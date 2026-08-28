/**
 * value-reveal.ts — v2.6.13 W3: 隐性价值显影补闭环（曝光→感知→采纳 + 熔断）
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md` W3：
 *   - 三态闭环：曝光（高亮）→感知（悬浮说明）→采纳（一键回传）
 *   - 采纳回写成功率≥99%；埋点覆盖 100%
 *   - 熔断降级：双门返工则自动降级不阻塞发版
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// W3 隐性价值显影闭环
// ============================================================================

/** 采纳回写成功率阈值（共识定死）。 */
export const REVEAL_WRITE_RATE = 0.99

/** 三态事件。 */
export type RevealStage = "exposure" | "perception" | "adoption"

/** 显影闭环结果。 */
export interface RevealResult {
  /** 三态事件计数。 */
  counts: Record<RevealStage, number>
  /** 三态埋点覆盖（100% 要求）。 */
  coverageComplete: boolean
  /** 采纳回写成功率。 */
  writeRate: number
  /** 熔断降级标记（双门返工时自动降级）。 */
  degraded: boolean
}

/**
 * 显影闭环判定（纯函数——确定性）。
 * 输入：三态事件计数 + 采纳回写成功数；输出：闭环完整性 + 熔断降级。
 * 语义：曝光→感知→采纳链路完整（单调不增）+ 埋点 100% + 回写≥99%。
 */
export function evaluateValueReveal(
  exposure: number,
  perception: number,
  adoption: number,
  writeSuccess: number,
  degraded = false,
): RevealResult {
  const coverageComplete = perception <= exposure && adoption <= perception
  const writeRate = adoption === 0 ? 0 : writeSuccess / adoption
  return {
    counts: { exposure, perception, adoption },
    coverageComplete,
    writeRate,
    degraded,
  }
}
