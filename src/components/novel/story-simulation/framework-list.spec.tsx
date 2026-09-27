// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/framework-list.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { FrameworkList } from "./framework-list"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("framework-list.tsx smoke", () => {
  it("renders FrameworkList without crashing", () => {
    const C = FrameworkList as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
