// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/briefing/BriefingPanel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BriefingPanel } from "./BriefingPanel"
import DefaultExport from "./BriefingPanel"
import { render } from "@/test-helpers/component-test-utils"
describe("BriefingPanel.tsx smoke", () => {
  it("renders BriefingPanel without crashing", () => {
    const { unmount } = render(<BriefingPanel digest={{ blocks: [], assertions: [], openDebts: [], warnings: [] }} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
