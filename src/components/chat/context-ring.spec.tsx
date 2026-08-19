// @vitest-environment jsdom
/**
 * ContextRing — Wave 5 上下文用量圆环组件测试。
 * - SVG 分段 stroke-dasharray / aria-label 断言
 * - 分段几何纯函数 computeRingGeometry（段序、offset 递增、gap 留白）
 * - 全零用量不 NaN 降级渲染
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ContextRing, computeRingGeometry } from "./context-ring"
import { buildContextUsage } from "@/lib/context-usage"
import { computeContextBudget } from "@/lib/context-budget"
import type { UserMemoryStore } from "@/lib/user-memory/types"

function makeStore(prefLengths: number[]): UserMemoryStore {
  return {
    version: 1,
    preferences: prefLengths.map((len, index) => ({
      id: `upref-${index}`,
      key: `key-${index}`,
      value: "x".repeat(len),
      category: "general",
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
    deAiWeights: { categoryBoosts: {}, severityThreshold: "medium" },
    reviewCalibration: { severityThreshold: "medium", categoryBoosts: {} },
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

const USAGE = buildContextUsage(computeContextBudget(100_000, 3), makeStore([100]))

afterEach(() => {
  cleanup()
})

describe("computeRingGeometry", () => {
  it("五段顺序固定，dashoffset 沿圆环递增", () => {
    const geometry = computeRingGeometry(USAGE)
    expect(geometry.map((s) => s.key)).toEqual(["memory", "retrieval", "graph", "body", "other"])
    expect(geometry.map((s) => s.label)).toEqual(["记忆", "检索", "图谱", "正文", "其他"])
    expect(geometry[0].dashoffset).toBe(0)
    for (let i = 1; i < geometry.length; i++) {
      expect(geometry[i].dashoffset).toBeLessThan(geometry[i - 1].dashoffset)
    }
    expect(geometry.every((s) => s.dasharray.split(" ").every((n) => Number.isFinite(Number(n))))).toBe(true)
  })

  it("fraction 为 0 的段不产生负 dash（全零用量降级）", () => {
    const zero = {
      memoryChars: 0,
      retrievalChars: 0,
      graphChars: 0,
      bodyChars: 0,
      otherChars: 0,
      maxCtx: 0,
    }
    const geometry = computeRingGeometry(zero)
    expect(geometry.every((s) => Number(s.dasharray.split(" ")[0]) >= 0)).toBe(true)
    expect(geometry.every((s) => Number.isFinite(s.dashoffset))).toBe(true)
  })
})

describe("ContextRing", () => {
  it("渲染五段 circle + 图例百分比 + 无障碍 aria-label", () => {
    render(<ContextRing usage={USAGE} />)
    expect(screen.getByTestId("context-ring")).toBeTruthy()
    const svg = screen.getByTestId("context-ring-svg")
    const circles = svg.querySelectorAll("circle[data-segment]")
    expect(circles).toHaveLength(5)
    expect(circles[0].getAttribute("data-segment")).toBe("memory")
    expect(circles[0].getAttribute("stroke")).toBeTruthy()
    expect(circles[0].getAttribute("stroke-dasharray")).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?$/)
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("上下文用量")
    expect(screen.getByText("记忆")).toBeTruthy()
    expect(screen.getByText("其他")).toBeTruthy()
  })

  it("size prop 控制 svg 宽高", () => {
    render(<ContextRing usage={USAGE} size={200} />)
    const svg = screen.getByTestId("context-ring-svg")
    expect(svg.getAttribute("width")).toBe("200")
    expect(svg.getAttribute("height")).toBe("200")
  })
})
