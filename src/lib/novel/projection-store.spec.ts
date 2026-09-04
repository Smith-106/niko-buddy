import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — createAtomicJsonStore uses readFile / writeFileAtomic /
// createDirectory from @/commands/fs. We DO NOT mock @/lib/path-utils
// (normalizePath is pure string ops on forward-slash, works in test).
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => {}),
  createDirectory: vi.fn(async (_path: string) => {}),
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

// ============================================================================
// E-03 (run-execute-1, 双库架构蓝图): schema 版本化 + 迁移链 + 可逆性
// ============================================================================

describe("E-03 createAtomicJsonStore 版本化", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("save stamps fileVersion when currentVersion > 1", async () => {
    const store = createAtomicJsonStore<TestStore>("v.json", emptyStore, { currentVersion: 2 })
    await store.save("/P", { items: ["a"], lastUpdated: "t" })
    const payload = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1])
    expect(payload.fileVersion).toBe(2)
    expect(payload.items).toEqual(["a"])
  })

  it("save does not stamp fileVersion at v1 (旧文件无版本字段 = v1, 兼容可逆)", async () => {
    const store = createAtomicJsonStore<TestStore>("v.json", emptyStore)
    await store.save("/P", { items: ["a"], lastUpdated: "t" })
    const payload = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1])
    expect(payload.fileVersion).toBeUndefined()
  })

  it("load migrates v1 → v2 via forward chain (migrate-on-read)", async () => {
    const store = createAtomicJsonStore<TestStore>("m.json", emptyStore, {
      currentVersion: 2,
      migrations: [{
        from: 1, to: 2, reversibility: "R0",
        forward: (raw) => ({ ...raw, migrated: true }),
        inverse: (raw) => {
          const { migrated: _m, ...rest } = raw
          return rest
        },
      }],
    })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], lastUpdated: "t" }))
    const loaded = await store.load("/P")
    expect(loaded).toMatchObject({ items: ["a"], migrated: true })
  })

  it("load fails loud on unknown newer fileVersion (降级会静默毁新数据)", async () => {
    const store = createAtomicJsonStore<TestStore>("m.json", emptyStore, { currentVersion: 2 })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], fileVersion: 3 }))
    await expect(store.load("/P")).rejects.toThrow(/fileVersion 3 > current 2/)
  })

  it("load onMissing 'null' returns null (cognition 语义)", async () => {
    const store = createAtomicJsonStore<TestStore>("m.json", emptyStore, { onMissing: "null" })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await store.load("/P")).toBeNull()
  })

  it("load onCorrupt 'throw' rejects (character-state / cognition 语义)", async () => {
    const store = createAtomicJsonStore<TestStore>("m.json", emptyStore, { onCorrupt: "throw" })
    fsMocks.readFile.mockResolvedValue("{ broken")
    await expect(store.load("/P")).rejects.toThrow(/Failed to parse/)
  })

  it("R2 lossy migration requires allowLossy opt-in", async () => {
    const store = createAtomicJsonStore<TestStore>("m.json", emptyStore, {
      currentVersion: 2,
      migrations: [{
        from: 1, to: 2, reversibility: "R2",
        forward: (raw) => raw,
        inverse: (raw) => raw,
      }],
    })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"] }))
    await expect(store.load("/P")).rejects.toThrow(/lossy \(R2\)/)
  })
})

describe("E-03 migrateTruthFileBackward (回滚脚本入口)", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
  })

  it("rolls v2 → v1 via inverse chain and strips fileVersion", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], migrated: true, fileVersion: 2 }))
    const result = await migrateTruthFileBackward("/P", "m.json", 1, {
      currentVersion: 2,
      migrations: [{
        from: 1, to: 2, reversibility: "R0",
        forward: (raw) => ({ ...raw, migrated: true }),
        inverse: (raw) => {
          const { migrated: _m, ...rest } = raw
          return rest
        },
      }],
    })
    expect(result).toEqual({ from: 2, to: 1 })
    const payload = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1])
    expect(payload.fileVersion).toBeUndefined()
    expect(payload.migrated).toBeUndefined()
    expect(payload.items).toEqual(["a"])
  })

  it("rejects targetVersion >= currentVersion", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    await expect(migrateTruthFileBackward("/P", "m.json", 2, { currentVersion: 2 }))
      .rejects.toThrow(/targetVersion 2 must be < currentVersion 2/)
  })
})

describe("E-03 canonicalizeForHash / truthStoreHash (truth_fold_drift 可执行定义)", () => {
  it("strips volatile metadata (lastUpdated/fileVersion/At$ 墙钟) but keeps 认识论字段", async () => {
    const { canonicalizeForHash, truthStoreHash } = await import("./projection-store")
    const store = {
      lastUpdated: "2026-09-04T00:00:00.000Z",
      fileVersion: 2,
      items: [{ name: "a", updatedAt: "2026-09-04T00:00:00.000Z", validAt: "ch-3", revealedAt: "ch-5" }],
    }
    const canonical = canonicalizeForHash(store)
    expect(canonical.lastUpdated).toBeUndefined()
    expect(canonical.fileVersion).toBeUndefined()
    expect(canonical.items[0].updatedAt).toBeUndefined()
    expect(canonical.items[0].validAt).toBe("ch-3")
    expect(canonical.items[0].revealedAt).toBe("ch-5")
    const h1 = await truthStoreHash(store)
    const h2 = await truthStoreHash(JSON.parse(JSON.stringify(store)))
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("key order does not affect hash (deep-sorted)", async () => {
    const { truthStoreHash } = await import("./projection-store")
    const a = await truthStoreHash({ x: 1, y: { b: 2, a: 1 } })
    const b = await truthStoreHash({ y: { a: 1, b: 2 }, x: 1 })
    expect(a).toBe(b)
  })
})
