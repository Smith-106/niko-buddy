/**
 * Context usage snapshot for the Wave 5 (v2.5.0) transparency ring.
 *
 * The ring shows where the context window went: 记忆 (user memory, measured
 * from the actual injected preference text) / 检索 (index budget) / 图谱
 * (active-entity budget) / 正文 (page budget) / 其他 (history + system +
 * response reserve remainder). Budget lines come straight from
 * `computeContextBudget` output — never recomputed here. Memory has no
 * budget line in context-budget.ts (it is injected via de-AI weights), so
 * its honest source is the measured preference character count.
 *
 * MIT License — independently implemented.
 */
import type { ContextBudget } from "./context-budget"
import type { UserMemoryStore } from "./user-memory/types"

/** Character allocation snapshot for one context build. */
export interface ContextUsage {
  /** 记忆 — measured preference text length (0 when no store / no prefs). */
  memoryChars: number
  /** 检索 — indexBudget. */
  retrievalChars: number
  /** 图谱 — activeEntitiesBudget rank0+rank1+rank2 sum. */
  graphChars: number
  /** 正文 — pageBudget. */
  bodyChars: number
  /** 其他 — maxCtx − (memory + retrieval + graph + body + responseReserve). */
  otherChars: number
  /** Full context window (chars). */
  maxCtx: number
}

/** One ring segment (fraction of the full circle). */
export interface RingSegment {
  key: "memory" | "retrieval" | "graph" | "body" | "other"
  label: string
  chars: number
  /** Fraction of maxCtx (0..1). */
  fraction: number
}

const SEGMENT_LABELS: Record<RingSegment["key"], string> = {
  memory: "记忆",
  retrieval: "检索",
  graph: "图谱",
  body: "正文",
  other: "其他",
}

/**
 * Assemble the usage snapshot from the budget + measured memory store.
 * Pure — no I/O, no state. `userMemoryStore` null/empty → memoryChars 0.
 */
export function buildContextUsage(
  budget: ContextBudget,
  userMemoryStore: UserMemoryStore | null | undefined,
): ContextUsage {
  const memoryChars = userMemoryStore
    ? userMemoryStore.preferences.reduce((sum, pref) => sum + pref.value.length, 0)
    : 0
  const retrievalChars = budget.indexBudget
  const graphChars =
    budget.activeEntitiesBudget.rank0Floor
    + budget.activeEntitiesBudget.rank1CompressibleCap
    + budget.activeEntitiesBudget.rank2CompressibleCap
  const bodyChars = budget.pageBudget
  const otherChars = Math.max(
    0,
    budget.maxCtx - (memoryChars + retrievalChars + graphChars + bodyChars + budget.responseReserve),
  )
  return { memoryChars, retrievalChars, graphChars, bodyChars, otherChars, maxCtx: budget.maxCtx }
}

/**
 * Compute ring segments (fractions of maxCtx) for the SVG ring.
 * Pure — the component only renders what this returns.
 */
export function computeRingSegments(usage: ContextUsage): RingSegment[] {
  const entries: Array<[RingSegment["key"], number]> = [
    ["memory", usage.memoryChars],
    ["retrieval", usage.retrievalChars],
    ["graph", usage.graphChars],
    ["body", usage.bodyChars],
    ["other", usage.otherChars],
  ]
  const total = Math.max(1, usage.maxCtx)
  return entries.map(([key, chars]) => ({
    key,
    label: SEGMENT_LABELS[key],
    chars,
    fraction: Math.min(1, chars / total),
  }))
}
