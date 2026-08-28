/**
 * rewrite-criteria.ts — v2.6.8 D5: 改写不可逆判据（复合条件 + P0 短路）
 *
 * 蓝图 `docs/p0/blueprint-v268-20260828.md` D5：
 *   - 复合布尔判据（三软维≥2 触地板 且 整体中位<9.0 才改写——非单维阈值）
 *   - P0 失败短路抑制改写（Quality 不得覆盖 Consistency）
 *   - 可回滚/不可回滚二分类 + 快照锚点（人名/设定/因果）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 改写触发判据（复合条件）
// ============================================================================

/** 改写判据输入。 */
export interface RewriteCriteriaInput {
  /** 触地板软维（来自 D2 地板闸）。 */
  softBreached: string[]
  /** 整体六维中位。 */
  overallMedian: number
  /** P0 硬门是否失败（consistency<9.0）。 */
  p0Failed: boolean
}

/** 改写判据结果。 */
export interface RewriteCriteriaResult {
  /** 是否触发改写。 */
  shouldRewrite: boolean
  /** 未触发原因（短路说明）。 */
  reason: string
}

/**
 * 复合改写判据（纯函数——确定性）。
 * 触发条件：三软维≥2 触地板 且 整体中位<9.0。
 * 短路：P0 失败 → 抑制改写（Quality 不得覆盖 Consistency）。
 */
export function evaluateRewriteCriteria(input: RewriteCriteriaInput): RewriteCriteriaResult {
  if (input.p0Failed) {
    return { shouldRewrite: false, reason: "P0 失败短路：Consistency 失败时改写被抑制（Quality 不得覆盖）" }
  }
  const softCount = input.softBreached.length
  if (softCount >= 2 && input.overallMedian < 9.0) {
    return { shouldRewrite: true, reason: `复合触发：${softCount} 软维触地板 且 中位 ${input.overallMedian}<9.0` }
  }
  return { shouldRewrite: false, reason: `未触发：软维 ${softCount}/3 触地板，中位 ${input.overallMedian}` }
}

// ============================================================================
// 可回滚/不可回滚二分类 + 快照锚点
// ============================================================================

/** 快照锚点类型（人名/设定/因果——触改即语义不可逆）。 */
export const ANCHOR_TYPES = ["character_name", "world_setting", "causal_link"] as const

export type AnchorType = (typeof ANCHOR_TYPES)[number]

/** 改写操作分类。 */
export type RewriteClass = "reversible" | "irreversible"

/** 改写操作声明。 */
export interface RewriteOperation {
  /** 操作描述。 */
  description: string
  /** 是否触碰锚点（人名/设定/因果）。 */
  touchesAnchor: boolean
  /** 锚点类型（touchesAnchor=true 时）。 */
  anchorType?: AnchorType
}

/**
 * 改写不可逆分类（纯函数——确定性）。
 * 触锚点（人名/设定/因果）= 语义不可逆（需快照锚点）；否则可回滚。
 */
export function classifyRewrite(op: RewriteOperation): { klass: RewriteClass; needsSnapshot: boolean } {
  if (op.touchesAnchor) {
    return { klass: "irreversible", needsSnapshot: true }
  }
  return { klass: "reversible", needsSnapshot: false }
}

/** 快照锚点（不可逆改写前置快照——恢复后 diff 为空）。 */
export interface SnapshotAnchor {
  anchorType: AnchorType
  /** 锚点值（改前）。 */
  before: string
  /** 锚点值（改后）。 */
  after: string
}

/** 快照恢复校验（纯函数——恢复后与改前一致）。 */
export function verifySnapshotRestore(anchor: SnapshotAnchor, restored: string): boolean {
  return restored === anchor.before
}
