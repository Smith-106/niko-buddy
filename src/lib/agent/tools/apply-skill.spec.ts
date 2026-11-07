/** C4 冒烟覆盖：src/lib/agent/tools/apply-skill.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
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
