import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, setMetricsFilePath, setMetricsTraceId, flushMetrics, setContinuityMetricsFilePath, flushContinuityMetrics, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { logger, setLogTraceId, toErrorMessage } from "@/lib/utils"
import { resolveTaskExtraPrompt } from "./task-customization"
import { useWikiStore } from "@/stores/wiki-store"
import { buildContextPack, contextPackToPrompt, type ContextPack } from "./context-engine"
import {  } from "./voiceprint-alignment"
import {  } from "./adversarial/author-fingerprint"
import { reviewChapter, type NovelReviewResult } from "./review-adapter"
import {
  runSixDimensionReview,
  type SixReviewDimensionKey,
  type DimensionReviewResult,
} from "./dimension-review-adapter"
import {  } from "./novel-skill-hooks"
import { formatStageThinking } from "./chapter-utils"
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
  type StateDelta,
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
  /**
   * 三门证据落账注入（write / continue / rewrite / polish / resume 共用同一
   * 写入口）。缺省 → 生产 fs 账本；测试注入内存实现，非致命失败不影响正文。
   */
  gateEvidence?: ChapterGateEvidenceDeps
}

const defaultDeps: DeepChapterGenerationDeps = {
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
  generateDraft,
  generateTaskBrief,
  runSceneBreakdownStage,
} from "./deep-chapter-context-assembly"
import { runReviewAndRepair } from "./deep-chapter-review-repair"

export async function runDeepChapterGeneration(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps: DeepChapterGenerationDeps = defaultDeps,
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

  // 阶段0：前情分析
  const previousChaptersAnalysis = await runPreviousChaptersAnalysis(
    input, writingConfig, novelConfig, resumeCheckpoint, callbacks, signal,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段1：上下文装配
  const { loadSmartDeAiSkill } = await import("./de-ai-adapter")
  const ctx1 = await assembleContext(
    deps, input, callbacks, resumeCheckpoint, signal, previousChaptersAnalysis, loadSmartDeAiSkill,
  )
  const { contextPack, customDeAiSkill, userMemoryStore, outlinePrompt, contextPrompt: rawContextPrompt, cachePrefix } = ctx1
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

  // 阶段1.5：场景拆解
  await runSceneBreakdownStage(
    input, novelConfig, resumeCheckpoint, contextPack, callbacks, signal, notePartial,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段2 + 2.5：任务书生成 + 纠偏
  const taskBrief = await generateTaskBrief(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, contextPrompt, lengthSpec, resumeCheckpoint, contextPack, cachePrefix,
    watchdog,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  pollWatchdogAtBoundary()
  await statusMerger?.drain()

  // 阶段3 + 3.5：正文初稿 + 草稿纠偏（CORR-107：first-wins + 成功清除）
  // draft 阶段内任何 partial 经 draftNotePartial 进入 partialReason（首因保留）；
  // 仅当整阶段零 partial 且草稿验证完整（非空、达 minChars、非 meta）时，才在编排层补清早期 scene 残留。
  // 降级/兜底（fallback taskBrief、空 polish 回退、repeat 截断、resume 短路复用旧草稿）不满足“完整”谓词，绝不 clear。
  // generateDraft 内部初稿/纠偏/扩写完整成功已 via onCompleteClearPartial 清除，此处为幂等补清（clear null 安全）。
  // ISS-20260709-045: draft 污染标记收拢进 partialState（单源；读位直读状态对象）。
  const draftNotePartial = (reason: string) => {
    noteDraftPartialState(partialState, reason)
  }
  const rawDraftContent = await generateDraft(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, contextPrompt, taskBrief, lengthSpec, resumeCheckpoint, cachePrefix,
    draftNotePartial, clearPartial, watchdog,
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

  // 阶段4-5：AI 审稿 + 返修循环
  const stage45 = await runReviewAndRepair(
    input, novelConfig, deps, signal, callbacks,
    contextPack, draftContent, resumeCheckpoint,
    writingConfig, outlinePrompt, contextPrompt, taskBrief, lengthSpec, cachePrefix, notePartial,
    watchdog,
  )
  // MAX_GATE_RETRY 转人工：原内联此处 callbacks.onFinalContent + 完整 return。
  // 提取后在编排器层构造 result（能访问 partialReason，partial 语义绝对正确）。
  const mergedReviewResults = [
    ...thrilSoftGateReviewResults,
    ...stateDeltaReviewResults,
    ...stage45.reviewResults,
  ]
  // 三门证据落账（write/continue/rewrite/polish/resume 共用同一路径）：
  // 不落证据 → 首页证据看板恒「未评估」，且「续写是否与从头写同一套门」无从审计。
  // recordChapterGateEvidence 自身非致命（IO 失败只回 error，不抛）。
  await recordChapterGateEvidence(
    {
      projectPath: input.projectPath,
      decisionGates: stage45.decisionGates,
      retryCount: stage45.retryCount,
      chapterNumber: input.chapterNumber,
      modelId: writingConfig.model,
      llmMediated: Boolean((novelConfig as { deepChapterReview?: boolean }).deepChapterReview),
      intent: input.resumeCheckpoint ? "resume" : undefined,
    },
    deps.gateEvidence,
  )
  if (stage45.manualHandoff) {
    callbacks.onFinalContent?.(stage45.currentContent)
    // DEBT-20260822-t34-wiring: run-end flush of pending status writes.
    // R1-F2：flush 失败不再裸吞，记 warn 留痕（仍不阻断 run 返回）。
    if (statusMerger) {
      await statusMerger.flush().catch((err: unknown) => {
        logger.warn("deep-chapter", `status flush failed (manualHandoff): ${toErrorMessage(err)}`)
      })
    }
    return {
      finalContent: stage45.currentContent,
      taskBrief,
      draftContent,
      reviewResults: mergedReviewResults,
      revised: stage45.revised,
      decisionGates: stage45.decisionGates,
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
  const finalContentNorm = finalNormalized.text
  if (finalNormalized.changed) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段7：终稿规范化",
      `终稿回流规范化: 替换 ${finalNormalized.replacementCount} 处, 删除 ${finalNormalized.deleteCount} 处`,
    ))
  }
  callbacks.onFinalContent?.(finalContentNorm)
  // 54 号设计 ⑨: avoid-ai 审计 (51 type 目录吸收, 审计型只读)。
  // final 产出后跑声纹审计, 结果经 onThinking 提示 + 日志留痕;
  // Track B soft (english-heavy 引擎对中文网文仅参考), 不设产品硬门。
  try {
    const { analyzeAvoidAiPatterns, formatAvoidAiPatternsSummary } = await import("./avoid-ai-patterns")
    const audit = analyzeAvoidAiPatterns(finalContentNorm)
    callbacks.onThinking?.(formatStageThinking(
      "阶段6.5：avoid-ai 审计",
      formatAvoidAiPatternsSummary(audit),
    ))
    // 55 号设计 W2-4 (54⑨ 收尾): 审计摘要持久化 (additive-optional, 仅计数/类型枚举)。
    // 写入走 saveNovelSessionStatus 唯一真源; 失败仅 warn 不阻塞。
    try {
      const { loadNovelSessionStatus, saveNovelSessionStatus } = await import("./novel-session-status")
      const status = await loadNovelSessionStatus(input.projectPath)
      if (status) {
        const issueTypes = [...new Set(audit.issues.map((i) => i.type))]
        const next = {
          ...status,
          avoid_ai_summary: {
            score: audit.score,
            label: audit.label,
            issueCount: audit.issues.length,
            issueTypes,
            updatedAt: new Date().toISOString(),
          },
        }
        // R4 共识（deepseek+glm）: next 是新建对象，next !== status 对新对象恒为 true（死守卫），
        // 原行为即「总是落盘」。去除恒真判断，行为不变、意图显式。
        await saveNovelSessionStatus(input.projectPath, next)
      }
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
  // 55 号设计 W2-5 (B-01): 数值事实检查 (warn-only, 不硬短路)。
  // 对最终交付物跑跨章数值一致性检查, 结果经 onThinking 提示 (Consistency 轴软信号)。
  // 正式章节正文位于 .novel/chapters/{n}/draft.md (context-data-sources.ts:67)。
  try {
    const { runNumericFactCheck } = await import("./numeric-fact-checker")
    const { readFile } = await import("@/commands/fs")
    const { listDirectory } = await import("@/commands/fs")
    const { normalizePath } = await import("@/lib/path-utils")
    const chaptersDir = `${normalizePath(input.projectPath)}/.novel/chapters`
    const dirs = await listDirectory(chaptersDir).catch(() => [])
    const chapterDirs = dirs
      .filter((d) => d.is_dir && /^\d+$/.test(d.name))
      .map((d) => ({ chapter: Number(d.name), dir: d.name }))
      .sort((a, b) => a.chapter - b.chapter)
    const chapters: { chapter: number; text: string }[] = []
    for (const { chapter, dir } of chapterDirs) {
      const text = await readFile(`${chaptersDir}/${dir}/draft.md`).catch(() => "")
      if (text) chapters.push({ chapter, text })
    }
    if (chapters.length > 0) {
      // 末章 (当前生成章) 替换为最终交付物, 保证审计对象 = 交付物
      const last = chapters[chapters.length - 1]
      last.text = finalContentNorm
      const numericFindings = runNumericFactCheck(chapters)
      if (numericFindings.length > 0) {
        callbacks.onThinking?.(formatStageThinking(
          "阶段6.6：数值一致性检查",
          `发现 ${numericFindings.length} 处数值矛盾候选 (warn-only): ${numericFindings.map((f) => f.message).join(" | ")}`,
        ))
      }
    }
  } catch {
    // 非致命: 数值检查失败不影响生成
  }
  // 54 号设计 ④: chase_debt 记账人接线 (webnovel-writer ChaseDebtMeta 吸收)。
  // 章节提交时: 结尾钩子含承诺型悬念 → 创建追读债务; 既有未偿债务计息。
  // additive: status.json 无 chase_debt 字段或写入失败 → 仅 warn 不阻塞。
  try {
    const { loadNovelSessionStatus, saveNovelSessionStatus, createChaseDebtFromHook, accrueAllChaseDebtInterest } = await import("./novel-session-status")
    const status = await loadNovelSessionStatus(input.projectPath)
    if (status) {
      const chapter = input.chapterNumber ?? 0
      const endingHook = finalContentNorm.slice(-200)
      const withDebt = accrueAllChaseDebtInterest(createChaseDebtFromHook(status, chapter, endingHook), chapter)
      if (withDebt !== status) {
        await saveNovelSessionStatus(input.projectPath, withDebt)
      }
    }
  } catch (err) {
    callbacks.onThinking?.(formatStageThinking(
      "追读债务记账",
      `chase_debt 记账跳过 (非致命): ${toErrorMessage(err)}`,
    ))
  }
  // ISS-20260714-002: explicit run-end flush of buffered LLM metrics. Fire-
  // and-forget (void) — the run is done, metrics persist async after return.
  // Abort/throw paths rely on the collectLLMMetric auto-flush safety valve
  // (buffer≥500) since this line is unreachable on a throw.
  void flushMetrics()
  // ISS-20260719-CE-001: explicit run-end flush of buffered continuity metrics.
  // Fire-and-forget (void) — same pattern as flushMetrics above. flushContinuityMetrics
  // internally re-buffers on write failure (llm-client.ts :229) so a flush error
  // never breaks the run return; no-op when the buffer is empty (:209).
  void flushContinuityMetrics()
  // DEBT-20260822-t34-wiring: run-end flush of pending status writes.
  // R1-F2：同上，失败记 warn 留痕。
  if (statusMerger) {
    await statusMerger.flush().catch((err: unknown) => {
      logger.warn("deep-chapter", `status flush failed (run-end): ${toErrorMessage(err)}`)
    })
  }
  return {
    finalContent: finalContentNorm,
    taskBrief,
    draftContent,
    reviewResults: mergedReviewResults,
    revised: stage45.revised,
    decisionGates: stage45.decisionGates,
    manualReviewRequired: false,
    retryCount: stage45.retryCount,
    partial: partialState.reason !== null,
    partialReason: partialState.reason,
    contextUsage: contextPack.contextUsage,
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
    const { issues, reviewResults, source } = runStateDeltaLightCheckOnDraft(
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
    const delta = structuredRaw
      ? (JSON.parse(structuredRaw) as StateDelta)
      : ({} as StateDelta)
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
        structuredRaw ? (JSON.parse(structuredRaw) as StateDelta) : ({} as StateDelta),
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
        resolveDeAiGenre(input.genre),
        writingTaskExtra,
      ),
    }],
    deps,
    signal,
    (partial) => callbacks.onThinking?.(formatStageThinking("阶段6：简单审查与去AI味", partial)),
    { max_tokens: lengthSpec.maxOutputTokens },
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

