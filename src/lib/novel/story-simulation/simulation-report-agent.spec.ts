import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import type {
  AgentAction,
  NovelAgent,
  SimulationEvent,
  StoryFramework,
  StoryNode,
} from "./types"
import { generateSimulationReport } from "./simulation-report-agent"

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: vi.fn(),
  }
})

const mockStreamChat = vi.mocked(streamChat)

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 4096,
}

function makeNode(overrides: Partial<StoryNode> = {}): StoryNode {
  return {
    index: 0,
    phase: "起",
    title: "开端",
    coreConflict: "冲突A",
    involvedCharacters: ["张三"],
    goal: "目标A",
    causeFromPrev: "",
    expectedOutcome: "结局A",
    ...overrides,
  }
}

function makeAgent(name: string): NovelAgent {
  return {
    characterId: `id-${name}`,
    name,
    profile: `${name}简介`,
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "",
    emotionalState: "平静",
    knownFacts: new Set<string>(),
    relationships: new Map(),
    powerLevel: "凡人",
    memory: {
      observedEvents: [],
      knownSecrets: new Set<string>(),
      sentiments: new Map(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: ["勇敢"],
    speakingStyle: "直率",
  } as NovelAgent
}

function makeFramework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "测试框架",
    premise: "测试前提：宗门大比",
    targetWords: 30000,
    simulationMode: "event-driven",
    sourceChapters: 3,
    nodes: [
      makeNode({}),
      makeNode({ index: 1, phase: "承", title: "发展", coreConflict: "冲突B", goal: "目标B" }),
    ],
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/** 让 mocked streamChat 按 collectStream 的回调协议一次性吐出 raw 文本 */
function mockResponseOnce(raw: string, split = false) {
  mockStreamChat.mockImplementationOnce(async (_config, _messages, callbacks) => {
    if (split && raw.length > 2) {
      const mid = Math.floor(raw.length / 2)
      callbacks.onToken(raw.slice(0, mid))
      callbacks.onToken(raw.slice(mid))
    } else {
      callbacks.onToken(raw)
    }
    callbacks.onDone()
  })
}

function userPromptOfCall(index = 0): string {
  const call = mockStreamChat.mock.calls[index]
  const messages = call[1] as Array<{ role: string; content: string }>
  return messages[1].content
}

function systemPromptOfCall(index = 0): string {
  const call = mockStreamChat.mock.calls[index]
  const messages = call[1] as Array<{ role: string; content: string }>
  return messages[0].content
}

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    characterAnalyses: [
      {
        characterId: "id-张三",
        name: "张三",
        behaviors: [{ node: "开端", action: "报名", motivation: "求道" }],
        stateChanges: ["心态坚定"],
        consistencyScore: 85,
      },
    ],
    branches: [
      {
        title: "走向一",
        summary: "摘要一",
        keyEvents: ["事件1"],
        probability: "high",
        pros: "优点",
        cons: "不足",
        recommendation: true,
      },
    ],
    recommendation: "建议走稳妥路线",
    ...overrides,
  })
}

beforeEach(() => {
  mockStreamChat.mockReset()
})

describe("generateSimulationReport 成功路径", () => {
  it("裸 JSON 全字段解析并回填 frameworkId/mode/createdAt", async () => {
    mockResponseOnce(validPayload())
    const framework = makeFramework()
    const report = await generateSimulationReport({
      events: [],
      framework,
      mode: "event-driven",
      llmConfig,
    })
    expect(report.frameworkId).toBe("fw-1")
    expect(report.mode).toBe("event-driven")
    expect(report.characterAnalyses).toHaveLength(1)
    expect(report.characterAnalyses[0].name).toBe("张三")
    expect(report.characterAnalyses[0].consistencyScore).toBe(85)
    expect(report.characterAnalyses[0].behaviors[0]).toEqual({
      node: "开端",
      action: "报名",
      motivation: "求道",
    })
    expect(report.branches).toHaveLength(1)
    expect(report.branches[0].probability).toBe("high")
    expect(report.branches[0].recommendation).toBe(true)
    expect(report.recommendation).toBe("建议走稳妥路线")
    expect(new Date(report.createdAt).toISOString()).toBe(report.createdAt)
  })

  it("按顺序触发三次 onProgress 且无 onProgress 时不抛错", async () => {
    mockResponseOnce(validPayload())
    const labels: string[] = []
    await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
      onProgress: (label) => labels.push(label),
    })
    expect(labels).toEqual([
      "正在构建推演提示词",
      "正在调用模型生成推演报告",
      "正在解析推演报告",
    ])

    mockResponseOnce(validPayload())
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.mode).toBe("hybrid")
  })

  it("system/user 提示词携带框架信息并透传 signal", async () => {
    mockResponseOnce(validPayload())
    const controller = new AbortController()
    await generateSimulationReport({
      events: [],
      framework: makeFramework({ userIdea: "复仇线" }),
      mode: "free-emergence",
      llmConfig,
      signal: controller.signal,
    })
    const system = systemPromptOfCall()
    expect(system).toContain("测试框架")
    expect(system).toContain("测试前提")
    expect(system).toContain("free-emergence")
    expect(system).toContain("characterAnalyses")
    const user = userPromptOfCall()
    expect(user).toContain("复仇线")
    expect(user).toContain("开端")
    expect(user).toContain("目标字数")
    const signalArg = mockStreamChat.mock.calls[0][3] as unknown
    expect(signalArg).toBe(controller.signal)
  })

  it("无 userIdea 时用户提示词不含用户构想行", async () => {
    mockResponseOnce(validPayload())
    const framework = makeFramework()
    delete framework.userIdea
    await generateSimulationReport({ events: [], framework, mode: "hybrid", llmConfig })
    expect(userPromptOfCall()).not.toContain("用户构想")
  })

  it("分片 token 拼接后再解析", async () => {
    mockResponseOnce(validPayload(), true)
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.recommendation).toBe("建议走稳妥路线")
  })
})

describe("extractJson 三种形态", () => {
  it("markdown 代码块包裹的 JSON 可解析", async () => {
    mockResponseOnce("```json\n" + validPayload() + "\n```")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.branches[0].title).toBe("走向一")
  })

  it("无语言标记的代码块 JSON 可解析", async () => {
    mockResponseOnce("```\n" + validPayload() + "\n```")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses[0].name).toBe("张三")
  })

  it("前后杂文本包裹的裸对象 JSON 可解析", async () => {
    mockResponseOnce("分析完成，结果如下：" + validPayload() + "，以上仅供参考。")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.recommendation).toBe("建议走稳妥路线")
  })

  it("损坏的代码块回退到正文对象提取", async () => {
    const payload = validPayload()
    mockResponseOnce("```json\nnot-json-here\n```\n正文：" + payload)
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.recommendation).toBe("建议走稳妥路线")
  })
})

describe("降级报告", () => {
  it("无任何 JSON 时用原始文本做 recommendation", async () => {
    mockResponseOnce("模型纯文本输出，没有结构")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses).toEqual([])
    expect(report.branches).toEqual([])
    expect(report.recommendation).toBe("模型纯文本输出，没有结构")
    expect(report.frameworkId).toBe("fw-1")
  })

  it("大括号内容非法时同样降级", async () => {
    mockResponseOnce("纯文本 {不是json} 更多文本")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses).toEqual([])
    expect(report.recommendation).toBe("纯文本 {不是json} 更多文本")
  })

  it("空白响应使用默认文案", async () => {
    mockResponseOnce("   \n  ")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.recommendation).toBe("模型未返回可解析的推演报告")
  })

  it("流错误向调用方抛出", async () => {
    mockStreamChat.mockImplementationOnce(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("upstream 500"))
    })
    await expect(
      generateSimulationReport({
        events: [],
        framework: makeFramework(),
        mode: "hybrid",
        llmConfig,
      }),
    ).rejects.toThrow("upstream 500")
  })
})

describe("事件序列化 formatEvent 全分支", () => {
  function actionEvent(action: AgentAction | undefined, extra: Partial<SimulationEvent> = {}): SimulationEvent {
    return {
      type: "agent-action",
      agent: makeAgent("张三"),
      action,
      round: 0,
      node: makeNode({ title: "开端" }),
      timestamp: "T1",
      ...extra,
    }
  }

  it("节点开始/完成含缺失分支", async () => {
    mockResponseOnce(validPayload())
    const node = makeNode({ index: 2, title: "高潮" })
    await generateSimulationReport({
      events: [
        { type: "node-start", node, timestamp: "T0" },
        { type: "node-start", timestamp: "T0b" },
        { type: "node-complete", node, timestamp: "T2" },
        { type: "node-complete", timestamp: "T3" },
      ],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    const user = userPromptOfCall()
    expect(user).toContain("节点开始：第 3 个节点「高潮」")
    expect(user).toContain("节点开始（节点信息缺失）")
    expect(user).toContain("节点完成：第 3 个节点「高潮」")
    expect(user).toContain("节点完成（节点信息缺失）")
  })

  it("八种行为动作文案各不相同", async () => {
    mockResponseOnce(validPayload())
    const cases: Array<[AgentAction, string]> = [
      [{ type: "speak", content: "你好", target: "李四" }, "对 李四 说"],
      [{ type: "speak", content: "独白" }, "自言自语"],
      [{ type: "act", content: "拔剑" }, "行动：拔剑"],
      [{ type: "react", content: "回礼", target: "李四" }, "做出反应"],
      [{ type: "decide", content: "应战" }, "做出决定：应战"],
      [{ type: "investigate", content: "查探" }, "调查：查探"],
      [{ type: "conflict", content: "争吵", target: "李四" }, "发生冲突"],
      [{ type: "cooperate", content: "结盟", target: "李四" }, "合作"],
      [{ type: "withhold", content: "隐瞒身世" }, "隐瞒信息"],
    ]
    await generateSimulationReport({
      events: cases.map(([action], i) =>
        actionEvent(action, { timestamp: `T${i}`, stateChanges: i === 0 ? ["怒气+1", "声望+2"] : [] }),
      ),
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    const user = userPromptOfCall()
    for (const [, fragment] of cases) expect(user).toContain(fragment)
    expect(user).toContain("状态变更：怒气+1，声望+2")
  })

  it("新引擎行为类型无专属文案但仍序列化", async () => {
    mockResponseOnce(validPayload())
    await generateSimulationReport({
      events: [
        actionEvent({ type: "evaluate", content: "此人深不可测" }, { timestamp: "TE" }),
        actionEvent({ type: "pushPlot", content: "夜探禁地" }, { timestamp: "TP" }),
      ],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    const user = userPromptOfCall()
    expect(user).toContain("角色行为：张三")
    expect(user).toContain("第 1 轮")
  })

  it("缺失 agent/node/round/action 与未知事件走默认分支", async () => {
    mockResponseOnce(validPayload())
    await generateSimulationReport({
      events: [
        { type: "agent-action", timestamp: "TA" },
        {
          type: "agent-action",
          agent: makeAgent("李四"),
          timestamp: "TB",
        },
        { type: "info", message: "旁白", timestamp: "TC" },
      ],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    const user = userPromptOfCall()
    expect(user).toContain("未知角色")
    expect(user).toContain("李四")
    expect(user).toContain("未知事件")
  })
})

describe("clampScore / parseProbability / parseBoolean 健壮解析", () => {
  it("consistencyScore 非法值钳制到 0~100 并四舍五入", async () => {
    mockResponseOnce(
      validPayload({
        characterAnalyses: [
          { characterId: "a", name: "A", behaviors: [], stateChanges: [], consistencyScore: "NaN" },
          { characterId: "b", name: "B", behaviors: [], stateChanges: [], consistencyScore: -5 },
          { characterId: "c", name: "C", behaviors: [], stateChanges: [], consistencyScore: 250 },
          { characterId: "d", name: "D", behaviors: [], stateChanges: [], consistencyScore: 67.6 },
          { characterId: "e", name: "E", behaviors: [], stateChanges: [], consistencyScore: "42" },
          { characterId: "f", name: "F", behaviors: [], stateChanges: [] },
        ],
      }),
    )
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    const scores = report.characterAnalyses.map((c) => c.consistencyScore)
    expect(scores).toEqual([0, 0, 100, 68, 42, 0])
  })

  it("probability 中英文映射与默认 medium", async () => {
    mockResponseOnce(
      validPayload({
        branches: [
          { title: "t1", summary: "s", keyEvents: [], probability: "高", pros: "", cons: "", recommendation: false },
          { title: "t2", summary: "s", keyEvents: [], probability: "低", pros: "", cons: "", recommendation: false },
          { title: "t3", summary: "s", keyEvents: [], probability: "HIGH", pros: "", cons: "", recommendation: false },
          { title: "t4", summary: "s", keyEvents: [], probability: "LOW", pros: "", cons: "", recommendation: false },
          { title: "t5", summary: "s", keyEvents: [], probability: "maybe", pros: "", cons: "", recommendation: false },
          { title: "t6", summary: "s", keyEvents: [], probability: null, pros: "", cons: "", recommendation: false },
        ],
      }),
    )
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.branches.map((b) => b.probability)).toEqual([
      "high",
      "low",
      "high",
      "low",
      "medium",
      "medium",
    ])
  })

  it("recommendation 布尔多形态解析", async () => {
    mockResponseOnce(
      validPayload({
        branches: [
          { title: "a", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: "是" },
          { title: "b", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: "推荐" },
          { title: "c", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: "yes" },
          { title: "d", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: 1 },
          { title: "e", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: 0 },
          { title: "f", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: "no" },
          { title: "g", summary: "s", keyEvents: [], probability: "high", pros: "", cons: "", recommendation: " True " },
        ],
      }),
    )
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.branches.map((b) => b.recommendation)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ])
  })

  it("非数组的 characterAnalyses/branches 回退为空数组", async () => {
    mockResponseOnce(validPayload({ characterAnalyses: { a: 1 }, branches: "oops" }))
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses).toEqual([])
    expect(report.branches).toEqual([])
  })

  it("缺失字段用空字符串与空数组兜底", async () => {
    mockResponseOnce(
      validPayload({
        characterAnalyses: [{ behaviors: [{ node: "n" }], stateChanges: "oops" }],
        branches: [{ keyEvents: "oops" }],
      }),
    )
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses[0].characterId).toBe("")
    expect(report.characterAnalyses[0].behaviors[0]).toEqual({ node: "n", action: "", motivation: "" })
    expect(report.characterAnalyses[0].stateChanges).toEqual([])
    expect(report.branches[0].title).toBe("")
    expect(report.branches[0].keyEvents).toEqual([])
  })
})

describe("parseRecommendation 全形态", () => {
  async function recommendWith(raw: unknown): Promise<string> {
    mockResponseOnce(validPayload({ recommendation: raw }))
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    return report.recommendation
  }

  it("空字符串与非字符串回退默认文案", async () => {
    expect(await recommendWith("   ")).toBe("模型未提供综合推荐建议")
    expect(await recommendWith(null)).toBe("模型未提供综合推荐建议")
    expect(await recommendWith(123)).toBe("模型未提供综合推荐建议")
  })

  it("JSON 字符串提取 text/content/recommendation/summary", async () => {
    expect(await recommendWith(JSON.stringify({ text: "文本建议" }))).toBe("文本建议")
    expect(await recommendWith(JSON.stringify({ content: "内容建议" }))).toBe("内容建议")
    expect(await recommendWith(JSON.stringify({ recommendation: "推荐建议" }))).toBe("推荐建议")
    expect(await recommendWith(JSON.stringify({ summary: "摘要建议" }))).toBe("摘要建议")
  })

  it("JSON 字符串数组拼接元素", async () => {
    expect(await recommendWith(JSON.stringify(["a", "b"]))).toBe("a；b")
    expect(
      await recommendWith(JSON.stringify([{ text: "A" }, { content: "B" }, "C", 7])),
    ).toBe("A；B；C；7")
  })

  it("JSON 字符串对象无已知键时拼接值", async () => {
    expect(
      await recommendWith(JSON.stringify({ a: "建议A", b: ["点1", "点2"] })),
    ).toBe("建议A；点1、点2")
  })

  it("稀疏元素与 null 条目均有安全兜底", async () => {
    mockResponseOnce(
      validPayload({
        characterAnalyses: [
          null,
          { behaviors: [null, {}], stateChanges: [1, null] },
        ],
        branches: [null, { keyEvents: [1, null] }],
      }),
    )
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses).toHaveLength(2)
    expect(report.characterAnalyses[0].characterId).toBe("")
    expect(report.characterAnalyses[1].behaviors).toEqual([
      { node: "", action: "", motivation: "" },
      { node: "", action: "", motivation: "" },
    ])
    expect(report.characterAnalyses[1].stateChanges).toEqual(["1", "null"])
    expect(report.branches).toHaveLength(2)
    expect(report.branches[0].title).toBe("")
    expect(report.branches[1].keyEvents).toEqual(["1", "null"])
  })

  it("JSON 纯字符串整体不被识别为 JSON 对象则原样返回", async () => {
    // 首尾为引号而非 {} / []，extractJson 式的对象提取不触发，原样返回（含引号）
    expect(await recommendWith(JSON.stringify("纯字符串建议"))).toBe(
      JSON.stringify("纯字符串建议"),
    )
    expect(await recommendWith(JSON.stringify("   "))).toBe(JSON.stringify("   "))
  })

  it("JSON 字符串对象前键非字符串时顺延后键", async () => {
    expect(
      await recommendWith(JSON.stringify({ text: 123, content: "后备内容" })),
    ).toBe("后备内容")
    expect(
      await recommendWith(
        JSON.stringify({ text: 1, content: 2, recommendation: "R建议" }),
      ),
    ).toBe("R建议")
    expect(await recommendWith(JSON.stringify({ a: 1 }))).toBe(
      "模型未提供综合推荐建议",
    )
  })
  it("JSON 字符串内空白 text/content 回退默认文案", async () => {
    expect(await recommendWith(JSON.stringify({ text: "   " }))).toBe(
      "模型未提供综合推荐建议",
    )
    expect(await recommendWith(JSON.stringify({ content: "  " }))).toBe(
      "模型未提供综合推荐建议",
    )
    expect(await recommendWith(JSON.stringify([{ n: 1 }, 5]))).toBe('{"n":1}；5')
    expect(await recommendWith(JSON.stringify({ recommendation: "  " }))).toBe(
      "模型未提供综合推荐建议",
    )
    expect(await recommendWith(JSON.stringify({ summary: " " }))).toBe(
      "模型未提供综合推荐建议",
    )
    expect(await recommendWith(JSON.stringify([""]))).toBe(
      "模型未提供综合推荐建议",
    )
  })

  it("JSON 字面量 null 触发解析降级保留原文", async () => {
    mockResponseOnce("null")
    const report = await generateSimulationReport({
      events: [],
      framework: makeFramework(),
      mode: "hybrid",
      llmConfig,
    })
    expect(report.characterAnalyses).toEqual([])
    expect(report.branches).toEqual([])
    expect(report.recommendation).toBe("null")
  })
  it("看似 JSON 但解析失败时返回原字符串", async () => {
    expect(await recommendWith('{"text": broken}')).toBe('{"text": broken}')
    expect(await recommendWith("{not json")).toBe("{not json")
  })

  it("数组与对象形态的 recommendation 直接解析", async () => {
    expect(await recommendWith(["a", { text: "B" }, 9])).toBe("a；B；9")
    expect(await recommendWith([])).toBe("模型未提供综合推荐建议")
    expect(await recommendWith({ text: "对象文本" })).toBe("对象文本")
    expect(await recommendWith({ content: "对象内容" })).toBe("对象内容")
    expect(await recommendWith({ summary: "对象摘要" })).toBe("对象摘要")
    expect(await recommendWith({ a: "甲", b: ["乙", "丙"] })).toBe("甲；乙、丙")
    expect(await recommendWith({ a: 1 })).toBe("模型未提供综合推荐建议")
    expect(await recommendWith({ text: "   " })).toBe("模型未提供综合推荐建议")
    expect(await recommendWith({ content: "  " })).toBe("模型未提供综合推荐建议")
    expect(await recommendWith({ recommendation: "" })).toBe("模型未提供综合推荐建议")
    expect(await recommendWith({ summary: "   " })).toBe("模型未提供综合推荐建议")
    // 数组元素为无已知键对象时回退为 JSON 字符串
    expect(await recommendWith([{ n: 1 }])).toBe('{"n":1}')
  })

  it("解析层抛异常时降级保留原始文本", async () => {
    mockResponseOnce(validPayload())
    const origParse = JSON.parse
    let calls = 0
    const spy = vi
      .spyOn(JSON, "parse")
      .mockImplementation(((text: string) => {
        calls += 1
        // 第 1 次是 extractJson 内部的直接解析（放行）；第 2 次是外层解析（模拟异常）
        if (calls === 2) throw new SyntaxError("injected parse failure")
        return origParse(text)
      }) as typeof JSON.parse)
    try {
      const report = await generateSimulationReport({
        events: [],
        framework: makeFramework(),
        mode: "hybrid",
        llmConfig,
      })
      expect(report.characterAnalyses).toEqual([])
      expect(report.branches).toEqual([])
      expect(report.recommendation).toContain("characterAnalyses")
    } finally {
      spy.mockRestore()
    }
  })
})
