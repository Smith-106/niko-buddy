import { describe, expect, it } from "vitest"
import {
  statisticalFingerprint,
  fingerprintBand,
  fingerprintToText,
  fingerprintDelta,
  type FingerprintResult,
} from "./mechanical-fingerprint"

describe("mechanical-fingerprint — 统计指纹自检 (零 LLM/IO)", () => {
  describe("statisticalFingerprint", () => {
    it("短文本返回有效结构", () => {
      const r = statisticalFingerprint("他推开门走了出去。夜色很深。远处有狗叫。")
      expect(r.sentence.mean).toBeGreaterThan(0)
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    })

    it("空文本安全", () => {
      const r = statisticalFingerprint("")
      expect(r.sentence.mean).toBe(0)
      expect(r.score).toBe(0)
    })

    it("均匀短句 → 低分 (机械齐整)", () => {
      const r = statisticalFingerprint("他走了。她来了。天黑了。风起了。灯灭了。门关了。")
      expect(r.sentence.cv).toBeLessThan(0.2)
      expect(r.score).toBeLessThan(0.4)
    })

    it("句长多样 → 高分", () => {
      const r = statisticalFingerprint(
        "他推开门，夜风卷着雨丝扑在脸上。走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛。他没说话，只是把伞轻轻放在墙边。",
      )
      expect(r.score).toBeGreaterThan(0.5)
    })
  })

  describe("fingerprintBand", () => {
    it("划分 unnattural/borderline/natural", () => {
      expect(fingerprintBand(0.1)).toBe("unnatural")
      expect(fingerprintBand(0.5)).toBe("borderline")
      expect(fingerprintBand(0.8)).toBe("natural")
    })
  })

  describe("fingerprintToText", () => {
    it("输出包含关键指标", () => {
      const r = statisticalFingerprint("他走了。她来了。")
      const t = fingerprintToText(r)
      expect(t).toContain("score=")
      expect(t).toContain("CV=")
      expect(t).toContain("突发性")
    })
  })

  describe("fingerprintDelta", () => {
    const base: FingerprintResult = {
      sentence: { mean: 10, std: 2, cv: 0.2, p25: 8, p75: 12, entropy: 0.5 },
      burstiness: 0.5,
      openerDiversity: 0.5,
      topWordRepetition: 0.1,
      score: 0.5,
    }
    it("改善 delta 为正", () => {
      const after: FingerprintResult = { ...base, score: 0.7 }
      const d = fingerprintDelta(base, after)
      expect(d.scoreDelta).toBe(0.2)
      expect(d.improved).toBe(true)
      expect(d.summary).toContain("+20")
    })
    it("恶化 delta 为负", () => {
      const after: FingerprintResult = { ...base, score: 0.3 }
      const d = fingerprintDelta(base, after)
      expect(d.scoreDelta).toBe(-0.2)
      expect(d.improved).toBe(false)
      expect(d.summary).toContain("未改善")
    })
  })
})
