// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/tools/BatchReplacePanel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BatchReplacePanel } from "./BatchReplacePanel"
import DefaultExport from "./BatchReplacePanel"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("BatchReplacePanel.tsx smoke", () => {
  it("renders BatchReplacePanel without crashing", () => {
    const C = BatchReplacePanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
