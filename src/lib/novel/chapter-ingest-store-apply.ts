/**
 * chapter-ingest-store-apply — 快照→store fold 应用子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 chapter-ingest.ts 抽出的 store-apply 纯函数：applyEmotionalArcsToStore/
 * applyResourceLedgerToStore/applySubplotChangesToStore。主文件只做编排——
 * fold 应用逻辑独立可测，不再埋在编排体里。
 */

import type { CharacterStateStore } from "./character-state"
import type { EmotionalArcStore } from "./emotional-arcs"
import type { Foreshadowing, ForeshadowingStore } from "./foreshadowing-tracker"
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

// ── applyCharacterStateChangesToStore / applyForeshadowingChangesToStore（arch-risk W4 补）──
// 同 fold 家族并入本模块（原在主文件），使 projection 块可完整抽离不依赖主文件。
export function parseCharacterStateChange(change: string): { charName: string; changeDesc: string } | null {
  const colonIdx = change.search(/[:：]/)
  if (colonIdx <= 0) return null
  return {
    charName: change.slice(0, colonIdx).trim(),
    changeDesc: change.slice(colonIdx + 1).trim(),
  }
}

/**
 * CORR-001/002 fix: shared colon parser for foreshadowing change lines.
 * Accepts both ASCII ":" and fullwidth "：" (Chinese LLM default). Classifies
 * the line as add/advance/resolve via the /^(新增伏笔|新增|推进伏笔|推进|回收伏笔|回收)[:：]/
 * guards. Shared by the live ingest path and applyForeshadowingChangesToStore
 * so the fold is deterministic (fold_rebuildable contract — ingest == rebuild
 * for fullwidth-colon lines). Returns null for unrecognized lines.
 */
export function parseForeshadowingChange(change: string):
  | { kind: "add"; name: string; desc: string }
  | { kind: "advance"; name: string; desc: string }
  | { kind: "resolve"; name: string; desc: string }
  | null {
  const trimmed = change.trim()
  if (/^(新增伏笔|新增)[:：]/.test(trimmed)) {
    const content = trimmed.replace(/^(新增伏笔|新增)[:：]?\s*/, "")
    const dashIdx = content.indexOf("-")
    return {
      kind: "add",
      name: dashIdx > 0 ? content.slice(0, dashIdx).trim() : content.trim(),
      desc: dashIdx > 0 ? content.slice(dashIdx + 1).trim() : "",
    }
  }
  if (/^(推进伏笔|推进)[:：]/.test(trimmed)) {
    // CORR-105: capture the post-colon detail (LLM-provided advance reason)
    // instead of discarding it. The add branch splits on '-'; advance/resolve
    // names are typically bare, so capture the whole remainder as desc.
    const content = trimmed.replace(/^(推进伏笔|推进)[:：]?\s*/, "")
    const dashIdx = content.indexOf("-")
    return {
      kind: "advance",
      name: dashIdx > 0 ? content.slice(0, dashIdx).trim() : content.trim(),
      desc: dashIdx > 0 ? content.slice(dashIdx + 1).trim() : "",
    }
  }
  if (/^(回收伏笔|回收)[:：]/.test(trimmed)) {
    // CORR-105: capture the post-colon detail (LLM-provided resolution reason).
    const content = trimmed.replace(/^(回收伏笔|回收)[:：]?\s*/, "")
    const dashIdx = content.indexOf("-")
    return {
      kind: "resolve",
      name: dashIdx > 0 ? content.slice(0, dashIdx).trim() : content.trim(),
      desc: dashIdx > 0 ? content.slice(dashIdx + 1).trim() : "",
    }
  }
  return null
}

// LE-2 Phase 2: 死亡状态检测模式 — 与 deterministic-continuity-engine.ts
// DEFAULT_CONTINUITY_CONFIG.deadCharacterPatterns 保持一致，确保生产端写入与引擎
// 读端同源。正则 fallback 保留（结构化缺失时降级匹配，行为向后兼容）。
const DEATH_PATTERNS = ["死", "亡", "殒", "逝", "毙"] as const

export function isDeathStatus(status: string): boolean {
  return status.length > 0 && DEATH_PATTERNS.some((p) => status.includes(p))
}

export function applyCharacterStateChangesToStore(
  existingChars: CharacterStateStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
  ctx?: FoldContext,
): CharacterStateStore {
  for (const change of snapshot.characterStateChanges) {
    const parsed = parseCharacterStateChange(change)
    if (parsed) {
      const { charName, changeDesc } = parsed
      const canonical = resolveCanonicalName(charName, resolveMatchingMap(charName, aliasMaps))
      const existing = existingChars.characters.find(c => c.characterName === canonical)
      if (existing) {
        existing.status = changeDesc
        existing.lastUpdatedChapter = snapshot.chapterNumber
        existing.lastSeenChapter = snapshot.chapterNumber
        // E-03 (C-3): fold 纯性 — 缺省保留输入值, 不引入隐式时钟。
        existing.lastUpdatedAt = ctx?.now ?? existing.lastUpdatedAt
        // LE-2 Phase 2: 结构化死亡标记写入端落地
        if (isDeathStatus(changeDesc)) {
          existing.isAlive = false
          existing.deathChapter = snapshot.chapterNumber
        }
      } else {
        const isDead = isDeathStatus(changeDesc)
        existingChars.characters.push({
          characterName: canonical,
          currentLocation: "",
          status: changeDesc,
          equipment: [],
          abilities: [],
          relationships: {},
          lastUpdatedChapter: snapshot.chapterNumber,
          lastSeenChapter: snapshot.chapterNumber,
          // E-03 (C-3): 新条目无 ctx 时写 ""（不引入隐式时钟）。
          lastUpdatedAt: ctx?.now ?? "",
          // LE-2 Phase 2: 新角色死亡结构化标记
          ...(isDead ? { isAlive: false as const, deathChapter: snapshot.chapterNumber } : {}),
        })
      }
    } else {
      const matched = existingChars.characters.find(c => change.includes(c.characterName))
      if (matched) {
        matched.status = change
        matched.lastUpdatedChapter = snapshot.chapterNumber
        matched.lastSeenChapter = snapshot.chapterNumber
        // E-03 (C-3): fold 纯性 — 缺省保留输入值。
        matched.lastUpdatedAt = ctx?.now ?? matched.lastUpdatedAt
        // LE-2 Phase 2: 结构化死亡标记写入端落地
        if (isDeathStatus(change)) {
          matched.isAlive = false
          matched.deathChapter = snapshot.chapterNumber
        }
      }
    }
  }
  // E-03 (C-3): fold 纯性 — 缺省保留输入 store 时间戳。
  existingChars.lastUpdated = ctx?.now ?? existingChars.lastUpdated
  return existingChars
}

/**
 * P2-IMP-09：伏笔名归一——trim + 连续空白折叠（「归一全等」的归一）。
 */
export function normalizeForeshadowName(name: string): string {
  return name.trim().replace(/\s+/g, " ")
}

/**
 * P2-IMP-09：伏笔名匹配——双向裸 includes 改「归一全等 ∥ (最短名≥2 且词界判定)」，
 * 禁裸互含（「剑」⊂「剑意」反例：单字名不再命中有词边的长名）。
 * 词界判定：最短名≥2 且为长名的前缀或后缀（词界锚定；长名中缀包含不再视为匹配，
 * 「九剑法门」不命中「剑法」），keep 既有部分名推进/回收的合理场景（「黑剑」↔「黑剑碎片」）。
 */
export function foreshadowNamesMatch(a: string, b: string): boolean {
  const na = normalizeForeshadowName(a)
  const nb = normalizeForeshadowName(b)
  if (na === nb) return true
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length <= nb.length ? nb : na
  if (shorter.length < 2) return false
  return longer.startsWith(shorter) || longer.endsWith(shorter)
}

export function applyForeshadowingChangesToStore(existingForeshadows: ForeshadowingStore, snapshot: ChapterSnapshot, ctx?: FoldContext): ForeshadowingStore {
  for (const change of snapshot.foreshadowingChanges) {
    const parsed = parseForeshadowingChange(change)
    if (!parsed) continue
    if (parsed.kind === "add") {
      // fold_rebuildable idempotency (CORR-104): an "add" foreshadow is keyed
      // by (plantedChapter, name). Re-ingesting the same snapshot MUST NOT
      // append a duplicate with a fresh length+1 id — otherwise live re-ingest
      // diverges from a clean rebuild (which folds each snapshot exactly once)
      // and ids collide/drift. If an item with the same name was already
      // planted by this chapter, update it in place instead of pushing.
      const existing = existingForeshadows.items.find(
        f => f.name === parsed.name && f.plantedChapter === snapshot.chapterNumber,
      )
      if (existing) {
        existing.description = parsed.desc
      } else {
        const newForeshadow: Foreshadowing = {
          id: `fs-${snapshot.chapterNumber}-${existingForeshadows.items.length + 1}`,
          name: parsed.name,
          description: parsed.desc,
          status: "planted",
          plantedChapter: snapshot.chapterNumber,
          advancedChapters: [],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        }
        existingForeshadows.items.push(newForeshadow)
      }
    } else if (parsed.kind === "advance") {
      const matched = existingForeshadows.items.find(
        f => foreshadowNamesMatch(f.name, parsed.name)
      )
      if (matched) {
        matched.status = "advanced"
        if (!matched.advancedChapters.includes(snapshot.chapterNumber)) {
          matched.advancedChapters.push(snapshot.chapterNumber)
        }
        // CORR-105: preserve the LLM-provided advance detail in notes (was
        // silently discarded by the prior `desc: ""` parser). Append with
        // chapter context so repeated advances accumulate rather than overwrite.
        if (parsed.desc) {
          const noteLine = `[第${snapshot.chapterNumber}章推进] ${parsed.desc}`
          matched.notes = matched.notes ? `${matched.notes}\n${noteLine}` : noteLine
        }
      }
    /* v8 ignore next */
    } else if (parsed.kind === "resolve") { /* v8 ignore start */ /* v8 ignore stop */
      const matched = existingForeshadows.items.find(
        f => foreshadowNamesMatch(f.name, parsed.name)
      )
      if (matched) {
        matched.status = "resolved"
        matched.resolvedChapter = snapshot.chapterNumber
        // CORR-105: preserve the LLM-provided resolution detail in notes.
        if (parsed.desc) {
          const noteLine = `[第${snapshot.chapterNumber}章回收] ${parsed.desc}`
          matched.notes = matched.notes ? `${matched.notes}\n${noteLine}` : noteLine
        }
      }
    }
  }
  // E-03 (C-3): fold 纯性 — 缺省保留输入 store 时间戳。
  existingForeshadows.lastUpdated = ctx?.now ?? existingForeshadows.lastUpdated
  return existingForeshadows
}
