// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/simulation-report-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SimulationReportView } from "./simulation-report-view"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("simulation-report-view.tsx smoke", () => {
  it("renders SimulationReportView without crashing", () => {
    const C = SimulationReportView as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
