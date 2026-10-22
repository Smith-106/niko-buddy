// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, deepGenResult, sessionStatus, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, unmountPanel, flushAsync, sendText, lastStreamChatCall, lastFinalize, setDeepMode } from "./chat-panel-test-setup"

const mocks = getChatPanelMocks()
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
    expect(mocks.writeFile).toHaveBeenCalled()
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
      sessionStatus({ session_id: 1n as any, status: "running", active_step_index: 1, updated_at: "t" }),
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

  it("深度续写：accumulated 为空 → 兜底文案", async () => {
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("继续未完成失败：模型没有返回内容。")
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
    mocks.routeTask.mockReturnValue(null as any)
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
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("保存失败：{{message}}::disk-string")
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

  it("保存进行中另一会话保存完成 → finally prev 不匹配 → 跳过回填", async () => {
    mocks.wikiState.project = PROJECT
    let resolveCommit1: (v: void | PromiseLike<void>) => void = () => {}
    mocks.commitAcceptedDeepChapterDraft.mockImplementationOnce(
      () => new Promise((res) => { resolveCommit1 = res }),
    )
    // conv-1 的 refresh 窗口挂起 50ms，期间 conv-2 的保存状态入队 → finally 时 prev 不匹配
    mocks.refreshProjectState.mockImplementationOnce(
      () => new Promise((res) => { setTimeout(res, 50) }),
    )
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [
      msg({ id: "u1", role: "user", content: "q", conversationId: "conv-1" }),
      msg({ id: "a1", role: "assistant", content: "草稿A", conversationId: "conv-1" }),
      msg({ id: "u2", role: "user", content: "q", conversationId: "conv-2" }),
      msg({ id: "a2", role: "assistant", content: "草稿B", conversationId: "conv-2" }),
    ]
    renderPanel()
    // conv-1 保存挂起在 commitAcceptedDeepChapterDraft
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    })
    // 放行 commit → conv-1 进入 refresh 挂起窗口
    await act(async () => {
      resolveCommit1(undefined)
      await new Promise((r) => setTimeout(r, 0))
    })
    // refresh 窗口内：conv-2 完整完成一次保存（状态入队覆盖 prev）
    mocks.chatState.activeConversationId = "conv-2"
    rerenderPanel()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80)) // 放行 refresh → conv-1 finally 跳过不匹配的 prev
    })
    await flushAsync()
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
  })
})

describe("ChatPanel — 补覆盖：exemplar 防御分支", () => {
  it("对话框打开后项目被移除 → 提交早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
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
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    mocks.wikiState.project = null
    rerenderPanel()
    fireEvent.click(screen.getByText("1★开"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).not.toHaveBeenCalled()
  })

  it("getSelection 返回 null → 空选提示（?? 兜底）", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => null) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("提交标记失败（非 Error）→ String(e)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.markStyleExemplarViaRust.mockRejectedValueOnce("str-err")
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(screen.getByText("标记失败：str-err")).toBeInTheDocument()
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