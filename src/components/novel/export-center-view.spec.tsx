// @vitest-environment jsdom
/**
 * export-center-view.spec.tsx — 导出中心视图（P1-04 全格式导出 + 范围/草稿开关 + 持久导出历史）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(),
    listDirectory: vi.fn(),
    fileExists: vi.fn(async () => false),
    openFileLocation: vi.fn(async () => {}),
    openProjectFolder: vi.fn(async () => {}),
  }
})

import { fileExists, listDirectory, openFileLocation, openProjectFolder, readFile } from "@/commands/fs"
import type { ManuscriptExportHistoryEntry } from "@/lib/export/pdf-export-gate"
import type { FileNode } from "@/types/wiki"
import { ExportCenterView, loadExportCenterSnapshot, manuscriptExportPath, type ManuscriptExportHistoryStore } from "./export-center-view"

const listDirectoryMock = vi.mocked(listDirectory)
const readFileMock = vi.mocked(readFile)
const fileExistsMock = vi.mocked(fileExists)
const openFileLocationMock = vi.mocked(openFileLocation)
const openProjectFolderMock = vi.mocked(openProjectFolder)

const FINAL_CHAPTER_MD = "---\nchapter_status: final\nchapter_number: 1\ntitle: 开篇\n---\n正文内容第一段\n"
const DRAFT_CHAPTER_MD = "---\nchapter_status: draft\nchapter_number: 2\ntitle: 草稿章\n---\n草稿正文\n"

function createMemoryHistoryStore(initial: ManuscriptExportHistoryEntry[] = []): ManuscriptExportHistoryStore {
  let entries = [...initial]
  return {
    load: vi.fn(async () => [...entries]),
    append: vi.fn(async (_projectPath, entry) => {
      entries = [...entries, entry]
      return [...entries]
    }),
  }
}

function mockOneFinalChapter() {
  listDirectoryMock.mockResolvedValue([
    { name: "第1章.md", path: "C:/proj/wiki/chapters/第1章.md", is_dir: false },
  ])
  readFileMock.mockImplementation(async (p) => {
    if (String(p).includes("export-history.json")) throw new Error("missing")
    return FINAL_CHAPTER_MD
  })
}

function mockDraftOnlyChapter() {
  listDirectoryMock.mockResolvedValue([
    { name: "第2章.md", path: "C:/proj/wiki/chapters/第2章.md", is_dir: false },
  ])
  readFileMock.mockImplementation(async (p) => {
    if (String(p).includes("export-history.json")) throw new Error("missing")
    return DRAFT_CHAPTER_MD
  })
}

afterEach(cleanup)

beforeEach(() => {
  listDirectoryMock.mockReset()
  readFileMock.mockReset()
  fileExistsMock.mockReset()
  openFileLocationMock.mockReset()
  openProjectFolderMock.mockReset()
  fileExistsMock.mockResolvedValue(false)
})

describe("ExportCenterView", () => {
  it("空 projectPath → 空态，不读磁盘", () => {
    render(<ExportCenterView projectPath="" historyStore={createMemoryHistoryStore()} />)
    expect(screen.getByTestId("export-center-view")).toBeTruthy()
    expect(screen.getByTestId("export-center-empty").textContent).toContain("未指定项目路径")
    expect(listDirectoryMock).not.toHaveBeenCalled()
  })

  it("有 final 章节 → 4 格式（TXT/DOCX/EPUB/PDF）全部可用，并展示单章 PDF 入口", async () => {
    mockOneFinalChapter()
    render(<ExportCenterView projectPath="C:/proj" historyStore={createMemoryHistoryStore()} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    expect(screen.getByTestId("export-center-count").textContent).toContain("1")
    expect(screen.queryByTestId("export-center-no-chapters")).toBeNull()
    expect(screen.getByTestId("export-txt-button")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-docx-button")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-epub-button")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-pdf-button")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-single-pdf-card")).toBeTruthy()
  })

  it("零 final 且零草稿 → 诚实文案 + 4 个导出按钮均禁用", async () => {
    listDirectoryMock.mockRejectedValue(new Error("missing"))
    render(<ExportCenterView projectPath="C:/proj" historyStore={createMemoryHistoryStore()} />)
    await waitFor(() => expect(screen.getByTestId("export-center-no-chapters")).toBeTruthy())
    expect(screen.getByTestId("export-center-count").textContent).toContain("0")
    expect(screen.getByTestId("export-txt-button")).toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-docx-button")).toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-epub-button")).toHaveProperty("disabled", true)
    expect(screen.getByTestId("export-pdf-button")).toHaveProperty("disabled", true)
    const snap = await loadExportCenterSnapshot("C:/proj")
    expect(snap.finalCount).toBe(0)
    expect(snap.draftCount).toBe(0)
  })

  it("仅有草稿章：默认禁用；勾选包含草稿后弹出警示条并解锁导出", async () => {
    mockDraftOnlyChapter()
    const exportTxt = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.txt",
      chapterCount: 1,
      draftCount: 1,
      message: "ok",
    })
    const historyStore = createMemoryHistoryStore()
    render(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={historyStore}
        actions={{ exportTxt, exportDocx: vi.fn(), exportEpub: vi.fn(), exportPdf: vi.fn() }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-draft-count").textContent).toBe("1"))
    expect(screen.getByTestId("export-txt-button")).toHaveProperty("disabled", true)

    fireEvent.click(screen.getByTestId("export-include-drafts"))
    expect(screen.getByTestId("export-include-drafts-alert").getAttribute("role")).toBe("alert")
    expect(screen.getByTestId("export-txt-button")).not.toHaveProperty("disabled", true)

    fireEvent.click(screen.getByTestId("export-txt-button"))
    await waitFor(() => expect(exportTxt).toHaveBeenCalled())
    expect(exportTxt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "C:/proj",
        exportPath: "C:/proj/exports/complete-novel.txt",
        includeDrafts: true,
        firstLineIndent: true,
        includeBom: true,
      }),
    )
    expect(historyStore.append).toHaveBeenCalledTimes(1)
  })

  it("章节范围校验：起 > 止时报错并禁用导出", async () => {
    mockOneFinalChapter()
    render(<ExportCenterView projectPath="C:/proj" historyStore={createMemoryHistoryStore()} />)
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-start-chapter"), { target: { value: "10" } })
    fireEvent.change(screen.getByTestId("export-end-chapter"), { target: { value: "3" } })
    expect(screen.getByTestId("export-range-error").getAttribute("role")).toBe("alert")
    expect(screen.getByTestId("export-docx-button")).toHaveProperty("disabled", true)
  })

  it("导出成功（DOCX / PDF）→ 写入持久化历史并支持打开所在文件夹（含降级）", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.docx",
      chapterCount: 1,
      message: "ok",
    })
    const exportPdf = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/complete-novel.pdf",
      chapterCount: 1,
      draftCount: 0,
      message: "ok",
    })
    const historyStore = createMemoryHistoryStore()
    render(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={historyStore}
        actions={{ exportDocx, exportEpub: vi.fn(), exportPdf }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-history-list")).toBeTruthy())
    expect(exportDocx).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "C:/proj",
        exportPath: "C:/proj/exports/complete-novel.docx",
        includeDrafts: false,
        startChapter: null,
        endChapter: null,
      }),
    )
    const record = screen.getByTestId("export-record-success")
    expect(record.textContent).toContain("DOCX")
    expect(record.textContent).toContain("complete-novel.docx")

    // 打开所在文件夹：openFileLocation 失败时降级 openProjectFolder
    openFileLocationMock.mockRejectedValueOnce(new Error("no shell"))
    fireEvent.click(screen.getByTestId("export-open-folder-button"))
    await waitFor(() => expect(openProjectFolderMock).toHaveBeenCalledWith("C:/proj"))

    // 整本 PDF 导出
    fireEvent.click(screen.getByTestId("export-pdf-button"))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledTimes(1))
    expect(screen.getAllByTestId("export-record-success")).toHaveLength(2)
  })

  it("导出失败 → 历史记录失败行（返回失败结果与抛错均记录）", async () => {
    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: false,
      exportedPath: "C:/proj/exports/complete-novel.docx",
      chapterCount: 0,
      message: "docx failed",
    })
    const exportEpub = vi.fn().mockRejectedValue(new Error("epub invoke failed"))
    render(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={createMemoryHistoryStore()}
        actions={{ exportDocx, exportEpub }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-record-failure")).toBeTruthy())
    expect(screen.getByTestId("export-record-failure").textContent).toContain("docx failed")

    fireEvent.click(screen.getByTestId("export-epub-button"))
    await waitFor(() => expect(screen.getAllByTestId("export-record-failure")).toHaveLength(2))
    const texts = screen.getAllByTestId("export-record-failure").map((el) => el.textContent ?? "")
    expect(texts.some((t) => t.includes("epub invoke failed"))).toBe(true)
  })

  it("目录选择器回填绝对路径：导出写到所选目录 + 取消保留手输", async () => {
    expect(manuscriptExportPath("C:/proj", "D:/out", "终稿", "TXT")).toBe("D:/out/终稿.txt")
    expect(manuscriptExportPath("C:/proj", "D:/out", "终稿", "DOCX")).toBe("D:/out/终稿.docx")
    expect(manuscriptExportPath("C:/proj", "/tmp/out/", "终稿", "EPUB")).toBe("/tmp/out/终稿.epub")
    expect(manuscriptExportPath("C:/proj", "exports", "终稿", "PDF")).toBe("C:/proj/exports/终稿.pdf")

    mockOneFinalChapter()
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "D:/out/终稿.docx",
      chapterCount: 1,
      message: "ok",
    })
    const historyStore = createMemoryHistoryStore()
    const { rerender } = render(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={historyStore}
        actions={{ exportDocx, exportEpub: vi.fn() }}
        pickDirectory={async () => "D:/out"}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-file-name"), { target: { value: "终稿" } })
    fireEvent.click(screen.getByTestId("export-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("export-target-path").textContent).toContain("D:/out/终稿.docx"))
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() =>
      expect(exportDocx).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "C:/proj",
          exportPath: "D:/out/终稿.docx",
        }),
      ),
    )

    rerender(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={historyStore}
        actions={{ exportDocx, exportEpub: vi.fn() }}
        pickDirectory={async () => null}
      />,
    )
    fireEvent.click(screen.getByTestId("export-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("export-target-path").textContent).toContain("D:/out/终稿.docx"))
  })

  it("同名文件先确认，确认后才导出；取消则不导出", async () => {
    mockOneFinalChapter()
    fileExistsMock.mockResolvedValue(true)
    const exportDocx = vi.fn().mockResolvedValue({
      success: true,
      exportedPath: "C:/proj/exports/终稿.docx",
      chapterCount: 1,
      message: "ok",
    })
    render(
      <ExportCenterView
        projectPath="C:/proj"
        historyStore={createMemoryHistoryStore()}
        actions={{ exportDocx, exportEpub: vi.fn() }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("export-center-count")).toBeTruthy())
    fireEvent.change(screen.getByTestId("export-file-name"), { target: { value: "终稿" } })
    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-overwrite-confirm")).toBeTruthy())
    expect(exportDocx).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("取消"))
    expect(screen.queryByTestId("export-overwrite-confirm")).toBeNull()

    fireEvent.click(screen.getByTestId("export-docx-button"))
    await waitFor(() => expect(screen.getByTestId("export-overwrite-confirm")).toBeTruthy())
    fireEvent.click(screen.getByTestId("export-overwrite-confirm-button"))
    await waitFor(() =>
      expect(exportDocx).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "C:/proj",
          exportPath: "C:/proj/exports/终稿.docx",
        }),
      ),
    )
  })

  it("加载中切换 projectPath 后旧请求才 resolve → 不写回旧快照", async () => {
    let resolveList!: (value: FileNode[]) => void
    listDirectoryMock.mockImplementationOnce(() => new Promise((res) => { resolveList = res }))
    const historyStore = createMemoryHistoryStore()
    const { rerender } = render(<ExportCenterView projectPath="C:/proj" historyStore={historyStore} />)
    expect(screen.getByTestId("export-center-loading")).toBeTruthy()
    rerender(<ExportCenterView projectPath="" historyStore={historyStore} />)
    expect(screen.getByTestId("export-center-empty")).toBeTruthy()
    readFileMock.mockResolvedValue(FINAL_CHAPTER_MD)
    resolveList([{ name: "第1章.md", path: "C:/proj/wiki/chapters/第1章.md", is_dir: false }])
    await waitFor(() => expect(readFileMock).toHaveBeenCalled())
    expect(screen.getByTestId("export-center-empty")).toBeTruthy()
    expect(screen.queryByTestId("export-center-count")).toBeNull()
  })
})
