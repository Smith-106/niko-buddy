import { describe, expect, it } from "vitest"
import {
  GATE_V2_WEIGHTS,
  GATE_V2_PASS_THRESHOLD,
  gateV2WeightedScore,
  mapHookTypeToScore,
  extractReadingPowerFeatures,
  buildP2ReferenceScore,
  formatP2ReferenceScore,
} from "./gate-v2-scoring"

describe("S3a Gate v2 加权 P2 参考 (StoryForge gate.rs 移植)", () => {
  it("加权系数 0.2/0.3/0.5 + threshold 0.75", () => {
    expect(GATE_V2_WEIGHTS).toEqual({ code: 0.2, rule: 0.3, model: 0.5 })
    expect(GATE_V2_PASS_THRESHOLD).toBe(0.75)
  })

  it("gateV2WeightedScore: 0.2*code + 0.3*rule + 0.5*model", () => {
    const s = gateV2WeightedScore(1.0, 0.8, 0.6)
    expect(s.weighted).toBeCloseTo(0.2 + 0.24 + 0.3) // 0.74
    expect(s.referencePass).toBe(false) // 0.74 < 0.75
    const pass = gateV2WeightedScore(1.0, 0.8, 0.7)
    expect(pass.weighted).toBeCloseTo(0.79)
    expect(pass.referencePass).toBe(true)
  })

  it("hook 映射: transition 0 / cliffhanger+mystery 0.9 / emotional+action 0.6 / weak 0.3", () => {
    expect(mapHookTypeToScore("cliffhanger", false)).toBe(0.9)
    expect(mapHookTypeToScore("mystery", false)).toBe(0.9)
    expect(mapHookTypeToScore("emotional", false)).toBe(0.6)
    expect(mapHookTypeToScore("action", false)).toBe(0.6)
    expect(mapHookTypeToScore("weak", false)).toBe(0.3)
    expect(mapHookTypeToScore("cliffhanger", true)).toBe(0) // transition 覆盖
  })

  it("reading_power: hook*0.4 + coolpoint*0.3 + micropayoff*0.3 clamp 0..1", () => {
    // cliffhanger(0.9) + 1 coolpoint(0.1) + 1 micropayoff(0.1)
    const content = "他推开门，却发现……就在这时，一个身影出现在他面前，全场哗然，昔日的仇人终于付出代价，他冷声道：'你是谁？'"
    const rp = extractReadingPowerFeatures(content)
    expect(rp.readingPowerScore).toBeGreaterThan(0.3)
    // 精确: hook 0.9*0.4=0.36 + coolpoint 0.1*0.3=0.03 + micropayoff 0.1*0.3=0.03 = 0.42
    expect(rp.readingPowerScore).toBeCloseTo(0.42, 1)
  })

  it("coolpoint 上限 0.8 / micropayoff 上限 0.4 (graders.rs:112-115)", () => {
    // 大量爽点词 → coolpointCount 大但 score 封顶
    const content = ("打脸反杀碾压逆转 打脸反杀碾压逆转 打脸反杀碾压逆转 打脸反杀碾压逆转 ").repeat(5)
      + " 兑现回应报应 兑现回应报应 兑现回应报应 兑现回应报应 兑现回应报应 兑现回应报应 "
      + "伏笔回收 线索闭环 伏笔回收 线索闭环"
    const rp = extractReadingPowerFeatures(content)
    expect(rp.coolpointCount).toBeGreaterThan(8)
    expect(rp.micropayoffCount).toBeGreaterThan(4)
    expect(rp.readingPowerScore).toBeLessThanOrEqual(1)
  })

  it("transition 章 → hook 0, reading_power 低", () => {
    const short = "清晨的街道很安静。" // 无对话无冲突 → transition
    const rp = extractReadingPowerFeatures(short)
    expect(rp.isTransition).toBe(true)
    expect(rp.hookScore).toBe(0)
    expect(rp.readingPowerScore).toBe(0)
  })

  it("buildP2ReferenceScore: gate*0.5 + reading_power*0.5", () => {
    const score = buildP2ReferenceScore({
      gate: { code: 1.0, rule: 1.0, model: 1.0 },
      content: "他推开门，却发现……就在这时，全场哗然。",
    })
    expect(score.referenceScore).toBeGreaterThanOrEqual(0.5)
    expect(score.gateV2!.weighted).toBe(1.0)
    expect(score.p0OverrideGuard).toContain("never overrides P0")
  })

  it("P2 参考分永不覆盖 P0 (契约字段存在且 gate 判定不暴露)", () => {
    const score = buildP2ReferenceScore({ content: "普通正文" })
    // 参考分再高也只带 p0OverrideGuard 契约, 无任何 gate 判定入口
    expect(score.p0OverrideGuard).toBe("P2 reference only — never overrides P0 consistency gate")
    // gateV2 可选: 无 gate 输入时仅 reading_power
    expect(score.gateV2).toBeUndefined()
    expect(score.referenceScore).toBe(score.readingPower.readingPowerScore)
  })

  it("detects mystery / emotional / action hook types from the tail", () => {
    expect(extractReadingPowerFeatures('他低声道：「这个秘密困扰了他很久」').hookType).toBe("mystery")
    expect(extractReadingPowerFeatures('他低声道：「全场泪目，令人心碎的一幕」').hookType).toBe("emotional")
    expect(extractReadingPowerFeatures('他低声道：「双方出手，展开激烈追逐」').hookType).toBe("action")
    expect(extractReadingPowerFeatures('他低声道：「今天天气不错」').hookType).toBe("weak")
  })

  it("formatP2ReferenceScore renders gateV2=n/a without a gate and skips transition tag", () => {
    const text = formatP2ReferenceScore(buildP2ReferenceScore({ content: '他问道：「你是谁？」' }))
    expect(text).toContain("gateV2=n/a")
    expect(text).not.toContain("transition")
  })

  it("formatP2ReferenceScore renders gate and transition tag", () => {
    const score = buildP2ReferenceScore({
      gate: { code: 0.9, rule: 0.8, model: 0.7 },
      content: "清晨的街道很安静。",
    })
    const text = formatP2ReferenceScore(score)
    expect(text).toContain("P2参考=")
    expect(text).toContain("gateV2=0.77(0.9/0.8/0.7)")
    expect(text).toContain("transition")
  })
})
