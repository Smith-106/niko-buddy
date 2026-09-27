// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/branch-compare-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BranchCompareView } from "./branch-compare-view"
import { render } from "@/test-helpers/component-test-utils"
describe("branch-compare-view.tsx smoke", () => {
  it("renders BranchCompareView without crashing", () => {
    const { unmount } = render(<BranchCompareView branches={[]} compareBranchIds={[]} onBack={() => {}} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
