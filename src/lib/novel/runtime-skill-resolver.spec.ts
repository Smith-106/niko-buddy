import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextPack } from "./context-engine"
import {
  computeEffectiveContextTokenBudget,
  resolveRuntimeSkillsForStage,
} from "./runtime-skill-resolver"
import {
  buildTieredDeAiOverrideDirective,
  createEmptyDeAiTieredOverrides,
  detectTieredDeAi,
  mergeTieredDeAiTable,
  TIERED_DEAI_TABLE,
} from "./de-ai-tiered-table"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { UserSkill } from "./skill-library"
import type { UserSkillConfig } from "./user-skill-store"

const skillStoreMocks = vi.hoisted(() => ({
  loadUserSkillConfig: vi.fn(),
  loadLinkedSkillContent: vi.fn(),
}))

vi.mock("./user-skill-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./user-skill-store")>()
  return {
    ...actual,
    loadUserSkillConfig: skillStoreMocks.loadUserSkillConfig,
    loadLinkedSkillContent: skillStoreMocks.loadLinkedSkillContent,
  }
})

function makeSkill(overrides: Partial<UserSkill> & { id: string; name: string }): UserSkill {
  return {
    description: "",
    kind: ["structure"],
    stages: ["drafting"],
    modes: ["standard"],
    content: "",
    source: "uploaded",
    priority: 50,
    tags: [],
    categoryId: "",
    ...overrides,
  }
}

function makeConfig(skills: UserSkill[], disabledSkillIds: string[] = []): UserSkillConfig {
  return {
    version: 1,
    selectedSkillId: skills[0]?.id ?? null,
    disabledSkillIds,
    skills,
    categories: [],
  }
}

describe("Phase 1 runtime-skill-resolver & context/de-ai upgrades", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue(makeConfig([]))
    skillStoreMocks.loadLinkedSkillContent.mockResolvedValue("")
  })

  it("零配置短路：taskSkillNames 为空时不调用 loadUserSkillConfig 且返回空串", async () => {
    const res = await resolveRuntimeSkillsForStage({
      projectPath: "/P",
      stage: "writing",
      novelConfig: { taskSkillNames: { writing: [], outline: [], review: [], summary: [], extract: [] }, contextTokenBudget: 32000 },
    })
    expect(skillStoreMocks.loadUserSkillConfig).not.toHaveBeenCalled()
    expect(res.renderedText).toBe("")
    expect(res.usedTokens).toBe(0)
    expect(res.skills).toEqual([])
  })

  it("按需水合 linked 技能并剥离 UTF-8 BOM + YAML frontmatter", async () => {
    const linked = makeSkill({
      id: "linked:1",
      name: "对话潜台词",
      source: "linked",
      linkedPath: "/assets/subtext",
      content: "",
    })
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue(makeConfig([linked]))
    skillStoreMocks.loadLinkedSkillContent.mockResolvedValue(
      "\uFEFF---\nname: 对话潜台词\nversion: 1\n---\n\n让角色说 A 暗示 B，避免直白抒情。",
    )

    const res = await resolveRuntimeSkillsForStage({
      projectPath: "/P",
      stage: "writing",
      novelConfig: { taskSkillNames: { writing: ["对话潜台词"], outline: [], review: [], summary: [], extract: [] }, contextTokenBudget: 32000 },
    })
    expect(skillStoreMocks.loadLinkedSkillContent).toHaveBeenCalledTimes(1)
    expect(res.renderedText).toContain("### 对话潜台词")
    expect(res.renderedText).toContain("让角色说 A 暗示 B")
    expect(res.renderedText).not.toContain("version: 1")
    expect(res.usedTokens).toBeGreaterThan(0)
  })

  it("遵守 disabledSkillIds 过滤：已禁用技能不被装载并记入 missingNames 与 gaps", async () => {
    const s1 = makeSkill({ id: "s1", name: "禁掉的技能", content: "正文", source: "uploaded" })
    const pack = { gaps: [] as NonNullable<ContextPack["gaps"]> }
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue(makeConfig([s1], ["s1"]))

    const res = await resolveRuntimeSkillsForStage({
      projectPath: "/P",
      stage: "outline",
      novelConfig: { taskSkillNames: { writing: [], outline: ["禁掉的技能"], review: [], summary: [], extract: [] }, contextTokenBudget: 32000 },
      pack,
    })
    expect(res.skills).toHaveLength(0)
    expect(res.missingNames).toEqual(["禁掉的技能"])
    expect(pack.gaps.some((g) => g.ref === "runtime_skill:禁掉的技能")).toBe(true)
  })

  it("同名优先级：uploaded > linked(非空) > built-in，linked 空内容时自动降级 built-in 并留痕 gap", async () => {
    const builtin = makeSkill({ id: "builtin:1", name: "爽点设计", source: "built-in", content: "内置爽点规则" })
    const emptyLinked = makeSkill({ id: "linked:1", name: "爽点设计", source: "linked", linkedPath: "/missing", content: "" })
    const uploaded = makeSkill({ id: "up:1", name: "伏笔推进", source: "uploaded", content: "自定义伏笔规则" })
    const builtin2 = makeSkill({ id: "builtin:2", name: "伏笔推进", source: "built-in", content: "内置伏笔规则" })

    // 故意把 built-in 放在数组后面，验证不再被后写覆盖
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue(makeConfig([uploaded, emptyLinked, builtin, builtin2]))
    skillStoreMocks.loadLinkedSkillContent.mockResolvedValue("")

    const pack = { gaps: [] as NonNullable<ContextPack["gaps"]> }
    const res = await resolveRuntimeSkillsForStage({
      projectPath: "/P",
      stage: "writing",
      novelConfig: { taskSkillNames: { writing: ["伏笔推进", "爽点设计"], outline: [], review: [], summary: [], extract: [] }, contextTokenBudget: 32000 },
      pack,
    })

    expect(res.renderedText).toContain("自定义伏笔规则")
    expect(res.renderedText).not.toContain("内置伏笔规则")
    expect(res.renderedText).toContain("内置爽点规则")
    expect(pack.gaps.some((g) => g.ref === "runtime_skill_linked_fallback:爽点设计")).toBe(true)
  })

  it("预算裁剪：长技能超配额按 token 截断写 gap", async () => {
    const longSkill = makeSkill({
      id: "s-long",
      name: "超长文风法典",
      content: "不要用总结腔，保持人物动作与感官锚点。".repeat(400),
      source: "uploaded",
    })
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue(makeConfig([longSkill]))
    const pack = { gaps: [] as NonNullable<ContextPack["gaps"]> }

    const res = await resolveRuntimeSkillsForStage({
      projectPath: "/P",
      stage: "writing",
      novelConfig: { taskSkillNames: { writing: ["超长文风法典"], outline: [], review: [], summary: [], extract: [] }, contextTokenBudget: 24000 },
      maxSkillBudgetTokens: 600,
      pack,
    })

    expect(res.usedTokens).toBeLessThanOrEqual(650)
    expect(res.truncatedNames).toContain("超长文风法典")
    expect(pack.gaps.some((g) => g.type === "truncated" && g.ref === "runtime_skill:超长文风法典")).toBe(true)
  })

  it("computeEffectiveContextTokenBudget 尊重用户 contextTokenBudget 并扣除技能已用 token", () => {
    const budget = computeEffectiveContextTokenBudget(
      { contextTokenBudget: 20000 },
      { maxContextSize: 64000 },
      3000,
    )
    expect(budget).toBe(17000)

    const cappedByWindow = computeEffectiveContextTokenBudget(
      { contextTokenBudget: 100000 },
      { maxContextSize: 32000 },
      2000,
    )
    expect(cappedByWindow).toBe(Math.floor(32000 * 0.65) - 2000)
  })

  it("parseFrontmatter 支持 UTF-8 BOM 开头并正确剥离 frontmatter", () => {
    const parsed = parseFrontmatter("\uFEFF---\ntitle: 测试\n---\n\n正文第一行")
    expect(parsed.frontmatter?.title).toBe("测试")
    expect(parsed.body.trim()).toBe("正文第一行")
  })

  it("De-AI 分级词表支持项目覆盖合并与自定义检测", () => {
    const overrides = {
      ...createEmptyDeAiTieredOverrides(1),
      disabledTerms: [TIERED_DEAI_TABLE[0].term],
      tierOverrides: { [TIERED_DEAI_TABLE[1].term]: "3" as const },
      customEntries: [
        {
          term: "赛博霓虹叹息",
          tier: "1A" as const,
          category: "套话" as const,
          weight: 0.9,
          suggestion: "改为具体街景声音",
        },
      ],
    }
    const merged = mergeTieredDeAiTable(TIERED_DEAI_TABLE, overrides)
    const hits = detectTieredDeAi(`${TIERED_DEAI_TABLE[0].term} 赛博霓虹叹息 ${TIERED_DEAI_TABLE[1].term}`, merged)
    expect(hits.some((h) => h.entry.term === TIERED_DEAI_TABLE[0].term)).toBe(false)
    expect(hits.some((h) => h.entry.term === "赛博霓虹叹息" && h.entry.tier === "1A")).toBe(true)
    expect(hits.some((h) => h.entry.term === TIERED_DEAI_TABLE[1].term && h.entry.tier === "3")).toBe(true)

    // 已豁免词即便同时写入 tierOverrides/customEntries(1A) 也不得注入 1A 必避提示段
    const contradictoryOverrides = {
      ...createEmptyDeAiTieredOverrides(2),
      disabledTerms: ["被豁免伪词", "赛博霓虹叹息"],
      tierOverrides: { 被豁免伪词: "1A" as const },
      customEntries: [
        {
          term: "赛博霓虹叹息",
          tier: "1A" as const,
          category: "套话" as const,
          weight: 0.9,
          suggestion: "改为具体街景声音",
        },
        {
          term: "有效新增禁词",
          tier: "1A" as const,
          category: "套话" as const,
          weight: 0.9,
          suggestion: "删除",
        },
      ],
    }
    const directive = buildTieredDeAiOverrideDirective(contradictoryOverrides)
    expect(directive).toContain("- 项目自定义 1A 必避 AI 词：有效新增禁词")
    expect(directive).not.toContain("1A 必避 AI 词：被豁免伪词")
    expect(directive).toContain("- 项目豁免词（无需强行改写）：被豁免伪词、赛博霓虹叹息")
    const bannedLine = directive.split("\n").find((l) => l.includes("项目自定义 1A 必避 AI 词")) ?? ""
    expect(bannedLine).not.toContain("被豁免伪词")
    expect(bannedLine).not.toContain("赛博霓虹叹息")
  })
})
