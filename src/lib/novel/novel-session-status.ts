import { DraftStatus } from "./draft-state-machine"
import { statusRead, statusWrite, type NovelDraftStatusPayload, type NovelSessionStatus, type StatusSchema } from "@/commands/status"
import type { GateSummary } from "@/commands/gates"
import { saveDraftArtifact, supersedeDraftArtifact } from "./draft-artifact-store"
import { parseNovelDraftRecord } from "./draft-record"
import type { ContextAssemblyResult } from "./context-assembly"
import { buildNovelTaskId } from "./novel-task-id"

type DeepSessionStage =
  | "after_context"
  | "after_task_brief"
  | "after_draft"
  | "after_review"
  | "after_revision"
  | "completed"
  | "failed"
  | "aborted"

export interface DeepSessionTimelineItem {
  index: number
  label: string
  status: string
}

export interface DeepSessionStatusExplanation {
  status: NovelSessionStatus
  activeStepIndex: number | null
  activeStepLabel: string | null
  label: string
  detail: string
  timeline: DeepSessionTimelineItem[]
}

export interface DeepSessionCheckpoint {
  version: 1
  originalRequest: string
  taskId?: string
  chapterNumber?: number
  stage: "after_context" | "after_task_brief" | "after_draft" | "after_review" | "after_revision"
  contextAssembly?: ContextAssemblyResult
  taskBrief?: string
  draftContent?: string
  reviewResults?: unknown[]
  gateSummary?: GateSummary
  currentContent?: string
}

export interface DeepSessionSyncInput {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber?: number
  checkpoint?: DeepSessionCheckpoint
  draftStatus: DraftStatus
  stage: DeepSessionStage
  finalContent?: string
  sessionStatus?: NovelSessionStatus
  failureMessage?: string
}

const statusSyncLocks = new Map<string, Promise<unknown>>()

type ReviewResultSeverity = "error" | "warning" | "info"

interface ReviewResultRecord {
  severity: ReviewResultSeverity
  type: string
  message: string
  evidence?: string
  relatedMemory?: string
  suggestion?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function toReviewResultRecord(value: unknown): ReviewResultRecord | null {
  if (!isObjectRecord(value)) return null
  const severity = value.severity
  const type = value.type
  const message = value.message
  if (
    (severity !== "error" && severity !== "warning" && severity !== "info")
    || typeof type !== "string"
    || !type.trim()
    || typeof message !== "string"
    || !message.trim()
  ) {
    return null
  }
  return {
    severity,
    type,
    message,
    evidence: typeof value.evidence === "string" ? value.evidence : undefined,
    relatedMemory: typeof value.relatedMemory === "string" ? value.relatedMemory : undefined,
    suggestion: typeof value.suggestion === "string" ? value.suggestion : undefined,
  }
}

function normalizeReviewResultsForDraft(
  reviewResults: unknown[] | undefined,
  gateSummary: GateSummary | undefined,
  stage: DeepSessionStage,
): unknown[] | undefined {
  const normalized = (reviewResults ?? [])
    .map(toReviewResultRecord)
    .filter((item): item is ReviewResultRecord => Boolean(item))

  if (!gateSummary || stage !== "completed") {
    return normalized.length > 0 ? normalized : reviewResults
  }

  const failingGateTypes = new Set(
    Object.values(gateSummary.gate_results)
      .filter((gate) => gate.status === "failed")
      .map((gate) => gate.gate_type),
  )

  const aligned = normalized.filter((item) => {
    if (item.severity !== "error") return true
    return failingGateTypes.has(item.type as "consistency" | "anti_ai" | "quality")
  })

  return aligned
}

function createSessionId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const yyyy = date.getUTCFullYear()
  const mm = pad(date.getUTCMonth() + 1)
  const dd = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const ss = pad(date.getUTCSeconds())
  return `novel-${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function buildDefaultTaskDecomposition(): unknown[] {
  return [
    { step: "build_context", label: "Build Context", status: "pending" },
    { step: "task_brief", label: "Task Brief", status: "pending" },
    { step: "draft_generation", label: "Draft Generation", status: "pending" },
    { step: "review", label: "Review", status: "pending" },
    { step: "revision", label: "Revision", status: "pending" },
    { step: "finalize", label: "Finalize", status: "pending" },
  ]
}

function defaultTaskLabel(index: number): string {
  return (buildDefaultTaskDecomposition()[index] as { label?: string } | undefined)?.label ?? `Step ${index + 1}`
}

function taskLabelForIndex(tasks: unknown[], index: number): string {
  const item = tasks[index]
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const label = (item as Record<string, unknown>).label
    if (typeof label === "string" && label.trim()) return label
  }
  return defaultTaskLabel(index)
}

function statusForStep(index: number, activeIndex: number | null, sessionStatus: NovelSessionStatus): string {
  if (sessionStatus === "completed" && index <= 5) return "done"
  if (activeIndex === null) return "pending"
  if (index < activeIndex) return "done"
  if (index === activeIndex) return sessionStatus === "blocked" ? "blocked" : "running"
  return "pending"
}

function checkpointStageToStepIndex(stage: DeepSessionCheckpoint["stage"]): number {
  switch (stage) {
    case "after_context":
      return 0
    case "after_task_brief":
      return 1
    case "after_draft":
      return 2
    case "after_review":
      return 3
    case "after_revision":
      return 4
  }
}

function mapStageToStepIndex(stage: DeepSessionStage): number | null {
  switch (stage) {
    case "after_context":
      return 0
    case "after_task_brief":
      return 1
    case "after_draft":
      return 2
    case "after_review":
      return 3
    case "after_revision":
      return 4
    case "completed":
      return 5
    case "failed":
      return 3
    case "aborted":
      return null
  }
}

function resolveActiveStepIndex(current: StatusSchema, input: DeepSessionSyncInput): number | null {
  if (input.stage === "failed" || input.stage === "aborted") {
    if (input.checkpoint) return checkpointStageToStepIndex(input.checkpoint.stage)
    return current.active_step_index ?? null
  }
  return mapStageToStepIndex(input.stage)
}

export function buildDeepSessionTimeline(schema: Pick<StatusSchema, "status" | "active_step_index" | "task_decomposition">): DeepSessionTimelineItem[] {
  const tasks = Array.isArray(schema.task_decomposition) && schema.task_decomposition.length > 0
    ? schema.task_decomposition
    : buildDefaultTaskDecomposition()

  return tasks.map((_, index) => ({
    index,
    label: taskLabelForIndex(tasks, index),
    status: schema.status === "paused" && schema.active_step_index === index
      ? "paused"
      : statusForStep(index, schema.active_step_index, schema.status),
  }))
}

export function explainDeepSessionStatus(schema: Pick<StatusSchema, "status" | "active_step_index" | "task_decomposition">): DeepSessionStatusExplanation {
  const timeline = buildDeepSessionTimeline(schema)
  const activeStep = schema.active_step_index === null
    ? null
    : timeline.find((item) => item.index === schema.active_step_index) ?? null

  if (schema.status === "completed") {
    return {
      status: schema.status,
      activeStepIndex: schema.active_step_index,
      activeStepLabel: activeStep?.label ?? null,
      label: "状态真源：completed",
      detail: "状态真源：completed，正式写入链已完成。",
      timeline,
    }
  }

  if (schema.status === "blocked") {
    return {
      status: schema.status,
      activeStepIndex: schema.active_step_index,
      activeStepLabel: activeStep?.label ?? null,
      label: "状态真源：blocked",
      detail: `状态真源：blocked，流程停在 ${activeStep?.label ?? "当前阶段"}，等待人工处理或后续修复。`,
      timeline,
    }
  }

  if (schema.status === "paused") {
    return {
      status: schema.status,
      activeStepIndex: schema.active_step_index,
      activeStepLabel: activeStep?.label ?? null,
      label: "状态真源：paused",
      detail: `状态真源：paused，流程在 ${activeStep?.label ?? "当前阶段"} 被中断，可继续未完成。`,
      timeline,
    }
  }

  return {
    status: schema.status,
    activeStepIndex: schema.active_step_index,
    activeStepLabel: activeStep?.label ?? null,
    label: "状态真源：running",
    detail: `状态真源：running，流程正处于 ${activeStep?.label ?? "当前阶段"}。`,
    timeline,
  }
}

function extractDraftConversationId(draft: unknown): string | null {
  if (!draft || typeof draft !== "object") return null
  const value = (draft as Record<string, unknown>).conversation_id
  return typeof value === "string" && value.trim() ? value : null
}

export function shouldResetStatusSchema(current: StatusSchema, input: DeepSessionSyncInput): boolean {
  if (input.stage === "after_context" && !input.checkpoint) return true
  const existingConversationId = extractDraftConversationId(current.draft)
  return Boolean(existingConversationId && existingConversationId !== input.conversationId)
}

function buildDraftPayload(input: DeepSessionSyncInput): NovelDraftStatusPayload {
  const checkpoint = input.checkpoint
  const draftId = checkpoint?.draftContent
    ? `${input.conversationId}-draft`
    : `${input.conversationId}-pending`
  const taskId = checkpoint?.taskId ?? buildNovelTaskId(input.conversationId, checkpoint?.chapterNumber ?? input.chapterNumber)

  return {
    draft_id: draftId,
    draft_status: input.draftStatus,
    conversation_id: input.conversationId,
    source_task_id: taskId,
    chapter_number: checkpoint?.chapterNumber ?? input.chapterNumber,
    user_request: checkpoint?.originalRequest ?? input.userRequest,
    task_brief: checkpoint?.taskBrief,
    draft_content: checkpoint?.draftContent,
    final_content: input.finalContent ?? checkpoint?.currentContent,
    review_results: normalizeReviewResultsForDraft(checkpoint?.reviewResults, checkpoint?.gateSummary, input.stage),
    accepted_at: undefined,
    rejected_at: undefined,
    superseded_at: undefined,
    supersedes_draft_id: undefined,
    formal_chapter_path: undefined,
    updated_at: nowIso(),
  }
}

export function createEmptyStatusSchema(source = "qmai"): StatusSchema {
  const now = nowIso()
  return {
    schema_version: "1",
    session_id: createSessionId(),
    created_at: now,
    updated_at: now,
    source,
    status: "running",
    active_step_index: 0,
    current_task: null,
    boundary_contract: {
      single_source_of_truth: ".novel/status.json",
      draft_first: true,
      gate_priority: ["consistency", "anti_ai", "quality"],
    },
    execution_criteria: [
      { id: "EC-01", description: "draft-first enabled" },
      { id: "EC-02", description: "status.json remains single source of truth" },
      { id: "EC-03", description: "gates run before formal accept" },
    ],
    task_decomposition: buildDefaultTaskDecomposition(),
    decision_gates: {
      consistency: {
        gate_type: "consistency",
        mechanical_findings: [],
        semantic_findings: [],
        retry_count: 0,
        max_retry: 3,
        status: "pending",
      },
      anti_ai: {
        gate_type: "anti_ai",
        mechanical_findings: [],
        semantic_findings: [],
        retry_count: 0,
        max_retry: 3,
        status: "pending",
      },
      quality: {
        gate_type: "quality",
        mechanical_findings: [],
        semantic_findings: [],
        retry_count: 0,
        max_retry: 3,
        status: "pending",
      },
    },
    context_assembly: null,
    draft: null,
    memory_snapshot: null,
    evidence_refs: [],
  }
}

export function applyDeepSessionStatus(
  current: StatusSchema,
  input: DeepSessionSyncInput,
): StatusSchema {
  const nextStatus = input.sessionStatus ?? current.status
  const taskId = input.checkpoint?.taskId ?? current.current_task ?? buildNovelTaskId(input.conversationId, input.chapterNumber)
  const activeStepIndex = resolveActiveStepIndex(current, input)
  const baseTasks = Array.isArray(current.task_decomposition) && current.task_decomposition.length > 0
    ? current.task_decomposition
    : buildDefaultTaskDecomposition()

  const taskDecomposition = baseTasks.map((item, index) => {
    const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}
    return {
      ...record,
      status: statusForStep(index, activeStepIndex, nextStatus),
      updated_at: nowIso(),
    }
  })

  const previousDraft = parseNovelDraftRecord(current.draft)
  const nextDraft = buildDraftPayload(input)
  const draft = {
    ...nextDraft,
    accepted_at: undefined,
    rejected_at: undefined,
    superseded_at: undefined,
    supersedes_draft_id: previousDraft?.draft_id,
    formal_chapter_path: undefined,
  }
  const memorySnapshot = input.finalContent
    ? {
        latest_final_content: input.finalContent,
        updated_at: nowIso(),
      }
    : current.memory_snapshot
  const evidenceRefs = Array.isArray(current.evidence_refs) ? [...current.evidence_refs] : []
  const checkpointGateSummary = input.checkpoint?.gateSummary
  if (checkpointGateSummary) {
    const gateRunRef = `runs/${taskId}-gates.json`
    if (!evidenceRefs.includes(gateRunRef)) {
      evidenceRefs.push(gateRunRef)
    }
  }
  if (input.finalContent) {
    const finalDraftRef = `drafts/${taskId}.json`
    if (!evidenceRefs.includes(finalDraftRef)) {
      evidenceRefs.push(finalDraftRef)
    }
  }

  const nextDecisionGates = checkpointGateSummary
    ? {
        ...current.decision_gates,
        ...Object.fromEntries(
          Object.entries(checkpointGateSummary.gate_results).map(([key, gate]) => [key, {
            gate_type: gate.gate_type,
            mechanical_findings: gate.mechanical_findings,
            semantic_findings: gate.semantic_findings,
            retry_count: gate.retry_count,
            max_retry: checkpointGateSummary.max_retry ?? 3,
            status: gate.status,
          }]),
        ),
      }
    : current.decision_gates

  return {
    ...current,
    status: nextStatus,
    active_step_index: activeStepIndex,
    current_task: taskId,
    task_decomposition: taskDecomposition,
    decision_gates: nextDecisionGates,
    context_assembly: input.checkpoint?.contextAssembly ?? current.context_assembly ?? null,
    draft,
    memory_snapshot: memorySnapshot ?? null,
    evidence_refs: evidenceRefs,
    updated_at: nowIso(),
  }
}

export async function loadOrCreateStatusSchema(projectPath: string): Promise<StatusSchema> {
  try {
    return await statusRead(projectPath)
  } catch (error) {
    if (isMissingStatusSchemaError(error)) {
      return createEmptyStatusSchema()
    }
    throw error
  }
}

export async function loadOptionalStatusSchema(projectPath: string): Promise<StatusSchema | null> {
  try {
    return await statusRead(projectPath)
  } catch (error) {
    if (isMissingStatusSchemaError(error)) {
      return null
    }
    throw error
  }
}

function isMissingStatusSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|no such file/i.test(message)
}

async function withStatusSyncLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = statusSyncLocks.get(projectPath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = prev.catch(() => {}).then(() => next)
  statusSyncLocks.set(
    projectPath,
    queued,
  )

  try {
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    Promise.resolve().then(() => {
      if (statusSyncLocks.get(projectPath) === queued) {
        statusSyncLocks.delete(projectPath)
      }
    })
  }
}

export async function syncDeepSessionStatus(input: DeepSessionSyncInput): Promise<StatusSchema | null> {
  return withStatusSyncLock(input.projectPath, async () => {
    const current = await loadOrCreateStatusSchema(input.projectPath)
    const previousDraft = parseNovelDraftRecord(current.draft)
    const base = shouldResetStatusSchema(current, input) ? createEmptyStatusSchema() : current
    const next = applyDeepSessionStatus(base, input)
    await statusWrite(input.projectPath, next)
    const nextDraft = parseNovelDraftRecord(next.draft)
    if (previousDraft && previousDraft.draft_id !== nextDraft?.draft_id) {
      await supersedeDraftArtifact(input.projectPath, previousDraft)
    }
    if (nextDraft) {
      await saveDraftArtifact(input.projectPath, nextDraft)
    }
    return next
  })
}
