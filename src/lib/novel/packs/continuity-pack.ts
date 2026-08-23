/**
 * continuity-pack.ts — T24 一致性维度规则包 (Consistency P0)
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 1: packs/continuity-pack.ts（一致性维度规则集）。
 *
 * 设计:
 *   - 工厂 createContinuityPack(input): 接收连续性引擎入参，内部对
 *     checkContinuity() **单次求值并 memo**（共享特征预计算在 consistency 域的
 *     对应物——同章审查不重复跑引擎），按 finding.type 分桶为 6 条规则；
 *   - 每条 finding 的 dimensionId 取自引擎 T24 新增的 taxonomyDimId 字段
 *     （T22 37 维 id，见 deterministic-continuity-engine.ts），规则自身不重复
 *     硬编码维度映射（单一真源 = 引擎检测器）;
 *   - severity 映射对齐 toConsistencyReviewResult 口径: critical→error /
 *     warning→warning / info→info; data_gap (info) 保留可见不阻断 (守 IC-02)。
 *
 * 组合语义: 本包是未冻结 RulePackDefinition；必须经 T23 combinePacks() 冻结后
 * runRuleStack()（run 前冻结，禁动态注册）。combinePacks 组合期校验
 * dimensionId ∈ T22 注册表且与 gate 一致——本包 findings 的 taxonomyDimId 全部
 * 属 consistency 门 15 维（引擎映射保证），data_gap 无维度（跨维通用槽位合法）。
 *
 * 机械层零模型调用 (ADR-19): checkContinuity 纯函数零 IO 零 LLM，本包无模型调用。
 *
 * @license MIT © QMAI
 */

import {
  checkContinuity,
  DEFAULT_CONTINUITY_CONFIG,
  type ContinuityEngineConfig,
  type ContinuityFinding,
  type ContinuityInput,
  type ContinuityOverrideStore,
  type ReadonlyStore,
  type TimelineDriftEvent,
} from "../deterministic-continuity-engine"
import type { AuditDimensionId } from "../audit-taxonomy"
import type { RawRuleFinding, RuleDefinition, RulePackDefinition, RuleSeverity } from "../rule-stack"

// ============================================================================
// 类型
// ============================================================================

/** createContinuityPack 输入：引擎入参 + 可选 config/override/timelineEvents。 */
export interface ContinuityPackInput extends ContinuityInput {
  readonly config?: ContinuityEngineConfig
  readonly overrides?: ContinuityOverrideStore
  /** F-002 时间线漂移检测入参（ReadonlyStore.timelineEvents 同名透传，可选）。 */
  readonly timelineEvents?: readonly TimelineDriftEvent[]
}

/** continuity-pack 唯一包 id（经 combinePacks 后进入栈 id 字典序拼接）。 */
export const CONTINUITY_PACK_ID = "pack.continuity"

// ============================================================================
// 内部: finding 分桶 + severity 映射
// ============================================================================

/** 引擎 severity → rule-stack severity（对齐 toConsistencyReviewResult 映射）。 */
function toRuleSeverity(severity: ContinuityFinding["severity"]): RuleSeverity {
  if (severity === "critical") return "error"
  if (severity === "warning") return "warning"
  return "info"
}

/**
 * finding → 规则分桶键。data_gap 单独成桶（info 可见不阻断）；其余按 type 直分。
 */
function bucketKeyOf(finding: ContinuityFinding): string {
  if (finding.subtype === "data_gap" || finding.type === "data_gap") return "data_gap"
  return finding.type
}

/** 六条规则的分桶键（与 RULE_ID_BY_BUCKET 一一对应）。 */
const BUCKET_KEYS = [
  "dormant_thread",
  "absent_character",
  "overdue_thread",
  "unresolved_foreshadowing",
  "dead_character_state",
  "timeline_drift",
  "data_gap",
] as const

/** 规则 id（bucket → 全栈唯一 ruleId）。 */
const RULE_ID_BY_BUCKET: Record<(typeof BUCKET_KEYS)[number], string> = {
  dormant_thread: "continuity.dormant-thread",
  absent_character: "continuity.absent-character",
  overdue_thread: "continuity.overdue-thread",
  unresolved_foreshadowing: "continuity.unresolved-foreshadowing",
  dead_character_state: "continuity.dead-character-state",
  timeline_drift: "continuity.timeline-drift",
  data_gap: "continuity.data-gap",
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 构建一致性规则包。checkContinuity 在工厂调用时**求值一次**，6+1 条规则各自
 * 过滤共享 findings 数组（闭包引用，零重扫）。
 *
 * 空 store 安全：findings 为空时各规则 run() 返回空数组（合法，rules 允许空产出）。
 */
export function createContinuityPack(input: ContinuityPackInput): RulePackDefinition {
  const config = input.config ?? DEFAULT_CONTINUITY_CONFIG
  const overrideStore =
    input.overrides && input.overrides.overrides.length > 0 ? input.overrides : undefined

  // 共享预计算（consistency 域）: 引擎单次求值，全部规则复用同一 findings 快照。
  const store: ReadonlyStore = {
    foreshadowing: input.foreshadowing,
    subplots: input.subplots,
    characters: input.characters,
    snapshots: input.snapshots,
    currentChapter: input.currentChapter,
    ...(input.timelineEvents ? { timelineEvents: input.timelineEvents } : {}),
  }
  const sharedFindings: readonly ContinuityFinding[] = Object.freeze(
    checkContinuity(store, config, overrideStore),
  )

  const rules: RuleDefinition[] = BUCKET_KEYS.map((bucket) => ({
    id: RULE_ID_BY_BUCKET[bucket],
    gate: "consistency",
    // 规则级 dimensionId 不声明：finding 级 taxonomyDimId 才是真源
    // （overdue 桶横跨 subplot_resolution/foreshadowing_integrity 两维，
    //  维度归属由引擎逐 finding 标注，规则层不收敛到单维）。
    run: (): readonly RawRuleFinding[] =>
      sharedFindings
        .filter((f) => bucketKeyOf(f) === bucket)
        .map((f) => ({
          dimensionId: f.taxonomyDimId as AuditDimensionId | undefined,
          severity: toRuleSeverity(f.severity),
          message: f.message,
        })),
  }))

  return { id: CONTINUITY_PACK_ID, rules }
}

/** 空输入（composeCoreRulePacks 缺省域用；空 store 引擎求值返回空 findings）。 */
export const EMPTY_CONTINUITY_INPUT: ContinuityPackInput = {
  foreshadowing: [],
  subplots: [],
  characters: [],
  snapshots: [],
  currentChapter: 0,
}
