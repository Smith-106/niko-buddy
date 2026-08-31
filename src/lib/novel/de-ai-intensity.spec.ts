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
    it("常量存在且 Track B soft 立场", () => {
      expect(INTERVENTION_DEFAULTS.lightUpper).toBe(6)
      expect(INTERVENTION_DEFAULTS.rewriteLower).toBe(16)
      expect(INTERVENTION_DEFAULTS.slopFloor).toBe(5)
      expect(INTERVENTION_DEFAULTS.cavitySkipUpper).toBe(0.7)
    })
  })
})
