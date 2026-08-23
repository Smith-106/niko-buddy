/**
 * rule-stack.ts — T23 RuleStack 硬短路 + 门控投影 + craft.finale 升格 + pack 组合语义
 *
 * 蓝图 §6 T23 / F-16 / A-04.2:
 *   - hardShortCircuit(): 门控硬短路链 Consistency(P0) > Anti-AI(P1) > Quality(P2)，
 *     P0/P1 fail 即短路后续低优先级门；Quality 永不短路（P2 永不挡，CLAUDE.md 硬约束 3）。
 *   - gateProjection(): 把规则产出按 T22 GATE_MAPPING 三门控投影为 pass/fail 裁定
 *     （存在 error 级 finding → fail）。
 *   - craftFinaleEscalation(): 终局章升格逻辑——仅终局章（isFinale=true）把 quality 门
 *     的 warning 升格为 error（使其可经 gateProjection 变为 blocking fail）；
 *     非终局章 quality warning 保持原级、永不升格。
 *   - pack 组合语义: combinePacks() 纯函数拼接（不改写输入包）+ gate 优先级稳定排序；
 *     组合产物在 run 前深度冻结，runRuleStack() 拒绝未冻结栈并在运行后复核完整性
 *     （run 内禁动态注册：栈结构不可变，且运行期不存在任何注册通道）。
 *
 * 排序口径（decision-log/20260821-t23-rule-stack.md）:
 *   主键 = GATE_MAPPING[gate].priority 升序；同优先级 tie-break = ruleId 字典序。
 *   该全序保证任意 pack 拼接顺序都得到同一规范化冻结栈（组合顺序稳定属性的强形式）。
 *   栈元数据同样规范化：id 与 packIds 取字典序，不保留拼接顺序。
 *
 * 机械层零模型调用 (ADR-19): 本文件只含纯函数与类型契约，
 * 无 IO / 无网络 / 无模型调用 / 无 Tauri 命令调用。
 *
 * Draft-first (ADR-08): 本模块为新增纯函数层，不写入运行时会话状态文件，
 * 不回填正式正文/记忆，不触及草稿正式层。
 *
 * @license MIT © QMAI
 */

import {
  AUDIT_TAXONOMY,
  GATE_MAPPING,
  GATE_PRIORITY_ORDER,
  getGateForDimension,
  type AuditDimensionId,
  type GateKey,
} from "./audit-taxonomy"

// ============================================================================
// 类型契约
// ============================================================================

/** 规则产出的严重级别。 */
export type RuleSeverity = "error" | "warning" | "info"

/** 严重级别取值注册表（运行时校验用）。 */
export const RULE_SEVERITIES: readonly RuleSeverity[] = ["error", "warning", "info"]

/** 单门投影裁定二值（gateProjection 的输出）。 */
export type GateVerdict = "pass" | "fail"

/** 运行期门控状态三值（含被短路跳过）。 */
export type GateRunStatus = GateVerdict | "skipped"

/** 运行期门控状态取值注册表。 */
export const GATE_RUN_STATUSES: readonly GateRunStatus[] = ["pass", "fail", "skipped"]

/** 规则原始产出（未盖章：不含 ruleId/gate，由运行器统一盖章防伪）。 */
export interface RawRuleFinding {
  /** 归属审计维度（T22 37 维之一；可缺省=跨维通用检查项）。 */
  readonly dimensionId?: AuditDimensionId
  /** 严重级别。 */
  readonly severity: RuleSeverity
  /** 人类可读诊断信息（非空）。 */
  readonly message: string
}

/**
 * 盖章后 finding（运行器注入 ruleId 与 gate，规则自身无法谎报归属门）。
 * escalated=true 表示该条被 craftFinaleEscalation 从 warning 升格为 error。
 */
export interface RuleFinding extends RawRuleFinding {
  /** 产出该 finding 的规则 id。 */
  readonly ruleId: string
  /** 归属门控键（来自规则定义的 gate，经 combinePacks 校验与维度一致）。 */
  readonly gate: GateKey
  /** 是否经终局章升格（warning → error）。 */
  readonly escalated?: boolean
}

/** 规则运行上下文（机械输入；终局标记驱动升格逻辑）。 */
export interface RuleRunContext {
  /** 是否终局章（craft.finale / final_image 段落或全书末章口径，由调用方判定）。 */
  readonly isFinale: boolean
}

/** 单条规则定义（纯函数谓词：上下文 → findings）。 */
export interface RuleDefinition {
  /** 全栈唯一规则 id（重复 id 在组合期拒绝）。 */
  readonly id: string
  /** 归属门控键（决定排序优先级与投影分组）。 */
  readonly gate: GateKey
  /** 归属审计维度（可选；提供时必须与 gate 经 T22 GATE_MAPPING 一致）。 */
  readonly dimensionId?: AuditDimensionId
  /** 纯函数执行体：零副作用，输出只读 findings。 */
  readonly run: (ctx: RuleRunContext) => readonly RawRuleFinding[]
}

/** 规则包定义（pack：若干规则的命名分组，组合的最小单位）。 */
export interface RulePackDefinition {
  /** 全栈唯一包 id。 */
  readonly id: string
  /** 包内规则列表（可为空数组）。 */
  readonly rules: readonly RuleDefinition[]
}

/** 冻结后的规则栈（combinePacks 产物；run 的唯一合法输入形态）。 */
export interface RuleStack {
  /** 结构品牌（防手搓对象冒充冻结栈）。 */
  readonly kind: "rule-stack"
  /** 栈 id（参与包 id 字典序以 "+" 连接；空栈为 "empty"）。 */
  readonly id: string
  /** 参与组合的包 id 列表（字典序规范化，与拼接顺序无关）。 */
  readonly packIds: readonly string[]
  /** 规范化规则序列（gate 优先级升序 + ruleId 字典序 tie-break）。 */
  readonly rules: readonly RuleDefinition[]
}

/** 单门投影结果。 */
export interface GateProjectionResult {
  /** 目标门控键。 */
  readonly gate: GateKey
  /** 投影裁定：任一 error 级 finding → fail。 */
  readonly verdict: GateVerdict
  /** 投影后 findings（quality+终局章时含升格结果）。 */
  readonly projectedFindings: readonly RuleFinding[]
  /** 本次投影中发生升格的条数。 */
  readonly escalatedCount: number
}

/** 单门运行结果。 */
export interface GateRunOutcome {
  /** 门控键。 */
  readonly gate: GateKey
  /** pass / fail / skipped(被短路)。 */
  readonly status: GateRunStatus
  /** 该门收集到的 findings（skipped 时为空）。 */
  readonly findings: readonly RuleFinding[]
  /** 是否实际执行（false=被短路跳过）。 */
  readonly evaluated: boolean
}

/** 栈运行总结果。 */
export interface StackRunResult {
  /** 三门结果（严格按 GATE_PRIORITY_ORDER 排列）。 */
  readonly outcomes: readonly GateRunOutcome[]
  /** 门控状态速查表。 */
  readonly verdicts: Readonly<Record<GateKey, GateRunStatus>>
  /** 是否发生硬短路。 */
  readonly shortCircuited: boolean
  /** 触发短路的门（未短路为 null）。 */
  readonly shortCircuitGate: GateKey | null
  /** 全部已评估门的 findings（按门优先级顺序拼接）。 */
  readonly allFindings: readonly RuleFinding[]
  /** 升格总数。 */
  readonly escalatedCount: number
  /** 实际执行的规则数（被短路门下的规则不计入）。 */
  readonly executedRuleCount: number
}

// ============================================================================
// 错误类型
// ============================================================================

/** rule-stack 错误基类。 */
export class RuleStackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleStackError"
  }
}

/** 结构完整性错误（重复 id / 非法 gate / 维度-门不一致等，组合期拒绝）。 */
export class RuleStackIntegrityError extends RuleStackError {
  constructor(message: string) {
    super(message)
    this.name = "RuleStackIntegrityError"
  }
}

/** 未冻结栈错误（组合在 run 前冻结；run 内禁动态注册）。 */
export class RuleStackNotFrozenError extends RuleStackError {
  constructor(message: string) {
    super(message)
    this.name = "RuleStackNotFrozenError"
  }
}

// ============================================================================
// 工具函数（内部）
// ============================================================================

/** 是否合法门控键。 */
function isGateKey(value: unknown): value is GateKey {
  return typeof value === "string" && (GATE_PRIORITY_ORDER as readonly string[]).includes(value)
}

/** 是否合法严重级别。 */
function isRuleSeverity(value: unknown): value is RuleSeverity {
  return typeof value === "string" && (RULE_SEVERITIES as readonly string[]).includes(value)
}

/** 深度冻结（MDN deepFreeze 同型；函数值跳过）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value)
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 校验单条规则定义的结构完整性（组合期机械守卫）。 */
function validateRuleDefinition(rule: unknown, packId: string): asserts rule is RuleDefinition {
  if (rule === null || typeof rule !== "object") {
    throw new RuleStackIntegrityError(`rule pack "${packId}" 含非对象规则项`)
  }
  const r = rule as Partial<RuleDefinition>
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new RuleStackIntegrityError(`rule pack "${packId}" 存在缺少合法 id 的规则`)
  }
  if (!isGateKey(r.gate)) {
    throw new RuleStackIntegrityError(`rule pack "${packId}" 的规则 "${r.id}" gate 非法: ${String(r.gate)}`)
  }
  if (typeof r.run !== "function") {
    throw new RuleStackIntegrityError(`rule pack "${packId}" 的规则 "${r.id}" 缺少 run 函数`)
  }
  if (r.dimensionId !== undefined) {
    if (!(r.dimensionId in AUDIT_TAXONOMY)) {
      throw new RuleStackIntegrityError(
        `rule pack "${packId}" 的规则 "${r.id}" dimensionId 不在 T22 注册表内: ${String(r.dimensionId)}`,
      )
    }
    if (getGateForDimension(r.dimensionId) !== r.gate) {
      throw new RuleStackIntegrityError(
        `rule pack "${packId}" 的规则 "${r.id}" 维度 ${r.dimensionId} 归属门 ${getGateForDimension(r.dimensionId)} 与声明门 ${r.gate} 不一致`,
      )
    }
  }
}

/** 校验栈已深度冻结（run 前置守卫；run 内禁动态注册的机械保证）。 */
function assertFrozenRuleStack(stack: RuleStack): void {
  const frozen =
    stack !== null &&
    typeof stack === "object" &&
    stack.kind === "rule-stack" &&
    Object.isFrozen(stack) &&
    Object.isFrozen(stack.packIds) &&
    Object.isFrozen(stack.rules) &&
    stack.rules.every((rule) => Object.isFrozen(rule))
  if (!frozen) {
    throw new RuleStackNotFrozenError(
      "rule-stack 必须经 combinePacks() 冻结后才能运行（组合在 run 前冻结，run 内禁动态注册）",
    )
  }
}

// ============================================================================
// 公共 API
// ============================================================================

/** 读取门控优先级（0=P0 最高, 1=P1, 2=P2；真源=T22 GATE_MAPPING）。 */
export function getGatePriority(gate: GateKey): 0 | 1 | 2 {
  return GATE_MAPPING[gate].priority
}

/**
 * pack 组合：纯函数拼接 + gate 优先级稳定排序，产物深度冻结。
 *
 * 组合语义：
 *   - 纯函数：不修改任何输入包（rules 数组复制后排序），输入保持原样；
 *   - 排序：主键 getGatePriority(gate) 升序（Consistency > Anti-AI > Quality），
 *     tie-break = ruleId 字典序 → 全序规范化，任意拼接顺序得到同一冻结栈；
 *   - 元数据规范化：id 与 packIds 取字典序（与拼接顺序无关），组合顺序稳定
 *     属性对整个栈对象成立（含元数据）；
 *   - 冻结：返回的栈（含 rules/rule/packIds）全部深度冻结，即「组合在 run 前冻结」；
 *   - 完整性：重复 packId / 重复 ruleId / 非法 gate / 维度-门不一致 → 组合期拒绝。
 */
export function combinePacks(packs: readonly RulePackDefinition[]): RuleStack {
  const seenPackIds = new Set<string>()
  const seenRuleIds = new Set<string>()
  const combined: RuleDefinition[] = []

  for (const pack of packs) {
    if (pack === null || typeof pack !== "object") {
      throw new RuleStackIntegrityError("rule pack 必须是对象")
    }
    if (typeof pack.id !== "string" || pack.id.length === 0) {
      throw new RuleStackIntegrityError("rule pack 缺少合法 id")
    }
    if (seenPackIds.has(pack.id)) {
      throw new RuleStackIntegrityError(`重复的 rule pack id: "${pack.id}"`)
    }
    seenPackIds.add(pack.id)
    if (!Array.isArray(pack.rules)) {
      throw new RuleStackIntegrityError(`rule pack "${pack.id}" 的 rules 必须是数组`)
    }
    for (const rule of pack.rules) {
      validateRuleDefinition(rule, pack.id)
      if (seenRuleIds.has(rule.id)) {
        throw new RuleStackIntegrityError(`重复的 rule id: "${rule.id}"（pack "${pack.id}"）`)
      }
      seenRuleIds.add(rule.id)
      combined.push(rule)
    }
  }

  // gate 优先级稳定排序（Array.prototype.sort ES2019+ 稳定）+ ruleId 字典序 tie-break。
  // 注：同 id 规则在上方已被拒绝，故相等分支不可达，无需返回 0。
  combined.sort((a, b) => {
    const pa = getGatePriority(a.gate)
    const pb = getGatePriority(b.gate)
    if (pa !== pb) return pa - pb
    return a.id < b.id ? -1 : 1
  })

  // 元数据规范化: packIds 字典序（组合顺序稳定属性覆盖整个栈对象）。
  const sortedPackIds = packs.map((p) => p.id).sort()
  const stack: RuleStack = {
    kind: "rule-stack",
    id: packs.length === 0 ? "empty" : sortedPackIds.join("+"),
    packIds: sortedPackIds,
    rules: combined,
  }
  return deepFreeze(stack)
}

/**
 * 硬短路判定：P0/P1 fail → true（跳过后续低优先级门）；Quality(P2) fail → false。
 * Quality 永不挡（CLAUDE.md 硬约束 3）：P2 是末端门且不得触发短路。
 */
export function hardShortCircuit(gate: GateKey, verdict: GateVerdict): boolean {
  return verdict === "fail" && gate !== "quality"
}

/**
 * craft.finale 升格：仅终局章把 quality 门 warning 升格为 error（标 escalated）。
 * 非终局章恒等返回内容（warning 不动）；非 quality 门的 finding 一律不动。
 * 纯函数：不修改输入数组元素。
 */
export function craftFinaleEscalation(
  findings: readonly RuleFinding[],
  isFinale: boolean,
): RuleFinding[] {
  if (!isFinale) {
    return findings.slice()
  }
  return findings.map((finding) => {
    if (finding.gate === "quality" && finding.severity === "warning") {
      return { ...finding, severity: "error", escalated: true }
    }
    return finding
  })
}

/**
 * 门控投影：把 findings 过滤到指定门并产出 pass/fail 裁定。
 *   - 过滤：finding.gate === gate；
 *   - 升格：quality 门且 options.isFinale=true 时先经 craftFinaleEscalation；
 *   - 裁定：存在 error 级 finding → fail，否则 pass（对齐 GATE_MAPPING.blockingSeverity="error"）。
 */
export function gateProjection(
  gate: GateKey,
  findings: readonly RuleFinding[],
  options?: { readonly isFinale?: boolean },
): GateProjectionResult {
  const scoped = findings.filter((finding) => finding.gate === gate)
  const projected =
    gate === "quality" && options?.isFinale === true
      ? craftFinaleEscalation(scoped, true)
      : scoped.slice()
  const escalatedCount = projected.reduce((n, f) => (f.escalated === true ? n + 1 : n), 0)
  const verdict: GateVerdict = projected.some((f) => f.severity === "error") ? "fail" : "pass"
  return { gate, verdict, projectedFindings: projected, escalatedCount }
}

/** 运行器内部门控章：给原始 finding 盖 ruleId/gate 章并做机械校验。 */
function stampFinding(rule: RuleDefinition, raw: unknown): RuleFinding {
  if (raw === null || typeof raw !== "object") {
    throw new RuleStackIntegrityError(`rule "${rule.id}" 产出了非对象 finding`)
  }
  const candidate = raw as Partial<RawRuleFinding>
  if (!isRuleSeverity(candidate.severity)) {
    throw new RuleStackIntegrityError(`rule "${rule.id}" 产出非法 severity: ${String(candidate.severity)}`)
  }
  if (typeof candidate.message !== "string" || candidate.message.length === 0) {
    throw new RuleStackIntegrityError(`rule "${rule.id}" 产出空 message`)
  }
  return {
    dimensionId: candidate.dimensionId,
    severity: candidate.severity,
    message: candidate.message,
    ruleId: rule.id,
    gate: rule.gate,
  }
}

/**
 * 运行规则栈：按门优先级逐门评估 + 硬短路链。
 *
 * 执行契约：
 *   1. 前置守卫：栈必须已深度冻结（assertFrozenRuleStack），否则拒绝运行；
 *   2. 按 GATE_PRIORITY_ORDER 逐门执行该门全部规则（规范化序），findings 由运行器统一盖章；
 *   3. 每门评估后立即 gateProjection，命中 hardShortCircuit 则剩余门标记 skipped；
 *   4. run 内禁动态注册：机械保证由冻结承担（冻结数组上任何增删同步抛错），
 *      加上前置守卫拒绝手搓未冻栈，运行期不存在任何注册通道。
 *   5. 结果深度冻结：调用方拿到的是不可变快照。
 */
export function runRuleStack(stack: RuleStack, ctx: RuleRunContext): StackRunResult {
  assertFrozenRuleStack(stack)

  const outcomes: GateRunOutcome[] = []
  const verdicts: Record<GateKey, GateRunStatus> = {
    consistency: "pass",
    anti_ai: "pass",
    quality: "pass",
  }
  const allFindings: RuleFinding[] = []
  let shortCircuited = false
  let shortCircuitGate: GateKey | null = null
  let escalatedCount = 0
  let executedRuleCount = 0

  for (const gate of GATE_PRIORITY_ORDER) {
    if (shortCircuited) {
      outcomes.push({ gate, status: "skipped", findings: [], evaluated: false })
      verdicts[gate] = "skipped"
      continue
    }
    const collected: RuleFinding[] = []
    for (const rule of stack.rules) {
      if (rule.gate !== gate) continue
      executedRuleCount++
      for (const raw of rule.run(ctx)) {
        collected.push(stampFinding(rule, raw))
      }
    }
    const projection = gateProjection(gate, collected, { isFinale: ctx.isFinale })
    escalatedCount += projection.escalatedCount
    outcomes.push({
      gate,
      status: projection.verdict,
      findings: projection.projectedFindings,
      evaluated: true,
    })
    verdicts[gate] = projection.verdict
    allFindings.push(...projection.projectedFindings)
    if (hardShortCircuit(gate, projection.verdict)) {
      shortCircuited = true
      shortCircuitGate = gate
    }
  }

  // 禁动态注册的机械保证由「深度冻结 + 前置守卫」共同承担：
  // 冻结数组上任何 push/splice 在严格模式下同步抛 TypeError（见 spec）。

  const result: StackRunResult = {
    outcomes,
    verdicts,
    shortCircuited,
    shortCircuitGate,
    allFindings,
    escalatedCount,
    executedRuleCount,
  }
  return deepFreeze(result)
}
