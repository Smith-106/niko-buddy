import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type {
  ExtractionResult,
  NovelAgent,
  RumorEvent,
  StoryFramework,
  StoryNode,
  TimelineEvent,
} from "./types"
import {
  buildAgents,
  getVisibleEvents,
  formatTimelineEvent,
  buildAgentContext,
} from "./agent-profile-builder"

const mockLlmConfigUnused: LlmConfig | null = null
void mockLlmConfigUnused

function makeAura(overrides: Record<string, string | undefined> = {}) {
  return {
    id: "aura_1",
    builtIn: false,
    name: "测试光环",
    sourceNote: "test",
    corpus: "corpus",
    styleDescription: "冷峻",
    behaviorRules: "行事果断",
    boundaries: "不滥杀",
    notes: "备注",
    ...overrides,
  }
}

function makeCharacter(overrides: Record<string, unknown> = {}) {
  return {
    id: "char_1",
    name: "张三",
    profile: "宗门弟子",
    aura: null,
    cognition: { knows: ["入门考核通过"], doesNotKnow: ["长老的阴谋"] },
    soul: "勇敢",
    skillContent: "",
    ...overrides,
  }
}

function makeFramework(overrides: Record<string, unknown> = {}): StoryFramework {
  return {
    id: "fw_1",
    title: "测试框架",
    premise: "一个修仙世界",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 1,
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "初入宗门",
        coreConflict: "身份危机",
        involvedCharacters: ["张三"],
        goal: "拜入宗门",
        causeFromPrev: "",
        expectedOutcome: "通过考验",
      },
    ],
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeExtraction(characters: ReturnType<typeof makeCharacter>[]): ExtractionResult {
  return {
    characters: characters as ExtractionResult["characters"],
    chapterContents: [],
    memoryData: {
      characterStates: "",
      characterCognition: null,
      foreshadowingTracker: null,
      timeline: [],
      canonFacts: "",
      conflicts: "",
    },
    worldRules: "",
    powerSystem: "",
    foreshadowing: null,
    timeline: [],
    outlineContent: "",
    soulDoc: "",
  }
}

function makeAgent(overrides: Partial<NovelAgent> = {}): NovelAgent {
  return {
    characterId: "char_1",
    name: "张三",
    profile: "宗门弟子",
    aura: null,
    cognition: { knows: ["入门考核通过"], doesNotKnow: ["长老的阴谋"] },
    soul: "勇敢之魂",
    currentGoal: "拜入宗门",
    emotionalState: "neutral",
    knownFacts: new Set(["入门考核通过"]),
    relationships: new Map(),
    powerLevel: "",
    memory: {
      observedEvents: [],
      knownSecrets: new Set<string>(),
      sentiments: new Map<string, number>(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: ["入门考核通过"],
    personality: ["勇敢"],
    speakingStyle: "直率",
    ...overrides,
  }
}

function makeNode(overrides: Partial<StoryNode> = {}): StoryNode {
  return {
    index: 0,
    phase: "起",
    title: "初入宗门",
    coreConflict: "主角面临身份危机",
    involvedCharacters: ["张三", "李四"],
    goal: "拜入宗门",
    causeFromPrev: "山下来信",
    expectedOutcome: "通过考验",
    ...overrides,
  }
}

function makeTimelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt_1",
    round: 0,
    nodeIndex: 0,
    actorId: "char_1",
    actorName: "张三",
    actionType: "speak",
    content: "我来了",
    observableBy: ["char_1", "char_2"],
    impacts: [],
    timestamp: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeRumor(overrides: Partial<RumorEvent> = {}): RumorEvent {
  return {
    id: "rumor_1",
    round: 1,
    nodeIndex: 0,
    sourceId: null,
    content: "长老私通外敌",
    distortion: 0.23,
    observableBy: ["char_1"],
    believedBy: [],
    verifiedBy: [],
    timestamp: "2024-01-01T00:00:00.000Z",
    generation: 0,
    ...overrides,
  }
}

// ── buildAgents ──

describe("buildAgents", () => {
  it("框架指定角色时只构建涉及角色（保持提取顺序，未提及的排除）", () => {
    const extraction = makeExtraction([
      makeCharacter({ id: "char_1", name: "张三" }),
      makeCharacter({ id: "char_2", name: "李四" }),
      makeCharacter({ id: "char_3", name: "王五" }),
      makeCharacter({ id: "char_4", name: "赵六" }),
    ])
    const framework = makeFramework({
      nodes: [
        { ...makeNode(), involvedCharacters: ["李四", "张三"] },
        { ...makeNode(), index: 1, involvedCharacters: ["李四", "王五", "李四"] },
      ],
    })
    const agents = buildAgents(extraction, framework)
    // filter 保持 extraction 顺序；重复提及去重；赵六未被提及被排除
    expect(agents.map((a) => a.name)).toEqual(["张三", "李四", "王五"])
  })

  it("框架未指定角色时使用全部提取角色", () => {
    const extraction = makeExtraction([
      makeCharacter({ id: "char_1", name: "张三" }),
      makeCharacter({ id: "char_2", name: "李四" }),
    ])
    const framework = makeFramework({
      nodes: [{ ...makeNode(), involvedCharacters: [] }],
    })
    const agents = buildAgents(extraction, framework)
    expect(agents.map((a) => a.name)).toEqual(["张三", "李四"])
  })

  it("currentGoal 取第一个涉及该角色节点的 goal，无节点时用 premise 兜底", () => {
    const extraction = makeExtraction([makeCharacter({ id: "char_9", name: "赵六" })])
    const framework = makeFramework({
      premise: "天下大乱",
      nodes: [{ ...makeNode(), involvedCharacters: ["别人"] }],
    })
    const agents = buildAgents(extraction, framework)
    // 赵六未被框架节点涉及 → 框架 nodes 非空但无匹配 → premise 兜底
    // 注意：框架指定了角色名"别人"，选中角色为空
    expect(agents).toHaveLength(0)

    const framework2 = makeFramework({
      premise: "天下大乱",
      nodes: [{ ...makeNode(), involvedCharacters: [] }],
    })
    const agents2 = buildAgents(extraction, framework2)
    expect(agents2).toHaveLength(1)
    expect(agents2[0].currentGoal).toBe("天下大乱")
  })

  it("premise 为空时 currentGoal 兜底为待定", () => {
    const extraction = makeExtraction([makeCharacter({ id: "char_1", name: "张三" })])
    const framework = makeFramework({
      premise: "",
      nodes: [{ ...makeNode(), involvedCharacters: [] }],
    })
    const agents = buildAgents(extraction, framework)
    expect(agents[0].currentGoal).toBe("待定")
  })

  it("命中节点的角色取该节点 goal", () => {
    const extraction = makeExtraction([makeCharacter({ id: "char_1", name: "张三" })])
    const agents = buildAgents(extraction, makeFramework())
    expect(agents[0].currentGoal).toBe("拜入宗门")
  })

  it("personality 从 soul 按标点切分：超长丢弃、去重、最多 8 个", () => {
    const extraction = makeExtraction([
      makeCharacter({
        soul: "勇敢。嫉恶如仇，勇敢、重情重义\n光明磊落；这是一个超过十二个字的超长句子应该被丢弃",
        aura: makeAura({
          styleDescription: "冷峻，寡言",
          behaviorRules: "勇敢，行事果断",
          mentalModel: "以天下为己任",
        }),
      }),
    ])
    const agents = buildAgents(extraction, makeFramework())
    const p = agents[0].personality
    // soul 切出 5 段（超长句丢弃）+ aura 补充，去重"勇敢"，总量截断 8
    expect(p).toContain("勇敢")
    expect(p).toContain("嫉恶如仇")
    expect(p).toContain("冷峻")
    expect(p.filter((x) => x === "勇敢")).toHaveLength(1)
    expect(p.length).toBeLessThanOrEqual(8)
    expect(p.every((x) => x.length <= 12)).toBe(true)
  })

  it("soul 为空且 aura 为 null 时 personality 为空数组", () => {
    const extraction = makeExtraction([
      makeCharacter({ soul: "", aura: null, cognition: null }),
    ])
    const agents = buildAgents(extraction, makeFramework())
    expect(agents[0].personality).toEqual([])
    expect(agents[0].speakingStyle).toBe("")
    expect(agents[0].knowledgeScope).toEqual([])
  })

  it("speakingStyle 拼接 expressionDna 与 styleDescription", () => {
    const extraction = makeExtraction([
      makeCharacter({
        aura: makeAura({ expressionDna: "短促有力", styleDescription: "惜字如金" }),
      }),
    ])
    const agents = buildAgents(extraction, makeFramework())
    expect(agents[0].speakingStyle).toBe("短促有力；惜字如金")
  })

  it("speakingStyle 缺失时用 soul 前 100 字兜底", () => {
    const soul = "x".repeat(150)
    const extraction = makeExtraction([
      makeCharacter({ soul, aura: makeAura({ expressionDna: undefined, styleDescription: "" }) }),
    ])
    // expressionDna undefined + styleDescription 空 → 走 soul 兜底
    const agents = buildAgents(extraction, makeFramework())
    expect(agents[0].speakingStyle).toBe("x".repeat(100))
  })

  it("speakingStyle 超长截断到 300 字", () => {
    const extraction = makeExtraction([
      makeCharacter({
        aura: makeAura({ expressionDna: "y".repeat(200), styleDescription: "z".repeat(200) }),
      }),
    ])
    const agents = buildAgents(extraction, makeFramework())
    expect(agents[0].speakingStyle.length).toBe(300)
    expect(agents[0].speakingStyle.startsWith("y".repeat(200))).toBe(true)
  })

  it("memory 与 relationships 初始化正确", () => {
    const extraction = makeExtraction([
      makeCharacter({ id: "char_1", name: "张三" }),
      makeCharacter({ id: "char_2", name: "李四" }),
    ])
    const framework = makeFramework({
      nodes: [{ ...makeNode(), involvedCharacters: ["张三", "李四"] }],
    })
    const agents = buildAgents(extraction, framework)
    const a = agents[0]
    expect(a.memory.sentiments.get("char_1")).toBe(0)
    expect(a.memory.sentiments.get("char_2")).toBe(0)
    expect(a.memory.rumorCredibility).toBe(0.5)
    expect(a.relationships.has("char_1")).toBe(false)
    expect(a.relationships.get("char_2")).toEqual({
      targetId: "char_2",
      relationType: "neutral",
      sentiment: 0,
    })
    expect(a.emotionalState).toBe("neutral")
    expect(a.powerLevel).toBe("")
    expect([...a.knownFacts]).toEqual(["入门考核通过"])
  })
})

// ── getVisibleEvents ──

describe("getVisibleEvents", () => {
  it("只返回 observableBy 包含该 agent 的事件", () => {
    const events = [
      makeTimelineEvent({ id: "e1", observableBy: ["char_1"] }),
      makeTimelineEvent({ id: "e2", observableBy: ["char_2"] }),
      makeTimelineEvent({ id: "e3", observableBy: ["char_1", "char_2"] }),
    ]
    const visible = getVisibleEvents("char_1", events)
    expect(visible.map((e) => e.id)).toEqual(["e1", "e3"])
  })

  it("limit 截断为最后 N 条", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeTimelineEvent({ id: `e${i}`, observableBy: ["char_1"] }),
    )
    expect(getVisibleEvents("char_1", events, 2).map((e) => e.id)).toEqual(["e3", "e4"])
  })

  it("默认返回最后 10 条", () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      makeTimelineEvent({ id: `e${i}`, observableBy: ["char_1"] }),
    )
    const visible = getVisibleEvents("char_1", events)
    expect(visible).toHaveLength(10)
    expect(visible[0].id).toBe("e2")
    expect(visible[9].id).toBe("e11")
  })

  it("无可见事件返回空数组", () => {
    expect(getVisibleEvents("char_9", [makeTimelineEvent()])).toEqual([])
  })
})

// ── formatTimelineEvent ──

describe("formatTimelineEvent", () => {
  it("公开事件（>2 可见者）带目标名与轮次", () => {
    const text = formatTimelineEvent(
      makeTimelineEvent({
        round: 2,
        actorName: "张三",
        targetName: "李四",
        actionType: "confront",
        content: "拔剑相向",
        observableBy: ["char_1", "char_2", "char_3"],
      }),
    )
    expect(text).toBe("第3轮 [公开] 张三 → 李四 [confront]：拔剑相向")
  })

  it("双人可见标记为私聊且无目标名时不带箭头", () => {
    const text = formatTimelineEvent(
      makeTimelineEvent({ actorName: "张三", observableBy: ["char_1", "char_2"] }),
    )
    expect(text).toContain("[私聊]")
    expect(text).not.toContain("→")
  })

  it("单人可见标记为内心", () => {
    const text = formatTimelineEvent(
      makeTimelineEvent({ observableBy: ["char_1"] }),
    )
    expect(text).toContain("[内心]")
  })
})

// ── buildAgentContext ──

describe("buildAgentContext", () => {
  it("场景节包含节点信息，缺失可选字段时不输出对应行", () => {
    const full = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(full).toContain("节点 0（起）：初入宗门")
    expect(full).toContain("核心冲突：主角面临身份危机")
    expect(full).toContain("本节点目标：拜入宗门")
    expect(full).toContain("承前原因：山下来信")
    expect(full).toContain("预期结果：通过考验")
    expect(full).toContain("涉及角色：张三、李四")

    const bare = buildAgentContext(
      makeAgent(),
      makeNode({ causeFromPrev: "", expectedOutcome: "", involvedCharacters: [] }),
      [],
      "",
    )
    expect(bare).not.toContain("承前原因")
    expect(bare).not.toContain("预期结果")
    expect(bare).not.toContain("涉及角色")
  })

  it("身份节按有无输出档案灵魂性格风格", () => {
    const full = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(full).toContain("档案：宗门弟子")
    expect(full).toContain("灵魂：勇敢之魂")
    expect(full).toContain("性格关键词：勇敢")
    expect(full).toContain("说话风格：直率")

    const bare = buildAgentContext(
      makeAgent({ profile: "", soul: "", personality: [], speakingStyle: "" }),
      makeNode(),
      [],
      "",
    )
    expect(bare).not.toContain("档案：")
    expect(bare).not.toContain("灵魂：")
    expect(bare).not.toContain("性格关键词")
    expect(bare).not.toContain("说话风格")
  })

  it("aura 为 null 时无光环节；空字段被跳过", () => {
    const noAura = buildAgentContext(makeAgent({ aura: null }), makeNode(), [], "")
    expect(noAura).not.toContain("角色光环")

    const withAura = buildAgentContext(
      makeAgent({
        aura: {
          ...makeAura(),
          boundaries: "",
          notes: undefined as unknown as string,
          decisionHeuristics: "先观察后行动",
        } as unknown as NovelAgent["aura"],
      }),
      makeNode(),
      [],
      "",
    )
    expect(withAura).toContain("【角色光环】")
    expect(withAura).toContain("风格描述：冷峻")
    expect(withAura).toContain("决策启发式：先观察后行动")
    expect(withAura).not.toContain("边界：")
    expect(withAura).not.toContain("备注：")
  })

  it("认知边界节：有无 knows/doesNotKnow 的输出差异，提醒行恒在", () => {
    const full = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(full).toContain("你知道的信息：入门考核通过")
    expect(full).toContain("你不知道的信息：长老的阴谋")
    expect(full).toContain("绝不能表现出全知视角")

    const empty = buildAgentContext(
      makeAgent({ knowledgeScope: [], cognition: null }),
      makeNode(),
      [],
      "",
    )
    expect(empty).not.toContain("你知道的信息：")
    expect(empty).not.toContain("你不知道的信息：")
    expect(empty).toContain("绝不能表现出全知视角")
  })

  it("当前状态节输出目标与情绪", () => {
    const text = buildAgentContext(
      makeAgent({ currentGoal: "复仇", emotionalState: "愤怒" }),
      makeNode(),
      [],
      "",
    )
    expect(text).toContain("当前目标：复仇")
    expect(text).toContain("情绪状态：愤怒")
  })

  it("情感节：空 sentiments 时无该节；跳过自己；按映射表显示名称", () => {
    const empty = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(empty).not.toContain("你对其他角色的情感")

    const agent = makeAgent({
      characterId: "char_1",
      memory: {
        observedEvents: [],
        knownSecrets: new Set<string>(),
        sentiments: new Map([
          ["char_1", 999],
          ["char_2", 10],
          ["char_3", -5],
        ]),
        recentDecisions: [],
        rumorCredibility: 0.5,
      },
    })
    const nameById = new Map([["char_2", "李四"]])
    const text = buildAgentContext(agent, makeNode(), [], "", undefined, undefined, nameById)
    expect(text).toContain("【你对其他角色的情感】")
    expect(text).toContain("对角色[李四]（char_2）：好感度 10")
    expect(text).toContain("对角色[char_3]：好感度 -5")
    expect(text).not.toContain("999")
  })

  it("近期事件有无的输出差异", () => {
    const withEvents = buildAgentContext(makeAgent(), makeNode(), ["长老现身"], "")
    expect(withEvents).toContain("【近期事件】")
    expect(withEvents).toContain("- 长老现身")

    const without = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(without).not.toContain("【近期事件】")
  })

  it("可见时间线事件有无的输出差异", () => {
    const ev = makeTimelineEvent({ round: 1, observableBy: ["char_1", "char_2", "char_3"] })
    const withVisible = buildAgentContext(makeAgent(), makeNode(), [], "", [ev])
    expect(withVisible).toContain("【你观察到的最近事件】")
    expect(withVisible).toContain("第2轮 [公开]")

    const without = buildAgentContext(makeAgent(), makeNode(), [], "", [])
    expect(without).not.toContain("【你观察到的最近事件】")
  })

  it("传闻节带提醒与失真度百分比", () => {
    const withRumor = buildAgentContext(makeAgent(), makeNode(), [], "", undefined, [makeRumor()])
    expect(withRumor).toContain("【你听到的传闻】")
    expect(withRumor).toContain("可信度低，可能失真")
    expect(withRumor).toContain("第2轮 [传闻（可信度低，可能失真）] 长老私通外敌（失真度约23%）")

    const without = buildAgentContext(makeAgent(), makeNode(), [], "", undefined, [])
    expect(without).not.toContain("【你听到的传闻】")
  })

  it("世界规则有无的输出差异", () => {
    const withRules = buildAgentContext(makeAgent(), makeNode(), [], "杀人偿命")
    expect(withRules).toContain("【世界规则】")
    expect(withRules).toContain("杀人偿命")

    const without = buildAgentContext(makeAgent(), makeNode(), [], "")
    expect(without).not.toContain("【世界规则】")
  })

  it("doesNotKnow 为空数组时不输出不知道行", () => {
    const text = buildAgentContext(
      makeAgent({
        knowledgeScope: ["a"],
        cognition: { knows: ["a"], doesNotKnow: [] },
      }),
      makeNode(),
      [],
      "",
    )
    expect(text).toContain("你知道的信息：a")
    expect(text).not.toContain("你不知道的信息：")
  })
})
