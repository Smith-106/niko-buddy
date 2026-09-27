// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/layout/director-sidebar-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DirectorSidebarPanel } from "./director-sidebar-panel"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("director-sidebar-panel.tsx smoke", () => {
  it("renders DirectorSidebarPanel without crashing", () => {
    const C = DirectorSidebarPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
