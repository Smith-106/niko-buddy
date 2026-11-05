import { afterEach, describe, expect, it, vi } from "vitest"
import { getStore } from "./web-store"

const memory = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
  clear: () => {
    memory.clear()
  },
})

const inner = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  load: vi.fn(async () => ({
    get: inner.get,
    set: inner.set,
    delete: inner.delete,
    save: inner.save,
  })),
}))
vi.mock("@tauri-apps/plugin-store", () => ({ load: inner.load }))
vi.mock("@/lib/platform", () => ({ isTauri: vi.fn(() => true) }))

import { isTauri } from "@/lib/platform"

const BROWSER_KEY = "niko-buddy.app-state"

afterEach(() => {
  vi.mocked(isTauri).mockReturnValue(true)
  memory.clear()
  vi.clearAllMocks()
})

describe("Tauri 路径（plugin-store 适配）", () => {
  it("load 固定参数打开 app-state.json", async () => {
    await getStore()
    expect(inner.load).toHaveBeenCalledWith("app-state.json", {
      autoSave: true,
      defaults: {},
    })
  })

  it("get 把 inner 的 undefined 归一为 null", async () => {
    inner.get.mockResolvedValueOnce(undefined)
    const store = await getStore()
    await expect(store.get("k")).resolves.toBeNull()
  })

  it("get 透传已有值", async () => {
    inner.get.mockResolvedValueOnce({ a: 1 })
    const store = await getStore()
    await expect(store.get("k")).resolves.toEqual({ a: 1 })
  })

  it("set/delete/save 委托给 inner", async () => {
    const store = await getStore()
    await store.set("k", { v: 2 })
    expect(inner.set).toHaveBeenCalledWith("k", { v: 2 })
    await store.delete("k")
    expect(inner.delete).toHaveBeenCalledWith("k")
    await store.save()
    expect(inner.save).toHaveBeenCalled()
  })
})

describe("浏览器路径（localStorage 同键契约）", () => {
  function browser() {
    vi.mocked(isTauri).mockReturnValue(false)
    return getStore()
  }

  it("set/get 往返，未写过的键读出 null", async () => {
    const store = await browser()
    await expect(store.get("llmConfig")).resolves.toBeNull()
    await store.set("llmConfig", { provider: "ollama-cloud" })
    await expect(store.get("llmConfig")).resolves.toEqual({
      provider: "ollama-cloud",
    })
  })

  it("delete 只删目标键、保留其余", async () => {
    const store = await browser()
    await store.set("a", 1)
    await store.set("b", 2)
    await store.delete("a")
    await expect(store.get("a")).resolves.toBeNull()
    await expect(store.get("b")).resolves.toBe(2)
  })

  it("save 空实现可调用", async () => {
    const store = await browser()
    await expect(store.save()).resolves.toBeUndefined()
  })

  it("损坏的 JSON 降级为空状态（get 读出 null 而非抛错）", async () => {
    memory.set(BROWSER_KEY, "{not-json")
    const store = await browser()
    await expect(store.get("any")).resolves.toBeNull()
    // 损坏后仍可写：覆盖为合法状态
    await store.set("k", "v")
    await expect(store.get("k")).resolves.toBe("v")
  })

  it("非对象 JSON（数组/字符串）同样视为空状态", async () => {
    for (const raw of ['[1,2]', '"str"', "123"]) {
      memory.set(BROWSER_KEY, raw)
      const store = await browser()
      await expect(store.get("any")).resolves.toBeNull()
    }
  })

  it("localStorage 缺席时读写不崩（SSR/受限环境）", async () => {
    vi.stubGlobal("localStorage", undefined)
    const store = await browser()
    await expect(store.get("k")).resolves.toBeNull()
    await expect(store.set("k", 1)).resolves.toBeUndefined()
    await expect(store.delete("k")).resolves.toBeUndefined()
  })
})
