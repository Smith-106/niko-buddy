// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/ui/input.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { Input } from "./input"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("input.tsx smoke", () => {
  it("renders Input without crashing", () => {
    const C = Input as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
