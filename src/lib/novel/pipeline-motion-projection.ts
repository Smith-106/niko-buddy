// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-projection.ts — 「管線動態」視圖的純函數投影層。
 *
 * 解決的問題：運動熱力圖原本只有靜態模組接線圖，看不見「工作正跑到哪一步」。
 * 本模組把 append-only 的運行事件（run-event-ledger + 主控軌跡）投影成一條
 * 縱向寫作管線的節點狀態：目標 → 取證 → 大綱 → 章綱 → 正文 → 自檢門 →
 * 審稿 → 審稿門 → 返修 → 入庫 → 交付 → 回流 → 復盤。
 *
 * 三條硬口徑：
 *   1. **只跟真實事件**：藍色「當前路徑」= 最後一個能映射到階段的事件，
 *      沒有事件也沒有軌跡條目才是空態（`checked: false`），絕不編假路徑、絕不做裝飾動畫。
 *   2. **映射只用事件自帶的欄位**（kind / actor / payload.pass /
 *      工具名），不猜語義；映射不上的事件只進計數與 log，不落節點。
 *      特別是 `stage`：賬本裡的 stage 是異質事件（子門/告警/質量迭代
 *      中間態），一律當正文就是編造，故一律不落節點。
 *   3. **紅色返工回路只計真實返工**：`retry` 事件計入 返修→正文
 *      （事件計數，未驗證後續真有正文事件）；`gate-run` 且 `pass === false`
 *      按 actor 歸因：critic 的失敗計入 自檢門→返修，其餘計入 審稿門→返修。
 */

import type { RunEvent } from "./run-event-ledger"
import type { TraceEntry } from "./main-control-trace"

// ── 管線定義 ───────────────────────────────────────────────────────────────────

/** 節點種類：stage=直通階段，decision=◆ 決策菱形，terminal=終點。 */
export type MotionNodeKind = "stage" | "decision" | "terminal"

export interface MotionStage {
  readonly id: string
  readonly label: string
  readonly kind: MotionNodeKind
}

export const PIPELINE_STAGES: readonly MotionStage[] = [
  { id: "goal", label: "目標", kind: "stage" },
  { id: "evidence", label: "取證", kind: "stage" },
  { id: "outline", label: "大綱", kind: "stage" },
  { id: "chapter-plan", label: "章綱", kind: "stage" },
  { id: "draft", label: "正文", kind: "stage" },
  { id: "self-gate", label: "自檢門", kind: "decision" },
  { id: "review", label: "審稿", kind: "stage" },
  { id: "review-gate", label: "審稿門", kind: "decision" },
  { id: "revise", label: "返修", kind: "stage" },
  { id: "ingest", label: "入庫", kind: "stage" },
  { id: "deliver", label: "交付", kind: "stage" },
  { id: "reflow", label: "回流", kind: "stage" },
  { id: "retrospective", label: "復盤", kind: "terminal" },
]

/** 黃色外部依賴側節點：只在事件真的提到它們時才點亮。 */
export const EXTERNAL_NODES: readonly MotionStage[] = [
  { id: "model-router", label: "模型路由", kind: "stage" },
  { id: "knowledge-base", label: "知識庫", kind: "stage" },
]

export interface ReworkEdge {
  readonly from: string
  readonly to: string
  readonly label: string
}

/** 紅色返工回路（固定三條，計數來自真實事件）。 */
export const REWORK_EDGES: readonly ReworkEdge[] = [
  { from: "revise", to: "draft", label: "返工" },
  { from: "review-gate", to: "revise", label: "不通過" },
  { from: "self-gate", to: "revise", label: "不通過" },
]

// ── 投影類型 ───────────────────────────────────────────────────────────────────

export type MotionNodeState = "current" | "visited" | "idle"

export interface MotionNodeProjection {
  readonly id: string
  readonly label: string
  readonly kind: MotionNodeKind
  readonly state: MotionNodeState
  /** 最後一次落到本節點的事件時間（ISO 字符串原樣透出，不解析）。 */
  readonly lastTs: string | null
}

export interface MotionLogEntry {
  readonly ts: string
  readonly label: string
  readonly tone: "info" | "pass" | "rework" | "error"
}

export interface PipelineMotionProjection {
  /** 是否真的檢查過（false = 零事件，面板必須顯示空態而不是一條灰管線）。 */
  readonly checked: boolean
  readonly nodes: readonly MotionNodeProjection[]
  readonly externals: readonly MotionNodeProjection[]
  /** 上一個真實轉移（null = 無轉移可畫，面板不得自作主張點亮主線邊）。 */
  readonly hotEdge: { readonly from: string; readonly to: string } | null
  /** 每條返工邊的真實觸發次數（0 = 畫灰邊，不畫紅）。 */
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
    /** 去重後的 chapterId 個數（事件沒帶 chapterId 時為 0，不猜）。 */
    readonly chapters: number
  }
  readonly log: readonly MotionLogEntry[]
}

/** 主控軌跡工具名 → 管線階段（只映射白名單工具，未知工具名不落節點）。 */
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

/** 運行事件 → 管線階段（`null` = 映射不上，只進計數與 log）。 */
function eventToStage(event: Pick<RunEvent, "kind" | "actor">): string | null {
  switch (event.kind) {
    case "retrieval":
      return "evidence"
    case "generate":
      return "draft"
    case "gate-run":
      // 自檢門與審稿門都是 gate-run：critic 執行的質量門落自檢門，其餘落審稿門。
      return event.actor === "critic" ? "self-gate" : "review-gate"
    case "retry":
      return "revise"
    case "accept":
      return "ingest"
    case "stage":
      // 異質事件（子門/告警/質量迭代中間態）：不猜，一律不落節點。
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
    // 生產三門用 status（pass/fail/skipped），質量迭代純函數用 pass；
    // R-04：只有明確通過才顯示通過，skipped/未知一律 info（未評估）。
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

/** gate-run 的 log 摘要：帶門名與結果（`system · gate consistency=fail`），缺欄位不編。 */
function gateSummary(payload: Pick<RunEvent, "payload">["payload"]): string {
  const record = (payload ?? {}) as Record<string, unknown>
  const gate = typeof record.gate === "string" && record.gate.length > 0 ? record.gate : "gate"
  // skipped 是明確裁定（未評估），不得寫成 unknown。
  const result = isGatePass(payload) ? "pass" : isGateFail(payload) ? "fail" : record.status === "skipped" ? "skipped" : "unknown"
  return `${gate}=${result}`
}

/** log 上限：串流只保留最近 N 條，不把整本賬本塞進面板。 */
const LOG_LIMIT = 30

export interface PipelineMotionInput {
  readonly events?: readonly RunEvent[]
  readonly traceEntries?: readonly Pick<TraceEntry, "name" | "title" | "status" | "startedAt">[]
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * 投影管線運動狀態。純函數：同輸入必得同輸出；不 IO、不讀時鐘。
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
    // prevStage 只記「上一個不同的映射階段」：同階段連擊不算轉移。
    if (lastStage !== null && stageId !== lastStage) prevStage = lastStage
    lastStage = stageId
  }

  for (const event of events) {
    const stageId = eventToStage(event)
    touch(stageId, event.ts)
    if (typeof event.chapterId === "number") chapters.add(event.chapterId)
    // 模型路由只認 quota 事件：門事件記下的 modelId 只是路由證據，不是路由跳。
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
        // 失敗按 actor 歸因：critic 的門是自檢門，其餘（含生產三門 system）是審稿門。
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
    // 返工統計 = retry 事件數＋失敗門數：紅邊亮而數字為 0 是自相矛盾，故合併（循環外一次）。
    const summary =
      event.kind === "gate-run"
        ? gateSummary(event.payload)
        : payload && hasOwn(payload, "stopReason")
          ? String(payload.stopReason ?? event.kind)
          : event.kind
    log.push({ ts: event.ts, label: `${event.actor} · ${summary}`, tone: eventTone(event) })
  }

  for (const entry of traceEntries) {
    // 未完成的軌跡（running/error）不算走過：標 visited 就是編造。
    if (entry.status !== "done") continue
    const stageId = hasOwn(TOOL_TO_STAGE, entry.name) ? TOOL_TO_STAGE[entry.name] : null
    // 軌跡條目只補 visited，不搶 current（current 永遠屬於最後一個賬本事件）。
    if (stageId && stageId !== lastStage && !visited.has(stageId)) visited.set(stageId, "")
  }

  counts.chapters = chapters.size
  // 返工統計 = retry 事件數＋失敗門數：紅邊亮而數字為 0 是自相矛盾，故合併。
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
    // 熱邊 = 上一個真實轉移（prevStage→lastStage）：跳躍經過的中間節點不點亮。
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
