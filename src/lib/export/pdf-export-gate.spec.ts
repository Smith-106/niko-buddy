// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors
//
// #43 门禁 1/7/9 验证：PDF 导出确认门 + 导出历史。
// - 门禁 1：非 final 章节拒绝导出（且绝不触碰 IPC）；final 放行并携带 digest。
// - 门禁 7：成功导出落 `.novel/export-history.json`，溯源链字段完整
//   （项目 → 会话-Run → 输入章节 → 确认版本摘要 → PDF 目标）。
// - 门禁 9：历史经磁盘 JSON 重启可读回。
// - 门禁 5：后端失败不留完成记录。门禁 6：同目标同内容重试幂等（deduped）。
// fs 走内存 mock（与 j06-j09-real-transport / j03-j11-j12-slice 同法，
// 等价 Tauri invoke 语义）；后端 `exportPdf` 走 mock（真实渲染由 Rust
// cargo test pdfexport 覆盖，不在此重复，更不记 Mock 为产物验证——门禁 10）。

import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  return {
    fileMap,
    createDirectory: vi.fn(async (_path: string) => {}),
    fileExists: vi.fn(async (path: string) => fileMap.has(path)),
    readFile: vi.fn(async (path: string) => {
      const c = fileMap.get(path)
      if (c === undefined) throw new Error(`ENOENT: ${path}`)
      return c
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      fileMap.set(path, content)
    }),
  }
})
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsState.createDirectory,
    fileExists: fsState.fileExists,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
  }
})

const ipcMocks = vi.hoisted(() => ({
  exportPdf: vi.fn(async (_projectPath: string, target: string, _title: string, paragraphs: string[]) => ({
    target,
    pages: 2,
    paragraphs: paragraphs.length,
    font: "NotoSerifCJKsc-Regular.otf",
    line_height_ratio: 1.5,
    bytes_written: 4096,
  })),
}))
vi.mock("./pdf-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-client")>()
  return { ...actual, exportPdf: ipcMocks.exportPdf }
})

import {
  assertChapterFinalForExport,
  exportConfirmedChapterPdf,
  exportHistoryPath,
  loadPdfExportHistory,
  markExportHistorySourceMissing,
} from "./pdf-export-gate"

const PROJECT = "C:/QM-J0312/gate-book"
const CHAPTER = "QM/chapters/chapter-001.md"
const CHAPTER_ABS = `${PROJECT}/${CHAPTER}`

const DRAFT_MD = [
  "---",
  "type: chapter",
  "chapter_number: 1",
  "chapter_status: draft",
  'title: "第1章"',
  "---",
  "",
  "# 第1章 雾起",
  "",
  "林深推开门，雾气涌入。",
  "",
].join("\n")

const FINAL_MD = DRAFT_MD.replace("chapter_status: draft", "chapter_status: final")

const PARAGRAPHS = ["第1章 雾起", "林深推开门，雾气涌入。"]

function readChapter() {
  return fsState.readFile(CHAPTER_ABS)
}

beforeEach(() => {
  fsState.fileMap.clear()
  ipcMocks.exportPdf.mockClear()
})

describe("PDF 导出确认门 + 导出历史（门禁 1/5/6/7/9）", () => {
  it("门禁1：draft 章节拒绝导出，且绝不触碰 IPC", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, DRAFT_MD)
    await expect(assertChapterFinalForExport(readChapter)).rejects.toThrow(
      "PDF_EXPORT_NOT_CONFIRMED",
    )
    await expect(
      exportConfirmedChapterPdf({
        projectPath: PROJECT,
        chapterPath: CHAPTER,
        chapterTitle: "第1章",
        target: "exports/chapter-001.pdf",
        paragraphs: PARAGRAPHS,
        readChapterContent: readChapter,
      }),
    ).rejects.toThrow("PDF_EXPORT_NOT_CONFIRMED")
    expect(ipcMocks.exportPdf).not.toHaveBeenCalled()
    // 拒绝导出不留历史
    expect(await loadPdfExportHistory(PROJECT)).toEqual([])
  })

  it("门禁1+7+9：final 放行 → 成功落历史 → 重启可读回，溯源链完整", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    const { confirmedDigest } = await assertChapterFinalForExport(readChapter)
    expect(confirmedDigest).toMatch(/^[0-9a-f]{16}$/)

    const { report, entry } = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: PARAGRAPHS,
      readChapterContent: readChapter,
    })
    expect(ipcMocks.exportPdf).toHaveBeenCalledTimes(1)
    expect(report.pages).toBe(2)
    // 溯源链：目标 / 输入章节 / 确认版本摘要 / 内容摘要一致
    expect(entry.target).toContain("exports/chapter-001.pdf")
    expect(entry.chapterPath).toBe(CHAPTER)
    expect(entry.confirmedDigest).toBe(confirmedDigest)
    expect(entry.contentDigest).toBe(confirmedDigest)
    expect(entry.chapterNumber).toBe(1)
    expect(entry.deduped).toBeUndefined()

    // 门禁 9：重启读回——清空内存视角，从磁盘 JSON 重新加载
    const raw = await fsState.readFile(exportHistoryPath(PROJECT))
    expect(raw).toContain("chapter-001")
    expect(raw).toContain("confirmedDigest")
    const reloaded = await loadPdfExportHistory(PROJECT)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.id).toBe(entry.id)
    expect(reloaded[0]?.confirmedDigest).toBe(confirmedDigest)
    expect(reloaded[0]?.chapterPath).toBe(CHAPTER)
  })

  it("门禁6：同目标同内容重试幂等，不产生重复条目", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    const first = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: PARAGRAPHS,
      readChapterContent: readChapter,
    })
    const second = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: PARAGRAPHS,
      readChapterContent: readChapter,
    })
    expect(ipcMocks.exportPdf).toHaveBeenCalledTimes(1)
    expect(second.entry.deduped).toBe(true)
    expect(second.entry.id).toBe(first.entry.id)
    expect(await loadPdfExportHistory(PROJECT)).toHaveLength(1)
  })

  it("门禁6反例：内容变化 → digest 变化 → 新条目（非重复，是新版本）", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: PARAGRAPHS,
      readChapterContent: readChapter,
    })
    await fsState.writeFileAtomic(CHAPTER_ABS, `${FINAL_MD}\n新增一段。\n`)
    const { entry } = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: [...PARAGRAPHS, "新增一段。"],
      readChapterContent: readChapter,
    })
    expect(entry.deduped).toBeUndefined()
    expect(ipcMocks.exportPdf).toHaveBeenCalledTimes(2)
    expect(await loadPdfExportHistory(PROJECT)).toHaveLength(2)
  })

  it("门禁5：后端失败不留完成记录", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    ipcMocks.exportPdf.mockRejectedValueOnce(new Error("PDF_EXPORT_RENDER: boom"))
    await expect(
      exportConfirmedChapterPdf({
        projectPath: PROJECT,
        chapterPath: CHAPTER,
        chapterTitle: "第1章",
        target: "exports/chapter-001.pdf",
        paragraphs: PARAGRAPHS,
        readChapterContent: readChapter,
      }),
    ).rejects.toThrow("boom")
    expect(await loadPdfExportHistory(PROJECT)).toEqual([])
  })

  it("门禁1-TOCTOU：确认门与导出之间内容变化则阻断", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    let calls = 0
    const flappingRead = async () => {
      calls += 1
      // 第一次（确认门）读 final，第二次（导出）读到被改写的内容
      if (calls === 1) return fsState.readFile(CHAPTER_ABS)
      return `${FINAL_MD}\n中途被改。\n`
    }
    await expect(
      exportConfirmedChapterPdf({
        projectPath: PROJECT,
        chapterPath: CHAPTER,
        chapterTitle: "第1章",
        target: "exports/chapter-001.pdf",
        paragraphs: PARAGRAPHS,
        readChapterContent: flappingRead,
      }),
    ).rejects.toThrow("PDF_EXPORT_CONTENT_CHANGED")
    expect(ipcMocks.exportPdf).not.toHaveBeenCalled()
  })

  it("数据区目标仍被硬拦（与 pdf-client 同判据）", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    await expect(
      exportConfirmedChapterPdf({
        projectPath: PROJECT,
        chapterPath: CHAPTER,
        chapterTitle: "第1章",
        target: "QM/exports/book.pdf",
        paragraphs: PARAGRAPHS,
        readChapterContent: readChapter,
      }),
    ).rejects.toThrow("PDF_EXPORT_INVALID_TARGET")
    expect(ipcMocks.exportPdf).not.toHaveBeenCalled()
  })

  it("门禁8：删除源章节后历史保留溯源并标记 sourceMissing，不误读为现存资产", async () => {
    await fsState.writeFileAtomic(CHAPTER_ABS, FINAL_MD)
    const { entry } = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
      chapterTitle: "第1章",
      target: "exports/chapter-001.pdf",
      paragraphs: PARAGRAPHS,
      readChapterContent: readChapter,
    })
    expect(entry.sourceMissing).toBeUndefined()
    // 删除源资产 → 明确处理：历史条目保留溯源但标记源缺失
    fsState.fileMap.delete(CHAPTER_ABS)
    const marked = await markExportHistorySourceMissing({
      projectPath: PROJECT,
      chapterPath: CHAPTER,
    })
    expect(marked).toBe(1)
    // 重启读回：溯源字段仍在，但 sourceMissing=true 明确源已不存在
    const reloaded = await loadPdfExportHistory(PROJECT)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.id).toBe(entry.id)
    expect(reloaded[0]?.chapterPath).toBe(CHAPTER)
    expect(reloaded[0]?.sourceMissing).toBe(true)
    expect(reloaded[0]?.confirmedDigest).toBe(entry.confirmedDigest)
    // 幂等：重复标记不重复计数
    expect(await markExportHistorySourceMissing({ projectPath: PROJECT, chapterPath: CHAPTER })).toBe(0)
    // 无该章节的标记请求返回 0
    expect(await markExportHistorySourceMissing({ projectPath: PROJECT, chapterPath: "QM/chapters/other.md" })).toBe(0)
  })
})
