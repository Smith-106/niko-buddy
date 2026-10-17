/**
 * deep-chapter-runtime-support.ts — 深章流水线运行时支撑层（纯搬迁，零逻辑变更）
 *
 * 从 deep-chapter-generation.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 承载：流式节流常量、门/情绪熔断阈值、残差策略判定、checkpoint 谓词与工厂、
 * 契约写后核对、collectModelText、safeBuildChapterContextPack。
 *
 * 纪律：只做同实现搬迁，任何逻辑改动都会破坏本承诺。
 */
import {
  createDefaultStructureThrilPacingPlan,
} from "./chapter-structure-plan"
import type {
  ChapterStructurePlan,
} from "./chapter-structure-plan"
import {
} from "./chapter-utils"
import {
} from "./context-engine"
import type {
  ContextPack,
} from "./context-engine"
import {
} from "./control-kernel"
import {
  applyCachePrefix,
} from "./deep-chapter-resolve"
import {
  checkChapterContract,
  parseChapterContractSection,
} from "./deep-chapter-task-brief"
import {
  assertNotAborted,
  findRepeatedTailStart,
} from "./deep-chapter-utils"
import {
  RESIDUAL_OVERALL_MEDIAN_THRESHOLD,
  evaluateResidualRewritePolicy,
} from "./residual-rewrite-policy"
import type {
  ResidualRewritePolicyDecision,
} from "./residual-rewrite-policy"
import type {
  NovelReviewResult,
} from "./review-adapter"
import {
  feedToken,
} from "./watchdog"
import type {
  WatchdogState,
} from "./watchdog"
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  combineAbortSignals,
  isRequestCancelledError,
  isTransportInactivityError,
} from "@/lib/llm-client"
import type {
  ChatMessage,
  RequestOverrides,
} from "@/lib/llm-client"
import {
  logger,
} from "@/lib/utils"
import {
  LlmConfig,
} from "@/stores/wiki-store"
import type {
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResumeStage,
} from "./deep-chapter-generation"

export const REPEAT_CHECK_MIN_CHARS = 600
export const REPEAT_WINDOW_CHARS = 120
export const REPEAT_HIT_LIMIT = 3
// F-4/F-12: throttle onUpdate so it does not pass the entire growing content /
// reasoningBuffer string to the caller on every single token. Without this,
// each token triggers an O(content-length) callback (formatStageThinking trims
// + slices + UI state write), making streaming O(N²) in draft length under
// --include-partial-messages where every token is a separate event. Flush only
// when at least this many new chars have accumulated; a final flush is always
// emitted before collectModelText returns so the caller never sees a stale
// truncated view on completion / cutoff / partial-preserve.
export const ONUPDATE_FLUSH_CHARS = 256
// CORR-101 (documented constraint): findRepeatedTailStart detects a 3x-repeated
// loop ONLY when the repeated block's period is a divisor of REPEAT_WINDOW_CHARS
// (120) — it anchors on the last 120 chars of the compacted draft and counts
// exact 120-char matches. A loop whose unique-cycle length is not a 120-divisor
// (e.g. a 180-char cycle repeated 3x) is silently missed because its last-120
// window differs from the first cycle's last-120 window. This is a known
// precision limitation of the tail-anchored detector, not a bug. Sliding
// multiple window sizes (40/80/120) or a suffix-array approach would widen
// coverage but risks false positives on legitimate prose; deferred.
export const MAX_GATE_RETRY = 3
// A19 emotion-ledger pilot: 情绪债务熔断阈值。任一角色 netValue 低于此值即触发
// Circuit Breaker (长期承压, ADR-17 fix-loop 配套)。-0.6 为 Niko Buddy 设计阈值
// (NovelForge-v5 EmotionTracker 的 net_debt 为 0-100+ 量纲, 无可直接对照的
// Circuit Breaker 阈值; -0.6 基于 Niko Buddy 的 -1.0~1.0 netValue 量纲经验设定:
// 三轴负偏 + history 负累积达此深度时角色状态已不可逆, 对应 NovelForge-v5
// CAUTIOUS 状态类比)。
export const EMOTION_CB_THRESHOLD = -0.6
export const MAX_TASK_BRIEF_REPAIR_ATTEMPTS = 2
export const USER_ABORT_MESSAGE = "已停止生成"


/** True when caller opted into residual campaign fields (any residual hook present). */
export function hasResidualOptIn(input: DeepChapterGenerationInput): boolean {
  return (
    input.residualOverallMedian != null
    || input.residualRewriteMode != null
    || input.chapterStructurePlan != null
    || input.residualLengthPreserving != null
  )
}

/**
 * Resolve structure plan for residual inject:
 * - explicit chapterStructurePlan wins
 * - residual_high + no plan → createDefaultStructureThrilPacingPlan(chapterNumber)
 * - no residual opt-in → undefined (fail-open)
 */
export function resolveStructurePlanForResidual(
  input: DeepChapterGenerationInput,
): ChapterStructurePlan | undefined {
  if (input.chapterStructurePlan) return input.chapterStructurePlan
  if (!hasResidualOptIn(input)) return undefined
  const median = input.residualOverallMedian
  if (median != null && Number.isFinite(median) && median >= RESIDUAL_OVERALL_MEDIAN_THRESHOLD) {
    return createDefaultStructureThrilPacingPlan(input.chapterNumber)
  }
  return undefined
}

/**
 * Residual policy decision when residual fields present; null when fail-open omit.
 */
export function evaluateResidualPolicyForInput(
  input: DeepChapterGenerationInput,
): ResidualRewritePolicyDecision | null {
  if (!hasResidualOptIn(input)) return null
  if (input.residualOverallMedian == null || !Number.isFinite(input.residualOverallMedian)) {
    return null
  }
  return evaluateResidualRewritePolicy({
    residualOverallMedian: input.residualOverallMedian,
    mode: input.residualRewriteMode ?? "structure_thril_pacing",
    lengthPreserving: input.residualLengthPreserving ?? true,
  })
}


export function createResumeCheckpoint(
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

export function checkpointStageAtLeast(
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

export function hasCheckpointTaskBrief(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string } {
  return Boolean(checkpoint?.taskBrief?.trim()) && checkpointStageAtLeast(checkpoint, "after_task_brief")
}

export function hasCheckpointDraft(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string } {
  return hasCheckpointTaskBrief(checkpoint) && Boolean(checkpoint.draftContent?.trim()) && checkpointStageAtLeast(checkpoint, "after_draft")
}

export function hasCheckpointReview(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[] } {
  return hasCheckpointDraft(checkpoint) && Array.isArray(checkpoint.reviewResults) && checkpointStageAtLeast(checkpoint, "after_review")
}

export function hasCheckpointRevision(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[], currentContent: string } {
  return hasCheckpointReview(checkpoint) && Boolean(checkpoint.currentContent?.trim()) && checkpointStageAtLeast(checkpoint, "after_revision")
}

// ── §GAP-88-01 章节契约写后核对（ainovel chapter_contract 模式）──────────
// 解析任务书契约段并机械核对正文，findings (type="contract") 并入
// reviewResults → CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES 归 consistency 门。
// 零 LLM。transitional 由契约段 `过渡章：是` 自声明透传（DEBT-89b 已关闭；
// 缺省非过渡=保守 warning，避免漏报）。契约缺段
// （parse null）如实跳过、不伪造 findings（IC-02 不静默降级：无契约=无约束，
// 而非 pass）。stage4/55/5/57 四个审查点统一经此 helper，防 ARCH-001 式漂移。
export function applyChapterContractCheck(
  taskBrief: string,
  content: string,
  reviewResults: NovelReviewResult[],
): NovelReviewResult[] {
  const contract = parseChapterContractSection(taskBrief)
  if (!contract) return reviewResults
  // DEBT-89b 关闭：transitional 不再恒 false——由契约段 `过渡章：是` 自声明
  // 透传；trade_off 转 info 级 finding 并入（人类/复审可见，IC-02 不静默），
  // info 级不进 error 门（passed 语义不变：仅 error 阻断）。stage4/55/5/57
  // 四个审查点统一经此 helper，调用方零改动。
  const check = checkChapterContract(contract, content, { transitional: contract.transitional })
  const tradeOffFindings: NovelReviewResult[] = check.tradeOffs.map((t) => ({
    severity: "info" as const,
    type: "contract",
    message: `章节契约（过渡章取舍）：${t}`,
    evidence: "",
    relatedMemory: "chapter_contract.transitional",
    suggestion: "过渡章方向提示取舍已记录；如下章仍未承接则补强。",
  }))
  if (check.findings.length === 0 && tradeOffFindings.length === 0) return reviewResults
  return [...reviewResults, ...check.findings, ...tradeOffFindings]
}

export async function collectModelText(
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
  /**
   * DEBT-20260822-t34-wiring: watchdog 注入点（可选，additive）。
   * 缺省 undefined → onToken 中不喂入 watchdog（现状字节级不变）。
   */
  watchdog?: WatchdogState,
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

  assertNotAborted(signal, USER_ABORT_MESSAGE)

  await deps.streamChat(
    config,
    applyCachePrefix(messages, cachePrefix),
    {
      onToken: (token) => {
        if (signal?.aborted) {
          stopStream(USER_ABORT_MESSAGE)
          return
        }
        // DEBT-20260822-t34-wiring: watchdog feed on each token
        if (watchdog) {
          feedToken(watchdog, Date.now())
        }
        content += token
        // Only re-scan for repeated tail when the content has grown by at least
        // REPEAT_WINDOW_CHARS since the last check; the trailing window cannot
        // form a new 3x repeat until that much new content arrives.
        if (content.length - lastRepeatCheckLen >= REPEAT_WINDOW_CHARS) {
          lastRepeatCheckLen = content.length
          const loopStart = findRepeatedTailStart(content, { minChars: REPEAT_CHECK_MIN_CHARS, windowChars: REPEAT_WINDOW_CHARS, hitLimit: REPEAT_HIT_LIMIT })
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











export async function safeBuildChapterContextPack(
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
