import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * F-002 (S3 / ANL-010): ProjectionStatusLedger — records the per-projection
 * commit/rebuild status of each derived projection so a mid-ingest failure is
 * VISIBLE and recoverable instead of silent.
 *
 * Replaces the 8-segment independent try/catch in chapter-ingest.ts (each
 * segment swallowed failures with only a console.warn, so a corrupted
 * projection was undetectable until a downstream consumer broke). Under
 * commit-then-project (approach b — the ONLY viable path since LanceDB has
 * no transaction API, ANL-010 C4), the commit point (saveSnapshot +
 * saveChapterIngestOutput) is per-file-atomic; the post-commit projections
 * are derived and tracked here per the C-002 mixed_per_projection model.
 *
 * Three categories (C-002):
 *   - single_snapshot_idempotent: vector / snapshot / chapter_ingest_output
 *     — re-running with the same snapshot yields the same state; safe to retry.
 *   - fold_rebuildable: cognition / character / foreshadow /
 *     summary_structured_memory — deterministically re-derivable from the
 *     committed snapshot sequence via rebuildFromCommittedSnapshot.
 *   - mutates_existing_non_rebuildable: graph_entity_pages (mutates existing
 *     pages; rebuild = delete+re-fold via cleanupSupersededEntityFiles) /
 *     community_summary (LLM-derived, non-deterministic; re-extract on failure).
 */

export type ProjectionCategory =
  | "single_snapshot_idempotent"
  | "fold_rebuildable"
  | "mutates_existing_non_rebuildable"

export type ProjectionStatus = "pending" | "committed" | "failed"

export interface ProjectionStatusEntry {
  /** The projection name (vector / cognition / character / foreshadow / graph / ...). */
  projection: string
  /** C-002 category — drives the recovery strategy on failure. */
  category: ProjectionCategory
  /** Last-known status for this projection + chapter. */
  status: ProjectionStatus
  /** ISO timestamp of the last status update. */
  updated_at: string
  /** Error message when status === "failed"; empty otherwise. */
  last_error: string
}

// ============================================================================
// F-005 (v2.6 Tier2): append-only audit trail.
//
// ProjectionStatusEntry above is a LAST-KNOWN-STATUS cell — re-running a
// projection overwrites it, so the history of intermediate failures during a
// single ingest (e.g. graph failed then succeeded on retry) is lost. The
// auditTrail below is an APPEND-ONLY event log recorded alongside it: one
// entry per projection commit/rebuild event, persisted per-event so a hard
// crash mid-ingest still leaves the already-emitted events on disk (mid-ingest
// forensics; the last-known-status cells are only saved in the loop's finally).
//
// ADR-16 boundary: auditTrail lives INSIDE the existing projection-status.json
// as an additive field — NOT a second session-state file. The RMW writer
// preserves every unknown top-level field, and readers of the ledger shape
// ({projections, chapters}) ignore the extra key.
// Growth note (OQ-3): the trail grows unbounded (~12 events/chapter); a
// rolling-window policy is deferred past v2.6 baseline.
// ============================================================================

/** Outcome of one audited projection event. "rebuild" = scheduled rebuild succeeded (community_summary); failures are always "failed" + error. */
export type ProjectionAuditStatus = "committed" | "rebuild" | "failed"

export interface ProjectionAuditEntry {
  /** The projection name (same keys as PROJECTION_CATEGORIES). */
  projection: string
  /** Chapter number the event belongs to (>0 — frontmatter-validated upstream). */
  chapter: number
  /** Event outcome: committed / rebuild / failed. */
  status: ProjectionAuditStatus
  /** Wall-clock duration of the projection body in ms. */
  durationMs: number
  /** Error message when status === "failed"; omitted otherwise. */
  error?: string
  /** ISO timestamp of when the event finished. */
  timestamp: string
}

export interface ProjectionStatusLedger {
  /** Static category mapping per C-002 mixed_per_projection. */
  projections: Record<string, ProjectionCategory>
  /** Per-chapter projection status: chapters[chapterNumber][projection] = entry. */
  chapters: Record<string, Record<string, ProjectionStatusEntry>>
  /** F-005: append-only audit history; additive optional field (older files lack it). */
  auditTrail?: ProjectionAuditEntry[]
}

/**
 * The canonical C-002 category mapping. Single source of truth —
 * chapter-ingest.ts and rebuildFromCommittedSnapshot both consult this to
 * decide the recovery strategy for a failed projection.
 */
export const PROJECTION_CATEGORIES: Record<string, ProjectionCategory> = {
  vector: "single_snapshot_idempotent",
  snapshot: "single_snapshot_idempotent",
  chapter_ingest_output: "single_snapshot_idempotent",
  cognition: "fold_rebuildable",
  character: "fold_rebuildable",
  foreshadow: "fold_rebuildable",
  summary_structured_memory: "fold_rebuildable",
  // R4 (S4 / ANL-013): 3 new structured-field projections — same-layer
  // siblings of character/foreshadow (NOT a Truth Files module; ANL-013 C4).
  // emotional_arc / resource_ledger are fold_rebuildable: re-derivable from
  // the committed snapshot sequence (characterDetails.arcChange /
  // itemDetails.holder). subplot_board is currently single_snapshot_idempotent:
  // chapter-ingest commits an empty store (no snapshot subplot field wired yet
  // — LLM-extract extension out of scope). Re-classify to fold_rebuildable when
  // a snapshot subplot field is added.
  emotional_arc: "fold_rebuildable",
  subplot_board: "single_snapshot_idempotent",
  resource_ledger: "fold_rebuildable",
  graph_entity_pages: "mutates_existing_non_rebuildable",
  // CORR-009: distinct key for the wiki-patch-field write path (was shared
  // with graph_entity_pages, masking partial failures). Same category.
  graph_entity_patch_fields: "mutates_existing_non_rebuildable",
  // CORR-007: syncSnapshotToMemory (structured-memory sync) — runs the
  // snapshot→memory write. Treated as fold_rebuildable (re-derivable from
  // committed snapshots via rebuildFromCommittedSnapshot).
  sync_snapshot_to_memory: "fold_rebuildable",
  community_summary: "mutates_existing_non_rebuildable",
}

export function emptyLedger(): ProjectionStatusLedger {
  return {
    projections: { ...PROJECTION_CATEGORIES },
    chapters: {},
    // F-005: initial state — an empty (present, not undefined) trail so
    // consumers can rely on array semantics after any load/empty path.
    auditTrail: [],
  }
}

function ledgerPath(projectPath: string): string {
  const pp = normalizePath(projectPath)
  return `${pp}/.novel/projection-status.json`
}

export async function loadProjectionStatusLedger(projectPath: string): Promise<ProjectionStatusLedger> {
  try {
    const raw = await readFile(ledgerPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<ProjectionStatusLedger>
    if (!parsed || typeof parsed !== "object" || !parsed.chapters) {
      return emptyLedger()
    }
    // Merge with canonical categories so new projections added in code are
    // reflected even in ledgers written by older versions.
    return {
      projections: { ...PROJECTION_CATEGORIES, ...(parsed.projections ?? {}) },
      chapters: parsed.chapters,
      // F-005: preserve the append-only trail across loads (legacy files → []).
      auditTrail: Array.isArray(parsed.auditTrail) ? parsed.auditTrail : [],
    }
  } catch {
    return emptyLedger()
  }
}

export async function saveProjectionStatusLedger(
  projectPath: string,
  ledger: ProjectionStatusLedger,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.novel`)
  // F-002: atomic write (fs.rs:1190 temp+fsync+rename) — the ledger itself
  // must not be corrupted by a crash mid-write, or it would defeat its
  // purpose of making projection failures visible.
  await writeFileAtomic(ledgerPath(projectPath), JSON.stringify(ledger, null, 2))
}

/**
 * F-005: append one audit event to the in-memory ledger's trail (pure).
 * Pairs with appendProjectionAuditEntry — the in-memory copy must stay in sync
 * so the end-of-loop saveProjectionStatusLedger cannot clobber the per-event
 * durable flushes back off disk.
 */
export function recordProjectionAudit(
  ledger: ProjectionStatusLedger,
  entry: ProjectionAuditEntry,
): ProjectionStatusLedger {
  return { ...ledger, auditTrail: [...(ledger.auditTrail ?? []), entry] }
}

/**
 * F-005: durably append one audit event to projection-status.json.
 *
 * Read-modify-write that spreads ALL existing top-level fields through
 * (projections / chapters / version / anything else) and only replaces the
 * auditTrail array — strictly additive, never drops legacy or unknown fields.
 * Tolerant of missing/corrupt files (starts a fresh document). Callers treat
 * failure as non-fatal: audit must never break the projection loop.
 */
export async function appendProjectionAuditEntry(
  projectPath: string,
  entry: ProjectionAuditEntry,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.novel`)
  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerPath(pp)))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>
    }
  } catch {
    // Missing or corrupt file → start a fresh document; the spread below
    // keeps whatever fields were recoverable (none) without failing the caller.
  }
  const existing = Array.isArray(doc.auditTrail) ? (doc.auditTrail as ProjectionAuditEntry[]) : []
  await writeFileAtomic(ledgerPath(pp), JSON.stringify({ ...doc, auditTrail: [...existing, entry] }, null, 2))
}

/**
 * Record a projection's status for a chapter. Additive — only updates the
 * single (chapter, projection) cell; other entries are preserved.
 */
export function recordProjectionStatus(
  ledger: ProjectionStatusLedger,
  chapterNumber: number,
  projection: string,
  status: ProjectionStatus,
  lastError = "",
): ProjectionStatusLedger {
  const key = String(chapterNumber)
  const category = PROJECTION_CATEGORIES[projection] ?? "fold_rebuildable"
  const entry: ProjectionStatusEntry = {
    projection,
    category,
    status,
    updated_at: new Date().toISOString(),
    last_error: lastError,
  }
  const chapters = { ...ledger.chapters }
  const chapterEntry = { ...(chapters[key] ?? {}) }
  chapterEntry[projection] = entry
  chapters[key] = chapterEntry
  return { ...ledger, chapters }
}
