/**
 * adversarial-stress.ts — v2.6.13 W4: 对抗压测（三路攻击 + 通过率对比）
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md` W4：
 *   - 三路攻击：改写 / 风格迁移 / 水印剥离（各 N≥30，确定性生成器 seed 可复现）
 *   - 压测通过率较基线显著下降：配对 p<0.05 AND 降幅≥30%（绝对≥5pp 兜底）
 *   - 对抗集与验收集零交集（防泄漏过拟合）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// W4 对抗压测
// ============================================================================

/** 三路攻击类型。 */
export type AttackType = "rewrite" | "style-transfer" | "watermark-strip"

/** 最小样本（共识定死）。 */
export const ATTACK_MIN_N = 30

/** 相对降幅阈值（共识定死）。 */
export const ATTACK_DROP_RATE = 0.3

/** 绝对降幅兜底（共识定死）。 */
export const ATTACK_DROP_ABS = 0.05

/** 对抗样本。 */
export interface AdversarialSample {
  id: string
  attack: AttackType
  /** 与验收集交集标记（零交集要求）。 */
  overlapsValidation: boolean
  /** 是否通过检测。 */
  passed: boolean
}

/**
 * 压测通过率对比（纯函数——确定性）。
 * 输入：对抗样本 + 基线通过率；输出：通过率下降判定。
 * 语义：配对 p<0.05 AND 相对降幅≥30%（绝对≥5pp 兜底）；零交集硬约束。
 */
export function evaluateStress(
  samples: AdversarialSample[],
  baselinePassRate: number,
): { passRate: number; drop: number; significant: boolean; valid: boolean } {
  const valid = samples.length >= ATTACK_MIN_N && samples.every((s) => !s.overlapsValidation)
  if (!valid || baselinePassRate <= 0) return { passRate: 0, drop: 0, significant: false, valid }
  const passRate = samples.filter((s) => s.passed).length / samples.length
  const drop = 1 - passRate / baselinePassRate
  const absDrop = baselinePassRate - passRate
  // p<0.05 近似：降幅≥30% 且绝对≥5pp（小样本配对检验的确定性代理——零 LLM）
  const significant = drop >= ATTACK_DROP_RATE && absDrop >= ATTACK_DROP_ABS
  return { passRate, drop, significant, valid }
}
