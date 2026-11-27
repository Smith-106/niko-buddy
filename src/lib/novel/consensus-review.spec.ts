import { beforeEach, describe, expect, it, vi } from "vitest"

const { reviewChapterDimensionMock, streamChatMock, buildPromptMock } = vi.hoisted(() => ({
  reviewChapterDimensionMock: vi.fn(),
  streamChatMock: vi.fn(),
  buildPromptMock: vi.fn(),
}))

// reviewChapterDimension/buildDimensionReviewPrompt mock；parseDimensionReviewResult 保持真实实现
vi.mock("./dimension-review-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dimension-review-adapter")>()
  return {
    ...actual,
    reviewChapterDimension: reviewChapterDimensionMock,
    buildDimensionReviewPrompt: buildPromptMock.mockReturnValue("BASE-PROMPT"),
  }
})
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: streamChatMock,
    combineAbortSignals: (...signals: (AbortSignal | undefined)[]) => {
      const list = signals.filter((s): s is AbortSignal => Boolean(s))
      if (list.length === 0) return undefined
      const controller = new AbortController()
      for (const s of list) s.addEventListener("abort", () => controller.abort(), { once: true })
      return controller.signal
    },
  }
})

import { runDimensionConsensus } from "./consensus-review"
import { SIX_REVIEW_DIMENSIONS } from "./dimension-review-adapter"
import { DEFAULT_NOVEL_CONFIG, type LlmConfig } from "@/stores/wiki-store"

function cfg(model: string): LlmConfig {
  return {
    provider: "claude-code",
    apiKey: "",
    model,
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 100000,
  } as LlmConfig
}

const dimension = SIX_REVIEW_DIMENSIONS.thrill

function chapterJson(score: number, summary: string): string {
  return JSON.stringify({ score, status: "pass", summary, issues: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  reviewChapterDimensionMock.mockImplementation(async ({ llmConfig }) => {
    const score = Number(llmConfig.model.replace(/[^\d.]/g, "")) || 5
    return {
      dimensionKey: "thrill",
      score,
      status: "pass",
      summary: `initial-${llmConfig.model}`,
      thinking: "",
      issues: [],
    }
  })
})

describe("runDimensionConsensus", () => {
  it("runs N parallel first-round reviews then debate per seat", async () => {
    // streamChat 真实契约：经 callbacks.onToken 流式输出（debateCall 靠 onToken 累积）
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken?.(chapterJson(7.5, "debated"))
    })
    const out = await runDimensionConsensus({
      models: [cfg("m6"), cfg("m8"), cfg("m9")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    expect(reviewChapterDimensionMock).toHaveBeenCalledTimes(3)
    // 每席位一次辩论调用 = 3 次 streamChat
    expect(streamChatMock).toHaveBeenCalledTimes(3)
    // 辩论后全部 7.5 → 中位 7.5，无分歧
    expect(out.result.score).toBe(7.5)
    expect(out.result.summary).toContain("debated")
    expect(out.disputed).toBe(false)
    // 辩论轮锁定审稿温度 0.15
    for (const call of streamChatMock.mock.calls) {
      expect(call[4]).toMatchObject({ temperature: 0.15 })
    }
  })

  it("single model degrades to pass-through with no debate calls", async () => {
    const out = await runDimensionConsensus({
      models: [cfg("m8.5")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 2,
    })
    expect(reviewChapterDimensionMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(out.result.score).toBe(8.5)
  })

  it("debate parse failure keeps the seat's previous ballot", async () => {
    reviewChapterDimensionMock.mockImplementation(async ({ llmConfig }) => ({
      dimensionKey: "thrill",
      score: llmConfig.model === "mA" ? 6 : 9,
      status: "pass",
      summary: `init-${llmConfig.model}`,
      thinking: "",
      issues: [],
    }))
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken?.("这不是 JSON") // 辩论轮全部解析失败
    })
    const out = await runDimensionConsensus({
      models: [cfg("mA"), cfg("mB")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    // 席位沿用第一轮票 [6,9]
    expect(out.result.score).toBe(7.5)
    expect(out.disputed).toBe(true)
  })

  it("throws when no model is usable", async () => {
    await expect(
      runDimensionConsensus({
        models: [],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 1,
      }),
    ).rejects.toThrow("共识模型均不可用")
    expect(reviewChapterDimensionMock).not.toHaveBeenCalled()
  })

  it("propagates first-round review failure (dimension fails as a whole)", async () => {
    reviewChapterDimensionMock.mockRejectedValueOnce(new Error("stream down"))
    await expect(
      runDimensionConsensus({
        models: [cfg("m1"), cfg("m2")],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 1,
      }),
    ).rejects.toThrow("stream down")
  })
})

describe("辩论席位流中断与 R2-REV-004 强化", () => {
  it("streamChat 触发 onError → 拒绝解析残片、降级沿用上轮票并记 warn（不中断整体）", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      // 即便已流出半截有效 JSON，只要 onError 触发也必须抛出并走降级（不采信残流）
      callbacks.onToken?.(chapterJson(1, "corrupted"))
      callbacks.onError?.(new Error("stream broken"))
    })
    const out = await runDimensionConsensus({
      models: [cfg("m6"), cfg("m8"), cfg("m9")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    // 辩论流中断 → 沿用首轮票（6/8/9 → 中位 8），不被残流 1 分污染
    expect(out.result.score).toBe(8)
  })

  it("透传 skillHookPromptFragments 到首轮与辩论轮，并附加 review taskExtraPrompt", async () => {
    const capturedSysPrompts: string[] = []
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      const sys = (msgs as Array<{ role: string; content: string }>)[0]!.content
      capturedSysPrompts.push(sys)
      callbacks.onToken?.(chapterJson(8.5, "aligned"))
    })
    const novelConfig = {
      ...DEFAULT_NOVEL_CONFIG,
      taskPrompts: {
        ...DEFAULT_NOVEL_CONFIG.taskPrompts,
        review: { extra: "自定义审查红线：严查人物动机断层" },
      },
    }
    const out = await runDimensionConsensus({
      models: [cfg("m7"), cfg("m8")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
      novelConfig,
      skillHookPromptFragments: ["HOOK-FRAG-1"],
    })
    expect(out.result.score).toBe(8.5)
    expect(capturedSysPrompts).toHaveLength(2)
    for (const sys of capturedSysPrompts) {
      expect(sys).toContain("自定义审查红线：严查人物动机断层")
    }
    expect(reviewChapterDimensionMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillHookPromptFragments: ["HOOK-FRAG-1"] }),
    )
    expect(buildPromptMock).toHaveBeenCalledWith(
      expect.anything(),
      "章",
      dimension,
      expect.objectContaining({ skillHookPromptFragments: ["HOOK-FRAG-1"] }),
    )
  })

  it("AbortSignal 取消时立即中止共识并向上抛错（绝不吞掉取消信号继续烧下一轮）", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runDimensionConsensus({
        models: [cfg("m6"), cfg("m8")],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow("已停止生成")
    expect(reviewChapterDimensionMock).not.toHaveBeenCalled()

    // 辩论中途取消：立即抛出并停止第 2 轮
    const midController = new AbortController()
    streamChatMock.mockImplementation(async () => {
      midController.abort()
      const abortErr = new Error("Request cancelled")
      abortErr.name = "AbortError"
      throw abortErr
    })
    await expect(
      runDimensionConsensus({
        models: [cfg("m6"), cfg("m8")],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 3,
        signal: midController.signal,
      }),
    ).rejects.toThrow()
    expect(streamChatMock).toHaveBeenCalledTimes(1) // 首席触发取消后其余席位与后续轮次立即中止，不再继续调用 LLM

    // 辩论非 Error onError 降级 + 无 signal 下抛 AbortError 仍立即上抛
    streamChatMock.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onError?.("raw-debate-error" as unknown as Error)
    }).mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onToken?.(chapterJson(8, "ok"))
    })
    const nonErrOut = await runDimensionConsensus({
      models: [cfg("m6"), cfg("m8")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    expect(nonErrOut.result.score).toBeGreaterThan(0)

    const cancelNoSignal = new Error("Request cancelled")
    cancelNoSignal.name = "AbortError"
    streamChatMock.mockRejectedValueOnce(cancelNoSignal)
    await expect(
      runDimensionConsensus({
        models: [cfg("m6"), cfg("m8")],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 1,
      }),
    ).rejects.toThrow("Request cancelled")
  })

  it("P3-B2: 辩论轮注入有界正典摘要并锁定 canon_audit 温度 0.15", async () => {
    const capturedUserPrompts: string[] = []
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      const userMsg = (msgs as Array<{ role: string; content: string }>).find((m) => m.role === "user")?.content ?? ""
      capturedUserPrompts.push(userMsg)
      callbacks.onToken?.(chapterJson(8.0, "aligned"))
    })

    await runDimensionConsensus({
      models: [cfg("m7"), cfg("m8")],
      dimension: SIX_REVIEW_DIMENSIONS.consistency,
      contextPack: {
        canonRulesBase: "灵气枯竭时代严禁瞬移法术",
        mustAvoid: "不可提前揭露小晴身份",
        outline: "第8章：祠堂核对族谱",
      } as never,
      chapterContent: "章",
      debateRounds: 1,
    })

    expect(capturedUserPrompts).toHaveLength(2)
    for (const p of capturedUserPrompts) {
      expect(p).toContain("【正典约束摘要（互评对齐基线）】")
      expect(p).toContain("灵气枯竭时代严禁瞬移法术")
      expect(p).toContain("不可提前揭露小晴身份")
    }
    for (const call of streamChatMock.mock.calls) {
      expect(call[4]).toMatchObject({ temperature: 0.15 })
    }
  })
})
