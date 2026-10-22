// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, deepGenResult, reviewResult, sessionStatus, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, flushAsync, sendText, lastFinalize, setDeepMode } from "./chat-panel-test-setup"

const mocks = getChatPanelMocks()
describe("ChatPanel — 编辑章节模式 (chat edit mode)", () => {
  function setupEditMode(): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.chatEditModeEnabled = true
    mocks.isChatEditRequest.mockReturnValue(true)
  }

  it("resolveChatEditTarget 失败 → finalize 提示并返回", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({ ok: false as const, message: "目标解析失败" })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(lastFinalize()[0]).toBe("目标解析失败")
  })

  it("目标章节文件缺失 → 提示缺失章节", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      n === 3 ? `${pp}/wiki/chapters/chapter-003.md` : null,
    )
    setConversation("conv-1")
    renderPanel()
    await sendText("修改3、4章")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("未找到以下章节")
    expect(lastFinalize()[0]).toContain("第4章")
  })

  it("单章修改成功：写回 + 备份 + 刷新 + 选中文件 + finalize 完成文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.readFile.mockImplementation(async () => "原文内容")
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("修改后内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.backupChapterFile).toHaveBeenCalledWith(
      expect.objectContaining({ chapterPath: "/p/mybook/wiki/chapters/chapter-003.md", chapterNumber: 3 }),
    )
    expect(mocks.writeFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-003.md", "NORMALIZED")
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-003.md")
    expect(lastFinalize()[0]).toContain("已完成第3章修改")
    await flushAsync()
  })

  it("多章修改成功：逐章写回 + 批量完成文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-00${3}${4}.md`.slice(0, 0) || `${pp}/wiki/chapters/chapter-00X.md`)
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.readFile.mockImplementation(async () => "原文")
    mocks.validateStructuredChapterEditResult.mockReturnValue({
      ok: true as const,
      files: [
        { chapterNumber: 3, content: "A内容" },
        { chapterNumber: 4, content: "B内容" },
      ],
    })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("MULTI")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(mocks.writeFile).toHaveBeenNthCalledWith(1, "/p/mybook/wiki/chapters/chapter-003.md", "NORMALIZED")
    expect(mocks.writeFile).toHaveBeenNthCalledWith(2, "/p/mybook/wiki/chapters/chapter-004.md", "NORMALIZED")
    expect(lastFinalize()[0]).toContain("已完成 2 个章节的批量修改")
    await flushAsync()
  })

  it("多章校验失败 → finalize 校验消息", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.validateStructuredChapterEditResult.mockReturnValue({ ok: false as const, message: "解析失败" })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(lastFinalize()[0]).toBe("解析失败")
  })

  it("多章某章缺修改结果 → 停止写回该章", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.validateStructuredChapterEditResult.mockReturnValue({
      ok: true as const,
      files: [{ chapterNumber: 3, content: "A" }],
    })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(lastFinalize()[0]).toContain("第4章缺少修改结果")
  })

  it("normalize 失败 → finalize 归一化错误", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.normalizeChapterEditFile.mockReturnValue({ ok: false as const, message: "格式错误" })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(lastFinalize()[0]).toBe("格式错误")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("edit onError → finalize 修改失败文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("API boom"))
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(lastFinalize()[0]).toContain("修改失败：")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("edit onToken 时 guard 失效 → token 被忽略", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onToken?.("有效内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.chatState.appendStreamToken).toHaveBeenCalledTimes(1)
    expect(mocks.chatState.appendStreamToken).toHaveBeenCalledWith("有效内容", "conv-1")
    expect(mocks.writeFile).toHaveBeenCalled()
  })
})

describe("ChatPanel — 深度章节生成 (deep chapter)", () => {
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

  it("深度生成成功：complete 落盘 + ready marker（residual 字段展开）", async () => {
    setupDeepBase()
    mocks.wikiState.novelConfig.residualCampaignEnabled = true
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写第3章")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/p/mybook", conversationId: "conv-1", chapterNumber: 3 }),
    )
    expect(mocks.resolveResidualCampaignFields).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, chapterNumber: 3 }),
    )
    const genInput = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(genInput.residualOverallMedian).toBe(9.0)
    expect(genInput.residualRewriteMode).toBe("structure_thril_pacing")
    // R9（Round-9 用户可感知开关）：stageJournalEnabled 缺省（mock sparse fixture 未设=undefined）→ 视为开，
    // 任务书缓存默认随行（digest-keyed 去重；关=genInput.stageJournal 缺席）。
    expect(genInput.stageJournal).toBeDefined()
    expect(genInput.stageJournal?.projectId).toBe("/p/mybook")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    expect(mocks.blockDeepChapterSession).not.toHaveBeenCalled()
    expect(mocks.pauseDeepChapterSession).not.toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("<!-- niko-buddy-deep-chapter-draft:")
    expect(decodeURIComponent(content)).toContain('"draftStatus":"ready"')
    // Wave 5: 上下文用量标记随 draft 标记同追 + completeDeepChapterSession 透传
    expect(content).toContain("<!-- niko-buddy-context-usage:")
    expect(decodeURIComponent(content)).toContain('"memoryChars":80')
    expect(mocks.completeDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: expect.objectContaining({ maxCtx: 100000 }) }),
    )
    setDeepMode(false)
  })

  it("F10-2：stageJournalEnabled=false → helper 回 undefined → genInput.stageJournal 缺席（直调 LLM）", async () => {
    setupDeepBase()
    mocks.wikiState.novelConfig.stageJournalEnabled = false
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写第3章")
    const genInput = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(genInput.stageJournal).toBeUndefined()
    delete mocks.wikiState.novelConfig.stageJournalEnabled
    setDeepMode(false)
  })

  it("深度生成无 contextUsage（空包降级）→ 不追加用量标记、不透传字段", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ contextUsage: undefined }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("niko-buddy-context-usage")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: undefined }),
    )
    setDeepMode(false)
  })

  it("contextUsage 标记 JSON 序列化失败（BigInt 字段）→ 降级无用量标记", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () =>
      deepGenResult({ contextUsage: { memoryChars: 1n as any, retrievalChars: 0, graphChars: 0, bodyChars: 0, otherChars: 0, maxCtx: 100 } }),
    )
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("niko-buddy-context-usage")
    setDeepMode(false)
  })

  it("深度生成 manualReviewRequired → block + pending marker", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", reviewResults: [reviewResult()], manualReviewRequired: true, retryCount: 3 }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.blockDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
    setDeepMode(false)
  })

  it("深度生成 partial → pause + pending marker", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "部分正文", partial: true, partialReason: "transport inactivity timeout" }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("写到一半的正文已留下") }),
    )
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
    setDeepMode(false)
  })

  it("checkpoint 落盘失败 → 抛 CHECKPOINT_PERSIST_FAILED → catch 可见失败 + 持久化详情", async () => {
    setupDeepBase()
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce(new Error("disk-full"))
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("出错：深度生成章节失败")
    expect(content).toContain("CHECKPOINT_PERSIST_FAILED")
    expect(content).toContain("进度点没能保存")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("深度生成报『已停止生成』→ 中止文案 + resume 上下文", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已停止生成。")
    expect(content).toContain("<!-- niko-buddy-novel-session-debug:")
    expect(content).toContain("appendContinueUnfinishedDeepChapterContext".length > 0 ? "已停止生成" : "")
    setDeepMode(false)
  })

  it("深度生成其他错误 → 可见失败文案（含 hidden debug）", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content, refs] = lastFinalize()
    expect(content).toContain("出错：深度生成章节失败：boom")
    expect(content).toContain("<!-- niko-buddy-novel-session-debug:")
    expect(refs).toBeUndefined()
    setDeepMode(false)
  })

  it("catch 中 pause 落盘失败 → pausePersistError + console.warn + 详情拼接", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce(new Error("pause-io"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("深度生成暂停状态落盘失败"), expect.any(Error))
    const [content] = lastFinalize()
    expect(content).toContain("暂停状态没能保存")
    warnSpy.mockRestore()
    setDeepMode(false)
  })

  it("startDeepChapterSession 提前失败 → 合成 session id（sessionDebug.syntheticSessionId）", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockRejectedValueOnce(new Error("early"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.createNovelSessionId).toHaveBeenCalled()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("出错：深度生成章节失败：early")
    setDeepMode(false)
  })

  it("session 状态中的 resume checkpoint 生效（autoResumedFromStatus true）", async () => {
    setupDeepBase()
    mocks.loadNovelSessionStatus.mockImplementation(async () => sessionStatus({ current_task: {} }))
    mocks.resolveInterruptedSessionResumeCheckpoint.mockReturnValue({ version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeCheckpoint: expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }) }),
    )
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].resumeCheckpoint).toEqual(
      expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }),
    )
    setDeepMode(false)
  })

  it("深度生成 onThinking/onFinalContent 在 guard 失效时跳过", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      callbacks.onThinking("阶段思考")
      callbacks.onFinalContent("正文")
      mocks.streamGuard.isActive.mockReturnValue(true)
      callbacks.onFinalContent("正文2")
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    // guard 失效的更新被跳过；有效的一次生效
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("正文2"), "conv-1")
    setDeepMode(false)
  })

  it("appendHiddenNovelSessionDebug 的 JSON 序列化失败 → 降级为原始内容", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockImplementation(async () =>
      // BigInt 使 JSON.stringify 抛错
      sessionStatus({ session_id: 1n as any, status: "running", active_step_index: 1, updated_at: "t" }),
    )
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).not.toContain("niko-buddy-novel-session-debug")
    expect(content).toContain("出错：深度生成章节失败")
    setDeepMode(false)
  })

  it("Wave 3 计划模式：打开面板 → 装载计划 → 开写 one-shot 透传 → 消费后清除", async () => {
    setupDeepBase()
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    // 未发送过深度请求 → 全书视图（chapter 0）
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).toHaveBeenCalledWith("/p/mybook", 0)
    // 注：chat-panel.spec 的 t mock 返回 key（非 defaultValue）
    expect(screen.getByText("本章确定性范围")).toBeTruthy()
    // 关闭面板
    fireEvent.click(screen.getByLabelText("关闭"))
    rerenderPanel()
    expect(screen.queryByText("本章确定性范围")).toBeNull()
    // 发送深度请求 → 目标章跟随（ref = 3）
    await sendText("深度写第3章")
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).toHaveBeenLastCalledWith("/p/mybook", 3)
    // 开写 → 面板关闭，plan 进入 one-shot 状态
    fireEvent.click(screen.getByText("以此计划开写"))
    rerenderPanel()
    expect(screen.queryByText("本章确定性范围")).toBeNull()
    // 发送 → planningPlan 附加到生成 input（calls[0] 是面板打开前的首次发送）
    await sendText("深度写第3章")
    const genInput = mocks.runDeepChapterGeneration.mock.calls[1][0]
    expect(genInput.planningPlan).toBeDefined()
    expect(genInput.planningPlan!.chapterNumber).toBe(3)
    // 消费后清除：第二次发送不再携带
    await sendText("深度写第3章")
    const genInput2 = mocks.runDeepChapterGeneration.mock.calls[2][0]
    expect(genInput2.planningPlan).toBeUndefined()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：装载失败 → 面板显示错误且不触发生成", async () => {
    setupDeepBase()
    mocks.buildChapterPlan.mockRejectedValueOnce(new Error("plan-io"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByText("plan-io")).toBeTruthy()
    expect(mocks.runDeepChapterGeneration).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：无 project → loadPlanning 直接返回（不装载）", async () => {
    mocks.wikiState.project = null
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：装载失败（非 Error）→ String(error) 显示", async () => {
    setupDeepBase()
    mocks.buildChapterPlan.mockRejectedValueOnce("plan-io-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByText("plan-io-string")).toBeTruthy()
    setDeepMode(false)
  })
})

describe("ChatPanel — 停止 / 重新生成 / 继续下一章", () => {
  it("无活跃会话点击停止 → 直接返回", () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("有会话但无进行中流 → 仅清 abort 引用", () => {
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("流进行中停止 → abort + finalize『已停止生成』（含已有流式内容前缀）", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {})) // 挂起
    await sendText("生成中")
    mocks.chatState.streamingContents = { "conv-1": "部分内容" }
    rerenderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(lastFinalize()[0]).toContain("部分内容")
    expect(lastFinalize()[0]).toContain("已停止生成。")
  })

  it("深度模式流停止 → novelManagedStop 早退，不 finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.runDeepChapterGeneration.mockImplementation(() => new Promise(() => {})) // 挂起
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const finalizeBefore = mocks.chatState.finalizeStream.mock.calls.length
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream.mock.calls.length).toBe(finalizeBefore)
    setDeepMode(false)
  })

  it("重新生成：流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("重新生成：无用户消息 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "a" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("重新生成：删除最后助手与用户消息后重发", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "重发问题" }),
      msg({ id: "a1", role: "assistant", content: "旧回答" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).toHaveBeenCalled()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "重发问题")
    expect(mocks.streamChat).toHaveBeenCalled()
    // setState 过滤旧用户消息后 handleSend 重新加入；onDone finalize 追加一条助手消息
    expect(mocks.chatState.messages).toHaveLength(2)
    expect(mocks.chatState.messages[0].content).toBe("重发问题")
    await flushAsync()
  })

  it("继续下一章：流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-next-chapter"))
    expect(mocks.chatState.createConversation).not.toHaveBeenCalled()
  })

  it("继续下一章：新建会话 + 按目标字数发送生成提示", async () => {
    mocks.wikiState.project = PROJECT
    mocks.resolveChapterLengthSpec.mockReturnValue({ targetChars: 2000, minChars: 1000, draftMaxChars: 4000, maxOutputTokens: 3000 })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-next-chapter"))
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    const sent = mocks.chatState.addMessage.mock.calls.find((c: any[]) => c[0] === "user")
    expect(sent[1]).toContain("继续生成下一章正文")
    expect(sent[1]).toContain("2000")
    await flushAsync()
  })
})
