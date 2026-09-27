// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/skills/SkillPackPanel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SkillPackPanel } from "./SkillPackPanel"
import DefaultExport from "./SkillPackPanel"
import { render } from "@/test-helpers/component-test-utils"
describe("SkillPackPanel.tsx smoke", () => {
  it("renders SkillPackPanel without crashing", () => {
    const { unmount } = render(<SkillPackPanel skills={[]} categoryId="general" />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
