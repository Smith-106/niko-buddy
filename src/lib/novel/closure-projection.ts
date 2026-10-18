/**
 * Closure 级叙事结构面 —— 只读投影（EPIC「Closure 级叙事结构面」第一切片）。
 *
 * 定位：把三个**已经存在**的真源投影成确定性只读表格（信息差 / 世界事件 / 涟漪），
 * **零新真源**——不新建状态文件、不写盘、不调 LLM、不改任何既有真源。
 *
 * 真源（全部既有；本模块只读）：
 * - `.novel/narrative-state.json`（`narrative-state.ts` 的 `NarrativeStateStore`）
 *   → `declarations` + `visibilities` = **信息差**（谁在何时知道什么，MIG-003 视角可见性）；
 *   → `events` = **世界事件**（故事时间级 birth/death/change 事件日志）；
 *   → `events[].causedBy` = **涟漪**（事件的下游后果，沿因果链派生，非新真源）。
 * - `.novel/timeline.json`（`timeline.ts` 的 `TimelineEntry[]`）
 *   → **世界事件**（章级事件：章号 + 事件文本）。
 *
 * 诚实边界（缺真源一律 `null` / 空数组 + `missingSources` 中文理由，不估算、不造 0）：
 * - `narrative-state.json` **没有章号字段**（只有 `storyTime` 字符串）→ 由它派生的行
 *   `chapterNumber` 恒 `null`；`timeline.json` **没有故事时间**→ 由它派生的行
 *   `storyTime` 恒 `null`。`null` = 无真源，**不是** 0 / 空串。
 * - **涟漪没有独立真源文件**：本投影只沿 `events[].causedBy` 派生「直接下游」计数，
 *   不做传递闭包、不猜语义。事件日志里没有任何 `causedBy` → 涟漪为空数组并逐条 N/A。
 * - 空真源 → 空数组（不造 0 行假装统计过）。
 */

import { normalizePath } from "@/lib/path-utils"
import {
  isTemporallyCovering,
  loadNarrativeState,
  type NarrativeDeclaration,
  type NarrativeStateStore,
  type VisibilityDeclaration,
} from "./narrative-state"
import { loadTimeline, type TimelineEntry } from "./timeline"

/** 三个结构面（行分类；testid 与分组都按它走）。 */
export type ClosureKind = "info-gap" | "world-event" | "ripple"

/** 真源文件路径（可追溯；本投影不新建真源）。 */
export const CLOSURE_SOURCE_NARRATIVE = ".novel/narrative-state.json"
export const CLOSURE_SOURCE_TIMELINE = ".novel/timeline.json"

/** 码点稳定比较（**不用** `localeCompare`：locale/ICU 会影响顺序，投影必须可复现）。 */
function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 非空文本，否则 `null`（缺文本 ≠ 空串）。 */
function asText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 章号归一：仅保留有限数字，缺失/NaN/非数字一律 `null`（缺失 ≠ 第 0 章）。 */
function asChapter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 去重 + 码点升序（投影确定性）。 */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoint)
}

/**
 * 事件日志记录（复用 `NarrativeStateStore.events` 的元素类型，不另造类型）。
 */
export type ClosureEventRecord = NarrativeStateStore["events"][number]

/**
 * 注入用的 narrative-state 子集（结构上兼容完整 `NarrativeStateStore`，
 * 便于 spec 只给需要的那部分；缺省字段按「无真源」处理）。
 */
export interface ClosureNarrativeInput {
  readonly declarations?: readonly NarrativeDeclaration[] | null
  readonly visibilities?: readonly VisibilityDeclaration[] | null
  readonly events?: readonly ClosureEventRecord[] | null
}

/** `projectClosureState` 的输入（缺省 = 空真源 → 全空 + 逐条 N/A）。 */
export interface ClosureSources {
  /** narrative-state 真源（信息差 + 故事时间级世界事件 + 涟漪）。 */
  readonly narrativeState?: ClosureNarrativeInput | null
  /** timeline 真源（章级世界事件）。 */
  readonly timelineEntries?: readonly TimelineEntry[] | null
}

/** 一行只读投影（三个结构面共用一个行形状；与真源无关的字段恒 `null`）。 */
export interface ClosureRow {
  /** 行 id（来自真源 id / 确定性合成：`timeline:<章号>:<事件>`、`event:<事件id>`、`ripple:<事件id>`、`<声明id>`）。 */
  readonly id: string
  /** 结构面分类。 */
  readonly kind: ClosureKind
  /** 真源文件（可追溯；不是新真源）。 */
  readonly source: string
  /** 主标签（真源文本；真源无文本 → 回退到 id，不编造）。 */
  readonly label: string
  /** 详情文本（真源无 → `null`；UI 显式 N/A）。 */
  readonly detail: string | null
  /** 认识论模态（仅信息差真源有 `fact`/`belief`/`hypothesis`；其它 → `null`）。 */
  readonly modality: string | null
  /** 章号（仅 `timeline.json` 有；其它真源 → `null`，不写 0）。 */
  readonly chapterNumber: number | null
  /** 故事时间（仅 `narrative-state.json` 有；其它真源 → `null`）。 */
  readonly storyTime: string | null
  /** 关联 id（码点升序）：信息差 = 可见性角色 id；世界事件 = `causedBy`；涟漪 = 下游事件 id。 */
  readonly relatedIds: readonly string[]
  /** 信息差：已知角色数（去重）；非信息差行 → `null`。 */
  readonly knownCount: number | null
  /** 信息差：未知角色数（去重）；非信息差行 → `null`。 */
  readonly unknownCount: number | null
  /** 涟漪：直接下游事件数；非涟漪行 → `null`。 */
  readonly consequenceCount: number | null
}

/** 三个结构面的只读投影结果。 */
export interface ClosureProjection {
  /** 信息差行（按声明 id 码点升序）。空真源 → 空数组。 */
  readonly infoGaps: readonly ClosureRow[]
  /** 世界事件行（章号升序 → 故事时间 → id 码点升序）。空真源 → 空数组。 */
  readonly worldEvents: readonly ClosureRow[]
  /** 涟漪行（按 id 码点升序）。无 `causedBy` 因果链 → 空数组。 */
  readonly ripples: readonly ClosureRow[]
  /** 缺真源清单（中文理由）；真源齐备 → 空数组。 */
  readonly missingSources: readonly string[]
}

/** 世界事件排序：有章号优先（章号升序）→ 故事时间 → id 码点。确定性、可复现。 */
function compareWorldEvent(a: ClosureRow, b: ClosureRow): number {
  if (a.chapterNumber !== null && b.chapterNumber === null) return -1
  if (a.chapterNumber === null && b.chapterNumber !== null) return 1
  if (a.chapterNumber !== null && b.chapterNumber !== null && a.chapterNumber !== b.chapterNumber) {
    return a.chapterNumber - b.chapterNumber
  }
  return compareCodePoint(a.storyTime ?? "", b.storyTime ?? "") || compareCodePoint(a.id, b.id)
}

/** 信息差行：一条声明 + 它的可见性（已知/未知角色）。 */
function toInfoGapRow(
  decl: NarrativeDeclaration,
  visibilities: readonly VisibilityDeclaration[],
): ClosureRow {
  // 时态口径与 `narrative-state.isTemporallyCovering` 对齐：只在声明生效时刻
  // （`decl.validFrom`）仍持有该可见性的角色才算「已知 / 未知」；已撤销（validTo 闭合
  // 早于该时刻）的记录不再计入，避免同一角色既算已知又算未知。
  const at = asText(decl.validFrom) ?? ""
  const mine = visibilities.filter(
    (v) => v.declarationId === decl.declarationId && (at === "" || isTemporallyCovering(v.validFrom, v.validTo, at)),
  )
  const known = sortedUnique(mine.filter((v) => v.state === "known").map((v) => v.characterId))
  const unknown = sortedUnique(mine.filter((v) => v.state === "unknown").map((v) => v.characterId))
  const entity = asText(decl.entityId)
  const property = asText(decl.property)
  const label = entity && property ? `${entity}.${property}` : entity ?? property ?? decl.declarationId
  return {
    id: decl.declarationId,
    kind: "info-gap",
    source: CLOSURE_SOURCE_NARRATIVE,
    label,
    detail: asText(decl.description),
    modality: asText(decl.modality),
    // narrative-state 声明没有章号字段 → 章号恒 null；故事时间取声明的 `validFrom`
    // （真源没有独立 storyTime 字段，这里如实标注是 validFrom，不冒充叙事时刻）。
    chapterNumber: null,
    storyTime: asText(decl.validFrom),
    relatedIds: sortedUnique([...known, ...unknown]),
    knownCount: known.length,
    unknownCount: unknown.length,
    consequenceCount: null,
  }
}

/** 世界事件行（章级，来自 timeline.json）。 */
function toTimelineRow(entry: TimelineEntry): ClosureRow {
  const chapterNumber = asChapter(entry.chapterNumber)
  const text = asText(entry.event)
  return {
    id: `timeline:${chapterNumber === null ? "?" : chapterNumber}:${text ?? ""}`,
    kind: "world-event",
    source: CLOSURE_SOURCE_TIMELINE,
    label: text ?? `第 ${chapterNumber === null ? "?" : chapterNumber} 章事件（真源无文本）`,
    detail: null,
    modality: null,
    chapterNumber,
    // timeline.json 没有故事时间字段 → 故事时间恒 null。
    storyTime: null,
    relatedIds: [],
    knownCount: null,
    unknownCount: null,
    consequenceCount: null,
  }
}

/** 世界事件行（故事时间级，来自 narrative-state.json 的 events）。 */
function toNarrativeEventRow(event: ClosureEventRecord): ClosureRow {
  const summary = asText(event.summary)
  return {
    id: `event:${event.eventId}`,
    kind: "world-event",
    source: CLOSURE_SOURCE_NARRATIVE,
    label: summary ?? `${event.type}@${event.entityId}`,
    detail: summary,
    modality: null,
    // narrative-state 事件没有章号字段 → 章号恒 null。
    chapterNumber: null,
    storyTime: asText(event.storyTime),
    relatedIds: event.causedBy ? [event.causedBy] : [],
    knownCount: null,
    unknownCount: null,
    consequenceCount: null,
  }
}

/**
 * 涟漪行：一个事件被多少下游事件 `causedBy` 引用（**直接**下游，不做传递闭包）。
 * 上游事件不在事件日志里（`causedBy` 悬空）时如实标注，不静默丢行。
 */
function toRippleRow(
  upstreamId: string,
  downstreamIds: readonly string[],
  upstream: ClosureEventRecord | undefined,
): ClosureRow {
  const children = sortedUnique(downstreamIds)
  const summary = upstream ? asText(upstream.summary) : null
  return {
    id: `ripple:${upstreamId}`,
    kind: "ripple",
    source: CLOSURE_SOURCE_NARRATIVE,
    label: summary ?? (upstream ? `${upstream.type}@${upstream.entityId}` : upstreamId),
    detail: upstream ? summary : "上游事件不在事件日志中（causedBy 悬空）",
    modality: null,
    chapterNumber: null,
    storyTime: upstream ? asText(upstream.storyTime) : null,
    relatedIds: children,
    knownCount: null,
    unknownCount: null,
    consequenceCount: children.length,
  }
}

/**
 * 纯函数：三个真源子集 → 只读 Closure 投影（不读盘、不写盘、不造字段）。
 * 缺省（`projectClosureState()`）等价于空真源：三个数组为空 + `missingSources` 逐条中文理由。
 */
export function projectClosureState(sources: ClosureSources = {}): ClosureProjection {
  const narrative = sources.narrativeState ?? null
  const timelineEntries = sources.timelineEntries ?? null
  const missingSources: string[] = []

  // ── 信息差（谁在何时知道什么）─────────────────────────────────
  const infoGaps: ClosureRow[] = []
  const declarations = narrative?.declarations ?? []
  const visibilities = narrative?.visibilities ?? []
  if (declarations.length === 0) {
    missingSources.push(
      `信息差：${CLOSURE_SOURCE_NARRATIVE} 的 declarations 为空——没有任何声明，无法判定「谁知道什么」`,
    )
  } else {
    for (const decl of declarations) infoGaps.push(toInfoGapRow(decl, visibilities))
    infoGaps.sort((a, b) => compareCodePoint(a.id, b.id))
  }

  // ── 世界事件（章级 timeline + 故事时间级 narrative-state events）──
  const worldEvents: ClosureRow[] = []
  if (timelineEntries === null || timelineEntries.length === 0) {
    missingSources.push(
      `世界事件：${CLOSURE_SOURCE_TIMELINE} 的 entries 为空——没有章级世界事件可投影`,
    )
  } else {
    for (const entry of timelineEntries) worldEvents.push(toTimelineRow(entry))
  }

  const events = narrative?.events ?? []
  if (events.length === 0) {
    missingSources.push(
      `世界事件（故事时间级）：${CLOSURE_SOURCE_NARRATIVE} 的 events 为空——没有 birth/death/change 事件可投影`,
    )
  } else {
    for (const event of events) worldEvents.push(toNarrativeEventRow(event))
  }
  worldEvents.sort(compareWorldEvent)

  // ── 涟漪（事件的直接下游后果，沿 causedBy 派生）─────────────────
  const ripples: ClosureRow[] = []
  const downstreamByUpstream = new Map<string, string[]>()
  for (const event of events) {
    if (!event.causedBy) continue
    const list = downstreamByUpstream.get(event.causedBy)
    if (list) list.push(event.eventId)
    else downstreamByUpstream.set(event.causedBy, [event.eventId])
  }
  if (downstreamByUpstream.size === 0) {
    missingSources.push(
      `涟漪：${CLOSURE_SOURCE_NARRATIVE} 的 events 里没有任何 causedBy 因果链——无下游后果可派生（不造空行假装有涟漪）`,
    )
  } else {
    const byId = new Map(events.map((event) => [event.eventId, event]))
    for (const [upstreamId, downstreamIds] of downstreamByUpstream) {
      ripples.push(toRippleRow(upstreamId, downstreamIds, byId.get(upstreamId)))
    }
    ripples.sort((a, b) => compareCodePoint(a.id, b.id))
  }

  return { infoGaps, worldEvents, ripples, missingSources }
}

/** 装载器签名（组件默认走它；测试可注入替身）。 */
export type ClosureProjectionLoader = (projectPath: string) => Promise<ClosureProjection>

/**
 * 默认装载：读两个既有真源（`.novel/narrative-state.json` + `.novel/timeline.json`），
 * 纯内存投影。单个真源读失败不拖垮整面板：按「无真源」降级并进 `missingSources`。
 */
export const loadClosureProjection: ClosureProjectionLoader = async (projectPath) => {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const [narrativeState, timeline] = await Promise.all([
    loadNarrativeState(pp).catch(() => null),
    loadTimeline(pp).catch(() => null),
  ])
  return projectClosureState({
    narrativeState,
    timelineEntries: timeline ? timeline.entries : null,
  })
}
