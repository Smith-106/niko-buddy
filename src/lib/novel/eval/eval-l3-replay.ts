/**
 * eval-l3-replay.ts — F1 G1 骨架：L3 回放。
 *
 * 硬共识（eval-g1-skeleton.md C3）：
 *  - L3 复用 checkContinuity（deterministic-continuity-engine.ts）
 *  - 仅计 subtype=consistency_mechanical 且 severity=critical 的 finding
 *  - 回放输入：装配期产出的 ContextPack 相关字段（canonRules/timeline/
 *    characterStates/formerFacts），由调用方接线真实 checkContinuity。
 */
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type { EvalCase } from "./eval-schema"
import { isL3CriticalFinding } from "./eval-adapters"

export interface L3ReplayInput {
  /** 调用方注入的 checkContinuity 执行器（真实引擎接线点）。 */
  runCheckContinuity: (input: unknown) => Promise<ContinuityFinding[]>
  /** 回放上下文（由 harness assemble 步骤产出）。 */
  context: unknown
}

/** 回放 L3：执行 checkContinuity → 过滤 critical+consistency_mechanical。 */
export async function replayL3(
  _caseItem: EvalCase,
  input: L3ReplayInput,
): Promise<ContinuityFinding[]> {
  const findings = await input.runCheckContinuity(input.context)
  return findings.filter(isL3CriticalFinding)
}
