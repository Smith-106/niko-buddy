import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, isRequestCancelledError, setMetricsFilePath, setMetricsTraceId, flushMetrics, setContinuityMetricsFilePath, flushContinuityMetrics, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { logger, setLogTraceId, toErrorMessage } from "@/lib/utils"
import { resolveTaskExtraPrompt } from "./task-customization"
import { getNovelRoleTemperature, resolveOptionalRoleModel } from "./model-resolver"
import { useWikiStore } from "@/stores/wiki-store"
import {
  buildContextPack,
  contextPackToPrompt,
  hasContextPackLoadFailure,
  type ContextPack,
} from "./context-engine"
import {  } from "./voiceprint-alignment"
import {  } from "./adversarial/author-fingerprint"
import { reviewChapter, isReviewParseError, type NovelReviewResult } from "./review-adapter"
import {
  runSixDimensionReview,
  type SixReviewDimensionKey,
  type DimensionReviewResult,
} from "./dimension-review-adapter"
import {  } from "./novel-skill-hooks"
import { formatStageThinking } from "./chapter-utils"
import { ensureChapterTitle, generateChapterTitle, type ChapterTitleSource } from "./chapter-title-generator"
import i18n from "@/i18n"
import { recordChapterGateEvidence, type ChapterGateEvidenceDeps } from "./deep-chapter-gate-evidence"
import { formatNormalize } from "./format-normalizer"
import { resolveDeAiGenre } from "./genre-codes"
import type { GoldenThreeChapterRequest } from "./golden-three-chapters"
import {
  resolveChapterLengthSpec,
  type ChapterLengthSpec,
  buildDeepChapterFinalPolishPrompt,
} from "./deep-chapter-prompts"
import {  } from "@/lib/user-memory/session"
import type { UserMemoryStore } from "@/lib/user-memory/types"
import {
  updateNovelSessionStatus,
  type RouteShellMode,
  type AntiAiMode,
} from "./novel-session-status"
import {
  type StageJournalRuntime,
} from "./stage-output-journal"
import {
} from "./character-cognition"
import { loadCharacterStates } from "./character-state"
import {
  extractEmbeddedStateDeltaJson,
  runStateDeltaLightCheckOnDraft,
  markStateDegraded,
  resolveStateSettlement,
} from "./state-delta-light-check"
import {
  formatThrillSoftGateThinkingWithAck,
  isThrillSoftGateAcknowledged,
  runOutlineThrillSoftGate,
} from "./outline-thrill-checkpoints"
import {
  type ChapterStructurePlan,
} from "./chapter-structure-plan"
import {
  type ResidualRewriteMode,
} from "./residual-rewrite-policy"
import {  } from "./structure-first-rewrite"
import {
  pollWatchdog,
  type WatchdogState,
} from "./watchdog"
import { createStatusWriteMerger } from "./status-write-merge"

export interface DeepChapterGenerationInput {
  projectPath: string
  userRequest: string
  chapterNumber?: number
  /**
   * F07（R04=a）：用户在会话层已确认的章节计划原文。
   *
   * 原样透传：生成链只做空值守卫，**不得截断/改写/摘要**（用户确认过的文本即强制约束）。
   * 消费点：阶段2任务书提示词与阶段3正文初稿提示词（均拼在稳定上下文前缀之后），
   * 故缺省 undefined 时生成链行为逐字节不变。
   */
  planBlueprint?: string
  goldenThreeChapter?: GoldenThreeChapterRequest
  dismantlingReferenceDirective?: string
  /**
   * Wave 3 (v2.5.0): 计划模式预填快照（可选，additive）。
   * 缺省 undefined → 生成链零行为变化（task-brief 与现状字节级一致）。
   * 存在时在 repair/fallback 循环之后、structure-plan 注入点同位置追加
   * 【本章确定性范围】块（marker 守卫防重复，append-only 不重写既有字段）。
   */
  planningPlan?: import("./planning").ChapterPlanView
  /**
   * 54 号设计 ⑧: 题材 (genre) 注入 (prosecreator 14 流派基线吸收)。
   * 可选 additive: 缺省 undefined → 生成链零行为变化; 传入时 final-polish
   * 提示词附加流派结构化规则 (仅低严重度微调)。
   */
  genre?: string
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
  /**
   * Medium-deepen residual hooks (fail-open). Omitting all residual fields leaves
   * the normal draft / Track A path unchanged. When residualOverallMedian is set
   * (campaign residual chapter), structure-first inject + residual policy apply.
   */
  residualOverallMedian?: number
  residualRewriteMode?: ResidualRewriteMode
  chapterStructurePlan?: ChapterStructurePlan | null
  residualLengthPreserving?: boolean
  /**
   * T10 × T09：route 薄壳模式开关（additive-optional，项目级隔离）。
   * 缺省 undefined → legacy（既有字节级等价顺序流水线，A-35 不破）；
   * "route" → stage 推进改读 control-kernel.route()（T33 注册表落地前预览路径）。
   */
  routeShellMode?: RouteShellMode
  /**
   * T10 × T09：三档反 AI 模式（additive-optional，项目级隔离）。
   * 缺省 undefined → off（现状：anti_ai 失败即挡）；
   * route 模式下由 route() 门控消费（off/warn/block，T21）。
   */
  antiAiMode?: AntiAiMode
  /**
   * DEBT-20260822-t34-wiring: watchdog 注入点（可选，additive）。
   * 缺省 undefined → 无卡死检测（现状字节级不变）。
   * 存在时在 collectModelText 的 onToken 中喂入 feedToken，
   * 在阶段边界处调用 pollWatchdog 判定卡死。
   */
  watchdog?: WatchdogState
  /**
   * DEBT-20260822-t34-wiring: status 快照 writer 注入点（可选，additive）。
   * 缺省 undefined → checkpoint/指标写入走现有路径（保持不变）。
   * 存在时创建 StatusWriteMerger 包装该 writer，checkpoint 关键写入
   * 走 merger.schedule(critical)，阶段边界 drain，完成时 flush。
   */
  snapshotWriter?: (payload: string) => Promise<void>
  /**
   * F8 (Round-8 journal 接线): 编排面 LLM 工件缓存（stage-output-journal 薄编排）。
   * 缺省 undefined → 关闭（零行为变化：直接走 LLM，与改前字节级一致）。
   * 传入时阶段2任务书经 resolveStageOutput 做 digest-keyed 去重：崩溃后同 digest
   * 重入即命中（hit=true），跳过 producer（即跳过 LLM 重调用）；TTL 过期视为未命中。
   * 结构镜像 anti-ai-telemetry-sink 的注入注释风格：全部副作用经 deps 注入。
   */
  stageJournal?: StageJournalRuntime,
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
  /** A01: 仅在最后一次实跑语义审查送审正文逐字节等于最终产出时为 true；不表示门禁通过。 */
  finalConsistencyReviewed?: boolean
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
  /**
   * Wave 5 (v2.5.0): 本次生成上下文用量快照（来自 buildContextPack 的
   * additive pack.contextUsage）。缺省 undefined（空包降级/非 build 路径）
   * → 完成页不渲染 ring。
   */
  contextUsage?: import("../context-usage").ContextUsage
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
  revisionReviewPending?: boolean
  decisionGates?: DeepChapterDecisionGates
  retryCount?: number
  manualReviewRequired?: boolean
  /** W1-01: 最后一次完成完整语义审查时对应的正文（仅在已审检查点持久化，用于断点恢复透传）。 */
  semanticallyReviewedContent?: string
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
  /**
   * 三门证据落账注入（write / continue / rewrite / polish / resume 共用同一
   * 写入口）。缺省 → 生产 fs 账本；测试注入内存实现，非致命失败不影响正文。
   */
  gateEvidence?: ChapterGateEvidenceDeps
}

/**
 * RV-001：标题来源 → i18n 键（固定映射，不用模板字面量拼 key）。
 *
 * `disabled` 不发提示（开关关掉时静默，不算异常），故不在此表内。
 */
const TITLE_SOURCE_KEYS: Record<Exclude<ChapterTitleSource, "disabled">, string> = {
  content: "mainControl.draftTitleSourceModel",
  generated: "mainControl.draftTitleSourceGenerated",
  fallback: "mainControl.draftTitleSourceFallback",
}

export const DEFAULT_DEEP_CHAPTER_DEPS: DeepChapterGenerationDeps = {
  buildContextPack,
  contextPackToPrompt,
  reviewChapter,
  runSixDimensionReview,
  streamChat,
}


// DEBT-20260824-T24-02 偿还：本地硬编码集已迁移到 review-adapter.resolveReviewGateKey
// （GATE_MAPPING 唯一真源），保留以下引用锚点防止遗留 import 被误删。
// CONSISTENCY_REVIEW_TYPES / ANTI_AI_REVIEW_TYPES 已删除，resolveDecisionGateKey
// 现在委托给 review-adapter 的 resolveReviewGateKey。


// ── route-shell 子模块（M8-2 增量切片）─────────────────────────
// T10 route 薄壳 + role→model 解析 + route-runtime 纯函数已抽离到
// deep-chapter-route-shell.ts；import 供本模块编排使用 + re-export 保持
// 外部 import 路径不变（route-shell.spec / b-improvements 零改动）。
import {
  buildDeepChapterRouteRuntime,
  computeStepDigest,
  resolveNextStageViaRoute,
  resolveRoleModel,
  selectRouteStageConfig,
} from "./deep-chapter-route-shell"
export {
  buildDeepChapterRouteRuntime,
  computeStepDigest,
  resolveAntiAiMode,
  resolveDeepChapterRoleConfigs,
  resolveNextStageViaRoute,
  resolveRoleModel,
  resolveRouteShellMode,
  selectRouteStageConfig,
  shouldUseDeepChapterGeneration,
  stageShortLabelForDisplay,
} from "./deep-chapter-route-shell"
export type { DeepChapterRouteRuntime } from "./deep-chapter-route-shell"


// ── 决策门子模块（arch-risk W4 god-object 拆分）─────────────────────────
// DeepChapterDecisionGate*/buildDecisionGates/collect*Issues/createEmpty* 已抽离
// 到 deep-chapter-decision-gates.ts；import 供本模块编排使用 + re-export 保持
// 外部 import 路径不变。改决策门逻辑只动子模块，不再动本编排体。
import {
  assertNotAborted,
  countChapterChars,
} from "./deep-chapter-utils"
import {
  isMetaDraftContent,
} from "./deep-chapter-task-brief"

// F4-6（Round-4 评估）：thinking 格式化簇已迁至 ./deep-chapter-utils
//（巨石拆分第 6 步）。本地 import 供内部调用点使用，并 re-export 保持既有
// import 面。
export {
  formatContextThinking,
  formatReviewIssueList,
  formatReviewThinking,
  resolveGoldenThreeThinkingHints,
} from "./deep-chapter-utils"

import {
  buildDecisionGates,
  collectBlockingIssues,
} from "./deep-chapter-decision-gates"
export {
  buildDecisionGates,
  collectBlockingIssues,
  collectLiteraryPolishIssues,
  collectRepairIssues,
  createEmptyDecisionGate,
  emptyDecisionGates,
} from "./deep-chapter-decision-gates"
// ISS-20260712-ARCH-1: trimForThinking 供 deep-chapter-task-brief 复用，re-export。
export { trimForThinking } from "./deep-chapter-utils"

// ── 审查执行子模块（arch-risk W4 god-object 拆分）─────────────────────────
// runFullReviewWithSixDim 已抽离到 deep-chapter-review.ts；import 供编排使用 +
// re-export 保持外部 import 路径不变。
import {  } from "./deep-chapter-review"
export { runFullReviewWithSixDim } from "./deep-chapter-review"

// ── 连贯性预检子模块（arch-risk W4 god-object 拆分）───────────────────────
// runContinuityPreCheck/checkContinuityCritical/buildPlotForecastHint 已抽离到
// deep-chapter-continuity.ts；import 供编排使用。
import {
  runContinuityPreCheck,
} from "./deep-chapter-continuity"

// ── 运行时支撑 / 上下文装配 / 审稿返修子模块（P1 巨文件拆分）───────────────
// 常量与纯函数（残差策略/checkpoint 谓词/契约核对/流式收集）已抽离到
// deep-chapter-runtime-support.ts；阶段1-3 上下文装配与生成抽离到
// deep-chapter-context-assembly.ts；阶段4-5 审稿返修抽离到
// deep-chapter-review-repair.ts。本文件保留编排体。
// 对外 API 不变：以下符号仍从本模块 re-export（spec/调用方零改动）。
import {
  USER_ABORT_MESSAGE,
  applyChapterContractCheck,
  collectModelText,
  createPartialState,
  notePartialState,
  clearPartialState,
  noteDraftPartialState,
} from "./deep-chapter-runtime-support"
export {
  applyChapterContractCheck,
  evaluateResidualPolicyForInput,
  hasResidualOptIn,
  resolveStructurePlanForResidual,
} from "./deep-chapter-runtime-support"
import {
  assembleContext,
  formatSceneBreakdownForPrompt,
  generateDraft,
  generateTaskBrief,
  runSceneBreakdownStage,
} from "./deep-chapter-context-assembly"
import { runReviewAndRepair } from "./deep-chapter-review-repair"

/**
 * R2-W09 IC-02 门控守卫：当上下文包因整包构建失败降级为空包时，阻断绿灯自动采纳
 * （consistency 门不得为 passed，overall 不得为 pass/warning）。
 */
function applyContextPackFailureGateGuard(
  gates: DeepChapterDecisionGates,
  contextPackLoadFailed: boolean,
): DeepChapterDecisionGates {
  if (!contextPackLoadFailed) return gates
  const consistency =
    gates.consistency.status === "passed"
      ? {
          ...gates.consistency,
          status: "pending" as const,
          verdict: "pending" as const,
          manual_review_required: true,
        }
      : {
          ...gates.consistency,
          manual_review_required: true,
        }
  const overall =
    gates.overall === "pass" || gates.overall === "warning"
      ? ("pending" as const)
      : gates.overall
  return {
    ...gates,
    consistency,
    overall,
  }
}

export async function runDeepChapterGeneration(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps: DeepChapterGenerationDeps = DEFAULT_DEEP_CHAPTER_DEPS,
  signal?: AbortSignal,
): Promise<DeepChapterGenerationResult> {
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  // ISS-20260709-019/020: configure the observability sinks for this run.
  // setMetricsFilePath enables LLM metrics buffering (collectLLMMetric in
  // streamChat); setMetricsTraceId + setLogTraceId stamp every metric/log
  // line with this run's id so post-hoc diagnosis can correlate them. The
  // auto-flush safety valve in collectLLMMetric persists at 500 records;
  // an explicit run-end flushMetrics() is the follow-up (ISS-20260714-002).
  const metricsFile = `${input.projectPath.replace(/\\/g, "/")}/.novel/metrics.jsonl`
  setMetricsFilePath(metricsFile)
  // ISS-20260719-CE-001: configure the continuity metrics sink for this run.
  // setContinuityMetricsFilePath enables continuity metric persistence
  // (collectContinuityMetric buffers engine run records); without it the
  // path stays empty and the buffer only ever drains via the >=500 auto-flush
  // safety valve (collectContinuityMetric :191). An explicit run-end
  // flushContinuityMetrics() is the follow-up below. Same source pattern as
  // setMetricsFilePath above. CWE-532: ContinuityMetric records only counts
  // /ms/gate enum (llm-client.ts :156-167) — no chapter content / finding.ref
  // / override text reaches this sink. SEC-1: path is derived from
  // projectPath (non-user-input), same form as metricsFile.
  const continuityMetricsFile = `${input.projectPath.replace(/\\/g, "/")}/.novel/continuity-metrics.jsonl`
  setContinuityMetricsFilePath(continuityMetricsFile)
  const runTraceId = `ch${input.chapterNumber ?? "?"}`
  setMetricsTraceId(runTraceId)
  setLogTraceId(runTraceId)
  // Tracks whether any collectModelText stage took the transport-inactivity
  // partial-preserve branch. The first partial reason wins; later stages
  // (expansion/polish) keep the flag set so the caller routes the result to the
  // pause / continue-unfinished path instead of completeDeepChapterSession.
  // ISS-20260709-045: 散装闭包改类型化状态对象（CORR-107 语义不变：first-wins + 成功清除）。
  // notePartial/clearPartial 保留同名薄闭包，供既有阶段调用点零改动消费。
  const partialState = createPartialState()
  const notePartial = (reason: string) => {
    notePartialState(partialState, reason)
  }
  // CORR-107: a subsequent full successful generation supersedes an earlier
  // transport-inactivity partial — clear it so a recovered draft is not
  // falsely marked partial (which would route it to pause instead of complete).
  const clearPartial = () => {
    clearPartialState(partialState)
  }
  const resumeCheckpoint = input.resumeCheckpoint
  const baseWritingConfig = resolveWritingConfig(input.llmConfig)
  // route 壳可把内容阶段切到角色模型（T33 绑定的运行时落点）；legacy 下不会被赋值。
  let writingConfig = baseWritingConfig
  const novelConfig = input.novelConfig
  const lengthSpec = resolveCurrentChapterLengthSpec(novelConfig)

  // ── DEBT-20260822-t34-wiring：watchdog + status-write-merger ──
  // watchdog 注入点：缺省 undefined → 无卡死检测（现状字节级不变）。
  // 存在时 collectModelText 的 onToken 中喂入 feedToken，阶段边界处 poll。
  const watchdog = input.watchdog
  // snapshotWriter 注入点：缺省 undefined → 无 merger（现状字节级不变）。
  // 存在时创建 StatusWriteMerger 包装该 writer 并管理其生命周期。
  const statusMerger = input.snapshotWriter
    ? createStatusWriteMerger(
        { write: input.snapshotWriter, now: () => Date.now() },
      )
    : undefined

  /** DEBT-20260822-t34-wiring: 阶段边界轮询 watchdog + drain merger。缺省无操作。 */
  const pollWatchdogAtBoundary = () => {
    if (watchdog) {
      pollWatchdog(watchdog, Date.now())
    }
  }

  // ── T10 薄编排化：route() 接入（默认 legacy 分支，A-35 字节级等价不破）──
  // legacy（route_shell_mode 缺省/非 "route"）：routeInstruction === null，
  // 下方既有顺序流水线一字不改运行，所有现有 deep-chapter *.spec.ts 零回归。
  // route：routeInstruction 由 control-kernel.route() 纯函数裁定（13 分支互斥），
  // 驱动阶段机；现有测试均走 legacy，route 分支 v8 ignore 不计入覆盖率。
  const routeRuntime = buildDeepChapterRouteRuntime(input, resumeCheckpoint, novelConfig)
  const routeInstruction = resolveNextStageViaRoute(input, novelConfig, routeRuntime)
  if (routeInstruction) {
    /* v8 ignore start */
    // T07 × T09 step_digest：基于 checkpoint-digest 计算当前步骤幂等摘要（落 status.json 用）。
    const stepDigest = await computeStepDigest(routeInstruction.action, routeRuntime)
    // DEBT-20260820-01: 经 statusMerger 写 status.json.step_digest
    if (statusMerger) {
      await statusMerger.schedule(
        JSON.stringify({ step_digest: stepDigest }),
        "non_critical",
      )
    }
    // T33 角色绑定：按 route() 裁定的角色取真实 per-role 模型（未配置角色模型时
    // 回退写作模型，与旧行为位级等价）。内容角色会真正接管本次内容阶段的执行
    // 模型（selectRouteStageConfig）；审阅类角色仍由 review-adapter 解析，避免
    // reviewModel 双重应用。
    const routeRoleConfig = resolveRoleModel(routeInstruction.role, { writingConfig: baseWritingConfig, novelConfig })
    writingConfig = selectRouteStageConfig(routeInstruction.role, routeRoleConfig, baseWritingConfig)
    callbacks.onThinking?.(formatStageThinking(
      "阶段路由(route)",
      `route() 裁定: action=${routeInstruction.action} role=${routeInstruction.role ?? "-"} model=${routeRoleConfig.model} stageModel=${writingConfig.model} reason=${routeInstruction.reason}`,
    ))
    /* v8 ignore stop */
  }

  // 可选角色模型槽位解析：槽位留空时原样返回 writingConfig（零行为变更、零 store 读取）。
  const plannerConfig = resolveOptionalRoleModel(writingConfig, novelConfig, "planner")
  const polishConfig = resolveOptionalRoleModel(writingConfig, novelConfig, "polish")

  // 阶段0：前情分析
  const previousChaptersAnalysis = await runPreviousChaptersAnalysis(
    input, plannerConfig, novelConfig, resumeCheckpoint, callbacks, signal,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段1：上下文装配（Phase 1 统一 De-AI 运行时：优先 de-ai-skills.json → de-ai-skill.txt → 场景 bundle + 分级覆盖）
  const { loadUnifiedDeAiSkillPrompt } = await import("./de-ai-adapter")
  const ctx1 = await assembleContext(
    deps, input, callbacks, resumeCheckpoint, signal, previousChaptersAnalysis, loadUnifiedDeAiSkillPrompt,
  )
  const { contextPack, customDeAiSkill, userMemoryStore, outlinePrompt, contextPrompt: rawContextPrompt, cachePrefix } = ctx1
  const contextPackLoadFailed = hasContextPackLoadFailure(contextPack)
  const manualReviewReasons: string[] = []
  if (contextPackLoadFailed) {
    manualReviewReasons.push("上下文包构建失败（IC-02 降级空包），禁止自动采纳")
  }
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // TASK-007: 确定性连续性引擎生成层预检 (grill GRL-011 Decision 1.3 bullet 模式)。
  // 非阻断: 只产提醒级 bullet 文本拼入任务书 prompt 末尾, 不阻止 generateDraft。
  // 空守卫: 预检返回 "" 时 contextPrompt 不变 (不污染 prompt)。阻断职责归审查层
  // (TASK-008)。logger 双参 scope='continuity-engine'。
  const continuityPreCheckText = await runContinuityPreCheck(input.projectPath, input.chapterNumber)
  const contextPrompt = continuityPreCheckText ? rawContextPrompt + continuityPreCheckText : rawContextPrompt
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // Quality Foundation v1 / FR-S1: outline thril soft-gate (pre-write).
  // Non-blocking: surfaces checklist via onThinking; FIX-1 fails are warnings, not Track A errors.
  // Continuing generation after this stage is the acknowledge path (not silent skip).
  const thrilSoftGateReviewResults = runPreWriteOutlineThrillSoftGate(
    outlinePrompt,
    input.chapterNumber,
    novelConfig,
    callbacks,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段1.5：场景拆解（R2-W06 闭环接线：sceneBreakdownEnabled=true 且拆解非空时注入下游任务书与初稿）
  const sceneBreakdownResult = await runSceneBreakdownStage(
    input, novelConfig, resumeCheckpoint, contextPack, callbacks, signal, notePartial,
  )
  const sceneBreakdownPrompt = novelConfig.sceneBreakdownEnabled
    ? formatSceneBreakdownForPrompt(sceneBreakdownResult)
    : ""
  const stageContextPrompt = sceneBreakdownPrompt
    ? [contextPrompt, sceneBreakdownPrompt].filter(Boolean).join("\n\n")
    : contextPrompt
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段2 + 2.5：任务书生成 + 纠偏
  const taskBrief = await generateTaskBrief(
    input, plannerConfig, deps, signal, callbacks,
    outlinePrompt, stageContextPrompt, lengthSpec, resumeCheckpoint, contextPack, cachePrefix,
    watchdog,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段3 + 3.5：正文初稿 + 草稿纠偏（CORR-107：first-wins + 成功清除）
  const draftNotePartial = (reason: string) => {
    noteDraftPartialState(partialState, reason)
  }
  const rawDraftContent = await generateDraft(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, stageContextPrompt, taskBrief, lengthSpec, resumeCheckpoint, cachePrefix,
    draftNotePartial, clearPartial, watchdog,
    // F07: 用户确认的章节计划原文（原样透传；缺省 undefined → 提示词逐字节不变）。
    input.planBlueprint,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  // 编排层成功点：draft 阶段零 partial + 内容完整 ⇒ 清除早期 partial（真正完整成功；降级/兜底不调）。
  if (!partialState.draftStageHadPartial) {
    const draftComplete = rawDraftContent.trim().length > 0 && !isMetaDraftContent(rawDraftContent) && countChapterChars(rawDraftContent) >= lengthSpec.minChars
    if (draftComplete) {
      clearPartial()
    }
  }

  // 54 号设计 ②: format-normalizer 机械层接线 (character-arc humanizer-zh 吸收)。
  // Draft-first: 规范化只作用于草稿 (pending 阶段), 不直接回填正式正文;
  // 替换字典+AI 套话删除在审稿/返修前完成, 后续流程基于规范化草稿。
  // additive: 纯函数零 LLM, 默认 enableColloquial=false 保留口癖。
  const normalized = formatNormalize(rawDraftContent)
  if (normalized.changed) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段3.5：机械层规范化",
      [
        `替换 ${normalized.replacementCount} 处 · 删除套话 ${normalized.deleteCount} 处 · 感叹号降级 ${normalized.exclamationReduced} 处 · 连续标点修复 ${normalized.repeatedPunctFixed} 处`,
        normalized.text.length !== rawDraftContent.length
          ? `文本长度 ${rawDraftContent.length} → ${normalized.text.length}`
          : "文本长度不变",
      ].join("\n"),
    ))
  }
  const draftContent = normalized.text
  assertNotAborted(signal, USER_ABORT_MESSAGE)

  // Quality Foundation v1 / FR-C1: post-draft StateDelta light-check (warn-only by default).
  // Non-fatal: extract/check failures never block generation; results merge into reviewResults.
  const stateDeltaReviewResults = await runPostDraftStateDeltaLightCheck(
    input.projectPath,
    draftContent,
    input.chapterNumber,
    novelConfig,
    callbacks,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  const effectiveGenre = input.genre ?? novelConfig.genre
  // 阶段4-5：AI 审稿 + 返修循环（R2-W05：注入初稿 StateDelta 轻检 findings 与返修重检回调，纳入 P0 consistency 门）
  const recheckStateDelta = (content: string) =>
    runPostDraftStateDeltaLightCheck(input.projectPath, content, input.chapterNumber, novelConfig, callbacks)
  const stage45 = await runReviewAndRepair(
    input, novelConfig, deps, signal, callbacks,
    contextPack, draftContent, resumeCheckpoint,
    writingConfig, outlinePrompt, contextPrompt, taskBrief, lengthSpec, cachePrefix, notePartial,
    watchdog,
    stateDeltaReviewResults,
    recheckStateDelta,
  )
  // MAX_GATE_RETRY 转人工：原内联此处 callbacks.onFinalContent + 完整 return。
  // 提取后在编排器层构造 result（能访问 partialReason，partial 语义绝对正确）。
  const includeInitialStateDelta =
    !stage45.revised && !stage45.reviewResults.some((item) => item.type === "state_delta_light_check")
  const mergedReviewResults = [
    ...thrilSoftGateReviewResults,
    ...(includeInitialStateDelta ? stateDeltaReviewResults : []),
    ...stage45.reviewResults,
  ]
  if (stage45.manualHandoff) {
    const guardedHandoffGates = applyContextPackFailureGateGuard(stage45.decisionGates, contextPackLoadFailed)
    // 三门证据落账（manualHandoff 路径）：确保账本与最终返回值一致。
    // recordChapterGateEvidence 自身非致命（IO 失败只回 error，不抛）。
    await recordChapterGateEvidence(
      {
        projectPath: input.projectPath,
        decisionGates: guardedHandoffGates,
        retryCount: stage45.retryCount,
        chapterNumber: input.chapterNumber,
        modelId: writingConfig.model,
        llmMediated: Boolean((novelConfig as { deepChapterReview?: boolean }).deepChapterReview),
        intent: input.resumeCheckpoint ? "resume" : undefined,
      },
      deps.gateEvidence,
    )
    callbacks.onFinalContent?.(stage45.currentContent)
    // DEBT-20260822-t34-wiring: run-end flush of pending status writes.
    // R1-F2：flush 失败不再裸吞，记 warn 留痕（仍不阻断 run 返回）。
    if (statusMerger) {
      await statusMerger.flush().catch((err: unknown) => {
        /* v8 ignore next -- 台账 deep-chapter-generation.ts L635-639：legacy 路径 pending 恒空，flush 不抛错 */
        logger.warn("deep-chapter", `status flush failed (manualHandoff): ${toErrorMessage(err)}`)
      })
    }
    return {
      finalContent: stage45.currentContent,
      taskBrief,
      draftContent,
      reviewResults: mergedReviewResults,
      revised: stage45.revised,
      decisionGates: guardedHandoffGates,
      manualReviewRequired: true,
      retryCount: stage45.retryCount,
      partial: partialState.reason !== null,
      partialReason: partialState.reason,
      contextUsage: contextPack.contextUsage,
    }
  }
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段7：简单审查与去AI味
  const finalContent = await finalPolishChapter(
    polishConfig,
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
    userMemoryStore ?? undefined,
    lengthSpec,
    cachePrefix,
    notePartial,
    watchdog,
  )
  callbacks.onThinking?.(formatStageThinking(
    "阶段7：完成",
    stage45.revised
      ? "采用返修并完成简单审查、去AI味后的正文作为最终正文。"
      : "未发现阻断问题，已完成最后一遍简单审查与去AI味。",
  ))
  // 55 号设计 W1-4 (54② 收尾): 终稿回流幂等再规范化。
  // stage4.5 LLM 返修 + stage6 finalPolish 的输出不再过 normalizer (54 号半接线缺口);
  // 此处补一次幂等 normalize, 保证审计对象 = 最终交付物 (顺序不可颠倒)。
  // 纯函数零 LLM; 空内容/无替换 → 零开销路径。
  const finalNormalized = formatNormalize(finalContent)
  const normalizedContent = finalNormalized.text
  if (finalNormalized.changed) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段7：终稿规范化",
      `终稿回流规范化: 替换 ${finalNormalized.replacementCount} 处, 删除 ${finalNormalized.deleteCount} 处`,
    ))
  }
  // RV-001：标题生成真接线（唯一开关 = `novelConfig.autoGenerateChapterTitle` 真值）。
  // 只在「有章号 + 开关开 + 正文里没有富标题」时多跑一次 LLM；任何失败降级「第N章」，
  // 绝不阻断正文（ensureChapterTitle 内部 try/catch，本段不抛）。
  const titleOutcome = await ensureChapterTitle(normalizedContent, {
    chapterNumber: input.chapterNumber,
    llmConfig: writingConfig,
    autoGenerateChapterTitle: novelConfig.autoGenerateChapterTitle,
    signal,
    // 显式绑定生产 LLM 入口（便于审计「谁真的在调 generateChapterTitle」）。
    generateTitle: generateChapterTitle,
  })
  if (titleOutcome.source === "generated" || titleOutcome.source === "content") {
    callbacks.onThinking?.(formatStageThinking(
      "阶段7.5：章节标题",
      i18n.t("mainControl.draftTitleDone", {
        title: titleOutcome.title,
        source: i18n.t(TITLE_SOURCE_KEYS[titleOutcome.source]),
      }),
    ))
  } else if (titleOutcome.source === "fallback") {
    callbacks.onThinking?.(formatStageThinking(
      "阶段7.5：章节标题",
      i18n.t("mainControl.draftTitleFailed", {
        n: input.chapterNumber ?? 0,
        message: titleOutcome.error ?? "",
      }),
    ))
  }
  const finalContentNorm = titleOutcome.content
  let deliveredContent = finalContentNorm
  let finalDecisionGates = stage45.decisionGates
  let finalReviewResults = mergedReviewResults
  let finalSemanticallyReviewedContent = stage45.semanticallyReviewedContent

  // W1-02 / N-2v2 阶段7.6：终稿一致性复核
  // 当阶段7润色/终稿规范化/章节标题处理改动了已通过语义审查的正文时，在交付前补做一致性复核；
  // 若已处于部分超时截断状态（partialState.reason !== null）或最终交付正文为空，则跳过复核；
  // 若复核引入阻断错误或抛出解析/非取消异常，则完整回滚至阶段4-5已审查版本（用户取消异常继续上抛）。
  if (
    novelConfig.deepChapterReview
    && !stage45.manualReviewRequired
    && stage45.semanticallyReviewedContent !== undefined
    && stage45.semanticallyReviewedContent !== deliveredContent
    && partialState.reason === null
    && deliveredContent.trim().length > 0
  ) {
    assertNotAborted(signal, USER_ABORT_MESSAGE)
    callbacks.onThinking?.(formatStageThinking(
      "阶段7.6：终稿一致性复核",
      "检测到阶段7润色/规范化/标题处理改动了正文，正在对最终交付稿执行一致性复核。",
    ))
    let postSemanticCompleted = false
    const postReviewOptions = {
      onThinking: callbacks.onThinking,
      contextPack,
      novelConfig,
      llmConfig: input.llmConfig,
      ...(effectiveGenre ? { genre: effectiveGenre } : {}),
      onSemanticReviewCompleted: () => { postSemanticCompleted = true },
    }
    try {
      const postRaw = signal
        ? await deps.reviewChapter(input.projectPath, deliveredContent, input.chapterNumber, postReviewOptions, signal)
        : await deps.reviewChapter(input.projectPath, deliveredContent, input.chapterNumber, postReviewOptions)
      assertNotAborted(signal, USER_ABORT_MESSAGE)
      const postStateDelta = await recheckStateDelta(deliveredContent)
      const postReviewResults = [
        ...postStateDelta,
        ...applyChapterContractCheck(taskBrief, deliveredContent, postRaw || []),
      ]
      const postDecisionGates = buildDecisionGates(
        postReviewResults,
        stage45.retryCount,
        undefined,
        effectiveGenre,
        postSemanticCompleted,
      )
      const postBlockingIssues = collectBlockingIssues(postDecisionGates)
      // R2-REV-001：collectBlockingIssues 强制执行 Consistency(P0) > Anti-AI(P1) > Quality(P2)
      // 仅 error 阻断语义，自动豁免纯 Quality warning 题材阈值升级（isNonBlockingQualityUpgrade），
      // 与 decideDraftAdoptionGate 保持同源语义，避免误回滚去 AI 味/标题成果。
      if (postBlockingIssues.length > 0) {
        logger.warn("Deep Chapter", "Stage 7.6 final review detected blocking issues; rolling back to stage 4-5 reviewed content", {
          blockingCount: postBlockingIssues.length,
          overall: postDecisionGates.overall,
        })
        callbacks.onThinking?.(formatStageThinking(
          "阶段7.6：终稿复核回滚",
          `阶段7修改引入 ${postBlockingIssues.length} 个阻断问题，已自动回滚至阶段4-5已审查正文。`,
        ))
        deliveredContent = stage45.currentContent
        finalDecisionGates = stage45.decisionGates
        finalReviewResults = mergedReviewResults
        finalSemanticallyReviewedContent = stage45.semanticallyReviewedContent
      } else if (!postSemanticCompleted && stage45.semanticallyReviewedContent === stage45.currentContent) {
        // R2-W09 防反降级回滚：阶段4-5原稿已完成语义一致性复核，但阶段7.6润色后复检未完成语义核验时，
        // 禁止用未经语义核验的润色稿覆盖已审原稿，强制回滚保留已审原稿与原门控。
        logger.warn("Deep Chapter", "Stage 7.6 final review did not complete semantic check; rolling back to stage 4-5 reviewed content")
        callbacks.onThinking?.(formatStageThinking(
          "阶段7.6：终稿复核回滚",
          "润色后语义复核未完成，已回滚保留原已审稿。",
        ))
        deliveredContent = stage45.currentContent
        finalDecisionGates = stage45.decisionGates
        finalReviewResults = mergedReviewResults
        finalSemanticallyReviewedContent = stage45.semanticallyReviewedContent
      } else {
        finalDecisionGates = postDecisionGates
        finalReviewResults = [
          ...thrilSoftGateReviewResults,
          ...postReviewResults,
        ]
        finalSemanticallyReviewedContent = postSemanticCompleted ? deliveredContent : undefined
        callbacks.onThinking?.(formatStageThinking(
          "阶段7.6：终稿一致性复核通过",
          postSemanticCompleted
            ? "终稿复核未发现阻断问题，最终正文已通过完整语义审查。"
            : "终稿复核未发现阻断问题，但未完成全量语义审查回调（按 fail-closed 不签发 finalConsistencyReviewed）。",
        ))
      }
    } catch (err) {
      const isAbortError = typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError"
      if (
        signal?.aborted
        || isAbortError
        || (err instanceof Error && (err.message === USER_ABORT_MESSAGE || isRequestCancelledError(err)))
      ) {
        throw err
      }
      logger.warn("Deep Chapter", "Stage 7.6 final review failed; rolling back to stage 4-5 reviewed content", {
        error: toErrorMessage(err),
        parseError: isReviewParseError(err),
      })
      callbacks.onThinking?.(formatStageThinking(
        "阶段7.6：终稿复核回滚",
        `终稿复核失败（${toErrorMessage(err)}），已自动回滚至阶段4-5已审查正文。`,
      ))
      deliveredContent = stage45.currentContent
      finalDecisionGates = stage45.decisionGates
      finalReviewResults = mergedReviewResults
      finalSemanticallyReviewedContent = stage45.semanticallyReviewedContent
    }
  }

  // R2-W09 IC-02：上下文包整包构建失败时强制转人工且阻断绿灯自动采纳
  finalDecisionGates = applyContextPackFailureGateGuard(finalDecisionGates, contextPackLoadFailed)
  const finalManualReviewRequired = stage45.manualReviewRequired || contextPackLoadFailed
  if (manualReviewReasons.length > 0) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段7.6：人工复核约束",
      manualReviewReasons.join("\n"),
    ))
  }

  // 三门证据落账（阶段7.6落定后）：确保账本与最终返回值完全一致。
  // recordChapterGateEvidence 自身非致命（IO 失败只回 error，不抛）。
  await recordChapterGateEvidence(
    {
      projectPath: input.projectPath,
      decisionGates: finalDecisionGates,
      retryCount: stage45.retryCount,
      chapterNumber: input.chapterNumber,
      modelId: writingConfig.model,
      llmMediated: Boolean((novelConfig as { deepChapterReview?: boolean }).deepChapterReview),
      intent: input.resumeCheckpoint ? "resume" : undefined,
    },
    deps.gateEvidence,
  )

  callbacks.onFinalContent?.(deliveredContent)
  // 54 号设计 ⑨: avoid-ai 审计 (51 type 目录吸收, 审计型只读)。
  // final 产出后跑声纹审计, 结果经 onThinking 提示 + 日志留痕;
  // Track B soft (english-heavy 引擎对中文网文仅参考), 不设产品硬门。
  try {
    const { analyzeAvoidAiPatterns, formatAvoidAiPatternsSummary } = await import("./avoid-ai-patterns")
    const audit = analyzeAvoidAiPatterns(deliveredContent)
    callbacks.onThinking?.(formatStageThinking(
      "阶段6.5：avoid-ai 审计",
      formatAvoidAiPatternsSummary(audit),
    ))
    // 55 号设计 W2-4 (54⑨ 收尾) / N-5a: 审计摘要持久化 (additive-optional, 仅计数/类型枚举)。
    // 写入走 updateNovelSessionStatus 锁内原子事务（收进 session-status 锁避免锁外 RMW 覆写）；失败仅 warn 不阻塞。
    try {
      const issueTypes = [...new Set(audit.issues.map((i) => i.type))]
      const summary = {
        score: audit.score,
        label: audit.label,
        issueCount: audit.issues.length,
        issueTypes,
        updatedAt: new Date().toISOString(),
      }
      await updateNovelSessionStatus(input.projectPath, (status) => (
        status ? { ...status, avoid_ai_summary: summary } : null
      ))
    } catch (err) {
      callbacks.onThinking?.(formatStageThinking(
        "avoid-ai 审计持久化",
        `摘要写入跳过 (非致命): ${toErrorMessage(err)}`,
      ))
    }
  } catch (err) {
    callbacks.onThinking?.(formatStageThinking(
      "avoid-ai 审计",
      `审计跳过 (非致命): ${toErrorMessage(err)}`,
    ))
  }
  // 55 号设计 W2-5 (B-01) + R2：数值事实检查 (warn-only, 不硬短路)。
  // 优先读取 wiki/chapters/ 下已按章号排序的正式章节（过滤草稿后缀）；
  // 仅当 wiki/chapters/ 不存在或无可读 .md 正式章时平滑回退读取历史 .novel/chapters/{n}/draft.md。
  try {
    const { runNumericFactCheck } = await import("./numeric-fact-checker")
    const { readFile, listDirectory } = await import("@/commands/fs")
    const { normalizePath } = await import("@/lib/path-utils")
    const { parseFrontmatter } = await import("@/lib/frontmatter")
    const { extractChapterNumber, flattenMdFiles, isDraftChapterFile } = await import("./chapter-utils")
    const { parseChapterNumber } = await import("./chapter-meta")

    const root = normalizePath(input.projectPath).replace(/\/+$/, "")
    const chapters: { chapter: number; text: string }[] = []

    const wikiChaptersDir = `${root}/wiki/chapters`
    const wikiNodes = await listDirectory(wikiChaptersDir).catch((err: unknown) => {
      logger.warn("DeepChapter", `Stage 6.6 list wiki/chapters failed (non-fatal): ${toErrorMessage(err)}`)
      return []
    })
    const formalFiles = flattenMdFiles(wikiNodes).filter((f) => !isDraftChapterFile(f.name))
    const formalByChapter = new Map<number, string>()
    for (const file of formalFiles) {
      const raw = await readFile(file.path).catch((err: unknown) => {
        logger.warn("DeepChapter", `Stage 6.6 read formal chapter ${file.name} failed (non-fatal): ${toErrorMessage(err)}`)
        return ""
      })
      if (!raw) continue
      const parsed = parseFrontmatter(raw)
      const fmNum = parseChapterNumber(parsed.frontmatter?.chapter_number)
      const chNum = fmNum ?? extractChapterNumber(file.name.replace(/\.md$/i, ""))
      const body = parsed.body.trim()
      if (chNum !== null && Number.isSafeInteger(chNum) && chNum > 0 && body) {
        formalByChapter.set(chNum, body)
      }
    }
    for (const [chapter, text] of [...formalByChapter.entries()].sort((a, b) => a[0] - b[0])) {
      chapters.push({ chapter, text })
    }

    if (chapters.length === 0) {
      const chaptersDir = `${root}/.novel/chapters`
      const dirs = await listDirectory(chaptersDir).catch((err: unknown) => {
        logger.warn("DeepChapter", `Stage 6.6 list chapters dir failed (non-fatal): ${toErrorMessage(err)}`)
        return []
      })
      const chapterDirs = dirs
        .filter((d) => d.is_dir && /^\d+$/.test(d.name))
        .map((d) => ({ chapter: Number(d.name), dir: d.name }))
        .sort((a, b) => a.chapter - b.chapter)
      for (const { chapter, dir } of chapterDirs) {
        const text = await readFile(`${chaptersDir}/${dir}/draft.md`).catch((err: unknown) => {
          logger.warn("DeepChapter", `Stage 6.6 read chapter ${chapter} failed (non-fatal): ${toErrorMessage(err)}`)
          return ""
        })
        if (text) chapters.push({ chapter, text })
      }
    }

    if (chapters.length > 0) {
      // R2-W05：按目标 chapterNumber 精准定位替换（存在同号则替换，不存在则追加），
      // 再按 chapterNumber 升序排序，禁止盲目覆写 chapters[last]。
      const targetChapterNumber =
        input.chapterNumber !== undefined && Number.isSafeInteger(input.chapterNumber) && input.chapterNumber > 0
          ? input.chapterNumber
          : chapters[chapters.length - 1]!.chapter + 1
      const existingIdx = chapters.findIndex((item) => item.chapter === targetChapterNumber)
      if (existingIdx >= 0) {
        chapters[existingIdx] = { chapter: targetChapterNumber, text: deliveredContent }
      } else {
        chapters.push({ chapter: targetChapterNumber, text: deliveredContent })
        chapters.sort((a, b) => a.chapter - b.chapter)
      }
      const numericFindings = runNumericFactCheck(chapters)
      if (numericFindings.length > 0) {
        callbacks.onThinking?.(formatStageThinking(
          "阶段6.6：数值一致性检查",
          `发现 ${numericFindings.length} 处数值矛盾候选 (warn-only): ${numericFindings.map((f) => f.message).join(" | ")}`,
        ))
      }
    }
  } catch (err) {
    logger.warn("DeepChapter", `Stage 6.6 numeric fact check failed (non-fatal): ${toErrorMessage(err)}`)
  }
  void flushMetrics()
  void flushContinuityMetrics()
  if (statusMerger) {
    await statusMerger.flush().catch((err: unknown) => {
      /* v8 ignore next -- 台账 deep-chapter-generation.ts L834-838：同上（run-end 侧） */
      logger.warn("deep-chapter", `status flush failed (run-end): ${toErrorMessage(err)}`)
    })
  }
  return {
    finalContent: deliveredContent,
    taskBrief,
    draftContent,
    reviewResults: finalReviewResults,
    revised: stage45.revised,
    decisionGates: finalDecisionGates,
    manualReviewRequired: finalManualReviewRequired,
    retryCount: stage45.retryCount,
    partial: partialState.reason !== null,
    partialReason: partialState.reason,
    contextUsage: contextPack.contextUsage,
    ...(finalSemanticallyReviewedContent === deliveredContent && !finalManualReviewRequired ? { finalConsistencyReviewed: true } : {}),
  }
}

/**
 * Quality Foundation v1: pre-write outline thril soft-gate.
 * Heuristic checklist on outline text; never hard-blocks generation.
 * FIX-1 conflict is warning with type outline_thrill_fix1 (not ackable as literary pass).
 */
function runPreWriteOutlineThrillSoftGate(
  outlinePrompt: string,
  chapterNumber: number | undefined,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  callbacks: DeepChapterGenerationCallbacks,
): NovelReviewResult[] {
  if (novelConfig.outlineThrillSoftGateEnabled === false) return []
  try {
    const outlineText = [
      outlinePrompt,
      // chapter-specific outline may already be inside pack-rendered outlinePrompt
    ].filter(Boolean).join("\n\n")
    const { results, reviewResults, summary } = runOutlineThrillSoftGate(
      outlineText,
      chapterNumber,
    )
    const ackMap = useWikiStore.getState().thrilSoftGateAcknowledgedByChapter
    const acknowledged = isThrillSoftGateAcknowledged(ackMap, chapterNumber)
    const thinking = formatThrillSoftGateThinkingWithAck(results, acknowledged)
    callbacks.onThinking?.(formatStageThinking("阶段1.2：大纲 thril 软门", thinking))
    if (summary.fix1Blocked) {
      logger.warn("DeepChapter", "outline thril soft-gate: FIX-1 conflict cue", {
        chapterNumber,
        failCount: summary.failCount,
        acknowledged,
      })
    }
    return reviewResults
  } catch (error) {
    logger.warn("DeepChapter", "outline thril soft-gate failed (non-fatal)", {
      error: toErrorMessage(error), /* v8 ignore start */ /* v8 ignore stop */
    })
    return []
  }
}

/**
 * Quality Foundation v1: post-draft StateDelta light-check.
 * Loads character-states, heuristic extract + pure check, returns NovelReviewResult[].
 * Failures → empty array (non-fatal). Default warn-only via stateDeltaBlocksTrackA=false.
 */
async function runPostDraftStateDeltaLightCheck(
  projectPath: string,
  draftContent: string,
  chapterNumber: number | undefined,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  callbacks: DeepChapterGenerationCallbacks,
): Promise<NovelReviewResult[]> {
  if (novelConfig.stateDeltaLightCheckEnabled === false) return []
  try {
    const store = await loadCharacterStates(projectPath)
    const chapter = chapterNumber ?? 0
    // Structured extract: optional JSON block in draft (```json state-delta ...```) or none → heuristic.
    const structuredRaw = extractEmbeddedStateDeltaJson(draftContent)
    const { delta, issues, reviewResults, source } = runStateDeltaLightCheckOnDraft(
      draftContent,
      store.characters ?? [],
      chapter,
      {
        blocksTrackA: novelConfig.stateDeltaBlocksTrackA === true,
        structuredRaw,
      },
    )
    // 53 号报告 P0-3 接线④ additive: 接入 PASS/REPAIR/FAIL 三态结算
    // (inkos resolveStateSettlement 模式, AGPL 只借模式)。三态为新增输出,
    // 不改变 reviewResults 流: REPAIR → 触发一次重结算 (不重写正文),
    // markStateDegraded 判定重结算后是否仍 degraded; FAIL → 提示阻断语义
    // (实际阻断仍由 stateDeltaBlocksTrackA 开关控制, 现状保留)。
    // R2-W05：直接复用 runStateDeltaLightCheckOnDraft 已安全解析/降级的 delta，移除裸 JSON.parse。
    let settlement = resolveStateSettlement(delta, issues, source)
    const settlementLines: string[] = [`结算三态：${settlement.outcome}（${settlement.reason}）`]
    if (settlement.outcome === "REPAIR") {
      // 重结算一次: 重跑 light-check (同一输入), 再结算; 仍非 PASS → degraded
      const reRun = runStateDeltaLightCheckOnDraft(
        draftContent,
        store.characters ?? [],
        chapter,
        { blocksTrackA: novelConfig.stateDeltaBlocksTrackA === true, structuredRaw },
      )
      const reSettled = resolveStateSettlement(
        reRun.delta,
        reRun.issues,
        reRun.source,
      )
      settlement = markStateDegraded(reSettled)
      settlementLines.push(`重结算后：${settlement.outcome}${settlement.degraded ? "（degraded，需人工确认）" : "（已收敛）"}`)
    } else if (settlement.outcome === "FAIL") {
      settlementLines.push(`FAIL 阻断语义：${novelConfig.stateDeltaBlocksTrackA ? "阻断 Track A" : "warn-only（未启用阻断）"}`)
    }
    if (issues.length > 0 || source !== "empty") {
      callbacks.onThinking?.(formatStageThinking(
        "阶段3.7：StateDelta 轻检",
        [
          `抽取源：${source === "structured" ? "结构化 JSON" : source === "heuristic" ? "启发式" : "跳过"}`,
          ...settlementLines,
          issues.length === 0
            ? "无状态告警。"
            : [
                `发现 ${issues.length} 条状态提示（${novelConfig.stateDeltaBlocksTrackA ? "可阻断 Track A" : "默认 warn-only"}）：`,
                ...issues.slice(0, 8).map((i) => `- [${i.severity}] ${i.message}`),
                issues.length > 8 ? `…另有 ${issues.length - 8} 条` : "",
              ].filter(Boolean).join("\n"),
        ].join("\n"),
      ))
    }
    return reviewResults
  } catch (error) {
    logger.warn("DeepChapter", "StateDelta light-check failed (non-fatal)", {
      error: toErrorMessage(error),
    })
    return []
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
    logger.error("deep-chapter-generation", "前情分析失败", { error: toErrorMessage(error) })
  }
  return previousChaptersAnalysis
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
  userMemoryStore?: UserMemoryStore,
  lengthSpec: ChapterLengthSpec = resolveChapterLengthSpec(),
  cachePrefix?: string,
  onPartial?: (reason: string) => void,
  watchdog?: WatchdogState,
): Promise<string> {
  const writingTaskExtra = resolveTaskExtraPrompt(input.novelConfig, "writing")
  assertNotAborted(signal, USER_ABORT_MESSAGE)
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
        userMemoryStore,
        // 55 号设计 W1-1: 入口统一解析 (英文码 → 中文流派名; undefined/未知码 → 默认基线)。
        resolveDeAiGenre(input.genre ?? input.novelConfig.genre),
        writingTaskExtra,
        input.novelConfig.autoGenerateChapterTitle,
      ),
    }],
    deps,
    signal,
    (partial) => callbacks.onThinking?.(formatStageThinking("阶段6：简单审查与去AI味", partial)),
    { max_tokens: lengthSpec.maxOutputTokens, temperature: getNovelRoleTemperature("polish") },
    cachePrefix,
    onPartial,
    undefined,
    watchdog,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  return polished.trim() ? polished : currentContent
}

// ── 解析/缓存辅助子模块（arch-risk W4 god-object 拆分）────────────────────
// resolveCurrentChapterLengthSpec/resolveWritingConfig/applyCachePrefix 已抽离到
// deep-chapter-resolve.ts；import 供编排使用 + applyCachePrefix re-export。
import {
  resolveCurrentChapterLengthSpec,
  resolveWritingConfig,
} from "./deep-chapter-resolve"
export { applyCachePrefix } from "./deep-chapter-resolve"

