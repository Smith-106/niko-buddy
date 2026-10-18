import { describe, expect, it } from "vitest"

import {
  projectAgentCapabilityMatrix,
  roleRequirementsFromDimensions,
  type CapabilityRole,
  type CapabilitySkill,
} from "./agent-capability-matrix"

const SKILLS: CapabilitySkill[] = [
  { name: "人物设计", kinds: ["character"] },
  { name: "伏笔管理", kinds: ["foreshadowing"] },
  { name: "节奏控制", stages: ["draft"] },
  { name: "无人问津技能", kinds: ["sound-design"] },
]

const ROLES: CapabilityRole[] = [
  { id: "character-agent", label: "人物关系 Agent", kinds: ["character"] },
  { id: "outline-agent", label: "大纲 Agent", kinds: ["character", "foreshadowing", "topic"] },
  { id: "rhythm-agent", label: "节奏 Agent", stages: ["draft"] },
]

describe("projectAgentCapabilityMatrix", () => {
  it("按 kinds/stages 交集算覆盖：命中技能按码点序、缺失能力单独列出", () => {
    const matrix = projectAgentCapabilityMatrix({ skills: SKILLS, roles: ROLES })
    const outline = matrix.rows.find((row) => row.roleId === "outline-agent")!
    expect(outline.matchedSkills).toEqual(["人物设计", "伏笔管理"])
    // topic 没有任何技能声明 → 必须报缺口，而不是当成已覆盖
    expect(outline.missingCapabilities).toEqual(["topic"])
    expect(matrix.rows.map((row) => row.roleId)).toEqual([
      "character-agent",
      "outline-agent",
      "rhythm-agent",
    ])
  })

  it("全局缺口 = 所有角色都没人覆盖的能力；被任一角色覆盖则不进全局缺口", () => {
    const matrix = projectAgentCapabilityMatrix({ skills: SKILLS, roles: ROLES })
    expect(matrix.missingCapabilities).toEqual(["topic"])
    // character 被两个角色覆盖、draft 被节奏 Agent 覆盖 → 都不该在全局缺口里
    expect(matrix.missingCapabilities).not.toContain("character")
    expect(matrix.missingCapabilities).not.toContain("draft")
  })

  it("无人需要的技能进 unusedSkills（冗余候选，不是错误）", () => {
    const matrix = projectAgentCapabilityMatrix({ skills: SKILLS, roles: ROLES })
    expect(matrix.unusedSkills).toEqual(["无人问津技能"])
  })

  it("skillsLoaded=false → 不下覆盖结论：matched/missing 都空，且写 N/A", () => {
    const matrix = projectAgentCapabilityMatrix({ skills: SKILLS, roles: ROLES, skillsLoaded: false })
    expect(matrix.rows.every((row) => row.matchedSkills.length === 0)).toBe(true)
    expect(matrix.rows.every((row) => row.missingCapabilities.length === 0)).toBe(true)
    // 关键：未装载不能说成「零覆盖」，也不能把技能判成冗余
    expect(matrix.missingCapabilities).toEqual([])
    expect(matrix.unusedSkills).toEqual([])
    expect(matrix.na.some((line) => line.includes("技能库未装载"))).toBe(true)
    expect(matrix.na.some((line) => line.includes("不是「零技能覆盖」"))).toBe(true)
  })

  it("未声明标记的技能进 N/A，不参与匹配也不被算成冗余", () => {
    const matrix = projectAgentCapabilityMatrix({
      skills: [{ name: "裸技能" }, ...SKILLS],
      roles: ROLES,
    })
    expect(matrix.na.some((line) => line.includes("裸技能"))).toBe(true)
    expect(matrix.unusedSkills).not.toContain("裸技能")
  })

  it("没有角色定义时写 N/A，不假装「不需要技能」", () => {
    const matrix = projectAgentCapabilityMatrix({ skills: SKILLS, roles: [] })
    expect(matrix.rows).toEqual([])
    expect(matrix.na.some((line) => line.includes("没有任何角色定义"))).toBe(true)
  })

  it("同输入必得同输出（稳定排序，不随插入顺序漂移）", () => {
    const a = projectAgentCapabilityMatrix({ skills: SKILLS, roles: ROLES })
    const b = projectAgentCapabilityMatrix({
      skills: [...SKILLS].reverse(),
      roles: [...ROLES].reverse(),
    })
    expect(a).toEqual(b)
  })

  it("counts 反映规模：覆盖角色数 != 角色总数时能被断言", () => {
    const matrix = projectAgentCapabilityMatrix({
      skills: [{ name: "人物设计", kinds: ["character"] }],
      roles: ROLES,
    })
    expect(matrix.counts).toEqual({ skills: 1, roles: 3, coveredRoles: 2 })
  })

  it("重复标记去重，且空标记被忽略", () => {
    const matrix = projectAgentCapabilityMatrix({
      skills: [{ name: "人物设计", kinds: ["character", "character", "  "] }],
      roles: [{ id: "r1", label: "R1", kinds: ["character", "character"] }],
    })
    expect(matrix.rows[0]!.missingCapabilities).toEqual([])
    expect(matrix.rows[0]!.matchedSkills).toEqual(["人物设计"])
  })
})

describe("roleRequirementsFromDimensions", () => {
  it("维度有映射时用映射的标记，无映射时原样保留维度名（不静默丢弃）", () => {
    const roles = roleRequirementsFromDimensions(["人物关系", "节奏", "未知维度"], {
      人物关系: ["character"],
    })
    expect(roles.map((role) => role.id)).toEqual(["人物关系", "未知维度", "节奏"].sort())
    const relation = roles.find((role) => role.id === "人物关系")!
    const unknown = roles.find((role) => role.id === "未知维度")!
    expect(relation.kinds).toEqual(["character"])
    expect(unknown.kinds).toEqual(["未知维度"])
  })

  it("空白维度被丢弃，不生成空角色", () => {
    expect(roleRequirementsFromDimensions(["  ", ""])).toEqual([])
  })
})
