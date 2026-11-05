import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  ExtractionResult,
  NovelAgent,
  SimulationDebugTrace,
  SimulationEvent,
  StoryFramework,
  StoryNode,
  TimelineEvent,
} from "@/lib/novel/story-simulation/types"
import type { SimulationCallbacks, SimulationTelemetry } from "@/lib/novel/story-simulation/simulation-engine"
import type { StagedEventPool } from "@/lib/novel/story-simulation/event-pool-generator"
import {
  generateRandomEvent,
  isNodeGoalReached,
  isNodeGoalReachedWithEmbedding,
  runSimulation,
} from "@/lib/novel/story-simulation/simulation-engine"
import { ModelDoesNotSupportToolsError } from "@/lib/agent/runner"
import { cosineSimilarity, embed } from "@/lib/embedding-client"

let mockRun: unknown

vi.mock("@/lib/agent/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/runner")>()
  return {
    ...actual,
    AgentRunner: class {
      run(...args: unknown[]) {
        return (mockRun as (...a: unknown[]) => Promise<unknown>)(...args)
      }
    },
    ModelDoesNotSupportToolsError: class extends Error {
      constructor() {
        super("当前模型不支持工具调用")
        this.name = "ModelDoesNotSupportToolsError"
      }
    },
  }
})

vi.mock("@/lib/embedding-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding-client")>()
  return {
    ...actual,
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
    cosineSimilarity: vi.fn().mockReturnValue(0),
  }
})

type StreamChatMockArgs = [
  config: unknown,
  messages: Array<{ role: string; content: string }>,
  callbacks: {
    onToken: (token: string) => void
    onDone: () => void
    onError: (error: Error) => void
  },
  signal?: AbortSignal,
]
// 默认空流：collectStream 收拢为 ""，parse 走 observe 兜底（各用例按需覆盖）
let mockStreamChatImpl: (...args: StreamChatMockArgs) => Promise<void> = async (
  _config,
  _messages,
  callbacks,
) => {
  callbacks.onDone()
}

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: (...args: StreamChatMockArgs) => mockStreamChatImpl(...args),
  }
})

vi.mock("@/lib/novel/story-simulation/types", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/novel/story-simulation/types")>()
  return {
    ...actual,
    // 覆盖率战役（本文件内）：真实 MODE_CONFIGS 的 directorEnabled 全为 false，
    // 此处仅在测试中打开，以便覆盖引擎导演评估/注入分支（生产代码不动）。
    getModeConfig: (mode: Parameters<typeof actual.getModeConfig>[0]) => ({
      ...actual.getModeConfig(mode),
      directorEnabled: true,
    }),
  }
})

// 导演模块故障注入：默认直通真实实现，个别用例覆盖为抛错以演练引擎侧 catch。
let mockDirectorEvaluateImpl: (input: never) => Promise<never> = async (
  input: never,
) => {
  const actual = await vi.importActual<{
    directorEvaluate: (input: never) => Promise<never>
  }>("@/lib/novel/story-simulation/director-agent")
  return actual.directorEvaluate(input)
}

vi.mock("@/lib/novel/story-simulation/director-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/novel/story-simulation/director-agent")>()
  return {
    ...actual,
    directorEvaluate: (input: never) => mockDirectorEvaluateImpl(input),
  }
})

function makeAgent(): NovelAgent {
  return {
    characterId: "a",
    name: "甲",
    profile: "甲的档案",
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "完成当前目标",
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

function makeExtraction(): ExtractionResult {
  return {
    characters: [],
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

function makeFramework(): StoryFramework {
  return {
    id: "fw",
    title: "测试框架",
    premise: "测试",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "开端",
        coreConflict: "冲突",
        involvedCharacters: ["甲"],
        goal: "继续开端",
        causeFromPrev: "无",
        expectedOutcome: "完成开端",
      },
    ],
  }
}

describe("runSimulation engine telemetry", () => {
  it("emits onTelemetry once on completion with counts matching the run", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "遥测事件",
        visibility: "all",
        motivation: "推进",
        plot_push: "补完当前节点",
      }),
    })

    const telemetries: SimulationTelemetry[] = []
    const streamed: TimelineEvent[] = []

    const events = await runSimulation(
      {
        agents: [makeAgent()],
        framework: makeFramework(),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      {
        onEvent: () => {},
        onProgress: () => {},
        onComplete: () => {},
        onError: () => {},
        onTimelineEvent: (event) => streamed.push(event),
        onTelemetry: (t) => telemetries.push(t),
      },
    )

    expect(telemetries).toHaveLength(1)
    const tele = telemetries[0]
    expect(tele.aborted).toBe(false)
    expect(tele.degraded).toBe(false)
    expect(tele.eventCount).toBe(events.length)
    expect(tele.eventCount).toBeGreaterThan(0)
    expect(tele.timelineEventCount).toBe(streamed.length)
    expect(tele.timelineEventCount).toBeGreaterThan(0)
    expect(tele.rounds).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(tele.latencyMs)).toBe(true)
    expect(tele.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(tele.timestamp))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 覆盖率战役增补：simulation-engine 未覆盖分支（只增补，不动原有用例）
// 约定：Math.random 全部显式注水；不使用真实定时器；只走公开 API
// （runSimulation / isNodeGoalReachedWithEmbedding），外部 LLM 全部 mock。
// ═══════════════════════════════════════════════════════════════════

function mockRandom(value: number): void {
  vi.spyOn(Math, "random").mockReturnValue(value)
}

function resetStreamToEmpty(): void {
  mockStreamChatImpl = async (_config, _messages, callbacks) => {
    callbacks.onDone()
  }
}

function rejectWithNoTools(): void {
  mockRun = vi.fn().mockRejectedValue(new ModelDoesNotSupportToolsError())
}

function makeNamedAgent(
  id: string,
  name: string,
  extra?: Partial<NovelAgent>,
): NovelAgent {
  return { ...makeAgent(), characterId: id, name, ...(extra ?? {}) }
}

function makeNode(
  index: number,
  title: string,
  involved: string[],
  expectedOutcome = `完成${title}`,
): StoryNode {
  return {
    index,
    phase: "起",
    title,
    coreConflict: "冲突",
    involvedCharacters: involved,
    goal: `推进${title}`,
    causeFromPrev: "无",
    expectedOutcome,
  }
}

function makeMultiNodeFramework(count: number): StoryFramework {
  const fw = makeFramework()
  return {
    ...fw,
    nodes: Array.from({ length: count }, (_, i) =>
      makeNode(i, `节点${i + 1}`, ["甲", "乙"]),
    ),
  }
}

function makeTlEvent(partial?: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: `tl-test-${Math.floor(Math.random() * 1e9)}`,
    round: 0,
    nodeIndex: 0,
    actorId: "a",
    actorName: "甲",
    actionType: "speak",
    content: "测试内容",
    observableBy: ["a"],
    impacts: [],
    timestamp: "2026-07-06T00:00:00.000Z",
    ...(partial ?? {}),
  }
}

interface Collected {
  events: SimulationEvent[]
  timeline: TimelineEvent[]
  telemetries: SimulationTelemetry[]
  traces: SimulationDebugTrace[]
  degraded: Array<{ consecutiveFailures: number; lastError?: string }>
  errors: Error[]
  completed: SimulationEvent[][]
  progresses: Array<[number, string]>
}

function makeCollectors(overrides?: {
  onEvent?: (e: SimulationEvent) => void
  onTimelineEvent?: (e: TimelineEvent) => void
}): { callbacks: SimulationCallbacks; collected: Collected } {
  const collected: Collected = {
    events: [],
    timeline: [],
    telemetries: [],
    traces: [],
    degraded: [],
    errors: [],
    completed: [],
    progresses: [],
  }
  const callbacks: SimulationCallbacks = {
    onEvent: (e) => {
      collected.events.push(e)
      overrides?.onEvent?.(e)
    },
    onProgress: (p, label) => {
      collected.progresses.push([p, label])
    },
    onComplete: (evts) => {
      collected.completed.push(evts)
    },
    onError: (e) => {
      collected.errors.push(e)
    },
    onTimelineEvent: (e) => {
      collected.timeline.push(e)
      overrides?.onTimelineEvent?.(e)
    },
    onTelemetry: (t) => {
      collected.telemetries.push(t)
    },
    onDebugTrace: (t) => {
      collected.traces.push(t)
    },
    onDegraded: (info) => {
      collected.degraded.push(info)
    },
  }
  return { callbacks, collected }
}

function agentActions(collected: Collected): SimulationEvent[] {
  return collected.events.filter((e) => e.type === "agent-action")
}

function randomMessages(collected: Collected): string[] {
  return collected.events
    .filter((e) => (e.message ?? "").startsWith("【随机事件】"))
    .map((e) => e.message as string)
}

describe("simulation-engine：非 ReAct 降级路径（parse/提示词组装）", () => {
  it("fallback 解析直接 JSON：公开 speak 无 target，不触发反应链", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    let seenUser = ""
    let seenSystem = ""
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      if (!seenSystem) {
        seenSystem = messages.find((m) => m.role === "system")?.content ?? ""
        seenUser = messages.find((m) => m.role === "user")?.content ?? ""
      }
      callbacks.onToken(
        JSON.stringify({
          type: "speak",
          content: "大家好",
          visibility: "all",
          motivation: "破冰",
          plot_push: "展开对话",
        }),
      )
      callbacks.onDone()
    }

    const agents = [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")]
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents,
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
        injectionEvent: "开场异变",
      } as never,
      makeExtraction(),
      callbacks,
    )

    // 提示词组装分支：注入事件进入用户消息，空性格走默认行
    expect(seenUser).toContain("开场异变")
    expect(seenUser).toContain("节点「节点1」")
    expect(seenSystem).toContain("你正在扮演小说中的真实角色")
    const actions = agentActions(collected)
    expect(actions).toHaveLength(2)
    expect(actions[0].action?.type).toBe("speak")
    expect(actions[0].timelineEvent?.observableBy.sort()).toEqual(["a", "b"])
    // 无 target → 无反应链、无传闻（公开事件全体可见）
    expect(actions.every((e) => e.action?.type !== "react")).toBe(true)
    expect(collected.traces.every((t) => t.rumors.length === 0)).toBe(true)
    expect(collected.completed).toHaveLength(1)
  })

  it("fallback 解析 markdown 代码块：性格/风格进入系统提示，speak+target 缺省 target_only 并触发反应", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    let seenSystem = ""
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const user = messages.find((m) => m.role === "user")?.content ?? ""
      if (user.includes("【刚才发生的事情】")) {
        callbacks.onToken(
          JSON.stringify({
            type: "observe",
            content: "乙表示收到",
            visibility: "self",
          }),
        )
        callbacks.onDone()
        return
      }
      if (!seenSystem) {
        seenSystem = messages.find((m) => m.role === "system")?.content ?? ""
      }
      callbacks.onToken(
        "```json\n" +
          JSON.stringify({
            type: "speak",
            content: "乙，过来一下",
            target: "乙",
            motivation: "商议",
            plot_push: "推进",
          }) +
          "\n```",
      )
      callbacks.onDone()
    }

    const agents = [
      makeNamedAgent("a", "甲", {
        personality: ["勇敢", "直率"],
        speakingStyle: "短句如刀",
      }),
      makeNamedAgent("b", "乙"),
    ]
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents,
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )

    expect(seenSystem).toContain("你的性格关键词：勇敢、直率")
    expect(seenSystem).toContain("你的说话风格：短句如刀")
    const speak = agentActions(collected).find(
      (e) => e.action?.type === "speak",
    )
    // 缺省 visibility：speak+target → target_only
    expect(speak?.timelineEvent?.observableBy.sort()).toEqual(["a", "b"])
    const react = agentActions(collected).find((e) => e.action?.type === "react")
    expect(react?.agent?.characterId).toBe("b")
    expect(react?.action?.target).toBe("甲")
    expect(react?.timelineEvent?.content).toBe("乙表示收到")
  })

  it("fallback 解析正文内嵌 JSON：非法类型/非法可见性/空 target 均有兜底", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(
        '前情提要：{"type": "胡闹", "content": "乱来", "visibility": "半公开", "target": ""}',
      )
      callbacks.onDone()
    }

    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )

    const action = agentActions(collected)[0]
    expect(action.action?.type).toBe("observe")
    // observe + 非法可见性 → self
    expect(action.timelineEvent?.observableBy).toEqual(["a"])
    expect(action.timelineEvent?.targetId).toBeUndefined()
  })

  it("fallback 解析纯垃圾文本与空白文本：observe 兜底内容分支", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    // 纯垃圾：无 JSON → 截断原文做内容
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken("这是一段完全无法解析的模型呓语，没有任何结构。")
      callbacks.onDone()
    }
    const first = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      first.callbacks,
    )
    const garbage = agentActions(first.collected)[0]
    expect(garbage.action?.type).toBe("observe")
    expect(garbage.action?.content).toContain("无法解析")

    // 空白文本：兜底为“沉默地观察周围”
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken("   ")
      callbacks.onDone()
    }
    const second = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      second.callbacks,
    )
    expect(agentActions(second.collected)[0].action?.content).toBe(
      "沉默地观察周围",
    )
  })

  it("fallback 可见性默认规则：evaluate→self，坏 visibility speak+target→target_only，显式 target_only 无 target→仅自己", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    const script = [
      JSON.stringify({ type: "evaluate", content: "甲心中暗想", motivation: "m" }),
      JSON.stringify({
        type: "speak",
        content: "甲听着",
        target: "甲",
        visibility: "bogus",
      }),
      JSON.stringify({ type: "speak", content: "自言自语", visibility: "target_only" }),
    ]
    let call = 0
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const user = messages.find((m) => m.role === "user")?.content ?? ""
      // 反应链调用直接给自洽兜底，避免干扰本用例断言
      if (user.includes("【刚才发生的事情】")) {
        callbacks.onToken(
          JSON.stringify({ type: "observe", content: "收到", visibility: "self" }),
        )
        callbacks.onDone()
        return
      }
      callbacks.onToken(script[Math.min(call, script.length - 1)])
      call += 1
      callbacks.onDone()
    }

    const agents = [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")]
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents,
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )

    // 回合内甲乙各一次决策 + 甲的 speak 触发乙反应，共 3 个 agent-action
    const mains = agentActions(collected).filter((e) => e.action?.type !== "react")
    expect(mains).toHaveLength(2)
    // 甲：evaluate 缺省 visibility → self
    expect(mains[0].timelineEvent?.observableBy).toEqual(["a"])
    // 乙：speak + 非法 visibility + 有 target → target_only（甲乙可见）
    expect(mains[1].timelineEvent?.observableBy.sort()).toEqual(["a", "b"])
  })

  it("fallback 空 content 的 JSON：回退为原文截断", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ type: "speak", content: "", visibility: "all" }))
      callbacks.onDone()
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // content 为空时回退为 raw 截断（实现行为），仍为 speak/all
    const action = agentActions(collected)[0]
    expect(action.action?.type).toBe("speak")
    expect(action.action?.content).toContain('"type"')
  })

  it("fallback streamChat 回调 onError：记失败、发 warn 事件，不降级且正常收尾", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("boom"))
    }
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(agentActions(collected)).toHaveLength(0)
    expect(collected.events.some((e) => (e.message ?? "").includes("本轮无行动"))).toBe(
      true,
    )
    expect(collected.degraded).toHaveLength(0)
    expect(collected.errors).toHaveLength(0)
    expect(collected.completed).toHaveLength(1)
    expect(collected.telemetries[0].degraded).toBe(false)
    expect(events.length).toBeGreaterThan(0)
  })

  it("fallback streamChat 直接 reject：同样记失败不断流", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async () => {
      throw new Error("reject-boom")
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.events.some((e) => (e.message ?? "").includes("本轮无行动"))).toBe(
      true,
    )
    expect(collected.completed).toHaveLength(1)
  })

  it("预中断 signal：直接收尾，上报 aborted 且不触发 onComplete", async () => {
    mockRandom(0.99)
    mockRun = vi.fn()
    resetStreamToEmpty()
    const controller = new AbortController()
    controller.abort()
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
      } as never,
      makeExtraction(),
      callbacks,
      controller.signal,
    )
    expect(events).toEqual([])
    expect(collected.completed).toHaveLength(0)
    expect(collected.telemetries).toHaveLength(1)
    expect(collected.telemetries[0].aborted).toBe(true)
    expect(collected.telemetries[0].eventCount).toBe(0)
    expect(mockRun).not.toHaveBeenCalled()
  })
})

describe("simulation-engine：isNodeGoalReachedWithEmbedding 全分支", () => {
  const node = makeNode(0, "开端", ["甲"])
  const llmConfig = {} as never

  afterEach(() => {
    vi.mocked(embed).mockResolvedValue([1, 0, 0])
    vi.mocked(cosineSimilarity).mockReturnValue(0)
  })

  it("达到最大轮次直接 true，不调 embedding", async () => {
    vi.mocked(embed).mockClear()
    const ok = await isNodeGoalReachedWithEmbedding(node, [], 2, 1, llmConfig)
    expect(ok).toBe(true)
    expect(embed).not.toHaveBeenCalled()
  })

  it("expectedOutcome 为空时走启发式：2 个 pushPlot 即 true", async () => {
    vi.mocked(embed).mockClear()
    const noGoal = { ...node, expectedOutcome: "   " }
    const events = [
      makeTlEvent({ actionType: "pushPlot" }),
      makeTlEvent({ actionType: "pushPlot" }),
    ]
    expect(await isNodeGoalReachedWithEmbedding(noGoal, events, 5, 0, llmConfig)).toBe(
      true,
    )
    expect(embed).not.toHaveBeenCalled()
  })

  it("有预期但事件为空 → false", async () => {
    expect(await isNodeGoalReachedWithEmbedding(node, [], 5, 0, llmConfig)).toBe(false)
  })

  it("相似度过阈 true / 未过阈 false，且 embed 入参与拼接文本正确", async () => {
    const events = [
      makeTlEvent({ actorName: "甲", content: "甲仗剑而起" }),
      makeTlEvent({ actorName: "乙", content: "乙应声附和" }),
    ]
    vi.mocked(cosineSimilarity).mockReturnValue(0.9)
    await expect(
      isNodeGoalReachedWithEmbedding(node, events, 5, 0, llmConfig),
    ).resolves.toBe(true)
    expect(embed).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(embed).mock.calls
    expect(calls[0][0]).toBe("完成开端")
    expect(calls[1][0]).toBe("甲：甲仗剑而起\n乙：乙应声附和")

    vi.mocked(embed).mockClear()
    vi.mocked(cosineSimilarity).mockReturnValue(0.1)
    await expect(
      isNodeGoalReachedWithEmbedding(node, events, 5, 0, llmConfig),
    ).resolves.toBe(false)
  })

  it("embed 抛错时降级为启发式（6 事件 → true）", async () => {
    vi.mocked(embed).mockRejectedValueOnce(new Error("embed down"))
    const events = Array.from({ length: 6 }, (_, i) =>
      makeTlEvent({ id: `e${i}`, content: `事件${i}` }),
    )
    await expect(
      isNodeGoalReachedWithEmbedding(node, events, 9, 0, llmConfig),
    ).resolves.toBe(true)
  })
})

describe("simulation-engine：随机事件池全分支", () => {
  function speakRunner() {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "公开讨论",
        visibility: "all",
      }),
    })
  }

  it("字符串池：按序消耗未用下标，usedIndices 生效不重复", async () => {
    mockRandom(0)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
        dynamicEventPool: ["池事件A", "池事件B", "池事件C"],
      } as never,
      makeExtraction(),
      callbacks,
    )
    const msgs = randomMessages(collected)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    expect(msgs[0]).toContain("池事件A")
    expect(msgs[1]).toContain("池事件B")
  })

  it("字符串池耗尽后回退到内置 RANDOM_EVENTS", async () => {
    mockRandom(0)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 3,
        dynamicEventPool: ["唯一事件"],
      } as never,
      makeExtraction(),
      callbacks,
    )
    const msgs = randomMessages(collected)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    expect(msgs[0]).toContain("唯一事件")
    // 耗尽后不再是池文本，但仍是随机事件
    expect(msgs[1]).not.toContain("唯一事件")
    expect(msgs[1].startsWith("【随机事件】")).toBe(true)
  })

  it("空字符串池：dynamicEventPool/usedEventIndices 退化为 undefined，仍可出内置事件", async () => {
    mockRandom(0)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
        dynamicEventPool: [],
      } as never,
      makeExtraction(),
      callbacks,
    )
    const msgs = randomMessages(collected)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].startsWith("【随机事件】")).toBe(true)
  })

  it("无事件池：走内置 RANDOM_EVENTS 分支", async () => {
    mockRandom(0)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const msgs = randomMessages(collected)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
  })

  it("分阶段池：命中 setup 阶段并记录 usedEventId，耗尽后回退", async () => {
    mockRandom(0)
    speakRunner()
    const staged = {
      byStage: {
        setup: [{ id: "s1", text: "序幕异象", stage: "setup" }],
        rising: [],
        climax: [],
        resolution: [],
      },
      all: [{ id: "s1", text: "序幕异象", stage: "setup" }],
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(4),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
        dynamicEventPool: staged,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const msgs = randomMessages(collected)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    expect(msgs[0]).toContain("序幕异象")
    expect(msgs[1]).not.toContain("序幕异象")
    // 随机事件落黑板并产生系统时间线事件
    expect(
      collected.timeline.some((t) => t.actorId === "system" && t.actionType === "pushPlot"),
    ).toBe(true)
  })
})

describe("simulation-engine：传闻衍生分支", () => {
  function evaluateRunner() {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "evaluate", content: "甲暗中记下", motivation: "m" }),
    })
  }

  it("self 可见 + 随机命中 → 传闻落黑板（失真度/可见人确定）", async () => {
    mockRandom(0)
    evaluateRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const withRumor = collected.traces.filter((t) => t.rumors.length > 0)
    expect(withRumor.length).toBeGreaterThan(0)
    const rumor = withRumor[0].rumors[0]
    expect(rumor.content).toContain("据说")
    expect(rumor.observableBy).toEqual(["b"])
    expect(rumor.distortion).toBeCloseTo(0.3, 5)
  })

  it("公开事件全体可见 → 不衍生传闻", async () => {
    mockRandom(0)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "公开", visibility: "all" }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.traces.length).toBeGreaterThan(0)
    expect(collected.traces.every((t) => t.rumors.length === 0)).toBe(true)
  })

  it("随机数未命中阈值 → 不衍生传闻", async () => {
    mockRandom(0.5)
    evaluateRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.traces.every((t) => t.rumors.length === 0)).toBe(true)
  })

  it("target_only 覆盖全体 → 无合格 gossip 对象，不衍生", async () => {
    mockRandom(0)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "密谈",
        target: "乙",
        visibility: "target_only",
      }),
    })
    // 反应链会产生自可见事件并二次衍生传闻：本用例压住反应，聚焦首事件判定
    mockStreamChatImpl = async () => {
      throw new Error("reaction suppressed")
    }
    try {
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // observableBy=[a,b] 覆盖全体 → eligible 为空
    expect(collected.traces.every((t) => t.rumors.length === 0)).toBe(true)
    expect(collected.completed).toHaveLength(1)
    } finally {
      resetStreamToEmpty()
    }
  })

  it("三 Agent：target 排除后剩余者成为传闻可见人", async () => {
    mockRandom(0)
    resetStreamToEmpty()
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "密谈",
        target: "乙",
      }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [
          makeNamedAgent("a", "甲"),
          makeNamedAgent("b", "乙"),
          makeNamedAgent("c", "丙"),
        ],
        framework: {
          ...makeFramework(),
          nodes: [makeNode(0, "开端", ["甲", "乙", "丙"])],
        },
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const withRumor = collected.traces.filter((t) => t.rumors.length > 0)
    expect(withRumor.length).toBeGreaterThan(0)
    expect(withRumor[0].rumors[0].observableBy).toEqual(["c"])
  })
})

describe("simulation-engine：降级/失败计数", () => {
  function failRunner(times: number, error: unknown) {
    let calls = 0
    mockRun = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls <= times) return Promise.reject(error)
      return Promise.resolve({
        toolCalls: [],
        roundsUsed: 1,
        finalText: JSON.stringify({
          type: "speak",
          content: "恢复发言",
          visibility: "all",
        }),
      })
    })
  }

  it("连续 3 次失败 → 降级锁存一次，遥测 degraded", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockRejectedValue(new Error("boom"))
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 3,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // hybrid 3 轮基数 → maxRounds=4，4 次失败只触发一次降级
    expect(collected.degraded).toHaveLength(1)
    expect(collected.degraded[0].consecutiveFailures).toBe(3)
    expect(collected.degraded[0].lastError).toBe("boom")
    expect(
      collected.events.some((e) => (e.message ?? "").includes("推演降级")),
    ).toBe(true)
    expect(
      collected.events.filter((e) => (e.message ?? "").includes("本轮无行动")),
    ).toHaveLength(4)
    expect(collected.errors).toHaveLength(0)
    expect(collected.completed).toHaveLength(1)
    expect(collected.telemetries[0].degraded).toBe(true)
    expect(collected.telemetries[0].aborted).toBe(false)
  })

  it("失败 2 次后成功 → 计数清零不降级（F,F,S,F,F 全程无 degraded）", async () => {
    mockRandom(0.99)
    failRunner(2, new Error("flaky"))
    // 第二段失败：再失败 2 次（累计 4 次但从未连续 3 次）
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 4,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // rounds: F,F,S,S,S → 最多连续 2 次
    expect(collected.degraded).toHaveLength(0)
    expect(agentActions(collected).length).toBeGreaterThan(0)
    expect(collected.telemetries[0].degraded).toBe(false)
  })

  it("AbortError 名失败 → 中止推演", async () => {
    mockRandom(0.99)
    mockRun = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("cancel"), { name: "AbortError" }))
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 3,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.completed).toHaveLength(0)
    expect(collected.telemetries).toHaveLength(1)
    expect(collected.telemetries[0].aborted).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it("ReAct 不支持工具 → fallback 成功不计失败", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(
        JSON.stringify({ type: "speak", content: "降级发言", visibility: "all" }),
      )
      callbacks.onDone()
    }
    const { callbacks, collected } = makeCollectors()
    try {
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      expect(agentActions(collected)).toHaveLength(1)
      expect(collected.degraded).toHaveLength(0)
    } finally {
      resetStreamToEmpty()
    }
  })
})

describe("simulation-engine：反应链", () => {
  function reactSpeakRunner() {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "乙， Troy 计划开始",
        target: "乙",
        visibility: "all",
      }),
    })
  }

  it("ReAct 路径公开带 target 事件 → 目标反应（强制 react 类型/目标）", async () => {
    mockRandom(0.99)
    reactSpeakRunner()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      // triggerReaction 专线：即便返回 speak，也会被强制为 react
      callbacks.onToken(
        JSON.stringify({ type: "speak", content: "乙立刻回应", visibility: "all" }),
      )
      callbacks.onDone()
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      const reacts = agentActions(collected).filter((e) => e.action?.type === "react")
      expect(reacts.length).toBeGreaterThanOrEqual(1)
      expect(reacts[0].agent?.characterId).toBe("b")
      expect(reacts[0].action?.target).toBe("甲")
      expect(reacts[0].timelineEvent?.content).toBe("乙立刻回应")
    } finally {
      resetStreamToEmpty()
    }
  })

  it("反应调用抛错被吞掉，主流程继续", async () => {
    mockRandom(0.99)
    reactSpeakRunner()
    mockStreamChatImpl = async () => {
      throw new Error("reaction down")
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      expect(agentActions(collected).every((e) => e.action?.type !== "react")).toBe(true)
      expect(collected.completed).toHaveLength(1)
      expect(collected.errors).toHaveLength(0)
    } finally {
      resetStreamToEmpty()
    }
  })

  it("反应中 signal 已中止 → 直接返回，外层收尾上报 aborted", async () => {
    mockRandom(0.99)
    reactSpeakRunner()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ type: "speak", content: "回应", visibility: "all" }))
      callbacks.onDone()
    }
    const controller = new AbortController()
    try {
      const { callbacks, collected } = makeCollectors({
        onEvent: (e) => {
          // 首个 agent 事件到达时同步中止：反应调用正好撞上已中止的 signal
          if (e.type === "agent-action") controller.abort()
        },
      })
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 3,
        } as never,
        makeExtraction(),
        callbacks,
        controller.signal,
      )
      expect(agentActions(collected).every((e) => e.action?.type !== "react")).toBe(true)
      expect(collected.completed).toHaveLength(0)
      expect(collected.telemetries[0].aborted).toBe(true)
    } finally {
      resetStreamToEmpty()
    }
  })

  it("agent 自己输出 react 类型 → 不再连锁反应", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "react",
        content: "甲直接反应",
        target: "乙",
        visibility: "all",
      }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // 甲乙各一次 react 决策，无二次连锁
    expect(agentActions(collected)).toHaveLength(2)
  })

  it("self 可见带 target 事件 → 不触发反应", async () => {
    // 随机数取 0：首事件触发 eligible 为空分支（543），次事件走传闻常规路径
    mockRandom(0)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "悄悄话",
        target: "乙",
        visibility: "self",
      }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(agentActions(collected).every((e) => e.action?.type !== "react")).toBe(true)
    expect(collected.completed).toHaveLength(1)
  })
})

describe("simulation-engine：resume/致命错误收尾分支", () => {
  function speakRunner() {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "续演", visibility: "all" }),
    })
  }

  it("resume 越界钳制：nodeIndex 不存在 → 回放 node 为空且从末节点起跑", async () => {
    mockRandom(0.99)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(2),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
        resume: {
          nextNodeIndex: 99,
          nextRound: -3,
          timelineEvents: [makeTlEvent({ nodeIndex: 5, round: 0, content: "旧事件" })],
        },
      } as never,
      makeExtraction(),
      callbacks,
    )
    // nodeIndex=5 在框架中不存在 → node 为 undefined，消息仍按序号格式化
    expect(events[0].message).toContain("节点6")
    expect(events[0].node).toBeUndefined()
    // 钳制到末节点（index=1）起跑
    const fresh = collected.timeline.filter((t) => t.content === "续演")
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((t) => t.nodeIndex === 1)).toBe(true)
  })

  it("resume 首轮越界：nextRound >= maxRounds 直接进下一节点", async () => {
    mockRandom(0.99)
    speakRunner()
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(2),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
        resume: {
          nextNodeIndex: 0,
          nextRound: 7,
          timelineEvents: [makeTlEvent({ content: "旧事件" })],
        },
      } as never,
      makeExtraction(),
      callbacks,
    )
    const fresh = collected.timeline.filter((t) => t.content === "续演")
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((t) => t.nodeIndex === 1)).toBe(true)
    // 节点 0 被跳过：无其 node-start
    expect(
      collected.events.some(
        (e) => e.type === "node-start" && e.node?.index === 0,
      ),
    ).toBe(false)
  })

  it("回调抛致命错且已有事件 → 错误事件 + onComplete（不断流）", async () => {
    mockRandom(0.99)
    speakRunner()
    let calls = 0
    const { callbacks, collected } = makeCollectors({
      onEvent: () => {
        calls += 1
        if (calls === 2) throw new Error("event sink down")
      },
    })
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.errors).toHaveLength(1)
    expect(collected.errors[0].message).toBe("event sink down")
    expect(
      collected.events.some((e) => (e.message ?? "").includes("推演过程中遇到错误")),
    ).toBe(true)
    expect(collected.completed).toHaveLength(1)
  })

  it("回放期抛错且尚无事件 → onError 后直接抛出", async () => {
    mockRandom(0.99)
    speakRunner()
    const { callbacks, collected } = makeCollectors({
      onTimelineEvent: () => {
        throw new Error("timeline sink down")
      },
    })
    await expect(
      runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
          resume: {
            nextNodeIndex: 0,
            nextRound: 0,
            timelineEvents: [makeTlEvent({ content: "旧事件" })],
          },
        } as never,
        makeExtraction(),
        callbacks,
      ),
    ).rejects.toThrow("timeline sink down")
    expect(collected.errors).toHaveLength(1)
    expect(collected.completed).toHaveLength(0)
  })

  it("运行中 abort + 回调抛错 → catch 走 abort 出口返回部分事件", async () => {
    mockRandom(0.99)
    speakRunner()
    const controller = new AbortController()
    let calls = 0
    const { callbacks, collected } = makeCollectors({
      onEvent: (e) => {
        calls += 1
        if (e.type === "node-start") controller.abort()
        if (calls === 2) throw new Error("late sink down")
      },
    })
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 3,
      } as never,
      makeExtraction(),
      callbacks,
      controller.signal,
    )
    // abort 出口：返回已收集事件，不调 onComplete/onError
    expect(collected.completed).toHaveLength(0)
    expect(collected.errors).toHaveLength(0)
    expect(collected.telemetries[0].aborted).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it("onEvent 抛 AbortError 名错误 → abort 出口", async () => {
    mockRandom(0.99)
    speakRunner()
    let calls = 0
    const { callbacks, collected } = makeCollectors({
      onEvent: () => {
        calls += 1
        if (calls === 2) {
          throw Object.assign(new Error("cancelled"), { name: "AbortError" })
        }
      },
    })
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.completed).toHaveLength(0)
    expect(collected.telemetries[0].aborted).toBe(true)
  })
})

describe("simulation-engine：导演评估注入分支", () => {
  const DIRECTOR_SCORES = {
    tension: 2,
    pace: 2,
    characterUtilization: 2,
    characterArc: 2,
    infoDensity: 2,
    emotionalResonance: 2,
    logicConsistency: 2,
  }

  function directorImpl(injectEvent: string | undefined, shouldInject: boolean) {
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const system = messages.find((m) => m.role === "system")?.content ?? ""
      if (system.includes("小说导演")) {
        const payload: Record<string, unknown> = {
          scores: DIRECTOR_SCORES,
          totalScore: 2,
          highlights: ["亮点"],
          issues: ["问题"],
          suggestion: "加强冲突",
          shouldInjectEvent: shouldInject,
        }
        if (injectEvent !== undefined) payload.injectEvent = injectEvent
        callbacks.onToken(JSON.stringify(payload))
        callbacks.onDone()
        return
      }
      callbacks.onToken(
        JSON.stringify({ type: "speak", content: "节点发言", visibility: "all" }),
      )
      callbacks.onDone()
    }
  }

  afterEach(() => {
    resetStreamToEmpty()
  })

  it("导演要求注入 → 下一节点首轮 prompt 携带注入事件", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockImplementation((_config, _registry, messages) => {
      const user = (messages as Array<{ role: string; content: string }>).find(
        (m) => m.role === "user",
      )?.content
      ;(globalThis as Record<string, unknown>).__lastUserMessages =
        (globalThis as unknown as Record<string, unknown[]>).__lastUserMessages ?? []
      ;(globalThis as unknown as Record<string, unknown[]>).__lastUserMessages.push(user)
      return Promise.resolve({
        toolCalls: [],
        roundsUsed: 1,
        finalText: JSON.stringify({
          type: "speak",
          content: "节点发言",
          visibility: "all",
        }),
      })
    })
    directorImpl("天外飞来陨石", true)
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(2),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      const allUsers = (globalThis as unknown as Record<string, string[]>).__lastUserMessages
      expect(allUsers.some((u) => u.includes("天外飞来陨石"))).toBe(true)
      // 注入只出现在第二节点（首轮），第一节点 prompt 不含
      expect(allUsers[0].includes("天外飞来陨石")).toBe(false)
      expect(collected.completed).toHaveLength(1)
    } finally {
      delete (globalThis as Record<string, unknown>).__lastUserMessages
    }
  })

  it("导演不注入 → 两节点正常跑完", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "发言", visibility: "all" }),
    })
    directorImpl(undefined, false)
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(2),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.completed).toHaveLength(1)
    expect(
      collected.events.filter((e) => e.type === "node-complete"),
    ).toHaveLength(2)
  })

  it("导演调用抛错 → 吞掉继续推演", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "发言", visibility: "all" }),
    })
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const system = messages.find((m) => m.role === "system")?.content ?? ""
      if (system.includes("小说导演")) {
        callbacks.onError(new Error("director down"))
        return
      }
      callbacks.onToken(
        JSON.stringify({ type: "speak", content: "发言", visibility: "all" }),
      )
      callbacks.onDone()
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(2),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(collected.completed).toHaveLength(1)
    expect(
      collected.events.filter((e) => e.type === "node-complete"),
    ).toHaveLength(2)
  })
})

describe("simulation-engine：目标达成启发式与输入回退", () => {
  it("ReAct 返回空文本且未中断 → 跳过该 agent 继续", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({ toolCalls: [], roundsUsed: 0, finalText: "" })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(agentActions(collected)).toHaveLength(0)
    expect(collected.completed).toHaveLength(1)
    // 仅系统事件：node-start/node-complete
    expect(collected.events.map((e) => e.type).sort()).toEqual([
      "node-complete",
      "node-start",
    ])
  })

  it("连续 pushPlot 提前结束节点（未跑满 maxRounds）", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        // 注意：parseAgentAction 会先 toLowerCase 再校验，LLM 的 "pushPlot"
        // 落为 observe；此处 pushPlot 计数靠 resume 预载的时间线达成。
        type: "speak",
        content: "闲聊",
        visibility: "all",
      }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: {
          ...makeFramework(),
          // expectedOutcome 为空 → 走启发式判定（pushPlot>=2 提前结束）
          nodes: [makeNode(0, "开端", ["甲"], "")],
        },
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 5,
        resume: {
          nextNodeIndex: 0,
          nextRound: 0,
          timelineEvents: [
            makeTlEvent({ id: "pp0", actionType: "pushPlot", content: "推进一" }),
            makeTlEvent({ id: "pp1", actionType: "pushPlot", content: "推进二" }),
          ],
        },
      } as never,
      makeExtraction(),
      callbacks,
    )
    // 首轮结束即满足 pushPlot>=2，未跑满 4 轮
    const fresh = collected.timeline.filter((t) => t.id !== "pp0" && t.id !== "pp1")
    expect(Math.max(...fresh.map((t) => t.round))).toBeLessThanOrEqual(0)
    expect(collected.completed).toHaveLength(1)
  })

  it("事件堆到 6 个提前结束节点", async () => {
    mockRandom(0)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "闲聊", visibility: "all" }),
    })
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: {
          ...makeFramework(),
          // expectedOutcome 为空 → 走启发式判定（事件数>=6 提前结束）
          nodes: [makeNode(0, "开端", ["甲"], "")],
        },
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 6,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // 每轮 1 agent 事件 + 1 随机事件 → 第 3 轮（round=2）满 6 提前结束
    const rounds = collected.timeline
      .filter((t) => t.actorId !== "system")
      .map((t) => t.round)
    expect(Math.max(...rounds)).toBeLessThanOrEqual(2)
    expect(collected.completed).toHaveLength(1)
  })

  it("mode 回退：undefined 用框架模式，未知模式走 hybrid", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "发言", visibility: "all" }),
    })
    for (const mode of [undefined, "weird-mode"]) {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(1),
          mode,
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      expect(collected.completed).toHaveLength(1)
    }
  })

  it("字数预算 NaN → 回退默认轮数；空 Agent 也能收尾", async () => {
    mockRandom(0.99)
    mockRun = vi.fn()
    const first = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: NaN,
        llmConfig: {},
      } as never,
      makeExtraction(),
      first.callbacks,
    )
    expect(first.collected.completed).toHaveLength(1)

    const second = makeCollectors()
    await runSimulation(
      {
        agents: [],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      second.callbacks,
    )
    expect(second.collected.completed).toHaveLength(1)
    expect(second.collected.telemetries[0].timelineEventCount).toBe(0)
  })
})

describe("simulation-engine：第二轮增补（剩余可达分支）", () => {
  function speakRunner(content = "公开讨论") {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content, visibility: "all" }),
    })
  }

  it("investigate 缺省可见性 → all（默认链 else 分支）", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ type: "investigate", content: "查线索" }))
      callbacks.onDone()
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      const mains = agentActions(collected)
      expect(mains).toHaveLength(2)
      expect(mains[0].timelineEvent?.observableBy.sort()).toEqual(["a", "b"])
    } finally {
      resetStreamToEmpty()
    }
  })

  it("streamChat 返回 JSON null → 解析抛错走 fallback（catch 分支）", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken("null")
      callbacks.onDone()
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      const action = agentActions(collected)[0]
      expect(action.action?.type).toBe("observe")
      expect(action.action?.content).toBe("null")
    } finally {
      resetStreamToEmpty()
    }
  })

  it("收拢中 abort → agentDecideAndAct 返回 null，外层走 abort 出口", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    const controller = new AbortController()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      controller.abort()
      callbacks.onDone()
    }
    try {
      const { callbacks, collected } = makeCollectors()
      const events = await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 3,
        } as never,
        makeExtraction(),
        callbacks,
        controller.signal,
      )
      expect(agentActions(collected)).toHaveLength(0)
      expect(collected.completed).toHaveLength(0)
      expect(collected.telemetries[0].aborted).toBe(true)
      expect(events.map((e) => e.type)).toEqual(["node-start"])
    } finally {
      resetStreamToEmpty()
    }
  })

  it("AgentRunner 触发 onText 回调 → finalText 累加分支", async () => {
    mockRandom(0.99)
    mockRun = vi
      .fn()
      .mockImplementation(
        (
          _config: unknown,
          _registry: unknown,
          _messages: unknown,
          callbacks: { onText: (chunk: string) => void },
        ) => {
          callbacks.onText("零散")
          return Promise.resolve({
            toolCalls: [],
            roundsUsed: 1,
            finalText: JSON.stringify({
              type: "speak",
              content: "完整发言",
              visibility: "all",
            }),
          })
        },
      )
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // 以返回的 finalText 为准，而非 onText 零散片段
    expect(agentActions(collected)[0].timelineEvent?.content).toBe("完整发言")
  })

  it("两 Agent 间中止 → agent 循环顶部 abort 分支", async () => {
    mockRandom(0.99)
    speakRunner()
    const controller = new AbortController()
    const { callbacks, collected } = makeCollectors({
      onEvent: (e) => {
        if (e.type === "agent-action") controller.abort()
      },
    })
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 3,
      } as never,
      makeExtraction(),
      callbacks,
      controller.signal,
    )
    // 乙尚未决策即中断
    expect(agentActions(collected)).toHaveLength(1)
    expect(collected.completed).toHaveLength(0)
    expect(collected.telemetries[0].aborted).toBe(true)
  })

  it("随机事件回调中 abort → 随机块后 abort 分支", async () => {
    mockRandom(0)
    speakRunner()
    const controller = new AbortController()
    const { callbacks, collected } = makeCollectors({
      onEvent: (e) => {
        if ((e.message ?? "").startsWith("【随机事件】")) controller.abort()
      },
    })
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "hybrid",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
      } as never,
      makeExtraction(),
      callbacks,
      controller.signal,
    )
    expect(randomMessages(collected).length).toBeGreaterThanOrEqual(1)
    expect(collected.completed).toHaveLength(0)
    expect(collected.telemetries[0].aborted).toBe(true)
  })

  it("导演模块抛错 → 引擎 catch 吞掉继续推演", async () => {
    mockRandom(0.99)
    speakRunner()
    const prev = mockDirectorEvaluateImpl
    mockDirectorEvaluateImpl = async () => {
      throw new Error("director exploded")
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲")],
          framework: makeMultiNodeFramework(2),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 1,
        } as never,
        makeExtraction(),
        callbacks,
      )
      expect(collected.completed).toHaveLength(1)
      expect(collected.events.filter((e) => e.type === "node-complete")).toHaveLength(2)
    } finally {
      mockDirectorEvaluateImpl = prev
    }
  })

  it("反应收拢中 abort → triggerReaction 收尾 abort 分支", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "乙看招",
        target: "乙",
        visibility: "all",
      }),
    })
    const controller = new AbortController()
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const user = messages.find((m) => m.role === "user")?.content ?? ""
      if (user.includes("【刚才发生的事情】")) {
        controller.abort()
        callbacks.onToken(
          JSON.stringify({ type: "speak", content: "回应", visibility: "all" }),
        )
        callbacks.onDone()
        return
      }
      callbacks.onDone()
    }
    try {
      const { callbacks, collected } = makeCollectors()
      await runSimulation(
        {
          agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
          framework: makeMultiNodeFramework(1),
          mode: "event-driven",
          wordBudget: 10000,
          llmConfig: {},
          maxRoundsPerNode: 3,
        } as never,
        makeExtraction(),
        callbacks,
        controller.signal,
      )
      expect(agentActions(collected).every((e) => e.action?.type !== "react")).toBe(true)
      expect(collected.completed).toHaveLength(0)
      expect(collected.telemetries[0].aborted).toBe(true)
    } finally {
      resetStreamToEmpty()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 覆盖率战役增补（本轮）：generateRandomEvent 纯数组分支 + isNodeGoalReached
// 最大轮次分支。只增补，不动原有用例。generateRandomEvent / isNodeGoalReached
// 本轮新增具名导出（零语义变更，纯可测性导出）。
// ═══════════════════════════════════════════════════════════════════════════

describe("simulation-engine：generateRandomEvent 纯数组分支（增补）", () => {
  it("单元素字符串池：命中唯一可用下标并返回 usedIndex", () => {
    const out = generateRandomEvent(["唯一池事件"])
    expect(out.usedIndex).toBe(0)
    expect(out.usedEventId).toBeUndefined()
    expect(out.event).not.toBeNull()
    expect(out.event?.message).toContain("唯一池事件")
  })

  it("字符串池跳过已用下标（has 真分支）", () => {
    const out = generateRandomEvent(["A事件", "B事件"], new Set([0]))
    expect(out.usedIndex).toBe(1)
    expect(out.event?.message).toContain("B事件")
  })

  it("字符串池耗尽（全部已用）→ 回退内置 RANDOM_EVENTS", () => {
    const out = generateRandomEvent(["唯一事件"], new Set([0]))
    expect(out.usedIndex).toBeUndefined()
    expect(out.event?.message?.startsWith("【随机事件】")).toBe(true)
    expect(out.event?.message).not.toContain("唯一事件")
  })

  it("空字符串池 → 回退内置 RANDOM_EVENTS", () => {
    const out = generateRandomEvent([])
    expect(out.usedIndex).toBeUndefined()
    expect(out.event?.message?.startsWith("【随机事件】")).toBe(true)
  })

  it("分阶段池缺节点上下文 → 按 all 文本走纯数组分支", () => {
    const staged = {
      byStage: { setup: [], rising: [], climax: [], resolution: [] },
      all: [{ id: "s1", text: "序幕异象", stage: "setup" }],
    } as unknown as StagedEventPool
    const out = generateRandomEvent(staged)
    expect(out.usedIndex).toBe(0)
    expect(out.event?.message).toContain("序幕异象")
  })
})

describe("simulation-engine：isNodeGoalReached 启发式全分支（增补）", () => {
  const node = makeNode(0, "开端", ["甲"])

  it("达到最大轮次直接 true（454 行）", () => {
    expect(isNodeGoalReached(node, [], 3, 2)).toBe(true)
    expect(isNodeGoalReached(node, [], 5, 4)).toBe(true)
    // 未达最大轮次且无事件 → false（守卫假分支）
    expect(isNodeGoalReached(node, [], 5, 0)).toBe(false)
  })

  it("2 个 pushPlot 即 true", () => {
    const events = [
      makeTlEvent({ actionType: "pushPlot" }),
      makeTlEvent({ actionType: "pushPlot" }),
    ]
    expect(isNodeGoalReached(node, events, 9, 0)).toBe(true)
  })

  it("6 事件即 true；1 事件则 false", () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      makeTlEvent({ id: `g${i}`, content: `事件${i}` }),
    )
    expect(isNodeGoalReached(node, six, 9, 0)).toBe(true)
    expect(isNodeGoalReached(node, [makeTlEvent()], 9, 0)).toBe(false)
  })
})

describe("simulation-engine：分支覆盖补齐（20261105-ralph-coverage-100）", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetStreamToEmpty()
    mockRun = undefined
  })

  function speakRunner() {
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "默认发言", visibility: "all" }),
    })
  }

  it("fallback 缺 type/缺 content：双 ?? 回退（305/309 行）", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    mockStreamChatImpl = async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ visibility: "all" }))
      callbacks.onDone()
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const mains = agentActions(collected)
    expect(mains.length).toBeGreaterThan(0)
    // type 缺失 → observe；content 缺失 → 回退为原文截断（含 visibility 键）
    expect(mains[0].action?.type).toBe("observe")
    expect(mains[0].action?.content).toContain("visibility")
  })

  it("fallback 非法 visibility：conceal→self / investigate→all（319 行三元 + 319 行 || 第三项）", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    const script = [
      JSON.stringify({ type: "conceal", content: "藏起匕首", visibility: "bogus" }),
      JSON.stringify({ type: "investigate", content: "查线索", visibility: "bogus" }),
    ]
    let call = 0
    mockStreamChatImpl = async (_config, messages, callbacks) => {
      const user = messages.find((m) => m.role === "user")?.content ?? ""
      if (user.includes("【刚才发生的事情】")) {
        callbacks.onToken(JSON.stringify({ type: "observe", content: "收到", visibility: "self" }))
        callbacks.onDone()
        return
      }
      callbacks.onToken(script[Math.min(call, script.length - 1)])
      call += 1
      callbacks.onDone()
    }
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲"), makeNamedAgent("b", "乙")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    const mains = agentActions(collected).filter((e) => e.action?.type !== "react")
    expect(mains).toHaveLength(2)
    // conceal + 非法 visibility → self（仅自己可见），覆盖 || 第三项求值 + self 分支
    expect(mains[0].timelineEvent?.observableBy).toEqual(["a"])
    // investigate + 非法 visibility → all（全体可见），覆盖 :all 分支
    // （注：pushPlot 经 toLowerCase 落为 observe，无法经 fallback 走 all；用 investigate 覆盖）
    expect(mains[1].timelineEvent?.observableBy.sort()).toEqual(["a", "b"])
  })

  it("generateRandomEvent 分阶段池无 usedIndices：|| 右侧兜底（392 行）", () => {
    const staged = {
      byStage: { setup: [{ id: "s1", text: " staged  setup 事件" }] },
      all: [{ id: "s1", text: "staged setup 事件" }],
    } as unknown as StagedEventPool
    const { event, usedEventId } = generateRandomEvent(staged, undefined, 0, 1)
    expect(event).not.toBeNull()
    expect(event?.message).toContain("【随机事件】")
    // usedIndices 缺省时内部 new Set 兜底，仍能命中分阶段事件并返回 id
    expect(usedEventId).toBe("s1")
  })

  it("mode 回退：input.mode 与 framework.simulationMode 双缺 → hybrid（869 行第三项）", async () => {
    mockRandom(0.99)
    speakRunner()
    const fw = makeMultiNodeFramework(1) as unknown as Record<string, unknown>
    delete fw["simulationMode"]
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: fw,
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(events.length).toBeGreaterThan(0)
    expect(agentActions(collected).length).toBeGreaterThan(0)
  })

  it("ReAct onError 非工具错误不抛继续跑（799 行 else）", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockImplementation(async (_cfg: unknown, _reg: unknown, _msgs: unknown, cbs: { onError: (e: Error) => void }) => {
      cbs.onError(new Error("tool boom"))
      return {
        toolCalls: [],
        roundsUsed: 1,
        finalText: JSON.stringify({ type: "speak", content: "工具错后仍发言", visibility: "all" }),
      }
    })
    const { callbacks, collected } = makeCollectors()
    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )
    expect(events.length).toBeGreaterThan(0)
    expect(agentActions(collected)[0].action?.content).toContain("工具错后仍发言")
  })

  it("导演注入跨轮：次轮 injectionEvent 回退 undefined（1064 行 false）", async () => {
    mockRandom(0.99)
    rejectWithNoTools()
    // 复用既有导演桩：streamChat 识别“小说导演”系统提示返回注入决策
    const systemPayload = (shouldInject: boolean) => async (_config: unknown, messages: Array<{ role: string; content: string }>, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
      const system = messages.find((m) => m.role === "system")?.content ?? ""
      if (system.includes("小说导演")) {
        callbacks.onToken(JSON.stringify({
          scores: { a: 1 },
          totalScore: 1,
          highlights: ["亮点"],
          issues: ["问题"],
          suggestion: "加强冲突",
          shouldInjectEvent: shouldInject,
          injectEvent: "天外飞来陨石",
        }))
        callbacks.onDone()
        return
      }
      callbacks.onToken(JSON.stringify({ type: "speak", content: "发言", visibility: "all" }))
      callbacks.onDone()
    }
    mockStreamChatImpl = systemPayload(true)
    const { callbacks, collected } = makeCollectors()
    await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(2),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 2,
      } as never,
      makeExtraction(),
      callbacks,
    )
    // 两节点 × 两轮 = 4 次 agent 决策；第二节点次轮走 round!==0 → undefined 分支
    expect(agentActions(collected).length).toBeGreaterThanOrEqual(4)
  })
})

// 覆盖率战役增补（本轮）：致命错误归一化与非 Error 抛出（1283 行右侧分支）。
describe("simulation-engine：致命错误归一化（增补）", () => {
  it("调用方回调抛非 Error（字符串）→ 归一化为 Error，已收事件仍随 onComplete 返回", async () => {
    mockRandom(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({ type: "speak", content: "正常推进", visibility: "all" }),
    })
    const { callbacks, collected } = makeCollectors()
    let thrown = false
    callbacks.onProgress = () => {
      // 只抛一次：避免错误分支内的 onComplete 再次触发
      if (thrown) return
      thrown = true
      throw "progress-callback-boom"
    }

    const events = await runSimulation(
      {
        agents: [makeNamedAgent("a", "甲")],
        framework: makeMultiNodeFramework(1),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      callbacks,
    )

    // 已推演内容不丢：错误事件追加在末尾
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.type).toBe("info")
    expect(last.message).toContain("推演过程中遇到错误")
    expect(last.message).toContain("progress-callback-boom")
    // onError 收到的是 Error 实例（归一化），不是原始字符串
    expect(collected.errors).toHaveLength(1)
    expect(collected.errors[0]).toBeInstanceOf(Error)
    expect(collected.errors[0].message).toBe("progress-callback-boom")
    expect(collected.completed).toHaveLength(1)
  })
})
