import { describe, expect, it } from "vitest"
import {
  SKILL_ROUTE_CATEGORY_IDS,
  DEFAULT_SKILL_ROUTE_CATEGORIES,
  resolveOutlineTopicSkillRoutes,
  inferSkillRoute,
  filterSkillsForSkillRoute,
  filterSkillsForSkillRoutes,
} from "./skill-route"
import { normalizeUserSkill, type UserSkill } from "./skill-library"

function skill(partial: Partial<UserSkill>): UserSkill {
  return normalizeUserSkill({
    id: partial.id ?? `test:${partial.name ?? "unnamed"}`,
    name: partial.name ?? "unnamed",
    description: partial.description ?? "",
    categoryId: partial.categoryId ?? "",
    tags: partial.tags ?? [],
  })
}

describe("skill-route category registry", () => {
  it("defines nine stable route category ids", () => {
    expect(Object.keys(SKILL_ROUTE_CATEGORY_IDS)).toEqual([
      "writing",
      "outline",
      "setting",
      "character",
      "worldbuilding",
      "faction",
      "foreshadowing",
      "map",
      "topic",
    ])
    expect(SKILL_ROUTE_CATEGORY_IDS.outline).toBe("skill-category:outline")
    expect(SKILL_ROUTE_CATEGORY_IDS.topic).toBe("skill-category:topic")
  })

  it("provides a default category per route", () => {
    expect(DEFAULT_SKILL_ROUTE_CATEGORIES).toHaveLength(9)
    const byId = new Map(DEFAULT_SKILL_ROUTE_CATEGORIES.map((c) => [c.id, c.name]))
    expect(byId.get(SKILL_ROUTE_CATEGORY_IDS.writing)).toBe("正文")
    expect(byId.get(SKILL_ROUTE_CATEGORY_IDS.outline)).toBe("大纲")
    expect(byId.get(SKILL_ROUTE_CATEGORY_IDS.topic)).toBe("题材")
  })
})

describe("resolveOutlineTopicSkillRoutes", () => {
  it("always includes outline and topic for empty input", () => {
    expect(resolveOutlineTopicSkillRoutes({})).toEqual(["outline", "topic"])
  })

  it("adds world/setting/faction/map routes for xuanhuan input", () => {
    const routes = resolveOutlineTopicSkillRoutes({ genre: "玄幻修仙" })
    expect(routes.slice(0, 2)).toEqual(["outline", "topic"])
    expect(routes).toEqual(expect.arrayContaining(["worldbuilding", "setting", "faction", "map"]))
  })

  it("adds setting/world/foreshadowing/map routes for urban-system input", () => {
    const routes = resolveOutlineTopicSkillRoutes({ task: "都市系统流" })
    expect(routes).toEqual(expect.arrayContaining(["setting", "worldbuilding", "foreshadowing", "map"]))
  })

  it("adds character/foreshadowing/setting routes for female-led input", () => {
    const routes = resolveOutlineTopicSkillRoutes({ channel: "女频", genre: "豪门总裁" })
    expect(routes).toEqual(expect.arrayContaining(["character", "foreshadowing", "setting"]))
  })

  it("deduplicates routes when multiple patterns match", () => {
    const routes = resolveOutlineTopicSkillRoutes({ genre: "玄幻", task: "都市悬疑" })
    expect(routes.length).toBe(new Set(routes).size)
    expect(routes.filter((r) => r === "setting")).toHaveLength(1)
  })

  it("matches via channel text as well", () => {
    expect(resolveOutlineTopicSkillRoutes({ channel: "male", genre: "修仙" })).toContain("faction")
    expect(resolveOutlineTopicSkillRoutes({ channel: "auto" })).toEqual(["outline", "topic"])
  })
})

describe("inferSkillRoute", () => {
  it("prefers the explicit categoryId mapping", () => {
    const s = skill({ name: "随便", categoryId: SKILL_ROUTE_CATEGORY_IDS.map })
    expect(inferSkillRoute(s)).toBe("map")
  })

  it("infers writing from a去AI keyword in the name", () => {
    expect(inferSkillRoute(skill({ name: "正文润色" }))).toBe("writing")
  })

  it("infers outline from topic keywords in name/tags", () => {
    expect(inferSkillRoute(skill({ name: "大纲小助手", tags: ["大纲"] }))).toBe("outline")
    expect(inferSkillRoute(skill({ name: "xxx", tags: ["主线剧情"] }))).toBe("outline")
  })

  it("falls back to description matching when name/tags do not match", () => {
    const s = skill({ name: "mystery-helper", tags: ["misc"], description: "专注伏笔回收与线索管理" })
    expect(inferSkillRoute(s)).toBe("foreshadowing")
  })

  it("prefers earlier fuzzy routes (worldbuilding beats setting)", () => {
    // 世界规则 contains 世界观 keyword; both worldbuilding and setting could match,
    // but FUZZY_ROUTE_ORDER puts worldbuilding first.
    const s = skill({ name: "世界规则设定集", description: "世界规则与能力体系" })
    expect(inferSkillRoute(s)).toBe("worldbuilding")
  })

  it("returns null when nothing matches", () => {
    expect(inferSkillRoute(skill({ name: "zzz-qqq", description: "nothing relevant here" }))).toBeNull()
  })
})

describe("filterSkillsForSkillRoute(s)", () => {
  const skills = [
    skill({ name: "正文润色", description: "改写润色" }),
    skill({ name: "大纲建筑师", tags: ["大纲"] }),
    skill({ name: "zzz-qqq", description: "nothing relevant" }),
  ]

  it("keeps only skills inferring to the requested route", () => {
    const writing = filterSkillsForSkillRoute(skills, "writing")
    expect(writing.map((s) => s.name)).toEqual(["正文润色"])
  })

  it("returns an empty list when nothing matches the route", () => {
    expect(filterSkillsForSkillRoute(skills, "map")).toEqual([])
  })

  it("filters by a set of routes keeping inferred members only", () => {
    const filtered = filterSkillsForSkillRoutes(skills, ["writing", "outline"])
    expect(filtered.map((s) => s.name).sort()).toEqual(["大纲建筑师", "正文润色"])
    // uninferrable skills are dropped even when routes are given
    expect(filtered.some((s) => s.name === "zzz-qqq")).toBe(false)
  })

  it("returns empty for an empty route set", () => {
    expect(filterSkillsForSkillRoutes(skills, [])).toEqual([])
  })
})
