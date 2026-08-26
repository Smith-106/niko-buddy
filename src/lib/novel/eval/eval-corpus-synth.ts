/**
 * eval-corpus-synth.ts — F1 G1 骨架：合成语料生成器。
 *
 * 硬共识（eval-g1-skeleton.md C7/C8）：
 *  - C7: synthetic 显式标注（source: "synthetic"）
 *  - C8: 200 case 六场景 + 留出集 15%（holdout）
 *  - fixture 非运行时真源（C6）：生成结果落 eval/fixtures/，运行时只读。
 *
 * 六场景（场景 id 前缀）：
 *  - canon_retrieval: canon 三元组应进 protected（L1 正例）
 *  - temporal_current: 有效 temporal 事实应进 protected（L1 正例）
 *  - former_isolation: 曾成立事实应落 former 层，禁进 protected（L2 负例）
 *  - contradiction: 与 canon 矛盾内容禁进 protected（L2 负例）
 *  - crossbook_leak: 跨书引用禁进 protected（L2 负例）
 *  - temporal_inversion: 时序倒置禁进 protected（L2 负例）
 */
import type { EvalCase, EvalManifest } from "./eval-schema"

export const EVAL_SCENARIOS = [
  "canon_retrieval",
  "temporal_current",
  "former_isolation",
  "contradiction",
  "crossbook_leak",
  "temporal_inversion",
] as const

export type EvalScenario = (typeof EVAL_SCENARIOS)[number]

export const SYNTH_CASE_COUNT = 200
export const SYNTH_HOLDOUT_RATIO = 0.15

const SUBJECTS = ["白砚", "苏未晞", "轩辕剑", "凌霄殿", "墨渊"]
const PREDICATES = ["持有", "位于", "状态", "关系", "能力"]

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!
}

/** 生成单个合成 case（确定性：seed 驱动，无随机）。 */
export function synthCase(seed: number, scenario: EvalScenario): EvalCase {
  const subject = pick(SUBJECTS, seed)
  const predicate = pick(PREDICATES, seed + 1)
  const object = pick(SUBJECTS, seed + 2)
  const chapter = (seed % 40) + 1

  const base = {
    id: `synth-${scenario}-${seed}`,
    chapter,
    query: `${subject} ${predicate}`,
    source: "synthetic" as const,
  }

  switch (scenario) {
    case "canon_retrieval":
      return {
        ...base,
        goldChunks: [{ id: `g-${seed}`, subject, predicate, object, tier: "protected", expectedLayer: "protected" }],
        poisonChunks: [],
        expectedLayer: "protected",
      }
    case "temporal_current":
      return {
        ...base,
        goldChunks: [{ id: `g-${seed}`, subject, predicate, object, tier: "protected", expectedLayer: "protected" }],
        poisonChunks: [],
        expectedLayer: "protected",
      }
    case "former_isolation":
      return {
        ...base,
        goldChunks: [],
        poisonChunks: [{
          id: `p-${seed}`,
          subject,
          predicate,
          object,
          poisonType: "former_as_current",
          expectedLanding: "former",
        }],
        expectedLayer: "former",
      }
    case "contradiction":
      return {
        ...base,
        goldChunks: [],
        poisonChunks: [{
          id: `p-${seed}`,
          subject,
          predicate,
          object,
          poisonType: "contradiction",
          expectedLanding: "excluded",
        }],
        expectedLayer: "excluded",
      }
    case "crossbook_leak":
      return {
        ...base,
        goldChunks: [],
        poisonChunks: [{
          id: `p-${seed}`,
          subject,
          predicate,
          object,
          poisonType: "crossbook_leak",
          expectedLanding: "excluded",
        }],
        expectedLayer: "excluded",
      }
    case "temporal_inversion":
      return {
        ...base,
        goldChunks: [],
        poisonChunks: [{
          id: `p-${seed}`,
          subject,
          predicate,
          object,
          poisonType: "temporal_inversion",
          expectedLanding: "excluded",
        }],
        expectedLayer: "excluded",
      }
  }
}

/** 生成全套 200 case（六场景均分）+ 留出集 15%。 */
export function synthCorpus(): { cases: EvalCase[]; holdout: EvalCase[]; manifest: EvalManifest } {
  const perScenario = Math.floor(SYNTH_CASE_COUNT / EVAL_SCENARIOS.length)
  const cases: EvalCase[] = []
  for (let s = 0; s < EVAL_SCENARIOS.length; s++) {
    for (let i = 0; i < perScenario; i++) {
      cases.push(synthCase(s * 1000 + i, EVAL_SCENARIOS[s]!))
    }
  }
  const holdoutSize = Math.round(cases.length * SYNTH_HOLDOUT_RATIO)
  const holdout = cases.slice(0, holdoutSize)
  const train = cases.slice(holdoutSize)

  return {
    cases: train,
    holdout,
    manifest: {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      totalCases: cases.length,
      holdoutRatio: SYNTH_HOLDOUT_RATIO,
      scenarios: [...EVAL_SCENARIOS],
      source: "synthetic",
    },
  }
}
