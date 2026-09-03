/**
 * 51 号报告 G2: 声纹对齐闭环（双向测量 + 收敛判定）.
 *
 * 语义: 在改写（去 AI 化 / 风格回归 / 判官池重写）前后做「双向」声纹测量，
 * 判定改写是否同时满足两个约束：
 *   1. 对齐作者基线（driftVsBaseline ≤ threshold）——风格不漂移；
 *   2. 保留改写前语义（driftVsBefore ≤ threshold）——不过度改写。
 * 未收敛 → 反馈 revision（再改一轮）或转人工（iteration 超限）。
 *
 * 纯函数、零 LLM 零 IO（守 ADR-19/29）——复用 author-fingerprint 抽取 + drift，
 * 不触碰既有改写链路行为（additive）。
 */

import {
  extractAuthorFingerprint,
  fingerprintDrift,
  type AuthorFingerprint,
} from "./adversarial/author-fingerprint"

export type VoiceprintRecommendation = "accept" | "revise" | "manual"

export interface VoiceprintConvergenceInput {
  /** 作者风格基线（原笔指纹）。 */
  baseline: AuthorFingerprint
  /** 改写前文本。 */
  beforeRewrite: string
  /** 改写后文本。 */
  afterRewrite: string
  /** 收敛阈值（归一化偏差，默认 0.3——7 团队共识阈值）。 */
  threshold?: number
  /** 已尝试 revision 轮数（≥ maxIterations 转 manual）。 */
  iteration?: number
  /** 最大 revision 轮数（默认 3）。 */
  maxIterations?: number
}

export interface VoiceprintConvergenceResult {
  /** 是否收敛（双向 drift 均 ≤ threshold）。 */
  converged: boolean
  /** 改写后 vs 基线 偏差（风格漂移度）。 */
  driftVsBaseline: number
  /** 改写后 vs 改写前 偏差（语义/内容变动度）。 */
  driftVsBefore: number
  /** 建议：accept（收敛）/ revise（未收敛且未超限）/ manual（超限转人工）。 */
  recommendation: VoiceprintRecommendation
  /** 判定理由。 */
  rationale: string[]
}

/** 默认收敛阈值（与 fingerprintDrift 告警阈值一致，7 团队共识）。 */
export const DEFAULT_VOICEPRINT_THRESHOLD = 0.3

/** 默认最大 revision 轮数。 */
export const DEFAULT_MAX_ITERATIONS = 3

/**
 * 双向声纹收敛判定（纯函数）.
 *
 * 流程:
 *   1. 抽取改写前/后声纹；
 *   2. 计算 driftVsBaseline（after vs baseline）+ driftVsBefore（after vs before）；
 *   3. converged = 两者均 ≤ threshold；
 *   4. recommendation = converged ? accept : (iteration ≥ max ? manual : revise)。
 *
 * 边界: beforeRewrite === afterRewrite → driftVsBefore=0，仅判 baseline 对齐。
 *       空文本抽取 sampleSize=0 → fingerprintDrift 返回 0（不触发）。
 */
export function checkVoiceprintConvergence(
  input: VoiceprintConvergenceInput,
): VoiceprintConvergenceResult {
  const {
    baseline,
    beforeRewrite,
    afterRewrite,
    threshold = DEFAULT_VOICEPRINT_THRESHOLD,
    iteration = 0,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = input

  const beforeFp = extractAuthorFingerprint(beforeRewrite)
  const afterFp = extractAuthorFingerprint(afterRewrite)

  const driftVsBaseline = fingerprintDrift(afterFp, baseline)
  const driftVsBefore = fingerprintDrift(afterFp, beforeFp)

  const rationale: string[] = []
  const styleOk = driftVsBaseline <= threshold
  const contentOk = driftVsBefore <= threshold

  if (!styleOk) {
    rationale.push(`改写后声纹偏离作者基线 ${driftVsBaseline.toFixed(3)} > ${threshold}（风格漂移）。`)
  }
  if (!contentOk) {
    rationale.push(`改写后声纹偏离改写前 ${driftVsBefore.toFixed(3)} > ${threshold}（过度改写）。`)
  }
  if (styleOk && contentOk) {
    rationale.push(
      `改写后声纹双向收敛：driftVsBaseline=${driftVsBaseline.toFixed(3)}、driftVsBefore=${driftVsBefore.toFixed(3)} 均 ≤ ${threshold}。`,
    )
  }

  const converged = styleOk && contentOk
  let recommendation: VoiceprintRecommendation
  if (converged) {
    recommendation = "accept"
  } else if (iteration >= maxIterations) {
    recommendation = "manual"
    rationale.push(`已达最大 revision 轮数 ${maxIterations}（当前第 ${iteration} 轮），转人工。`)
  } else {
    recommendation = "revise"
    rationale.push(`未收敛且未超限（第 ${iteration} 轮），反馈 revision 再改一轮。`)
  }

  return { converged, driftVsBaseline, driftVsBefore, recommendation, rationale }
}
