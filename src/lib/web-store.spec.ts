/** C4 冒烟覆盖：src/lib/web-store.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { getStore } from "./web-store"

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => null, set: async () => {}, save: async () => {} })),
}))
describe("web-store.ts smoke", () => {
  it("getStore() resolves via mocked plugin-store", async () => {
    const store = await getStore()
    expect(store).toBeDefined()
  })
})
