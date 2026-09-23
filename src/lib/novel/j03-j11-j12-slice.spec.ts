// J03/J11/J12 首轮真实纵切面:QM章节Markdown→审核编辑→确认正式版本(final)→
// PDF导出输入→溯源→重启读回 (#43, docs/j03-j11-j12-audit.md §八).
//
// 诚实边界(与 goal 硬门禁对齐):
// - 章节/状态/审核作业走真实函数(startDeepChapterSession/normalizeChapterEditFile/
//   updateChapterStatus/advanceReviewJob*),fs 用内存 mock(与 j06-j09-real-transport
//   同法,等价 Tauri invoke 语义);paragraphs 切段与 writing-workspace.tsx:37-43 同法.
// - 真实 PDF 渲染不在此 spec 内:由 Rust cargo test pdfexport 覆盖
//   (9 passed,真实 pdfium + CJK 内嵌 + 回读断言,见审计 §五);前端 Dialog 的 Mock IPC
//   spec 不记作产物验证(门禁10).
// - 已知缺口不断言为通过:F-J12-01(无Export状态机)/F-J12-02(导出输入不绑定确认版本,
//   本 spec 以调用方显式 final 门演示人控补偿)/F-J12-03(无导出历史持久化).
import { describe, expect, it, beforeEach, vi } from "vitest"

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

import { parseFrontmatter } from "../frontmatter"
import {
  isFinalChapter,
  normalizeChapterStatus,
  parseChapterMeta,
  updateChapterStatus,
} from "./chapter-meta"
import { normalizeChapterEditFile } from "./chapter-edit-file"
import { validateExportTarget } from "../export/pdf-client"
import {
  advanceReviewJobDone,
  advanceReviewJobRunning,
} from "./review-job-lifecycle"
import {
  loadNovelSessionStatus,
  startDeepChapterSession,
} from "./novel-session-status"

const PROJECT = "C:/QM-J0312/slice-book"
const CHAPTER = `${PROJECT}/QM/chapters/chapter-001.md`

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
  "远处灯塔的光忽明忽暗。",
  "",
].join("\n")

/** 与 writing-workspace.tsx:37-43 同法:正文按空行切段(导出输入口径). */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

beforeEach(() => fsState.fileMap.clear())

describe("J03/J11/J12 首轮纵切面(QM md→确认final→PDF输入→溯源→重启)", () => {
  it("选择QM章节→来源可溯→审核编辑→确认final→导出输入一致→重启读回", async () => {
    // ── J03 选择资产:QM/chapters 为正式章节根,frontmatter 即来源/版本/状态 ──
    await fsState.writeFileAtomic(CHAPTER, DRAFT_MD)
    expect(CHAPTER).toContain("/QM/chapters/")
    let disk = await fsState.readFile(CHAPTER)
    let fm = parseFrontmatter(disk).frontmatter as Record<string, unknown>
    expect(parseChapterMeta(fm)?.status).toBe("draft")
    expect(isFinalChapter(fm)).toBe(false)
    // F-J11-01 边界:无 confirmed 稳定版本对象——未知状态回退 draft,不静默确认为正式版
    expect(normalizeChapterStatus("confirmed")).toBe("draft")
    expect(normalizeChapterStatus("partial")).toBe("draft")

    // ── J03+J11 会话与审核作业(重启恢复载体=status.json) ──
    const s = await startDeepChapterSession({
      projectPath: PROJECT,
      conversationId: "conv-slice",
      userRequest: "审核第1章并导出PDF",
      chapterNumber: 1,
    })
    expect(s.status).toBe("running")
    const running = await advanceReviewJobRunning(PROJECT, 1)
    expect(running?.phase).toBe("running")

    // ── J11 审核编辑:人工修改经归一写回,空正文拒写回 ──
    const edited = normalizeChapterEditFile({
      content: "林深推开门，雾气涌入，人工加了一句：灯塔今夜不会亮。",
      targetChapterNumber: 1,
      originalContent: disk,
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) throw new Error("unreachable")
    await fsState.writeFileAtomic(CHAPTER, edited.content)
    disk = await fsState.readFile(CHAPTER)
    expect(disk).toContain("人工加了一句")
    // frontmatter 沿用原文件(状态仍 draft,编辑≠确认)
    fm = parseFrontmatter(disk).frontmatter as Record<string, unknown>
    expect(parseChapterMeta(fm)?.status).toBe("draft")

    // ── J11 确认正式版本:复用 final 语义(审计 §四,不新增状态机) ──
    const finalized = updateChapterStatus(disk, "final")
    await fsState.writeFileAtomic(CHAPTER, finalized)
    disk = await fsState.readFile(CHAPTER)
    fm = parseFrontmatter(disk).frontmatter as Record<string, unknown>
    expect(isFinalChapter(fm)).toBe(true)

    // ── J12 预览/导出输入:UI=磁盘=导出输入 ──
    const body = parseFrontmatter(disk).body
    const paragraphs = splitParagraphs(body)
    expect(paragraphs.length).toBeGreaterThan(1)
    expect(paragraphs.join("\n")).toContain("人工加了一句") // 导出输入含人工修改
    // F-J12-02 人控补偿:导出层不绑定确认版本,调用方必须显式断言 final 才放行
    if (!isFinalChapter(fm)) throw new Error("导出门:非 final 章节不得导出")
    // 用户选路径:数据区之外通过,数据区内拒绝
    expect(validateExportTarget("exports/chapter-001.pdf")).toBeNull()
    expect(validateExportTarget("QM/exports/book.pdf")).toBe("pdfexport.path.outsideData")
    expect(validateExportTarget(".novel/exports/book.pdf")).toBe("pdfexport.path.outsideData")

    // ── J11 审核完成 + 重启读回:章节 final + review_job done 双持久 ──
    const doneJob = await advanceReviewJobDone(PROJECT, "人工确认第1章")
    expect(doneJob?.phase).toBe("done")
    const reloaded = await loadNovelSessionStatus(PROJECT)
    expect(reloaded?.review_job?.phase).toBe("done")
    const reChapter = await fsState.readFile(CHAPTER)
    const reFm = parseFrontmatter(reChapter).frontmatter as Record<string, unknown>
    expect(isFinalChapter(reFm)).toBe(true) // 重启后确认版本可恢复
    expect(reChapter).toContain("人工加了一句") // 重启后人工修改可恢复
    // F-J12-03 如实记录:无导出历史持久化对象,本轮不虚构导出记录断言
  })
})
