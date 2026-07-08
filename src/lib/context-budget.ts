/**
 * Pure budget allocator for chat context assembly.
 *
 * Given an LLM's `maxContextSize` (in characters — see wiki-store.ts;
 * yes, that's a quirky unit, but tokens-vs-chars conversion lives
 * elsewhere), compute the per-section character budgets used by
 * chat-panel when packing the prompt.
 *
 * Why this is its own module:
 *   - The math has corner cases that deserve their own tests
 *     (tiny configs, huge configs, the legacy 30K cap removal).
 *   - Inlining it in chat-panel.tsx made it untestable in isolation.
 *
 * The shape of the budget:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              maxCtx (100%)                          │
 *   ├──────┬───────────────┬──────────────────┬───────────┤
 *   │ idx  │   pages       │  history + sys   │  resp     │
 *   │  5%  │    50%        │    ~30%          │   15%     │
 *   └──────┴───────────────┴──────────────────┴───────────┘
 *
 * `historyAndSystem` isn't returned because it's not enforced as a
 * single budget — system prompt is roughly fixed-size, and history
 * is gated by `maxHistoryMessages` (count, not bytes). The leftover
 * just provides headroom.
 *
 * The response reserve is a "passive" reservation: we don't pass
 * `max_tokens: responseReserve / 3` to the LLM (yet — that's a
 * follow-up). We just refuse to fill above (maxCtx - responseReserve)
 * so the LLM has room to actually answer.
 */

/** Result of `computeContextBudget`. All values are character counts. */
export interface ContextBudget {
  /** The model's full context window (always populated; falls back
   *  to a sensible default when caller passes 0/undefined). */
  maxCtx: number
  /** Characters NOT to be filled with prompt content — left empty so
   *  the LLM has room to write its response. */
  responseReserve: number
  /** Wiki index summary budget. ~5% — enough to list every page's
   *  title without occupying serious budget. */
  indexBudget: number
  /** Total characters available for retrieved wiki page content. */
  pageBudget: number
  /** Per-page truncation cap. A single page won't be embedded longer
   *  than this even if `pageBudget` would allow it. Scales with
   *  pageBudget (used to be hard-capped at 30,000 chars regardless
   *  of context size — that wasted budget on long-context models). */
  maxPageSize: number
}

const DEFAULT_MAX_CTX = 204_800
const RESPONSE_RESERVE_FRAC = 0.15
const INDEX_BUDGET_FRAC = 0.05
const PAGE_BUDGET_FRAC = 0.5
const PER_PAGE_FRAC = 0.3
const PER_PAGE_FLOOR = 5_000

/**
 * CORR-013 (TASK-007): floor for the index budget. Without this, tiny
 * `maxContextSize` configs (e.g. 10K) produce an indexBudget of ~500 chars
 * (5% of 10K), which is too small to list every page's title — the wiki
 * index summary becomes a single truncated line. The floor is applied
 * AFTER adaptive scaling so tiny configs at all chapter scales still list
 * page titles. For normal configs (200K+) the floor sits well below the
 * scaled value, so behavior is unchanged (additive, backward compatible).
 */
const MIN_INDEX_FLOOR = 2_000

/**
 * TASK-003 (ANL-013 S4): chapterNumber-adaptive budget scaling.
 *
 * The static budget (5% index / 50% pages / 15% response) was invariant to
 * novel length — chapter 5 and chapter 500 got the same allocation, even
 * though the wiki at chapter 500 is ~100x larger. The adaptive curve:
 *
 *   - chapterNumber <= 10:   full budget (scale = 1.0)  — early chapters
 *                            have small wikis, no pressure to compress.
 *   - 10 < n <= 100:         log-decay to 0.8           — mid-novel, wiki
 *                            grows; gently compress non-protected tiers.
 *   - n > 100:               converge to 0.6            — long-form, wiki
 *                            is large; protected tiers still full-inject,
 *                            compressible tiers take the cut.
 *
 * The scale is applied to `indexBudget` and `pageBudget` (the budget-elastic
 * pools). `responseReserve` is tied to `maxCtx` and is NOT scaled — the LLM
 * always needs the same room to answer regardless of novel length.
 *
 * `chapterNumber === undefined` (or <= 0) keeps the original static logic
 * unchanged — backward compatible with every existing caller that doesn't
 * know the chapter number.
 *
 * Curve: scale = 1.0 for n<=10; for n>10, scale = 0.6 + 0.4 * (log10(10)/log10(n))
 * which at n=10 gives 1.0, at n=100 gives 0.8, and as n→∞ approaches 0.6.
 */
function chapterAdaptiveScale(chapterNumber: number | undefined): number {
  if (chapterNumber === undefined || chapterNumber <= 0) return 1.0
  if (chapterNumber <= 10) return 1.0
  // log10(n) for n>10 is > 1; log10(10)=1, so ratio = 1/log10(n) in (0,1].
  // scale goes from 1.0 (n=10) → 0.8 (n=100) → 0.6 (n→∞).
  const logRatio = 1 / Math.log10(chapterNumber)
  return 0.6 + 0.4 * logRatio
}

/**
 * Compute character budgets from the LLM's max context window.
 *
 * Falsy `maxContextSize` (0 / NaN / undefined) falls back to the
 * pre-Phase-1 default of 200K chars so existing configs don't break.
 *
 * `chapterNumber` (optional, TASK-003) activates adaptive budget scaling:
 * early chapters get the full static budget; later chapters compress the
 * index/page pools as the wiki grows. Omitting it preserves the original
 * static behavior (backward compatibility).
 */
export function computeContextBudget(
  maxContextSize: number | undefined,
  chapterNumber?: number,
): ContextBudget {
  const maxCtx =
    typeof maxContextSize === "number" && maxContextSize > 0
      ? maxContextSize
      : DEFAULT_MAX_CTX

  const responseReserve = Math.floor(maxCtx * RESPONSE_RESERVE_FRAC)

  // Adaptive scale: compress index/page budgets as the novel grows.
  // Undefined chapterNumber → scale 1.0 → original static behavior.
  const scale = chapterAdaptiveScale(chapterNumber)
  // CORR-013 (TASK-007): MIN_INDEX_FLOOR applied AFTER scaling so tiny
  // maxContextSize configs still list every page's title in the wiki index
  // summary. Additive — for normal configs the floor is below the scaled
  // value, so behavior is unchanged.
  const indexBudget = Math.max(MIN_INDEX_FLOOR, Math.floor(maxCtx * INDEX_BUDGET_FRAC * scale))
  const pageBudget = Math.floor(maxCtx * PAGE_BUDGET_FRAC * scale)

  // Per-page cap rules:
  //   - At minimum, allow PER_PAGE_FLOOR (5K) so a small config still
  //     fits one short page.
  //   - At maximum, never exceed pageBudget itself — for tiny configs
  //     where pageBudget < 5K, the floor would otherwise allow a
  //     single page bigger than the entire page budget, which then
  //     gets entirely rejected by tryAddPage in chat-panel.
  //   - Otherwise scale linearly with pageBudget at PER_PAGE_FRAC (30%).
  const maxPageSize = Math.min(
    pageBudget,
    Math.max(PER_PAGE_FLOOR, Math.floor(pageBudget * PER_PAGE_FRAC)),
  )

  return {
    maxCtx,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
  }
}
