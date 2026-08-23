/**
 * quality-six-dim-pack.ts — T24 六维评审规则包 + 有界并发短路边界运行器
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 1/4:
 *   - packs/quality-six-dim-pack.ts（六维评审）: 把六维评审结果投影为 T23 规则包
 *     （thrill/pacing/pull → quality 门三维；character/consistency/continuity →
 *     consistency 门三维——与 dimension-review-adapter.DIM_TO_GATE_TYPE 的门归属
 *     口径一致，维度升级为 T22 37 维精确槽位）。
 *   - 六维评审并行化: runSixDimBounded() 有界并发运行器——按门优先级分组
 *     （GATE_PRIORITY_ORDER），组内有界并发（默认 3，任务口径 2-3）；P0/P1 组
 *     fail 时经 T23 hardShortCircuit 短路后续低优先级组（复用 rule-stack 语义，
 *     Quality 永不触发短路）。
 *
 * ADR-19 边界: 本模块零模型调用。evaluate 回调由调用方注入（生产传
 * reviewChapterDimension 包装），本文件只做编排与投影。
 *
 * 组合语义: 未冻结 RulePackDefinition，须经 T23 combinePacks() 冻结后运行。
 *
 * @license MIT © QMAI
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "../audit-taxonomy"
import {
  hardShortCircuit,
  type GateVerdict,
  type RawRuleFinding,
  type RuleDefinition,
  type RulePackDefinition,
  type RuleSeverity,
} from "../rule-stack"
import type { DimensionReviewResult, SixReviewDimensionKey } from "../dimension-review-adapter"
import type { SharedTextFeatures } from "./shared-text-features"

// ============================================================================
// 类型与常量
// ============================================================================

/** quality-six-dim-pack 唯一包 id。 */
export const QUALITY_SIX_DIM_PACK_ID = "pack.quality-six-dim"

/** 六维 key → 门控键（与 DIM_TO_GATE_TYPE 三门归属同口径）。 */
export const SIX_DIM_KEY_GATE: Readonly<Record<SixReviewDimensionKey, GateKey>> = {
  thrill: "quality",
  pacing: "quality",
  pull: "quality",
  character: "consistency",
  consistency: "consistency",
  continuity: "consistency",
}

/** 有界并发默认值（任务口径 2-3，取上界 3）。 */
export const DEFAULT_SIX_DIM_CONCURRENCY = 3

export interface QualitySixDimInputs {
  /** 六维评审结果（缺维 → 对应规则空产出）。 */
  readonly results: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  /** 共享特征预计算产物（可选；提供时产出结构统计 info 规则）。 */
  readonly features?: SharedTextFeatures
}

/** 有界并发运行结果（skippedKeys = 被硬短路跳过的维）。 */
export interface SixDimBoundedRunResult<K extends string> {
  /** 已评估维的结果（skipped 维不出现）。 */
  readonly results: Partial<Record<K, DimensionReviewResult>>
  /** 被短路跳过的维（保规范序）。 */
  readonly skippedKeys: readonly K[]
  /** 触发短路的门（未短路为 null）。 */
  readonly shortCircuitGate: GateKey | null
}

// ============================================================================
// 六维 → 规则投影
// ============================================================================

/** 六维 key → 规则三元组（ruleId / gate / T22 维度）。 */
const SIX_DIM_RULE_SPEC: Readonly<
  Record<SixReviewDimensionKey, { ruleId: string; gate: GateKey; dimensionId: RawRuleFinding["dimensionId"] }>
> = {
  thrill: { ruleId: "six-dim.thrill", gate: "quality", dimensionId: "thrill_density" },
  pacing: { ruleId: "six-dim.pacing", gate: "quality", dimensionId: "pacing_tension" },
  pull: { ruleId: "six-dim.pull", gate: "quality", dimensionId: "reading_power" },
  character: { ruleId: "six-dim.character", gate: "consistency", dimensionId: "character_consistency" },
  consistency: { ruleId: "six-dim.consistency", gate: "consistency", dimensionId: "setting_consistency" },
  continuity: { ruleId: "six-dim.continuity", gate: "consistency", dimensionId: "timeline_consistency" },
}

/**
 * 维度级 status → severity 下限（镜像 dimension-review-adapter.severityForIssue
 * 的「维度状态是下限」口径）: error→error / high|medium→warning / low|pass→info。
 */
function severityFloorOf(status: DimensionReviewResult["status"]): RuleSeverity {
  if (status === "error") return "error"
  if (status === "high" || status === "medium") return "warning"
  return "info"
}

const SEVERITY_ORDER: Record<RuleSeverity, number> = { error: 2, warning: 1, info: 0 }

/** 取更严重一档（error > warning > info）。 */
function maxSeverity(a: RuleSeverity, b: RuleSeverity): RuleSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b
}

/**
 * 构建六维评审规则包（7 条规则：6 维各一条 + 结构统计 info 一条）。
 * 结果集在工厂调用时快照（共享预计算语义），run() 只读不重算。
 */
export function createQualitySixDimPack(inputs: QualitySixDimInputs): RulePackDefinition {
  const results = inputs.results ?? {}

  const dimRules: RuleDefinition[] = (
    Object.keys(SIX_DIM_RULE_SPEC) as SixReviewDimensionKey[]
  ).map((key) => {
    const spec = SIX_DIM_RULE_SPEC[key]
    return {
      id: spec.ruleId,
      gate: spec.gate,
      dimensionId: spec.dimensionId,
      run: (): readonly RawRuleFinding[] => {
        const result = results[key]
        if (!result) return []
        const floor = severityFloorOf(result.status)
        if (result.issues.length > 0) {
          return result.issues.map((issue) => ({
            dimensionId: spec.dimensionId,
            severity: maxSeverity(floor, issue.severity),
            message: `[六维:${key}] ${issue.message}`,
          }))
        }
        // CORR-010 口径（维度自身状态权威）：无 issue 但维度状态为 error/warning
        // 时仍须产出对应级别 finding，否则门投影只见 info 会误判 pass。
        if (floor !== "info") {
          return [{
            dimensionId: spec.dimensionId,
            severity: floor,
            message: `[六维:${key}] 维度状态 ${result.status}: ${result.summary || "无 issue 明细"}`,
          }]
        }
        // 无 issue 且状态低平 → info 摘要 —— 门控记录该维已评审（对齐
        // dimensionResultsToReviewResults 的空 issue info 摘要口径）。
        return [{
          dimensionId: spec.dimensionId,
          severity: "info",
          message: `[六维:${key}] ${result.summary || "pass"} (score ${result.score}, status ${result.status})`,
        }]
      },
    }
  })

  // 共享特征预计算消费方：结构统计 info 规则（P2 info 永不阻断；
  // 句式/段落/n-gram 多样性作为结构平衡维的机械参照，一次扫描全局复用）。
  const structureStatsRule: RuleDefinition = {
    id: "six-dim.structure-stats",
    gate: "quality",
    dimensionId: "structural_balance",
    run: (): readonly RawRuleFinding[] => {
      const features = inputs.features
      if (!features) return []
      return [{
        dimensionId: "structural_balance",
        severity: "info",
        message: `[共享特征预计算] 句 ${features.sentenceLengths.length} 句 (CV ${features.sentenceLengthCV.toFixed(3)}), 段 ${features.paragraphLengths.length} 段 (CV ${features.paragraphLengthCV.toFixed(3)}), 3-gram ${features.trigramUnique}/${features.trigramTotal} 唯一`,
      }]
    },
  }

  return { id: QUALITY_SIX_DIM_PACK_ID, rules: [...dimRules, structureStatsRule] }
}

// ============================================================================
// 有界并发 + 硬短路运行器
// ============================================================================

/**
 * 六维评审裁定（T23 hardShortCircuit 输入口径）:
 *   status==="error" 或任一 issue severity==="error" → "fail"，否则 "pass"。
 * （对齐 severityForIssue 的维度状态权威语义：error 态维度即失败。）
 */
export function deriveSixDimVerdict(result: DimensionReviewResult): GateVerdict {
  const failed =
    result.status === "error" || result.issues.some((issue) => issue.severity === "error")
  return failed ? "fail" : "pass"
}

/** 有界并发 worker pool：保序返回全部结果；limit ≥ 1。 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        await worker(items[index]!)
      }
    },
  )
  await Promise.all(runners)
}

/**
 * 六维评审有界并发运行器（要求 4: quality 维内有界并发 2-3；P0/P1 硬门先短路）。
 *
 * 执行契约:
 *   1. 按 GATE_PRIORITY_ORDER 把 keys 分门分组（consistency → anti_ai → quality）;
 *   2. 逐门顺序执行，门内 keys 以有界并发（options.concurrency，默认 3）运行;
 *   3. 每门完成后聚合裁定（任一维 fail → 门 fail），命中 T23 hardShortCircuit
 *      （P0/P1 fail）→ 后续所有低优先级门的 keys 记入 skippedKeys 不再评估;
 *      Quality(P2) fail 永不短路（CLAUDE.md 硬约束 3）;
 *   4. evaluate 抛错直接向上传播（调用方自行逐维兜底——与现行
 *      runSixDimensionReview 逐维 try/catch → buildFailedDimensionResult 同约定）。
 *
 * 纯编排零模型调用（ADR-19）：evaluate 由调用方注入。
 */
export async function runSixDimBounded<K extends SixReviewDimensionKey>(
  keys: readonly K[],
  evaluate: (key: K) => Promise<DimensionReviewResult>,
  options?: { readonly concurrency?: number },
): Promise<SixDimBoundedRunResult<K>> {
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_SIX_DIM_CONCURRENCY))
  const results: Partial<Record<K, DimensionReviewResult>> = {}
  const skippedKeys: K[] = []
  let shortCircuitGate: GateKey | null = null

  for (const gate of GATE_PRIORITY_ORDER) {
    const gateKeys = keys.filter((key) => SIX_DIM_KEY_GATE[key] === gate)
    if (gateKeys.length === 0) continue
    if (shortCircuitGate !== null) {
      skippedKeys.push(...gateKeys)
      continue
    }
    const outcomes = new Map<K, DimensionReviewResult>()
    await runBounded(gateKeys, concurrency, async (key) => {
      outcomes.set(key, await evaluate(key))
    })
    for (const [key, result] of outcomes) {
      results[key] = result
    }
    const gateFailed = [...outcomes.values()].some((r) => deriveSixDimVerdict(r) === "fail")
    if (hardShortCircuit(gate, gateFailed ? "fail" : "pass")) {
      shortCircuitGate = gate
    }
  }

  return { results, skippedKeys, shortCircuitGate }
}
