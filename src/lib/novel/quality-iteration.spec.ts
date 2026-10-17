import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_QUALITY_BUDGET,
  QUALITY_DIMS,
  buildQualityRunEvents,
  buildRevisionBrief,
  median,
  runQualityIteration,
  scoreChapter,
  type DimensionScores,
} from "./quality-iteration"
import { appendRunEvents, createRunEventLedger } from "./run-event-ledger"

const LOW: DimensionScores = { thrill: 7, consistency: 7.5, pacing: 6.5, character: 7, continuity: 9, pull: 7 }
const HIGH: DimensionScores = { thrill: 9.2, consistency: 9.1, pacing: 9.0, character: 9.3, continuity: 9.2, pull: 9.0 }

describe("median / scoreChapter", () => {
  it("median 取中位并保留两位", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
    expect(median([1.111, 2.222, 3.333])).toBe(2.22)
  })

  it("六维全达标才算 pass，缺维度不放行", () => {
    expect(scoreChapter(HIGH).pass).toBe(true)
    const partial = scoreChapter({ ...HIGH, pull: undefined })
    expect(partial.pass).toBe(false)
    expect(partial.missing).toEqual(["pull"])
    expect(partial.median).toBeGreaterThanOrEqual(9)
  })

  it("weak 按缺口降序，缺口为 0 的维度不计入", () => {
    const score = scoreChapter({ ...LOW, continuity: 9.5 })
    expect(score.weak.map((row) => row.key)).toEqual(["pacing", "thrill", "character", "pull", "consistency"])
    expect(score.weak[0].gap).toBeCloseTo(2.5, 5)
    expect(score.pass).toBe(false)
  })

  it("中位达标但存在弱维时仍不放行（避免被高分维度掩盖）", () => {
    const skewed = { thrill: 10, consistency: 10, pacing: 10, character: 10, continuity: 10, pull: 6 }
    const score = scoreChapter(skewed)
    expect(score.median).toBe(10)
    expect(score.pass).toBe(false)
  })
})

describe("buildRevisionBrief", () => {
  it("只点名未达标维度并禁止牺牲一致性", () => {
    const brief = buildRevisionBrief(scoreChapter(LOW))
    expect(brief).toContain("thrill")
    expect(brief).toContain("pacing")
    expect(brief).toContain("Consistency")
    expect(brief).toContain("9")
  })

  it("缺维度时要求补齐", () => {
    const brief = buildRevisionBrief(scoreChapter({ ...HIGH, pull: undefined }))
    expect(brief).toContain("缺少评分")
    expect(brief).toContain("pull")
  })
})

describe("runQualityIteration", () => {
  it("评分低 → 定向重写 → 评分升高并达标", async () => {
    const score = vi
      .fn<(content: string) => Promise<DimensionScores>>()
      .mockResolvedValueOnce(LOW)
      .mockResolvedValueOnce(HIGH)
    const revise = vi.fn(async (content: string, brief: string) => `${content}（已定向重写:${brief.length}）`)
    const onRound = vi.fn()

    const result = await runQualityIteration({ content: "第一版草稿", score, revise, onRound })

    expect(result.ok).toBe(true)
    expect(result.stopReason).toBe("target")
    expect(result.content.startsWith("第一版草稿（已定向重写:")).toBe(true)
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0].improved).toBe(true)
    expect(result.history.map((h) => h.median)).toEqual([7, 9.15])
    expect(onRound).toHaveBeenCalledTimes(1)
    // 重写指令按缺口点名最弱维度
    expect(String(revise.mock.calls[0][1])).toContain("pacing")
  })

  it("重写没有实质提升时立即停止并保留历史最佳稿", async () => {
    const score = vi
      .fn<(content: string) => Promise<DimensionScores>>()
      .mockResolvedValueOnce(LOW)
      .mockResolvedValueOnce(LOW)
    const result = await runQualityIteration({
      content: "原稿",
      score,
      revise: async (content) => `${content}+改`,
    })
    expect(result.ok).toBe(false)
    expect(result.stopReason).toBe("no-improvement")
    expect(result.content).toBe("原稿")
    expect(result.rounds).toHaveLength(1)
  })

  it("轮次预算耗尽即停止", async () => {
    let index = 0
    const score = vi.fn(async () => {
      index += 1
      return { ...LOW, thrill: 7 + index * 0.2, pacing: 7 + index * 0.2 }
    })
    const result = await runQualityIteration({
      content: "稿",
      score,
      revise: async (content) => `${content}~`,
      budget: { maxRounds: 2 },
    })
    expect(result.stopReason).toBe("budget")
    expect(result.rounds).toHaveLength(2)
    expect(result.ok).toBe(false)
  })

  it("首轮评分失败时返回 score-error 且不改稿", async () => {
    const result = await runQualityIteration({
      content: "原稿",
      score: async () => {
        throw new Error("模型挂了")
      },
      revise: async (content) => content,
    })
    expect(result.stopReason).toBe("score-error")
    expect(result.content).toBe("原稿")
    expect(result.ok).toBe(false)
  })

  it("首轮即达标则不触发重写", async () => {
    const revise = vi.fn(async (content: string) => content)
    const result = await runQualityIteration({ content: "好稿", score: async () => HIGH, revise })
    expect(result.stopReason).toBe("target")
    expect(result.ok).toBe(true)
    expect(revise).not.toHaveBeenCalled()
  })
})

describe("buildQualityRunEvents", () => {
  it("产出 gate-run/retry/accept 事件并可写入账本", async () => {
    const result = await runQualityIteration({
      content: "草稿",
      score: vi
        .fn<(content: string) => Promise<DimensionScores>>()
        .mockResolvedValueOnce(LOW)
        .mockResolvedValueOnce(HIGH),
      revise: async (content) => `${content}!`,
    })
    const events = buildQualityRunEvents(result, { runId: "run-1", chapterId: 12 })
    expect(events.map((e) => e.kind)).toEqual(["gate-run", "gate-run", "retry", "accept"])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    expect(events[0].payload).toMatchObject({ round: 0, pass: false })
    expect(events[3].payload).toMatchObject({ stopReason: "target", ok: true })

    const ledger = appendRunEvents(createRunEventLedger(), events)
    expect(ledger.events).toHaveLength(4)
    expect(ledger.events[2].kind).toBe("retry")
  })

  it("未达标时收口为 stage 事件", async () => {
    const result = await runQualityIteration({
      content: "草稿",
      score: async () => LOW,
      revise: async (content) => content,
      budget: { maxRounds: 1 },
    })
    const events = buildQualityRunEvents(result, { runId: "run-2" })
    expect(events[events.length - 1].kind).toBe("stage")
    expect(events[events.length - 1].payload).toMatchObject({ ok: false })
  })
})

describe("默认预算", () => {
  it("与 L9 硬门一致：目标中位 9.0、最多 3 轮", () => {
    expect(DEFAULT_QUALITY_BUDGET.minMedian).toBe(9.0)
    expect(DEFAULT_QUALITY_BUDGET.maxRounds).toBe(3)
    expect(QUALITY_DIMS).toHaveLength(6)
  })
})
