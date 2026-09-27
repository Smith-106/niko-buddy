// @vitest-environment jsdom
/** C4 冒烟覆盖：src/lib/novel/story-simulation/action-type-utils.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { actionTypeShortLabel, actionTypePhrase, actionTypePhraseOnly, actionTypeIcon } from "./action-type-utils"
describe("action-type-utils.tsx smoke", () => {
  it("exports actionTypeShortLabel", () => {
    expect(actionTypeShortLabel).toBeDefined()
  })
  it("exports actionTypePhrase", () => {
    expect(actionTypePhrase).toBeDefined()
  })
  it("exports actionTypePhraseOnly", () => {
    expect(actionTypePhraseOnly).toBeDefined()
  })
  it("exports actionTypeIcon", () => {
    expect(actionTypeIcon).toBeDefined()
  })
})
