/**
 * Wave B — minimal write / review split timeline (StoryForge-inspired).
 *
 * Write path should not wait on full six-dim literary review. Track A
 * mechanical continuity remains available; Track B six-dim can run as
 * background job state on status.json (additive fields only).
 *
 * Does NOT start workers by itself — callers schedule review and call
 * markReviewJob*. Never a second session file; never thril hard gate.
 */
export const WRITE_REVIEW_SPLIT_SCHEMA = "write-review-split/1.0" as const

export type ReviewJobPhase = "idle" | "queued" | "running" | "done" | "failed"

export interface ReviewJobState {
  schemaVersion: typeof WRITE_REVIEW_SPLIT_SCHEMA
  phase: ReviewJobPhase
  /** ISO timestamp when write draft became ready for optional review. */
  writeReadyAt?: string
  /** ISO when review was queued (split from write). */
  reviewQueuedAt?: string
  reviewStartedAt?: string
  reviewFinishedAt?: string
  chapterNumber?: number
  note?: string
  /** Six-dim / literary review must not block accept of draft. */
  blocksWrite: false
  productHardGate: false
}

export function createIdleReviewJob(): ReviewJobState {
  return {
    schemaVersion: WRITE_REVIEW_SPLIT_SCHEMA,
    phase: "idle",
    blocksWrite: false,
    productHardGate: false,
  }
}

/** Call when draft generation finishes — write timeline ready. */
export function markWriteReady(
  job: ReviewJobState | null | undefined,
  chapterNumber?: number,
): ReviewJobState {
  const base = job ?? createIdleReviewJob()
  return {
    ...base,
    schemaVersion: WRITE_REVIEW_SPLIT_SCHEMA,
    phase: base.phase === "running" || base.phase === "queued" ? base.phase : "idle",
    writeReadyAt: new Date().toISOString(),
    chapterNumber: chapterNumber ?? base.chapterNumber,
    blocksWrite: false,
    productHardGate: false,
    note: "write ready; review may run async",
  }
}

/** Queue background review without blocking write/accept. */
export function markReviewQueued(
  job: ReviewJobState | null | undefined,
  chapterNumber?: number,
): ReviewJobState {
  const base = job ?? createIdleReviewJob()
  return {
    ...base,
    schemaVersion: WRITE_REVIEW_SPLIT_SCHEMA,
    phase: "queued",
    reviewQueuedAt: new Date().toISOString(),
    writeReadyAt: base.writeReadyAt ?? new Date().toISOString(),
    chapterNumber: chapterNumber ?? base.chapterNumber,
    blocksWrite: false,
    productHardGate: false,
    note: "review queued (split timeline)",
  }
}

export function markReviewRunning(job: ReviewJobState | null | undefined): ReviewJobState {
  const base = job ?? createIdleReviewJob()
  return {
    ...base,
    phase: "running",
    reviewStartedAt: new Date().toISOString(),
    blocksWrite: false,
    productHardGate: false,
  }
}

export function markReviewDone(
  job: ReviewJobState | null | undefined,
  note?: string,
): ReviewJobState {
  const base = job ?? createIdleReviewJob()
  return {
    ...base,
    phase: "done",
    reviewFinishedAt: new Date().toISOString(),
    blocksWrite: false,
    productHardGate: false,
    note: note ?? "review done (non-blocking)",
  }
}

export function markReviewFailed(
  job: ReviewJobState | null | undefined,
  note?: string,
): ReviewJobState {
  const base = job ?? createIdleReviewJob()
  return {
    ...base,
    phase: "failed",
    reviewFinishedAt: new Date().toISOString(),
    blocksWrite: false,
    productHardGate: false,
    note: note ?? "review failed (write still unblocked)",
  }
}

/** True if write/accept should proceed regardless of review phase. */
export function isWriteUnblockedByReview(job: ReviewJobState | null | undefined): boolean {
  // Contract: always true for this minimal split — review never blocks write.
  void job
  return true
}

export function formatReviewJobLine(job: ReviewJobState): string {
  return [
    `write-review-split: phase=${job.phase}`,
    job.chapterNumber != null ? `ch=${job.chapterNumber}` : "",
    job.writeReadyAt ? `writeReady=${job.writeReadyAt}` : "",
    job.reviewQueuedAt ? `queued=${job.reviewQueuedAt}` : "",
    "blocksWrite=false",
    "not product hard gate",
  ]
    .filter(Boolean)
    .join(" | ")
}
