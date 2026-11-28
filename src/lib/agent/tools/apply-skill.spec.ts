/** C4 冒烟覆盖：src/lib/agent/tools/apply-skill.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { toOpenAITools } from "../tools-schema"
import { createApplySkillTool } from "./apply-skill"
describe("apply-skill.ts smoke", () => {
  it("exports createApplySkillTool", () => {
    expect(createApplySkillTool).toBeDefined()
  })
})

describe("apply-skill 缺配置", () => {
  it("配置未加载且无用户技能 → 明确报错", async () => {
    const tool = createApplySkillTool(() => null, () => [])
    const out = await tool.execute({ name: "任意技能" }, {} as never)
    expect(String(out)).toContain("技能库配置未加载")
  })
})

describe("apply-skill 静态 schema 字节稳定性", () => {
  const makeSkill = (index: number) => ({
    id: `skill:custom-${index}`,
    name: `写作规范_${index}`,
    description: `说明 ${index}`,
    kind: ["style"] as const,
    stages: ["drafting"] as const,
    modes: ["standard"] as const,
    content: `规则正文 ${index}`,
    source: "project" as const,
  })

  it("1 个技能与 10 个技能的序列化 tool schema 逐字节一致且不含动态技能名", () => {
    const tool0 = createApplySkillTool(() => null, () => [])
    const tool1 = createApplySkillTool(() => null, () => [makeSkill(1)] as never)
    const tool10 = createApplySkillTool(
      () => null,
      () => Array.from({ length: 10 }, (_, idx) => makeSkill(idx + 1)) as never,
    )

    const json0 = JSON.stringify(toOpenAITools([tool0]))
    const json1 = JSON.stringify(toOpenAITools([tool1]))
    const json10 = JSON.stringify(toOpenAITools([tool10]))

    expect(json1).toBe(json0)
    expect(json10).toBe(json1)
    expect(tool10.description).not.toContain("写作规范_1")
    expect(tool10.parameters.skillName?.description).not.toContain("写作规范_1")
  })

  it("静态 schema 下空参 execute 仍返回完整排序技能清单且可按名称读取模板", async () => {
    const tool = createApplySkillTool(
      () => null,
      () => [makeSkill(2), makeSkill(1)] as never,
    )
    const listOut = await tool.execute({})
    expect(listOut).toContain("写作规范_1")
    expect(listOut).toContain("写作规范_2")
    const applyOut = await tool.execute({ skillName: "写作规范_2" })
    expect(applyOut).toContain("规则正文 2")
  })
})
