// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/ui/button.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { Button, buttonVariants } from "./button"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("button.tsx smoke", () => {
  it("renders Button without crashing", () => {
    const C = Button as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("exports buttonVariants", () => {
    expect(buttonVariants).toBeDefined()
  })
})
