// @vitest-environment jsdom
/**
 * context-usage — Wave 5 上下文用量快照纯函数测试。
 * - buildContextUsage：预算线直读 + 记忆实测（null/空 store → 0）
 * - computeRingSegments：五段 fraction 归一（maxCtx 兜底 1）
 */
import { describe, expect, it } from "vitest"
import { buildContextUsage, computeRingSegments } from "./context-usage"
import { computeContextBudget } from "./context-budget"
import type { UserMemoryStore } from "./user-memory/types"

function makeStore(prefLengths: number[]): UserMemoryStore {
  return {
    version: "user-memory/1.0",
    preferences: prefLengths.map((len, index) => ({
      id: `upref-${index}`,
      key: `key-${index}`,
      value: "x".repeat(len),
      category: "custom",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    deAiWeights: { categoryBoosts: {}, severityThreshold: "medium", genreOverrides: {} },
    reviewCalibration: { dimensionWeights: {}, severityDeductions: {} },
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("buildContextUsage", () => {
  it("预算线直读 computeContextBudget 输出 + 记忆实测字符数", () => {
    const budget = computeContextBudget(100_000, 3)
    const usage = buildContextUsage(budget, makeStore([10, 20, 30]))
    expect(usage.maxCtx).toBe(100_000)
    expect(usage.memoryChars).toBe(60)
    expect(usage.retrievalChars).toBe(budget.indexBudget)
    expect(usage.graphChars).toBe(
      budget.activeEntitiesBudget.rank0Floor
      + budget.activeEntitiesBudget.rank1CompressibleCap
      + budget.activeEntitiesBudget.rank2CompressibleCap,
    )
    expect(usage.bodyChars).toBe(budget.pageBudget)
    expect(usage.otherChars).toBe(
      Math.max(0, 100_000 - (60 + budget.indexBudget + (budget.activeEntitiesBudget.rank0Floor + budget.activeEntitiesBudget.rank1CompressibleCap + budget.activeEntitiesBudget.rank2CompressibleCap) + budget.pageBudget + budget.responseReserve)),
    )
  })

  it("无 store / 空 preferences → memoryChars 0，其余预算线照常", () => {
    const budget = computeContextBudget(undefined, undefined)
    expect(buildContextUsage(budget, null).memoryChars).toBe(0)
    expect(buildContextUsage(budget, undefined).memoryChars).toBe(0)
    expect(buildContextUsage(budget, makeStore([])).memoryChars).toBe(0)
    expect(buildContextUsage(budget, null).retrievalChars).toBe(budget.indexBudget)
  })

  it("otherChars 不取负（极小窗口 + 超大记忆时钳到 0）", () => {
    const budget = computeContextBudget(1_000, undefined)
    const usage = buildContextUsage(budget, makeStore([500_000]))
    expect(usage.otherChars).toBe(0)
    expect(usage.memoryChars).toBe(500_000)
  })
})

describe("computeRingSegments", () => {
  it("五段顺序固定：记忆/检索/图谱/正文/其他，fraction = chars / maxCtx", () => {
    const budget = computeContextBudget(100_000, 3)
    const usage = buildContextUsage(budget, makeStore([100]))
    const segments = computeRingSegments(usage)
    expect(segments.map((s) => s.key)).toEqual(["memory", "retrieval", "graph", "body", "other"])
    expect(segments.map((s) => s.label)).toEqual(["记忆", "检索", "图谱", "正文", "其他"])
    expect(segments[0].fraction).toBeCloseTo(100 / 100_000, 6)
    expect(segments[2].fraction).toBeCloseTo(usage.graphChars / 100_000, 6)
    expect(segments.every((s) => s.fraction >= 0 && s.fraction <= 1)).toBe(true)
    // 五段合计 = maxCtx − responseReserve（15% 预留不入段，环留白表示）
    const total = segments.reduce((sum, s) => sum + s.fraction, 0)
    expect(total).toBeCloseTo((100_000 - budget.responseReserve) / 100_000, 5)
  })

  it("maxCtx 为 0 时 fraction 兜底（分母 1，不 NaN）", () => {
    const usage = {
      memoryChars: 0,
      retrievalChars: 0,
      graphChars: 0,
      bodyChars: 0,
      otherChars: 0,
      maxCtx: 0,
    }
    const segments = computeRingSegments(usage)
    expect(segments.every((s) => Number.isFinite(s.fraction))).toBe(true)
    expect(segments[0].fraction).toBe(0)
  })
})
