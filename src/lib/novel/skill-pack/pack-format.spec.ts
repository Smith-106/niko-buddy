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
