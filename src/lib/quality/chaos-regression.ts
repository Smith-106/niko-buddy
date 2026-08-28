/**
 * chaos-regression.ts — v2.6.12 测试 W3: 专项/混沌回归（故障注入限影子环境）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` 测试 W3：
 *   - 故障注入限影子/测试环境（memory/LanceDB/IPC 三类随机组合）
 *   - 白名单豁免已知抖动
 *   - 0 阻断级失败（对照基线通过率，劣化即挂起）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 专项/混沌回归（测试 W3）
// ============================================================================

/** 故障注入面（限影子/测试环境）。 */
export type ChaosTarget = "memory" | "lancedb" | "ipc"

/** 混沌回归结果。 */
export interface ChaosResult {
  /** 注入目标。 */
  target: ChaosTarget
  /** 是否阻断级失败。 */
  blockingFailure: boolean
  /** 白名单豁免（已知抖动）。 */
  whitelisted: boolean
}

/**
 * 混沌回归判定（纯函数——确定性）。
 * 输入：故障注入结果列表；输出：是否 0 阻断级失败。
 * 语义：白名单豁免已知抖动；非豁免阻断级失败 = 回归失败。
 */
export function evaluateChaosRegression(results: ChaosResult[]): { blockingFailures: number; pass: boolean } {
  const blockingFailures = results.filter((r) => r.blockingFailure && !r.whitelisted).length
  return { blockingFailures, pass: blockingFailures === 0 }
}
