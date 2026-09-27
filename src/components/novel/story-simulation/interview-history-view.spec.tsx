// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/interview-history-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { InterviewHistoryView } from "./interview-history-view"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("interview-history-view.tsx smoke", () => {
  it("renders InterviewHistoryView without crashing", () => {
    const C = InterviewHistoryView as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
