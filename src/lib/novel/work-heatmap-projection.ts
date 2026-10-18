/**
 * work-heatmap-projection.ts — 动态工作热力图（**只读投影**）。
 *
 * 用户诉求：「动态热力图，实时展示当前工作状态、工作进度、数据是怎么被处理的」。
 *
 * 真源（唯一，无第二真源）：
 *   `.novel/status.json` 的 `stage_metrics`（`StageMetricEntry[]`：stage / tokenCost /
 *   latencyMs / partial / chapterId / timestamp，见 `novel-session-status.ts:221-233`）
 *   + 顶层 `status` / `active_step_index` / `updated_at`（当前进度指针）。
 *
 * 为什么不做「按章节热力」：章节维度只有 `chapterId?`，多数条目没有值；
 * 缺真源的维度一律显式 N/A（`notApplicable`），不拿别的字段顶替。
 *
 * 机械层纪律（与本仓既有投影一致）：
 *   - 纯函数、零 IO、零时钟（`now` 由调用方注入）、零模型调用；
 *   - 确定性：时间分桶按注入的 `now` + 固定桶宽推导，行/列按码点升序；
 *   - 无真源 → 空数组 + 逐条中文 N/A，绝不造 0 行假装统计过；
 *   - 无时间戳的条目**不静默丢弃**：进 `undated`（按 stage 计数）并给 N/A 说明。
 *
 * @license MIT © Niko Buddy
 */

import type { StageMetricEntry } from "./novel-session-status"

/** 时间桶宽度（毫秒）。默认 1 小时：一次写作会话通常跨数小时。 */
export const WORK_HEATMAP_DEFAULT_BUCKET_MS = 60 * 60 * 1000

/** 最多保留的时间桶数（更早的条目折叠进 `foldedCount`，不静默丢）。 */
export const WORK_HEATMAP_MAX_BUCKETS = 24

/** 缺真源时给出的中文 N/A 说明（面板直接渲染，不猜）。 */
export const WORK_HEATMAP_NOT_APPLICABLE = [
  {
    id: "chapter-axis",
    label: "按章节热力",
    reason: "`stage_metrics.chapterId` 是可选字段，多数阶段不写入；章节维度没有真源，不做「按章热力」。",
  },
  {
    id: "live-stream",
    label: "实时事件流",
    reason: "status.json 只存聚合后的阶段指标，没有逐事件流；本图按刷新周期重读快照，不声称流式。",
  },
  {
    id: "quality-score",
    label: "质量/文学分",
    reason: "stage_metrics 只有 tokenCost / latencyMs / partial，没有质量分真源；不把耗时当质量。",
  },
] as const;

/** 一个时间桶。 */
export interface WorkHeatmapBucket {
  /** 桶起点（ISO，UTC）。 */
  readonly start: string
  /** 桶终点（ISO，UTC，开区间）。 */
  readonly end: string
  /** 展示标签：桶**真实起点**的 UTC `HH:mmZ`（不谎报成整点）。 */
  readonly label: string
}

/** 一格：某 stage 在某时间桶内的聚合。 */
export interface WorkHeatmapCell {
  readonly stage: string
  readonly bucketIndex: number
  /** 条目数（>0 才有格子）。 */
  readonly count: number
  /** 这些条目的 token 之和；全部条目都没有 tokenCost → null（不是 0）。 */
  readonly tokenCost: number | null
  /** 这些条目的耗时之和；全部条目都没有 latencyMs → null。 */
  readonly latencyMs: number | null
  /** 其中 partial=true 的条目数。 */
  readonly partialCount: number
}

/** 一行：一个 stage 在全部时间桶上的分布。 */
export interface WorkHeatmapRow {
  readonly stage: string
  /** 与 `buckets` 等长；无数据的桶 count=0。 */
  readonly cells: readonly WorkHeatmapCell[]
  readonly count: number
  readonly tokenCost: number | null
  readonly latencyMs: number | null
  readonly partialCount: number
}

/** 当前进度指针（来自 status.json 顶层，缺则全 null）。 */
export interface WorkHeatmapProgress {
  readonly status: string | null
  readonly activeStepIndex: number | null
  readonly updatedAt: string | null
  readonly currentChapterNumber: number | null
}

/** 只读投影结果。 */
export interface WorkHeatmapProjection {
  /** 时间桶（升序）。无时间戳条目为 0 时可能为空数组。 */
  readonly buckets: readonly WorkHeatmapBucket[]
  /** 行（stage 码点升序）。 */
  readonly rows: readonly WorkHeatmapRow[]
  /** 进度指针。 */
  readonly progress: WorkHeatmapProgress
  /** 全图最大格子计数（渲染色阶用；无数据 → 0）。 */
  readonly maxCount: number
  /** 无时间戳的条目按 stage 计数（码点升序）；空数组 = 没有这类条目。 */
  readonly undated: readonly { readonly stage: string; readonly count: number }[]
  /** 因超过 `WORK_HEATMAP_MAX_BUCKETS` 而折叠的条目数（0 = 没有折叠）。 */
  /** 落在窗口之前（早于 windowStart）的条目数。 */
  readonly foldedCount: number
  /** 晚于 anchor 的条目数（`now` 早于部分条目时出现）。 */
  readonly foldedNewerCount: number
  readonly totals: {
    readonly entries: number
    readonly stages: number
    readonly buckets: number
    readonly partialCount: number
  }
  /** 缺哪些真源（面板据此渲染显式 N/A）。 */
  readonly missingSources: readonly string[]
  /** 明确不适用的维度（不是缺失，而是按语义没有真源/无意义）。 */
  readonly notApplicable: readonly { readonly id: string; readonly label: string; readonly reason: string }[]
}

/** 投影输入：status.json 的相关子集（结构上兼容完整 `NovelSessionStatus`）。 */
export interface WorkHeatmapInput {
  readonly status?: string | null
  readonly activeStepIndex?: number | null
  readonly updatedAt?: string | null
  readonly currentChapterNumber?: number | null
  readonly stageMetrics?: readonly StageMetricEntry[] | null
}

export interface WorkHeatmapOptions {
  /** 注入「现在」（毫秒时间戳）；缺省 = 用条目里最大的时间戳（保证纯函数可测）。 */
  readonly now?: number | null
  readonly bucketMs?: number
  readonly maxBuckets?: number
}

function codePointCompare(a: string, b: string): number {
  if (a === b) return 0
  const ax = Array.from(a)
  const bx = Array.from(b)
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i += 1) {
    const d = (ax[i]?.codePointAt(0) ?? 0) - (bx[i]?.codePointAt(0) ?? 0)
    if (d !== 0) return d
  }
  return ax.length - bx.length
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 解析时间戳：支持 ISO 字符串与毫秒数；非法/缺失 → null（不猜成 0）。 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string" || value.trim() === "") return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function bucketLabel(ms: number, withDate: boolean): string {
  // 纯展示：UTC + 真实分钟（不把 09:37 的桶标成 09:00）。
  // 窗口跨日时带 `MM-DD `，否则 24h 窗口里两天的同一时刻会撞标签。
  const d = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  const date = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
  return withDate ? `${date} ${hh}:${mm}Z` : `${hh}:${mm}Z`
}

/**
 * 投影某项目的阶段工作热力。
 *
 * 分桶规则（确定性）：
 *   anchor = options.now ?? max(timestamps)；只保留 [anchor - maxBuckets*bucketMs, anchor] 内的条目，
 *   越界条目计入 `foldedCount`（不静默丢）。桶按 anchor 对齐向过去切分。
 */
export function projectWorkHeatmap(
  input: WorkHeatmapInput = {},
  options: WorkHeatmapOptions = {},
): WorkHeatmapProjection {
  const bucketMs = Math.max(1, options.bucketMs ?? WORK_HEATMAP_DEFAULT_BUCKET_MS)
  const maxBuckets = Math.max(1, options.maxBuckets ?? WORK_HEATMAP_MAX_BUCKETS)
  const metrics = Array.isArray(input.stageMetrics) ? input.stageMetrics : []
  const progress: WorkHeatmapProgress = {
    status: typeof input.status === "string" && input.status ? input.status : null,
    activeStepIndex: asFiniteNumber(input.activeStepIndex),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : null,
    currentChapterNumber: asFiniteNumber(input.currentChapterNumber),
  }

  const missingSources: string[] = []
  if (metrics.length === 0) {
    missingSources.push(
      "`.novel/status.json` 的 `stage_metrics`（无条目：要么还没跑过带指标的阶段，要么是真源未写入）",
    )
  }

  // 1) 时间戳解析
  const dated: { entry: StageMetricEntry; at: number; stage: string }[] = []
  const undatedByStage = new Map<string, number>()
  for (const entry of metrics) {
    const stage = typeof entry?.stage === "string" && entry.stage ? entry.stage : "(未命名阶段)"
    const at = parseTimestamp((entry as { timestamp?: unknown })?.timestamp)
    if (at === null) {
      undatedByStage.set(stage, (undatedByStage.get(stage) ?? 0) + 1)
      continue
    }
    dated.push({ entry, at, stage })
  }
  if (dated.length === 0 && metrics.length > 0) {
    missingSources.push("`stage_metrics[].timestamp`（条目存在但没有一条带可解析时间戳 → 画不出时间轴）")
  }

  // 2) anchor 与时间桶
  const maxTs = dated.reduce((acc, cur) => (cur.at > acc ? cur.at : acc), -Infinity)
  const anchor = options.now ?? (Number.isFinite(maxTs) ? maxTs : null)
  const windowStart = anchor === null ? null : anchor - maxBuckets * bucketMs

  const anchorMs = anchor ?? null
  // 左端点闭区间、右端点闭区间：[windowStart, anchor]（与上方分桶规则一致）。
  const inWindow =
    anchorMs === null || windowStart === null
      ? []
      : dated.filter((d) => d.at >= windowStart && d.at <= anchorMs)
  const foldedCount =
    anchorMs === null || windowStart === null ? 0 : dated.filter((d) => d.at < windowStart).length
  const foldedNewerCount = anchorMs === null ? 0 : dated.filter((d) => d.at > anchorMs).length

  const bucketCount = inWindow.length === 0 || anchor === null ? 0 : maxBuckets
  const buckets: WorkHeatmapBucket[] = []
  if (anchor !== null && bucketCount > 0) {
    const windowSpanMs = bucketCount * bucketMs
    const crossesDay = windowSpanMs >= 24 * 60 * 60 * 1000
    for (let i = 0; i < bucketCount; i += 1) {
      const start = anchor - (bucketCount - i) * bucketMs
      const end = start + bucketMs
      buckets.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        label: bucketLabel(start, crossesDay),
      })
    }
  }
  const windowMinutes = Math.round(bucketMs / 60000)
  if (foldedCount > 0) {
    missingSources.push(
      `有 ${foldedCount} 条阶段指标**早于**最近 ${maxBuckets} × ${windowMinutes} 分钟窗口，已折叠（不是不存在，只是图上不画）`,
    )
  }
  if (foldedNewerCount > 0) {
    missingSources.push(
      `有 ${foldedNewerCount} 条阶段指标的时间戳**晚于**锚点（锚点由调用方 now 指定），未画进窗口`,
    )
  }

  // 3) 聚合到 (stage, bucket)
  const stageSet = new Set<string>()
  for (const item of inWindow) stageSet.add(item.stage)
  const acc = new Map<string, { count: number; token: number | null; latency: number | null; partial: number }>()
  const key = (stage: string, idx: number) => `${stage}\u0000${idx}`
  for (const item of inWindow) {
    if (anchor === null) break
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((item.at - (anchor - bucketCount * bucketMs)) / bucketMs)),
    )
    const k = key(item.stage, idx)
    const cur = acc.get(k) ?? { count: 0, token: null, latency: null, partial: 0 }
    cur.count += 1
    const token = asFiniteNumber(item.entry?.tokenCost)
    if (token !== null) cur.token = (cur.token ?? 0) + token
    const latency = asFiniteNumber(item.entry?.latencyMs)
    if (latency !== null) cur.latency = (cur.latency ?? 0) + latency
    if (item.entry?.partial === true) cur.partial += 1
    acc.set(k, cur)
  }

  const stages = [...stageSet].sort(codePointCompare)
  const rows: WorkHeatmapRow[] = stages.map((stage) => {
    const cells: WorkHeatmapCell[] = buckets.map((_, idx) => {
      const hit = acc.get(key(stage, idx))
      return {
        stage,
        bucketIndex: idx,
        count: hit?.count ?? 0,
        tokenCost: hit?.token ?? null,
        latencyMs: hit?.latency ?? null,
        partialCount: hit?.partial ?? 0,
      }
    })
    const rowToken = cells.reduce<number | null>(
      (sum, c) => (c.tokenCost === null ? sum : (sum ?? 0) + c.tokenCost),
      null,
    )
    const rowLatency = cells.reduce<number | null>(
      (sum, c) => (c.latencyMs === null ? sum : (sum ?? 0) + c.latencyMs),
      null,
    )
    return {
      stage,
      cells,
      count: cells.reduce((sum, c) => sum + c.count, 0),
      tokenCost: rowToken,
      latencyMs: rowLatency,
      partialCount: cells.reduce((sum, c) => sum + c.partialCount, 0),
    }
  })

  const maxCount = rows.reduce((m, row) => row.cells.reduce((mm, c) => Math.max(mm, c.count), m), 0)
  const undated = [...undatedByStage.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => codePointCompare(a.stage, b.stage))

  if (undated.length > 0) {
    missingSources.push(
      `有 ${undated.reduce((s, u) => s + u.count, 0)} 条阶段指标没有可解析时间戳（已按阶段单独汇总，不进时间轴）`,
    )
  }

  return {
    buckets,
    rows,
    progress,
    maxCount,
    undated,
    foldedCount,
    foldedNewerCount,
    totals: {
      entries: metrics.length,
      stages: rows.length,
      buckets: buckets.length,
      partialCount: rows.reduce((s, r) => s + r.partialCount, 0),
    },
    missingSources,
    notApplicable: WORK_HEATMAP_NOT_APPLICABLE.map((item) => ({ ...item })),
  }
}

/** 装载器签名：面板注入用（真实实现读 `.novel/status.json`）。 */
export type WorkHeatmapLoader = (projectPath: string) => Promise<WorkHeatmapInput | null>

/**
 * 从 `NovelSessionStatus` 取出热力图输入（窄化，避免面板耦合整份会话状态）。
 * `status === null` → null（面板渲染显式空态，不造空图）。
 */
export function toWorkHeatmapInput(status: {
  status?: unknown
  active_step_index?: unknown
  updated_at?: unknown
  current_task?: { chapter_number?: unknown } | null
  stage_metrics?: readonly StageMetricEntry[] | null
} | null): WorkHeatmapInput | null {
  if (!status) return null
  const chapterNumber =
    status.current_task && typeof status.current_task === "object"
      ? asFiniteNumber(status.current_task.chapter_number)
      : null
  return {
    status: typeof status.status === "string" ? status.status : null,
    activeStepIndex: asFiniteNumber(status.active_step_index),
    updatedAt: typeof status.updated_at === "string" ? status.updated_at : null,
    currentChapterNumber: chapterNumber,
    stageMetrics: Array.isArray(status.stage_metrics) ? status.stage_metrics : [],
  }
}
