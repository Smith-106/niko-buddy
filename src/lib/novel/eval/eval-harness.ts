/**
 * eval-harness.ts — F1 G1 骨架：评测执行器。
 *
 * 硬共识（eval-g1-skeleton.md）：
 *  - harness 必须注入 assemble 步骤（tier 在装配期判定）— 调用方提供
 *    assemble 函数（ContextPack 产出），harness 经 contextPackToAssembledView
 *    转视图后喂 L1/L2；L3 由调用方提供 findings（复用 checkContinuity）。
 *  - C9: replayOnlyFailed 默认 true（仅重跑失败 case）。
 */
import type { ContextPack } from "../context-engine"
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type {
  EvalCase,
  EvalRunConfig,
  EvalCaseResult,
  EvalRunResult,
  LayerResult,
} from "./eval-schema"
import { computeL1, computeL2, computeL3, aggregate } from "./eval-metrics"
import { contextPackToAssembledView } from "./eval-adapters"
import type { AssembledContextView } from "./eval-adapters"

/** 装配函数：case → ContextPack（tier 在装配期判定）。 */
export type AssembleFn = (caseItem: EvalCase) => Promise<ContextPack>

/** L3 信号源：case → findings（复用 checkContinuity 的调用方接线）。 */
export type L3FindingsFn = (caseItem: EvalCase, pack: ContextPack) => Promise<ContinuityFinding[]>

export interface RunEvalCaseOptions {
  assemble: AssembleFn
  l3Findings?: L3FindingsFn
  thresholds?: EvalRunConfig["thresholds"]
}

/** 单 case 运行：assemble → view → L1/L2/L3 → 聚合。 */
export async function runEvalCase(
  caseItem: EvalCase,
  options: RunEvalCaseOptions,
): Promise<EvalCaseResult> {
  const pack = await options.assemble(caseItem)
  const view: AssembledContextView = contextPackToAssembledView(pack)

  const l1 = computeL1(caseItem.goldChunks, view)
  const l2 = computeL2(caseItem.poisonChunks, view)
  const l3: LayerResult = options.l3Findings
    ? computeL3(await options.l3Findings(caseItem, pack))
    : { layer: "L3", pass: true, score: 0, detail: { skipped: true } }

  const agg = aggregate(l1, l2, l3, options.thresholds)
  return {
    caseId: caseItem.id,
    passed: agg.overall,
    layers: { L1: l1, L2: l2, L3: l3 },
    rejections: [],
  }
}

/** 全套运行：C9 replayOnlyFailed 默认 true。 */
export async function runEvalSuite(
  cases: readonly EvalCase[],
  options: RunEvalCaseOptions,
  config: EvalRunConfig = { replayOnlyFailed: true, thresholds: { l1Min: 0.95, l2Min: 0.99, l3Max: 0.01 } },
): Promise<EvalRunResult> {
  const replayOnlyFailed = config.replayOnlyFailed ?? true
  const caseIds = config.caseIds
  const selected = cases.filter((c) => {
    if (caseIds && !caseIds.includes(c.id)) return false
    return true
  })

  const results: EvalCaseResult[] = []
  for (const caseItem of selected) {
    const result = await runEvalCase(caseItem, options)
    if (replayOnlyFailed && result.passed) continue
    results.push(result)
  }

  const l1 = aggregateLayer(results, "L1")
  const l2 = aggregateLayer(results, "L2")
  const l3 = aggregateLayer(results, "L3")
  const aggregateResult = aggregate(l1, l2, l3, config.thresholds)

  return {
    config,
    cases: results,
    aggregate: aggregateResult,
  }
}

function aggregateLayer(results: EvalCaseResult[], layer: "L1" | "L2" | "L3"): LayerResult {
  if (results.length === 0) {
    return { layer, pass: true, score: 1, detail: { skipped: true } }
  }
  const scores = results.map((r) => r.layers[layer].score)
  const score = scores.reduce((a, b) => a + b, 0) / scores.length
  const pass = results.every((r) => r.layers[layer].pass)
  return { layer, pass, score, detail: { cases: results.length } }
}
