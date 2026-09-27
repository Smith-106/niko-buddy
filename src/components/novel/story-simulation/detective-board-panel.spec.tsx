// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/detective-board-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ClueTimelinePanel } from "./detective-board-panel"
import { render } from "@/test-helpers/component-test-utils"
describe("detective-board-panel.tsx smoke", () => {
  it("renders ClueTimelinePanel without crashing", () => {
    const { unmount } = render(<ClueTimelinePanel agents={new Map()} rumors={[]} events={[]} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
