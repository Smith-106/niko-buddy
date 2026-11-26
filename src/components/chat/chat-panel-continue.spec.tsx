// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { fireEvent, screen, within, waitFor } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, deepGenResult, reviewResult, sessionStatus, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, flushAsync, lastStreamChatCall, lastFinalize, mockManagedDraft } from "@/test-helpers/chat-panel/chat-panel-test-setup"
import { readManagedDeepChapterDraftMessage } from "./chat-message-content"
import { appendContextUsageMarker, appendManagedDeepChapterDraftMarker } from "./chat-message-markers"
import type { DisplayMessage } from "@/stores/chat-store"

const mocks = getChatPanelMocks()

/**
 * system 消息内容可能是块数组（G4a：稳定段带 cacheControl + 动态段），断言前先压平成文本。
 * 拼接方式与 llm-providers 的 toOpenAiContent / flattenAnthropicSystem 一致（块间无分隔符）。
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (block && typeof block === "object" && "text" in block
      ? String((block as { text: unknown }).text)
      : ""))
    .join("")
}
describe("ChatPanel — 继续未完成 (continue unfinished)", () => {
  it("流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    expect(mocks.chatState.addMessage).not.toHaveBeenCalled()
  })

  it("深度续写成功：persistedResume checkpoint + complete + ready marker", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "原始章节需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "已有上下文",
      rootResumeContext: "根上下文",
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始章节需求" }),
      msg({ id: "a1", role: "assistant", content: "<!-- 续写占位 -->" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "继续未完成")
    expect(mocks.chatState.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeCheckpoint: expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }) }),
    )
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"ready"')
  })

  it("深度续写 manualReviewRequired → block", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", reviewResults: [reviewResult()], manualReviewRequired: true, retryCount: 3 }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.blockDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
  })

  it("深度续写 partial → pause", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", partial: true, partialReason: "timeout" }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
  })

  it("深度续写 guard 失效 → finish 前返回，不 finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("切换项目后重渲染：继续未完成读取的是新项目的会话状态（project 不得是旧闭包）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.loadNovelSessionStatus.mockImplementation(async () => null)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "问题" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    // 只换项目；其余依赖（isStreaming / llmConfig / 会话动作等）全部不变。
    mocks.wikiState.project = { id: "p2", name: "OtherBook", path: "/p/otherbook" }
    rerenderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.loadNovelSessionStatus).toHaveBeenCalledWith("/p/otherbook")
    expect(mocks.loadNovelSessionStatus).not.toHaveBeenCalledWith(PROJECT.path)
  })

  it("statusResume payload 优先提供 originalRequest/checkpoint", async () => {
    mocks.wikiState.project = PROJECT
    mocks.loadNovelSessionStatus.mockImplementation(async () =>
      sessionStatus({ current_task: { conversation_id: "conv-1", user_request: "状态里的需求" } }),
    )
    mocks.buildInterruptedResumeContextPayload.mockReturnValue({
      checkpoint: { version: 1, originalRequest: "状态需求", chapterNumber: 9, stage: "after_draft" },
      originalRequest: "状态需求",
      resumeContext: "状态上下文",
      rootResumeContext: "根",
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "旧问题" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "状态需求", resumeCheckpoint: expect.objectContaining({ chapterNumber: 9, stage: "after_draft" }) }),
    )
  })

  it("无 checkpoint：重建上下文包 + 普通 streamChat + finish finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "任务",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
    }))
    mocks.contextPackToPrompt.mockReturnValue("CONTEXT_PACK_PROMPT")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "被中断的正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.buildContextPack).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
    const [, msgs] = lastStreamChatCall()
    expect(msgs[0].role).toBe("system")
    expect(contentText(msgs[0].content)).toContain("CONTEXT_PACK_PROMPT")
    expect(readManagedDeepChapterDraftMessage(lastFinalize()[0])).toMatchObject({
      body: "继续未完成失败：模型没有返回内容。",
      draftStatus: "pending",
    })
  })

  it("无 checkpoint 且原始请求为空 → 仅基础 system prompt", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
    const [, msgs] = lastStreamChatCall()
    expect(contentText(msgs[0].content)).toContain("专业小说写作助手")
    expect(mocks.buildContextPack).not.toHaveBeenCalled()
  })

  it("无 checkpoint 续写 streamError → catch → pause + 失败文案", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("网络错误"))
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).not.toContain("niko-buddy-novel-session-debug")
  })

  it("无 checkpoint 续写 onToken/onReasoningToken 的 guard 失效分支", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onToken?.("被忽略")
      handlers?.onReasoningToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onReasoningToken?.("思考中")
      handlers?.onToken?.("正文片段")
      handlers?.onDone?.()
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("正文片段")
  })

  it("accumulated 为空 → 兜底『模型没有返回内容』", async () => {
    mocks.wikiState.project = PROJECT
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("继续未完成失败：模型没有返回内容。")
  })

  it("深度续写 catch：pause 落盘失败 → pausePersistError + console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce(new Error("pause-io"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("继续未完成暂停状态落盘失败"), expect.any(Error))
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).toContain("暂停状态没能保存")
    warnSpy.mockRestore()
  })

  it("深度续写 catch：pause 成功 → sessionDebug.pauseWrite 写入 debug 注释", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockResolvedValueOnce(
      sessionStatus({ draft: { draft_status: "pending" }, current_task: { last_error: "resume-boom" } }),
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("niko-buddy-novel-session-debug")
    expect(decodeURIComponent(content)).toContain('"pauseWrite"')
    expect(decodeURIComponent(content)).toContain('"status":"paused"')
    expect(decodeURIComponent(content)).toContain('"lastError":"resume-boom"')
  })
})

describe("ChatPanel — 保存 / 丢弃章节草稿", () => {
  it("无项目保存 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "正文" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("无助手草稿（仅用户消息）保存 → 早退", () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("采纳以存档章号、原请求和精确 CRLF 正文写入，并保留 accepted 会话 ID", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.selectedFile = "/p/mybook/wiki/chapters/chapter-002.md"
    setConversation("conv-1")
    const body = "\r\n# 第12章 标题X\r\n\r\n  正文内容  \r\n\t\r\n"
    const { draft, message } = mockManagedDraft(body, {
      chapter_number: 12,
      user_request: "存档请求：写第12章",
    })
    const thinking = "<think>\n阶段一\n</think>\n\n<think>\n阶段二\n</think>\n\n"
    const content = appendContextUsageMarker(thinking + message.content, deepGenResult().contextUsage)
    setMessages([
      msg({ id: "u1", role: "user", content: "不是存档请求：写第2章" }),
      msg({ id: "u2", role: "user", content: "继续未完成" }),
      { ...message, content },
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[2])
    await flushAsync()
    const chapterPath = "/p/mybook/wiki/chapters/chapter-012.md"
    expect(mocks.requireManagedDeepChapterDraft).toHaveBeenCalledWith(PROJECT.path, "conv-1", "accept")
    expect(mocks.getManagedDraftAdoptionGate).toHaveBeenCalledWith(draft)
    expect(mocks.findChapterFileByNumber).toHaveBeenCalledWith(PROJECT.path, 12)
    expect(mocks.readManagedChapterForWrite).toHaveBeenCalledWith(chapterPath)
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
    expect(mocks.readSelectedChapterNumberForFile).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT.path,
        conversationId: "conv-1",
        sessionId: draft.session_id,
        userRequest: draft.user_request,
        chapterNumber: 12,
        chapterPath,
        expectedExistingContent: null,
        overwriteExisting: false,
      }),
    )
    const [{ finalChapterContent }] = mocks.commitAcceptedDeepChapterDraft.mock.calls[0]
    expect(finalChapterContent.split("\n---\n")).toEqual([
      expect.stringContaining("chapter_number: 12\nchapter_status: final\ntitle: \"第12章 标题X\""),
      body,
    ])
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith(PROJECT.path)
    const updated = mocks.chatState.setMessages.mock.calls[0][0].find((m: DisplayMessage) => m.id === message.id)
    expect(readManagedDeepChapterDraftMessage(updated.content)).toMatchObject({
      draftStatus: "accepted", conversationId: draft.conversation_id, sessionId: draft.session_id,
    })
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(chapterPath)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith(PROJECT.path)
    expect(screen.getByTestId("save-status").textContent).toContain("已接受草稿并保存为 第12章 标题X")
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("未评估草稿不能采纳；复核通过后仍须另点保存才写正式章", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("# 第5章 复核对象\n正文内容")
    setMessages([message])
    mocks.getManagedDraftAdoptionGate.mockResolvedValue("unassessed")
    mocks.rerunMainControlGates.mockImplementationOnce(async () => {
      mocks.getManagedDraftAdoptionGate.mockResolvedValue("passed")
      return {
        draftId: draft.draft_id, chapterNumber: 5, adoptionGate: "passed", overall: "pass",
        rows: [], contractEvaluated: true, llmMediated: true, unassessedDimensions: [],
      }
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("须通过正文复核")
    expect(mocks.rerunMainControlGates).not.toHaveBeenCalled()
    expect(mocks.readManagedChapterForWrite).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("review-draft"))
    await flushAsync()
    expect(mocks.rerunMainControlGates).toHaveBeenCalledWith({
      draftId: draft.draft_id,
      projectPath: PROJECT.path,
      novelConfig: mocks.wikiState.novelConfig,
      llmConfig: mocks.wikiState.llmConfig,
      managedDraft: { artifact: draft, chapterNumber: 5 },
    })
    expect(screen.getByTestId("save-status").textContent).toBe("复核已通过，尚未采纳草稿。")
    expect(mocks.readManagedChapterForWrite).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 5, chapterPath: "/p/mybook/wiki/chapters/chapter-005.md" }),
    )
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
  })

  it("autoIngestOnSave：可用 LLM + 摄取成功", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    const base = PROJECT.path
    const sourcePath = `${base}/wiki/chapters/chapter-005.md`
    const historyPath = `${base}/.novel/snapshots/history/005/extraction.snapshot.json`
    const body = "# 测试章\n正文"
    const source = `---
type: chapter
chapter_number: 5
chapter_status: final
---
${body}`
    const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
    const extraction = { chapterNumber: 5, snapshotId: "chapter-005-r1", revision: 1, isHistorical: false }
    const archive = JSON.stringify({ ...extraction, isHistorical: true }, null, 2)
    const current = JSON.stringify({ ...extraction, snapshotId: "chapter-005-r2", revision: 2, supersedes: "chapter-005-r1" }, null, 2)
    const files = new Map<string, string>([
      [sourcePath, source],
      [historyPath, archive],
      [`${base}/.novel/snapshots/005.snapshot.json`, current],
      [`${base}/.novel/projection-status.json`, JSON.stringify({
        schemaVersion: "2",
        chapters: { "5": { sync_snapshot_to_memory: { projection: "sync_snapshot_to_memory", category: "fold_rebuildable", status: "committed", updated_at: "2026-01-01T00:00:00Z", last_error: "" } } },
      })],
    ])
    mocks.readFile.mockImplementation(async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    })
    mocks.ingestChapter.mockImplementation(async () => ({
      ledgerSaveFailed: false,
      factsStoreFailed: false,
      failedProjections: [],
      pendingProjections: [],
      committedProjections: ["sync_snapshot_to_memory"],
      canonOutcome: { status: "skipped", reason: "no_facts" },
      receipt: {
        readPath: sourcePath,
        chapterNumber: 5,
        bodySha256: sha(body),
        contentSha256: sha(source),
        snapshotIdAtExtractionCommit: "chapter-005-r1",
        snapshotRevisionAtExtractionCommit: 1,
        snapshotJsonSha256AtExtractionCommit: sha(JSON.stringify(extraction, null, 2)),
        canonOutcome: { status: "skipped", reason: "no_facts" },
      },
      projectionReceipt: {
        extractionHistoryPath: historyPath,
        snapshotId: "chapter-005-r2",
        revision: 2,
        snapshotJsonSha256: sha(current),
      },
      snapshot: {
        chapterId: "chapter-005",
        chapterNumber: 5,
        summary: "s",
        characters: [],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        newCanonFacts: [],
        timelineEvents: [],
        conflicts: [],
        endingHook: "",
        graphNodes: [],
        graphEdges: [],
      },
    }))
    setConversation("conv-1")
    setMessages([mockManagedDraft(body).message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    // 动态导入 chapter-ingest / canon-dual-write 超出单次 setTimeout(0) 的 flush 能力，改用轮询断言
    await waitFor(() => {
      const status = screen.getByTestId("save-status").textContent ?? ""
      expect(status).toContain("已接受草稿并保存为 测试章")
      expect(status).toContain("记忆回填完成")
    })
    expect(mocks.ingestChapter).toHaveBeenCalled()
  })

  it.each([
    [undefined, "但章节摄取未完成"],
    ["not_final", "章节未标为终稿，已跳过记忆回填"],
  ] as const)("autoIngestOnSave：摄取无 snapshot（%s）→ 如实提示状态", async (failReason, status) => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.ingestChapter.mockImplementation(async () => ({ snapshot: null, failReason }))
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 测试章\n正文").message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    // 同上：动态导入导致时序超出 flushAsync，改用轮询断言
    await waitFor(() => {
      expect(screen.getByTestId("save-status").textContent).toContain(status)
    })
  })

  it("autoIngestOnSave：无可用 LLM → 提示未配置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.hasUsableLlm.mockReturnValue(false)
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 测试章\n正文").message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("未配置可用 AI 模型")
  })

  it("正式采纳失败 → 明确失败且不摄取、不切换预览", async () => {
    mocks.wikiState.project = PROJECT
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce(new Error("disk-error"))
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 测试章\n正文").message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("save-status").textContent).toContain("无法确认保存结果")
    expect(screen.getByTestId("save-status").textContent).toContain("disk-error")
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("复核草稿进行中不置 isSaving=true，保存进行中才置 isSaving=true（U-4）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("# 第5章 复核对象\n正文内容")
    setMessages([message])
    let resolveReview!: (value: Awaited<ReturnType<typeof mocks.rerunMainControlGates>>) => void
    mocks.rerunMainControlGates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve
        }),
    )
    renderPanel()
    fireEvent.click(screen.getByTestId("review-draft"))
    await waitFor(() => expect(mocks.rerunMainControlGates).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("saving")).toBeNull()

    resolveReview({
      draftId: draft.draft_id,
      chapterNumber: 5,
      adoptionGate: "passed",
      overall: "pass",
      rows: [],
      contractEvaluated: true,
      llmMediated: true,
      unassessedDimensions: [],
    })
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toBe("复核已通过，尚未采纳草稿。")

    let resolveCommit!: () => void
    mocks.commitAcceptedDeepChapterDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve
        }),
    )
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await waitFor(() => expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("saving")).toBeInTheDocument()
    resolveCommit()
    await flushAsync()
    expect(screen.queryByTestId("saving")).toBeNull()
  })

  it("复核/保存异常保留本地化基文案并附加规整截断的 120 字摘要（U-4）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { message } = mockManagedDraft("# 第5章 异常摘要\n正文内容")
    setMessages([message])
    const longErr = `  line1\n   line2   ${"E".repeat(150)}`
    mocks.rerunMainControlGates.mockRejectedValueOnce(new Error(longErr))
    renderPanel()
    fireEvent.click(screen.getByTestId("review-draft"))
    await flushAsync()
    const status = screen.getByTestId("save-status").textContent ?? ""
    expect(status).toContain("无法复核当前草稿")
    expect(status).toContain("line1 line2 ")
    const match = status.match(/（(.+)）$/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBe(120)
  })

  it("丢弃草稿成功：rejected marker 保留会话 ID，不采用陈旧状态的会话 ID", async () => {
    mocks.wikiState.project = PROJECT
    mocks.detectGeneratedTargetChapterNumber.mockReturnValue(3)
    mocks.rejectDeepChapterDraft.mockResolvedValueOnce(sessionStatus({
      session_id: "stale-state-session",
      current_task: { conversation_id: "other-conversation" },
    }))
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("# 第3章 草稿\n草稿正文", { chapter_number: 3 })
    setMessages([msg({ id: "u1", role: "user", content: "q" }), message])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 3, conversationId: "conv-1" }),
    )
    expect(mocks.chatState.markLastAssistantDiscarded).toHaveBeenCalled()
    const updated = mocks.chatState.setMessages.mock.calls[0][0].find((m: DisplayMessage) => m.id === message.id)
    expect(readManagedDeepChapterDraftMessage(updated.content)).toMatchObject({
      conversationId: draft.conversation_id,
      sessionId: draft.session_id,
      draftStatus: "rejected",
    })
    expect(screen.getByTestId("save-status").textContent).toContain("已拒绝草稿")
  })

  it("丢弃草稿失败 → saveFailed", async () => {
    mocks.wikiState.project = PROJECT
    mocks.rejectDeepChapterDraft.mockRejectedValueOnce(new Error("reject-boom"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("保存失败：{{message}}::reject-boom")
  })

  it("丢弃后再保存 → 无助手草稿早退（discarded 被过滤）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    rerenderPanel()
    // markLastAssistantDiscarded 将最后助手消息标记 discarded（getLatestAssistantDraftContext 过滤）
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it.each([
    ["正文已改变", (body: string) => `${body}\n不同结尾`],
    ["正文前多了非思考内容", (body: string) => `附加正文\n\n${body}`],
  ] as const)("相同会话但%s → Save 与 Review 均不写入", async (_label, staleBody) => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("# 第5章 现行存档\n正文")
    setMessages([{ ...message, content: appendManagedDeepChapterDraftMarker(staleBody(draft.content), {
      conversationId: draft.conversation_id, sessionId: draft.session_id, draftStatus: "ready",
    }) }])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("无法确认保存结果")
    fireEvent.click(screen.getByTestId("review-draft"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("无法复核当前草稿")
    expect(mocks.requireManagedDeepChapterDraft).toHaveBeenCalledTimes(2)
    expect(mocks.rerunMainControlGates).not.toHaveBeenCalled()
    expect(mocks.getManagedDraftAdoptionGate).not.toHaveBeenCalled()
    expect(mocks.readManagedChapterForWrite).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("普通助手正文没有受管标记，不读存档也不写正式章", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ role: "assistant", content: "# 第5章 普通消息\n正文" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.requireManagedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it.each(["pending", "accepted"] as const)("存档为 %s 时不能借 ready 标记采纳", async (draft_status) => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("# 第5章 草稿\n正文")
    mocks.requireManagedDeepChapterDraft.mockResolvedValue({ ...draft, draft_status })
    setMessages([message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.getManagedDraftAdoptionGate).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("旧草稿缺章号，无法从正文明确识别时不得复核或保存到下一章", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    const { draft, message } = mockManagedDraft("未明确章号的正文", { chapter_number: undefined })
    setMessages([message])
    renderPanel()
    fireEvent.click(screen.getByTestId("review-draft"))
    await flushAsync()
    expect(mocks.detectGeneratedTargetChapterNumber).toHaveBeenCalledWith(draft.content)
    expect(screen.getByTestId("save-status").textContent).toContain("未绑定章号")
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.rerunMainControlGates).not.toHaveBeenCalled()
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  // ── C4 覆盖守卫（目标章节已有正文 → 显式确认后才覆盖）─────────────────────
  it("C4 覆盖守卫：目标章节已有正文 → 先弹确认，确认前不写入", async () => {
    mocks.wikiState.project = PROJECT
    const chapterPath = "/p/mybook/wiki/chapters/第7章 旧稿.md"
    const original = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 7\r\nchapter_status: final\r\n---\r\n\r\n# 第7章 旧稿\r\n\r\n已有正文 \r\n"
    mocks.findChapterFileByNumber.mockResolvedValue(chapterPath)
    mocks.readManagedChapterForWrite.mockResolvedValue(original)
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第7章 标题\n新正文内容", { chapter_number: 7 }).message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.readManagedChapterForWrite).toHaveBeenCalledWith(chapterPath)
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("chapter-overwrite-accept"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterNumber: 7,
        chapterPath,
        expectedExistingContent: original,
        overwriteExisting: true,
      }),
    )
  })

  it("C4 覆盖守卫：取消覆盖 → 不写入 + 状态提示未覆盖", async () => {
    mocks.wikiState.project = PROJECT
    mocks.readManagedChapterForWrite.mockResolvedValue("---\ntype: chapter\n---\n\n旧正文")
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第7章 新稿\n新正文内容", { chapter_number: 7 }).message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    fireEvent.click(screen.getByTestId("chapter-overwrite-cancel"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("已取消保存：目标章节已有正文")
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
  })

  it.each(["conversation", "project"] as const)("覆盖确认后 %s 已切换 → 不写原目标", async (changed) => {
    mocks.wikiState.project = PROJECT
    mocks.readManagedChapterForWrite.mockResolvedValue("旧正文")
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第5章 新稿\n新正文").message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    const confirm = screen.getByTestId("chapter-overwrite-accept")
    if (changed === "project") mocks.wikiState.project = { ...PROJECT, path: "/p/other-book" }
    else mocks.chatState.activeConversationId = "conv-other"
    fireEvent.click(confirm)
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("C4 覆盖守卫：目标存在但无正文（planned 骨架）→ 不弹确认直接保存", async () => {
    mocks.wikiState.project = PROJECT
    const skeleton = "---\ntype: chapter\nchapter_number: 7\nchapter_status: planned\n---\n"
    mocks.readManagedChapterForWrite.mockResolvedValue(skeleton)
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第7章 新稿\n新正文内容", { chapter_number: 7 }).message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedExistingContent: skeleton, overwriteExisting: false,
    }))
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
  })

  it.each(["invalid UTF-8", "existence query failed"])("严格读取失败（%s）→ 不弹确认、不写入", async (error) => {
    mocks.wikiState.project = PROJECT
    mocks.readManagedChapterForWrite.mockRejectedValueOnce(new Error(error))
    setConversation("conv-1")
    setMessages([mockManagedDraft("# 第7章 新稿\n新正文内容", { chapter_number: 7 }).message])
    renderPanel()
    fireEvent.click(screen.getByTestId("save-as-chapter"))
    await flushAsync()
    expect(mocks.readManagedChapterForWrite).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-007.md")
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
    expect(screen.getByTestId("save-status").textContent).toContain("无法确认保存结果")
  })
})

describe("ChatPanel — exemplar 标记 UI", () => {
  it("打开对话框：选中文本 → 显示文本 + 计数；空选 → 提示", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockImplementation(async () => [{ exemplarId: "e1", chapterId: "ch-1", text: "x", markType: "style", createdAt: "t" }])
    setConversation("conv-1")
    renderPanel()
    // 空选择
    window.getSelection = (() => ({ toString: () => "" })) as any
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    expect(screen.queryByTestId("dialog")).toBeNull()
    // 有效选择
    window.getSelection = (() => ({ toString: () => "这一段写得很好" })) as any
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("这一段写得很好")).toBeInTheDocument()
    expect(screen.getByTestId("dialog").textContent).toContain("1")
    expect(mocks.loadStyleExemplarsViaRust).toHaveBeenCalledWith("/p/mybook")
  })

  it("打开对话框时计数加载失败 → 非致命", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockRejectedValueOnce(new Error("io"))
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("无项目点击标记 → 直接返回", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("提交标记成功：markType/note 透传 + 计数刷新 + 关闭 + 反馈", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockImplementation(async () => [
      { exemplarId: "e1", chapterId: "ch-1", text: "x", markType: "style", createdAt: "t" },
      { exemplarId: "e2", chapterId: "ch-2", text: "y", markType: "voice", createdAt: "t" },
    ])
    window.getSelection = (() => ({ toString: () => "选段文本" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    const markTypeSelect = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === "style") as HTMLSelectElement
    fireEvent.change(markTypeSelect, { target: { value: "voice" } })
    fireEvent.change(screen.getByPlaceholderText("为什么喜欢这段写法？（可选）"), {
      target: { value: "角色声线" },
    })
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(mocks.markStyleExemplarViaRust).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ markType: "voice", note: "角色声线", text: "选段文本", chapterId: "chat-selection" }),
    )
    // 提交后计数刷新（打开时 + 提交后）
    expect(mocks.loadStyleExemplarsViaRust).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("dialog")).toBeNull() // 成功后关闭
  })

  it("提交标记失败 → 失败反馈保留对话框", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.markStyleExemplarViaRust.mockRejectedValueOnce(new Error("write-fail"))
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(screen.getByText("收藏失败：write-fail")).toBeInTheDocument()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("取消按钮关闭对话框", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getByText("取消"))
    rerenderPanel()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("exemplar dialog：dialog-close（onOpenChange false）→ 关闭并重置状态", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dialog-close"))
    rerenderPanel()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("A/B 评分：enabled/disabled 各档按钮 → appendExemplarABSample + 均分反馈", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: 4.2, disabledAvg: null })
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getAllByText("3★")[0]!)
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ variant: "enabled", score: 3, chapterId: "chat" }),
    )
    expect(screen.getByText(/开启参考均分 4.20，关闭参考均分 暂无/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByText("2★")[1]!)
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ variant: "disabled", score: 2 }),
    )
  })

  it("A/B 评分：均分为 null 时显示 N/A（disabled 有值时 toFixed）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: 3.5 })
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getAllByText("1★")[0]!)
    await flushAsync()
    expect(screen.getByText(/开启参考均分 暂无，关闭参考均分 3.50/)).toBeInTheDocument()
  })

  it("selectedFile 存在时 chapterId 取文件名", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.selectedFile = "/p/mybook/wiki/chapters/chapter-003.md"
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为风格范例"))
    rerenderPanel()
    fireEvent.click(screen.getAllByText("1★")[0]!)
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ chapterId: "chapter-003.md" }),
    )
  })
})

describe("ChatPanel — 补覆盖：标签交互与虚拟列表防御", () => {
  it("点击会话标签切换会话（onClick 路径）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    fireEvent.click(screen.getAllByRole("tab")[1])
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-2")
  })

  it("hover 后离开标签 → 删除按钮隐藏（onMouseLeave 重置 hoveredId）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab2 = screen.getAllByRole("tab")[1]
    // 常渲染 + opacity-0 隐藏（键盘可达性，见 P0-B5）
    expect(within(tab2).getByLabelText("删除该会话")).toHaveClass("opacity-0")
    fireEvent.mouseEnter(tab2)
    expect(within(tab2).getByLabelText("删除该会话")).not.toHaveClass("opacity-0")
    fireEvent.mouseLeave(tab2)
    expect(within(tab2).getByLabelText("删除该会话")).toHaveClass("opacity-0")
  })

  it("失焦时 confirmDeleteId 属于其他标签 → 保留原确认态", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const [tab1, tab2] = screen.getAllByRole("tab")
    fireEvent.mouseEnter(tab2)
    fireEvent.click(within(tab2).getByLabelText("删除该会话")) // 武装 conv-2
    fireEvent.click(within(tab1).getByLabelText("删除该会话")) // 再武装 conv-1
    // 对 conv-2 的按钮失焦：cur=conv-1 ≠ conv-2 → 保留 conv-1 的确认态
    fireEvent.blur(within(tab2).getByLabelText("删除该会话"))
    expect(within(tab1).getByLabelText("确认删除该会话")).toBeInTheDocument()
  })

  it("虚拟列表防御：越界项 getItemKey ?? 兜底 + msg undefined 跳过", () => {
    mocks.useVirtualizer.mockImplementation((opts: any) => {
      const count = opts.count
      const items = Array.from({ length: count + 1 }, (_v, i) => ({
        index: i,
        key: opts.getItemKey(i),
        start: i * 200,
        size: 200,
      }))
      return {
        getVirtualItems: () => items,
        getTotalSize: () => (count + 1) * 200,
        measureElement: () => {},
      }
    })
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    expect(screen.getAllByTestId("chat-message")).toHaveLength(1) // 越界项被跳过
  })
})
