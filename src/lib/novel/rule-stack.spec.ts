/**
 * rule-stack.spec.ts — T23 RuleStack 单测 + fast-check 属性面
 *
 * 蓝图 §6 T23 / F-16 / A-04.2 收敛条件:
 *   "短路/升格/组合断言 + 属性绿" (`npx vitest run rule-stack`)
 *
 * 本 spec 五面 (与 control-kernel.spec.ts 同型):
 *   ① 哨兵对齐: 与 T22 GATE_MAPPING / control-sentinels GATE_PRIORITY 三方一致
 *   ② combinePacks 组合语义单测: 纯函数拼接 / 冻结 / 完整性拒绝 / 规范化全序
 *   ③ hardShortCircuit + craftFinaleEscalation + gateProjection 纯函数真值表
 *   ④ runRuleStack 集成: 短路链 / 终局升格 / 未冻结拒跑 / run 内禁动态注册
 *   ⑤ fast-check 属性面: 组合顺序稳定 / gate 优先级不变量 / 硬短路规格镜像 /
 *      升格属性 / 输入守恒 / 运行确定性
 *
 * 执行纪律:
 *   - ADR-19 机械层零模型调用: 本 spec 不调用任何模型 / IO 业务面 (仅读源文件做 token 守卫)。
 *   - Draft-first (ADR-08): 新增测试文件, 不触及 .novel/status.json 正式层。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import {
  combinePacks,
  craftFinaleEscalation,
  gateProjection,
  getGatePriority,
  GATE_RUN_STATUSES,
  hardShortCircuit,
  RULE_SEVERITIES,
  RuleStackIntegrityError,
  RuleStackNotFrozenError,
  runRuleStack,
  type GateRunStatus,
  type GateVerdict,
  type RawRuleFinding,
  type RuleDefinition,
  type RuleFinding,
  type RulePackDefinition,
  type RuleSeverity,
  type RuleStack,
} from "./rule-stack"
import {
  GATE_MAPPING,
  GATE_PRIORITY_ORDER,
  type AuditDimensionId,
  type GateKey,
} from "./audit-taxonomy"
import { GATE_PRIORITY } from "./control-sentinels"

// ============================================================================
// 测试夹具
// ============================================================================

/** 各门取 T22 注册表首维作为代表性维度 (维度-门一致性校验用)。 */
const FIRST_DIM: Record<GateKey, AuditDimensionId> = {
  consistency: "timeline_consistency",
  anti_ai: "slop_explanation",
  quality: "thrill_density",
}

type FindingSpec = {
  dimensionId?: AuditDimensionId
  severity: RuleSeverity
  message?: string
}

/** 固定产出规则夹具: run() 恒返回给定 specs。 */
function fixedRule(id: string, gate: GateKey, specs: readonly FindingSpec[]): RuleDefinition {
  return Object.freeze({
    id,
    gate,
    run: () =>
      specs.map((spec) => ({
        dimensionId: spec.dimensionId,
        severity: spec.severity,
        message: spec.message ?? `${id} finding`,
      })),
  })
}

/** 快照包的可变数据面 (守恒断言用; run 函数为纯函数引用不参与快照)。 */
function describePack(pack: RulePackDefinition): {
  id: string
  ruleIds: string[]
  gates: GateKey[]
} {
  return { id: pack.id, ruleIds: pack.rules.map((r) => r.id), gates: pack.rules.map((r) => r.gate) }
}

/** 枚举全排列 (组合顺序稳定属性用; n ≤ 4)。 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()]
  const out: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const perm of permutations(rest)) out.push([items[i], ...perm])
  }
  return out
}

// ============================================================================
// fast-check 场景生成器
// ============================================================================

/** 单条规则生成计划: 归属门 + 产出档 (none=零产出) + 是否携带维度。 */
interface RuleSpec {
  gate: GateKey
  severity: "none" | RuleSeverity
  withDimension: boolean
}

const stackScenarioArb = fc.record({
  packCount: fc.integer({ min: 1, max: 4 }),
  rules: fc.array(
    fc.record({
      gate: fc.constantFrom<GateKey>("consistency", "anti_ai", "quality"),
      severity: fc.constantFrom<"none" | RuleSeverity>("none", "error", "warning", "info"),
      withDimension: fc.boolean(),
    }),
    { minLength: 0, maxLength: 9 },
  ),
  isFinale: fc.boolean(),
})

/** 把场景物化为 pack 列表 (id 按位置分配保证唯一; run 为确定性纯函数)。 */
function materializePacks(packCount: number, rules: readonly RuleSpec[]): RulePackDefinition[] {
  const packs: { id: string; rules: RuleDefinition[] }[] = Array.from(
    { length: packCount },
    (_, pi) => ({ id: `pack-${pi}`, rules: [] as RuleDefinition[] }),
  )
  rules.forEach((spec, idx) => {
    const pack = packs[idx % packCount]
    const dimensionId = spec.withDimension ? FIRST_DIM[spec.gate] : undefined
    const ruleId = `r${idx}`
    pack.rules.push(
      Object.freeze({
        id: ruleId,
        gate: spec.gate,
        ...(dimensionId !== undefined ? { dimensionId } : {}),
        run: (): readonly RawRuleFinding[] =>
          spec.severity === "none"
            ? []
            : [{ dimensionId, severity: spec.severity, message: `${ruleId} finding` }],
      }),
    )
  })
  return packs
}

/** 规格镜像 (独立于 runRuleStack 实现): 按门独立推导期望三态裁定。 */
function mirrorVerdicts(rules: readonly RuleSpec[], isFinale: boolean): Record<GateKey, GateRunStatus> {
  const emits = (gate: GateKey, severity: RuleSeverity): boolean =>
    rules.some((s) => s.gate === gate && s.severity === severity)
  const qualityFails =
    emits("quality", "error") || (isFinale && emits("quality", "warning"))
  let failedGate: Exclude<GateKey, "quality"> | null = null
  const verdicts: Record<GateKey, GateRunStatus> = {
    consistency: "pass",
    anti_ai: "pass",
    quality: "pass",
  }
  for (const gate of GATE_PRIORITY_ORDER) {
    if (failedGate !== null) {
      verdicts[gate] = "skipped"
      continue
    }
    const fails =
      gate === "consistency"
        ? emits("consistency", "error")
        : gate === "anti_ai"
          ? emits("anti_ai", "error")
          : qualityFails
    if (fails) {
      verdicts[gate] = "fail"
      if (gate !== "quality") failedGate = gate
    }
  }
  return verdicts
}

// ============================================================================
// ① 哨兵常量与三方对齐
// ============================================================================

describe("T23 rule-stack (F-16 / A-04.2)", () => {
  describe("哨兵常量与三方对齐", () => {
    it("GATE_PRIORITY_ORDER 与 T22 GATE_MAPPING / control-sentinels GATE_PRIORITY 一致", () => {
      expect(GATE_PRIORITY_ORDER).toEqual(["consistency", "anti_ai", "quality"])
      expect(GATE_PRIORITY).toEqual(GATE_PRIORITY_ORDER)
      expect(GATE_MAPPING.consistency.priority).toBe(0)
      expect(GATE_MAPPING.anti_ai.priority).toBe(1)
      expect(GATE_MAPPING.quality.priority).toBe(2)
    })

    it("getGatePriority 读数与 GATE_MAPPING.priority 逐门一致", () => {
      for (const gate of GATE_PRIORITY_ORDER) {
        expect(getGatePriority(gate)).toBe(GATE_MAPPING[gate].priority)
      }
    })

    it("严重级别与运行状态注册表内容正确", () => {
      expect(RULE_SEVERITIES).toEqual(["error", "warning", "info"])
      expect(GATE_RUN_STATUSES).toEqual(["pass", "fail", "skipped"])
    })

    it("ADR-19 机械层零模型调用: rule-stack.ts 无 IO/网络/模型 token", () => {
      const src = readFileSync(resolve(__dirname, "rule-stack.ts"), "utf-8")
      // 与收敛命令同口径 (意图): 无 fetch / LLM / openai 调用 token。
      expect(/\b(?:fetch|llm|openai)\b/i.test(src)).toBe(false)
      // 从严: 无 node fs/http / 子进程 / socket / Tauri 命令调用 token。
      expect(
        /(?:node:fs|node:http|node:child_process|readFileSync|writeFileSync|createServer|WebSocket|XMLHttpRequest|\binvoke\b)/i.test(src),
      ).toBe(false)
    })
  })

  // ============================================================================
  // ② combinePacks 组合语义 (纯函数拼接 + 冻结 + 完整性 + 规范化全序)
  // ============================================================================

  describe("combinePacks 组合语义", () => {
    it("跨门排序: 拼接顺序打乱仍按 Consistency > Anti-AI > Quality 输出", () => {
      const packs = [
        { id: "p-quality", rules: [fixedRule("q1", "quality", [])] },
        { id: "p-consistency", rules: [fixedRule("c1", "consistency", [])] },
        { id: "p-anti-ai", rules: [fixedRule("a1", "anti_ai", [])] },
      ]
      const stack = combinePacks(packs)
      expect(stack.rules.map((r) => r.gate)).toEqual(["consistency", "anti_ai", "quality"])
      // 元数据规范化: packIds 字典序, 与拼接顺序无关
      expect(stack.packIds).toEqual(["p-anti-ai", "p-consistency", "p-quality"])
      expect(stack.id).toBe("p-anti-ai+p-consistency+p-quality")
    })

    it("同门 tie-break: ruleId 字典序 (规范化全序)", () => {
      const stack = combinePacks([
        { id: "pa", rules: [fixedRule("zz", "consistency", []), fixedRule("mm", "consistency", [])] },
        { id: "pb", rules: [fixedRule("aa", "consistency", [])] },
      ])
      expect(stack.rules.map((r) => r.id)).toEqual(["aa", "mm", "zz"])
    })

    it("组合顺序稳定: combine([A,B]) 与 combine([B,A]) DeepEqual 同一栈", () => {
      const pa: RulePackDefinition = {
        id: "pa",
        rules: [fixedRule("c1", "consistency", []), fixedRule("q1", "quality", [])],
      }
      const pb: RulePackDefinition = {
        id: "pb",
        rules: [fixedRule("a1", "anti_ai", []), fixedRule("c0", "consistency", [])],
      }
      expect(combinePacks([pa, pb])).toEqual(combinePacks([pb, pa]))
      expect(combinePacks([pa, pb]).rules.map((r) => r.id)).toEqual(["c0", "c1", "a1", "q1"])
    })

    it("纯函数拼接: 输入包不被修改, 栈规则数组不别名输入数组", () => {
      const pa: RulePackDefinition = {
        id: "pa",
        rules: [fixedRule("c1", "consistency", []), fixedRule("a1", "anti_ai", [])],
      }
      const before = describePack(pa)
      const stack = combinePacks([pa])
      expect(describePack(pa)).toEqual(before)
      expect(Object.is(stack.rules, pa.rules)).toBe(false)
      expect(stack.rules).toHaveLength(2)
    })

    it("组合产物深度冻结: 栈/规则表/packIds/单条规则均 frozen, push 抛 TypeError", () => {
      const stack = combinePacks([{ id: "pa", rules: [fixedRule("c1", "consistency", [])] }])
      expect(Object.isFrozen(stack)).toBe(true)
      expect(Object.isFrozen(stack.rules)).toBe(true)
      expect(Object.isFrozen(stack.packIds)).toBe(true)
      expect(stack.rules.every((rule) => Object.isFrozen(rule))).toBe(true)
      expect(() => (stack.rules as RuleDefinition[]).push(fixedRule("intruder", "quality", []))).toThrow(
        TypeError,
      )
      expect(stack.rules).toHaveLength(1)
      expect(() => (stack.packIds as string[]).push("intruder")).toThrow(TypeError)
    })

    it("完整性拒绝: 重复 ruleId / 重复 packId / 非法 gate / 维度-门不一致 / 缺 run 函数", () => {
      const dupRule = fixedRule("dup", "consistency", [])
      expect(() =>
        combinePacks([
          { id: "pa", rules: [dupRule] },
          { id: "pb", rules: [dupRule] },
        ]),
      ).toThrow(RuleStackIntegrityError)

      const shared: RulePackDefinition = { id: "same", rules: [] }
      expect(() => combinePacks([shared, shared])).toThrow(RuleStackIntegrityError)

      expect(() =>
        combinePacks([{ id: "pa", rules: [{ id: "bad-gate", gate: "unknown" as unknown as GateKey, run: () => [] }] }]),
      ).toThrow(RuleStackIntegrityError)

      expect(() =>
        combinePacks([
          { id: "pa", rules: [{ id: "dim-mismatch", gate: "quality", dimensionId: "timeline_consistency", run: () => [] }] },
        ]),
      ).toThrow(RuleStackIntegrityError)

      expect(() =>
        combinePacks([{ id: "pa", rules: [{ id: "no-run", gate: "quality" } as unknown as RuleDefinition] }]),
      ).toThrow(RuleStackIntegrityError)

      expect(() => combinePacks([{ id: "", rules: [] }])).toThrow(RuleStackIntegrityError)
      expect(() =>
        combinePacks([{ id: "pa", rules: "not-an-array" as unknown as RuleDefinition[] }]),
      ).toThrow(RuleStackIntegrityError)

      // 规则项缺合法 id / 非对象规则项 / 包非对象 / 未知 dimensionId
      expect(() =>
        combinePacks([{ id: "pa", rules: [{ id: "", gate: "quality", run: () => [] }] }]),
      ).toThrow(RuleStackIntegrityError)
      expect(() =>
        combinePacks([
          { id: "pa", rules: [null as unknown as RuleDefinition] },
        ]),
      ).toThrow(RuleStackIntegrityError)
      expect(() => combinePacks([null as unknown as RulePackDefinition])).toThrow(
        RuleStackIntegrityError,
      )
      expect(() => combinePacks(["pack" as unknown as RulePackDefinition])).toThrow(
        RuleStackIntegrityError,
      )
      expect(() =>
        combinePacks([
          {
            id: "pa",
            rules: [
              {
                id: "unknown-dim",
                gate: "quality",
                dimensionId: "not_a_dim" as unknown as AuditDimensionId,
                run: () => [],
              },
            ],
          },
        ]),
      ).toThrow(RuleStackIntegrityError)
    })

    it("合法维度直通: dimensionId 与声明门一致时保留并可通过校验", () => {
      const stack = combinePacks([
        {
          id: "pa",
          rules: [
            {
              id: "thrill-check",
              gate: "quality",
              dimensionId: "thrill_density",
              run: () => [{ dimensionId: "thrill_density", severity: "warning", message: "thrill low" }],
            },
          ],
        },
      ])
      expect(stack.rules).toHaveLength(1)
      expect(stack.rules[0].dimensionId).toBe("thrill_density")
    })

    it("空组合: 空 pack 列表 → empty 栈; 全空包也合法", () => {
      const empty = combinePacks([])
      expect(empty.id).toBe("empty")
      expect(empty.rules).toHaveLength(0)

      const blank = combinePacks([
        { id: "pa", rules: [] },
        { id: "pb", rules: [] },
      ])
      expect(blank.id).toBe("pa+pb")
      expect(blank.rules).toHaveLength(0)
    })
  })

  // ============================================================================
  // ③ 纯函数真值表: hardShortCircuit / craftFinaleEscalation / gateProjection
  // ============================================================================

  describe("hardShortCircuit 真值表", () => {
    it("P0/P1 fail 短路; Quality(P2) fail 永不短路; 其余组合均不短路", () => {
      const table: readonly [GateKey, GateVerdict, boolean][] = [
        ["consistency", "fail", true],
        ["anti_ai", "fail", true],
        ["quality", "fail", false],
        ["consistency", "pass", false],
        ["anti_ai", "pass", false],
        ["quality", "pass", false],
      ]
      for (const [gate, verdict, expected] of table) {
        expect(hardShortCircuit(gate, verdict)).toBe(expected)
      }
    })
  })

  describe("craftFinaleEscalation 升格逻辑", () => {
    const mixed: readonly RuleFinding[] = [
      { ruleId: "cw", gate: "consistency", severity: "warning", message: "cw" },
      { ruleId: "aw", gate: "anti_ai", severity: "warning", message: "aw" },
      { ruleId: "qi", gate: "quality", severity: "info", message: "qi" },
      { ruleId: "qe", gate: "quality", severity: "error", message: "qe" },
      { ruleId: "qw", gate: "quality", severity: "warning", message: "qw" },
    ]

    it("终局章: 仅 quality.warning → error 且标 escalated; 其他级别/其他门不动", () => {
      const out = craftFinaleEscalation(mixed, true)
      expect(out).toHaveLength(5)
      expect(out[0]).toMatchObject({ gate: "consistency", severity: "warning" })
      expect(out[0].escalated).toBeUndefined()
      expect(out[1]).toMatchObject({ gate: "anti_ai", severity: "warning" })
      expect(out[1].escalated).toBeUndefined()
      expect(out[2]).toMatchObject({ gate: "quality", severity: "info" })
      expect(out[2].escalated).toBeUndefined()
      expect(out[3]).toMatchObject({ gate: "quality", severity: "error" })
      expect(out[3].escalated).toBeUndefined()
      expect(out[4]).toMatchObject({ gate: "quality", severity: "error", escalated: true })
    })

    it("非终局章: 恒等返回 (无任何升格标记)", () => {
      const out = craftFinaleEscalation(mixed, false)
      expect(out.map((f) => f.severity)).toEqual(["warning", "warning", "info", "error", "warning"])
      expect(out.every((f) => f.escalated === undefined)).toBe(true)
    })

    it("纯函数: 输入数组与元素不被修改; 返回新数组", () => {
      const input: RuleFinding[] = [
        { ruleId: "qw", gate: "quality", severity: "warning", message: "qw" },
      ]
      const out = craftFinaleEscalation(input, true)
      expect(Object.is(out, input)).toBe(false)
      expect(input[0]).toMatchObject({ severity: "warning" })
      expect(input[0].escalated).toBeUndefined()
    })

    it("空输入: 终局/非终局均返回空数组", () => {
      expect(craftFinaleEscalation([], true)).toEqual([])
      expect(craftFinaleEscalation([], false)).toEqual([])
    })
  })

  describe("gateProjection 门控投影", () => {
    it("过滤: 只统计目标门的 finding", () => {
      const findings: readonly RuleFinding[] = [
        { ruleId: "ce", gate: "consistency", severity: "error", message: "ce" },
        { ruleId: "aw", gate: "anti_ai", severity: "warning", message: "aw" },
        { ruleId: "ae", gate: "anti_ai", severity: "error", message: "ae" },
      ]
      expect(gateProjection("anti_ai", findings).verdict).toBe("fail")
      expect(gateProjection("anti_ai", findings).projectedFindings).toHaveLength(2)
      expect(gateProjection("quality", findings).verdict).toBe("pass")
      expect(gateProjection("quality", findings).projectedFindings).toHaveLength(0)
    })

    it("裁定: 任一 error → fail; 仅 warning/info 或空 → pass", () => {
      const mk = (severities: readonly RuleSeverity[]): RuleFinding[] =>
        severities.map((severity, i) => ({
          ruleId: `r${i}`,
          gate: "anti_ai" as const,
          severity,
          message: `m${i}`,
        }))
      expect(gateProjection("anti_ai", mk([])).verdict).toBe("pass")
      expect(gateProjection("anti_ai", mk(["info"])).verdict).toBe("pass")
      expect(gateProjection("anti_ai", mk(["warning", "info"])).verdict).toBe("pass")
      expect(gateProjection("anti_ai", mk(["warning", "error"])).verdict).toBe("fail")
    })

    it("终局升格接入: quality 门 warning 在 isFinale=true 下投影为 fail 并计数", () => {
      const qw: readonly RuleFinding[] = [
        { ruleId: "qw1", gate: "quality", severity: "warning", message: "w1" },
        { ruleId: "qw2", gate: "quality", severity: "warning", message: "w2" },
      ]
      const finale = gateProjection("quality", qw, { isFinale: true })
      expect(finale.verdict).toBe("fail")
      expect(finale.escalatedCount).toBe(2)
      expect(finale.projectedFindings.every((f) => f.severity === "error")).toBe(true)

      const normal = gateProjection("quality", qw, { isFinale: false })
      expect(normal.verdict).toBe("pass")
      expect(normal.escalatedCount).toBe(0)
    })

    it("升格只作用于 quality 门: 非 quality 门忽略 isFinale 选项", () => {
      const cw: readonly RuleFinding[] = [
        { ruleId: "cw", gate: "consistency", severity: "warning", message: "w" },
      ]
      const projected = gateProjection("consistency", cw, { isFinale: true })
      expect(projected.verdict).toBe("pass")
      expect(projected.escalatedCount).toBe(0)
      expect(projected.projectedFindings[0].escalated).toBeUndefined()
    })
  })

  // ============================================================================
  // ④ runRuleStack 集成: 短路链 / 升格端到端 / 冻结前置 / 禁动态注册
  // ============================================================================

  describe("runRuleStack 运行语义", () => {
    const threeGatePacks: readonly RulePackDefinition[] = [
      {
        id: "continuity",
        rules: [
          fixedRule("c-ok", "consistency", [{ severity: "warning", message: "minor timeline note" }]),
        ],
      },
      {
        id: "anti-ai-mech",
        rules: [fixedRule("a-ok", "anti_ai", [{ severity: "info", message: "clean" }])],
      },
      {
        id: "six-dim",
        rules: [fixedRule("q-ok", "quality", [{ severity: "warning", message: "pacing soft" }])],
      },
    ]

    it("全通过路径: 三门依优先级评估, 无短路, 执行计数完整", () => {
      const stack = combinePacks(threeGatePacks)
      const result = runRuleStack(stack, { isFinale: false })
      expect(result.outcomes.map((o) => o.gate)).toEqual([...GATE_PRIORITY_ORDER])
      expect(result.outcomes.every((o) => o.evaluated)).toBe(true)
      expect(result.verdicts).toEqual({ consistency: "pass", anti_ai: "pass", quality: "pass" })
      expect(result.shortCircuited).toBe(false)
      expect(result.shortCircuitGate).toBeNull()
      expect(result.executedRuleCount).toBe(3)
      expect(result.allFindings).toHaveLength(3)
    })

    it("硬短路 P0: consistency fail → anti_ai/quality 被 skipped, 低门规则不执行", () => {
      const stack = combinePacks([
        { id: "continuity", rules: [fixedRule("c-fail", "consistency", [{ severity: "error", message: "canon conflict" }])] },
        { id: "anti-ai-mech", rules: [fixedRule("a-fail", "anti_ai", [{ severity: "error", message: "should-not-run" }])] },
        { id: "six-dim", rules: [fixedRule("q-any", "quality", [{ severity: "error", message: "should-not-run" }])] },
      ])
      const result = runRuleStack(stack, { isFinale: false })
      expect(result.verdicts).toEqual({ consistency: "fail", anti_ai: "skipped", quality: "skipped" })
      expect(result.shortCircuited).toBe(true)
      expect(result.shortCircuitGate).toBe("consistency")
      expect(result.outcomes.find((o) => o.gate === "anti_ai")?.evaluated).toBe(false)
      expect(result.outcomes.find((o) => o.gate === "quality")?.findings).toHaveLength(0)
      expect(result.executedRuleCount).toBe(1)
      expect(result.allFindings.map((f) => f.ruleId)).toEqual(["c-fail"])
    })

    it("硬短路 P1: consistency pass + anti_ai fail → 仅 quality 被 skipped", () => {
      const stack = combinePacks([
        { id: "continuity", rules: [fixedRule("c-pass", "consistency", [])] },
        { id: "anti-ai-mech", rules: [fixedRule("a-fail", "anti_ai", [{ severity: "error", message: "slop burst" }])] },
        { id: "six-dim", rules: [fixedRule("q-any", "quality", [{ severity: "error", message: "should-not-run" }])] },
      ])
      const result = runRuleStack(stack, { isFinale: false })
      expect(result.verdicts).toEqual({ consistency: "pass", anti_ai: "fail", quality: "skipped" })
      expect(result.shortCircuitGate).toBe("anti_ai")
      expect(result.executedRuleCount).toBe(2)
    })

    it("Quality(P2) fail 永不短路: 三门全部评估, 无 skipped", () => {
      const stack = combinePacks([
        { id: "continuity", rules: [fixedRule("c-pass", "consistency", [])] },
        { id: "anti-ai-mech", rules: [fixedRule("a-pass", "anti_ai", [])] },
        { id: "six-dim", rules: [fixedRule("q-fail", "quality", [{ severity: "error", message: "flat climax" }])] },
      ])
      const result = runRuleStack(stack, { isFinale: false })
      expect(result.verdicts).toEqual({ consistency: "pass", anti_ai: "pass", quality: "fail" })
      expect(result.shortCircuited).toBe(false)
      expect(result.outcomes.every((o) => o.evaluated)).toBe(true)
    })

    it("craft.finale 升格端到端: 终局章 quality.warning → fail; 非终局章保持 pass", () => {
      const stack = combinePacks([
        { id: "six-dim", rules: [fixedRule("q-warn", "quality", [{ severity: "warning", message: "closure weak" }])] },
      ])

      const normal = runRuleStack(stack, { isFinale: false })
      expect(normal.verdicts.quality).toBe("pass")
      expect(normal.escalatedCount).toBe(0)

      const finale = runRuleStack(stack, { isFinale: true })
      expect(finale.verdicts.quality).toBe("fail")
      expect(finale.escalatedCount).toBe(1)
      expect(finale.allFindings[0]).toMatchObject({
        ruleId: "q-warn",
        gate: "quality",
        severity: "error",
        escalated: true,
      })
      // 升格只改投影结果, 不触发短路 (quality 永不挡)
      expect(finale.shortCircuited).toBe(false)
    })

    it("空栈: 三门全评估且 pass, 零执行零产出", () => {
      const result = runRuleStack(combinePacks([]), { isFinale: true })
      expect(result.verdicts).toEqual({ consistency: "pass", anti_ai: "pass", quality: "pass" })
      expect(result.executedRuleCount).toBe(0)
      expect(result.allFindings).toHaveLength(0)
    })

    it("未冻结栈拒跑: 手搓对象缺品牌/未冻结 → RuleStackNotFrozenError", () => {
      const rule = fixedRule("c1", "consistency", [])
      const unbranded = { kind: "other", id: "x", packIds: [], rules: [] } as unknown as RuleStack
      expect(() => runRuleStack(unbranded, { isFinale: false })).toThrow(RuleStackNotFrozenError)

      const unfrozen = { kind: "rule-stack", id: "x", packIds: ["pa"], rules: [rule] } as unknown as RuleStack
      expect(() => runRuleStack(unfrozen, { isFinale: false })).toThrow(RuleStackNotFrozenError)

      const halfFrozen = Object.freeze({
        kind: "rule-stack",
        id: "x",
        packIds: Object.freeze([]),
        rules: [rule], // rule 数组未冻结
      }) as unknown as RuleStack
      expect(() => runRuleStack(halfFrozen, { isFinale: false })).toThrow(RuleStackNotFrozenError)
    })

    it("run 内禁动态注册: 结果不可变 + 运行后栈规则数不变 + 双次运行确定性", () => {
      const stack = combinePacks(threeGatePacks)
      const first = runRuleStack(stack, { isFinale: false })
      // 结果深度冻结: 无法借返回值篡改
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.outcomes)).toBe(true)
      expect(() => (first.allFindings as RuleFinding[]).push({ ruleId: "x", gate: "quality", severity: "info", message: "x" })).toThrow(
        TypeError,
      )
      // 栈未被运行过程篡改
      expect(stack.rules).toHaveLength(3)
      // 确定性: 同输入双次运行 DeepEqual, 且输出不别名栈
      const second = runRuleStack(stack, { isFinale: false })
      expect(second).toEqual(first)
      expect(Object.is(first, stack)).toBe(false)
    })

    it("运行器机械校验: 规则产出非法 severity / 空 message / 非对象 → IntegrityError", () => {
      const badSeverity = combinePacks([
        {
          id: "bad",
          rules: [
            {
              id: "bad-sev",
              gate: "quality",
              run: () => [{ severity: "critical" as unknown as RuleSeverity, message: "x" }],
            },
          ],
        },
      ])
      expect(() => runRuleStack(badSeverity, { isFinale: false })).toThrow(RuleStackIntegrityError)

      const emptyMsg = combinePacks([
        {
          id: "bad",
          rules: [{ id: "empty-msg", gate: "quality", run: () => [{ severity: "info", message: "" }] }],
        },
      ])
      expect(() => runRuleStack(emptyMsg, { isFinale: false })).toThrow(RuleStackIntegrityError)

      const nonObject = combinePacks([
        {
          id: "bad",
          rules: [{ id: "null-find", gate: "quality", run: () => [null as unknown as RawRuleFinding] }],
        },
      ])
      expect(() => runRuleStack(nonObject, { isFinale: false })).toThrow(RuleStackIntegrityError)
    })
  })

  // ============================================================================
  // ⑤ fast-check 属性面 (组合顺序稳定 / gate 优先级 / 短路镜像 / 升格 / 守恒)
  // ============================================================================

  describe("fast-check 属性面", () => {
    it("属性·组合顺序稳定: 任意 pack 排列组合出同一规范化冻结栈", () => {
      fc.assert(
        fc.property(
          stackScenarioArb.filter((s) => s.packCount >= 2),
          ({ packCount, rules }) => {
            const packs = materializePacks(packCount, rules)
            const canonical = combinePacks(packs)
            for (const perm of permutations(packs)) {
              expect(combinePacks(perm)).toEqual(canonical)
            }
          },
        ),
        { numRuns: 60 },
      )
    })

    it("属性·gate 优先级不变量: 组合产物优先级序列单调不减", () => {
      fc.assert(
        fc.property(stackScenarioArb, ({ packCount, rules }) => {
          const stack = combinePacks(materializePacks(packCount, rules))
          const priorities = stack.rules.map((r) => getGatePriority(r.gate))
          for (let i = 1; i < priorities.length; i++) {
            expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1])
          }
          // 分组连续性: 同门规则在序列中连续出现
          const gates = stack.rules.map((r) => r.gate)
          expect(new Set(gates).size).toBeLessThanOrEqual(3)
        }),
        { numRuns: 200 },
      )
    })

    it("属性·硬短路规格镜像: 任意场景下三门三态与独立推导一致 + 双次运行确定", () => {
      fc.assert(
        fc.property(stackScenarioArb, ({ packCount, rules, isFinale }) => {
          const stack = combinePacks(materializePacks(packCount, rules))
          const result = runRuleStack(stack, { isFinale })
          expect(result.verdicts).toEqual(mirrorVerdicts(rules, isFinale))

          // 短路元数据与镜像联动
          const failedBeforeQuality = mirrorVerdicts(rules, isFinale)
          const p0Fail = failedBeforeQuality.consistency === "fail"
          const p1Fail = failedBeforeQuality.anti_ai === "fail"
          expect(result.shortCircuited).toBe(p0Fail || p1Fail)
          expect(result.shortCircuitGate).toBe(p0Fail ? "consistency" : p1Fail ? "anti_ai" : null)

          // executedRuleCount = 已评估门的规则总数 (被跳过门不计入)
          const evaluatedGates = GATE_PRIORITY_ORDER.filter((g) => result.verdicts[g] !== "skipped")
          const expectedExecuted = rules.filter((s) => evaluatedGates.includes(s.gate)).length
          expect(result.executedRuleCount).toBe(expectedExecuted)

          // 确定性: 双次运行 DeepEqual
          expect(runRuleStack(stack, { isFinale })).toEqual(result)
        }),
        { numRuns: 150 },
      )
    })

    it("属性·craft.finale 升格: quality-warning-only 栈的裁定随 isFinale 翻转, 且永不短路", () => {
      fc.assert(
        fc.property(fc.boolean(), fc.integer({ min: 0, max: 6 }), (isFinale, n) => {
          const pack: RulePackDefinition = {
            id: "quality-only",
            rules: Array.from({ length: n }, (_, i) =>
              fixedRule(`qw${i}`, "quality", [{ severity: "warning", message: `w${i}` }]),
            ),
          }
          const result = runRuleStack(combinePacks([pack]), { isFinale })
          expect(result.verdicts.quality).toBe(isFinale && n > 0 ? "fail" : "pass")
          expect(result.verdicts.consistency).toBe("pass")
          expect(result.verdicts.anti_ai).toBe("pass")
          expect(result.shortCircuited).toBe(false)
          expect(result.escalatedCount).toBe(isFinale ? n : 0)
        }),
        { numRuns: 100 },
      )
    })

    it("属性·输入守恒: combine/run 不修改输入包, 输出不别名输入", () => {
      fc.assert(
        fc.property(stackScenarioArb, ({ packCount, rules, isFinale }) => {
          const packs = materializePacks(packCount, rules)
          const before = packs.map(describePack)
          const stack = combinePacks(packs)
          const result = runRuleStack(stack, { isFinale })
          expect(packs.map(describePack)).toEqual(before)
          expect(Object.is(stack.rules, packs[0]?.rules)).toBe(false)
          expect(Object.is(result, stack)).toBe(false)
          // 栈自身仍是冻结态 (运行不解除冻结)
          expect(Object.isFrozen(stack.rules)).toBe(true)
        }),
        { numRuns: 150 },
      )
    })
  })
})
