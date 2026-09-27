// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/export/PdfExportDialog.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { PdfExportDialog } from "./PdfExportDialog"
import DefaultExport from "./PdfExportDialog"
import { render } from "@/test-helpers/component-test-utils"
describe("PdfExportDialog.tsx smoke", () => {
  it("renders PdfExportDialog without crashing", () => {
    const { unmount } = render(<PdfExportDialog projectPath="/proj" title="测试标题" paragraphs={["第一段正文"]} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
