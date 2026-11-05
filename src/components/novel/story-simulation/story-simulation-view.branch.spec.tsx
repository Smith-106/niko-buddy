// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  StorySimulationView,
  buildConflictDraft,
  pickConflictEvents,
} from "./story-simulation-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type {
  ExtractionResult,
  NovelAgent,
  SerializedSimulationSnapshot,
  SimulationDebugTrace,
  SimulationReport,
  StoryFramework,
  TimelineEvent,
} from "@/lib/novel"
import type { SavedSimulationResult } from "@/stores/story-simulation-store"

/**
 * 分支覆盖增补（BRIEF：story-simulation-view 31 miss）。只增补，不改既有用例。
 * 禁止 as any：全部 helper 用真实类型构造；store 写入走 Partial 状态。
 */

const wikiState = vi.hoisted(() => ({
  project: null as { id: string; name: string; path: string } | null,
  llmConfig: null,
}))

const novelMocks = vi.hoisted(() => ({
  extractStoryContent: vi.fn(),
  generateStoryFramework: vi.fn(),
  buildAgents: vi.fn(),
  runSimulation: vi.fn(),
  generateDynamicEventPool: vi.fn(),
  generateSimulationReport: vi.fn(),
  generateStoryDraft: vi.fn(),
  saveFramework: vi.fn(),
  saveSimulationResult: vi.fn(),
  loadSimulationResults: vi.fn(),
  resolveDefaultModel: vi.fn(),
  interviewAgent: vi.fn(),
  saveInterview: vi.fn(),
  loadInterviews: vi.fn(),
  exportInterview: vi.fn(),
  serializeSimulationState: vi.fn(),
  deserializeSimulationSnapshot: vi.fn(),
  appendStageMetric: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, ...novelMocks }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof wikiState) => unknown) => selector(wikiState),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts && typeof opts.count === "number" ? `${key}#${opts.count}` : key,
  }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}))

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "e1",
    round: 1,
    nodeIndex: 0,
    actorId: "c1",
    actorName: "寨主",
    actionType: "speak",
    content: "今夜子时动手。",
    observableBy: [],
    impacts: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeAgent(id = "c1", name = "寨主"): NovelAgent {
  return {
    characterId: id,
    name,
    profile: "profile",
    aura: null,
    cognition: null,
    soul: "soul",
    currentGoal: "goal",
    emotionalState: "calm",
    knownFacts: new Set<string>(),
    relationships: new Map(),
    powerLevel: "1",
    memory: {
      observedEvents: ["e1"],
      knownSecrets: new Set<string>(["s1"]),
      sentiments: new Map<string, number>([["c2", 10]]),
      recentDecisions: ["d1"],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: ["brave"],
    speakingStyle: "direct",
  }
}

function makeFramework(): StoryFramework {
  return {
    id: "fw1",
    title: "测试框架",
    premise: "premise",
    targetWords: 1000,
    simulationMode: "event-driven",
    sourceChapters: 5,
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "开端",
        coreConflict: "conflict",
        involvedCharacters: ["寨主"],
        goal: "goal",
        causeFromPrev: "cause",
        expectedOutcome: "outcome",
      },
    ],
    createdAt: new Date().toISOString(),
  } as StoryFramework
}

function makeReport(recommendation = "r"): SimulationReport {
  return {
    frameworkId: "fw1",
    mode: "event-driven",
    characterAnalyses: [
      { characterId: "c1", name: "寨主", behaviors: [], stateChanges: [], consistencyScore: 82 },
    ],
    branches: [
      {
        title: "夜袭",
        summary: "s",
        keyEvents: [],
        probability: "high",
        pros: "",
        cons: "",
        recommendation: true,
      },
    ],
    recommendation,
    createdAt: new Date().toISOString(),
  } as SimulationReport
}

function makeExtraction(): ExtractionResult {
  return {
    characters: [{ id: "c1", name: "寨主", profile: "p", aura: null, cognition: null, soul: "s", skillContent: "" }],
    chapterContents: [],
    memoryData: { characterStates: "", characterCognition: null, foreshadowingTracker: null, timeline: [], canonFacts: "", conflicts: "" },
    worldRules: "rules",
    powerSystem: "",
    foreshadowing: null,
    timeline: [],
    outlineContent: "",
    soulDoc: "",
  } as ExtractionResult
}

function makeTrace(agent: NovelAgent, round = 1, agents?: Map<string, NovelAgent>): SimulationDebugTrace {
  return {
    id: `t${round}`,
    type: "event-recorded",
    nodeIndex: 0,
    nodeTitle: "开端",
    round,
    candidateAgents: [],
    selectedAgents: [],
    blackboard: { allAgentCount: 1, activeAgentCount: 1, totalEventCount: 5, publicEventCount: 3, rumorCount: 1 },
    visibilityByAgent: [],
    rumors: [],
    activeAgents: agents ?? new Map([[agent.characterId, agent]]),
    timestamp: new Date().toISOString(),
  } as SimulationDebugTrace
}

function makeSnapshot(): SerializedSimulationSnapshot {
  const agent = {
    characterId: "c1",
    name: "寨主",
    profile: "profile",
    aura: null,
    cognition: null,
    soul: "soul",
    currentGoal: "goal",
    emotionalState: "calm",
    knownFacts: [],
    relationships: [],
    powerLevel: "1",
    memory: { observedEvents: ["e1"], knownSecrets: ["s1"], sentiments: { c2: 10 }, recentDecisions: ["d1"], rumorCredibility: 0.5 },
    knowledgeScope: [],
    personality: ["brave"],
    speakingStyle: "direct",
  }
  return {
    agents: [agent],
    state: { currentRound: 0, timelineEvents: [], activeAgents: { c1: agent }, worldState: {} },
  }
}

function resetBranchStore() {
  useStorySimulationStore.getState().reset()
  useStorySimulationStore.setState({
    phase: "idle",
    error: null,
    infoMessage: null,
    timelineEvents: [],
    debugTraces: [],
    currentRumors: [],
    currentAgents: new Map(),
    branches: [],
    currentReport: null,
    currentDraft: null,
    currentFramework: null,
    extractionResult: null,
    savedResults: [],
    selectedResultId: null,
    continuingInterviewId: null,
    activeChatAgent: null,
    agentChatMessages: [],
    dynamicEventPool: [],
    frameworks: [],
  })
  wikiState.project = { id: "p1", name: "proj", path: "C:/proj" }
  Object.values(novelMocks).forEach((fn) => { (fn as { mockReset: () => void }).mockReset() })
  novelMocks.resolveDefaultModel.mockReturnValue({ model: "mock" })
  novelMocks.serializeSimulationState.mockReturnValue({ agents: [], state: { currentRound: 0 } })
  novelMocks.deserializeSimulationSnapshot.mockReturnValue({
    agents: [makeAgent()],
    state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() },
  })
  novelMocks.appendStageMetric.mockResolvedValue(undefined)
  novelMocks.saveFramework.mockResolvedValue(undefined)
  novelMocks.saveSimulationResult.mockResolvedValue(undefined)
  novelMocks.loadSimulationResults.mockResolvedValue([])
  novelMocks.loadInterviews.mockResolvedValue([])
  novelMocks.exportInterview.mockResolvedValue("C:/proj/interview.md")
  novelMocks.saveInterview.mockResolvedValue(undefined)
}

describe("story-simulation-view 纯函数分支增补", () => {
  it("无名事件回退到旁白", () => {
    const events = [makeEvent({ actorName: "" })]
    expect(pickConflictEvents(events)).toHaveLength(1)
    const draft = buildConflictDraft(events, "fw1")
    expect(draft.chapters[0]?.title).toContain("旁白")
    expect(draft.branchId).toBe("extracted-conflicts")
    expect(draft.frameworkId).toBe("fw1")
  })
})

describe("story-simulation-view 渲染分支增补", () => {
  beforeEach(() => { resetBranchStore(); vi.stubGlobal("confirm", vi.fn(() => false)) })
  afterEach(() => { cleanup(); resetBranchStore(); vi.unstubAllGlobals() })

  it("selectedResult 副作用容忍缺失时间线/传闻/过程观察", async () => {
    const agent = makeAgent()
    const report = makeReport()
    const saved: SavedSimulationResult[] = [
      { id: "sel9", frameworkId: "fw1", report, draft: null, agentSnapshot: makeSnapshot(), createdAt: report.createdAt },
    ]
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentReport: report,
      currentFramework: makeFramework(),
      savedResults: saved,
      selectedResultId: null,
    })
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({
      agents: [agent],
      state: { currentRound: 0, timelineEvents: [], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() },
    })
    render(<StorySimulationView />)
    useStorySimulationStore.getState().setSelectedResultId("sel9")
    await waitFor(() => expect(useStorySimulationStore.getState().currentAgents.size).toBe(1))
    // 缺失字段 → 保持默认空数组，不崩
    expect(useStorySimulationStore.getState().timelineEvents).toEqual([])
  })

  it("续聊恢复在采访与结果均无快照时跳过", async () => {
    novelMocks.loadInterviews.mockResolvedValue([{ id: "int9", agentId: "c1", agentName: "寨主", session: { agentId: "c1", agentName: "寨主", messages: [] }, frameworkId: "fw1" }])
    novelMocks.loadSimulationResults.mockResolvedValue([
      { id: "r9", frameworkId: "fw1", report: makeReport(), createdAt: new Date().toISOString() },
    ])
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentReport: makeReport(),
      currentFramework: makeFramework(),
      continuingInterviewId: "int9",
    })
    render(<StorySimulationView />)
    await waitFor(() => expect(novelMocks.loadSimulationResults).toHaveBeenCalled())
    expect(novelMocks.deserializeSimulationSnapshot).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().phase).toBe("report-viewing")
  })

  it("仅过程观察无时间线时取消走空事件部分保存", async () => {
    const agent = makeAgent()
    const fw = makeFramework()
    const emptyAgents = new Map<string, NovelAgent>()
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [fw],
      timelineEvents: [],
      debugTraces: [],
    })
    novelMocks.buildAgents.mockReturnValue([agent])
    novelMocks.runSimulation.mockImplementation(async (_p: unknown, _e: unknown, cb: {
      onTimelineEvent?: (ev: TimelineEvent) => void
      onDebugTrace?: (t: SimulationDebugTrace) => void
    }, signal: AbortSignal) => {
      cb.onDebugTrace?.(makeTrace(agent, 1, emptyAgents))
      await new Promise((r) => setTimeout(r, 300))
      if (signal.aborted) throw new DOMException("aborted", "AbortError")
      return []
    })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(screen.queryByText("取消推演")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消推演"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 6000 })
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.simulationCancelled")
    await waitFor(() => expect(novelMocks.saveSimulationResult).toHaveBeenCalled())
    const partialCall = novelMocks.saveSimulationResult.mock.calls.find((c) => {
      const opts = c[8] as { status?: string } | undefined
      return opts?.status === "cancelled"
    })
    expect(partialCall).toBeTruthy()
    const resume = (partialCall?.[8] as { resume?: { nextNodeIndex?: number; nextRound?: number } } | undefined)?.resume
    expect(resume).toMatchObject({ nextNodeIndex: 0, nextRound: 0 })
    // 空 agents → 快照未定义
    expect(partialCall?.[5]).toBeUndefined()
  })

  it("选择缺失可选字段的历史结果进入报告页", async () => {
    const fw = makeFramework()
    const report = makeReport("rec-min")
    const saved: SavedSimulationResult[] = [
      { id: "rmin", frameworkId: "fw1", report, createdAt: report.createdAt },
    ]
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [fw],
      savedResults: saved,
    })
    novelMocks.loadSimulationResults.mockResolvedValue(saved)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("rec-min"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"))
    expect(useStorySimulationStore.getState().currentReport?.recommendation).toBe("rec-min")
    expect(useStorySimulationStore.getState().timelineEvents).toEqual([])
    expect(useStorySimulationStore.getState().currentAgents.size).toBe(0)
  })

  it("继续仅带 resume 的结果触发续跑并回退空快照", async () => {
    const agent = makeAgent()
    const fw = makeFramework()
    const ev = makeEvent({ id: "cont-e1" })
    const report = makeReport("rec-cont")
    const resume = { nextNodeIndex: 0, nextRound: 0, timelineEvents: [] as TimelineEvent[] }
    const saved: SavedSimulationResult[] = [
      { id: "rcont", frameworkId: "fw1", report, resume, status: "partial", partialReason: "中断", createdAt: report.createdAt },
    ]
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [fw],
      savedResults: saved,
    })
    novelMocks.loadSimulationResults.mockResolvedValue(saved)
    novelMocks.buildAgents.mockReturnValue([agent])
    novelMocks.runSimulation.mockImplementation(async (_p: unknown, _e: unknown, cb: {
      onTimelineEvent?: (ev: TimelineEvent) => void
      onDebugTrace?: (t: SimulationDebugTrace) => void
    }) => {
      cb.onTimelineEvent?.(ev)
      cb.onDebugTrace?.(makeTrace(agent, 1))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(makeReport("rec-new"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByLabelText("rec-cont")).toBeTruthy(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByText("storySimulation.continueSimulation")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("storySimulation.continueSimulation"))
    await waitFor(() => expect(novelMocks.runSimulation).toHaveBeenCalled(), { timeout: 5000 })
    const runArgs = novelMocks.runSimulation.mock.calls[0]?.[0] as { resume?: unknown }
    expect(runArgs.resume).toEqual(resume)
  })

  it("确认后生成草稿携带 agent 快照", async () => {
    const agent = makeAgent()
    const fw = makeFramework()
    const ev = makeEvent({ id: "sim-e1", content: "推演事件正文" })
    const report = makeReport()
    const draft = { branchId: "b1", frameworkId: "fw1", chapters: [{ title: "t", content: "draft-body", correspondingNode: 0 }], totalWords: 100, createdAt: new Date().toISOString() }
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [],
      dynamicEventPool: ["pool-evt"],
      simulationRounds: 2,
    })
    novelMocks.buildAgents.mockReturnValue([agent])
    novelMocks.runSimulation.mockImplementation(async (_p: unknown, _e: unknown, cb: {
      onTimelineEvent?: (ev: TimelineEvent) => void
      onDebugTrace?: (t: SimulationDebugTrace) => void
    }) => {
      cb.onTimelineEvent?.(ev)
      cb.onDebugTrace?.(makeTrace(agent, 1))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(report)
    novelMocks.generateStoryDraft.mockResolvedValue(draft)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"), { timeout: 5000 })
    const draftSave = novelMocks.saveSimulationResult.mock.calls.find((c) => c[3] != null)
    expect(draftSave).toBeTruthy()
    expect(draftSave?.[5]).toBeDefined()
  })

  it("无框架时一键提取落到 extracted 框架 id", async () => {
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: null,
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
    })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("时间线"))
    await waitFor(() => expect(screen.getByTestId("sim-extract-conflicts")).toBeTruthy())
    fireEvent.click(screen.getByTestId("sim-extract-conflicts"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"))
    expect(useStorySimulationStore.getState().currentDraft?.frameworkId).toBe("extracted")
  })

  it("有仿真状态时保存采访携带 agent 快照", async () => {
    const agent = makeAgent()
    const fw = makeFramework()
    const ev = makeEvent({ id: "sim-e1" })
    const report = makeReport()
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [],
      dynamicEventPool: ["pool-evt"],
      simulationRounds: 2,
    })
    novelMocks.buildAgents.mockReturnValue([agent])
    novelMocks.runSimulation.mockImplementation(async (_p: unknown, _e: unknown, cb: {
      onTimelineEvent?: (ev: TimelineEvent) => void
      onDebugTrace?: (t: SimulationDebugTrace) => void
    }) => {
      cb.onTimelineEvent?.(ev)
      cb.onDebugTrace?.(makeTrace(agent, 1))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(report)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    useStorySimulationStore.setState({
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [{ id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() }],
    })
    await waitFor(() => expect(screen.getByTitle("storySimulation.saveInterviewTip")).toBeTruthy())
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(novelMocks.saveInterview).toHaveBeenCalled())
    const opts = novelMocks.saveInterview.mock.calls[0]?.[2] as { agentSnapshot?: unknown } | undefined
    expect(opts?.agentSnapshot).toBeDefined()
  })

  it("续聊保存确认覆盖时透传 existingId", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: makeFramework(),
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      continuingInterviewId: "int-cover",
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [{ id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() }],
    })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(novelMocks.saveInterview).toHaveBeenCalled())
    const opts = novelMocks.saveInterview.mock.calls[0]?.[2] as { existingId?: string } | undefined
    expect(opts?.existingId).toBe("int-cover")
  })

  it("仅过程观察无时间线且有 agents 时取消携带快照部分保存", async () => {
    const agent = makeAgent()
    const fw = makeFramework()
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: makeExtraction(),
      frameworks: [fw],
      timelineEvents: [],
      debugTraces: [],
    })
    novelMocks.buildAgents.mockReturnValue([agent])
    novelMocks.runSimulation.mockImplementation(async (_p: unknown, _e: unknown, cb: {
      onTimelineEvent?: (ev: TimelineEvent) => void
      onDebugTrace?: (t: SimulationDebugTrace) => void
    }, signal: AbortSignal) => {
      cb.onDebugTrace?.(makeTrace(agent, 1))
      await new Promise((r) => setTimeout(r, 300))
      if (signal.aborted) throw new DOMException("aborted", "AbortError")
      return []
    })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(screen.queryByText("取消推演")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消推演"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 6000 })
    const partialCall = novelMocks.saveSimulationResult.mock.calls.find((c) => {
      const opts = c[8] as { status?: string } | undefined
      return opts?.status === "cancelled"
    })
    expect(partialCall).toBeTruthy()
    const resume = (partialCall?.[8] as { resume?: { nextNodeIndex?: number; nextRound?: number } } | undefined)?.resume
    expect(resume).toMatchObject({ nextNodeIndex: 0, nextRound: 0 })
    // 有 agents → 快照已定义
    expect(partialCall?.[5]).toBeDefined()
  })

  it("续聊保存拒绝覆盖时不透传 existingId", async () => {
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: makeFramework(),
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      continuingInterviewId: "int-keep",
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [{ id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() }],
    })
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByTitle("storySimulation.saveInterviewTip")).toBeTruthy())
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(novelMocks.saveInterview).toHaveBeenCalled())
    const opts = novelMocks.saveInterview.mock.calls[0]?.[2] as { existingId?: string } | undefined
    expect(opts?.existingId).toBeUndefined()
  })

  it("选中结果无快照时发送采访报无可用状态", async () => {
    const report = makeReport()
    const saved: SavedSimulationResult[] = [
      { id: "selN", frameworkId: "fw1", report, draft: null, timelineEvents: [makeEvent()], createdAt: report.createdAt },
    ]
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: makeFramework(),
      currentReport: report,
      timelineEvents: [makeEvent()],
      currentAgents: new Map(),
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [],
      savedResults: saved,
      selectedResultId: "selN",
    })
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBe("storySimulation.noAgentState"))
    expect(novelMocks.interviewAgent).not.toHaveBeenCalled()
  })

  it("历史快照恢复失败后发送时从历史重建并继续采访", async () => {
    const agent = makeAgent()
    const report = makeReport()
    const ev = makeEvent({ id: "chat-h1" })
    const saved: SavedSimulationResult[] = [
      { id: "selh", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: makeSnapshot(), createdAt: report.createdAt },
    ]
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    novelMocks.deserializeSimulationSnapshot.mockImplementationOnce(() => {
      throw new Error("bad snap")
    })
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({
      agents: [agent],
      state: { currentRound: 0, timelineEvents: [ev], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() },
    })
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: makeFramework(),
      currentReport: report,
      timelineEvents: [ev],
      currentAgents: new Map(),
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [],
      savedResults: saved,
      selectedResultId: "selh",
    })
    novelMocks.interviewAgent.mockImplementation(async (opts: {
      onToken?: (t: string) => void
      onDone?: () => void
    }) => {
      opts.onDone?.()
      return { fullText: "", session: { agentId: "c1", agentName: "寨主", messages: [] } }
    })
    render(<StorySimulationView />)
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(novelMocks.interviewAgent).toHaveBeenCalled(), { timeout: 5000 })
    expect(useStorySimulationStore.getState().error).toBeNull()
    errSpy.mockRestore()
  })

  it("采访流未开始时 onError 直接报错", async () => {
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: makeFramework(),
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      currentAgents: new Map([["c1", makeAgent()]]),
      activeChatAgent: { id: "c1", name: "寨主" },
      agentChatMessages: [],
    })
    // refs 为空会先走恢复分支：直接给出可恢复的 agents，避免走到 noAgentState
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({
      agents: [],
      state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() },
    })
    novelMocks.interviewAgent.mockImplementation(async (opts: {
      onError?: (e: Error) => void
    }) => {
      opts.onError?.(new Error("late boom"))
      return { fullText: "", session: { agentId: "c1", agentName: "寨主", messages: [] } }
    })
    // 先注入 refs：通过一次成功的空采访建立 ref？改用 selectedResult 恢复路径
    const report = makeReport()
    const saved: SavedSimulationResult[] = [
      { id: "selE", frameworkId: "fw1", report, draft: null, timelineEvents: [makeEvent()], agentSnapshot: makeSnapshot(), createdAt: report.createdAt },
    ]
    useStorySimulationStore.setState({ savedResults: saved, selectedResultId: "selE" })
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({
      agents: [makeAgent()],
      state: { currentRound: 0, timelineEvents: [], activeAgents: new Map([["c1", makeAgent()]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() },
    })
    render(<StorySimulationView />)
    await waitFor(() => expect(useStorySimulationStore.getState().currentAgents.size).toBe(1))
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("late boom"))
  })
})
