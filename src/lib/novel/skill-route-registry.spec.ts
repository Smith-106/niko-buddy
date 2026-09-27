/** C4 冒烟覆盖：src/lib/novel/skill-route-registry.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { getSkillRouteSkillNames, findSkillRouteByAlias, getOutlineSkillNames, getWritingSkillNames, resolveAvailableSkillsByNames, validateSkillRouteRegistry, resolveSkillReference, uniqueSkillsById, collectExplicitSkills } from "./skill-route-registry"
describe("skill-route-registry.ts smoke", () => {
  it("exports getSkillRouteSkillNames", () => {
    expect(getSkillRouteSkillNames).toBeDefined()
  })
  it("exports findSkillRouteByAlias", () => {
    expect(findSkillRouteByAlias).toBeDefined()
  })
  it("exports getOutlineSkillNames", () => {
    expect(getOutlineSkillNames).toBeDefined()
  })
  it("exports getWritingSkillNames", () => {
    expect(getWritingSkillNames).toBeDefined()
  })
  it("exports resolveAvailableSkillsByNames", () => {
    expect(resolveAvailableSkillsByNames).toBeDefined()
  })
  it("exports validateSkillRouteRegistry", () => {
    expect(validateSkillRouteRegistry).toBeDefined()
  })
  it("exports resolveSkillReference", () => {
    expect(resolveSkillReference).toBeDefined()
  })
  it("exports uniqueSkillsById", () => {
    expect(uniqueSkillsById).toBeDefined()
  })
  it("exports collectExplicitSkills", () => {
    expect(collectExplicitSkills).toBeDefined()
  })
})
