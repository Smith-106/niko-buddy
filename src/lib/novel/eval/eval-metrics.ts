/**
 * eval-metrics.ts — F1 G1 骨架：三层指标计算。
 *
 * 硬共识（eval-g1-skeleton.md C1/C3/C5）：
 *  - L1: protected 层存在性（非 rank）— goldChunk 三元组在 protectedCurrent 命中
 *  - L2: poisonChunk 不得进入 protected 层（former 类允许落 former 层）
 *  - L3: 仅计 ContinuityFinding critical + subtype=consistency_mechanical
 *  - A 门：L2≥0.99 > L1≥0.95 > L3<0.01（阈值由 config 注入，默认值在此）
 */
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type { GoldChunk, PoisonChunk, LayerResult, AggregateResult } from "./eval-schema"
import { layerContainsTriple, isL3CriticalFinding } from "./eval-adapters"
import type { AssembledContextView } from "./eval-adapters"

export const DEFAULT_THRESHOLDS = {
  l1Min: 0.95,
  l2Min: 0.99,
  l3Max: 0.01,
} as const

/** L1：goldChunk 在 protected 层存在性命中率（C5：非 rank）。 */
export function computeL1(
  goldChunks: readonly GoldChunk[],
  view: AssembledContextView,
): LayerResult {
  if (!view.protectedLayerAssembled) {
    return {
      layer: "L1",
      pass: false,
      score: 0,
      detail: { reason: "protected layer not assembled" },
    }
  }
  if (goldChunks.length === 0) {
    return { layer: "L1", pass: true, score: 1, detail: { hits: 0, total: 0 } }
  }
  const hits = goldChunks.filter((g) =>
    layerContainsTriple(view.protectedCurrent, g.subject, g.predicate, g.object),
  ).length
  const score = hits / goldChunks.length
  return {
    layer: "L1",
    pass: score >= DEFAULT_THRESHOLDS.l1Min,
    score,
    detail: { hits, total: goldChunks.length },
  }
}

/** L2：poisonChunk 不得进入 protected 层（former 类允许落 former 层）。 */
export function computeL2(
  poisonChunks: readonly PoisonChunk[],
  view: AssembledContextView,
): LayerResult {
  if (!view.protectedLayerAssembled) {
    return {
      layer: "L2",
      pass: false,
      score: 0,
      detail: { reason: "protected layer not assembled" },
    }
  }
  if (poisonChunks.length === 0) {
    return { layer: "L2", pass: true, score: 1, detail: { leaks: 0, total: 0 } }
  }
  const leaks = poisonChunks.filter((p) => {
    const inProtected = layerContainsTriple(view.protectedCurrent, p.subject, p.predicate, p.object)
    if (!inProtected) return false
    // former 类毒化允许落 former 层（曾成立事实独立分块），但不得进 protected
    if (p.poisonType === "former_as_current" && p.expectedLanding === "former") {
      return !layerContainsTriple(view.protectedFormer, p.subject, p.predicate, p.object)
    }
    return true
  }).length
  const score = 1 - leaks / poisonChunks.length
  return {
    layer: "L2",
    pass: score >= DEFAULT_THRESHOLDS.l2Min,
    score,
    detail: { leaks, total: poisonChunks.length },
  }
}

/** L3：critical + consistency_mechanical finding 占比（C3）。 */
export function computeL3(findings: readonly ContinuityFinding[]): LayerResult {
  const critical = findings.filter(isL3CriticalFinding)
  const score = findings.length === 0 ? 0 : critical.length / findings.length
  return {
    layer: "L3",
    pass: score < DEFAULT_THRESHOLDS.l3Max,
    score,
    detail: { critical: critical.length, total: findings.length },
  }
}

/** 聚合：A 门判定（L2≥0.99 > L1≥0.95 > L3<0.01）。 */
export function aggregate(
  l1: LayerResult,
  l2: LayerResult,
  l3: LayerResult,
  thresholds: { l1Min?: number; l2Min?: number; l3Max?: number } = {},
): AggregateResult {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const overall = l1.pass && l2.pass && l3.pass
  return {
    overall,
    layers: { L1: l1, L2: l2, L3: l3 },
    verdict: overall
      ? "PASS"
      : [
          l1.pass ? "" : `L1<${t.l1Min}`,
          l2.pass ? "" : `L2<${t.l2Min}`,
          l3.pass ? "" : `L3>=${t.l3Max}`,
        ].filter(Boolean).join("; ") || "FAIL",
  }
}
