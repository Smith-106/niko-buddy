/**
 * budget-counters.ts — T34 哨兵硬化：BudgetCounters（墙钟 + 分角色 token 预算）。
 *
 * ## 职责（TASK-P6-34 / T34 / A-07.3 / A-07.4）
 *   1. **墙钟计数**：计入全部角色绑定调用（writer/reviewer/arbiter/judge/architect/
 *      editor 全角色累计，非单角色口径）——这是 A/B 门槛④「墙钟 ≤45min/章」的测量前提。
 *      不计墙钟则多角色并行调用会低估真实耗时，45min 门槛无从校验。
 *   2. **token 预算分角色子计数**：每角色独立 prompt/completion/total 累计，
 *      支持「软警告」（超线告警不挡）与「硬封顶」（超线拒绝后续该角色调用）两档。
 *   3. **per-stage 墙钟预算分配表**：装配 3 / 拆解 2 / brief 2 / draft 20 /
 *      review 10 / revision 5 / gate 1 / 缓冲 2 分钟（合计恰为 45min/章）。
 *      常量表为初始值，可被 50ch-telemetry 实测校准覆盖（applyStageBudgetOverrides）。
 *
 * ## 定位与边界（ADR-19 机械层零模型调用）
 *   - 纯数据结构 + 纯函数：零 IO、零 LLM、零时钟读取（now 由调用方注入/传入）。
 *   - **零 import**：与 offline-replay-config.ts 同型态，保证 `scripts/50ch-telemetry.js`
 *     可经 Node 24 type-stripping 直接 import 本文件常量做校准对照（相对路径显式 .ts）。
 *   - 角色名与 control-sentinels.ts 的 ROUTE_ROLES 对齐（本文件为保持零依赖而复制字面量；
 *     两处需同步演进，见 spec 断言护栏）。阶段名与 control-kernel.ts route() 动作对齐。
 *   - 本模块只做计数与判定；watchdog（无 token 卡死）与 status 写入合并分别见
 *     watchdog.ts / status-write-merge.ts，互不复用。
 */

// ============================================================================
// 常量哨兵（数值口径）
// ============================================================================

/** A/B 门槛④：全角色累计墙钟 ≤45min/章（TASK-P6-34 测量前提）。 */
export const WALLCLOCK_BUDGET_PER_CHAPTER_MS = 45 * 60 * 1000

/**
 * per-stage 墙钟预算分配（分钟，蓝图原文：装配 3 / 拆解 2 / brief 2 / draft 20 /
 * review 10 / revision 5 / gate 1 / 缓冲 2）。键与 control-kernel.ts route() 动作名
 * 对齐（context_assembly/scene_breakdown/task_brief/write_draft/review/revise/judge），
 * buffer 为章内非阶段开销预留。合计 = 45 分钟（STAGE_BUDGET_TOTAL_MIN 断言锚定）。
 */
export const PER_STAGE_WALLCLOCK_BUDGETS_MIN = {
  context_assembly: 3,
  scene_breakdown: 2,
  task_brief: 2,
  write_draft: 20,
  review: 10,
  revise: 5,
  judge: 1,
  buffer: 2,
} as const

/** 阶段预算键集合（含 buffer）。 */
export type StageBudgetKey = keyof typeof PER_STAGE_WALLCLOCK_BUDGETS_MIN

/** 阶段预算合计（分钟）：必须恰等于 WALLCLOCK_BUDGET_PER_CHAPTER_MS 的分钟数。 */
export const STAGE_BUDGET_TOTAL_MIN: number = Object.values(
  PER_STAGE_WALLCLOCK_BUDGETS_MIN,
).reduce((a, b) => a + b, 0)

/**
 * token 预算默认档位（每角色·每章）。初始占位值，待 50ch-telemetry 实测后校准：
 *   - 软警告：超线记 warning，不阻断（与 anti_ai warn 档同哲学）。
 *   - 硬封顶：超线拒绝该角色后续调用（evaluateTokenGate → allowed=false）。
 */
export const DEFAULT_TOKEN_SOFT_WARN_TOKENS = 120_000
export const DEFAULT_TOKEN_HARD_CAP_TOKENS = 240_000

/**
 * 执行角色字面量。与 control-sentinels.ts ROUTE_ROLES 一致（writer/reviewer/
 * arbiter/judge/architect/editor）；`(string & {})` 保留自定义扩展位，与 T33
 * role→model 注册表的扩展策略一致。为维持零 import（Node type-stripping 直读）
 * 在此复制字面量，spec 有同步断言护栏。
 */
export type BudgetRole =
  | "writer"
  | "reviewer"
  | "arbiter"
  | "judge"
  | "architect"
  | "editor"
  | (string & {})

// ============================================================================
// 计数器数据结构
// ============================================================================

/** 单角色 token 子计数（分角色子计数 = 分角色的独立累加槽位）。 */
export interface RoleTokenSubCounter {
  role: BudgetRole
  /** 累计输入 token。 */
  promptTokens: number
  /** 累计输出 token。 */
  completionTokens: number
  /** 累计总 token（prompt + completion）。 */
  totalTokens: number
  /** 调用次数（该角色）。 */
  calls: number
  /** 已触发过软警告（首次越线置 true，供去重告警）。 */
  softWarned: boolean
  /** 已触发过硬封顶（首次越线置 true）。 */
  hardCapped: boolean
}

/**
 * BudgetCounters — 章级资源哨兵计数器。
 *
 * 墙钟口径：`wallclockMs` 计入**全部角色绑定调用**的时长总和（recordRoleCall /
 * recordRoleWallclock 都会累加），即 A/B 门槛④的测量口径。token 按角色子计数分槽。
 */
export interface BudgetCounters {
  schemaVersion: "budget-counters/1.0"
  /** 全角色绑定调用累计墙钟 ms。 */
  wallclockMs: number
  /** 全角色绑定调用总次数。 */
  callCount: number
  /** 分角色子计数（role → 子计数）。 */
  roles: Record<string, RoleTokenSubCounter>
}

/** 创建空计数器（零值起点）。 */
export function createBudgetCounters(): BudgetCounters {
  return {
    schemaVersion: "budget-counters/1.0",
    wallclockMs: 0,
    callCount: 0,
    roles: {},
  }
}

function ensureRole(counters: BudgetCounters, role: string): RoleTokenSubCounter {
  let sub = counters.roles[role]
  if (!sub) {
    sub = {
      role,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 0,
      softWarned: false,
      hardCapped: false,
    }
    counters.roles[role] = sub
  }
  return sub
}

/** token 预算配置（软警告/硬封顶阈值；缺省走 DEFAULT_* 占位值）。 */
export interface TokenBudgetConfig {
  softWarnTokens?: number
  hardCapTokens?: number
}

/** 单次调用后的预算裁定结果。 */
export interface TokenBudgetVerdict {
  /** 本次记录后是否越过硬封顶（已计入；调用方应停止该角色后续调用）。 */
  hardCapExceeded: boolean
  /** 本次记录后是否越过软警告线（未越过硬封顶时才有意义）。 */
  softWarn: boolean
  /** 该角色是否已被硬封顶（累计态，before-call 判定用 evaluateTokenGate）。 */
  hardCapped: boolean
}

/**
 * before-call 门禁：该角色是否允许发起新调用。
 * 已达/超硬封顶 → allowed=false（拒绝）；已达/超软警告且未封顶 → softWarn=true。
 * 阈值非法（<=0 或 NaN）视为未配置 → 放行（不误挡）。
 */
export function evaluateTokenGate(
  counters: BudgetCounters,
  role: string,
  config: TokenBudgetConfig = {},
): { allowed: boolean; softWarn: boolean } {
  const sub = counters.roles[role]
  if (!sub) return { allowed: true, softWarn: false }
  const hardCap = normalizeThreshold(config.hardCapTokens)
  const softWarn = normalizeThreshold(config.softWarnTokens)
  if (hardCap !== undefined && sub.totalTokens >= hardCap) {
    return { allowed: false, softWarn: false }
  }
  if (softWarn !== undefined && sub.totalTokens >= softWarn) {
    return { allowed: true, softWarn: true }
  }
  return { allowed: true, softWarn: false }
}

function normalizeThreshold(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined
  return v
}

/** 单次角色绑定调用的用量输入（wallclock 与 token 可任选其一或同记）。 */
export interface RoleCallUsage {
  /** 本次调用墙钟 ms（≥0；非法值按 0 计，不静默丢弃调用本身）。 */
  wallclockMs?: number
  promptTokens?: number
  completionTokens?: number
}

/**
 * 记录一次角色绑定调用（after-call）：墙钟计入全角色累计口径 + 分角色 token 子计数。
 * 返回本次记录后的预算裁定（软警告/硬封顶首越线时在子计数上落 flag）。
 */
export function recordRoleCall(
  counters: BudgetCounters,
  role: string,
  usage: RoleCallUsage = {},
  config: TokenBudgetConfig = {},
): TokenBudgetVerdict {
  const wc = typeof usage.wallclockMs === "number" && Number.isFinite(usage.wallclockMs)
    ? Math.max(0, usage.wallclockMs)
    : 0
  const prompt = nonNegative(usage.promptTokens)
  const completion = nonNegative(usage.completionTokens)

  counters.wallclockMs += wc
  counters.callCount += 1

  const sub = ensureRole(counters, role)
  sub.calls += 1
  sub.promptTokens += prompt
  sub.completionTokens += completion
  sub.totalTokens += prompt + completion

  const hardCap = normalizeThreshold(config.hardCapTokens)
  const softWarnAt = normalizeThreshold(config.softWarnTokens)
  const hardCapExceeded = hardCap !== undefined && sub.totalTokens > hardCap
  const softWarn = !hardCapExceeded && softWarnAt !== undefined && sub.totalTokens > softWarnAt
  if (hardCapExceeded) sub.hardCapped = true
  if (softWarn || (!hardCapExceeded && softWarnAt !== undefined && sub.totalTokens >= softWarnAt)) {
    sub.softWarned = true
  }
  return { hardCapExceeded, softWarn, hardCapped: sub.hardCapped }
}

function nonNegative(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * 仅记墙钟（无 token 用量的角色绑定调用，如本地机械步骤经角色包装）。
 * 同样计入全角色累计口径。
 */
export function recordRoleWallclock(
  counters: BudgetCounters,
  role: string,
  wallclockMs: number,
): void {
  recordRoleCall(counters, role, { wallclockMs })
}

// ============================================================================
// per-stage 预算分配：覆盖（校准）与比对
// ============================================================================

/** 校准覆盖表：stage → 分钟（部分覆盖；未提供的阶段沿用默认表）。 */
export type StageBudgetOverride = Partial<Record<StageBudgetKey, number>>

/**
 * 由默认表 + 校准覆盖派生生效表（纯函数，不改写常量表本身——常量表始终保留
 * 蓝图初始值，校准只发生在派生层，便于回溯 diff）。非法覆盖（负数/NaN）被忽略。
 */
export function applyStageBudgetOverrides(
  overrides?: StageBudgetOverride,
): Record<StageBudgetKey, number> {
  const effective: Record<StageBudgetKey, number> = { ...PER_STAGE_WALLCLOCK_BUDGETS_MIN }
  if (!overrides) return effective
  for (const [k, v] of Object.entries(overrides) as Array<[StageBudgetKey, number]>) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      effective[k] = v
    }
  }
  return effective
}

/** 生效表合计分钟数。 */
export function sumStageBudgetsMin(table: Record<StageBudgetKey, number>): number {
  return Object.values(table).reduce((a, b) => a + b, 0)
}

/** 单阶段实测结果输入（compareStageBudgets 用）。 */
export interface StageMeasurement {
  stage: string
  durationMs: number
}

/** 单阶段预算比对结论。 */
export interface StageBudgetCheck {
  stage: string
  durationMs: number
  budgetMs: number
  overByMs: number
  status: "ok" | "over"
  /** 未列入预算表的阶段（budgetMs=0，仅报告不判超）。 */
  unknownStage: boolean
}

/**
 * 实测阶段时长 vs 生效预算表逐项比对。未知阶段标记 unknownStage（不参与超支判定，
 * 但会出现在结果里——避免静默吞掉表外阶段的墙钟）。
 */
export function compareStageBudgets(
  measured: readonly StageMeasurement[],
  table?: Record<StageBudgetKey, number>,
): StageBudgetCheck[] {
  const effective = table ?? applyStageBudgetOverrides()
  return measured.map((m) => {
    const known = (effective as Record<string, number>)[m.stage]
    const budgetMs = typeof known === "number" ? known * 60_000 : 0
    const dur = Number.isFinite(m.durationMs) ? Math.max(0, m.durationMs) : 0
    const overByMs = known === undefined ? 0 : Math.max(0, dur - budgetMs)
    return {
      stage: m.stage,
      durationMs: dur,
      budgetMs,
      overByMs,
      status: overByMs > 0 ? "over" : "ok",
      unknownStage: known === undefined,
    } satisfies StageBudgetCheck
  })
}

/**
 * 章级墙钟门槛判定：全角色累计墙钟 vs A/B 门槛④ 45min/章。
 */
export function checkChapterWallclockGate(
  wallclockMs: number,
  budgetMs: number = WALLCLOCK_BUDGET_PER_CHAPTER_MS,
): { pass: boolean; wallclockMs: number; budgetMs: number; overByMs: number } {
  const wc = Number.isFinite(wallclockMs) ? Math.max(0, wallclockMs) : 0
  const overByMs = Math.max(0, wc - budgetMs)
  return { pass: overByMs === 0, wallclockMs: wc, budgetMs, overByMs }
}
