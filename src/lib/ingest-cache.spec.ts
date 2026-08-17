import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  checkIngestCache,
  removeFromIngestCache,
  saveIngestCache,
} from "./ingest-cache"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  fileExists: mocks.fileExists,
}))

const cachePath = "/proj/.qmai/ingest-cache.json"

const entry = (hash: string, filesWritten: string[]) => ({
  hash,
  timestamp: 123,
  filesWritten,
})

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockRejectedValue(new Error("no cache file"))
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(true)
})

// ── checkIngestCache ─────────────────────────────────────────────────────────

describe("checkIngestCache", () => {
  it("returns null when there is no cache file on disk", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await checkIngestCache("/proj", "a.pdf", "content")).toBeNull()
  })

  it("returns null when the cache file is corrupt", async () => {
    mocks.readFile.mockResolvedValue("not json {{")
    expect(await checkIngestCache("/proj", "a.pdf", "content")).toBeNull()
  })

  it("returns null when the source file has no cache entry", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    expect(await checkIngestCache("/proj", "a.pdf", "content")).toBeNull()
  })

  it("returns null when the hash does not match the current content", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ entries: { "a.pdf": entry("deadbeef", ["wiki/a.md"]) } }),
    )
    expect(await checkIngestCache("/proj", "a.pdf", "different content")).toBeNull()
  })

  it("returns the previously written files on a full hit (relative paths)", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ entries: { "a.pdf": entry(await sha256("content"), ["wiki/a.md"]) } }),
    )
    const hit = await checkIngestCache("/proj", "a.pdf", "content")
    expect(hit).toEqual(["wiki/a.md"])
    expect(mocks.fileExists).toHaveBeenCalledWith("/proj/wiki/a.md")
  })

  it("resolves absolute written paths against the filesystem directly", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        entries: { "a.pdf": entry(await sha256("content"), ["/abs/wiki/a.md"]) },
      }),
    )
    const hit = await checkIngestCache("/proj", "a.pdf", "content")
    expect(hit).toEqual(["/abs/wiki/a.md"])
    expect(mocks.fileExists).toHaveBeenCalledWith("/abs/wiki/a.md")
  })

  it("returns null (cache miss) when a previously written file is gone", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ entries: { "a.pdf": entry(await sha256("content"), ["wiki/a.md"]) } }),
    )
    expect(await checkIngestCache("/proj", "a.pdf", "content")).toBeNull()
  })

  it("returns null when the existence check itself fails", async () => {
    mocks.fileExists.mockRejectedValue(new Error("lancedb/fs error"))
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        entries: {
          "a.pdf": entry(await sha256("content"), ["wiki/a.md", "wiki/b.md"]),
        },
      }),
    )
    expect(await checkIngestCache("/proj", "a.pdf", "content")).toBeNull()
  })
})

// ── saveIngestCache ──────────────────────────────────────────────────────────

describe("saveIngestCache", () => {
  it("writes the hash entry keyed by source filename", async () => {
    await saveIngestCache("/proj", "a.pdf", "content", ["wiki/a.md"])
    expect(mocks.writeFile).toHaveBeenCalledWith(
      cachePath,
      expect.any(String),
    )
    const saved = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(saved.entries["a.pdf"].hash).toBe(await sha256("content"))
    expect(saved.entries["a.pdf"].filesWritten).toEqual(["wiki/a.md"])
    expect(typeof saved.entries["a.pdf"].timestamp).toBe("number")
  })

  it("merges with existing entries instead of dropping them", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ entries: { "old.pdf": entry("oldhash", ["wiki/old.md"]) } }),
    )
    await saveIngestCache("/proj", "new.pdf", "new content", ["wiki/new.md"])
    const saved = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(saved.entries["old.pdf"].hash).toBe("oldhash")
    expect(saved.entries["new.pdf"].hash).toBe(await sha256("new content"))
  })

  it("overwrites the entry for an already-cached source", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ entries: { "a.pdf": entry("oldhash", ["wiki/a.md"]) } }),
    )
    await saveIngestCache("/proj", "a.pdf", "newer content", ["wiki/a.md"])
    const saved = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(saved.entries["a.pdf"].hash).toBe(await sha256("newer content"))
    expect(saved.entries["a.pdf"].filesWritten).toEqual(["wiki/a.md"])
  })

  it("survives a failed save (non-critical)", async () => {
    mocks.writeFile.mockRejectedValue(new Error("disk full"))
    await expect(saveIngestCache("/proj", "a.pdf", "content", ["wiki/a.md"])).resolves.toBeUndefined()
  })

  it("still writes when the cache file is missing or corrupt", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await saveIngestCache("/proj", "a.pdf", "content", ["wiki/a.md"])
    expect(mocks.writeFile).toHaveBeenCalled()
  })
})

// ── removeFromIngestCache ────────────────────────────────────────────────────

describe("removeFromIngestCache", () => {
  it("removes only the named entry", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        entries: {
          "a.pdf": entry("h1", ["wiki/a.md"]),
          "b.pdf": entry("h2", ["wiki/b.md"]),
        },
      }),
    )
    await removeFromIngestCache("/proj", "a.pdf")
    const saved = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(saved.entries["a.pdf"]).toBeUndefined()
    expect(saved.entries["b.pdf"].hash).toBe("h2")
  })

  it("is a no-op for a source that is not cached", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    await removeFromIngestCache("/proj", "missing.pdf")
    const saved = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(saved.entries).toEqual({})
  })

  it("survives a missing cache file", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await expect(removeFromIngestCache("/proj", "a.pdf")).resolves.toBeUndefined()
    expect(mocks.writeFile).toHaveBeenCalled()
  })
})
