/**
 * evidence-snapshot.ts — 波1 EB-1 证据链卡片快照（贯穿超越主题的数据层）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md`，三路共识）：
 *   - 「证据链可见化」：每个模块 UI = 证据暴露面；可证性三问——谁的证据 /
 *     能否点开 / 能否重放——在数据层一次性回答；
 *   - R-04：门结果未落 gate-run 事件 = 未发生（hasEvent=false → NOT_EVALUATED）；
 *   - 卡片字段 = EB-1 契约 (gate, verdict, score, evidence_refs[], replay_id,
 *     model_id, promptArtifact@version 血缘, ts)；
 *   - **权威口径（防污染）**：卡片是「结论 + 归因」的一个整体——`display` 来自门状态，
 *     `ts/score/replayId/modelId/promptArtifact/evidenceCount/hasEvent` 来自账本事件，
 *     二者必须同源。若事件选取不过滤，就会出现「结论是正式章的、时间戳是草稿复核的」
 *     这种不可审计的拼接假面。因此本模块的账本扫描统一走 `toAuthoritativeLedger`
 *     （唯一权威过滤器，见 gate-run-authority.ts）；成本归因例外——花钱是真花的，
 *     不过滤（草稿复核也是真实算力消耗）；
 *   - 聚合面：门事件覆盖率（G1=1.0）/ 提示词血缘率（LLM 中介门 100%）/
 *     budgetCost 归因 / 库健康摘要——首页仪表盘与列表健康列共用此纯函数。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用；UI 只读渲染。
 *
 * @license MIT © Niko Buddy
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "./audit-taxonomy"
import {
  aggregateBudgetCost,
  checkGateEventCoverage,
  gateDisplayLabel,
  gateDisplayStatus,
  readGateRunPayload,
  type BudgetCostSummary,
  type GateDisplayStatus,
  type RunEvent,
  type RunEventLedger,
} from "./run-event-ledger"
import { checkPromptLineageCoverage } from "./prompt-artifacts"
import { toAuthoritativeLedger } from "./gate-run-authority"
import type { GateRunStatus } from "./rule-stack"
import type { LibraryHealthReport } from "./asset-library"

// ============================================================================
// 卡片契约（EB-1）
// ============================================================================

/** 单门证据卡片（UI 渲染单元；点开 = evidenceRefs/replayId 可下钻）。 */
export interface EvidenceGateCard {
  readonly gate: GateKey
  /** 显示三态（R-04：未评估永不渲染为通过）。 */
  readonly display: GateDisplayStatus
  /** 中文标签（通过 / 未通过 / 未评估）。 */
  readonly label: string
  /** 门得分（事件携带时）。 */
  readonly score: number | null
  /** 证据引用数（下钻条目由事件 evidenceRefs 提供）。 */
  readonly evidenceCount: number
  /** 可重放链 id（点开可重放）。 */
  readonly replayId: string | null
  /** 裁决模型（路由证据）。 */
  readonly modelId: string | null
  /** 门-提示词血缘（id@version；无 LLM 中介为 null）。 */
  readonly promptArtifact: string | null
  /** 事件时间（ISO；未落事件为 null）。 */
  readonly ts: string | null
  /** 覆盖检查：该门是否落了 gate-run 事件（false = 未发生，显示 NOT_EVALUATED）。 */
  readonly hasEvent: boolean
}

/** 证据链快照（首页/列表/章节页共用只读派生模型）。 */
export interface EvidenceSnapshot {
  /** 三门卡片（GATE_PRIORITY_ORDER 序：P0 > P1 > P2）。 */
  readonly cards: readonly EvidenceGateCard[]
  /** 门事件覆盖率（covered/total；空运行为 1）。 */
  readonly gateEventCoverage: number
  /** 提示词血缘率（无 LLM 中介门运行为 null）。 */
  readonly promptLineageRate: number | null
  /** 成本归因（全账本聚合）。 */
  readonly budgetCost: BudgetCostSummary
  /** 库健康摘要（kb-health 探针结果透传）。 */
  readonly libraryHealth: readonly { readonly libraryId: string; readonly healthy: boolean; readonly violations: number }[]
  /** 列表健康列（四指标共识：gateSummary/L9 占位/kbCoverage 占位/向量数占位中的门控面）。 */
  readonly blocked: boolean
  readonly blockingGate: GateKey | null
}

/**
 * 构建证据链快照（纯函数）：门显示三态 + 事件覆盖 + 血缘 + 成本 + 库健康。
 * DS 超越点：P0 失败时首页显示「被 P0 阻塞」而非高分高亮（blockingGate 语义）。
 *
 * 卡片三态取自**该门最近一条权威 gate-run 事件的 payload.status**（R-04：没有事件
 * 就没有裁定，即使内存里有结论也不渲染通过）；`input.gateStatuses` 只用于覆盖率
 * 分母（哪些门「有裁定、理应留证」）。这样 display 与 ts/replayId/modelId/score/
 * evidenceCount 永远是同一条事件上的事实，审计可闭合。
 */
export function buildEvidenceSnapshot(input: {
  readonly gateStatuses: Readonly<Record<GateKey, GateRunStatus | undefined>>
  readonly ledger: RunEventLedger
  readonly libraryReports?: readonly LibraryHealthReport[]
}): EvidenceSnapshot {
  // 权威账本视图（唯一过滤器）：卡片归因、覆盖率、血缘率同源；成本归因不过滤。
  const authoritativeLedger = toAuthoritativeLedger(input.ledger)
  const cards: EvidenceGateCard[] = []
  for (const gate of GATE_PRIORITY_ORDER) {
    // 账本中该门最近一条**权威** gate-run 事件（证据落账事实 + 归因单源）
    let latestEvent: RunEvent | null = null
    for (let i = authoritativeLedger.events.length - 1; i >= 0; i -= 1) {
      const event = authoritativeLedger.events[i] as RunEvent
      const payload = readGateRunPayload(event)
      if (payload && payload.gate === gate) {
        latestEvent = event
        break
      }
    }
    const payload = latestEvent ? readGateRunPayload(latestEvent) : null
    const promptArtifact =
      latestEvent?.promptArtifactId !== undefined && latestEvent?.promptArtifactVersion !== undefined
        ? `${latestEvent.promptArtifactId}@${latestEvent.promptArtifactVersion}`
        : null
    // R-04 + 未落=未发生：display 以事件在账为准——内存裁定但未落事件 → NOT_EVALUATED。
    // 且 display 与 ts/score/replayId/evidenceCount 取**同一条权威事件**：若 display 走
    // 外部门状态而归因走事件，一旦两者不同源（草稿复核未过滤），同一张卡就会变成
    // 「结论是正式章的、证据时间戳是草稿的」这种不可审计的拼接假面。
    const display = gateDisplayStatus(payload?.status)
    cards.push({
      gate,
      display,
      label: gateDisplayLabel(display),
      score: payload?.score ?? null,
      evidenceCount: latestEvent?.evidenceRefs.length ?? 0,
      replayId: latestEvent?.replayId ?? null,
      modelId: latestEvent?.modelId ?? null,
      promptArtifact,
      ts: latestEvent?.ts ?? null,
      hasEvent: latestEvent !== null,
    })
  }

  // 覆盖率只对「有裁定」的门计——空运行（无裁定无事件）平凡覆盖 = 1；
  // 口径：只算权威事件（草稿复核落的 gate-run 不算「本门已留证」）
  const evaluatedGates = GATE_PRIORITY_ORDER.filter((gate) => input.gateStatuses[gate] !== undefined)
  const coverage = checkGateEventCoverage(
    evaluatedGates.map((gate) => ({ gate })),
    authoritativeLedger,
  )
  const lineage = checkPromptLineageCoverage(authoritativeLedger)
  const failing = cards.find((card) => card.display === "fail")

  return {
    cards,
    gateEventCoverage: coverage.rate,
    promptLineageRate: lineage.llmMediatedGateRuns === 0 ? null : lineage.rate,
    budgetCost: aggregateBudgetCost(input.ledger.events),
    libraryHealth: (input.libraryReports ?? []).map((r) => ({
      libraryId: r.libraryId,
      healthy: r.healthy,
      violations: r.violations.length,
    })),
    blocked: failing !== undefined,
    blockingGate: failing?.gate ?? null,
  }
}