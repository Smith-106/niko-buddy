/** C4 冒烟覆盖：src/lib/novel/skill-library.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_SKILL_PRIORITY, SKILL_KIND_LABELS, SKILL_STAGE_LABELS, SKILL_MODE_LABELS, normalizeUserSkill, filterUserSkills } from "./skill-library"
describe("skill-library.ts smoke", () => {
  it("exports DEFAULT_SKILL_PRIORITY", () => {
    expect(DEFAULT_SKILL_PRIORITY).toBeDefined()
  })
  it("exports SKILL_KIND_LABELS", () => {
    expect(SKILL_KIND_LABELS).toBeDefined()
  })
  it("exports SKILL_STAGE_LABELS", () => {
    expect(SKILL_STAGE_LABELS).toBeDefined()
  })
  it("exports SKILL_MODE_LABELS", () => {
    expect(SKILL_MODE_LABELS).toBeDefined()
  })
  it("exports normalizeUserSkill", () => {
    expect(normalizeUserSkill).toBeDefined()
  })
  it("exports filterUserSkills", () => {
    expect(filterUserSkills).toBeDefined()
  })
})
