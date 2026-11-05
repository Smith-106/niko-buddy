/** skill-library 全分支行为测试（重写空壳 spec）：normalizeUserSkill 归一化 + filterUserSkills 过滤。 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_SKILL_PRIORITY,
  SKILL_KIND_LABELS,
  SKILL_MODE_LABELS,
  SKILL_STAGE_LABELS,
  filterUserSkills,
  normalizeUserSkill,
  type UserSkill,
} from "./skill-library"

function baseSkill(overrides: Partial<UserSkill> = {}): UserSkill {
  return {
    id: "s1",
    name: "技能一",
    description: "描述",
    kind: ["style"],
    stages: ["rewrite"],
    modes: ["standard"],
    content: "内容",
    source: "project",
    priority: 50,
    tags: [],
    categoryId: "c1",
    ...overrides,
  }
}

/**
 * 故意传入形状非法的原始值，验证 normalizeUserSkill 的运行时收敛。
 * 生产签名是 Partial<UserSkill>，而这些用例要证明的正是「非法值不会泄漏出去」，
 * 所以必须在调用点显式声明「这是刻意的非法输入」，而不是在断言里放宽类型。
 */
function normRaw(value: Record<string, unknown>): UserSkill {
  return normalizeUserSkill(value as unknown as Partial<UserSkill>)
}

describe("normalizeUserSkill · source 收敛", () => {
  it("built-in/uploaded/linked 原样保留，缺省与非法值收敛为 project", () => {
    expect(normRaw({ source: "built-in" }).source).toBe("built-in")
    expect(normRaw({ source: "uploaded" }).source).toBe("uploaded")
    expect(normRaw({ source: "linked" }).source).toBe("linked")
    expect(normRaw({}).source).toBe("project")
    expect(normRaw({ source: "project" }).source).toBe("project")
    expect(normRaw({ source: "other" }).source).toBe("project")
    expect(normRaw({ source: 42 }).source).toBe("project")
  })
})

describe("normalizeUserSkill · priority 钳制", () => {
  it("缺省取 DEFAULT_SKILL_PRIORITY，越界钳制到 [1,100]，小数四舍五入", () => {
    expect(normRaw({}).priority).toBe(DEFAULT_SKILL_PRIORITY)
    expect(normRaw({ priority: "high" }).priority).toBe(DEFAULT_SKILL_PRIORITY)
    expect(normRaw({ priority: 200 }).priority).toBe(100)
    expect(normRaw({ priority: -5 }).priority).toBe(1)
    expect(normRaw({ priority: 50.6 }).priority).toBe(51)
    expect(normRaw({ priority: 50.4 }).priority).toBe(50)
  })
})

describe("normalizeUserSkill · tags 归一化", () => {
  it("非数组取空；非字符串/空白跳过；去重保首见序", () => {
    expect(normRaw({ tags: "x" }).tags).toEqual([])
    expect(normRaw({}).tags).toEqual([])
    const skill = normRaw({
      tags: ["  a ", "a", "", "   ", 42, "b", "a ", null, "b"],
    })
    expect(skill.tags).toEqual(["a", "b"])
  })
})

describe("normalizeUserSkill · 标识与文本字段", () => {
  it("id 缺失或空白时按 project:<ts> 生成，有效值去首尾空格", () => {
    expect(normRaw({ id: "  s9  " }).id).toBe("s9")
    expect(normRaw({}).id.startsWith("project:")).toBe(true)
    expect(normRaw({ id: "   " }).id.startsWith("project:")).toBe(true)
    expect(normRaw({ id: 7 }).id.startsWith("project:")).toBe(true)
  })

  it("name 空白或缺失取默认，有效值去首尾空格", () => {
    expect(normRaw({ name: "  写作  " }).name).toBe("写作")
    expect(normRaw({}).name).toBe("未命名技能")
    expect(normRaw({ name: "  " }).name).toBe("未命名技能")
    expect(normRaw({ name: 9 }).name).toBe("未命名技能")
  })

  it("description/content 非字符串取空，字符串去首尾空格", () => {
    expect(normRaw({ description: "  d  " }).description).toBe("d")
    expect(normRaw({ description: 5 }).description).toBe("")
    expect(normRaw({}).description).toBe("")
    expect(normRaw({ content: "  c  " }).content).toBe("c")
    expect(normRaw({ content: null }).content).toBe("")
  })
})

describe("normalizeUserSkill · kind/stages/modes 校验", () => {
  it("有效值保留、非法值丢弃、重复去重、首见序不变", () => {
    const skill = normRaw({
      kind: ["style", "bogus", "style", 42, "review"],
      stages: ["drafting", "nope", "drafting"],
      modes: ["fast", "wrong", "fast"],
    })
    expect(skill.kind).toEqual(["style", "review"])
    expect(skill.stages).toEqual(["drafting"])
    expect(skill.modes).toEqual(["fast"])
  })

  it("非数组/全非法/空数组时取默认回退", () => {
    expect(normRaw({ kind: "style" }).kind).toEqual(["style"])
    expect(normRaw({ kind: ["bogus"] }).kind).toEqual(["style"])
    expect(normRaw({ kind: [] }).kind).toEqual(["style"])
    expect(normRaw({ stages: null }).stages).toEqual(["rewrite", "output"])
    expect(normRaw({ stages: ["bogus"] }).stages).toEqual(["rewrite", "output"])
    expect(normRaw({ modes: undefined }).modes).toEqual(["standard", "strict"])
    expect(normRaw({ modes: ["bogus"] }).modes).toEqual(["standard", "strict"])
  })
})

describe("normalizeUserSkill · linkedPath/categoryId/时间戳", () => {
  it("仅 linked + 字符串路径才保留 linkedPath", () => {
    expect(normRaw({ source: "linked", linkedPath: "/p/a.md" }).linkedPath).toBe("/p/a.md")
    expect(normRaw({ source: "linked" }).linkedPath).toBeUndefined()
    expect(normRaw({ source: "linked", linkedPath: 5 }).linkedPath).toBeUndefined()
    expect(normRaw({ source: "project", linkedPath: "/p/a.md" }).linkedPath).toBeUndefined()
  })

  it("categoryId 非字符串取空字符串", () => {
    expect(normRaw({ categoryId: "c9" }).categoryId).toBe("c9")
    expect(normRaw({}).categoryId).toBe("")
    expect(normRaw({ categoryId: 3 }).categoryId).toBe("")
  })

  it("createdAt/updatedAt 仅数字保留", () => {
    expect(normRaw({ createdAt: 100, updatedAt: 200 }).createdAt).toBe(100)
    expect(normRaw({ createdAt: 100, updatedAt: 200 }).updatedAt).toBe(200)
    expect(normRaw({}).createdAt).toBeUndefined()
    expect(normRaw({}).updatedAt).toBeUndefined()
    expect(normRaw({ createdAt: "100" }).createdAt).toBeUndefined()
    expect(normRaw({ updatedAt: "200" }).updatedAt).toBeUndefined()
  })
})

describe("filterUserSkills · 过滤语义", () => {
  const skills = [
    baseSkill({ id: "a", modes: ["fast"], stages: ["drafting"], kind: ["style"] }),
    baseSkill({ id: "b", modes: ["strict"], stages: ["review"], kind: ["review"] }),
  ]

  it("无过滤条件全部通过", () => {
    expect(filterUserSkills(skills, {}).map((s) => s.id)).toEqual(["a", "b"])
  })

  it("mode/stage/kind 命中保留、未命中过滤", () => {
    expect(filterUserSkills(skills, { mode: "fast" }).map((s) => s.id)).toEqual(["a"])
    expect(filterUserSkills(skills, { stage: "review" }).map((s) => s.id)).toEqual(["b"])
    expect(filterUserSkills(skills, { kind: "style" }).map((s) => s.id)).toEqual(["a"])
    expect(filterUserSkills(skills, { mode: "standard" })).toEqual([])
  })

  it("多条件交集：任一不满足即过滤", () => {
    expect(filterUserSkills(skills, { mode: "fast", stage: "drafting" }).map((s) => s.id)).toEqual(["a"])
    expect(filterUserSkills(skills, { mode: "fast", stage: "review" })).toEqual([])
    expect(filterUserSkills(skills, { mode: "fast", kind: "review" })).toEqual([])
  })
})

describe("标签常量 · 冒烟", () => {
  it("标签表覆盖全部枚举键", () => {
    expect(Object.keys(SKILL_KIND_LABELS).sort()).toEqual(
      ["knowledge", "output", "planning", "review", "rewrite", "style", "structure"].sort(),
    )
    expect(Object.keys(SKILL_STAGE_LABELS).sort()).toEqual(
      ["drafting", "output", "planning", "review", "rewrite"].sort(),
    )
    expect(Object.keys(SKILL_MODE_LABELS).sort()).toEqual(["fast", "standard", "strict"].sort())
    expect(SKILL_KIND_LABELS.style).toBe("风格")
    expect(SKILL_STAGE_LABELS.drafting).toBe("正文")
    expect(SKILL_MODE_LABELS.strict).toBe("严格")
    expect(DEFAULT_SKILL_PRIORITY).toBe(50)
  })
})
