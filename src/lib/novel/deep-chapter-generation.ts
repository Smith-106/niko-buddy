import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { buildContextPack, contextPackToPrompt, type ContextPack } from "./context-engine"
import { reviewChapter, type NovelReviewResult } from "./review-adapter"
import {
  dimensionResultsToReviewResults,
  runSixDimensionReview,
  type SixReviewDimensionKey,
  type DimensionReviewResult,
} from "./dimension-review-adapter"
import type { TaskRouteResult } from "./task-router"
import type { GoldenThreeChapterRequest } from "./golden-three-chapters"
import {
  resolveChapterLengthSpec,
  type ChapterLengthSpec,
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterExpansionPrompt,
  buildDeepChapterFinalPolishPrompt,
  buildDeepChapterRevisionPrompt,
  buildStableContextPrefix,
} from "./deep-chapter-prompts"

export interface DeepChapterGenerationInput {
  projectPath: string
  userRequest: string
  chapterNumber?: number
  goldenThreeChapter?: GoldenThreeChapterRequest
  dismantlingReferenceDirective?: string
  llmConfig: LlmConfig
  resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
}

export interface DeepChapterGenerationCallbacks {
  onThinking?: (content: string) => void
  onFinalContent?: (content: string) => void
  onCheckpoint?: (checkpoint: DeepChapterGenerationResumeCheckpoint) => void | Promise<void>
}

export interface DeepChapterGenerationResult {
  finalContent: string
  taskBrief: string
  draftContent: string
  reviewResults: NovelReviewResult[]
  revised: boolean
  decisionGates: DeepChapterDecisionGates
  manualReviewRequired: boolean
  retryCount: number
  /**
   * True when any collectModelText stage took the transport-inactivity
   * partial-preserve branch — i.e. finalContent was truncated mid-generation by
   * a transport timeout rather than completed normally. Callers MUST route a
   * partial result to the pause / continue-unfinished path (draft_status
   * "pending"), NOT to completeDeepChapterSession ("ready"), so the truncated
   * draft is not persisted as a completed chapter. See collectModelText + the
   * Draft-first boundary invariant.
   */
  partial: boolean
  partialReason: string | null
}

export type DeepChapterDecisionGateKey = "consistency" | "anti_ai" | "quality"
export type DeepChapterGateVerdict = "pending" | "pass" | "warning" | "fail" | "manual_review"

export interface DeepChapterDecisionGate {
  status: "pending" | "passed" | "failed"
  verdict: DeepChapterGateVerdict
  findings: NovelReviewResult[]
  repair_suggestions: string[]
  retry_count: number
  updated_at?: string
  manual_review_required?: boolean
}

export interface DeepChapterDecisionGates {
  consistency: DeepChapterDecisionGate
  anti_ai: DeepChapterDecisionGate
  quality: DeepChapterDecisionGate
  overall: DeepChapterGateVerdict
}

export type DeepChapterGenerationResumeStage =
  | "after_context"
  | "after_task_brief"
  | "after_draft"
  | "after_review"
  | "after_revision"

export interface DeepChapterGenerationResumeCheckpoint {
  version: 1
  originalRequest: string
  chapterNumber?: number
  stage: DeepChapterGenerationResumeStage
  taskBrief?: string
  draftContent?: string
  reviewResults?: NovelReviewResult[]
  /**
   * CORR-006 (from quality-review): the raw 6-dimension review map, persisted
   * to NovelSessionStatus.dimension_results for auditability. The flattened
   * form already lives in reviewResults (via dimensionResultsToReviewResults);
   * this preserves the structured per-dimension view (score/status/summary).
   */
  dimensionResults?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  currentContent?: string
  decisionGates?: DeepChapterDecisionGates
  retryCount?: number
  manualReviewRequired?: boolean
}

export interface DeepChapterGenerationDeps {
  buildContextPack: typeof buildContextPack
  contextPackToPrompt: typeof contextPackToPrompt
  reviewChapter: typeof reviewChapter
  /**
   * F-003 (ANL-010): the 6-dimension review. Results are wired into
   * reviewResults via dimensionResultsToReviewResults before the 18→3 fold,
   * so the previously-orphaned 6 dims now reach the decision gates. Defaults
   * to the real runSixDimensionReview; tests can inject a stub.
   */
  runSixDimensionReview?: typeof runSixDimensionReview
  streamChat: (
    config: LlmConfig,
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    requestOverrides?: RequestOverrides,
  ) => Promise<void>
}

const defaultDeps: DeepChapterGenerationDeps = {
  buildContextPack,
  contextPackToPrompt,
  reviewChapter,
  runSixDimensionReview,
  streamChat,
}

const REPEAT_CHECK_MIN_CHARS = 600
const REPEAT_WINDOW_CHARS = 120
const REPEAT_HIT_LIMIT = 3
const MAX_GATE_RETRY = 3
const MAX_TASK_BRIEF_REPAIR_ATTEMPTS = 2
const USER_ABORT_MESSAGE = "已停止生成"
const TASK_BRIEF_META_REQUEST_RE = /请(?:先)?补充|给我.{0,12}(?:五句|五句话)|待补全后再推进|等你补完/u
const TASK_BRIEF_META_REFUSAL_RE = /只给任务书|不写正文|本轮只|无法开写|无法推进/u
const DRAFT_META_REQUEST_RE = /请(?:先)?补充|给我.{0,12}(?:五句|五句话)|待补全后再推进|等你补完/u
const DRAFT_META_REFUSAL_RE = /只给任务书|不写正文|本轮只|任务书|错误草稿/u
const TASK_BRIEF_STRUCTURAL_MARKERS = [
  "必须完成",
  "禁止违背",
  "角色状态",
  "伏笔推进",
  "结尾钩子",
] as const
const TASK_BRIEF_SOURCE_MAX_SEGMENTS = 2
const TASK_BRIEF_SOURCE_MAX_SEGMENT_LENGTH = 72
const TASK_BRIEF_SOURCE_MAX_TOTAL_LENGTH = 160
const TASK_BRIEF_SOURCE_PREFIX_RE = /^(?:(?:本章必须完成|禁止违背|角色状态|伏笔推进|结尾钩子|暂定设定|长度要求|原始请求对齐|优先承接上一章结尾|注意推进或回应相关伏笔|不要违背既有设定|不要写乱当前时间线|不要写错当前人物状态|优先延续上一章结尾带出的悬念或动作|结合近期伏笔决定是否继续铺设、推进或回收|保持时间线连续|参考记忆库相关命中补足场景细节|注意承接最近剧情|场景必须承接)\s*[：:]\s*)+/u
const TASK_BRIEF_NOISE_MARKERS = [
  "---",
  "--- type:",
  "memory_type:",
  "snapshot_id:",
  "sources: [",
  "source_type:",
  "source_sequence:",
  "source_revision:",
  "chapter_status:",
  "chapter_number:",
  "[[",
  "]]",
] as const
const TASK_BRIEF_NOISE_LINE_RE = /^(?:-+\s*)?(?:type|memory_type|title|created|updated|tags|aliases|related|snapshot_id|source_type|source_sequence|source_revision|is_historical|sources|chapter_number|chapter_status)\s*[:：]/iu
const TASK_BRIEF_NOISE_FRAGMENT_RE = /(?:---(?:\s*type:)?|snapshot_id:|sources:\s*\[|source_(?:type|sequence|revision):|chapter_status:|chapter_number:|memory_type:|\[\[|\]\]|\{"knows":|\{"doesNotKnow":)/iu
const TASK_BRIEF_NOISE_LABELS = new Set([
  "正式设定记忆",
  "时间线记忆",
  "角色认知记忆",
  "人物状态记忆",
  "章节信息",
  "候选区",
  "当前正式认知",
  "当前正式状态",
  "正式事实",
  "最新来源",
  "相关章节",
  "关键事件",
  "关系变化",
  "角色认知",
  "当前持有者",
  "前持有者",
  "能力",
  "限制",
  "区域",
  "类型",
])
const CONSISTENCY_REVIEW_TYPES = new Set([
  "consistency",
  "character_consistency",
  "timeline",
  "foreshadowing",
  "setting",
])
const ANTI_AI_REVIEW_TYPES = new Set([
  "anti_ai",
  "style",
  "de_ai",
  "slop",
])

export function shouldUseDeepChapterGeneration(_route: TaskRouteResult | null, enabled: boolean): boolean {
  return enabled
}

function createResumeCheckpoint(
  input: DeepChapterGenerationInput,
  stage: DeepChapterGenerationResumeStage,
  data: Partial<DeepChapterGenerationResumeCheckpoint> = {},
): DeepChapterGenerationResumeCheckpoint {
  const originalRequest = input.resumeCheckpoint?.originalRequest?.trim() || input.userRequest.trim()
  return {
    version: 1,
    originalRequest,
    chapterNumber: input.resumeCheckpoint?.chapterNumber ?? input.chapterNumber,
    stage,
    ...data,
  }
}

function createEmptyDecisionGate(): DeepChapterDecisionGate {
  return {
    status: "pending",
    verdict: "pending",
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
  }
}

function emptyDecisionGates(): DeepChapterDecisionGates {
  return {
    consistency: createEmptyDecisionGate(),
    anti_ai: createEmptyDecisionGate(),
    quality: createEmptyDecisionGate(),
    overall: "pending",
  }
}

function resolveDecisionGateKey(type: string): DeepChapterDecisionGateKey {
  const normalized = type.trim().toLowerCase()
  if (CONSISTENCY_REVIEW_TYPES.has(normalized)) {
    return "consistency"
  }
  if (ANTI_AI_REVIEW_TYPES.has(normalized)) {
    return "anti_ai"
  }
  return "quality"
}

function uniqueSuggestions(findings: NovelReviewResult[]): string[] {
  return [...new Set(
    findings
      .map((item) => item.suggestion?.trim())
      .filter((value): value is string => Boolean(value)),
  )]
}

export function buildDecisionGates(
  reviewResults: NovelReviewResult[],
  retryCount: number,
  manualReviewRequired = false,
): DeepChapterDecisionGates {
  const grouped: Record<DeepChapterDecisionGateKey, NovelReviewResult[]> = {
    consistency: [],
    anti_ai: [],
    quality: [],
  }
  for (const item of reviewResults) {
    grouped[resolveDecisionGateKey(item.type)].push(item)
  }
  const updatedAt = new Date().toISOString()
  const createGate = (findings: NovelReviewResult[]): DeepChapterDecisionGate => {
    const hasError = findings.some((item) => item.severity === "error")
    const hasWarning = findings.some((item) => item.severity === "warning")
    return {
      status: hasError ? "failed" : "passed",
      verdict: manualReviewRequired && hasError
        ? "manual_review"
        : hasError
          ? "fail"
          : hasWarning
            ? "warning"
            : "pass",
      findings,
      repair_suggestions: uniqueSuggestions(findings),
      retry_count: retryCount,
      updated_at: updatedAt,
      manual_review_required: manualReviewRequired && hasError ? true : undefined,
    }
  }
  const gates: DeepChapterDecisionGates = {
    consistency: createGate(grouped.consistency),
    anti_ai: createGate(grouped.anti_ai),
    quality: createGate(grouped.quality),
    overall: "pass",
  }
  gates.overall = manualReviewRequired
    ? "manual_review"
    : gates.consistency.status === "failed" || gates.anti_ai.status === "failed"
      ? "fail"
      : gates.anti_ai.verdict === "warning" || gates.quality.verdict === "warning"
        ? "warning"
        : gates.quality.status === "failed"
          ? "fail"
          : "pass"
  return gates
}

export function collectBlockingIssues(decisionGates: DeepChapterDecisionGates): NovelReviewResult[] {
  // CORR-005 fix (GRL-008 C-104): accumulate error-severity findings across
  // ALL failed gates, not just the first. The prior early-return dropped
  // errors from subsequent failed gates (e.g. if consistency AND quality
  // both fail, quality's errors never reached the repair prompt). Warnings
  // are still routed separately via collectRepairIssues (error-only here is
  // by design — warnings never block).
  const blocking: NovelReviewResult[] = []
  for (const gateKey of ["consistency", "anti_ai", "quality"] as const) {
    const gate = decisionGates[gateKey]
    if (gate.status === "failed") {
      for (const finding of gate.findings) {
        if (finding.severity === "error") {
          blocking.push(finding)
        }
      }
    }
  }
  return blocking
}

/**
 * F-003 (ANL-010): route WARNING-severity review findings to the stage-5
 * repair loop. `collectBlockingIssues` (above) is error-only and MUST stay
 * that way — warnings never block. But warnings SHOULD still reach the
 * repair model so it can fix non-blocking quality issues in the same pass.
 * This function gathers all warning-severity findings across the 3 gates
 * (in the same gate precedence order as collectBlockingIssues) for the
 * revision prompt, WITHOUT changing the 3-gate verdict logic (gate.status
 * remains 'failed'-only-by-hasError at buildDecisionGates).
 *
 * Exported for TS-01 testing (verify warning dims reach stage-5).
 */
export function collectRepairIssues(decisionGates: DeepChapterDecisionGates): NovelReviewResult[] {
  const warnings: NovelReviewResult[] = []
  for (const gateKey of ["consistency", "anti_ai", "quality"] as const) {
    const gate = decisionGates[gateKey]
    for (const finding of gate.findings) {
      if (finding.severity === "warning") {
        warnings.push(finding)
      }
    }
  }
  return warnings
}

function checkpointStageAtLeast(
  checkpoint: DeepChapterGenerationResumeCheckpoint | null | undefined,
  target: DeepChapterGenerationResumeStage,
): boolean {
  if (!checkpoint) return false
  const order: DeepChapterGenerationResumeStage[] = [
    "after_context",
    "after_task_brief",
    "after_draft",
    "after_review",
    "after_revision",
  ]
  return order.indexOf(checkpoint.stage) >= order.indexOf(target)
}

function hasCheckpointTaskBrief(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string } {
  return Boolean(checkpoint?.taskBrief?.trim()) && checkpointStageAtLeast(checkpoint, "after_task_brief")
}

function hasCheckpointDraft(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string } {
  return hasCheckpointTaskBrief(checkpoint) && Boolean(checkpoint.draftContent?.trim()) && checkpointStageAtLeast(checkpoint, "after_draft")
}

function hasCheckpointReview(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[] } {
  return hasCheckpointDraft(checkpoint) && Array.isArray(checkpoint.reviewResults) && checkpointStageAtLeast(checkpoint, "after_review")
}

function hasCheckpointRevision(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[], currentContent: string } {
  return hasCheckpointReview(checkpoint) && Boolean(checkpoint.currentContent?.trim()) && checkpointStageAtLeast(checkpoint, "after_revision")
}

function normalizeMetaText(content: string): string {
  return content.replace(/\s+/g, "")
}

function sanitizeTaskBriefSourceText(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return ""

  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/(?:^|\s)---+(?=\s|$)/gu, "\n")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/[（(]来源[:：][^）)]*[）)]/gu, "")
    .replace(/\{[^{}]{0,200}\}/gu, " ")
    .replace(/\s+-\s+/gu, "\n- ")

  const segments = normalized
    .split(/\n+/u)
    .flatMap((line) => line.split(/[；;]/u))
    .map((line) => normalizeTaskBriefCandidateLine(line))
    .filter((line) => isUsableTaskBriefCandidateLine(line))

  const preferredSegments = segments.some(containsCjkTaskBriefText)
    ? segments.filter((line) => containsCjkTaskBriefText(line))
    : segments

  const deduped: string[] = []
  for (const segment of preferredSegments) {
    if (deduped.includes(segment)) continue
    deduped.push(trimForThinking(segment, TASK_BRIEF_SOURCE_MAX_SEGMENT_LENGTH))
    if (deduped.length >= TASK_BRIEF_SOURCE_MAX_SEGMENTS) break
  }

  if (deduped.length === 0) return ""
  return trimForThinking(deduped.join("；"), TASK_BRIEF_SOURCE_MAX_TOTAL_LENGTH)
}

function normalizeTaskBriefCandidateLine(value: string): string {
  const trimmed = value.trim()
  const isHeading = /^#{1,6}\s*/u.test(trimmed)
  let normalized = trimmed
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^-+\s*/u, "")
    .replace(/^第\d+章[：:]\s*/u, "")
    .replace(/^Chapter\s*\d+[：:]\s*/iu, "")
    .replace(/^(?:当前状态|最近更新|关系变化|角色认知|关键事件|说明|已知|未知|当前正式事实|当前正式认知|当前正式状态)[：:]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()

  while (TASK_BRIEF_SOURCE_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(TASK_BRIEF_SOURCE_PREFIX_RE, "").trim()
  }

  if (isHeading && !/[：:，。！？；,.!?]/u.test(normalized)) {
    return ""
  }

  return normalized
}

function containsCjkTaskBriefText(value: string): boolean {
  return /[\u3400-\u9FFF]/u.test(value)
}

function isUsableTaskBriefCandidateLine(value: string): boolean {
  if (!value) return false
  if (TASK_BRIEF_NOISE_LABELS.has(value)) return false
  if (TASK_BRIEF_NOISE_LINE_RE.test(value) || TASK_BRIEF_NOISE_FRAGMENT_RE.test(value)) return false
  if (looksLikeNarrativeTaskBrief(value)) return false
  return value.length >= 6
}

function chapterLengthRequirement(lengthSpec: ChapterLengthSpec): string {
  return `目标约 ${lengthSpec.targetChars} 字；低于 ${lengthSpec.minChars} 字视为未完成。`
}

function isNonExecutableTaskBrief(taskBrief: string): boolean {
  const normalized = normalizeMetaText(taskBrief)
  if (!normalized) return false
  return TASK_BRIEF_META_REQUEST_RE.test(normalized) && TASK_BRIEF_META_REFUSAL_RE.test(normalized)
}

function countTaskBriefStructureHits(taskBrief: string): number {
  return TASK_BRIEF_STRUCTURAL_MARKERS.reduce((count, marker) => (
    taskBrief.includes(marker) ? count + 1 : count
  ), 0)
}

function containsPollutedTaskBriefMarkers(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  const markerHits = TASK_BRIEF_NOISE_MARKERS.reduce((count, marker) => (
    trimmed.includes(marker) ? count + 1 : count
  ), 0)
  if (markerHits === 0) return false
  return countTaskBriefStructureHits(trimmed) >= 2 || trimmed.length >= 240
}

function looksLikeNarrativeTaskBrief(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  if (/^\[N\]/u.test(trimmed)) return true
  if (/^#\s*第.{0,20}章/mu.test(trimmed) || /^第.{0,20}章(?:\s|$)/mu.test(trimmed)) {
    return true
  }
  if (countTaskBriefStructureHits(trimmed) >= 2) return false
  const longParagraphs = trimmed
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/g, ""))
    .filter((paragraph) => paragraph.length >= 40)
  return longParagraphs.length >= 3
}

function shouldRepairTaskBrief(taskBrief: string): boolean {
  return isNonExecutableTaskBrief(taskBrief)
    || looksLikeNarrativeTaskBrief(taskBrief)
    || containsPollutedTaskBriefMarkers(taskBrief)
}

function shouldUseDeterministicTaskBriefFallback(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  if (containsPollutedTaskBriefMarkers(trimmed)) return true
  if (countTaskBriefStructureHits(trimmed) >= 2 && trimmed.length >= 600) return true
  return looksLikeNarrativeTaskBrief(trimmed) && trimmed.length >= 600
}

function isMetaDraftContent(draftContent: string): boolean {
  const normalized = normalizeMetaText(draftContent)
  if (!normalized) return false
  if (/^\[N\]/u.test(draftContent.trim())) return true
  return DRAFT_META_REQUEST_RE.test(normalized) && DRAFT_META_REFUSAL_RE.test(normalized)
}

function buildTaskBriefRepairPrompt(
  outlinePrompt: string,
  contextPrompt: string,
  invalidTaskBrief: string,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  return [
    buildStableContextPrefix(outlinePrompt, contextPrompt),
    "[TASK_BRIEF_MARKER]",
    "",
    "你刚才输出的写作任务书不可直接执行。",
    "它可能把缺失信息转回给用户、声明本轮不直接写正文，或者直接漂移成了小说正文片段。",
    "请把它改写成一份可以立刻开写的结构化章节任务书。",
    "",
    "硬性要求：",
    "1. 不得向用户追问，不得要求“补充设定”“给我五句话”“下一轮再写”。",
    "2. 不得写“只给任务书”“不写正文”“待补全后再推进”这类元说明。",
    "3. 不得输出小说正文、对话片段、场景描写、章节标题或任何可直接作为正文保存的内容。",
    "4. 如果上下文不足，必须自行补出最小必要设定，并明确标成“暂定设定”。",
    "5. 任务书必须显式覆盖：本章必须完成、禁止违背、角色状态、伏笔推进、结尾钩子。",
    `6. 这份任务书必须足以直接写出完整章节正文，${chapterLengthRequirement(lengthSpec)}`,
    "7. 严格按下面的结构输出，不得改标题，不得额外添加章节标题、正文片段或解释：",
    "本章必须完成：...",
    "禁止违背：...",
    "角色状态：...",
    "伏笔推进：...",
    "结尾钩子：...",
    "暂定设定：...",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    `用户请求：${userRequest}`,
    "",
    "不可执行任务书：",
    invalidTaskBrief,
  ].join("\n")
}

function pickTaskBriefFallbackValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = sanitizeTaskBriefSourceText(value)
    if (normalized) return normalized
  }
  return ""
}

function taskBriefFallbackLine(label: string, value: string): string {
  return `${label}：${value.trim()}`
}

function buildFallbackTaskBrief(
  contextPack: ContextPack,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  const chapterLabel = chapterNumber ? `第${chapterNumber}章` : "当前章节"
  const mustDo = pickTaskBriefFallbackValue(
    contextPack.mustDo,
    contextPack.chapterGoal,
    `承接上一章结尾，完成 ${chapterLabel} 的核心冲突推进，并自然落出下一步行动。`,
  )
  const mustAvoid = pickTaskBriefFallbackValue(
    contextPack.mustAvoid,
    contextPack.canonRules,
    contextPack.timeline,
    "不得违背既有设定、角色认知边界与时间线。",
  )
  const characterState = pickTaskBriefFallbackValue(
    contextPack.characterStates,
    contextPack.cognitionStates,
    "沿用现有角色状态与认知边界，不擅自越界知晓或反常行动。",
  )
  const foreshadowing = pickTaskBriefFallbackValue(
    contextPack.foreshadowingStates,
    contextPack.searchResults,
    contextPack.graphSearchResults,
    "至少推进一个既有线索或伏笔，并把它和本章结果绑定。",
  )
  const endingHook = pickTaskBriefFallbackValue(
    contextPack.nextChapterAdvice,
    contextPack.previousChapterEnding && `结尾需承接上一章留下的压力：${contextPack.previousChapterEnding}`,
    "结尾保留下一章可直接承接的新压力、线索或选择题。",
  )
  const provisionalSetting = pickTaskBriefFallbackValue(
    contextPack.relatedSettings,
    contextPack.previousChapterEnding && `场景必须承接：${contextPack.previousChapterEnding}`,
    "若上下文仍有缺口，只补最小必要场景设定，不新增会推翻既有设定的事实。",
  )

  return [
    taskBriefFallbackLine("本章必须完成", mustDo),
    taskBriefFallbackLine("禁止违背", mustAvoid),
    taskBriefFallbackLine("角色状态", characterState),
    taskBriefFallbackLine("伏笔推进", foreshadowing),
    taskBriefFallbackLine("结尾钩子", endingHook),
    taskBriefFallbackLine("暂定设定", provisionalSetting),
    taskBriefFallbackLine("长度要求", chapterLengthRequirement(lengthSpec)),
    taskBriefFallbackLine(
      "原始请求对齐",
      sanitizeTaskBriefSourceText(userRequest) || `围绕 ${chapterLabel} 的写作需求推进。`,
    ),
  ].join("\n")
}

function buildDraftRecoveryPrompt(
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  invalidDraft: string,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  return [
    buildStableContextPrefix(outlinePrompt, contextPrompt),
    "[DRAFT_STAGE_MARKER]",
    "",
    "你上一次输出成了任务说明、追问用户或其他元文本，而不是小说正文。",
    "请丢弃那份错误输出，重新直接写出可审查、可保存的章节正文。",
    "",
    "硬性要求：",
    "1. 只输出小说正文，不得输出任务书、解释、追问、补设定请求或后续说明。",
    "2. 如果任务书里仍有缺口，必须自行补出最小必要设定并自然写进正文，不得把任务转回给用户。",
    `3. 必须写成完整章节，${chapterLengthRequirement(lengthSpec)}`,
    "4. 必须保留冲突推进、人物互动、细节描写和结尾钩子。",
    "5. 禁止复读、循环输出、重复段落，以及任何“等你补充后再写”的元文本。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    `用户请求：${userRequest}`,
    "",
    "写作任务书：",
    taskBrief,
    "",
    "错误草稿（仅用于识别错误模式，不可沿用其元文本表达）：",
    invalidDraft,
  ].join("\n")
}

export async function runDeepChapterGeneration(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps: DeepChapterGenerationDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<DeepChapterGenerationResult> {
  assertNotAborted(signal)
  // Tracks whether any collectModelText stage took the transport-inactivity
  // partial-preserve branch. The first partial reason wins; later stages
  // (expansion/polish) keep the flag set so the caller routes the result to the
  // pause / continue-unfinished path instead of completeDeepChapterSession.
  let partialReason: string | null = null
  const notePartial = (reason: string) => {
    if (partialReason === null) partialReason = reason
  }
  const resumeCheckpoint = input.resumeCheckpoint
  const writingConfig = resolveWritingConfig(input.llmConfig)
  const lengthSpec = resolveCurrentChapterLengthSpec()
  const novelConfig = useWikiStore.getState().novelConfig
  const { loadSmartDeAiSkill } = await import("./de-ai-adapter")

  // 将在阶段1构建contextPack后再加载skill（需要contextPack用于场景检测）
  let customDeAiSkill: string | null = null

  // 阶段0：前情分析（仅当章节号>1，且设置开启时；记忆库的近期摘要与上一章结尾仍会注入）
  let previousChaptersAnalysis = ""
  if (input.chapterNumber && input.chapterNumber > 1 && !resumeCheckpoint && novelConfig.deepPreviousChaptersAnalysis) {
    callbacks.onThinking?.(formatStageThinking("阶段0：前情分析", "正在读取并分析前3章完整内容..."))
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    try {
      previousChaptersAnalysis = await analyzePreviousChapters(
        input.projectPath,
        input.chapterNumber,
        writingConfig,
        3,
      )
      if (previousChaptersAnalysis) {
        callbacks.onThinking?.(formatStageThinking(
          "阶段0：前情分析",
          `已完成前情分析（${previousChaptersAnalysis.length}字）\n\n${previousChaptersAnalysis.slice(0, 500)}...`
        ))
      }
    } catch (error) {
      console.error("[deep-chapter-generation] 前情分析失败:", error)
    }
  }
  assertNotAborted(signal)

  const contextPack = await safeBuildChapterContextPack(
    deps,
    input.projectPath,
    input.userRequest,
    input.chapterNumber,
  )
  assertNotAborted(signal)

  // 阶段1后：加载智能skill（传递contextPack用于场景检测）
  customDeAiSkill = await loadSmartDeAiSkill(input.projectPath, input.userRequest, contextPack)

  // 独立提取大纲，不通过contextPackToPrompt
  const outlinePrompt = contextPack.outline
    ? [
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "# 【强制遵守】作品完整大纲",
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "**重要：以下是本作品的完整大纲，这是强制性要求。**",
        "你必须严格遵守大纲中的情节发展、角色行为、关键事件、故事走向。",
        "大纲内容必须完整体现在生成的章节中，不可偏离。",
        "",
        contextPack.outline,
        "",
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
      ].join("\n")
    : ""

  // 其他上下文可以进行token预算管理，但大纲已被排除
  const contextPrompt = [
    previousChaptersAnalysis ? `## 前情分析\n\n${previousChaptersAnalysis}` : "",
    deps.contextPackToPrompt(contextPack, 32000, { excludeOutline: true }),
    input.dismantlingReferenceDirective,
  ].filter(Boolean).join("\n\n")

  // 稳定上下文前缀：与任务书/初稿/扩写/返修/去AI味各阶段提示词开头逐字节一致。
  // 作为显式 prompt 缓存断点传入（Anthropic/MiniMax 走 cache_control；
  // OpenAI/DeepSeek 该断点被折叠回字符串、由其自动前缀缓存命中）。
  const cachePrefix = buildStableContextPrefix(outlinePrompt, contextPrompt)

  if (!resumeCheckpoint) {
    callbacks.onThinking?.(formatContextThinking(input, contextPack))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_context"))
  }
  assertNotAborted(signal)

  let taskBrief = hasCheckpointTaskBrief(resumeCheckpoint) ? resumeCheckpoint.taskBrief.trim() : ""
  if (!taskBrief) {
    taskBrief = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDeepChapterBriefPrompt(
          outlinePrompt,
          contextPrompt,
          input.userRequest,
          input.chapterNumber,
          input.goldenThreeChapter,
          lengthSpec,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", partial)),
      undefined,
      cachePrefix,
    )
    assertNotAborted(signal)
    callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", taskBrief))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  }

  const taskBriefNeedsDeterministicFallback =
    shouldUseDeterministicTaskBriefFallback(taskBrief)
    || (Boolean(resumeCheckpoint) && shouldRepairTaskBrief(taskBrief))

  if (taskBriefNeedsDeterministicFallback) {
    taskBrief = buildFallbackTaskBrief(
      contextPack,
      input.userRequest,
      input.chapterNumber,
      lengthSpec,
    )
    callbacks.onThinking?.(formatStageThinking(
      "阶段2.5：任务书纠偏",
      [
        resumeCheckpoint
          ? "检测到恢复检查点里的任务书已经漂移成正文或元说明。"
          : "检测到任务书已经膨胀成超长章节化说明，继续追加一次模型纠偏只会放大不稳定性。",
        resumeCheckpoint
          ? "为避免恢复链再次卡在一次额外的模型纠偏调用，这次直接切换到本地结构化 fallback 任务书。"
          : "这次直接切换到本地结构化 fallback 任务书，绕过额外的阶段2.5 模型调用。",
        "",
        taskBrief,
      ].join("\n"),
    ))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  } else if (shouldRepairTaskBrief(taskBrief)) {
    let repairAttempt = 0
    while (shouldRepairTaskBrief(taskBrief) && repairAttempt < MAX_TASK_BRIEF_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      callbacks.onThinking?.(formatStageThinking(
        "阶段2.5：任务书纠偏",
        repairAttempt === 1
          ? "检测到任务书不可直接执行，或已经漂移成正文片段，正在改写为可直接开写的结构化任务书。"
          : `上一次纠偏仍未产出可执行任务书，正在进行第 ${repairAttempt} 次重试。`,
      ))
      taskBrief = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildTaskBriefRepairPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            input.userRequest,
            input.chapterNumber,
            lengthSpec,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段2.5：任务书纠偏", partial)),
        undefined,
        cachePrefix,
      )
      assertNotAborted(signal)
      callbacks.onThinking?.(formatStageThinking("阶段2.5：任务书纠偏", taskBrief))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
    }

    if (shouldRepairTaskBrief(taskBrief)) {
      taskBrief = buildFallbackTaskBrief(
        contextPack,
        input.userRequest,
        input.chapterNumber,
        lengthSpec,
      )
      callbacks.onThinking?.(formatStageThinking(
        "阶段2.5：任务书纠偏",
        [
          `模型连续 ${MAX_TASK_BRIEF_REPAIR_ATTEMPTS} 次仍输出正文型任务书，已切换到本地结构化 fallback，避免阶段3继续使用坏 taskBrief。`,
          "",
          taskBrief,
        ].join("\n"),
      ))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
    }
  }

  let draftContent = hasCheckpointDraft(resumeCheckpoint) ? resumeCheckpoint.draftContent.trim() : ""
  if (!draftContent) {
    draftContent = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDeepChapterDraftPrompt(
          outlinePrompt,
          contextPrompt,
          taskBrief,
          input.userRequest,
          input.chapterNumber,
          input.goldenThreeChapter,
          lengthSpec,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文初稿", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
    )
    assertNotAborted(signal)
    if (countChapterChars(draftContent) < lengthSpec.minChars) {
      draftContent = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildDeepChapterExpansionPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            draftContent,
            input.userRequest,
            input.chapterNumber,
            input.goldenThreeChapter,
            lengthSpec,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文扩写补足", partial)),
        { max_tokens: lengthSpec.maxOutputTokens },
        cachePrefix,
        notePartial,
      )
      assertNotAborted(signal)
    }
    callbacks.onThinking?.(formatStageThinking("阶段3：正文初稿", [
      draftContent,
      "",
      `初稿生成完成，约 ${countChapterChars(draftContent)} 字。`,
    ].join("\n")))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_draft", { taskBrief, draftContent }))
  }

  if (isMetaDraftContent(draftContent)) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段3.5：草稿纠偏",
      "检测到模型输出了任务说明或追问用户，正在重写为可直接审查的章节正文。",
    ))
    draftContent = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDraftRecoveryPrompt(
          outlinePrompt,
          contextPrompt,
          taskBrief,
          draftContent,
          input.userRequest,
          input.chapterNumber,
          lengthSpec,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段3.5：草稿纠偏", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
    )
    assertNotAborted(signal)
    if (countChapterChars(draftContent) < lengthSpec.minChars) {
      draftContent = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildDeepChapterExpansionPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            draftContent,
            input.userRequest,
            input.chapterNumber,
            input.goldenThreeChapter,
            lengthSpec,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文扩写补足", partial)),
        { max_tokens: lengthSpec.maxOutputTokens },
        cachePrefix,
        notePartial,
      )
      assertNotAborted(signal)
    }
    callbacks.onThinking?.(formatStageThinking("阶段3.5：草稿纠偏", [
      draftContent,
      "",
      `纠偏后正文约 ${countChapterChars(draftContent)} 字。`,
    ].join("\n")))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_draft", { taskBrief, draftContent }))
  }

  let reviewResults = hasCheckpointReview(resumeCheckpoint) ? resumeCheckpoint.reviewResults : []
  let decisionGates = resumeCheckpoint?.decisionGates ?? emptyDecisionGates()
  let retryCount = resumeCheckpoint?.retryCount ?? 0
  let manualReviewRequired = Boolean(resumeCheckpoint?.manualReviewRequired)
  if (!hasCheckpointReview(resumeCheckpoint)) {
    if (!novelConfig.deepChapterReview) {
      callbacks.onThinking?.(formatStageThinking(
        "阶段4-5：已跳过审稿与返修",
        "已按设置关闭 AI 审稿，初稿将直接进入阶段6简单审查与去AI味。",
      ))
    } else {
      callbacks.onThinking?.(formatStageThinking(
        "阶段4：AI审稿",
        "正在检查正文完整性、剧情连续性、是否被截断以及是否存在阻断问题。",
      ))
      try {
        // 复用阶段1已构建的 contextPack，避免审稿内部再 buildContextPack 一次
        // （会重复跑检索 / 向量 / 图谱）。
        reviewResults = signal
          ? await deps.reviewChapter(input.projectPath, draftContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack }, signal)
          : await deps.reviewChapter(input.projectPath, draftContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack })
      } catch (err) {
        console.error("[Deep Chapter] Review failed:", err)
        throw err
      }
      reviewResults = reviewResults || []
      // F-003 (ANL-010): wire the 6-dimension review into reviewResults.
      // Previously the 6 dims were generated by runSixDimensionReview but
      // orphaned — they never reached reviewResults (no import here; verified
      // grep-zero-match pre-F-003). Now they're flattened via
      // dimensionResultsToReviewResults (each dim tagged with DIM_TO_GATE_TYPE
      // so resolveDecisionGateKey buckets correctly — character → consistency
      // gate, NOT quality) and merged BEFORE the 18→3 fold in buildDecisionGates.
      // Best-effort: a 6-dim failure must NOT break the main review flow.
      let dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {}
      try {
        dimensionResults = deps.runSixDimensionReview
          ? await deps.runSixDimensionReview({
              projectPath: input.projectPath,
              chapterContent: draftContent,
              chapterNumber: input.chapterNumber,
            })
          : {}
        if (dimensionResults && Object.keys(dimensionResults).length > 0) {
          reviewResults = [
            ...(reviewResults || []),
            ...dimensionResultsToReviewResults(dimensionResults),
          ]
        }
      } catch (err) {
        console.error("[Deep Chapter] 6-dimension review failed (non-blocking):", err)
      }
      decisionGates = buildDecisionGates(reviewResults, retryCount)
      assertNotAborted(signal)
      callbacks.onThinking?.(formatReviewThinking(reviewResults))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
        taskBrief,
        draftContent,
        reviewResults,
        dimensionResults,
        decisionGates,
        retryCount,
      }))
    }
  }

  if (hasCheckpointReview(resumeCheckpoint) && decisionGates.overall === "pending") {
    decisionGates = buildDecisionGates(reviewResults, retryCount, manualReviewRequired)
  }

  let currentContent = draftContent
  let revised = false

  if (hasCheckpointRevision(resumeCheckpoint)) {
    currentContent = resumeCheckpoint.currentContent.trim()
    revised = true
    if (novelConfig.deepChapterReview && decisionGates.overall === "pending") {
      callbacks.onThinking?.(formatStageThinking(
        "阶段5.5：返修后复审",
        "正在恢复返修后的完整门控审查，确认上次中断前的返修结果。",
      ))
      try {
        reviewResults = signal
          ? await deps.reviewChapter(input.projectPath, currentContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack }, signal)
          : await deps.reviewChapter(input.projectPath, currentContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack })
      } catch (err) {
        console.error("[Deep Chapter] 恢复返修后复审失败:", err)
        throw err
      }
      reviewResults = reviewResults || []
      decisionGates = buildDecisionGates(reviewResults, retryCount, manualReviewRequired)
      assertNotAborted(signal)
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
        taskBrief,
        draftContent,
        reviewResults,
        currentContent,
        decisionGates,
        retryCount,
      }))
    }
  }

  let blockingIssues = collectBlockingIssues(decisionGates)
  if (!revised && blockingIssues.length === 0 && novelConfig.deepChapterReview) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段5：无需自动返修",
      "AI审稿未发现阻断问题，跳过自动返修，进入阶段6简单审查与去AI味。",
    ))
  }

  while (novelConfig.deepChapterReview && blockingIssues.length > 0) {
    if (retryCount >= MAX_GATE_RETRY) {
      manualReviewRequired = true
      decisionGates = buildDecisionGates(reviewResults, retryCount, true)
      callbacks.onThinking?.(formatStageThinking(
        "阶段5.5：转人工处理",
        [
          `阻断问题在 ${retryCount} 次自动返修后仍未解除，已转人工处理。`,
          "",
          formatReviewIssueList(blockingIssues),
          "",
          "当前草稿与 gate 结果将保留在运行态真源中，等待人工继续处理。",
        ].join("\n"),
      ))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, revised ? "after_revision" : "after_review", {
        taskBrief,
        draftContent,
        reviewResults,
        currentContent,
        decisionGates,
        retryCount,
        manualReviewRequired: true,
      }))
      callbacks.onFinalContent?.(currentContent)
      return {
        finalContent: currentContent,
        taskBrief,
        draftContent,
        reviewResults,
        revised,
        decisionGates,
        manualReviewRequired: true,
        retryCount,
        partial: partialReason !== null,
        partialReason,
      }
    }

    const nextRetryCount = retryCount + 1
    // F-003 (ANL-010): route WARNING-severity findings to the stage-5 repair
    // loop alongside the error-severity blockingIssues. collectBlockingIssues
    // stays error-only (warnings never block); collectRepairIssues gathers
    // the warnings so the repair model can fix non-blocking quality issues
    // (TS-01: warning dims reach stage-5) in the same pass. Dedup by message
    // to avoid double-listing an issue that is both blocking and warned.
    const repairIssues = collectRepairIssues(decisionGates)
    const repairIssueMessages = new Set(repairIssues.map((i) => i.message))
    const revisionIssues = [
      ...blockingIssues,
      ...repairIssues.filter((i) => !repairIssueMessages.has(i.message) || blockingIssues.every((b) => b.message !== i.message)),
    ]
    const revisedContent = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDeepChapterRevisionPrompt(
          outlinePrompt,
          contextPrompt,
          taskBrief,
          currentContent,
          revisionIssues,
          input.userRequest,
          input.chapterNumber,
          input.goldenThreeChapter,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段5：自动返修", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
    )
    assertNotAborted(signal)
    callbacks.onThinking?.(formatStageThinking(
      "阶段5：自动返修",
      [
        `检测到 ${blockingIssues.length} 个阻断问题，已自动返修第 ${nextRetryCount} 次。`,
        "",
        formatReviewIssueList(blockingIssues),
        "",
        `返修后正文约 ${countChapterChars(revisedContent)} 字。`,
      ].join("\n"),
    ))
    currentContent = revisedContent
    revised = true
    retryCount = nextRetryCount
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_revision", {
      taskBrief,
      draftContent,
      reviewResults,
      currentContent: revisedContent,
      decisionGates,
      retryCount,
    }))

    callbacks.onThinking?.(formatStageThinking(
      "阶段5.5：返修后复审",
      "正在对返修后的正文重新运行完整门控审查，确认阻断问题是否已经解除。",
    ))
    try {
      reviewResults = signal
        ? await deps.reviewChapter(input.projectPath, currentContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack }, signal)
        : await deps.reviewChapter(input.projectPath, currentContent, input.chapterNumber, { onThinking: callbacks.onThinking, contextPack })
    } catch (err) {
      console.error("[Deep Chapter] 返修后复审失败:", err)
      throw err
    }
    reviewResults = reviewResults || []
    decisionGates = buildDecisionGates(reviewResults, retryCount)
    blockingIssues = collectBlockingIssues(decisionGates)
    assertNotAborted(signal)
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
      taskBrief,
      draftContent,
      reviewResults,
      currentContent,
      decisionGates,
      retryCount,
    }))
    callbacks.onThinking?.(formatStageThinking(
      "阶段5.5：返修后复审",
      blockingIssues.length === 0
        ? "返修后复审未发现新的阻断问题，进入阶段6。"
        : [
            `返修后复审仍发现 ${blockingIssues.length} 个阻断问题。`,
            "",
            formatReviewIssueList(blockingIssues),
            "",
            `当前自动返修次数：${retryCount}/${MAX_GATE_RETRY}。`,
          ].join("\n"),
    ))
  }

  const finalContent = await finalPolishChapter(
    writingConfig,
    outlinePrompt,
    contextPrompt,
    taskBrief,
    currentContent,
    input,
    contextPack,
    callbacks,
    deps,
    signal,
    customDeAiSkill || undefined,
    lengthSpec,
    cachePrefix,
    notePartial,
  )
  callbacks.onThinking?.(formatStageThinking(
    "阶段7：完成",
    revised
      ? "采用返修并完成简单审查、去AI味后的正文作为最终正文。"
      : "未发现阻断问题，已完成最后一遍简单审查与去AI味。",
  ))
  callbacks.onFinalContent?.(finalContent)
  return {
    finalContent,
    taskBrief,
    draftContent,
    reviewResults,
    revised,
    decisionGates,
    manualReviewRequired: false,
    retryCount,
    partial: partialReason !== null,
    partialReason,
  }
}

async function finalPolishChapter(
  writingConfig: LlmConfig,
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  currentContent: string,
  input: DeepChapterGenerationInput,
  _contextPack: ContextPack,
  callbacks: DeepChapterGenerationCallbacks,
  deps: DeepChapterGenerationDeps,
  signal?: AbortSignal,
  customDeAiSkill?: string,
  lengthSpec: ChapterLengthSpec = resolveChapterLengthSpec(),
  cachePrefix?: string,
  onPartial?: (reason: string) => void,
): Promise<string> {
  assertNotAborted(signal)
  callbacks.onThinking?.(formatStageThinking("阶段6：简单审查与去AI味", "正在进行最后一遍简单审查，去除复读、机械套话和 AI 味。"))
  const polished = await collectModelText(
    writingConfig,
    [{
      role: "user",
      content: buildDeepChapterFinalPolishPrompt(
        outlinePrompt,
        contextPrompt,
        taskBrief,
        currentContent,
        input.userRequest,
        input.chapterNumber,
        input.goldenThreeChapter,
        customDeAiSkill,
      ),
    }],
    deps,
    signal,
    (partial) => callbacks.onThinking?.(formatStageThinking("阶段6：简单审查与去AI味", partial)),
    { max_tokens: lengthSpec.maxOutputTokens },
    cachePrefix,
    onPartial,
  )
  assertNotAborted(signal)
  return polished.trim() ? polished : currentContent
}

function resolveCurrentChapterLengthSpec(): ChapterLengthSpec {
  const novelConfig = useWikiStore.getState().novelConfig
  return resolveChapterLengthSpec(novelConfig?.chapterTargetChars)
}

function resolveWritingConfig(llmConfig: LlmConfig): LlmConfig {
  // 写作模型已移除，始终使用 AI 会话当前模型。
  // llmConfig 已在 chat-panel.tsx 中通过 effectiveChatLlmConfig 正确解析，
  // 不再通过 resolveNovelModel 重新解析，避免二次解析使用不同 API 端点/密钥
  return llmConfig
}

/**
 * 把以 cachePrefix 开头的 user 字符串消息拆成 [前缀块(cacheControl), 余下块]，
 * 让 provider 在稳定上下文前缀上打缓存断点。其余消息原样返回。
 * 注：Anthropic/MiniMax 会据此发出 cache_control；OpenAI/DeepSeek 端纯文本块会被
 * 折叠回与原字符串逐字节一致的内容，不影响其自动前缀缓存。
 */
function applyCachePrefix(messages: ChatMessage[], cachePrefix?: string): ChatMessage[] {
  if (!cachePrefix) return messages
  return messages.map((message) => {
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(cachePrefix)
    ) {
      const rest = message.content.slice(cachePrefix.length)
      return {
        role: message.role,
        content: [
          { type: "text" as const, text: cachePrefix, cacheControl: true },
          ...(rest ? [{ type: "text" as const, text: rest }] : []),
        ],
      }
    }
    return message
  })
}

async function collectModelText(
  config: LlmConfig,
  messages: ChatMessage[],
  deps: DeepChapterGenerationDeps,
  signal?: AbortSignal,
  onUpdate?: (content: string) => void,
  requestOverrides?: RequestOverrides,
  cachePrefix?: string,
  onPartial?: (reason: string) => void,
): Promise<string> {
  let content = ""
  let reasoningBuffer = ""
  let streamError: Error | null = null
  let cutoffReason: string | null = null
  // Repeat-detection only needs to re-run once enough new content has arrived
  // to change the trailing window (REPEAT_WINDOW_CHARS). Without this gate the
  // per-token findRepeatedTailStart call did 3 full passes over the entire
  // growing draft on every text_delta, making collectModelText O(n^2) in draft
  // length — pathological under --include-partial-messages where every token is
  // a separate stream event. The tail changes meaningfully only after
  // REPEAT_WINDOW_CHARS new chars, so gating on that drops per-token cost to
  // O(1) amortized and the whole-draft cost to O(n).
  let lastRepeatCheckLen = 0
  const streamController = new AbortController()
  const combinedSignal = combineAbortSignals(signal, streamController.signal)
  const stopStream = (reason: string) => {
    if (cutoffReason) return
    cutoffReason = reason
    streamController.abort()
  }

  assertNotAborted(signal)

  await deps.streamChat(
    config,
    applyCachePrefix(messages, cachePrefix),
    {
      onToken: (token) => {
        if (signal?.aborted) {
          stopStream(USER_ABORT_MESSAGE)
          return
        }
        content += token
        // Only re-scan for repeated tail when the content has grown by at least
        // REPEAT_WINDOW_CHARS since the last check; the trailing window cannot
        // form a new 3x repeat until that much new content arrives.
        if (content.length - lastRepeatCheckLen >= REPEAT_WINDOW_CHARS) {
          lastRepeatCheckLen = content.length
          const loopStart = findRepeatedTailStart(content)
          if (loopStart !== null) {
            content = content.slice(0, loopStart).trimEnd()
            onUpdate?.(`${content}\n\n（已检测到模型重复输出，已自动停止重复内容。）`)
            stopStream("检测到模型重复输出，已自动停止重复内容。")
            return
          }
        }
        onUpdate?.(content)
      },
      onReasoningToken: (token) => {
        if (signal?.aborted) {
          stopStream(USER_ABORT_MESSAGE)
          return
        }
        // 推理 token 只用于进度显示，不计入最终 content
        reasoningBuffer += token
        if (!content) {
          onUpdate?.(reasoningBuffer)
        }
      },
      onDone: () => {},
      onError: (error) => {
        streamError = error
      },
    },
    combinedSignal,
    {
      ...requestOverrides,
      reasoning: requestOverrides?.reasoning ?? config.reasoning,
    },
  )

  // `streamError` is assigned inside the `onError` callback above, so TS
  // control-flow treats it as `null` here. Read it through a closure accessor
  // so the real `Error | null` type survives for the recoverability check.
  const readStreamError = (): Error | null => streamError

  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)
  // Transport inactivity/timeout errors are recoverable when the model already
  // streamed real partial content: the transport simply lost patience before
  // the next token arrived. Discarding that content would force a full stage-3
  // re-run from an empty draft, which is the documented `after_task_brief`
  // stall mechanism. Preserve the partial text so the caller can checkpoint it
  // as a pausable partial draft and `continue-unfinished` can resume from real
  // progress instead of from zero. Genuine hangs (no content at all) and
  // deterministic errors (auth/config/cancellation) still throw so the chat
  // panel pause path records the failure.
  //
  // `streamError` is assigned inside the `onError` callback, so TS control-flow
  // treats it as `null` here; read it through an accessor to defeat that
  // narrowing and recover the real `Error | null` type.
  const errorNow = readStreamError()
  const partialContent = content.trim()
  if (errorNow && !(cutoffReason && isRequestCancelledError(errorNow))) {
    if (partialContent && isTransportInactivityError(errorNow)) {
      // Surface partiality to the caller so the orchestration layer can route
      // this draft to the pause / continue-unfinished path instead of the
      // complete->ready->writeback path. Without this signal the truncated
      // draft would be persisted as a completed, ready chapter (Draft-first
      // boundary violation). See DeepChapterGenerationResult.partial.
      onPartial?.(errorNow.message)
      onUpdate?.(`${partialContent}\n\n（${errorNow.message}，已保留已生成的部分正文以便继续未完成。）`)
    } else {
      throw errorNow
    }
  }
  if (cutoffReason) {
    onUpdate?.(`${content.trim()}\n\n（${cutoffReason}）`)
  }
  return content.trim()
}

function countChapterChars(content: string): number {
  return content.replace(/\s+/g, "").length
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)
}

function isRequestCancelledError(error: Error): boolean {
  return /request cancelled|request canceled|aborted|aborterror/i.test(error.message)
}

/**
 * True for Claude Code CLI transport timeouts where the subprocess stayed
 * alive but stalled before/after producing output. These are recoverable when
 * partial content exists: a fresh subprocess on `continue-unfinished` can
 * complete the draft. Distinct from cancellation (client intent) and from
 * deterministic auth/config errors (retrying won't help).
 */
function isTransportInactivityError(error: Error): boolean {
  return /produced no meaningful stream output within \d+ seconds|produced no additional stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|kept emitting progress heartbeats/i.test(
    error.message,
  )
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter(Boolean) as AbortSignal[]
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]

  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

function findRepeatedTailStart(content: string): number | null {
  const normalized = content.replace(/\r\n/g, "\n")
  const compact = normalized.replace(/\s+/g, "")
  if (compact.length < REPEAT_CHECK_MIN_CHARS) return null

  const tail = compact.slice(-REPEAT_WINDOW_CHARS)
  const first = compact.indexOf(tail)
  if (first === -1 || first >= compact.length - REPEAT_WINDOW_CHARS) return null

  let hits = 0
  let searchIndex = 0
  while (true) {
    const found = compact.indexOf(tail, searchIndex)
    if (found === -1) break
    hits += 1
    if (hits >= REPEAT_HIT_LIMIT) {
      return sourceIndexFromCompactIndex(normalized, first + REPEAT_WINDOW_CHARS)
    }
    searchIndex = found + Math.max(1, tail.length)
  }
  return null
}

function sourceIndexFromCompactIndex(content: string, compactIndex: number): number {
  let seen = 0
  for (let index = 0; index < content.length; index += 1) {
    if (/\s/.test(content[index])) continue
    seen += 1
    if (seen >= compactIndex) return index + 1
  }
  return content.length
}

function formatContextThinking(input: DeepChapterGenerationInput, pack: ContextPack): string {
  const recentSummaries = Array.isArray(pack.recentSummaries) ? pack.recentSummaries : []
  const goldenThreeHints = resolveGoldenThreeThinkingHints(input.goldenThreeChapter)
  return formatStageThinking(
    "阶段1：上下文分析",
    [
      ...goldenThreeHints,
      input.chapterNumber ? `目标章节：第${input.chapterNumber}章` : "目标章节：从用户请求中识别",
      `章节目标：${fallback(pack.chapterGoal, "未读取到明确章节目标")}`,
      `上一章结尾：${fallback(pack.previousChapterEnding, "未读取到上一章结尾")}`,
      `近期剧情：${recentSummaries.length} 条`,
      `人物状态：${summaryText(pack.characterStates)}`,
      `伏笔状态：${summaryText(pack.foreshadowingStates)}`,
      `时间线：${summaryText(pack.timeline)}`,
      `禁止违背：${fallback(pack.mustAvoid, "暂无明确禁止项")}`,
      `必须完成：${fallback(pack.mustDo, "暂无明确必做项")}`,
    ].join("\n"),
  )
}

function formatReviewThinking(reviewResults: NovelReviewResult[]): string {
  if (reviewResults.length === 0) {
    return formatStageThinking("阶段4：AI审稿", "未发现阻断问题。")
  }
  const characterIssues = reviewResults.filter((item) => item.type === "character_consistency")
  const otherIssues = reviewResults.filter((item) => item.type !== "character_consistency")
  const errorCount = reviewResults.filter((item) => item.severity === "error").length
  const sections: string[] = [
    `发现 ${reviewResults.length} 个问题，其中阻断问题 ${errorCount} 个。`,
  ]

  // 角色命中记忆库报告（单独展示 character_consistency 类型的问题）
  if (characterIssues.length > 0) {
    sections.push("")
    sections.push("【角色命中记忆库报告】")
    sections.push(formatReviewIssueList(characterIssues))
  }

  // 其他问题
  if (otherIssues.length > 0) {
    sections.push("")
    sections.push("【其他审查问题】")
    sections.push(formatReviewIssueList(otherIssues))
  }

  return formatStageThinking("阶段4：AI审稿", sections.join("\n"))
}

function formatStageThinking(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}

function formatReviewIssueList(reviewResults: NovelReviewResult[]): string {
  return reviewResults
    .map((item, index) => [
      `${index + 1}. [${severityLabel(item.severity)}] ${item.message}`,
      item.evidence ? `   - 证据：${item.evidence}` : "",
      item.relatedMemory ? `   - 相关记忆：${item.relatedMemory}` : "",
      item.suggestion ? `   - 建议：${item.suggestion}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n")
}

function fallback(value: string | null | undefined, fallbackText: string): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimForThinking(trimmed, 180) : fallbackText
}

function summaryText(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimForThinking(trimmed, 140) : "暂无"
}

function trimForThinking(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...`
}

function severityLabel(severity: NovelReviewResult["severity"]): string {
  if (severity === "error") return "严重"
  if (severity === "warning") return "提醒"
  return "信息"
}

function resolveGoldenThreeThinkingHints(goldenThreeChapter?: GoldenThreeChapterRequest): string[] {
  if (!goldenThreeChapter?.enabled || !goldenThreeChapter.targetChapter) return []
  if (goldenThreeChapter.outputMode === "first_chapter_with_directions") {
    return [
      "黄金三章：已启用",
      "执行策略：当前按黄金三章规则生成第1章正文，并在正文后给出第2章、第3章写作方向。",
    ]
  }
  return [
    "黄金三章：已启用",
    `执行策略：当前按黄金三章规则生成第${goldenThreeChapter.targetChapter}章正文。`,
  ]
}


async function safeBuildChapterContextPack(
  deps: DeepChapterGenerationDeps,
  projectPath: string,
  userRequest: string,
  chapterNumber?: number,
): Promise<ContextPack> {
  try {
    return await deps.buildContextPack(projectPath, userRequest, chapterNumber)
  } catch {
    return {
      task: userRequest,
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
    }
  }
}
