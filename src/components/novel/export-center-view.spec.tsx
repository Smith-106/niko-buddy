// @vitest-environment jsdom
/**
 * export-center-view.spec.tsx — 导出中心视图（书稿导出）契约。
 *
 * 覆盖：
 *   1. 空 projectPath → 空态，不读磁盘；
 *   2. 有 final 章节 → 计数渲染 + Word/EPUB 可用、PDF 恒禁用；
 *   3. 零 final 章节 → 诚实文案 + 导出按钮禁用；
 *   4. 导出成功 → 会话记录成功行（动作经 props 注入，不碰 Tauri invoke）；
 *   5. 导出失败 → 会话记录失败行（诚实 message）。
 *
 * 磁盘统一经 `@/commands/fs` 的 listDirectory/readFile（countFinalChapters
 * 经此路径），此处只 mock 该模块；导出动作经 props 注入 fake。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn(), fileExists: vi.fn(async () => false) }
})

import { fileExists, listDirectory, readFile } from "@/commands/fs"
import { ExportCenterView, loadExportCenterSnapshot } from "./export-center-view"

const listDirectoryMock = vi.mocked(listDirectory)
const readFileMock = vi.mocked(readFile)
const fileExistsMock = vi.mocked(fileExists)

const FINAL_CHAPTER_MD = "---\nchapter_status: final\nchapter_number: 1\ntitle: 开篇\n---\n正文内容\n"

function mockOneFinalChapter() {
  listDirectoryMock.mockResolvedValue([
    { name: "第1章.md", path: "C:/proj/wiki/chapters/第1章.md", is_dir: false },
  ])
  readFileMock.mockResolvedValue(FINAL_CHAPTER_MD)
}

afterEach(cleanup)

beforeEach(() => {
  listDirectoryMock.mockReset()
  readFileMock.mockReset()
  fileExistsMock.mockReset()
  fileExistsMock.mockResolvedValue(false)
})

describe("ExportCenterView", () => {
  it("空 projectPath → 空态，不读磁盘", () => {
    render(<ExportCenterView projectPath="" />)
    expect(screen.getByTestId("export-center-view")).toBeTruthy()
    expect(screen.getByTestId("export-center-empty").textContent).toContain("未指定项目路径")
    expect(listDirectoryMock).not.toHaveBeenCalled()
  })

  it("有 final 章节 → 计数渲染 + PDF 恒禁用", async () => {
    mockOneFinalChapter()
    render(<ExportCenterView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    expect(screen.getByTestId("export-center-count").textContent).toContain("1")
    expect(screen.queryByTestId("export-center-no-chapters")).toBeNull()
    expect(screen.getByTestId("export-docx-button")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-epub-button")).not.toHaveProperty("disabled", true)
    // 仓库内无 PDF 导出函数：按钮恒禁用 + 诚实 title。
    const pdfButton = screen.getByTestId("export-pdf-button")
    expect(pdfButton).toHaveProperty("disabled", true)
    expect(pdfButton.getAttribute("title")).toContain("尚未接入")
  })

  it("零 final 章节 → 诚实文案 + 导出按钮禁用", async () => {
    listDirectoryMock.mockRejectedValue(new Error("missing"))
    render(<ExportCenterView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("export-center-no-chapters")).toBeTruthy())
    expect(screen.getByTestId("export-center-count").textContent).toContain("0")
    expect(screen.getByTestId("export-docx-button")).toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-epub-button")).toHaveProperty("disabled", true)
    expect(await loadExportCenterSnapshot("C:/proj")).toEqual({ finalCount: 0 })
  })

  it("导出成功 → 会话记录成功行", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.docx",
      chapterCount: 1,
      message: "ok",
    })
    const exportEpub = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.epub",
      chapterCount: 1,
      message: "ok",
    })
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-history-list")).toBeTruthy())
    expect(exportDocx).toHaveBeenCalledWith({
      projectPath: "C:/proj",
      exportPath: "C:/proj/exports/complete-novel.docx",
    })
    const record = screen.getByTestId("export-record-success")
    expect(record.textContent).toContain("DOCX")
    expect(record.textContent).toContain("complete-novel.docx")
  })

  it("导出失败 → 会话记录失败行", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: false,
      exportedPath: "C:/proj/exports/complete-novel.docx",
      chapterCount: 0,
      message: "docx failed",
    })
    const exportEpub = vi.fn().mockRejectedValue(new Error("epub invoke failed"))
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    // 真实函数返回失败结果 → 失败行（含 message）。
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-record-failure")).toBeTruthy())
    expect(screen.getByTestId("export-record-failure").textContent).toContain("docx failed")
    // 注入动作抛错 → 兜底失败行。
    fireEvent.click(screen.getByTestId("export-epub-button"))
    await waitFor(() => expect(screen.getAllByTestId("export-record-failure")).toHaveLength(2))
    expect(screen.getAllByTestId("export-record-failure")[1]?.textContent).toContain("epub invoke failed")
  })

  it("目录选择器回填绝对路径：导出写到所选目录 + 取消保留手输", async () => {
    const { manuscriptExportPath } = await import("./export-center-view")
    // 绝对路径直拼文件名（Windows 盘符 + POSIX 双兼容）。
    expect(manuscriptExportPath("C:/proj", "D:/out", "终稿", "DOCX")).toBe("D:/out/终稿.docx")
    expect(manuscriptExportPath("C:/proj", "/tmp/out/", "终稿", "EPUB")).toBe("/tmp/out/终稿.epub")
    // 相对目录仍走项目内。
    expect(manuscriptExportPath("C:/proj", "exports", "终稿", "DOCX")).toBe("C:/proj/exports/终稿.docx")

    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "D:/out/终稿.docx",
      chapterCount: 1,
      message: "ok",
    })
    // 选择器返回绝对目录 → 回填 → 导出路径跟随。
    const { rerender } = render(
      <ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} pickDirectory={async () => "D:/out"} />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-file-name"), { target: { value: "终稿" } })
    fireEvent.click(screen.getByTestId("export-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("export-target-path").textContent).toContain("D:/out/终稿.docx"))
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(exportDocx).toHaveBeenCalledWith({
      projectPath: "C:/proj",
      exportPath: "D:/out/终稿.docx",
    }))
    // 选择器取消（null）→ 保留手输目录。
    rerender(
      <ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} pickDirectory={async () => null} />,
    )
    fireEvent.click(screen.getByTestId("export-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("export-target-path").textContent).toContain("D:/out/终稿.docx"))
  })

  it("同名文件先确认，确认后才导出", async () => {
    mockOneFinalChapter()
    fileExistsMock.mockResolvedValue(true)
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.docx",
      chapterCount: 1,
      message: "ok",
    })
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-file-name"), { target: { value: "终稿" } })
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-overwrite-confirm")).toBeTruthy())
    expect(exportDocx).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("export-overwrite-confirm-button"))
    await waitFor(() => expect(exportDocx).toHaveBeenCalledWith({
      projectPath: "C:/proj",
      exportPath: "C:/proj/exports/终稿.docx",
    }))
  })
})
