// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen, within, waitFor } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, deepGenResult, reviewResult, sessionStatus, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, flushAsync, lastStreamChatCall, lastFinalize } from "./chat-panel-test-setup"

const mocks = getChatPanelMocks()
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
    expect(msgs[0].content).toContain("CONTEXT_PACK_PROMPT")
    expect(lastFinalize()[0]).toContain("## 继续未完成")
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
    expect(msgs[0].content).toContain("专业小说写作助手")
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

  it("保存成功（next 策略）：写 chapter 文件 + accepted marker + 状态回填 + 切 wiki 视图", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第3章" }),
      msg({ id: "a1", role: "assistant", content: "# 第3章 标题\n正文内容" }),
    ])
    mocks.cleanGeneratedChapterContentWithTitle.mockReturnValue({ content: "清理后正文", title: "标题X" })
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.getNextChapterNumber).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters")
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p/mybook",
        conversationId: "conv-1",
        chapterNumber: 7,
        chapterPath: "/p/mybook/wiki/chapters/chapter-007.md",
      }),
    )
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.chatState.setMessages).toHaveBeenCalled()
    const setMessagesCall = mocks.chatState.setMessages.mock.calls[0][0]
    const updated = setMessagesCall.find((m: any) => m.id === "a1")
    expect(decodeURIComponent(updated.content)).toContain('"draftStatus":"accepted"')
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-007.md")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
    expect(screen.getByTestId("save-status").textContent).toContain("已接受草稿并保存为 标题X")
    expect(mocks.wikiState.novelConfig.autoIngestOnSave).toBe(false) // 默认关闭
  })

  it("保存成功（direct_explicit_target_new 策略）：targetChapterNumber 直接使用", async () => {
    mocks.wikiState.project = PROJECT
    mocks.decideChapterSaveStrategy.mockReturnValue({
      action: "direct_explicit_target_new",
      targetChapterNumber: 5,
    })
    mocks.detectGeneratedTargetChapterNumber.mockReturnValue(5)
    mocks.findChapterFileByNumber.mockImplementation(async () => null)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写章节" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 5, chapterPath: "/p/mybook/wiki/chapters/chapter-005.md" }),
    )
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
  })

  it("autoIngestOnSave：可用 LLM + 摄取成功", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.ingestChapter.mockImplementation(async () => ({
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
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    // 动态导入 chapter-ingest / canon-dual-write 超出单次 setTimeout(0) 的 flush 能力，改用轮询断言
    await waitFor(() => {
      expect(screen.getByTestId("save-status").textContent).toContain("已接受草稿并保存为 测试章")
    })
    expect(mocks.ingestChapter).toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).not.toContain("未完成")
  })

  it("autoIngestOnSave：摄取无 snapshot → 提示未完成", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.ingestChapter.mockImplementation(async () => ({ snapshot: null }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    // 同上：动态导入导致时序超出 flushAsync，改用轮询断言
    await waitFor(() => {
      expect(screen.getByTestId("save-status").textContent).toContain("但章节摄取未完成")
    })
  })

  it("autoIngestOnSave：无可用 LLM → 提示未配置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.hasUsableLlm.mockReturnValue(false)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("未配置可用 AI 模型")
  })

  it("保存失败 → saveFailed 状态（含错误消息）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce(new Error("disk-error"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("保存失败：{{message}}::disk-error")
  })

  it("丢弃草稿成功：reject 落盘 + rejected marker + 标记丢弃", async () => {
    mocks.wikiState.project = PROJECT
    mocks.detectGeneratedTargetChapterNumber.mockReturnValue(3)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 3, conversationId: "conv-1" }),
    )
    expect(mocks.chatState.markLastAssistantDiscarded).toHaveBeenCalled()
    const setMessagesCall = mocks.chatState.setMessages.mock.calls[0][0]
    const updated = setMessagesCall.find((m: any) => m.id === "a1")
    expect(decodeURIComponent(updated.content)).toContain('"draftStatus":"rejected"')
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

  it("findPreviousUserRequest：『继续未完成』用户消息被跳过，回退到前一条", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "第一版" }),
      msg({ id: "u2", role: "user", content: "继续未完成" }),
      msg({ id: "a2", role: "assistant", content: "第二版" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "原始需求" }),
    )
  })

  it("findPreviousUserRequest：全部用户消息均为『继续未完成』→ 回退 userMessages[0]", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "继续未完成" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "继续未完成" }),
    )
  })

  it("findPreviousUserRequest：无用户消息 → userRequest 空 → 正文前 80 字兜底", async () => {
    mocks.wikiState.project = PROJECT
    mocks.cleanGeneratedChapterContentWithTitle.mockReturnValue({ content: "清理后正文", title: "" })
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "正文" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "清理后正文" }),
    )
  })

  // ── C4 覆盖守卫（目标章节已有正文 → 显式确认后才覆盖）─────────────────────
  it("C4 覆盖守卫：目标章节已有正文 → 先弹确认，确认前不写入", async () => {
    mocks.wikiState.project = PROJECT
    mocks.fileExists.mockImplementation(async () => true)
    mocks.readFile.mockImplementation(
      async () => "---\ntype: chapter\nchapter_number: 7\nchapter_status: draft\n---\n\n# 第7章 旧稿\n\n已有正文",
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第7章" }),
      msg({ id: "a1", role: "assistant", content: "# 第7章 标题\n新正文内容" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    // 未经确认：不调用 accept 通道、不落盘
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("chapter-overwrite-accept")).toBeTruthy()
    fireEvent.click(screen.getByTestId("chapter-overwrite-accept"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterNumber: 7,
        chapterPath: "/p/mybook/wiki/chapters/chapter-007.md",
      }),
    )
  })

  it("C4 覆盖守卫：取消覆盖 → 不写入 + 状态提示未覆盖", async () => {
    mocks.wikiState.project = PROJECT
    mocks.fileExists.mockImplementation(async () => true)
    mocks.readFile.mockImplementation(async () => "---\ntype: chapter\n---\n\n旧正文")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第7章" }),
      msg({ id: "a1", role: "assistant", content: "新正文内容" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    fireEvent.click(screen.getByTestId("chapter-overwrite-cancel"))
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("已取消保存：目标章节已有正文")
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
  })

  it("C4 覆盖守卫：目标存在但无正文（planned 骨架）→ 不弹确认直接保存", async () => {
    mocks.wikiState.project = PROJECT
    mocks.fileExists.mockImplementation(async () => true)
    mocks.readFile.mockImplementation(
      async () => "---\ntype: chapter\nchapter_number: 7\nchapter_status: draft\n---\n",
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第7章" }),
      msg({ id: "a1", role: "assistant", content: "新正文内容" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalled()
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
  })

  it("C4 覆盖守卫：目标存在但正文读取失败 → 保守要求确认", async () => {
    mocks.wikiState.project = PROJECT
    mocks.fileExists.mockImplementation(async () => true)
    mocks.readFile.mockRejectedValueOnce(new Error("read-boom"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第7章" }),
      msg({ id: "a1", role: "assistant", content: "新正文内容" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("chapter-overwrite-accept")).toBeTruthy()
  })

  it("C4 覆盖守卫：存在性查询失败 → 降级放行（不弹确认、不阻断写作）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.fileExists.mockRejectedValueOnce(new Error("ipc-down"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第7章" }),
      msg({ id: "a1", role: "assistant", content: "新正文内容" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalled()
    expect(screen.queryByTestId("chapter-overwrite-accept")).toBeNull()
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
    const countSpan = screen.getByTestId("dialog").querySelector("span.font-mono")
    expect(countSpan?.textContent).toContain("1")
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
    fireEvent.change(screen.getByPlaceholderText("为什么这段是好文风锚点？"), {
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
    expect(screen.getByText("标记失败：write-fail")).toBeInTheDocument()
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
    fireEvent.click(screen.getByText("3★开"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ variant: "enabled", score: 3, chapterId: "chat" }),
    )
    expect(screen.getByText(/开启均分 4.20，关闭均分 无/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("2★关"))
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
    fireEvent.click(screen.getByText("1★开"))
    await flushAsync()
    expect(screen.getByText(/开启均分 无，关闭均分 3.50/)).toBeInTheDocument()
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
    fireEvent.click(screen.getByText("1★开"))
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
