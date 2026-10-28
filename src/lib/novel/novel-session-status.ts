import { createDirectory, readFile, writeFileAtomic, writeFilesAtomic } from "@/commands/fs"
import { listen } from "@tauri-apps/api/event"
import { normalizePath } from "@/lib/path-utils"
import { isTauri } from "@/lib/platform"
import { pad, toErrorMessage, logger } from "@/lib/utils"
import { z } from "zod"
import { withProjectLock } from "./novel-locks"
import { DRAFT_AUTO_ARM_SCHEMA, type DraftAutoArmStatus } from "./auto-arm-status"
import { checkCommitDiscipline } from "@/lib/quality/commit-discipline"
import type {
  DeepChapterDecisionGates,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResumeStage,
} from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
import {
  markReviewQueued,
  markWriteReady,
  type ReviewJobState,
} from "./write-review-split"
import {
  canReuseExistingSession,
  cloneDecisionGates,
  isSameSessionBase,
  createBaseStatus,
  extractDraftContent,
  mergeEvidenceRefs,
  normalizeUserRequest,
  resolveDimensionResults,
  stageToActiveStepIndex,
  taskIdForConversation,
} from "./novel-status-construction"
import type { DeepChapterSessionInput } from "./novel-status-construction"
export {
  resolveInterruptedSessionResumeCheckpoint,
  resolveStatusResumeCheckpoint,
} from "./novel-status-construction"

/** Wave B helper: draft ready then queue non-blocking review. */
function markWriteReadyThenQueueReview(
  prev: ReviewJobState | undefined,
  chapterNumber?: number,
): ReviewJobState {
  return markReviewQueued(markWriteReady(prev, chapterNumber), chapterNumber)
}

export type NovelSessionLifecycleStatus = "running" | "completed" | "paused" | "blocked" | "interrupted"
export type NovelDraftStatus = "pending" | "ready" | "accepted" | "rejected" | "superseded"
export type NovelGateStatus = "pending" | "passed" | "failed"

// CORR-008 (odyssey): enum value lists for load-time validation of the
// status.json truth-source. Rejecting unknown values at load prevents a
// corrupted file from being spread through and silently treated as a
// "still running" session by downstream === checks.
const SESSION_LIFECYCLE_STATUSES: readonly NovelSessionLifecycleStatus[] = [
  "running",
  "completed",
  "paused",
  "blocked",
  // J10-02: interrupted = 上个进程 running/paused 但进程已终止的持久态。
  // 重启加载时降级写入，区分「主动 running」与「重启发现的死 running」，
  // 防止幽灵 running 跨重启复活。additive — 下游应视其为非活跃可续作态。
  "interrupted",
]
const DRAFT_STATUSES: readonly NovelDraftStatus[] = [
  "pending",
  "ready",
  "accepted",
  "rejected",
  "superseded",
]

export interface NovelDraftArtifact {
  draft_id: string
  session_id?: string
  conversation_id: string
  source_task_id: string
  user_request: string
  chapter_number?: number
  draft_status: NovelDraftStatus
  checkpoint_stage?: DeepChapterGenerationResumeStage
  content: string
  review_results: NovelReviewResult[]
  checkpoint?: DeepChapterGenerationResumeCheckpoint
  decision_gates?: DeepChapterDecisionGates
  created_at: string
  updated_at: string
  accepted_at?: string
  rejected_at?: string
  formal_chapter_path?: string
  superseded_by?: string
  /**
   * Wave 5 (v2.5.0): 本次生成上下文用量快照（记忆/检索/图谱/正文/其他）。
   * additive — 旧草稿/非 build 路径无此字段，读取方缺省降级不渲染。
   */
  context_usage?: import("@/lib/context-usage").ContextUsage
}

export interface NovelSessionStatus {
  schema_version: "1"
  session_id: string
  source: "deep_chapter_generation"
  created_at: string
  updated_at: string
  status: NovelSessionLifecycleStatus
  active_step_index: number | null
  current_task: {
    task_id: string
    conversation_id: string
    user_request: string
    chapter_number?: number
    checkpoint_stage: DeepChapterGenerationResumeStage | "started" | "completed"
    status: NovelSessionLifecycleStatus
    last_error?: string
  }
  draft: {
    draft_id: string
    file_path: string
    draft_status: NovelDraftStatus
    checkpoint_stage?: DeepChapterGenerationResumeStage
    updated_at: string
    accepted_at?: string
    rejected_at?: string
    formal_chapter_path?: string
  }
  decision_gates: DeepChapterDecisionGates
  resume_checkpoint?: DeepChapterGenerationResumeCheckpoint
  evidence_refs: string[]
  /**
   * F-003 (ANL-010 C1): additive field persisting the 6-dimension review
   * results. Previously the 6 dims were generated but orphaned (never
   * reached reviewResults / session status). Now wired into the 18→3 fold
   * via dimensionResultsToReviewResults, they are also persisted here for
   * auditability and post-hoc inspection. Optional & additive: the
   * Partial<NovelSessionStatus> spread in loadNovelSessionStatus (:550)
   * round-trips an undefined field safely, so older status files without
   * this field load unchanged.
   */
  dimension_results?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  /**
   * EPIC-002 / TASK-013 / Story 2.3: additive field persisting structured
   * stage-level metrics (tokenCost/latencyMs/partial) for ADR-30 scene-breakdown
   * and future stages. Mirrors the `dimension_results` additive-optional pattern:
   * optional & additive, the Partial<NovelSessionStatus> spread in
   * loadNovelSessionStatus round-trips an undefined field safely, so older
   * status files without this field load unchanged.
   *
   * HARD-1 (status.json sole truth-source): these structured metrics live ON
   * status.json (the existing truth-source), NOT a second session-state file.
   * The flat `evidence_refs: string[]` contract stays a pure path list (merged
   * via mergeEvidenceRefs Set-dedup) — structured stage metrics need their own
   * slot, so they go here rather than polluting the string[] path contract.
   */
  stage_metrics?: StageMetricEntry[]
  /**
   * Wave B: write/review split job state (additive). Review never blocks write.
   * Lives on status.json sole truth-source — not a second session file.
   */
  review_job?: import("./write-review-split").ReviewJobState
  /**
   * S2b (roadmap R07): chase_debt 追读债务台账 (additive-optional)。
   * 契约区分: chase_debt = 追读力债务 (hook/micropayoff/coolpoint);
   * 伏笔逾期债务走 foreshadowing-debt (related-chapters.findOverdueForeshadowing),
   * 不混入本字段。旧 status.json 无本字段仍可加载 (additive 兼容)。
   */
  chase_debt?: {
    debts: ChaseDebt[]
    /** 防重复计息事件日志 */
    debt_events: ChaseDebtEvent[]
    updated_at: string
  }
  /**
   * 55 号设计 W2-4 (54⑨ 收尾): avoid-ai 审计摘要 (additive-optional)。
   * 仅计数/类型枚举, 不含正文片段 (CWE-532 纪律); 旧 status.json 无此字段仍可加载。
   */
  avoid_ai_summary?: {
    score: number
    label: string
    issueCount: number
    issueTypes: string[]
    updatedAt: string
  }
  /**
   * Wave 4 (v2.5.0): 批量去AI味批次状态 (additive-optional)。
   * 状态/指针落 status.json 唯一真源；草稿内容落 .novel/de-ai-batch-drafts/ 工件。
   * 旧 status.json 无本字段仍可加载 (additive 兼容)。
   */
  de_ai_batch?: import("./de-ai-batch/types").DeAiBatchState
  /**
   * T09 (additive-optional, 三开关项目级隔离): 以下 4 字段承载项目级开关与
   * 步骤摘要, 落 status.json 唯一真源（HARD-1）, 不另建第二份会话状态文件,
   * 永不经 @tauri-apps/plugin-store 路由（store 禁用注记, 见 STATUS_FILE 常量）。
   *
   * 项目级隔离: 每个项目各自 .novel/status.json 持有独立开关值（按 projectId /
   * projectPath 天然隔离, 无跨项目共享全局态）。同一进程内多项目并行时, 开关值
   * 只从各自 status.json 读取, 互不串扰。
   *
   * 三开关（route_shell_mode / canon_migration / anti_ai_mode）缺省 undefined
   * （未显式设置 → 走各调用点默认回退; 如 route 默认 legacy / canon 默认
   * legacy 一键回退 / anti_ai 默认 off）, 不污染旧 status.json（additive 兼容）。
   *
   * 增强注记（P1-7 投影审计扩展, 2026-08-19, 32 仓库报告, 仅评估不承诺实现）:
   * status.json 唯一真源可加 projection_log 审计派生视图同步状态（事实源→派生
   * 只读视图五路投影+投影审计模式对照）; 本任务仅标记扩展点, 不实现。
   */
  /** 当前步骤摘要（短哈希/文本）, additive-optional, 缺省 undefined。 */
  step_digest?: string
  /** route() 薄壳模式开关: legacy(默认) / route / 自定义。项目级隔离。 */
  route_shell_mode?: RouteShellMode
  /** canon 迁移开关: legacy(默认, 一键回退) / dual / shadow / 自定义。项目级隔离。 */
  canon_migration?: CanonMigrationMode
  /** anti_ai 三档开关: off(默认) / warn / block / 自定义。项目级隔离。 */
  anti_ai_mode?: AntiAiMode
  /**
   * 波2-A (consensus plan 模块 10/波2): draft-autoarm 裁定落盘 (additive-optional)。
   * 机械门 P0+P1 全 pass → 草稿态升 ready 且 target 类型层只有 "ready"
   * (accept 永远人工, 见 auto-arm-status.ts assertAutoArmPatchNeverAccepts)。
   * 旧 status.json 无本字段仍可加载 (additive 兼容, zod optional)。
   */
  draft_auto_arm?: DraftAutoArmStatus
}

/**
 * T09 项目级开关类型（additive）。各开关落 status.json 唯一真源, 按 projectId
 * 项目级隔离（每项目各自持有, 无跨项目共享全局态）。字面量为蓝图当前约定档位,
 * `(string & {})` 保留自定义扩展位（不承诺实现, 仅类型护栏）。
 */
export type RouteShellMode = "legacy" | "route" | "authoritative" | (string & {})
export type CanonMigrationMode = "legacy" | "dual" | "shadow" | (string & {})
export type AntiAiMode = "off" | "warn" | "block" | (string & {})

/**
 * EPIC-002 / ADR-30 / TASK-013: 阶段指标溯源条目（status.json additive
 * optional 字段 stage_metrics 的元素类型）。每条记录一个 LLM 调用阶段的
 * tokenCost/latencyMs/partial，O-201 成本经验决策可据。
 */
export interface StageMetricEntry {
  /**
   * 阶段标记：'scene_breakdown' = ADR-30 阶段 1.5；
   * P1 起允许其它软指标 stage 名（write_llm / six_dim / pack / ingest 等），
   * 仅诊断用，非产品硬门。
   */
  stage: "scene_breakdown" | (string & {})
  tokenCost?: number
  latencyMs?: number
  partial?: boolean
  chapterId?: string
  timestamp?: string
}

/**
 * S2b (roadmap): chase_debt 追读债务 (webnovel ChaseDebtMeta 契约移植)。
 * 与伏笔债务 (foreshadowing-debt) 语义区分:
 *   chase_debt = 追读力债务 (hook/micropayoff/coolpoint 欠账, 阅读动力维度)
 *   foreshadowing-debt = 伏笔逾期 (剧情连续性债务, 由 related-chapters 扫描)
 * 两者都是 additive-optional 字段, 旧 status.json 无 debt 字段仍可加载。
 */
export type ChaseDebtType =
  | "hook_strength"
  | "micropayoff"
  | "coolpoint"
  | (string & {})

export type ChaseDebtStatus = "active" | "paid" | "overdue" | "written_off"

/** 追读债务 (webnovel ChaseDebtMeta: debt_type/amount/interest_rate/due_chapter/status) */
export interface ChaseDebt {
  id: string
  debt_type: ChaseDebtType
  /** 初始债务量 */
  original_amount: number
  /** 当前债务量 (含利息) */
  current_amount: number
  /** 利息率 (每章) */
  interest_rate: number
  /** 产生债务的章节 */
  source_chapter: number
  /** 截止章节 (到期未还 → overdue) */
  due_chapter: number
  status: ChaseDebtStatus
  /** 关联的 review metric 或 override contract id (可选) */
  ref?: string
}

/** 债务事件日志 (webnovel DebtEventMeta: created/interest_accrued/partial/full/overdue) — 防重复计息 */
export interface ChaseDebtEvent {
  debt_id: string
  event_type: "created" | "interest_accrued" | "partial_payment" | "full_payment" | "overdue" | "written_off"
  amount: number
  chapter: number
  note?: string
}

interface PersistDeepChapterCheckpointInput extends DeepChapterSessionInput {
  sessionId: string
  checkpoint: DeepChapterGenerationResumeCheckpoint
}

interface CompleteDeepChapterSessionInput extends DeepChapterSessionInput {
  sessionId: string
  checkpoint?: DeepChapterGenerationResumeCheckpoint
  finalContent: string
  reviewResults?: NovelReviewResult[]
  /** Wave 5 (v2.5.0): 上下文用量快照透传（additive，缺省不落盘）。 */
  contextUsage?: import("@/lib/context-usage").ContextUsage
}

interface PauseDeepChapterSessionInput extends DeepChapterSessionInput {
  sessionId: string
  checkpoint?: DeepChapterGenerationResumeCheckpoint
  errorMessage: string
}

interface DraftDecisionInput extends DeepChapterSessionInput {
  sessionId?: string
  formalChapterPath?: string
}

interface WriteDraftArtifactOptions {
  finalContent?: string
  acceptedAt?: string
  rejectedAt?: string
  formalChapterPath?: string
  decisionGates?: DeepChapterDecisionGates
  /** Wave 5 (v2.5.0): 上下文用量快照（additive，缺省不落盘）。 */
  contextUsage?: import("@/lib/context-usage").ContextUsage
}

type DraftDecisionMode = "accept" | "reject"

/**
 * STORE 禁用注记（T09 / ADR-16）: status.json 是运行时唯一真源, 永远经
 * `writeFileAtomic` (Rust fs 后端) 直接原子写入 .novel/status.json; 绝不经过
 * `@tauri-apps/plugin-store` 路由（plugin-store 仅用于非真源类 UI 偏好, 不在
 * 会话状态真源链路上）。任何读写本项目状态都必须走 novelSessionStatusPath +
 * load/save 函数, 不得改接 plugin-store。
 */
const NOVEL_DIR = ".novel"
const DRAFTS_DIR = "drafts"
const STATUS_FILE = "status.json"

export function createNovelSessionId(now: Date = new Date()): string {
  return [
    "novel-",
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "-",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("")
}

function novelDirPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${NOVEL_DIR}`
}

export function novelSessionStatusPath(projectPath: string): string {
  return `${novelDirPath(projectPath)}/${STATUS_FILE}`
}

function draftsDirPath(projectPath: string): string {
  return `${novelDirPath(projectPath)}/${DRAFTS_DIR}`
}

/**
 * SEC-001 (odyssey): sanitize draftId (= conversationId) before interpolating
 * into a drafts/ path. The conversationId is currently generated internally
 * (conv_<timestamp>_<random36>, safe chars only) so path traversal is not
 * reachable today, but loadNovelDraftArtifact/requireManagedDeepChapterDraft
 * accept externally-supplied conversationId parameters without validation,
 * and the Rust fs backend has no project-root containment. Align with the
 * taskIdForConversation sanitizer (same [^a-zA-Z0-9_-] → - replacement) as
 * defense-in-depth, so a future caller passing `../` cannot escape drafts/.
 */
function sanitizeDraftId(draftId: string): string {
  return draftId.replace(/[^a-zA-Z0-9_-]/g, "-")
}

export function novelDraftArtifactPath(projectPath: string, draftId: string): string {
  return `${draftsDirPath(projectPath)}/${sanitizeDraftId(draftId)}.json`
}

function novelSupersededDraftArtifactPath(projectPath: string, draftId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-")
  return `${draftsDirPath(projectPath)}/${sanitizeDraftId(draftId)}.superseded.${safeTimestamp}.json`
}

async function ensureNovelSessionDirs(projectPath: string): Promise<void> {
  await createDirectory(novelDirPath(projectPath))
  await createDirectory(draftsDirPath(projectPath))
}

async function writeVerifiedJson<T>(
  path: string,
  payload: T,
  label: string,
  verify: (parsed: unknown) => boolean,
): Promise<void> {
  const serialized = JSON.stringify(payload, null, 2)
  await writeFileAtomic(path, serialized)

  let raw: string
  try {
    raw = await readFile(path)
  } catch (error) {
    throw new Error(`${label} 写入后回读失败（${path}）：${toErrorMessage(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} 写入后回读不是有效 JSON（${path}）：${toErrorMessage(error)}`)
  }

  if (!verify(parsed)) {
    throw new Error(`${label} 写入回读校验失败（${path}）`)
  }
}

/**
 * P0 原子提交（R4 模式）：draft + status 单次 writeFilesAtomic 批量事务。
 *
 * 背景：6 个 lifecycle 函数（persist/complete/pause/block/accept/reject）此前
 * 先 writeDraftArtifact（drafts/*.json）再 saveNovelSessionStatus，中途崩溃 =
 * 状态分叉（draft 新 + status 旧）。参考本仓既有 R4 模式（chapter-ingest.ts
 * saveSnapshot 用 writeFilesAtomic([jsonPath, mdPath]) 单次批量事务，失败即
 * 零落盘，见其注释），此处 draft 工件 + status.json 同属一次快照，同理批量提交：
 * prepare 阶段任一 temp 失败即零落盘；提交阶段为顺序 rename（微秒窗口）。
 * 失败抛错由调用方处理，禁止吞错降级为静默不一致。
 */
interface PendingDraftFile {
  path: string
  content: string
  label: string
  verify: (parsed: unknown) => boolean
}

function buildDraftArtifacts(
  input: DeepChapterSessionInput,
  sessionId: string,
  draftStatus: NovelDraftStatus,
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  reviewResults: NovelReviewResult[],
  options: WriteDraftArtifactOptions,
  existing: NovelDraftArtifact | null,
  now: string,
): {
  filePath: string
  artifact: NovelDraftArtifact
  supersededPath: string | null
  supersededArtifact: NovelDraftArtifact | null
} {
  const draftId = input.conversationId
  const filePath = novelDraftArtifactPath(input.projectPath, draftId)
  let supersededPath: string | null = null
  let supersededArtifact: NovelDraftArtifact | null = null
  // CORR-003 (odyssey) 语义与 writeDraftArtifact 一致：异 session / 无 session_id
  // 遗留草稿走 supersede 审计拷贝分支，same-session 复写不产生 superseded 文件。
  // ISS-20260709-008：这里是 missing-as-different 语义（undefined !== sessionId 为真），
  // 遗留草稿必须走 supersede 审计拷贝，不能静默覆盖。
  if (
    existing
    && !isSameSessionBase(existing, sessionId)
    && existing.draft_status !== "superseded"
  ) {
    supersededPath = novelSupersededDraftArtifactPath(input.projectPath, draftId, now)
    supersededArtifact = {
      ...existing,
      draft_status: "superseded",
      updated_at: now,
      superseded_by: filePath,
    }
  }
  const content = extractDraftContent(checkpoint, options.finalContent)
  // CORR-001 语义与 writeDraftArtifact 一致：same-session 复写保留 created_at。
  const createdAt = isSameSessionBase(existing, sessionId) && existing.draft_status !== "superseded"
    ? existing.created_at
    : now
  const artifact: NovelDraftArtifact = {
    draft_id: draftId,
    session_id: sessionId,
    conversation_id: input.conversationId,
    source_task_id: taskIdForConversation(input.conversationId),
    user_request: normalizeUserRequest(input.userRequest),
    chapter_number: checkpoint?.chapterNumber ?? input.resumeCheckpoint?.chapterNumber ?? input.chapterNumber,
    draft_status: draftStatus,
    checkpoint_stage: checkpoint?.stage,
    content,
    review_results: reviewResults,
    checkpoint,
    decision_gates: cloneDecisionGates(options.decisionGates ?? checkpoint?.decisionGates),
    created_at: createdAt,
    updated_at: now,
    accepted_at: options.acceptedAt,
    rejected_at: options.rejectedAt,
    formal_chapter_path: options.formalChapterPath,
    superseded_by: undefined,
    context_usage: options.contextUsage,
  }
  return { filePath, artifact, supersededPath, supersededArtifact }
}

function verifySupersededDraft(
  parsed: unknown,
  draftId: string,
  filePath: string,
): boolean {
  const candidate = parsed as Partial<NovelDraftArtifact> | null
  return candidate?.draft_id === draftId
    && candidate?.draft_status === "superseded"
    && candidate?.superseded_by === filePath
}

function verifyDraftArtifact(
  parsed: unknown,
  draftId: string,
  conversationId: string,
  sessionId: string,
  draftStatus: NovelDraftStatus,
): boolean {
  const candidate = parsed as Partial<NovelDraftArtifact> | null
  return candidate?.draft_id === draftId
    && candidate?.conversation_id === conversationId
    && candidate?.session_id === sessionId
    && candidate?.draft_status === draftStatus
}

function verifySessionStatus(parsed: unknown, status: NovelSessionStatus): boolean {
  const candidate = parsed as Partial<NovelSessionStatus> | null
  return candidate?.session_id === status.session_id
    && candidate?.current_task?.conversation_id === status.current_task.conversation_id
    && candidate?.status === status.status
    && candidate?.draft?.draft_status === status.draft.draft_status
}

/**
 * 批量前准备：读既有草稿（判定 supersede / created_at 复用）并序列化 draft
 * 工件为待提交文件，不落盘。调用方在同一把 session-status 锁内先 prepare、
 * 再 buildNextStatus、最后经 persistCheckpointBaseWithinLock 单次批量提交，
 * 保证 draft + status 同事务。
 */
async function prepareDraftWrites(
  input: DeepChapterSessionInput,
  sessionId: string,
  draftStatus: NovelDraftStatus,
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  reviewResults: NovelReviewResult[],
  options: WriteDraftArtifactOptions = {},
): Promise<{ filePath: string; files: PendingDraftFile[] }> {
  const now = new Date().toISOString()
  const existing = await loadNovelDraftArtifact(input.projectPath, input.conversationId)
  const { filePath, artifact, supersededPath, supersededArtifact } = buildDraftArtifacts(
    input,
    sessionId,
    draftStatus,
    checkpoint,
    reviewResults,
    options,
    existing,
    now,
  )
  const files: PendingDraftFile[] = []
  if (supersededPath && supersededArtifact) {
    const draftId = input.conversationId
    const capturedPath = supersededPath
    const capturedArtifact = supersededArtifact
    files.push({
      path: capturedPath,
      content: JSON.stringify(capturedArtifact, null, 2),
      label: "superseded 草稿文件",
      verify: (parsed) => verifySupersededDraft(parsed, draftId, filePath),
    })
  }
  const draftId = input.conversationId
  const conversationId = input.conversationId
  files.push({
    path: filePath,
    content: JSON.stringify(artifact, null, 2),
    label: "草稿文件",
    verify: (parsed) => verifyDraftArtifact(parsed, draftId, conversationId, sessionId, draftStatus),
  })
  return { filePath, files }
}

/**
 * 单次 writeFilesAtomic 批量提交（draft 工件 + status.json 同事务）。
 * 成功后逐文件回读校验（fail-loud，与 writeVerifiedJson 同语义）；
 * 批量本身抛错直接上抛，零落盘，禁止吞错降级。
 */
async function commitDraftAndStatusBatch(
  projectPath: string,
  draftFiles: PendingDraftFile[],
  status: NovelSessionStatus,
): Promise<void> {
  await ensureNovelSessionDirs(projectPath)
  const statusPath = novelSessionStatusPath(projectPath)
  const capturedStatus = status
  const allFiles: PendingDraftFile[] = [
    ...draftFiles,
    {
      path: statusPath,
      content: JSON.stringify(capturedStatus, null, 2),
      label: "小说会话状态文件",
      verify: (parsed) => verifySessionStatus(parsed, capturedStatus),
    },
  ]
  // S4-R4：draft + status 改走 writeFilesAtomic 单次批量事务。两文件同属一次
  // 快照，prepare 阶段任一 temp 失败即零落盘；提交阶段为顺序 rename（微秒窗口）。
  await writeFilesAtomic(allFiles.map((f) => [f.path, f.content] as [string, string]))
  for (const f of allFiles) {
    let raw: string
    try {
      raw = await readFile(f.path)
    } catch (error) {
      throw new Error(`${f.label} 写入后回读失败（${f.path}）：${toErrorMessage(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`${f.label} 写入后回读不是有效 JSON（${f.path}）：${toErrorMessage(error)}`)
    }
    if (!f.verify(parsed)) {
      throw new Error(`${f.label} 写入回读校验失败（${f.path}）`)
    }
  }
}

/**
 * ADR-31 (EPIC-000, lifecycle-twin factory extraction): single source of truth
 * for constructing a `next` NovelSessionStatus from a `base` + delta overrides.
 *
 * The 6 lifecycle functions (persist/complete/pause/block/accept/reject) each
 * previously inlined a manually-copied `next` status literal spread from base
 * with 9 repeated fields. That manual duplication
 * triggered the lifecycle-twin omission 4 times (SH-5 → ARCH-006 → PAT-G1 →
 * DC-2): each recurrence was a field silently dropped on one of the mirrored
 * sites. Centralizing here means a future lifecycle function (e.g. F-002
 * scene-breakdown's pending→ready→accept path) cannot forget a field — it calls
 * this factory with delta-only overrides.
 *
 * The factory owns all 9 fields that drifted across the 4 recurrences:
 * dimension_results / updated_at / status / active_step_index / current_task /
 * draft / decision_gates / resume_checkpoint / evidence_refs. Each defaults to
 * the base value when not supplied in overrides (so callers only pass what
 * changes), mirroring the prior `...base` spread semantics but explicit.
 *
 * `dimension_results` is resolved via resolveDimensionResults when a checkpoint
 * is supplied (centralized twin-safe helper, DC-2); callers may also override
 * directly for the accept/reject twin that resolves from draft.checkpoint.
 */
export function buildNextStatus(
  base: NovelSessionStatus,
  overrides: {
    updated_at: string
    status: NovelSessionLifecycleStatus
    active_step_index?: number | null
    current_task?: Partial<NovelSessionStatus["current_task"]>
    draft?: Partial<NovelSessionStatus["draft"]>
    decision_gates?: DeepChapterDecisionGates
    resume_checkpoint?: DeepChapterGenerationResumeCheckpoint
    evidence_refs?: string[]
    dimension_results?: NovelSessionStatus["dimension_results"]
    stage_metrics?: StageMetricEntry[]
    review_job?: NovelSessionStatus["review_job"]
    chase_debt?: NovelSessionStatus["chase_debt"]
    de_ai_batch?: NovelSessionStatus["de_ai_batch"]
    step_digest?: NovelSessionStatus["step_digest"]
    route_shell_mode?: NovelSessionStatus["route_shell_mode"]
    canon_migration?: NovelSessionStatus["canon_migration"]
    anti_ai_mode?: NovelSessionStatus["anti_ai_mode"]
  },
): NovelSessionStatus {
  // Use `key in overrides` (not `!== undefined`) so a caller passing
  // `resume_checkpoint: undefined` explicitly clears the field, faithfully
  // mirroring the prior `...base, resume_checkpoint: input.checkpoint` spread
  // semantics (where input.checkpoint may be undefined and overwrites base).
  // A caller omitting the key entirely inherits base — the delta-only path.
  const currentTask: NovelSessionStatus["current_task"] = "current_task" in overrides && overrides.current_task
    ? { ...base.current_task, ...overrides.current_task }
    : base.current_task
  const draft: NovelSessionStatus["draft"] = "draft" in overrides && overrides.draft
      ? { ...base.draft, ...overrides.draft }
      : base.draft
  const decisionGates = "decision_gates" in overrides
    ? cloneDecisionGates(overrides.decision_gates)
    : base.decision_gates
  const resumeCheckpoint = "resume_checkpoint" in overrides
    ? overrides.resume_checkpoint
    : base.resume_checkpoint
  const evidenceRefs = "evidence_refs" in overrides
    ? (overrides.evidence_refs ?? base.evidence_refs)
    : base.evidence_refs
  const dimensionResults = "dimension_results" in overrides
    ? overrides.dimension_results
    : base.dimension_results
  const stageMetrics = "stage_metrics" in overrides
    ? overrides.stage_metrics
    : base.stage_metrics
  const reviewJob = "review_job" in overrides
    ? overrides.review_job
    : base.review_job
  const chaseDebt = "chase_debt" in overrides
    ? overrides.chase_debt
    : base.chase_debt
  const deAiBatch = "de_ai_batch" in overrides
    ? overrides.de_ai_batch
    : base.de_ai_batch
  const stepDigest = "step_digest" in overrides
    ? overrides.step_digest
    : base.step_digest
  const routeShellMode = "route_shell_mode" in overrides
    ? overrides.route_shell_mode
    : base.route_shell_mode
  const canonMigration = "canon_migration" in overrides
    ? overrides.canon_migration
    : base.canon_migration
  const antiAiMode = "anti_ai_mode" in overrides
    ? overrides.anti_ai_mode
    : base.anti_ai_mode
  return {
    schema_version: base.schema_version,
    session_id: base.session_id,
    source: base.source,
    created_at: base.created_at,
    updated_at: overrides.updated_at,
    status: overrides.status,
    active_step_index: "active_step_index" in overrides && overrides.active_step_index !== undefined
      ? overrides.active_step_index
      : base.active_step_index,
    current_task: currentTask,
    draft,
    decision_gates: decisionGates,
    resume_checkpoint: resumeCheckpoint,
    evidence_refs: evidenceRefs,
    dimension_results: dimensionResults,
    stage_metrics: stageMetrics,
    review_job: reviewJob,
    chase_debt: chaseDebt,
    de_ai_batch: deAiBatch,
    step_digest: stepDigest,
    route_shell_mode: routeShellMode,
    canon_migration: canonMigration,
    anti_ai_mode: antiAiMode,
  }
}

/**
 * ISS-20260709-005/027：lifecycle 孪生收敛到 buildLifecycleStatus 工厂。
 *
 * canonical 工厂名（ISS 命名口径）；实现与 ADR-31 `buildNextStatus` 同一函数
 * （别名，非复制），7 lifecycle 函数经此收敛，8 核心字段全保留：
 * updated_at/status/active_step_index/current_task/draft/decision_gates/
 * resume_checkpoint/evidence_refs（其余 additive 字段同样透传，零行为变更）。
 * 保留 `buildNextStatus` 导出作向后兼容别名，对外接口不变。
 */
export const buildLifecycleStatus = buildNextStatus

export type BuildLifecycleStatusOverrides = Parameters<typeof buildNextStatus>[1]

/**
 * ADR-31 (EPIC-000, lifecycle-twin factory extraction): shared checkpoint
 * persistence helper. Encapsulates the status.json truth-source write (the
 * `.novel/status.json` file, which carries the embedded resume_checkpoint as a
 * nested field — no separate checkpoint file is created, which would
 * violate HARD-1 status.json sole truth-source) plus optional evidence_refs
 * append, so the 6 lifecycle functions share one write path instead of each
 * inlining saveNovelSessionStatus + evidence merge.
 *
 * `evidenceEntries`, when supplied, are merged into next.evidence_refs (deduped
 * via mergeEvidenceRefs) before the status.json write — mirroring the prior
 * `mergeEvidenceRefs(...base.evidence_refs, draftPath[, formalChapterPath])`
 * pattern but centralized so a future lifecycle function cannot forget to
 * thread evidence refs through.
 *
 * HARD-1 (status.json sole truth-source): writes only .novel/status.json via
 * saveNovelSessionStatus; no new session-state file is created. `sessionId`
 * is accepted for parity with the lifecycle function signatures and MUST match
 * next.session_id (the truth-source identity); it is not used to derive a
 * separate file path.
 */
function preparePersistPayload(
  sessionId: string,
  next: NovelSessionStatus,
  evidenceEntries?: string[],
): void {
  if (evidenceEntries && evidenceEntries.length > 0) {
    next.evidence_refs = mergeEvidenceRefs(...next.evidence_refs, ...evidenceEntries)
  }
  // Guard the truth-source identity: a caller passing a mismatched sessionId
  // would persist a next.status belonging to a different session, corrupting
  // the truth-source. Throw rather than silently write.
  if (next.session_id !== sessionId) {
    throw new Error(
      `persistCheckpointBase 真源身份不匹配：next.session_id=${next.session_id} 但传入 sessionId=${sessionId}`,
    )
  }
}

export async function persistCheckpointBase(
  projectPath: string,
  sessionId: string,
  next: NovelSessionStatus,
  evidenceEntries?: string[],
): Promise<void> {
  preparePersistPayload(sessionId, next, evidenceEntries)
  await saveNovelSessionStatus(projectPath, next)
}

/**
 * ST-1: persistCheckpointBase 的锁内变体。调用方必须已持有 session-status 锁
 * （经 withSessionStatusLock / updateNovelSessionStatus 进入）；写盘走无锁
 * writeNovelSessionStatusUnlocked，避免对同一把非重入锁二次获取导致等待超时。
 * 真源身份护栏与 evidence 合并语义与 persistCheckpointBase 完全一致。
 *
 * P0 原子提交：draft 工件 + status.json 经 commitDraftAndStatusBatch 单次
 * writeFilesAtomic 批量事务落盘（R4 模式），失败即零落盘并上抛，禁止吞错
 * 降级为静默不一致。无 draft 变更时 draftFiles 为空数组，退化为单文件批量
 * （仍走 writeFilesAtomic，保持统一失败语义）。
 */
async function persistCheckpointBaseWithinLock(
  projectPath: string,
  sessionId: string,
  next: NovelSessionStatus,
  evidenceEntries?: string[],
  draftFiles: PendingDraftFile[] = [],
): Promise<void> {
  preparePersistPayload(sessionId, next, evidenceEntries)
  await commitDraftAndStatusBatch(projectPath, draftFiles, next)
}

/**
 * EPIC-002 / ADR-30 / TASK-013 / Story 2.3: 追加一条结构化阶段指标到
 * status.json `stage_metrics` additive optional 字段。
 *
 * 读现有 status.json（HARD-1 唯一真源）→ append 条目 → buildNextStatus 工厂
 * （ADR-31）→ persistCheckpointBase 写回。不新建第二份真源文件（HARD-1 守恒），
 * 复用现有 stage_metrics additive optional 字段（缺时 []，向后兼容）。
 *
 * 失败非致命（non-fatal）— 阶段指标采集不影响主链生成。
 *
 * @param projectPath 项目根路径
 * @param entry      阶段指标条目（stage/tokenCost/latencyMs/partial/chapterId/timestamp）
 */
export async function appendStageMetric(
  projectPath: string,
  entry: StageMetricEntry,
): Promise<void> {
  try {
    // ST-1: load→modify→write 收进同一把 session-status 锁（共识写作 N 路并行
    // 调用本函数是常态，锁外 RMW 会令 N 路阶段指标仅存最后一路）。
    await updateNovelSessionStatus(projectPath, (existing) => {
      if (!existing) return null
      const metrics = Array.isArray(existing.stage_metrics) ? existing.stage_metrics : []
      // 上限保护：单项目跨章节累积阶段指标封顶，避免无界增长（与
      // routingROIBuckets/exemplarABuckets 一致，1024 条）。
      const STAGE_METRICS_MAX = 1024
      const next = [...metrics, entry]
      while (next.length > STAGE_METRICS_MAX) {
        next.shift()
      }
      return buildNextStatus(existing, {
        updated_at: new Date().toISOString(),
        status: existing.status,
        stage_metrics: next,
      })
    })
  } catch (err) {
    // non-fatal — 阶段指标采集失败不阻断主链
    // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
    logger.warn("Novel Session", "stage metrics append failed (non-fatal)", { error: toErrorMessage(err) })
  }
}

async function writeDraftArtifact(
  input: DeepChapterSessionInput,
  sessionId: string,
  draftStatus: NovelDraftStatus,
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  reviewResults: NovelReviewResult[],
  options: WriteDraftArtifactOptions = {},
): Promise<string> {
  const now = new Date().toISOString()
  const draftId = input.conversationId
  const existing = await loadNovelDraftArtifact(input.projectPath, draftId)
  const { filePath, artifact, supersededPath, supersededArtifact } = buildDraftArtifacts(
    input,
    sessionId,
    draftStatus,
    checkpoint,
    reviewResults,
    options,
    existing,
    now,
  )
  // CORR-003 (odyssey): supersede when the existing draft belongs to a
  // different session OR is a legacy draft with no session_id (the field is
  // optional — loadNovelDraftArtifact does not require it). Previously the
  // `existing.session_id` truthiness guard let legacy drafts fall through to
  // a silent overwrite, losing the original content/review_results without
  // creating a superseded.{timestamp}.json audit copy. `undefined !== sessionId`
  // is true, so legacy drafts now route through the supersede path.
  if (supersededPath && supersededArtifact) {
    await ensureNovelSessionDirs(input.projectPath)
    await writeVerifiedJson(
      supersededPath,
      supersededArtifact,
      "superseded 草稿文件",
      (parsed) => verifySupersededDraft(parsed, draftId, filePath),
    )
  }
  await ensureNovelSessionDirs(input.projectPath)
  await writeVerifiedJson(
    filePath,
    artifact,
    "草稿文件",
    (parsed) => verifyDraftArtifact(parsed, draftId, input.conversationId, sessionId, draftStatus),
  )
  void sessionId
  return filePath
}

export async function loadNovelDraftArtifact(
  projectPath: string,
  draftId: string,
): Promise<NovelDraftArtifact | null> {
  try {
    const raw = await readFile(novelDraftArtifactPath(projectPath, draftId))
    const parsed = JSON.parse(raw) as Partial<NovelDraftArtifact>
    if (
      typeof parsed?.draft_id !== "string"
      || typeof parsed?.conversation_id !== "string"
      || typeof parsed?.user_request !== "string"
      || typeof parsed?.draft_status !== "string"
      || typeof parsed?.content !== "string"
      || !Array.isArray(parsed?.review_results)
      || typeof parsed?.created_at !== "string"
      || typeof parsed?.updated_at !== "string"
      // PAT-G2 (odyssey generalize): validate draft_status enum membership, not
      // just typeof string. CORR-008 added this guard to loadNovelSessionStatus;
      // the sibling draft loader only got the typeof check. An unknown value
      // (e.g. "garbage") bypasses the superseded-audit-copy branch in
      // writeDraftArtifact (unknown !== "superseded" is true) and could be
      // silently overwritten without an audit copy. Reject at the load boundary.
      || !DRAFT_STATUSES.includes(parsed.draft_status as NovelDraftStatus)
    ) {
      return null
    }
    return {
      ...(parsed as NovelDraftArtifact),
      decision_gates: cloneDecisionGates(parsed.decision_gates),
    }
  } catch (err) {
    // ISS-20260709-025 PAT-IM2: 草稿解析降级记诊断（控制流不变，仍返回 null）。
    logger.warn("Novel Session", "parse draft artifact failed, degrade to null (non-fatal)", { error: toErrorMessage(err) })
    return null
  }
}

export async function requireManagedDeepChapterDraft(
  projectPath: string,
  conversationId: string,
  mode: DraftDecisionMode,
): Promise<NovelDraftArtifact> {
  const draft = await loadNovelDraftArtifact(projectPath, conversationId)
  if (!draft || draft.conversation_id !== conversationId || !draft.session_id) {
    throw new Error("No managed deep chapter draft found for this conversation.")
  }

  // CORR-007 (odyssey): reject accepts both "ready" and "pending". The Draft-first
  // spec (coding-009) describes the normal flow pending→ready→accepted|rejected,
  // but reject-from-pending is the intentional abort path — a user abandoning an
  // in-progress (not-yet-ready) draft. Accept requires "ready" (the generation
  // completed and passed gates) so a partial/aborted draft cannot be accepted.
  // Confirmed-not-bug: the asymmetry is by design.
  const allowedStatuses: NovelDraftStatus[] = mode === "accept"
    ? ["ready"]
    : ["ready", "pending"]
  if (!allowedStatuses.includes(draft.draft_status)) {
    throw new Error(`Deep chapter draft is not eligible for ${mode} in status ${draft.draft_status}.`)
  }

  return draft
}

/**
 * DF-1: 战役批量验收通道的受管草稿注册点。
 *
 * 战役（含全自动巡航）不经过聊天会话生命周期（start/complete 等），原先直接以
 * conversationId="autonomous-campaign" 调 accept，而全库无该会话的受管草稿写入点，
 * requireManagedDeepChapterDraft 必抛 → formal-writeback 删文件后降级直写正式正文、
 * acceptedCount 仍报成功。本函数复用既有受管草稿写入设施 writeDraftArtifact，以
 * "ready" 状态注册（或刷新）战役会话草稿，使 accept 的 Draft-first 校验成立；
 * requireManagedDeepChapterDraft 校验本身不放宽。
 *
 * session 身份：复用现有 status.json 的 session_id（存在时），使 accept 经
 * buildNextStatus 在同一 session 上叠加，不因新建 base 重置真源既有 additive 字段；
 * 无 status.json 时才新建 session id（与 createBaseStatus 缺省路径一致）。
 */
export async function registerManagedCampaignDraft(input: {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber: number
  finalContent: string
  reviewResults?: NovelReviewResult[]
  decisionGates?: DeepChapterDecisionGates
}): Promise<string> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const sessionId = existing?.session_id ?? createNovelSessionId(new Date())
  return writeDraftArtifact(
    {
      projectPath: input.projectPath,
      conversationId: input.conversationId,
      userRequest: input.userRequest,
      chapterNumber: input.chapterNumber,
    },
    sessionId,
    "ready",
    undefined,
    input.reviewResults ?? [],
    { finalContent: input.finalContent, decisionGates: input.decisionGates },
  )
}

/**
 * T09: zod passthrough 加载边界护栏的 schema。
 *
 * 与现有 CORR-008 / PAT-G2 手动校验等价的核心字段 + 4 个 additive 项目级开关;
 * `.passthrough()` 保留未知键（未来 additive 字段 / 派生键不丢）。TS 类型唯一源
 * 仍是文件顶部 `NovelSessionStatus` interface; 本 schema 仅作运行时校验护栏,
 * 不另立类型真源。
 */
const SESSION_STATUS_ENUM = ["running", "completed", "paused", "blocked", "interrupted"] as const
const DRAFT_STATUS_ENUM = ["pending", "ready", "accepted", "rejected", "superseded"] as const

const novelSessionStatusLoadSchema = z
  .object({
    schema_version: z.literal("1"),
    session_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    status: z.enum(SESSION_STATUS_ENUM),
    active_step_index: z.number().nullable(),
    current_task: z
      .object({
        conversation_id: z.string(),
        user_request: z.string(),
        status: z.enum(SESSION_STATUS_ENUM),
      })
      .passthrough(),
    draft: z
      .object({
        draft_id: z.string(),
        file_path: z.string(),
        draft_status: z.enum(DRAFT_STATUS_ENUM),
      })
      .passthrough(),
    // 4 additive 项目级开关（与 NovelSessionStatus interface 字段一一对应;
    // 缺省 optional → 回填为 undefined, 不污染旧 status.json）。
    step_digest: z.string().optional(),
    route_shell_mode: z
      .union([z.literal("legacy"), z.literal("route"), z.string()])
      .optional(),
    canon_migration: z
      .union([z.literal("legacy"), z.literal("dual"), z.literal("shadow"), z.string()])
      .optional(),
    anti_ai_mode: z
      .union([z.literal("off"), z.literal("warn"), z.literal("block"), z.string()])
      .optional(),
    // 波2-A additive: draft-autoarm 裁定落盘（strict 校验，缺省 optional →
    // 旧 status.json 无此字段不污染，回填 undefined）。
    draft_auto_arm: DRAFT_AUTO_ARM_SCHEMA.optional(),
  })
  .passthrough()

/**
 * T09: zod passthrough 加载边界护栏（validateAndBackfill）。
 *
 * 职责: 对 loadNovelSessionStatus 解析出的 JSON 对象做「校验 + 默认值回填 +
 * 保留未知键」三件事, 作为 status.json 唯一真源的加载边界（HARD-1 守恒）:
 *  - 校验: 核心字段（schema_version/session_id/枚举等）, 与现有 CORR-008 / PAT-G2
 *    手动校验等价 —— 不放松, 也不收窄到手动校验之外。
 *  - 默认值回填: 4 个 additive 项目级开关（step_digest / route_shell_mode /
 *    canon_migration / anti_ai_mode）缺省回填为 undefined（未设置 → 走各调用点
 *    默认回退, 不污染旧 status.json）。
 *  - 保留未知键: `.passthrough()` 保留未来 additive 字段与派生键, 不丢字段。
 *
 * TS 类型唯一源: 返回的仍是 `NovelSessionStatus`（由文件顶部 interface 定义）;
 * zod schema 仅作运行时校验护栏, 不另立类型真源。
 *
 * 写路径不动（ADR-16）: 本函数只读校验, 不参与任何 status.json 写入。
 *
 * @returns 校验通过返回回填后的 NovelSessionStatus; 失败返回 null（与手动校验
 *          一致降级为「文件不可信 → null」）。
 */
export function validateAndBackfillNovelSessionStatus(raw: unknown): NovelSessionStatus | null {
  const parsed = novelSessionStatusLoadSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data as Record<string, unknown>
  return {
    ...data,
    step_digest: data.step_digest as string | undefined,
    route_shell_mode: data.route_shell_mode as RouteShellMode | undefined,
    canon_migration: data.canon_migration as CanonMigrationMode | undefined,
    anti_ai_mode: data.anti_ai_mode as AntiAiMode | undefined,
    decision_gates: cloneDecisionGates(
      data.decision_gates as Partial<DeepChapterDecisionGates> | undefined,
    ),
  } as NovelSessionStatus
}

/**
 * CORR-A (corrupt-preserve): load 损坏分支的诊断结果。
 *
 * `corrupt` 仅在 status.json「可读且非空、但 JSON 解析 / 手动校验 / zod 护栏
 * 失败」时存在 —— 即真正损坏、会被下游重建静默覆盖的文件。文件缺失、读取
 * 失败（ENOENT 等）或空文件（无字节可保全）不产生 corrupt 标记。
 * `preservedTo` 为 null 表示原始字节保全失败（fail-loud），调用方据此
 * 拒绝覆盖唯一副本；非 null 为 `.corrupt-*` 兄弟文件落点。
 */
interface NovelSessionStatusLoadResult {
  status: NovelSessionStatus | null
  corrupt?: { preservedTo: string | null }
}

/**
 * CORR-A: 把损坏 status.json 的原始字节原样保全到同目录 `.corrupt-<时间戳>`
 * 兄弟文件（命名与 projection-status-ledger 的 preserveCorruptLedger 一致：
 * 同基名插入 `.corrupt-<ISO 时间戳（:/. → -）>` 后缀，扩展名保持 .json）。
 * 原 status.json 一字不动，绝不先覆盖后保全。
 *
 * 保全 best-effort：失败绝不打断 load 的可用性降级（仍返回 null），但必须
 * fail-loud 报出「未保全」，并返回 null 让 startDeepChapterSession 拒绝覆盖。
 */
/**
 * #7（2026-10-28）：status.json 缺失判定。新项目 / 尚未开写时文件不存在属预期状态，
 * 不应每次读取都刷 warn。文案对齐 character-state.ts / director-pipeline-store.ts 既有先例
 * （含 Windows Rust read_file 的 os error 2 与中文 locale 文案）。
 */
function isStatusFileMissingError(err: unknown): boolean {
  return /ENOENT|not found|no such file|does not exist|os error 2|系统找不到/i.test(toErrorMessage(err))
}

async function preserveCorruptStatusFile(projectPath: string, raw: string): Promise<string | null> {
  const statusPath = novelSessionStatusPath(projectPath)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const corruptPath = `${novelDirPath(projectPath)}/status.corrupt-${stamp}.json`
    await writeFileAtomic(corruptPath, raw)
    // ISS-20260709-050: 脱敏 — 只记路径，不记原文/错误对象。
    logger.error("Novel Session", "corrupted status.json detected, original preserved", { status: statusPath, preservedTo: corruptPath })
    return corruptPath
  } catch (error) {
    // 保全失败 → fail-loud；startDeepChapterSession 检测到「未保全」标记后
    // 拒绝覆盖已有文件（禁止在未保全的情况下覆盖唯一副本）。
    // ISS-20260709-050: 只记名与 message（toErrorMessage），禁原文外泄。
    logger.error("Novel Session", "FAILED to preserve corrupt status.json, refuse overwrite", { status: statusPath, error: toErrorMessage(error) })
    return null
  }
}

/**
 * CORR-A: 带损坏诊断的 load 内部实现（公共 loadNovelSessionStatus 委托本函数
 * 并只取 status）。startDeepChapterSession 消费 `corrupt` 标记做覆盖前安全联锁。
 */
async function loadNovelSessionStatusDetailed(projectPath: string): Promise<NovelSessionStatusLoadResult> {
  // 跨读/解析边界保留原始字节：损坏时先保全 `.corrupt-*` 兄弟文件，再
  // fail-loud 降级返回 null（绝不静默）。
  let raw: string | undefined
  try {
    raw = await readFile(novelSessionStatusPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<NovelSessionStatus>
    if (
      parsed?.schema_version !== "1"
      || typeof parsed.session_id !== "string"
      || typeof parsed.created_at !== "string"
      || typeof parsed.updated_at !== "string"
      || typeof parsed.current_task?.conversation_id !== "string"
      || typeof parsed.current_task?.user_request !== "string"
      || typeof parsed.draft?.draft_id !== "string"
      || typeof parsed.draft?.file_path !== "string"
      // CORR-008 (odyssey): validate the lifecycle + draft enum values so a
      // corrupted status.json (e.g. status:"foo" or draft_status:"bar") is
      // rejected at the truth-source load boundary, not spread through and
      // silently treated as "still running/pending" by downstream === checks.
      || !SESSION_LIFECYCLE_STATUSES.includes(parsed.status as NovelSessionLifecycleStatus)
      || !DRAFT_STATUSES.includes(parsed.draft?.draft_status as NovelDraftStatus)
      // PAT-G2 (odyssey generalize): current_task.status is the same
      // NovelSessionLifecycleStatus enum as the top-level status (line 68), but
      // CORR-008 only guarded the outer field. A corrupted current_task.status
      // (e.g. "foo") passed validation and was spread through, then misbehaved
      // in downstream === "running"/=== "completed" checks. Guard the nested
      // twin field of the same enum.
      || !SESSION_LIFECYCLE_STATUSES.includes(parsed.current_task?.status as NovelSessionLifecycleStatus)
      || (parsed.active_step_index !== null && typeof parsed.active_step_index !== "number")
    ) {
      return { status: null, corrupt: { preservedTo: await preserveCorruptStatusFile(projectPath, raw) } }
    }
    // T09: zod passthrough 加载边界护栏（校验+默认值回填+保留未知键）。
    // 上方 CORR-008 / PAT-G2 手动枚举/必填校验已通过; 此处再经 zod 护栏回填
    // 4 个 additive 项目级开关默认值（undefined）并保留未知键（.passthrough）。
    const backfilled = validateAndBackfillNovelSessionStatus(parsed)
    if (!backfilled) {
      // zod 护栏独立拒绝（manual 校验之外）同样是损坏信号：先保全再降级。
      return { status: null, corrupt: { preservedTo: await preserveCorruptStatusFile(projectPath, raw) } }
    }
    return { status: backfilled }
  } catch (err) {
    // CORR-A: 读取失败（ENOENT 等）或空文件无原始字节可保全，保持既有 null
    // 降级；解析失败（raw 已取得）先把原始内容写为 `.corrupt-<时间戳>` 兄弟
    // 文件，再 fail-loud 返回 null。禁止在未保全的情况下被下游覆盖。
    // ISS-20260709-025 PAT-IM2: 记诊断（读失败 vs 解析失败分支不变）。
    if (raw === undefined && isStatusFileMissingError(err)) {
      // #7：文件缺失是预期降级路径（新项目 / 尚未开写），降为 info，不再污染 warn 日志。
      logger.info("Novel Session", "status.json not present yet, degrade to null", { status: novelSessionStatusPath(projectPath) })
      return { status: null }
    }
    logger.warn("Novel Session", "load session detailed failed, degrade to null (non-fatal)", { error: toErrorMessage(err) })
    if (raw === undefined || raw.length === 0) return { status: null }
    return { status: null, corrupt: { preservedTo: await preserveCorruptStatusFile(projectPath, raw) } }
  }
}

export async function loadNovelSessionStatus(projectPath: string): Promise<NovelSessionStatus | null> {
  return (await loadNovelSessionStatusDetailed(projectPath)).status
}

/**
 * ST-1: status.json per-project 锁键（与 ledger 的键前缀区分；既有键名保留，
 * 不改变任何已在线程内的锁语义）。
 */
function sessionStatusLockKey(projectPath: string): string {
  return `session-status:${normalizePath(projectPath)}`
}

/** ST-1: 复用 novel-locks 既有 FIFO 互斥（勿另造）的 session-status 锁包装。 */
function withSessionStatusLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  return withProjectLock(sessionStatusLockKey(projectPath), fn)
}

/**
 * status.json 实际写盘（无锁）。调用方要么已持有 session-status 锁
 * （锁内生命周期函数 / updateNovelSessionStatus），要么经 saveNovelSessionStatus
 * 这一锁外入口进入；两条路径共用唯一写实现，防止双写实现漂移。
 */
async function writeNovelSessionStatusUnlocked(
  projectPath: string,
  status: NovelSessionStatus,
): Promise<void> {
  await ensureNovelSessionDirs(projectPath)
  const statusPath = novelSessionStatusPath(projectPath)
  await writeVerifiedJson(
    statusPath,
    status,
    "小说会话状态文件",
    (parsed) => {
      const candidate = parsed as Partial<NovelSessionStatus> | null
      return candidate?.session_id === status.session_id
        && candidate?.current_task?.conversation_id === status.current_task.conversation_id
        && candidate?.status === status.status
        && candidate?.draft?.draft_status === status.draft.draft_status
    },
  )
}

export async function saveNovelSessionStatus(
  projectPath: string,
  status: NovelSessionStatus,
): Promise<void> {
  // Phase4 锁族：status.json 并锁（与 ledger 共用 per-project 键前缀区分，
  // 防止 community rebuild 与 ingest 并行写会话状态时 RMW 交错）。
  await withSessionStatusLock(projectPath, () => writeNovelSessionStatusUnlocked(projectPath, status))
}

/**
 * ST-1: status.json 读-改-写事务（load→mutate→write 收进同一把锁）。
 *
 * 旧实现下所有调用方均为「锁外 load → buildNextStatus → 锁内 save」：后写者用
 * 旧快照整份覆盖先写者（共识写作 N 路并行 RMW 同一 status.json 是常态），
 * 字段确定性丢失。本函数把整段 RMW 包进与 saveNovelSessionStatus 同一把
 * session-status 锁，复用 novel-locks 既有实现；锁等待超时/熔断行为沿用
 * LOCK_WAIT_TIMEOUT_MS（锁内执行不另设超时，与既有 save 语义一致）。
 *
 * mutator 约定：
 *  - 传入当前真源（文件不存在/损坏时为 null）；返回 next 则落盘，返回 null 则跳过写。
 *  - mutator 内禁止再调用任何 status.json 读写 API（同一把锁不可重入，会等待超时）。
 */
export type NovelSessionStatusMutator = (
  current: NovelSessionStatus | null,
) => NovelSessionStatus | null | Promise<NovelSessionStatus | null>

export async function updateNovelSessionStatus(
  projectPath: string,
  mutator: NovelSessionStatusMutator,
): Promise<NovelSessionStatus | null> {
  return withSessionStatusLock(projectPath, async () => {
    const current = await loadNovelSessionStatus(projectPath)
    const next = await mutator(current)
    if (!next) return null
    await writeNovelSessionStatusUnlocked(projectPath, next)
    return next
  })
}

export async function startDeepChapterSession(
  input: DeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => startDeepChapterSessionWithinLock(input))
}

async function startDeepChapterSessionWithinLock(
  input: DeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const now = new Date().toISOString()
  // CORR-A: 损坏保全标记联锁 —— load 已把损坏 status.json 的原始字节保全到
  // `.corrupt-*` 兄弟文件；若保全失败（preservedTo === null），重建覆盖会
  // 丢失唯一副本 → 不得覆盖已有文件，fail-loud 拒绝写盘。既有测试语义不变：
  // 文件缺失/读取失败/空文件不触发；保全成功时照常重建（损坏字节已留存）。
  const loaded = await loadNovelSessionStatusDetailed(input.projectPath)
  if (loaded.corrupt && loaded.corrupt.preservedTo === null) {
    throw new Error(
      `[novel-session-status] 拒绝覆盖未保全的损坏 status.json（${novelSessionStatusPath(input.projectPath)}）：preservation failed`,
    )
  }
  const existing = loaded.status
  const sessionId = canReuseExistingSession(existing, input)
    ? existing.session_id
    : createNovelSessionId(new Date(now))
  const createdAt = canReuseExistingSession(existing, input) ? existing.created_at : now
  const draftPath = novelDraftArtifactPath(input.projectPath, input.conversationId)
  const next = createBaseStatus(input, sessionId, createdAt, draftPath)
  next.updated_at = now
  next.active_step_index = stageToActiveStepIndex(input.resumeCheckpoint?.stage ?? "started")
  next.current_task.checkpoint_stage = input.resumeCheckpoint?.stage ?? "started"
  next.draft.checkpoint_stage = input.resumeCheckpoint?.stage
  next.resume_checkpoint = input.resumeCheckpoint
  if (input.resumeCheckpoint) {
    const savedDraftPath = await writeDraftArtifact(
      input,
      sessionId,
      "pending",
      input.resumeCheckpoint,
      input.resumeCheckpoint.reviewResults ?? [],
      { decisionGates: input.resumeCheckpoint.decisionGates },
    )
    next.draft.file_path = savedDraftPath
    next.decision_gates = cloneDecisionGates(input.resumeCheckpoint.decisionGates)
    next.evidence_refs = mergeEvidenceRefs(savedDraftPath)
  }
  await writeNovelSessionStatusUnlocked(input.projectPath, next)
  return next
}

export async function persistDeepChapterCheckpoint(
  input: PersistDeepChapterCheckpointInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => persistDeepChapterCheckpointWithinLock(input))
}

async function persistDeepChapterCheckpointWithinLock(
  input: PersistDeepChapterCheckpointInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = isSameSessionBase(existing, input.sessionId)
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  // P0 原子提交：先 prepare 草稿待提交文件（不落盘），再构造 status，最后
  // 单次 writeFilesAtomic 批量提交 draft + status 同事务。
  const prepared = await prepareDraftWrites(
    input,
    input.sessionId,
    "pending",
    input.checkpoint,
    input.checkpoint.reviewResults ?? [],
    { decisionGates: input.checkpoint.decisionGates },
  )
  const draftPath = prepared.filePath
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "running",
    active_step_index: stageToActiveStepIndex(input.checkpoint.stage),
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint.stage,
      status: "running",
      last_error: undefined,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "pending",
      checkpoint_stage: input.checkpoint.stage,
      updated_at: now,
    },
    decision_gates: input.checkpoint.decisionGates ?? base.decision_gates,
    resume_checkpoint: input.checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // CORR-006 / DC-2: 6-dim review map persisted via resolveDimensionResults
    // (centralized twin-safe helper). Additive field: older status files lack
    // it; loadNovelSessionStatus spreads Partial safely.
    dimension_results: resolveDimensionResults(input.checkpoint, base),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, input.sessionId, next, undefined, prepared.files)
  return next
}

export async function completeDeepChapterSession(
  input: CompleteDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => completeDeepChapterSessionWithinLock(input))
}

async function completeDeepChapterSessionWithinLock(
  input: CompleteDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = isSameSessionBase(existing, input.sessionId)
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  // P0 原子提交：先 prepare 草稿待提交文件（不落盘），再构造 status，最后
  // 单次 writeFilesAtomic 批量提交 draft + status 同事务。
  const prepared = await prepareDraftWrites(
    input,
    input.sessionId,
    "ready",
    input.checkpoint,
    input.reviewResults ?? [],
    {
      finalContent: input.finalContent,
      decisionGates: input.checkpoint?.decisionGates ?? base.decision_gates,
      contextUsage: input.contextUsage,
    },
  )
  const draftPath = prepared.filePath
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "ready",
      checkpoint_stage: input.checkpoint?.stage,
      updated_at: now,
    },
    decision_gates: input.checkpoint?.decisionGates ?? base.decision_gates,
    resume_checkpoint: input.checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // DC-2: 6-dim review map via centralized resolveDimensionResults helper
    // (was inlined ?? base.dimension_results; on fresh-base path the spread
    // yielded undefined and the checkpoint's 6-dim map was dropped on
    // completion — F-003 twin-path omission, now twin-safe via helper).
    dimension_results: resolveDimensionResults(input.checkpoint, base),
    // Wave B: write ready + review queued (never blocks write/accept).
    review_job: markWriteReadyThenQueueReview(
      base.review_job,
      input.checkpoint?.chapterNumber ?? input.chapterNumber,
    ),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, input.sessionId, next, undefined, prepared.files)
  return next
}

export async function pauseDeepChapterSession(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => pauseDeepChapterSessionWithinLock(input))
}

async function pauseDeepChapterSessionWithinLock(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = isSameSessionBase(existing, input.sessionId)
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  let draftPath = base.draft.file_path
  let draftFiles: PendingDraftFile[] = []
  if (input.checkpoint) {
    // P0 原子提交：prepare 不落盘，后续与 status 同一批次提交。
    const prepared = await prepareDraftWrites(
      input,
      input.sessionId,
      "pending",
      input.checkpoint,
      input.checkpoint.reviewResults ?? [],
      { decisionGates: input.checkpoint.decisionGates ?? base.decision_gates },
    )
    draftPath = prepared.filePath
    draftFiles = prepared.files
  }
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "paused",
    active_step_index: input.checkpoint
      ? stageToActiveStepIndex(input.checkpoint.stage)
      : base.active_step_index,
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint?.stage ?? base.current_task.checkpoint_stage,
      status: "paused",
      last_error: input.errorMessage,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: input.checkpoint ? "pending" : base.draft.draft_status,
      checkpoint_stage: input.checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
    },
    decision_gates: input.checkpoint?.decisionGates ?? base.decision_gates,
    resume_checkpoint: input.checkpoint ?? base.resume_checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // DC-2: 6-dim review map via centralized helper (was ARCH-006 twin fix,
    // now twin-safe — cannot be omitted by a future lifecycle function).
    dimension_results: resolveDimensionResults(input.checkpoint, base),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, input.sessionId, next, undefined, draftFiles)
  return next
}

/**
 * J10-02：重启加载时把上个进程残留的 running/paused 降级为 interrupted 持久态。
 * 幽灵 running 修复——落盘态准确反映「进程已终止的任务」，二次重启不再误当 running。
 * 幂等：已是 interrupted/非 running|paused 态 → 原样返回不写。
 * 不改 draft/checkpoint/decision_gates——中断任务的可续作证据原样保留。
 */
export async function markSessionInterrupted(projectPath: string): Promise<NovelSessionStatus | null> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(projectPath, () => markSessionInterruptedWithinLock(projectPath))
}

async function markSessionInterruptedWithinLock(
  projectPath: string,
): Promise<NovelSessionStatus | null> {
  const existing = await loadNovelSessionStatus(projectPath)
  if (!existing) return null
  if (existing.status !== "running" && existing.status !== "paused") return existing
  const now = new Date().toISOString()
  const next = buildLifecycleStatus(existing, {
    updated_at: now,
    status: "interrupted",
    current_task: {
      ...existing.current_task,
      status: "interrupted",
    },
  })
  await persistCheckpointBaseWithinLock(projectPath, existing.session_id, next)
  return next
}

export async function blockDeepChapterSession(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→modify→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => blockDeepChapterSessionWithinLock(input))
}

async function blockDeepChapterSessionWithinLock(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = isSameSessionBase(existing, input.sessionId)
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  let draftPath = base.draft.file_path
  let draftFiles: PendingDraftFile[] = []
  if (input.checkpoint) {
    // P0 原子提交：prepare 不落盘，后续与 status 同一批次提交。
    const prepared = await prepareDraftWrites(
      input,
      input.sessionId,
      "pending",
      input.checkpoint,
      input.checkpoint.reviewResults ?? [],
      { decisionGates: input.checkpoint.decisionGates ?? base.decision_gates },
    )
    draftPath = prepared.filePath
    draftFiles = prepared.files
  }
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "blocked",
    active_step_index: null,
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint?.stage ?? base.current_task.checkpoint_stage,
      status: "blocked",
      last_error: input.errorMessage,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: input.checkpoint ? "pending" : base.draft.draft_status,
      checkpoint_stage: input.checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
    },
    decision_gates: input.checkpoint?.decisionGates ?? base.decision_gates,
    resume_checkpoint: input.checkpoint ?? base.resume_checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // DC-2: 6-dim review map via centralized helper (was ARCH-006 twin fix).
    dimension_results: resolveDimensionResults(input.checkpoint, base),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, input.sessionId, next, undefined, draftFiles)
  return next
}

function canReuseDecisionSession(
  existing: NovelSessionStatus | null,
  input: DraftDecisionInput,
): existing is NovelSessionStatus {
  if (!existing) return false
  /* v8 ignore next */
  if (input.sessionId) return existing.session_id === input.sessionId
  /* v8 ignore next */
  return canReuseExistingSession(existing, input)
}

function resolveDecisionBaseStatus(
  existing: NovelSessionStatus | null,
  input: DraftDecisionInput,
  now: string,
): NovelSessionStatus {
  if (canReuseDecisionSession(existing, input)) return existing
  return createBaseStatus(
    input,
    /* v8 ignore next */
    input.sessionId ?? createNovelSessionId(new Date(now)),
    now,
    novelDraftArtifactPath(input.projectPath, input.conversationId),
  )
}

export async function acceptDeepChapterDraft(
  input: DraftDecisionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→requireManaged→write 收进同一把锁（报告 :1475 accept 锁外读）。
  return withSessionStatusLock(input.projectPath, () => acceptDeepChapterDraftWithinLock(input))
}

async function acceptDeepChapterDraftWithinLock(
  input: DraftDecisionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const draft = await requireManagedDeepChapterDraft(input.projectPath, input.conversationId, "accept")
  const now = new Date().toISOString()
  // B2（守门四件套接线）：commit-discipline 接 accept 前单章闭环断言（v2.6.7 D4）。
  // 断言位置：回填发生前（writeDraftArtifact 之前），违规 → 拒绝 accept（fail-loud）。
  // checkCommitDiscipline 为纯函数（ADR-19 零 IO），此处只读断言、无额外副作用。
  const discipline = checkCommitDiscipline({
    chapterIds:
      draft?.chapter_number != null || input.chapterNumber != null
        ? [String(draft?.chapter_number ?? input.chapterNumber)]
        : [],
    touchesStatusJson: true,
    touchesCanonicalContent: input.formalChapterPath != null,
    touchesCanonicalMemory: input.formalChapterPath != null,
  })
  if (!discipline.ok) {
    throw new Error(
      `[commit-discipline] accept 被拒绝（单章 Draft-first 闭环违规）：${discipline.reasons.join("；")}`,
    )
  }
  const decisionInput = {
    ...input,
    sessionId: input.sessionId ?? draft.session_id,
  }
  const base = resolveDecisionBaseStatus(existing, decisionInput, now)
  const checkpoint = draft?.checkpoint ?? base.resume_checkpoint ?? input.resumeCheckpoint
  const chapterNumber = draft?.chapter_number ?? checkpoint?.chapterNumber ?? base.current_task.chapter_number ?? input.chapterNumber /* v8 ignore start */ /* v8 ignore stop */
  const reviewResults = draft?.review_results ?? checkpoint?.reviewResults ?? [] /* v8 ignore start */ /* v8 ignore stop */
  const decisionGates = draft?.decision_gates ?? checkpoint?.decisionGates ?? base.decision_gates /* v8 ignore start */ /* v8 ignore stop */
  // P0 原子提交：prepare 不落盘，后续与 status 同一批次提交。
  // 断言位置保持回填发生前（prepare 之前已做 commit-discipline 校验）。
  const prepared = await prepareDraftWrites(
    {
      ...input,
      chapterNumber,
    },
    base.session_id,
    "accepted",
    checkpoint,
    reviewResults,
    {
      finalContent: draft?.content,
      acceptedAt: now,
      formalChapterPath: input.formalChapterPath,
      decisionGates,
    },
  )
  const draftPath = prepared.filePath
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "accepted",
      checkpoint_stage: checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
      accepted_at: now,
      rejected_at: undefined,
      formal_chapter_path: input.formalChapterPath,
    },
    decision_gates: decisionGates,
    resume_checkpoint: checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath, input.formalChapterPath),
    // DC-2 (odyssey-improve): accept was the F-003 twin-path 4th recurrence —
    // it omitted dimension_results entirely, so on a fresh base (createBaseStatus
    // never sets it) the 6-dim review map was dropped when a draft was accepted.
    // Mirror the other 4 lifecycle functions via the centralized helper.
    dimension_results: resolveDimensionResults(checkpoint, base),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, base.session_id, next, undefined, prepared.files)
  return next
}

export async function rejectDeepChapterDraft(
  input: DraftDecisionInput,
): Promise<NovelSessionStatus> {
  // ST-1: load→requireManaged→write 收进同一把锁（读不再在锁外）。
  return withSessionStatusLock(input.projectPath, () => rejectDeepChapterDraftWithinLock(input))
}

async function rejectDeepChapterDraftWithinLock(
  input: DraftDecisionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const draft = await requireManagedDeepChapterDraft(input.projectPath, input.conversationId, "reject")
  const now = new Date().toISOString()
  const decisionInput = {
    ...input,
    sessionId: input.sessionId ?? draft.session_id,
  }
  const base = resolveDecisionBaseStatus(existing, decisionInput, now)
  const checkpoint = draft?.checkpoint ?? base.resume_checkpoint ?? input.resumeCheckpoint
  const chapterNumber = draft?.chapter_number ?? checkpoint?.chapterNumber ?? base.current_task.chapter_number ?? input.chapterNumber /* v8 ignore start */ /* v8 ignore stop */
  const reviewResults = draft?.review_results ?? checkpoint?.reviewResults ?? [] /* v8 ignore start */ /* v8 ignore stop */
  const decisionGates = draft?.decision_gates ?? checkpoint?.decisionGates ?? base.decision_gates /* v8 ignore start */ /* v8 ignore stop */
  // P0 原子提交：prepare 不落盘，后续与 status 同一批次提交。
  const prepared = await prepareDraftWrites(
    {
      ...input,
      chapterNumber,
    },
    base.session_id,
    "rejected",
    checkpoint,
    reviewResults,
    {
      finalContent: draft?.content,
      rejectedAt: now,
      decisionGates,
    },
  )
  const draftPath = prepared.filePath
  const next = buildLifecycleStatus(base, {
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "rejected",
      checkpoint_stage: checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
      accepted_at: undefined,
      rejected_at: now,
      formal_chapter_path: undefined,
    },
    decision_gates: decisionGates,
    resume_checkpoint: checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // DC-2 (odyssey-improve): reject twin of accept — omitted dimension_results,
    // dropping the 6-dim review map on fresh base. Mirror via centralized helper.
    dimension_results: resolveDimensionResults(checkpoint, base),
  })
  await persistCheckpointBaseWithinLock(input.projectPath, base.session_id, next, undefined, prepared.files)
  return next
}


// ---------------------------------------------------------------------------
// Finding-rewrite draft helpers (RPC-2 / TASK-007)
//
// 守 HARD-1 (status.json 唯一真源) + HARD-2 (Draft-first)：改写片段经
// NovelDraftStatus (pending/accepted/rejected) 流转，复用已导出
// novelDraftArtifactPath + writeFileAtomic，NOT module-private writeDraftArtifact
// (其强耦合 DeepChapterSessionInput / checkpoint_stage / decision_gates)。draft
// artifact 路径用 `finding-rewrite-${sessionId}` key 隔离，避免与 deep-chapter
// draft 碰撞（CLAUDE.md 文件锚点：草稿/会话状态 anchor = novel-session-status.ts）。
// ---------------------------------------------------------------------------

export interface FindingRewriteDraftInput {
  chapterId: string
  originalText: string
  replacementText: string
  findingId?: string
}

export async function writeFindingRewriteDraft(
  projectPath: string,
  sessionId: string,
  input: FindingRewriteDraftInput,
): Promise<void> {
  const path = novelDraftArtifactPath(projectPath, `finding-rewrite-${sessionId}`)
  await createDirectory(path.replace(/[^/]+$/, ""))
  const draft = {
    draft_id: `finding-rewrite-${sessionId}`,
    chapter_id: input.chapterId,
    original_text: input.originalText,
    replacement_text: input.replacementText,
    finding_id: input.findingId,
    draft_status: "pending" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await writeFileAtomic(path, JSON.stringify(draft, null, 2))
}

export async function acceptFindingRewriteDraft(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  const path = novelDraftArtifactPath(projectPath, `finding-rewrite-${sessionId}`)
  const raw = await readFile(path)
  const draft = JSON.parse(raw) as {
    draft_status: NovelDraftStatus
    updated_at: string
    [key: string]: unknown
  }
  draft.draft_status = "accepted"
  draft.updated_at = new Date().toISOString()
  await writeFileAtomic(path, JSON.stringify(draft, null, 2))
}

export async function rejectFindingRewriteDraft(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  const path = novelDraftArtifactPath(projectPath, `finding-rewrite-${sessionId}`)
  const raw = await readFile(path)
  const draft = JSON.parse(raw) as {
    draft_status: NovelDraftStatus
    updated_at: string
    [key: string]: unknown
  }
  draft.draft_status = "rejected"
  draft.updated_at = new Date().toISOString()
  await writeFileAtomic(path, JSON.stringify(draft, null, 2))
}

// ============================================================================
// S2b (roadmap R07): chase_debt 债务台账辅助 (webnovel 契约移植)
// ============================================================================

/** 计算某债务在给定章节的未偿状态 (interest 累加 + 到期判定)。 */
export function computeChaseDebtState(
  debt: ChaseDebt,
  currentChapter: number,
  events: readonly ChaseDebtEvent[],
): { current_amount: number; status: ChaseDebtStatus } {
  if (debt.status === "paid" || debt.status === "written_off") {
    return { current_amount: debt.current_amount, status: debt.status }
  }
  // 计息: 从 source_chapter 起每章利息率累加 (interest_accrued 事件防重复计息)
  const accruedEvents = events.filter((e) => e.debt_id === debt.id && e.event_type === "interest_accrued")
  let amount = debt.original_amount
  for (const e of accruedEvents) {
    amount += e.amount
  }
  // 部分还款减少
  for (const e of events) {
    if (e.debt_id !== debt.id) continue
    if (e.event_type === "partial_payment" || e.event_type === "full_payment") {
      amount -= e.amount
    }
  }
  amount = Math.max(0, amount)
  // 到期判定: currentChapter >= due_chapter 且未偿清 → overdue
  const status: ChaseDebtStatus =
    currentChapter >= debt.due_chapter && amount > 0 ? "overdue" : debt.status
  return { current_amount: amount, status }
}

/**
 * 记录计息事件 (防重复计息: 同一 debt 在同一 chapter 只计一次)。
 * 返回新增事件; 已存在相同 debt_id+chapter 的 interest_accrued 则返回 null。
 */
export function accrueChaseDebtInterest(
  events: readonly ChaseDebtEvent[],
  debtId: string,
  chapter: number,
  interestAmount: number,
): ChaseDebtEvent | null {
  const existing = events.some(
    (e) => e.debt_id === debtId && e.event_type === "interest_accrued" && e.chapter === chapter,
  )
  if (existing) return null
  return { debt_id: debtId, event_type: "interest_accrued", amount: interestAmount, chapter }
}

/**
 * 54 号设计 ④: chase_debt 记账人纯函数 (webnovel-writer ChaseDebtMeta 吸收)。
 * 从章节结尾钩子创建追读债务——仅当结尾含明确承诺型悬念 (必须/承诺/三天后/回来等)
 * 才创建, 防误报。additive: 无 chase_debt 字段的 status 原样返回。
 */
export function createChaseDebtFromHook(
  status: NovelSessionStatus,
  chapter: number,
  endingHook: string,
  opts: { dueIn?: number; interestRate?: number } = {},
): NovelSessionStatus {
  const ledger = status.chase_debt
  if (!ledger) return status
  const hook = endingHook.trim()
  if (!hook) return status
  // 承诺型悬念信号: 明确指向「后续必须发生」的表述
  const COMMITMENT_HOOK_RE = /(必须|承诺|答应|三天后|明天|回来|找到|救出|揭开|真相|秘密|危险|危机|来不及|倒计时)/
  if (!COMMITMENT_HOOK_RE.test(hook)) return status
  const dueIn = opts.dueIn ?? 3
  const interestRate = opts.interestRate ?? 0.1
  // 54 终验（hy3 P2）：同章重新生成会重复创建 chase-<ch>-N 债务——按 source_chapter 去重
  if (ledger.debts.some((d) => d.source_chapter === chapter)) return status
  const debt: ChaseDebt = {
    id: `chase-${chapter}-${ledger.debts.length + 1}`,
    debt_type: "hook_strength",
    original_amount: 1,
    current_amount: 1,
    interest_rate: interestRate,
    source_chapter: chapter,
    due_chapter: chapter + dueIn,
    status: "active",
    ref: "ending-hook",
  }
  return {
    ...status,
    chase_debt: {
      debts: [...ledger.debts, debt],
      debt_events: [
        ...ledger.debt_events,
        { debt_id: debt.id, event_type: "created", amount: 1, chapter, note: "ending-hook commitment" },
      ],
      updated_at: new Date().toISOString(),
    },
  }
}

/**
 * 54 号设计 ④: 章节提交时对既有未偿债务计息 (防重复计息事件溯源)。
 * additive: 无 chase_debt 字段原样返回。
 */
export function accrueAllChaseDebtInterest(
  status: NovelSessionStatus,
  chapter: number,
): NovelSessionStatus {
  const ledger = status.chase_debt
  if (!ledger) return status
  const newEvents: ChaseDebtEvent[] = []
  for (const debt of ledger.debts) {
    if (debt.status !== "active") continue
    if (chapter <= debt.source_chapter) continue
    const event = accrueChaseDebtInterest(ledger.debt_events, debt.id, chapter, Math.round(debt.original_amount * debt.interest_rate * 100) / 100)
    if (event) newEvents.push(event)
  }
  if (newEvents.length === 0) return status
  return {
    ...status,
    chase_debt: {
      ...ledger,
      debt_events: [...ledger.debt_events, ...newEvents],
      updated_at: new Date().toISOString(),
    },
  }
}

/** 更新 status.json 中某债务的状态 (additive: 无 chase_debt 字段则不动)。 */
export function updateChaseDebtStatus(
  status: NovelSessionStatus,
  debtId: string,
  newStatus: ChaseDebtStatus,
  chapter: number,
): NovelSessionStatus {
  const ledger = status.chase_debt
  if (!ledger) return status
  const debts = ledger.debts.map((d) => (d.id === debtId ? { ...d, status: newStatus } : d))
  return {
    ...status,
    chase_debt: {
      debts,
      debt_events: [
        ...ledger.debt_events,
        { debt_id: debtId, event_type: newStatus === "paid" ? "full_payment" : newStatus === "written_off" ? "written_off" : newStatus === "overdue" ? "overdue" : "created", amount: 0, chapter, note: `status → ${newStatus}` },
      ],
      updated_at: new Date().toISOString(),
    },
  }
}

// ============================================================================
// 架构-1 (30 号审计): status.json 真源跨进程监听
// ============================================================================

/**
 * 订阅 status.json 真源变更（HARD-1）。
 *
 * Rust 域同步 status_watcher 在 `.novel/status.json` 每次写入后 emit
 * `novel-status-changed`（事件仅携带「已变更」信号，无载荷）。本函数负责
 * 按调用方传入的 projectPath 重读 status.json（唯一真源），把最新状态交给
 * 回调 —— 消费方（dashboard-view / chat-panel）在打开项目后注册，即可实现
 * 外部/跨进程写入的增量刷新，无需重开项目或手动刷新。
 *
 * 非 Tauri 环境（浏览器预览 / vitest 替身，无 __TAURI_INTERNALS__）安全
 * 降级为不订阅，返回 no-op 取消函数 —— 保证既有调用路径与导出兼容。
 *
 * @param projectPath 项目根路径（事件无载荷，需按调用方项目重读真源）
 * @param onStatus    收到最新状态（null = 真源缺失/损坏/重读失败）后的回调
 * @returns 取消订阅函数（Promise 化，与 listen 语义一致）
 */
export async function subscribeStatusJson(
  projectPath: string,
  onStatus: (status: NovelSessionStatus | null) => void | Promise<void>,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen("novel-status-changed", () => {
    void loadNovelSessionStatus(projectPath)
      .then(async (status) => {
        await onStatus(status)
      })
      .catch(() => {
        // 重读失败：消费方按既有空态（null）语义处理，不向上抛出
      })
  })
}
