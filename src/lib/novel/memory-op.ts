/**
 * Wave B — Mem0-style memory write-back ops over TemporalFact[] (VIEW).
 *
 * ADD / UPDATE / DELETE / NOOP. Does not own persistence (ANL-013 C4):
 * callers pass the live facts array; DELETE = invalidate (validUntil), not remove.
 * Product hard gates never come from op outcomes.
 */
import {
  invalidateFact,
  type TemporalFact,
} from "./temporal-memory"

export const MEMORY_OP_SCHEMA = "memory-op/1.0" as const

export type MemoryOpKind = "ADD" | "UPDATE" | "DELETE" | "NOOP"

/**
 * L1 atom kinds (Tencent L1-inspired classification over TemporalFact VIEW).
 * Soft taxonomy only — does not create a second store; productHardGate never true.
 */
export const MEMORY_ATOM_KINDS = [
  "constraint",
  "preference",
  "event",
  "setting",
  "relationship",
  "inventory",
  "state",
  "other",
] as const

export type MemoryAtomKind = (typeof MEMORY_ATOM_KINDS)[number]

export interface MemoryOp {
  kind: MemoryOpKind
  /** Target fact id (UPDATE/DELETE); optional for ADD (auto-id if missing). */
  factId?: string
  /** Payload for ADD/UPDATE. */
  fact?: Partial<TemporalFact> & Pick<TemporalFact, "subject" | "predicate" | "object" | "validFrom" | "source">
  /** L1 atom classification (optional; set by planAddOpsFromCanonFacts). */
  atomKind?: MemoryAtomKind
  note?: string
  /** Chapter clock for DELETE invalidate. */
  atChapter?: number
}

/** Heuristic classify free-text / colon-split canon lines into L1 atom kinds. */
export function classifyMemoryAtomKind(text: string, subject?: string, object?: string): MemoryAtomKind {
  const blob = `${subject ?? ""} ${object ?? ""} ${text}`.toLowerCase()
  if (/禁止|不得|必须|约束|规则|禁忌|不可|不准|不得违背/.test(blob)) return "constraint"
  if (/偏好|习惯|喜欢|讨厌|倾向|风格偏好/.test(blob)) return "preference"
  if (/发生|事件|战斗|抵达|离开|死亡|婚|相遇|决战|爆发/.test(blob)) return "event"
  if (/设定|世界观|法则|体系|地图|时代|规则设定/.test(blob)) return "setting"
  if (/关系|盟友|敌对|师徒|情侣|父子|母女|从属/.test(blob)) return "relationship"
  if (/持有|获得|失去|装备|物品|戒指|武器|道具/.test(blob)) return "inventory"
  if (/状态|受伤|昏迷|觉醒|等级|境界|情绪/.test(blob)) return "state"
  return "other"
}

export interface MemoryOpResult {
  schemaVersion: typeof MEMORY_OP_SCHEMA
  kind: MemoryOpKind
  ok: boolean
  factId?: string
  note?: string
  productHardGate: false
}

/**
 * Apply a single memory op to facts (mutates array for ADD/UPDATE/DELETE).
 */
export function applyMemoryOp(facts: TemporalFact[], op: MemoryOp): MemoryOpResult {
  const base = {
    schemaVersion: MEMORY_OP_SCHEMA,
    kind: op.kind,
    productHardGate: false as const,
  }

  switch (op.kind) {
    case "NOOP":
      return { ...base, ok: true, note: op.note ?? "noop" }

    case "ADD": {
      if (!op.fact) {
        return { ...base, ok: false, note: "ADD requires fact payload" }
      }
      const id =
        op.factId ??
        op.fact.id ??
        `mem-add-${op.fact.validFrom}-${facts.length}-${Date.now().toString(36)}`
      const next: TemporalFact = {
        id,
        subject: op.fact.subject,
        predicate: op.fact.predicate,
        object: op.fact.object,
        validFrom: op.fact.validFrom,
        source: op.fact.source,
        validUntil: op.fact.validUntil,
        supersedes: op.fact.supersedes,
        confidence: op.fact.confidence,
      }
      if (facts.some((f) => f.id === id)) {
        return { ...base, ok: false, factId: id, note: "ADD id already exists — use UPDATE" }
      }
      facts.push(next)
      return { ...base, ok: true, factId: id, note: op.note }
    }

    case "UPDATE": {
      const id = op.factId
      if (!id) return { ...base, ok: false, note: "UPDATE requires factId" }
      const existing = facts.find((f) => f.id === id)
      if (!existing) return { ...base, ok: false, factId: id, note: "UPDATE target missing" }
      if (op.fact) {
        if (op.fact.subject !== undefined) existing.subject = op.fact.subject
        if (op.fact.predicate !== undefined) existing.predicate = op.fact.predicate
        if (op.fact.object !== undefined) existing.object = op.fact.object
        if (op.fact.source !== undefined) existing.source = op.fact.source
        if (op.fact.confidence !== undefined) existing.confidence = op.fact.confidence
        // validFrom only narrows if explicitly provided and greater? keep additive: allow object/predicate edits only for safety
      }
      return { ...base, ok: true, factId: id, note: op.note }
    }

    case "DELETE": {
      const id = op.factId
      if (!id) return { ...base, ok: false, note: "DELETE requires factId" }
      const at = op.atChapter ?? op.fact?.validFrom ?? 0
      const r = invalidateFact(facts, id, at, op.note)
      return { ...base, ok: r.ok, factId: id, note: r.note ?? op.note ?? "invalidated" }
    }

    default: {
      const _exhaustive: never = op.kind
      return { ...base, ok: false, note: `unknown kind ${_exhaustive}` }
    }
  }
}

/** Apply a batch; returns per-op results. Stops nothing on failure (best-effort). */
export function applyMemoryOps(facts: TemporalFact[], ops: readonly MemoryOp[]): MemoryOpResult[] {
  return ops.map((op) => applyMemoryOp(facts, op))
}

/**
 * Plan ADD ops from snapshot newCanonFacts (ingest post-commit helper).
 * Pure: does not apply; caller applies after review.
 */
export function planAddOpsFromCanonFacts(
  chapterNumber: number,
  newCanonFacts: readonly string[],
  source = `chapter-${chapterNumber}`,
): MemoryOp[] {
  return (newCanonFacts ?? []).map((raw, idx) => {
    const text = String(raw ?? "").trim()
    // "subject：object" or "subject: object" or free text → bag as object under generic predicate
    const m = text.match(/^(.+?)[：:]\s*(.+)$/)
    const subject = m ? m[1]!.trim() : "canon"
    const object = m ? m[2]!.trim() : text
    const atomKind = classifyMemoryAtomKind(text, subject, object)
    return {
      kind: "ADD" as const,
      factId: `fact-ch${chapterNumber}-mem-${idx}`,
      atomKind,
      note: `L1 atomKind=${atomKind}`,
      fact: {
        id: `fact-ch${chapterNumber}-mem-${idx}`,
        subject,
        predicate: atomKind === "other" ? "陈述" : atomKind,
        object,
        validFrom: chapterNumber,
        source,
      },
    }
  })
}
