// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/framework-confirm-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { FrameworkConfirmPanel } from "./framework-confirm-panel"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("framework-confirm-panel.tsx smoke", () => {
  it("renders FrameworkConfirmPanel without crashing", () => {
    const C = FrameworkConfirmPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
