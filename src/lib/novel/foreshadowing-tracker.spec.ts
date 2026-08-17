import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

import {
  createEmptyForeshadowingStore,
  foreshadowingToContextText,
  loadForeshadowingTracker,
  saveForeshadowingTracker,
  type Foreshadowing,
} from "./foreshadowing-tracker"

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
})
