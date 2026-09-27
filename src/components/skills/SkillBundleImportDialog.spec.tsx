// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/skills/SkillBundleImportDialog.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SkillBundleImportDialog } from "./SkillBundleImportDialog"
import DefaultExport from "./SkillBundleImportDialog"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("SkillBundleImportDialog.tsx smoke", () => {
  it("renders SkillBundleImportDialog without crashing", () => {
    const C = SkillBundleImportDialog as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
