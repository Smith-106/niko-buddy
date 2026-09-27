/** C4 冒烟覆盖：src/lib/export/pdf-client.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DATA_SECTIONS, LINE_HEIGHT_RATIO, CJK_FONT_FILE, PATH_INSIDE_DATA_SECTION_PREFIX, isPathInsideDataSection, validateExportTarget, isPathInsideDataSectionError, exportPdf } from "./pdf-client"
describe("pdf-client.ts smoke", () => {
  it("exports DATA_SECTIONS", () => {
    expect(DATA_SECTIONS).toBeDefined()
  })
  it("exports LINE_HEIGHT_RATIO", () => {
    expect(LINE_HEIGHT_RATIO).toBeDefined()
  })
  it("exports CJK_FONT_FILE", () => {
    expect(CJK_FONT_FILE).toBeDefined()
  })
  it("exports PATH_INSIDE_DATA_SECTION_PREFIX", () => {
    expect(PATH_INSIDE_DATA_SECTION_PREFIX).toBeDefined()
  })
  it("exports isPathInsideDataSection", () => {
    expect(isPathInsideDataSection).toBeDefined()
  })
  it("exports validateExportTarget", () => {
    expect(validateExportTarget).toBeDefined()
  })
  it("exports isPathInsideDataSectionError", () => {
    expect(isPathInsideDataSectionError).toBeDefined()
  })
  it("exports exportPdf", () => {
    expect(exportPdf).toBeDefined()
  })
})
