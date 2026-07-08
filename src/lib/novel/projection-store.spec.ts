import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — createAtomicJsonStore uses readFile / writeFileAtomic /
// createDirectory from @/commands/fs. We DO NOT mock @/lib/path-utils
// (normalizePath is pure string ops on forward-slash, works in test).
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

import { createAtomicJsonStore } from "./projection-store"

interface TestStore {
  items: string[]
  lastUpdated: string
}

function emptyStore(): TestStore {
  return { items: [], lastUpdated: "epoch" }
}

describe("MAINT-002 createAtomicJsonStore", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("save → load roundtrip persists the store via writeFileAtomic", async () => {
    const store = createAtomicJsonStore<TestStore>("test-projection.json", emptyStore)
    const payload: TestStore = { items: ["a", "b"], lastUpdated: "2026-07-08" }
    // First save (writes), then load (reads the written JSON).
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(payload))

    await store.save("/P", payload)
    const loaded = await store.load("/P")

    // save created .novel/ then atomic-wrote the file.
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/P/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/P/.novel/test-projection.json",
      JSON.stringify(payload, null, 2),
    )
    // load read the same path and parsed it back.
    expect(fsMocks.readFile).toHaveBeenCalledWith("/P/.novel/test-projection.json")
    expect(loaded).toEqual(payload)
  })

  it("load on missing file returns emptyCtor() (not throw)", async () => {
    const store = createAtomicJsonStore<TestStore>("test-projection.json", emptyStore)
    // readFile rejects (file not found) — load must catch + return empty.
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    const loaded = await store.load("/Missing")
    expect(loaded).toEqual(emptyStore())
    // emptyCtor was invoked — fresh ISO-ish sentinel present.
    expect(loaded.lastUpdated).toBe("epoch")
  })

  it("load on corrupt (unparseable) file returns emptyCtor() (not throw)", async () => {
    const store = createAtomicJsonStore<TestStore>("test-projection.json", emptyStore)
    fsMocks.readFile.mockResolvedValue("{ truncated json")
    const loaded = await store.load("/Corrupt")
    expect(loaded).toEqual(emptyStore())
  })

  it("save uses normalizePath (forward-slash join) consistently with load", async () => {
    const store = createAtomicJsonStore<TestStore>("x.json", emptyStore)
    await store.save("C:\\Novel\\Sub", emptyStore())
    // normalizePath on Windows-style still joins with /. The createDirectory
    // call reveals the normalized path used.
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(
      expect.stringContaining("/.novel"),
    )
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      expect.stringContaining("/.novel/x.json"),
      expect.any(String),
    )
  })
})
