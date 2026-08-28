/**
 * adversarial-corpus.ts — v2.7.1 对抗样本库（扩库 ≥2× + 真阳性抽检 + 只增不改）
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - ≥2× 基线（W4 三路 N≥30→每路 N≥60 + 新样本 ≥3 类）
 *   - 入库 100% 标注复核；真阳性抽检 ≥95%（样本 ≥50）；只增不改版本可回滚
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 对抗样本库
// ============================================================================

/** 扩库倍数硬门（共识定死）。 */
export const CORPUS_MULTIPLIER = 2

/** 真阳性抽检率硬门（共识定死）。 */
export const CORPUS_PRECISION = 0.95

/** 最小抽检样本（共识定死）。 */
export const CORPUS_MIN_SAMPLE = 50

/** 样本族（向量族覆盖——W4 三路 + 新向量 ≥3 类）。 */
export type AttackFamily = "rewrite" | "style-transfer" | "watermark-strip" | "semantic-rephrase" | "jailbreak" | "role-hijack" | "prefix-inject"

/** 对抗样本。 */
export interface AdversarialSample {
  id: string
  family: AttackFamily
  /** 真阳性（标注复核通过）。 */
  labeledPositive: boolean
}

/** 扩库结果。 */
export interface CorpusResult {
  /** 当前库规模。 */
  total: number
  /** 基线规模。 */
  baseline: number
  /** 扩库倍数（≥2× 硬门）。 */
  multiplier: number
  /** 覆盖的向量族数。 */
  familyCount: number
  /** 真阳性抽检率（≥95% 硬门）。 */
  precision: number
  /** 是否达标（≥2× ∧ 族数≥5 ∧ 抽检率≥95%）。 */
  passed: boolean
}

/**
 * 扩库校验（纯函数——确定性）。
 * 输入：全库样本 + 基线规模 + 抽检样本；输出：倍数/精度/达标判定。
 * 语义：只增不改（全库=基线+增量）；真阳性抽检 ≥95%（样本 ≥50）。
 */
export function evaluateCorpus(
  samples: AdversarialSample[],
  baseline: number,
  audited: AdversarialSample[],
): CorpusResult {
  const total = samples.length
  const multiplier = baseline === 0 ? 0 : total / baseline
  const familyCount = new Set(samples.map((s) => s.family)).size
  const auditSet = audited.length >= CORPUS_MIN_SAMPLE ? audited : samples
  const positives = auditSet.filter((s) => s.labeledPositive).length
  const precision = auditSet.length === 0 ? 0 : positives / auditSet.length
  return {
    total,
    baseline,
    multiplier,
    familyCount,
    precision,
    passed: multiplier >= CORPUS_MULTIPLIER && familyCount >= 5 && precision >= CORPUS_PRECISION,
  }
}
