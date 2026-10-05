/** C4 冒烟覆盖：src/lib/web-store.ts（自动生成，核心行为由专项 spec 加深） */
import { afterEach, describe, expect, it, vi } from "vitest"
import { getStore } from "./web-store"

const load = vi.fn(async () => ({ get: async () => null, set: async () => {}, save: async () => {} }))
const memory = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value) },
  clear: () => { memory.clear() },
})
vi.mock("@tauri-apps/plugin-store", () => ({ load }))
vi.mock("@/lib/platform", () => ({ isTauri: vi.fn(() => true) }))

import { isTauri } from "@/lib/platform"

describe("web-store.ts smoke", () => {
  afterEach(() => {
    vi.mocked(isTauri).mockReturnValue(true)
    localStorage.clear()
    load.mockClear()
  })

  it("getStore() resolves via mocked plugin-store", async () => {
    const store = await getStore()
    expect(store).toBeDefined()
    expect(load).toHaveBeenCalled()
  })

  it("uses localStorage outside Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const store = await getStore()
    await store.set("llmConfig", { provider: "ollama-cloud" })
    await expect(store.get("llmConfig")).resolves.toEqual({ provider: "ollama-cloud" })
    expect(load).not.toHaveBeenCalled()
  })
})
