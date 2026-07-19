import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, isRequestCancelledError, isTransportInactivityError, setMetricsFilePath, setMetricsTraceId, flushMetrics, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { setLogTraceId, logger } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import { buildContextPack, contextPackToPrompt, type ContextPack } from "./context-engine"
import { loadEmotionLedger, checkEmotionCircuitBreaker } from "./emotion-ledger"
import {
  scoreCandidate,
  detectRegression,
  type CandidateVersion,
} from "./candidate-selector"
import { reviewChapter, type NovelReviewResult } from "./review-adapter"
import {
  dimensionResultsToReviewResults,
  runSixDimensionReview,
  type SixReviewDimensionKey,
  type DimensionReviewResult,
} from "./dimension-review-adapter"
import type { TaskRouteResult } from "./task-router"
import { formatStageThinking } from "./chapter-utils"
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
import {
  runSceneBreakdown,
  persistSceneBreakdownDraft,
  type SceneBreakdownResult,
} from "./scene-breakdown"
import {
  appendStageMetric,
} from "./novel-session-status"
import {
  appendRewriteRateASample,
} from "./character-cognition"
import {
  runContinuityEngine,
  summarizeContinuityFindings,
  type ContinuityInput,
  type ContinuityFinding,
} from "./deterministic-continuity-engine"
import { collectContinuityMetric } from "@/lib/llm-client"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadSubplotBoard } from "./subplot-board"
import { loadCharacterStates } from "./character-state"

export interface DeepChapterGenerationInput {
  projectPath: string
  userRequest: string
  chapterNumber?: number
  goldenThreeChapter?: GoldenThreeChapterRequest
  dismantlingReferenceDirective?: string
  llmConfig: LlmConfig
  resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
  /**
   * ISS-20260709-042: novelConfig injected by caller (chat-panel) rather than
   * read via useWikiStore.getState() inside the generator. Deep-chapter is a
   * lib module and must not reach into the React/zustand store directly
   * (same pattern as ISS-033 context-engine fix). Freezing the config at
   * generation-start is intentional — a single generation run applies a
   * consistent config snapshot rather than reading mid-run config mutations.
   * Type is NovelConfig (store state declares it non-optional, default
   * DEFAULT_NOVEL_CONFIG), so callers always supply a concrete value.
   */
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"]
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
  | "after_scene_breakdown"
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
// F-4/F-12: throttle onUpdate so it does not pass the entire growing content /
// reasoningBuffer string to the caller on every single token. Without this,
// each token triggers an O(content-length) callback (formatStageThinking trims
// + slices + UI state write), making streaming O(N²) in draft length under
// --include-partial-messages where every token is a separate event. Flush only
// when at least this many new chars have accumulated; a final flush is always
// emitted before collectModelText returns so the caller never sees a stale
// truncated view on completion / cutoff / partial-preserve.
const ONUPDATE_FLUSH_CHARS = 256
// CORR-101 (documented constraint): findRepeatedTailStart detects a 3x-repeated
// loop ONLY when the repeated block's period is a divisor of REPEAT_WINDOW_CHARS
// (120) — it anchors on the last 120 chars of the compacted draft and counts
// exact 120-char matches. A loop whose unique-cycle length is not a 120-divisor
// (e.g. a 180-char cycle repeated 3x) is silently missed because its last-120
// window differs from the first cycle's last-120 window. This is a known
// precision limitation of the tail-anchored detector, not a bug. Sliding
// multiple window sizes (40/80/120) or a suffix-array approach would widen
// coverage but risks false positives on legitimate prose; deferred.
const MAX_GATE_RETRY = 3
// A19 emotion-ledger pilot: 情绪债务熔断阈值。任一角色 netValue 低于此值即触发
// Circuit Breaker (长期承压, ADR-17 fix-loop 配套)。-0.6 选自 NovelForge-v5
// EmotionTracker 经验值: 三轴负偏 + history 负累积达此深度时角色状态已不可逆。
const EMOTION_CB_THRESHOLD = -0.6
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
  "consistency_mechanical",
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
  // CORR-108 fix (ADR-17 priority: Consistency > Anti-AI > Quality): a
  // Quality-gate FAILURE must still produce overall='fail', even when the
  // Anti-AI gate has only a warning. The prior ternary chain checked the
  // anti_ai/quality warning branch BEFORE the quality.status==='failed'
  // branch, so an Anti-AI warning demoted a Quality failure to 'warning'.
  // Group all status==='failed' checks first (any failed gate → 'fail'),
  // then warnings, then pass. collectBlockingIssues still fires the repair
  // loop either way; this only corrects the reported overall verdict.
  // F-18: manual_review requires at least one failed gate (matches the
  // createGate verdict at :297 which also gates on hasError). The prior
  // `manualReviewRequired ? "manual_review"` branch could mark overall as
  // manual_review with all gates passed when an external caller passed
  // manualReviewRequired=true with empty reviewResults — a semantic
  // contradiction for this exported pure function. In the live call chain
  // manualReviewRequired=true only happens at MAX_GATE_RETRY (which guarantees
  // a failed gate), so this is a robustness guard, not a behavior change.
  const anyFailed = gates.consistency.status === "failed"
    || gates.anti_ai.status === "failed"
    || gates.quality.status === "failed"
  gates.overall = manualReviewRequired && anyFailed
    ? "manual_review"
    : anyFailed
      ? "fail"
      : gates.consistency.verdict === "warning"
          || gates.anti_ai.verdict === "warning"
          || gates.quality.verdict === "warning"
        ? "warning"
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
    "after_scene_breakdown",
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

  // F-21a (PAT-G2 mirror of uniqueSuggestions :271): Set-based dedup instead
  // of deduped.includes (which is O(n) per segment → O(n²) overall). Dedup is
  // keyed on the raw segment to match the prior .includes semantics (the
  // pushed value is the trimmed segment, but the dedup key stays raw).
  const deduped: string[] = []
  const dedupedSet = new Set<string>()
  for (const segment of preferredSegments) {
    if (dedupedSet.has(segment)) continue
    dedupedSet.add(segment)
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

/**
 * ARCH-001 (ISS-20260708-005): single review helper called at all 3 review
 * points (stage-4 initial, stage-5.5 resume-after-revision, stage-5
 * post-repair). Runs reviewChapter + the F-003 6-dimension review + the
 * dimension-flatten merge in one place, so the 6-dim wiring that previously
 * lived only at stage-4 (causing copy-paste drift) now fires on revised
 * content too. The 6-dim block is best-effort: a failure MUST NOT break the
 * main review flow (preserved from the original stage-4 pattern).
 *
 * The helper does NOT call buildDecisionGates — callers do, because the 3
 * sites differ in retryCount / manualReviewRequired.
 *
 * Returns `{ reviewResults, dimensionResults }` so callers can checkpoint
 * dimensionResults (the raw 6-dim map) alongside the flattened reviewResults.
 */
export async function runFullReviewWithSixDim(
  content: string,
  chapterNumber: number | undefined,
  projectPath: string,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  contextPack: ContextPack,
  callbacks: DeepChapterGenerationCallbacks,
): Promise<{
  reviewResults: NovelReviewResult[]
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
}> {
  // (a) reviewChapter — signal-aware ternary (both branches must stay or
  // non-signal callers break). Matches the original stage-4 call shape.
  let reviewResults: NovelReviewResult[]
  // PERF-NEW-06: reviewChapter and runSixDimensionReview have NO data
  // dependency between them — launch both concurrently. reviewChapter keeps
  // its rethrow-on-failure semantics (await it first so its error surfaces
  // before the non-blocking 6-dim result is merged), while runSixDim runs
  // in parallel and is merged only after reviewChapter resolves.
  const runSixDim = deps.runSixDimensionReview
  // ISS-20260709-049: own a local AbortController for the 6-dim review so a
  // reviewChapter throw can cascade-abort the orphan 6-dim LLM stream instead
  // of letting it run to its 120s timeout. The external `signal` (caller-side
  // cancel / user abort) is merged in via combineAbortSignals so it propagates
  // to 6-dim too — but we cannot abort the external signal ourselves, so the
  // local controller is the only handle we hold for orphan cancellation.
  const sixDimController = new AbortController()
  const sixDimSignal = combineAbortSignals(signal, sixDimController.signal)
  const sixDimP: Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> | { __sixDimError: unknown } | undefined> = runSixDim
    ? runSixDim({ projectPath, chapterContent: content, chapterNumber, signal: sixDimSignal })
        .then((res) => res as Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>)
        .catch((err: unknown) => {
          // Non-blocking: capture the original error so the gap log can print
          // the real Error object (matches the prior console.error shape).
          // Re-throws are NOT propagated (preserves 6-dim-non-blocking contract).
          return { __sixDimError: err }
        })
    : Promise.resolve(undefined)
  try {
    reviewResults = signal
      ? await deps.reviewChapter(projectPath, content, chapterNumber, { onThinking: callbacks.onThinking, contextPack }, signal)
      : await deps.reviewChapter(projectPath, content, chapterNumber, { onThinking: callbacks.onThinking, contextPack })
  } catch (err) {
    // (b) log + rethrow (matches the original stage-4 ~1042-1044 pattern).
    // The 3 call sites previously each had their own try/catch with slightly
    // different log messages; consolidating into the helper eliminates that
    // copy-paste drift along with the 6-dim block.
    // F-16 (CWE-532): log only the message, not the full error object — streamChat
    // errors may carry provider request details (URL/headers) that should not
    // reach the app's stderr. Matches the :778 six-dim error-message extraction.
    logger.error("Deep Chapter", "Review failed", { error: err instanceof Error ? err.message : String(err) })
    // F-1 (orphan 6-dim process): when reviewChapter throws, the `await
    // sixDimP` at the coalesce step below is unreachable, so the 6-dim review
    // launched in parallel would keep running as an orphan background LLM
    // stream (up to 6 dimensions × stream timeout). ISS-20260709-049: now
    // that runSixDimensionReview accepts an AbortSignal, abort the local
    // sixDimController to cascade-cancel the in-flight 6-dim LLM streams,
    // reclaiming the orphaned token/quota. sixDimP already has a .catch above
    // so the abort surfaces as a non-blocking __sixDimError (discarded: the
    // coalesce step is unreachable on this path, and reviewChapter's failure
    // already fails the whole review). Attach a terminal .catch so the orphan
    // is explicitly owned (never becomes an unhandled rejection if the .catch
    // above is ever changed). The external signal is NOT aborted — only the
    // local controller, so the caller's cancel semantics are untouched.
    if (runSixDim) {
      sixDimController.abort()
      void sixDimP.catch(() => {})
      logger.warn("Deep Chapter", "6-dimension review aborted after reviewChapter failure (ISS-20260709-049 cascade-cancel).")
    }
    throw err
  }
  // (c) coalesce — reviewChapter may return null/undefined.
  reviewResults = reviewResults || []
  // (c)+(d) F-003 6-dim block: non-blocking. A 6-dim failure must not break
  // the main review flow.
  let dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {}
  const sixDimOutcome = await sixDimP
  if (sixDimOutcome && typeof sixDimOutcome === "object" && "__sixDimError" in sixDimOutcome) {
    // CORR-109 (IC-02 contract): record the gap. The prior catch only logged
    // and left dimensionResults={}, so a chapter whose 6-dim review threw was
    // indistinguishable downstream from one where 6-dim passed clean (the
    // F-003/ARCH-001 "6-dim orphan" silently recurred). Push an info-severity
    // NovelReviewResult so status.json / ContextGap consumers can see the 6-dim
    // review was skipped, not clean. Non-blocking preserved (info, not error).
    const sixDimErr = sixDimOutcome.__sixDimError
    const errMsg = sixDimErr instanceof Error ? sixDimErr.message : String(sixDimErr)
    // F-16 (CWE-532): message-only to avoid leaking provider request details.
    logger.error("Deep Chapter", "6-dimension review failed (non-blocking)", { error: errMsg })
    reviewResults = [
      ...reviewResults,
      {
        severity: "info",
        type: "quality",
        message: `[6-dim review unavailable: ${errMsg}]`,
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ]
  } else if (sixDimOutcome) {
    dimensionResults = sixDimOutcome
    if (Object.keys(dimensionResults).length > 0) {
      reviewResults = [
        ...reviewResults,
        ...dimensionResultsToReviewResults(dimensionResults),
      ]
    }
  }
  return { reviewResults, dimensionResults }
}

/**
 * TASK-007: 确定性连续性引擎生成层预检 (grill GRL-011 Decision 1.3 bullet 模式)。
 *
 * 薄包装: load foreshadowing-tracker / subplot-board / character-states 结构化
 * store (幂等 try/catch 降级, 缺失/损坏返回空数组非致命), 组装 ContinuityInput,
 * 调 runContinuityEngine 纯函数拿 ContinuityFinding[]。过滤 critical+high 且排除
 * data_gap (Decision 1.3 bullet 只注入提醒级 findings, 不阻断生成守 Draft-first 三
 * 大硬约束 #2; data_gap 是 info 级标注非一致性问题不注入生成层)。文本化为简短
 * bullet list 注入任务书 prompt 末尾 (非长文, 守 context 预算)。空则返回 "" 不污染
 * prompt (空守卫)。try/catch 降级: 引擎或 store 读取失败返回 "" 不阻断草稿生成
 * (生成层绝不阻断, 阻断职责归审查层 TASK-008)。
 *
 * snapshots 传空数组: 预检轻量化, 不全量 load snapshots (O(C) 读盘开销大)。
 * 引擎 checkDormantThreads 优先读 subplot.lastSeenChapter 落盘值 (writehook 增量
 * 更新), 仅 undefined 时 fold 反推需 snapshots——此时 deriveSubplotLastSeenChapter
 * 返回 undefined, 引擎产 data_gap (info) 标注缺数据, 不阻断。其余 3 项检测
 * (absent_character/overdue_threads/dead_character_state) 不依赖 snapshots。
 */
async function runContinuityPreCheck(
  projectPath: string,
  currentChapter: number | undefined,
): Promise<string> {
  const startMs = Date.now()
  try {
    const chapterNum = currentChapter ?? 0
    const [foreshadowingStore, subplotStore, characterStore] = await Promise.all([
      loadForeshadowingTracker(projectPath).catch(() => ({ items: [], lastUpdated: "" })),
      loadSubplotBoard(projectPath).catch(() => ({ items: [], lastUpdated: "" })),
      loadCharacterStates(projectPath).catch(() => ({ characters: [], lastUpdated: "" })),
    ])
    const continuityInput: ContinuityInput = {
      foreshadowing: foreshadowingStore.items,
      subplots: subplotStore.items,
      characters: characterStore.characters,
      snapshots: [],
      currentChapter: chapterNum,
    }
    const findings: ContinuityFinding[] = runContinuityEngine(continuityInput)
    const summary = summarizeContinuityFindings(findings)
    // ADR-30: 3 级 severity (critical/warning/info) — blueprint 对齐 (非 4 级无 high)。
    // 生成层预检注入 critical+warning 提醒级 (非阻断守 Draft-first)。
    // warning 级 = dormant_thread/absent_character/unresolved_foreshadowing (3 级方案)。
    // data_gap (info) 不注入 (仅可见标注)。
    const injected = findings.filter(
      (f) => (f.severity === "critical" || f.severity === "warning") && f.subtype !== "data_gap" && f.type !== "data_gap",
    )
    // TASK-010 (Decision 7.2): continuity 观测层 metric — 生成层预检 gate=consistency,
    // 只记 count+ms (CWE-532)。short_circuit_hits=0 (预检非阻断不短路 LLM)。
    // high_count=0 (3 级方案无 high, dormant/absent/unresolved 归 warning)。
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: summary.critical,
      high_count: 0,
      warning_count: summary.warning,
      data_gap_count: summary.data_gap,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 0,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    if (injected.length === 0) return ""
    const bullets = injected
      .map((f) => `- [${f.severity}] ${f.ref}: ${f.message}`)
      .join("\n")
    return `\n\n[连续性预检提醒]\n${bullets}\n`
  } catch (err) {
    logger.warn("continuity-engine", "precheck degraded: " + (err as Error).message)
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: 0,
      high_count: 0,
      warning_count: 0,
      data_gap_count: 0,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 1,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    return ""
  }
}

/**
 * TASK-009: 确定性连续性引擎机械 critical 检测 (grill GRL-011 Decision 3.1 +
 * ADR-17 Q4 机械 critical 不进 fix-loop LLM 重写)。
 *
 * 薄包装: load foreshadowing-tracker / subplot-board / character-states store
 * (幂等 try/catch 降级), 组装 ContinuityInput, 调 runContinuityEngine 纯函数拿
 * findings, 检查是否存在 severity==='critical' 且 subtype==='consistency_mechanical'
 * 的 finding (dead_character_state / overdue_thread; 两者 type 不同但 subtype 都是
 * consistency_mechanical)。用 subtype 而非 type 判定 (ContinuityFinding.subtype 字段
 * 是 consistency_mechanical 标记)。有则返回 {tripped:true, reason: 模板化摘要 (critical
 * findings 的 ref+type 列表, 不引用正文守 CWE-532)}; 无则 {tripped:false, reason:''}。
 * 该分流走 emotion-ledger Circuit Breaker 同款 manualHandoff 路径 (Decision 3.1 复用
 * 不新建独立 audit)。调用点在 fix-loop LLM 重写分支前, 通过 manualHandoff 提前返回
 * 绕过 max_retry=3 LLM 重写 (守 ADR-17)。
 */
async function checkContinuityCritical(
  projectPath: string,
  currentChapter: number | undefined,
): Promise<{ tripped: boolean; reason: string }> {
  const startMs = Date.now()
  try {
    const chapterNum = currentChapter ?? 0
    const [foreshadowingStore, subplotStore, characterStore] = await Promise.all([
      loadForeshadowingTracker(projectPath).catch(() => ({ items: [], lastUpdated: "" })),
      loadSubplotBoard(projectPath).catch(() => ({ items: [], lastUpdated: "" })),
      loadCharacterStates(projectPath).catch(() => ({ characters: [], lastUpdated: "" })),
    ])
    const continuityInput: ContinuityInput = {
      foreshadowing: foreshadowingStore.items,
      subplots: subplotStore.items,
      characters: characterStore.characters,
      snapshots: [],
      currentChapter: chapterNum,
    }
    const findings: ContinuityFinding[] = runContinuityEngine(continuityInput)
    const summary = summarizeContinuityFindings(findings)
    const critical = findings.filter(
      (f) => f.severity === "critical" && f.subtype === "consistency_mechanical",
    )
    // TASK-010 (Decision 7.2): critical 分流 metric — short_circuit_hits=tripped 数
    // (机械 critical 短路 LLM fix-loop, 走 manualHandoff 非 LLM 重写)。
    // high_count=0 (3 级方案无 high, ADR-30 blueprint 对齐)。
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: summary.critical,
      high_count: 0,
      warning_count: summary.warning,
      data_gap_count: summary.data_gap,
      overrides_hit: 0,
      short_circuit_hits: critical.length,
      engine_error_count: 0,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    if (critical.length === 0) {
      return { tripped: false, reason: "" }
    }
    const list = critical
      .map((f) => `${f.ref}(${f.type})`)
      .join(", ")
    return {
      tripped: true,
      reason: `连续性机械 critical: ${list} (死亡角色活跃态/伏笔逾期未回收, 走人工处理避免 fix-loop LLM 重写加深不一致)`,
    }
  } catch (err) {
    logger.warn("continuity-engine", "critical check degraded: " + (err as Error).message)
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: 0,
      high_count: 0,
      warning_count: 0,
      data_gap_count: 0,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 1,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    return { tripped: false, reason: "" }
  }
}

export async function runDeepChapterGeneration(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps: DeepChapterGenerationDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<DeepChapterGenerationResult> {
  assertNotAborted(signal)
  // ISS-20260709-019/020: configure the observability sinks for this run.
  // setMetricsFilePath enables LLM metrics buffering (collectLLMMetric in
  // streamChat); setMetricsTraceId + setLogTraceId stamp every metric/log
  // line with this run's id so post-hoc diagnosis can correlate them. The
  // auto-flush safety valve in collectLLMMetric persists at 500 records;
  // an explicit run-end flushMetrics() is the follow-up (ISS-20260714-002).
  const metricsFile = `${input.projectPath.replace(/\\/g, "/")}/.novel/metrics.jsonl`
  setMetricsFilePath(metricsFile)
  const runTraceId = `ch${input.chapterNumber ?? "?"}`
  setMetricsTraceId(runTraceId)
  setLogTraceId(runTraceId)
  // Tracks whether any collectModelText stage took the transport-inactivity
  // partial-preserve branch. The first partial reason wins; later stages
  // (expansion/polish) keep the flag set so the caller routes the result to the
  // pause / continue-unfinished path instead of completeDeepChapterSession.
  let partialReason: string | null = null
  const notePartial = (reason: string) => {
    if (partialReason === null) partialReason = reason
  }
  // CORR-107: a subsequent full successful generation supersedes an earlier
  // transport-inactivity partial — clear it so a recovered draft is not
  // falsely marked partial (which would route it to pause instead of complete).
  const clearPartial = () => {
    partialReason = null
  }
  const resumeCheckpoint = input.resumeCheckpoint
  const writingConfig = resolveWritingConfig(input.llmConfig)
  const novelConfig = input.novelConfig
  const lengthSpec = resolveCurrentChapterLengthSpec(novelConfig)

  // 阶段0：前情分析
  const previousChaptersAnalysis = await runPreviousChaptersAnalysis(
    input, writingConfig, novelConfig, resumeCheckpoint, callbacks, signal,
  )
  assertNotAborted(signal)

  // 阶段1：上下文装配
  const { loadSmartDeAiSkill } = await import("./de-ai-adapter")
  const ctx1 = await assembleContext(
    deps, input, callbacks, resumeCheckpoint, signal, previousChaptersAnalysis, loadSmartDeAiSkill,
  )
  const { contextPack, customDeAiSkill, outlinePrompt, contextPrompt: rawContextPrompt, cachePrefix } = ctx1
  assertNotAborted(signal)

  // TASK-007: 确定性连续性引擎生成层预检 (grill GRL-011 Decision 1.3 bullet 模式)。
  // 非阻断: 只产提醒级 bullet 文本拼入任务书 prompt 末尾, 不阻止 generateDraft。
  // 空守卫: 预检返回 "" 时 contextPrompt 不变 (不污染 prompt)。阻断职责归审查层
  // (TASK-008)。logger 双参 scope='continuity-engine'。
  const continuityPreCheckText = await runContinuityPreCheck(input.projectPath, input.chapterNumber)
  const contextPrompt = continuityPreCheckText ? rawContextPrompt + continuityPreCheckText : rawContextPrompt
  assertNotAborted(signal)

  // 阶段1.5：场景拆解
  await runSceneBreakdownStage(
    input, novelConfig, resumeCheckpoint, contextPack, callbacks, signal, notePartial,
  )
  assertNotAborted(signal)

  // 阶段2 + 2.5：任务书生成 + 纠偏
  const taskBrief = await generateTaskBrief(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, contextPrompt, lengthSpec, resumeCheckpoint, contextPack, cachePrefix,
  )
  assertNotAborted(signal)

  // 阶段3 + 3.5：正文初稿 + 草稿纠偏
  const draftContent = await generateDraft(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, contextPrompt, taskBrief, lengthSpec, resumeCheckpoint, cachePrefix,
    notePartial, clearPartial,
  )
  assertNotAborted(signal)

  // 阶段4-5：AI 审稿 + 返修循环
  const stage45 = await runReviewAndRepair(
    input, novelConfig, deps, signal, callbacks,
    contextPack, draftContent, resumeCheckpoint,
    writingConfig, outlinePrompt, contextPrompt, taskBrief, lengthSpec, cachePrefix, notePartial,
  )
  // MAX_GATE_RETRY 转人工：原内联此处 callbacks.onFinalContent + 完整 return。
  // 提取后在编排器层构造 result（能访问 partialReason，partial 语义绝对正确）。
  if (stage45.manualHandoff) {
    callbacks.onFinalContent?.(stage45.currentContent)
    return {
      finalContent: stage45.currentContent,
      taskBrief,
      draftContent,
      reviewResults: stage45.reviewResults,
      revised: stage45.revised,
      decisionGates: stage45.decisionGates,
      manualReviewRequired: true,
      retryCount: stage45.retryCount,
      partial: partialReason !== null,
      partialReason,
    }
  }
  assertNotAborted(signal)

  // 阶段7：简单审查与去AI味
  const finalContent = await finalPolishChapter(
    writingConfig,
    outlinePrompt,
    contextPrompt,
    taskBrief,
    stage45.currentContent,
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
    stage45.revised
      ? "采用返修并完成简单审查、去AI味后的正文作为最终正文。"
      : "未发现阻断问题，已完成最后一遍简单审查与去AI味。",
  ))
  callbacks.onFinalContent?.(finalContent)
  // ISS-20260714-002: explicit run-end flush of buffered LLM metrics. Fire-
  // and-forget (void) — the run is done, metrics persist async after return.
  // Abort/throw paths rely on the collectLLMMetric auto-flush safety valve
  // (buffer≥500) since this line is unreachable on a throw.
  void flushMetrics()
  return {
    finalContent,
    taskBrief,
    draftContent,
    reviewResults: stage45.reviewResults,
    revised: stage45.revised,
    decisionGates: stage45.decisionGates,
    manualReviewRequired: false,
    retryCount: stage45.retryCount,
    partial: partialReason !== null,
    partialReason,
  }
}

// ───────────────────────────────────────────────────────────────────
// 阶段函数（ISS-20260712-MAINT-1 拆分）
// 每个函数对应 runDeepChapterGeneration 的一个自然边界阶段。
// 扁平参数 + 返回阶段产出，遵循既有 finalPolishChapter 模式。
// 编排器持有可变累积状态，阶段函数只读入参 / 返回新值。
// ───────────────────────────────────────────────────────────────────

// 阶段0：前情分析（仅当章节号>1，且设置开启时；记忆库的近期摘要与上一章结尾仍会注入）
async function runPreviousChaptersAnalysis(
  input: DeepChapterGenerationInput,
  writingConfig: LlmConfig,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  signal?: AbortSignal,
): Promise<string> {
  if (!(input.chapterNumber && input.chapterNumber > 1 && !resumeCheckpoint && novelConfig.deepPreviousChaptersAnalysis)) {
    return ""
  }
  callbacks.onThinking?.(formatStageThinking("阶段0：前情分析", "正在读取并分析前3章完整内容..."))
  const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
  let previousChaptersAnalysis = ""
  try {
    previousChaptersAnalysis = await analyzePreviousChapters(
      input.projectPath,
      input.chapterNumber,
      writingConfig,
      3,
      signal,
    )
    if (previousChaptersAnalysis) {
      callbacks.onThinking?.(formatStageThinking(
        "阶段0：前情分析",
        `已完成前情分析（${previousChaptersAnalysis.length}字）\n\n${previousChaptersAnalysis.slice(0, 500)}...`
      ))
    }
  } catch (error) {
    // F-16 (CWE-532): message-only to avoid leaking provider request details.
    logger.error("deep-chapter-generation", "前情分析失败", { error: error instanceof Error ? error.message : String(error) })
  }
  return previousChaptersAnalysis
}

// 阶段1：上下文装配（contextPack + 智能skill + 大纲提取 + 社区摘要 + cachePrefix）
// 返回阶段产出的全部上下文对象；customDeAiSkill 经返回值回传给编排器。
interface AssembledContext {
  contextPack: ContextPack
  customDeAiSkill: string | null
  outlinePrompt: string
  communitySummaryInjection: string
  contextPrompt: string
  cachePrefix: string
}

async function assembleContext(
  deps: DeepChapterGenerationDeps,
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  signal: AbortSignal | undefined,
  previousChaptersAnalysis: string,
  loadSmartDeAiSkill: (projectPath: string, userRequest: string, contextPack: ContextPack) => Promise<string | null>,
): Promise<AssembledContext> {
  const contextPack = await safeBuildChapterContextPack(
    deps,
    input.projectPath,
    input.userRequest,
    input.chapterNumber,
  )
  assertNotAborted(signal)

  // 阶段1后：加载智能skill（传递contextPack用于场景检测）
  const customDeAiSkill = await loadSmartDeAiSkill(input.projectPath, input.userRequest, contextPack)

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

  // TASK-003 (ANL-013 S4): pre-generation community-summary generate side.
  // After context assembly, before prose generation: generate (or reuse the
  // cached) narrative summaries for the communities most relevant to the
  // current chapter's task tokens, and inject them into the compressible
  // context tier. This closes the previously-orphaned generate side — only
  // the retrieval side (`searchCommunitySummaries` via graphSearchResults)
  // was wired before. `generateCommunitySummariesForChapter` is the per-chapter
  // lazy-cached entry point; it internally calls `generateSingleCommunitySummary`
  // (community-summary.ts) for each relevant community. Best-effort: failure
  // returns "" and does not block.
  let communitySummaryInjection = ""
  try {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    communitySummaryInjection = await generateCommunitySummariesForChapter(
      input.projectPath,
      input.userRequest,
      input.chapterNumber,
      input.llmConfig,
    )
  } catch (err) {
    // F-16 (CWE-532): message-only.
    logger.warn("Deep Chapter", "社区摘要生成失败（非阻断）", { error: err instanceof Error ? err.message : String(err) })
  }

  // 其他上下文可以进行token预算管理，但大纲已被排除
  const contextPrompt = [
    previousChaptersAnalysis ? `## 前情分析\n\n${previousChaptersAnalysis}` : "",
    deps.contextPackToPrompt(contextPack, 32000, { excludeOutline: true }),
    communitySummaryInjection ? `## 相关社区摘要\n\n${communitySummaryInjection}` : "",
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

  return { contextPack, customDeAiSkill, outlinePrompt, communitySummaryInjection, contextPrompt, cachePrefix }
}

// 阶段1.5：Scene Breakdown（ADR-30 / EPIC-002 / TASK-012）。
// 仅当 sceneBreakdownEnabled 开启时，在 contextPack（阶段 1）之后、task_brief
// （阶段 2）之前插入单次 LLM 调用，把章节蓝图拆成 3-8 个连续场景，持久化到
// .novel/chapters/{n}/scenes.pending.json（Draft-first pending，ADR-08），并通过
// ADR-31 工厂 buildNextStatus 写回 status.json evidence_refs（HARD-1 真源不变）。
// 向后兼容（ADR-30）：flag=false 时跳过整段，after_task_brief 恢复序不变。
// resume 时若已过 after_scene_breakdown 也跳过（避免重复拆解已 checkpoint 的章节）。
async function runSceneBreakdownStage(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  contextPack: ContextPack,
  callbacks: DeepChapterGenerationCallbacks,
  signal: AbortSignal | undefined,
  notePartial: (reason: string) => void,
): Promise<void> {
  if (
    !novelConfig.sceneBreakdownEnabled
    || resumeCheckpoint
    || checkpointStageAtLeast(resumeCheckpoint, "after_scene_breakdown")
  ) {
    return
  }
  callbacks.onThinking?.(formatStageThinking("阶段1.5：场景拆解", "正在根据章节蓝图拆解连续场景..."))
  const chapterId = String(input.chapterNumber ?? "")
  let sceneResult: SceneBreakdownResult | null = null
  try {
    // blueprint = 章节原始意图（userRequest）；buildSceneBreakdownPrompt 再补充
    // contextPack 的结构化字段（chapterGoal/outline/mustDo/mustAvoid/...）。
    sceneResult = await runSceneBreakdown(input.userRequest, contextPack, signal)
  } catch (error) {
    // F-16 (CWE-532): message-only. Scene breakdown 是加性中间层（ADR-30），
    // 失败不阻断主链——跳过阶段 1.5 继续到 task_brief（向后兼容降级）。
    logger.error("deep-chapter-generation", "场景拆解失败（非阻断，跳过阶段1.5）", { error: error instanceof Error ? error.message : String(error) })
  }
  assertNotAborted(signal)
  if (sceneResult && sceneResult.scenes.length > 0) {
    // 工厂持久化（ADR-31 硬先决）：persistSceneBreakdownDraft 内部用
    // buildNextStatus + persistCheckpointBase 写 status.json，非手动 const next 块。
    try {
      await persistSceneBreakdownDraft(input.projectPath, chapterId, sceneResult)
    } catch (error) {
      // 持久化失败不阻断主链（加性中间层），仅记日志。
      logger.error("deep-chapter-generation", "场景拆解持久化失败（非阻断）", { error: error instanceof Error ? error.message : String(error) })
    }
    // EPIC-002 / TASK-013 / Story 2.3: 阶段指标溯源写 status.json stage_metrics
    // （HARD-1 真源 additive optional 字段，非新真源）。sceneResult.tokenCost/
    // latencyMs/partial 从 runSceneBreakdown 单次 LLM 调用采集，O-201 成本经验
    // 决策可据。non-fatal — 指标采集失败不阻断主链。
    await appendStageMetric(input.projectPath, {
      stage: "scene_breakdown",
      tokenCost: sceneResult.tokenCost,
      latencyMs: sceneResult.latencyMs,
      partial: sceneResult.partial,
      chapterId,
      timestamp: new Date().toISOString(),
    })
    // spec S-444k typed signal 传播：sceneResult.partial 经 notePartial 进入
    // runDeepChapter 的 partialReason，最终 DeepChapterGenerationResult.partial=true
    // → chat-panel pauseDeepChapterSession（draft_status pending）而非
    // completeDeepChapterSession（ready），防 partial 误标 complete（Draft-first 边界）。
    // first-partial-reason-wins：仅当主链尚未记录 partial 时才记 scene 的 reason
    // （与 collectModelText 的 notePartial 语义一致，:852）。
    if (sceneResult.partial && sceneResult.partialReason) {
      notePartial(`scene-breakdown: ${sceneResult.partialReason}`)
    }
    callbacks.onThinking?.(formatStageThinking(
      "阶段1.5：场景拆解",
      `已完成场景拆解（${sceneResult.scenes.length}个场景${sceneResult.partial ? "，部分保留" : ""}）`,
    ))
  }
  await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_scene_breakdown"))
}

// 阶段2 + 2.5：任务书生成 + 纠偏（含 repair while 循环）。
// resume 时若检查点已有 taskBrief 则短路；否则模型生成，再按需 deterministic
// fallback 或循环纠偏，最终产出可执行 taskBrief。
async function generateTaskBrief(
  input: DeepChapterGenerationInput,
  writingConfig: LlmConfig,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  outlinePrompt: string,
  contextPrompt: string,
  lengthSpec: ChapterLengthSpec,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  contextPack: ContextPack,
  cachePrefix: string | undefined,
): Promise<string> {
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
  return taskBrief
}

// 阶段3 + 3.5：正文初稿（+ 长度不足时扩写补足）+ 草稿纠偏（meta 漂移时重写）。
// resume 时若检查点已有 draftContent 则短路。notePartial/clearPartial 闭包由
// 编排器传入，partial 状态机语义不变（first-partial-wins + 成功 clear）。
async function generateDraft(
  input: DeepChapterGenerationInput,
  writingConfig: LlmConfig,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  lengthSpec: ChapterLengthSpec,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  cachePrefix: string | undefined,
  notePartial: (reason: string) => void,
  clearPartial: () => void,
): Promise<string> {
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
        clearPartial,
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
        clearPartial,
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
  return draftContent
}

// 阶段4-5：AI 审稿 + 返修循环（含 MAX_GATE_RETRY 转人工）。
// 返回阶段产出 + manualHandoff 标志。manualHandoff=true 表示命中
// MAX_GATE_RETRY 转人工路径——编排器据此构造完整 result（含 partial 字段，
// 需访问编排器层 partialReason，故不在本函数内构造 earlyReturn）。
interface ReviewAndRepairResult {
  reviewResults: NovelReviewResult[]
  decisionGates: DeepChapterDecisionGates
  retryCount: number
  manualReviewRequired: boolean
  currentContent: string
  revised: boolean
  manualHandoff: boolean
}

async function runReviewAndRepair(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  contextPack: ContextPack,
  draftContent: string,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  writingConfig: LlmConfig,
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  lengthSpec: ChapterLengthSpec,
  cachePrefix: string | undefined,
  notePartial: (reason: string) => void,
): Promise<ReviewAndRepairResult> {
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
      // ARCH-001: reviewChapter + 6-dim review + merge live in the shared
      // review helper so the 3 review points stay structurally identical
      // (was copy-paste drift — only stage-4 had the 6-dim wiring, the 2
      // resume/repair paths silently skipped it).
      const stage4 = await runFullReviewWithSixDim(draftContent, input.chapterNumber, input.projectPath, deps, signal, contextPack, callbacks)
      reviewResults = stage4.reviewResults
      decisionGates = buildDecisionGates(reviewResults, retryCount)
      assertNotAborted(signal)
      callbacks.onThinking?.(formatReviewThinking(reviewResults))
      // EPIC-002 / TASK-013 / Story 2.3: rewrite 率 A/B 埋点（severity=error /
      // 总 findings）。variant 由 sceneBreakdownEnabled 决定（enabled 章节
      // 经历过阶段 1.5 scene 拆解，disabled 跳过）。每章首次完整 review 结果
      // 代表该章 rewrite 率，返修后复审不重复埋点避免样本污染。写 cognition-
      // state.json rewriteRateABuckets（HARD-1 守恒，非新真源）。non-fatal。
      const totalFindings = reviewResults.length
      const errorFindings = reviewResults.filter((item) => item.severity === "error").length
      const rewriteRate = totalFindings > 0 ? errorFindings / totalFindings : 0
      await appendRewriteRateASample(input.projectPath, {
        variant: novelConfig.sceneBreakdownEnabled ? "enabled" : "disabled",
        rewriteRate,
        chapterId: String(input.chapterNumber ?? ""),
        timestamp: new Date().toISOString(),
      })
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
        taskBrief,
        draftContent,
        reviewResults,
        dimensionResults: stage4.dimensionResults,
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
      // ARCH-001: the shared review helper now wires the 6-dim review here too
      // (was reviewChapter-only, silently skipping dimension findings on
      // resumed revised content). dimensionResults is checkpointed additively.
      const stage55 = await runFullReviewWithSixDim(currentContent, input.chapterNumber, input.projectPath, deps, signal, contextPack, callbacks)
      reviewResults = stage55.reviewResults
      decisionGates = buildDecisionGates(reviewResults, retryCount, manualReviewRequired)
      assertNotAborted(signal)
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
        taskBrief,
        draftContent,
        reviewResults,
        dimensionResults: stage55.dimensionResults,
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

  // A19 借鉴点 #4 (PLN-20260716-elo-fixloop-selection): fix-loop 候选退化检测。
  // currentContent=revisedContent 直接覆盖 (file:1752 原编排器) 无版本对比, 返修可能
  // 越改越差 (slop 上升)。prevCandidate 滑动窗口记前版机械 slop 分, 返修后 detectRegression
  // 退化时回退前版。零 LLM (scoreCandidate 复用 #1 slopScore)。最小侵入: 只加 candidate
  // 变量 + 退化分支, 不改 buildDeepChapterRevisionPrompt/collectModelText/MAX_GATE_RETRY
  // (守 MAINT-1 拆分结构)。首次进循环时 prevCandidate===null, 用当前 currentContent 初始化。
  let prevCandidate: CandidateVersion | null = null

  while (novelConfig.deepChapterReview && blockingIssues.length > 0) {
    // 借鉴点 #4 首次进循环: 用当前 currentContent (初稿/resume 版) 记前版候选。
    // 后续迭代由退化检测分支更新 (滑动窗口 2 版, DD-1)。
    if (prevCandidate === null) {
      prevCandidate = {
        content: currentContent,
        slopPenalty: scoreCandidate(currentContent),
        retryCount,
      }
    }
    // A19 emotion-ledger pilot Circuit Breaker (ADR-17 fix-loop 配套): 返修循环
    // 中若某角色情绪债务超阈值 (netValue < EMOTION_CB_THRESHOLD), 提前转人工而非
    // 继续返修——角色情绪已崩时继续重写只会加深不一致。最小侵入: 复用与
    // MAX_GATE_RETRY 相同的 manualHandoff 回传路径, 不扰动 MAINT-1 拆分结构。
    // 仅在已返修过 (retryCount > 0) 时检查, 避免首次 review 即误触发。零 LLM:
    // loadEmotionLedger 只读 store, checkEmotionCircuitBreaker 纯算术判定。
    if (retryCount > 0) {
      try {
        const emotionStore = await loadEmotionLedger(input.projectPath)
        const cb = checkEmotionCircuitBreaker(emotionStore, EMOTION_CB_THRESHOLD)
        if (cb.tripped) {
          manualReviewRequired = true
          decisionGates = buildDecisionGates(reviewResults, retryCount, true)
          callbacks.onThinking?.(formatStageThinking(
            "阶段5.5：情绪债务熔断转人工",
            [
              cb.reason,
              "",
              "角色情绪债务已达熔断阈值，继续自动返修将加深角色状态不一致，已转人工处理。",
              "",
              formatReviewIssueList(blockingIssues),
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
          return {
            reviewResults,
            decisionGates,
            retryCount,
            manualReviewRequired: true,
            currentContent,
            revised,
            manualHandoff: true,
          }
        }
      } catch {
        // emotion-ledger store 缺失/损坏 → 跳过熔断检查, 降级为原返修逻辑 (非致命)。
      }
    }

    // TASK-009: 确定性连续性引擎机械 critical 分流 (grill GRL-011 Decision 3.1 +
    // ADR-17 Q4)。复用 emotion-ledger Circuit Breaker 同款 manualHandoff 路径 (Decision
    // 3.1 复用不新建独立 audit)。机械 critical (dead_character_state / overdue_thread)
    // 不进 fix-loop LLM 重写——继续返修只会加深角色状态不一致/伏笔债务。调用点在
    // LLM 重写分支 (collectModelText buildDeepChapterRevisionPrompt) 前, 通过 manualHandoff
    // 提前返回绕过 max_retry=3。仅 retryCount > 0 时检查 (与 emotion CB 一致, 避免首次
    // review 即误触发; 首次 review 的 critical 已由 review-adapter 审查层处理)。零 LLM:
    // checkContinuityCritical 调 runContinuityEngine 纯函数。
    if (retryCount > 0) {
      const continuityCritical = await checkContinuityCritical(input.projectPath, input.chapterNumber)
      if (continuityCritical.tripped) {
        logger.warn("continuity-engine", "critical continuity findings, manual handoff: " + continuityCritical.reason)
        manualReviewRequired = true
        decisionGates = buildDecisionGates(reviewResults, retryCount, true)
        callbacks.onThinking?.(formatStageThinking(
          "阶段5.5：连续性机械 critical 转人工",
          [
            continuityCritical.reason,
            "",
            "检测到确定性连续性机械 critical (死亡角色活跃态/伏笔逾期未回收), 继续 LLM 重写将加深不一致, 已转人工处理。",
            "",
            formatReviewIssueList(blockingIssues),
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
        return {
          reviewResults,
          decisionGates,
          retryCount,
          manualReviewRequired: true,
          currentContent,
          revised,
          manualHandoff: true,
        }
      }
    }

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
      // 原编排器此处 callbacks.onFinalContent?.(currentContent) + 完整 return。
      // 提取后改为 manualHandoff 标志回传——编排器层据此构造完整 result（含
      // partial 字段，需访问编排器 partialReason，故不在本函数构造 earlyReturn）。
      return {
        reviewResults,
        decisionGates,
        retryCount,
        manualReviewRequired: true,
        currentContent,
        revised,
        manualHandoff: true,
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
    // 借鉴点 #4 退化检测: 返修后跑 detectRegression 比当前版 vs 前版 slop 分。
    // 退化 (当前版 slop 比前版高 +threshold) → 回退前版 (不采用更差返修), 但 retryCount
    // 仍 +1 (占一次重试额度防无限循环)。不退化 → 采用当前版 + 更新 prevCandidate (滑动窗口)。
    // 零 LLM (scoreCandidate/detectRegression 复用 #1 slopScore 纯算术)。
    const currCandidate: CandidateVersion = {
      content: revisedContent,
      slopPenalty: scoreCandidate(revisedContent),
      retryCount: nextRetryCount,
    }
    const selection = detectRegression(prevCandidate, currCandidate)
    if (selection.regressed) {
      currentContent = selection.keep.content
      callbacks.onThinking?.(formatStageThinking(
        "阶段5：返修退化回退",
        [selection.reason, "", "已回退前版草稿, retryCount 仍计数以防无限循环。"].join("\n"),
      ))
      // prevCandidate 保持不变 (前版仍是基准, 下一轮继续对比)
    } else {
      currentContent = revisedContent
      prevCandidate = currCandidate
    }
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
    // ARCH-001 (ISS-20260708-005): the post-repair re-review now runs the
    // 6-dim review too (was reviewChapter-only — dimension findings on
    // revised content never reached decision gates, causing quality-regression
    // blindness). dimensionResults checkpointed additively.
    const stage5 = await runFullReviewWithSixDim(currentContent, input.chapterNumber, input.projectPath, deps, signal, contextPack, callbacks)
    reviewResults = stage5.reviewResults
    // F-9: intentionally NOT passing manualReviewRequired here. The only path
    // that sets manualReviewRequired=true (retryCount >= MAX_GATE_RETRY at the
    // loop top) returns immediately, so reaching this post-repair gate rebuild
    // means the loop continued — a fresh re-evaluation against the revised
    // content, where manualReviewRequired must reset to false (its default).
    // The resume branches DO pass it because they restore the checkpointed
    // value (may already be true from a prior manual-handoff). The asymmetry
    // is deliberate: resume preserves prior manual state, fresh post-repair
    // re-evaluates from scratch. Changing the loop to no longer return at
    // MAX_GATE_RETRY would make this divergence a real bug — keep the early
    // return, or thread manualReviewRequired explicitly here too.
    decisionGates = buildDecisionGates(reviewResults, retryCount)
    blockingIssues = collectBlockingIssues(decisionGates)
    assertNotAborted(signal)
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
      taskBrief,
      draftContent,
      reviewResults,
      dimensionResults: stage5.dimensionResults,
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

  return {
    reviewResults,
    decisionGates,
    retryCount,
    manualReviewRequired,
    currentContent,
    revised,
    manualHandoff: false,
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

function resolveCurrentChapterLengthSpec(novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"]): ChapterLengthSpec {
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
  // CORR-107 fix: when this collectModelText call completes WITHOUT taking the
  // transport-inactivity partial-preserve branch (i.e. a full successful
  // generation), the caller clears any earlier partialReason set by a prior
  // stage — so a recovered draft (initial partial + successful expansion) is
  // not falsely marked partial. Without this, the 'first partial reason wins,
  // never cleared' policy produces false-positive partial flags on recovered
  // drafts, routing a complete chapter to pause instead of complete.
  onCompleteClearPartial?: () => void,
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
  // F-4/F-12: throttle onUpdate flushes. Track how much content/reasoning we
  // have already pushed so we only invoke onUpdate (which re-formats the whole
  // string on the caller side) when enough new chars accumulated. A final flush
  // before return / cutoff / partial-preserve guarantees the caller never ends
  // on a stale truncated view.
  let lastPushedContentLen = 0
  let lastPushedReasoningLen = 0
  const flushContent = () => {
    if (content.length > lastPushedContentLen) {
      lastPushedContentLen = content.length
      onUpdate?.(content)
    }
  }
  const flushReasoning = () => {
    if (!content && reasoningBuffer.length > lastPushedReasoningLen) {
      lastPushedReasoningLen = reasoningBuffer.length
      onUpdate?.(reasoningBuffer)
    }
  }
  const streamController = new AbortController()
  const combinedSignal = combineAbortSignals(signal, streamController.signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS))
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
            // Reset the flush tracker: content shrank, so the next flush must
            // emit even if length compares as "not greater" than the old value.
            lastPushedContentLen = 0
            onUpdate?.(`${content}\n\n（已检测到模型重复输出，已自动停止重复内容。）`)
            stopStream("检测到模型重复输出，已自动停止重复内容。")
            return
          }
        }
        // F-4: flush only every ONUPDATE_FLUSH_CHARS to keep streaming O(n).
        if (content.length - lastPushedContentLen >= ONUPDATE_FLUSH_CHARS) {
          flushContent()
        }
      },
      onReasoningToken: (token) => {
        if (signal?.aborted) {
          stopStream(USER_ABORT_MESSAGE)
          return
        }
        // 推理 token 只用于进度显示，不计入最终 content
        reasoningBuffer += token
        // F-12: throttle reasoningBuffer flushes the same way as content.
        if (!content && reasoningBuffer.length - lastPushedReasoningLen >= ONUPDATE_FLUSH_CHARS) {
          flushReasoning()
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
  let tookPartialPreserve = false
  if (errorNow && !(cutoffReason && isRequestCancelledError(errorNow))) {
    if (partialContent && isTransportInactivityError(errorNow)) {
      // Surface partiality to the caller so the orchestration layer can route
      // this draft to the pause / continue-unfinished path instead of the
      // complete->ready->writeback path. Without this signal the truncated
      // draft would be persisted as a completed, ready chapter (Draft-first
      // boundary violation). See DeepChapterGenerationResult.partial.
      onPartial?.(errorNow.message)
      // Final flush of the partial content (tracker reset so it emits even if
      // length did not grow past the throttle threshold since the last push).
      lastPushedContentLen = 0
      onUpdate?.(`${partialContent}\n\n（${errorNow.message}，已保留已生成的部分正文以便继续未完成。）`)
      tookPartialPreserve = true
    } else {
      throw errorNow
    }
  }
  // F-4 regression guard (S_CONFIRM): the partial-preserve path already
  // emitted its final annotated view at :1678, so neither the cutoff flush nor
  // the normal-completion flush must run afterward — otherwise flushContent()
  // would overwrite the partial-preserve annotation with a bare content frame
  // (last-onUpdate-wins), hiding the partial signal from the caller's UI.
  if (!tookPartialPreserve) {
    if (cutoffReason) {
      // Final flush on cutoff (tracker reset to emit the cutoff-annotated view).
      lastPushedContentLen = 0
      onUpdate?.(`${content.trim()}\n\n（${cutoffReason}）`)
    } else {
      // F-4: final flush of the complete content so the caller's last onUpdate
      // reflects the full draft, not a throttle-stale truncated view.
      flushContent()
      flushReasoning()
    }
  }
  // CORR-107: a full successful generation (no partial-preserve branch taken)
  // supersedes any earlier partialReason set by a prior stage — clear it so a
  // recovered draft is not falsely marked partial.
  if (!tookPartialPreserve) {
    onCompleteClearPartial?.()
  }
  return content.trim()
}

function countChapterChars(content: string): number {
  return content.replace(/\s+/g, "").length
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)
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
      // Pass the RAW content (not `normalized`) so the returned index lands in
      // the caller's coordinate space — :1886 slices raw `content`, and slicing
      // a CRLF string at an LF-normalized index cuts N chars too early (one per
      // \r\n). sourceIndexFromCompactIndex skips whitespace via /\s/.test so \r
      // doesn't perturb the `seen` count; only the returned index space differs.
      return sourceIndexFromCompactIndex(content, first + REPEAT_WINDOW_CHARS)
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
    // CORR-102: return `index` (not `index + 1`) so slice(0, index) lands at
    // the start of the second repeated copy, not one char past it. The prior
    // +1 dropped the first non-whitespace char after the cut point.
    if (seen >= compactIndex) return index
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
  } catch (err) {
    // F-10: log the failure (matches the :844 previous-chapters-analysis catch
    // observability) so context-assembly failure is not silent. Without this the
    // whole main chain runs 7 stages on an all-empty ContextPack, producing a
    // superficially-successful but semantically-empty chapter with no partial/
    // fail signal. Surfacing this as a partial flag would require either passing
    // notePartial here or returning a {contextPack, error} tuple — both are part
    // of the broader partial-state-object refactor (F-8) and tracked as an issue;
    // the log at least makes the failure observable in the app's stderr.
    logger.error("Deep Chapter", "Context pack assembly failed (continuing with empty context)", { error: err instanceof Error ? err.message : String(err) })
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
