/**
 * world-constraint-gate.ts — 波2-A 模块 13：世界样本约束 → P0 门联动。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 13）：
 *   - GLM P0 缺口「world-sample 门联动」：transferableConstraints 已入库但未与
 *     门联动执行——本模块把世界样本库条目编译为 RuleDefinition 闭包
 *     （text + entries 构造期求值一次，run() 返回预计算只读 findings），
 *     交由 rule-stack combinePacks/runRuleStack 走既有 P0>P1>P2 门序；
 *   - 硬约束（transferableConstraints）违规 → P0 error finding（consistency
 *     门 gateProjection 存在 error 即 FAIL）；
 *   - 软约束（softConstraints）违规 → 恒 warning（gateProjection 只认
 *     error→fail，warning 不影响 verdict）——「软违规不得 P0 FAIL」不变量；
 *   - 机械子串近似（ADR-19 零模型调用）：约束 DSL 只有 forbid:/require: 两种
 *     机械判据；裸串视为 require（正文须含该锚点 token）。LLM 语义级约束
 *     判定明确 out-of-scope（语义违例由 LLM 中介门承担，本模块只做机械面）。
 *
 * 执行记录落事件账本可追溯（GLM 验收）：findings 经 runRuleStack 盖章后由
 * 上层 recordGateRunEvents 携带 evidenceRefs（ruleId 即 world-sample 条目锚）
 * 落 gate-run 事件——证据卡可点开（见 gate-chain-e2e.spec.ts）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

import type { WorldSampleEntry } from "./asset-library"
import type { RawRuleFinding, RuleDefinition, RulePackDefinition, RuleRunContext } from "./rule-stack"

// ============================================================================
// 契约与错误
// ============================================================================

/** 规则包 id（恒定；combinePacks 元数据字典序参与栈 id）。 */
export const WORLD_CONSTRAINT_PACK_ID = "world-constraint"

/** 约束判据种类：forbid=正文不得含 literal；require=正文必须含 literal。 */
export type WorldConstraintKind = "forbid" | "require"

/** 解析后的单条约束。 */
export interface ParsedWorldConstraint {
  readonly kind: WorldConstraintKind
  /** 机械判据 literal（非空，已 trim）。 */
  readonly literal: string
  /** 原始约束文本（finding message 引用，可追溯回世界样本条目）。 */
  readonly raw: string
}

/** world-constraint-gate 错误（空 entryId 等结构守卫）。 */
export class WorldConstraintGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorldConstraintGateError"
  }
}

/**
 * 约束 DSL 解析（机械、永不抛错）：
 *   - `forbid:<literal>` → 正文不得含 literal 子串；
 *   - `require:<literal>` → 正文必须含 literal 子串；
 *   - 裸串 → require 近似（注释口径：世界样本硬约束缺省按「须出现锚点 token」
 *     机械近似；语义级校验由 LLM 中介门承担）；
 *   - 空/纯前缀/空白串 → null（跳过不建规则，防真空判据）。
 */
export function parseWorldConstraint(raw: string): ParsedWorldConstraint | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith("forbid:")) {
    const literal = trimmed.slice("forbid:".length).trim()
    return literal.length === 0 ? null : { kind: "forbid", literal, raw: trimmed }
  }
  if (trimmed.startsWith("require:")) {
    const literal = trimmed.slice("require:".length).trim()
    return literal.length === 0 ? null : { kind: "require", literal, raw: trimmed }
  }
  return { kind: "require", literal: trimmed, raw: trimmed }
}

// ============================================================================
// 内部工具
// ============================================================================

/** rule id 内 entryId 的 `:` 转义（保证 id 分段语义稳定 + 全栈唯一）。 */
function escapeEntryId(entryId: string): string {
  return entryId.replace(/:/g, "_")
}

/** forbid 命中证据节选（命中点前后各 12 字符，总长截断 120——禁正文大段引用）。 */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12)
  const end = Math.min(text.length, index + length + 12)
  return text.slice(start, end).slice(0, 120)
}

/** 单条约束的预计算 finding（构造期求值一次；无违规 → null）。 */
function evaluateConstraint(
  entryId: string,
  constraint: ParsedWorldConstraint,
  text: string,
  severity: "error" | "warning",
): RawRuleFinding | null {
  const at = text.indexOf(constraint.literal)
  if (constraint.kind === "forbid") {
    if (at === -1) return null
    return {
      severity,
      message:
        `world-sample "${entryId}" 硬约束违反（${constraint.raw}）：正文出现禁词「${constraint.literal}」` +
        ` @ …${excerptAround(text, at, constraint.literal.length)}…`,
    }
  }
  if (at !== -1) return null
  return {
    severity,
    message:
      `world-sample "${entryId}" ${severity === "error" ? "硬" : "软"}约束违反（${constraint.raw}）：` +
      `正文缺失必需锚点「${constraint.literal}」`,
  }
}

// ============================================================================
// 工厂（RuleDefinition 闭包 text+entries）
// ============================================================================

/**
 * 构建世界样本约束规则包（P0 consistency 门）：
 *   - 工厂调用时求值一次：text+entries 封装进各规则闭包，run(ctx) 忽略 ctx
 *     返回预计算 findings 的只读拷贝（仿 continuity-pack 工厂风格，零重扫）；
 *   - 硬约束（transferableConstraints）→ severity error（P0 可 FAIL）；
 *   - 软约束（softConstraints）→ 恒 severity warning（永不 P0 FAIL）；
 *   - rule id `world-hard:<entryId>:<i>` / `world-soft:<entryId>:<i>`，
 *     entryId 转义后全局唯一且确定性稳定；
 *   - 空 samples / 全部约束跳过 → rules: [] 合法空包。
 */
export function buildWorldConstraintPack(input: {
  readonly text: string
  readonly samples: readonly WorldSampleEntry[]
}): RulePackDefinition {
  const rules: RuleDefinition[] = []
  for (const sample of input.samples) {
    if (typeof sample.entryId !== "string" || sample.entryId.length === 0) {
      throw new WorldConstraintGateError("world_sample 条目 entryId 为空，无法落可追溯 rule id")
    }
    const safeEntryId = escapeEntryId(sample.entryId)
    const hard = sample.transferableConstraints ?? []
    const soft = sample.softConstraints ?? []
    for (let i = 0; i < hard.length; i += 1) {
      const parsed = parseWorldConstraint(hard[i] ?? "")
      if (!parsed) continue
      const finding = evaluateConstraint(sample.entryId, parsed, input.text, "error")
      rules.push({
        id: `world-hard:${safeEntryId}:${i}`,
        gate: "consistency",
        run: (_ctx: RuleRunContext): readonly RawRuleFinding[] =>
          finding === null ? [] : [{ ...finding }],
      })
    }
    for (let i = 0; i < soft.length; i += 1) {
      const parsed = parseWorldConstraint(soft[i] ?? "")
      if (!parsed) continue
      const finding = evaluateConstraint(sample.entryId, parsed, input.text, "warning")
      rules.push({
        id: `world-soft:${safeEntryId}:${i}`,
        gate: "consistency",
        run: (_ctx: RuleRunContext): readonly RawRuleFinding[] =>
          finding === null ? [] : [{ ...finding }],
      })
    }
  }
  return { id: WORLD_CONSTRAINT_PACK_ID, rules }
}