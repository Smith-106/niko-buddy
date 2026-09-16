/**
 * repair-loop.ts — 波2-C：反 AI 修正闭环率 + FP 误报统计（账本聚合）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 15 深化）：
 *   - GLM P1 缺口「anti-ai-correction-loop」：反 AI 修正闭环缺闭环率指标与
 *     FP 统计——本模块从事件账本切片**聚合**出数值（不新增真源、不写状态）；
 *   - GLM/DS 验收：闭环率与误报率可从账本切片聚合出数值并 UI 展示。
 *
 * 机械口径（账本可证，全部派生自 append-only 事件流）：
 *   - 一次 fail 的门运行 = 待闭环项（scope = gate+bookId+chapterId）；
 *   - fail 后同 scope 出现 pass 且其间存在 retry/generate 事件 → **修正闭环**
 *     （correction：检测→修正→复检通过走完闭环）；
 *   - fail 后同 scope 出现 pass 且其间**无任何 retry/generate** → **FP 误报**
 *     （内容未变而裁定翻转 = 原检测为假阳性的机械代理口径）；
 *   - fail 后无后续运行 = 未闭环（open，不计入闭环率分子）；
 *   - closureRate = corrections / failRuns；fpRate = falsePositives / failRuns；
 *     无 fail 运行 → 双率 null（无可闭环项，不臆造 100%）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "./audit-taxonomy"
import { readGateRunPayload, sliceRunEvents, type RunEvent, type RunEventLedger } from "./run-event-ledger"

// ============================================================================
// 契约
// ============================================================================

/** 单门修正闭环统计。 */
export interface CorrectionLoopGateStat {
  readonly gate: GateKey
  /** fail 运行数（待闭环项）。 */
  readonly failRuns: number
  /** fail→pass 间出现 retry/generate 的闭环数（真修正）。 */
  readonly corrections: number
  /** fail→pass 间无修正动作的翻转数（FP 机械代理口径）。 */
  readonly falsePositives: number
  /** 尚未出现后续同 scope 运行的 fail 数（open）。 */
  readonly openFailRuns: number
  /** corrections / failRuns；无 fail 运行 → null。 */
  readonly closureRate: number | null
  /** falsePositives / failRuns；无 fail 运行 → null。 */
  readonly fpRate: number | null
}

/** 修正闭环统计总表（按门 + 全局合计）。 */
export interface CorrectionLoopStats {
  readonly gates: readonly CorrectionLoopGateStat[]
  readonly totals: {
    readonly failRuns: number
    readonly corrections: number
    readonly falsePositives: number
    readonly openFailRuns: number
    readonly closureRate: number | null
    readonly fpRate: number | null
  }
}

// ============================================================================
// 聚合
// ============================================================================

/** 门运行事件的 scope 键（gate+bookId+chapterId；未提供维度视为空串）。 */
function scopeKeyOf(event: RunEvent): string {
  return [
    readGateRunPayload(event)?.gate ?? "",
    event.bookId ?? "",
    event.chapterId === undefined ? "" : String(event.chapterId),
  ].join("|")
}

/**
 * 修正闭环统计（纯聚合）：
 *   1. gate-run 事件按 seq 升序扫描（账本天然全序）；
 *   2. 每个 fail 运行向后找同 scope 的下一条 gate-run：
 *      pass 且间隔内有 retry/generate → correction；pass 且无 → FP；
 *      fail / 无后续 → open（不计分子）；
 *   3. 事件 payload.gate 与事件键以账本事实为准（readGateRunPayload 判读）。
 */
export function buildCorrectionLoopStats(
  ledger: RunEventLedger,
  options?: { readonly gates?: readonly GateKey[] },
): CorrectionLoopStats {
  const gateFilter = options?.gates
  const gateRuns = sliceRunEvents(ledger, { kind: "gate-run" })
  // 按 scope 分组（组内保持 seq 升序）
  const byScope = new Map<string, RunEvent[]>()
  for (const event of gateRuns) {
    const key = scopeKeyOf(event)
    const list = byScope.get(key)
    if (list) list.push(event)
    else byScope.set(key, [event])
  }

  const statsByGate = new Map<GateKey, { failRuns: number; corrections: number; falsePositives: number; openFailRuns: number }>()
  const ensure = (gate: GateKey) => {
    const current = statsByGate.get(gate)
    if (current) return current
    const fresh = { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 }
    statsByGate.set(gate, fresh)
    return fresh
  }

  for (const [, runs] of byScope) {
    for (let i = 0; i < runs.length; i += 1) {
      const event = runs[i] as RunEvent
      const payload = readGateRunPayload(event)
      if (!payload || payload.status !== "fail") continue
      const gate = payload.gate
      if (gateFilter !== undefined && !gateFilter.includes(gate)) continue
      const stat = ensure(gate)
      stat.failRuns += 1
      // 向后扫：同 scope 的下一条 gate-run（i+1 起，组内全序）
      const next = (runs[i + 1] as RunEvent | undefined) ?? null
      if (next === null) {
        stat.openFailRuns += 1
        continue
      }
      const nextPayload = readGateRunPayload(next)
      if (!nextPayload || nextPayload.status !== "pass") continue
      // 间隔内是否存在修正动作（retry / generate，seq 严格位于两者之间）
      const hadCorrection = sliceRunEvents(ledger, { kinds: ["retry", "generate"] }).some(
        (action) => action.seq > event.seq && action.seq < next.seq,
      )
      if (hadCorrection) stat.corrections += 1
      else stat.falsePositives += 1
    }
  }

  const gates = (gateFilter !== undefined ? gateFilter : GATE_PRIORITY_ORDER).map((gate) => {
    const stat = statsByGate.get(gate) ?? { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 }
    const rate = (numerator: number): number | null => (stat.failRuns === 0 ? null : numerator / stat.failRuns)
    return {
      gate,
      failRuns: stat.failRuns,
      corrections: stat.corrections,
      falsePositives: stat.falsePositives,
      openFailRuns: stat.openFailRuns,
      closureRate: rate(stat.corrections),
      fpRate: rate(stat.falsePositives),
    }
  })
  const totals = gates.reduce(
    (acc, g) => ({
      failRuns: acc.failRuns + g.failRuns,
      corrections: acc.corrections + g.corrections,
      falsePositives: acc.falsePositives + g.falsePositives,
      openFailRuns: acc.openFailRuns + g.openFailRuns,
    }),
    { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 },
  )
  const totalRate = (numerator: number): number | null =>
    totals.failRuns === 0 ? null : numerator / totals.failRuns
  return {
    gates,
    totals: { ...totals, closureRate: totalRate(totals.corrections), fpRate: totalRate(totals.falsePositives) },
  }
}