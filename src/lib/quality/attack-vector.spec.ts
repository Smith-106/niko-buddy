/**
 * attack-vector.spec.ts — v2.7.1 新攻击向量闭环验收
 *
 * 覆盖：五段闭环 100% / 各向量 ≥10 用例
 */
import { describe, expect, it } from "vitest"
import { CLOSED_LOOP_STAGES, VECTOR_MIN_CASES, evaluateVector } from "./attack-vector"

const STAGES = ["reproduce", "detected", "attributed", "patched", "regressed"] as const

const closedCase = (id: string, vector: "semantic-rephrase" | "jailbreak") => ({ id, vector, stages: [...STAGES] })

describe("攻击向量 — 五段闭环", () => {
  it("语义改写 10 例全闭环 → 达标", () => {
    const cases = Array.from({ length: 10 }, (_, i) => closedCase(`sr-${i}`, "semantic-rephrase"))
    const r = evaluateVector(cases, "semantic-rephrase")
    expect(r.total).toBe(10)
    expect(r.closedRate).toBe(1)
    expect(r.passed).toBe(true)
    expect(VECTOR_MIN_CASES).toBe(10)
  })

  it("越狱 12 例全闭环 → 达标", () => {
    const cases = Array.from({ length: 12 }, (_, i) => closedCase(`jb-${i}`, "jailbreak"))
    const r = evaluateVector(cases, "jailbreak")
    expect(r.closedRate).toBe(1)
    expect(r.passed).toBe(true)
  })

  it("用例不足 10 → 不达标", () => {
    const cases = Array.from({ length: 5 }, (_, i) => closedCase(`sr-${i}`, "semantic-rephrase"))
    expect(evaluateVector(cases, "semantic-rephrase").passed).toBe(false)
  })

  it("缺一段闭环 → 不达标", () => {
    const cases = Array.from({ length: 10 }, (_, i) => closedCase(`sr-${i}`, "semantic-rephrase"))
    cases[0].stages = CLOSED_LOOP_STAGES.filter((s) => s !== "patched")
    const r = evaluateVector(cases, "semantic-rephrase")
    expect(r.closed).toBe(9)
    expect(r.passed).toBe(false)
  })
})
