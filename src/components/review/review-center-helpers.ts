/**
 * review-center-helpers.ts — 审查中心视图的纯函数（零 IO）。
 *
 * @license MIT © Niko Buddy
 */

import type { ReviewRunState } from "@/stores/wiki-store-config"

/** 审稿结束后的完成提示；null = 不显示（未跑、进行中、出错或完成门未通过）。 */
export interface ReviewRunDoneSummary {
  /** 本次结果里的问题条数（六维逐维 issues 合计；旧单遍审查用 results）。 */
  readonly count: number
}

/**
 * 六维审查把结果写在 dimensionResults，results 恒为空数组；
 * 只看 results.length 会让六维审稿永远没有完成提示。
 * gateStatus 为 incomplete / suspect 时不宣称完成。
 */
export function summarizeReviewRunDone(
  run: Pick<ReviewRunState, "running" | "error" | "results" | "dimensionResults" | "gateStatus"> | null | undefined,
  runError: string,
): ReviewRunDoneSummary | null {
  if (!run || run.running || runError) return null
  if (run.gateStatus === "incomplete" || run.gateStatus === "suspect") return null
  const dims = Object.values(run.dimensionResults ?? {})
  if (dims.length > 0) {
    return { count: dims.reduce((sum, dim) => sum + (dim?.issues?.length ?? 0), 0) }
  }
  const legacy = run.results ?? []
  return { count: legacy.length }
}
