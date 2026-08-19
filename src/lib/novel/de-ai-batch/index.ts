/**
 * Wave 4 (v2.5.0): 批量去AI味 — canonical 公共出口。
 * 主链消费方（UI / 测试）只从本文件导入，不直接读内部模块。
 */

export {
  DE_AI_BATCH_SCHEMA,
  DE_AI_BATCH_DEFAULT_CONCURRENCY,
  DE_AI_BATCH_MIN_CONCURRENCY,
  DE_AI_BATCH_MAX_CONCURRENCY,
  DE_AI_BATCH_MAX_RETRIES,
  DE_AI_BATCH_BACKOFF_BASE_MS,
  DE_AI_BATCH_BACKOFF_CAP_MS,
  DE_AI_BATCH_JITTER,
  type DeAiBatchPhase,
  type DeAiChapterStatus,
  type DeAiChapterState,
  type DeAiBatchState,
  type DeAiBatchProgress,
  type ChapterFailure,
  type DeAiBatchSummary,
  type DeAiBatchOptions,
  type DeAiBatchDraftArtifact,
} from "./types"
export {
  createSemaphore,
  runWithBackoff,
  runBatch,
  backoffDelayMs,
  isTransientLlmError,
  type Semaphore,
  type BackoffOptions,
  type RunBatchOptions,
} from "./concurrency"
export {
  deAiBatchDraftsDirPath,
  deAiBatchDraftPath,
  saveDeAiBatchDraft,
  loadDeAiBatchDraft,
  deleteDeAiBatchDraft,
} from "./drafts"
export {
  loadDeAiBatchState,
  saveDeAiBatchState,
  createDeAiBatchState,
  deriveRemainingQueue,
  resumeDeAiBatchState,
} from "./resume"
export {
  runDeAiBatch,
  acceptAllDeAiBatchDrafts,
  acceptDeAiBatchDraft,
  rejectDeAiBatchDraft,
  discardDeAiBatch,
} from "./scheduler"
