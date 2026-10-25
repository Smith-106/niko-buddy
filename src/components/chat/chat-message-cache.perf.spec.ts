import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetCitedImageCacheForTests,
  buildCitedPageCandidates,
  extractCitedImageInfo,
  getCitedImageCacheKey,
  getOrFetchCitedImageInfo,
  readFirstExistingCandidate,
} from "./chat-message"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: mocks.readFile,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetCitedImageCacheForTests()
  mocks.readFile.mockRejectedValue(new Error("not found"))
})

describe("ISS-20260709-013 CitedReferencesPanel parallel+cache", () => {
  it("parallel probe returns first candidate in order even when later finishes first", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("first.md")) {
        await new Promise((r) => setTimeout(r, 25))
        return "# first ![a](img-1.png)"
      }
      if (path.endsWith("second.md")) {
        await new Promise((r) => setTimeout(r, 5))
        return "# second"
      }
      throw new Error("not found")
    })
    const found = await readFirstExistingCandidate(["/p/first.md", "/p/second.md", "/p/missing.md"])
    expect(found?.path).toBe("/p/first.md")
    expect(found?.index).toBe(0)
    // Parallel: every candidate was attempted, not short-circuited serially
    expect(mocks.readFile).toHaveBeenCalledTimes(3)
    expect(extractCitedImageInfo(found!.text).count).toBe(1)
  })

  it("same projectPath+path hits cache on second fetch without readFile", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/p/wiki/entities/a.md") return "# A ![x](img-x.png)"
      throw new Error("not found")
    })
    const first = await getOrFetchCitedImageInfo("/p", "wiki/entities/a.md")
    expect(first.count).toBe(1)
    const callsAfterFirst = mocks.readFile.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    mocks.readFile.mockClear()
    const second = await getOrFetchCitedImageInfo("/p", "wiki/entities/a.md")
    expect(second).toEqual(first)
    // Cache hit: no second-round readFile
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(getCitedImageCacheKey("/p", "wiki/entities/a.md")).toContain("wiki/entities/a.md")
    // Candidate builder keeps verbatim path first (serial-chain order preserved)
    expect(buildCitedPageCandidates("/p", "wiki/entities/a.md")[0]).toBe("/p/wiki/entities/a.md")
  })
})
