/** C4 冒烟覆盖：src/lib/novel/skill-seed.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_BUILTIN_WRITING_SKILLS, getBuiltinSkillIds } from "./skill-seed"
describe("skill-seed.ts smoke", () => {
  it("exports DEFAULT_BUILTIN_WRITING_SKILLS", () => {
    expect(DEFAULT_BUILTIN_WRITING_SKILLS).toBeDefined()
  })
  it("getBuiltinSkillIds() executes", async () => {
    await (getBuiltinSkillIds() as unknown as Promise<unknown>)
  })
})
