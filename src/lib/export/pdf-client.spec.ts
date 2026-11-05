/** C4 冒烟覆盖：src/lib/export/pdf-client.ts（自动生成，核心行为由专项 spec 加深） */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DATA_SECTIONS, LINE_HEIGHT_RATIO, CJK_FONT_FILE, PATH_INSIDE_DATA_SECTION_PREFIX, isPathInsideDataSection, validateExportTarget, isPathInsideDataSectionError, exportPdf } from "./pdf-client"

// 后端 IPC 桩：`export_pdf` 真渲染由 Rust cargo test 覆盖，此处只验证客户端
// 传输契约（命令名 + 载荷）与「越界不触碰 IPC」的本地前置拦截。
const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args: unknown) => ({
  target: "exports/book.pdf",
  pages: 3,
  paragraphs: 2,
  font: "NotoSerifCJKsc-Regular.otf",
  line_height_ratio: 1.5,
  bytes_written: 1024,
})))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
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

describe("pdf-client.ts 数据区判据（路径段口径）", () => {
  it("空白路径不算数据区，但导出目标校验直接拒绝", () => {
    // 归一化后长度为 0 → 无任何路径段，不算数据区（只在 UI 校验层被拒绝）。
    expect(isPathInsideDataSection("   ")).toBe(false)
    expect(isPathInsideDataSection("")).toBe(false)
    expect(validateExportTarget("")).toBe("pdfexport.path.outsideData")
    expect(validateExportTarget("   ")).toBe("pdfexport.path.outsideData")
  })

  it("`..` 路径段一律视为越界（即使末段不是数据区目录）", () => {
    expect(isPathInsideDataSection("exports/../book.pdf")).toBe(true)
    expect(isPathInsideDataSection("a/b/..")).toBe(true)
    expect(validateExportTarget("E:/Novel/exports/../book.pdf")).toBe("pdfexport.path.outsideData")
  })

  it("扩展名与数据区双重校验：非 .pdf 与数据区目录都返回同一 UI 文案", () => {
    // 非 PDF 扩展名先被拦截
    expect(validateExportTarget("E:/Novel/exports/book.txt")).toBe("pdfexport.path.outsideData")
    // 反斜杠 + 前缀分隔符归一化后仍命中数据区段
    expect(validateExportTarget("E:\\Novel\\.novel\\exports\\book.pdf")).toBe("pdfexport.path.outsideData")
    expect(isPathInsideDataSection("/backups/book.pdf")).toBe(true)
  })

  it("数据区之外的 .pdf 目标通过校验", () => {
    expect(validateExportTarget("E:/Novel/exports/book.pdf")).toBeNull()
    expect(validateExportTarget("book.PDF")).toBeNull()
    expect(isPathInsideDataSection("exports/book.pdf")).toBe(false)
  })

  it("后端越界错误可识别：Error / 非 Error 两种入参同判据", () => {
    expect(isPathInsideDataSectionError(new Error(`${PATH_INSIDE_DATA_SECTION_PREFIX}: nope`))).toBe(true)
    expect(isPathInsideDataSectionError(`${PATH_INSIDE_DATA_SECTION_PREFIX}: nope`)).toBe(true)
    expect(isPathInsideDataSectionError(new Error("PDF_EXPORT_NOT_CONFIRMED: 需先确认"))).toBe(false)
    expect(isPathInsideDataSectionError(undefined)).toBe(false)
  })
})

describe("pdf-client.ts exportPdf IPC 契约", () => {
  beforeEach(() => {
    invokeMock.mockClear()
  })

  it("合法目标：按 commands 契约调用 export_pdf 并透传后端报告", async () => {
    const report = await exportPdf("E:/Novel", "exports/book.pdf", "第一章", ["p1", "p2"])

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("export_pdf", {
      projectPath: "E:/Novel",
      target: "exports/book.pdf",
      title: "第一章",
      paragraphs: ["p1", "p2"],
    })
    expect(report).toMatchObject({ pages: 3, bytes_written: 1024, font: CJK_FONT_FILE })
  })

  it("数据区目标：本地前置拦截抛越界错误，绝不触碰 IPC", async () => {
    await expect(exportPdf("E:/Novel", ".novel/exports/book.pdf", "T", ["p"])).rejects.toThrow(
      new RegExp(`^${PATH_INSIDE_DATA_SECTION_PREFIX}: `),
    )
    await expect(exportPdf("E:/Novel", "draft.txt", "T", ["p"])).rejects.toThrow(PATH_INSIDE_DATA_SECTION_PREFIX)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
