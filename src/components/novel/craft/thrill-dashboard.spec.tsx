// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 回归：图表懒加载/渲染失败的兜底必须真的可达。
//
// 旧实现是 `const [echartsError] = useState(false)`（无 setter）→ 「图表加载失败」分支
// 永远不渲染（死代码），echarts 缺失时用户只看到空白。此 spec 注入一个渲染即抛错的
// 图表模块，断言错误边界把兜底文案显示出来。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { ThrillDashboard } from "./thrill-dashboard"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}))

vi.mock("./thrill-echarts", () => ({
  TensionCurveChart: () => {
    throw new Error("echarts chunk unavailable")
  },
  BeatIntensityChart: () => null,
  SixDimRadarChart: () => null,
}))

const result = {
  configVersion: "test",
  hits: [],
  tensionCurve: [],
}

describe("ThrillDashboard — 图表失败兜底", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("图表渲染抛错 → 错误边界显示兜底文案（而非空白）", async () => {
    render(<ThrillDashboard result={result} />)
    await waitFor(() => {
      expect(screen.getByText("craft.thrillDashboard.chartFailed")).toBeTruthy()
    })
  })

  it("无数据时显示空态而不是兜底", () => {
    render(<ThrillDashboard result={undefined} />)
    expect(screen.getByText("craft.thrillDashboard.noData")).toBeTruthy()
    expect(screen.queryByText("craft.thrillDashboard.chartFailed")).toBeNull()
  })
})
