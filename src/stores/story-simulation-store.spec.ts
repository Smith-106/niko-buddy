// SPDX-License-Identifier: MIT
// StorySimulation store 冒烟覆盖：初始契约 + append 语义 setter + 关键状态迁移
// （M1 测试债第一块：唯一无 spec 的 store，improve-odyssey 20260914）
import { beforeEach, describe, expect, it } from "vitest"
import { useStorySimulationStore } from "./story-simulation-store"

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
