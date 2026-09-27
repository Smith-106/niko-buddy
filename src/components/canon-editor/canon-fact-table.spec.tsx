// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/canon-editor/canon-fact-table.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { CanonFactTable } from "./canon-fact-table"
import { render } from "@/test-helpers/component-test-utils"
describe("canon-fact-table.tsx smoke", () => {
  it("renders CanonFactTable without crashing", () => {
    const { unmount } = render(<CanonFactTable edges={[]} maxRevision={null} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
