/**
 * deep-chapter-review-repair.ts — 深章阶段4-5 AI审稿 + 返修循环（纯搬迁，零逻辑变更）
 *
 * 从 deep-chapter-generation.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 含：MAX_GATE_RETRY 转人工、情绪熔断、平台期早退、六维评审、契约写后核对。
 */
import {
  extractAuthorFingerprint,
} from "./adversarial/author-fingerprint"
import {
  detectRegression,
  scoreCandidate,
} from "./candidate-selector"
import type {
  CandidateVersion,
} from "./candidate-selector"
import {
  createDefaultStructureThrilPacingPlan,
} from "./chapter-structure-plan"
import {
  formatStageThinking,
} from "./chapter-utils"
import {
  appendRewriteRateASample,
} from "./character-cognition"
import {
  loadCharacterStates,
} from "./character-state"
import type {
  ContextPack,
} from "./context-engine"
import {
} from "./control-kernel"
import {
  checkContinuityCritical,
} from "./deep-chapter-continuity"
import {
  buildDecisionGates,
  collectBlockingIssues,
  collectLiteraryPolishIssues,
  collectRepairIssues,
  emptyDecisionGates,
} from "./deep-chapter-decision-gates"
import {
  buildDeepChapterRevisionPrompt,
} from "./deep-chapter-prompts"
import type {
  ChapterLengthSpec,
} from "./deep-chapter-prompts"
import {
  runFullReviewWithSixDim,
} from "./deep-chapter-review"
import {
  assertNotAborted,
  countChapterChars,
  formatReviewIssueList,
  formatReviewThinking,
} from "./deep-chapter-utils"
import {
  checkEmotionCircuitBreaker,
  loadEmotionLedger,
} from "./emotion-ledger"
import {
  resolveDeAiGenre,
} from "./genre-codes"
import {
  countEchoFamily,
  detectChorusSing,
  detectSilentStretch,
} from "./mechanical-slop-detector"
import {
  DEFAULT_PLATEAU_CONFIG,
  SlopHistoryTracker,
  recommendPostPlateauAction,
} from "./plateau-stop"
import {
} from "./review-adapter"
import type {
  NovelReviewResult,
} from "./review-adapter"
import {
  buildStructureFirstRewriteConstraint,
} from "./structure-first-rewrite"
import {
  resolveTaskExtraPrompt,
} from "./task-customization"
import {
  buildTrackBMultiObjectiveConstraint,
  createDefaultTrackBMultiObjectivePolicy,
  shouldAcceptTrackBPolishText,
} from "./track-b-multi-objective"
import {
  checkVoiceprintConvergence,
} from "./voiceprint-alignment"
import type {
  WatchdogState,
} from "./watchdog"
import {
  logger,
} from "@/lib/utils"
import {
  LlmConfig,
  useWikiStore,
} from "@/stores/wiki-store"
import type {
  DeepChapterDecisionGates,
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
import {
  EMOTION_CB_THRESHOLD,
  MAX_GATE_RETRY,
  USER_ABORT_MESSAGE,
  applyChapterContractCheck,
  collectModelText,
  createResumeCheckpoint,
  evaluateResidualPolicyForInput,
  hasCheckpointReview,
  hasCheckpointRevision,
  hasResidualOptIn,
  resolveStructurePlanForResidual,
} from "./deep-chapter-runtime-support"

// RCP-20261014-1311：平台期结构信号采集（纯同步，零 IO/LLM）。
// 角色名由调用方预加载传入（早退点在循环内，禁止 await 读盘）；
// 复读家族词源=引号短句高频项（≥3 次），与 countEchoFamily(minCount=3) 对齐。
function collectPlateauStructuralFlags(content: string, characterNames: readonly string[]): string[] {
  const flags: string[] = []
  try {
    const chorus = detectChorusSing(content)
    if (chorus.length > 0) {
      flags.push(`轮唱×${chorus.length}（第${chorus.map((c) => `${c.para}段${c.shouts}连`).join("、")}）`)
    }
    const quotes = content.match(/\u201c[^\u201d]{2,12}\u201d/g) ?? []
    const freq = new Map<string, number>()
    for (const q of quotes) freq.set(q, (freq.get(q) ?? 0) + 1)
    const echoFams = [...freq.entries()].filter(([, n]) => n >= 3).map(([q]) => q)
    const echo = countEchoFamily(content, echoFams)
    if (echo.length > 0) {
      flags.push(`复读家族×${echo.length}（${echo.map((e) => `${e.family}×${e.count}`).join("、")}）`)
    }
    const silent = detectSilentStretch(content, characterNames)
    if (silent.length > 0) {
      flags.push(`静默段×${silent.length}（第${silent.map((s) => `${s.fromPara}-${s.toPara}段`).join("、")}）`)
    }
  } catch {
    return []
  }
  return flags
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

export async function runReviewAndRepair(
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
  watchdog?: WatchdogState,
): Promise<ReviewAndRepairResult> {
  const writingTaskExtra = resolveTaskExtraPrompt(input.novelConfig, "writing")
  let reviewResults = hasCheckpointReview(resumeCheckpoint) ? resumeCheckpoint.reviewResults : []
  let decisionGates = resumeCheckpoint?.decisionGates ?? emptyDecisionGates()
  let retryCount = resumeCheckpoint?.retryCount ?? 0
  let manualReviewRequired = Boolean(resumeCheckpoint?.manualReviewRequired)
  // 48号报告 §六-⑥ parseFailed 防误修订: stage4/5.5 若返回 reviewParseFailed=true,
  // 不进 fix-loop (否则会用不可解析的噪声审计驱动 LLM 重写有效正文)。转人工。
  // 累积标记 (OR) 因 stage5.5 复审也可能触发, 任一命中即短路。
  let reviewParseFailedFlag = false
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
      reviewResults = applyChapterContractCheck(taskBrief, draftContent, stage4.reviewResults)
      reviewParseFailedFlag = reviewParseFailedFlag || stage4.reviewParseFailed === true
      decisionGates = buildDecisionGates(reviewResults, retryCount, undefined, resolveDeAiGenre(input.genre))
      assertNotAborted(signal, USER_ABORT_MESSAGE)
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
    decisionGates = buildDecisionGates(reviewResults, retryCount, manualReviewRequired, resolveDeAiGenre(input.genre))
  }

  let currentContent = draftContent
  let revised = false

  if (hasCheckpointRevision(resumeCheckpoint)) {
    currentContent = resumeCheckpoint.currentContent.trim()
    revised = true
    /* v8 ignore next */
    if (novelConfig.deepChapterReview && decisionGates.overall === "pending") {
      callbacks.onThinking?.(formatStageThinking(
        "阶段5.5：返修后复审",
        "正在恢复返修后的完整门控审查，确认上次中断前的返修结果。",
      ))
      // ARCH-001: the shared review helper now wires the 6-dim review here too
      // (was reviewChapter-only, silently skipping dimension findings on
      // resumed revised content). dimensionResults is checkpointed additively.
      const stage55 = await runFullReviewWithSixDim(currentContent, input.chapterNumber, input.projectPath, deps, signal, contextPack, callbacks)
      reviewResults = applyChapterContractCheck(taskBrief, currentContent, stage55.reviewResults)
      reviewParseFailedFlag = reviewParseFailedFlag || stage55.reviewParseFailed === true
      decisionGates = buildDecisionGates(reviewResults, retryCount, manualReviewRequired, resolveDeAiGenre(input.genre))
      assertNotAborted(signal, USER_ABORT_MESSAGE)
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
  // 51 号报告 G6: plateau 停止准则滑窗记账器（与 prevCandidate 同源独立记账）。
  // 每轮返修后 push slop 分，连续 window 轮 delta<epsilon → 提前接受当前稿。
  const slopHistory = new SlopHistoryTracker()

  // 48号报告 §六-⑥ parseFailed 防误修订: 审查输出不可解析时禁止进 fix-loop, 直接转人工。
  // 不依赖 blockingIssues>0 —— 不可信审计下 decisionGates 本身不可信, 一律转人工保护正文。
  if (reviewParseFailedFlag) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段5：审稿解析失败转人工",
      "审查输出不可解析，跳过自动返修以保护正文，转人工处理。",
    ))
    manualReviewRequired = true
    return {
      reviewResults,
      decisionGates,
      retryCount,
      manualReviewRequired,
      currentContent,
      revised,
      manualHandoff: true,
    }
  }

  // RCP-20261014-1311：平台期结构信号用角色名预加载（循环前一次 IO，
  // 早退点同步调用不 await；失败回退 []=静默段检测跳过=keep-current 旧行为）。
  let plateauCharacterNames: string[] = []
  try {
    const charStore = await loadCharacterStates(input.projectPath)
    plateauCharacterNames = (charStore.characters ?? [])
      .map((c) => c.characterName)
      .filter((n) => n.length > 0)
  } catch {
    plateauCharacterNames = []
  }

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
          decisionGates = buildDecisionGates(reviewResults, retryCount, true, resolveDeAiGenre(input.genre))
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
      const continuityCritical = await checkContinuityCritical(input.projectPath, input.chapterNumber, currentContent)
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

    // F-003 retryCountCircuitBreaker: 显式计数判定 (retryCount >= MAX_GATE_RETRY=3)
    // 强制 SUSPEND, 与 emotion-ledger Circuit Breaker 双轨并存。不改 manualHandoff 路径。
    const retryCountCircuitBreakerTripped = retryCount >= MAX_GATE_RETRY
    if (retryCountCircuitBreakerTripped) {
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
    const revisionIssues = [
      ...blockingIssues,
      // R4 共识（deepseek+glm）: 旧谓词首个条件 `!repairIssueMessages.has(i.message)` 恒为 false
      // （repairIssueMessages 正是由 repairIssues 构建的），有效语义就是「不与 blockingIssues 重消息」。
      ...repairIssues.filter((i) => blockingIssues.every((b) => b.message !== i.message)),
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
          writingTaskExtra,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段5：自动返修", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
      undefined,
      watchdog,
    )
    assertNotAborted(signal, USER_ABORT_MESSAGE)
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
    // 51 号报告 G2: 声纹对齐闭环（additive 监控，不改变门控决策）——
    // 返修前后双向声纹测量：driftVsBaseline（风格不漂移）+ driftVsBefore
    // （不过度改写）。未收敛 → onThinking 提示（继续返修或转人工），
    // 不置 manualReviewRequired（该标志为门控 CB 专用，保持既有语义）。
    // baseline 取初稿（作者原笔近似）；beforeRewrite=返修前 currentContent。
    const voiceprint = checkVoiceprintConvergence({
      baseline: extractAuthorFingerprint(draftContent),
      beforeRewrite: currentContent,
      afterRewrite: revisedContent,
      iteration: retryCount,
    })
    if (!voiceprint.converged) {
      callbacks.onThinking?.(formatStageThinking(
        "阶段5：声纹对齐检查",
        [
          `返修后声纹未收敛：风格漂移 ${voiceprint.driftVsBaseline.toFixed(3)}（默认阈值 0.3），改写偏差 ${voiceprint.driftVsBefore.toFixed(3)}。`,
          voiceprint.recommendation === "manual"
            ? "已达返修上限，建议人工复核声纹漂移。"
            : "继续返修以收敛声纹。",
        ].join("\n"),
      ))
    }
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
    // 51 号报告 G6: plateau 停止准则——连续 window 轮 slop delta<epsilon 即平台期，
    // 继续返修只会噪声波动，提前接受当前稿（不置 manualReviewRequired，与
    // retryCountCircuitBreakerTripped 的 manualHandoff 路径严格区分）。
    // 与 MAX_GATE_RETRY 硬上限共存（window=2 < 3，只可能在其前触发）。
    // 记返修后 slop 分（非采用版）：退化回退不产生假平台期（delta=0 误判）。
    // push 在 retryCount 递增前：第 3 次 push 时 retryCount 仍为 2（< 3），
    // plateau 才可触发（原实现在递增后 push，第 3 次 push 时 retryCount=3
    // 被守卫拒绝，plateau 永不触发——GLM 终验发现的不可达死代码）。
    // 实际 break 在复审后判定（见 after_review checkpoint 之后），
    // 仅当复审确认无阻断残留时才早退，P0 门禁不受影响。
    slopHistory.push(scoreCandidate(revisedContent))
    const plateau = slopHistory.evaluate(DEFAULT_PLATEAU_CONFIG)
    const plateauEligible = plateau.plateau && retryCount < MAX_GATE_RETRY
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
    reviewResults = applyChapterContractCheck(taskBrief, currentContent, stage5.reviewResults)
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
    decisionGates = buildDecisionGates(reviewResults, retryCount, undefined, resolveDeAiGenre(input.genre))
    blockingIssues = collectBlockingIssues(decisionGates)
    assertNotAborted(signal, USER_ABORT_MESSAGE)
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_review", {
      taskBrief,
      draftContent,
      reviewResults,
      dimensionResults: stage5.dimensionResults,
      currentContent,
      decisionGates,
      retryCount,
    }))
    // G6: plateau 早退在复审后判定——blockingIssues 为最新复审结果，
    // 仅当无阻断残留时才提前接受（有阻断继续返修，retryCount 达硬上限时
    // 由循环顶部 retryCountCircuitBreaker 以 manualHandoff 转人工，P0 保护）。
    // RCP-20261014-1311 接线：早退前跑结构层三件套 + recommendPostPlateauAction，
    // 有结构信号 → onThinking 输出 diagnose-structure 建议后照常 break
    // （首轮只建议不断言改稿，行为零变更；复读家族词源=引号短句高频项，
    // 角色名源=character-states，任一供给失败回退空数组=keep-current 旧行为）。
    if (plateauEligible && blockingIssues.length === 0) {
      const structuralFlags = collectPlateauStructuralFlags(currentContent, plateauCharacterNames)
      const postAction = recommendPostPlateauAction(slopHistory.getHistory(), structuralFlags)
      if (postAction === "diagnose-structure") {
        callbacks.onThinking?.(formatStageThinking(
          "阶段5：返修平台期——建议转结构手术",
          [
            `连续 ${plateau.window} 轮返修 slop 分变化 < ${DEFAULT_PLATEAU_CONFIG.epsilon}，已进入平台期。`,
            `机械层检出结构信号：${structuralFlags.join("；")}。`,
            "建议停微改、转诊断驱动的结构手术（轮唱并段/复读台词动作化/静默段补在场锚，单轮≤3 处、可回滚），本轮仍接受当前稿。",
          ].join("\n"),
        ))
      } else {
        callbacks.onThinking?.(formatStageThinking(
          "阶段5：返修平台期提前停止",
          [
            `连续 ${plateau.window} 轮返修 slop 分变化 < ${DEFAULT_PLATEAU_CONFIG.epsilon}，已进入平台期，提前接受当前稿。`,
            "",
            formatReviewIssueList(blockingIssues),
          ].join("\n"),
        ))
      }
      break
    }
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

  // Track B: optional literary polish after Track A gates are green (no blocking errors).
  // Residual campaign opt-in may enter this path without literaryPolishAfterGate (fail-open default).
  // At most one pass; thril/pacing/pull warnings only; never overrides Consistency/FIX-1.
  const residualOptIn = hasResidualOptIn(input)
  if (
    novelConfig.deepChapterReview
    && (novelConfig.literaryPolishAfterGate || residualOptIn)
    && !manualReviewRequired
    && collectBlockingIssues(decisionGates).length === 0
  ) {
    const literaryIssues = collectLiteraryPolishIssues(decisionGates)
    // Residual campaign may polish with structure constraint even when no thril/pacing warnings.
    if (literaryIssues.length > 0 || residualOptIn) {
      callbacks.onThinking?.(formatStageThinking(
        residualOptIn && literaryIssues.length === 0
          ? "阶段5.7：Residual structure 抛光"
          : "阶段5.7：Track B 文学抛光",
        residualOptIn && literaryIssues.length === 0
          ? [
              "门控已绿；residual campaign opt-in：至多 1 次 structure_thril_pacing 抛光（不挡交付；productHardGate=false）。",
              `residualOverallMedian=${input.residualOverallMedian ?? "n/a"} mode=${input.residualRewriteMode ?? "structure_thril_pacing"}`,
            ].join("\n")
          : [
              `门控已绿；对 ${literaryIssues.length} 条 thril/节奏/追读相关提示做至多 1 次可选抛光（不挡交付）。`,
              residualOptIn ? "（同时启用 residual structure-first 约束）" : "",
              "",
              formatReviewIssueList(literaryIssues),
            ].filter(Boolean).join("\n"),
      ))
      // Multi-objective guardrails: lift thril/pacing/pull without burning character/pull/FIX-1.
      const trackBPolicy = createDefaultTrackBMultiObjectivePolicy()
      const trackBConstraint = buildTrackBMultiObjectiveConstraint(trackBPolicy)
      // Medium-deepen E3: residual policy + structure constraint only when residual fields present.
      let residualConstraint = ""
      if (residualOptIn) {
        const residualDecision = evaluateResidualPolicyForInput(input)
        const residualPlanForPolish =
          resolveStructurePlanForResidual(input)
          ?? (residualDecision ? createDefaultStructureThrilPacingPlan(input.chapterNumber) : undefined) /* v8 ignore start */ /* v8 ignore stop */
        residualConstraint = buildStructureFirstRewriteConstraint(
          residualPlanForPolish ?? null,
          residualDecision,
        )
      }
      const polishedContent = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildDeepChapterRevisionPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            currentContent,
            literaryIssues,
            input.userRequest,
            input.chapterNumber,
            input.goldenThreeChapter,
          ) + trackBConstraint + residualConstraint + writingTaskExtra,
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段5.7：Track B 文学抛光", partial)),
        { max_tokens: lengthSpec.maxOutputTokens },
        cachePrefix,
        notePartial,
        undefined,
        watchdog,
      )
      assertNotAborted(signal, USER_ABORT_MESSAGE)
      if (polishedContent.trim()) {
        const prevSlop = scoreCandidate(currentContent)
        const nextSlop = scoreCandidate(polishedContent)
        const guard = shouldAcceptTrackBPolishText({
          beforeText: currentContent,
          afterText: polishedContent,
          beforeSlop: prevSlop,
          afterSlop: nextSlop,
          policy: trackBPolicy,
        })
        if (guard.accept) {
          currentContent = polishedContent
          revised = true
          callbacks.onThinking?.(formatStageThinking(
            "阶段5.7：Track B 多目标通过",
            guard.reason,
          ))
        } else {
          callbacks.onThinking?.(formatStageThinking(
            "阶段5.7：文学抛光回退",
            `多目标护栏拒绝：${guard.reason}${guard.fix1Violation ? "（FIX-1）" : ""}。已回退门控绿稿。`,
          ))
        }
        const stage57 = await runFullReviewWithSixDim(currentContent, input.chapterNumber, input.projectPath, deps, signal, contextPack, callbacks)
        reviewResults = applyChapterContractCheck(taskBrief, currentContent, stage57.reviewResults)
        decisionGates = buildDecisionGates(reviewResults, retryCount, undefined, resolveDeAiGenre(input.genre))
        await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_revision", {
          taskBrief,
          draftContent,
          reviewResults,
          dimensionResults: stage57.dimensionResults,
          currentContent,
          decisionGates,
          retryCount,
        }))
      }
    }
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
