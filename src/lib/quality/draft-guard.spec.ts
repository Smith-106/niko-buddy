/**
 * draft-guard.spec.ts — v2.7.0 Draft-first 守卫验收
 *
 * 覆盖：只落 pending/ready / 正式正文拒绝
 */
import { describe, expect, it } from "vitest"
import { guardDraft } from "./draft-guard"

describe("Draft-first 守卫", () => {
  it("pending 允许", () => {
    expect(guardDraft("pending").allowed).toBe(true)
  })

  it("ready 允许", () => {
    expect(guardDraft("ready").allowed).toBe(true)
  })

  it("formal（正式正文）拒绝——AI 输出先进草稿", () => {
    const r = guardDraft("formal")
    expect(r.allowed).toBe(false)
    expect(r.target).toBe("formal")
  })
})
