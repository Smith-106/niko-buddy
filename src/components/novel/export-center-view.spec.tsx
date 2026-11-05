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

  it("同名探测抛错 → 按占用处理并可取消（取消后不导出）", async () => {
    mockOneFinalChapter()
    // fileExists 抛错（权限/瞬态 IO）：按"已占用"保守处理，先确认。
    fileExistsMock.mockRejectedValueOnce(new Error("denied"))
    const exportDocx = vi.fn()
    const exportEpub = vi.fn()
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-overwrite-confirm")).toBeTruthy())
    expect(exportDocx).not.toHaveBeenCalled()
    // 点取消：确认框消失，且始终没有写盘。
    fireEvent.click(screen.getByText("取消"))
    expect(screen.queryByTestId("export-overwrite-confirm")).toBeNull()
    expect(exportDocx).not.toHaveBeenCalled()
    expect(screen.queryByTestId("export-history-list")).toBeNull()
  })

  it("改目录输入 → 目标路径跟随且清掉待确认态", async () => {
    mockOneFinalChapter()
    fileExistsMock.mockResolvedValue(true)
    const exportDocx = vi.fn()
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-overwrite-confirm")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-folder-name"), { target: { value: "newdir" } })
    expect(screen.queryByTestId("export-overwrite-confirm")).toBeNull()
    expect(screen.getByTestId("export-target-path").textContent).toContain("C:/proj/newdir/complete-novel.docx")
    expect(exportDocx).not.toHaveBeenCalled()
  })

  it("EPUB 导出中 → 按钮显示进行态文案", async () => {
    mockOneFinalChapter()
    let resolveEpub!: (value: unknown) => void
    const exportEpub = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveEpub = resolve }))
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx: vi.fn(), exportEpub }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-epub-button"))
    await waitFor(() => expect(screen.getByTestId("export-epub-button").textContent).toContain("正在导出 EPUB"))
    resolveEpub({ success: true, exportedPath: "C:/proj/exports/complete-novel.epub", chapterCount: 1, message: "ok" })
    await waitFor(() => expect(screen.getByTestId("export-history-list")).toBeTruthy())
    expect(screen.getByTestId("export-record-success").textContent).toContain("EPUB")
  })

  it("导出中再次点击 → 按钮禁用防重提（只落一条记录）", async () => {
    mockOneFinalChapter()
    let resolveDocx!: (value: unknown) => void
    const exportDocx = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveDocx = resolve }))
    const exportEpub = vi.fn()
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-docx-button").textContent).toContain("正在导出 Word"))
    // 并发保护在渲染层：导出中两个按钮都 disabled（jsdom/真浏览器都不再派发点击）。
    expect(screen.getByTestId("export-docx-button")).toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-epub-button")).toHaveProperty("disabled", true)
    fireEvent.click(screen.getByTestId("export-epub-button"))
    expect(exportEpub).not.toHaveBeenCalled()
    resolveDocx({ success: true, exportedPath: "C:/proj/exports/complete-novel.docx", chapterCount: 1, message: "ok" })
    await waitFor(() => expect(screen.getByTestId("export-history-list")).toBeTruthy())
    expect(exportDocx).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId("export-record-success")).toHaveLength(1)
  })

  it("注入动作抛非 Error → 兜底失败行展示原文", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn().mockRejectedValue("plain-string-failure")
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-record-failure")).toBeTruthy())
    expect(screen.getByTestId("export-record-failure").textContent).toContain("plain-string-failure")
  })

  it("manuscriptExportPath 空目录/空文件名回退到约定值", async () => {
    const { manuscriptExportPath } = await import("./export-center-view")
    expect(manuscriptExportPath("C:/proj", "\\", "", "DOCX")).toBe("C:/proj/exports/complete-novel.docx")
    expect(manuscriptExportPath("C:/proj", "  ", "  ", "EPUB")).toBe("C:/proj/exports/complete-novel.epub")
  })

  it("未注入目录选择器 → 走真实 platform 回退且目录不变", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn()
    // 不传 pickDirectory：触发 `pickDirectoryImpl ?? (await import("@/lib/platform")).pickDirectory` 右路。
    // jsdom 无 Tauri/目录拣选器，prompt 未实现 → 回退分支静默保留手输目录。
    render(<ExportCenterView projectPath="C:/proj" actions={{ exportDocx, exportEpub: vi.fn() }} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("export-target-path").textContent).toContain("C:/proj/exports/complete-novel.docx"))
    expect(exportDocx).not.toHaveBeenCalled()
  })

  it("加载中切换 projectPath → 旧请求被取消（不写回旧快照）", async () => {
    // 挂起的旧请求：断言只关心「被取消后不写回」，不关心它最终 resolve 成什么，
    // 故给一个永不 settle 的 Promise（也避免 resolve 回调的类型协变冲突）。
    listDirectoryMock.mockImplementationOnce(() => new Promise(() => {}))
    const { rerender } = render(<ExportCenterView projectPath="C:/proj" />)
    expect(screen.getByTestId("export-center-loading")).toBeTruthy()
    rerender(<ExportCenterView projectPath="" />)
    expect(screen.getByTestId("export-center-empty")).toBeTruthy()
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalledTimes(1))
    // 旧请求已取消：空态保持，不冒出旧项目的计数。
    expect(screen.getByTestId("export-center-empty")).toBeTruthy()
    expect(screen.queryByTestId("export-center-count")).toBeNull()
  })
})
