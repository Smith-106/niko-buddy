/**
 * M2-3 切片：novel-session-status 状态构造纯逻辑层。
 *
 * 自 `novel-session-status.ts` 剥出的内聚纯函数块（stage 映射 / decision-gate
 * 克隆 / draft 内容提取 / resume 检查点解析 / base 状态创建 / evidence 合并 /
 * dimension 结果解析 + 内部会话输入类型与 taskId 派生），零运行时依赖
 * （仅 type-only import，零新依赖）。
 *
 * 对外 export 符号名与签名与原文件一致；原文件经 `export ... from` 重导出
 * resolveStatusResumeCheckpoint / resolveInterruptedSessionResumeCheckpoint，
 * 其余经 import 回用 —— 外部 `from "./novel-session-status"` 路径零变更。
 * buildNextStatus / buildLifecycleStatus 工厂 intentionally 留在原文件
 * （twin-structural spec 按源文本计数定义点）。
 */
import type {
  DeepChapterDecisionGates,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResumeStage,
} from "./deep-chapter-generation"
import type {
  NovelSessionStatus,
} from "./novel-session-status"

export interface DeepChapterSessionInput {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber?: number
  resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
}

export function taskIdForConversation(conversationId: string): string {
  return `tsk-${conversationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export function stageToActiveStepIndex(
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

export function cloneDecisionGates(
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

export function extractDraftContent(
  checkpoint?: DeepChapterGenerationResumeCheckpoint,
  finalContent?: string,
): string {
  if (finalContent?.trim()) return finalContent.trim()
  if (checkpoint?.currentContent?.trim()) return checkpoint.currentContent.trim()
  if (checkpoint?.draftContent?.trim()) return checkpoint.draftContent.trim()
  return ""
}

export function normalizeUserRequest(userRequest: string): string {
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

/** 词表映射调用点（B2 回退：曾委托 stage-vocabulary，现就地内联，不依赖 untracked）。
 * checkpoint_stage 的值域 = DeepChapterGenerationResumeStage ∪ "started" ∪ "completed"；
 * 映射就地内联（端点 started→context、completed→done；未知值降级 context 且不静默为终态）。
 */
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
  // J10-02: interrupted 是 running 的持久化中断态（重启降级写入），
  // 与 running 同享中断恢复路径——否则标 interrupted 的任务无法续作。
  if (!status || (status.status !== "running" && status.status !== "interrupted")) return undefined
  if (status.current_task.conversation_id !== input.conversationId) return undefined
  if (normalizeUserRequest(status.current_task.user_request) !== normalizeUserRequest(input.userRequest)) {
    return undefined
  }
  return resolveStatusResumeCheckpoint(status, input.conversationId)
}

export function canReuseExistingSession(
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

/**
 * ISS-20260709-008（PAT-G7）：写入路径的“同会话基底”判定单一真源。
 *
 * 语义区分（此前 5 处裸 `existing.session_id === input.sessionId` 各自手写，
 * 读代码时无法分辨 missing-as-skip 与 missing-as-different）：
 * - `created_at`：保留既有值要求 **严格同一会话**（`missing-as-different`）。
 *   遗留草稿的 `session_id` 可能缺失，此时 `undefined === id` 为 false → 取 now，
 *   不把未知归属的旧时间戳冒充本会话创建时间。
 * - 写入基底：同上，不同会话/缺 session_id 一律新建基底，避免把别的会话
 *   的 status 当本会话继续写（missing-as-skip 会静默串写）。
 *
 * 只给写入/时间戳路径用；读取/恢复路径用 `canReuseExistingSession`（宽松：
 * 按会话+请求匹配），两者语义不可互换。
 */
export function isSameSessionBase<T extends { session_id?: string }>(
  existing: T | null,
  sessionId: string,
): existing is T & { session_id: string } {
  return Boolean(existing && existing.session_id === sessionId)
}

export function createBaseStatus(
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

export function mergeEvidenceRefs(...refs: Array<string | undefined>): string[] {
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
export function resolveDimensionResults(
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  base: NovelSessionStatus,
): NovelSessionStatus["dimension_results"] {
  return checkpoint?.dimensionResults ?? base.dimension_results
}
