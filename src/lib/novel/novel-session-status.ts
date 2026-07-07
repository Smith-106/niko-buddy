import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type {
  DeepChapterDecisionGates,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResumeStage,
} from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"

export type NovelSessionLifecycleStatus = "running" | "completed" | "paused" | "blocked"
export type NovelDraftStatus = "pending" | "ready" | "accepted" | "rejected" | "superseded"
export type NovelGateStatus = "pending" | "passed" | "failed"

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

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

export function novelDraftArtifactPath(projectPath: string, draftId: string): string {
  return `${draftsDirPath(projectPath)}/${draftId}.json`
}

function novelSupersededDraftArtifactPath(projectPath: string, draftId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-")
  return `${draftsDirPath(projectPath)}/${draftId}.superseded.${safeTimestamp}.json`
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
  if (
    existing
    && existing.session_id
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
    created_at: now,
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "running",
    active_step_index: stageToActiveStepIndex(input.checkpoint.stage),
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint.stage,
      status: "running",
      last_error: undefined,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "pending",
      checkpoint_stage: input.checkpoint.stage,
      updated_at: now,
    },
    decision_gates: cloneDecisionGates(input.checkpoint.decisionGates ?? base.decision_gates),
    resume_checkpoint: input.checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
    // CORR-006 (from quality-review): persist the raw 6-dimension review map
    // so the structured per-dimension view (score/status/summary) survives the
    // checkpoint round-trip — not just the flattened NovelReviewResult[] form
    // that already lives in resume_checkpoint.reviewResults. Additive field:
    // older status files lack it; loadNovelSessionStatus spreads Partial safely.
    dimension_results: input.checkpoint.dimensionResults ?? base.dimension_results,
  }
  await saveNovelSessionStatus(input.projectPath, next)
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "ready",
      checkpoint_stage: input.checkpoint?.stage,
      updated_at: now,
    },
    decision_gates: cloneDecisionGates(input.checkpoint?.decisionGates ?? base.decision_gates),
    resume_checkpoint: input.checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
  }
  await saveNovelSessionStatus(input.projectPath, next)
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "paused",
    active_step_index: input.checkpoint
      ? stageToActiveStepIndex(input.checkpoint.stage)
      : base.active_step_index,
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint?.stage ?? base.current_task.checkpoint_stage,
      status: "paused",
      last_error: input.errorMessage,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: input.checkpoint ? "pending" : base.draft.draft_status,
      checkpoint_stage: input.checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
    },
    decision_gates: cloneDecisionGates(input.checkpoint?.decisionGates ?? base.decision_gates),
    resume_checkpoint: input.checkpoint ?? base.resume_checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
  }
  await saveNovelSessionStatus(input.projectPath, next)
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "blocked",
    active_step_index: null,
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: input.checkpoint?.chapterNumber ?? input.chapterNumber,
      checkpoint_stage: input.checkpoint?.stage ?? base.current_task.checkpoint_stage,
      status: "blocked",
      last_error: input.errorMessage,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: input.checkpoint ? "pending" : base.draft.draft_status,
      checkpoint_stage: input.checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
    },
    decision_gates: cloneDecisionGates(input.checkpoint?.decisionGates ?? base.decision_gates),
    resume_checkpoint: input.checkpoint ?? base.resume_checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
  }
  await saveNovelSessionStatus(input.projectPath, next)
  return next
}

function canReuseDecisionSession(
  existing: NovelSessionStatus | null,
  input: DraftDecisionInput,
): existing is NovelSessionStatus {
  if (!existing) return false
  if (input.sessionId) return existing.session_id === input.sessionId
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
  const chapterNumber = draft?.chapter_number ?? checkpoint?.chapterNumber ?? base.current_task.chapter_number ?? input.chapterNumber
  const reviewResults = draft?.review_results ?? checkpoint?.reviewResults ?? []
  const decisionGates = draft?.decision_gates ?? checkpoint?.decisionGates ?? base.decision_gates
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "accepted",
      checkpoint_stage: checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
      accepted_at: now,
      rejected_at: undefined,
      formal_chapter_path: input.formalChapterPath,
    },
    decision_gates: cloneDecisionGates(decisionGates),
    resume_checkpoint: checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath, input.formalChapterPath),
  }
  await saveNovelSessionStatus(input.projectPath, next)
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
  const chapterNumber = draft?.chapter_number ?? checkpoint?.chapterNumber ?? base.current_task.chapter_number ?? input.chapterNumber
  const reviewResults = draft?.review_results ?? checkpoint?.reviewResults ?? []
  const decisionGates = draft?.decision_gates ?? checkpoint?.decisionGates ?? base.decision_gates
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
  const next: NovelSessionStatus = {
    ...base,
    updated_at: now,
    status: "completed",
    active_step_index: stageToActiveStepIndex("completed"),
    current_task: {
      ...base.current_task,
      user_request: normalizeUserRequest(input.userRequest),
      chapter_number: chapterNumber,
      checkpoint_stage: "completed",
      status: "completed",
      last_error: undefined,
    },
    draft: {
      ...base.draft,
      draft_id: input.conversationId,
      file_path: draftPath,
      draft_status: "rejected",
      checkpoint_stage: checkpoint?.stage ?? base.draft.checkpoint_stage,
      updated_at: now,
      accepted_at: undefined,
      rejected_at: now,
      formal_chapter_path: undefined,
    },
    decision_gates: cloneDecisionGates(decisionGates),
    resume_checkpoint: checkpoint,
    evidence_refs: mergeEvidenceRefs(...base.evidence_refs, draftPath),
  }
  await saveNovelSessionStatus(input.projectPath, next)
  return next
}
