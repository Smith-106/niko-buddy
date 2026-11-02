/**
 * snapshot-scanner.ts — G3：快照扫库 + 范围选择 + 批量提取队列（纯逻辑核 + 薄 IO）。
 *
 * 职责边界（硬约束，勿越界）：
 *   1. 只读 `.novel/snapshots/*.snapshot.json`：本模块**不写**快照、不写正式记忆。
 *      ingestChapter / runOutlineIngestTask 引擎与快照格式一概不动（G3 只做扫库与排队）。
 *   2. 待补判定规则全部落成具名常量（SNAPSHOT_BACKFILL_FIELDS /
 *      SNAPSHOT_BACKFILL_REASONS），扫库判定、UI 文案、
 *      G4 harness 共用同一口径 —— 禁止在 UI / harness 各自散落字符串或数字副本。
 *   3. 批量提取是「两段式」：extract → pending/ready 草稿 → accept 才回填正式记忆
 *      （Draft-first 硬边界）。本模块只提供队列状态机；`completeBatchChapter` 只会
 *      产出 `ready` 草稿，`acceptBatchDraft` 是唯一把草稿推进到 `accepted` 的入口，
 *      且它只接受 `ready` 草稿 —— 任何「提取即直写正式记忆」的路径都违反本不变量。
 *   4. LLM 预算上限（BATCH_EXTRACT_BUDGET_*）在范围选择阶段即强制生效：超限即停并
 *      记账（`skippedByBudget`），缓解 R3（全量重提烧预算 / 失控排队）。
 */
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import type { ChapterSnapshot } from "./chapter-ingest"
import { listSnapshots } from "./chapter-ingest-snapshot-io"
import { snapshotJsonPath } from "./snapshot-paths"

// ──────────────────────────────────────────────────────────────────────────
// 具名常量：扫库口径 / 预算口径 / Draft-first 不变量
// ──────────────────────────────────────────────────────────────────────────

/** 快照目录（相对项目根，与 snapshot-paths 的落盘位置同源）。 */
export const SNAPSHOT_DIR_RELATIVE = ".novel/snapshots" as const

/** 快照文件后缀（与 `snapshotJsonPath` 的 `*.snapshot.json` 命名同源）。 */
export const SNAPSHOT_FILE_SUFFIX = ".snapshot.json" as const

/*
 * 已删除的常量：`SNAPSHOT_FIELD_REVISION`（曾经的「字段版本 = 2」）。
 *
 * 为什么删：`ChapterSnapshot.revision` 是**单调内容修订号**（每次内容重写 +1），
 * 不是字段集版本。拿 `revision < 2` 当「字段不齐」用，会把「字段齐全但内容只修订过
 * 0–1 次」的真实快照误判为待补 → 进入批量提取队列 → 白烧 LLM 预算（恰好放大 R3）。
 *
 * 现行口径：待补只看**可选字段是否缺失**（`SNAPSHOT_BACKFILL_FIELDS`），外加
 * 「旧格式缺 revision 字段」这一个格式信号（`revision_missing`）。
 * 如果将来真的需要字段版本，必须给快照加一个独立的字段版本字段并在写入侧同步，
 * 不得再借用 `revision`。
 */

/**
 * 待补可选字段族（G3 待补清单的唯一真源）。
 *
 * 缺字段（undefined / null；povCharacter 额外把空串视为缺）即待补。
 * 注意：**空数组不算缺** —— 某章确实没有「X 认为…」这类认知事实是合法状态，
 * 若把空数组判成待补，全量扫库会永远把这类章节留在待补清单里（假阳性刷屏）。
 */
export const SNAPSHOT_BACKFILL_FIELDS = ["beliefFacts", "hypothesisFacts", "povCharacter"] as const

/** 待补字段族元素类型。 */
export type SnapshotBackfillField = (typeof SNAPSHOT_BACKFILL_FIELDS)[number]

/** 待补主因码（稳定字面量；UI 经 `extract.batchReason.*` 映射，不直接展示原文）。 */
export const SNAPSHOT_BACKFILL_REASONS = {
  /** 缺可选字段族之一（最常见：旧快照没有 beliefFacts / povCharacter）。 */
  missingOptionalField: "missing_optional_field",
  /** 快照没有 revision 字段（旧格式信号：字段集也往往更旧）。 */
  revisionMissing: "revision_missing",
  /** 快照文件读不出 / JSON 解析失败。 */
  unreadable: "unreadable",
} as const

/** 待补主因码联合类型。 */
export type SnapshotBackfillReason =
  (typeof SNAPSHOT_BACKFILL_REASONS)[keyof typeof SNAPSHOT_BACKFILL_REASONS]

/** 扫库读取并发上限（PAT-IM1：循环内串行 readFile 是 IPC 放大反模式）。 */
export const SNAPSHOT_SCAN_CONCURRENCY = 8 as const

/** 默认范围：仅未提取（= 待补清单）。 */
export const DEFAULT_BATCH_EXTRACT_SCOPE = "missing" as const

/** 全量模式下默认跳过已有完整快照的章节（省 LLM 预算，幂等重跑友好）。 */
export const DEFAULT_BATCH_SKIP_EXISTING = true as const

/** 默认不强制重提：force 才会无视 skipExisting 全量重跑。 */
export const DEFAULT_BATCH_FORCE = false as const

/**
 * 全量模式的 LLM 预算上限（章数，**默认值即配置真源**）。
 *
 * R3 缓解：全量模式强制带上限，超限即停并记账（`skippedByBudget`）。
 * 与 G4 harness 共用本常量 —— harness 断言「UI 声称可跑章数」与「实测口径」一致，
 * 禁止在 UI / harness 各写一份数字副本。
 */
export const BATCH_EXTRACT_BUDGET_DEFAULT = 20 as const

/** 预算硬顶：调用方覆写不得超过，超限按硬顶截断（防「把上限调到无穷」绕过 R3）。 */
export const BATCH_EXTRACT_BUDGET_MAX = 60 as const

/** 预算强制开关（false 仅供未来显式放开；当前恒 true = 全量模式必带预算）。 */
export const BATCH_EXTRACT_BUDGET_ENFORCED = true as const

/**
 * Draft-first 不变量（供 UI / harness 断言用）：提取产出只能停在 `ready` 草稿，
 * 必须经 accept 才回填正式记忆。
 */
export const BATCH_DRAFT_REQUIRES_ACCEPT = true as const

// ──────────────────────────────────────────────────────────────────────────
// D1：扫库 + 待补判定
// ──────────────────────────────────────────────────────────────────────────

/** 待补清单条目：`[{ chapter, reason }]`（外加缺失字段明细，便于 UI 展示）。 */
export interface SnapshotBackfillEntry {
  /** 章号（负数 = 大纲快照；默认扫库不含大纲）。 */
  chapter: number
  /** 主因码（稳定字面量）。 */
  reason: SnapshotBackfillReason
  /** 缺失的可选字段族（reason=missing_optional_field 时非空）。 */
  missingFields: SnapshotBackfillField[]
  /** 快照内容修订号（缺失 → null；**不是**字段版本，不参与待补判定）。 */
  revision: number | null
}

/** 单条快照的完整性判定结果。 */
export interface SnapshotCompleteness {
  complete: boolean
  reason: SnapshotBackfillReason | null
  missingFields: SnapshotBackfillField[]
  revision: number | null
}

/** 扫库结果。 */
export interface SnapshotScanResult {
  /** 扫到的快照条数（= chapters.length）。 */
  total: number
  /** 扫到的全部章号（升序；mode="all" 的候选域）。 */
  chapters: number[]
  /** 待补清单（升序；mode="missing" 的候选域）。 */
  pending: SnapshotBackfillEntry[]
  /** 读取/解析失败诊断（非阻断，随结果返回给 UI 诚实展示）。 */
  errors: string[]
}

/** 扫库选项。 */
export interface ScanSnapshotBackfillOptions {
  /** 只扫这些章号（缺省 = 快照目录全量，经 listSnapshots）。 */
  chapters?: readonly number[]
  /** 是否包含大纲快照（负章号）；默认 false —— 大纲没有章节正文，无法批量重提。 */
  includeOutlines?: boolean
  /** 读取并发上限。 */
  concurrency?: number
}

/** 字段是否「缺」（undefined / null；povCharacter 额外把空串视为缺）。 */
function isBackfillFieldMissing(field: SnapshotBackfillField, value: unknown): boolean {
  if (value === undefined || value === null) return true
  // povCharacter 是单值声明：空串等价于「未填写」，仍属待补。
  if (field === "povCharacter") {
    return typeof value !== "string" || value.trim().length === 0
  }
  // 数组族：只判「字段缺」；空数组合法（该章确实没有模态事实）。
  return !Array.isArray(value)
}

/**
 * 快照字段完整性判定（纯函数，零 IO）。
 *
 * 判定顺序（先到先得，保证主因稳定可断言）：
 *   1. 非对象 → unreadable
 *   2. 缺任一可选字段族 → missing_optional_field
 *   3. revision 字段缺失 → revision_missing（旧格式信号，不是字段版本比较）
 *
 * **不用 `revision` 的大小判待补**：revision 是内容修订号，
 * 与字段齐不齐无关（字段齐全 + revision=1 是合法且常见的真实状态）。
 */
export function classifySnapshotFields(raw: unknown): SnapshotCompleteness {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      complete: false,
      reason: SNAPSHOT_BACKFILL_REASONS.unreadable,
      missingFields: [],
      revision: null,
    }
  }
  const record = raw as Record<string, unknown>
  const revisionRaw = record.revision
  const revision = typeof revisionRaw === "number" && Number.isFinite(revisionRaw) ? revisionRaw : null
  const missingFields = SNAPSHOT_BACKFILL_FIELDS.filter((field) =>
    isBackfillFieldMissing(field, record[field]),
  )
  if (missingFields.length > 0) {
    return {
      complete: false,
      reason: SNAPSHOT_BACKFILL_REASONS.missingOptionalField,
      missingFields,
      revision,
    }
  }
  if (revision === null) {
    return {
      complete: false,
      reason: SNAPSHOT_BACKFILL_REASONS.revisionMissing,
      missingFields: [],
      revision: null,
    }
  }
  return { complete: true, reason: null, missingFields: [], revision }
}

function dedupeSorted(numbers: readonly number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b)
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * 扫库：列出 `.novel/snapshots/*.snapshot.json`，逐条判定字段完整性，
 * 输出待补清单 `[{ chapter, reason }]`。
 *
 * 只读；永不抛（IO/解析失败进 `errors`，对应章号按 `unreadable` 计入待补）。
 */
export async function scanSnapshotBackfill(
  projectPath: string,
  opts: ScanSnapshotBackfillOptions = {},
): Promise<SnapshotScanResult> {
  const pp = normalizePath(projectPath)
  const errors: string[] = []

  let chapters: number[]
  if (opts.chapters) {
    chapters = dedupeSorted(opts.chapters)
  } else {
    try {
      // failLoud：目录缺失 → []（首次打开尚无快照），其余 IO 失败如实抛出。
      chapters = await listSnapshots(pp, { failLoud: true })
    } catch (err) {
      const message = toErrorMessage(err)
      logger.warn("Snapshot Scanner", "scan list failed", { error: message })
      return { total: 0, chapters: [], pending: [], errors: [message] }
    }
  }
  if (!opts.includeOutlines) {
    chapters = chapters.filter((chapter) => chapter > 0)
  }

  const pending: SnapshotBackfillEntry[] = []
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? SNAPSHOT_SCAN_CONCURRENCY, chapters.length || 1),
  )

  for (let index = 0; index < chapters.length; index += concurrency) {
    const slice = chapters.slice(index, index + concurrency)
    const reads = await Promise.all(
      slice.map(async (chapter) => {
        const path = snapshotJsonPath(pp, chapter)
        try {
          return { chapter, raw: await readFile(path), error: null as string | null }
        } catch (err) {
          return { chapter, raw: null, error: toErrorMessage(err) }
        }
      }),
    )
    for (const read of reads) {
      if (read.error !== null) {
        errors.push(`第 ${read.chapter} 章快照读取失败：${read.error}`)
        pending.push({
          chapter: read.chapter,
          reason: SNAPSHOT_BACKFILL_REASONS.unreadable,
          missingFields: [],
          revision: null,
        })
        continue
      }
      const verdict = classifySnapshotFields(safeParseJson(read.raw ?? ""))
      if (verdict.complete) continue
      /* v8 ignore next -- complete=false 时 reason 恒非 null（classifySnapshotFields 契约） */
      const reason = verdict.reason ?? SNAPSHOT_BACKFILL_REASONS.unreadable
      pending.push({
        chapter: read.chapter,
        reason,
        missingFields: verdict.missingFields,
        revision: verdict.revision,
      })
    }
  }

  pending.sort((a, b) => a.chapter - b.chapter)
  return { total: chapters.length, chapters, pending, errors }
}

// ──────────────────────────────────────────────────────────────────────────
// D2：范围选择（默认「仅未提取」）+ LLM 预算上限
// ──────────────────────────────────────────────────────────────────────────

/** 范围模式：all = 全部章节；missing = 仅未提取（待补清单）。 */
export type BatchExtractScopeMode = typeof DEFAULT_BATCH_EXTRACT_SCOPE | "all"

/** 范围选择开关。 */
export interface BatchExtractScopeOptions {
  /** 默认 DEFAULT_BATCH_EXTRACT_SCOPE（仅未提取）。 */
  mode?: BatchExtractScopeMode
  /** 全量模式下跳过已有完整快照的章节（默认 true）。 */
  skipExisting?: boolean
  /** 强制重提：无视 skipExisting，全量重跑（默认 false）。 */
  force?: boolean
}

/** 范围选择结果。 */
export interface BatchExtractScopeSelection {
  mode: BatchExtractScopeMode
  skipExisting: boolean
  force: boolean
  /** 进入队列的章号（升序、去重）。 */
  chapters: number[]
  /** 因 skipExisting 被跳过的章号。 */
  skippedExisting: number[]
}

/**
 * 范围解析（纯函数）。
 *
 * 语义表（skipExisting / force 只在 mode="all" 有意义）：
 *   mode="missing"                       → 待补清单（force/skipExisting 不改变集合）
 *   mode="all" + force=true              → 全部章节（强制重提，忽略 skipExisting）
 *   mode="all" + skipExisting=true(默认) → 待补清单（= 跳过已提取过的章节，幂等重跑）
 *   mode="all" + skipExisting=false      → 全部章节
 */
export function resolveBatchExtractScope(
  scan: SnapshotScanResult,
  opts: BatchExtractScopeOptions = {},
): BatchExtractScopeSelection {
  const mode = opts.mode ?? DEFAULT_BATCH_EXTRACT_SCOPE
  const skipExisting = opts.skipExisting ?? DEFAULT_BATCH_SKIP_EXISTING
  const force = opts.force ?? DEFAULT_BATCH_FORCE
  const pendingChapters = dedupeSorted(scan.pending.map((entry) => entry.chapter))

  if (mode === DEFAULT_BATCH_EXTRACT_SCOPE) {
    return { mode, skipExisting, force, chapters: pendingChapters, skippedExisting: [] }
  }

  const allChapters = dedupeSorted(scan.chapters)
  if (force) {
    return { mode, skipExisting, force, chapters: allChapters, skippedExisting: [] }
  }
  if (skipExisting) {
    const pendingSet = new Set(pendingChapters)
    return {
      mode,
      skipExisting,
      force,
      chapters: pendingChapters,
      skippedExisting: allChapters.filter((chapter) => !pendingSet.has(chapter)),
    }
  }
  return { mode, skipExisting, force, chapters: allChapters, skippedExisting: [] }
}

/** 预算归一化：非法值回落默认；超硬顶按硬顶截断。 */
export function normalizeBatchExtractBudget(value?: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return BATCH_EXTRACT_BUDGET_DEFAULT
  }
  return Math.min(Math.floor(value), BATCH_EXTRACT_BUDGET_MAX)
}

/** 预算裁决结果。 */
export interface BatchExtractBudgetPlan {
  /** 生效预算（章）。 */
  budget: number
  /** 准入章号（升序，长度 ≤ budget）。 */
  admitted: number[]
  /** 超预算被记账跳过的章号（升序）。 */
  skippedByBudget: number[]
  /** 是否触顶（true = 超限即停）。 */
  exhausted: boolean
}

/**
 * 预算裁决（纯函数）：超限即停并记账，绝不「先跑再说」。
 * 全量模式强制生效（BATCH_EXTRACT_BUDGET_ENFORCED）。
 */
export function applyBatchExtractBudget(
  chapters: readonly number[],
  budgetInput?: number | null,
): BatchExtractBudgetPlan {
  const budget = normalizeBatchExtractBudget(budgetInput)
  const ordered = dedupeSorted(chapters)
  const admitted = ordered.slice(0, budget)
  const skippedByBudget = ordered.slice(budget)
  return { budget, admitted, skippedByBudget, exhausted: skippedByBudget.length > 0 }
}

/** 预算记账行（结构化；UI 用 i18n 文案渲染，本模块不产中文）。 */
export interface BatchBudgetLedger {
  budget: number
  requested: number
  admitted: number
  skipped: number
  exhausted: boolean
}

/** 预算记账（超限即停 → 记账，供进度通道 message 展示）。 */
export function buildBatchBudgetLedger(plan: BatchExtractBudgetPlan): BatchBudgetLedger {
  return {
    budget: plan.budget,
    requested: plan.admitted.length + plan.skippedByBudget.length,
    admitted: plan.admitted.length,
    skipped: plan.skippedByBudget.length,
    exhausted: plan.exhausted,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// D4/D5：批量提取队列（Draft-first 状态机，纯函数）
// ──────────────────────────────────────────────────────────────────────────

/** 草稿状态：pending（已排队）→ ready（提取完成待 accept）→ accepted（已回填）。 */
export const BATCH_DRAFT_STATUSES = ["pending", "ready", "accepted", "failed", "cancelled"] as const

/** 草稿状态联合类型。 */
export type BatchDraftStatus = (typeof BATCH_DRAFT_STATUSES)[number]

/** 单章草稿。`snapshot` 只在 accept 之后才被回填正式记忆。 */
export interface BatchExtractDraft {
  chapter: number
  status: BatchDraftStatus
  /** 提取产出的快照（草稿态；accept 前绝不落正式记忆）。 */
  snapshot?: ChapterSnapshot | null
  /** 失败/取消原因（稳定字面量或引擎 failReason）。 */
  reason?: string
  updatedAt: number
}

/** 队列状态。 */
export interface BatchExtractQueueState {
  projectPath: string
  status: "idle" | "running" | "cancelling" | "cancelled" | "done"
  /** 生效 LLM 预算（章）。 */
  budget: number
  /** 准入章号。 */
  admitted: number[]
  /** 超预算记账跳过的章号。 */
  skippedByBudget: number[]
  /** 全部草稿（含 pending/ready/accepted/failed/cancelled）。 */
  drafts: BatchExtractDraft[]
  /** 已 ready 的章数。 */
  completed: number
  /** 失败章数。 */
  failed: number
}

/** 建队列输入。 */
export interface CreateBatchExtractQueueInput {
  projectPath: string
  plan: BatchExtractBudgetPlan
  now?: number
}

/** 建队列（idle，全部准入章以 pending 草稿入列）。 */
export function createBatchExtractQueue(input: CreateBatchExtractQueueInput): BatchExtractQueueState {
  const now = input.now ?? Date.now()
  return {
    projectPath: normalizePath(input.projectPath),
    status: "idle",
    budget: input.plan.budget,
    admitted: [...input.plan.admitted],
    skippedByBudget: [...input.plan.skippedByBudget],
    drafts: input.plan.admitted.map((chapter) => ({
      chapter,
      status: "pending",
      updatedAt: now,
    })),
    completed: 0,
    failed: 0,
  }
}

function patchDraft(
  state: BatchExtractQueueState,
  chapter: number,
  patch: Partial<BatchExtractDraft>,
  now: number,
): BatchExtractQueueState {
  let touched = false
  const drafts = state.drafts.map((draft) => {
    if (draft.chapter !== chapter) return draft
    touched = true
    return { ...draft, ...patch, chapter, updatedAt: now }
  })
  return touched ? { ...state, drafts } : state
}

/** 开始某章（队列转 running，草稿转 pending）。 */
export function startBatchChapter(
  state: BatchExtractQueueState,
  chapter: number,
  now: number = Date.now(),
): BatchExtractQueueState {
  const next = patchDraft({ ...state, status: "running" }, chapter, { status: "pending" }, now)
  return next
}

/**
 * 某章提取完成 → 草稿置 `ready`。
 *
 * Draft-first：**绝不**在此把草稿置 `accepted`，也绝不写正式记忆；
 * accept 是独立的人工动作（acceptBatchDraft）。
 */
export function completeBatchChapter(
  state: BatchExtractQueueState,
  chapter: number,
  snapshot: ChapterSnapshot | null,
  now: number = Date.now(),
): BatchExtractQueueState {
  if (!snapshot) return failBatchChapter(state, chapter, "extract_failed", now)
  const next = patchDraft(state, chapter, { status: "ready", snapshot, reason: undefined }, now)
  if (next === state) return state
  return {
    ...next,
    completed: next.drafts.filter((draft) => draft.status === "ready" || draft.status === "accepted").length,
  }
}

/** 某章提取失败 → 草稿置 `failed`。 */
export function failBatchChapter(
  state: BatchExtractQueueState,
  chapter: number,
  reason: string,
  now: number = Date.now(),
): BatchExtractQueueState {
  const next = patchDraft(state, chapter, { status: "failed", reason }, now)
  if (next === state) return state
  return { ...next, failed: next.drafts.filter((draft) => draft.status === "failed").length }
}

/** 取消（走既有 abort 通道；已 ready 的草稿保留可 accept）。 */
export function cancelBatchExtractQueue(
  state: BatchExtractQueueState,
  now: number = Date.now(),
): BatchExtractQueueState {
  return {
    ...state,
    status: "cancelled",
    drafts: state.drafts.map((draft) =>
      draft.status === "pending" ? { ...draft, status: "cancelled", updatedAt: now } : draft,
    ),
  }
}

/** 全部章节处理完毕 → done。 */
export function finishBatchExtractQueue(state: BatchExtractQueueState): BatchExtractQueueState {
  if (state.status === "cancelled") return state
  return { ...state, status: "done" }
}

/** 可 accept 的草稿（ready）。 */
export function listAcceptableDrafts(state: BatchExtractQueueState): BatchExtractDraft[] {
  return state.drafts.filter((draft) => draft.status === "ready")
}

/**
 * accept 回填（Draft-first 唯一出口）。
 *
 * 只接受 `ready` 草稿；其它状态原样返回（调用方据此判断是否需要回填）。
 * 调用方必须在 `syncSnapshotToMemory` 成功之后调用本函数 —— 本函数只记账。
 */
export function acceptBatchDraft(
  state: BatchExtractQueueState,
  chapter: number,
  now: number = Date.now(),
): BatchExtractQueueState {
  const target = state.drafts.find((draft) => draft.chapter === chapter)
  if (!target || target.status !== "ready") return state
  return patchDraft(state, chapter, { status: "accepted" }, now)
}

/** 队列进度（供进度通道）。 */
export interface BatchExtractProgress {
  completed: number
  failed: number
  total: number
  pending: number
  accepted: number
  percent: number
}

/** 进度快照（纯函数）。 */
export function batchQueueProgress(state: BatchExtractQueueState): BatchExtractProgress {
  const total = state.drafts.length
  const completed = state.drafts.filter((draft) => draft.status === "ready").length
  const accepted = state.drafts.filter((draft) => draft.status === "accepted").length
  const failed = state.drafts.filter((draft) => draft.status === "failed").length
  const pending = state.drafts.filter((draft) => draft.status === "pending").length
  const done = completed + accepted + failed
  return {
    completed,
    failed,
    total,
    pending,
    accepted,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  }
}
