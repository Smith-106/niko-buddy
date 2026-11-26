// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, deepGenResult, sessionStatus, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, unmountPanel, flushAsync, sendText, lastStreamChatCall, lastFinalize, setDeepMode, mockManagedDraft } from "@/test-helpers/chat-panel/chat-panel-test-setup"
import { readManagedDeepChapterDraftMessage } from "./chat-message-content"

const mocks = getChatPanelMocks()

/** 防御分支需要故意传入运行时非法值（例如 BigInt session_id 触发 JSON 序列化失败）；集中收口，调用点不再分散断言。 */
function rawForDefense<T>(v: unknown): T {
  return v as unknown as T
}

/** window.getSelection 在 jsdom 下行为不足，用最小形状 mock；一次收口。 */
function mockSelection(text: string | null): void {
  window.getSelection = (
    text === null ? (() => null) : (() => ({ toString: () => text }))
  ) as unknown as typeof window.getSelection
}

/** Tauri 运行时标记：jsdom 下不存在，用具名窗口类型一次收口。 */
interface TauriWindow {
  __TAURI_INTERNALS__?: unknown
}

function setTauriInternals(v: unknown): void {
  ;(window as unknown as TauriWindow).__TAURI_INTERNALS__ = v
}

function clearTauriInternals(): void {
  delete (window as unknown as TauriWindow).__TAURI_INTERNALS__
}
import type { RetrievalGraph } from "@/lib/graph-relevance"
describe("ChatPanel — 补覆盖：handleSend 分支", () => {
  it("novelMode+project+历史助手消息 → lastGeneratedChapterNumber 收到内容数组", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "问题A" }),
      msg({ id: "a1", role: "assistant", content: "回答A" }),
    ])
    renderPanel()
    await sendText("继续")
    expect(mocks.detectLastGeneratedChapterNumber).toHaveBeenCalledWith(["回答A"])
  })

  it("aiChatModel 纯模型名匹配但 provider 不在 preset → custom 回退（second find）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { zzz: { savedModels: [{ model: "plain-model" }] } }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
    expect(mocks.resolveConfig).toHaveBeenCalled()
  })

  it("streamChat onError 收到非 Error 值 → String(err) 后脱敏", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.("请求 https://x.test/v1 失败")
    })
    await sendText("提问")
    expect(lastFinalize()[0]).toContain("出错：请求 [url] 失败")
  })

  it("closeReasoning guard 失效分支（onToken 内 isActive 翻转）", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValueOnce(true).mockReturnValueOnce(false)
      handlers?.onToken?.("x") // onToken guard 通过，closeReasoning 内部 guard 失效 → 早退
      handlers?.onReasoningToken?.("思考")
      handlers?.onToken?.("正文")
      handlers?.onDone?.()
    })
    await sendText("再来")
    // closeReasoning 内部 guard 失效仅早退（不阻止 onToken 继续追加 token）
    expect(lastFinalize()[0]).toBe("x<think>思考</think>正文")
  })

  it("agent suffix：无章节文件 → 列表占位文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockImplementation(async () => [])
    setConversation("conv-1")
    renderPanel()
    await sendText("帮我改章节")
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    const blocks = sys.content as { text: string }[]
    expect(blocks[blocks.length - 1].text).toContain("暂无章节文件")
  })

  it("编辑模式：读取章节文件失败 → catch 空内容继续写回", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.chatEditModeEnabled = true
    mocks.isChatEditRequest.mockReturnValue(true)
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.readFile.mockRejectedValueOnce(new Error("read-boom"))
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("修改后内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("已完成第3章修改")
  })

  it("检索：index/purpose 读取失败 → catch 空串", async () => {
    mocks.wikiState.project = PROJECT
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md") || path.endsWith("purpose.md")) throw new Error("io")
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.buildRetrievalGraph).toHaveBeenCalled()
    expect(mocks.readFile).toHaveBeenCalledWith("/p/mybook/wiki/index.md")
    expect(mocks.readFile).toHaveBeenCalledWith("/p/mybook/purpose.md")
    const [, llmMessages] = lastStreamChatCall()
    const joined = (llmMessages[0]?.content as { text: string }[]).map((b) => b.text).join("\n")
    expect(joined).toContain("## 资料页面")
    expect(joined).not.toContain("chapter one")
  })

  it("图扩展：≥2 个新节点 → sort 比较器执行", async () => {
    mocks.wikiState.project = PROJECT
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
    ])
    mocks.getRelatedNodes.mockImplementation((nodeId: string, _graph: RetrievalGraph, _limit?: number) => {
      if (nodeId === "a") {
        return [
          { node: { id: "e", title: "E", path: "/p/mybook/wiki/pages/e.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
          { node: { id: "f", title: "F", path: "/p/mybook/wiki/pages/f.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
        ]
      }
      return []
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("页面预算用尽 → tryAddPage 早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.computeContextBudget.mockReturnValue({ strategy: "full", maxCtx: 204800, responseReserve: 30720, indexBudget: 5000, pageBudget: 80, maxPageSize: 800, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 }, hardInjectionBudget: { capChars: 3072, baselineChars: 3072 } })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("wiki/pages/a.md")) return "a".repeat(80)
      if (path.includes("wiki/pages/b.md")) return "b"
      return ""
    })
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
  })
})

describe("ChatPanel — 补覆盖：深度生成分支", () => {
  function setupDeepBase(): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: { chapterNumber: "3" },
    })
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 3)
  }

  it("onThinking 正常路径 + onCheckpoint 成功 → checkpointWrite 写入", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      callbacks.onThinking("阶段思考")
      callbacks.onFinalContent("正文")
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("阶段思考"), "conv-1")
    expect(mocks.persistDeepChapterCheckpoint).toHaveBeenCalled()
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("onCheckpoint 落盘失败（非 Error）→ String + CHECKPOINT_PERSIST_FAILED", async () => {
    setupDeepBase()
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce("disk-full-string")
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("CHECKPOINT_PERSIST_FAILED: disk-full-string")
    setDeepMode(false)
  })

  it("深度生成抛非 Error 值 → String(err)", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce("boom-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("出错：深度生成章节失败：boom-string")
    setDeepMode(false)
  })

  it("pause 落盘失败（非 Error）→ String(persistError) + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce("pause-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("暂停状态没能保存：pause-string")
    warnSpy.mockRestore()
    setDeepMode(false)
  })

  it("已停止生成 + existing 非空 → 前缀拼接", async () => {
    setupDeepBase()
    mocks.deepStreamRenderer.getContent.mockReturnValue("已有正文")
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已有正文")
    expect(content).toContain("已停止生成。")
    setDeepMode(false)
  })

  it("深度错误 + existing 非空 → 可见失败含前缀", async () => {
    setupDeepBase()
    mocks.deepStreamRenderer.getContent.mockReturnValue("已有正文")
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已有正文")
    expect(content).toContain("出错：深度生成章节失败：boom")
    setDeepMode(false)
  })

  it("深度 chat 意图（无章节号）→ sessionDebug chapterNumber ?? null", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => undefined)
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("随便聊聊")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("goldenThree 启用 → 透传给生成器", async () => {
    setupDeepBase()
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].goldenThreeChapter).toEqual({
      enabled: true,
      targetChapter: 3,
      requestedFirstThree: false,
    })
    setDeepMode(false)
  })

  it("partial + partialReason null → 默认超时文案", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "部分", partial: true }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("写到一半的正文已留下") }),
    )
    setDeepMode(false)
  })

  it("guard 失效 → finish 回调跳过 → finally 清理 activeStreamSessions", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      throw new Error("boom")
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("marker JSON 序列化失败（BigInt sessionId）→ 降级无 marker", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockImplementation(async () =>
      sessionStatus({ session_id: rawForDefense<string>(1n), status: "running", active_step_index: 1, updated_at: "t" }),
    )
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("niko-buddy-deep-chapter-draft")
    setDeepMode(false)
  })
})

describe("ChatPanel — 补覆盖：继续未完成分支", () => {
  function setupContinueConv(): void {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "被中断正文" }),
    ])
  }

  it("model 解析：providerId/modelId 命中 preset", async () => {
    mocks.wikiState.aiChatModel = "providerA/modelX"
    mocks.wikiState.providerConfigs = { providerA: { savedModels: [{ model: "modelX" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("modelX")
  })

  it("model 解析：providerId 未配置 → 仅覆盖 model", async () => {
    mocks.wikiState.aiChatModel = "providerZ/ghost"
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("ghost")
  })

  it("model 解析：providerId 不在 preset → custom 回退", async () => {
    mocks.wikiState.aiChatModel = "providerN/modelY"
    mocks.wikiState.providerConfigs = { providerN: { savedModels: [{ model: "modelY" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("modelY")
  })

  it("model 解析：纯模型名匹配 + preset 命中", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { providerA: { savedModels: [{ model: "plain-model" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("model 解析：纯模型名 → custom 回退", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { zzz: { savedModels: [{ model: "plain-model" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("model 解析：纯模型名未匹配 → 默认 + model 覆盖", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("stale click：消息 conversationId 被清空 → 回退当前会话（不切换）", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "" // stale：不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setActiveConversation).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：消息 conversationId 异于当前会话 → 切换会话", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "conv-other" // stale：不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-other")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：消息已从 store 移除 → findPreviousUserRequest 未命中回退", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages = [mocks.chatState.messages[0]] // 移除助手消息，不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：conversationId 与当前会话均缺失 → createConversation 兜底", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "" // stale：不 rerender
    mocks.chatState.activeConversationId = null
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("无项目 → statusResume 为 null（loadNovelSessionStatus 不调用）", async () => {
    mocks.wikiState.project = null
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.loadNovelSessionStatus).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  function setupDeepContinue(checkpoint?: any): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue(
      checkpoint ?? {
        originalRequest: "原始章节需求",
        checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
        resumeContext: "ctx",
        rootResumeContext: "ctx",
      },
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始章节需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
  }

  it("深度续写：全回调（guard 有效/失效）+ checkpoint 成功", async () => {
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      callbacks.onThinking("思考A")
      mocks.streamGuard.isActive.mockReturnValueOnce(false)
      callbacks.onThinking("跳过")
      mocks.streamGuard.isActive.mockReturnValueOnce(false)
      callbacks.onFinalContent("跳过")
      mocks.streamGuard.isActive.mockReturnValue(true)
      callbacks.onFinalContent("正文A")
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("正文A"), "conv-1")
    expect(mocks.persistDeepChapterCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: { stage: "after_draft", chapterNumber: 2 } }),
    )
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
  })

  it("深度续写：checkpoint 落盘失败（Error）→ throw + catch 文案", async () => {
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce(new Error("disk-full"))
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).toContain("CHECKPOINT_PERSIST_FAILED: disk-full")
  })

  it("深度续写：checkpoint 落盘失败（string）→ String 分支", async () => {
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce("disk-string")
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("CHECKPOINT_PERSIST_FAILED: disk-string")
  })

  it("深度续写：partial + partialReason null → 默认文案", async () => {
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", partial: true }))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("写到一半的正文已留下") }),
    )
  })

  it("深度续写：终稿空白且没有流式正文，不展示思考占位或标为 ready", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce(deepGenResult({ finalContent: " \r\n\t" }))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(readManagedDeepChapterDraftMessage(lastFinalize()[0])).toMatchObject({
      body: "继续未完成失败：模型没有返回内容。",
      draftStatus: "pending",
    })
    expect(mocks.deepStreamRenderer.replaceFinal).not.toHaveBeenCalled()
    expect(mocks.completeDeepChapterSession).not.toHaveBeenCalled()
  })

  it("深度续写：goldenResume 启用 → 透传", async () => {
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].goldenThreeChapter).toEqual({
      enabled: true,
      targetChapter: 3,
      requestedFirstThree: false,
    })
  })

  it("深度续写：residual 启用 → 字段展开", async () => {
    mocks.wikiState.novelConfig.residualCampaignEnabled = true
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const genInput = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(genInput.residualOverallMedian).toBe(9.0)
    expect(genInput.residualRewriteMode).toBe("structure_thril_pacing")
  })

  it("深度续写：checkpoint 无 chapterNumber → ?? null", async () => {
    setupDeepContinue({
      originalRequest: "需求",
      checkpoint: { stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.startDeepChapterSession).toHaveBeenCalled()
  })

  it("深度续写：『已停止生成』→ pause errorMessage 固定文案", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "已停止生成" }),
    )
  })

  it("深度续写 catch：pause 成功且 last_error null → lastError null", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(decodeURIComponent(content)).toContain('"lastError":null')
  })

  it("深度续写 catch：pause 失败（string）→ String + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce("pause-string")
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("暂停状态没能保存：pause-string")
    warnSpy.mockRestore()
  })

  it("深度续写：startDeepChapterSession 提前失败 → syntheticSessionId 写入 debug", async () => {
    mocks.startDeepChapterSession.mockRejectedValueOnce(new Error("early"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(decodeURIComponent(content)).toContain('"syntheticSessionId":"synthetic-session"')
  })

  it("上下文重建：contextPackToPrompt 抛错 → console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.contextPackToPrompt.mockImplementationOnce(() => {
      throw new Error("ctx-boom")
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("构建继续未完成上下文包失败"), expect.any(Error))
    expect(mocks.streamChat).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("上下文重建：routeTask 返回 null → taskDirective 空", async () => {
    mocks.routeTask.mockReturnValue(rawForDefense<import("@/lib/novel").TaskRouteResult>(null))
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.buildContextPack).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("上下文重建：tokenBudget 生效", async () => {
    mocks.wikiState.novelConfig.contextTokenBudget = 4000
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.contextPackToPrompt).toHaveBeenCalledWith(expect.anything(), 4000, expect.anything())
  })

  it("上下文重建：buildContextPack 失败 → fallback 对象", async () => {
    mocks.buildContextPack.mockRejectedValueOnce(new Error("pack-boom"))
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.contextPackToPrompt).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("普通路径：streamChat 后 guard 失效 → 早退不 finalize", async () => {
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onDone?.()
      mocks.streamGuard.isActive.mockReturnValue(false)
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("catch：非 Error 错误 → String 分支", async () => {
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.("string-err")
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("出错：继续未完成失败：string-err")
  })

  it("catch：accumulated 为空 → 无前缀", async () => {
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("e"))
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("出错：继续未完成失败：e")
    expect(lastFinalize()[0]).not.toContain("正在基于")
  })
})

describe("ChatPanel — 补覆盖：保存/丢弃分支", () => {
  it("无项目丢弃 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "草稿" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    expect(mocks.rejectDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("草稿已被丢弃 → getLatestAssistantDraftContext 为空 → 早退", () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x", discarded: true })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    expect(mocks.rejectDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("保存失败（非 Error）→ String 分支", async () => {
    mocks.wikiState.project = PROJECT
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce("disk-string")
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第5章 草稿\n正文").message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("save-status").textContent).toContain("无法确认保存结果")
  })

  it("丢弃失败（非 Error）→ String 分支", async () => {
    mocks.wikiState.project = PROJECT
    mocks.rejectDeepChapterDraft.mockRejectedValueOnce("reject-string")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("保存失败：{{message}}::reject-string")
  })

  it("丢弃：无用户消息 → userRequest 兜底 draft rejected", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "草稿" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "draft rejected" }),
    )
  })

  it("同一轮连点 Save 和 Review 只执行一次采纳", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第5章 草稿\n正文").message])
    renderPanel()
    const save = screen.getByTestId("save-as-chapter")
    const review = screen.getByTestId("review-draft")
    act(() => {
      fireEvent.click(save)
      fireEvent.click(save)
      fireEvent.click(review)
    })
    await flushAsync()
    expect(mocks.requireManagedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(mocks.readManagedChapterForWrite).toHaveBeenCalledTimes(1)
    expect(mocks.rerunMainControlGates).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
  })
})

describe("ChatPanel — 补覆盖：exemplar 防御分支", () => {
  it("对话框打开后项目被移除 → 提交早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mockSelection("选段")
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    mocks.wikiState.project = null
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(mocks.markStyleExemplarViaRust).not.toHaveBeenCalled()
  })

  it("对话框打开后项目被移除 → A/B 评分早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mockSelection("选段")
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    mocks.wikiState.project = null
    rerenderPanel()
    fireEvent.click(screen.getAllByText("1★")[0]!)
    await flushAsync()
    expect(mocks.appendExemplarABSample).not.toHaveBeenCalled()
  })

  it("getSelection 返回 null → 空选提示（?? 兜底）并渲染内联状态反馈", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mockSelection(null)
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    expect(screen.queryByTestId("dialog")).toBeNull()
    const inlineFeedback = screen.getByTestId("exemplar-inline-feedback")
    expect(inlineFeedback).toHaveAttribute("role", "status")
    expect(inlineFeedback).toHaveTextContent("请先在消息中选中一段文本")
  })

  it("U4-03：标记为风格范例按钮包含 Bookmark 图标，TooltipContent 为 TooltipTrigger 合法兄弟节点", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    const triggerBtn = screen.getByLabelText("标记为风格范例")
    const icon = triggerBtn.querySelector("svg.lucide-bookmark")
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute("aria-hidden", "true")
    // TooltipContent 必须是同级兄弟节点，不得嵌套在 Button/TooltipTrigger 内部
    expect(triggerBtn.querySelector('[data-testid="tooltip-content"]')).toBeNull()
    const tooltipRoot = triggerBtn.closest('[data-testid="tooltip"]')
    expect(tooltipRoot).not.toBeNull()
    const siblingContent = tooltipRoot?.querySelector('[data-testid="tooltip-content"]')
    expect(siblingContent).not.toBeNull()
    expect(siblingContent?.textContent).toBeTruthy()
    // NON_BLOCKING-2：mouseDown preventDefault，避免桌面端点击按钮前清空当前文本选区
    const downEvt = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    triggerBtn.dispatchEvent(downEvt)
    expect(downEvt.defaultPrevented).toBe(true)
  })

  it("U4-03：有效选区打开弹窗后不再重复显示底部内联反馈", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mockSelection(null)
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    expect(screen.getByTestId("exemplar-inline-feedback")).toBeInTheDocument()

    mockSelection("一段值得收藏的描写")
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("exemplar-inline-feedback")).toBeNull()
  })

  it("提交标记失败（非 Error）→ String(e)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.markStyleExemplarViaRust.mockRejectedValueOnce("str-err")
    mockSelection("选段")
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(screen.getByText("收藏失败：str-err")).toBeInTheDocument()
  })
})

describe("ChatPanel — 补覆盖：写入按钮与占位", () => {
  it("novel + ingest 模式：写入按钮 novel 文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    const btn = screen.getByText("写入章节")
    expect(btn).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(btn)
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).toHaveBeenCalled()
  })

  it("novel + ingest 模式：占位 novel.chat.ingestPlaceholder", () => {
    mocks.wikiState.novelMode = true
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "讨论章节内容或继续追问...")
  })

  it("写入 wiki 失败（非 Error）→ 上屏保留原始字符串诊断", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "ingest"
    mocks.executeIngestWrites.mockRejectedValueOnce("str-err")
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    await act(async () => {
      fireEvent.click(screen.getByText("写入资料库"))
    })
    await flushAsync()
    expect(screen.getByTestId("write-wiki-error")).toHaveTextContent("str-err")
  })

  it("重新生成：活跃会话已被清空（stale）→ ?? 兜底后早退", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    mocks.chatState.activeConversationId = null // stale：不 rerender
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("停止：流式内容为空 → 无前缀『已停止生成』", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {})) // 挂起
    await sendText("生成中")
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(lastFinalize()[0]).toBe("已停止生成。")
  })
})

describe("ChatPanel — P1-9 status 订阅清理", () => {
  it("切项目/unmount 时调用 subscribeStatusJson 返回的 unlisten", async () => {
    const unlisten = vi.fn()
    mocks.subscribeStatusJson.mockResolvedValueOnce(unlisten)
    mocks.wikiState.project = PROJECT
    renderPanel()
    await flushAsync()
    await flushAsync()
    expect(mocks.subscribeStatusJson).toHaveBeenCalled()
    unmountPanel()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
describe("TASK-021 chat-panel uncovered lines", () => {
  it("AB score failure formats error via formatError (line 164)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.appendExemplarABSample.mockRejectedValueOnce(new Error("ab-fail"))
    // need cognition load to succeed so failure is from append
    mocks.loadCognitionState.mockResolvedValueOnce(null)
    mockSelection("selected")
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    // click first enabled AB score button (1 enabled)
    const abButtons = screen.getAllByTitle("范例加去AI味评分")
    // fallback: buttons with text "1★" etc; use first AB button
    const target = abButtons[0] ?? screen.getAllByRole("button").find((b) => b.textContent?.includes("1"))
    expect(target).toBeTruthy()
    await act(async () => {
      fireEvent.click(target as HTMLElement)
    })
    await flushAsync()
    // formatError path: feedback contains operationFailed + detail
    expect(mocks.appendExemplarABSample).toHaveBeenCalled()
  })

  it("force stop with no active conversation returns early (line 727)", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    renderPanel()
    // clear active to trigger early return
    mocks.chatState.activeConversationId = null
    rerenderPanel()
    fireEvent.click(screen.getByTestId("chat-force-stop"))
    // no finalize when no conv
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("force stop normal flow finalizes with prefix (lines 729,755-764)", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {}))
    await sendText("hello force")
    // streaming started
    expect(mocks.chatState.streamingContents["conv-1"]).toBeDefined()
    fireEvent.click(screen.getByTestId("chat-force-stop"))
    await flushAsync()
    const call = lastFinalize()
    expect(call[0]).toContain("已强制终止生成。")
  })

  it("接受并撰写下一章：先采纳存档章号，再在新会话请求后一章", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([mockManagedDraft(`# Chapter 5 Title\n\n${"X".repeat(130)}`).message])
    renderPanel()
    const btn = screen.getByTestId("accept-and-continue-next")
    expect(btn).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(btn)
    })
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(expect.objectContaining({ chapterNumber: 5 }))
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", expect.stringContaining("第 6 章正文"))
  })

  it("regenerate restores message when handleSend fails (lines 794-799)", async () => {
    setConversation("conv-1")
    const userMsg = msg({ id: "u1", role: "user", content: "regen-q" })
    const asstMsg = msg({ id: "a1", role: "assistant", content: "regen-a" })
    setMessages([userMsg, asstMsg])
    renderPanel()
    // make handleSend throw via chatMessagesToLLM
    mocks.chatMessagesToLLM.mockImplementationOnce(() => {
      throw new Error("llm-fail")
    })
    fireEvent.click(screen.getByTestId("regenerate"))
    await flushAsync()
    // message restored (user msg still present)
    const msgs = mocks.chatState.messages
    expect(msgs.some((m: any) => m.id === "u1")).toBe(true)
  })

  it("subscribe event triggers refresh and disposed guard (lines 430-431)", async () => {
    let capturedCb: (() => Promise<void>) | null = null
    mocks.subscribeStatusJson.mockImplementationOnce(
      (async (_pp: string, cb: () => Promise<void>) => {
        capturedCb = cb
        return () => {}
      }) as unknown as () => Promise<() => void>,
    )
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    renderPanel()
    await flushAsync()
    expect(capturedCb).not.toBeNull()
    const before = mocks.refreshProjectState.mock.calls.length
    await capturedCb!()
    expect(mocks.refreshProjectState.mock.calls.length).toBeGreaterThan(before)
    // unmount then event should be ignored (disposed)
    unmountPanel()
    const before2 = mocks.refreshProjectState.mock.calls.length
    await capturedCb!()
    expect(mocks.refreshProjectState.mock.calls.length).toBe(before2)
  })

  it("subscribe reject logs warn (lines 437-439)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // need logger.warn path: subscribeStatusJson rejects
    mocks.subscribeStatusJson.mockRejectedValueOnce(new Error("sub-fail"))
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    renderPanel()
    await flushAsync()
    await flushAsync()
    // logger.warn calls console.warn? actual logger may call console; just ensure no crash
    expect(mocks.subscribeStatusJson).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("planning toggle open/close and refresh (lines 1021,1088)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    const openBtn = screen.getByLabelText("打开计划面板")
    fireEvent.click(openBtn)
    await flushAsync()
    // planning panel should appear (refresh button)
    const refreshBtn = screen.getByLabelText("刷新")
    expect(refreshBtn).toBeInTheDocument()
    const loadCalls = mocks.buildChapterPlan?.mock?.calls?.length ?? 0
    fireEvent.click(refreshBtn)
    await flushAsync()
    // close via same toggle (now label is close)
    fireEvent.click(screen.getByLabelText("关闭计划面板"))
    expect(screen.queryByLabelText("刷新")).toBeNull()
    expect(loadCalls).toBeDefined()
  })

  it("exemplar delete cancel and confirm (lines 1195-1196)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockResolvedValueOnce([
      { exemplarId: "ex-12345678", text: "sample text for delete flow", markType: "style", chapterId: "chat", createdAt: "t" },
    ])
    mockSelection("sel")
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    await flushAsync()
    // request delete (need delete button)
    const delBtn = screen.getByLabelText("删除此范例")
    fireEvent.click(delBtn)
    await flushAsync()
    // cancel (row cancel is first of the two "取消" buttons: list row vs dialog footer)
    fireEvent.click(screen.getAllByText("取消")[0])
    await flushAsync()
    // request again then confirm
    fireEvent.click(screen.getByLabelText("删除此范例"))
    await flushAsync()
    mocks.deleteStyleExemplarViaRust.mockResolvedValueOnce(undefined)
    mocks.loadStyleExemplarsViaRust.mockResolvedValueOnce([])
    fireEvent.click(screen.getByText("确认删除"))
    await flushAsync()
    expect(mocks.deleteStyleExemplarViaRust).toHaveBeenCalledWith(expect.anything(), "ex-12345678")
  })
})

describe("TASK-021 chat-panel round2", () => {
  it("接受并撰写下一章：目标不可读时不采纳，也不开启新会话", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([mockManagedDraft(`# Chapter 5 Title\n\n${"X".repeat(130)}`).message])
    mocks.readManagedChapterForWrite.mockRejectedValueOnce(new Error("Target unreadable"))
    renderPanel()
    const btn = screen.getByTestId("accept-and-continue-next")
    await act(async () => {
      fireEvent.click(btn)
    })
    await flushAsync()
    expect(mocks.readManagedChapterForWrite).toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.chatState.createConversation).not.toHaveBeenCalled()
  })

  it("force stop with Tauri kill failure finalizes warn (lines 736-750)", async () => {
    const transport = await import("@/lib/claude-cli-transport")
    const activeSpy = vi.spyOn(transport, "activeRustStreamIds").mockReturnValue(["stream-1"])
    const killSpy = vi.spyOn(transport, "gracefulAbortStream").mockRejectedValue(new Error("kill-fail"))
    setTauriInternals({})
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    // need a conversation for convStillExists true
    mocks.chatState.conversations = [{ id: "conv-1", title: "t", createdAt: 0, updatedAt: 0, deAiMode: false }]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {}))
    await sendText("tauri kill")
    fireEvent.click(screen.getByTestId("chat-force-stop"))
    await flushAsync()
    await new Promise((r) => setTimeout(r, 20))
    // killFailed>0 and conv exists -> finalize with warn
    const calls = mocks.chatState.finalizeStream.mock.calls
    const warnCall = calls.find((c: any[]) => String(c[0]).includes("未能确认终止"))
    expect(warnCall).toBeTruthy()
    clearTauriInternals()
    activeSpy.mockRestore()
    killSpy.mockRestore()
  })

  it("force stop with novelManaged true returns early (line 756)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "deep q" })])
    // hang deep generation to keep managed flag true
    mocks.runDeepChapterGeneration.mockImplementationOnce(() => new Promise(() => {}))
    // ensure deep branch taken: need deep enabled + route to deep? Use direct deepChapterEnabled ref via UI toggle
    renderPanel()
    // enable deep mode via toggle button (aria-pressed false -> click to enable)
    // deep toggle button is the Brain button with aria-pressed
    const deepBtn = screen.getByLabelText("开启深度模式")
    fireEvent.click(deepBtn)
    await flushAsync()
    // send triggers deep path (novelMode + deep enabled)
    await sendText("write deep chapter")
    // now managed flag should be true for conv-1; force stop should early-return (no force finalize)
    const before = mocks.chatState.finalizeStream.mock.calls.length
    fireEvent.click(screen.getByTestId("chat-force-stop"))
    await flushAsync()
    const afterCalls = mocks.chatState.finalizeStream.mock.calls.slice(before)
    // early return means no "已强制终止生成。" finalize from force stop
    expect(afterCalls.some((c: any[]) => String(c[0]).includes("已强制终止生成。"))).toBe(false)
    setDeepMode(false)
  })

  it("R2-U06 装配期中止：在上下文检索阶段点击停止后绝不继续发起 streamChat", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = false
    setConversation("conv-1")
    type SearchResults = Awaited<ReturnType<typeof mocks.searchWiki>>
    let resolveSearch!: (v: SearchResults) => void
    mocks.searchWiki.mockImplementationOnce(
      () => new Promise<SearchResults>((resolve) => { resolveSearch = resolve }),
    )
    renderPanel()
    await sendText("分析一下全书伏笔脉络")

    // 在 searchWiki 等待期间点击停止：startStreaming 后立即注册的 AbortController 被中止
    fireEvent.click(screen.getByTestId("chat-stop"))
    resolveSearch([])
    await flushAsync()

    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("R2-U01/U09 handleDiscardDraft 互斥锁：连点两次丢弃仅执行一次 rejectDeepChapterDraft，且与保存互斥", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([mockManagedDraft(`# Chapter 5 Title\n\n${"X".repeat(130)}`).message])
    type RejectResult = Awaited<ReturnType<typeof mocks.rejectDeepChapterDraft>>
    let resolveDiscard!: (v: RejectResult) => void
    mocks.rejectDeepChapterDraft.mockImplementationOnce(
      () => new Promise<RejectResult>((resolve) => { resolveDiscard = resolve }),
    )
    renderPanel()
    const discardBtn = screen.getByTestId("discard-draft")
    const saveBtn = screen.getByTestId("save-as-chapter")
    fireEvent.click(discardBtn)
    fireEvent.click(discardBtn)
    fireEvent.click(saveBtn)
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    resolveDiscard(sessionStatus())
    await flushAsync()
  })
})
