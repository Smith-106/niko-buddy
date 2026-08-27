/**
 * adversarial-regression-set.spec.ts — v2.6.4 V-01/V-04 验收
 *
 * 蓝图验收：`npx vitest run src/lib/novel/adversarial`
 * 覆盖：样本 schema 校验 / 分层召回计算 / 诚实报告（stub 不产模拟分）
 */
import { describe, expect, it } from "vitest"
import {
  ATTACK_TYPES,
  DIFFICULTY_LEVELS,
  buildAdversarialReport,
  computeStratifiedRecall,
  validateSample,
  type AdversarialSample,
} from "./adversarial-regression-set"

const sample = (over: Partial<AdversarialSample> = {}): AdversarialSample => ({
  id: "s1",
  original: "他推开门，看见满屋的月光。",
  rewritten: "门被推开，月光洒满了整间屋子。",
  attackType: "paraphrase",
  difficulty: "L1",
  source: "gold220",
  ...over,
})

describe("V-01 对抗回归集框架 — 样本 schema 校验", () => {
  it("合法样本通过校验", () => {
    expect(validateSample(sample())).toHaveLength(0)
  })

  it("六字段逐一校验（id/original/rewritten/attackType/difficulty/source）", () => {
    expect(validateSample(sample({ id: "" }))[0]).toContain("id")
    expect(validateSample(sample({ original: "  " }))[0]).toContain("original")
    expect(validateSample(sample({ rewritten: "" }))[0]).toContain("rewritten")
    expect(validateSample(sample({ attackType: "bad" as never }))[0]).toContain("attackType")
    expect(validateSample(sample({ difficulty: "L9" as never }))[0]).toContain("difficulty")
    expect(validateSample(sample({ source: "" }))[0]).toContain("source")
  })

  it("枚举完整（PADBen 三层 + 难度 L1-L3）", () => {
    expect(ATTACK_TYPES).toEqual(["paraphrase", "homoglyph", "llm_rewrite"])
    expect(DIFFICULTY_LEVELS).toEqual(["L1", "L2", "L3"])
  })
})

describe("V-01 对抗回归集框架 — 分层召回计算", () => {
  it("按类型×难度分组计算召回", () => {
    const samples = [
      sample({ id: "a", attackType: "paraphrase", difficulty: "L1" }),
      sample({ id: "b", attackType: "paraphrase", difficulty: "L1" }),
      sample({ id: "c", attackType: "paraphrase", difficulty: "L1" }),
      sample({ id: "d", attackType: "llm_rewrite", difficulty: "L3" }),
    ]
    const { strata, macroRecall, weightedRecall } = computeStratifiedRecall(
      samples,
      (s) => s.id !== "c", // 检出 3/4
    )
    expect(strata).toHaveLength(2)
    const para = strata.find((s) => s.attackType === "paraphrase")
    expect(para?.recall).toBeCloseTo(2 / 3, 5)
    const llm = strata.find((s) => s.attackType === "llm_rewrite")
    expect(llm?.recall).toBe(1)
    expect(macroRecall).toBeCloseTo((2 / 3 + 1) / 2, 5)
    expect(weightedRecall).toBeCloseTo(3 / 4, 5)
  })

  it("空集返回零召回", () => {
    const { strata, macroRecall, weightedRecall } = computeStratifiedRecall([], () => true)
    expect(strata).toHaveLength(0)
    expect(macroRecall).toBe(0)
    expect(weightedRecall).toBe(0)
  })
})

describe("V-04 诚实报告 — stub 不产模拟分", () => {
  it("无判定数据 → data_status=stub + stubReason，零模拟分", () => {
    const report = buildAdversarialReport([sample()], null, "无检测器判定数据")
    expect(report.dataStatus).toBe("stub")
    expect(report.stubReason).toContain("无检测器判定数据")
    expect(report.strata).toHaveLength(0)
    expect(report.macroRecall).toBe(0)
    expect(report.weightedRecall).toBe(0)
  })

  it("有判定 → data_status=measured + 分层明细", () => {
    const report = buildAdversarialReport([sample()], () => true)
    expect(report.dataStatus).toBe("measured")
    expect(report.totalSamples).toBe(1)
    expect(report.strata).toHaveLength(1)
    expect(report.macroRecall).toBe(1)
  })

  it("stub 报告不含任何阳性/缺陷结论（零召回断言）", () => {
    const report = buildAdversarialReport([sample()], null)
    expect(report.macroRecall).toBe(0)
    expect(report.weightedRecall).toBe(0)
    expect(report.strata).toHaveLength(0)
  })
})
