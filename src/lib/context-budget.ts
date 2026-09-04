/**
 * Pure budget allocator for chat context assembly.
 *
 * Given an LLM's `maxContextSize` (in characters), computes per-section
 * character budgets used by the chat panel when packing the prompt:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              maxCtx (100%)                          │
 *   ├──────┬───────────────┬──────────────────┬───────────┤
 *   │ idx  │   pages       │  history + sys   │  resp     │
 *   │  5%  │    50%        │    ~30%          │   15%     │
 *   └──────┴───────────────┴──────────────────┴───────────┘
 *
 * MIT License — independently implemented.
 */

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
/** E-02 (C-4): 硬注入占 maxCtx 比例上限。 */
export const HARD_INJECT_CTX_FRAC = 0.3

/**
 * E-02 (C-4): 硬注入 cap 纯函数 — min(2048×1.5, floor(maxCtx×0.3)) chars。
 * 供 context-engine 装配与 spec 断言共用 (单一口径)。
 */
export function hardInjectionCapChars(maxCtx: number): number {
  const baselineChars = Math.floor(HARD_INJECT_TOKEN_CAP * CJK_CHARS_PER_TOKEN)
  return Math.min(baselineChars, Math.floor(maxCtx * HARD_INJECT_CTX_FRAC))
}

const DEFAULT_MAX_CTX = 204_800
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
 * @param maxContextSize  The model's context window in characters.
 *                        Falsy values fall back to a 200K default.
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
  }
}

export function resolveContextPackTokenBudget(
  config: { maxInputChars?: number; maxContextSize?: number } | undefined,
): number {
  return config?.maxInputChars ?? config?.maxContextSize ?? 204_800
}
