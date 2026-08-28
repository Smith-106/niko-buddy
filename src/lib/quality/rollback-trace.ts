/**
 * rollback-trace.ts — v2.7.2 回滚 trace（强制落盘 + 静默回滚=0 审计）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - 每次自动回滚强制落 trace（时间戳/触发门/证据/回滚范围/前后哈希）
 *   - 静默回滚=0（trace 空缺计数=0）；人工回滚通道保留
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 回滚 trace
// ============================================================================

/** trace 条目（强制字段）。 */
export interface RollbackTrace {
  eventId: string
  chapterId: string
  gate: "P0" | "P1" | "P2"
  reason: string
  scope: string
  hashBefore: string
  hashAfter: string
  /** 人工回滚通道是否可达。 */
  manualChannelAvailable: boolean
}

/** 审计结果。 */
export interface TraceAuditResult {
  /** 事件总数。 */
  total: number
  /** trace 完整数（强制字段全非空）。 */
  complete: number
  /** 静默回滚数（缺 trace——必须=0）。 */
  silent: number
  /** 审计判定（静默=0 且 trace 100%）。 */
  passed: boolean
}

/**
 * trace 审计（纯函数——确定性）。
 * 输入：trace 条目；输出：静默回滚计数。
 * 语义：无 trace 的回滚事件 = 静默回滚（P0 违规）；强制字段全非空才算完整。
 */
export function auditTrace(traces: RollbackTrace[]): TraceAuditResult {
  const complete = traces.filter(
    (t) => t.reason.length > 0 && t.scope.length > 0 && t.hashBefore.length > 0 && t.hashAfter.length > 0 && t.manualChannelAvailable,
  ).length
  const total = traces.length
  const silent = total - complete
  return { total, complete, silent, passed: silent === 0 && total > 0 }
}
