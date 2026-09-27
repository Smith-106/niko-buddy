// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/editor/wiki-gating-progress.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ChapterGatingProgress } from "./wiki-gating-progress"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("wiki-gating-progress.tsx smoke", () => {
  it("renders ChapterGatingProgress without crashing", () => {
    const C = ChapterGatingProgress as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
