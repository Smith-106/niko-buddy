/**
 * simulation-event-pipeline 真实行为测试（新建）。
 * 覆盖：cloneAgent 深拷贝/nextEventId 唯一/resolveTarget/
 * determineObservableBy/computeImpacts/applyEventToMemory/
 * createTimelineEvent/timelineEventToSimulationEvent/
 * formatActionDescription 全分支/filterRecentDescsForAgent。
 * 纯逻辑，无文件与 LLM 操作。
 */
import { describe, expect, it } from "vitest"
import type {
  AgentAction,
  NovelAgent,
  SimulationState,
  StoryNode,
  TimelineEvent,
} from "./types"
import {
  applyEventToMemory,
  cloneAgent,
  computeImpacts,
  createTimelineEvent,
  determineObservableBy,
  filterRecentDescsForAgent,
  formatActionDescription,
  nextEventId,
  resolveTarget,
  timelineEventToSimulationEvent,
  type ParsedAction,
} from "./simulation-event-pipeline"

function agent(id: string, name: string): NovelAgent {
  return {
    characterId: id,
    name,
    profile: `${name}档案`,
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "目标",
    emotionalState: "neutral",
    knownFacts: new Set([`${id}-fact`]),
    relationships: new Map([
      [`other-${id}`, { targetId: `other-${id}`, relationType: "neutral", sentiment: 0 }],
    ]),
    powerLevel: "normal",
    memory: {
      observedEvents: [],
      knownSecrets: new Set(),
      sentiments: new Map([[`other-${id}`, 5]]),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [`scope-${id}`],
    personality: ["勇敢"],
    speakingStyle: "直率",
  }
}

function agentsMap(): Map<string, NovelAgent> {
  return new Map([
    ["a", agent("a", "甲")],
    ["b", agent("b", "乙")],
  ])
}

function parsed(
  type: AgentAction["type"],
  visibility: ParsedAction["visibility"] = "all",
): ParsedAction {
  return {
    action: { type, content: "做点什么", target: "乙", visibility },
    motivation: "动机",
    plotPush: "推动",
    visibility,
  }
}

function tlEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt-1",
    round: 2,
    nodeIndex: 1,
    actorId: "a",
    actorName: "甲",
    actionType: "speak",
    content: "你好世界这是一段比较长的内容文本",
    observableBy: ["a", "b"],
    impacts: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function node(): StoryNode {
  return {
    index: 1,
    phase: "承",
    title: "转折",
    coreConflict: "冲突",
    involvedCharacters: ["甲"],
    goal: "转折",
    causeFromPrev: "前缘",
    expectedOutcome: "抉择",
  }
}

describe("cloneAgent", () => {
  it("深拷贝可变集合且与原对象隔离", () => {
    const src = agent("a", "甲")
    const copy = cloneAgent(src)
    expect(copy).not.toBe(src)
    expect(copy.name).toBe("甲")
    expect(copy.knownFacts).toEqual(src.knownFacts)
    expect(copy.knownFacts).not.toBe(src.knownFacts)
    expect(copy.relationships).not.toBe(src.relationships)
    expect(copy.memory.observedEvents).not.toBe(src.memory.observedEvents)
    expect(copy.memory.knownSecrets).not.toBe(src.memory.knownSecrets)
    expect(copy.memory.sentiments).not.toBe(src.memory.sentiments)
    expect(copy.memory.recentDecisions).not.toBe(src.memory.recentDecisions)
    expect(copy.knowledgeScope).not.toBe(src.knowledgeScope)
    expect(copy.personality).not.toBe(src.personality)

    copy.knownFacts.add("new")
    copy.memory.sentiments.set("x", 99)
    copy.relationships.get("other-a")!.sentiment = 99
    expect(src.knownFacts.has("new")).toBe(false)
    expect(src.memory.sentiments.has("x")).toBe(false)
    expect(src.relationships.get("other-a")!.sentiment).toBe(0)
  })
})

describe("nextEventId", () => {
  it("生成 evt_ 前缀的唯一 id", () => {
    const ids = new Set([nextEventId(), nextEventId(), nextEventId()])
    expect(ids.size).toBe(3)
    for (const id of ids) expect(id.startsWith("evt_")).toBe(true)
  })
})

describe("resolveTarget", () => {
  it("按名字与按 id 都能命中，缺省与miss返回 undefined", () => {
    const map = agentsMap()
    expect(resolveTarget("乙", map)?.characterId).toBe("b")
    expect(resolveTarget("b", map)?.characterId).toBe("b")
    expect(resolveTarget(undefined, map)).toBeUndefined()
    expect(resolveTarget("丙", map)).toBeUndefined()
  })
})

describe("determineObservableBy", () => {
  it("self 仅自己可见", () => {
    const map = agentsMap()
    expect(determineObservableBy(map.get("a")!, undefined, "self", map)).toEqual(["a"])
  })

  it("target_only 有目标时双方可见，无目标回退自己", () => {
    const map = agentsMap()
    expect(
      determineObservableBy(map.get("a")!, map.get("b"), "target_only", map),
    ).toEqual(["a", "b"])
    expect(
      determineObservableBy(map.get("a")!, undefined, "target_only", map),
    ).toEqual(["a"])
  })

  it("all 返回全体 id，未知可见性走默认分支", () => {
    const map = agentsMap()
    expect(determineObservableBy(map.get("a")!, map.get("b"), "all", map)).toEqual([
      "a",
      "b",
    ])
    expect(
      determineObservableBy(
        map.get("a")!,
        undefined,
        "weird" as unknown as ParsedAction["visibility"],
        map,
      ),
    ).toEqual(["a", "b"])
  })
})

describe("computeImpacts", () => {
  it("目标类行为产生对目标的影响", () => {
    const map = agentsMap()
    const a = map.get("a")!
    const b = map.get("b")!
    expect(computeImpacts(a, parsed("ally"), b)).toContainEqual({
      characterId: "b",
      type: "relationship",
      detail: "甲向乙示好结盟，好感度上升",
    })
    expect(computeImpacts(a, parsed("confront"), b)).toContainEqual({
      characterId: "b",
      type: "relationship",
      detail: "甲与乙对抗，好感度下降",
    })
    expect(computeImpacts(a, parsed("speak"), b)).toContainEqual({
      characterId: "b",
      type: "knowledge",
      detail: "乙听到了甲说的话",
    })
    expect(computeImpacts(a, parsed("react"), b)).toContainEqual({
      characterId: "b",
      type: "sentiment",
      detail: "甲对乙的行为做出了反应",
    })
  })

  it("自身类行为产生对自己的影响", () => {
    const map = agentsMap()
    const a = map.get("a")!
    const b = map.get("b")!
    expect(computeImpacts(a, parsed("investigate"), b)).toContainEqual({
      characterId: "a",
      type: "knowledge",
      detail: "甲获取了新信息",
    })
    expect(computeImpacts(a, parsed("observe"), b)).toContainEqual({
      characterId: "a",
      type: "knowledge",
      detail: "甲获取了新信息",
    })
    expect(computeImpacts(a, parsed("conceal"), b)).toContainEqual({
      characterId: "a",
      type: "knowledge",
      detail: "甲隐藏了某些信息",
    })
    expect(computeImpacts(a, parsed("evaluate"), b)).toContainEqual({
      characterId: "a",
      type: "sentiment",
      detail: "甲形成了看法/评价",
    })
  })

  it("无目标时不产生目标影响，公开行为追加 __all__ 影响", () => {
    const map = agentsMap()
    const a = map.get("a")!
    const silent = computeImpacts(a, parsed("ally", "self"), undefined)
    expect(silent.some((i) => i.characterId === "b")).toBe(false)
    expect(silent.some((i) => i.characterId === "__all__")).toBe(false)

    const pub = computeImpacts(a, parsed("speak", "all"), undefined)
    expect(pub).toContainEqual({
      characterId: "__all__",
      type: "knowledge",
      detail: "所有人都观察到了甲的公开行为",
    })
  })
})

describe("applyEventToMemory", () => {
  it("记录观察事件并去重写入知识", () => {
    const a = agent("a", "甲")
    const ev = tlEvent({
      impacts: [
        { characterId: "a", type: "knowledge", detail: "新知识" },
        { characterId: "a", type: "knowledge", detail: "新知识" },
        { characterId: "b", type: "knowledge", detail: "与己无关" },
      ],
    })
    applyEventToMemory(a, ev)
    expect(a.memory.observedEvents).toEqual(["evt-1"])
    expect(a.knowledgeScope.filter((k) => k === "新知识")).toHaveLength(1)
    expect(a.knowledgeScope).not.toContain("与己无关")
  })

  it("__all__ 影响同样作用于自己", () => {
    const a = agent("a", "甲")
    applyEventToMemory(
      a,
      tlEvent({ impacts: [{ characterId: "__all__", type: "knowledge", detail: "公开知识" }] }),
    )
    expect(a.knowledgeScope).toContain("公开知识")
  })

  it("正面情感影响切换 emotionalState", () => {
    const a = agent("a", "甲")
    applyEventToMemory(
      a,
      tlEvent({ impacts: [{ characterId: "a", type: "sentiment", detail: "感到正面鼓舞" }] }),
    )
    expect(a.emotionalState).toBe("positive")
  })

  it("非正面情感不改变 emotionalState", () => {
    const a = agent("a", "甲")
    applyEventToMemory(
      a,
      tlEvent({ impacts: [{ characterId: "a", type: "sentiment", detail: "感到低落" }] }),
    )
    expect(a.emotionalState).toBe("neutral")
  })

  it("关系影响调整好感并钳制在 ±100", () => {
    const a = agent("a", "甲")
    a.memory.sentiments.set("b", 95)
    a.relationships.set("b", { targetId: "b", relationType: "neutral", sentiment: 95 })
    applyEventToMemory(
      a,
      tlEvent({
        targetId: "b",
        impacts: [{ characterId: "a", type: "relationship", detail: "甲与乙结盟上升" }],
      }),
    )
    expect(a.memory.sentiments.get("b")).toBe(100)
    expect(a.relationships.get("b")).toMatchObject({ sentiment: 100, relationType: "ally" })

    const c = agent("c", "丙")
    c.memory.sentiments.set("b", -95)
    applyEventToMemory(
      c,
      tlEvent({
        actorId: "c",
        targetId: "b",
        impacts: [{ characterId: "c", type: "relationship", detail: "对抗冲突下降" }],
      }),
    )
    expect(c.memory.sentiments.get("b")).toBe(-100)
  })

  it("仅发起者记录最近决策并截断保留 20 条", () => {
    const a = agent("a", "甲")
    a.memory.recentDecisions = Array.from({ length: 20 }, (_, i) => `old-${i}`)
    const other = agent("b", "乙")
    const ev = tlEvent({ content: "这是一次重要的公开演讲内容文本超长需要截断处理" })
    applyEventToMemory(a, ev)
    applyEventToMemory(other, ev)
    expect(a.memory.recentDecisions).toHaveLength(20)
    expect(a.memory.recentDecisions[0]).toBe("old-1")
    expect(a.memory.recentDecisions[19]).toContain("[R3] speak:")
    expect(other.memory.recentDecisions).toHaveLength(0)
  })
})

describe("createTimelineEvent", () => {
  it("组装时间线事件字段", () => {
    const map = agentsMap()
    const ev = createTimelineEvent(map.get("a")!, parsed("speak", "all"), map.get("b"), 2, 1, map)
    expect(ev.round).toBe(2)
    expect(ev.nodeIndex).toBe(1)
    expect(ev.actorId).toBe("a")
    expect(ev.actorName).toBe("甲")
    expect(ev.actionType).toBe("speak")
    expect(ev.targetId).toBe("b")
    expect(ev.targetName).toBe("乙")
    expect(ev.observableBy).toEqual(["a", "b"])
    expect(ev.impacts.length).toBeGreaterThan(0)
    expect(typeof ev.timestamp).toBe("string")
  })
})

describe("timelineEventToSimulationEvent", () => {
  it("聚合动机/剧情推动/影响并排除 __all__", () => {
    const map = agentsMap()
    const tl = tlEvent({
      impacts: [
        { characterId: "b", type: "knowledge", detail: "乙听到了甲说的话" },
        { characterId: "__all__", type: "knowledge", detail: "公开" },
      ],
    })
    const out = timelineEventToSimulationEvent(tl, map.get("a")!, parsed("speak"), node(), 2)
    expect(out.type).toBe("agent-action")
    expect(out.round).toBe(2)
    expect(out.node).toEqual(node())
    expect(out.stateChanges).toContain("动机：动机")
    expect(out.stateChanges).toContain("剧情推动：推动")
    expect(out.stateChanges).not.toContain("公开")
    expect(out.action).toMatchObject({
      type: "speak",
      content: "做点什么",
      target: "乙",
      motivation: "动机",
      plot_push: "推动",
    })
    expect(out.timelineEvent).toEqual(tl)
    // agent 为深拷贝而非原引用
    expect(out.agent).not.toBe(map.get("a"))
    expect(out.agent!.name).toBe("甲")
  })

  it("无动机与推动时只保留目标影响", () => {
    const map = agentsMap()
    const p: ParsedAction = {
      action: { type: "observe", content: "观察", visibility: "self" },
      motivation: "",
      plotPush: "",
      visibility: "self",
    }
    const tl = tlEvent({ impacts: [] })
    const out = timelineEventToSimulationEvent(tl, map.get("a")!, p, node(), 0)
    expect(out.stateChanges).toEqual([])
    expect(out.timelineEvent).toEqual(tl)
  })
})

describe("formatActionDescription", () => {
  const cases: Array<[AgentAction["type"], string | undefined, string]> = [
    ["speak", "乙", "甲 对 乙 说：「hi」"],
    ["speak", undefined, "甲 说：「hi」"],
    ["evaluate", undefined, "甲 心中评价：hi"],
    ["pushPlot", undefined, "甲 采取行动：hi"],
    ["observe", undefined, "甲 观察到：hi"],
    ["react", "乙", "甲 对 乙 的反应：hi"],
    ["react", undefined, "甲 做出反应：hi"],
    ["ally", "乙", "甲 向 乙 示好结盟：hi"],
    ["ally", undefined, "甲 寻求合作：hi"],
    ["confront", "乙", "甲 与 乙 对抗：hi"],
    ["confront", undefined, "甲 采取对抗姿态：hi"],
    ["conceal", undefined, "甲 隐瞒了内心想法：hi"],
    ["investigate", undefined, "甲 调查：hi"],
    ["act", undefined, "甲 行动：hi"],
    ["decide", undefined, "甲 做出决定：hi"],
    ["conflict", "乙", "甲 与 乙 发生冲突：hi"],
    ["conflict", undefined, "甲 冲突：hi"],
    ["cooperate", "乙", "甲 与 乙 合作：hi"],
    ["cooperate", undefined, "甲 合作：hi"],
    ["withhold", undefined, "甲 隐瞒信息：hi"],
  ]
  it.each(cases)("%s target=%s", (type, target, expected) => {
    expect(
      formatActionDescription({ type, content: "hi", target }, "甲"),
    ).toBe(expected)
  })

  it("未知类型走默认分支", () => {
    expect(
      formatActionDescription(
        { type: "mystery" as unknown as AgentAction["type"], content: "hi" },
        "甲",
      ),
    ).toBe("甲：hi")
  })
})

describe("filterRecentDescsForAgent", () => {
  function filteringState(): { state: SimulationState; visible: Set<string> } {
    const ev1 = tlEvent({ id: "e1", actorName: "甲", observableBy: ["a", "b"] })
    const ev2 = tlEvent({
      id: "e2",
      actorName: "乙",
      content: "乙的秘密计划内容文本很长很长",
      observableBy: ["b"],
    })
    const state: SimulationState = {
      currentRound: 2,
      timelineEvents: [ev1, ev2],
      activeAgents: agentsMap(),
      worldState: {},
      directorEnabled: false,
      nextNodeInjectionMap: new Map(),
    }
    return { state, visible: new Set(["e1"]) }
  }

  it("系统事件保留，可见事件保留，不可见与查无此事丢弃", () => {
    const { state, visible } = filteringState()
    const sys = "[系统事件] 全场广播"
    const vis = `旁白 甲：你好世界这是一段比较长的内容文本`
    const invis = `旁白 乙：乙的秘密计划内容文本很长`
    const unknown = "旁白 丙：查无此人的闲聊"
    const out = filterRecentDescsForAgent([sys, vis, invis, unknown], state, visible, "a")
    expect(out).toContain(sys)
    expect(out).toContain(vis)
    expect(out).not.toContain(invis)
    expect(out).not.toContain(unknown)
  })

  it("无参与者名但内容命中可见事件时经回退保留", () => {
    const { state, visible } = filteringState()
    // 不含 actorName，但包含内容前 24 字 → 首轮查找失败，回退命中
    const desc = `转述：你好世界这是一段比较长的内容文本`
    expect(filterRecentDescsForAgent([desc], state, visible, "a")).toEqual([desc])
  })
})

describe("applyEventToMemory 关系分支补齐", () => {
  function relEvent(detail: string, withTarget = true): TimelineEvent {
    return tlEvent({
      ...(withTarget ? { targetId: "b" } : { targetId: undefined }),
      impacts: [{ characterId: "a", type: "relationship", detail }],
    })
  }

  it.each([
    ["好感度上升", 10],
    ["双方结盟", 10],
    ["向对方示好", 10],
    ["好感度下降", -10],
    ["双方公开对抗", -10],
    ["爆发冲突", -10],
  ])("单关键词 %s 触发对应方向", (detail, expected) => {
    const a = agent("a", "甲")
    a.memory.sentiments.set("b", 0)
    applyEventToMemory(a, relEvent(detail))
    expect(a.memory.sentiments.get("b")).toBe(expected)
  })

  it("无 sentiments 旧值时从 0 起算", () => {
    const fresh = agent("a", "甲")
    fresh.memory.sentiments.clear()
    applyEventToMemory(fresh, relEvent("好感度上升"))
    expect(fresh.memory.sentiments.get("b")).toBe(10)
  })

  it("下降时同步旧 relationType 为 hostile", () => {
    const a = agent("a", "甲")
    a.memory.sentiments.set("b", 20)
    a.relationships.set("b", { targetId: "b", relationType: "ally", sentiment: 20 })
    applyEventToMemory(a, relEvent("好感度下降"))
    expect(a.memory.sentiments.get("b")).toBe(10)
    expect(a.relationships.get("b")).toMatchObject({ sentiment: 10, relationType: "hostile" })
  })

  it("无关键词时 delta 为 0 并保留原 relationType", () => {
    const a = agent("a", "甲")
    a.memory.sentiments.set("b", 7)
    a.relationships.set("b", { targetId: "b", relationType: "neutral", sentiment: 7 })
    applyEventToMemory(a, relEvent("关系如常"))
    expect(a.memory.sentiments.get("b")).toBe(7)
    expect(a.relationships.get("b")).toMatchObject({ sentiment: 7, relationType: "neutral" })
  })

  it("无 targetId 的关系影响被整体跳过", () => {
    const a = agent("a", "甲")
    a.memory.sentiments.set("b", 7)
    applyEventToMemory(a, relEvent("好感度上升", false))
    expect(a.memory.sentiments.get("b")).toBe(7)
  })
})

describe("filterRecentDescsForAgent 可见性回退", () => {
  it("visible 集未收录但 observableBy 包含自己时保留", () => {
    const ev = tlEvent({ id: "e9", actorName: "甲", observableBy: ["a"] })
    const state: SimulationState = {
      currentRound: 2,
      timelineEvents: [ev],
      activeAgents: agentsMap(),
      worldState: {},
      directorEnabled: false,
      nextNodeInjectionMap: new Map(),
    }
    const desc = `转述 甲：你好世界这是一段比较长的内容文本`
    // content 前 24 字命中，首轮 actorName 查找同样命中；关键是 visible 集为空
    expect(filterRecentDescsForAgent([desc], state, new Set(), "a")).toEqual([desc])
  })
})
