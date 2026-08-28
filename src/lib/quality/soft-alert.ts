/**
 * soft-alert.ts — v2.7.1 写作流保护（误报软告警不阻断）
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - 误报软告警不阻断（草稿标记+侧栏提示，绝不阻断 accept/回填）
 *   - 判定理由透明可查
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 软告警
// ============================================================================

/** 告警通道。 */
export type AlertChannel = "draft-mark" | "sidebar" | "blocking"

/** 软告警结果。 */
export interface SoftAlertResult {
  /** 告警通道（软=草稿标记/侧栏；绝无 blocking）。 */
  channel: AlertChannel
  /** 判定理由（透明可查）。 */
  reason: string
  /** 是否阻断写作流（必须 false）。 */
  blocksWriting: boolean
}

/**
 * 软告警（纯函数——确定性）。
 * 输入：探针命中 + 判定理由；输出：软通道告警（不阻断）。
 * 语义：D3 命中一律走草稿标记/侧栏——绝不阻断 accept/回填（Draft-first 边界内）。
 */
export function softAlert(reason: string, prefersSidebar = false): SoftAlertResult {
  return {
    channel: prefersSidebar ? "sidebar" : "draft-mark",
    reason,
    blocksWriting: false,
  }
}
