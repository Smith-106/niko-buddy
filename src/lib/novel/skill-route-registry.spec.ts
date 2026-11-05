/** skill-route-registry 分支覆盖专项（覆盖率战役第九批）：全函数真实行为 + 条件双臂断言。 */
import { describe, expect, it } from "vitest"
import {
  SKILL_ROUTE_DEFINITIONS,
  collectExplicitSkills,
  findSkillRouteByAlias,
  getOutlineSkillNames,
  getSkillRouteSkillNames,
  getWritingSkillNames,
  hasExplicitReferenceId,
  resolveAvailableSkillsByNames,
  resolveDraftRoute,
  resolveSkillReference,
  uniqueSkillsById,
  validateSkillRouteRegistry,
} from "./skill-route-registry"
import type { UserSkill } from "./skill-library"

function userSkill(overrides: { id: string; name: string }): UserSkill {
  return {
    id: overrides.id,
    name: overrides.name,
    description: "测试技能",
    kind: [],
    stages: [],
    modes: [],
    content: "内容",
    source: "project",
    priority: 0,
    tags: [],
    categoryId: "cat-1",
  } as unknown as UserSkill
}

describe("hasExplicitReferenceId（显式参考 ID 判定）", () => {
  it("空串 → false（!text 真臂）", () => {
    expect(hasExplicitReferenceId("")).toBe(false)
  })

  it("无 ID 的正文 → false（some 全假）", () => {
    expect(hasExplicitReferenceId("今天我们来聊聊范文和拆书，没有编号。")).toBe(false)
  })

  it("范文ID → true", () => {
    expect(hasExplicitReferenceId("范文ID: ABC123 请仿写")).toBe(true)
  })

  it("拆书报告：→ true", () => {
    expect(hasExplicitReferenceId("拆书报告：第一期")).toBe(true)
  })

  it("exemplar-id → true（大小写不敏感）", () => {
    expect(hasExplicitReferenceId("Exemplar-ID: abc")).toBe(true)
  })

  it("拆书id → true", () => {
    expect(hasExplicitReferenceId("参考拆书id: xyz")).toBe(true)
  })
})

describe("resolveDraftRoute（三元双臂）", () => {
  it("显式 ID → route-b-reference", () => {
    expect(resolveDraftRoute("范文ID: ABC123 请仿写")).toBe("route-b-reference")
  })

  it("无 ID / 空串 → route-a-direct", () => {
    expect(resolveDraftRoute("请直接写一章")).toBe("route-a-direct")
    expect(resolveDraftRoute("")).toBe("route-a-direct")
  })
})

describe("findSkillRouteByAlias（空输入 / 精确 / 子串 / 未命中）", () => {
  it("空串与空白括号串 → undefined（!normalized 真臂）", () => {
    expect(findSkillRouteByAlias("")).toBeUndefined()
    expect(findSkillRouteByAlias("   「」")).toBeUndefined()
  })

  it("精确别名 → character_design", () => {
    expect(findSkillRouteByAlias("人物小传")?.task).toBe("character_design")
  })

  it("长文本子串命中 → character_design（=== 假 + includes 真）", () => {
    expect(findSkillRouteByAlias("帮我写一段人物小传番外")?.task).toBe("character_design")
  })

  it("未知别名 → undefined（find 未命中 + ?. 空臂）", () => {
    expect(findSkillRouteByAlias("不存在的别名xyz")).toBeUndefined()
  })
})

describe("getOutlineSkillNames（!definition / outline / review / drafting）", () => {
  it("outline 阶段 → 技能名非空", () => {
    const names = getOutlineSkillNames("人物小传")
    expect(names).toContain("character-design")
  })

  it("review 阶段 → 技能名非空（stage !== outline 真 + !== review 假）", () => {
    const names = getOutlineSkillNames("大纲质量检查")
    expect(names).toContain("outline-quality-check")
  })

  it("drafting 阶段 → []（两 !== 皆真）", () => {
    expect(getOutlineSkillNames("编写章节")).toEqual([])
  })

  it("未知别名与空串 → []（!definition 真）", () => {
    expect(getOutlineSkillNames("不存在的别名xyz")).toEqual([])
    expect(getOutlineSkillNames("")).toEqual([])
  })
})

describe("getSkillRouteSkillNames", () => {
  it("合并 primary + supporting", () => {
    const definition = SKILL_ROUTE_DEFINITIONS[0]!
    expect(getSkillRouteSkillNames(definition)).toEqual([
      ...definition.primarySkills,
      ...definition.supportingSkills,
    ])
  })
})

describe("getWritingSkillNames（意图门 + 四路开关）", () => {
  it("非写作意图 → []（意图门真臂）", () => {
    expect(getWritingSkillNames("general_chat", "战斗场面")).toEqual([])
  })

  it("短篇开关真 → short；长篇回落（else 臂）", () => {
    const short = getWritingSkillNames("write_chapter", "短篇知乎故事")
    expect(short).toContain("short-form-drafting")
    expect(short).not.toContain("long-form-drafting")

    const long = getWritingSkillNames("write_chapter", "编写章节正文")
    expect(long).toContain("long-form-drafting")
    expect(long).not.toContain("short-form-drafting")
  })

  it("战斗开关真 / 假", () => {
    expect(getWritingSkillNames("continue_chapter", "续写战斗追逐章节")).toContain("combat-action")
    expect(getWritingSkillNames("continue_chapter", "续写温馨日常章节")).not.toContain("combat-action")
  })

  it("对话开关真 / 假", () => {
    expect(getWritingSkillNames("rewrite_chapter", "改写加入对话情绪对话")).toContain("dialogue-emotion")
    expect(getWritingSkillNames("rewrite_chapter", "改写纯叙事无特殊场景")).not.toContain("dialogue-emotion")
  })

  it("去 AI 味开关真 / 假", () => {
    expect(getWritingSkillNames("polish_chapter", "润色去AI味最终润色")).toContain("anti-ai-polish")
    expect(getWritingSkillNames("polish_chapter", "普通润色")).not.toContain("anti-ai-polish")
  })
})

describe("resolveAvailableSkillsByNames（缺失 / 去重 / 同 id 合并）", () => {
  it("缺失进 missing；同 id 不同名只收录一次；重名输入去重", () => {
    const skillA = userSkill({ id: "dup", name: "skill-a" })
    const skillB = userSkill({ id: "dup", name: "skill-b" })
    const result = resolveAvailableSkillsByNames([skillA, skillB], ["skill-a", "skill-b", "missing-x", "skill-a"])
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]!.id).toBe("dup")
    expect(result.missingNames).toEqual(["missing-x"])
  })

  it("全部命中 → missing 为空", () => {
    const skillA = userSkill({ id: "a", name: "skill-a" })
    const result = resolveAvailableSkillsByNames([skillA], ["skill-a"])
    expect(result.skills).toHaveLength(1)
    expect(result.missingNames).toEqual([])
  })
})

describe("validateSkillRouteRegistry（filter 真假双臂）", () => {
  it("空集合 → 全部缺失；全量集合 → 空", () => {
    const missing = validateSkillRouteRegistry([])
    expect(missing).toContain("chapter-outline-builder")
    expect(missing.length).toBeGreaterThan(0)

    const all = [...new Set(SKILL_ROUTE_DEFINITIONS.flatMap((d) => [...d.primarySkills, ...d.supportingSkills]))]
    expect(validateSkillRouteRegistry(all)).toEqual([])
  })
})

describe("resolveSkillReference（id / name / 别名路由）", () => {
  const skillA = userSkill({ id: "a", name: "character-design" })
  const skillB = userSkill({ id: "b", name: "long-form-drafting" })
  const skills = [skillA, skillB]

  it("id 命中 → 直接返回", () => {
    expect(resolveSkillReference(skills, { id: "a" })).toBe(skillA)
  })

  it("id 未命中 → undefined", () => {
    expect(resolveSkillReference(skills, { id: "nope" })).toBeUndefined()
  })

  it("空白 id 回落到 name 精确命中", () => {
    expect(resolveSkillReference(skills, { id: "   ", name: "long-form-drafting" })).toBe(skillB)
  })

  it("无 id 无 name → undefined（!name 真臂）", () => {
    expect(resolveSkillReference(skills, {})).toBeUndefined()
    expect(resolveSkillReference(skills, { name: "   " })).toBeUndefined()
  })

  it("name 精确命中", () => {
    expect(resolveSkillReference(skills, { name: "character-design" })).toBe(skillA)
  })

  it("中文别名经路由到 canonical 并命中", () => {
    expect(resolveSkillReference(skills, { name: "人物小传" })).toBe(skillA)
  })

  it("中文别名路由命中但仓库无 canonical → undefined", () => {
    expect(resolveSkillReference([skillB], { name: "人物小传" })).toBeUndefined()
  })

  it("未知 name 无路由 → undefined（canonical 假臂）", () => {
    expect(resolveSkillReference(skills, { name: "子虚乌有的技能xyz" })).toBeUndefined()
  })

  it("括号名归一化为空 → 别名路由空臂（!normalized 真）", () => {
    expect(resolveSkillReference(skills, { name: "「」" })).toBeUndefined()
  })
})

describe("uniqueSkillsById（some 真假双臂）", () => {
  it("同 id 去重", () => {
    const a1 = userSkill({ id: "a", name: "n1" })
    const a2 = userSkill({ id: "a", name: "n2" })
    const b = userSkill({ id: "b", name: "n3" })
    expect(uniqueSkillsById([a1, a2, b])).toHaveLength(2)
    expect(uniqueSkillsById([b])).toHaveLength(1)
  })
})

describe("collectExplicitSkills（引用 + 子串 + 短名跳过）", () => {
  const longSkill = userSkill({ id: "s-long", name: "character-design" })
  const shortSkill = userSkill({ id: "s-short", name: "ab" })
  const skills = [longSkill, shortSkill]

  it("引用命中 + 空消息提前返回", () => {
    expect(collectExplicitSkills(skills, "", [{ skillId: "s-long" }])).toEqual([longSkill])
  })

  it("未知引用忽略；重复引用合并为一条", () => {
    const collected = collectExplicitSkills(skills, "今天天气不错", [
      { skillId: "nope" },
      { skillId: "s-long" },
      { title: "character-design" },
    ])
    expect(collected).toEqual([longSkill])
  })

  it("默认 references 参数 + 消息子串命中", () => {
    expect(collectExplicitSkills(skills, "请使用 character-design 帮忙")).toEqual([longSkill])
  })

  it("短名（<4 字符）跳过；无命中返回空", () => {
    expect(collectExplicitSkills(skills, "请使用 ab 和 character-design")).toEqual([longSkill])
    expect(collectExplicitSkills(skills, "今天天气不错")).toEqual([])
    expect(collectExplicitSkills([], "")).toEqual([])
  })
})
