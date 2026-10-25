/**
 * ISS-20260709-009：start-review-run / six-dimension-review 孪生公共 runner。
 *
 * 收敛前两文件逐字重复：
 * - 空输入守卫 `if (!selectedFile || !fileContent.trim()) return`
 * - DI 三行回退 `setReviewRun/finishReviewRun/getReviewRun`
 * - `runId = Date.now()-random` 生成
 * - `catch { logger.error(message-only) + finishReviewRun(failed) }`
 * - `finally { if (current?.runId === runId) finishReviewRun(running:false) }`
 *
 * 本模块为唯一真源；差异点（reviewChapter+gate+thinkingPublisher vs
 * AbortController+advanceReviewJob+preflight+runSixDimensionReview）保留在各自调用方。
 * 语义零变更。
 *
 * MIT License — independently implemented.
 */
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"

export interface ReviewRunStoreActions {
  setReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "setReviewRun">["setReviewRun"]
  finishReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "finishReviewRun">["finishReviewRun"]
  getReviewRun: () => ReturnType<typeof useWikiStore.getState>["reviewRun"]
}

/** DI 三行回退收敛：注入优先，缺省回退 useWikiStore（向后兼容）。 */
export function resolveReviewRunActions(storeActions?: ReviewRunStoreActions): ReviewRunStoreActions {
  return {
    setReviewRun: storeActions?.setReviewRun ?? ((r) => useWikiStore.getState().setReviewRun(r)),
    finishReviewRun:
      storeActions?.finishReviewRun ?? ((id, r) => useWikiStore.getState().finishReviewRun(id, r)),
    getReviewRun: storeActions?.getReviewRun ?? (() => useWikiStore.getState().reviewRun),
  }
}

/** 空输入守卫收敛：与两调用方原 `if (!selectedFile || !fileContent.trim()) return` 等价。 */
export function isEmptyReviewInput(selectedFile: string, fileContent: string): boolean {
  return !selectedFile || !fileContent.trim()
}

/** runId 生成收敛：`Date.now()-random` 保持原格式（调用方日志/比对依赖）。 */
export function newReviewRunId(): string {
  return `${Date.now()}-${Math.random()}`
}

/** finally 收口收敛：仅当 current 仍是本 run 才标记 running:false（防跨 run 覆盖）。 */
export function finishCurrentReviewRunIfOwned(
  getReviewRun: ReviewRunStoreActions["getReviewRun"],
  finishReviewRun: ReviewRunStoreActions["finishReviewRun"],
  runId: string,
  patch: Parameters<ReviewRunStoreActions["finishReviewRun"]>[1],
): void {
  const current = getReviewRun()
  if (current?.runId === runId) {
    finishReviewRun(runId, patch)
  }
}

/** catch 收敛：message-only 日志（F-16 防泄漏）+ 统一失败态。 */
export function failReviewRun(
  scope: string,
  message: string,
  error: unknown,
  finishReviewRun: ReviewRunStoreActions["finishReviewRun"],
  runId: string,
  failedMessage: string,
): void {
  logger.error(scope, message, { error: toErrorMessage(error) })
  finishReviewRun(runId, { running: false, error: failedMessage })
}
