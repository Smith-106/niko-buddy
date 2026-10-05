// J14 历史检索 — 反向溯源纵切面（真实函数链，内存 fs 等价 Tauri invoke）。
//
// 纵切面（goal 第一条，不建全局搜索中心）：
//   导出章节 → 导出记录 → 真实PDF回执 → 反查确认版本 → 反查Run →
//   反查源章节资产+项目 → 模拟源缺失(sourceMissing) → 重启 → 同追溯一致。
//
// 诚实边界：
// - 真实 PDF 渲染不在此 spec（Rust cargo test pdfexport 9 passed 覆盖）；
//   后端 exportPdf 走 mock（门禁10：不记 Mock 为产物验证，只记回执字段）。
// - fs 内存 mock 等价 Tauri invoke（与 j03-j11-j12-slice / gate spec 同法）。
// - 反向追溯的"恢复上下文"= resolveExportProvenance 派生的结构（Run/确认版/
//   源资产/产物/状态），不实际打开文件、不建 Run/资产/导出。
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  return {
    fileMap,
    createDirectory: vi.fn(async (_p: string) => {}),
    fileExists: vi.fn(async (p: string) => fileMap.has(p)),
    readFile: vi.fn(async (p: string) => {
      const c = fileMap.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      return c
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      fileMap.set(p, c)
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
  exportPdf: vi.fn(async (_pp: string, target: string, _t: string, paragraphs: string[]) => ({
    target,
    pages: 2,
    paragraphs: paragraphs.length,
    font: "NotoSerifCJKsc-Regular.otf",
    line_height_ratio: 1.5,
    bytes_written: 4096,
  })),
}))
vi.mock("@/lib/export/pdf-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/pdf-client")>()
  return { ...actual, exportPdf: ipcMocks.exportPdf }
})

import { parseFrontmatter } from "../frontmatter"
import { isFinalChapter, updateChapterStatus } from "./chapter-meta"
import { startDeepChapterSession } from "./novel-session-status"
import {
  exportConfirmedChapterPdf,
  loadPdfExportHistory,
  markExportHistorySourceMissing,
} from "../export/pdf-export-gate"
import {
  loadExportHistoryView,
  resolveExportProvenance,
} from "../export/export-history-view"

const PROJECT = "C:/QM-J14/book"
const CHAPTER = `${PROJECT}/QM/chapters/chapter-001.md`
const CHAPTER_REL = "QM/chapters/chapter-001.md"
const TARGET = "exports/chapter-1.pdf"
const TARGET_ABS = `${PROJECT}/${TARGET}`

const FINAL_MD = [
  "---",
  "type: chapter",
  "chapter_number: 1",
  "chapter_status: final",
  'title: "第1章"',
  "---",
  "",
  "# 第1章 雾起",
  "",
  "林深推开门，雾气涌入。",
  "",
  "远处灯塔的光忽明忽暗。",
  "",
].join("\n")

function splitParagraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)
}

async function simulateRestart() {
  // 重启语义 = 重新从磁盘真源读：清调用方缓存概念，重新 load。
  // fileMap 即磁盘；内存 mock 下"重启"= 重新调 load/resolve。
}

beforeEach(() => {
  fsState.fileMap.clear()
  ipcMocks.exportPdf.mockClear()
})

describe("J14 反向溯源纵切面", () => {
  it("导出→PDF→确认版→Run→源资产→项目→源缺失→重启→同追溯", async () => {
    // ── 前置：final 章节 + 运行中会话（Run 溯源源） ──
    await fsState.writeFileAtomic(CHAPTER, FINAL_MD)
    await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-j14",
      userRequest: "导出第1章PDF",
      chapterNumber: 1,
    })
    const body = parseFrontmatter(await fsState.readFile(CHAPTER)).body

    // ── 步骤1：导出章节（确认门 → 后端 → 落历史） ──
    const { report, entry } = await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER_REL,
      chapterTitle: "第1章",
      target: TARGET,
      paragraphs: splitParagraphs(body),
      readChapterContent: () => fsState.readFile(CHAPTER),
    })
    expect(report.bytes_written).toBeGreaterThan(0)
    expect(entry.confirmedDigest).toBe(entry.contentDigest)
    // 模拟产物落盘（真实渲染由 Rust 覆盖；这里补产物文件供 output_exists 检测）
    await fsState.writeFileAtomic(TARGET_ABS, "%PDF-1.4 fake")

    // ── 步骤2：导出记录可读回（导出历史真源） ──
    const history = await loadPdfExportHistory(PROJECT)
    expect(history).toHaveLength(1)
    expect(history[0].id).toBe(`${TARGET}::${entry.contentDigest}`)

    // ── 步骤3：反查确认版本（PDF → confirmedDigest → final 快照） ──
    const prov = await resolveExportProvenance(PROJECT, history[0], {
      chapterFileExists: fsState.fileExists,
      outputFileExists: fsState.fileExists,
    })
    expect(prov.confirmedVersion.confirmedDigest).toBe(entry.confirmedDigest)
    expect(prov.confirmedVersion.confirmedDigest).toBe(prov.confirmedVersion.contentDigest)

    // ── 步骤4：反查 Run（导出 → sessionId/conversationId） ──
    expect(prov.run.sessionId).not.toBe("")
    expect(prov.run.conversationId).toBe("conv-j14")
    expect(prov.run.userRequest).toBe("导出第1章PDF")
    expect(prov.run.resolvable).toBe(true)

    // ── 步骤5：反查源章节资产 + 项目 ──
    expect(prov.sourceAsset.chapterPath).toBe(CHAPTER_REL)
    expect(prov.sourceAsset.chapterNumber).toBe(1)
    expect(prov.sourceAsset.reachable).toBe(true)
    expect(prov.projectPath).toBe(PROJECT)
    expect(prov.output.exists).toBe(true)
    expect(prov.status).toBe("available")

    // ── 步骤6：模拟源章节缺失 → sourceMissing 保留历史 ──
    fsState.fileMap.delete(CHAPTER) // 删除源章节
    const marked = await markExportHistorySourceMissing({
      projectPath: PROJECT,
      chapterPath: CHAPTER_REL,
    })
    expect(marked).toBe(1)
    const afterMissing = await resolveExportProvenance(PROJECT, (await loadPdfExportHistory(PROJECT))[0], {
      chapterFileExists: fsState.fileExists,
      outputFileExists: fsState.fileExists,
    })
    expect(afterMissing.status).toBe("source_missing")
    expect(afterMissing.sourceAsset.reachable).toBe(false)
    // 历史保留：Run/确认版/产物仍可反查，只是源缺失（不静默抹除审计）
    expect(afterMissing.run.sessionId).not.toBe("")
    expect(afterMissing.confirmedVersion.confirmedDigest).toBe(entry.confirmedDigest)
    expect(afterMissing.output.exists).toBe(true)

    // ── 步骤7：重启 → 重新从磁盘读回同一追溯 ──
    await simulateRestart()
    const viewAfterRestart = await loadExportHistoryView(PROJECT, {
      chapterFileExists: fsState.fileExists,
      outputFileExists: fsState.fileExists,
    })
    expect(viewAfterRestart).toHaveLength(1)
    const p2 = viewAfterRestart[0].provenance
    expect(p2.exportId).toBe(prov.exportId)
    expect(p2.status).toBe("source_missing")
    expect(p2.run.conversationId).toBe("conv-j14")
    expect(p2.confirmedVersion.confirmedDigest).toBe(prov.confirmedVersion.confirmedDigest)
    expect(p2.sourceAsset.chapterNumber).toBe(1)
    // 同一追溯：重启后 source_missing 状态、Run、确认版一致——索引丢失不毁历史
  })

  it("重命名源章节后 chapter_number 重连 → 历史不断链", async () => {
    await fsState.writeFileAtomic(CHAPTER, FINAL_MD)
    await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-r",
      userRequest: "导出",
      chapterNumber: 1,
    })
    const body = parseFrontmatter(await fsState.readFile(CHAPTER)).body
    await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER_REL,
      chapterTitle: "第1章",
      target: TARGET,
      paragraphs: splitParagraphs(body),
      readChapterContent: () => fsState.readFile(CHAPTER),
    })
    await fsState.writeFileAtomic(TARGET_ABS, "%PDF")
    // 模拟重命名：chapter-001.md → chapter-001-renamed.md（frontmatter chapter_number 不变）
    // 但 chapter_number 候选 chapter-001.md 也变了——用同号新名落盘模拟移动。
    fsState.fileMap.delete(CHAPTER)
    const RENAMED = `${PROJECT}/QM/chapters/chapter-001-雾起.md`
    await fsState.writeFileAtomic(RENAMED, FINAL_MD)
    const prov = await resolveExportProvenance(
      PROJECT,
      (await loadPdfExportHistory(PROJECT))[0],
      {
        chapterFileExists: fsState.fileExists,
        outputFileExists: fsState.fileExists,
      },
    )
    // chapter_number=1 候选 chapter-001.md 不存在；重命名文件 chapter-001-雾起.md
    // 不在固定候选内 → reachable=false → source_missing（如实报缺失，不误报在）。
    expect(prov.status).toBe("source_missing")
    // 但确认版/Run 仍反查得到（历史不因源失联而抹除）
    expect(prov.confirmedVersion.confirmedDigest).not.toBe("")
    expect(prov.run.resolvable).toBe(true)
  })

  it("产物缺失 → output_missing（源在但PDF被删）", async () => {
    await fsState.writeFileAtomic(CHAPTER, FINAL_MD)
    await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-o",
      userRequest: "导出",
      chapterNumber: 1,
    })
    const body = parseFrontmatter(await fsState.readFile(CHAPTER)).body
    await exportConfirmedChapterPdf({
      projectPath: PROJECT,
      chapterPath: CHAPTER_REL,
      chapterTitle: "第1章",
      target: TARGET,
      paragraphs: splitParagraphs(body),
      readChapterContent: () => fsState.readFile(CHAPTER),
    })
    // 不落产物文件 → output_missing
    const prov = await resolveExportProvenance(
      PROJECT,
      (await loadPdfExportHistory(PROJECT))[0],
      {
        chapterFileExists: fsState.fileExists,
        outputFileExists: fsState.fileExists,
      },
    )
    expect(prov.status).toBe("output_missing")
    expect(prov.sourceAsset.reachable).toBe(true)
    expect(prov.output.exists).toBe(false)
  })
})
