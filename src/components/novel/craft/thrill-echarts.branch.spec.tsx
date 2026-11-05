// @vitest-environment jsdom
/** thrill-echarts 分支覆盖补齐（Ralph 覆盖率战役）：空数据占位 + formatter 退化分支 + open 闭环着色。 */
import { describe, expect, it, vi } from "vitest"
import { BeatIntensityChart, SixDimRadarChart, TensionCurveChart } from "./thrill-echarts"
import { render } from "@/test-helpers/component-test-utils"

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

describe("thrill-echarts 分支补齐", () => {
  it("空数据走占位分支（三图）", () => {
    const a = render(<TensionCurveChart tensionCurve={[]} />)
    expect(a.container.textContent).toContain("暂无张力曲线数据")
    a.unmount()
    const b = render(<BeatIntensityChart hits={[]} />)
    expect(b.container.textContent).toContain("暂无 beat 强度数据")
    b.unmount()
    const c = render(<SixDimRadarChart scores={{}} />)
    expect(c.container.textContent).toContain("暂无六维评分数据")
    c.unmount()
  })

  it("ResizeObserver 存在时订阅元素尺寸变化并在卸载时断开", () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    class FakeResizeObserver {
      observe = observe
      disconnect = disconnect
      constructor(_callback: unknown) {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    try {
      const { unmount } = render(
        <TensionCurveChart tensionCurve={[{ positionRatio: 0.2, raw: 0.5, smoothed: 0.4 }]} />,
      )
      expect(observe).toHaveBeenCalledTimes(1)
      unmount()
      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("ResizeObserver 缺失时仍挂载 window resize 回退", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    try {
      const { container, unmount } = render(
        <TensionCurveChart tensionCurve={[{ positionRatio: 0.2, raw: 0.5, smoothed: 0.4 }]} />,
      )
      expect(container.querySelector('[role="img"]')).toBeTruthy()
      unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("张力 tooltip：非数组输入返回空串；空数组回退轴标签", () => {
    captured.length = 0
    const { unmount } = render(
      <TensionCurveChart tensionCurve={[{ positionRatio: 0.1, raw: 0.7, smoothed: 0.21 }]} />,
    )
    const tooltip = lastOption().tooltip as { formatter: (p: unknown) => string }
    expect(tooltip.formatter("not-an-array")).toBe("")
    expect(tooltip.formatter([])).toBe("全书位置 %")
    unmount()
  })

  it("Beat open 闭环走琥珀色分支；tooltip  open 措辞为开放延宕", () => {
    captured.length = 0
    const { unmount } = render(
      <BeatIntensityChart
        hits={[
          { beatType: "reveal", rawIntensity: 0.9, weightedIntensity: 1.1, positionRatio: 0.3, closureState: "open", arcId: null },
          { beatType: "twist", rawIntensity: 0.5, weightedIntensity: 0.6, positionRatio: 0.7, closureState: "closed", arcId: null },
        ]}
      />,
    )
    const series = (lastOption().series as Array<{ data: Array<{ itemStyle: { color: string } }> }>)[0]!
    const colors = series.data.map((d) => d.itemStyle.color)
    expect(colors).toContain("#f59e0b")
    expect(colors).toContain("#22c55e")
    const tooltip = lastOption().tooltip as { formatter: (p: unknown) => string }
    const text = tooltip.formatter([{ value: 1.1, dataIndex: 0 }])
    expect(text).toContain("开放延宕")
    unmount()
  })

  it("Beat tooltip：非数组输入与越界下标返回空串", () => {
    captured.length = 0
    const { unmount } = render(
      <BeatIntensityChart
        hits={[{ beatType: "reveal", rawIntensity: 0.9, weightedIntensity: 1.1, positionRatio: 0.3, closureState: "closed", arcId: null }]}
      />,
    )
    const tooltip = lastOption().tooltip as { formatter: (p: unknown) => string }
    expect(tooltip.formatter("not-an-array")).toBe("")
    expect(tooltip.formatter([{ value: 1.1, dataIndex: 99 }])).toBe("")
    unmount()
  })

  it("雷达 tooltip：非数组输入返回空串", () => {
    captured.length = 0
    const { unmount } = render(<SixDimRadarChart scores={{ thrill: 8, pacing: 7 }} />)
    const tooltip = lastOption().tooltip as { formatter: (p: unknown) => string }
    expect(tooltip.formatter("not-an-array")).toBe("")
    unmount()
  })
})
