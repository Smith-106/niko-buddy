/**
 * canon-editor.spec.ts — TASK-P4-29b (T29b): canon 写路径编辑单测
 *
 * 蓝图 T29b 验收: `npx vitest run canon-editor wish-drive`
 * 覆盖：known_by/revealed_at 人工校正的校验（角色合法性/单调性）与
 * 写路径 op 构建（supersede_by_digest，句柄不外泄契约）。
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；Draft-first 不触正式层。
 */
import { describe, expect, it } from "vitest"
import {
  KNOWN_BY_ROLES,
  applyCorrectionToFact,
  buildCorrectionOp,
  validateCorrection,
  validateMonotonicReveal,
  type KnownByCorrection,
} from "./canon-editor"

const validCorrection: KnownByCorrection = {
  factDigest: "abc12345def",
  knownBy: ["protagonist"],
  revealedAt: 5,
  reason: "人工校正：主角应知晓该事实",
}

describe("TASK-P4-29b (T29b) canon-editor — 校正校验", () => {
  it("合法校正通过校验", () => {
    const v = validateCorrection(validCorrection)
    expect(v.ok).toBe(true)
    expect(v.errors).toHaveLength(0)
  })

  it("knownBy 角色非法被拒", () => {
    const v = validateCorrection({ ...validCorrection, knownBy: ["villain"] as never })
    expect(v.ok).toBe(false)
    expect(v.errors.join("; ")).toContain("角色非法")
  })

  it("knownBy 为空被拒", () => {
    const v = validateCorrection({ ...validCorrection, knownBy: [] })
    expect(v.ok).toBe(false)
    expect(v.errors.join("; ")).toContain("不能为空")
  })

  it("revealedAt < 1 被拒", () => {
    const v = validateCorrection({ ...validCorrection, revealedAt: 0 })
    expect(v.ok).toBe(false)
    expect(v.errors.join("; ")).toContain("≥1")
  })

  it("reason 为空被拒（审计要求）", () => {
    const v = validateCorrection({ ...validCorrection, reason: "  " })
    expect(v.ok).toBe(false)
    expect(v.errors.join("; ")).toContain("reason")
  })

  it("单调性：revealedAt 回退被拒", () => {
    const v = validateMonotonicReveal({ ...validCorrection, revealedAt: 3 }, 5)
    expect(v.ok).toBe(false)
    expect(v.errors.join("; ")).toContain("回退")
  })

  it("单调性：revealedAt 前进通过", () => {
    const v = validateMonotonicReveal({ ...validCorrection, revealedAt: 7 }, 5)
    expect(v.ok).toBe(true)
  })
})

describe("TASK-P4-29b (T29b) canon-editor — 写路径 op 构建", () => {
  it("构建 supersede_by_digest 校正 op（句柄经写路径下发，不外泄）", () => {
    const { op, audit } = buildCorrectionOp(validCorrection)
    expect(op.canonPayload.kind).toBe("supersede_by_digest")
    if (op.canonPayload.kind !== "supersede_by_digest") throw new Error("unreachable")
    const req = op.canonPayload.request as Record<string, unknown>
    expect(req.oldDigest).toBe("abc12345def")
    expect(req.revealedAt).toBe(5)
    expect(req.knownBy).toEqual(["protagonist"])
    expect(String(req.causedBy)).toContain("canon-editor")
    expect(audit.factDigest).toBe("abc12345def")
  })

  it("非法校正构建 op 抛错", () => {
    expect(() => buildCorrectionOp({ ...validCorrection, knownBy: [] })).toThrow(/非法/)
  })

  it("纯函数应用校正到事实投影（UI 预览，不落库）", () => {
    const fact = { digest: "abc12345def", knownBy: ["narrator" as const], revealedAt: 2 }
    const updated = applyCorrectionToFact(fact, validCorrection)
    expect(updated.knownBy).toEqual(["protagonist"])
    expect(updated.revealedAt).toBe(5)
    expect(fact.knownBy).toEqual(["narrator"]) // 原投影不变（纯函数）
  })

  it("KNOWN_BY_ROLES 枚举完整", () => {
    expect(KNOWN_BY_ROLES).toContain("protagonist")
    expect(KNOWN_BY_ROLES).toContain("narrator")
  })
})
