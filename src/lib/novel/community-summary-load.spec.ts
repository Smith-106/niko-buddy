import { describe, expect, it, vi, beforeEach } from "vitest"

const listDirectory = vi.fn()
const readFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      embeddingConfig: { enabled: false, model: "" },
      novelConfig: { communitySummaryEnabled: true, communitySummaryInterval: 5 },
    }),
  },
}))

describe("loadPersistedCommunitySummaries", () => {
  beforeEach(() => {
    listDirectory.mockReset()
    readFile.mockReset()
  })

  it("loads and caps community summary text", async () => {
    listDirectory.mockResolvedValue([
      { name: "1.json", path: "/p/.novel/community-summaries/1.json", is_dir: false },
      { name: "2.json", path: "/p/.novel/community-summaries/2.json", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("1.json")) {
        return JSON.stringify({
          communityId: 1,
          summary: "阵营甲与终面密室相关。",
          nodeCount: 5,
          topNodes: ["白砚", "矩阵"],
          generatedAt: "2026-08-10",
        })
      }
      return JSON.stringify({
        communityId: 2,
        summary: "次要社区。",
        nodeCount: 2,
        topNodes: ["配角"],
        generatedAt: "2026-08-10",
      })
    })

    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { text, records } = await loadPersistedCommunitySummaries("/p", {
      maxRecords: 6,
      maxChars: 2000,
    })
    expect(records.length).toBe(2)
    expect(text).toContain("社区")
    expect(text).toContain("白砚")
  })

  it("returns empty on missing dir", async () => {
    listDirectory.mockRejectedValue(new Error("enoent"))
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { text, records } = await loadPersistedCommunitySummaries("/missing")
    expect(text).toBe("")
    expect(records).toEqual([])
  })
})
