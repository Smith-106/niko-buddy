/**
 * story-draft-generator 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：轻量流逐章生成 / 深章引擎成功与降级回退 / 提示词组装各分支 /
 * 流错误传播 / 空框架 / 字数统计 / 进度与章节回调。
 * LLM 与文件写入一律 mock，不做真实网络调用。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import { runDeepChapterGeneration } from "@/lib/novel/deep-chapter-generation"
import type { LlmConfig } from "@/stores/wiki-store"
import type {
  CharacterAnalysis,
  StoryBranch,
  StoryFramework,
  StoryNode,
  TimelineEvent,
} from "@/lib/novel/story-simulation/types"
import { generateStoryDraft } from "./story-draft-generator"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

vi.mock("@/lib/novel/deep-chapter-generation", () => ({
  runDeepChapterGeneration: vi.fn(),
}))

const mockedStreamChat = vi.mocked(streamChat)
const mockedRunDeep = vi.mocked(runDeepChapterGeneration)

function llmConfig(): LlmConfig {
  return {
    provider: "custom",
    apiKey: "k",
    model: "gpt-5.4",
    customEndpoint: "https://example.test/v1",
    ollamaUrl: "",
    maxContextSize: 204800,
    apiMode: "chat_completions",
  } as LlmConfig
}

function node(overrides: Partial<StoryNode> = {}): StoryNode {
  return {
    index: 0,
    phase: "起",
    title: "开端",
    coreConflict: "主角与命运的冲突",
    involvedCharacters: ["阿明"],
    goal: "立起人物与困境",
    causeFromPrev: "前情铺垫",
    expectedOutcome: "主角踏上旅程",
    ...overrides,
  }
}

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "测试框架",
    premise: "一个关于勇气的故事",
    targetWords: 1000,
    simulationMode: "hybrid",
    sourceChapters: 2,
    nodes: [
      node({ index: 0, title: "开端" }),
      node({
        index: 1,
        phase: "承",
        title: "转折",
        involvedCharacters: ["c-阿红"],
        causeFromPrev: "",
      }),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function branch(overrides: Partial<StoryBranch> = {}): StoryBranch {
  return {
    title: "勇者之路",
    summary: "主角迎难而上",
    keyEvents: ["主角拔剑", "众人欢呼"],
    probability: "high",
    pros: "燃",
    cons: "险",
    recommendation: true,
    ...overrides,
  }
}

function analysis(overrides: Partial<CharacterAnalysis> = {}): CharacterAnalysis {
  return {
    characterId: "c-aming",
    name: "阿明",
    behaviors: [{ node: "开端", action: "拔剑", motivation: "守护" }],
    stateChanges: ["从胆怯到坚定"],
    consistencyScore: 88,
    ...overrides,
  }
}

function timelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "ev-1",
    round: 0,
    nodeIndex: 0,
    actorId: "c-aming",
    actorName: "阿明",
    actionType: "speak",
    content: "我来断后！",
    observableBy: ["c-aming"],
    impacts: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

type StreamCb = {
  onToken: (t: string) => void
  onDone: () => void
  onError: (e: Error) => void
}

/** 让 streamChat 按给定正文逐 token 回放后正常结束。 */
function mockStreamOk(fullText: string) {
  mockedStreamChat.mockImplementation(async (_cfg, _msgs, cb) => {
    const c = cb as unknown as StreamCb
    for (const ch of fullText) c.onToken(ch)
    c.onDone()
  })
}

function lastUserPrompt(): string {
  const calls = mockedStreamChat.mock.calls
  const msgs = calls[calls.length - 1]?.[1] as
    | { role: string; content: string }[]
    | undefined
  return msgs?.find((m) => m.role === "user")?.content ?? ""
}

function baseReport() {
  return {
    frameworkId: "fw-1",
    mode: "hybrid" as const,
    characterAnalyses: [analysis()],
    branches: [branch()],
    recommendation: "建议走勇者线",
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStreamOk("  章节正文甲  ")
})

describe("generateStoryDraft 轻量流", () => {
  it("逐节点生成章节并汇总字数与回调", async () => {
    mockStreamOk("AB CD\nEF") // 含空白：countWords 应按去空白计数
    const progress: string[] = []
    const generated: string[] = []
    const draft = await generateStoryDraft({
      framework: framework(),
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
      onProgress: (l) => progress.push(l),
      onChapterGenerated: (c) => generated.push(c.title),
    })

    expect(mockedStreamChat).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(["正在生成第 1/2 章：开端", "正在生成第 2/2 章：转折"])
    expect(generated).toEqual(["开端", "转折"])
    expect(draft.chapters).toHaveLength(2)
    // "AB CD\nEF" 去空白后 6 字 × 2 章
    expect(draft.totalWords).toBe(12)
    expect(draft.branchId).toBe("勇者之路")
    expect(draft.frameworkId).toBe("fw-1")
    expect(draft.chapters[0]).toMatchObject({
      title: "开端",
      content: "AB CD\nEF".trim(),
      correspondingNode: 0,
      rawContent: "AB CD\nEF".trim(),
    })
    expect(draft.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("提示词包含因果/分支事件/角色行为与一手事件序列", async () => {
    const fw = framework()
    await generateStoryDraft({
      framework: fw,
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
      nodeTimelineEvents: [
        timelineEvent({ targetName: "阿红" }),
        timelineEvent({ id: "ev-2", nodeIndex: 1, round: 2, targetName: "阿红", content: "对峙！" }),
      ],
    })
    const prompt = lastUserPrompt()
    // 第二章的提示词（最后一次调用）
    expect(prompt).toContain("转折")
    // 本章目标字数：1000/2=500
    expect(prompt).toContain("本章目标字数约 500 字")
    // 第二章节点用 characterId 匹配（involvedCharacters=["c-阿红"]），报告里应无阿明分析
    expect(prompt).toContain("（无相关角色的行为分析数据）")
    // 一手事件只收录本节点（nodeIndex=1），第 round+1=3 轮，带目标箭头
    expect(prompt).toContain("第3轮")
    expect(prompt).toContain("→ 阿红")
    expect(prompt).toContain("对峙！")
    expect(prompt).not.toContain("我来断后")
  })

  it("第一章提示词走节点行为过滤与状态变化分支", async () => {
    const fw = framework({ nodes: [node({ index: 0, title: "开端" })] })
    await generateStoryDraft({
      framework: fw,
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
      nodeTimelineEvents: [timelineEvent()],
    })
    const prompt = lastUserPrompt()
    expect(prompt).toContain("承接上文的因果：前情铺垫")
    expect(prompt).toContain("关键事件：主角拔剑；众人欢呼")
    expect(prompt).toContain("角色：阿明")
    expect(prompt).toContain("行为：拔剑（动机：守护）")
    expect(prompt).toContain("状态变化：从胆怯到坚定")
    expect(prompt).toContain("【本节点一手推演事件序列")
    expect(prompt).toContain("第1轮 阿明 [speak]：我来断后！")
    expect(prompt).toContain("本章目标字数约 1000 字")
  })

  it("空分支回退：无因果/无关键事件/无分析/无状态变化/无目标名", async () => {
    const fw = framework({
      targetWords: 7,
      nodes: [
        node({
          index: 0,
          title: "孤章",
          involvedCharacters: [],
          causeFromPrev: "",
        }),
      ],
    })
    await generateStoryDraft({
      framework: fw,
      report: { ...baseReport(), characterAnalyses: [] },
      selectedBranch: branch({ keyEvents: [] }),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
    })
    const prompt = lastUserPrompt()
    expect(prompt).not.toContain("承接上文的因果")
    expect(prompt).toContain("涉及角色：（未指定）")
    expect(prompt).toContain("关键事件：（无）")
    expect(prompt).toContain("（无相关角色的行为分析数据）")
    expect(prompt).not.toContain("【本节点一手推演事件序列")
    // 7/1=7
    expect(prompt).toContain("本章目标字数约 7 字")
  })

  it("角色无本节点行为时回退展示全部行为", async () => {
    const fw = framework({ nodes: [node({ index: 0, title: "开端" })] })
    await generateStoryDraft({
      framework: fw,
      report: {
        ...baseReport(),
        characterAnalyses: [
          analysis({ behaviors: [{ node: "别处", action: "潜伏", motivation: "等待" }], stateChanges: [] }),
        ],
      },
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
    })
    const prompt = lastUserPrompt()
    expect(prompt).toContain("行为：潜伏（动机：等待）")
    expect(prompt).not.toContain("状态变化：")
  })

  it("流错误透出给调用方", async () => {
    const boom = new Error("LLM 熔断")
    mockedStreamChat.mockImplementation(async (_c, _m, cb) => {
      ;(cb as unknown as StreamCb).onError(boom)
    })
    await expect(
      generateStoryDraft({
        framework: framework({ nodes: [node()] }),
        report: baseReport(),
        selectedBranch: branch(),
        llmConfig: llmConfig(),
        useDeepChapterEngine: false,
      }),
    ).rejects.toBe(boom)
  })

  it("空框架：无节点时直接返回空草稿且不调 LLM", async () => {
    const draft = await generateStoryDraft({
      framework: framework({ nodes: [], targetWords: 3000 }),
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      useDeepChapterEngine: false,
    })
    expect(draft.chapters).toEqual([])
    expect(draft.totalWords).toBe(0)
    expect(mockedStreamChat).not.toHaveBeenCalled()
  })

  it("projectPath 存在但显式关闭深章引擎时走轻量流", async () => {
    await generateStoryDraft({
      framework: framework({ nodes: [node()] }),
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      projectPath: "/proj",
      useDeepChapterEngine: false,
    })
    expect(mockedRunDeep).not.toHaveBeenCalled()
    expect(mockedStreamChat).toHaveBeenCalledTimes(1)
  })
})

describe("generateStoryDraft 深章引擎", () => {
  const gates = {
    consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    overall: "pass",
  } as unknown as Awaited<ReturnType<typeof runDeepChapterGeneration>>["decisionGates"]

  it("深章成功：挂载 decisionGates/reviewResults 并触发 thinking 进度", async () => {
    const progress: string[] = []
    mockedRunDeep.mockImplementation(async (_input, cbs) => {
      cbs?.onThinking?.("正在构思开篇钩子与人物动机铺陈0123456789".repeat(5))
      cbs?.onFinalContent?.("  中间稿  ")
      return {
        finalContent: "  深章正文  ",
        taskBrief: "b",
        draftContent: "d",
        reviewResults: [{ kind: "ok" }],
        revised: false,
        decisionGates: gates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      } as unknown as Awaited<ReturnType<typeof runDeepChapterGeneration>>
    })
    const draft = await generateStoryDraft({
      framework: framework({ nodes: [node()] }),
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      projectPath: "/proj",
      onProgress: (l) => progress.push(l),
    })
    expect(mockedRunDeep).toHaveBeenCalledTimes(1)
    expect(mockedStreamChat).not.toHaveBeenCalled()
    expect(draft.chapters[0].content).toBe("深章正文")
    expect(draft.chapters[0].rawContent).toBe("深章正文")
    expect(draft.chapters[0].decisionGates).toBe(gates)
    expect(draft.chapters[0].reviewResults).toEqual([{ kind: "ok" }])
    expect(progress.some((p) => p.includes("[第 1/1 章]"))).toBe(true)
  })

  it("深章抛错时降级回轻量流", async () => {
    mockedRunDeep.mockRejectedValueOnce(new Error("引擎不可用"))
    mockStreamOk("降级正文")
    const draft = await generateStoryDraft({
      framework: framework({ nodes: [node()] }),
      report: baseReport(),
      selectedBranch: branch(),
      llmConfig: llmConfig(),
      projectPath: "/proj",
    })
    expect(mockedRunDeep).toHaveBeenCalledTimes(1)
    expect(mockedStreamChat).toHaveBeenCalledTimes(1)
    expect(draft.chapters[0].content).toBe("降级正文")
    expect(draft.chapters[0].decisionGates).toBeUndefined()
    expect(draft.chapters[0].reviewResults).toBeUndefined()
  })
})
