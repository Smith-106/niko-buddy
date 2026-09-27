// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/craft/thrill-echarts.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { TensionCurveChart, BeatIntensityChart, SixDimRadarChart } from "./thrill-echarts"
import { render } from "@/test-helpers/component-test-utils"

// jsdom 无 canvas：echarts.init 会崩，模块级 mock 只保留 init/setOption 骨架
vi.mock("echarts", () => ({
  init: () => ({ setOption: () => {}, resize: () => {}, dispose: () => {} }),
}))
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
