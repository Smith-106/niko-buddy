import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — createAtomicJsonStore uses readFile / writeFileAtomic /
// createDirectory from @/commands/fs. We DO NOT mock @/lib/path-utils
// (normalizePath is pure string ops on forward-slash, works in test).
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => {}),
  createDirectory: vi.fn(async (_path: string) => {}),
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

describe("E-03 迁移链内部排序（按 to 升序执行，不依赖调用方顺序）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
  })

  it("migrations 逆序传入仍按 to 升序执行（v1 → v3 两级）", async () => {
    const order: string[] = []
    const store = createAtomicJsonStore<TestStore & { v2?: boolean; v3?: boolean }>("chain.json", emptyStore, {
      currentVersion: 3,
      migrations: [
        { from: 2, to: 3, reversibility: "R0", forward: (raw) => { order.push("2→3"); return { ...raw, v3: true } }, inverse: (raw) => raw },
        { from: 1, to: 2, reversibility: "R0", forward: (raw) => { order.push("1→2"); return { ...raw, v2: true } }, inverse: (raw) => raw },
      ],
    })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], lastUpdated: "epoch" }))
    const loaded = await store.load("/P")
    expect(order).toEqual(["1→2", "2→3"])
    expect(loaded).toMatchObject({ items: ["a"], v2: true, v3: true })
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

describe("arrayFieldCaps（arch-risk W2 无界增长护栏）", () => {
  it("save 时数组字段截尾保最近 N 条", async () => {
    const { createAtomicJsonStore } = await import("./projection-store")
    const store = createAtomicJsonStore<{ entries: number[] }>(
      "test-cap.json",
      () => ({ entries: [] }),
      { arrayFieldCaps: { entries: 3 } },
    )
    const written: string[] = []
    // mock writeFileAtomic 捕获 payload
    const orig = (await import("@/commands/fs")).writeFileAtomic
    ;(await import("@/commands/fs")).writeFileAtomic = (async (_p: string, c: string) => { written.push(c) }) as typeof orig
    await store.save("/proj", { entries: [1, 2, 3, 4, 5, 6, 7] })
    ;(await import("@/commands/fs")).writeFileAtomic = orig
    const saved = JSON.parse(written[0])
    expect(saved.entries).toEqual([5, 6, 7])
  })

  it("数组未超 cap → 不截尾", async () => {
    const { createAtomicJsonStore } = await import("./projection-store")
    const store = createAtomicJsonStore<{ entries: number[] }>(
      "test-cap2.json",
      () => ({ entries: [] }),
      { arrayFieldCaps: { entries: 10 } },
    )
    const written: string[] = []
    const orig = (await import("@/commands/fs")).writeFileAtomic
    ;(await import("@/commands/fs")).writeFileAtomic = (async (_p: string, c: string) => { written.push(c) }) as typeof orig
    await store.save("/proj", { entries: [1, 2] })
    ;(await import("@/commands/fs")).writeFileAtomic = orig
    const saved = JSON.parse(written[0])
    expect(saved.entries).toEqual([1, 2])
  })

  it("缺省无 arrayFieldCaps → 不截尾（向后兼容）", async () => {
    const { createAtomicJsonStore } = await import("./projection-store")
    const store = createAtomicJsonStore<{ entries: number[] }>(
      "test-nocap.json",
      () => ({ entries: [] }),
    )
    const written: string[] = []
    const orig = (await import("@/commands/fs")).writeFileAtomic
    ;(await import("@/commands/fs")).writeFileAtomic = (async (_p: string, c: string) => { written.push(c) }) as typeof orig
    await store.save("/proj", { entries: [1, 2, 3, 4, 5] })
    ;(await import("@/commands/fs")).writeFileAtomic = orig
    const saved = JSON.parse(written[0])
    expect(saved.entries).toEqual([1, 2, 3, 4, 5])
  })
})

describe("读错误分类 / 空文件语义（ISS-20260712-010 多态）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("isMissingError=false → 非缺失类错误（EACCES）rethrow，不静默降级", async () => {
    const store = createAtomicJsonStore<TestStore>(
      "guarded.json",
      emptyStore,
      { isMissingError: (err) => (err as { code?: string }).code === "ENOENT" },
    )
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }))
    await expect(store.load("/P")).rejects.toThrow(/denied/)
  })

  it("isMissingError=false 且错误为 ENOENT → 仍按缺失降级为空 store", async () => {
    const store = createAtomicJsonStore<TestStore>(
      "guarded.json",
      emptyStore,
      { isMissingError: (err) => (err as { code?: string }).code === "ENOENT" },
    )
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("no such file"), { code: "ENOENT" }))
    await expect(store.load("/P")).resolves.toEqual(emptyStore())
  })

  it("onMissing='throw' → 文件缺失抛 Missing truth file（含相对路径）", async () => {
    const store = createAtomicJsonStore<TestStore>("must-exist.json", emptyStore, { onMissing: "throw" })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await expect(store.load("/P")).rejects.toThrow(/Missing truth file: \.novel\/must-exist\.json/)
  })

  it("空文件按 missing 语义处理：throw / null / empty 三态", async () => {
    fsMocks.readFile.mockResolvedValue("   \n\t ")
    const throwing = createAtomicJsonStore<TestStore>("empty.json", emptyStore, { onMissing: "throw" })
    await expect(throwing.load("/P")).rejects.toThrow(/Empty truth file: \.novel\/empty\.json/)

    const nullable = createAtomicJsonStore<TestStore>("empty.json", emptyStore, { onMissing: "null" })
    await expect(nullable.load("/P")).resolves.toBeNull()

    const degrading = createAtomicJsonStore<TestStore>("empty.json", emptyStore)
    await expect(degrading.load("/P")).resolves.toEqual(emptyStore())
  })
})

describe("migrateTruthFileBackward 边界（回滚脚本入口）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
  })

  it("fileVersion 已 <= targetVersion → 原样返回，不写盘（幂等回滚）", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], fileVersion: 1 }))
    const result = await migrateTruthFileBackward("/P", "m.json", 1, { currentVersion: 3 })
    expect(result).toEqual({ from: 1, to: 1 })
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("多级 inverse 按 to 降序执行（v3 → v1 逐级回滚），fileVersion 落回目标版本", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ items: ["a"], v2: true, v3: true, fileVersion: 3 }),
    )
    const order: string[] = []
    const result = await migrateTruthFileBackward("/P", "m.json", 1, {
      currentVersion: 3,
      migrations: [
        { from: 1, to: 2, reversibility: "R0", forward: (raw) => raw, inverse: (raw) => { order.push("2→1"); const { v2: _v2, ...rest } = raw; return rest } },
        { from: 2, to: 3, reversibility: "R0", forward: (raw) => raw, inverse: (raw) => { order.push("3→2"); const { v3: _v3, ...rest } = raw; return rest } },
      ],
    })
    expect(order).toEqual(["3→2", "2→1"])
    expect(result).toEqual({ from: 3, to: 1 })
    const payload = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1])
    expect(payload).toEqual({ items: ["a"] })
  })

  it("中间目标版本 > 1 → 保留并改写 fileVersion（不是剥字段）", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], v3: true, fileVersion: 3 }))
    const result = await migrateTruthFileBackward("/P", "m.json", 2, {
      currentVersion: 3,
      migrations: [
        { from: 2, to: 3, reversibility: "R0", forward: (raw) => raw, inverse: (raw) => { const { v3: _v3, ...rest } = raw; return rest } },
      ],
    })
    expect(result).toEqual({ from: 3, to: 2 })
    const payload = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1])
    expect(payload.fileVersion).toBe(2)
    expect(payload.items).toEqual(["a"])
  })

  it("inverse 命中 R2 有损步 → 未显式 opt-in 时拒绝回滚", async () => {
    const { migrateTruthFileBackward } = await import("./projection-store")
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ items: ["a"], fileVersion: 2 }))
    await expect(
      migrateTruthFileBackward("/P", "m.json", 1, {
        currentVersion: 2,
        migrations: [
          { from: 1, to: 2, reversibility: "R2", forward: (raw) => raw, inverse: (raw) => raw },
        ],
      }),
    ).rejects.toThrow(/Inverse migration 1→2 for m\.json is lossy \(R2\) and not opted in/)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})
