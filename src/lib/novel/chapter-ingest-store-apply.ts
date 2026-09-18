/**
 * chapter-ingest-store-apply — 快照→store fold 应用子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 chapter-ingest.ts 抽出的 store-apply 纯函数：applyEmotionalArcsToStore/
 * applyResourceLedgerToStore/applySubplotChangesToStore。主文件只做编排——
 * fold 应用逻辑独立可测，不再埋在编排体里。
 */

import type { EmotionalArcStore } from "./emotional-arcs"
import type { ResourceLedgerStore } from "./resource-ledger"
import type { SubplotBoardStore } from "./subplot-board"
import type { FoldContext } from "./projection-store"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { NameAliasMap } from "./book-analysis/types"
import { resolveCanonicalName, resolveMatchingMap } from "./character-cognition"

export function applyEmotionalArcsToStore(
  arcStore: EmotionalArcStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
  ctx?: FoldContext,
): EmotionalArcStore {
  const details = snapshot.characterDetails ?? {}
  for (const [rawName, detail] of Object.entries(details)) {
    const arcChange = (detail?.arcChange ?? "").trim()
    if (!arcChange) continue
    const canonical = resolveCanonicalName(rawName, resolveMatchingMap(rawName, aliasMaps))
    // fold_rebuildable idempotency (CORR-103): a beat is keyed by
    // (character, chapterNumber). Re-ingesting the same snapshot (or re-running
    // the fold over a store that already holds this chapter's beat) MUST update
    // the existing beat rather than append a duplicate — otherwise live re-ingest
    // diverges from a clean rebuild (which folds each snapshot exactly once).
    const existing = arcStore.beats.find(
      b => b.character === canonical && b.chapterNumber === snapshot.chapterNumber,
    )
    if (existing) {
      existing.emotion = arcChange
    } else {
      arcStore.beats.push({
        character: canonical,
        chapterNumber: snapshot.chapterNumber,
        emotion: arcChange,
        intensity: 0,
        trigger: "",
        notes: "",
      })
    }
  }
  // E-03 (C-3): fold 纯性 — 缺省保留输入 store 时间戳。
  arcStore.lastUpdated = ctx?.now ?? arcStore.lastUpdated
  return arcStore
}

/**
 * R4 (S4 / ANL-013): fold resource-ledger entries from a snapshot's
 * itemDetails.holder / previousHolders. Shared by ingest + rebuild so the
 * fold is deterministic (fold_rebuildable contract). Each chapter's holder
 * becomes a transfer entry; the first holder seeds acquiredChapter.
 */
export function applyResourceLedgerToStore(
  ledger: ResourceLedgerStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
  ctx?: FoldContext,
): ResourceLedgerStore {
  const details = snapshot.itemDetails ?? {}
  for (const [itemName, detail] of Object.entries(details)) {
    const rawHolder = (detail?.holder ?? "").trim()
    if (!itemName) continue
    const entry = ledger.entries.find((e) => e.item === itemName)
    const canonicalHolder = rawHolder
      ? resolveCanonicalName(rawHolder, resolveMatchingMap(rawHolder, aliasMaps))
      : ""

    // PAT-M1 (odyssey sibling) analysis: this store IS idempotent on re-fold
    // of the same snapshot — the `canonicalHolder !== entry.currentHolder`
    // guard prevents duplicate transition pushes (re-fold sees an equal
    // currentHolder and skips), and the seed branch only fires when the entry
    // does not yet exist (so live re-ingest matches clean rebuild, which also
    // seeds only once per item). The earlier semantic-scan suspicion of a
    // missing (item, chapterNumber) dedup key was a false positive: holder
    // equality is the correct idempotency signal here because a holder that
    // does not change produces no new transfer row by design. Left as-is.

    if (!entry) {
      ledger.entries.push({
        item: itemName,
        currentHolder: canonicalHolder,
        acquiredChapter: snapshot.chapterNumber,
        transferredFrom: (detail?.previousHolders ?? "").trim() || undefined,
        transferHistory: canonicalHolder
          ? [{ fromChapter: snapshot.chapterNumber, fromHolder: "", toHolder: canonicalHolder }]
          : [],
      })
    } else if (canonicalHolder && canonicalHolder !== entry.currentHolder) {
      entry.transferHistory.push({
        fromChapter: snapshot.chapterNumber,
        fromHolder: entry.currentHolder,
        toHolder: canonicalHolder,
      })
      entry.currentHolder = canonicalHolder
    }
  }
  // E-03 (C-3): fold 纯性 — 缺省保留输入 store 时间戳。
  ledger.lastUpdated = ctx?.now ?? ledger.lastUpdated
  return ledger
}

// ============================================================================
// Phase 3 (LE-1): Subplot 结构化逾期标记写入端
// ============================================================================

/**
 * Phase 3 (LE-1): applySubplotChangesToStore — 从 snapshot 情节线解决/废弃事件
 * 解析结构化标记，写入 SubplotBoard。
 *
 * 数据源:
 *   - foreshadowingChanges "回收伏笔：name" → targetResolutionChapter = current chapter
 *   - foreshadowingChanges "废弃：name" / "废弃伏笔：name" → abandoned = true
 *   - events 含 "废弃" + subplot title → abandoned = true
 *
 * 匹配方式: 按 subplot.title substring 匹配（name 含 title 或 title 含 name），
 * 与 foreshadowing 匹配风格一致。
 *
 * fold_rebuildable: 对同一 snapshot 重复调用零行为变更 (idempotent — 同章号
 * 重复写入 targetResolutionChapter/abandoned 相同值)。
 */
export function applySubplotChangesToStore(
  board: SubplotBoardStore,
  snapshot: ChapterSnapshot,
  ctx?: FoldContext,
): SubplotBoardStore {
  for (const change of snapshot.foreshadowingChanges) {
    const trimmed = change.trim()

    // 回收 (resolve) → targetResolutionChapter = current chapter
    if (/^(回收伏笔|回收)[:：]/.test(trimmed)) {
      const content = trimmed.replace(/^(回收伏笔|回收)[:：]?\s*/, "")
      const name = content.split("-")[0]?.trim() || content.trim()
      if (!name) continue
      for (const subplot of board.items) {
        if (subplot.title.includes(name) || name.includes(subplot.title)) {
          subplot.targetResolutionChapter = snapshot.chapterNumber
          if (subplot.status !== "resolved") {
            subplot.status = "resolved"
            subplot.resolvedChapter = snapshot.chapterNumber
          }
        }
      }
    }

    // 废弃 (abandon) → abandoned = true
    if (/^(废弃|废弃伏笔)[:：]/.test(trimmed)) {
      const content = trimmed.replace(/^(废弃|废弃伏笔)[:：]?\s*/, "")
      const name = content.split("-")[0]?.trim() || content.trim()
      if (!name) continue
      for (const subplot of board.items) {
        if (subplot.title.includes(name) || name.includes(subplot.title)) {
          subplot.abandoned = true
          if (subplot.status !== "resolved") {
            subplot.status = "resolved"
            subplot.resolvedChapter = snapshot.chapterNumber
          }
        }
      }
    }
  }

  // 同时检查 events 中 "废弃" + subplot title 组合
  for (const event of snapshot.events) {
    if (!event.includes("废弃")) continue
    for (const subplot of board.items) {
      if (event.includes(subplot.title)) {
        subplot.abandoned = true
        if (subplot.status !== "resolved") {
          subplot.status = "resolved"
          subplot.resolvedChapter = snapshot.chapterNumber
        }
      }
    }
  }

  // E-03 (C-3): fold 纯性 — 缺省保留输入 store 时间戳。
  board.lastUpdated = ctx?.now ?? board.lastUpdated
  return board
}
