/**
 * U2 — advance status.review_job through six-dim / review workers.
 * Never blocks write/accept; status.json remains sole truth-source.
 */
import {
  loadNovelSessionStatus,
  saveNovelSessionStatus,
} from "./novel-session-status"
import {
  markReviewDone,
  markReviewFailed,
  markReviewRunning,
  type ReviewJobState,
} from "./write-review-split"

export async function advanceReviewJobRunning(
  projectPath: string,
  chapterNumber?: number,
): Promise<ReviewJobState | null> {
  const status = await loadNovelSessionStatus(projectPath)
  if (!status) return null
  const base = status.review_job
  const nextJob = {
    ...markReviewRunning(base),
    chapterNumber: chapterNumber ?? base?.chapterNumber,
  }
  await saveNovelSessionStatus(projectPath, {
    ...status,
    review_job: nextJob,
    updated_at: new Date().toISOString(),
  })
  return nextJob
}

export async function advanceReviewJobDone(
  projectPath: string,
  note?: string,
): Promise<ReviewJobState | null> {
  const status = await loadNovelSessionStatus(projectPath)
  if (!status) return null
  const nextJob = markReviewDone(status.review_job, note)
  await saveNovelSessionStatus(projectPath, {
    ...status,
    review_job: nextJob,
    updated_at: new Date().toISOString(),
  })
  return nextJob
}

export async function advanceReviewJobFailed(
  projectPath: string,
  note?: string,
): Promise<ReviewJobState | null> {
  const status = await loadNovelSessionStatus(projectPath)
  if (!status) return null
  const nextJob = markReviewFailed(status.review_job, note)
  await saveNovelSessionStatus(projectPath, {
    ...status,
    review_job: nextJob,
    updated_at: new Date().toISOString(),
  })
  return nextJob
}
