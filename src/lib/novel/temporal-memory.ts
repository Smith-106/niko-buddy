/**
 * TASK-004 (S4 / ANL-013 R3): Temporal memory — cross-chapter time-ordered
 * fact extraction + reinjection.
 *
 * A `TemporalFact` carries a validity window (validFrom / validUntil chapter
 * numbers) so that "what is true at chapter N" is a query, not a guess. Facts
 * supersede earlier facts (close the old validity window) and negate earlier
 * facts (record the conflict pair for audit) — this is the supersession-chain
 * + negation-pairs model from ANL-013.
 *
 * CRITICAL (ANL-013 C4 / ADR-26 / A23 — no dual truth source):
 *   temporal-memory is a VIEW, not a new store. `getFactsAt` receives the
 *   `TemporalFact[]` array from the caller; the array is derived from
 *   ChapterSnapshot.newCanonFacts (chapter-ingest already records per-chapter
 *   canon facts) + the ProjectionStatusLedger (which chapters' facts are
 *   committed). temporal-memory itself NEVER owns a fact store — it folds the
 *   committed snapshot sequence into a temporal projection. The ledger
 *   (S3 F-002) remains the single source of truth for "which projection is
 *   committed for which chapter"; temporal facts are a derived view over the
 *   committed snapshot chain.
 *
 * The ProjectionStatusLedger import below is type-only: temporal-memory
 * consults the ledger shape (fold_rebuildable projection status) when callers
 * pass a ledger to `factsFromCommittedSnapshots`, but it does NOT persist any
 * new projection key — the ledger schema is left untouched (S3 F-002
 * contract).
 */
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import { resolveCanonicalName } from "./character-cognition"
import type { NameAliasMap } from "./book-analysis/types"
import type { ContextEntity } from "./context-engine"

export interface TemporalFact {
  /** Stable id (e.g. `fact-ch5-<idx>`). */
  id: string
  /** Canonical subject (character name normalized via resolveCanonicalName). */
  subject: string
  /** Predicate, e.g. "持有" / "位于" / "状态". */
  predicate: string
  /** Object value, e.g. "轩辕剑" / "凌霄殿" / "重伤". */
  object: string
  /** Chapter number at which this fact becomes effective. */
  validFrom: number
  /**
   * Chapter number at which this fact is no longer authoritative (closed by a
   * superseding or negating fact). undefined while the fact is still current.
   */
  validUntil?: number
  /** Ids of facts this fact supersedes (replaces). */
  supersedes?: string[]
  /** Chapter reference / provenance. */
  source: string
  /** Optional extraction confidence 0..1. */
  confidence?: number
}

/**
 * A negation pair records an explicit conflict: one fact negates another.
 * The negated fact's validUntil is closed; the pair is kept for audit so a
 * reviewer can revisit whether the negation was legitimate or a hallucination.
 */
export interface NegationPair {
  negatingId: string
  negatedId: string
  /** Chapter at which the negation was resolved. */
  resolvedAt: number
  note?: string
}

/**
 * Return all facts authoritative at `chapterNumber`.
 *
 * A fact is authoritative when `validFrom <= chapterNumber` AND
 * (`validUntil` is unset OR `validUntil > chapterNumber`). When `subject` is
 * provided, results are filtered by canonical name (resolved through the
 * optional alias map) so aliases fold to the same subject.
 */
export function getFactsAt(
  chapterNumber: number,
  subject: string | undefined,
  facts: readonly TemporalFact[],
  aliasMap?: NameAliasMap,
): TemporalFact[] {
  const canonicalSubject = subject !== undefined
    ? resolveCanonicalName(subject, aliasMap)
    : undefined

  return facts.filter((fact) => {
    if (fact.validFrom > chapterNumber) return false
    if (fact.validUntil !== undefined && fact.validUntil <= chapterNumber) return false
    if (canonicalSubject !== undefined) {
      if (resolveCanonicalName(fact.subject, aliasMap) !== canonicalSubject) return false
    }
    return true
  })
}

/**
 * Alias for getFactsAt — Graphiti-style "what is true at chapter N" query surface.
 * VIEW only: does not own storage (ANL-013 C4).
 */
export function queryFactsAt(
  chapterNumber: number,
  subject: string | undefined,
  facts: readonly TemporalFact[],
  aliasMap?: NameAliasMap,
): TemporalFact[] {
  return getFactsAt(chapterNumber, subject, facts, aliasMap)
}

/**
 * Close a fact's validity window at `atChapter` (invalidate without deleting).
 * Monotonic: only narrows validUntil. Returns false if id missing.
 * Prefer resolveNegation when a replacing fact exists; use this for soft revoke.
 */
export function invalidateFact(
  facts: TemporalFact[],
  id: string,
  atChapter: number,
  note?: string,
): { ok: boolean; note?: string } {
  const fact = facts.find((f) => f.id === id)
  if (!fact) return { ok: false }
  const ch = Number.isFinite(atChapter) ? Math.trunc(atChapter) : fact.validFrom
  if (ch < (fact.validUntil ?? Infinity)) {
    fact.validUntil = ch
  }
  return { ok: true, note }
}

/**
 * Record that `newFact` supersedes `oldFactId`: close the old fact's validity
 * window at the new fact's validFrom and link the supersedes chain. Mutates
 * the facts array in place (callers pass the live array). No-op if the old
 * fact is missing. The validity window only ever narrows (monotonic
 * convergence, CORR-003): repeated calls settle validUntil to the minimum of
 * all validFrom values passed, regardless of call order.
 */
export function recordSupersession(
  newFact: TemporalFact,
  oldFactId: string,
  facts: TemporalFact[],
): void {
  const oldFact = facts.find((f) => f.id === oldFactId)
  if (!oldFact) return
  // Always link the supersession chain, even when the old fact was already
  // closed earlier — the chain is provenance, not a window mutation.
  if (!newFact.supersedes) newFact.supersedes = []
  if (!newFact.supersedes.includes(oldFactId)) {
    newFact.supersedes.push(oldFactId)
  }
  // Monotonic convergence (CORR-003): only ever NARROW the validity window,
  // never widen it. The final validUntil is the min of all validFrom values
  // ever passed, regardless of call order — order-independent.
  const newValidUntil = newFact.validFrom
  if (newValidUntil < (oldFact.validUntil ?? Infinity)) {
    oldFact.validUntil = newValidUntil
  }
}

/**
 * Record that `negatingFact` negates `negatedFactId`: close the negated
 * fact's validity window and return the NegationPair for audit. The negating
 * fact remains authoritative from its own validFrom. Returns the pair so
 * callers can accumulate an audit log; the negated fact is mutated in place.
 * The validity window only ever narrows (monotonic convergence, CORR-003):
 * repeated calls settle validUntil to the minimum of all validFrom values
 * passed, regardless of call order.
 */
export function resolveNegation(
  negatingFact: TemporalFact,
  negatedFactId: string,
  facts: TemporalFact[],
  note?: string,
): NegationPair | null {
  const negated = facts.find((f) => f.id === negatedFactId)
  if (!negated) return null
  // Monotonic convergence (CORR-003): only ever NARROW the validity window,
  // never widen it. Order-independent across repeated calls.
  const newValidUntil = negatingFact.validFrom
  if (newValidUntil < (negated.validUntil ?? Infinity)) {
    negated.validUntil = newValidUntil
  }
  return {
    negatingId: negatingFact.id,
    negatedId: negatedFactId,
    resolvedAt: negatingFact.validFrom,
    note,
  }
}

/**
 * Derive a TemporalFact[] view from committed snapshots.
 *
 * ANL-013 C4 no-dual-truth-source: this folds the snapshot chain's
 * newCanonFacts into temporal facts. Only snapshots whose projection status
 * in the ledger is "committed" (or absent from the ledger, treated as
 * committed for read-path robustness) are folded — the ledger remains the
 * single authority for projection commit state. The fact id is keyed by
 * chapter + index so repeated folds are idempotent.
 */
export function factsFromCommittedSnapshots(
  snapshots: readonly ChapterSnapshot[],
  ledger: ProjectionStatusLedger | undefined,
  aliasMap?: NameAliasMap,
): TemporalFact[] {
  const sorted = [...snapshots].sort((a, b) => a.chapterNumber - b.chapterNumber)
  const facts: TemporalFact[] = []

  for (const snapshot of sorted) {
    const chapterKey = String(snapshot.chapterNumber)
    const projectionEntry = ledger?.chapters?.[chapterKey]?.["snapshot"]
    // Skip snapshots whose own snapshot projection is marked failed — they
    // are not authoritative. (committed / pending / absent → include.)
    if (projectionEntry?.status === "failed") continue

    snapshot.newCanonFacts.forEach((raw, idx) => {
      const parsed = parseCanonFact(raw)
      facts.push({
        id: `fact-ch${snapshot.chapterNumber}-${idx}`,
        subject: resolveCanonicalName(parsed.subject, aliasMap),
        predicate: parsed.predicate,
        object: parsed.object,
        validFrom: snapshot.chapterNumber,
        source: `chapter-${snapshot.chapterNumber}`,
        confidence: parsed.confidence,
      })
    })
  }

  return facts
}

/**
 * Parse a raw canon-fact string ("subject：predicate object" or
 * "subject 是 object") into subject / predicate / object. Falls back to a
 * whole-string subject with an empty predicate/object when no separator
 * matches — the fact is still recorded so it remains queryable.
 */
function parseCanonFact(raw: string): {
  subject: string
  predicate: string
  object: string
  confidence?: number
} {
  const trimmed = raw.trim()
  if (!trimmed) return { subject: "", predicate: "", object: "" }

  // "subject：predicate object" form.
  const colonMatch = trimmed.match(/^(.+?)[:：]\s*(.+)$/)
  if (colonMatch) {
    return {
      subject: colonMatch[1].trim(),
      predicate: "是",
      object: colonMatch[2].trim(),
    }
  }

  // "subject 是/为/属于 object" form.
  const verbMatch = trimmed.match(/^(.+?)\s*(?:是|为|属于|拥有)\s*(.+)$/)
  if (verbMatch) {
    return {
      subject: verbMatch[1].trim(),
      predicate: "是",
      object: verbMatch[2].trim(),
    }
  }

  return { subject: trimmed.slice(0, 20).trim(), predicate: "", object: "" }
}

/**
 * Render temporal facts authoritative at `chapterNumber` as a protected-tier
 * canon block for context injection. Returns "" when no facts are active so
 * callers can unconditionally concat.
 */
export function renderTemporalCanonBlock(
  chapterNumber: number,
  facts: readonly TemporalFact[],
  aliasMap?: NameAliasMap,
): string {
  const active = getFactsAt(chapterNumber, undefined, facts, aliasMap)
  if (active.length === 0) return ""
  const lines = active.map((f) => {
    const tail = f.object ? `${f.predicate} ${f.object}`.trim() : ""
    return `- [第${f.validFrom}章起] ${f.subject}${tail ? "：" + tail : ""}`
  })
  return `# 时序事实（截至第${chapterNumber}章有效）\n${lines.join("\n")}`
}

/**
 * TASK-001 (RPC-4 Track B): rerank active entities by temporal facts.
 *
 * 纯函数 —— 无 IO，无 LLM。接收 Track A (selectActiveEntities) 已筛选的
 * activeEntities，叠加 canon 路已 load 的 temporalFacts，将「在 chapterNumber
 * 章有效的时序事实 subject 命中」的 entity boost 到 rank 0。
 *
 * 不变量 (D6 —— 只升不降, 上限 rank 0, additive):
 *   - 已是 rank 0 的 entity (依 relevance tags) 永不降级；
 *   - rank > 0 且命中的 entity 升到 rank 0 (上限 rank 0)；
 *   - 未命中的 entity 保持原 rank 不变；
 *   - temporalFacts 为 null 或 activeEntities 为空时返回原序 (零命中退化加性,
 *     永不破坏 Track A 基线)。
 *
 * 稳定排序显式编码 (NEW-W7): 用 (finalRank, originalIndex) tuple 双键比较器,
 * 不依赖 V8 TimSort 运行时稳定性。
 */
export function rerankActiveEntitiesByTemporalFacts(
  activeEntities: ContextEntity[],
  temporalFacts: readonly TemporalFact[] | null,
  chapterNumber: number,
): ContextEntity[] {
  // 零命中退化：temporalFacts 为 null 或 activeEntities 为空时原序返回 (加性)。
  if (temporalFacts === null || activeEntities.length === 0) {
    return activeEntities
  }

  // 复刻 selectActiveEntities:1258-1266 的 rank 重算 —— ContextEntity 无持久化
  // 的 relevanceRank 字段 (仅 closure 局部), 故须从 entity.tags 推 rank。
  const computeRank = (e: ContextEntity, chapterN: number): number => {
    let rank = 1
    const tagStr = (e.tags ?? []).join(" ")
    if (tagStr.includes("relevance:high")) rank = 0
    else if (tagStr.includes("relevance:low")) rank = 2
    if (chapterN && tagStr.includes(`location:chapter-${chapterN}`)) rank = 0
    return rank
  }

  const tuples = activeEntities.map((entity, originalIndex) => {
    const rank = computeRank(entity, chapterNumber)
    // 简化路径 ii: 对每个 entity 用空 aliases 兜底构造 NameAliasMap 传 getFactsAt,
    // resolveCanonicalName 折叠别名匹配 fact.subject (F-07 覆盖度不足则退化原序)。
    const hits = getFactsAt(
      chapterNumber,
      entity.name,
      temporalFacts,
      { canonical: resolveCanonicalName(entity.name), aliases: [] } as NameAliasMap,
    )
    // 只升不降: 命中且 computeRank>0 → boost rank 0; 已 rank 0 命中也不动 (D6)。
    const boosted = hits.length > 0 && rank > 0
    const finalRank = boosted ? 0 : rank
    return { entity, originalIndex, finalRank }
  })

  // 稳定排序显式编码: finalRank 升序主键 + originalIndex 升序次键保稳定。
  tuples.sort((a, b) => a.finalRank - b.finalRank || a.originalIndex - b.originalIndex)
  return tuples.map((t) => t.entity)
}
