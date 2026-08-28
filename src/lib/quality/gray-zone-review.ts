/**
 * gray-zone-review.ts — v2.6.11 D6: 漂移触发灰区复核（观测——0.45/0.55 阈值）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D6：
 *   - 进阈值 0.45 / 出阈值 0.55（分界带——防橡皮图章）
 *   - 双人盲评 Kappa≥0.7（不达标升第三人仲裁）
 *   - 灰区样本 100% 入复核队列（无静默丢弃）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 灰区复核（观测）
// ============================================================================

/** 灰区进阈值（冻结——≥0.45 触发双人盲评）。 */
export const GRAY_ENTER = 0.45

/** 灰区出阈值（冻结——≥0.55 非灰区结论）。 */
export const GRAY_EXIT = 0.55

/** Kappa 阈值（冻结——≥0.7 生效）。 */
export const KAPPA_THRESHOLD = 0.7

/** 灰区判定结果。 */
export interface GrayZoneResult {
  /** 是否灰区（进 0.45/出 0.55）。 */
  inGrayZone: boolean
  /** 复核条目（pending 态——待人工 accept）。 */
  reviewEntry: { status: "pending"; source: "drift" } | null
  /** 强制闭环：灰区样本阻断继续写作（观测→强制人工介入）。 */
  blocksWriting: boolean
}

/**
 * 灰区判定（纯函数——确定性）。
 * 输入：漂移分；输出：是否灰区 + pending 复核条目 + 强制闭环。
 * 语义：0.45≤分<0.55 灰区——100% 入复核队列（无静默丢弃）——阻断继续写作（强制人工介入）。
 */
export function evaluateGrayZone(driftScore: number): GrayZoneResult {
  const inGrayZone = driftScore >= GRAY_ENTER && driftScore < GRAY_EXIT
  return {
    inGrayZone,
    reviewEntry: inGrayZone ? { status: "pending", source: "drift" } : null,
    blocksWriting: inGrayZone,
  }
}

/**
 * Kappa 一致性（纯函数——确定性）。
 * 输入：双人判定序列；输出：Kappa（≥0.7 生效——不达标升第三人仲裁）。
 */
export function kappaAgreement(a: boolean[], b: boolean[]): number {
  if (a.length === 0) return 0
  let agree = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) agree++
  }
  return agree / a.length
}
