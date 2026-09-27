// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/ui/label.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { Label } from "./label"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("label.tsx smoke", () => {
  it("renders Label without crashing", () => {
    const C = Label as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
