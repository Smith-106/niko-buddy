/** C4 冒烟覆盖：src/lib/novel/skill-pack/pack-format.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { NBSKILL_PACK_SCHEMA_VERSION, NBSKILL_PACK_EXTENSION, NBSKILL_PACK_KIND, PACK_TOOL_CATEGORIES, PACK_TRUST_LEVELS, PACK_TOOL_NAME_PATTERN, PACK_NAME_PATTERN, isAllowedToolCategory, formatIssuePath, packToolSpecSchema, packPromptSpecSchema, nbskillPackSchema, parseNbskillPack, packFileName } from "./pack-format"
describe("pack-format.ts smoke", () => {
  it("exports NBSKILL_PACK_SCHEMA_VERSION", () => {
    expect(NBSKILL_PACK_SCHEMA_VERSION).toBeDefined()
  })
  it("exports NBSKILL_PACK_EXTENSION", () => {
    expect(NBSKILL_PACK_EXTENSION).toBeDefined()
  })
  it("exports NBSKILL_PACK_KIND", () => {
    expect(NBSKILL_PACK_KIND).toBeDefined()
  })
  it("exports PACK_TOOL_CATEGORIES", () => {
    expect(PACK_TOOL_CATEGORIES).toBeDefined()
  })
  it("exports PACK_TRUST_LEVELS", () => {
    expect(PACK_TRUST_LEVELS).toBeDefined()
  })
  it("exports PACK_TOOL_NAME_PATTERN", () => {
    expect(PACK_TOOL_NAME_PATTERN).toBeDefined()
  })
  it("exports PACK_NAME_PATTERN", () => {
    expect(PACK_NAME_PATTERN).toBeDefined()
  })
  it("exports isAllowedToolCategory", () => {
    expect(isAllowedToolCategory).toBeDefined()
  })
  it("exports formatIssuePath", () => {
    expect(formatIssuePath).toBeDefined()
  })
  it("exports packToolSpecSchema", () => {
    expect(packToolSpecSchema).toBeDefined()
  })
  it("exports packPromptSpecSchema", () => {
    expect(packPromptSpecSchema).toBeDefined()
  })
  it("exports nbskillPackSchema", () => {
    expect(nbskillPackSchema).toBeDefined()
  })
  it("exports parseNbskillPack", () => {
    expect(parseNbskillPack).toBeDefined()
  })
  it("exports packFileName", () => {
    expect(packFileName).toBeDefined()
  })
})

/** 行为补测（g08）：formatIssuePath 数值下标 + name_invalid 专属错误码。 */
describe("pack-format.ts 行为补测", () => {
  it("formatIssuePath 把 zod 数值路径渲染成 tools[0].category", () => {
    expect(formatIssuePath(["tools", 0, "category"])).toBe("tools[0].category")
    expect(formatIssuePath([0, "name"])).toBe("[0].name")
    expect(formatIssuePath([])).toBe("")
  })

  it("name 不合规 → 专属 name_invalid（不是宽泛的 schema_invalid）", () => {
    const result = parseNbskillPack({
      schemaVersion: NBSKILL_PACK_SCHEMA_VERSION,
      name: "Bad Name",
      version: "1.0.0",
      author: "someone",
      tools: [],
      prompts: [],
      trustLevel: "untrusted",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ code: "name_invalid", at: "name" })
    expect(result.issues[0]!.detail).toContain("name must match")
  })

  it("合规范但缺 author 的包 → ok:true 且给出 trust 警告", () => {
    const result = parseNbskillPack({
      schemaVersion: NBSKILL_PACK_SCHEMA_VERSION,
      name: "no-author-pack",
      version: "1.0.0",
      author: "   ",
      tools: [],
      prompts: [],
      trustLevel: "untrusted",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("pack declares no author")
  })
})
