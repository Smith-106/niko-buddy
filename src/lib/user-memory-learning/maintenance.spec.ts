import { afterEach, describe, expect, it, vi } from "vitest"
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

  it("storage 为 null（无 window）→ 不执行治理，返回 false", () => {
    expect(runUserMemoryMaintenance(null, 200)).toBe(false)
  })
})

describe("user memory startup maintenance 默认存储探测", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("window 未定义 → runtimeStorage 返回 null，维护短路返回 false", () => {
    vi.stubGlobal("window", undefined)
    expect(runUserMemoryMaintenance()).toBe(false)
  })

  it("window.localStorage 可用 → 用真实存储治理，无变化时不写回", () => {
    const storage = new MemoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    expect(runUserMemoryMaintenance()).toBe(false)
    expect(storage.writes).toBe(0)
  })

  it("window.localStorage 访问抛错（隐私模式）→ 降级为 null，不崩溃且返回 false", () => {
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage blocked")
      },
    })
    vi.stubGlobal("window", win)
    expect(runUserMemoryMaintenance()).toBe(false)
  })
})
