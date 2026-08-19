import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { pad, toErrorMessage } from "@/lib/utils"
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

/** Wave B helper: draft ready then queue non-blocking review. */
function markWriteReadyThenQueueReview(
  prev: ReviewJobState | undefined,
  chapterNumber?: number,
): ReviewJobState {
  return markReviewQueued(markWriteReady(prev, chapterNumber), chapterNumber)
}

export type NovelSessionLifecycleStatus = "running" | "completed" | "paused" | "blocked"
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
   * Wave 4 (v2.5.0): 批量去AI味批次状态 (additive-optional)。
   * 状态/指针落 status.json 唯一真源；草稿内容落 .novel/de-ai-batch-drafts/ 工件。
   * 旧 status.json 无本字段仍可加载 (additive 兼容)。
   */
  de_ai_batch?: import("./de-ai-batch/types").DeAiBatchState
}

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
  event_type: "created" | "interest_accrued" | "partial_payment" | "full_payment" | "overdue"
  amount: number
  chapter: number
  note?: string
}

interface DeepChapterSessionInput {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber?: number
  resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
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
}

type DraftDecisionMode = "accept" | "reject"

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

function taskIdForConversation(conversationId: string): string {
  return `tsk-${conversationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
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

function stageToActiveStepIndex(
  stage: DeepChapterGenerationResumeStage | "started" | "completed",
): number {
  switch (stage) {
    case "after_context":
    case "after_task_brief":
    case "started":
      return 1
    case "after_draft":
      return 2
    case "after_review":
      return 3
    case "after_revision":
      return 4
    case "completed":
      return 5
    // DC (odyssey-improve, maintainability L): runtime fallback so a future
    // stage enum value that TS exhaustiveness can't yet see (e.g. added in a
    // type re-export) returns a sane default instead of implicit undefined.
    default:
      return 0
  }
}

function emptyDecisionGates(): NovelSessionStatus["decision_gates"] {
  return {
    consistency: {
      status: "pending",
      verdict: "pending",
      findings: [],
      repair_suggestions: [],
      retry_count: 0,
    },
    anti_ai: {
      status: "pending",
      verdict: "pending",
      findings: [],
      repair_suggestions: [],
      retry_count: 0,
    },
    quality: {
      status: "pending",
      verdict: "pending",
      findings: [],
      repair_suggestions: [],
      retry_count: 0,
    },
    overall: "pending",
  }
}

function cloneDecisionGateEntry(
  entry?: Partial<NovelSessionStatus["decision_gates"]["consistency"]>,
): NovelSessionStatus["decision_gates"]["consistency"] {
  return {
    status: entry?.status ?? "pending",
    verdict: entry?.verdict ?? (entry?.status === "failed" ? "fail" : entry?.status === "passed" ? "pass" : "pending"),
    findings: Array.isArray(entry?.findings) ? [...entry.findings] : [],
    repair_suggestions: Array.isArray(entry?.repair_suggestions) ? [...entry.repair_suggestions] : [],
    retry_count: typeof entry?.retry_count === "number" ? entry.retry_count : 0,
    updated_at: typeof entry?.updated_at === "string" ? entry.updated_at : undefined,
    manual_review_required: entry?.manual_review_required === true ? true : undefined,
  }
}

function cloneDecisionGates(
  gates?: Partial<DeepChapterDecisionGates>,
): NovelSessionStatus["decision_gates"] {
  const base = emptyDecisionGates()
  const consistency = cloneDecisionGateEntry(gates?.consistency)
  const antiAi = cloneDecisionGateEntry(gates?.anti_ai)
  const quality = cloneDecisionGateEntry(gates?.quality)
  const overall = typeof gates?.overall === "string"
    ? gates.overall
    : consistency.status === "failed" || antiAi.status === "failed" || quality.status === "failed"
      ? "fail"
      : quality.verdict === "warning"
        ? "warning"
        : consistency.status === "pending" || antiAi.status === "pending" || quality.status === "pending"
          ? "pending"
          : "pass"
  return {
    ...base,
    consistency,
    anti_ai: antiAi,
    quality,
    overall,
  }
}

function extractDraftContent(
  checkpoint?: DeepChapterGenerationResumeCheckpoint,
  finalContent?: string,
): string {
  if (finalContent?.trim()) return finalContent.trim()
  if (checkpoint?.currentContent?.trim()) return checkpoint.currentContent.trim()
  if (checkpoint?.draftContent?.trim()) return checkpoint.draftContent.trim()
  return ""
}

function normalizeUserRequest(userRequest: string): string {
  return userRequest.trim()
}

function activeStepIndexToCheckpointStage(
  activeStepIndex: number | null,
  checkpoint?: DeepChapterGenerationResumeCheckpoint,
  checkpointStage?: DeepChapterGenerationResumeStage | "started" | "completed",
): DeepChapterGenerationResumeStage | undefined {
  if (activeStepIndex === null || activeStepIndex >= 5) return undefined
  if (
    checkpointStage
    && checkpointStage !== "started"
    && checkpointStage !== "completed"
    && stageToActiveStepIndex(checkpointStage) === activeStepIndex
  ) {
    return checkpointStage
  }
  if (checkpoint && stageToActiveStepIndex(checkpoint.stage) === activeStepIndex) {
    return checkpoint.stage
  }
  switch (activeStepIndex) {
    case 1:
      return checkpoint?.taskBrief?.trim() ? "after_task_brief" : "after_context"
    case 2:
      return "after_draft"
    case 3:
      return "after_review"
    case 4:
      return "after_revision"
    default:
      return undefined
  }
}

export function resolveStatusResumeCheckpoint(
  status: NovelSessionStatus | null,
  conversationId: string,
): DeepChapterGenerationResumeCheckpoint | undefined {
  if (!status) return undefined
  if (status.current_task.conversation_id !== conversationId) return undefined
  if (status.status === "completed") return undefined
  const checkpoint = status.resume_checkpoint
  if (!checkpoint) return undefined
  const stage = activeStepIndexToCheckpointStage(
    status.active_step_index,
    checkpoint,
    status.current_task.checkpoint_stage,
  )
  if (!stage) return undefined
  return {
    ...checkpoint,
    chapterNumber: checkpoint.chapterNumber ?? status.current_task.chapter_number,
    stage,
  }
}

export function resolveInterruptedSessionResumeCheckpoint(
  status: NovelSessionStatus | null,
  input: {
    conversationId: string
    userRequest: string
  },
): DeepChapterGenerationResumeCheckpoint | undefined {
  if (!status || status.status !== "running") return undefined
  if (status.current_task.conversation_id !== input.conversationId) return undefined
  if (normalizeUserRequest(status.current_task.user_request) !== normalizeUserRequest(input.userRequest)) {
    return undefined
  }
  return resolveStatusResumeCheckpoint(status, input.conversationId)
}

function canReuseExistingSession(
  existing: NovelSessionStatus | null,
  input: DeepChapterSessionInput,
): existing is NovelSessionStatus {
  return Boolean(
    existing
    && existing.status !== "completed"
    && existing.current_task.conversation_id === input.conversationId
    && existing.current_task.user_request === normalizeUserRequest(input.userRequest),
  )
}

function createBaseStatus(
  input: DeepChapterSessionInput,
  sessionId: string,
  createdAt: string,
  draftPath: string,
): NovelSessionStatus {
  return {
    schema_version: "1",
    session_id: sessionId,
    source: "deep_chapter_generation",
    created_at: createdAt,
    updated_at: createdAt,
    status: "running",
    active_step_index: stageToActiveStepIndex("started"),
    current_task: {
      task_id: taskIdForConversation(input.conversationId),
      conversation_id: input.conversationId,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.resumeCheckpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.resumeCheckpoint?.stage ?? "started",
      status: "running",
    },
    draft: {
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "pending",
      checkpoint_stage: input.resumeCheckpoint?.stage,
      updated_at: createdAt,
    },
    decision_gates: cloneDecisionGates(input.resumeCheckpoint?.decisionGates),
    resume_checkpoint: input.resumeCheckpoint,
    evidence_refs: [],
  }
}

function mergeEvidenceRefs(...refs: Array<string | undefined>): string[] {
  return [...new Set(refs.filter((value): value is string => Boolean(value)))]
}

/**
 * DC-2 (odyssey-improve): single source of truth for the `dimension_results`
 * field on a lifecycle `next` status. The 6 lifecycle functions
 * (persist/complete/pause/block/accept/reject) each previously inlined
 * `input.checkpoint?.dimensionResults ?? base.dimension_results` — or, in the
 * accept/reject twin, omitted it entirely. That omission was the F-003
 * twin-path defect recurring for the 4th time (SH-5 → ARCH-006 → PAT-G1 →
 * here): on the fresh-base path (createBaseStatus never sets dimension_results),
 * the `...base` spread yields undefined and the 6-dim review map carried in the
 * checkpoint is silently dropped. Centralizing the resolution here means a new
 * lifecycle function cannot forget the field — it calls this helper.
 *
 * Preference: checkpoint's raw dimensionResults (authoritative, just produced)
 * over base's (may be stale or absent on fresh base).
 */
function resolveDimensionResults(
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  base: NovelSessionStatus,
): NovelSessionStatus["dimension_results"] {
  return checkpoint?.dimensionResults ?? base.dimension_results
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
  }
}

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
export async function persistCheckpointBase(
  projectPath: string,
  sessionId: string,
  next: NovelSessionStatus,
  evidenceEntries?: string[],
): Promise<void> {
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
  await saveNovelSessionStatus(projectPath, next)
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
    const existing = await loadNovelSessionStatus(projectPath)
    if (!existing) return
    const metrics = Array.isArray(existing.stage_metrics) ? existing.stage_metrics : []
    // 上限保护：单项目跨章节累积阶段指标封顶，避免无界增长（与
    // routingROIBuckets/exemplarABuckets 一致，1024 条）。
    const STAGE_METRICS_MAX = 1024
    const next = [...metrics, entry]
    while (next.length > STAGE_METRICS_MAX) {
      next.shift()
    }
    const updated = buildNextStatus(existing, {
      updated_at: new Date().toISOString(),
      status: existing.status,
      stage_metrics: next,
    })
    await persistCheckpointBase(projectPath, existing.session_id, updated)
  } catch {
    // non-fatal — 阶段指标采集失败不阻断主链
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
  const filePath = novelDraftArtifactPath(input.projectPath, draftId)
  const existing = await loadNovelDraftArtifact(input.projectPath, draftId)
  // CORR-003 (odyssey): supersede when the existing draft belongs to a
  // different session OR is a legacy draft with no session_id (the field is
  // optional — loadNovelDraftArtifact does not require it). Previously the
  // `existing.session_id` truthiness guard let legacy drafts fall through to
  // a silent overwrite, losing the original content/review_results without
  // creating a superseded.{timestamp}.json audit copy. `undefined !== sessionId`
  // is true, so legacy drafts now route through the supersede path.
  if (
    existing
    && existing.session_id !== sessionId
    && existing.draft_status !== "superseded"
  ) {
    const supersededPath = novelSupersededDraftArtifactPath(input.projectPath, draftId, now)
    const supersededArtifact: NovelDraftArtifact = {
      ...existing,
      draft_status: "superseded",
      updated_at: now,
      superseded_by: filePath,
    }
    await ensureNovelSessionDirs(input.projectPath)
    await writeVerifiedJson(
      supersededPath,
      supersededArtifact,
      "superseded 草稿文件",
      (parsed) => {
        const candidate = parsed as Partial<NovelDraftArtifact> | null
        return candidate?.draft_id === draftId
          && candidate?.draft_status === "superseded"
          && candidate?.superseded_by === filePath
      },
    )
  }
  const content = extractDraftContent(checkpoint, options.finalContent)
  // CORR-001 (odyssey): preserve the original creation timestamp across
  // rewrites. Previously every writeDraftArtifact call reset created_at to
  // `now`, making it semantically identical to updated_at and losing the
  // draft's first-creation time (used for audit/timeline). Keep existing
  // when rewriting the same draft (same session_id, not superseded); only a
  // brand-new draft (no existing, or existing is being superseded) uses `now`.
  const createdAt = existing && existing.session_id === sessionId && existing.draft_status !== "superseded"
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
  }
  await ensureNovelSessionDirs(input.projectPath)
  await writeVerifiedJson(
    filePath,
    artifact,
    "草稿文件",
    (parsed) => {
      const candidate = parsed as Partial<NovelDraftArtifact> | null
      return candidate?.draft_id === draftId
        && candidate?.conversation_id === input.conversationId
        && candidate?.session_id === sessionId
        && candidate?.draft_status === draftStatus
    },
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
  } catch {
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

export async function loadNovelSessionStatus(projectPath: string): Promise<NovelSessionStatus | null> {
  try {
    const raw = await readFile(novelSessionStatusPath(projectPath))
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
      return null
    }
    return {
      ...(parsed as NovelSessionStatus),
      decision_gates: cloneDecisionGates(parsed.decision_gates),
    }
  } catch {
    return null
  }
}

export async function saveNovelSessionStatus(
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

export async function startDeepChapterSession(
  input: DeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const now = new Date().toISOString()
  const existing = await loadNovelSessionStatus(input.projectPath)
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
  await saveNovelSessionStatus(input.projectPath, next)
  return next
}

export async function persistDeepChapterCheckpoint(
  input: PersistDeepChapterCheckpointInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = existing
    && existing.session_id === input.sessionId
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  const draftPath = await writeDraftArtifact(
    input,
    input.sessionId,
    "pending",
    input.checkpoint,
    input.checkpoint.reviewResults ?? [],
    { decisionGates: input.checkpoint.decisionGates },
  )
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, input.sessionId, next)
  return next
}

export async function completeDeepChapterSession(
  input: CompleteDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = existing
    && existing.session_id === input.sessionId
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  const draftPath = await writeDraftArtifact(
    input,
    input.sessionId,
    "ready",
    input.checkpoint,
    input.reviewResults ?? [],
    {
      finalContent: input.finalContent,
      decisionGates: input.checkpoint?.decisionGates ?? base.decision_gates,
    },
  )
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, input.sessionId, next)
  return next
}

export async function pauseDeepChapterSession(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = existing
    && existing.session_id === input.sessionId
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  let draftPath = base.draft.file_path
  if (input.checkpoint) {
    draftPath = await writeDraftArtifact(
      input,
      input.sessionId,
      "pending",
      input.checkpoint,
      input.checkpoint.reviewResults ?? [],
      { decisionGates: input.checkpoint.decisionGates ?? base.decision_gates },
    )
  }
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, input.sessionId, next)
  return next
}

export async function blockDeepChapterSession(
  input: PauseDeepChapterSessionInput,
): Promise<NovelSessionStatus> {
  const existing = await loadNovelSessionStatus(input.projectPath)
  const now = new Date().toISOString()
  const base = existing
    && existing.session_id === input.sessionId
    ? existing
    : createBaseStatus(
      input,
      input.sessionId,
      now,
      novelDraftArtifactPath(input.projectPath, input.conversationId),
    )
  let draftPath = base.draft.file_path
  if (input.checkpoint) {
    draftPath = await writeDraftArtifact(
      input,
      input.sessionId,
      "pending",
      input.checkpoint,
      input.checkpoint.reviewResults ?? [],
      { decisionGates: input.checkpoint.decisionGates ?? base.decision_gates },
    )
  }
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, input.sessionId, next)
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
  const existing = await loadNovelSessionStatus(input.projectPath)
  const draft = await requireManagedDeepChapterDraft(input.projectPath, input.conversationId, "accept")
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
  const draftPath = await writeDraftArtifact(
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
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, base.session_id, next)
  return next
}

export async function rejectDeepChapterDraft(
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
  const draftPath = await writeDraftArtifact(
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
  const next = buildNextStatus(base, {
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
  await persistCheckpointBase(input.projectPath, base.session_id, next)
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
        { debt_id: debtId, event_type: newStatus === "paid" ? "full_payment" : newStatus === "overdue" ? "overdue" : "created", amount: 0, chapter, note: `status → ${newStatus}` },
      ],
      updated_at: new Date().toISOString(),
    },
  }
}
