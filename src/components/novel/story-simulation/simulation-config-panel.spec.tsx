// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/simulation-config-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SimulationConfigPanel } from "./simulation-config-panel"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("simulation-config-panel.tsx smoke", () => {
  it("renders SimulationConfigPanel without crashing", () => {
    const C = SimulationConfigPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
