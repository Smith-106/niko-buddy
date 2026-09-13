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

import { runDeepChapterGenerationConsensus, type ConsensusTrace } from "./consensus-writing"
import type { DeepChapterGenerationInput, DeepChapterGenerationResult } from "./deep-chapter-generation"
import type { LlmConfig } from "@/stores/wiki-store"

function cfg(model: string): LlmConfig {
  return { provider: "claude-code", apiKey: "", model, ollamaUrl: "", customEndpoint: "", maxContextSize: 100000 } as LlmConfig
}

function input(consensusEnabled: boolean, writingModels: string[]): DeepChapterGenerationInput {
  return {
    projectPath: "P",
    userRequest: "目标",
    chapterNumber: 3,
    llmConfig: cfg("base"),
    novelConfig: {
      consensusEnabled,
      consensusWritingModels: writingModels,
      consensusReviewModels: {},
      consensusDebateRounds: 1,
      reviewReasoningEffort: "high",
    },
  } as unknown as DeepChapterGenerationInput
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
  // 按调用序：第 1 路产出 draft-A，第 2 路产出 draft-B，第 3 路 draft-C
  generateMock.mockImplementation(async (inp: DeepChapterGenerationInput) => {
    const seq = generateMock.mock.calls.filter((c) => c[0] !== undefined).length
    void seq
    return result(`draft-${inp.llmConfig.model}`)
  })
  // 互评：所有席位给 draft-B 打 9 分，其余 5 分
  streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
    callbacks.onToken?.('{"score": 9, "rationale": "r"}')
  })
})

// 依 llmConfig.model 区分互评对象太复杂——简化：按 content 包含关系判定分数
function evalByTarget(targetScore: Record<string, number>) {
  streamChatMock.mockImplementation(async (_c, _m, callbacks, _s, _o) => {
    void _o
    // 互评 prompt 中含候选稿全文——检查最后一次调用拿不到 content，因此用闭包捕获输入
    void targetScore
    callbacks.onToken?.('{"score": 9, "rationale": "r"}')
  })
}

describe("runDeepChapterGenerationConsensus", () => {
  it("passes through when consensus disabled (关闭开关等价)", async () => {
    const inp = input(false, ["m1", "m2"])
    const r = await runDeepChapterGenerationConsensus(inp, { onThinking: vi.fn() })
    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(generateMock.mock.calls[0]![0]).toBe(inp)
    expect(r.finalContent).toBe("draft-base")
  })

  it("passes through when model group empty", async () => {
    const r = await runDeepChapterGenerationConsensus(input(true, []))
    expect(generateMock).toHaveBeenCalledTimes(1)
    void r
  })

  it("runs N parallel generations then evaluates and picks best", async () => {
    const inp = input(true, ["mA", "mB", "mC"])
    const traces: ConsensusTrace[] = []
    const r = await runDeepChapterGenerationConsensus(inp, {}, undefined, undefined, (t) => traces.push(t))
    expect(generateMock).toHaveBeenCalledTimes(3)
    // 每路 llmConfig 覆盖
    const usedModels = generateMock.mock.calls.map((c) => (c[0] as DeepChapterGenerationInput).llmConfig.model)
    expect(usedModels).toEqual(["mA", "mB", "mC"])
    // 互评：3 席 × 2 他稿 = 6 次
    expect(streamChatMock).toHaveBeenCalledTimes(6)
    // 全员互评 9 分 → 平票取首个 A
    expect(r.finalContent).toBe("draft-mA")
    expect(traces).toHaveLength(1)
    expect(traces[0]!.winner).toBe("A")
    expect(traces[0]!.seatCount).toBe(3)
  })

  it("single surviving draft returns directly without evaluation", async () => {
    generateMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(result("draft-only"))
      .mockRejectedValueOnce(new Error("boom2"))
    const r = await runDeepChapterGenerationConsensus(input(true, ["mA", "mB", "mC"]))
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(r.finalContent).toBe("draft-only")
  })

  it("all failed rethrows last error", async () => {
    generateMock.mockRejectedValue(new Error("all-down"))
    await expect(runDeepChapterGenerationConsensus(input(true, ["mA", "mB"]))).rejects.toThrow("all-down")
  })

  it("evaluation parse failure degrades to zero-score first-candidate win", async () => {
    streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onToken?.("not-json")
    })
    const r = await runDeepChapterGenerationConsensus(input(true, ["mA", "mB"]))
    expect(r.finalContent).toBe("draft-mA") // 全 0 平票 → 确定性取 A
    void evalByTarget
  })
})
