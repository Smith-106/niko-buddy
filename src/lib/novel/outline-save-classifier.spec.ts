/** C4 冒烟覆盖：src/lib/novel/outline-save-classifier.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { sanitizeOutlineFileNamePart, formatChapterOutlineFileName, getDefaultFolderForOutlineFileType, inferOutlineFileTypeFromSkills, classifyOutlineSaveTarget } from "./outline-save-classifier"
describe("outline-save-classifier.ts smoke", () => {
  it("exports sanitizeOutlineFileNamePart", () => {
    expect(sanitizeOutlineFileNamePart).toBeDefined()
  })
  it("exports formatChapterOutlineFileName", () => {
    expect(formatChapterOutlineFileName).toBeDefined()
  })
  it("exports getDefaultFolderForOutlineFileType", () => {
    expect(getDefaultFolderForOutlineFileType).toBeDefined()
  })
  it("exports inferOutlineFileTypeFromSkills", () => {
    expect(inferOutlineFileTypeFromSkills).toBeDefined()
  })
  it("exports classifyOutlineSaveTarget", () => {
    expect(classifyOutlineSaveTarget).toBeDefined()
  })
})
