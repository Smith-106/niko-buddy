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
 * Resolve max chars for review windows.
 * - env `REVIEW_CHAPTER_MAX_CHARS` if valid positive int
 * - else DEFAULT_REVIEW_CHAPTER_MAX_CHARS
 * Clamped to [2000, 200000].
 */
export function resolveReviewChapterMaxChars(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
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
  env: NodeJS.ProcessEnv = process.env,
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
