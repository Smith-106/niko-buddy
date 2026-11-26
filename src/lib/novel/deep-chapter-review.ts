/**
 * deep-chapter-review — 全书审查执行子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的独立导出函数 runFullReviewWithSixDim：
 * reviewChapter + 6-dim 并发审查 + 机械预检。主文件只做编排——审查执行逻辑
 * 独立可测，不再埋在编排体里。
 */

import { combineAbortSignals } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { formatStageThinking } from "./chapter-utils"
import type { ContextPack } from "./context-engine"
import { runContinuityMechanicalPreflight, isReviewParseError, type NovelReviewResult } from "./review-adapter"
import { dimensionResultsToReviewResults, type SixReviewDimensionKey, type DimensionReviewResult } from "./dimension-review-adapter"
import { recordAntiAiShadowTelemetry } from "./anti-ai-shadow-telemetry"
import { logger, toErrorMessage } from "@/lib/utils"
import type { DeepChapterGenerationCallbacks, DeepChapterGenerationDeps } from "./deep-chapter-generation"

export type SixDimOutcome =
  | { kind: "success"; results: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> }
  | { kind: "failure"; error: unknown }
  | { kind: "skipped" }

/** ISS-20260709-049: 穷尽分支断言 — 新增 kind 必须在此 switch 显式处理，否则编译期报错。 */
export function assertNeverSixDimOutcome(value: never): never {
  throw new Error(`Unhandled SixDimOutcome kind: ${JSON.stringify(value)}`)
}

export async function runFullReviewWithSixDim(
  content: string,
  chapterNumber: number | undefined,
  projectPath: string,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  contextPack: ContextPack,
  callbacks: DeepChapterGenerationCallbacks,
  genre?: string,
  runtimeConfig?: { novelConfig?: NovelConfig; llmConfig?: LlmConfig },
): Promise<{
  reviewResults: NovelReviewResult[]
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  /** 48号报告 §六-⑥: 审查输出不可解析且重试耗尽 ⇒ 禁止 LLM 自动修订正文, 转人工。 */
  reviewParseFailed?: boolean
  /** A01: 仅当语义审查在输入内容上实际跑过回调标记时为 true。 */
  semanticReviewCompleted?: boolean
}> {
  // (a) reviewChapter — signal-aware ternary (both branches must stay or
  // non-signal callers break). Matches the original stage-4 call shape.
  let reviewResults: NovelReviewResult[]
  const runSixDim = deps.runSixDimensionReview
  const sixDimController = new AbortController()
  const sixDimSignal = combineAbortSignals(signal, sixDimController.signal)
  const preflightContinuity = await runContinuityMechanicalPreflight(projectPath, chapterNumber, { chapterText: content })
  const sixDimP: Promise<SixDimOutcome> = runSixDim
    ? runSixDim({
        projectPath,
        chapterContent: content,
        chapterNumber,
        signal: sixDimSignal,
        priorReviewResults: preflightContinuity,
        contextPack,
        ...(runtimeConfig?.novelConfig ? { novelConfig: runtimeConfig.novelConfig } : {}),
        ...(runtimeConfig?.llmConfig ? { llmConfig: runtimeConfig.llmConfig } : {}),
      })
        .then((res) => ({
          kind: "success" as const,
          results: res as Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>,
        }))
        .catch((err: unknown) => {
          // Non-blocking: 捕获原始 error 供 gap 日志脱敏打印（toErrorMessage）。
          // Re-throws are NOT propagated (preserves 6-dim-non-blocking contract).
          return { kind: "failure" as const, error: err }
        })
    : Promise.resolve({ kind: "skipped" as const })
  let semanticReviewCompleted = false
  const reviewOptions = {
    onThinking: callbacks.onThinking,
    contextPack,
    injectedContinuityResults: preflightContinuity,
    ...(genre ? { genre } : {}),
    ...(runtimeConfig?.novelConfig ? { novelConfig: runtimeConfig.novelConfig } : {}),
    ...(runtimeConfig?.llmConfig ? { llmConfig: runtimeConfig.llmConfig } : {}),
    onSemanticReviewCompleted: () => { semanticReviewCompleted = true },
  }
  try {
    reviewResults = signal
      ? await deps.reviewChapter(projectPath, content, chapterNumber, reviewOptions, signal)
      : await deps.reviewChapter(projectPath, content, chapterNumber, reviewOptions)
  } catch (err) {
    // (b) log + rethrow (matches the original stage-4 ~1042-1044 pattern).
    // The 3 call sites previously each had their own try/catch with slightly
    // different log messages; consolidating into the helper eliminates that
    // copy-paste drift along with the 6-dim block.
    // F-16 (CWE-532): log only the message, not the full error object — streamChat
    // errors may carry provider request details (URL/headers) that should not
    // reach the app's stderr. Matches the :778 six-dim error-message extraction.
    logger.error("Deep Chapter", "Review failed", { error: toErrorMessage(err) })
    // F-1 (orphan 6-dim process): when reviewChapter throws, the `await
    // sixDimP` at the coalesce step below is unreachable, so the 6-dim review
    // launched in parallel would keep running as an orphan background LLM
    // stream (up to 6 dimensions × stream timeout). ISS-20260709-049: now
    // that runSixDimensionReview accepts an AbortSignal, abort the local
    // sixDimController to cascade-cancel the in-flight 6-dim LLM streams,
    // reclaiming the orphaned token/quota. sixDimP already normalizes rejections
    // to { kind: "failure" } (non-blocking) above so the abort surfaces as a
    // failure outcome (discarded: the coalesce step is unreachable on this path, and reviewChapter's failure
    // already fails the whole review). Attach a terminal .catch so the orphan
    // is explicitly owned (never becomes an unhandled rejection if the .catch
    // above is ever changed). The external signal is NOT aborted — only the
    // local controller, so the caller's cancel semantics are untouched.
    if (runSixDim) {
      sixDimController.abort()
      await sixDimP
      logger.warn("Deep Chapter", "6-dimension review aborted after reviewChapter failure (ISS-20260709-049 cascade-cancel).")
    }
    // 48号报告 §六-⑥ parseFailed 防误修订: 审查输出不可解析 (ReviewParseError,
    // 重试耗尽后) ⇒ 禁止基于不可信审计触发 LLM 自动返修正文 (对齐 inkos
    // chapter-review-cycle parseFailed → skip auto-revise 语义)。不 re-throw
    // 触发 watchdog paused, 而是返回 warning finding + reviewParseFailed=true
    // 让编排层走 manualHandoff 转人工。守 IC-02 "从不静默降级" 纪律。
    if (isReviewParseError(err)) {
      callbacks.onThinking?.(formatStageThinking(
        "阶段4：审稿解析失败保护",
        "重试耗尽，审查输出不可解析。禁止基于不可信审计自动返修正文，转人工处理。",
      ))
      return {
        reviewResults: [{
          severity: "warning" as const,
          type: "review_parse_failed",
          message: "审查输出解析失败（重试耗尽），已跳过自动修订以避免误改正文",
          evidence: err.parseMessage,
          relatedMemory: "review-adapter",
          suggestion: "换用更强模型或检查结构化输出格式后重跑审稿；正文未做任何自动改动。",
        }],
        dimensionResults: {},
        reviewParseFailed: true,
        semanticReviewCompleted: false,
      }
    }
    throw err
  }
  // (c) coalesce — reviewChapter may return null/undefined.
  reviewResults = reviewResults || []
  // (c)+(d) F-003 6-dim block: non-blocking. A 6-dim failure must not break
  // the main review flow.
  let dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {}
  const sixDimOutcome = await sixDimP
  // ISS-20260709-049: 穷尽处理三分支（success/failure/skipped），default 编译期兜底。
  // 行为等价：failure 记 info gap（非阻塞）、success 合并举证、skipped 空合并。
  switch (sixDimOutcome.kind) {
    case "failure": {
      // CORR-109 (IC-02 contract): record the gap. The prior catch only logged
      // and left dimensionResults={}, so a chapter whose 6-dim review threw was
      // indistinguishable downstream from one where 6-dim passed clean (the
      // F-003/ARCH-001 "6-dim orphan" silently recurred). Push an info-severity
      // NovelReviewResult so status.json / ContextGap consumers can see the 6-dim
      // review was skipped, not clean. Non-blocking preserved (info, not error).
      const sixDimErr = sixDimOutcome.error
      const errMsg = toErrorMessage(sixDimErr)
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
      break
    }
    case "success": {
      dimensionResults = sixDimOutcome.results
      if (Object.keys(dimensionResults).length > 0) {
        // §GAP-88-03 (ainovel 强制举证硬门激活): 传入 content 作 chapterBody，
        // 使 dimensionResultsToReviewResults 内的举证机械校验真正生效——无
        // chapterBody 时 verifyEvidenceCitations 全跳过，硬门形同虚设。
        reviewResults = [
          ...reviewResults,
          ...dimensionResultsToReviewResults(dimensionResults, content),
        ]
      }
      break
    }
    case "skipped": {
      // runSixDimensionReview 缺失（测试注入/降级路径）：空合并，保持既有语义。
      break
    }
    default: {
    /* v8 ignore start -- 台账 deep-chapter-review.ts L198-199：switch(sixDimOutcome) 已穷举 SixDimOutcome 联合的全部成员，default 是编译期 exhaustiveness 断言（assertNever 的参数类型是 never），运行期不可达 */
      assertNeverSixDimOutcome(sixDimOutcome)
      break
    /* v8 ignore stop */
    }
  }
  // ISS-20260719-002 (option C1 真接线已激活): 机械预检在 sixDimP 启动前先跑
  // (见上方 preflightContinuity), 结果注入 6-dim 的 priorReviewResults 激活
  // continuity 维度短路 (dimension-review-adapter.ts:404-422), 命中 consistency_mechanical
  // findings 时 6-dim continuity 维度产 pass 占位跳 LLM。此处仅记短路激活频次信号
  // (CWE-532 脱敏, 只记 count 不引用 findings 正文), 供未来 plan session 评估短路收益
  // (省了多少 continuity LLM token)。短路未命中 (mechanical=0 或 6-dim 仍跑 continuity)
  // 不记。守 logger 双参 scope='Deep Chapter'。
  const mechanicalContinuityCount = reviewResults.filter(
    (r) => r.type === "consistency_mechanical",
  ).length
  if (mechanicalContinuityCount > 0 && dimensionResults.continuity) {
    logger.warn("Deep Chapter", "ISS-20260719-002 continuity 短路接线运行信号", {
      mechanical_findings: mechanicalContinuityCount,
      six_dim_continuity_status: dimensionResults.continuity.status,
    })
  }
  // T24-01 影子遥测接线（#34 ≥200 章累积钟）：跑 mech 四因子仅供 sink 记录，
  // 不并入 reviewResults/gate（门裁语义零变更）。fire-and-forget，永不阻塞主评审。
  // 语料降级：生产无 corpus 则 n-gram/标点因子中性，PL/熵正常算。
  void recordAntiAiShadowTelemetry(content, chapterNumber).catch(() => {
    /* 非致命：遥测失败绝不影响章节生成 */
  })
  return { reviewResults, dimensionResults, semanticReviewCompleted }
}
