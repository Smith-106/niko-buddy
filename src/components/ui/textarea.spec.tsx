// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/ui/textarea.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { Textarea } from "./textarea"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("textarea.tsx smoke", () => {
  it("renders Textarea without crashing", () => {
    const C = Textarea as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
