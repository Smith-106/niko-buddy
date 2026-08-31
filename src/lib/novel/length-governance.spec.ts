import { describe, expect, it } from "vitest"
import {
  buildLengthTelemetry,
  countByMode,
  evaluateLength,
  evaluateLengthByCount,
  validateLengthSpec,
  type LengthSpec,
} from "./length-governance"

const SPEC: LengthSpec = {
  target: 4000,
  softMin: 3000,
  softMax: 5000,
  hardMin: 2000,
  hardMax: 8000,
  countingMode: "zh_chars",
}

describe("length-governance（吸收自 inkos models/length-governance 软硬界治理模式）", () => {
  it("countByMode：zh_chars 仅计 CJK；en_words 计 ASCII 词", () => {
    expect(countByMode("你好世界 hello world 123", "zh_chars")).toBe(4)
    expect(countByMode("你好世界 hello world 123", "en_words")).toBe(3)
  })

  it("validateLengthSpec：越界结构报错，合法规格零错误", () => {
    expect(validateLengthSpec(SPEC)).toEqual([])
    expect(
      validateLengthSpec({ ...SPEC, target: 9000 }).length,
    ).toBeGreaterThan(0)
    expect(
      validateLengthSpec({ ...SPEC, hardMin: 3500 }).length,
    ).toBeGreaterThan(0)
  })

  it("软硬界四段判定：within/soft/hard 精确分级", () => {
    expect(evaluateLength("字".repeat(4000), SPEC)).toMatchObject({ level: "within", action: "ok" })
    expect(evaluateLength("字".repeat(2500), SPEC)).toMatchObject({ level: "soft_violation", action: "warn" })
    expect(evaluateLength("字".repeat(5500), SPEC)).toMatchObject({ level: "soft_violation", action: "warn" })
    expect(evaluateLength("字".repeat(1500), SPEC)).toMatchObject({ level: "hard_violation", action: "block" })
    expect(evaluateLength("字".repeat(9000), SPEC)).toMatchObject({ level: "hard_violation", action: "block" })
    expect(evaluateLength("字".repeat(1500), SPEC).reason).toContain("硬下限")
  })

  it("en_words 模式按词计", () => {
    const enSpec: LengthSpec = { ...SPEC, countingMode: "en_words" }
    const text = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ")
    expect(evaluateLength(text, enSpec).level).toBe("within")
    expect(evaluateLength(text, enSpec).count).toBe(4000)
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(evaluateLength("字".repeat(4200), SPEC))).toBe(
      JSON.stringify(evaluateLength("字".repeat(4200), SPEC)),
    )
  })

  it("evaluateLengthByCount 与 evaluateLength 结果一致（复评路径）", () => {
    expect(evaluateLengthByCount(4200, SPEC)).toEqual(evaluateLength("字".repeat(4200), SPEC))
  })

  it("buildLengthTelemetry 组装遥测（lengthWarning 随终稿评估）", () => {
    const t = buildLengthTelemetry(
      3,
      SPEC,
      { writer: 4100, postRevise: 4150, final: 4200 },
      false,
    )
    expect(t).toMatchObject({
      chapter: 3,
      target: 4000,
      countingMode: "zh_chars",
      writerCount: 4100,
      postReviseCount: 4150,
      finalCount: 4200,
      repairApplied: false,
      lengthWarning: false,
    })
    const t2 = buildLengthTelemetry(3, SPEC, { writer: 4100, postRevise: 4150, final: 1500 }, true)
    expect(t2.lengthWarning).toBe(true)
    expect(t2.repairApplied).toBe(true)
  })
})
