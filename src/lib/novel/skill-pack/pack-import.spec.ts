/** C4 冒烟覆盖：src/lib/novel/skill-pack/pack-import.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { normalizeUserSkill, type UserSkill } from "../skill-library"
import type { UserSkillConfig } from "../user-skill-store"
import { importNbskillPack, importedSkillsTargetFile, importedSkillsOf } from "./pack-import"
describe("pack-import.ts smoke", () => {
  it("exports importNbskillPack", () => {
    expect(importNbskillPack).toBeDefined()
  })
  it("importedSkillsTargetFile() executes", async () => {
    await (importedSkillsTargetFile() as unknown as Promise<unknown>)
  })
  it("exports importedSkillsOf", () => {
    expect(importedSkillsOf).toBeDefined()
  })
})

// importedSkillsOf 是「已导入技能」的唯一只读视图：必须只挑 source==="uploaded"，
// 且不得修改传入配置（调用方可能是共享的会话配置对象）。
function skillOf(name: string, source: UserSkill["source"]): UserSkill {
  return normalizeUserSkill({ id: `${source}:${name}`, name, source })
}

describe("importedSkillsOf（只读视图：只挑 uploaded）", () => {
  it("只返回 source=uploaded 的技能，built-in/project/linked 全不出现", () => {
    const config: UserSkillConfig = {
      version: 1,
      selectedSkillId: null,
      disabledSkillIds: [],
      skills: [
        skillOf("导入甲", "uploaded"),
        skillOf("内建乙", "built-in"),
        skillOf("项目丙", "project"),
        skillOf("链接丁", "linked"),
        skillOf("导入戊", "uploaded"),
      ],
      categories: [],
    }

    const imported = importedSkillsOf(config)

    expect(imported.map((skill) => skill.name)).toEqual(["导入甲", "导入戊"])
    expect(imported.every((skill) => skill.source === "uploaded")).toBe(true)
  })

  it("不修改传入配置（顺序与条数原样），且无 uploaded 时返回空数组", () => {
    const skills = [skillOf("内建乙", "built-in"), skillOf("项目丙", "project")]
    const before = skills.map((skill) => skill.id)
    const config: UserSkillConfig = {
      version: 1,
      selectedSkillId: "project:项目丙",
      disabledSkillIds: [],
      skills,
      categories: [],
    }

    expect(importedSkillsOf(config)).toEqual([])
    expect(config.skills.map((skill) => skill.id)).toEqual(before)
    expect(config.selectedSkillId).toBe("project:项目丙")
  })
})
