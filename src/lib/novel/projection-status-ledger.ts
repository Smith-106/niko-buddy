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

export interface ProjectionStatusLedger {
  /** Static category mapping per C-002 mixed_per_projection. */
  projections: Record<string, ProjectionCategory>
  /** Per-chapter projection status: chapters[chapterNumber][projection] = entry. */
  chapters: Record<string, Record<string, ProjectionStatusEntry>>
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
  // All fold_rebuildable: re-derivable from the committed snapshot sequence.
  emotional_arc: "fold_rebuildable",
  subplot_board: "fold_rebuildable",
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
