/**
 * style-template.ts — v2.7.3 风格模板（4 维因子一致率 + 内容保真 diff + P95 性能）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - 一致率 ≥90%（4 维风格因子达标项占比）；P95<2s/章（>5k 字分块 ≤2k/块）
 *   - 内容保真：只替换风格特征 token，内容 token 必须保留；diff 超阈值回退
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 风格模板套用
// ============================================================================

/** 一致率硬门（共识定死）。 */
export const STYLE_AGREEMENT = 0.9

/** 单章性能上限 ms（共识定死）。 */
export const STYLE_P95_MS = 2_000

/** 大章分块阈值字（共识定死）。 */
export const STYLE_CHUNK_THRESHOLD = 5_000

/** 分块大小（共识定死）。 */
export const STYLE_CHUNK_SIZE = 2_000

/** 内容保真 diff 上限（内容 token 变更占比——超限回退）。 */
export const CONTENT_FIDELITY_CAP = 0.1

/** 单章套用结果。 */
export interface StyleApplyResult {
  chapterId: string
  /** 4 维因子一致率。 */
  agreement: number
  /** 耗时 ms。 */
  durationMs: number
  /** 内容 token 变更占比（保真校验）。 */
  contentDrift: number
  /** 是否套用成功（一致率≥90% ∧ P95<2s ∧ 内容保真）。 */
  applied: boolean
}

/** 批量结果。 */
export interface StyleBatchResult {
  /** 一致率达标章占比。 */
  agreementRate: number
  /** P95 耗时 ms。 */
  p95Ms: number
  /** 内容保真失败数（回退）。 */
  fidelityFails: number
  /** 达标判定。 */
  passed: boolean
}

/** P95 计算（确定性排序分位）。 */
function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[idx]
}

/**
 * 批量套用评估（纯函数——确定性）。
 * 输入：单章结果序列；输出：一致率/P95/保真判定。
 * 语义：一致率≥90% ∧ P95<2s ∧ 内容保真（contentDrift≤10%）。
 */
export function evaluateStyleBatch(results: StyleApplyResult[]): StyleBatchResult {
  const n = results.length
  const agreed = results.filter((r) => r.agreement >= STYLE_AGREEMENT && r.contentDrift <= CONTENT_FIDELITY_CAP).length
  const fidelityFails = results.filter((r) => r.contentDrift > CONTENT_FIDELITY_CAP).length
  const agreementRate = n === 0 ? 0 : agreed / n
  const p95Ms = p95(results.map((r) => r.durationMs))
  return { agreementRate, p95Ms, fidelityFails, passed: agreementRate >= STYLE_AGREEMENT && p95Ms < STYLE_P95_MS }
}
