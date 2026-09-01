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
import type {
  DimensionReviewResult,
  SixReviewDimensionKey,
} from "./dimension-review-adapter"

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

/**
 * G2 (39 号修复): UI 六维审查完成时把 dimensionResults 一并落 status.json。
 * 与 advanceReviewJobDone 同形, 额外合并写 status.dimension_results (additive
 * 字段, 与 deep-chapter fold 的 checkpoint 写入路径同源同字段), 修复 inspector
 * (queryInspectorState → getCachedDimensionResults) 读不到 UI 运行结果的断点。
 * 合并而非覆盖: 保留其他章节/维度已有结果。
 */
export async function advanceReviewJobDoneWithDimensionResults(
  projectPath: string,
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>,
  note?: string,
): Promise<ReviewJobState | null> {
  const status = await loadNovelSessionStatus(projectPath)
  if (!status) return null
  const nextJob = markReviewDone(status.review_job, note)
  await saveNovelSessionStatus(projectPath, {
    ...status,
    review_job: nextJob,
    dimension_results: {
      ...(status.dimension_results ?? {}),
      ...dimensionResults,
    },
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
