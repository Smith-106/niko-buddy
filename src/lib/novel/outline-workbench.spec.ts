/** C4 冒烟覆盖：src/lib/novel/outline-workbench.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_OUTLINE_FOLDERS, DEFAULT_OUTLINE_FOLDER_PATHS, LEGACY_OUTLINE_FOLDER_MIGRATIONS, isPathInsideOutlineRoot, sanitizeOutlineFileNamePart, formatChapterOutlineFileName, planOutlineFileMove, inferOutlineSaveTarget } from "./outline-workbench"
describe("outline-workbench.ts smoke", () => {
  it("exports DEFAULT_OUTLINE_FOLDERS", () => {
    expect(DEFAULT_OUTLINE_FOLDERS).toBeDefined()
  })
  it("exports DEFAULT_OUTLINE_FOLDER_PATHS", () => {
    expect(DEFAULT_OUTLINE_FOLDER_PATHS).toBeDefined()
  })
  it("exports LEGACY_OUTLINE_FOLDER_MIGRATIONS", () => {
    expect(LEGACY_OUTLINE_FOLDER_MIGRATIONS).toBeDefined()
  })
  it("exports isPathInsideOutlineRoot", () => {
    expect(isPathInsideOutlineRoot).toBeDefined()
  })
  it("exports sanitizeOutlineFileNamePart", () => {
    expect(sanitizeOutlineFileNamePart).toBeDefined()
  })
  it("exports formatChapterOutlineFileName", () => {
    expect(formatChapterOutlineFileName).toBeDefined()
  })
  it("exports planOutlineFileMove", () => {
    expect(planOutlineFileMove).toBeDefined()
  })
  it("exports inferOutlineSaveTarget", () => {
    expect(inferOutlineSaveTarget).toBeDefined()
  })
})
