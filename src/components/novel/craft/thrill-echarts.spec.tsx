// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/craft/thrill-echarts.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { TensionCurveChart, BeatIntensityChart, SixDimRadarChart } from "./thrill-echarts"
import { render } from "@/test-helpers/component-test-utils"

// jsdom 无 canvas：echarts.init 会崩，mock 捕获 setOption 以便断言 tooltip 含义文案
const captured: unknown[] = []
vi.mock("echarts", () => ({
  init: () => ({
    setOption: (opt: unknown) => {
      captured.push(opt)
    },
    resize: () => {},
    dispose: () => {},
  }),
}))

function lastOption(): Record<string, unknown> {
  return captured[captured.length - 1] as Record<string, unknown>
}

describe("thrill-echarts.tsx smoke", () => {
  it("renders TensionCurveChart without crashing", () => {
    const { unmount } = render(<TensionCurveChart tensionCurve={[{ positionRatio: 0.5, raw: 0.8, smoothed: 0.7 }]} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("renders BeatIntensityChart without crashing", () => {
    const { unmount } = render(<BeatIntensityChart hits={[{ beatType: "reveal", rawIntensity: 0.9, weightedIntensity: 1.1, positionRatio: 0.3, closureState: "closed", arcId: null }]} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("renders SixDimRadarChart without crashing", () => {
    const { unmount } = render(<SixDimRadarChart scores={{ thrill: 8, pacing: 7 }} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})

describe("thrill-echarts tooltip 含义（Odyssey FIX-1）", () => {
  it("张力曲线 tooltip 解释原始/平滑含义与取值范围", () => {
    captured.length = 0
    const { unmount, container } = render(
      <TensionCurveChart tensionCurve={[{ positionRatio: 0.1, raw: 0.7, smoothed: 0.21 }]} />,
    )
    const tooltip = (lastOption().tooltip ?? {}) as { formatter?: (p: unknown) => string }
    const text = tooltip.formatter?.([
      { seriesName: "原始张力", value: 0.7, axisValueLabel: "10.0" },
      { seriesName: "平滑张力", value: 0.21, axisValueLabel: "10.0" },
    ])
    expect(text).toContain("全书位置 10.0%")
    expect(text).toContain("原始叠加强度")
    expect(text).toContain("阅读体感节奏")
    expect(text).toContain("0–1")
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("0–1")
    unmount()
  })

  it("Beat tooltip 解释加权强度定义与闭环含义", () => {
    captured.length = 0
    const { unmount, container } = render(
      <BeatIntensityChart hits={[{ beatType: "reveal", rawIntensity: 0.9, weightedIntensity: 1.1, positionRatio: 0.3, closureState: "closed", arcId: null }]} />,
    )
    const tooltip = (lastOption().tooltip ?? {}) as { formatter?: (p: unknown) => string }
    const text = tooltip.formatter?.([{ value: 1.1, dataIndex: 0 }])
    expect(text).toContain("原始强度 × 闭环权重")
    expect(text).toContain(">1 为高光")
    expect(text).toContain("已闭环疏解")
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("加权强度")
    unmount()
  })

  it("六维雷达 tooltip 标注 0–10 分制", () => {
    captured.length = 0
    const { unmount, container } = render(<SixDimRadarChart scores={{ thrill: 8, pacing: 7 }} />)
    const tooltip = (lastOption().tooltip ?? {}) as { formatter?: (p: unknown) => string }
    const text = tooltip.formatter?.([{ value: [8, 0, 7, 0, 0, 0], name: "六维评分" }])
    expect(text).toContain("0–10 分")
    expect(text).toContain("/ 10")
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("0–10")
    unmount()
  })
})
