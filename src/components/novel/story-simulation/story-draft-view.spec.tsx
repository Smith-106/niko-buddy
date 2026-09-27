// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/story-draft-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { StoryDraftView } from "./story-draft-view"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("story-draft-view.tsx smoke", () => {
  it("renders StoryDraftView without crashing", () => {
    const C = StoryDraftView as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
