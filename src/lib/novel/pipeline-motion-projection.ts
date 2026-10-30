// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-projection.ts — 「管线动态」视图的纯函数投影层。
 *
 * 解决的问题：运动热力图原本只有静态模组接线图，看不见「工作正跑到哪一步」。
 * 本模组把 append-only 的运行事件（run-event-ledger + 主控轨迹）投影成一条
 * 纵向写作管线的节点状态：目标 → 取证 → 大纲 → 章纲 → 正文 → 自检门 →
 * 审稿 → 审稿门 → 返修 → 入库 → 交付 → 回流 → 复盘。
 *
 * 三条硬口径：
 *   1. **只跟真实事件**：蓝色「当前路径」= 最后一个能映射到阶段的事件，
 *      没有事件也没有轨迹条目才是空态（`checked: false`），绝不编假路径、绝不做装饰动画。
 *   2. **映射只用事件自带的栏位**（kind / actor / payload.pass /
 *      工具名），不猜语义；映射不上的事件只进计数与 log，不落节点。
 *      特别是 `stage`：账本里的 stage 是异质事件（子门/告警/质量迭代
 *      中间态），一律当正文就是编造，故一律不落节点。
 *   3. **红色返工回路只计真实返工**：`retry` 事件计入 返修→正文
 *      （事件计数，未验证后续真有正文事件）；`gate-run` 且 `pass === false`
 *      按 actor 归因：critic 的失败计入 自检门→返修，其余计入 审稿门→返修。
 */

import type { RunEvent } from "./run-event-ledger"
import type { TraceEntry } from "./main-control-trace"

// ── 管线定义 ───────────────────────────────────────────────────────────────────

/** 节点种类：stage=直通阶段，decision=◆ 决策菱形，terminal=终点。 */
export type MotionNodeKind = "stage" | "decision" | "terminal"

export interface MotionStage {
  readonly id: string
  readonly label: string
  readonly kind: MotionNodeKind
}

export const PIPELINE_STAGES: readonly MotionStage[] = [
  { id: "goal", label: "目标", kind: "stage" },
  { id: "evidence", label: "取证", kind: "stage" },
  { id: "outline", label: "大纲", kind: "stage" },
  { id: "chapter-plan", label: "章纲", kind: "stage" },
  { id: "draft", label: "正文", kind: "stage" },
  { id: "self-gate", label: "自检门", kind: "decision" },
  { id: "review", label: "审稿", kind: "stage" },
  { id: "review-gate", label: "审稿门", kind: "decision" },
  { id: "revise", label: "返修", kind: "stage" },
  { id: "ingest", label: "入库", kind: "stage" },
  { id: "deliver", label: "交付", kind: "stage" },
  { id: "reflow", label: "回流", kind: "stage" },
  { id: "retrospective", label: "复盘", kind: "terminal" },
]

/** 黄色外部依赖侧节点：只在事件真的提到它们时才点亮。 */
export const EXTERNAL_NODES: readonly MotionStage[] = [
  { id: "model-router", label: "模型路由", kind: "stage" },
  { id: "knowledge-base", label: "知识库", kind: "stage" },
]

export interface ReworkEdge {
  readonly from: string
  readonly to: string
  readonly label: string
}

/** 红色返工回路（固定三条，计数来自真实事件）。 */
export const REWORK_EDGES: readonly ReworkEdge[] = [
  { from: "revise", to: "draft", label: "返工" },
  { from: "review-gate", to: "revise", label: "不通过" },
  { from: "self-gate", to: "revise", label: "不通过" },
]

// ── 投影类型 ───────────────────────────────────────────────────────────────────

export type MotionNodeState = "current" | "visited" | "idle"

export interface MotionNodeProjection {
  readonly id: string
  readonly label: string
  readonly kind: MotionNodeKind
  readonly state: MotionNodeState
  /** 最后一次落到本节点的事件时间（ISO 字符串原样透出，不解析）。 */
  readonly lastTs: string | null
}

export interface MotionLogEntry {
  readonly ts: string
  readonly label: string
  readonly tone: "info" | "pass" | "rework" | "error"
}

export interface PipelineMotionProjection {
  /** 是否真的检查过（false = 零事件，面板必须显示空态而不是一条灰管线）。 */
  readonly checked: boolean
  readonly nodes: readonly MotionNodeProjection[]
  readonly externals: readonly MotionNodeProjection[]
  /** 上一个真实转移（null = 无转移可画，面板不得自作主张点亮主线边）。 */
  readonly hotEdge: { readonly from: string; readonly to: string } | null
  /** 每条返工边的真实触发次数（0 = 画灰边，不画红）。 */
  readonly reworkCounts: Readonly<Record<string, number>>
  readonly counts: {
    readonly events: number
    readonly evidence: number
    readonly generated: number
    readonly gates: number
    readonly passed: number
    readonly reworks: number
    readonly accepts: number
    readonly errors: number
    /** 去重后的 chapterId 个数（事件没带 chapterId 时为 0，不猜）。 */
    readonly chapters: number
  }
  readonly log: readonly MotionLogEntry[]
}

/** 主控轨迹工具名 → 管线阶段（只映射白名单工具，未知工具名不落节点）。 */
const TOOL_TO_STAGE: Readonly<Record<string, string>> = {
  route_task: "goal",
  read_chapter: "evidence",
  list_chapters: "evidence",
  search_chapters: "evidence",
  read_memory: "evidence",
  list_memories: "evidence",
  read_deduction: "evidence",
  list_deductions: "evidence",
  load_context: "evidence",
  read_outline: "outline",
  list_outlines: "outline",
  read_outline_history: "outline",
  write_chapter: "draft",
  score_chapter: "self-gate",
  revise_chapter: "revise",
  run_chapter_workflow: "draft",
}

/** 运行事件 → 管线阶段（`null` = 映射不上，只进计数与 log）。 */
function eventToStage(event: Pick<RunEvent, "kind" | "actor">): string | null {
  switch (event.kind) {
    case "retrieval":
      return "evidence"
    case "generate":
      return "draft"
    case "gate-run":
      // 自检门与审稿门都是 gate-run：critic 执行的质量门落自检门，其余落审稿门。
      return event.actor === "critic" ? "self-gate" : "review-gate"
    case "retry":
      return "revise"
    case "accept":
      return "ingest"
    case "stage":
      // 异质事件（子门/告警/质量迭代中间态）：不猜，一律不落节点。
      return null
    case "kb-rebuild":
      return "knowledge-base"
    case "quota":
      return "model-router"
    case "error":
      return null
    default:
      return null
  }
}

function eventTone(event: Pick<RunEvent, "kind" | "payload">): MotionLogEntry["tone"] {
  if (event.kind === "retry") return "rework"
  if (event.kind === "error") return "error"
  if (event.kind === "accept") return "pass"
  if (event.kind === "gate-run") {
    // 生产三门用 status（pass/fail/skipped），质量迭代纯函数用 pass；
    // R-04：只有明确通过才显示通过，skipped/未知一律 info（未评估）。
    if (isGateFail(event.payload)) return "rework"
    if (isGatePass(event.payload)) return "pass"
    return "info"
  }
  return "info"
}

type GatePayload = { pass?: unknown; status?: unknown } | undefined

function isGatePass(payload: Pick<RunEvent, "payload">["payload"]): boolean {
  const record = payload as GatePayload
  return record?.pass === true || record?.status === "pass"
}

function isGateFail(payload: Pick<RunEvent, "payload">["payload"]): boolean {
  const record = payload as GatePayload
  return record?.pass === false || record?.status === "fail"
}

/** gate-run 的 log 摘要：带门名与结果（`system · gate consistency=fail`），缺栏位不编。 */
function gateSummary(payload: Pick<RunEvent, "payload">["payload"]): string {
  const record = (payload ?? {}) as Record<string, unknown>
  const gate = typeof record.gate === "string" && record.gate.length > 0 ? record.gate : "gate"
  // skipped 是明确裁定（未评估），不得写成 unknown。
  const result = isGatePass(payload) ? "pass" : isGateFail(payload) ? "fail" : record.status === "skipped" ? "skipped" : "unknown"
  return `${gate}=${result}`
}

/** log 上限：串流只保留最近 N 条，不把整本账本塞进面板。 */
const LOG_LIMIT = 30

export interface PipelineMotionInput {
  readonly events?: readonly RunEvent[]
  readonly traceEntries?: readonly Pick<TraceEntry, "name" | "title" | "status" | "startedAt">[]
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * 投影管线运动状态。纯函数：同输入必得同输出；不 IO、不读时钟。
 */
export function projectPipelineMotion(input: PipelineMotionInput): PipelineMotionProjection {
  const events = input.events ?? []
  const traceEntries = input.traceEntries ?? []

  const emptyCounts = {
    events: 0,
    evidence: 0,
    generated: 0,
    gates: 0,
    passed: 0,
    reworks: 0,
    accepts: 0,
    errors: 0,
    chapters: 0,
  }
  if (events.length === 0 && traceEntries.length === 0) {
    const idle = (stage: MotionStage): MotionNodeProjection => ({
      id: stage.id,
      label: stage.label,
      kind: stage.kind,
      state: "idle",
      lastTs: null,
    })
    return {
      checked: false,
      nodes: PIPELINE_STAGES.map(idle),
      externals: EXTERNAL_NODES.map(idle),
      hotEdge: null,
      reworkCounts: {
        "revise->draft": 0,
        "review-gate->revise": 0,
        "self-gate->revise": 0,
      },
      counts: emptyCounts,
      log: [],
    }
  }

  const visited = new Map<string, string>()
  const log: MotionLogEntry[] = []
  const counts = { ...emptyCounts, events: events.length }
  const chapters = new Set<number>()
  let reworkToDraft = 0
  let reviewGateFailed = 0
  let selfGateFailed = 0
  let failedGates = 0
  let lastStage: string | null = null
  let prevStage: string | null = null

  const touch = (stageId: string | null, ts: string): void => {
    if (!stageId) return
    visited.set(stageId, ts)
    // prevStage 只记「上一个不同的映射阶段」：同阶段连击不算转移。
    if (lastStage !== null && stageId !== lastStage) prevStage = lastStage
    lastStage = stageId
  }

  for (const event of events) {
    const stageId = eventToStage(event)
    touch(stageId, event.ts)
    if (typeof event.chapterId === "number") chapters.add(event.chapterId)
    // 模型路由只认 quota 事件：门事件记下的 modelId 只是路由证据，不是路由跳。
    const payload = event.payload as Record<string, unknown> | undefined
    switch (event.kind) {
      case "retrieval":
        counts.evidence += 1
        break
      case "generate":
        counts.generated += 1
        break
      case "gate-run":
        counts.gates += 1
        if (isGatePass(event.payload)) counts.passed += 1
        // 失败按 actor 归因：critic 的门是自检门，其余（含生产三门 system）是审稿门。
        if (isGateFail(event.payload)) {
          failedGates += 1
          if (event.actor === "critic") selfGateFailed += 1
          else reviewGateFailed += 1
        }
        break
      case "retry":
        counts.reworks += 1
        reworkToDraft += 1
        break
      case "accept":
        counts.accepts += 1
        break
      case "error":
        counts.errors += 1
        break
      default:
        break
    }
    // 返工统计 = retry 事件数＋失败门数：红边亮而数字为 0 是自相矛盾，故合并（循环外一次）。
    const summary =
      event.kind === "gate-run"
        ? gateSummary(event.payload)
        : payload && hasOwn(payload, "stopReason")
          ? String(payload.stopReason ?? event.kind)
          : event.kind
    log.push({ ts: event.ts, label: `${event.actor} · ${summary}`, tone: eventTone(event) })
  }

  for (const entry of traceEntries) {
    // 未完成的轨迹（running/error）不算走过：标 visited 就是编造。
    if (entry.status !== "done") continue
    const stageId = hasOwn(TOOL_TO_STAGE, entry.name) ? TOOL_TO_STAGE[entry.name] : null
    // 轨迹条目只补 visited，不抢 current（current 永远属于最后一个账本事件）。
    if (stageId && stageId !== lastStage && !visited.has(stageId)) visited.set(stageId, "")
  }

  counts.chapters = chapters.size
  // 返工统计 = retry 事件数＋失败门数：红边亮而数字为 0 是自相矛盾，故合并。
  counts.reworks += failedGates

  const build = (stage: MotionStage): MotionNodeProjection => ({
    id: stage.id,
    label: stage.label,
    kind: stage.kind,
    state: stage.id === lastStage ? "current" : visited.has(stage.id) ? "visited" : "idle",
    lastTs: visited.get(stage.id) || null,
  })

  return {
    checked: true,
    nodes: PIPELINE_STAGES.map(build),
    externals: EXTERNAL_NODES.map(build),
    // 热边 = 上一个真实转移（prevStage→lastStage）：跳跃经过的中间节点不点亮。
    hotEdge: lastStage !== null && prevStage !== null ? { from: prevStage, to: lastStage } : null,
    reworkCounts: {
      "revise->draft": reworkToDraft,
      "review-gate->revise": reviewGateFailed,
      "self-gate->revise": selfGateFailed,
    },
    counts,
    log: log.slice(-LOG_LIMIT),
  }
}
