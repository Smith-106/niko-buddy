/**
 * arc-settlement.ts — G4 弧末结算编排契约层
 *
 * 背景: control-kernel routeNextArcStep 已有
 *   arc_review → summary → volume_summary → expand → new_volume
 * 事务顺序, campaign-runner 跨章循环尚未调用。本模块只沉淀编排契约
 * (触发判定 + 下一步推导), 不做任何 IO / 状态读写 / 模型调用,
 * 由后续 campaign-runner 接线消费。
 *
 * 机械层 (ADR-19): 纯函数, 零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

/** 弧末结算步骤 (G4 编排契约层命名, 顺序见 ARC_SETTLEMENT_ORDER)。 */
export type ArcSettlementStep =
  | "arc_review"
  | "summary"
  | "volume_summary"
  | "expand"
  | "new_volume"

/**
 * 弧末结算事务顺序 (与 control-kernel routeNextArcStep 同序)。
 * 只读常量, nextArcSettlementStep 按此顺序推导下一个未完成步骤。
 */
export const ARC_SETTLEMENT_ORDER: readonly ArcSettlementStep[] = [
  "arc_review",
  "summary",
  "volume_summary",
  "expand",
  "new_volume",
]

/**
 * 是否触发弧末结算 (纯函数)。
 * @param chapterNumber 当前章号 (1-based)
 * @param arcEndChapter 弧尾章号, null = 未知/无弧边界 → 永不触发
 * @returns chapterNumber >= arcEndChapter 时 true, 否则 false
 */
export function shouldTriggerArcSettlement(
  chapterNumber: number,
  arcEndChapter: number | null,
): boolean {
  if (arcEndChapter === null) return false
  return chapterNumber >= arcEndChapter
}

/**
 * 推导下一个未完成的结算步骤 (纯函数)。
 * 按 ARC_SETTLEMENT_ORDER 事务顺序返回第一个不在 done 中的步骤;
 * 全部完成返回 null。done 乱序/重复均不影响结果, 不突变入参。
 */
export function nextArcSettlementStep(
  done: readonly ArcSettlementStep[],
): ArcSettlementStep | null {
  const finished = new Set<ArcSettlementStep>(done)
  for (const step of ARC_SETTLEMENT_ORDER) {
    if (!finished.has(step)) return step
  }
  return null
}
