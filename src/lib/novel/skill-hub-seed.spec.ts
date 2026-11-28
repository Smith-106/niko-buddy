import { describe, expect, it } from "vitest"
import { SKILL_ROUTE_CATEGORY_IDS } from "./skill-route"
import { DEFAULT_SKILL_HUB_SKILLS } from "./skill-hub-seed"

describe("SkillHub seed", () => {
  it("loads SkillHub files as built-in routed skills", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.length).toBe(99)
    expect(new Set(DEFAULT_SKILL_HUB_SKILLS.map((skill) => skill.name)).size).toBe(99)
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
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-faction-politics-and-conspiracy")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.faction)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "character-graceful-exit-and-legacy-arc")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.character)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-combat-tactics-and-terrain-chess")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.writing)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-dialogue-sparring-and-status-play")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.writing)
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

  it("loads the 7 integrated Nowledge Mem core engine & compliance skills with expected categories", () => {
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-continuity-p0-gate-audit")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-finale-three-precepts-audit")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "aigc-platform-compliance-kit")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-thrill-loop-delay-pacing")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-ghost-wound-and-wish-motive-chain")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.character)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-dual-kb-research-and-injection")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.setting)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "detect-ai-flavor-nine-signals")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.writing)
    // v3 新增 6 个通用大手法/角色/流派配装支柱技能
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "novel-craft-school-and-expert-selector")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "character-ensemble-ecology-and-chemistry")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.character)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "character-antagonist-mirror-and-pressure")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.character)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "character-voice-fingerprint-and-micro-actions")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.character)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-power-economy-and-map-escalation")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.setting)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-cinematic-blocking-and-sensory-immersion")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.writing)
    // v4 从 WeKnora 写作技法库蒸馏的 4 个核心技法技能
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-opening-hook-promise-and-inciting-incident")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-scene-sequel-beats-and-pov-discipline")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.writing)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-mystery-clue-fairplay-and-red-herring")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.setting)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-worldview-coherence-and-belief-arc")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.setting)
    // v5 从 WeKnora 写作技法库深挖的第二批 3 个核心技法技能
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-midbook-midpoint-and-climax-architecture")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-self-editing-revision-and-prose-tightening")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
    expect(DEFAULT_SKILL_HUB_SKILLS.find((skill) => skill.name === "craft-emotional-tension-and-crisis-escalation")?.categoryId)
      .toBe(SKILL_ROUTE_CATEGORY_IDS.outline)
  })
})

describe("SkillHub seed / frontmatter 防御分支", () => {
  it("parseFrontmatter 返回 undefined 时全部文件被过滤为空（?? 回退 + !frontmatter）", async () => {
    const { vi: v } = await import("vitest")
    v.resetModules()
    v.doMock("@/lib/frontmatter", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
      return { ...actual, parseFrontmatter: () => undefined }
    })
    v.doMock("./skill-route-registry", () => ({
      validateSkillRouteRegistry: () => [],
    }))
    try {
      const mod = await import("./skill-hub-seed")
      // 防御链：?? { frontmatter: null } 右侧 → !frontmatter 真分支 → 99 个文件全被过滤
      expect(mod.DEFAULT_SKILL_HUB_SKILLS).toEqual([])
    } finally {
      v.doUnmock("@/lib/frontmatter")
      v.doUnmock("./skill-route-registry")
      v.resetModules()
    }
  })

  it("单个文件缺 name 时仅该文件被过滤，其余 98 条保留", async () => {
    const { vi: v } = await import("vitest")
    v.resetModules()
    let calls = 0
    v.doMock("@/lib/frontmatter", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
      return {
        ...actual,
        parseFrontmatter: (content: string) => {
          calls += 1
          if (calls === 1) return { frontmatter: { description: "只有描述没有名字" }, body: content, rawBlock: "" }
          return actual.parseFrontmatter(content)
        },
      }
    })
    v.doMock("./skill-route-registry", () => ({
      validateSkillRouteRegistry: () => [],
    }))
    const errSpy = v.spyOn(console, "error").mockImplementation(() => {})
    try {
      const mod = await import("./skill-hub-seed")
      // !name 短路：缺 name 的文件不能在种子里留下无名 skill（id 会退化成
      // "skillhub:undefined"，路由与收藏都会撞车）
      expect(mod.DEFAULT_SKILL_HUB_SKILLS).toHaveLength(98)
      expect(mod.DEFAULT_SKILL_HUB_SKILLS.every((s) => s.name.trim().length > 0)).toBe(true)
      expect(mod.DEFAULT_SKILL_HUB_SKILLS.some((s) => s.id === "skillhub:undefined")).toBe(false)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      v.doUnmock("@/lib/frontmatter")
      v.doUnmock("./skill-route-registry")
      v.resetModules()
    }
  })

  it("单个文件缺 description 时仅该文件被过滤，其余 98 条保留", async () => {
    const { vi: v } = await import("vitest")
    v.resetModules()
    let calls = 0
    v.doMock("@/lib/frontmatter", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
      return {
        ...actual,
        parseFrontmatter: (content: string) => {
          calls += 1
          if (calls === 1) return { frontmatter: { name: "broken-only" }, body: content, rawBlock: "" }
          return actual.parseFrontmatter(content)
        },
      }
    })
    v.doMock("./skill-route-registry", () => ({
      validateSkillRouteRegistry: () => [],
    }))
    const errSpy = v.spyOn(console, "error").mockImplementation(() => {})
    try {
      const mod = await import("./skill-hub-seed")
      // !name || !description 真分支：首个文件（有 name 无 description）被过滤，其余走真实解析保留
      expect(mod.DEFAULT_SKILL_HUB_SKILLS).toHaveLength(98)
      expect(mod.DEFAULT_SKILL_HUB_SKILLS.some((s) => s.name === "broken-only")).toBe(false)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      v.doUnmock("@/lib/frontmatter")
      v.doUnmock("./skill-route-registry")
      v.resetModules()
    }
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
      // seed still loads with the real 99 SkillHub files
      expect(mod.DEFAULT_SKILL_HUB_SKILLS.length).toBe(99)
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
