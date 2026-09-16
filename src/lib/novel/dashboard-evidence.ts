/**
 * dashboard-evidence.ts — 波2-D：首页/列表只读派生数据源（证据卡接线）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2-D + 模块 1 深化）：
 *   - GLM/DS P0 缺口「证据卡接真实 UI」：EvidenceGateCards 需要接入真实首页
 *     仪表盘（director-view）与列表健康列——本模块提供**只读派生数据源**：
 *     账本 → 门状态 → 快照 → UI，零写路径、禁第二真源；
 *   - R-04：未落 gate-run 事件的门 = 未发生（NOT_EVALUATED），永不渲染为通过。
 *
 * 机械口径：
 *   - deriveEvidenceGateStatuses：账本中每门最近一条 gate-run 事件 → 三态
 *     （账本天然全序，倒序扫描取最近）；
 *   - buildDashboardEvidenceSnapshot：compose 派生门状态 + buildEvidenceSnapshot
 *     ——真实 UI 的唯一数据源入口（与 buildEvidenceSnapshot 正交，不改其 API）；
 *   - deriveBookHealthSummaries：列表健康列（per-bookId）：按事件 bookId 过滤
 *     派生每书门控摘要（任一 fail → blocked+blockingGate；三门全评估且无
 *     fail → pass；否则 not_evaluated）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用；磁盘读取由 UI 层
 * 经 run-event-ledger-store 完成后注入账本。
 *
 * @license MIT © QMAI
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "./audit-taxonomy"
import type { LibraryHealthReport } from "./asset-library"
import { buildEvidenceSnapshot, type EvidenceSnapshot } from "./evidence-snapshot"
import { readGateRunPayload, type RunEvent, type RunEventLedger } from "./run-event-ledger"
import type { GateRunStatus } from "./rule-stack"

// ============================================================================
// 门状态派生（只读）
// ============================================================================

/**
 * 从账本派生三门最新状态（R-04：未落事件 → undefined → NOT_EVALUATED）。
 * 纯函数：倒序扫描账本（天然全序），每门取最近一条 gate-run。
 */
export function deriveEvidenceGateStatuses(ledger: RunEventLedger): Readonly<Record<GateKey, GateRunStatus | undefined>> {
  const statuses: Record<GateKey, GateRunStatus | undefined> = {
    consistency: undefined,
    anti_ai: undefined,
    quality: undefined,
  }
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const event = ledger.events[i] as RunEvent
    const payload = readGateRunPayload(event)
    if (!payload) continue
    if (statuses[payload.gate] === undefined) statuses[payload.gate] = payload.status
  }
  return statuses
}

/**
 * 首页证据快照（真实 UI 数据源入口）：门状态从账本派生 + 快照组装。
 * libraryReports 可选透传（kb-health 探针结果）。
 */
export function buildDashboardEvidenceSnapshot(
  ledger: RunEventLedger,
  libraryReports?: readonly LibraryHealthReport[],
): EvidenceSnapshot {
  return buildEvidenceSnapshot({
    gateStatuses: deriveEvidenceGateStatuses(ledger),
    ledger,
    libraryReports,
  })
}

// ============================================================================
// 子门与告警可见面（波2-E：G-14 修复——算得到也要看得见）
// ============================================================================

/** 子门/告警展示项（stage 系事件的 UI 读出单元）。 */
export interface SubGateAlertItem {
  readonly eventId: string
  readonly ts: string
  readonly seq: number
  /** 来源类：子门裁定 / 同质化告警 / 反事实重放。 */
  readonly category: "subgate" | "alert" | "counterfactual"
  /** 子门或告警名（cross-form-derivation/vis-cont/aura-homogenization/voice-drift/counterfactual）。 */
  readonly name: string
  /** 人类可读摘要（裁定/相似度/漂移值等，由 payload 提取）。 */
  readonly summary: string
  /** 可点开证据链（evidenceRefs 透传）。 */
  readonly evidenceRefs: readonly string[]
  readonly bookId: string | null
  readonly chapterId: number | null
}

/** stage 事件摘要提取（纯函数；无匹配 payload → null 跳过）。 */
function summarizeStageEvent(event: RunEvent): SubGateAlertItem | null {
  const payload = event.payload as { subGate?: unknown; alert?: unknown; counterfactual?: { gate?: unknown; decisiveSourceIds?: unknown } } | undefined
  if (event.kind !== "stage" || payload === undefined || payload === null) return null
  const bookId = event.bookId ?? null
  const chapterId = event.chapterId ?? null
  if (typeof payload.subGate === "string") {
    const sub = payload as { subGate: string; verdict?: string; form?: string; pairsChecked?: number; findings?: { frameA?: string; frameB?: string; similarity?: number }[]; decisiveSourceIds?: string[] }
    const detail =
      sub.verdict !== undefined
        ? `裁定=${sub.verdict}${sub.form !== undefined ? ` (${String(sub.form)})` : ""}`
        : sub.pairsChecked !== undefined
          ? `跨帧对=${sub.pairsChecked} 断裂=${sub.findings?.length ?? 0}`
          : sub.decisiveSourceIds !== undefined
            ? `决定性证据=${sub.decisiveSourceIds.length}`
            : ""
    return { eventId: event.eventId, ts: event.ts, seq: event.seq, category: sub.subGate === "counterfactual" ? "counterfactual" : "subgate", name: sub.subGate, summary: detail, evidenceRefs: event.evidenceRefs, bookId, chapterId }
  }
  if (typeof payload.alert === "string") {
    const alert = payload as { alert: string; pairs?: { entryIdA?: string; entryIdB?: string; similarity?: number }[]; drift?: number | null; chapterId?: number }
    const detail =
      alert.alert === "aura-homogenization"
        ? `同质化角色对=${alert.pairs?.length ?? 0}${alert.pairs?.[0]?.similarity !== undefined ? ` 最高相似度=${alert.pairs[0].similarity}` : ""}`
        : alert.alert === "voice-drift"
          ? `漂移=${alert.drift ?? "未知"}（ch${alert.chapterId ?? "?"}）`
          : ""
    return { eventId: event.eventId, ts: event.ts, seq: event.seq, category: "alert", name: alert.alert, summary: detail, evidenceRefs: event.evidenceRefs, bookId, chapterId }
  }
  if (payload.counterfactual !== undefined && typeof payload.counterfactual === "object") {
    const cf = payload.counterfactual
    return {
      eventId: event.eventId,
      ts: event.ts,
      seq: event.seq,
      category: "counterfactual",
      name: `counterfactual:${typeof cf.gate === "string" ? cf.gate : "?"}`,
      summary: `决定性证据=${Array.isArray(cf.decisiveSourceIds) ? cf.decisiveSourceIds.length : 0}`,
      evidenceRefs: event.evidenceRefs,
      bookId,
      chapterId,
    }
  }
  return null
}

/**
 * 子门/告警可见面（G-14）：从账本 stage 事件派生可展示清单（账本序，最新在前）。
 * 纯函数；空账本/无匹配 → 空数组（零告警是合法结果，不制造噪声）。
 */
export function deriveSubGateAlerts(ledger: RunEventLedger, limit = 50): readonly SubGateAlertItem[] {
  const items: SubGateAlertItem[] = []
  for (const event of ledger.events) {
    const item = summarizeStageEvent(event)
    if (item !== null) items.push(item)
  }
  return items.reverse().slice(0, limit)
}

/** 单书健康摘要（列表健康列渲染单元）。 */
export interface BookHealthSummary {
  readonly bookId: string
  /** 三态：任一门 fail → fail；三门全评估且无 fail → pass；否则 not_evaluated。 */
  readonly display: "pass" | "fail" | "not_evaluated"
  /** 任一门未通过 → 阻塞（列表行可见）。 */
  readonly blocked: boolean
  /** 最先阻塞门（GATE_PRIORITY_ORDER 序）。 */
  readonly blockingGate: GateKey | null
  /** 已评估门数（0..3；0 = 无门运行事件，未发生）。 */
  readonly evaluatedGates: number
}

/**
 * 列表健康列派生（per-bookId）：账本 gate-run 事件按 bookId 过滤，每门取
 * 最近一条 → 三态摘要。无事件的书 → not_evaluated / 不阻塞（R-04 诚实面）。
 */
export function deriveBookHealthSummaries(
  ledger: RunEventLedger,
  bookIds: readonly string[],
): Readonly<Record<string, BookHealthSummary>> {
  // 按 bookId 收集事件（账本全序保持）
  const byBook = new Map<string, { gate: GateKey; status: GateRunStatus }[]>()
  for (const event of ledger.events) {
    const payload = readGateRunPayload(event)
    if (!payload || event.bookId === undefined) continue
    const list = byBook.get(event.bookId)
    if (list) list.push({ gate: payload.gate, status: payload.status })
    else byBook.set(event.bookId, [{ gate: payload.gate, status: payload.status }])
  }
  const out: Record<string, BookHealthSummary> = {}
  for (const bookId of bookIds) {
    const runs = byBook.get(bookId) ?? []
    // 每门最近状态（倒序扫描，首个出现即最近）
    const latest = new Map<GateKey, GateRunStatus>()
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const run = runs[i] as { gate: GateKey; status: GateRunStatus }
      if (!latest.has(run.gate)) latest.set(run.gate, run.status)
    }
    const blockingGate = GATE_PRIORITY_ORDER.find((gate) => latest.get(gate) === "fail") ?? null
    const evaluatedGates = latest.size
    const display: BookHealthSummary["display"] =
      blockingGate !== null ? "fail" : evaluatedGates === GATE_PRIORITY_ORDER.length ? "pass" : "not_evaluated"
    out[bookId] = { bookId, display, blocked: blockingGate !== null, blockingGate, evaluatedGates }
  }
  return out
}