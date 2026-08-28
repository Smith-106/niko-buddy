/**
 * d3-probe.ts — v2.7.1 D3 探针对抗（分层三票加权 + 检出/误报双门）
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - 探针分层：规则（冻结守误报下限）+ 嵌入（语义漂移）+ 一致性（事实锚点）三票加权
 *   - 检出率 ≥90% 且误报率 ≤5%（两指标同报告同门控）
 *   - 灰区置信 [0.4,0.7] 全量人工复审
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// D3 探针
// ============================================================================

/** 检出硬门（共识定死）。 */
export const D3_DETECT_RATE = 0.9

/** 误报上限（共识定死）。 */
export const D3_FALSE_POSITIVE_RATE = 0.05

/** 灰区下限（共识定死）。 */
export const GRAY_ZONE_LOW = 0.4

/** 灰区上限（共识定死）。 */
export const GRAY_ZONE_HIGH = 0.7

/** 分层探针信号。 */
export interface ProbeSignals {
  rule: number
  embedding: number
  consistency: number
}

/** 单样本探针结果。 */
export interface ProbeResult {
  id: string
  /** 融合置信度。 */
  confidence: number
  /** 探针判定。 */
  verdict: "detected" | "clean" | "gray"
  /** 是否进入人工复审（灰区）。 */
  needsReview: boolean
}

/** 双门评测结果。 */
export interface ProbeMetrics {
  /** 检出率（对抗集命中）。 */
  detectRate: number
  /** 误报率（干净集误杀）。 */
  falsePositiveRate: number
  /** 灰区样本数。 */
  grayCount: number
  /** 双门是否同时达标。 */
  passed: boolean
}

/** 三票加权融合（规则 0.3 / 嵌入 0.4 / 一致性 0.3——确定性）。 */
export function fuseSignals(s: ProbeSignals): number {
  return Math.min(1, Math.max(0, s.rule * 0.3 + s.embedding * 0.4 + s.consistency * 0.3))
}

/** 单样本判定（灰区 [0.4,0.7] → 人工复审）。 */
export function classifyConfidence(confidence: number): Omit<ProbeResult, "id"> {
  if (confidence >= GRAY_ZONE_HIGH) return { confidence, verdict: "detected", needsReview: false }
  if (confidence <= GRAY_ZONE_LOW) return { confidence, verdict: "clean", needsReview: false }
  return { confidence, verdict: "gray", needsReview: true }
}

/**
 * 双门评测（纯函数——确定性）。
 * 输入：对抗集（label=1）+ 干净集（label=0）；输出：检出率/误报率/灰区计数。
 * 语义：检出 ≥90% 且误报 ≤5% 双门同达标；两指标同报告同门控。
 */
export function evaluateProbe(
  adversarial: ProbeResult[],
  clean: ProbeResult[],
): ProbeMetrics {
  const detect = adversarial.filter((p) => p.verdict === "detected").length
  const falsePos = clean.filter((p) => p.verdict === "detected").length
  const detectRate = adversarial.length === 0 ? 0 : detect / adversarial.length
  const falsePositiveRate = clean.length === 0 ? 0 : falsePos / clean.length
  const grayCount = adversarial.filter((p) => p.verdict === "gray").length + clean.filter((p) => p.verdict === "gray").length
  return {
    detectRate,
    falsePositiveRate,
    grayCount,
    passed: detectRate >= D3_DETECT_RATE && falsePositiveRate <= D3_FALSE_POSITIVE_RATE,
  }
}
