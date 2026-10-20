import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, setMetricsFilePath, setMetricsTraceId, flushMetrics, setContinuityMetricsFilePath, flushContinuityMetrics, type ChatMessage, type RequestOverrides, type StreamCallbacks } from "@/lib/llm-client"
import { setLogTraceId, logger } from "@/lib/utils"
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
import type { TaskRouteResult } from "./task-router"
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
  route,
  type ControlState,
  type Instruction,
  type RouteStage,
  type RouteGates,
  type RouteRole,
  type AntiAiMode as KernelAntiAiMode,
} from "./control-kernel"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  type StageJournalRuntime,
} from "./stage-output-journal"
import { resolveRoleModel as resolveRoleModelName, type ProjectModelConfig, type WritingRole } from "@/lib/llm/model-resolver"
import { resolveModelConfig } from "./model-resolver"
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


export function shouldUseDeepChapterGeneration(_route: TaskRouteResult | null, enabled: boolean): boolean {
  return enabled
}

// ───────────────────────────────────────────────────────────────────
// T10 薄编排化：route() 接入 + T09 additive 字段 + role→model 解析点预留
// ───────────────────────────────────────────────────────────────────
//
// 设计决策（自动判决）:
//   主循环 stage 推进改为『可』读 control-kernel.route() 获取下一步指令 → 分发；
//   但默认 route_shell_mode=legacy（T09 缺省），此时 resolveNextStageViaRoute
//   返回 null，既有顺序流水线一字不改运行 → 字节级等价 A-35 不破，
//   deep-chapter-golden.spec.ts 与全部现有 deep-chapter *.spec.ts 零回归。
//   route 分支仅当显式 route_shell_mode="route" 时激活（T33 注册表落地前预览路径，
//   现有测试均走 legacy，故该分支标记 v8 ignore 不计入覆盖率）。
//   route() 只决定『下一步做什么』（13 分支互斥纯函数，无 IO/LLM）；
//   『怎么做』由 resolveRoleModel 按角色解析模型（默认全角色单模型 = 现状）。

/**
 * T10 × T09：route 薄壳模式开关读取（项目级隔离，缺省 legacy）。
 * legacy = 既有字节级等价顺序流水线（默认）；route = 走 control-kernel.route() 决策。
 *
 * B2 说明（P1-7）：灰度由「缺省 legacy」本身承担 —— route 仅当调用方或项目配置
 * 显式写 routeShellMode="route"/"authoritative" 才激活（T10/#42 既定语义，
 * route-shell.spec 锁定）。B2 曾加 enableRouteShell 二重闸，与既定语义冲突已回退。
 */
export function resolveRouteShellMode(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
): RouteShellMode {
  const fromInput = input.routeShellMode
  const fromConfig = novelConfig
    ? (novelConfig as { routeShellMode?: RouteShellMode }).routeShellMode
    : undefined
  const raw = fromInput ?? fromConfig ?? "legacy"
  // #42 值语义归一（A-11 解锁条件 a 前半）："authoritative" 是 route 的别名档位，
  // 归一为规范值 "route"，消除「写 authoritative 静默回退 legacy」的失效路径。
  return raw === "authoritative" ? "route" : raw
}

/**
 * T10 × T09：三档反 AI 模式读取（项目级隔离，缺省 off = 现状：anti_ai 失败即挡）。
 * 三档：off=不挡 / warn=警告不挡 / block=硬挡（T21；route 模式由 route() 门控消费）。
 */
export function resolveAntiAiMode(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
): AntiAiMode {
  const fromInput = input.antiAiMode
  const fromConfig = novelConfig
    ? (novelConfig as { antiAiMode?: AntiAiMode }).antiAiMode
    : undefined
  return fromInput ?? fromConfig ?? "off"
}

/** T09 AntiAiMode (含自定义 string&{}) → route() 内核三档字面量（未知档归 off，route() 仅 block 硬挡）。 */
function normalizeAntiAiMode(mode: AntiAiMode): KernelAntiAiMode {
  if (mode === "warn") return "warn"
  if (mode === "block") return "block"
  return "off"
}

/**
 * route() 角色 → T33 注册表的写作角色。
 *
 * reviewer 是 route 的外交名，对应注册表的 critic（审稿）；architect/editor
 * 都是内容生产角色，落在 writer/reviser 这一侧。
 */
const ROUTE_ROLE_TO_WRITING_ROLE: Record<RouteRole, WritingRole> = {
  writer: "writer",
  reviewer: "critic",
  arbiter: "arbiter",
  judge: "judge",
  architect: "writer",
  editor: "reviser",
}

/** 项目配置里真实存在的角色模型字段（不伪造：未配置就不填）。 */
type RoleProjectConfig = {
  writingConfig: LlmConfig
  novelConfig?: Pick<
    ReturnType<typeof useWikiStore.getState>["novelConfig"],
    "writingModel" | "reviewModel" | "summaryModel" | "extractModel"
  > | null
  /** 测试/后台任务可注入 provider 配置表；缺省读 store（与 review-adapter 同构）。 */
  providerConfigs?: ReturnType<typeof useWikiStore.getState>["providerConfigs"]
}

/**
 * 从项目配置拼出 T33 注册表的入参。
 *
 * writingModel 缺省回退当前会话模型——这正是历史的「全角色单模型」语义，
 * 但 reviewModel 等角色字段**不再**用 writingModel 冒充：未配置就是未配置，
 * 由 resolveRoleModelName 走回退，从而保证默认态与旧行为位级等价。
 */
function toProjectModelConfig(projectConfig: RoleProjectConfig): ProjectModelConfig {
  const novelConfig = projectConfig.novelConfig
  const configuredWriting = (novelConfig?.writingModel ?? "").trim()
  const configuredReview = (novelConfig?.reviewModel ?? "").trim()
  return {
    writingModel: configuredWriting || projectConfig.writingConfig.model,
    ...(configuredReview ? { reviewModel: configuredReview } : {}),
    ...(novelConfig?.summaryModel?.trim() ? { summaryModel: novelConfig.summaryModel.trim() } : {}),
    ...(novelConfig?.extractModel?.trim() ? { extractModel: novelConfig.extractModel.trim() } : {}),
  }
}

/**
 * T10 / T33：stage executor 的 role→model 解析点。
 *
 * 输入是**真实项目配置**（novelConfig 的 writing/review/summary/extract 模型字段），
 * 经 `@/lib/llm/model-resolver` 的角色注册表解出角色应使用的模型名，再用
 * `@/lib/novel/model-resolver` 的模型名解析把 "providerId/modelId" 换成完整 LlmConfig。
 *
 * 默认态（项目未配置任何角色模型）返回 `writingConfig` 本体：全角色单模型，
 * 与旧行为位级等价（A-35 不破）。
 */
export function resolveRoleModel(
  role: RouteRole | undefined,
  projectConfig: RoleProjectConfig,
): LlmConfig {
  const writingConfig = projectConfig.writingConfig
  if (!role) return writingConfig
  const modelName = resolveRoleModelName(
    ROUTE_ROLE_TO_WRITING_ROLE[role],
    toProjectModelConfig(projectConfig),
  )
  if (!modelName || modelName === writingConfig.model) return writingConfig
  const providerConfigs = projectConfig.providerConfigs ?? useWikiStore.getState().providerConfigs
  return resolveModelConfig(modelName, writingConfig, providerConfigs)
}

/**
 * route 角色里由「内容阶段」执行的那些：只有它们才有权替换本次生成的执行模型。
 *
 * reviewer/arbiter/judge 的模型由审查适配器（review-adapter）自行按
 * novelConfig.reviewModel 解析；在这里再换一次执行模型会把 reviewModel 双重应用
 * （审查阶段反而用 reviewModel 去写草稿）。
 */
const CONTENT_ROUTE_ROLES: ReadonlySet<RouteRole> = new Set<RouteRole>([
  "writer",
  "architect",
  "editor",
])

/**
 * route 裁定的角色 → 本次内容阶段真正使用的执行配置。
 *
 * 这是 T33 绑定的**运行时**落点：`resolveRoleModel` 只负责算出角色模型，
 * 不交给阶段请求就是空操作。审查类角色返回写作配置本体（保持现状，由审阅层解析）。
 */
export function selectRouteStageConfig(
  role: RouteRole | undefined,
  roleConfig: LlmConfig,
  writingConfig: LlmConfig,
): LlmConfig {
  if (!role || !CONTENT_ROUTE_ROLES.has(role)) return writingConfig
  return roleConfig
}

/**
 * 全 route 角色的模型绑定快照（T33 注册表接入点）。
 *
 * 供 route 阶段机 / 诊断面直接取用，避免每处重复解析；无配置时六个角色
 * 全部等于写作配置（同一对象），与默认行为一致。
 */
export function resolveDeepChapterRoleConfigs(
  projectConfig: RoleProjectConfig,
): Record<RouteRole, LlmConfig> {
  const entries = (Object.keys(ROUTE_ROLE_TO_WRITING_ROLE) as RouteRole[]).map(
    (role) => [role, resolveRoleModel(role, projectConfig)] as const,
  )
  return Object.fromEntries(entries) as Record<RouteRole, LlmConfig>
}

/** T10 路由运行时（route() ControlState 的精简投影，纯函数无 IO）。 */
export interface DeepChapterRouteRuntime {
  phase: "writing"
  stage: RouteStage
  chapterNumber: number
  completedChapters: number
  pendingRewrites: number[]
  gates: RouteGates
  antiAiMode: KernelAntiAiMode
  manualReviewRequired: boolean
  blockThresholdApplied: boolean
  foundationMissing: string[]
  planningTier: ""
  reviewInterval: number
  lastGlobalReviewChapter: number
  hasArcReview: boolean
  hasArcSummary: boolean
  hasVolumeSummary: boolean
  shellMode: "legacy"
}

/** after_* → 规范阶段共享表（mapResumeStageToRouteStage 与 mapCheckpointStageToCanonicalInline
 * 共用一张表；未知值调用方各自降级为 context，与原 switch default 等价）。
 * B2 说明：曾委托 stage-vocabulary canonic 映射，该模块系他人 P5 untracked（CI 缺失）
 * 已回退为本文件内联表，行为等价。 */
const AFTER_STAGE_TO_CANONICAL: Record<DeepChapterGenerationResumeStage, RouteStage> = {
  after_context: "context",
  after_scene_breakdown: "scene_breakdown",
  after_task_brief: "task_brief",
  after_draft: "draft",
  after_review: "review",
  after_revision: "revision",
}

/** 恢复检查点 resume stage → route() RouteStage（与 control-sentinels ROUTE_STAGES 同构；
 * 未知值降级为 context，不静默终态）。薄封装：查共享表。 */
function mapResumeStageToRouteStage(
  checkpoint: DeepChapterGenerationResumeCheckpoint | undefined,
): RouteStage {
  if (!checkpoint) return "context"
  // typeof 守卫：与原 switch default 完全等价（任意非表内字符串一律回落 context，
  // 含原型链属性名如 "__proto__"/"toString" 查表时的误命中）。
  const raw: unknown = (AFTER_STAGE_TO_CANONICAL as Record<string, unknown>)[checkpoint.stage]
  return typeof raw === "string" ? (raw as RouteStage) : "context"
}

/** UI 阶段短标签统一出口——checkpoint_stage raw 值 → 中文短标签（未知值标「未知阶段」不隐藏）。
 * B2 回退说明：曾委托 stage-vocabulary.checkpointStageShortLabel，现就地内联，不依赖 untracked。
 * 调用方（chat 面板/诊断面）展示恢复阶段时走此函数。 */
const CANONICAL_STAGES_INLINE = [
  "context",
  "scene_breakdown",
  "task_brief",
  "draft",
  "review",
  "revision",
  "done",
] as const

type CanonicalStageInline = (typeof CANONICAL_STAGES_INLINE)[number]

const CANONICAL_SHORT_LABELS_INLINE: Record<CanonicalStageInline, string> = {
  context: "上下文",
  scene_breakdown: "场景拆解",
  task_brief: "任务简报",
  draft: "草稿",
  review: "审稿",
  revision: "修订",
  done: "完成",
}

function mapCheckpointStageToCanonicalInline(stage: string): CanonicalStageInline {
  if (stage === "started") return "context"
  if (stage === "completed") return "done"
  // 薄封装：查共享表；未知值降级为 context（与原 switch default 等价，含原型链属性名误命中防护）。
  const raw: unknown = (AFTER_STAGE_TO_CANONICAL as Record<string, unknown>)[stage]
  return typeof raw === "string" ? (raw as CanonicalStageInline) : "context"
}

function checkpointStageShortLabelInline(stage: string): string {
  const canon = mapCheckpointStageToCanonicalInline(stage)
  if (!(CANONICAL_STAGES_INLINE as readonly string[]).includes(stage) && canon === "context" && stage !== "started") {
    return stage.trim().length > 0 ? `未知阶段(${stage.slice(0, 24)})` : "上下文"
  }
  return CANONICAL_SHORT_LABELS_INLINE[canon]
}

export function stageShortLabelForDisplay(
  stage: DeepChapterGenerationResumeStage | "started" | "completed" | string | null | undefined,
): string {
  if (stage === null || stage === undefined) return "上下文"
  return checkpointStageShortLabelInline(String(stage))
}

/** DeepChapterDecisionGate.status（pending/passed/failed）→ route() GateVerdict（pending/pass/fail）。 */
function mapDecisionGateStatusToVerdict(
  status: "pending" | "passed" | "failed" | undefined,
): "pending" | "pass" | "fail" {
  if (status === "failed") return "fail"
  if (status === "passed") return "pass"
  return "pending"
}

/**
 * T10：由 deep-chapter 运行时（输入 + 恢复检查点 + novelConfig）构造 route() 的 ControlState。
 * 单章生成视角：completedChapters/reviewInterval/弧末事务均按当前章上下文归零/关闭
 * （global_review / arc_transition 分支在单章生成内不触发），不影响 legacy 路径字节级等价。
 */
export function buildDeepChapterRouteRuntime(
  input: DeepChapterGenerationInput,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
): DeepChapterRouteRuntime {
  const gates: RouteGates = resumeCheckpoint?.decisionGates
    ? {
        consistency: mapDecisionGateStatusToVerdict(resumeCheckpoint.decisionGates.consistency.status),
        anti_ai: mapDecisionGateStatusToVerdict(resumeCheckpoint.decisionGates.anti_ai.status),
        quality: mapDecisionGateStatusToVerdict(resumeCheckpoint.decisionGates.quality.status),
      }
    : { consistency: "pending", anti_ai: "pending", quality: "pending" }
  const antiAi = resolveAntiAiMode(input, novelConfig)
  const normalizedAntiAi: KernelAntiAiMode = normalizeAntiAiMode(antiAi)
  return {
    phase: "writing",
    stage: mapResumeStageToRouteStage(resumeCheckpoint),
    chapterNumber: input.chapterNumber ?? 0,
    completedChapters: 0,
    pendingRewrites: [],
    gates,
    antiAiMode: normalizedAntiAi,
    // T21 接线点：block 档激活状态（T20 标定判据 FPR≤5%/召回≥75% 已达标，但未接线验证）。
    // 激活前置：全章窗试跑确认 block 档零误杀后置 true（Draft-first 安全边界，三模型共识 2026-08-26）。
    blockThresholdApplied: false,
    manualReviewRequired: Boolean(resumeCheckpoint?.manualReviewRequired),
    foundationMissing: [],
    planningTier: "",
    reviewInterval: 0,
    lastGlobalReviewChapter: 0,
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
    shellMode: "legacy",
  }
}

/** route() ControlState 投影（薄封装，无 IO/LLM，ADR-19 机械层）。 */
function buildDeepChapterControlState(runtime: DeepChapterRouteRuntime): ControlState {
  return {
    phase: runtime.phase,
    stage: runtime.stage,
    chapterNumber: runtime.chapterNumber,
    completedChapters: runtime.completedChapters,
    pendingRewrites: runtime.pendingRewrites,
    gates: runtime.gates,
    antiAiMode: runtime.antiAiMode,
    manualReviewRequired: runtime.manualReviewRequired,
    foundationMissing: runtime.foundationMissing,
    planningTier: runtime.planningTier,
    reviewInterval: runtime.reviewInterval,
    lastGlobalReviewChapter: runtime.lastGlobalReviewChapter,
    hasArcReview: runtime.hasArcReview,
    hasArcSummary: runtime.hasArcSummary,
    hasVolumeSummary: runtime.hasVolumeSummary,
    shellMode: runtime.shellMode,
  }
}

/**
 * T10 薄编排化：stage 推进改读 route()。
 *
 * 默认 legacy 分支（route_shell_mode 缺省/非 "route"）→ 返回 null，编排器走既有
 * 字节级等价顺序流水线（A-35 不破；deep-chapter-golden.spec.ts 零回归）。
 *
 * route 分支（route_shell_mode === "route"）→ 由 control-kernel.route() 纯函数
 * （13 分支互斥，无 IO/LLM）裁定下一步动作；执行层『怎么做』由 resolveRoleModel
 * 按角色解析模型（默认全角色单模型 = 现状）。route 模式为 T33 注册表落地前的预览
 * 路径，现有测试均走 legacy，故该分支 v8 ignore 不计入覆盖率。
 */
export function resolveNextStageViaRoute(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  runtime: DeepChapterRouteRuntime,
): Instruction | null {
  const shellMode = resolveRouteShellMode(input, novelConfig)
  if (shellMode !== "route") {
    return null
  }
  /* v8 ignore start */
  const instruction = route(buildDeepChapterControlState(runtime))
  return instruction
  /* v8 ignore stop */
}

/**
 * T07 × T09 step_digest 集成：基于 checkpoint-digest (SHA-256 幂等键) 计算当前步骤摘要。
 * 输入经 stableStringify 规范化（键序稳定），同一步骤恒定同 digest，供 status.json
 * 唯一真源 step_digest 字段落盘（崩溃续跑命中跳过重调 LLM）。薄封装，无 IO/LLM（ADR-19）。
 */
export async function computeStepDigest(stageLabel: string, payload: unknown): Promise<string> {
  return computeCheckpointDigestOf({ stage: stageLabel, payload })
}


// ── 决策门子模块（arch-risk W4 god-object 拆分）─────────────────────────
// DeepChapterDecisionGate*/buildDecisionGates/collect*Issues/createEmpty* 已抽离
// 到 deep-chapter-decision-gates.ts；import 供本模块编排使用 + re-export 保持
// 外部 import 路径不变。改决策门逻辑只动子模块，不再动本编排体。
import {
  assertNotAborted,
} from "./deep-chapter-utils"

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

  // 阶段3 + 3.5：正文初稿 + 草稿纠偏
  const rawDraftContent = await generateDraft(
    input, writingConfig, deps, signal, callbacks,
    outlinePrompt, contextPrompt, taskBrief, lengthSpec, resumeCheckpoint, cachePrefix,
    notePartial, clearPartial, watchdog,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)

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
    if (statusMerger) {
      await statusMerger.flush().catch(() => {})
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
      partial: partialReason !== null,
      partialReason,
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
        `摘要写入跳过 (非致命): ${err instanceof Error ? err.message : String(err)}`,
      ))
    }
  } catch (err) {
    callbacks.onThinking?.(formatStageThinking(
      "avoid-ai 审计",
      `审计跳过 (非致命): ${err instanceof Error ? err.message : String(err)}`,
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
      `chase_debt 记账跳过 (非致命): ${err instanceof Error ? err.message : String(err)}`,
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
  if (statusMerger) {
    await statusMerger.flush().catch(() => {})
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
    partial: partialReason !== null,
    partialReason,
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
      error: error instanceof Error ? error.message : String(error), /* v8 ignore start */ /* v8 ignore stop */
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
      error: error instanceof Error ? error.message : String(error),
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
    logger.error("deep-chapter-generation", "前情分析失败", { error: error instanceof Error ? error.message : String(error) })
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

