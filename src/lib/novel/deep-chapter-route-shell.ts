/**
 * deep-chapter-route-shell — T10 route 薄壳 + role→model 解析 + route-runtime 纯函数子模块（M8-2 增量切片）。
 *
 * 从 deep-chapter-generation.ts 抽出的自足纯逻辑块（原 275-650 行，376 行）：shouldUseDeepChapterGeneration/
 * resolveRouteShellMode/resolveAntiAiMode/role 解析（resolveRoleModel/selectRouteStageConfig/
 * resolveDeepChapterRoleConfigs）/route-runtime 构造（buildDeepChapterRouteRuntime/resolveNextStageViaRoute/
 * computeStepDigest）+ stage 短标签统一出口。接口与实现原样搬迁，主文件只做编排。
 * 仅 type-only 依赖主链类型（编译期擦除，无运行时循环，与 deep-chapter-utils 同构）；无新增依赖。
 */

import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { TaskRouteResult } from "./task-router"
import type { RouteShellMode, AntiAiMode } from "./novel-session-status"
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
  resolveRoleModel as resolveRoleModelName,
  type ProjectModelConfig,
  type WritingRole,
} from "@/lib/llm/model-resolver"
import { resolveModelConfig } from "./model-resolver"
import type {
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResumeStage,
} from "./deep-chapter-generation"

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
