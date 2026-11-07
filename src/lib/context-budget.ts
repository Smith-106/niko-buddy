/**
 * Pure budget allocator for chat context assembly.
 *
 * Given an LLM's `maxContextSize` (a **token** window), computes per-section
 * **character** budgets used by the chat panel when packing the prompt:
 *
 * ## G4b：换算分支化（旧「安全方向」注释已修正）
 *
 * 旧注释说「CJK 约 1.5 字符/token，所以 pageBudget = maxCtx × 0.5 只相当于窗口
 * 的约 1/3 token，误差方向安全」——**这句是错的，两个方向都错**：
 *
 *   - CJK 实测约 **1 字符/token**（见 token-estimator.ts 的校准口径：汉字
 *     1.0 token/字符），所以 `0.5 × maxCtx` 字符 ≈ `0.5 × maxCtx` token，
 *     不是 1/3 —— 比旧注释说的近 1.5 倍，属于**偏危险**方向；
 *   - 非 CJK（英文散文）约 4 字符/token，一律按 1.5 换算等于只用掉一半容量，
 *     属于**白浪费**方向。
 *
 * 所以换算按脚本分支：CJK 段保留 1.5（见 `CJK_CHARS_PER_TOKEN`，与硬注入 /
 * canonRules 的既有口径同源，数值不动），非 CJK 段走 1.0
 * （`NON_CJK_CHARS_PER_TOKEN`，保守下界：一个字符当一 token 花，只会少填不会超窗）。
 * 本节下方的配比常量与 adaptiveScale 曲线**一个数字都没改**——分支只作用在
 * 「token 预算 → 字符预算」这一层（见 `tokenBudgetToCharBudget`）。
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              maxCtx (100%)                          │
 *   ├──────┬───────────────┬──────────────────┬───────────┤
 *   │ idx  │   pages       │  history + sys   │  resp     │
 *   │  5%  │    50%        │    ~30%          │   15%     │
 *   └──────┴───────────────┴──────────────────┴───────────┘
 *
 * ## G5 (R5 缓解): canonRules 预留槽的真实语义 —— **告警阈值，不是额度扣减**
 *
 * `RESERVED_CANON_RULES_CHARS` 只作为「canonRules 是否超体量」的判据
 * (`buildCanonRulesBudgetExceeded` → trace + journal 双记)，**不参与任何额度分配**：
 * 本模块不把 `reservedChars` 从 maxCtx 里减掉，history / sys / index / page / resp
 * 的任何预算数值都不受它影响，也没有任何装配点拿它去限制其它段。
 *
 * 为什么不做「真扣」：本仓不存在「history/sys 额度」这条分配路径 —— 聊天装配
 * (`chat-panel-context-assembly.ts`) 只取 indexBudget / pageBudget / maxPageSize，
 * 压缩链 (`context-compact.ts`) 的 `tokenBudget` 由调用方另行给定。凭空造一条
 * 预留扣减路径，等于在既有三项配额之外新增一套无人校验的配额，风险大于收益。
 *
 * **因此 G5 落地的唯一保证机制是「L4 零截断」**：压缩到 L4 (fullSummary) 时
 * canonRules 段不被裁剪 (见 `context-compact.ts` 的 L4 循环显式跳过该段)。
 * 「其它段让位给预留槽」这件事**没有发生，也不在本模块承诺范围内**。
 *
 * MIT License — independently implemented.
 */

import { DEFAULT_MAX_CONTEXT_TOKENS } from "./llm-context-limits"
/**
 * F-008: 自适应上下文三态策略枚举。
 *
 * 作为现有 adaptiveScale 曲线上层选择器：先选态再算预算，不替换曲线。
 * - `full`: 全量上下文（章节数 ≤ fullThreshold，默认 50）
 * - `sliding`: 滑动窗口上下文（fullThreshold < 章节数 ≤ summaryThreshold，默认 50-200）
 * - `summary`: 摘要级上下文（章节数 > summaryThreshold，默认 200）
 */
export type ContextStrategy = "full" | "sliding" | "summary"

/** 三态策略阈值配置（可 novelConfig 覆盖）。 */
export interface ContextStrategyConfig {
  fullThreshold: number
  summaryThreshold: number
}

const DEFAULT_STRATEGY_CONFIG: ContextStrategyConfig = {
  fullThreshold: 50,
  summaryThreshold: 200,
}

/**
 * 根据章节号选择上下文策略（先选态再算预算，不替换 adaptiveScale 曲线）。
 *
 * @param chapterNumber 当前章节号（undefined/≤0 返回 full）
 * @param config        可选阈值覆盖（默认 full≤50/sliding 50-200/summary>200）
 */
export function selectContextStrategy(
  chapterNumber: number | undefined,
  config?: Partial<ContextStrategyConfig>,
): ContextStrategy {
  const { fullThreshold, summaryThreshold } = { ...DEFAULT_STRATEGY_CONFIG, ...config }
  if (chapterNumber === undefined || chapterNumber <= 0) return "full"
  if (chapterNumber <= fullThreshold) return "full"
  if (chapterNumber <= summaryThreshold) return "sliding"
  return "summary"
}

/** All values are character counts. */
export interface ContextBudget {
  /** Full context window (falls back to default when 0/undefined). */
  maxCtx: number
  /** Characters reserved for the LLM's response (not filled by prompt). */
  responseReserve: number
  /** Wiki index summary budget (~5%). */
  indexBudget: number
  /** Total characters for retrieved wiki page content. */
  pageBudget: number
  /** Per-page truncation cap (scales with pageBudget). */
  maxPageSize: number
  /**
   * Active entities budget: a compressible tier with a rank-0 floor.
   * rank0 entities are always fully kept; rank1/rank2 entities are
   * compressed by their tier caps.
   */
  activeEntitiesBudget: {
    rank0Floor: number
    rank1CompressibleCap: number
    rank2CompressibleCap: number
  }
  /**
   * F-008: 三态策略选择结果（full/sliding/summary）。
   * 作为 adaptiveScale 曲线上层选择器，先选态再算预算。
   */
  strategy: ContextStrategy
  /**
   * E-02 (双库架构蓝图 EPIC-02, 三模型共识 C-4): 硬注入保护槽。
   * capChars = min(2048 tokens × 1.5 char/token, floor(maxCtx × 0.3))。
   * 硬注入 MUST 优先占满, 软语料 (pageBudget 内) MUST 截断 (CAP-RET-08)。
   */
  hardInjectionBudget: HardInjectionBudget
  /**
   * G5 (R5 缓解): canonRules 预留槽（**告警阈值口径，不扣减任何额度**）。
   *
   * 这是「canonRules 体量参考线」而不是配额：本模块**不会**把它从 maxCtx 里减去，
   * 也没有任何装配点拿它去限制 history / sys / index / page。既有三项配比
   * (index 5% / page 50% / resp 15%) 与旧版逐字节相同，这一点不是靠「预留槽先扣、
   * 其它段让位」实现的，而是因为预留槽压根不参与分配。
   *
   * G5 对 canonRules 的**唯一保证机制是 L4 零截断**（见 `context-compact.ts` 的
   * L4 fullSummary 循环显式跳过 canonRules）；本字段的用途只有两个：
   *   1. `buildCanonRulesBudgetExceeded` 的判据（超线 → trace + journal 告警）；
   *   2. UI 展示「参考线 / 缺口」时的数字来源。
   *
   * 注：`computeContextBudget` 恒填充该字段（不是可选行为）；声明为可选仅为
   * 向后兼容仓内既有 `ContextBudget` 字面量 fixtures（组件测试的桩预算表，
   * 不在本任务改动范围）——消费方若持有 computeContextBudget 的返回值可直接取值。
   */
  canonRulesReserve?: CanonRulesReserve
}

/**
 * G5 (R5 缓解): canonRules 预留槽（chars）—— **告警阈值，不是配额**。
 *
 * 该结构不参与任何额度分配；字段仅供告警判据与展示使用（见
 * `ContextBudget.canonRulesReserve` 的说明）。
 */
export interface CanonRulesReserve {
  /**
   * 参考字符数 = min(RESERVED_CANON_RULES_CHARS, maxCtx − (resp+index+page))。
   *
   * 只是「这条配置下 canonRules 有多少余量」的告警线；**不从任何段的预算里扣除**。
   */
  reservedChars: number
  /** 标准参考额度 (RESERVED_CANON_RULES_CHARS)；reservedChars 小于它即参考线被压缩。 */
  standardChars: number
  /** 剩余未分配额度不足以满足标准参考线 (true = 该配置下 canonRules 无余量，需告警)。 */
  clamped: boolean
}

/**
 * E-02 (C-4): 硬注入预算槽 — 基线 2048 tokens (CJK ≈ 1.5 char/token → 3072 chars),
 * cap = min(基线, maxCtx × 0.3)。口径写死防验收 6 不可复现。
 */
export interface HardInjectionBudget {
  /** cap: min(基线换算 chars, floor(maxCtx × 0.3))。 */
  capChars: number
  /** 基线 2048 tokens 的 chars 换算 (CJK ≈ 1.5 char/token → 3072)。 */
  baselineChars: number
}

/** E-02 (C-4): 硬注入 token 基线 (tokens)。 */
export const HARD_INJECT_TOKEN_CAP = 2048
/** E-02 (C-4): CJK 字符/token 换算 (与 context-engine CJK 口径同源)。 */
export const CJK_CHARS_PER_TOKEN = 1.5
/**
 * G4b: 非 CJK 字符/token 换算（保守下界 1.0 chars/token）。
 *
 * 为什么不是英文实际值 ≈4：字符预算的用途是「按字符往上下文里填」，系数越大 =
 * 允许填越多字符 = 越容易撞上游窗口。4 chars/token 只对纯 ASCII 散文成立；
 * 代码、URL、base64、混排 emoji 会掉到 1–2 chars/token。取 1.0 意味着
 * 「一个字符当一 token 花」——只会少填，不会超窗（误差方向单向可控）。
 */
export const NON_CJK_CHARS_PER_TOKEN = 1.0

/**
 * CJK 码点判定（与 token-estimator.ts 的 isCjkCodePoint 同范围）。
 *
 * 刻意在本文件重写而不 import：token-estimator 没有导出该判定，而本任务的
 * 改动边界不含 token-estimator。范围若变动，两处必须同步（各自有 spec 兜底）。
 */
function isCjkChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  )
}

/**
 * G4b: 按脚本分支的 chars/token 系数。
 *
 * 纯 CJK 文本 → 1.5；纯非 CJK → 1.0；混排按各自的 token 消耗加权
 * （totalChars / (cjk/1.5 + nonCjk/1.0)），与 context-engine-prompt 的
 * 混排口径同形。空文本沿用旧口径 1.5（没有样本可分类，不能凭空改历史数值）。
 */
export function charsPerTokenForText(text: string): number {
  if (!text) return CJK_CHARS_PER_TOKEN
  let cjk = 0
  let nonCjk = 0
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1
    else nonCjk += 1
  }
  const total = cjk + nonCjk
  /* v8 ignore next -- 台账 context-budget.ts L222：上一行 if (!text) 已拦下空串，非空字符串的 for...of 迭代次数 >= 1，故 total 恒 >= 1 */
  if (total === 0) return CJK_CHARS_PER_TOKEN
  const tokens = cjk / CJK_CHARS_PER_TOKEN + nonCjk / NON_CJK_CHARS_PER_TOKEN
  return total / tokens
}

/**
 * G4b: token 预算 → 字符预算（分支换算的唯一入口）。
 *
 * CJK 段 1.5 chars/token、非 CJK 段 1.0 chars/token；不传样本文本时沿用
 * 旧口径（1.5），保证既有调用点的数值不变。
 */
export function tokenBudgetToCharBudget(tokenBudget: number, sampleText?: string): number {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return 0
  const charsPerToken = sampleText === undefined
    ? CJK_CHARS_PER_TOKEN
    : charsPerTokenForText(sampleText)
  return Math.max(0, Math.floor(tokenBudget * charsPerToken))
}
/** E-02 (C-4): 硬注入占 maxCtx 比例上限。 */
export const HARD_INJECT_CTX_FRAC = 0.3

/**
 * G5 (R5 缓解): canonRules 预留槽参考额度 (chars)。
 *
 * 测算依据 (写死口径防验收不可复现)：
 *   - 典型 canonRules 体量：长篇项目正史规则 40–60 条 × 平均 ≈55 字符/条
 *     ≈ 2.2K–3.3K 字符；取上界 3_200 chars 作为「典型体量」；
 *   - +20% 裕量：3_200 × 1.2 = **3_840 chars** (吸收时序事实合并链路
 *     applyTemporalFactsToCanonRules 追加条目带来的增量)。
 *
 * **该常量只做告警阈值**：不从任何段的预算里扣除（见 computeContextBudget 注释）。
 * canonRules 不被 L4 截断是压缩链的行为（零截断），不是这个数字撑住的。
 */
export const RESERVED_CANON_RULES_CHARS = 3_840

/**
 * E-02 (C-4): 硬注入 cap 纯函数 — min(2048×1.5, floor(maxCtx×0.3)) chars。
 * 供 context-engine 装配与 spec 断言共用 (单一口径)。
 */
export function hardInjectionCapChars(maxCtx: number): number {
  const baselineChars = Math.floor(HARD_INJECT_TOKEN_CAP * CJK_CHARS_PER_TOKEN)
  return Math.min(baselineChars, Math.floor(maxCtx * HARD_INJECT_CTX_FRAC))
}

const DEFAULT_MAX_CTX = DEFAULT_MAX_CONTEXT_TOKENS
const RESERVE_FRAC = 0.15
const INDEX_FRAC = 0.05
const PAGE_FRAC = 0.5
const PER_PAGE_FRAC = 0.3
const PER_PAGE_FLOOR = 5_000
const MIN_INDEX_FLOOR = 2_000
const ENTITY_FLOOR = 8

/**
 * Chapter-adaptive scaling factor.
 *
 *   n <= 10:    1.0 (early chapters, small wiki)
 *   10 < n:     log-decay from 1.0 → 0.6 (compress as wiki grows)
 *
 * Curve: scale = 0.6 + 0.4 * (1 / log10(n)) for n > 10.
 * Undefined or <= 0 preserves the original static behavior.
 */
function adaptiveScale(chapterNumber: number | undefined): number {
  if (chapterNumber === undefined || chapterNumber <= 0) return 1.0
  if (chapterNumber <= 10) return 1.0
  return 0.6 + 0.4 * (1 / Math.log10(chapterNumber))
}

/**
 * Compute character budgets from the LLM's max context window.
 *
 * @param maxContextSize  The model's context window in **tokens**.
 *                        Falsy values fall back to DEFAULT_MAX_CTX.
 * @param chapterNumber   Optional chapter number for adaptive scaling.
 *                        Omit to preserve original static behavior.
 * @param strategyConfig  Optional F-008 三态策略阈值覆盖。
 */
export function computeContextBudget(
  maxContextSize: number | undefined,
  chapterNumber?: number,
  strategyConfig?: Partial<ContextStrategyConfig>,
): ContextBudget {
  const maxCtx =
    typeof maxContextSize === "number" && maxContextSize > 0
      ? maxContextSize
      : DEFAULT_MAX_CTX

  const responseReserve = Math.floor(maxCtx * RESERVE_FRAC)
  // F-008: 先选态再算预算（作为 adaptiveScale 曲线上层选择器，不替换曲线）。
  const strategy = selectContextStrategy(chapterNumber, strategyConfig)
  const scale = adaptiveScale(chapterNumber)

  // Index budget: 5% of context, scaled by chapter, with a floor.
  const indexBudget = Math.max(MIN_INDEX_FLOOR, Math.floor(maxCtx * INDEX_FRAC * scale))
  const pageBudget = Math.floor(maxCtx * PAGE_FRAC * scale)

  // Per-page cap: floor of 5K, ceiling of pageBudget, otherwise 30% of pageBudget.
  const maxPageSize = Math.min(
    pageBudget,
    Math.max(PER_PAGE_FLOOR, Math.floor(pageBudget * PER_PAGE_FRAC)),
  )

  // G5 (R5 缓解): canonRules 预留槽 = **告警阈值**（不扣减、不占位）。
  // 既有三项配额 (resp/index/page) 的配比常量与算式一字未改，数值与旧版相同；
  // 本字段只回答「这条配置下 canonRules 还剩多少余量」给告警判据用：
  // 它**没有**被从 maxCtx 里减掉，history / sys / index / page 的可用额度
  // 不因它变化，也没有任何装配点读它去限制其它段。
  // canonRules 不被 L4 截断的保证来自压缩链的零截断行为，不来自这个数字。
  const canonRulesReservedChars = Math.min(
    RESERVED_CANON_RULES_CHARS,
    Math.max(0, maxCtx - (responseReserve + indexBudget + pageBudget)),
  )

  // Active entities budget (compressible tier with floor).
  const entityFrac = 0.02
  const rank0Floor = Math.max(ENTITY_FLOOR, Math.floor(maxCtx * entityFrac * scale))
  const rank1CompressibleCap = Math.max(2, Math.floor(rank0Floor * 1.5))
  const rank2CompressibleCap = Math.max(1, Math.floor(rank0Floor * 0.5))

  return {
    maxCtx,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
    activeEntitiesBudget: { rank0Floor, rank1CompressibleCap, rank2CompressibleCap },
    strategy,
    // E-02 (C-4): 硬注入保护槽 — 恒算 (Fixed 轴, cap MUST NOT 运行时放宽)。
    hardInjectionBudget: {
      baselineChars: Math.floor(HARD_INJECT_TOKEN_CAP * CJK_CHARS_PER_TOKEN),
      capChars: hardInjectionCapChars(maxCtx),
    },
    // G5 (R5 缓解): canonRules 独立预留槽 — 恒算 (同 Fixed 轴, 不放宽)。
    canonRulesReserve: {
      reservedChars: canonRulesReservedChars,
      standardChars: RESERVED_CANON_RULES_CHARS,
      clamped: canonRulesReservedChars < RESERVED_CANON_RULES_CHARS,
    },
  }
}

export function resolveContextPackTokenBudget(
  config: { maxInputChars?: number; maxContextSize?: number } | undefined,
): number {
  return config?.maxInputChars ?? config?.maxContextSize ?? DEFAULT_MAX_CONTEXT_TOKENS
}
