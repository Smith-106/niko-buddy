/**
 * deep-chapter-review — 全书审查执行子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的独立导出函数 runFullReviewWithSixDim：
 * reviewChapter + 6-dim 并发审查 + 机械预检。主文件只做编排——审查执行逻辑
 * 独立可测，不再埋在编排体里。
 */

import { combineAbortSignals } from "@/lib/llm-client"
import { formatStageThinking } from "./chapter-utils"
import type { ContextPack } from "./context-engine"
import { runContinuityMechanicalPreflight, isReviewParseError, type NovelReviewResult } from "./review-adapter"
import { dimensionResultsToReviewResults, type SixReviewDimensionKey, type DimensionReviewResult } from "./dimension-review-adapter"
import { recordAntiAiShadowTelemetry } from "./anti-ai-shadow-telemetry"
import { logger } from "@/lib/utils"
import type { DeepChapterGenerationCallbacks, DeepChapterGenerationDeps } from "./deep-chapter-generation"

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
  /** 48号报告 §六-⑥: 审查输出不可解析且重试耗尽 ⇒ 禁止 LLM 自动修订正文, 转人工。 */
  reviewParseFailed?: boolean
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
  // ISS-20260719-002 (option C1 真接线): 启动 6-dim 前先串行跑一次机械连续性预检,
  // 结果同时注入 (a) sixDimP 的 priorReviewResults 激活 continuity 维度短路跳 LLM,
  // (b) reviewChapter 的 injectedContinuityResults 跳过内部重跑。串行插入的仅是
  // 机械 IO (4-store load + 纯函数 checkContinuity), 不取消任何 LLM 并发 —
  // PERF-NEW-06 的 invariant 是 reviewChapter 的 LLM 审查与 6-dim 的 LLM 审查并发,
  // 机械预检非 LLM 不在 invariant 范围。净成本 0 (现状 reviewChapter 内也要跑这步),
  // 净收益 = 省 1 轮 continuity LLM (短路命中时)。守 S-20260718-ito3 (复用已加载 store
  // 不独立 reload): injectedContinuityResults 消除重复 load, 总 preflight 调用次数 = 1。
  const preflightContinuity = await runContinuityMechanicalPreflight(projectPath, chapterNumber)
  const sixDimP: Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> | { __sixDimError: unknown } | undefined> = runSixDim
    ? runSixDim({ projectPath, chapterContent: content, chapterNumber, signal: sixDimSignal, priorReviewResults: preflightContinuity })
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
      ? await deps.reviewChapter(projectPath, content, chapterNumber, { onThinking: callbacks.onThinking, contextPack, injectedContinuityResults: preflightContinuity }, signal)
      : await deps.reviewChapter(projectPath, content, chapterNumber, { onThinking: callbacks.onThinking, contextPack, injectedContinuityResults: preflightContinuity })
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
    // 48号报告 §六-⑥ parseFailed 防误修订: 审查输出不可解析 (ReviewParseError,
    // 重试耗尽后) ⇒ 禁止基于不可信审计触发 LLM 自动返修正文 (对齐 inkos
    // chapter-review-cycle parseFailed → skip auto-revise 语义)。不 re-throw
    // 触发 watchdog paused, 而是返回 warning finding + reviewParseFailed=true
    // 让编排层走 manualHandoff 转人工。守 IC-02 "从不静默降级" 纪律。
    if (isReviewParseError(err)) {
      if (runSixDim) {
        sixDimController.abort()
        void sixDimP.catch(() => {})
      }
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
  return { reviewResults, dimensionResults }
}
