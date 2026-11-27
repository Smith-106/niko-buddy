import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: fsMocks.readFile,
      writeFileAtomic: fsMocks.writeFileAtomic,
      createDirectory: fsMocks.createDirectory,
    
  }
})

import {
  createEmptyForeshadowingStore,
  foreshadowingToContextText,
  getActiveForeshadowings,
  getForeshadowingWatermark,
  loadForeshadowingTracker,
  markAbandoned,
  retainForeshadowingItems,
  saveForeshadowingTracker,
  type Foreshadowing,
} from "./foreshadowing-tracker"
import { applyStoreArrayFieldCaps } from "./projection-store"

function shadow(overrides: Partial<Foreshadowing> = {}): Foreshadowing {
  return {
    id: "f1",
    name: "玉佩",
    description: "来历不明的玉佩",
    status: "planted",
    plantedChapter: 3,
    advancedChapters: [],
    relatedCharacters: [],
    relatedEvents: [],
    notes: "",
    ...overrides,
  }
}

describe("foreshadowing-tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("createEmptyForeshadowingStore returns empty items with timestamp", () => {
    const store = createEmptyForeshadowingStore()
    expect(store.items).toEqual([])
    expect(store.lastUpdated).toBeTruthy()
  })

  it("saveForeshadowingTracker writes atomic JSON under .novel", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    const store = createEmptyForeshadowingStore()
    await saveForeshadowingTracker("C:/novel", store)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("C:/novel/.novel")
    const [filePath, contents] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(filePath).toBe("C:/novel/.novel/foreshadowing-tracker.json")
    expect(JSON.parse(contents).items).toEqual([])
  })

  it("loadForeshadowingTracker returns parsed store", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ items: [shadow()], lastUpdated: "t" }),
    )
    const store = await loadForeshadowingTracker("C:/novel")
    expect(store.items).toHaveLength(1)
    expect(store.items[0].name).toBe("玉佩")
  })

  it("loadForeshadowingTracker falls back to empty store on read/parse error", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const store = await loadForeshadowingTracker("C:/novel")
    expect(store.items).toEqual([])

    fsMocks.readFile.mockResolvedValue("not json")
    const store2 = await loadForeshadowingTracker("C:/novel")
    expect(store2.items).toEqual([])
  })

  it("foreshadowingToContextText returns empty for no unresolved items", () => {
    const store = {
      items: [
        shadow({ status: "resolved", resolvedChapter: 9 }),
        shadow({ id: "x", status: "resolved" }),
      ],
      lastUpdated: "t",
    }
    expect(foreshadowingToContextText(store)).toBe("")
  })

  it("foreshadowingToContextText maps planted and advanced items", () => {
    const store = {
      items: [
        shadow({ id: "a", status: "planted", name: "玉佩", plantedChapter: 3 }),
        shadow({ id: "b", status: "advanced", name: "铜镜", plantedChapter: 5 }),
        shadow({ id: "c", status: "resolved" }),
      ],
      lastUpdated: "t",
    }
    const text = foreshadowingToContextText(store)
    expect(text).toContain("[已埋设] 玉佩：来历不明的玉佩（第3章埋设）")
    expect(text).toContain("[推进中] 铜镜：来历不明的玉佩（第5章埋设）")
    expect(text).not.toContain("c")
  })

  it("foreshadowingToContextText excludes abandoned items (卸离活跃伏笔链)", () => {
    const store = {
      items: [
        shadow({ id: "a", status: "planted", name: "玉佩", plantedChapter: 3 }),
        shadow({ id: "b", status: "abandoned", name: "断线", plantedChapter: 4 }),
        shadow({ id: "c", status: "advanced", name: "铜镜", plantedChapter: 5 }),
      ],
      lastUpdated: "t",
    }
    const text = foreshadowingToContextText(store)
    expect(text).toContain("玉佩")
    expect(text).toContain("铜镜")
    expect(text).not.toContain("断线")
  })

  describe("markAbandoned", () => {
    it("planted → abandoned 合法转移，返回新对象不原地改", () => {
      const f = shadow({ status: "planted" })
      const out = markAbandoned(f)
      expect(out.status).toBe("abandoned")
      expect(f.status).toBe("planted")
      expect(out).not.toBe(f)
    })

    it("advanced → abandoned 合法转移", () => {
      const f = shadow({ status: "advanced" })
      expect(markAbandoned(f).status).toBe("abandoned")
      expect(f.status).toBe("advanced")
    })

    it("resolved 不可废弃 → 抛错", () => {
      expect(() => markAbandoned(shadow({ status: "resolved", resolvedChapter: 8 }))).toThrow()
    })

    it("abandoned 不可二次废弃 → 抛错", () => {
      expect(() => markAbandoned(shadow({ status: "abandoned" }))).toThrow()
    })
  })

  describe("编辑器注入上游（foreshadowingAlert）", () => {
    it("getActiveForeshadowings：仅 planted/advanced（resolved/abandoned 退出）", () => {
      const store = createEmptyForeshadowingStore()
      store.items = [
        shadow({ id: "p", status: "planted" }),
        shadow({ id: "a", status: "advanced", advancedChapters: [4] }),
        shadow({ id: "r", status: "resolved", resolvedChapter: 8 }),
        shadow({ id: "x", status: "abandoned" }),
      ]
      expect(getActiveForeshadowings(store).map((f) => f.id)).toEqual(["p", "a"])
    })

    it("getForeshadowingWatermark：取 planted/resolved/advanced 最大引用；空库为 1", () => {
      expect(getForeshadowingWatermark([])).toBe(1)
      expect(getForeshadowingWatermark([
        shadow({ plantedChapter: 3 }),
        shadow({ plantedChapter: 2, status: "advanced", advancedChapters: [5, 9] }),
        shadow({ plantedChapter: 1, status: "resolved", resolvedChapter: 7 }),
      ])).toBe(9)
    })
  })

  describe("retainForeshadowingItems（百章级未回收伏笔不变量）", () => {
    it("活跃伏笔数量 <= cap 时绝不驱逐任何 planted/advanced，并优先驱逐最旧 resolved/abandoned 且保原序", () => {
      const items: Foreshadowing[] = [
        shadow({ id: "active-ch1", name: "首章主线伏笔", status: "planted", plantedChapter: 1 }),
        shadow({ id: "old-resolved", name: "旧已回收", status: "resolved", plantedChapter: 2, resolvedChapter: 5 }),
        shadow({ id: "old-abandoned", name: "旧废弃", status: "abandoned", plantedChapter: 3 }),
        shadow({ id: "active-adv", name: "推进中伏笔", status: "advanced", plantedChapter: 4, advancedChapters: [12] }),
        shadow({ id: "new-resolved", name: "新已回收", status: "resolved", plantedChapter: 20, resolvedChapter: 88 }),
      ]

      const retained = retainForeshadowingItems(items, 3)
      expect(retained.map((f) => f.id)).toEqual(["active-ch1", "active-adv", "new-resolved"])
      expect(items).toHaveLength(5)
      expect(retainForeshadowingItems(items, 0)).toEqual([])
      expect(retainForeshadowingItems(items, 10)).toHaveLength(5)
    })

    it("活跃伏笔超过 cap 时按最近活动章号确定性留存且保原序", () => {
      const items: Foreshadowing[] = [
        shadow({ id: "a1", status: "planted", plantedChapter: 1 }),
        shadow({ id: "a2", status: "advanced", plantedChapter: 2, advancedChapters: [50] }),
        shadow({ id: "a3", status: "planted", plantedChapter: 30 }),
      ]
      expect(retainForeshadowingItems(items, 2).map((f) => f.id)).toEqual(["a2", "a3"])
    })

    it("saveForeshadowingTracker 超过 500 条时绝不驱逐第 1 章未回收伏笔并与 applyStoreArrayFieldCaps 同源", async () => {
      fsMocks.createDirectory.mockResolvedValue(undefined)
      fsMocks.writeFileAtomic.mockResolvedValue(undefined)

      const items: Foreshadowing[] = [
        shadow({ id: "ch1-planted", name: "命运之钥", status: "planted", plantedChapter: 1 }),
        ...Array.from({ length: 520 }, (_, i) =>
          shadow({
            id: `resolved-${i + 1}`,
            name: `已回收-${i + 1}`,
            status: "resolved",
            plantedChapter: i + 2,
            resolvedChapter: i + 3,
          }),
        ),
      ]
      const input = { items, lastUpdated: "2026-11-27T00:00:00.000Z" }
      await saveForeshadowingTracker("C:/novel", input)
      const saved = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1] as string) as { items: Foreshadowing[] }
      expect(saved.items).toHaveLength(500)
      expect(saved.items[0].id).toBe("ch1-planted")
      expect(saved.items.some((f) => f.id === "resolved-1")).toBe(false)
      expect(saved.items.some((f) => f.id === "resolved-520")).toBe(true)

      const replayed = applyStoreArrayFieldCaps("foreshadowing-tracker.json", input)
      expect(replayed.items.map((f) => f.id)).toEqual(saved.items.map((f) => f.id))
    })
  })
})
