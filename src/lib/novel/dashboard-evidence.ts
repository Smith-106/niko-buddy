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
// 列表健康列（per-book 门控摘要）
// ============================================================================

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