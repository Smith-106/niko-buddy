import { describe, expect, it } from "vitest"
import {
  classifyIntervention,
  formatInterventionVerdict,
  INTERVENTION_DEFAULTS,
  type InterventionVerdict,
} from "./de-ai-intensity"

describe("de-ai-intensity", () => {
  describe("classifyIntervention", () => {
    it("light: 低 slop + 低 weightedScore → 轻改不改其余", () => {
      const v = classifyIntervention({ slopPenalty: 2, weightedScore: 2 })
      expect(v.tier).toBe("light")
      expect(v.skip).toBe(false)
      expect(v.productHardGate).toBe(false)
      expect(v.guidance).toContain("轻改")
    })

    it("medium: slopPenalty >= slopFloor → 全章扫描", () => {
      const v = classifyIntervention({ slopPenalty: 6, weightedScore: 3 })
      expect(v.tier).toBe("medium")
      expect(v.skip).toBe(false)
    })

    it("medium: weightedScore >= lightUpper 但低于 rewriteLower → 中改", () => {
      const v = classifyIntervention({ slopPenalty: 0, weightedScore: 8 })
      expect(v.tier).toBe("medium")
    })

    it("rewrite: 高 slop + 高 weightedScore → 重写需人工确认", () => {
      const v = classifyIntervention({ slopPenalty: 9, weightedScore: 20 })
      expect(v.tier).toBe("rewrite")
      expect(v.guidance).toContain("人工确认")
    })

    it("36 号双轨: charCount 提供时按每千字密度口径 — 长文原始分高但密度低 → 不误升 rewrite", () => {
      // 真实标定锚点: 《8人》ch1 归一 9408 字符、weightedScore=15.4 (即 1.64/k) → light
      const v = classifyIntervention({ slopPenalty: 0, weightedScore: 15.4, charCount: 9408 })
      expect(v.tier).toBe("light")
    })

    it("36 号双轨: 高密度重度 AI 文本 → rewrite 仍可触发", () => {
      // 同 weightedScore 但篇幅仅 800 字符 → 归一 15.4/800*1000 = 19.25/k ≥ rewriteLower 6.0 且 slop ≥ 5
      const v = classifyIntervention({ slopPenalty: 8, weightedScore: 15.4, charCount: 800 })
      expect(v.tier).toBe("rewrite")
    })

    it("36 号双轨: 中等密度 (≈2.5/k) → medium (留轻度 AI 润色提示空间)", () => {
      const v = classifyIntervention({ slopPenalty: 0, weightedScore: 25, charCount: 10000 })
      expect(v.tier).toBe("medium")
    })

    it("skip: humanizerCavityScore 高 → 跳过改写防改写器腔", () => {
      const v = classifyIntervention({
        slopPenalty: 3,
        weightedScore: 3,
        humanizerCavityScore: 0.9,
      })
      expect(v.tier).toBe("light")
      expect(v.skip).toBe(true)
      expect(v.guidance).toContain("跳过")
    })

    it("cavity 但低于阈值 → 不跳过", () => {
      const v = classifyIntervention({
        slopPenalty: 1,
        weightedScore: 1,
        humanizerCavityScore: 0.3,
      })
      expect(v.skip).toBe(false)
    })

    it("自定义阈值覆盖", () => {
      const v2 = classifyIntervention({ slopPenalty: 1, weightedScore: 1, humanizerCavityScore: 0.25 }, {
        cavitySkipUpper: 0.2,
      })
      expect(v2.skip).toBe(true)
    })

    it("formatInterventionVerdict 输出稳定", () => {
      const v: InterventionVerdict = {
        tier: "medium",
        guidance: "x",
        skip: false,
        productHardGate: false,
      }
      expect(formatInterventionVerdict(v)).toBe("intervention=medium rewrite-bounded Track B soft")
      const v2: InterventionVerdict = { tier: "light", guidance: "x", skip: true, productHardGate: false }
      expect(formatInterventionVerdict(v2)).toContain("skip(rewriter-cavity)")
    })
  })

  describe("INTERVENTION_DEFAULTS", () => {
    it("常量存在且 Track B soft 立场 (36 号标定: 每千字口径 2.5/6.0)", () => {
      expect(INTERVENTION_DEFAULTS.lightUpper).toBe(2.5)
      expect(INTERVENTION_DEFAULTS.rewriteLower).toBe(6.0)
      expect(INTERVENTION_DEFAULTS.slopFloor).toBe(5)
      expect(INTERVENTION_DEFAULTS.cavitySkipUpper).toBe(0.7)
    })
  })
})
