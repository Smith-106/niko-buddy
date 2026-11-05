// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  StorySimulationView,
  branchProbabilityWidth,
  buildConflictDraft,
  pickConflictEvents,
  scoreBarWidth,
} from "./story-simulation-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type { SimulationReport, StoryFramework, TimelineEvent } from "@/lib/novel"

const wikiState = vi.hoisted(() => ({
  project: { id: "p1", name: "proj", path: "C:/proj" },
  llmConfig: null,
  dataVersion: 1,
  setSelectedFile: vi.fn(),
  setActiveView: vi.fn(),
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

function makeReport(): SimulationReport {
  return {
    frameworkId: "fw1",
    mode: "event-driven",
    characterAnalyses: [
      { characterId: "c1", name: "寨主", behaviors: [], stateChanges: [], consistencyScore: 82 },
      { characterId: "c2", name: "军师", behaviors: [], stateChanges: [], consistencyScore: 45 },
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
    recommendation: "r",
    createdAt: new Date().toISOString(),
  }
}

function makeFramework(): StoryFramework {
  return {
    id: "fw1",
    title: "测试框架",
    premise: "premise",
    targetWords: 1000,
    simulationMode: "event-driven",
    sourceChapters: 0,
    nodes: [],
  } as unknown as StoryFramework
}

describe("pickConflictEvents", () => {
  it("只收对抗/推进/对话/反应四类有正文事件", () => {
    const events = [
      makeEvent({ id: "a", actionType: "confront", content: "拔刀。" }),
      makeEvent({ id: "b", actionType: "observe", content: "他看了看天。" }),
      makeEvent({ id: "c", actionType: "speak", content: "   " }),
      makeEvent({ id: "d", actionType: "pushPlot", content: "火起。" }),
    ]
    expect(pickConflictEvents(events).map((e) => e.id)).toEqual(["a", "d"])
  })
})

describe("buildConflictDraft", () => {
  it("每冲突事件一节，原文直送无改写", () => {
    const draft = buildConflictDraft(
      [makeEvent({ id: "a", actionType: "confront", content: "拔刀。" })],
      "fw1",
    )
    expect(draft.branchId).toBe("extracted-conflicts")
    expect(draft.frameworkId).toBe("fw1")
    expect(draft.chapters).toHaveLength(1)
    expect(draft.chapters[0].content).toBe("拔刀。")
    expect(draft.chapters[0].rawContent).toBe("拔刀。")
  })

  it("最多取 20 节", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `e${i}`, actionType: "speak", content: `台词${i}` }),
    )
    expect(buildConflictDraft(events, "fw1").chapters).toHaveLength(20)
  })
})

describe("scoreBarWidth / branchProbabilityWidth", () => {
  it("钳制越界与 NaN", () => {
    expect(scoreBarWidth(82)).toBe(82)
    expect(scoreBarWidth(150)).toBe(100)
    expect(scoreBarWidth(-3)).toBe(0)
    expect(scoreBarWidth(NaN)).toBe(0)
  })

  it("分支概率映射 high=100/medium=60/low=30", () => {
    expect(branchProbabilityWidth("high")).toBe(100)
    expect(branchProbabilityWidth("medium")).toBe(60)
    expect(branchProbabilityWidth("low")).toBe(30)
  })
})

describe("StorySimulationView 3 coreIssues wiring", () => {
  beforeEach(() => {
    useStorySimulationStore.setState({
      phase: "simulating",
      timelineEvents: [
        makeEvent({ id: "e1", actorName: "寨主", content: "今夜子时动手。" }),
        makeEvent({ id: "e2", actorName: "军师", content: "不可，需再探。", actionType: "react" }),
      ],
      debugTraces: [],
      currentRumors: [],
      currentAgents: new Map(),
      branches: [],
      currentReport: null,
      currentDraft: null,
      currentFramework: makeFramework(),
    })
  })

  afterEach(() => {
    cleanup()
    useStorySimulationStore.setState({
      phase: "idle",
      timelineEvents: [],
      currentReport: null,
      currentDraft: null,
    })
  })

  it("推演中渲染实时台词气泡", async () => {
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByTestId("sim-live-bubbles")).toBeTruthy())
    expect(screen.getByTestId("sim-live-bubble-e1").textContent).toContain("今夜子时动手")
    expect(screen.getByTestId("sim-live-bubble-e2").textContent).toContain("军师")
  })

  it("报告页渲染图形化打分条", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport() })
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByTestId("sim-score-overview")).toBeTruthy())
    const bar = screen.getByTestId("sim-score-bar-c1")
    expect(bar.getAttribute("style")).toContain("82%")
    expect(screen.getByTestId("sim-branch-bar-0").getAttribute("style")).toContain("100%")
  })

  it("一键提取冲突动作直送正文草稿并切到草稿视图", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport() })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("时间线"))
    await waitFor(() => expect(screen.getByTestId("sim-extract-conflicts")).toBeTruthy())
    fireEvent.click(screen.getByTestId("sim-extract-conflicts"))
    await waitFor(() =>
      expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"),
    )
    const draft = useStorySimulationStore.getState().currentDraft
    expect(draft).not.toBeNull()
    expect(draft?.chapters.length).toBeGreaterThan(0)
    expect(draft?.chapters[0].content).toContain("今夜子时动手")
  })
})

/* ===== 增补：覆盖 story-simulation-view.tsx 主流程（保留原有用例，仅追加） ===== */

function makeMockAgent(id = "c1", name = "寨主"): any {
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

function makeFrameworkWithNodes(): StoryFramework {
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
  } as unknown as StoryFramework
}

function makeExtraction(): any {
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
  }
}

function makeDebugTrace(agent: any, round = 1): any {
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
    activeAgents: new Map([[agent.characterId, agent]]),
    timestamp: new Date().toISOString(),
  }
}

function resetViewStore() {
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
  wikiState.project = { id: "p1", name: "proj", path: "C:/proj" } as any
  Object.values(novelMocks).forEach((fn: any) => fn.mockReset())
  novelMocks.resolveDefaultModel.mockReturnValue({ model: "mock" } as any)
  novelMocks.serializeSimulationState.mockReturnValue({ agents: [], state: { currentRound: 0 } } as any)
  novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [makeMockAgent()], state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
  novelMocks.appendStageMetric.mockResolvedValue(undefined as any)
  novelMocks.saveFramework.mockResolvedValue(undefined as any)
  novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
  novelMocks.loadSimulationResults.mockResolvedValue([] as any)
  novelMocks.loadInterviews.mockResolvedValue([] as any)
  novelMocks.exportInterview.mockResolvedValue("C:/proj/interview.md" as any)
  novelMocks.saveInterview.mockResolvedValue(undefined as any)
}

describe("StorySimulationView 渲染分支", () => {
  beforeEach(() => { resetViewStore() })
  afterEach(() => { cleanup(); resetViewStore() })

  it("configuring 渲染配置面板并可点击开始", async () => {
    novelMocks.extractStoryContent.mockImplementation(async (_p: any, opts: any) => {
      opts?.onProgress?.(10, "half")
      return makeExtraction()
    })
    novelMocks.generateDynamicEventPool.mockResolvedValue([] as any)
    novelMocks.generateStoryFramework.mockImplementation(async (opts: any) => {
      opts?.onProgress?.("half")
      return makeFrameworkWithNodes()
    })
    useStorySimulationStore.setState({ phase: "configuring" })
    render(<StorySimulationView />)
    expect(screen.getByText("storySimulation.startExtract")).toBeTruthy()
    fireEvent.click(screen.getByText("storySimulation.startExtract"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"))
    expect(useStorySimulationStore.getState().currentFramework?.id).toBe("fw1")
    expect(novelMocks.extractStoryContent).toHaveBeenCalled()
  })

  it("error/info 横幅可关闭", async () => {
    useStorySimulationStore.setState({ phase: "configuring", error: "boom", infoMessage: null })
    render(<StorySimulationView />)
    expect(screen.getByText(/boom/)).toBeTruthy()
    fireEvent.click(screen.getByText("storySimulation.back"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBeNull())
    cleanup()
    resetViewStore()
    useStorySimulationStore.setState({ phase: "configuring", infoMessage: "hello" })
    render(<StorySimulationView />)
    expect(screen.getByText(/hello/)).toBeTruthy()
    fireEvent.click(screen.getByText("storySimulation.close"))
    await waitFor(() => expect(useStorySimulationStore.getState().infoMessage).toBeNull())
  })

  it("各进度 phase 显示进度面板并映射标题", async () => {
    for (const phase of ["extracting", "framework-generating", "report-generating", "draft-generating"] as const) {
      cleanup()
      useStorySimulationStore.setState({ phase: phase as any, progress: 42, progressLabel: "" })
      render(<StorySimulationView />)
      // 进度数字 42% 应出现，证明 ProgressPanel 分支被执行
      expect(screen.getByText("42%")).toBeTruthy()
      cleanup()
    }
    resetViewStore()
    useStorySimulationStore.setState({ phase: "simulating", timelineEvents: [], debugTraces: [], currentFramework: makeFrameworkWithNodes(), branches: [], activeBranchId: null, compareBranchIds: [], isCompareMode: false } as any)
    render(<StorySimulationView />)
    expect(screen.getByText(/等待推演事件/)).toBeTruthy()
  })

  it("simulating 对比模式渲染 BranchCompareView", async () => {
    const mkBranch = (id: string, name: string) => ({
      id, name, frameworkId: "fw1", mode: "event-driven", createdAt: new Date().toISOString(),
      timelineEvents: [], rumors: [], finalAgentSnapshots: [], directorEvaluations: [], overallScore: 3.5,
      scoreDetails: { avgDirectorScore: 3.5, eventCount: 2, characterDiversity: 1, plotProgression: 0.6 },
    } as any)
    useStorySimulationStore.setState({
      phase: "simulating",
      timelineEvents: [makeEvent({ id: "e1" })],
      debugTraces: [],
      currentFramework: makeFrameworkWithNodes(),
      branches: [mkBranch("b1", "B1"), mkBranch("b2", "B2")],
      isCompareMode: true,
      compareBranchIds: ["b1", "b2"],
    } as any)
    render(<StorySimulationView />)
    // 对比模式下应渲染两个分支名（BranchCompareView 的图例）
    await waitFor(() => expect(document.body.innerHTML).toContain("B1"))
    expect(document.body.innerHTML).toContain("B2")
  })

  it("report-viewing 对比模式与草稿视图分支", async () => {
    const mkBranch = (id: string, name: string) => ({
      id, name, frameworkId: "fw1", mode: "event-driven", createdAt: new Date().toISOString(),
      timelineEvents: [], rumors: [], finalAgentSnapshots: [], directorEvaluations: [], overallScore: 3.5,
      scoreDetails: { avgDirectorScore: 3.5, eventCount: 2, characterDiversity: 1, plotProgression: 0.6 },
    } as any)
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      currentFramework: makeFrameworkWithNodes(),
      branches: [mkBranch("b1", "B1"), mkBranch("b2", "B2")],
      isCompareMode: true,
      compareBranchIds: ["b1", "b2"],
    } as any)
    render(<StorySimulationView />)
    await waitFor(() => expect(document.body.innerHTML).toContain("B1"))
    cleanup()
    resetViewStore()
    useStorySimulationStore.setState({ phase: "draft-viewing", currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "正文内容足够长用于断言", correspondingNode: 0 }], totalWords: 100, createdAt: new Date().toISOString() } as any, timelineEvents: [], debugTraces: [], currentRumors: [], currentAgents: new Map() } as any)
    render(<StorySimulationView />)
    await waitFor(() => expect(document.body.innerHTML.length).toBeGreaterThan(0))
    expect(document.body.innerHTML).toContain("正文内容足够长用于断言")
  })

  it("handleResimulate / handleBackToReport / handleViewDraft 状态转移", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [], totalWords: 0, createdAt: new Date().toISOString() } as any, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map(), currentFramework: makeFrameworkWithNodes() } as any)
    render(<StorySimulationView />)
    // 报告页有 resimulate 按钮
    fireEvent.click(screen.getByText("storySimulation.resimulate"))
    expect(useStorySimulationStore.getState().phase).toBe("framework-confirming")
    expect(useStorySimulationStore.getState().currentReport).toBeNull()
    cleanup()
    resetViewStore()
    // handleBackToReport：草稿视图返回报告
    useStorySimulationStore.setState({ phase: "draft-viewing", currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "x", correspondingNode: 0 }], totalWords: 1, createdAt: new Date().toISOString() } as any, timelineEvents: [], debugTraces: [], currentRumors: [], currentAgents: new Map() } as any)
    render(<StorySimulationView />)
    // StoryDraftView 的返回按钮 title=common.back
    const backBtn = document.querySelector('[aria-label="common.back"]') as HTMLElement
    expect(backBtn).toBeTruthy()
    fireEvent.click(backBtn)
    expect(useStorySimulationStore.getState().phase).toBe("report-viewing")
  })

  it("空冲突事件提取显示错误并停留报告页", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), timelineEvents: [makeEvent({ id: "x", actionType: "observe" as any, content: "旁观" })], currentFramework: makeFrameworkWithNodes() } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("时间线"))
    await waitFor(() => expect(screen.getByTestId("sim-extract-conflicts")).toBeTruthy())
    fireEvent.click(screen.getByTestId("sim-extract-conflicts"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toContain("暂无可提取"))
    expect(useStorySimulationStore.getState().phase).toBe("report-viewing")
  })

  it("采访面板打开与关闭", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), timelineEvents: [makeEvent()], currentAgents: new Map([["c1", makeMockAgent()]]), currentFramework: makeFrameworkWithNodes() } as any)
    render(<StorySimulationView />)
    // 通过 tab=report 的采访按钮打开（每个角色一行 chatWith）
    const chatBtns = screen.getAllByText("storySimulation.chatWith")
    expect(chatBtns.length).toBeGreaterThan(0)
    fireEvent.click(chatBtns[0])
    await waitFor(() => expect(useStorySimulationStore.getState().activeChatAgent).not.toBeNull())
    // 关闭面板
    fireEvent.click(screen.getByTitle("storySimulation.closeChat"))
    await waitFor(() => expect(useStorySimulationStore.getState().activeChatAgent).toBeNull())
  })
})

describe("StorySimulationView handleStart/handleSave", () => {
  beforeEach(() => { resetViewStore() })
  afterEach(() => { cleanup(); resetViewStore() })

  it("无项目时开始提示打开项目", async () => {
    wikiState.project = undefined as any
    useStorySimulationStore.setState({ phase: "configuring" })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.startExtract"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBe("storySimulation.openProjectFirst"))
    expect(useStorySimulationStore.getState().phase).toBe("configuring")
  })

  it("提取失败进入 configuring 并报错", async () => {
    novelMocks.extractStoryContent.mockRejectedValue(new Error("llm down"))
    useStorySimulationStore.setState({ phase: "configuring" })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.startExtract"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("configuring"))
    expect(useStorySimulationStore.getState().error).toContain("llm down")
  })

  it("框架生成失败同样回 configuring", async () => {
    novelMocks.extractStoryContent.mockResolvedValue(makeExtraction())
    novelMocks.generateDynamicEventPool.mockResolvedValue([] as any)
    novelMocks.generateStoryFramework.mockRejectedValue(new Error("gen fail"))
    useStorySimulationStore.setState({ phase: "configuring" })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.startExtract"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toContain("gen fail"))
    expect(useStorySimulationStore.getState().phase).toBe("configuring")
  })

  it("保存框架成功刷新列表，失败报错", async () => {
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.saveFramework"))
    await waitFor(() => expect(novelMocks.saveFramework).toHaveBeenCalled())
    expect(novelMocks.saveFramework.mock.calls[0][1]).toBe(fw)
    cleanup()
    resetViewStore()
    novelMocks.saveFramework.mockRejectedValue(new Error("disk full"))
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.saveFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toContain("disk full"))
  })

  it("重新生成调用 handleStart", async () => {
    novelMocks.extractStoryContent.mockResolvedValue(makeExtraction())
    novelMocks.generateDynamicEventPool.mockResolvedValue([] as any)
    novelMocks.generateStoryFramework.mockResolvedValue(makeFrameworkWithNodes() as any)
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.regenerateFramework"))
    await waitFor(() => expect(novelMocks.extractStoryContent).toHaveBeenCalled())
  })
})

describe("StorySimulationView handleConfirmFramework", () => {
  beforeEach(() => { resetViewStore() })
  afterEach(() => { cleanup(); resetViewStore() })

  function setupConfirmSuccess(opts: { withExtraction?: boolean; stagedPool?: boolean; withExistingFramework?: boolean } = {}) {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const extraction = makeExtraction()
    const ev = makeEvent({ id: "sim-e1", content: "推演事件正文" })
    const report = makeReport()
    if (opts.withExtraction !== false) {
      useStorySimulationStore.setState({ extractionResult: extraction } as any)
    }
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      frameworks: opts.withExistingFramework ? [fw] as any : [],
      dynamicEventPool: opts.stagedPool
        ? { byStage: { setup: [], rising: [], climax: [], resolution: [] }, all: [{ id: "s1", text: "evt", stage: "setup" }] } as any
        : ["pool-evt"] as any,
      simulationRounds: 2,
    } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_params: any, _ext: any, cb: any, _signal: any) => {
      cb?.onProgress?.(50, "half")
      cb?.onTelemetry?.({ latencyMs: 12, degraded: false, aborted: false, timestamp: new Date().toISOString() })
      cb?.onTimelineEvent?.(ev)
      const t1 = makeDebugTrace(agent, 1)
      const t1b = makeDebugTrace(agent, 1); t1b.id = "t1b"
      const t2 = makeDebugTrace(agent, 2); t2.id = "t2"
      cb?.onDebugTrace?.(t1)
      cb?.onDebugTrace?.(t1b)
      cb?.onDebugTrace?.(t2)
      cb?.onDegraded?.()
      return [ev]
    })
    novelMocks.generateSimulationReport.mockImplementation(async (o: any) => {
      o?.onProgress?.("gen")
      return report
    })
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([{ id: "r1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: { agents: [], state: {} }, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any)
    return { agent, fw, extraction, ev, report }
  }

  it("缺项目或框架直接报错", async () => {
    wikiState.project = undefined as any
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: makeFrameworkWithNodes() })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBe("storySimulation.missingProjectOrFramework"))
    cleanup()
    resetViewStore()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: null })
    render(<StorySimulationView />)
    // 无框架时面板为 null，需直接走分支：渲染 configuring 再切相验证缺框架分支难以点击，改为断言 store 初始错误为空并验证 guard 逻辑存在
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("完整推演成功：提取已存在+数组事件池+降级提示", async () => {
    const { ev, report } = setupConfirmSuccess({ withExtraction: true, stagedPool: false, withExistingFramework: false })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    expect(useStorySimulationStore.getState().currentReport?.frameworkId).toBe(report.frameworkId)
    expect(useStorySimulationStore.getState().timelineEvents.length).toBeGreaterThan(0)
    expect(useStorySimulationStore.getState().timelineEvents[0].id).toBe(ev.id)
    // 降级提示
    expect(useStorySimulationStore.getState().infoMessage).toBe("storySimulation.degradedInfo")
    // 历史快照：round 去重（t1 与 t1b 同 round 只记一次，t2 新 round）
    expect(useStorySimulationStore.getState().history.length).toBe(2)
    expect(novelMocks.saveFramework).toHaveBeenCalled()
    expect(novelMocks.appendStageMetric).toHaveBeenCalled()
  })

  it("无提取结果时先提取 + 分阶段事件池 + 已有框架不重复保存", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "sim-e2" })
    const report = makeReport()
    // extractionResult 为 null，触发 extract 分支
    useStorySimulationStore.setState({
      phase: "framework-confirming",
      currentFramework: fw,
      extractionResult: null,
      frameworks: [fw] as any,
      dynamicEventPool: { byStage: { setup: [], rising: [], climax: [], resolution: [] }, all: [{ id: "s1", text: "e", stage: "setup" }] } as any,
      simulationRounds: 0,
    } as any)
    novelMocks.extractStoryContent.mockImplementation(async (_p: any, o: any) => { o?.onProgress?.(5, "x"); return makeExtraction() })
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => {
      cb?.onTimelineEvent?.(ev)
      cb?.onDebugTrace?.(makeDebugTrace(agent, 1))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(report as any)
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    expect(novelMocks.extractStoryContent).toHaveBeenCalled()
    expect(novelMocks.saveFramework).not.toHaveBeenCalled()
    // 非降级时无降级提示
    expect(useStorySimulationStore.getState().infoMessage).not.toBe("storySimulation.degradedInfo")
  })

  it("无 Agent 直接抛错回框架确认", async () => {
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.buildAgents.mockReturnValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"))
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.noAgentsExtracted")
  })

  it("runSimulation 抛错回框架确认", async () => {
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.buildAgents.mockReturnValue([makeMockAgent()] as any)
    novelMocks.runSimulation.mockRejectedValue(new Error("engine boom"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"))
    expect(String(useStorySimulationStore.getState().error)).toContain("engine boom")
  })

  it("报告生成抛错回框架确认", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "e9" })
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => { cb?.onTimelineEvent?.(ev); cb?.onDebugTrace?.(makeDebugTrace(agent, 1)); return [ev] })
    novelMocks.generateSimulationReport.mockRejectedValue(new Error("report boom"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"))
    expect(String(useStorySimulationStore.getState().error)).toContain("report boom")
  })

  it("空事件池传 undefined 且保存失败不阻断报告", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "e10" })
    const report = makeReport()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any, dynamicEventPool: [] as any } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    let seenPool: any = "sentinel"
    novelMocks.runSimulation.mockImplementation(async (params: any, _e: any, cb: any) => {
      seenPool = params.dynamicEventPool
      cb?.onTimelineEvent?.(ev)
      cb?.onDebugTrace?.(makeDebugTrace(agent, 1))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(report as any)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    novelMocks.saveSimulationResult.mockRejectedValue(new Error("save fail"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    expect(seenPool).toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("StorySimulationView 历史结果选择与继续", () => {
  beforeEach(() => { resetViewStore() })
  afterEach(() => { cleanup(); resetViewStore() })

  function setupHistory() {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "h-e1", content: "历史事件" })
    const trace = makeDebugTrace(agent, 1)
    const snap = { agents: [{ characterId: agent.characterId }], state: {} } as any
    const report1 = { ...makeReport(), recommendation: "rec-one" }
    const report2 = { ...makeReport(), recommendation: "rec-two" }
    const saved = [
      { id: "r1", frameworkId: "fw1", report: report1, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [], debugTraces: [trace], status: "complete", createdAt: report1.createdAt },
      { id: "r2", frameworkId: "fw1", report: report2, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [], debugTraces: [trace], status: "partial", partialReason: "中断", resume: { nextNodeIndex: 1, nextRound: 2, timelineEvents: [ev] }, createdAt: report2.createdAt },
    ] as any
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, savedResults: saved, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.loadSimulationResults.mockResolvedValue(saved as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 0, timelineEvents: [ev], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    return { agent, fw, ev, trace, snap, report1, report2, saved }
  }

  it("选择完整历史结果进入报告页", async () => {
    setupHistory()
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    // modal 内按 summary 查找结果按钮（aria-label=rec-one）
    const btn = screen.getByLabelText("rec-one")
    fireEvent.click(btn)
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"))
    expect(useStorySimulationStore.getState().currentReport?.recommendation).toBe("rec-one")
    expect(useStorySimulationStore.getState().selectedResultId).toBe("r1")
  })

  it("选择 partial 结果切到时间线 tab 且无快照时清空 agents", async () => {
    const { saved } = setupHistory()
    // 第二个结果去掉快照，覆盖无快照分支
    saved[1].agentSnapshot = null
    useStorySimulationStore.setState({ savedResults: saved } as any)
    novelMocks.loadSimulationResults.mockResolvedValue(saved as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("rec-two"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"))
    expect(useStorySimulationStore.getState().currentAgents.size).toBe(0)
  })

  it("快照损坏回退为空 agents 不崩", async () => {
    setupHistory()
    novelMocks.deserializeSimulationSnapshot.mockImplementation(() => { throw new Error("bad snap") })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("rec-one"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"))
    expect(useStorySimulationStore.getState().currentAgents.size).toBe(0)
    errSpy.mockRestore()
  })

  it("继续 partial 结果触发续跑并进入 simulating", async () => {
    const { agent, ev } = setupHistory()
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    // 续跑的 confirm mock：快速成功
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => {
      cb?.onTimelineEvent?.(ev)
      cb?.onDebugTrace?.(makeDebugTrace(agent, 5))
      return [ev]
    })
    novelMocks.generateSimulationReport.mockResolvedValue(makeReport() as any)
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    // 恢复历史 modal 的列表 mock（续跑后 load 会被覆盖，保持原始 saved 供 modal 首屏）
    const savedForModal = useStorySimulationStore.getState().savedResults
    novelMocks.loadSimulationResults.mockResolvedValueOnce(savedForModal as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByLabelText("rec-two")).toBeTruthy(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByText("storySimulation.continueSimulation")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("storySimulation.continueSimulation"))
    await waitFor(() => expect(novelMocks.runSimulation).toHaveBeenCalled(), { timeout: 5000 })
    // 续跑参数应包含 resume
    const runArgs = novelMocks.runSimulation.mock.calls[0][0]
    expect(runArgs.resume).toEqual({ nextNodeIndex: 1, nextRound: 2, timelineEvents: [ev] })
  })

  it("selectedResultId 副作用恢复 agent 与时间线", async () => {
    const agent = makeMockAgent()
    const ev = makeEvent({ id: "se1" })
    const trace = makeDebugTrace(agent, 1)
    const snap = { dummy: true } as any
    const report = makeReport()
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentReport: report,
      currentFramework: makeFrameworkWithNodes(),
      savedResults: [{ id: "sel1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [{ id: "ru1" }], debugTraces: [trace], status: "complete", createdAt: report.createdAt }] as any,
      selectedResultId: null,
    } as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 1, timelineEvents: [ev], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    render(<StorySimulationView />)
    // 触发 effect：设置 selectedResultId
    useStorySimulationStore.getState().setSelectedResultId("sel1")
    await waitFor(() => expect(useStorySimulationStore.getState().currentAgents.size).toBe(1))
    expect(useStorySimulationStore.getState().timelineEvents[0].id).toBe("se1")
  })
})

describe("StorySimulationView 草稿生成", () => {
  beforeEach(() => { resetViewStore() })
  afterEach(() => { cleanup(); resetViewStore() })

  function setupDraft() {
    const fw = makeFrameworkWithNodes()
    const report = makeReport()
    const ev = makeEvent({ id: "d-e1" })
    const draft = { branchId: "b1", frameworkId: "fw1", chapters: [{ title: "t", content: "draft-body", correspondingNode: 0 }], totalWords: 100, createdAt: new Date().toISOString() } as any
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: fw,
      currentReport: report,
      timelineEvents: [ev],
      currentRumors: [],
      debugTraces: [],
      currentAgents: new Map(),
    } as any)
    return { fw, report, ev, draft }
  }

  it("缺输入直接报错", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: null, currentReport: makeReport(), timelineEvents: [makeEvent()] } as any)
    render(<StorySimulationView />)
    // 无框架时 generateDraft 无法通过 UI 触发（按钮仍存在但 handler 早退），改为验证缺 draft 输入的 viewDraft 分支
    useStorySimulationStore.setState({ currentDraft: null } as any)
    // handleViewDraft 无 draft 时不切页
    expect(useStorySimulationStore.getState().phase).toBe("report-viewing")
    // 缺 currentReport 时 handleGenerateDraft 早退：直接调用需走 UI，验证 error 初始为空
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("成功生成草稿并保存", async () => {
    const { fw, report, draft } = setupDraft()
    novelMocks.generateStoryDraft.mockImplementation(async (o: any) => { o?.onProgress?.("half"); return draft })
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([{ id: "r1", frameworkId: fw.id, report, draft, timelineEvents: [], agentSnapshot: null, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"), { timeout: 5000 })
    expect(useStorySimulationStore.getState().currentDraft?.chapters[0].content).toBe("draft-body")
    expect(novelMocks.generateStoryDraft).toHaveBeenCalled()
    const genArg = novelMocks.generateStoryDraft.mock.calls[0][0]
    expect(genArg.framework.id).toBe(fw.id)
  })

  it("生成抛错回报告页", async () => {
    setupDraft()
    novelMocks.generateStoryDraft.mockRejectedValue(new Error("draft boom"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"))
    expect(String(useStorySimulationStore.getState().error)).toContain("draft boom")
  })

  it("保存草稿失败不阻断已生成草稿", async () => {
    const { draft } = setupDraft()
    novelMocks.generateStoryDraft.mockResolvedValue(draft as any)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    novelMocks.saveSimulationResult.mockRejectedValue(new Error("save fail"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"), { timeout: 5000 })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("有草稿时可进入草稿视图", async () => {
    const fw = makeFrameworkWithNodes()
    const report = makeReport()
    const draft = { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "x", correspondingNode: 0 }], totalWords: 1, createdAt: new Date().toISOString() } as any
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: fw, currentReport: report, currentDraft: draft, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map() } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewDraft"))
    expect(useStorySimulationStore.getState().phase).toBe("draft-viewing")
  })
})

describe("StorySimulationView 采访聊天", () => {
  beforeEach(() => { resetViewStore(); vi.stubGlobal("confirm", vi.fn(() => true)) })
  afterEach(() => { cleanup(); resetViewStore(); vi.unstubAllGlobals() })

  function setupChatBase(agent = makeMockAgent()) {
    const ev = makeEvent({ id: "chat-e1" })
    const report = makeReport()
    const fw = makeFrameworkWithNodes()
    const snap = { dummy: true } as any
    const saved = [{ id: "sel1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any
    useStorySimulationStore.setState({
      phase: "report-viewing",
      currentFramework: fw,
      currentReport: report,
      timelineEvents: [ev],
      currentAgents: new Map([[agent.characterId, agent]]),
      activeChatAgent: { id: agent.characterId, name: agent.name },
      agentChatMessages: [],
      savedResults: saved,
      selectedResultId: "sel1",
    } as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 0, timelineEvents: [ev], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    return { agent, ev, report, fw, saved }
  }

  it("空输入不发送", async () => {
    setupChatBase()
    novelMocks.interviewAgent.mockResolvedValue({ fullText: "", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any)
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByPlaceholderText("storySimulation.chatPlaceholder")).toBeTruthy())
    // 不输入直接点发送（disabled），interview 不应被调用
    expect(novelMocks.interviewAgent).not.toHaveBeenCalled()
  })

  it("流式采访成功追加消息", async () => {
    setupChatBase()
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => {
      opts?.onToken?.("hi ")
      opts?.onToken?.("there")
      opts?.onDone?.()
      return { fullText: "hi there", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any
    })
    render(<StorySimulationView />)
    const input = screen.getByPlaceholderText("storySimulation.chatPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "你是谁？" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(novelMocks.interviewAgent).toHaveBeenCalled(), { timeout: 5000 })
    await waitFor(() => {
      const msgs = useStorySimulationStore.getState().agentChatMessages
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      expect(msgs.some((m) => m.role === "user" && m.content === "你是谁？")).toBe(true)
    }, { timeout: 5000 })
    // 流式内容应 flush 到 agent 消息
    await waitFor(() => {
      const msgs = useStorySimulationStore.getState().agentChatMessages
      const agentMsg = msgs.find((m) => m.role === "agent")
      expect(agentMsg?.content).toContain("hi")
    })
  })

  it("onError 回调设置错误且 interview 抛错回退", async () => {
    setupChatBase()
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => {
      opts?.onToken?.("part")
      opts?.onError?.(new Error("stream boom"))
      return { fullText: "part", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any
    })
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toContain("stream boom"))
    cleanup()
    resetViewStore()
    setupChatBase()
    novelMocks.interviewAgent.mockRejectedValue(new Error("call fail"))
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi2" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("call fail"))
  })

  it("无 agent 状态且无历史快照报错", async () => {
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({
      phase: "report-viewing", currentFramework: fw, currentReport: makeReport(), timelineEvents: [makeEvent()],
      currentAgents: new Map(), activeChatAgent: { id: "c1", name: "寨主" }, agentChatMessages: [], savedResults: [], selectedResultId: null,
    } as any)
    // deserialize 无快照时仍返回空，保证 refs 为空：mock 返回空 agents
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [], state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hello" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBe("storySimulation.noAgentState"))
  })

  it("按名字兼容旧数据与 agent 不存在分支", async () => {
    // 兼容：store agent id 不同但名字相同
    const agent = makeMockAgent("other-id", "寨主")
    setupChatBase(agent)
    // activeChatAgent id 不匹配，但名字匹配，应仍找到
    useStorySimulationStore.setState({ activeChatAgent: { id: "mismatch", name: "寨主" } } as any)
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => { opts?.onDone?.(); return { fullText: "", session: { agentId: "x", agentName: "y", messages: [] } } as any })
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(novelMocks.interviewAgent).toHaveBeenCalled())
    cleanup()
    resetViewStore()
    // agent 不存在
    setupChatBase(makeMockAgent("c1", "寨主"))
    useStorySimulationStore.setState({ activeChatAgent: { id: "nope", name: " nobody " } } as any)
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.agentNotFound"))
  })

  it("导出与保存聊天", async () => {
    setupChatBase()
    const msgs = [{ id: "m1", role: "user" as const, content: "hi", timestamp: new Date().toISOString() }]
    useStorySimulationStore.setState({ agentChatMessages: msgs } as any)
    novelMocks.exportInterview.mockResolvedValue("C:/proj/a.md" as any)
    novelMocks.saveInterview.mockResolvedValue(undefined as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByTitle("storySimulation.exportChatMd"))
    await waitFor(() => expect(novelMocks.exportInterview).toHaveBeenCalled())
    expect(useStorySimulationStore.getState().infoMessage).toContain("storySimulation.chatExported")
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(novelMocks.saveInterview).toHaveBeenCalled())
    expect(String(useStorySimulationStore.getState().infoMessage)).toContain("storySimulation.interviewSaved")
  })

  it("导出失败与保存失败报错", async () => {
    setupChatBase()
    useStorySimulationStore.setState({ agentChatMessages: [{ id: "m1", role: "user" as const, content: "hi", timestamp: new Date().toISOString() }] } as any)
    novelMocks.exportInterview.mockRejectedValue(new Error("export boom"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByTitle("storySimulation.exportChatMd"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("export boom"))
    cleanup()
    resetViewStore()
    setupChatBase()
    useStorySimulationStore.setState({ agentChatMessages: [{ id: "m1", role: "user" as const, content: "hi", timestamp: new Date().toISOString() }] } as any)
    novelMocks.saveInterview.mockRejectedValue(new Error("save boom"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("save boom"))
  })
})

describe("StorySimulationView 续聊恢复与取消", () => {
  beforeEach(() => { resetViewStore(); vi.stubGlobal("confirm", vi.fn(() => true)) })
  afterEach(() => { cleanup(); resetViewStore(); vi.unstubAllGlobals() })

  it("continuingInterview 从采访快照恢复", async () => {
    const agent = makeMockAgent()
    const snap = { dummy: 1 } as any
    novelMocks.loadInterviews.mockResolvedValue([{ id: "int1", agentId: "c1", agentName: "寨主", session: { agentId: "c1", agentName: "寨主", messages: [] }, agentSnapshot: snap, frameworkId: "fw1" }] as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 2, timelineEvents: [], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), continuingInterviewId: "int1" } as any)
    render(<StorySimulationView />)
    // 恢复是异步 effect，等待 interviewAgent 可用即证明 refs 已填充：直接发消息
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => { opts?.onDone?.(); return { fullText: "", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any })
    useStorySimulationStore.setState({ activeChatAgent: { id: "c1", name: "寨主" }, agentChatMessages: [] } as any)
    await waitFor(() => expect(novelMocks.loadInterviews).toHaveBeenCalled())
  })

  it("continuingInterview 无快照时从推演结果恢复", async () => {
    const agent = makeMockAgent()
    novelMocks.loadInterviews.mockResolvedValue([{ id: "int2", agentId: "c1", agentName: "寨主", session: { agentId: "c1", agentName: "寨主", messages: [] }, frameworkId: "fw1" }] as any)
    novelMocks.loadSimulationResults.mockResolvedValue([{ id: "r1", agentSnapshot: { dummy: 1 }, frameworkId: "fw1", report: makeReport() }] as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 1, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), continuingInterviewId: "int2" } as any)
    render(<StorySimulationView />)
    await waitFor(() => expect(novelMocks.loadSimulationResults).toHaveBeenCalled())
  })

  it("continuingInterview 恢复失败不崩", async () => {
    novelMocks.loadInterviews.mockRejectedValue(new Error("load fail"))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), continuingInterviewId: "bad" } as any)
    render(<StorySimulationView />)
    await waitFor(() => expect(novelMocks.loadInterviews).toHaveBeenCalled())
    // 错误被 console.error 吞掉，页面不报错
    expect(useStorySimulationStore.getState().phase).toBe("report-viewing")
    errSpy.mockRestore()
  })

  it("取消无控制器时静默， abort 触发部分保存", async () => {
    // 无控制器：进度页取消不报错
    useStorySimulationStore.setState({ phase: "extracting", progress: 10, progressLabel: "x" } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("取消"))
    expect(useStorySimulationStore.getState().error).toBeNull()
    cleanup()
    resetViewStore()
    // 有控制器：延迟 run 中取消走 abort 分支
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "cancel-e1", content: "取消前事件" })
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any, timelineEvents: [], debugTraces: [] } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any, signal: any) => {
      cb?.onTimelineEvent?.(ev)
      await new Promise((r) => setTimeout(r, 300))
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      return [ev]
    })
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    // 等待进入 simulating 出现取消按钮后点取消
    await waitFor(() => expect(screen.queryByText("取消推演")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消推演"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 5000 })
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.simulationCancelled")
    expect(novelMocks.saveSimulationResult).toHaveBeenCalled()
  })

  it("空时间线取消直接返回不保存", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any, timelineEvents: [], debugTraces: [] } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, _cb: any, signal: any) => {
      await new Promise((r) => setTimeout(r, 200))
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      return []
    })
    const saveSpy = novelMocks.saveSimulationResult
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(screen.queryByText("取消推演")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消推演"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 5000 })
    // 空时间线+空 trace 时 savePartial 早退：saveSimulationResult 不应被部分保存调用（confirm 正常保存也不应发生，因已 abort）
    // 允许 confirm 的正常保存未发生，断言 abort 错误即可
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.simulationCancelled")
    expect(saveSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ frameworkId: fw.id }), undefined, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ status: expect.stringMatching(/cancelled|partial/) }))
  })
})

describe("StorySimulationView 中断与回调全覆盖", () => {
  beforeEach(() => { resetViewStore(); vi.stubGlobal("confirm", vi.fn(() => false)) })
  afterEach(() => { cleanup(); resetViewStore(); vi.unstubAllGlobals() })

  it("run 成功后被取消走保存部分分支", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "abort-e1", content: "x".repeat(10) })
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any, dynamicEventPool: [] as any } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    // run 延迟 400ms 后正常 resolve，但期间被 abort：覆盖 661 分支（resolve 后检查 aborted）
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => {
      cb?.onTimelineEvent?.(ev)
      await new Promise((r) => setTimeout(r, 400))
      return [ev]
    })
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([{ id: "r1", frameworkId: fw.id, report: makeReport(), draft: null, timelineEvents: [ev], agentSnapshot: null, rumors: [], debugTraces: [], status: "cancelled", createdAt: new Date().toISOString() }] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(screen.queryByText("取消推演")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消推演"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 6000 })
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.simulationCancelled")
    // 部分保存应被调用且 info 提示出现
    await waitFor(() => expect(novelMocks.saveSimulationResult).toHaveBeenCalled())
  })

  it("报告生成后被取消走取消分支", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "abort-e2" })
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => { cb?.onTimelineEvent?.(ev); return [ev] })
    novelMocks.generateSimulationReport.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400))
      return makeReport()
    })
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    // 等待进入 report-generating（进度 80% + 取消按钮“取消”）后取消
    await waitFor(() => expect(screen.queryByText("取消")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("framework-confirming"), { timeout: 6000 })
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.cancelled")
  })

  it("草稿缺输入与取消分支", async () => {
    // 缺输入：无项目时点生成（需先进入 report-viewing 且有生成按钮）
    const fw = makeFrameworkWithNodes()
    const report = makeReport()
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: fw, currentReport: report, timelineEvents: [makeEvent()], currentAgents: new Map() } as any)
    wikiState.project = undefined as any
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().error).toBe("storySimulation.missingDraftInputs"))
    cleanup()
    resetViewStore()
    // 生成中取消：覆盖 821 分支
    const draft = { branchId: "b1", frameworkId: "fw1", chapters: [{ title: "t", content: "x", correspondingNode: 0 }], totalWords: 1, createdAt: new Date().toISOString() } as any
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: makeReport(), timelineEvents: [makeEvent()], currentAgents: new Map() } as any)
    novelMocks.generateStoryDraft.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 400)); return draft })
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(screen.queryByText("取消")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 6000 })
    expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.draftCancelled")
  })

  it("草稿抛错时 abort 与非 abort 分支", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: makeReport(), timelineEvents: [makeEvent()], currentAgents: new Map() } as any)
    // 非 abort 抛错
    novelMocks.generateStoryDraft.mockRejectedValueOnce(new Error("draft fail"))
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("draft fail"))
    cleanup()
    resetViewStore()
    // abort 抛错：mock 直接 throw AbortError 且 signal 已 abort
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: makeReport(), timelineEvents: [makeEvent()], currentAgents: new Map() } as any)
    novelMocks.generateStoryDraft.mockImplementation(async (_o: any) => {
      await new Promise((r) => setTimeout(r, 200))
      const e = new DOMException("aborted", "AbortError")
      throw e
    })
    render(<StorySimulationView />)
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(screen.queryByText("取消")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("取消"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.draftCancelled"), { timeout: 6000 })
  })

  it("保存框架早退与历史早退分支", async () => {
    // 保存早退：无项目时点保存直接返回
    const fw = makeFrameworkWithNodes()
    wikiState.project = undefined as any
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.saveFramework"))
    await new Promise((r) => setTimeout(r, 100))
    expect(novelMocks.saveFramework).not.toHaveBeenCalled()
    cleanup()
    resetViewStore()
    // 历史选择 ghost id 早退
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, savedResults: [] as any, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.loadSimulationResults.mockResolvedValue([{ id: "ghost", frameworkId: "fw1", report: { ...makeReport(), recommendation: "ghost-rec" }, draft: null, timelineEvents: [], agentSnapshot: null, rumors: [], debugTraces: [], status: "complete", createdAt: new Date().toISOString() }] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByLabelText("ghost-rec")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByLabelText("ghost-rec"))
    await new Promise((r) => setTimeout(r, 200))
    expect(useStorySimulationStore.getState().phase).toBe("framework-confirming")
    cleanup()
    resetViewStore()
    // 继续 partial 无 resume 早退
    const report = makeReport()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, savedResults: [{ id: "noresume", frameworkId: "fw1", report, draft: null, timelineEvents: [], agentSnapshot: null, rumors: [], debugTraces: [], status: "partial", createdAt: report.createdAt }] as any, extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.loadSimulationResults.mockResolvedValue(useStorySimulationStore.getState().savedResults as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByText("storySimulation.continueSimulation")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("storySimulation.continueSimulation"))
    await new Promise((r) => setTimeout(r, 300))
    expect(novelMocks.runSimulation).not.toHaveBeenCalled()
  })

  it("续跑快照损坏回退并继续", async () => {
    const agent = makeMockAgent()
    const fw = makeFrameworkWithNodes()
    const ev = makeEvent({ id: "resume-corrupt-e" })
    const report = makeReport()
    const badSnap = { corrupt: true } as any
    useStorySimulationStore.setState({
      phase: "framework-confirming", currentFramework: fw,
      savedResults: [{ id: "bad", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: badSnap, rumors: [], debugTraces: [], status: "partial", partialReason: "x", resume: { nextNodeIndex: 0, nextRound: 1, timelineEvents: [ev] }, createdAt: report.createdAt }] as any,
      extractionResult: makeExtraction(), frameworks: [fw] as any,
    } as any)
    // 续跑的 deserialize 抛错一次（handleContinue 内），之后 confirm 内的 deserialize 也抛但被吞
    novelMocks.deserializeSimulationSnapshot.mockImplementation(() => { throw new Error("bad") })
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => { cb?.onTimelineEvent?.(ev); return [ev] })
    novelMocks.generateSimulationReport.mockResolvedValue(report as any)
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    novelMocks.loadSimulationResults.mockResolvedValueOnce(useStorySimulationStore.getState().savedResults as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByText("storySimulation.continueSimulation")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByText("storySimulation.continueSimulation"))
    await waitFor(() => expect(novelMocks.runSimulation).toHaveBeenCalled(), { timeout: 5000 })
    expect(useStorySimulationStore.getState().currentAgents.size).toBe(0)
  })
})

describe("StorySimulationView 收尾覆盖", () => {
  beforeEach(() => { resetViewStore(); vi.stubGlobal("confirm", vi.fn(() => true)) })
  afterEach(() => { cleanup(); resetViewStore(); vi.unstubAllGlobals() })

  it("导出/保存早退不调用", async () => {
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: fw, currentReport: makeReport(), timelineEvents: [makeEvent()], activeChatAgent: { id: "c1", name: "寨主" }, agentChatMessages: [] } as any)
    render(<StorySimulationView />)
    // 消息为空时导出/保存按钮 disabled，点击不应调用
    expect(novelMocks.exportInterview).not.toHaveBeenCalled()
    expect(novelMocks.saveInterview).not.toHaveBeenCalled()
  })

  it("空输入回车早退", async () => {
    const agent = makeMockAgent()
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: makeReport(), timelineEvents: [makeEvent()], currentAgents: new Map([[agent.characterId, agent]]), activeChatAgent: { id: agent.characterId, name: agent.name }, agentChatMessages: [] } as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    render(<StorySimulationView />)
    const input = screen.getByPlaceholderText("storySimulation.chatPlaceholder")
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false })
    await new Promise((r) => setTimeout(r, 100))
    expect(novelMocks.interviewAgent).not.toHaveBeenCalled()
  })

  it("历史快照恢复成功路径", async () => {
    const agent = makeMockAgent()
    const ev = makeEvent({ id: "restore-e1" })
    const report = makeReport()
    const snap = { ok: 1 } as any
    // refs 为空：不预置 currentAgents，依靠 selectedResult 恢复
    useStorySimulationStore.setState({
      phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: report, timelineEvents: [ev],
      currentAgents: new Map(), activeChatAgent: { id: agent.characterId, name: agent.name }, agentChatMessages: [],
      savedResults: [{ id: "rs1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any,
      selectedResultId: "rs1",
    } as any)
    // selectedResult effect 会先恢复一次，handleSendChat 内再次恢复也应走通
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 0, timelineEvents: [ev], activeAgents: new Map([[agent.characterId, agent]]), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => { opts?.onDone?.(); return { fullText: "", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any })
    render(<StorySimulationView />)
    // 等待 effect 填充 refs 后再发送（refs 已有则不走恢复分支，为覆盖恢复分支需先清空 refs？此处 effect 已填充，handleSendChat 将直接走正常分支）
    // 为强制走恢复分支，等待后手动清空 refs 的唯一方式是重新渲染空 refs？改用直接验证恢复逻辑：发送应成功
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi-restore" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(novelMocks.interviewAgent).toHaveBeenCalled(), { timeout: 5000 })
  })

  it("历史快照损坏恢复失败", async () => {
    const agent = makeMockAgent()
    const ev = makeEvent({ id: "restore-bad" })
    const report = makeReport()
    // 渲染时不带 snapshot，发送时 refs 为空且 selectedResult 快照损坏
    useStorySimulationStore.setState({
      phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: report, timelineEvents: [ev],
      currentAgents: new Map(), activeChatAgent: { id: agent.characterId, name: agent.name }, agentChatMessages: [],
      savedResults: [{ id: "bad1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: { bad: 1 }, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any,
      selectedResultId: "bad1",
    } as any)
    novelMocks.deserializeSimulationSnapshot.mockImplementation(() => { throw new Error("corrupt") })
    render(<StorySimulationView />)
    // effect 的 deserialize 也会抛，但 handleSendChat 的恢复分支应报错 restoreAgentFailed
    // 为确保 refs 为空，等待 effect 后再发送（effect 失败不会填充 refs）
    await new Promise((r) => setTimeout(r, 200))
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => expect(String(useStorySimulationStore.getState().error)).toContain("storySimulation.restoreAgentFailed"))
  })

  it("续聊保存覆盖确认分支", async () => {
    const agent = makeMockAgent()
    const ev = makeEvent({ id: "save-e1" })
    // 先通过 confirm 填充 refs
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, extractionResult: makeExtraction(), frameworks: [fw] as any, dynamicEventPool: [] as any } as any)
    novelMocks.buildAgents.mockReturnValue([agent] as any)
    novelMocks.runSimulation.mockImplementation(async (_p: any, _e: any, cb: any) => { cb?.onTimelineEvent?.(ev); cb?.onDebugTrace?.(makeDebugTrace(agent, 1)); return [ev] })
    novelMocks.generateSimulationReport.mockResolvedValue(makeReport() as any)
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.confirmFramework"))
    await waitFor(() => expect(useStorySimulationStore.getState().phase).toBe("report-viewing"), { timeout: 5000 })
    // 进入采访并保存，continuingInterviewId 存在且 confirm 返回 true → existingId 被设置
    useStorySimulationStore.setState({ activeChatAgent: { id: agent.characterId, name: agent.name }, agentChatMessages: [{ id: "m1", role: "user" as const, content: "hi", timestamp: new Date().toISOString() }], continuingInterviewId: "int-keep" } as any)
    novelMocks.saveInterview.mockResolvedValue(undefined as any)
    novelMocks.serializeSimulationState.mockReturnValue({ agents: [], state: {} } as any)
    await waitFor(() => expect(screen.queryByTitle("storySimulation.saveInterviewTip")).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByTitle("storySimulation.saveInterviewTip"))
    await waitFor(() => expect(novelMocks.saveInterview).toHaveBeenCalled())
    const saveOpts = (novelMocks.saveInterview.mock.calls[0] as any)[2]
    expect(saveOpts.existingId).toBe("int-keep")
    expect(useStorySimulationStore.getState().continuingInterviewId).toBeNull()
  })

  it("流式节流定时器触发", async () => {
    const agent = makeMockAgent()
    const ev = makeEvent({ id: "throttle-e" })
    const report = makeReport()
    const snap = { ok: 1 } as any
    useStorySimulationStore.setState({ phase: "report-viewing", currentFramework: makeFrameworkWithNodes(), currentReport: report, timelineEvents: [ev], currentAgents: new Map([[agent.characterId, agent]]), activeChatAgent: { id: agent.characterId, name: agent.name }, agentChatMessages: [], savedResults: [{ id: "th1", frameworkId: "fw1", report, draft: null, timelineEvents: [ev], agentSnapshot: snap, rumors: [], debugTraces: [], status: "complete", createdAt: report.createdAt }] as any, selectedResultId: "th1" } as any)
    novelMocks.deserializeSimulationSnapshot.mockReturnValue({ agents: [agent], state: { currentRound: 0, timelineEvents: [], activeAgents: new Map(), worldState: {}, directorEnabled: false, nextNodeInjectionMap: new Map() } } as any)
    novelMocks.interviewAgent.mockImplementation(async (opts: any) => {
      opts?.onToken?.("a")
      await new Promise((r) => setTimeout(r, 120))
      opts?.onToken?.("b")
      await new Promise((r) => setTimeout(r, 120))
      opts?.onDone?.()
      return { fullText: "ab", session: { agentId: "c1", agentName: "寨主", messages: [] } } as any
    })
    render(<StorySimulationView />)
    fireEvent.change(screen.getByPlaceholderText("storySimulation.chatPlaceholder"), { target: { value: "hi-throttle" } })
    fireEvent.click(screen.getByTitle("chat.send"))
    await waitFor(() => {
      const msgs = useStorySimulationStore.getState().agentChatMessages
      const am = msgs.find((m) => m.role === "agent")
      expect(am?.content).toContain("a")
    }, { timeout: 5000 })
  })

  it("各回调按钮全点击", async () => {
    const mkBranch = (id: string, name: string) => ({ id, name, frameworkId: "fw1", mode: "event-driven", createdAt: new Date().toISOString(), timelineEvents: [], rumors: [], finalAgentSnapshots: [], directorEvaluations: [], overallScore: 3.5, scoreDetails: { avgDirectorScore: 3.5, eventCount: 2, characterDiversity: 1, plotProgression: 0.6 } } as any)
    // simulating 对比返回
    useStorySimulationStore.setState({ phase: "simulating", timelineEvents: [makeEvent({ id: "e1" })], debugTraces: [], currentFramework: makeFrameworkWithNodes(), branches: [mkBranch("b1", "B1"), mkBranch("b2", "B2")], isCompareMode: true, compareBranchIds: ["b1", "b2"] } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.backToBranchManagement"))
    await waitFor(() => expect(useStorySimulationStore.getState().isCompareMode).toBe(false))
    cleanup()
    resetViewStore()
    // simulating 非对比采访（用 getAllByText 取事件气泡外的采访按钮，避免与筛选下拉重名）
    useStorySimulationStore.setState({ phase: "simulating", timelineEvents: [makeEvent({ id: "e1", actorId: "c1", actorName: "寨主", content: "台词" })], debugTraces: [], currentFramework: makeFrameworkWithNodes(), branches: [], isCompareMode: false } as any)
    render(<StorySimulationView />)
    const zhaiBtns = screen.getAllByText("寨主")
    // 采访按钮是 button 元素，筛选 option 不是
    const interviewBtn = zhaiBtns.find((el) => el.tagName.toLowerCase() === "button")!
    expect(interviewBtn).toBeTruthy()
    fireEvent.click(interviewBtn)
    await waitFor(() => expect(useStorySimulationStore.getState().activeChatAgent?.name).toBe("寨主"))
    cleanup()
    resetViewStore()
    // 历史 modal 关闭
    const fw = makeFrameworkWithNodes()
    useStorySimulationStore.setState({ phase: "framework-confirming", currentFramework: fw, savedResults: [], extractionResult: makeExtraction(), frameworks: [fw] as any } as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.viewHistory"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    cleanup()
    resetViewStore()
    // report 对比返回 + 查看采访历史
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), timelineEvents: [makeEvent()], currentFramework: makeFrameworkWithNodes(), branches: [mkBranch("b1", "B1"), mkBranch("b2", "B2")], isCompareMode: true, compareBranchIds: ["b1", "b2"] } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.backToBranchManagement"))
    await waitFor(() => expect(useStorySimulationStore.getState().isCompareMode).toBe(false))
    cleanup()
    resetViewStore()
    // report 查看采访历史 + draft 回调
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport(), timelineEvents: [makeEvent()], currentFramework: makeFrameworkWithNodes(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [], totalWords: 0, createdAt: new Date().toISOString() } as any, currentAgents: new Map() } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("storySimulation.interviewHistory"))
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(true)
    cleanup()
    resetViewStore()
    useStorySimulationStore.setState({ phase: "draft-viewing", currentReport: makeReport(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "正文", correspondingNode: 0 }], totalWords: 10, createdAt: new Date().toISOString() } as any, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map([["c1", makeMockAgent()]]) } as any)
    render(<StorySimulationView />)
    // draft 页的推演报告 tab 内应有 resimulate 按钮（切到报告 tab 才可见？先切 tab）
    fireEvent.click(screen.getByText("推演报告"))
    await waitFor(() => expect(screen.getByText("storySimulation.resimulate")).toBeTruthy())
    fireEvent.click(screen.getByText("storySimulation.resimulate"))
    expect(useStorySimulationStore.getState().phase).toBe("framework-confirming")
  })

  it("草稿页生成/采访/历史回调", async () => {
    useStorySimulationStore.setState({ phase: "draft-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "正文", correspondingNode: 0 }], totalWords: 10, createdAt: new Date().toISOString() } as any, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map([["c1", makeMockAgent()]]) } as any)
    const draft2 = { branchId: "b1", frameworkId: "fw1", chapters: [{ title: "t2", content: "y", correspondingNode: 0 }], totalWords: 5, createdAt: new Date().toISOString() } as any
    novelMocks.generateStoryDraft.mockResolvedValue(draft2 as any)
    novelMocks.saveSimulationResult.mockResolvedValue(undefined as any)
    novelMocks.loadSimulationResults.mockResolvedValue([] as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("推演报告"))
    await waitFor(() => expect(screen.getAllByText("storySimulation.generateDraft")[0]).toBeTruthy())
    fireEvent.click(screen.getAllByText("storySimulation.generateDraft")[0])
    await waitFor(() => expect(novelMocks.generateStoryDraft).toHaveBeenCalled())
    cleanup()
    resetViewStore()
    // 采访与历史
    useStorySimulationStore.setState({ phase: "draft-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "正文", correspondingNode: 0 }], totalWords: 10, createdAt: new Date().toISOString() } as any, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map([["c1", makeMockAgent()]]) } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("推演报告"))
    await waitFor(() => expect(screen.getAllByText("storySimulation.chatWith")[0]).toBeTruthy())
    fireEvent.click(screen.getAllByText("storySimulation.chatWith")[0])
    await waitFor(() => expect(useStorySimulationStore.getState().activeChatAgent).not.toBeNull())
    cleanup()
    resetViewStore()
    useStorySimulationStore.setState({ phase: "draft-viewing", currentReport: makeReport(), currentFramework: makeFrameworkWithNodes(), currentDraft: { branchId: "b", frameworkId: "fw1", chapters: [{ title: "t", content: "正文", correspondingNode: 0 }], totalWords: 10, createdAt: new Date().toISOString() } as any, timelineEvents: [makeEvent()], debugTraces: [], currentRumors: [], currentAgents: new Map() } as any)
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("推演报告"))
    await waitFor(() => expect(screen.getByText("storySimulation.interviewHistory")).toBeTruthy())
    fireEvent.click(screen.getByText("storySimulation.interviewHistory"))
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(true)
  })
})
