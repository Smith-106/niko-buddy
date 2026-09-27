/** C4 冒烟覆盖：src/lib/novel/skill-pack/pack-import.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
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
