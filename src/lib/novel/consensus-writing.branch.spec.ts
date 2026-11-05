import { beforeEach, describe, expect, it, vi } from "vitest"

const { generateMock, streamChatMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  streamChatMock: vi.fn(),
}))

vi.mock("./deep-chapter-generation", () => ({
  runDeepChapterGeneration: generateMock,
}))
vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
  combineAbortSignals: () => undefined,
}))

import { runDeepChapterGenerationConsensus } from "./consensus-writing"
import type { DeepChapterGenerationInput, DeepChapterGenerationResult } from "./deep-chapter-generation"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * 分支覆盖增补（BRANCH-BRIEF：consensus-writing 20 miss）。只增补，不改既有用例。
 * 禁止 any 断言：输入对象用满足类型约束的最小形状 + 断言式收窄。
 */

function cfg(model: string): LlmConfig {
  return { provider: "claude-code", apiKey: "", model, ollamaUrl: "", customEndpoint: "", maxContextSize: 100000 } as LlmConfig
}

function baseNovelConfig() {
  return {
    consensusEnabled: true,
    consensusWritingModels: ["mA", "mB"],
    consensusReviewModels: {},
    consensusDebateRounds: 1,
    reviewReasoningEffort: "high",
  }
}

function input(overrides: {
  consensusEnabled?: boolean
  writingModels?: string[]
  chapterNumber?: number | undefined
  debateRounds?: number
  /** "omit" 时删除该键，覆盖 ?? 右端 */
  reviewReasoningEffort?: "high" | "omit"
} = {}): DeepChapterGenerationInput {
  const novelConfig: Record<string, unknown> = {
    ...baseNovelConfig(),
    consensusEnabled: overrides.consensusEnabled ?? true,
    consensusWritingModels: overrides.writingModels ?? ["mA", "mB"],
    consensusDebateRounds: overrides.debateRounds ?? 1,
  }
  if (overrides.reviewReasoningEffort === "omit") {
    delete novelConfig["reviewReasoningEffort"]
  }
  const full = {
    projectPath: "P",
    userMessage: "目标",
    userRequest: "目标",
    llmConfig: cfg("base"),
    novelConfig,
  } as unknown as DeepChapterGenerationInput
  if (overrides.chapterNumber === undefined) {
    return full
  }
  return { ...full, chapterNumber: overrides.chapterNumber }
}

function result(content: string): DeepChapterGenerationResult {
  return {
    finalContent: content,
    taskBrief: "tb",
    draftContent: content,
    reviewResults: [],
    revised: false,
    decisionGates: {},
    manualReviewRequired: false,
    retryCount: 0,
  } as unknown as DeepChapterGenerationResult
}

beforeEach(() => {
  vi.clearAllMocks()
  generateMock.mockImplementation(async (inp: DeepChapterGenerationInput) => {
    return result(`draft-${inp.llmConfig.model}`)
  })
  streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
    callbacks.onToken?.('{"score": 9, "rationale": "r"}')
  })
})

describe("共识写作分支增补", () => {
  it("单模型组直通 runDeepChapterGeneration 且不互评", async () => {
    const inp = input({ writingModels: ["mA"] })
    const r = await runDeepChapterGenerationConsensus(inp)
    expect(generateMock).toHaveBeenCalledTimes(1)
    // 单模型直通：原输入对象透传，未做模型覆盖
    expect(generateMock.mock.calls[0]?.[0]).toBe(inp)
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(r.finalContent).toBe("draft-base")
  })

  it("无章节号时评估提示使用「本章」", async () => {
    let seenPrompt = ""
    streamChatMock.mockImplementation(async (_c, messages, callbacks) => {
      const texts = (messages as Array<{ content?: string }>).map((m) => m.content ?? "").join("\n")
      seenPrompt = texts
      callbacks.onToken?.('{"score": 8, "rationale": "好"}')
    })
    const r = await runDeepChapterGenerationConsensus(input({ chapterNumber: undefined }))
    expect(r.finalContent).toContain("draft-")
    expect(seenPrompt).toContain("本章")
  })

  it("缺 reviewReasoningEffort 时默认 high 仍可互评", async () => {
    const r = await runDeepChapterGenerationConsensus(
      input({ writingModels: ["mA", "mB"], reviewReasoningEffort: "omit" }),
    )
    expect(streamChatMock).toHaveBeenCalled()
    expect(r.finalContent).toContain("draft-")
  })

  it("字符串分数经 Number 转换后参与排名", async () => {
    streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onToken?.('{"score": "8.5", "rationale": "可"}')
    })
    const r = await runDeepChapterGenerationConsensus(input({ writingModels: ["mA", "mB"] }))
    expect(r.finalContent).toBe("draft-mA")
  })

  it("缺 rationale 时按空串处理仍可决出胜者", async () => {
    streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onToken?.('{"score": 7}')
    })
    const r = await runDeepChapterGenerationConsensus(input({ writingModels: ["mA", "mB"] }))
    expect(r.finalContent).toBe("draft-mA")
  })

  it("非数值分数抛错后该席位评分作废，平票取首稿", async () => {
    streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onToken?.('{"score": "not-a-number", "rationale": "x"}')
    })
    const r = await runDeepChapterGenerationConsensus(input({ writingModels: ["mA", "mB"] }))
    expect(r.finalContent).toBe("draft-mA")
  })

  it("全席位以非 Error 原因失败时按字符串原因抛错", async () => {
    generateMock.mockRejectedValue("string-fail")
    await expect(
      runDeepChapterGenerationConsensus(input({ writingModels: ["mA", "mB"] })),
    ).rejects.toBe("string-fail")
  })

  it("全席位无原因失败时抛默认共识失败错误", async () => {
    generateMock.mockRejectedValue(undefined)
    await expect(
      runDeepChapterGenerationConsensus(input({ writingModels: ["mA", "mB"] })),
    ).rejects.toThrow("共识生成全部失败")
  })

  it("两轮辩论：第二轮附带他席上轮评分并决出胜者", async () => {
    let calls = 0
    streamChatMock.mockImplementation(async (_c, messages, callbacks) => {
      calls += 1
      const texts = (messages as Array<{ content?: string }>).map((m) => m.content ?? "").join("\n")
      // 候选稿全文决定分数：含 mC 的稿给低分，其余高分 → 胜者应为 mA 或 mB
      const score = texts.includes("draft-mC") ? 4 : 9
      callbacks.onToken?.(JSON.stringify({ score, rationale: `第${calls}次评分` }))
    })
    const inp = input({ writingModels: ["mA", "mB", "mC"], debateRounds: 2 })
    const traces: Array<{ winner: string; debateRounds: number; averageScores: unknown[] }> = []
    const r = await runDeepChapterGenerationConsensus(inp, {}, undefined, undefined, (t) => {
      traces.push(t)
    })
    // 两轮 × 3 席 × 2 他稿 = 12 次互评
    expect(streamChatMock).toHaveBeenCalledTimes(12)
    expect(traces).toHaveLength(1)
    expect(traces[0]?.debateRounds).toBe(2)
    expect(r.finalContent).toBe("draft-mA")
  })

  it("第二轮引用首轮缺失评分时记为 ? 仍可决出胜者", async () => {
    let calls = 0
    streamChatMock.mockImplementation(async (_c, _messages, callbacks) => {
      calls += 1
      // 首轮第 2 次互评（A 评 C）失败 → 次轮 A 评 B 时引用 A→C 缺失，落到 ?? "?"
      if (calls === 2) {
        throw new Error("eval boom")
      }
      callbacks.onToken?.('{"score": 8, "rationale": "稳"}')
    })
    const inp = input({ writingModels: ["mA", "mB", "mC"], debateRounds: 2 })
    const traces: Array<{ winner: string }> = []
    const r = await runDeepChapterGenerationConsensus(inp, {}, undefined, undefined, (t) => {
      traces.push(t)
    })
    // 首轮 6 次中 1 次失败 + 次轮 6 次 = 12 次调用
    expect(streamChatMock).toHaveBeenCalledTimes(12)
    expect(traces).toHaveLength(1)
    expect(r.finalContent).toContain("draft-")
  })
})
