/**
 * kb-observability.ts — 可观测性聚合 + 错误分级（E-06 / F-006，双库架构蓝图 kb-governance）。
 *
 * ## 职责（REQ-OBS-001..005）
 *   - 6 项核心指标聚合（GOV-OBS-01）：canon_violation_rate（<1%）/
 *     obligation_coverage（>95%）/ hard_injection_budget_usage /
 *     promotion_replay_success / truth_fold_drift（=0）/ gap_report_rate。
 *     缺源显式 N/A（null + unavailableReason），绝不伪造数值。
 *   - truth_fold_drift > 0 → 告警（GOV-OBS-01：不静默降级）。
 *   - 3 类健康检查（GOV-OBS-03）：门面只读装配就绪 / 原子存储完整性 /
 *     KB-VIEW 重建时效（staleness，阈值 [需校准]）。
 *   - 错误分级与恢复（GOV-OBS-04）：DISASTER（原子写失败→终止写阶段）/
 *     DEGRADED（检索超时→降级硬注入兜底不终止写作）/ RECOVERABLE（采源失败→
 *     FAILED→重试或 QUARANTINE）/ CONTROLLED（accept 拒绝→阻断晋升保留草稿）。
 *
 * ## 边界与纪律
 *   - 只读聚合既有产物（审计 findings / fold-conflicts.jsonl / 指标函数），
 *     零新真源；聚合输出 = 报告工件（可删重建，E-04 G1 同款纪律）。
 *   - 纯函数 + 注入式依赖（便于单测）；不新建任何真相文件。
 *
 * ## DimensionCoord（SA-05 / GOV-REV-02，E-06 共识 C-10）
 *   (Decoupled, Async, Tunable)：只读聚合零写句柄；指标可离线重算（Replay 语义
 *   由来源保证）；告警为报告工件可删重建。
 *
 * 遵循 QMAI/CLAUDE.md：E-06 新增锚点（2026-09-04 三模型共识），落 `src/lib/novel/`。
 */

// ──────────────────────────────────────────────────────────────────────────
// 6 指标聚合（GOV-OBS-01）
// ──────────────────────────────────────────────────────────────────────────

/** 单指标采集结果：不可采集 → null + unavailableReason（绝不伪造数值）。 */
export interface MetricSample {
  value: number | null
  unavailableReason?: string
}

/** 6 项核心指标（GOV-OBS-01）。 */
export interface KbMetrics {
  /** canon 违反率（<1% 健康）；源=评测 gate，种子未就绪 → N/A */
  canon_violation_rate: MetricSample
  /** 义务覆盖率（>95% 健康）；源=评测 gate，种子未就绪 → N/A */
  obligation_coverage: MetricSample
  /** 硬注入预算占用（chars/capChars）；源=E-02 ContextPack hardInjectUsage */
  hard_injection_budget_usage: MetricSample
  /** 晋升重放成功率；源=promotion-bridge.promotionReplaySuccessRate */
  promotion_replay_success: MetricSample
  /** 真相文件 fold 漂移（=0 健康）；源=chapter-ingest.computeTruthFoldDrift */
  truth_fold_drift: MetricSample
  /** 检索缺口报告率；源=pack.gaps */
  gap_report_rate: MetricSample
}

/** 指标来源注入（单测可 mock；生产接线点见各来源函数）。 */
export interface KbMetricsSources {
  canonViolationRate?: number | null
  obligationCoverage?: number | null
  hardInjectionBudgetUsage?: number | null
  promotionReplaySuccess?: number | null
  truthFoldDrift?: number | null
  gapReportRate?: number | null
}

/** 聚合 6 指标（缺源显式 N/A，不伪造数值）。 */
export function collectKbMetrics(sources: KbMetricsSources): KbMetrics {
  const sample = (value: number | null | undefined, reason: string): MetricSample =>
    value === null || value === undefined ? { value: null, unavailableReason: reason } : { value }
  return {
    canon_violation_rate: sample(sources.canonViolationRate, "seed-missing（评测集种子未就绪）"),
    obligation_coverage: sample(sources.obligationCoverage, "seed-missing（评测集种子未就绪）"),
    hard_injection_budget_usage: sample(sources.hardInjectionBudgetUsage, "E-02 hardInjectUsage 未接线"),
    promotion_replay_success: sample(sources.promotionReplaySuccess, "promotionReplaySuccessRate 不可采集"),
    truth_fold_drift: sample(sources.truthFoldDrift, "computeTruthFoldDrift 不可采集"),
    gap_report_rate: sample(sources.gapReportRate, "pack.gaps 未接线"),
  }
}

/** truth_fold_drift > 0 → 告警（GOV-OBS-01：不静默降级）。 */
export function checkTruthFoldDrift(drift: number | null): { alarm: boolean; detail: string } {
  if (drift === null) return { alarm: false, detail: "truth_fold_drift 不可采集（N/A）" }
  if (drift > 0) return { alarm: true, detail: `truth_fold_drift=${drift} > 0（真相文件与快照重放不一致）` }
  return { alarm: false, detail: "truth_fold_drift=0（健康）" }
}

// ──────────────────────────────────────────────────────────────────────────
// 3 健康检查（GOV-OBS-03）
// ──────────────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  ok: boolean
  detail: string
}

/** H1 门面只读装配就绪：门面读路径可返回且零异常。 */
export function checkFacadeReady(input: { facadeReadable: boolean; techLeak: boolean }): HealthCheckResult {
  if (!input.facadeReadable) return { ok: false, detail: "门面只读装配不可用" }
  if (input.techLeak) return { ok: false, detail: "tech 泄漏（assertNoTechLeak 命中）" }
  return { ok: true, detail: "门面只读装配就绪" }
}

/** H2 原子存储完整性：真相文件可解析 + fileVersion 匹配 + drift=0。 */
export function checkAtomicStoreIntegrity(input: {
  parseable: boolean
  fileVersionOk: boolean
  drift: number | null
}): HealthCheckResult {
  if (!input.parseable) return { ok: false, detail: "原子存储文件不可解析" }
  if (!input.fileVersionOk) return { ok: false, detail: "fileVersion 不匹配" }
  if (input.drift !== null && input.drift > 0) return { ok: false, detail: `truth_fold_drift=${input.drift} > 0` }
  return { ok: true, detail: "原子存储完整性通过" }
}

/** H3 KB-VIEW 重建时效（staleness）：generatedAt 距今 ≤ 阈值（[需校准]）。 */
export function checkKbViewStaleness(input: {
  generatedAt: number | null
  now: number
  maxAgeDays?: number
}): HealthCheckResult {
  const maxAgeDays = input.maxAgeDays ?? 7
  if (input.generatedAt === null) return { ok: false, detail: "KB-VIEW generatedAt 缺失" }
  const ageDays = (input.now - input.generatedAt) / 86_400_000
  if (ageDays > maxAgeDays) {
    return { ok: false, detail: `KB-VIEW 重建时效过期：${ageDays.toFixed(1)} 天 > ${maxAgeDays} 天（[需校准]）` }
  }
  return { ok: true, detail: `KB-VIEW 时效正常（${ageDays.toFixed(1)} 天）` }
}

// ──────────────────────────────────────────────────────────────────────────
// 错误分级与恢复（GOV-OBS-04）
// ──────────────────────────────────────────────────────────────────────────

/** 四类错误分级（GOV-OBS-04）。 */
export type KbErrorClass = "DISASTER" | "DEGRADED" | "RECOVERABLE" | "CONTROLLED"

/** 分级上下文（分类依据）。 */
export interface KbErrorContext {
  /** 原子写失败（createAtomicJsonStore commit 抛错） */
  atomicWriteFailed?: boolean
  /** 检索超时/检索失败 */
  retrievalFailed?: boolean
  /** 采源失败（LLM/外部源） */
  sourceFailed?: boolean
  /** accept 拒绝 / 门控 BLOCK */
  gateBlocked?: boolean
}

/** 错误分级（纯函数；未知错误保守归 RECOVERABLE）。 */
export function classifyKbError(_err: unknown, ctx: KbErrorContext = {}): KbErrorClass {
  if (ctx.atomicWriteFailed) return "DISASTER"
  if (ctx.retrievalFailed) return "DEGRADED"
  if (ctx.gateBlocked) return "CONTROLLED"
  if (ctx.sourceFailed) return "RECOVERABLE"
  return "RECOVERABLE"
}

/** 恢复策略表（GOV-OBS-04）。 */
export interface RecoveryPlan {
  action: string
  terminal: boolean
  rollback: string
  eventType: string
}

/** 恢复策略（表驱动纯函数）。 */
export function recoveryPlanFor(cls: KbErrorClass): RecoveryPlan {
  switch (cls) {
    case "DISASTER":
      return {
        action: "终止写阶段 fail-loud（旧文件完好，结构上无半成品）",
        terminal: true,
        rollback: "temp+fsync+rename 原子底座保证旧文件完好",
        eventType: "disaster_atomic_write",
      }
    case "DEGRADED":
      return {
        action: "降级硬注入兜底，不终止写作",
        terminal: false,
        rollback: "degraded_source gap 记录，恢复后重试",
        eventType: "degraded_retrieval",
      }
    case "RECOVERABLE":
      return {
        action: "FAILED → 退避重试（封顶）→ 超限转 QUARANTINE",
        terminal: false,
        rollback: "重试队列重放收敛",
        eventType: "recoverable_source",
      }
    case "CONTROLLED":
      return {
        action: "阻断晋升、保留草稿（不回滚 accept/正文）",
        terminal: false,
        rollback: "promotion-retry 队列重放收敛",
        eventType: "controlled_gate_block",
      }
  }
}
