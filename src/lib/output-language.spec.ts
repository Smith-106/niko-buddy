/** C4 冒烟覆盖：src/lib/output-language.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { getOutputLanguage, buildLanguageDirective, buildLanguageReminder } from "./output-language"
describe("output-language.ts smoke", () => {
  it("exports getOutputLanguage", () => {
    expect(getOutputLanguage).toBeDefined()
  })
  it("exports buildLanguageDirective", () => {
    expect(buildLanguageDirective).toBeDefined()
  })
  it("exports buildLanguageReminder", () => {
    expect(buildLanguageReminder).toBeDefined()
  })
})
