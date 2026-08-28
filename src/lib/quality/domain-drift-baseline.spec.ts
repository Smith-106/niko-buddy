/**
 * domain-drift-baseline.spec.ts — v2.6.11 D1 验收
 *
 * 覆盖：三元组锚定 / 指纹构建 / 漂移检测 / 超阈判定
 */
import { describe, expect, it } from "vitest"
import { buildFingerprint, detectDrift, verifyAnchorKey } from "./domain-drift-baseline"

describe("D1 域漂移基准 — 三元组锚定", () => {
  it("合法三元组通过", () => {
    expect(verifyAnchorKey({ chapter: 3, model: "deepseek-v4-pro", prompt: "p1" })).toBe(true)
  })

  it("非法三元组拒绝（章次=0）", () => {
    expect(verifyAnchorKey({ chapter: 0, model: "m", prompt: "p" })).toBe(false)
  })
})

describe("D1 域漂移基准 — 指纹 + 漂移检测", () => {
  it("同分布无漂移", () => {
    const fp = buildFingerprint([[1, 2, 3], [1.1, 2.1, 3.1], [0.9, 1.9, 2.9]])
    const r = detectDrift(fp, [1, 2, 3])
    expect(r.drift).toBeLessThan(0.1)
    expect(r.drifted).toBe(false)
  })

  it("异分布超阈漂移", () => {
    const fp = buildFingerprint([[1, 2, 3], [1.1, 2.1, 3.1], [0.9, 1.9, 2.9]])
    const r = detectDrift(fp, [9, 1, 1])
    expect(r.drift).toBeGreaterThan(0.5)
    expect(r.drifted).toBe(true)
  })

  it("空输入安全", () => {
    const fp = buildFingerprint([])
    expect(detectDrift(fp, []).drifted).toBe(false)
  })
})
