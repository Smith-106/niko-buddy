// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * model-resolver.ts — T33 角色化绑定 + fallback 链解析
 *
 * 蓝图 §7 T33:
 *   五角色 writer/critic/reviser/arbiter/judge 的角色化绑定；
 *   resolveRoleModel(role, projectConfig) 纯函数，默认全绑单模型=现状（向后兼容）；
 *   taskTier 复杂度路由 + fallback 链语义契约；
 *   NovelError 三分类 (retryable / content / fatal)。
 *
 * 机械层约束:
 *   纯函数 + 类型定义，无 IO / 无网络 / 无模型调用。
 *
 * @license MIT © QMAI
 */

// ── 角色定义 ─────────────────────────────────────────────────────────────────────

/** 写作角色枚举。 */
export type WritingRole = "writer" | "critic" | "reviser" | "arbiter" | "judge"

/** 全部五角色（保序，按管线顺序）。 */
export const ALL_WRITING_ROLES: readonly WritingRole[] = [
  "writer",
  "critic",
  "reviser",
  "arbiter",
  "judge",
] as const

/** 角色→模型字段映射（用于从 NovelConfig 读取）。 */
const ROLE_TO_CONFIG_FIELD: Record<WritingRole, string> = {
  writer: "writingModel",
  critic: "reviewModel",
  reviser: "writingModel",   // 默认复用 writingModel，可独立覆盖
  arbiter: "reviewModel",
  judge: "reviewModel",
}

// ── 角色→模型映射 ────────────────────────────────────────────────────────────────

/** 角色→模型名称映射。 */
export interface RoleModelMap {
  writer: string
  critic: string
  reviser: string
  arbiter: string
  judge: string
}

/** 项目配置模型字段子集（resolveRoleModel 的输入契约）。 */
export interface ProjectModelConfig {
  writingModel?: string
  reviewModel?: string
  summaryModel?: string
  extractModel?: string
  /** 判官池显式模型列表（judge 角色多模型路由，见 resolveJudgePool）。 */
  judgePool?: string[]
}

/**
 * 解析角色对应的模型名称。
 * 纯函数：给定相同 (role, config) 总是返回相同结果。
 *
 * 解析优先级:
 *   1. 角色专属字段（如 writer→writingModel, critic→reviewModel）
 *   2. writingModel 作为兜底
 *   3. 空字符串（无配置时）
 *
 * 向后兼容: 所有角色全绑 writingModel 时行为与现状一致。
 */
export function resolveRoleModel(
  role: WritingRole,
  config: ProjectModelConfig,
): string {
  const field = ROLE_TO_CONFIG_FIELD[role] as keyof ProjectModelConfig
  // judgePool 为 string[] 字段，与角色→模型单字段语义无关，需收窄为 string
  return (config[field] as string | undefined) || config.writingModel || ""
}

/**
 * 从 projectConfig 构建完整角色→模型映射。
 * 纯函数。
 */
export function buildRoleModelMap(config: ProjectModelConfig): RoleModelMap {
  return {
    writer: resolveRoleModel("writer", config),
    critic: resolveRoleModel("critic", config),
    reviser: resolveRoleModel("reviser", config),
    arbiter: resolveRoleModel("arbiter", config),
    judge: resolveRoleModel("judge", config),
  }
}

/**
 * 构建默认角色→模型映射（所有角色绑定同一模型）。
 * 纯函数。
 */
export function buildDefaultRoleModelMap(singleModel: string): RoleModelMap {
  return {
    writer: singleModel,
    critic: singleModel,
    reviser: singleModel,
    arbiter: singleModel,
    judge: singleModel,
  }
}

// ── TaskTier 复杂度路由 ──────────────────────────────────────────────────────────

/** 任务复杂度分层。 */
export type TaskTier = "simple" | "standard" | "complex" | "analysis"

/** 全部 taskTier 列表（保序，按复杂度升序）。 */
export const ALL_TASK_TIERS: readonly TaskTier[] = [
  "simple",
  "standard",
  "complex",
  "analysis",
] as const

/** Tier→角色映射（用于 resolveTierModel）。 */
const TIER_TO_ROLE: Record<TaskTier, WritingRole> = {
  simple: "writer",
  standard: "writer",
  complex: "writer",
  analysis: "critic", // 分析任务使用 critic/review 模型
}

/**
 * 根据 taskTier 解析推荐模型。
 * 纯函数。
 */
export function resolveTierModel(
  tier: TaskTier,
  modelMap: RoleModelMap,
): string {
  return modelMap[TIER_TO_ROLE[tier]]
}

/**
 * 获取 tier 的推荐角色。
 * 纯函数。
 */
export function resolveTierRole(tier: TaskTier): WritingRole {
  return TIER_TO_ROLE[tier]
}

// ── 判官池路由（judge 角色多模型，DEBT-20260828-t31b-01 后半截） ─────────────────

/**
 * 判官池显式配置（judgePool: [flash, ox] 语义）。
 *
 * `judgePool` 为判官模型的有序列表，首个为主判官。
 * 空 / 缺省 → 回退到现有单判官绑定（resolveRoleModel("judge")），向后兼容。
 */
export interface JudgePoolConfig {
  judgePool?: string[]
}

/**
 * 判官池解析源（精品模式 fallback 链的 judge 角色槽）。
 * 结构对齐 DEFAULT_PREMIUM_CONFIG.fallbackChains（premium-config.ts）。
 */
export interface JudgePoolSource {
  fallbackChains?: Partial<Record<"judge", FallbackChainConfig>>
}

/**
 * 注册表默认判官池：T36 真实补验轮定稿的 flash + ox 双异模型对
 * （J1=cpa-responses/deepseek-v4-flash，J2=cpa-responses/ox-alpha-free，
 * 见 docs/p6/ab-evidence/aggregate-summary.json 与 docs/p6/premium-mode-ab-report.md §3）。
 *
 * offline-replay A/B 判官臂显式引用此常量作为可配默认（registry 单点定义，
 * 不再散落硬编码于 driver/spec/aggregator）；产品运行路径不隐式启用——
 * 无 judgePool 配置时仍回退单判官（向后兼容）。
 */
export const DEFAULT_JUDGE_POOL: readonly string[] = [
  "cpa-responses/deepseek-v4-flash",
  "cpa-responses/ox-alpha-free",
] as const

/**
 * 保序去重（保留首次出现），跳过非字符串与空串。纯函数。
 */
function dedupeKeepOrder(models: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of models) {
    if (typeof m !== "string") continue
    const trimmed = m.trim()
    if (trimmed === "" || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 解析判官池（judge 角色多模型路由，judgePool: [flash, ox] 语义）。
 *
 * 解析优先级:
 *   1. config.judgePool 显式列表（非空 → 保序去重原样返回）
 *   2. roleJudge + fallbackChains.judge 派生（[roleJudge, primary, ...fallbacks]
 *      保序去重）——与 DEFAULT_PREMIUM_CONFIG.fallbackChains.judge 结构对齐
 *   3. 单判官 [roleJudge]（无任何配置 → 现状回退）
 *   4. []（roleJudge 也为空，调用方自行处理）
 *
 * 向后兼容（DEBT-20260828-t31b-01）:
 *   - 无 judgePool 且无 fallbackChains.judge → [resolveRoleModel("judge")]，
 *     与 premium-execution 现状（judgeA === judgeB 单判官）行为一致；
 *   - 仅 fallbackChains.judge.primary 且 ≠ roleJudge → [roleJudge, primary]，
 *     与现状（judgeModelB = primary || judgeModelA）一致。
 *
 * 纯函数：同输入同输出，无 IO / 无模型调用。
 */
export function resolveJudgePool(
  config: ProjectModelConfig & JudgePoolConfig,
  premiumConfig?: JudgePoolSource,
): string[] {
  const explicit = config.judgePool
  if (explicit && explicit.length > 0) {
    return dedupeKeepOrder(explicit)
  }
  const roleJudge = resolveRoleModel("judge", config)
  const chain = premiumConfig?.fallbackChains?.judge
  const derived: (string | undefined)[] = [
    roleJudge,
    chain?.primary,
    ...(chain?.fallbacks ?? []),
  ]
  return dedupeKeepOrder(derived)
}

/**
 * 从判官池取双判官（judgeA / judgeB）——双判官执行语义的纯函数投影。
 *
 *   - 池长度 ≥ 2 → judgeA / judgeB 为池中前两个（双异模型）
 *   - 池长度 1 → judgeA === judgeB（单判官，现状回退）
 *   - 池空 → 双空（调用方自行处理）
 *
 * 纯函数。
 */
export function resolveJudgePair(pool: readonly string[]): {
  judgeA: string
  judgeB: string
} {
  const judgeA = pool[0] ?? ""
  const judgeB = pool[1] ?? judgeA
  return { judgeA, judgeB }
}

// ── Fallback 链 ─────────────────────────────────────────────────────────────────

/** Fallback 链配置。 */
export interface FallbackChainConfig {
  /** 主模型（首个尝试）。 */
  primary: string
  /** 后备模型列表（按优先级排序）。 */
  fallbacks: string[]
  /** 链耗尽后的处理动作。 */
  exhaustedAction: "checkpoint" | "manual_review"
  /** 内容失败（非 retryable）的处理动作。 */
  contentFailAction: "manual_review"
}

/** Fallback 链解析结果。 */
export interface FallbackChainResult {
  /** 当前尝试的模型名。 */
  currentModel: string
  /** 剩余后备模型列表（空表示链已耗尽）。 */
  remainingFallbacks: string[]
  /** 是否已耗尽所有选项。 */
  exhausted: boolean
}

/**
 * 解析 fallback 链——获取当前应尝试的模型。
 * 纯函数。
 *
 * @param attemptIndex 当前尝试序号（0 = 首次）
 * @param chain fallback 链配置
 * @returns 当前模型 + 剩余后备 + 是否耗尽
 */
export function resolveFallbackChain(
  attemptIndex: number,
  chain: FallbackChainConfig,
): FallbackChainResult {
  if (attemptIndex === 0) {
    return {
      currentModel: chain.primary,
      remainingFallbacks: [...chain.fallbacks],
      exhausted: false,
    }
  }

  const fallbackIndex = attemptIndex - 1
  if (fallbackIndex < chain.fallbacks.length) {
    return {
      currentModel: chain.fallbacks[fallbackIndex],
      remainingFallbacks: chain.fallbacks.slice(fallbackIndex + 1),
      exhausted: false,
    }
  }

  // 链已耗尽
  return {
    currentModel: "",
    remainingFallbacks: [],
    exhausted: true,
  }
}

/**
 * 判断错误是否为 retryable（可触发 fallback 重试）。
 * 纯函数。
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof NovelError) {
    return error.kind === "retryable"
  }
  if (error instanceof Error) {
    const msg = error.message
    if (/timed out|timeout|network|connection|abort|rate limit|429|503|500/i.test(msg)) {
      return true
    }
  }
  return false
}

/**
 * 判断错误是否为 content 失败（应走 manual_review）。
 * 纯函数。
 */
export function isContentError(error: unknown): boolean {
  if (error instanceof NovelError) {
    return error.kind === "content"
  }
  if (error instanceof Error) {
    const msg = error.message
    if (/JSON|parse|解析|content.policy|moderation|safety/i.test(msg)) {
      return true
    }
  }
  return false
}

// ── NovelError 三分类 ───────────────────────────────────────────────────────────

/** NovelError 分类枚举。 */
export type NovelErrorKind = "retryable" | "content" | "fatal"

/**
 * NovelError 基类——LLM 层三分类错误。
 *
 * 语义契约:
 *   - retryable: 网络/超时/限流等可重试错误 → 触发 fallback 链
 *   - content:   内容解析/策略/审核失败 → 不触发 fallback，直接 manual_review
 *   - fatal:     认证/配置/参数错误 → 不触发 fallback，直接终止
 */
export class NovelError extends Error {
  readonly kind: NovelErrorKind

  constructor(kind: NovelErrorKind, message: string) {
    super(message)
    this.name = "NovelError"
    this.kind = kind
  }
}

/** 可重试错误（网络/超时/限流）→ 触发 fallback 链。 */
export class RetryableError extends NovelError {
  constructor(message: string) {
    super("retryable", message)
    this.name = "RetryableError"
  }
}

/** 内容错误（解析/策略/审核）→ 不触发 fallback，直接 manual_review。 */
export class ContentError extends NovelError {
  constructor(message: string) {
    super("content", message)
    this.name = "ContentError"
  }
}

/** 致命错误（认证/配置）→ 不触发 fallback，直接终止。 */
export class FatalError extends NovelError {
  constructor(message: string) {
    super("fatal", message)
    this.name = "FatalError"
  }
}

/**
 * 将任意错误分类为 NovelError（如果尚未是）。
 * 纯函数。
 */
export function classifyError(err: unknown): NovelError {
  if (err instanceof NovelError) return err
  if (err instanceof Error) {
    const msg = err.message
    if (/timed out|timeout|network|connection|abort|rate limit|429|503|500/i.test(msg)) {
      return new RetryableError(msg)
    }
    if (/JSON|parse|解析|content.policy|moderation|safety/i.test(msg)) {
      return new ContentError(msg)
    }
    if (/auth|unauthorized|401|403|api key|配置错误/i.test(msg)) {
      return new FatalError(msg)
    }
    return new RetryableError(msg) // 默认可重试
  }
  return new RetryableError(String(err))
}