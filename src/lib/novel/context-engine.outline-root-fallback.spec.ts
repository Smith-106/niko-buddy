/**
 * M1: project-root Chapter-N-Outline-FILLED.md is readable when wiki/outlines is empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync, existsSync } from "node:fs"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (path: string): Promise<string> => {
    if (existsSync(path)) return readFileSync(path, "utf8")
    throw new Error(`ENOENT ${path}`)
  }),
  listDirectory: vi.fn(async (path: string) => {
    // Simulate missing wiki/outlines
    if (String(path).includes("wiki")) {
      throw new Error("ENOENT wiki")
    }
    return []
  }),
  getFileModifiedTime: vi.fn(async () => Date.now()),
  fileExists: vi.fn(async (path: string) => existsSync(path)),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  listDirectory: fsMocks.listDirectory,
  getFileModifiedTime: fsMocks.getFileModifiedTime,
  fileExists: fsMocks.fileExists,
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(async () => []),
  tokenizeQuery: (q: string) => q.split(/\s+/),
}))

describe("M1 readChapterOutlineContent project-root FILLED fallback", () => {
  beforeEach(() => {
    fsMocks.readFile.mockClear()
    fsMocks.listDirectory.mockClear()
  })

  it("loads Chapter-4-Outline-FILLED.md from project root when wiki missing", async () => {
    const project = process.env.M1_TEST_PROJECT || "E:/写作/8人"
    if (!existsSync(`${project}/Chapter-4-Outline-FILLED.md`)) {
      // skip when manuscript not mounted
      return
    }
    const { readChapterOutlineContent } = await import("./context-engine")
    const text = await readChapterOutlineContent(project, 4)
    expect(text.length).toBeGreaterThan(200)
    expect(text).toMatch(/Continuity|第四章|Chapter 4|Outline/i)
  })
})
