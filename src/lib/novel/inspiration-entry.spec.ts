import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async () => {}),
}))

const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => "mock-uuid"),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

vi.mock("node:crypto", () => ({
  randomUUID: cryptoMocks.randomUUID,
}))

import {
  appendInspiration,
  createInspirationEntry,
  loadInspirationCollection,
  renderInspirationsForRouting,
  type InspirationCollection,
} from "./inspiration-entry"

describe("createInspirationEntry", () => {
  beforeEach(() => {
    cryptoMocks.randomUUID.mockReturnValue("mock-uuid")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-08T10:00:00.000Z"))
  })

  it("builds a valid mobile-sourced entry with id and timestamp", () => {
    const entry = createInspirationEntry("主角在雨夜遇见旧友", "plot")
    expect(entry).toEqual({
      id: "inspiration-mock-uuid",
      content: "主角在雨夜遇见旧友",
      category: "plot",
      createdAt: "2026-07-08T10:00:00.000Z",
      source: "mobile",
      tags: undefined,
    })
  })

  it("trims content and preserves tags", () => {
    const entry = createInspirationEntry("  对白太密  ", "dialogue", ["节奏", "重写"])
    expect(entry.content).toBe("对白太密")
    expect(entry.tags).toEqual(["节奏", "重写"])
  })

  it("omits tags when empty", () => {
    const entry = createInspirationEntry("场景：废弃工厂", "scene", [])
    expect(entry.tags).toBeUndefined()
  })

  it("rejects empty content", () => {
    expect(() => createInspirationEntry("   ", "other")).toThrow("inspiration content must not be empty")
  })

  it("generates a fresh id per call", () => {
    cryptoMocks.randomUUID.mockReturnValueOnce("a").mockReturnValueOnce("b")
    const e1 = createInspirationEntry("one", "character")
    const e2 = createInspirationEntry("two", "character")
    expect(e1.id).toBe("inspiration-a")
    expect(e2.id).toBe("inspiration-b")
  })
})

describe("renderInspirationsForRouting", () => {
  it("returns empty string for empty collection", () => {
    const empty: InspirationCollection = { schemaVersion: 1, entries: [], updatedAt: "x" }
    expect(renderInspirationsForRouting(empty)).toBe("")
  })

  it("groups entries by category in fixed order", () => {
    const collection: InspirationCollection = {
      schemaVersion: 1,
      updatedAt: "x",
      entries: [
        { id: "1", content: "剧情A", category: "plot", createdAt: "t", source: "mobile" },
        { id: "2", content: "人物A", category: "character", createdAt: "t", source: "mobile" },
        { id: "3", content: "剧情B", category: "plot", createdAt: "t", source: "mobile", tags: ["钩子"] },
      ],
    }
    const out = renderInspirationsForRouting(collection)
    expect(out).toContain("# 移动端灵感 (导入桌面深写)")
    // character block before plot block (fixed order)
    expect(out.indexOf("### 人物")).toBeLessThan(out.indexOf("### 剧情"))
    expect(out).toContain("- 人物A")
    expect(out).toContain("- 剧情A")
    expect(out).toContain("- 剧情B [钩子]")
  })

  it("skips categories with no entries", () => {
    const collection: InspirationCollection = {
      schemaVersion: 1,
      updatedAt: "x",
      entries: [
        { id: "1", content: "对白X", category: "dialogue", createdAt: "t", source: "mobile" },
      ],
    }
    const out = renderInspirationsForRouting(collection)
    expect(out).not.toContain("### 人物")
    expect(out).toContain("### 对白")
  })

  it("returns empty string when entries carry categories outside the fixed order", () => {
    // External .json data is cast, not validated — an unknown category never
    // matches CATEGORY_ORDER, so no section is rendered.
    const collection: InspirationCollection = {
      schemaVersion: 1,
      updatedAt: "x",
      entries: [
        { id: "1", content: "外部数据", category: "unknown", createdAt: "t", source: "mobile" } as unknown as InspirationCollection["entries"][number],
      ],
    }
    expect(renderInspirationsForRouting(collection)).toBe("")
  })
})

describe("loadInspirationCollection", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("returns empty collection when file does not exist", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    const col = await loadInspirationCollection("E:/Novel")
    expect(col.schemaVersion).toBe(1)
    expect(col.entries).toEqual([])
  })

  it("loads and parses existing file", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    const payload = {
      schemaVersion: 1,
      entries: [
        { id: "1", content: "c", category: "plot", createdAt: "t", source: "mobile" },
      ],
      updatedAt: "2026-07-08T00:00:00.000Z",
    }
    fsMocks.readFile.mockResolvedValue(JSON.stringify(payload))
    const col = await loadInspirationCollection("E:/Novel")
    expect(col.entries).toHaveLength(1)
    expect(col.entries[0].content).toBe("c")
    expect(col.updatedAt).toBe("2026-07-08T00:00:00.000Z")
  })

  it("degrades to empty collection on invalid schemaVersion (BP-003 crash-safety)", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ schemaVersion: 2, entries: [] }))
    const col = await loadInspirationCollection("E:/Novel")
    // BP-003: corrupt/invalid inspirations.json degrades to empty, not throw.
    expect(col.schemaVersion).toBe(1)
    expect(col.entries).toEqual([])
  })

  it("fills updatedAt with the current timestamp when the file omits it", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ schemaVersion: 1, entries: [] }))
    const col = await loadInspirationCollection("E:/Novel")
    expect(col.entries).toEqual([])
    expect(typeof col.updatedAt).toBe("string")
    expect(col.updatedAt.length).toBeGreaterThan(0)
  })

  it("degrades to empty collection when readFile rejects with a non-Error value", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockRejectedValue({ code: "EACCES" })
    const col = await loadInspirationCollection("E:/Novel")
    expect(col.schemaVersion).toBe(1)
    expect(col.entries).toEqual([])
  })
})

describe("appendInspiration", () => {
  beforeEach(() => {
    fsMocks.createDirectory.mockClear()
    fsMocks.fileExists.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockClear()
    fsMocks.writeFileAtomic.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-08T10:00:00.000Z"))
  })

  it("creates dir, loads existing, appends, persists via writeFileAtomic (BP-003)", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    const existing = {
      schemaVersion: 1,
      entries: [
        { id: "1", content: "old", category: "plot", createdAt: "t", source: "mobile" },
      ],
      updatedAt: "old",
    }
    fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))

    const entry = createInspirationEntry("new idea", "character")
    const col = await appendInspiration("E:/Novel", entry)

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(col.entries).toHaveLength(2)
    expect(col.entries[1]).toBe(entry)
    expect(col.updatedAt).toBe("2026-07-08T10:00:00.000Z")
    // BP-003: atomic write used, not bare writeFile.
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/inspirations.json",
      expect.stringContaining("new idea"),
    )
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("starts from empty collection when file missing", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    const entry = createInspirationEntry("first", "scene")
    const col = await appendInspiration("E:/Novel", entry)
    expect(col.entries).toEqual([entry])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledOnce()
  })

  it("starts from empty collection when existing file is corrupt (BP-003)", async () => {
    // Corrupt file: load degrades to empty, append still succeeds (no throw).
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("{ broken json")
    const entry = createInspirationEntry("recovery", "setting")
    const col = await appendInspiration("E:/Novel", entry)
    expect(col.entries).toEqual([entry])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/inspirations.json",
      expect.stringContaining("recovery"),
    )
  })
})
