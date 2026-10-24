// @vitest-environment jsdom
/** 动态工作热力图面板：只读渲染 + 进度指针 + 空态/错误态 + 暂无声明三条。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { WorkHeatmapPanel } from "./work-heatmap-panel"
import { projectWorkHeatmap } from "@/lib/novel"

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
      selector({ project: { path: "C:/proj" } }),
  }
})

const T0 = Date.parse("2026-10-18T00:00:00.000Z")

function projection() {
  return projectWorkHeatmap(
    {
      status: "running",
      activeStepIndex: 2,
      updatedAt: "2026-10-18T00:30:00.000Z",
      currentChapterNumber: 7,
      stageMetrics: [
        { stage: "write_llm", tokenCost: 900, latencyMs: 5000, timestamp: new Date(T0 + 10 * 60 * 1000).toISOString() },
        { stage: "write_llm", tokenCost: 100, latencyMs: 1000, timestamp: new Date(T0 + 20 * 60 * 1000).toISOString() },
        { stage: "six_dim", tokenCost: 50, latencyMs: 200, partial: true, timestamp: new Date(T0 + 20 * 60 * 1000).toISOString() },
      ],
    },
    { now: T0 + 30 * 60 * 1000, maxBuckets: 2 },
  )
}

afterEach(cleanup)

describe("有数据：渲染阶段行与时间桶", () => {
  it("两个 stage 行都在，格子带 data-count，合计正确", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-panel")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-row-write_llm")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-row-six_dim")).toBeTruthy()
    const filled = screen
      .getAllByTestId(/^work-heatmap-cell-/)
      .filter((el) => Number(el.getAttribute("data-count")) > 0)
    expect(filled.length).toBeGreaterThan(0)
    expect(filled.reduce((sum, el) => sum + Number(el.getAttribute("data-count")), 0)).toBe(3)
  })

  it("进度指针渲染真实值（步骤=2、章=7 精确匹配，不靠碰巧出现的数字）", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    const progress = screen.getByTestId("work-heatmap-progress").textContent ?? ""
    expect(progress).toContain("running")
    // 精确口径：步骤 2、当前章 7（用「步骤 2」「第 7」形式断言，避免从别的数字里蒙中）
    expect(progress).toMatch(/步骤\s*2(?![0-9])/)
    expect(progress).toMatch(/(?:第\s*7\s*章|章\s*7(?![0-9]))/)
  })

  it("partial 计数出现在行合计里", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-row-six_dim").textContent).toContain("partial 1")
  })
})

describe("空态与暂无声明：不画空网格", () => {
  it("投影为空 → 空态文案出现，且没有网格", () => {
    render(<WorkHeatmapPanel projection={projectWorkHeatmap({})} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-empty")).toBeTruthy()
    expect(screen.queryByTestId("work-heatmap-grid")).toBeNull()
  })

  it("三条不适用声明都渲染（章节轴/实时流/质量分）", () => {
    render(<WorkHeatmapPanel projection={projectWorkHeatmap({})} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-na-chapter-axis")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-na-live-stream")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-na-quality-score")).toBeTruthy()
    // 「不是事件流」必须写明，不能假装流式
    expect(screen.getByTestId("work-heatmap-scope").textContent).toContain("不是事件流")
  })
})

describe("装载器：错误态不覆盖数据、null 给显式空态文案", () => {
  it("loader 抛错 → work-heatmap-error 出现", async () => {
    const loader = vi.fn(async () => {
      throw new Error("boom")
    })
    render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => {
      expect(screen.getByTestId("work-heatmap-error").textContent).toContain("boom")
    })
  })

  it("loader 返回 null → 明确说读不到 status.json（不是静默空图）", async () => {
    const loader = vi.fn(async () => null)
    render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => {
      expect(screen.getByTestId("work-heatmap-error").textContent).toContain("读不到")
    })
  })
})
