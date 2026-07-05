import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { useWikiStore } from "@/stores/wiki-store"
import { runDecisionGates, type GateResultInfo, type GateSummary } from "@/commands/gates"
import { buildContextPack, buildContextPackEnvelope, contextPackToPrompt, type ContextPack } from "./context-engine"
import { resolveNovelModel } from "./model-resolver"
import { reviewChapter, type NovelReviewResult } from "./review-adapter"
import type { TaskRouteResult } from "./task-router"
import type { GoldenThreeChapterRequest } from "./golden-three-chapters"
import type { ContextAssemblyResult } from "./context-assembly"
import { buildNovelTaskId } from "./novel-task-id"
import {
  resolveChapterLengthSpec,
  type ChapterLengthSpec,
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterExpansionPrompt,
  buildDeepChapterFinalPolishPrompt,
  buildDeepChapterRevisionPrompt,
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
  onCheckpoint?: (checkpoint: DeepChapterGenerationResumeCheckpoint) => void
}

export interface DeepChapterGenerationResult {
  finalContent: string
  taskBrief: string
  draftContent: string
  reviewResults: NovelReviewResult[]
  gateSummary: GateSummary
  revised: boolean
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
  taskId?: string
  chapterNumber?: number
  stage: DeepChapterGenerationResumeStage
  contextAssembly?: ContextAssemblyResult
  taskBrief?: string
  draftContent?: string
  reviewResults?: NovelReviewResult[]
  gateSummary?: GateSummary
  currentContent?: string
}

export interface DeepChapterGenerationDeps {
  buildContextPack: typeof buildContextPack
  buildContextPackEnvelope: typeof buildContextPackEnvelope
  contextPackToPrompt: typeof contextPackToPrompt
  reviewChapter: typeof reviewChapter
  runDecisionGates: typeof runDecisionGates
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
  buildContextPackEnvelope,
  contextPackToPrompt,
  reviewChapter,
  runDecisionGates,
  streamChat,
}

const REPEAT_CHECK_MIN_CHARS = 600
const REPEAT_WINDOW_CHARS = 120
const REPEAT_HIT_LIMIT = 3
const USER_ABORT_MESSAGE = "已停止生成"

function alignReviewResultsWithGateSummary(
  reviewResults: NovelReviewResult[],
  gateSummary: GateSummary,
): NovelReviewResult[] {
  const failingGateTypes = new Set(
    Object.values(gateSummary.gate_results)
      .filter((gate) => gate.status === "failed")
      .map((gate) => gate.gate_type),
  )

  return reviewResults.filter((item) => item.severity !== "error" || failingGateTypes.has(item.type as "consistency" | "anti_ai" | "quality"))
}

export function shouldUseDeepChapterGeneration(_route: TaskRouteResult | null, enabled: boolean): boolean {
  return enabled
}

function buildManualReviewGateSummary(gateSummary: GateSummary): GateSummary {
  const maxRetry = gateSummary.max_retry || 3
  return {
    ...gateSummary,
    all_passed: false,
    total_retries: maxRetry,
    gate_results: Object.fromEntries(
      Object.entries(gateSummary.gate_results).map(([key, gate]) => [
        key,
        gate.status === "failed"
          ? {
            ...gate,
            retry_count: maxRetry,
          }
          : gate,
      ]),
    ),
  }
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
    taskId: data.taskId ?? input.resumeCheckpoint?.taskId ?? buildNovelTaskId(input.userRequest, input.chapterNumber),
    chapterNumber: input.resumeCheckpoint?.chapterNumber ?? input.chapterNumber,
    stage,
    ...data,
  }
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
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[], gateSummary: GateSummary } {
  return hasCheckpointDraft(checkpoint)
    && Array.isArray(checkpoint.reviewResults)
    && Boolean(checkpoint.gateSummary)
    && checkpointStageAtLeast(checkpoint, "after_review")
}

function hasCheckpointRevision(
  checkpoint?: DeepChapterGenerationResumeCheckpoint | null,
): checkpoint is DeepChapterGenerationResumeCheckpoint & { taskBrief: string, draftContent: string, reviewResults: NovelReviewResult[], gateSummary: GateSummary, currentContent: string } {
  return hasCheckpointReview(checkpoint) && Boolean(checkpoint.currentContent?.trim()) && checkpointStageAtLeast(checkpoint, "after_revision")
}

export async function runDeepChapterGeneration(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps: DeepChapterGenerationDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<DeepChapterGenerationResult> {
  assertNotAborted(signal)
  const resumeCheckpoint = input.resumeCheckpoint
  const writingConfig = resolveWritingConfig(input.llmConfig)
  const lengthSpec = resolveCurrentChapterLengthSpec()
  const { loadSmartDeAiSkill } = await import("./de-ai-adapter")
  const taskId = resumeCheckpoint?.taskId ?? buildNovelTaskId(input.userRequest, input.chapterNumber)

  // 将在阶段1构建contextPack后再加载skill（需要contextPack用于场景检测）
  let customDeAiSkill: string | null = null

  // 阶段0：前情分析（仅当章节号>1时）
  let previousChaptersAnalysis = ""
  if (input.chapterNumber && input.chapterNumber > 1 && !resumeCheckpoint) {
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

  const { pack: contextPack, assembly: contextAssembly } = await safeBuildChapterContextPack(
    deps,
    input.projectPath,
    input.userRequest,
    input.chapterNumber,
    taskId,
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

  if (!resumeCheckpoint) {
    callbacks.onThinking?.(formatContextThinking(input, contextPack))
    callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_context", {
      taskId,
      contextAssembly,
    }))
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
    )
    assertNotAborted(signal)
    callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", taskBrief))
    callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", {
      taskId,
      contextAssembly,
      taskBrief,
    }))
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
      )
      assertNotAborted(signal)
    }
    callbacks.onThinking?.(formatStageThinking("阶段3：正文初稿", [
      draftContent,
      "",
      `初稿生成完成，约 ${countChapterChars(draftContent)} 字。`,
    ].join("\n")))
    callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_draft", {
      taskId,
      contextAssembly,
      taskBrief,
      draftContent,
    }))
  }

  let reviewResults = hasCheckpointReview(resumeCheckpoint) ? resumeCheckpoint.reviewResults : []
  let gateSummary = hasCheckpointReview(resumeCheckpoint)
    ? resumeCheckpoint.gateSummary
    : createEmptyGateSummary()
  if (!hasCheckpointReview(resumeCheckpoint)) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段4：正式三门控",
      "正在运行 Consistency、Anti-AI、Quality 三门控，并补充审稿证据。",
    ))
    gateSummary = await deps.runDecisionGates(input.projectPath, draftContent)
    assertNotAborted(signal)
    try {
      reviewResults = signal
        ? await deps.reviewChapter(input.projectPath, draftContent, input.chapterNumber, { onThinking: callbacks.onThinking }, signal)
        : await deps.reviewChapter(input.projectPath, draftContent, input.chapterNumber, { onThinking: callbacks.onThinking })
    } catch (err) {
      console.error("[Deep Chapter] Review enrichment failed:", err)
      reviewResults = []
    }
    reviewResults = reviewResults || []
    assertNotAborted(signal)
    callbacks.onThinking?.(formatGateThinking(gateSummary, reviewResults))
    callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
      taskId,
      contextAssembly,
      taskBrief,
      draftContent,
      reviewResults,
      gateSummary,
    }))
  }

  let currentContent = draftContent
  let revised = false

  if (hasCheckpointRevision(resumeCheckpoint)) {
    currentContent = resumeCheckpoint.currentContent.trim()
    revised = true
    gateSummary = resumeCheckpoint.gateSummary
  } else {
    let blockingIssues = collectBlockingIssues(gateSummary, reviewResults)
    if (blockingIssues.length === 0 && gateSummary.all_passed) {
      callbacks.onThinking?.(formatStageThinking(
        "阶段5：无需自动返修",
        "正式三门控已通过，跳过自动返修，进入阶段6简单审查与去AI味。",
      ))
    } else {
      let retryAttempt = 0
      const maxRetry = gateSummary.max_retry || 3
      while (blockingIssues.length > 0 && retryAttempt < maxRetry) {
        retryAttempt += 1
        const revisedContent = await collectModelText(
          writingConfig,
          [{
            role: "user",
            content: buildDeepChapterRevisionPrompt(
              outlinePrompt,
              contextPrompt,
              taskBrief,
              currentContent,
              blockingIssues,
              input.userRequest,
              input.chapterNumber,
              input.goldenThreeChapter,
            ),
          }],
          deps,
          signal,
          (partial) => callbacks.onThinking?.(formatStageThinking(`阶段5：自动返修（${retryAttempt}/${maxRetry}）`, partial)),
          { max_tokens: lengthSpec.maxOutputTokens },
        )
        assertNotAborted(signal)
        callbacks.onThinking?.(formatStageThinking(
          `阶段5：自动返修（${retryAttempt}/${maxRetry}）`,
          [
            `检测到 ${blockingIssues.length} 个门控阻断问题，已完成第 ${retryAttempt} 次自动返修。`,
            "",
            formatReviewIssueList(blockingIssues),
            "",
            `返修后正文约 ${countChapterChars(revisedContent)} 字。`,
          ].join("\n"),
        ))
        currentContent = revisedContent
        revised = true
        gateSummary = await deps.runDecisionGates(input.projectPath, currentContent)
        blockingIssues = collectBlockingIssues(gateSummary, reviewResults)
        callbacks.onThinking?.(formatStageThinking(
          `阶段5：返修后复核（${retryAttempt}/${maxRetry}）`,
          formatGateSummaryLines(gateSummary).join("\n"),
        ))
        callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_revision", {
          taskId,
          contextAssembly,
          taskBrief,
          draftContent,
          reviewResults,
          gateSummary,
          currentContent: revisedContent,
        }))
      }

      if (blockingIssues.length > 0) {
        gateSummary = buildManualReviewGateSummary(gateSummary)
        callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_revision", {
          taskId,
          contextAssembly,
          taskBrief,
          draftContent,
          reviewResults,
          gateSummary,
          currentContent,
        }))
        callbacks.onThinking?.(formatStageThinking(
          "阶段5：转人工处理",
          [
            `达到 max_retry=${gateSummary.max_retry}，仍有阻断问题。`,
            "该次任务将被标记为 manual review，保留草稿和门控结果供人工处理。",
            "",
            formatReviewIssueList(blockingIssues),
          ].join("\n"),
        ))
        throw new Error("MANUAL_REVIEW_REQUIRED")
      }
    }
  }

  const polishedContent = await finalPolishChapter(
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
  )
  const finalGateSummary = await deps.runDecisionGates(input.projectPath, polishedContent)
  const finalContent = finalGateSummary.final_text?.trim() || polishedContent
  const finalReviewResults = alignReviewResultsWithGateSummary(reviewResults, finalGateSummary)
  callbacks.onThinking?.(formatStageThinking(
    "阶段7：正式门控收口",
    [
      ...formatGateSummaryLines(finalGateSummary),
      "",
      finalGateSummary.all_passed
        ? "pre-commit 三门控已通过。"
        : "pre-commit 三门控未完全通过，已保留门控结果供后续 accept/reject 流程使用。",
    ].join("\n"),
  ))
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
    reviewResults: finalReviewResults,
    gateSummary: finalGateSummary,
    revised,
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
  )
  assertNotAborted(signal)
  return polished.trim() ? polished : currentContent
}

function resolveCurrentChapterLengthSpec(): ChapterLengthSpec {
  const novelConfig = useWikiStore.getState().novelConfig
  return resolveChapterLengthSpec(novelConfig?.chapterTargetChars)
}

function resolveWritingConfig(llmConfig: LlmConfig): LlmConfig {
  const novelConfig = useWikiStore.getState().novelConfig
  return resolveNovelModel(llmConfig, novelConfig, "writing")
}

async function collectModelText(
  config: LlmConfig,
  messages: ChatMessage[],
  deps: DeepChapterGenerationDeps,
  signal?: AbortSignal,
  onUpdate?: (content: string) => void,
  requestOverrides?: RequestOverrides,
): Promise<string> {
  let content = ""
  let reasoningBuffer = ""
  let streamError: Error | null = null
  let cutoffReason: string | null = null
  // Repeat-detection only needs to re-run once enough new content has arrived
  // to change the trailing window (REPEAT_WINDOW_CHARS). Without this gate the
  // per-token findRepeatedTailStart call does 3 full passes over the entire
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
    messages,
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
      reasoning: requestOverrides?.reasoning ?? resolveUserVisibleReasoning(config.reasoning),
    },
  )

  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)
  if (streamError && !(cutoffReason && isRequestCancelledError(streamError))) throw streamError
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

function createEmptyGateSummary(): GateSummary {
  return {
    all_passed: true,
    gate_results: {},
    total_retries: 0,
    max_retry: 3,
    final_text: null,
  }
}

function collectBlockingIssues(gateSummary: GateSummary, reviewResults: NovelReviewResult[]): NovelReviewResult[] {
  void reviewResults
  const gateIssues = Object.values(gateSummary.gate_results)
    .filter((gate) => gate.status === "failed")
    .flatMap((gate) => gateResultToReviewIssues(gate))
  return gateIssues
}

function gateResultToReviewIssues(gate: GateResultInfo): NovelReviewResult[] {
  const findings = [...gate.mechanical_findings, ...gate.semantic_findings]
  if (findings.length === 0 && gate.status === "failed") {
    return [{
      severity: "error",
      type: gate.gate_type,
      message: `${gate.gate_type} 门控未通过`,
      evidence: gate.findings_desc.join("；"),
      relatedMemory: "",
      suggestion: "按门控结果返修后重跑正式 gates。",
    }]
  }

  return findings.map((finding) => ({
    severity: finding.severity === "warning" ? "warning" : "error",
    type: gate.gate_type,
    message: `${gate.gate_type}：${finding.description}`,
    evidence: finding.location ?? "",
    relatedMemory: "",
    suggestion: finding.suggestion ?? "按门控结果返修正文。",
  }))
}

function formatGateThinking(gateSummary: GateSummary, reviewResults: NovelReviewResult[]): string {
  const blockingIssues = collectBlockingIssues(gateSummary, reviewResults)
  return formatStageThinking(
    "阶段4：正式三门控",
    [
      ...formatGateSummaryLines(gateSummary),
      "",
      blockingIssues.length === 0
        ? "未发现阻断问题。"
        : `发现 ${blockingIssues.length} 个阻断问题。`,
      blockingIssues.length > 0 ? "" : "",
      blockingIssues.length > 0 ? formatReviewIssueList(blockingIssues) : "",
    ].filter(Boolean).join("\n"),
  )
}

function formatGateSummaryLines(gateSummary: GateSummary): string[] {
  const gateOrder: Array<keyof GateSummary["gate_results"] | "consistency" | "anti_ai" | "quality"> = [
    "consistency",
    "anti_ai",
    "quality",
  ]
  const lines = gateOrder
    .map((key) => {
      const gate = gateSummary.gate_results[key]
      if (!gate) return ""
      return `- ${key}: ${gate.status}，score ${gate.score.toFixed(1)}，findings ${gate.finding_count}，retry ${gate.retry_count}`
    })
    .filter(Boolean)
  if (lines.length === 0) return ["- 暂无门控结果"]
  return lines
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
  taskId?: string,
): Promise<{ pack: ContextPack, assembly: ContextAssemblyResult }> {
  try {
    return await deps.buildContextPackEnvelope(projectPath, userRequest, chapterNumber)
  } catch {
    return {
      pack: {
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
      },
      assembly: {
        task_id: taskId ?? "tsk-context-fallback",
        sources: [],
        token_budget: null,
        estimated_tokens: 0,
        prompt_chars: 0,
        hard_constraints: [
          "不能越过角色认知边界",
          "禁止改写正式正文",
        ],
        gaps: ["context_assembly_failed"],
      },
    }
  }
}
