/**
 * audit-report.ts — v2.7.0 审计报告（结案证据链 + 可追溯）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - 自动结案输出可审计报告（评分明细/门控判定/哈希/模型标识）
 *   - 用户可回溯「为什么结案」；100% 出报告
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 审计报告
// ============================================================================

/** 审计报告条目。 */
export interface AuditEntry {
  chapterId: string
  verdict: string
  gateDetail: string
  buildHash: string
  modelId: string
  closedBy: "auto" | "human"
}

/** 审计报告结果。 */
export interface AuditReportResult {
  entries: AuditEntry[]
  /** 报告完整率（每章有可回溯证据——100% 要求）。 */
  completeness: number
  complete: boolean
}

/**
 * 审计报告构建（纯函数——确定性）。
 * 输入：结案条目；输出：报告 + 完整性判定（每章有哈希/模型/门控明细）。
 */
export function buildAuditReport(entries: AuditEntry[]): AuditReportResult {
  const completeCount = entries.filter(
    (e) => e.gateDetail.length > 0 && e.buildHash.length > 0 && e.modelId.length > 0,
  ).length
  const completeness = entries.length === 0 ? 0 : completeCount / entries.length
  return { entries, completeness, complete: completeness >= 1 }
}
