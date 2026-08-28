/**
 * version-lock.spec.ts — v2.7.0 版本锁验收
 *
 * 覆盖：产物哈希一致 / 配置哈希一致 / 失配阻断
 */
import { describe, expect, it } from "vitest"
import { verifyVersionLock } from "./version-lock"

const lock = (bundle: string, binary: string, prompt = "p1", temp = "0.7", weights = "w1") => ({
  artifacts: { bundle, binary },
  config: { prompt, temperature: temp, weights },
})

describe("版本锁 — 哈希一致", () => {
  it("产物+配置全一致 → 不阻断", () => {
    const r = verifyVersionLock(lock("h1", "h2"), lock("h1", "h2"))
    expect(r.artifactsMatch).toBe(true)
    expect(r.configMatch).toBe(true)
    expect(r.blocked).toBe(false)
  })

  it("产物哈希失配 → fail-fast 阻断", () => {
    const r = verifyVersionLock(lock("h1", "h2"), lock("h1-x", "h2"))
    expect(r.blocked).toBe(true)
  })

  it("配置哈希失配（温度漂移）→ 阻断（防漏锁绕过）", () => {
    const r = verifyVersionLock(lock("h1", "h2", "p1", "0.7"), lock("h1", "h2", "p1", "0.9"))
    expect(r.configMatch).toBe(false)
    expect(r.blocked).toBe(true)
  })
})
