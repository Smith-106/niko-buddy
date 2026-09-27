// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/craft/arc-workbench.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ArcWorkbench } from "./arc-workbench"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("arc-workbench.tsx smoke", () => {
  it("renders ArcWorkbench without crashing", () => {
    const C = ArcWorkbench as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
