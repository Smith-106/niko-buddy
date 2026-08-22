/**
 * quality-six-dim-pack.spec.ts — T24 六维评审规则包 + 有界并发短路运行器单测
 *
 * 蓝图 §6 T24 (TASK-P3-24) 收敛面:
 *   - 包结构: id / 7 规则（6 维 + 结构统计）/ 门归属与 DIM_TO_GATE_TYPE 同口径;
 *   - 投影: status 下限 × issue severity 取 max; 空 issue → info 摘要;
 *   - runSixDimBounded: 有界并发（并发峰值 ≤ limit）/ P0 组 fail 短路 P2 组
 *     （复用 T23 hardShortCircuit 语义）/ Quality fail 永不短路 / skippedKeys 记录;
 *   - 共享特征预计算消费: features 注入产出结构统计 info 规则。
 *
 * 执行纪律: ADR-19 零模型调用——evaluate 为测试注入的受控 stub。
 */
import { describe, expect, it } from "vitest"
import type { DimensionReviewIssue, DimensionReviewResult } from "../dimension-review-adapter"
import {
  createQualitySixDimPack,
  deriveSixDimVerdict,
  DEFAULT_SIX_DIM_CONCURRENCY,
  QUALITY_SIX_DIM_PACK_ID,
  runSixDimBounded,
  SIX_DIM_KEY_GATE,
} from "./quality-six-dim-pack"
import { precomputeTextFeatures } from "./shared-text-features"
import { combinePacks, runRuleStack } from "../rule-stack"

// ============================================================================
// Fixture
// ============================================================================

function dimResult(
  key: DimensionReviewResult["dimensionKey"],
  over: Partial<DimensionReviewResult> = {},
): DimensionReviewResult {
  return {
    dimensionKey: key,
    score: 8.5,
    status: "pass",
    summary: `${key} 摘要`,
    thinking: "",
    issues: [],
    ...over,
  }
}

function issue(over: Partial<DimensionReviewIssue> = {}): DimensionReviewIssue {
  return {
    severity: "warning",
    type: "thrill",
    dimensionKey: "thrill",
    message: "爽点未兑现",
    evidence: "",
    relatedMemory: "",
    suggestion: "",
    ...over,
  }
}

/** 受控 evaluate：可编程延迟/结果/并发观测。 */
function makeEvaluator(results: Partial<Record<string, DimensionReviewResult>>) {
  let inFlight = 0
  let peak = 0
  const order: string[] = []
  const evaluate = async (key: string): Promise<DimensionReviewResult> => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await Promise.resolve()
    inFlight--
    order.push(key)
    const r = results[key]
    if (!r) throw new Error(`no fixture for ${key}`)
    return r
  }
  return { evaluate, peak: () => peak, order: () => order }
}

describe("quality-six-dim-pack 包结构", () => {
  it("包 id 固定 + 7 条规则，门归属与 DIM_TO_GATE_TYPE 三门口径一致", () => {
    const pack = createQualitySixDimPack({ results: {} })
    expect(pack.id).toBe(QUALITY_SIX_DIM_PACK_ID)
    expect(pack.rules.map((r) => r.id)).toEqual([
      "six-dim.thrill",
      "six-dim.pacing",
      "six-dim.pull",
      "six-dim.character",
      "six-dim.consistency",
      "six-dim.continuity",
      "six-dim.structure-stats",
    ])
    for (const rule of pack.rules) {
      expect(rule.gate).toBe(SIX_DIM_KEY_GATE[rule.id.replace("six-dim.", "") as keyof typeof SIX_DIM_KEY_GATE] ?? rule.gate)
    }
    // combinePacks 维度-门一致性校验通过（T22 GATE_MAPPING 守卫）
    expect(() => combinePacks([pack])).not.toThrow()
  })
})

describe("六维结果投影", () => {
  it("status error → error；high/medium → warning 下限；issue 更严重时取 issue", () => {
    const pack = createQualitySixDimPack({
      results: {
        thrill: dimResult("thrill", { status: "error" }),
        pacing: dimResult("pacing", { status: "medium", issues: [issue({ severity: "warning" })] }),
        pull: dimResult("pull", { status: "low", issues: [issue({ severity: "error", message: "空钩子" })] }),
      },
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const byRule = new Map(result.allFindings.map((f) => [f.ruleId, f]))
    expect(byRule.get("six-dim.thrill")?.severity).toBe("error")
    expect(byRule.get("six-dim.pacing")?.severity).toBe("warning")
    expect(byRule.get("six-dim.pull")?.severity).toBe("error")
    expect(byRule.get("six-dim.pull")?.message).toContain("[六维:pull]")
  })

  it("维度→37 维槽位映射：character→character_consistency (consistency 门)，thrill→thrill_density (quality 门)", () => {
    const pack = createQualitySixDimPack({
      results: {
        character: dimResult("character", { status: "high", issues: [issue({ dimensionKey: "character", message: "动机断裂" })] }),
        continuity: dimResult("continuity", { status: "pass" }),
      },
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const charFinding = result.allFindings.find((f) => f.ruleId === "six-dim.character")
    expect(charFinding?.gate).toBe("consistency")
    expect(charFinding?.dimensionId).toBe("character_consistency")
    const contFinding = result.allFindings.find((f) => f.ruleId === "six-dim.continuity")
    expect(contFinding?.severity).toBe("info")
    expect(contFinding?.message).toContain("score")
  })

  it("缺维 → 对应规则空产出；features 注入 → 结构统计 info 规则产出共享预计算数据", () => {
    const features = precomputeTextFeatures("第一句很短。\n\n第二句稍微长一点点，带一点画面。\n\n第三句又变短了。")
    const pack = createQualitySixDimPack({ results: {}, features })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.allFindings).toHaveLength(1)
    expect(result.allFindings[0]!.ruleId).toBe("six-dim.structure-stats")
    expect(result.allFindings[0]!.severity).toBe("info")
    expect(result.allFindings[0]!.message).toContain("[共享特征预计算]")
    // 无 features 时该规则空产出
    const bare = runRuleStack(combinePacks([createQualitySixDimPack({ results: {} })]), { isFinale: false })
    expect(bare.allFindings).toEqual([])
  })
})

describe("deriveSixDimVerdict (hardShortCircuit 输入口径)", () => {
  it("status error 或 error 级 issue → fail；否则 pass", () => {
    expect(deriveSixDimVerdict(dimResult("thrill", { status: "error" }))).toBe("fail")
    expect(deriveSixDimVerdict(dimResult("thrill", { status: "pass", issues: [issue({ severity: "error" })] }))).toBe("fail")
    expect(deriveSixDimVerdict(dimResult("thrill", { status: "high", issues: [issue()] }))).toBe("pass")
    expect(deriveSixDimVerdict(dimResult("thrill"))).toBe("pass")
  })
})

describe("runSixDimBounded 有界并发 + 硬短路", () => {
  it("全 pass：六维全部评估，无 skipped，无短路", async () => {
    const results = {
      character: dimResult("character"),
      consistency: dimResult("consistency"),
      continuity: dimResult("continuity"),
      thrill: dimResult("thrill"),
      pacing: dimResult("pacing"),
      pull: dimResult("pull"),
    }
    const ev = makeEvaluator(results)
    const out = await runSixDimBounded(
      ["thrill", "consistency", "pacing", "character", "continuity", "pull"],
      ev.evaluate,
    )
    expect(Object.keys(out.results)).toHaveLength(6)
    expect(out.skippedKeys).toEqual([])
    expect(out.shortCircuitGate).toBeNull()
  })

  it("P0 组 fail → quality 组整组 skipped（复用 hardShortCircuit 语义）", async () => {
    const results = {
      character: dimResult("character", { status: "error" }), // consistency 门 fail
      consistency: dimResult("consistency"),
      continuity: dimResult("continuity"),
      thrill: dimResult("thrill"),
      pacing: dimResult("pacing"),
      pull: dimResult("pull"),
    }
    const ev = makeEvaluator(results)
    const out = await runSixDimBounded(
      ["thrill", "consistency", "pacing", "character", "continuity", "pull"],
      ev.evaluate,
    )
    expect(out.shortCircuitGate).toBe("consistency")
    expect([...out.skippedKeys].sort()).toEqual(["pacing", "pull", "thrill"].sort())
    expect(out.results["thrill"]).toBeUndefined()
    expect(out.results["character"]?.status).toBe("error")
    // P0 三维已评估，quality 三维未评估
    expect(ev.order()!.sort()).toEqual(["character", "consistency", "continuity"].sort())
  })

  it("Quality(P2) fail 永不短路（CLAUDE.md 硬约束 3）", async () => {
    const results = {
      character: dimResult("character"),
      consistency: dimResult("consistency"),
      continuity: dimResult("continuity"),
      thrill: dimResult("thrill", { status: "error" }),
      pacing: dimResult("pacing", { status: "error" }),
      pull: dimResult("pull", { status: "error" }),
    }
    const ev = makeEvaluator(results)
    const out = await runSixDimBounded(
      ["thrill", "consistency", "pacing", "character", "continuity", "pull"],
      ev.evaluate,
    )
    expect(out.shortCircuitGate).toBeNull()
    expect(out.skippedKeys).toEqual([])
    expect(Object.keys(out.results)).toHaveLength(6)
  })

  it("有界并发：并发峰值 ≤ limit（默认 3 与显式 2 两档）", async () => {
    const keys = ["thrill", "consistency", "pacing", "character", "continuity", "pull"] as const
    const mkResults = (): Partial<Record<string, DimensionReviewResult>> => ({
      character: dimResult("character"),
      consistency: dimResult("consistency"),
      continuity: dimResult("continuity"),
      thrill: dimResult("thrill"),
      pacing: dimResult("pacing"),
      pull: dimResult("pull"),
    })
    const evDefault = makeEvaluator(mkResults())
    const outDefault = await runSixDimBounded(keys, evDefault.evaluate)
    expect(DEFAULT_SIX_DIM_CONCURRENCY).toBe(3)
    expect(evDefault.peak()).toBeLessThanOrEqual(3)

    const evTwo = makeEvaluator(mkResults())
    await runSixDimBounded(keys, evTwo.evaluate, { concurrency: 2 })
    expect(evTwo.peak()).toBeLessThanOrEqual(2)

    // 全 pass 输出不受并发档位影响（保序语义由 results map 承载）
    expect(Object.keys(outDefault.results)).toHaveLength(6)
  })

  it("单门子集运行：只传 quality 键时不触发跨门行为", async () => {
    const ev = makeEvaluator({
      thrill: dimResult("thrill", { status: "error" }),
      pull: dimResult("pull"),
    })
    const out = await runSixDimBounded(["thrill", "pull"], ev.evaluate)
    expect(out.shortCircuitGate).toBeNull()
    expect(out.skippedKeys).toEqual([])
    expect(out.results["thrill"]?.status).toBe("error")
  })
})
