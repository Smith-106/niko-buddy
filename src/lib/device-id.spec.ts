import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { conflictFileName } from "@/lib/novel/sync-client"
import { getDeviceId, sanitizeDeviceId, setDeviceId } from "@/lib/device-id"

const KEY = "qmai.deviceId"

/** node 测试环境无 localStorage，按既有 crypto.spec.ts 的做法补一个。 */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

let storage: Storage

beforeEach(() => {
  storage = makeLocalStorage()
  ;(globalThis as { localStorage?: Storage }).localStorage = storage
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
  vi.resetModules()
  vi.restoreAllMocks()
})

describe("sanitizeDeviceId", () => {
  it("剔除两侧冲突命名判定不接受的字符", () => {
    expect(sanitizeDeviceId("dev-a b/c#d")).toBe("dev-abcd")
    expect(sanitizeDeviceId("  spaced  ")).toBe("spaced")
    expect(sanitizeDeviceId("____")).toBe("____")
  })

  it("截断到 64 字符（两侧实现均无长度上限，此上限只防病态输入）", () => {
    expect(sanitizeDeviceId("x".repeat(100))).toHaveLength(64)
  })
})

describe("getDeviceId", () => {
  it("首次调用生成并持久化到 qmai.deviceId", () => {
    const id = getDeviceId()
    expect(id).toMatch(/^dev-[A-Za-z0-9_-]+$/)
    expect(storage.getItem(KEY)).toBe(id)
  })

  it("重复调用返回同一值（同进程稳定）", () => {
    expect(getDeviceId()).toBe(getDeviceId())
  })

  it("跨模块重载（模拟应用重启）仍是同一值", async () => {
    const first = getDeviceId()
    vi.resetModules()
    const reloaded = await import("@/lib/device-id")
    expect(reloaded.getDeviceId()).toBe(first)
  })

  it("存量值含非法字符时读取即清洗", () => {
    storage.setItem(KEY, "dev-!!bad id")
    expect(getDeviceId()).toBe("dev-badid")
  })

  it("存量值为空串时重新生成", () => {
    storage.setItem(KEY, "")
    expect(getDeviceId()).toMatch(/^dev-[A-Za-z0-9_-]+$/)
  })

  it("无 localStorage（隐私模式/受限 WebView）时进程内恒定", async () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    vi.resetModules()
    const mod = await import("@/lib/device-id")
    const a = mod.getDeviceId()
    expect(a).toMatch(/^dev-[A-Za-z0-9_-]+$/)
    expect(mod.getDeviceId()).toBe(a)
  })

  it("显式覆盖值优先且同样被清洗", () => {
    expect(getDeviceId("dev-explicit")).toBe("dev-explicit")
    expect(getDeviceId("dev-ex plicit")).toBe("dev-explicit")
  })
})

describe("setDeviceId", () => {
  it("写入清洗后的值（连字符合法、空格被剔除），后续 getDeviceId 返回它", () => {
    const applied = setDeviceId("my-laptop 01")
    expect(applied).toBe("my-laptop01")
    expect(storage.getItem(KEY)).toBe("my-laptop01")
    expect(getDeviceId()).toBe("my-laptop01")
  })

  it("空/全非法输入不覆盖现值（不把设备标识改坏）", () => {
    const original = getDeviceId()
    expect(setDeviceId("")).toBe(original)
    expect(setDeviceId("!!!")).toBe(original)
    expect(storage.getItem(KEY)).toBe(original)
  })
})

describe("与冲突命名的契约", () => {
  it("生成的标识必能产出合法冲突副本名（conflictFileName 不为 null）", () => {
    const id = getDeviceId()
    const name = conflictFileName(id, "2026-09-12T10:00:00")
    expect(name).not.toBeNull()
    // 注意：conflictFileName 也会清洗时间戳（`:`/`T` 被剔除），故此处断言清洗后的形态。
    expect(name).toBe(`.conflict-${id}-2026-09-12100000`)
  })

  it("用户自定义的标识同样能产出合法冲突副本名", () => {
    setDeviceId("desk top / 2")
    expect(getDeviceId()).toBe("desktop2")
    expect(conflictFileName(getDeviceId(), "2026-09-12")).toBe(
      ".conflict-desktop2-2026-09-12",
    )
  })
})
