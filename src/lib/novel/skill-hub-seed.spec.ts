import { describe, expect, it } from "vitest"
import { SKILL_ROUTE_CATEGORY_IDS } from "./skill-route"
import { DEFAULT_SKILL_HUB_SKILLS } from "./skill-hub-seed"

describe("SkillHub seed", () => {
  it("loads SkillHub files as built-in routed skills", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.length).toBe(70)
    expect(new Set(DEFAULT_SKILL_HUB_SKILLS.map((skill) => skill.name)).size).toBe(70)
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
