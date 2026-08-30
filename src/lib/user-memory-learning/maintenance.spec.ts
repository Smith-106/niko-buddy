import { describe, expect, it } from "vitest"
import { runUserMemoryMaintenance } from "./maintenance"
import { GLOBAL_USER_MEMORY_STORAGE_KEY, loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig, upsertAutomaticUserMemoryRule } from "./store"

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  values = new Map<string, string>()
  writes = 0
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.writes += 1; this.values.set(key, value) }
}

describe("user memory startup maintenance", () => {
  it("仅在治理结果变化时写回存储", () => {
    const storage = new MemoryStorage()
    let config = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "回答时先给结论。", category: "interaction_preference", surfaces: ["all"], confidence: 0.8,
      evidenceSummary: "证据", sourceHash: "h1",
    }, 100)
    saveGlobalUserMemoryConfig(config, storage)
    const before = storage.writes

    expect(runUserMemoryMaintenance(storage, 200)).toBe(false)
    expect(storage.writes).toBe(before)
    expect(storage.getItem(GLOBAL_USER_MEMORY_STORAGE_KEY)).not.toBeNull()

    config = { ...config, rules: config.rules.map((rule) => ({ ...rule, expiresAt: 150 })) }
    saveGlobalUserMemoryConfig(config, storage)
    expect(runUserMemoryMaintenance(storage, 200)).toBe(true)
    expect(loadGlobalUserMemoryConfig(storage).rules[0]?.status).toBe("expired")
  })
})
