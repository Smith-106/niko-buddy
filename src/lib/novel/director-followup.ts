/**
 * director-followup.ts — 波2-B 模块 19：导演跟进（阻塞队列 + staleness 传染 + 重跑成本）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 19）：
 *   - GLM P1 缺口「director-followup」：卷战略卡/节奏板/阻塞队列/staleness
 *     传染/重跑成本预估未交付——本模块交付**从事件账本推导**的跟进数据层：
 *     ① 阻塞队列：最近一次门运行的失败门按 P0→P1→P2 排队，低优先级项被高
 *        优先级失败项阻塞（门序不可逆的队列投影）；
 *     ② staleness 传染：上游工件变更 → 受影响下游传递闭包确定性标记 stale；
 *     ③ 重跑成本预估：由账本 budgetCost 聚合历史用量（无历史 → null 不臆造），
 *        DS 验收「重跑成本（token/时间）在 UI 可点开依据」= 事件证据锚。
 *   - UI 卡片接线属波2-D（#367 首页仪表盘/列表健康列）；本模块交付纯数据面。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用；全部派生自
 * RunEventLedger（append-only 真源）——不写 status.json / 不写 kb 产物。
 *
 * @license MIT © Niko Buddy
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "./audit-taxonomy"
import { readGateRunPayload, sliceRunEvents, type RunEvent, type RunEventLedger } from "./run-event-ledger"
import { getGatePriority } from "./rule-stack"

// ============================================================================
// 阻塞队列（P0→P1→P2 门序的队列投影）
// ============================================================================

/** 队列项（失败门 + 阻塞语义）。 */
export interface BlockingQueueItem {
  readonly gate: GateKey
  /** 门优先级（0=P0, 1=P1, 2=P2；真源 GATE_MAPPING）。 */
  readonly priority: 0 | 1 | 2
  /** 最近一次失败运行的 replayId（可点开重放）。 */
  readonly replayId: string | null
  /** 最近一次失败事件时间。 */
  readonly ts: string | null
  /** 失败运行证据数。 */
  readonly evidenceCount: number
  /** 被更高优先级失败门阻塞时指向该门（P0→P1→P2 传染）；无则 null。 */
  readonly blockedBy: GateKey | null
}

/**
 * 从账本推导阻塞队列（纯函数）：
 *   1. 每门取账本中**最近**一条 gate-run 事件（未落事件=未发生，不进队列）；
 *   2. fail 门按优先级升序入队（P0→P1→P2）；
 *   3. 低优先级失败项被更高优先级失败项阻塞（blockedBy=首个更高优先级失败门）；
 *   4. 全 pass / 空账本 → 空队列。
 */
export function buildBlockingQueue(ledger: RunEventLedger): readonly BlockingQueueItem[] {
  const latest = new Map<GateKey, RunEvent>()
  for (const event of ledger.events) {
    const payload = readGateRunPayload(event)
    if (payload) latest.set(payload.gate, event)
  }
  const failed: { gate: GateKey; event: RunEvent }[] = []
  for (const gate of GATE_PRIORITY_ORDER) {
    const event = latest.get(gate)
    if (!event) continue
    const payload = readGateRunPayload(event)
    if (payload && payload.status === "fail") failed.push({ gate, event })
  }
  const orderIndex = new Map<GateKey, number>(GATE_PRIORITY_ORDER.map((g, i) => [g, i]))
  failed.sort((a, b) => (orderIndex.get(a.gate) ?? 0) - (orderIndex.get(b.gate) ?? 0))
  return failed.map(({ gate, event }, index) => {
    const higherFailed = failed.slice(0, index)
    const blocker = higherFailed.length > 0 ? higherFailed[0]?.gate ?? null : null
    return {
      gate,
      priority: getGatePriority(gate),
      replayId: event.replayId ?? null,
      ts: event.ts,
      evidenceCount: event.evidenceRefs.length,
      blockedBy: blocker,
    }
  })
}

// ============================================================================
// staleness 传染（上游变更 → 下游传递闭包）
// ============================================================================

/** 依赖边（upstream 变更 → downstream stale）。 */
export interface StalenessEdge {
  readonly upstream: string
  readonly downstream: string
}

/**
 * staleness 传染（纯函数）：changedArtifacts 的传递闭包（BFS）。
 * 确定性：输出按拓扑层序 BFS 首见序，且已 stale 工件不重复展开。
 * changed 本身不在结果内（变更方已知；只标受影响下游）。
 */
export function propagateStaleness(
  edges: readonly StalenessEdge[],
  changedArtifacts: readonly string[],
): readonly string[] {
  const changedSet = new Set(changedArtifacts)
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.upstream)
    if (list) list.push(edge.downstream)
    else adjacency.set(edge.upstream, [edge.downstream])
  }
  const stale: string[] = []
  const queued = [...changedArtifacts]
  const visited = new Set<string>(queued)
  while (queued.length > 0) {
    const current = queued.shift()
    if (current === undefined) break
    for (const downstream of adjacency.get(current) ?? []) {
      if (visited.has(downstream)) continue
      visited.add(downstream)
      if (!changedSet.has(downstream)) stale.push(downstream)
      queued.push(downstream)
    }
  }
  return stale
}

// ============================================================================
// 重跑成本预估（账本 budgetCost 聚合；无历史 → null 不臆造）
// ============================================================================

/** 单门重跑成本预估（证据=账本历史事件；无历史 → nulls）。 */
export interface RerunCostEstimate {
  readonly gate: GateKey
  /** 历史累计 token（无携带 budgetCost 的历史 → null）。 */
  readonly tokens: number | null
  /** 历史累计墙钟 ms。 */
  readonly wallclockMs: number | null
  /** 历史累计调用次数。 */
  readonly calls: number | null
  /** 参与聚合的历史事件数（可点开依据）。 */
  readonly eventsCounted: number
}

/**
 * 重跑成本预估（纯函数）：指定门的全部历史 gate-run 事件 budgetCost 聚合
 * （全账本口径——重跑预计消耗与上次同级；换模型差分属波2-C gate-retry-diff）。
 * 无任何携带成本的历史 → tokens/wallclock/calls 全 null（不臆造数字）。
 */
export function estimateRerunCost(
  ledger: RunEventLedger,
  gates: readonly GateKey[],
): readonly RerunCostEstimate[] {
  const gateEvents = new Map<GateKey, RunEvent[]>()
  for (const event of sliceRunEvents(ledger, { kind: "gate-run" })) {
    const payload = readGateRunPayload(event)
    if (!payload) continue
    const list = gateEvents.get(payload.gate)
    if (list) list.push(event)
    else gateEvents.set(payload.gate, [event])
  }
  return gates.map((gate) => {
    const events = gateEvents.get(gate) ?? []
    let tokens = 0
    let wallclockMs = 0
    let calls = 0
    let counted = 0
    for (const event of events) {
      const cost = event.budgetCost
      if (!cost) continue
      counted += 1
      tokens += cost.tokens ?? 0
      wallclockMs += cost.wallclockMs ?? 0
      calls += cost.calls ?? 0
    }
    const hasHistory = counted > 0
    return {
      gate,
      tokens: hasHistory ? tokens : null,
      wallclockMs: hasHistory ? wallclockMs : null,
      calls: hasHistory ? calls : null,
      eventsCounted: counted,
    }
  })
}

// ============================================================================
// 导演跟进快照（UI 卡片数据面；纯组合）
// ============================================================================

/** 导演跟进快照（首页仪表盘/跟进面板的只读派生模型）。 */
export interface DirectorFollowupSnapshot {
  /** 阻塞队列（P0→P1→P2；blockedBy 传染语义）。 */
  readonly queue: readonly BlockingQueueItem[]
  /** 上游变更后受影响下游（传递闭包）。 */
  readonly stale: readonly string[]
  /** 重跑成本预估（按查询门序）。 */
  readonly rerunCost: readonly RerunCostEstimate[]
}

/** 构建导演跟进快照（纯组合：队列 + 传染 + 成本，全部派生自账本/输入）。 */
export function buildDirectorFollowupSnapshot(input: {
  readonly ledger: RunEventLedger
  readonly edges?: readonly StalenessEdge[]
  readonly changedArtifacts?: readonly string[]
  readonly rerunCostGates?: readonly GateKey[]
}): DirectorFollowupSnapshot {
  return {
    queue: buildBlockingQueue(input.ledger),
    stale: propagateStaleness(input.edges ?? [], input.changedArtifacts ?? []),
    rerunCost: estimateRerunCost(input.ledger, input.rerunCostGates ?? GATE_PRIORITY_ORDER),
  }
}