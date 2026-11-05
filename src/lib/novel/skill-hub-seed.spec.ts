import { describe, expect, it } from "vitest"
import { SKILL_ROUTE_CATEGORY_IDS } from "./skill-route"
import { DEFAULT_SKILL_HUB_SKILLS } from "./skill-hub-seed"

describe("SkillHub seed", () => {
  it("loads SkillHub files as built-in routed skills", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.length).toBe(75)
    expect(new Set(DEFAULT_SKILL_HUB_SKILLS.map((skill) => skill.name)).size).toBe(75)
    expect(DEFAULT_SKILL_HUB_SKILLS.every((skill) => skill.source === "built-in")).toBe(true)
  })

  it("routes key outline, topic and setting skills to stable folders", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "outline-master-builder")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "male-xuanhuan-xianxia")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.topic)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "world-rules")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.worldbuilding)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "faction-system")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.faction)
  })

  it("loads newly added topic, chapter-outline and quality skills for AI outline routing", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "male-beast-taming")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.topic)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "female-book-transmigration")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.topic)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "short-public-trial-face-slap")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.topic)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "chapter-outline-builder")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "outline-quality-check")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
  })
})

describe("SkillHub seed / 注册表缺口告警", () => {
  it("logs a desensitized error when the route registry lists unknown SkillHub names", async () => {
    const { vi: v } = await import("vitest")
    v.resetModules()
    v.doMock("./skill-route-registry", () => ({
      validateSkillRouteRegistry: () => ["ghost-skill", "phantom-skill"],
    }))
    const errSpy = v.spyOn(console, "error").mockImplementation(() => {})
    try {
      const mod = await import("./skill-hub-seed")
      // seed still loads with the real 75 SkillHub files
      expect(mod.DEFAULT_SKILL_HUB_SKILLS.length).toBe(75)
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(errSpy.mock.calls[0][0]).toContain("Skill 路由注册表包含不存在的 SkillHub 名称")
      // desensitized: count + name list string, no error object leak
      expect(errSpy.mock.calls[0][1]).toBe("2 missing: ghost-skill, phantom-skill")
    } finally {
      errSpy.mockRestore()
      v.doUnmock("./skill-route-registry")
      v.resetModules()
    }
  })
})
