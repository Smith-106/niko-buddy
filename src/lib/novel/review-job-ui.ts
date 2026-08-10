/**
 * S4 — review_job UI model (presentation only).
 * Never blocks write/accept; productHardGate always false.
 */
import {
  formatReviewJobLine,
  isWriteUnblockedByReview,
  type ReviewJobPhase,
  type ReviewJobState,
} from "./write-review-split"

export interface ReviewJobUiModel {
  phase: ReviewJobPhase
  chapterNumber?: number
  writeReadyAt?: string
  reviewQueuedAt?: string
  reviewStartedAt?: string
  reviewFinishedAt?: string
  note?: string
  /** Human-readable one-liner for chat/status strip. */
  statusLine: string
  /** Short zh/en-neutral label for phase chip. */
  phaseLabel: string
  writeUnblocked: true
  productHardGate: false
  blocksWrite: false
}

const PHASE_LABEL: Record<ReviewJobPhase, string> = {
  idle: "review:idle",
  queued: "review:queued",
  running: "review:running",
  done: "review:done",
  failed: "review:failed",
}

export function getReviewJobUiModel(job: ReviewJobState | null | undefined): ReviewJobUiModel | null {
  if (!job) return null
  return {
    phase: job.phase,
    chapterNumber: job.chapterNumber,
    writeReadyAt: job.writeReadyAt,
    reviewQueuedAt: job.reviewQueuedAt,
    reviewStartedAt: job.reviewStartedAt,
    reviewFinishedAt: job.reviewFinishedAt,
    note: job.note,
    statusLine: formatReviewJobLine(job),
    phaseLabel: PHASE_LABEL[job.phase],
    writeUnblocked: true,
    productHardGate: false,
    blocksWrite: false,
  }
}

/** Convenience for status strip / toast. */
export function formatReviewJobStatusLine(job: ReviewJobState | null | undefined): string {
  const m = getReviewJobUiModel(job)
  if (!m) return "write-review-split: (no review_job)"
  void isWriteUnblockedByReview(job)
  return m.statusLine
}
