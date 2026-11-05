import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
  ModeConfig,
  NovelAgent,
  RumorEvent,
  SimulationState,
  StoryNode,
  TimelineEvent,
} from "@/lib/novel/story-simulation/types"
import {
  createSimulationBlackboard,
  createBlackboardDebugTrace,
  decideRumorTruth,
  findMatchingRumor,
  getBlackboardVisibleEvents,
  getBlackboardVisibleRumors,
  planMultiAgentRound,
  recordBlackboardEvent,
  recordRumorEvent,
  selectNodeAgentCandidates,
  spreadRumor,
  verifyRumor,
} from "@/lib/novel/story-simulation/multi-agent-orchestrator"

function makeAgent(id: string, name: string): NovelAgent {
  return {
    characterId: id,
    name,
    profile: `${name} profile`,
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "完成当前节点目标",
    emotionalState: "neutral",
    knownFacts: new Set(),
    relationships: new Map(),
    powerLevel: "normal",
    memory: {
      observedEvents: [],
      knownSecrets: new Set(),
      sentiments: new Map(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: [],
    speakingStyle: "",
  }
}

function makeTimelineEvent(
  id: string,
  observableBy: string[],
): TimelineEvent {
  return {
    id,
    round: 0,
    nodeIndex: 0,
    actorId: "a",
    actorName: "甲",
    actionType: "speak",
    content: id,
    observableBy,
    impacts: [],
    timestamp: "2026-07-03T00:00:00.000Z",
  }
}

function makeNode(): StoryNode {
  return {
    index: 0,
    phase: "起",
    title: "开端",
    coreConflict: "冲突",
    involvedCharacters: ["甲", "乙", "丙"],
    goal: "推进剧情",
    causeFromPrev: "无",
    expectedOutcome: "完成开端",
  }
}

function makeModeConfig(agentSubsetRatio: number): ModeConfig {
  return {
    roundsMultiplier: 1,
    behaviorHint: "",
    randomEventChance: 0,
    agentSubsetRatio,
    strictNodeProgression: true,
  }
}

function makeState(agents: NovelAgent[]): SimulationState {
  return {
    currentRound: 0,
    timelineEvents: [],
    activeAgents: new Map(agents.map((agent) => [agent.characterId, agent])),
    worldState: {},
    directorEnabled: false,
    nextNodeInjectionMap: new Map(),
  }
}

describe("createSimulationBlackboard", () => {
  it("indexes active agents and initial timeline events by visibility", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]
    const publicEvent = makeTimelineEvent("public", ["a", "b", "c"])
    const privateEvent = makeTimelineEvent("private", ["a", "b"])

    const blackboard = createSimulationBlackboard({
      agents,
      timelineEvents: [publicEvent, privateEvent],
    })

    expect([...blackboard.activeAgents.keys()]).toEqual(["a", "b", "c"])
    expect(blackboard.events.map((event) => event.id)).toEqual(["public", "private"])
    expect(blackboard.publicEvents.map((event) => event.id)).toEqual(["public"])
    expect(blackboard.visibleEventsByAgent.get("a")?.map((event) => event.id)).toEqual([
      "public",
      "private",
    ])
    expect(blackboard.visibleEventsByAgent.get("c")?.map((event) => event.id)).toEqual([
      "public",
    ])
  })

  it("keeps the full agent roster separate from the current active agents", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]

    const blackboard = createSimulationBlackboard({ agents })
    blackboard.activeAgents = new Map([["a", agents[0]]])

    expect([...blackboard.allAgents.keys()]).toEqual(["a", "b", "c"])
    expect([...blackboard.activeAgents.keys()]).toEqual(["a"])
  })

  it("records later events into shared and per-agent blackboard state", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const event = makeTimelineEvent("later", ["b"])

    recordBlackboardEvent(blackboard, event)

    expect(blackboard.events.map((item) => item.id)).toEqual(["later"])
    expect(blackboard.publicEvents).toEqual([])
    expect(blackboard.visibleEventsByAgent.get("a")).toEqual([])
    expect(blackboard.visibleEventsByAgent.get("b")?.map((item) => item.id)).toEqual([
      "later",
    ])
  })
})

describe("selectNodeAgentCandidates", () => {
  it("selects node participants from the full agent roster instead of current active agents", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]
    const blackboard = createSimulationBlackboard({ agents })
    blackboard.activeAgents = new Map([["a", agents[0]]])
    const node = {
      ...makeNode(),
      involvedCharacters: ["丙"],
    }

    const candidates = selectNodeAgentCandidates(blackboard, node)

    expect(candidates.map((agent) => agent.characterId)).toEqual(["c"])
  })

  it("falls back to all agents when a node does not match any participant names", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const node = {
      ...makeNode(),
      involvedCharacters: ["不存在的人"],
    }

    const candidates = selectNodeAgentCandidates(blackboard, node)

    expect(candidates.map((agent) => agent.characterId)).toEqual(["a", "b"])
  })
})

describe("getBlackboardVisibleEvents", () => {
  it("returns only events visible to the requested agent", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const visible = makeTimelineEvent("visible", ["a"])
    const hidden = makeTimelineEvent("hidden", ["b"])
    const blackboard = createSimulationBlackboard({
      agents,
      timelineEvents: [visible, hidden],
    })

    expect(getBlackboardVisibleEvents(blackboard, "a").map((event) => event.id)).toEqual([
      "visible",
    ])
  })

  it("keeps the newest visible events when a limit is provided", () => {
    const agents = [makeAgent("a", "甲")]
    const blackboard = createSimulationBlackboard({
      agents,
      timelineEvents: [
        makeTimelineEvent("old", ["a"]),
        makeTimelineEvent("middle", ["a"]),
        makeTimelineEvent("new", ["a"]),
      ],
    })

    expect(getBlackboardVisibleEvents(blackboard, "a", 2).map((event) => event.id)).toEqual([
      "middle",
      "new",
    ])
  })
})

describe("createBlackboardDebugTrace", () => {
  it("summarizes round planning and blackboard visibility without exposing mutable maps", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]
    const publicEvent = makeTimelineEvent("public", ["a", "b", "c"])
    const privateEvent = makeTimelineEvent("private", ["a", "b"])
    const blackboard = createSimulationBlackboard({
      agents,
      timelineEvents: [publicEvent, privateEvent],
    })
    const node = makeNode()
    const plan = planMultiAgentRound({
      node,
      state: makeState(agents),
      candidateAgents: [agents[0], agents[2]],
      modeConfig: makeModeConfig(1),
      round: 1,
    })

    const trace = createBlackboardDebugTrace(blackboard, {
      type: "round-plan",
      node,
      round: 1,
      candidateAgents: [agents[0], agents[2]],
      plan,
      timestamp: "2026-07-03T01:00:00.000Z",
    })

    expect(trace.type).toBe("round-plan")
    expect(trace.nodeIndex).toBe(0)
    expect(trace.nodeTitle).toBe("开端")
    expect(trace.round).toBe(1)
    expect(trace.strategy).toBe("all-agents")
    expect(trace.blackboard).toEqual({
      allAgentCount: 3,
      activeAgentCount: 3,
      totalEventCount: 2,
      publicEventCount: 1,
      rumorCount: 0,
    })
    expect(trace.candidateAgents.map((agent) => agent.agentId)).toEqual(["a", "c"])
    expect(trace.selectedAgents.map((agent) => agent.agentId)).toEqual(["a", "c"])
    expect(trace.selectedAgents[0].reason).toBe("模式要求全部角色参与")
    expect(trace.visibilityByAgent.find((agent) => agent.agentId === "a")).toMatchObject({
      agentName: "甲",
      visibleEventCount: 2,
    })
    expect(
      trace.visibilityByAgent.find((agent) => agent.agentId === "c")!.recentEvents!.map(
        (event) => event.id,
      ),
    ).toEqual(["public"])
    expect(trace.rumors).toBeInstanceOf(Array)
    expect(trace.activeAgents).toBeInstanceOf(Map)
  })

  it("limits each agent recent visible event summaries to the newest events", () => {
    const agents = [makeAgent("a", "甲")]
    const blackboard = createSimulationBlackboard({
      agents,
      timelineEvents: [
        makeTimelineEvent("old", ["a"]),
        makeTimelineEvent("middle", ["a"]),
        makeTimelineEvent("new", ["a"]),
      ],
    })

    const trace = createBlackboardDebugTrace(blackboard, {
      type: "event-recorded",
      node: makeNode(),
      round: 0,
      latestEvent: makeTimelineEvent("new", ["a"]),
      visibleEventLimit: 2,
      timestamp: "2026-07-03T01:00:00.000Z",
    })

    expect(trace.latestEvent?.id).toBe("new")
    expect(trace.visibilityByAgent[0].recentEvents!.map((event) => event.id)).toEqual([
      "middle",
      "new",
    ])
  })
})

describe("planMultiAgentRound", () => {
  it("schedules all candidate agents in order when the mode uses the full agent set", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]

    const plan = planMultiAgentRound({
      node: makeNode(),
      state: makeState(agents),
      candidateAgents: agents,
      modeConfig: makeModeConfig(1),
      round: 2,
    })

    expect(plan.round).toBe(2)
    expect(plan.nodeIndex).toBe(0)
    expect(plan.turns.map((turn) => turn.agentId)).toEqual(["a", "b", "c"])
    expect(plan.turns.map((turn) => turn.agentName)).toEqual(["甲", "乙", "丙"])
  })

  it("schedules only a mode-sized subset when the mode uses partial agents", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]

    const plan = planMultiAgentRound({
      node: makeNode(),
      state: makeState(agents),
      candidateAgents: agents,
      modeConfig: makeModeConfig(0.5),
      round: 0,
      random: () => 0.9,
    })

    expect(plan.turns).toHaveLength(2)
    expect(plan.turns.every((turn) => ["a", "b", "c"].includes(turn.agentId))).toBe(true)
  })

  it("returns an empty plan when there are no candidate agents", () => {
    const plan = planMultiAgentRound({
      node: makeNode(),
      state: makeState([]),
      candidateAgents: [],
      modeConfig: makeModeConfig(1),
      round: 0,
    })

    expect(plan.turns).toEqual([])
  })
})

describe("simulation-engine integration", () => {
  it("delegates round planning and blackboard recording to the orchestrator module", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/novel/story-simulation/simulation-engine.ts"),
      "utf8",
    )

    expect(source).toContain("planMultiAgentRound")
    expect(source).toContain("recordBlackboardEvent")
    expect(source).toContain("selectNodeAgentCandidates")
    expect(source).toContain("getBlackboardVisibleEvents")
    expect(source).toContain("createBlackboardDebugTrace")
    expect(source).toContain("onDebugTrace?:")
    expect(source).toContain("callbacks.onDebugTrace?.")
    expect(source).not.toContain("Math.random() - 0.5")
    expect(source).not.toContain("state.timelineEvents,\n    10,")
  })
})

describe("multi-agent-orchestrator 分支覆盖补齐（R-26：分支 miss 清零）", () => {
  function makeRumor(id: string, content: string, observableBy: string[]): RumorEvent {
    return {
      id,
      round: 0,
      nodeIndex: 0,
      sourceId: null,
      content,
      distortion: 0.1,
      observableBy,
      believedBy: [],
      verifiedBy: [],
      timestamp: "2026-07-03T00:00:00.000Z",
      generation: 0,
    }
  }

  it("未知角色取可见事件/传闻 → ?? [] 右侧空数组", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    expect(getBlackboardVisibleEvents(blackboard, "ghost")).toEqual([])
    expect(getBlackboardVisibleRumors(blackboard, "ghost")).toEqual([])
    expect(findMatchingRumor(blackboard, "ghost", "城西失火")).toBeNull()
  })

  it("调试轨迹：无可见事件的角色 → 可见数 0（?? [] 右侧）", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    const trace = createBlackboardDebugTrace(blackboard, {
      type: "round-plan",
      node: makeNode(),
      round: 0,
    })
    expect(trace.visibilityByAgent).toHaveLength(1)
    expect(trace.visibilityByAgent[0]).toMatchObject({ agentId: "a", visibleEventCount: 0 })
  })

  it("空活跃集记录事件 → isPublicEvent 直接 false（不公开）", () => {
    const blackboard = createSimulationBlackboard({ agents: [] })
    const event = makeTimelineEvent("e1", [])
    recordBlackboardEvent(blackboard, event)
    expect(blackboard.events).toHaveLength(1)
    expect(blackboard.publicEvents).toHaveLength(0)
  })

  it("关键词部分重叠 → 命中最匹配传闻（overlap/score/阈值 then）", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    recordRumorEvent(blackboard, makeRumor("r1", "城西，市场开张", ["a"]))
    const hit = findMatchingRumor(blackboard, "a", "城西，粮仓失火")
    expect(hit?.id).toBe("r1")
  })

  it("双方关键词皆空 → 总数 0 走 else → 无匹配 null", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    recordRumorEvent(blackboard, makeRumor("r1", "。", ["a"]))
    expect(findMatchingRumor(blackboard, "a", "，")).toBeNull()
  })

  it("中等失真三段全覆盖：confirmed/partial/debunked（确定性随机）", () => {
    for (const [randValue, expected] of [
      [0.2, "confirmed"],
      [0.5, "partial"],
      [0.8, "debunked"],
    ] as const) {
      const rand = vi.spyOn(Math, "random").mockReturnValue(randValue)
      try {
        expect(decideRumorTruth(0.5)).toBe(expected)
      } finally {
        rand.mockRestore()
      }
    }
  })

  it("verifyRumor：传闻/角色缺失 → 明确错误串", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["a"]))
    expect(verifyRumor(blackboard, "a", "nope", "confirmed")).toContain("找不到指定的传闻")
    expect(verifyRumor(blackboard, "ghost", "r1", "confirmed")).toContain("找不到指定的角色")
  })

  it("verifyRumor confirmed 幂等：重复验证不堆 verifiedBy/believedBy", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["a"]))
    const first = verifyRumor(blackboard, "a", "r1", "confirmed")
    expect(first).toContain("确认属实")
    const rumor = blackboard.rumors[0]!
    expect(rumor.verifiedBy).toEqual(["a"])
    expect(rumor.believedBy).toEqual(["a"])
    verifyRumor(blackboard, "a", "r1", "confirmed")
    expect(rumor.verifiedBy).toEqual(["a"])
    expect(rumor.believedBy).toEqual(["a"])
  })

  it("verifyRumor debunked：角色无可见传闻映射 → 跳过摘除但记 observed", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["a"]))
    // 注意：未走 recordRumorEvent，可见映射缺失 → 395 else
    const message = verifyRumor(blackboard, "a", "r1", "debunked")
    expect(message).toContain("证实为假")
    const agent = blackboard.allAgents.get("a")!
    expect(agent.memory.observedEvents).toContain("r1")
  })

  it("verifyRumor debunked：传闻不在角色可见列 → 不摘除他人条目", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["a"]))
    blackboard.rumors.push(makeRumor("r2", "据说城东涨水", ["a"]))
    recordRumorEvent(blackboard, blackboard.rumors[1]!)
    const message = verifyRumor(blackboard, "a", "r1", "debunked")
    expect(message).toContain("证实为假")
    expect(blackboard.visibleRumorsByAgent.get("a")!.map((r) => r.id)).toEqual(["r2"])
  })

  it("spreadRumor：未知传播者 → null（守卫 then）", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲"), makeAgent("b", "乙")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["a", "b"]))
    const result = spreadRumor(blackboard, "r1", "ghost", "b", "转述")
    expect(result).toEqual({ newRumor: null, targetBelieved: false })
  })

  it("spreadRumor：传播者不可见源传闻 → null（?? [] 右侧）", () => {
    const blackboard = createSimulationBlackboard({ agents: [makeAgent("a", "甲"), makeAgent("b", "乙")] })
    blackboard.rumors.push(makeRumor("r1", "听说城西失火", ["b"]))
    const result = spreadRumor(blackboard, "r1", "a", "b", "转述")
    expect(result).toEqual({ newRumor: null, targetBelieved: false })
  })
})
