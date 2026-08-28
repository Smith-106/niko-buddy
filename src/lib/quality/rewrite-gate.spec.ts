/**
 * rewrite-gate.spec.ts — v2.7.3 Draft-first 闸门验收
 *
 * 覆盖：formal 100% 拦截 / 渗透测试 0 成功
 */
import { describe, expect, it } from "vitest"
import { evaluateRewriteGate, type PenetrationAttempt } from "./rewrite-gate"

const att = (id: string, target: "pending" | "ready" | "formal", blocked: boolean): PenetrationAttempt => ({ id, target, blocked })

describe("Draft-first 闸门 — 渗透测试", () => {
  it("formal 目标 100% 拦截 → 零直写", () => {
    const attempts = [
      att("p1", "pending", false),
      att("p2", "ready", false),
      att("p3", "formal", true),
      att("p4", "formal", true),
    ]
    const r = evaluateRewriteGate(attempts)
    expect(r.formalWrites).toBe(0)
    expect(r.blockRate).toBe(1)
    expect(r.passed).toBe(true)
  })

  it("formal 直写成功 → 渗透失败（违规）", () => {
    const attempts = [att("p1", "formal", false)]
    const r = evaluateRewriteGate(attempts)
    expect(r.formalWrites).toBe(1)
    expect(r.passed).toBe(false)
  })
})
