// @vitest-environment jsdom
/**
 * P2-IMP-13 (P2-M4)：KbHealthView 面板 smoke spec。
 * 覆盖：六行指标渲染 + N/A 分色（徽章 + unavailableReason 小字）+
 * drift>0 高亮告警横幅 + 建议重建按钮（点击回调 / 无回调禁用）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { KbHealthView } from "./kb-health-view"
import { collectKbMetrics } from "@/lib/novel/kb-observability"

const METRIC_KEYS = [
  "canon_violation_rate",
  "obligation_coverage",
  "hard_injection_budget_usage",
  "promotion_replay_success",
  "truth_fold_drift",
  "gap_report_rate",
] as const

afterEach(() => {
  cleanup()
})

describe("KbHealthView 面板 smoke（P2-IMP-13）", () => {
  it("渲染六行指标：三真实值 + 三 N/A 分色（徽章 + unavailableReason）", () => {
    const metrics = collectKbMetrics({
      truthFoldDrift: 0,
      hardInjectionBudgetUsage: 0.42,
      gapReportRate: 3,
    })
    render(<KbHealthView metrics={metrics} />)

    for (const key of METRIC_KEYS) {
      expect(screen.getByTestId(`kb-metric-${key}`)).toBeTruthy()
    }
    // 三真实源：非 N/A，值按口径渲染
    expect(screen.queryByTestId("kb-metric-truth_fold_drift-na")).toBeNull()
    expect(screen.queryByTestId("kb-metric-hard_injection_budget_usage-na")).toBeNull()
    expect(screen.queryByTestId("kb-metric-gap_report_rate-na")).toBeNull()
    expect(screen.getByText("42.0%")).toBeTruthy() // rate ×100
    expect(screen.getByText("3")).toBeTruthy() // count 直读
    // 两评测 gate 项 + promotion：N/A 徽章 + 原因小字（诚实降级分色）
    expect(screen.getByTestId("kb-metric-canon_violation_rate-na")).toBeTruthy()
    expect(screen.getByTestId("kb-metric-obligation_coverage-na")).toBeTruthy()
    expect(screen.getByTestId("kb-metric-promotion_replay_success-na")).toBeTruthy()
    expect(screen.getAllByText("N/A")).toHaveLength(3)
    expect(screen.getAllByText("seed-missing（评测集种子未就绪）")).toHaveLength(2)
    // drift=0 健康 → 无告警横幅、无重建按钮
    expect(screen.queryByTestId("kb-health-drift-alarm")).toBeNull()
  })

  it("drift>0 → 行高亮 + 告警横幅 + 建议重建按钮点击回调", () => {
    const metrics = collectKbMetrics({ truthFoldDrift: 2, gapReportRate: 1 })
    const onRebuild = vi.fn()
    render(<KbHealthView metrics={metrics} onRebuild={onRebuild} />)

    const alarm = screen.getByTestId("kb-health-drift-alarm")
    expect(alarm).toBeTruthy()
    expect(alarm.textContent).toContain("truth_fold_drift=2")
    // drift 行高亮（amber 告警配色）
    expect(screen.getByTestId("kb-metric-truth_fold_drift").className).toContain("amber")
    const button = screen.getByRole("button", { name: "建议重建" })
    fireEvent.click(button)
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })

  it("drift>0 但无 onRebuild → 按钮禁用（只读降级，不伪造可用性）", () => {
    const metrics = collectKbMetrics({ truthFoldDrift: 1 })
    render(<KbHealthView metrics={metrics} />)
    const button = screen.getByRole("button", { name: "建议重建" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
