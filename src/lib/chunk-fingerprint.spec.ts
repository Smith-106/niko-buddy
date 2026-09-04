import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

import {
  ChunkFingerprintIndex,
  chunkFingerprint,
  fingerprintIndexPath,
  normalizeChunkContent,
} from "./chunk-fingerprint"

const PROJECT = "E:\\Novel"
const PP = "E:/Novel"
const FILE = `${PP}/.qmai/vector-fingerprints.json`

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.files.clear()
})

describe("chunkFingerprint", () => {
  it("returns a deterministic versioned SHA-256 fingerprint for identical content", () => {
    const a = chunkFingerprint("The quick brown fox jumps over the lazy dog")
    const b = chunkFingerprint("The quick brown fox jumps over the lazy dog")
    expect(a).toBe(b)
    // 55 号设计 W2-7: 版本位 v1: + 64-char hex
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/)
  })

  it("collapses leading/trailing whitespace (trim) to the same fingerprint", () => {
    expect(chunkFingerprint("  hello world  ")).toBe(chunkFingerprint("hello world"))
    expect(chunkFingerprint("hello world\n")).toBe(chunkFingerprint("hello world"))
  })

  it("collapses NFKC unicode forms (fullwidth → normal) to the same fingerprint", () => {
    expect(chunkFingerprint("Ｈｅｌｌｏ　Ｗｏｒｌｄ")).toBe(chunkFingerprint("Hello World"))
  })

  it("distinguishes different content", () => {
    expect(chunkFingerprint("alpha")).not.toBe(chunkFingerprint("beta"))
  })

  it("normalizeChunkContent applies NFKC then trim", () => {
    expect(normalizeChunkContent("  ＨＥＬＬＯ  ")).toBe("HELLO")
    expect(normalizeChunkContent("  alpha  \n")).toBe("alpha")
  })
})

describe("ChunkFingerprintIndex (in-memory)", () => {
  it("starts empty", () => {
    const idx = new ChunkFingerprintIndex()
    expect(idx.size).toBe(0)
    expect(idx.has("fp")).toBe(false)
  })

  it("has() reflects add() in either order", () => {
    const idx = new ChunkFingerprintIndex()
    expect(idx.has("fp1")).toBe(false)
    idx.add("fp1", "page-a")
    expect(idx.has("fp1")).toBe(true)
  })

  it("add() is idempotent for the same page", () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fp", "page-a")
    idx.add("fp", "page-a")
    expect(idx.size).toBe(1)
    expect(idx.has("fp")).toBe(true)
  })

  it("add() across distinct fingerprints grows size", () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fp1", "page-a")
    idx.add("fp2", "page-a")
    expect(idx.size).toBe(2)
  })

  it("removeByPage drops that page's fingerprints and prunes empty keys", () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fp1", "page-a")
    idx.add("fp2", "page-a")
    idx.add("fp2", "page-b")
    // fp2 still owned by page-b; fp1 fully gone
    expect(idx.removeByPage("page-a")).toBe(2)
    expect(idx.has("fp1")).toBe(false)
    expect(idx.has("fp2")).toBe(true)
    // page-b's fp2 remains
    expect(idx.removeByPage("page-b")).toBe(1)
    expect(idx.size).toBe(0)
  })

  it("removeByPage of an unknown page is a no-op (returns 0)", () => {
    const idx = new ChunkFingerprintIndex()
    expect(idx.removeByPage("ghost")).toBe(0)
  })

  it("a fingerprint owned by a different page stays visible via has()", () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("shared", "page-a")
    expect(idx.has("shared")).toBe(true)
    idx.removeByPage("page-a")
    expect(idx.has("shared")).toBe(false)
  })
})

describe("ChunkFingerprintIndex persistence round-trip", () => {
  it("load() returns empty when the store file does not exist", async () => {
    const idx = await ChunkFingerprintIndex.load(PROJECT)
    expect(idx.size).toBe(0)
  })

  it("load() degrades to empty on corrupt JSON / unreadable file", async () => {
    fsMocks.files.set(FILE, "{oops")
    const corrupt = await ChunkFingerprintIndex.load(PROJECT)
    expect(corrupt.size).toBe(0)

    fsMocks.files.clear()
    fsMocks.readFile.mockRejectedValueOnce(new Error("io error"))
    const unreadable = await ChunkFingerprintIndex.load(PROJECT)
    expect(unreadable.size).toBe(0)
  })

  it("save() then load() preserves add/remove state exactly", async () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fp1", "page-a")
    idx.add("fp2", "page-a")
    idx.add("fp2", "page-b")
    await idx.save(PROJECT)

    // On-disk shape is the expected IndexFile
    expect(fsMocks.files.get(FILE)).toContain("fp1")

    const reloaded = await ChunkFingerprintIndex.load(PROJECT)
    expect(reloaded.size).toBe(2)
    expect(reloaded.has("fp1")).toBe(true)
    expect(reloaded.has("fp2")).toBe(true)
  })

  it("save() writes through writeFileAtomic to the normalized path", async () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fp", "page")
    await idx.save(PROJECT)
    expect(fingerprintIndexPath(PROJECT)).toBe(FILE)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      FILE,
      expect.stringContaining("fp"),
    )
  })

  it("round-trips after removeByPage across a save/load boundary", async () => {
    const idx = new ChunkFingerprintIndex()
    idx.add("fpA", "page-x")
    idx.add("fpB", "page-x")
    await idx.save(PROJECT)

    idx.removeByPage("page-x")
    await idx.save(PROJECT)

    const reloaded = await ChunkFingerprintIndex.load(PROJECT)
    expect(reloaded.size).toBe(0)
    expect(reloaded.has("fpA")).toBe(false)
  })

  it("save() swallows write failures (best-effort, does not throw)", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    const idx = new ChunkFingerprintIndex()
    idx.add("fp", "page")
    await expect(idx.save(PROJECT)).resolves.toBeUndefined()
  })
})