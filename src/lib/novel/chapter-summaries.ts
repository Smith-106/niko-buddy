import { createAtomicJsonStore } from "./projection-store"
import type { ChapterSnapshot } from "./chapter-ingest"

/**
 * R4 (S4 / ANL-013): ChapterSummaries projection — 每章「发生了什么 +
 * 状态变了什么」的键控真相。三模型共识（2026-08-27，deepseek-v4-pro +
 * GLM-5.2 + hy3，参考 Grok "Different Knowledge Bases for Writing AI"）：
 * Grok 7 类真相文件中 chapter_summaries 要求显式记录 state-change delta
 * （谁/什么字段 before→after），而 QMAI 现状只有 snapshot.summary 文本 +
 * recentSummaries 注入，无按章键控的 stateDelta 子表。本投影从
 * ChapterSnapshot 既有字段 fold（不新增提取语义），作为 character-state
 * SAME-LAYER sibling（NOT a Truth Files module — ANL-013 C4 forbids a
 * second truth source; ADR-26 + A23 must hold）。
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence — summary/characterStateChanges/relationshipChanges/
 * knowledgeChanges/foreshadowingChanges/itemDetails fold deterministically.
 * Persistence uses writeFileAtomic (fs.rs:1190 temp+fsync+rename) —
 * crash-safe, same contract as character-state.ts.
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with emotional-arcs / resource-ledger / subplot-board).
 */

export interface StateChange {
  /** Entity kind: character | relationship | knowledge | foreshadowing | item. */
  kind: string
  /** Entity name (canonical). */
  entity: string
  /** Change description (from snapshot delta line, verbatim). */
  change: string
}

export interface ChapterSummaryEntry {
  /** Chapter number (key). */
  chapter: number
  /** What happened (snapshot.summary verbatim). */
  happened: string
  /** State deltas folded from snapshot delta fields. */
  stateChanges: StateChange[]
  /** Key reveals (from knowledgeChanges + newCanonFacts). */
  keyReveals: string[]
  /** Ending hook (snapshot.endingHook verbatim). */
  endingHook: string
}

export interface ChapterSummariesStore {
  /** Keyed by chapter number, ascending. */
  entries: ChapterSummaryEntry[]
  lastUpdated: string
}

export function createEmptyChapterSummariesStore(): ChapterSummariesStore {
  return { entries: [], lastUpdated: "" }
}

const store = createAtomicJsonStore<ChapterSummariesStore>(
  "chapter-summaries.json",
  createEmptyChapterSummariesStore,
)

export async function saveChapterSummaries(
  projectPath: string,
  storeData: ChapterSummariesStore,
): Promise<void> {
  await store.save(projectPath, storeData)
}

export async function loadChapterSummaries(
  projectPath: string,
): Promise<ChapterSummariesStore> {
  return store.load(projectPath)
}

/**
 * 从 ChapterSnapshot 确定性 fold 出本章摘要条目（纯函数，零 LLM）。
 * 供 chapter-ingest 投影循环在 accept 后调用；模型不得直接覆写。
 */
export function foldChapterSummary(snapshot: ChapterSnapshot): ChapterSummaryEntry {
  const stateChanges: StateChange[] = []
  for (const line of snapshot.characterStateChanges ?? []) {
    stateChanges.push({ kind: "character", entity: line.split(/[：:]/)[0] || "?", change: line })
  }
  for (const line of snapshot.relationshipChanges ?? []) {
    stateChanges.push({ kind: "relationship", entity: line.split(/[：:]/)[0] || "?", change: line })
  }
  for (const line of snapshot.knowledgeChanges ?? []) {
    stateChanges.push({ kind: "knowledge", entity: line.split(/[：:]/)[0] || "?", change: line })
  }
  for (const line of snapshot.foreshadowingChanges ?? []) {
    stateChanges.push({ kind: "foreshadowing", entity: line.split(/[：:]/)[0] || "?", change: line })
  }
  for (const [item, detail] of Object.entries(snapshot.itemDetails ?? {})) {
    const holder = detail.holder || "?"
    stateChanges.push({ kind: "item", entity: item, change: `归属 → ${holder}` })
  }
  return {
    chapter: snapshot.chapterNumber,
    happened: snapshot.summary,
    stateChanges,
    keyReveals: [...(snapshot.knowledgeChanges ?? []), ...(snapshot.newCanonFacts ?? [])],
    endingHook: snapshot.endingHook,
  }
}

/**
 * 按章 upsert（同章已存在则替换，保持升序）。
 */
export function upsertChapterSummary(
  storeData: ChapterSummariesStore,
  entry: ChapterSummaryEntry,
): ChapterSummariesStore {
  const rest = storeData.entries.filter((e) => e.chapter !== entry.chapter)
  const entries = [...rest, entry].sort((a, b) => a.chapter - b.chapter)
  return { entries, lastUpdated: new Date().toISOString() }
}

/**
 * 取最近 N 章摘要（Grok 调用规则：规划读 current_state + pending_hooks +
 * 近 3 章摘要）。
 */
export function recentChapterSummaries(
  storeData: ChapterSummariesStore,
  n: number,
): ChapterSummaryEntry[] {
  return storeData.entries.slice(-n)
}

export function chapterSummariesToContextText(
  storeData: ChapterSummariesStore,
  n = 3,
): string {
  const recent = recentChapterSummaries(storeData, n)
  if (recent.length === 0) return ""
  const lines = recent.map((e) => {
    const deltas = e.stateChanges.length
      ? e.stateChanges.map((d) => `  - [${d.kind}] ${d.entity}: ${d.change}`).join("\n")
      : "  - （无状态变更）"
    return `第${e.chapter}章：${e.happened}\n${deltas}`
  })
  return `【近 ${recent.length} 章摘要】\n${lines.join("\n")}`
}
