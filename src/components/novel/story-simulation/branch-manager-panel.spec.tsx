// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/branch-manager-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BranchManagerPanel } from "./branch-manager-panel"
import { render } from "@/test-helpers/component-test-utils"
describe("branch-manager-panel.tsx smoke", () => {
  it("renders BranchManagerPanel without crashing", () => {
    const noop = () => {}
    const { unmount } = render(<BranchManagerPanel branches={[]} activeBranchId={null} compareBranchIds={[]} isCompareMode={false} onSaveBranch={noop} onDeleteBranch={noop} onRenameBranch={noop} onSwitchBranch={noop} onToggleCompareBranch={noop} onSetCompareMode={noop} onClearCompareSelection={noop} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
