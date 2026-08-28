/**
 * decision-points.spec.ts — v2.6.8 D4 验收
 *
 * 覆盖：append-only / hash 链校验 / 写前拒非追加 / 锚件白名单
 */
import { describe, expect, it } from "vitest"
import { ANCHOR_WHITELIST, appendEvent, hashEvent, isWhitelistedAnchor, validateChain } from "./decision-points"

describe("D4 不可逆决策点 — append-only + hash 链", () => {
  it("追加事件：seq 单调递增 + prevHash 链", () => {
    const r1 = appendEvent([], { chapterId: "ch1", description: "主角决定离开", isCausalHub: true, ts: "t1" })
    expect(r1.ok).toBe(true)
    expect(r1.chain[0].seq).toBe(1)
    expect(r1.chain[0].prevHash).toBe("genesis")

    const r2 = appendEvent(r1.chain, { chapterId: "ch1", description: "主角烧掉信", isCausalHub: false, ts: "t2" })
    expect(r2.ok).toBe(true)
    expect(r2.chain[1].seq).toBe(2)
    expect(r2.chain[1].prevHash).toBe(hashEvent({ ...r1.chain[0], prevHash: undefined } as never))
  })

  it("写前拒非追加（seq 不连续拒绝——数据层强制）", () => {
    const r1 = appendEvent([], { chapterId: "ch1", description: "d1", isCausalHub: false, ts: "t1" })
    const r2 = appendEvent(r1.chain, { seq: 5, chapterId: "ch1", description: "d2", isCausalHub: false, ts: "t2" } as never)
    expect(r2.ok).toBe(false)
    expect(r2.reason).toContain("非追加写入拒绝")
  })

  it("hash 链校验：完整链通过", () => {
    const r1 = appendEvent([], { chapterId: "ch1", description: "d1", isCausalHub: true, ts: "t1" })
    const r2 = appendEvent(r1.chain, { chapterId: "ch1", description: "d2", isCausalHub: false, ts: "t2" })
    expect(validateChain(r2.chain).valid).toBe(true)
  })

  it("hash 链校验：篡改断链（外部改 status.json 恢复协议）", () => {
    const r1 = appendEvent([], { chapterId: "ch1", description: "d1", isCausalHub: true, ts: "t1" })
    const r2 = appendEvent(r1.chain, { chapterId: "ch1", description: "d2", isCausalHub: false, ts: "t2" })
    const tampered = [{ ...r2.chain[1], description: "被篡改" }]
    const v = validateChain(tampered)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).not.toBeNull()
  })
})

describe("D4 锚件 Anti-AI 白名单（防机械提示词误判）", () => {
  it("白名单锚件通过", () => {
    expect(ANCHOR_WHITELIST.length).toBeGreaterThan(0)
    expect(isWhitelistedAnchor("不可逆决策点")).toBe(true)
    expect(isWhitelistedAnchor("因果枢纽")).toBe(true)
  })

  it("白名单外锚件标记需复核", () => {
    expect(isWhitelistedAnchor("随便写的锚")).toBe(false)
  })
})
