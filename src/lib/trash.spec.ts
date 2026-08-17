import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TrashItem } from "./trash"

const fsState = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsState)

import {
  cleanupExpiredTrashItems,
  getTrashDaysRemaining,
  listTrashItems,
  moveFileToTrash,
  permanentlyDeleteAllTrashItems,
  permanentlyDeleteTrashItem,
  readTrashItemContent,
  restoreTrashItem,
} from "./trash"

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function makeItem(overrides: Partial<TrashItem> = {}): TrashItem {
  return {
    id: "abc123",
    name: "a.md",
    originalPath: "/P/wiki/a.md",
    trashPath: "/P/.trash/files/abc123.md",
    deletedAt: 1000,
    expiresAt: 2000,
    kind: "chapter",
    ...overrides,
  }
}

const INDEX = "/P/.trash/items.json"
const ROOT = "/P/.trash"
const FILES = "/P/.trash/files"

function resolveRead(paths: Record<string, string | Error>): void {
  fsState.readFile.mockImplementation((p: string) => {
    if (p in paths) {
      const v = paths[p]
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
    }
    return Promise.reject(new Error(`unexpected read: ${p}`))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fsState.createDirectory.mockReset().mockResolvedValue(undefined)
  fsState.deleteFile.mockReset().mockResolvedValue(undefined)
  fsState.fileExists.mockReset().mockResolvedValue(false)
  fsState.readFile.mockReset().mockRejectedValue(new Error("no file"))
  fsState.writeFile.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("listTrashItems", () => {
  it("returns items sorted newest-first", async () => {
    const old = makeItem({ id: "old", deletedAt: 100 })
    const fresh = makeItem({ id: "fresh", deletedAt: 500 })
    resolveRead({ [INDEX]: JSON.stringify([old, fresh]) })
    await expect(listTrashItems("/P")).resolves.toEqual([fresh, old])
  })

  it("returns [] when the index cannot be read", async () => {
    fsState.readFile.mockRejectedValue(new Error("ENOENT"))
    await expect(listTrashItems("/P")).resolves.toEqual([])
  })

  it("returns [] when the index contains invalid JSON", async () => {
    resolveRead({ [INDEX]: "{not json" })
    await expect(listTrashItems("/P")).resolves.toEqual([])
  })

  it("returns [] when the index is not an array", async () => {
    resolveRead({ [INDEX]: "{}" })
    await expect(listTrashItems("/P")).resolves.toEqual([])
  })

  it("filters malformed entries out of the index", async () => {
    const valid = makeItem()
    resolveRead({
      [INDEX]: JSON.stringify([
        valid,
        null,
        42,
        "str",
        { id: 5, name: "x", originalPath: "p", trashPath: "t", deletedAt: 1, expiresAt: 2, kind: "chapter" },
        { id: "x", name: 5, originalPath: "p", trashPath: "t", deletedAt: 1, expiresAt: 2, kind: "chapter" },
        { id: "x", name: "x", originalPath: 5, trashPath: "t", deletedAt: 1, expiresAt: 2, kind: "chapter" },
        { id: "x", name: "x", originalPath: "p", trashPath: 5, deletedAt: 1, expiresAt: 2, kind: "chapter" },
        { id: "x", name: "x", originalPath: "p", trashPath: "t", deletedAt: "1", expiresAt: 2, kind: "chapter" },
        { id: "x", name: "x", originalPath: "p", trashPath: "t", deletedAt: 1, expiresAt: "2", kind: "chapter" },
        { id: "x", name: "x", originalPath: "p", trashPath: "t", deletedAt: 1, expiresAt: 2, kind: 7 },
      ]),
    })
    await expect(listTrashItems("/P")).resolves.toEqual([valid])
  })
})

describe("moveFileToTrash", () => {
  it("moves a file into the trash with a generated id and 30-day retention", async () => {
    resolveRead({
      "/P/wiki/old.md": "content",
      [INDEX]: "[]",
    })
    const item = await moveFileToTrash("/P", "/P/wiki/old.md", "chapter", NOW)
    expect(item.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/)
    expect(item.name).toBe("old.md")
    expect(item.originalPath).toBe("/P/wiki/old.md")
    expect(item.trashPath).toBe(`${FILES}/${item.id}.md`)
    expect(item.deletedAt).toBe(NOW)
    expect(item.expiresAt).toBe(NOW + 30 * DAY)
    expect(item.kind).toBe("chapter")
    expect(fsState.createDirectory).toHaveBeenCalledWith(ROOT)
    expect(fsState.createDirectory).toHaveBeenCalledWith(FILES)
    expect(fsState.writeFile).toHaveBeenCalledWith(`${FILES}/${item.id}.md`, "content")
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/wiki/old.md")
    // index written with the new item prepended
    const indexCall = fsState.writeFile.mock.calls.find((c) => c[0] === INDEX)
    expect(indexCall).toBeDefined()
    expect(JSON.parse(indexCall![1] as string)[0]).toMatchObject({ id: item.id, name: "old.md" })
  })

  it("writes empty content when the source cannot be read", async () => {
    resolveRead({ [INDEX]: "[]" })
    const item = await moveFileToTrash("/P", "/P/wiki/ghost.md", "file", NOW)
    expect(item.name).toBe("ghost.md")
    expect(fsState.writeFile).toHaveBeenCalledWith(`${FILES}/${item.id}.md`, "")
  })

  it("keeps the trash entry when deleting the source fails (ghost entry)", async () => {
    resolveRead({
      "/P/wiki/old.md": "content",
      [INDEX]: "[]",
    })
    fsState.deleteFile.mockRejectedValueOnce(new Error("permission denied"))
    const item = await moveFileToTrash("/P", "/P/wiki/old.md", "chapter", NOW)
    expect(item).toMatchObject({ name: "old.md", kind: "chapter" })
  })

  it("handles dotfiles (extension at position 0) and extensionless names", async () => {
    resolveRead({ [INDEX]: "[]" })
    const dot = await moveFileToTrash("/P", "/P/.env", "file", NOW)
    expect(dot.trashPath).toBe(`${FILES}/${dot.id}`)
    const plain = await moveFileToTrash("/P", "/P/plain", "file", NOW)
    expect(plain.trashPath).toBe(`${FILES}/${plain.id}`)
  })

  it("tolerates a failing index read and still records the item", async () => {
    resolveRead({ "/P/wiki/old.md": "content" }) // items.json read rejects → []
    const item = await moveFileToTrash("/P", "/P/wiki/old.md", "page", NOW)
    expect(item.kind).toBe("page")
  })
})

describe("restoreTrashItem", () => {
  it("restores to the original path when it is free", async () => {
    const item = makeItem()
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "content",
    })
    const result = await restoreTrashItem("/P", "abc123", NOW)
    expect(result.item.id).toBe("abc123")
    expect(result.restoredPath).toBe("/P/wiki/a.md")
    expect(result.renamed).toBe(false)
    expect(fsState.createDirectory).toHaveBeenCalledWith("/P/wiki")
    expect(fsState.writeFile).toHaveBeenCalledWith("/P/wiki/a.md", "content")
    expect(fsState.deleteFile).toHaveBeenCalledWith(item.trashPath)
    // index rewritten without the item
    const indexCall = fsState.writeFile.mock.calls.find((c) => c[0] === INDEX)
    expect(JSON.parse(indexCall![1] as string)).toEqual([])
  })

  it("renames with a chapter stem when the original path is taken", async () => {
    const item = makeItem({
      id: "c1",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/c1.md",
      kind: "chapter",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "---\ntitle: B\nchapter_number: 2\n---\n# body",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/a.md")
    const result = await restoreTrashItem("/P", "c1", NOW)
    expect(result.restoredPath).toBe("/P/wiki/第2章-B.md")
    expect(result.renamed).toBe(true)
    expect(fsState.writeFile).toHaveBeenCalledWith("/P/wiki/第2章-B.md", "---\ntitle: B\nchapter_number: 2\n---\n# body")
  })

  it("appends a counter until a free path is found", async () => {
    const item = makeItem({
      id: "c1",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/c1.md",
      kind: "chapter",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "---\ntitle: B\nchapter_number: 2\n---",
    })
    fsState.fileExists.mockImplementation(async (p: string) =>
      p === "/P/wiki/a.md" || p === "/P/wiki/第2章-B.md" || p === "/P/wiki/第2章-B-2.md",
    )
    const result = await restoreTrashItem("/P", "c1", NOW)
    expect(result.restoredPath).toBe("/P/wiki/第2章-B-3.md")
    expect(result.renamed).toBe(true)
  })

  it("renames outlines using a title slug (h1 fallback)", async () => {
    const item = makeItem({
      id: "o1",
      name: "out.md",
      originalPath: "/P/wiki/out.md",
      trashPath: "/P/.trash/files/o1.md",
      kind: "outline",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "# Some Title\n",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/out.md")
    const result = await restoreTrashItem("/P", "o1", NOW)
    expect(result.restoredPath).toBe("/P/wiki/Some-Title.md")
    expect(result.renamed).toBe(true)
  })

  it("renames outlines with the filename stem when no title exists", async () => {
    const item = makeItem({
      id: "o2",
      name: "out.md",
      originalPath: "/P/wiki/out.md",
      trashPath: "/P/.trash/files/o2.md",
      kind: "outline",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/out.md")
    const result = await restoreTrashItem("/P", "o2", NOW)
    expect(result.restoredPath).toBe("/P/wiki/out-2.md")
  })

  it("restores non-chapter/outline kinds with the plain stem", async () => {
    const item = makeItem({
      id: "f1",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/f1.md",
      kind: "file",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "data",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/a.md")
    const result = await restoreTrashItem("/P", "f1", NOW)
    expect(result.restoredPath).toBe("/P/wiki/a-2.md")
    expect(result.renamed).toBe(true)
  })

  it("uses the plain stem unchanged for extensionless names (stemOf fallback)", async () => {
    const item = makeItem({
      id: "f2",
      name: "data",
      originalPath: "/P/wiki/data",
      trashPath: "/P/.trash/files/f2.md",
      kind: "file",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "raw",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/data")
    const result = await restoreTrashItem("/P", "f2", NOW)
    expect(result.restoredPath).toBe("/P/wiki/data-2")
    expect(result.renamed).toBe(true)
  })

  it("falls back to the slug of the title when a chapter has no chapter_number", async () => {
    const item = makeItem({
      id: "c2",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/c2.md",
      kind: "chapter",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "---\ntitle: X\n---\n# body",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/a.md")
    const result = await restoreTrashItem("/P", "c2", NOW)
    expect(result.restoredPath).toBe("/P/wiki/X.md")
    expect(result.renamed).toBe(true)
  })

  it("ignores a non-positive chapter_number when building the conflict stem", async () => {
    const item = makeItem({
      id: "c3",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/c3.md",
      kind: "chapter",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "---\ntitle: X\nchapter_number: 0\n---",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/a.md")
    const result = await restoreTrashItem("/P", "c3", NOW)
    expect(result.restoredPath).toBe("/P/wiki/X.md")
  })

  it("ignores a non-numeric chapter_number when building the conflict stem", async () => {
    const item = makeItem({
      id: "c4",
      name: "a.md",
      originalPath: "/P/wiki/a.md",
      trashPath: "/P/.trash/files/c4.md",
      kind: "chapter",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "---\ntitle: X\nchapter_number: abc\n---",
    })
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/wiki/a.md")
    const result = await restoreTrashItem("/P", "c4", NOW)
    expect(result.restoredPath).toBe("/P/wiki/X.md")
  })

  it("skips dir creation when the target has no directory component", async () => {
    const item = makeItem({
      id: "n1",
      originalPath: "b.md",
      trashPath: "/P/.trash/files/n1.md",
    })
    resolveRead({
      [INDEX]: JSON.stringify([item]),
      [item.trashPath]: "data",
    })
    const result = await restoreTrashItem("/P", "n1", NOW)
    expect(result.restoredPath).toBe("b.md")
    // only writeItems' createDirectory(ROOT) is issued
    expect(fsState.createDirectory).toHaveBeenCalledTimes(1)
    expect(fsState.createDirectory).toHaveBeenCalledWith(ROOT)
    expect(fsState.writeFile).toHaveBeenCalledWith("b.md", "data")
  })

  it("throws when the item id does not exist", async () => {
    resolveRead({ [INDEX]: "[]" })
    await expect(restoreTrashItem("/P", "missing")).rejects.toThrow("回收站项目不存在")
  })
})

describe("cleanupExpiredTrashItems", () => {
  it("deletes expired items and keeps the rest", async () => {
    const expired = makeItem({ id: "e1", trashPath: "/P/.trash/files/e1.md", expiresAt: 100 })
    const keep = makeItem({ id: "k1", expiresAt: 300 })
    resolveRead({ [INDEX]: JSON.stringify([expired, keep]) })
    const result = await cleanupExpiredTrashItems("/P", 200)
    expect(result).toEqual({ deletedCount: 1 })
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/.trash/files/e1.md")
    const indexCall = fsState.writeFile.mock.calls.find((c) => c[0] === INDEX)
    expect(JSON.parse(indexCall![1] as string)).toEqual([keep])
  })

  it("ignores failures while deleting expired files", async () => {
    const expired = makeItem({ id: "e1", trashPath: "/P/.trash/files/e1.md", expiresAt: 100 })
    resolveRead({ [INDEX]: JSON.stringify([expired]) })
    fsState.deleteFile.mockRejectedValueOnce(new Error("gone"))
    await expect(cleanupExpiredTrashItems("/P", 200)).resolves.toEqual({ deletedCount: 1 })
  })

  it("does not rewrite the index when nothing expired", async () => {
    const keep = makeItem({ id: "k1", expiresAt: 300 })
    resolveRead({ [INDEX]: JSON.stringify([keep]) })
    await expect(cleanupExpiredTrashItems("/P", 100)).resolves.toEqual({ deletedCount: 0 })
    expect(fsState.writeFile).not.toHaveBeenCalled()
  })
})

describe("getTrashDaysRemaining", () => {
  it("ceil-rounds positive remaining days", () => {
    const item = makeItem({ expiresAt: NOW + 2.5 * DAY })
    expect(getTrashDaysRemaining(item, NOW)).toBe(3)
  })

  it("clamps negative remaining time to 0", () => {
    const item = makeItem({ expiresAt: NOW - DAY })
    expect(getTrashDaysRemaining(item, NOW)).toBe(0)
  })
})

describe("readTrashItemContent", () => {
  it("reads the trashed file content", async () => {
    resolveRead({ "/P/.trash/files/abc123.md": "hello" })
    await expect(readTrashItemContent(makeItem())).resolves.toBe("hello")
  })
})

describe("permanentlyDeleteTrashItem", () => {
  it("deletes the file and removes the entry from the index", async () => {
    const item = makeItem()
    resolveRead({ [INDEX]: JSON.stringify([item]) })
    await permanentlyDeleteTrashItem("/P", "abc123")
    expect(fsState.deleteFile).toHaveBeenCalledWith(item.trashPath)
    const indexCall = fsState.writeFile.mock.calls.find((c) => c[0] === INDEX)
    expect(JSON.parse(indexCall![1] as string)).toEqual([])
  })

  it("tolerates the file already being gone", async () => {
    const item = makeItem()
    resolveRead({ [INDEX]: JSON.stringify([item]) })
    fsState.deleteFile.mockRejectedValueOnce(new Error("ENOENT"))
    await permanentlyDeleteTrashItem("/P", "abc123")
    expect(fsState.writeFile).toHaveBeenCalledWith(INDEX, expect.any(String))
  })

  it("throws when the item id does not exist", async () => {
    resolveRead({ [INDEX]: "[]" })
    await expect(permanentlyDeleteTrashItem("/P", "missing")).rejects.toThrow("回收站项目不存在")
  })
})

describe("permanentlyDeleteAllTrashItems", () => {
  it("deletes every trashed file and returns the count", async () => {
    const a = makeItem({ id: "a1", trashPath: "/P/.trash/files/a1.md" })
    const b = makeItem({ id: "b1", trashPath: "/P/.trash/files/b1.md" })
    resolveRead({ [INDEX]: JSON.stringify([a, b]) })
    fsState.deleteFile.mockRejectedValueOnce(new Error("gone")) // one deletion fails, ignored
    await expect(permanentlyDeleteAllTrashItems("/P")).resolves.toBe(2)
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/.trash/files/a1.md")
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/.trash/files/b1.md")
    const indexCall = fsState.writeFile.mock.calls.find((c) => c[0] === INDEX)
    expect(JSON.parse(indexCall![1] as string)).toEqual([])
  })
})
