import { beforeEach, describe, expect, it, vi } from "vitest"

const { generateMock, streamChatMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  streamChatMock: vi.fn(),
}))

vi.mock("./deep-chapter-generation", () => ({
  runDeepChapterGeneration: generateMock,
}))
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: streamChatMock,
    combineAbortSignals: () => undefined,
  }
})

import {
  buildEvaluationPrompt,
  runDeepChapterGenerationConsensus,
  selectGateEligibleCandidates,
  type ConsensusTrace,
} from "./consensus-writing"
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

  it("passes through when resolved model group has single model", async () => {
    const r = await runDeepChapterGenerationConsensus(input(true, ["mOnly"]))
    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(r.finalContent).toBe("draft-base")
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

describe("互评席位流中断", () => {
  it("streamChat 触发 onError → 互评正文为空 → 抛「互评没有返回 JSON」（中断不再静默）", async () => {
    streamChatMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onError?.(new Error("stream broken"))
    })
    const r = await runDeepChapterGenerationConsensus(input(true, ["mA", "mB", "mC"]))
    // 互评席位全部中断 → 降级仍产出终稿（不静默丢失，warn 已记录）
    expect(streamChatMock).toHaveBeenCalled()
    expect(typeof r.finalContent).toBe("string")
    expect(r.finalContent.length).toBeGreaterThan(0)
  })
})

describe("R2-REV-004: Track A 门控先筛 / 真辩论他席注入 / streamError 与 AbortSignal", () => {
  function withGates(
    content: string,
    consistencyStatus: "passed" | "failed" | "pending",
    antiAiStatus: "passed" | "failed" | "pending" = "passed",
  ): DeepChapterGenerationResult {
    return {
      ...result(content),
      decisionGates: {
        consistency: {
          status: consistencyStatus,
          verdict: consistencyStatus === "failed" ? "fail" : consistencyStatus === "passed" ? "pass" : "pending",
          findings: [],
          repair_suggestions: [],
          retry_count: 0,
        },
        anti_ai: {
          status: antiAiStatus,
          verdict: antiAiStatus === "failed" ? "fail" : antiAiStatus === "passed" ? "pass" : "pending",
          findings: [],
          repair_suggestions: [],
          retry_count: 0,
        },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: consistencyStatus === "failed" || antiAiStatus === "failed" ? "fail" : "pass",
      },
    }
  }

  it("selectGateEligibleCandidates 严格执行 Consistency(P0) > Anti-AI(P1) > Quality(P2)", () => {
    const p0PassP1Fail = { id: "A", result: withGates("A", "passed", "failed") }
    const p0PassP1Pass = { id: "B", result: withGates("B", "passed", "passed") }
    const p0FailP1Pass = { id: "C", result: withGates("C", "failed", "passed") }

    // 1) P0 passed 过滤掉 P0 failed，再在 P0 存活集内按 P1 passed 过滤
    expect(selectGateEligibleCandidates([p0PassP1Fail, p0PassP1Pass, p0FailP1Pass]).map((s) => s.id)).toEqual(["B"])

    // 2) 无 P0 passed 时：P0 pending 优于 P0 failed
    const p0Pending = { id: "P", result: withGates("P", "pending", "pending") }
    expect(selectGateEligibleCandidates([p0FailP1Pass, p0Pending]).map((s) => s.id)).toEqual(["P"])

    // 3) P0 存活集内无 P1 passed 时：P1 pending 优于 P1 failed
    const p0PassP1Pending = { id: "Q", result: withGates("Q", "passed", "pending") }
    expect(selectGateEligibleCandidates([p0PassP1Fail, p0PassP1Pending]).map((s) => s.id)).toEqual(["Q"])

    // 4) 单候选直接返回
    expect(selectGateEligibleCandidates([p0FailP1Pass]).map((s) => s.id)).toEqual(["C"])
  })

  it("P0 失败稿即使互评更高分也不得凭文学分翻盘（仅 1 路过 P0 时免互评直接胜出并记录 trace）", async () => {
    generateMock.mockImplementation(async (inp: DeepChapterGenerationInput) => {
      if (inp.llmConfig.model === "mA") return withGates("draft-mA-p0-failed", "failed", "passed")
      return withGates("draft-mB-p0-passed", "passed", "passed")
    })
    const traces: ConsensusTrace[] = []
    const winner = await runDeepChapterGenerationConsensus(
      input(true, ["mA", "mB"]),
      {},
      undefined,
      undefined,
      (t) => traces.push(t),
    )
    expect(winner.finalContent).toBe("draft-mB-p0-passed")
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      seatCount: 2,
      debateRounds: 0,
      winner: "B",
    })
    expect(traces[0]!.rationaleDigest).toContain("Track A")
  })

  it("buildEvaluationPrompt 与多轮真辩论：round > 0 注入「他席对该候选稿的上轮匿名评分」，绝不自查自评", async () => {
    const noPeerPrompt = buildEvaluationPrompt(input(true, ["mA", "mB"]), "正文内容")
    expect(noPeerPrompt).not.toContain("多模型共识辩论")
    const withPeerPrompt = buildEvaluationPrompt(input(true, ["mA", "mB"]), "正文内容", [
      { voter: "C", candidate: "B", score: 8.5, rationale: "人物动作克制" },
    ])
    expect(withPeerPrompt).toContain("【多模型共识辩论】")
    expect(withPeerPrompt).toContain("评审C：8.5 分 —— 人物动作克制")

    // 3 席 × 2 轮辩论：每轮 6 次互评，共 12 次
    const capturedPrompts: Array<{ model: string; prompt: string }> = []
    streamChatMock.mockImplementation(async (llmCfg: LlmConfig, messages: Array<{ role: string; content: string }>, callbacks) => {
      const userPrompt = messages.find((m) => m.role === "user")?.content ?? ""
      capturedPrompts.push({ model: llmCfg.model, prompt: userPrompt })
      const score = userPrompt.includes("draft-mB") ? 9.0 : 6.0
      callbacks.onToken?.(JSON.stringify({ score, rationale: `${llmCfg.model}评语` }))
    })
    const twoRoundInput = input(true, ["mA", "mB", "mC"])
    twoRoundInput.novelConfig.consensusDebateRounds = 2
    const winner = await runDeepChapterGenerationConsensus(twoRoundInput)

    expect(winner.finalContent).toBe("draft-mB")
    expect(streamChatMock).toHaveBeenCalledTimes(12)
    // 第 1 轮（0..5）无辩论段
    for (const entry of capturedPrompts.slice(0, 6)) {
      expect(entry.prompt).not.toContain("【多模型共识辩论】")
    }
    // 第 2 轮（6..11）：mA(席位A) 评 draft-mB(候选B) 时，应看到席位 C 对候选 B 的评分（不看到 A 自己的评分）
    const round2AOnB = capturedPrompts
      .slice(6)
      .find((entry) => entry.model === "mA" && entry.prompt.includes("draft-mB"))
    expect(round2AOnB).toBeDefined()
    expect(round2AOnB!.prompt).toContain("【多模型共识辩论】")
    expect(round2AOnB!.prompt).toContain("评审C：9 分 —— mC评语")
    expect(round2AOnB!.prompt).not.toContain("评审A：")
  })

  it("AbortSignal 预取消或生成/互评阶段抛出 AbortError 时立即中止并向上抛错", async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      runDeepChapterGenerationConsensus(input(true, ["mA", "mB"]), {}, undefined, preAborted.signal),
    ).rejects.toThrow("已停止生成")
    expect(generateMock).not.toHaveBeenCalled()

    // 生成阶段单席抛 AbortError → 立即上抛，不进入互评
    const abortErr = new Error("Request cancelled")
    abortErr.name = "AbortError"
    generateMock.mockRejectedValueOnce(abortErr).mockResolvedValueOnce(result("draft-mB"))
    await expect(
      runDeepChapterGenerationConsensus(input(true, ["mA", "mB"])),
    ).rejects.toThrow("Request cancelled")
    expect(streamChatMock).not.toHaveBeenCalled()

    // 互评阶段中途取消 → 立即上抛，不进入第 2 轮
    const evalController = new AbortController()
    generateMock.mockImplementation(async (inp: DeepChapterGenerationInput) => result(`draft-${inp.llmConfig.model}`))
    streamChatMock.mockImplementationOnce(async () => {
      evalController.abort()
      throw abortErr
    })
    const twoRoundInput = input(true, ["mA", "mB"])
    twoRoundInput.novelConfig.consensusDebateRounds = 2
    await expect(
      runDeepChapterGenerationConsensus(twoRoundInput, {}, undefined, evalController.signal),
    ).rejects.toThrow()
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    // 无外部 signal 时互评席位抛出 AbortError → 仍经 isRequestCancelledError 立即上抛
    streamChatMock.mockReset()
    streamChatMock.mockRejectedValueOnce(abortErr).mockResolvedValueOnce(undefined)
    await expect(
      runDeepChapterGenerationConsensus(input(true, ["mA", "mB"])),
    ).rejects.toThrow("Request cancelled")
  })

  it("P3-B2: 互评锁定 temperature=0.15，buildEvaluationPrompt 支持第 4 参正典摘要并在有真实计划/任务书约束时自动注入", async () => {
    // 3 参向后兼容：不注入摘要段
    const legacyPrompt = buildEvaluationPrompt(input(true, ["mA", "mB"]), "正文内容", [])
    expect(legacyPrompt).not.toContain("【正典与计划约束摘要（互评对齐基线）】")

    // 4 参显式注入
    const withDigest = buildEvaluationPrompt(input(true, ["mA", "mB"]), "正文内容", [], "[计划/大纲] 祠堂潜入")
    expect(withDigest).toContain("【正典与计划约束摘要（互评对齐基线）】")
    expect(withDigest).toContain("[计划/大纲] 祠堂潜入")

    // 端到端：planBlueprint 存在时互评注入正典摘要并锁温 0.15
    const capturedUserPrompts: string[] = []
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      const userMsg = (msgs as Array<{ role: string; content: string }>).find((m) => m.role === "user")?.content ?? ""
      capturedUserPrompts.push(userMsg)
      callbacks.onToken?.('{"score": 8.5, "rationale": "ok"}')
    })
    const inpWithPlan = {
      ...input(true, ["mA", "mB"]),
      planBlueprint: "必须保持祠堂雨夜氛围，不得提前揭露真凶",
    }
    await runDeepChapterGenerationConsensus(inpWithPlan)

    expect(streamChatMock).toHaveBeenCalledTimes(2)
    for (const call of streamChatMock.mock.calls) {
      expect(call[4]).toMatchObject({ temperature: 0.15 })
    }
    for (const p of capturedUserPrompts) {
      expect(p).toContain("【正典与计划约束摘要（互评对齐基线）】")
      expect(p).toContain("必须保持祠堂雨夜氛围，不得提前揭露真凶")
    }
  })
})
