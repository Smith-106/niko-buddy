/**
 * anti-ai-mech-pack.spec.ts — T24 反 AI 机械规则包单测
 *
 * 蓝图 §6 T24 (TASK-P3-24) 收敛面:
 *   - 包结构: id / 5 规则 / 全属 anti_ai 门 / combinePacks 维度-门校验通过;
 *   - T19 四统计因子接线: warn 态 → warning finding（不 block），非 warn 空产出;
 *   - 池分析 memo: analyze 至多调用一次（共享特征预计算语义）;
 *   - mechanical-slop TIER3: 命中→warning / classifySlop block→error / 无命中空产出;
 *   - ADR-19 边界: 未注入 pool 时四因子规则恒空产出（惰性降级不抛错）。
 *
 * 执行纪律: 机械层零模型调用；池经 DI stub 注入，不依赖真实语料。
 */
import { describe, expect, it } from "vitest"
import type { AntiAiAnalysisReport, StatisticalFactorReport } from "../anti-ai-candidate-pool"
import { createAntiAiMechPack, ANTI_AI_MECH_PACK_ID, type AntiAiPoolLike } from "./anti-ai-mech-pack"
import { combinePacks, runRuleStack } from "../rule-stack"

// ============================================================================
// Fixture
// ============================================================================

function factor(over: Partial<StatisticalFactorReport> & { factor: string }): StatisticalFactorReport {
  return {
    value: 0.5,
    threshold: 0.4,
    warn: false,
    description: `${over.factor} 描述`,
    ...over,
  }
}

function report(over?: Partial<AntiAiAnalysisReport>): AntiAiAnalysisReport {
  return {
    factors: [],
    hasWarnings: false,
    warningCount: 0,
    summary: "[clean] 四因子检测通过。",
    calibrationSource: "synthetic-degraded",
    ...over,
  }
}

/** 可编程 stub 池：记录 analyze 调用次数。 */
function stubPool(result: AntiAiAnalysisReport): AntiAiPoolLike & { calls: () => number } {
  let n = 0
  return {
    analyze: (_text: string) => {
      n++
      return result
    },
    calls: () => n,
  }
}

const SLOP_BLOCK_TEXT = "显然这一切事实上毫无疑问。其实说白了换句话说简单来说。综上所述总而言之不难发现值得一提的是。众所周知不可否认显而易见不言而喻毋庸置疑。值得注意的是需要指出的是在某种程度上多维度深层次。"

describe("anti-ai-mech-pack 包结构", () => {
  it("包 id 固定 + 5 条规则全属 anti_ai 门", () => {
    const pack = createAntiAiMechPack({ text: "正文" })
    expect(pack.id).toBe(ANTI_AI_MECH_PACK_ID)
    expect(pack.rules.map((r) => r.id)).toEqual([
      "anti-ai-mech.t19-ngram-overlap",
      "anti-ai-mech.t19-sentence-entropy",
      "anti-ai-mech.t19-punctuation-fingerprint",
      "anti-ai-mech.t19-paragraph-distribution",
      "anti-ai-mech.slop-tier3",
    ])
    for (const rule of pack.rules) {
      expect(rule.gate).toBe("anti_ai")
    }
    // combinePacks 组合期维度-门一致性校验通过
    expect(() => combinePacks([pack])).not.toThrow()
  })
})

describe("T19 四统计因子接线 (warn 态)", () => {
  it("warn 因子产出 warning finding，维度映射正确", () => {
    const pool = stubPool(report({
      factors: [
        factor({ factor: "nGramOverlap", warn: true }),
        factor({ factor: "sentenceEntropy", warn: true }),
        factor({ factor: "punctuationFingerprint", warn: true }),
        factor({ factor: "paragraphLengthDist", warn: true }),
      ],
      hasWarnings: true,
      warningCount: 4,
    }))
    const pack = createAntiAiMechPack({ text: "测试正文", pool })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const byRule = new Map(result.allFindings.map((f) => [f.ruleId, f]))
    expect(byRule.get("anti-ai-mech.t19-ngram-overlap")?.dimensionId).toBe("statistical_ai_signature")
    expect(byRule.get("anti-ai-mech.t19-ngram-overlap")?.severity).toBe("warning")
    expect(byRule.get("anti-ai-mech.t19-sentence-entropy")?.dimensionId).toBe("slop_mechanical")
    expect(byRule.get("anti-ai-mech.t19-sentence-entropy")?.severity).toBe("warning")
    expect(byRule.get("anti-ai-mech.t19-punctuation-fingerprint")?.dimensionId).toBe("statistical_ai_signature")
    expect(byRule.get("anti-ai-mech.t19-paragraph-distribution")?.dimensionId).toBe("statistical_ai_signature")
    // 全 warning 不构成 error → 门 pass（warn 态不 block 守 T19 口径）
    expect(result.verdicts.anti_ai).toBe("pass")
  })

  it("非 warn 因子空产出；池分析 memo 至多一次", () => {
    const pool = stubPool(report())
    const pack = createAntiAiMechPack({ text: "测试正文", pool })
    const stack = combinePacks([pack])
    const r1 = runRuleStack(stack, { isFinale: false })
    const t19Findings = r1.allFindings.filter((f) => f.ruleId.startsWith("anti-ai-mech.t19"))
    expect(t19Findings).toEqual([])
    // 5 条规则全部执行后 analyze 只调了 1 次
    expect(pool.calls()).toBe(1)
    runRuleStack(stack, { isFinale: false })
    expect(pool.calls()).toBe(1)
  })

  it("未注入 pool：四因子规则恒空产出且不抛错（ADR-19 DI 边界）", () => {
    const pack = createAntiAiMechPack({ text: "测试正文" })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const t19Findings = result.allFindings.filter((f) => f.ruleId.startsWith("anti-ai-mech.t19"))
    expect(t19Findings).toEqual([])
  })
})

describe("mechanical-slop TIER3 接线", () => {
  it("TIER3 命中未达阻断 → warning (slop_mechanical)", () => {
    // A3 密度制校准：短文本命中率天然超高（原句单独 penalty=10 直接 block），
    // 用中性叙事稀释至 warn 带 [5,8) 验证「未达阻断→warning」语义而非绝对值。
    const neutral = [
      "他推开门走了出去，风很大，吹得衣角猎猎作响。",
      "桌上的茶凉了半盏，窗外的天色一点点暗了下去。",
      "他把纸叠好收进口袋，转身下了楼。",
    ].join("")
    const text = "他深吸一口气，目光交汇的瞬间，空气仿佛凝固。" + neutral.repeat(9)
    const pack = createAntiAiMechPack({ text })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const tier3 = result.allFindings.filter((f) => f.ruleId === "anti-ai-mech.slop-tier3")
    expect(tier3.length).toBe(1)
    expect(tier3[0]!.severity).toBe("warning")
    expect(tier3[0]!.dimensionId).toBe("slop_mechanical")
    expect(tier3[0]!.message).toContain("TIER3")
  })

  it("classifySlop block → error 并触发 P1 门 fail（保持现行阻断语义）", () => {
    const pack = createAntiAiMechPack({ text: SLOP_BLOCK_TEXT })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const tier3 = result.allFindings.filter((f) => f.ruleId === "anti-ai-mech.slop-tier3")
    expect(tier3.length).toBe(1)
    expect(tier3[0]!.severity).toBe("error")
    expect(result.verdicts.anti_ai).toBe("fail")
    // P1 fail → hardShortCircuit 短路 quality 门
    expect(result.shortCircuitGate).toBe("anti_ai")
    expect(result.verdicts.quality).toBe("skipped")
  })

  it("无命中 → 空产出；空文本 → 全部规则空产出", () => {
    const clean = runRuleStack(
      combinePacks([createAntiAiMechPack({ text: "主角推开门，屋内无人。炉火早已熄灭，只剩灰烬的余温。" })]),
      { isFinale: false },
    )
    expect(clean.allFindings.filter((f) => f.ruleId === "anti-ai-mech.slop-tier3")).toEqual([])

    const empty = runRuleStack(combinePacks([createAntiAiMechPack({})]), { isFinale: false })
    expect(empty.allFindings).toEqual([])
  })

  it("features 注入时消费规范化文本（幂等等价）+ bypassCount 透传阻断消息", () => {
    const withBypass = "他\u200b深吸一口气，目光交汇的瞬间，空气仿佛凝固。"
    const direct = createAntiAiMechPack({ text: withBypass })
    const viaFeatures = createAntiAiMechPack({
      text: withBypass,
      features: { normalizedText: withBypass.replace(/\u200b/g, ""), bypassCount: 1 },
    })
    const r1 = runRuleStack(combinePacks([direct]), { isFinale: false })
    const r2 = runRuleStack(combinePacks([viaFeatures]), { isFinale: false })
    const f1 = r1.allFindings.find((f) => f.ruleId === "anti-ai-mech.slop-tier3")
    const f2 = r2.allFindings.find((f) => f.ruleId === "anti-ai-mech.slop-tier3")
    expect(f1).toBeDefined()
    expect(f2).toBeDefined()
    // 两路径 tier 命中一致（normalizeText 幂等）
    expect(f1!.message.replace(/bypass:\d+/, "")).toBe(f2!.message.replace(/bypass:\d+/, ""))
    if (f1!.severity === "error") {
      expect(f2!.message).toContain("bypass:1")
    }
  })
})

// ============================================================================
// origin 埋点 (20260823 #34 前置, 裁决 A: pack 层装饰)
// ============================================================================

import { withPoolReportOrigin } from "./anti-ai-mech-pack"

describe("origin 打标 (#34 前置埋点)", () => {
  it("withPoolReportOrigin: 设 origin → 报告携带; 缺省 → 同一引用无复制", () => {
    const base = report()
    expect(withPoolReportOrigin(base, "ai_draft").origin).toBe("ai_draft")
    expect(withPoolReportOrigin(base)).toBe(base)
    expect(withPoolReportOrigin(base, undefined)).toBe(base)
    // 不改写输入对象
    const tagged = withPoolReportOrigin(base, "user_text")
    expect(base.origin).toBeUndefined()
    expect(tagged).not.toBe(base)
  })

  it("getPoolReport memo: 带 origin 时 analyze 仍恰好调一次", () => {
    const pool = stubPool(report({ hasWarnings: true, warningCount: 1 }))
    const pack = createAntiAiMechPack({ text: "正文内容足够长。", pool, origin: "ai_draft" })
    for (const rule of pack.rules) rule.run({} as never)
    expect(pool.calls()).toBe(1)
  })

  it("warn 态报告 + origin 下 finding message 不泄漏 origin 字面量", () => {
    const pool = stubPool(report({
      hasWarnings: true, warningCount: 2,
      factors: [factor({ factor: "sentenceEntropy", warn: true }), factor({ factor: "paragraphLengthDist", warn: true })],
    }))
    const pack = createAntiAiMechPack({ text: "正文。他推开门。屋里很静，只有风从窗缝里钻进来。他坐下点了灯。火光跳了两下映出影子。「谁？」没有人回答。他把刀横在膝上等。风又起了灯灭了。", pool, origin: "ai_draft" })
    const allFindings = pack.rules.flatMap((r) => r.run({} as never))
    expect(allFindings.length).toBeGreaterThan(0)
    // origin 是纯元数据：绝不进 message（CWE-532 口径 + message 人类可读定位）
    for (const f of allFindings) expect(f.message).not.toContain("ai_draft")
    expect(pool.calls()).toBe(1)
  })
})
