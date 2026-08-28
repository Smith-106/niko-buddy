/**
 * cross-lang-f1.ts — v2.7.4 跨语言泛化（相对阈值 ≥源域基线×95%）
 *
 * 蓝图 `docs/p0/blueprint-v274-20260828.md`：
 *   - 跨语言 F1 ≥ 源域锁定基线×95%（相对阈值，每语言独立计算）
 *   - 源域基线版本锁定（git commit + 评估快照）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 常量（共识定死）
// ============================================================================

/** 跨语言 F1 相对阈值。 */
export const CROSS_LANG_F1_RATIO = 0.95

// ============================================================================
// 跨语言 F1
// ============================================================================

/** 单语言 F1 结果。 */
export interface LangF1 {
  lang: string
  f1: number
}

/** 跨语言泛化结果。 */
export interface CrossLangResult {
  /** 源域锁定基线 F1。 */
  baselineF1: number
  /** 基线版本（锁定）。 */
  baselineVersion: string
  /** 各语言 F1 与判定。 */
  langs: Array<LangF1 & { passed: boolean }>
  /** 达标判定（全部语言 ≥基线×95%）。 */
  passed: boolean
}

/**
 * 跨语言 F1 评估（纯函数——确定性）。
 * 输入：源域锁定基线（F1+版本）+ 各语言 F1；输出：相对阈值判定。
 * 语义：每语言 F1 ≥ 基线×95% 才通过；基线版本必须显式锁定。
 */
export function evaluateCrossLang(baselineF1: number, baselineVersion: string, langs: LangF1[]): CrossLangResult {
  const threshold = baselineF1 * CROSS_LANG_F1_RATIO
  const results = langs.map((l) => ({ ...l, passed: l.f1 >= threshold }))
  return {
    baselineF1,
    baselineVersion,
    langs: results,
    passed: baselineVersion.length > 0 && results.length > 0 && results.every((r) => r.passed),
  }
}
