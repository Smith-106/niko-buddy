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

// ── 覆盖加深（增补：原有用例保留不动）─────────────────────────────────────────
// 目标：CV 上界衰减分支（cv > 0.7 → cvScore 线性衰减，不封顶为 1）。
// 这是「人为造不规则」的信号位：句长极不均匀必须扣分，而不是和自然区间同分。
describe("CV 上界衰减（增补）", () => {
  it("句长极不均匀（cv > 0.7）→ cvScore 走衰减分支，score 按衰减后的权重计", () => {
    // 2 字短句 + 40 字长句：mean≈21、std≈19 → cv≈0.9，落在「过不规则」区。
    const r = statisticalFingerprint(
      "走吧。他推开门，夜风卷着雨丝扑在脸上，走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛，一直亮到天明。",
    )
    expect(r.sentence.cv).toBeGreaterThan(0.7)
    const cvScore = Math.max(0, 1 - (r.sentence.cv - 0.7) / 0.7)
    // 前提：本用例确实落在衰减区间内（cvScore 严格小于自然区间的 1）——否则断言无意义
    expect(cvScore).toBeGreaterThan(0)
    expect(cvScore).toBeLessThan(0.95)
    const expected =
      0.35 * cvScore +
      0.2 * r.sentence.entropy +
      0.15 * (1 - Math.abs(r.burstiness - 0.5) / 0.5) +
      0.15 * Math.min(1, r.openerDiversity / 0.6) +
      0.15 * (r.topWordRepetition < 0.2 ? 1 : Math.max(0, 1 - (r.topWordRepetition - 0.2) / 0.2))
    expect(r.score).toBeCloseTo(expected, 10)
    expect(r.score).toBeLessThan(0.35 + 0.2 + 0.15 + 0.15 + 0.15)
  })

  it("CV 进一步升高 → 分数单调下降（衰减不是封顶）", () => {
    const milder = statisticalFingerprint(
      "走吧。他推开门，夜风卷着雨丝扑在脸上，走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛。",
    )
    const wilder = statisticalFingerprint(
      "走吧。他推开门，夜风卷着雨丝扑在脸上，走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛，一直亮到天明，雨也没有停下来的意思，整条街只剩下他的脚步声，一步一步走向那扇门。",
    )
    expect(wilder.sentence.cv).toBeGreaterThan(milder.sentence.cv)
    expect(wilder.score).toBeLessThan(milder.score)
  })
})

describe("空白文本（增补）", () => {
  it("纯空白 → 分句为空 → 全零指纹（不产生哨兵句）", () => {
    const r = statisticalFingerprint("   \n\t  ")
    expect(r.sentence).toEqual({ mean: 0, std: 0, cv: 0, p25: 0, p75: 0, entropy: 0 })
    expect(r.burstiness).toBe(0)
    expect(r.openerDiversity).toBe(0)
    expect(r.topWordRepetition).toBe(0)
    expect(r.score).toBe(0)
  })
})
