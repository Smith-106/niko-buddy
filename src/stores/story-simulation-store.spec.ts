// SPDX-License-Identifier: MIT
// StorySimulation store 冒烟覆盖：初始契约 + append 语义 setter + 关键状态迁移
// （M1 测试债第一块：唯一无 spec 的 store，improve-odyssey 20260914）
import { beforeEach, describe, expect, it } from "vitest"
import {
  calculateBranchScore,
  useStorySimulationStore,
} from "./story-simulation-store"

const reset = () =>
  useStorySimulationStore.setState({
    phase: "idle",
    mode: "event-driven",
    userIdea: "",
    targetWords: 10000,
    sourceChapters: 10,
    simulationRounds: 0,
    progress: 0,
    progressLabel: "",
    timelineEvents: [],
    debugTraces: [],
    activeChatAgent: null,
    agentChatMessages: [],
    listRefreshKey: 0,
    savedResults: [],
    selectedResultId: null,
    showInterviewHistory: false,
    savedInterviews: [],
    viewingInterview: null,
    compareWithResultId: null,
    continuingInterviewId: null,
    error: null,
    infoMessage: null,
    currentFramework: null,
    currentReport: null,
    currentDraft: null,
    extractionResult: null,
    frameworks: [],
    selectedFrameworkId: null,
    binding: null,
  })

beforeEach(reset)

describe("story-simulation store — 初始契约", () => {
  it("初始态：idle / event-driven / 空集合", () => {
    const s = useStorySimulationStore.getState()
    expect(s.phase).toBe("idle")
    expect(s.mode).toBe("event-driven")
    expect(s.targetWords).toBe(10000)
    expect(s.sourceChapters).toBe(10)
    expect(s.simulationRounds).toBe(0)
    expect(s.timelineEvents).toEqual([])
    expect(s.agentChatMessages).toEqual([])
    expect(s.listRefreshKey).toBe(0)
    expect(s.error).toBeNull()
  })
})

describe("story-simulation store — setter 行为", () => {
  it("setPhase / setMode / setError / setInfoMessage 写入对应字段", () => {
    const st = useStorySimulationStore
    st.getState().setPhase("simulating")
    st.getState().setMode("hybrid")
    st.getState().setError("boom")
    st.getState().setInfoMessage("ok")
    const s = st.getState()
    expect(s.phase).toBe("simulating")
    expect(s.mode).toBe("hybrid")
    expect(s.error).toBe("boom")
    expect(s.infoMessage).toBe("ok")
  })

  it("setProgress 同步写入 progress 与 progressLabel", () => {
    useStorySimulationStore.getState().setProgress(42, "提取设定中")
    const s = useStorySimulationStore.getState()
    expect(s.progress).toBe(42)
    expect(s.progressLabel).toBe("提取设定中")
  })

  it("addTimelineEvent 追加语义（append，不替换）", () => {
    const st = useStorySimulationStore.getState()
    st.addTimelineEvent({ id: "e1" } as never)
    st.addTimelineEvent({ id: "e2" } as never)
    expect(useStorySimulationStore.getState().timelineEvents.map((e) => (e as { id: string }).id)).toEqual(["e1", "e2"])
  })

  it("addDebugTrace 追加语义", () => {
    const st = useStorySimulationStore.getState()
    st.addDebugTrace({ id: "t1" } as never)
    expect(useStorySimulationStore.getState().debugTraces).toHaveLength(1)
  })

  it("addAgentChatMessage 追加；clearAgentChat 清空消息与活跃角色", () => {
    const st = useStorySimulationStore.getState()
    st.setActiveChatAgent({ id: "a1", name: "侦探" })
    st.addAgentChatMessage({ id: "m1" } as never)
    expect(useStorySimulationStore.getState().agentChatMessages).toHaveLength(1)
    st.clearAgentChat()
    const s = useStorySimulationStore.getState()
    expect(s.agentChatMessages).toEqual([])
    expect(s.activeChatAgent).toBeNull()
  })

  it("bumpListRefresh 递增 listRefreshKey", () => {
    const st = useStorySimulationStore.getState()
    st.bumpListRefresh()
    st.bumpListRefresh()
    expect(useStorySimulationStore.getState().listRefreshKey).toBe(2)
  })

  it("setSavedResults / setSelectedResultId 选中历史结果", () => {
    const st = useStorySimulationStore.getState()
    st.setSavedResults([{ id: "r1", frameworkId: "f1", report: {}, createdAt: "2026-09-14" } as never])
    st.setSelectedResultId("r1")
    const s = useStorySimulationStore.getState()
    expect(s.savedResults).toHaveLength(1)
    expect(s.selectedResultId).toBe("r1")
  })
})

describe("story-simulation store — 基础 setter 增补", () => {
  const fullReset = () => {
    useStorySimulationStore.getState().reset()
    useStorySimulationStore.setState({
      mode: "event-driven",
      userIdea: "",
      targetWords: 10000,
      sourceChapters: 10,
      simulationRounds: 0,
      frameworks: [],
      selectedFrameworkId: null,
      binding: null,
      infoMessage: null,
      listRefreshKey: 0,
      interruptedSimStates: {},
    })
  }

  beforeEach(fullReset)

  it("setUserIdea / setTargetWords / setSourceChapters / setSimulationRounds 写入对应字段", () => {
    const st = useStorySimulationStore
    st.getState().setUserIdea("修仙开局")
    st.getState().setTargetWords(30000)
    st.getState().setSourceChapters(5)
    st.getState().setSimulationRounds(3)
    const s = st.getState()
    expect(s.userIdea).toBe("修仙开局")
    expect(s.targetWords).toBe(30000)
    expect(s.sourceChapters).toBe(5)
    expect(s.simulationRounds).toBe(3)
  })

  it("setExtractionResult / setCurrentFramework / setCurrentReport / setCurrentDraft 写入且可清空", () => {
    const st = useStorySimulationStore
    st.getState().setExtractionResult({ worldRules: "r" } as never)
    expect(st.getState().extractionResult).toMatchObject({ worldRules: "r" })
    st.getState().setExtractionResult(null)
    expect(st.getState().extractionResult).toBeNull()
    st.getState().setCurrentFramework({ id: "f1" } as never)
    expect((st.getState().currentFramework as { id: string }).id).toBe("f1")
    st.getState().setCurrentReport({ frameworkId: "f1" } as never)
    expect((st.getState().currentReport as { frameworkId: string }).frameworkId).toBe("f1")
    st.getState().setCurrentDraft({ branchId: "b1" } as never)
    expect((st.getState().currentDraft as { branchId: string }).branchId).toBe("b1")
    st.getState().setCurrentFramework(null)
    st.getState().setCurrentReport(null)
    st.getState().setCurrentDraft(null)
    expect(st.getState().currentFramework).toBeNull()
    expect(st.getState().currentReport).toBeNull()
    expect(st.getState().currentDraft).toBeNull()
  })

  it("setFrameworks / setSelectedFrameworkId / setBinding 写入", () => {
    const st = useStorySimulationStore
    st.getState().setFrameworks([{ id: "f1" }, { id: "f2" }] as never)
    st.getState().setSelectedFrameworkId("f2")
    st.getState().setBinding({ frameworkId: "f2" } as never)
    const s = st.getState()
    expect(s.frameworks).toHaveLength(2)
    expect(s.selectedFrameworkId).toBe("f2")
    expect((s.binding as { frameworkId: string }).frameworkId).toBe("f2")
  })

  it("采访相关 setter 写入与切换", () => {
    const st = useStorySimulationStore
    st.getState().setShowInterviewHistory(true)
    st.getState().setSavedInterviews([{ id: "i1" }] as never)
    st.getState().setViewingInterview({ id: "i1" } as never)
    st.getState().setCompareWithResultId("r9")
    st.getState().setContinuingInterviewId("i1")
    st.getState().setAgentChatMessages([{ id: "m1" }] as never)
    const s = st.getState()
    expect(s.showInterviewHistory).toBe(true)
    expect(s.savedInterviews).toHaveLength(1)
    expect((s.viewingInterview as { id: string }).id).toBe("i1")
    expect(s.compareWithResultId).toBe("r9")
    expect(s.continuingInterviewId).toBe("i1")
    expect(s.agentChatMessages).toHaveLength(1)
  })

  it("setTimelineEvents 替换列表；setDebugTraces 替换快照", () => {
    const st = useStorySimulationStore
    st.getState().addTimelineEvent({ id: "old" } as never)
    st.getState().setTimelineEvents([{ id: "n1" }, { id: "n2" }] as never)
    expect(st.getState().timelineEvents.map((e) => (e as { id: string }).id)).toEqual(["n1", "n2"])
    st.getState().addDebugTrace({ id: "old-t" } as never)
    st.getState().setDebugTraces([{ id: "t9" }] as never)
    expect(st.getState().debugTraces.map((t) => (t as { id: string }).id)).toEqual(["t9"])
  })

  it("setDynamicEventPool 支持字符串数组与分阶段池", () => {
    const st = useStorySimulationStore
    st.getState().setDynamicEventPool(["e1", "e2"])
    expect(st.getState().dynamicEventPool).toEqual(["e1", "e2"])
    const staged = { byStage: { setup: [], rising: [], climax: [], resolution: [] }, all: [] } as never
    st.getState().setDynamicEventPool(staged)
    expect(st.getState().dynamicEventPool).toBe(staged)
  })

  it("setDirectorEnabled / setCurrentRumors / setCurrentAgents 写入引用", () => {
    const st = useStorySimulationStore
    st.getState().setDirectorEnabled(true)
    expect(st.getState().directorEnabled).toBe(true)
    const rumors = [{ id: "r1" }] as never
    st.getState().setCurrentRumors(rumors)
    expect(st.getState().currentRumors).toBe(rumors)
    const agents = new Map([["c1", { characterId: "c1" } as never]])
    st.getState().setCurrentAgents(agents as never)
    expect(st.getState().currentAgents).toBe(agents)
    expect(st.getState().currentAgents.get("c1")).toBeDefined()
  })
})

describe("story-simulation store — 分支管理", () => {
  const fullReset = () => {
    useStorySimulationStore.getState().reset()
    useStorySimulationStore.setState({
      mode: "event-driven",
      interruptedSimStates: {},
      frameworks: [],
    })
  }

  const framework = {
    id: "f1",
    title: "测试框架",
    premise: "p",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 10,
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "n0",
        coreConflict: "c",
        involvedCharacters: ["c1", "c2", "c3"],
        goal: "g",
        causeFromPrev: "",
        expectedOutcome: "o",
      },
    ],
    createdAt: "2026-01-01",
  } as never

  const agentOf = (characterId: string, name: string, secrets: string[] = [], sentiments: [string, number][] = []) =>
    ({
      characterId,
      name,
      profile: "",
      aura: null,
      cognition: null,
      soul: "",
      currentGoal: "",
      emotionalState: "",
      knownFacts: new Set<string>(),
      relationships: new Map(),
      powerLevel: "",
      memory: {
        observedEvents: [],
        knownSecrets: new Set<string>(secrets),
        sentiments: new Map<string, number>(sentiments),
        recentDecisions: [],
        rumorCredibility: 0.5,
      },
      knowledgeScope: [],
      personality: [],
      speakingStyle: "",
    }) as never

  const timelineEvent = (id: string) =>
    ({
      id,
      round: 0,
      nodeIndex: 0,
      actorId: "c1",
      actorName: "A",
      actionType: "speak",
      content: "hi",
      observableBy: [],
      impacts: [],
      timestamp: "2026-01-01",
    }) as never

  beforeEach(fullReset)

  it("saveCurrentAsBranch 无框架时不新增分支", () => {
    useStorySimulationStore.getState().saveCurrentAsBranch("b")
    expect(useStorySimulationStore.getState().branches).toEqual([])
  })

  it("saveCurrentAsBranch 分支数达上限（10）时拒绝新增", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.setState({
      branches: Array.from({ length: 10 }, (_, i) => ({ id: "b" + i, name: "b" + i })) as never,
    })
    st.getState().saveCurrentAsBranch("overflow")
    expect(st.getState().branches).toHaveLength(10)
  })

  it("saveCurrentAsBranch happy path：快照、评分与拷贝隔离", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().setMode("hybrid")
    const agents = new Map([
      ["c1", agentOf("c1", "A", ["s1"], [["c2", 10]])],
      ["c2", agentOf("c2", "B", [], [["c1", -5]])],
    ])
    st.getState().setCurrentAgents(agents as never)
    st.getState().setTimelineEvents([timelineEvent("e1"), timelineEvent("e2")])
    st.getState().setCurrentRumors([{ id: "r1" }] as never)
    st.getState().saveCurrentAsBranch("第一条支线")
    const branches = st.getState().branches
    expect(branches).toHaveLength(1)
    const b = branches[0] as unknown as {
      id: string
      name: string
      frameworkId: string
      mode: string
      timelineEvents: unknown[]
      rumors: unknown[]
      finalAgentSnapshots: { agentId: string; name: string; knownSecrets: string[]; sentiments: [string, number][] }[]
      overallScore: number
      scoreDetails: { avgDirectorScore: number; eventCount: number; characterDiversity: number; plotProgression: number }
    }
    expect(b.id.startsWith("branch_")).toBe(true)
    expect(b.name).toBe("第一条支线")
    expect(b.frameworkId).toBe("f1")
    expect(b.mode).toBe("hybrid")
    expect(b.timelineEvents).toHaveLength(2)
    expect(b.rumors).toHaveLength(1)
    expect(b.finalAgentSnapshots).toHaveLength(2)
    expect(b.finalAgentSnapshots.find((s) => s.agentId === "c1")?.knownSecrets).toEqual(["s1"])
    expect(b.finalAgentSnapshots.find((s) => s.agentId === "c1")?.sentiments).toEqual([["c2", 10]])
    // 评分详情计算：2 个事件 / 2 活跃角色 / 3 角色上限
    expect(b.scoreDetails.eventCount).toBe(2)
    expect(b.scoreDetails.avgDirectorScore).toBe(3)
    expect(b.scoreDetails.characterDiversity).toBe(0.67)
    expect(b.scoreDetails.plotProgression).toBeCloseTo(0.6, 5)
    expect(b.overallScore).toBeGreaterThan(0)
    // 拷贝隔离：后续追加时间线事件不影响已保存分支
    st.getState().addTimelineEvent(timelineEvent("e3"))
    expect(st.getState().branches[0].timelineEvents).toHaveLength(2)
    expect(st.getState().timelineEvents).toHaveLength(3)
  })

  it("saveCurrentAsBranch 大事件量触及评分上限（20 与 40 事件同分）", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().setTimelineEvents(Array.from({ length: 20 }, (_, i) => timelineEvent("e" + i)))
    st.getState().saveCurrentAsBranch("twenty")
    const twenty = (st.getState().branches[0] as unknown as { overallScore: number }).overallScore
    st.getState().setTimelineEvents(Array.from({ length: 40 }, (_, i) => timelineEvent("x" + i)))
    st.getState().saveCurrentAsBranch("forty")
    const forty = (st.getState().branches[1] as unknown as { overallScore: number }).overallScore
    // eventScore = min(5, count/4) * 0.2：20 与 40 事件都触顶 1.0，其余因子相同故总分相等
    expect(forty).toBe(twenty)
    expect(forty).toBeGreaterThan(0)
  })

  it("deleteBranch 删除分支并清理 active 与对比选中；renameBranch 改名", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().saveCurrentAsBranch("one")
    st.getState().saveCurrentAsBranch("two")
    const [b1, b2] = st.getState().branches
    st.getState().switchToBranch(b1.id)
    st.getState().toggleCompareBranch(b1.id)
    st.getState().toggleCompareBranch(b2.id)
    st.getState().deleteBranch(b1.id)
    const s = st.getState()
    expect(s.branches.map((b) => b.id)).toEqual([b2.id])
    expect(s.activeBranchId).toBeNull()
    expect(s.compareBranchIds).toEqual([b2.id])
    st.getState().renameBranch(b2.id, "改名后")
    expect(st.getState().branches[0].name).toBe("改名后")
  })

  it("switchToBranch 不存在 id 时保持状态不变", () => {
    const st = useStorySimulationStore
    st.getState().setTimelineEvents([timelineEvent("keep")])
    const before = st.getState().timelineEvents
    st.getState().switchToBranch("missing")
    expect(st.getState().timelineEvents).toBe(before)
    expect(st.getState().activeBranchId).toBeNull()
  })

  it("switchToBranch 命中时恢复时间线、传闻并标记 active", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().setTimelineEvents([timelineEvent("e1")])
    st.getState().setCurrentRumors([{ id: "r1" }] as never)
    st.getState().saveCurrentAsBranch("snap")
    const bid = st.getState().branches[0].id
    st.getState().setTimelineEvents([])
    st.getState().setCurrentRumors([])
    st.getState().switchToBranch(bid)
    const s = st.getState()
    expect(s.activeBranchId).toBe(bid)
    expect(s.timelineEvents.map((e) => (e as { id: string }).id)).toEqual(["e1"])
    expect(s.currentRumors).toHaveLength(1)
  })

  it("clearBranches 清空分支、active、对比选中与对比模式", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().saveCurrentAsBranch("a")
    st.getState().saveCurrentAsBranch("b")
    const [b1, b2] = st.getState().branches
    st.getState().toggleCompareBranch(b1.id)
    st.getState().toggleCompareBranch(b2.id)
    st.getState().setCompareMode(true)
    expect(st.getState().isCompareMode).toBe(true)
    st.getState().clearBranches()
    const s = st.getState()
    expect(s.branches).toEqual([])
    expect(s.activeBranchId).toBeNull()
    expect(s.compareBranchIds).toEqual([])
    expect(s.isCompareMode).toBe(false)
  })

  it("toggleCompareBranch 增删与 3 个上限", () => {
    const st = useStorySimulationStore
    st.getState().toggleCompareBranch("x1")
    st.getState().toggleCompareBranch("x2")
    st.getState().toggleCompareBranch("x3")
    expect(st.getState().compareBranchIds).toEqual(["x1", "x2", "x3"])
    st.getState().toggleCompareBranch("x4")
    expect(st.getState().compareBranchIds).toEqual(["x1", "x2", "x3"])
    st.getState().toggleCompareBranch("x2")
    expect(st.getState().compareBranchIds).toEqual(["x1", "x3"])
    st.getState().clearCompareSelection()
    expect(st.getState().compareBranchIds).toEqual([])
    expect(st.getState().isCompareMode).toBe(false)
  })

  it("setCompareMode 数量校验：<2 或 >3 拒绝启用", () => {
    const st = useStorySimulationStore
    st.setState({ compareBranchIds: ["a"], isCompareMode: false })
    st.getState().setCompareMode(true)
    expect(st.getState().isCompareMode).toBe(false)
    st.setState({ compareBranchIds: ["a", "b"], isCompareMode: false })
    st.getState().setCompareMode(true)
    expect(st.getState().isCompareMode).toBe(true)
    st.setState({ compareBranchIds: ["a", "b", "c"], isCompareMode: false })
    st.getState().setCompareMode(true)
    expect(st.getState().isCompareMode).toBe(true)
    st.setState({ compareBranchIds: ["a", "b", "c", "d"], isCompareMode: false })
    st.getState().setCompareMode(true)
    expect(st.getState().isCompareMode).toBe(false)
    st.getState().setCompareMode(false)
    expect(st.getState().isCompareMode).toBe(false)
  })

  it("deleteBranch 非 active 分支时保留 active；renameBranch 只改目标分支", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().saveCurrentAsBranch("one")
    st.getState().saveCurrentAsBranch("two")
    const [b1, b2] = st.getState().branches
    st.getState().switchToBranch(b1.id)
    st.getState().deleteBranch(b2.id)
    expect(st.getState().branches.map((b) => b.id)).toEqual([b1.id])
    expect(st.getState().activeBranchId).toBe(b1.id)
    st.getState().saveCurrentAsBranch("three")
    const ids = st.getState().branches.map((b) => b.id)
    st.getState().renameBranch(ids[0], "renamed")
    expect(st.getState().branches[0].name).toBe("renamed")
    expect(st.getState().branches[1].name).toBe("three")
  })
})

describe("story-simulation store — 中断恢复与历史播放", () => {
  const fullReset = () => {
    useStorySimulationStore.getState().reset()
    useStorySimulationStore.setState({
      mode: "event-driven",
      interruptedSimStates: {},
      frameworks: [],
    })
  }

  const framework = {
    id: "f1",
    title: "F",
    premise: "p",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 10,
    nodes: [],
    createdAt: "2026-01-01",
  } as never

  const timelineEvent = (id: string) =>
    ({
      id,
      round: 0,
      nodeIndex: 0,
      actorId: "c1",
      actorName: "A",
      actionType: "speak",
      content: "hi",
      observableBy: [],
      impacts: [],
      timestamp: "2026-01-01",
    }) as never

  beforeEach(fullReset)

  it("saveInterruptedState 只在可保存阶段且有框架时生效", () => {
    const st = useStorySimulationStore
    st.getState().setPhase("idle")
    st.getState().setCurrentFramework(framework)
    st.getState().saveInterruptedState()
    expect(st.getState().interruptedSimStates).toEqual({})
    st.getState().setPhase("simulating")
    st.getState().setCurrentFramework(null)
    st.getState().saveInterruptedState()
    expect(st.getState().interruptedSimStates).toEqual({})
  })

  it("saveInterruptedState happy path 快照包含进度与 Map 拷贝", () => {
    const st = useStorySimulationStore
    st.getState().setPhase("simulating")
    st.getState().setCurrentFramework(framework)
    st.getState().setTimelineEvents([timelineEvent("e1")])
    st.getState().setProgress(55, "推演中")
    const agents = new Map([["c1", { characterId: "c1" } as never]])
    st.getState().setCurrentAgents(agents as never)
    st.getState().saveInterruptedState()
    const saved = st.getState().interruptedSimStates["f1"]
    expect(saved.phase).toBe("simulating")
    expect(saved.timelineEvents).toHaveLength(1)
    expect(saved.progress).toBe(55)
    expect(saved.progressLabel).toBe("推演中")
    expect(saved.currentAgents).not.toBe(agents)
    expect(saved.currentAgents.get("c1")).toBeDefined()
  })

  it("restoreInterruptedState 无快照时不变；明确 frameworkId 可恢复", () => {
    const st = useStorySimulationStore
    st.getState().setPhase("idle")
    st.getState().setCurrentFramework(framework)
    st.getState().restoreInterruptedState()
    expect(st.getState().phase).toBe("idle")
    // 先保存，切换到其他框架后用明确 id 恢复
    st.getState().setPhase("report-viewing")
    st.getState().setProgress(80, "报告中")
    st.getState().setTimelineEvents([timelineEvent("saved")])
    st.getState().saveInterruptedState()
    st.getState().setPhase("idle")
    st.getState().setTimelineEvents([])
    st.getState().setProgress(0, "")
    st.getState().restoreInterruptedState("f1")
    const s = st.getState()
    expect(s.phase).toBe("report-viewing")
    expect(s.timelineEvents.map((e) => (e as { id: string }).id)).toEqual(["saved"])
    expect(s.progress).toBe(80)
    // 恢复后条目被清除（一次性消费）
    expect(s.interruptedSimStates["f1"]).toBeUndefined()
  })

  it("restoreInterruptedState 默认用当前框架 id 恢复", () => {
    const st = useStorySimulationStore
    st.getState().setCurrentFramework(framework)
    st.getState().setPhase("draft-generating")
    st.getState().saveInterruptedState()
    st.getState().setPhase("idle")
    st.getState().restoreInterruptedState()
    expect(st.getState().phase).toBe("draft-generating")
  })

  it("addHistoryEntry / setHistoryIndex 停止播放 / togglePlayback / setPlaybackSpeed / clearHistory", () => {
    const st = useStorySimulationStore
    const entry = {
      round: 1,
      nodeIndex: 0,
      nodeTitle: "n0",
      agentStates: {},
      eventCount: 1,
      rumorCount: 0,
    } as never
    st.getState().addHistoryEntry(entry)
    st.getState().addHistoryEntry(entry)
    expect(st.getState().history).toHaveLength(2)
    st.setState({ isPlaying: true })
    st.getState().setHistoryIndex(0)
    expect(st.getState().historyIndex).toBe(0)
    expect(st.getState().isPlaying).toBe(false)
    st.getState().togglePlayback()
    expect(st.getState().isPlaying).toBe(true)
    st.getState().togglePlayback()
    expect(st.getState().isPlaying).toBe(false)
    st.getState().setPlaybackSpeed(2)
    expect(st.getState().playbackSpeed).toBe(2)
    st.getState().clearHistory()
    const s = st.getState()
    expect(s.history).toEqual([])
    expect(s.historyIndex).toBe(-1)
    expect(s.isPlaying).toBe(false)
  })
})

describe("story-simulation store — getDisplayAgents / reset / initWithPreset", () => {
  const fullReset = () => {
    useStorySimulationStore.getState().reset()
    useStorySimulationStore.setState({
      mode: "event-driven",
      userIdea: "",
      phase: "idle",
      interruptedSimStates: {},
      frameworks: [],
      savedResults: [],
    })
  }

  beforeEach(fullReset)

  it("getDisplayAgents 实时模式返回 currentAgents 本体", () => {
    const st = useStorySimulationStore
    const agents = new Map([["c1", { characterId: "c1", name: "A" } as never]])
    st.getState().setCurrentAgents(agents as never)
    st.getState().setHistoryIndex(-1)
    expect(st.getState().getDisplayAgents()).toBe(agents)
  })

  it("getDisplayAgents 历史索引越界时返回空 Map", () => {
    const st = useStorySimulationStore
    st.getState().addHistoryEntry({
      round: 0,
      nodeIndex: 0,
      nodeTitle: "n0",
      agentStates: {},
      eventCount: 0,
      rumorCount: 0,
    } as never)
    st.setState({ historyIndex: 5 })
    const result = st.getState().getDisplayAgents()
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  it("getDisplayAgents 回放模式重建 Agent 快照（Set/Map 转换正确）", () => {
    const st = useStorySimulationStore
    st.getState().addHistoryEntry({
      round: 2,
      nodeIndex: 1,
      nodeTitle: "n1",
      agentStates: {
        c1: {
          name: "侦探",
          sentiments: [["c2", 42]],
          knownSecrets: ["s1", "s2"],
          observedEvents: ["e1"],
        },
      },
      eventCount: 1,
      rumorCount: 0,
    } as never)
    st.setState({ historyIndex: 0 })
    const result = st.getState().getDisplayAgents()
    expect(result.size).toBe(1)
    const agent = result.get("c1") as unknown as {
      characterId: string
      name: string
      memory: { knownSecrets: Set<string>; sentiments: Map<string, number>; observedEvents: string[]; rumorCredibility: number }
    }
    expect(agent.characterId).toBe("c1")
    expect(agent.name).toBe("侦探")
    expect([...agent.memory.knownSecrets]).toEqual(["s1", "s2"])
    expect(agent.memory.sentiments.get("c2")).toBe(42)
    expect(agent.memory.observedEvents).toEqual(["e1"])
    expect(agent.memory.rumorCredibility).toBe(0.5)
  })

  it("reset 恢复全部状态字段", () => {
    const st = useStorySimulationStore
    st.getState().setPhase("simulating")
    st.getState().setCurrentFramework({ id: "f1" } as never)
    st.getState().addTimelineEvent({ id: "e1" } as never)
    st.getState().setCurrentAgents(new Map([["c1", { characterId: "c1" } as never]]) as never)
    st.getState().toggleCompareBranch("x1")
    st.getState().addHistoryEntry({ round: 0, nodeIndex: 0, nodeTitle: "t", agentStates: {}, eventCount: 0, rumorCount: 0 } as never)
    st.setState({ historyIndex: 0, isPlaying: true })
    st.getState().setPlaybackSpeed(2)
    st.getState().setDirectorEnabled(true)
    st.getState().reset()
    const s = st.getState()
    expect(s.phase).toBe("idle")
    expect(s.currentFramework).toBeNull()
    expect(s.timelineEvents).toEqual([])
    expect(s.currentAgents.size).toBe(0)
    expect(s.branches).toEqual([])
    expect(s.compareBranchIds).toEqual([])
    expect(s.history).toEqual([])
    expect(s.historyIndex).toBe(-1)
    expect(s.isPlaying).toBe(false)
    expect(s.playbackSpeed).toBe(1)
    expect(s.directorEnabled).toBe(false)
    expect(s.usedEventIndices.size).toBe(0)
    expect(s.error).toBeNull()
  })

  it("initWithPreset story_framework_generate 始终进入 configuring", () => {
    const st = useStorySimulationStore
    st.getState().initWithPreset({ intent: "story_framework_generate", userInput: "幻想", hasFramework: true })
    const s = st.getState()
    expect(s.userIdea).toBe("幻想")
    expect(s.phase).toBe("configuring")
  })

  it("initWithPreset multi_agent_simulate 有无框架分流", () => {
    const st = useStorySimulationStore
    st.getState().initWithPreset({ intent: "multi_agent_simulate", userInput: "a", hasFramework: true })
    expect(st.getState().phase).toBe("simulating")
    st.getState().initWithPreset({ intent: "multi_agent_simulate", userInput: "b", hasFramework: false })
    const s = st.getState()
    expect(s.phase).toBe("configuring")
    expect(s.userIdea).toBe("b")
  })

  it("initWithPreset character_interview 取决于框架与历史结果", () => {
    const st = useStorySimulationStore
    st.getState().initWithPreset({ intent: "character_interview", userInput: "q", hasFramework: false })
    expect(st.getState().phase).toBe("configuring")
    st.setState({
      savedResults: [{ id: "r1", frameworkId: "f1", report: {}, createdAt: "x" } as never],
    })
    st.getState().initWithPreset({ intent: "character_interview", userInput: "q2", hasFramework: true })
    expect(st.getState().phase).toBe("report-viewing")
    st.setState({ savedResults: [] })
    st.getState().initWithPreset({ intent: "character_interview", userInput: "q3", hasFramework: true })
    expect(st.getState().phase).toBe("configuring")
  })

  it("calculateBranchScore 非空导演评分区取平均（591–592 行）", () => {
    const zero = () => ({
      tension: 0,
      pace: 0,
      characterUtilization: 0,
      characterArc: 0,
      infoDensity: 0,
      emotionalResonance: 0,
      logicConsistency: 0,
    })
    const evals = [
      { scores: zero(), totalScore: 70, highlights: [], issues: [], suggestion: "", shouldInjectEvent: false },
      { scores: zero(), totalScore: 80, highlights: [], issues: [], suggestion: "", shouldInjectEvent: false },
    ]
    const { overallScore, details } = calculateBranchScore(evals, 8, 2, 3)
    // avgDirectorScore = (70 + 80) / 2 = 75 → directorScorePart = 75 * 0.5；总分保留一位小数
    expect(details.avgDirectorScore).toBe(75)
    expect(overallScore).toBe(
      Math.round((75 * 0.5 + Math.min(5, 8 / 4) * 0.2 + ((2 / 3) * 5 * 0.15) + 0.6 * 5 * 0.15) * 10) / 10,
    )
    // 空评分区回退 3.0（原有行为不受影响）
    expect(calculateBranchScore([], 0, 0, 3).details.avgDirectorScore).toBe(3)
  })

  it("initWithPreset 未知 intent 回退到 configuring", () => {
    const st = useStorySimulationStore
    st.getState().initWithPreset({ intent: "unknown_xyz", userInput: "hi", hasFramework: true })
    const s = st.getState()
    expect(s.phase).toBe("configuring")
    expect(s.userIdea).toBe("hi")
  })
})
