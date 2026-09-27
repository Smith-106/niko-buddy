/** C4 冒烟覆盖：src/lib/novel/skill-route.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SKILL_ROUTE_CATEGORY_IDS, DEFAULT_SKILL_ROUTE_CATEGORIES, resolveOutlineTopicSkillRoutes, inferSkillRoute, filterSkillsForSkillRoute, filterSkillsForSkillRoutes } from "./skill-route"
describe("skill-route.ts smoke", () => {
  it("exports SKILL_ROUTE_CATEGORY_IDS", () => {
    expect(SKILL_ROUTE_CATEGORY_IDS).toBeDefined()
  })
  it("exports DEFAULT_SKILL_ROUTE_CATEGORIES", () => {
    expect(DEFAULT_SKILL_ROUTE_CATEGORIES).toBeDefined()
  })
  it("exports resolveOutlineTopicSkillRoutes", () => {
    expect(resolveOutlineTopicSkillRoutes).toBeDefined()
  })
  it("exports inferSkillRoute", () => {
    expect(inferSkillRoute).toBeDefined()
  })
  it("exports filterSkillsForSkillRoute", () => {
    expect(filterSkillsForSkillRoute).toBeDefined()
  })
  it("exports filterSkillsForSkillRoutes", () => {
    expect(filterSkillsForSkillRoutes).toBeDefined()
  })
})
