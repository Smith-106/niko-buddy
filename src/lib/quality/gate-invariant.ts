/**
 * gate-invariant.ts — v2.7.2 门控不变量（P0>P1>P2 零违反断言）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - P0>P1>P2 硬编码——自愈回滚/自动结案不得覆盖 Consistency(P0) 失败
 *   - P0 失败即阻断后续自动动作；Quality 覆盖尝试被拒
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 门控优先级不变量
// ============================================================================

/** 门控维度。 */
export type PriorityDim = "P0" | "P1" | "P2"

/** 优先级顺序（硬编码）。 */
export const PRIORITY_ORDER: PriorityDim[] = ["P0", "P1", "P2"]

/** 自动动作判定。 */
export interface AutoAction {
  id: string
  /** 门控结果。 */
  gates: { P0: boolean; P1: boolean; P2: boolean }
  /** 尝试执行的自动动作（回滚/结案/干预）。 */
  action: "rollback" | "closeout" | "intervene" | "none"
}

/** 不变量结果。 */
export interface InvariantResult {
  /** P0 失败但自动动作仍执行数（必须=0）。 */
  p0Overridden: number
  /** P2 覆盖 P0 的尝试数（必须=0）。 */
  qualityOverride: number
  /** 达标判定。 */
  passed: boolean
}

/**
 * 门控不变量断言（纯函数——确定性）。
 * 输入：自动动作序列；输出：P0 覆盖/Quality 覆盖计数。
 * 语义：P0 失败 → 阻断一切自动动作（只允许 none）；P2 永远不能覆盖 P0 失败。
 */
export function assertGateInvariant(actions: AutoAction[]): InvariantResult {
  let p0Overridden = 0
  let qualityOverride = 0
  for (const a of actions) {
    if (!a.gates.P0 && a.action !== "none") p0Overridden++
    // P2 尝试覆盖 P0 失败（P0 失败但 P2 通过且动作非 none 已计；这里计显式 Quality 覆盖信号）
    if (!a.gates.P0 && a.gates.P2 && a.action === "closeout") qualityOverride++
  }
  return { p0Overridden, qualityOverride, passed: p0Overridden === 0 && qualityOverride === 0 }
}
