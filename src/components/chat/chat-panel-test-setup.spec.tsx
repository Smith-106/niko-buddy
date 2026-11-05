// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { getChatPanelMocks } from "./chat-panel-test-setup"

const mocks = getChatPanelMocks()

/** 哨兵入参：这些用例只验证 mock 返回被配置的值，入参不参与断言。 */
function dummy<T = unknown>(): T {
  return {} as T
}

beforeAll(async () => {
  mocks.streamGuard.start("conv-1")
  mocks.streamGuard.isActive("conv-1", 1)
  mocks.deepStreamRenderer.updateThinking("think")
  mocks.deepStreamRenderer.appendFinal("final")
  mocks.deepStreamRenderer.getContent()
  mocks.t("nope.missing.key.xyz")
  mocks.t("nope.missing.key.xyz", { message: "m" })
  await mocks.streamChat(dummy(), [], {
    onToken: () => {},
    onDone: () => {},
    onError: () => {},
  })
  await mocks.executeIngestWrites("/p", dummy())
  mocks.routeTask("hi")
  mocks.buildTaskDirective(dummy())
  await mocks.markStyleExemplarViaRust("/p", dummy())
  await mocks.deleteStyleExemplarViaRust("/p", "ex-1")
  await mocks.refreshProjectState("/p")
  await mocks.readFile("/a.txt")
  await mocks.fileExists("/a.txt")
  await mocks.loadStyleExemplarsViaRust("/p")
  mocks.exemplarABStats(null)
  await mocks.searchWiki("/p", "q")
  mocks.detectLastGeneratedChapterNumber(["hi"])
  await mocks.findChapterFileByNumber("/p", 1)
  await mocks.getNextChapterNumber("/p")
  await mocks.readSelectedChapterNumberForFile("f.md")
  await mocks.resolveTargetChapterNumberForChat(dummy())
  mocks.buildQmQuaiSystemPrompt()
  mocks.cleanGeneratedChapterContentWithTitle("body")
  mocks.isGreeting("hello")
  mocks.hasUsableLlm(dummy())
  mocks.buildGoldenThreeChapterDirective(undefined)
  mocks.detectGoldenThreeChapterRequest("hi")
  mocks.isChatEditRequest("hi")
  mocks.resolveChatEditTarget(dummy())
  mocks.validateStructuredChapterEditResult(dummy())
  mocks.decideChapterSaveStrategy(dummy())
  mocks.detectGeneratedTargetChapterNumber("x")
  mocks.normalizeChapterEditFile(dummy())
  mocks.createNovelSessionId()
  await expect(mocks.loadNovelSessionStatus("/p")).rejects.toThrow("no status")
  await mocks.pauseDeepChapterSession(dummy())
  await mocks.persistDeepChapterCheckpoint(dummy())
  mocks.resolveInterruptedSessionResumeCheckpoint(null, dummy())
  await mocks.startDeepChapterSession(dummy())
  mocks.appendContinueUnfinishedDeepChapterContext("c", dummy())
  mocks.buildInterruptedResumeContextPayload(null, "conv-1")
  mocks.buildContinueUnfinishedDeepChapterPrompt(dummy())
  mocks.extractContinueUnfinishedDeepChapterContext("c")
  await mocks.runDeepChapterGeneration(dummy())
  await mocks.buildContextPack("/p", "task")
  mocks.contextPackToPrompt(dummy())
  await mocks.buildRetrievalGraph("/p")
  mocks.getRelatedNodes("n", dummy())
  mocks.detectEditIntent("hi")
  mocks.buildAgentSystemSuffix("chapters")
  await mocks.readScopeFileContents("/p", "chapters")
  await mocks.ingestChapter("/p", "/c.md")
  mocks.resolveChapterLengthSpec()
})

describe("chat-panel-test-setup mock 工厂默认行为补覆盖", () => {
  it("chatState 基础 setter 默认实现", () => {
    mocks.chatState.setConversations([{ id: "c1" }])
    expect(mocks.chatState.conversations).toEqual([{ id: "c1" }])

    mocks.chatState.streamingContents = { "conv-1": "x" }
    mocks.chatState.clearStreaming("conv-1")
    expect(mocks.chatState.streamingContents).toEqual({})

    mocks.chatState.setMode("ingest")
    expect(mocks.chatState.mode).toBe("ingest")

    mocks.chatState.setIngestSource("src")
    expect(mocks.chatState.ingestSource).toBe("src")
    mocks.chatState.setIngestSource(null)
    expect(mocks.chatState.ingestSource).toBeNull()

    mocks.chatState.setMaxHistoryMessages(10)
    expect(mocks.chatState.maxHistoryMessages).toBe(10)

    mocks.chatState.streamingContents = {}
    expect(mocks.chatState.isAnyStreaming()).toBe(false)
    mocks.chatState.streamingContents = { c: "y" }
    expect(mocks.chatState.isAnyStreaming()).toBe(true)
  })

  it("finalizeStream 空会话早退与正常落库", () => {
    mocks.chatState.activeConversationId = null
    mocks.chatState.messages = []
    mocks.chatState.streamingContents = {}
    mocks.chatState.finalizeStream("c", [])
    expect(mocks.chatState.messages).toEqual([])

    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.finalizeStream("hello", [])
    expect(mocks.chatState.messages).toHaveLength(1)
    expect(mocks.chatState.messages[0].content).toBe("hello")
  })

  it("removeLastAssistantMessage 与 markLastAssistantDiscarded 边缘路径", () => {
    mocks.chatState.activeConversationId = null
    mocks.chatState.messages = [{ id: "u1", role: "user", content: "q", conversationId: "conv-1" }]
    mocks.chatState.removeLastAssistantMessage()
    mocks.chatState.markLastAssistantDiscarded()
    expect(mocks.chatState.messages).toHaveLength(1)

    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [{ id: "u1", role: "user", content: "q", conversationId: "conv-1" }]
    mocks.chatState.removeLastAssistantMessage()
    expect(mocks.chatState.messages).toHaveLength(1)
    mocks.chatState.markLastAssistantDiscarded()
    expect(mocks.chatState.messages).toHaveLength(1)

    mocks.chatState.messages = [
      { id: "u1", role: "user", content: "q", conversationId: "conv-1" },
      { id: "a1", role: "assistant", content: "a", conversationId: "conv-1" },
    ]
    mocks.chatState.removeLastAssistantMessage()
    expect(mocks.chatState.messages).toHaveLength(1)

    mocks.chatState.messages = [
      { id: "u1", role: "user", content: "q", conversationId: "conv-1" },
      { id: "a1", role: "assistant", content: "a", conversationId: "conv-1" },
    ]
    mocks.chatState.markLastAssistantDiscarded()
    expect(mocks.chatState.messages[1].discarded).toBe(true)
    expect(mocks.chatState.messages[1].content).toBe("")
  })

  it("streamGuard 与 deepStreamRenderer 与 t 默认行为", () => {
    expect(mocks.streamGuard.start("conv-1")).toBe(1)
    expect(mocks.streamGuard.isActive("conv-1", 1)).toBe(true)
    const cb = vi.fn()
    mocks.streamGuard.runIfActive("conv-1", 1, cb)
    expect(cb).toHaveBeenCalledTimes(1)

    expect(mocks.deepStreamRenderer.updateThinking("think")).toBe("think")
    expect(mocks.deepStreamRenderer.appendFinal("final")).toBe("final")
    expect(mocks.deepStreamRenderer.getContent()).toBe("")

    expect(mocks.t("nope.missing.key.xyz")).toBe("nope.missing.key.xyz")
    expect(mocks.t("nope.missing.key.xyz", { message: "m" })).toBe("nope.missing.key.xyz::m")
  })

  it("lib 基础链路 mock 默认返回值", async () => {
    const onDone = vi.fn()
    await mocks.streamChat(dummy(), [], {
      onToken: () => {},
      onDone,
      onError: () => {},
    })
    expect(onDone).toHaveBeenCalledTimes(1)

    await expect(mocks.executeIngestWrites("/p", dummy())).resolves.toEqual([])
    expect(mocks.routeTask("hi")).toEqual({
      intent: "general_chat",
      confidence: 1,
      chapterNumber: undefined,
      extractedParams: {},
    })
    expect(mocks.buildTaskDirective(dummy())).toBe("")
    await expect(mocks.readFile("/a.txt")).resolves.toBe("")
    await expect(mocks.fileExists("/a.txt")).resolves.toBe(false)
    await mocks.markStyleExemplarViaRust("/p", dummy())
    await mocks.deleteStyleExemplarViaRust("/p", "ex-1")
    await mocks.refreshProjectState("/p")
    await expect(mocks.loadStyleExemplarsViaRust("/p")).resolves.toEqual([])
    expect(mocks.exemplarABStats(null)).toEqual({ enabledAvg: null, disabledAvg: null })
    await expect(mocks.searchWiki("/p", "q")).resolves.toEqual([])
    expect(mocks.tokenizeQuery("Hello World")).toEqual(["hello", "world"])
    expect(mocks.detectLastGeneratedChapterNumber(["hi"])).toBeUndefined()
    await expect(mocks.findChapterFileByNumber("/p", 1)).resolves.toBeNull()
    await expect(mocks.getNextChapterNumber("/p")).resolves.toBe(7)
    await expect(mocks.readSelectedChapterNumberForFile("f.md")).resolves.toBeUndefined()
    await expect(mocks.resolveTargetChapterNumberForChat(dummy())).resolves.toBe(5)
    expect(mocks.buildQmQuaiSystemPrompt()).toBe("")
    expect(mocks.cleanGeneratedChapterContentWithTitle("body")).toEqual({
      content: "body",
      title: "测试章",
    })
    expect(mocks.isGreeting("hello")).toBe(false)
  })

  it("llm 与金章三章及编辑模式 mock 默认返回值", () => {
    expect(mocks.hasUsableLlm(dummy())).toBe(true)
    expect(mocks.buildGoldenThreeChapterDirective(undefined)).toBe("")
    expect(mocks.detectGoldenThreeChapterRequest("hi")).toEqual({
      enabled: false,
      requestedFirstThree: false,
    })
    expect(mocks.isChatEditRequest("hi")).toBe(false)
    expect(mocks.resolveChatEditTarget(dummy()).ok).toBe(false)
    expect(mocks.validateStructuredChapterEditResult(dummy()).ok).toBe(false)
    expect(mocks.decideChapterSaveStrategy(dummy())).toEqual({ action: "direct_next_chapter" })
    expect(mocks.detectGeneratedTargetChapterNumber("x")).toBeNull()
    const normalized = mocks.normalizeChapterEditFile(dummy())
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.content).toBe("NORMALIZED")
    }
  })

  it("novel 会话状态机 mock 默认返回值", async () => {
    expect(mocks.createNovelSessionId()).toBe("synthetic-session")
    await expect(mocks.loadNovelSessionStatus("/p")).rejects.toThrow("no status")

    const paused = await mocks.pauseDeepChapterSession(dummy())
    expect(paused.status).toBe("paused")

    const persisted = await mocks.persistDeepChapterCheckpoint(dummy())
    expect(persisted.status).toBe("running")

    expect(mocks.resolveInterruptedSessionResumeCheckpoint(null, dummy())).toBeUndefined()

    const started = await mocks.startDeepChapterSession(dummy())
    expect(started.status).toBe("running")
  })

  it("续写上下文与深度生成 mock 默认返回值", async () => {
    expect(mocks.appendContinueUnfinishedDeepChapterContext("c", dummy())).toBe("c")
    expect(mocks.buildInterruptedResumeContextPayload(null, "conv-1")).toBeNull()
    expect(mocks.buildContinueUnfinishedDeepChapterPrompt(dummy())).toBe("RESUME_PROMPT")
    expect(mocks.extractContinueUnfinishedDeepChapterContext("c")).toBeNull()

    const deep = await mocks.runDeepChapterGeneration(dummy())
    expect(deep.finalContent).toBe("FINAL")

    const plan = await mocks.buildChapterPlan()
    expect(plan.chapterNumber).toBe(3)
  })

  it("上下文引擎与检索及摄取 mock 默认返回值", async () => {
    const pack = await mocks.buildContextPack("/p", "task")
    expect(pack.task).toBe("")
    expect(mocks.contextPackToPrompt(dummy())).toBe("CONTEXT_PROMPT")

    const graph = await mocks.buildRetrievalGraph("/p")
    expect(graph.dataVersion).toBe(0)
    expect(mocks.getRelatedNodes("n", dummy())).toEqual([])
    expect(mocks.detectEditIntent("hi")).toBe(false)
    expect(mocks.buildAgentSystemSuffix("chapters")).toBe("AGENT_SUFFIX")
    await expect(mocks.readScopeFileContents("/p", "chapters")).resolves.toEqual([])
    await expect(mocks.ingestChapter("/p", "/c.md")).resolves.toEqual({ snapshot: null })
    expect(mocks.resolveChapterLengthSpec()).toEqual({
      targetChars: 3000,
      minChars: 1500,
      draftMaxChars: 6000,
      maxOutputTokens: 4000,
    })
    expect(mocks.getLastQueryPages()).toEqual([])
  })

  it("tooltip fallback branch and selection sentinel", async () => {
    const tooltipModule = await import("@/components/ui/tooltip")
    const MockedTrigger = tooltipModule.TooltipTrigger
    render(<MockedTrigger>fallback-content</MockedTrigger>)
    expect(screen.getByText("fallback-content")).toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe("")
  })
})