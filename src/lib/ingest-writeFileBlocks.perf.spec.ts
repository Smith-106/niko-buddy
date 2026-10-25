import { beforeEach, describe, expect, it, vi } from "vitest"
import { writeFileBlocks } from "./ingest"
import type { LlmConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(),
  mergePageContent: vi.fn(),
  sanitize: vi.fn((s: string) => s),
  wikiGetState: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: mocks.readFile,
    writeFileAtomic: mocks.writeFileAtomic,
    listDirectory: vi.fn(async () => []),
  }
})

vi.mock("@/lib/ingest-sanitize", () => ({
  sanitizeIngestedFileContent: mocks.sanitize,
}))

vi.mock("@/lib/page-merge", () => ({
  mergePageContent: mocks.mergePageContent,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: { getState: mocks.wikiGetState },
  }
})

const LLM = {
  provider: "custom",
  apiKey: "k",
  model: "m",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 100_000,
} as unknown as LlmConfig

function block(path: string, body: string): string {
  return `---FILE: ${path}---\n${body}\n---END FILE---`
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.wikiGetState.mockReturnValue({ outputLanguage: "auto" })
  mocks.sanitize.mockImplementation((s: string) => s)
  // tryReadFile("") path: readFile rejects => treated as empty
  mocks.readFile.mockRejectedValue(new Error("not found"))
  mocks.mergePageContent.mockImplementation(async (incoming: string) => incoming)
})

describe("ISS-20260713-008 writeFileBlocks parallel保序", () => {
  it("out-of-order completion still backfills writtenPaths in input order", async () => {
    const text = [
      block("wiki/concepts/a.md", "# A"),
      block("wiki/concepts/b.md", "# B"),
      block("wiki/concepts/c.md", "# C"),
    ].join("\n")
    const completionOrder: string[] = []
    mocks.writeFileAtomic.mockImplementation(async (path: string) => {
      // a slow, b fast, c medium — completion order would be b,c,a if not backfilled
      if (path.endsWith("a.md")) await new Promise((r) => setTimeout(r, 30))
      else if (path.endsWith("b.md")) await new Promise((r) => setTimeout(r, 5))
      else await new Promise((r) => setTimeout(r, 10))
      completionOrder.push(path)
    })

    const { writtenPaths, hardFailures } = await writeFileBlocks("/P", text, LLM, "src.pdf")

    expect(hardFailures).toEqual([])
    // Input order preserved despite b finishing first
    expect(writtenPaths).toEqual([
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/concepts/c.md",
    ])
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(3)
    // Sanity: completion really was out of order (proves the test exercises parallelism)
    expect(completionOrder[0]).toContain("b.md")
  })

  it("hardFailures keeps failed item and preserves order of survivors", async () => {
    const text = [
      block("wiki/concepts/a.md", "# A"),
      block("wiki/concepts/b.md", "# B"),
      block("wiki/concepts/c.md", "# C"),
    ].join("\n")
    mocks.writeFileAtomic.mockImplementation(async (path: string) => {
      if (path.endsWith("b.md")) throw new Error("disk full")
    })

    const { writtenPaths, warnings, hardFailures } = await writeFileBlocks("/P", text, LLM, "src.pdf")

    expect(writtenPaths).toEqual(["wiki/concepts/a.md", "wiki/concepts/c.md"])
    expect(hardFailures).toEqual(["wiki/concepts/b.md"])
    expect(warnings.some((w) => w.includes("wiki/concepts/b.md"))).toBe(true)
  })
})
