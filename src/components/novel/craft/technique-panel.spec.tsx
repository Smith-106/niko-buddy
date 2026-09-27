// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/craft/technique-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { TechniquePanel } from "./technique-panel"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("technique-panel.tsx smoke", () => {
  it("renders TechniquePanel without crashing", () => {
    const C = TechniquePanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
