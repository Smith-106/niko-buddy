/**
 * R-inkos-5 (23-inkos-coverage roadmap P1): ChapterWorkspace — 章节原子快照工作区.
 *
 * 吸收来源：reference/inkos「安全章节工作区（原子提交）」— 23 号覆盖审计
 * 三票 roadmap 完全一致，终裁 P1 后本 goal 落地。
 *
 * 定位：Draft-first 的历史维度增强——pending/ready 管当前草稿，工作区管理
 * 已提交快照栈（每次 accept 前可落一份快照），支持回滚取回与变更摘要。
 * 语义为「快照栈」而非 git（桌面单机零依赖纪律）：栈上限淘汰最旧快照，
 * 回滚 = 取回历史内容 + 不破坏栈（调用方决定是否以新快照记录回滚动作）。
 *
 * 持久化：createAtomicJsonStore（writeFileAtomic temp+fsync+rename 同契约）。
 * 内容安全：快照只存 preview（首 120 字）与 wordCount 于轻量摘要；
 * 全文 content 进栈供回滚取回（单项目本地文件，容量由 maxSnapshots 封顶）。
 */

import { createAtomicJsonStore } from "./projection-store"

export const CHAPTER_WORKSPACE_MAX_SNAPSHOTS = 20
export const SNAPSHOT_PREVIEW_CHARS = 120

export interface ChapterSnapshot {
  chapter: number
  savedAt: string
  wordCount: number
  /** 首 120 字预览（审计/选择回滚点用）。 */
  preview: string
  /** 快照全文（回滚取回用）。 */
  content: string
}

export interface ChapterWorkspaceStore {
  snapshots: ChapterSnapshot[]
  lastUpdated: string
}

export function createEmptyChapterWorkspaceStore(): ChapterWorkspaceStore {
  return { snapshots: [], lastUpdated: new Date().toISOString() }
}

const workspaceStore = createAtomicJsonStore<ChapterWorkspaceStore>(
  "chapter-workspace.json",
  createEmptyChapterWorkspaceStore,
)

export async function saveChapterWorkspace(
  projectPath: string,
  store: ChapterWorkspaceStore,
): Promise<void> {
  await workspaceStore.save(projectPath, store)
}

export async function loadChapterWorkspace(
  projectPath: string,
): Promise<ChapterWorkspaceStore> {
  return workspaceStore.load(projectPath)
}

function countWords(text: string): number {
  // 中文按字计数 + ASCII 词计数（与中文小说字数直觉一致的近似）
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const asciiWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length
  return cjk + asciiWords
}

/**
 * 原子提交一份章节快照（追加栈顶；超上限淘汰最旧）。纯函数语义，
 * 返回新 store（调用方决定持久化）。
 */
export function commitSnapshot(
  store: ChapterWorkspaceStore,
  chapter: number,
  content: string,
  opts: { maxSnapshots?: number } = {},
): ChapterWorkspaceStore {
  const max = opts.maxSnapshots ?? CHAPTER_WORKSPACE_MAX_SNAPSHOTS
  const snapshot: ChapterSnapshot = {
    chapter,
    savedAt: new Date().toISOString(),
    wordCount: countWords(content),
    preview: [...content].slice(0, SNAPSHOT_PREVIEW_CHARS).join(""),
    content,
  }
  const snapshots = [...store.snapshots, snapshot]
  while (snapshots.length > max) snapshots.shift()
  return { snapshots, lastUpdated: new Date().toISOString() }
}

/** 列出某章的快照（栈序：旧→新），仅含摘要字段（不含全文，避免上下文污染）。 */
export function listSnapshots(
  store: ChapterWorkspaceStore,
  chapter: number,
): Array<Omit<ChapterSnapshot, "content">> {
  return store.snapshots
    .filter((s) => s.chapter === chapter)
    .map(({ chapter: c, savedAt, wordCount, preview }) => ({
      chapter: c,
      savedAt,
      wordCount,
      preview,
    }))
}

/** 取回某章第 index 份快照全文（0 基，栈序同 listSnapshots）。越界返回 null。 */
export function rollbackToSnapshot(
  store: ChapterWorkspaceStore,
  chapter: number,
  index: number,
): string | null {
  const forChapter = store.snapshots.filter((s) => s.chapter === chapter)
  if (index < 0 || index >= forChapter.length) return null
  return forChapter[index].content
}

export interface WorkspaceDiffSummary {
  addedLines: number
  removedLines: number
  unchangedLines: number
  wordDelta: number
}

/**
 * 行级变更摘要（确定性；不做 LCS 对齐——桌面工作区场景仅需规模感）：
 * 以多重集合差统计（相同行按出现次数抵消）。
 */
export function workspaceDiffSummary(
  before: string,
  after: string,
): WorkspaceDiffSummary {
  const beforeLines = before.split(/\r?\n/).filter((l) => l.trim() !== "")
  const afterLines = after.split(/\r?\n/).filter((l) => l.trim() !== "")
  const counter = new Map<string, number>()
  for (const l of beforeLines) counter.set(l, (counter.get(l) ?? 0) + 1)
  let unchanged = 0
  for (const l of afterLines) {
    const c = counter.get(l) ?? 0
    if (c > 0) {
      unchanged++
      counter.set(l, c - 1)
    }
  }
  const removed = beforeLines.length - unchanged
  const added = afterLines.length - unchanged
  return {
    addedLines: added,
    removedLines: removed,
    unchangedLines: unchanged,
    wordDelta: countWords(after) - countWords(before),
  }
}
