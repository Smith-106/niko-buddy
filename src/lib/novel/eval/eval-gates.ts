/**
 * eval-gates.ts — F1 G1 骨架：A 门判定。
 *
 * 硬共识 C1：L2≥0.99 > L1≥0.95 > L3<0.01。
 * 门控优先级固定：Consistency(P0) > Anti-AI(P1) > Quality(P2) —
 * L2（一致性毒化）失败不得被 L1/L3 覆盖。
 */
import type { AggregateResult } from "./eval-schema"
import { DEFAULT_THRESHOLDS } from "./eval-metrics"

export interface GateVerdict {
  pass: boolean
  gate: "A"
  reasons: string[]
}

/** A 门：L2 硬门（P0 一致性）优先，L1/L3 次之。 */
export function evaluateGateA(agg: AggregateResult): GateVerdict {
  const reasons: string[] = []
  const l2 = agg.layers.L2
  const l1 = agg.layers.L1
  const l3 = agg.layers.L3

  if (!l2.pass) {
    reasons.push(`L2=${l2.score.toFixed(4)} < ${DEFAULT_THRESHOLDS.l2Min} (P0 consistency gate)`)
  }
  if (!l1.pass) {
    reasons.push(`L1=${l1.score.toFixed(4)} < ${DEFAULT_THRESHOLDS.l1Min}`)
  }
  if (!l3.pass) {
    reasons.push(`L3=${l3.score.toFixed(4)} >= ${DEFAULT_THRESHOLDS.l3Max}`)
  }

  return {
    pass: reasons.length === 0,
    gate: "A",
    reasons,
  }
}
