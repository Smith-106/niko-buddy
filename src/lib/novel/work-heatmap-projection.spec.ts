/**
 * work-heatmap-projection.spec.ts — 动态工作热力图投影的**可失败**行为证据。
 *
 * 覆盖：空真源不造行、时间分桶确定性、码点序排序、无时间戳条目单列、
 * token/latency 缺值必须是 null（不是 0）、窗口折叠计数、partial 计数、
 * 进度指针窄化、以及「不许把耗时当质量」的 N/A 声明。
 */
import { describe, expect, it } from "vitest"

import {
  WORK_HEATMAP_MAX_BUCKETS,
  WORK_HEATMAP_NOT_APPLICABLE,
  parseTimestamp,
  projectWorkHeatmap,
  toWorkHeatmapInput,
} from "./work-heatmap-projection"

const HOUR = 60 * 60 * 1000
const T0 = Date.parse("2026-10-18T00:00:00.000Z")

function metric(overrides: Record<string, unknown> = {}) {
  return {
    stage: "write_llm",
    tokenCost: 100,
    latencyMs: 1000,
    partial: false,
    chapterId: "ch-1",
    timestamp: new Date(T0).toISOString(),
    ...overrides,
  } as never
}

describe("空真源：不造 0 行，逐条 N/A", () => {
  it("无 stage_metrics → rows/buckets 空、missingSources 指出真源、N/A 三条齐全", () => {
    const p = projectWorkHeatmap({})
    expect(p.rows).toEqual([])
    expect(p.buckets).toEqual([])
    expect(p.maxCount).toBe(0)
    expect(p.missingSources.length).toBeGreaterThan(0)
    expect(p.missingSources[0]).toContain("stage_metrics")
    expect(p.notApplicable.map((n) => n.id)).toEqual(["chapter-axis", "live-stream", "quality-score"])
    expect(WORK_HEATMAP_NOT_APPLICABLE).toHaveLength(3)
  })

  it("toWorkHeatmapInput(null) → null（面板据此渲染空态，而不是空图）", () => {
    expect(toWorkHeatmapInput(null)).toBeNull()
  })
})

describe("时间分桶与聚合", () => {
  it("同桶两条同 stage → count=2、token 求和；桶数 = maxBuckets 且升序", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ timestamp: new Date(T0 + 10 * 60 * 1000).toISOString(), tokenCost: 30 }),
          metric({ timestamp: new Date(T0 + 20 * 60 * 1000).toISOString(), tokenCost: 70 }),
        ],
      },
      { now: T0 + 30 * 60 * 1000, maxBuckets: 2 },
    )
    expect(p.buckets).toHaveLength(2)
    expect(p.buckets[0]!.start < p.buckets[1]!.start).toBe(true)
    const row = p.rows.find((r) => r.stage === "write_llm")
    expect(row).toBeTruthy()
    expect(row!.count).toBe(2)
    expect(row!.tokenCost).toBe(100)
    const filled = row!.cells.filter((c) => c.count > 0)
    expect(filled).toHaveLength(1)
    expect(filled[0]!.count).toBe(2)
    expect(filled[0]!.tokenCost).toBe(100)
  })

  it("缺 tokenCost / latencyMs 的条目 → 该格是 null 而不是 0（不许把没有当零）", () => {
    const p = projectWorkHeatmap(
      { stageMetrics: [metric({ tokenCost: undefined, latencyMs: undefined })] },
      { now: T0 + HOUR },
    )
    const cell = p.rows[0]!.cells.find((c) => c.count > 0)!
    expect(cell.tokenCost).toBeNull()
    expect(cell.latencyMs).toBeNull()
    expect(p.rows[0]!.tokenCost).toBeNull()
  })

  it("无时间戳条目 → 进 undated 且不进时间轴；不影响 buckets", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ stage: "write_llm", timestamp: undefined }),
          metric({ stage: "six_dim", timestamp: "not-a-date" }),
          metric({ stage: "six_dim", timestamp: new Date(T0).toISOString() }),
        ],
      },
      { now: T0 + HOUR, maxBuckets: 2 },
    )
    expect(p.undated).toEqual([
      { stage: "six_dim", count: 1 },
      { stage: "write_llm", count: 1 },
    ])
    // undated 不计入任何格子
    expect(p.rows.reduce((s, r) => s + r.count, 0)).toBe(1)
    expect(p.missingSources.some((m) => m.includes("时间戳"))).toBe(true)
  })

  it("超出窗口的条目 → foldedCount 计数且给 N/A 说明（不静默丢）", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ timestamp: new Date(T0).toISOString() }),
          metric({ timestamp: new Date(T0 + 10 * HOUR).toISOString() }),
        ],
      },
      { now: T0 + 10 * HOUR, maxBuckets: 2 },
    )
    expect(p.foldedCount).toBe(1)
    expect(p.missingSources.some((m) => m.includes("折叠"))).toBe(true)
    expect(p.totals.entries).toBe(2)
    expect(p.rows.reduce((s, r) => s + r.count, 0)).toBe(1)
  })

  it("partial 计数按 stage 汇总", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ partial: true }),
          metric({ partial: true, timestamp: new Date(T0 + HOUR).toISOString() }),
          metric({ partial: false }),
        ],
      },
      { now: T0 + HOUR, maxBuckets: 3 },
    )
    expect(p.rows[0]!.partialCount).toBe(2)
    expect(p.totals.partialCount).toBe(2)
  })
})

describe("确定性与排序", () => {
  it("stage 行按码点升序；同输入两次投影深等", () => {
    const input = {
      stageMetrics: [
        metric({ stage: "write_llm" }),
        metric({ stage: "accept" }),
        metric({ stage: "Pack" }),
      ],
    }
    const a = projectWorkHeatmap(input, { now: T0 + HOUR, maxBuckets: 2 })
    const b = projectWorkHeatmap(input, { now: T0 + HOUR, maxBuckets: 2 })
    expect(a).toEqual(b)
    expect(a.rows.map((r) => r.stage)).toEqual(["Pack", "accept", "write_llm"])
  })

  it("未注入 now 时用最大时间戳做锚点（纯函数、不读时钟）", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ timestamp: new Date(T0).toISOString() }),
          metric({ timestamp: new Date(T0 + 5 * HOUR).toISOString() }),
        ],
      },
      { maxBuckets: 2 },
    )
    expect(p.buckets).toHaveLength(2)
    expect(p.buckets[1]!.end).toBe(new Date(T0 + 5 * HOUR).toISOString())
  })

  it("maxBuckets 上限被尊重（默认 24）", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      metric({ timestamp: new Date(T0 + i * HOUR).toISOString() }),
    )
    const p = projectWorkHeatmap({ stageMetrics: many }, { now: T0 + 39 * HOUR })
    expect(p.buckets).toHaveLength(WORK_HEATMAP_MAX_BUCKETS)
    // 窗口是闭区间 [windowStart, anchor]：恰在左端点的那条仍算窗内，故折叠数 = 40 - 24 - 1。
    expect(p.foldedCount).toBe(40 - WORK_HEATMAP_MAX_BUCKETS - 1)
    expect(p.foldedNewerCount).toBe(0)
  })
})

describe("桶标签与折叠文案的诚实性（回归锁）", () => {
  it("锚点不在整点时，标签是桶真实起点（09:37Z），不是 09:00Z", () => {
    const anchorMs = Date.parse("2026-10-18T10:37:00.000Z")
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ timestamp: new Date(anchorMs - 60 * 60 * 1000).toISOString(), stage: "a" }),
        ],
      },
      { now: anchorMs, maxBuckets: 2 },
    )
    const last = p.buckets[p.buckets.length - 1]!
    expect(last.label).toMatch(/^09:37Z$/)
    // 标签必须与真实起点一致（不允许把起点谎报成整点）
    const start = new Date(last.start)
    const hh = String(start.getUTCHours()).padStart(2, "0")
    const mm = String(start.getUTCMinutes()).padStart(2, "0")
    expect(last.label).toBe(`${hh}:${mm}Z`)
  })

  it("now 早于某些条目 → 计入 foldedNewerCount，文案写「晚于」而不是「早于」", () => {
    const p = projectWorkHeatmap(
      {
        stageMetrics: [
          metric({ timestamp: new Date(T0).toISOString() }),
          metric({ timestamp: new Date(T0 + 10 * HOUR).toISOString() }),
        ],
      },
      { now: T0, maxBuckets: 2 },
    )
    expect(p.foldedNewerCount).toBe(1)
    expect(p.foldedCount).toBe(0)
    expect(p.missingSources.some((m) => m.includes("晚于"))).toBe(true)
    expect(p.missingSources.some((m) => m.includes("早于"))).toBe(false)
  })

  it("全部条目都在窗外时仍给折叠说明，且不会说成「没有时间戳」", () => {
    const p = projectWorkHeatmap(
      { stageMetrics: [metric({ timestamp: new Date(T0).toISOString() })] },
      { now: T0 + 100 * HOUR, maxBuckets: 2 },
    )
    expect(p.rows).toHaveLength(0)
    expect(p.foldedCount).toBe(1)
    expect(p.missingSources.some((m) => m.includes("折叠"))).toBe(true)
    expect(p.missingSources.some((m) => m.includes("没有一条带可解析时间戳"))).toBe(false)
  })
})

describe("进度指针窄化", () => {
  it("toWorkHeatmapInput 只取窄化字段；非有限数字变 null", () => {
    const input = toWorkHeatmapInput({
      status: "running",
      active_step_index: 3,
      updated_at: "2026-10-18T00:00:00.000Z",
      current_task: { chapter_number: 12 },
      stage_metrics: [metric()],
    })
    expect(input).toEqual({
      status: "running",
      activeStepIndex: 3,
      updatedAt: "2026-10-18T00:00:00.000Z",
      currentChapterNumber: 12,
      stageMetrics: [metric()],
    })

    const bad = toWorkHeatmapInput({
      status: undefined,
      active_step_index: Number.NaN,
      updated_at: undefined,
      current_task: { chapter_number: "12" },
      stage_metrics: undefined,
    })
    expect(bad).toEqual({
      status: null,
      activeStepIndex: null,
      updatedAt: null,
      currentChapterNumber: null,
      stageMetrics: [],
    })
  })

  it("progress 字段在投影里原样透出，缺失为 null（不冒充 0）", () => {
    const p = projectWorkHeatmap({ statusMetrics: undefined, stageMetrics: [metric()] } as never, {
      now: T0 + HOUR,
    })
    expect(p.progress.status).toBeNull()
    expect(p.progress.activeStepIndex).toBeNull()
    expect(p.progress.currentChapterNumber).toBeNull()
  })
})

describe("parseTimestamp 边界", () => {
  it("接受 ISO 与毫秒数，拒绝空串/非法/NaN", () => {
    expect(parseTimestamp("2026-10-18T00:00:00.000Z")).toBe(T0)
    expect(parseTimestamp(T0)).toBe(T0)
    expect(parseTimestamp("")).toBeNull()
    expect(parseTimestamp("x")).toBeNull()
    expect(parseTimestamp(Number.NaN)).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
  })
})
