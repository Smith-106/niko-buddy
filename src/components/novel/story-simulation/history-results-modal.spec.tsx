// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/history-results-modal.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { HistoryResultsModal } from "./history-results-modal"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("history-results-modal.tsx smoke", () => {
  it("renders HistoryResultsModal without crashing", () => {
    const C = HistoryResultsModal as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
