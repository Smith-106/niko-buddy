/**
 * Chapter text windowing for LLM review prompts.
 *
 * Hard prefix-only truncation (historical `slice(0, 8000)`) drops chapter
 * endings — pull dimension checks ("结尾是否停在高张力…") become unobservable
 * (team-swarm H4 / expand-measure-window). Prefer head+tail so both opening
 * and ending stay in the measured window when the chapter exceeds the budget.
 */

/** Default max characters sent to review LLMs (env REVIEW_CHAPTER_MAX_CHARS overrides). */
export const DEFAULT_REVIEW_CHAPTER_MAX_CHARS = 16_000

/** Separator inserted when middle content is omitted (must be unique-ish for tests). */
export const CHAPTER_WINDOW_OMISSION_MARK =
  "\n\n…[中间正文已省略，保留章首与章末供审查]…\n\n"

/**
 * Browser-safe default env.
 *
 * 写成裸 `process.env` 作默认参数会在 WebView 里直接抛
 * `ReferenceError: process is not defined`——默认参数在**调用时**求值，而应用里没有
 * `process` 全局。深章管线的评审阶段正是无参调用这两个函数，于是整条管线在
 * `after_task_brief` 之后崩掉（真机 e2e 实测报错原文就是 `process is not defined`）。
 *
 * 所以默认值必须自己先探存在性；Node（测试/脚本）仍拿到真实 env，行为不变。
 */
function defaultEnv(): NodeJS.ProcessEnv {
  return typeof process !== "undefined" && process.env ? process.env : ({} as NodeJS.ProcessEnv)
}

/**
 * Resolve max chars for review windows.
 * - env `REVIEW_CHAPTER_MAX_CHARS` if valid positive int
 * - else DEFAULT_REVIEW_CHAPTER_MAX_CHARS
 * Clamped to [2000, 200000].
 */
export function resolveReviewChapterMaxChars(
  override?: number,
  env: NodeJS.ProcessEnv = defaultEnv(),
): number {
  // Explicit override: allow small values for unit tests; only clamp upper bound.
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.min(200_000, Math.floor(override))
  }
  const raw = env.REVIEW_CHAPTER_MAX_CHARS
  if (raw != null && raw !== "") {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) {
      // Env path keeps a production floor so misconfig cannot collapse the window.
      return Math.min(200_000, Math.max(2_000, n))
    }
  }
  return DEFAULT_REVIEW_CHAPTER_MAX_CHARS
}

/**
 * Slice chapter content for review prompts.
 * - If `content.length <= maxChars`: return as-is.
 * - Else: keep head + tail (equal split of remaining budget after omission mark),
 *   so chapter-end hooks remain observable for pull / continuity checks.
 */
export function sliceChapterForReview(
  content: string,
  maxChars?: number,
  env: NodeJS.ProcessEnv = defaultEnv(),
): string {
  const max = resolveReviewChapterMaxChars(maxChars, env)
  if (content.length <= max) return content

  const mark = CHAPTER_WINDOW_OMISSION_MARK
  const budget = max - mark.length
  if (budget < 2) {
    // Degenerate: fall back to pure head truncate.
    return content.slice(0, max)
  }
  const headLen = Math.floor(budget / 2)
  const tailLen = budget - headLen
  return content.slice(0, headLen) + mark + content.slice(content.length - tailLen)
}
