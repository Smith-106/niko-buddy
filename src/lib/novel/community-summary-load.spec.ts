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

  it("caps records at maxRecords and breaks the loop", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `${i + 1}.json`,
      path: `/p/.novel/community-summaries/${i + 1}.json`,
      is_dir: false,
    }))
    listDirectory.mockResolvedValue(files)
    readFile.mockImplementation(async (path: string) =>
      JSON.stringify({ communityId: Number(String(path).match(/(\d+)\.json$/)?.[1]), summary: `摘要${String(path).match(/(\d+)\.json$/)?.[1]}`, nodeCount: 1, topNodes: ["X"], generatedAt: "2026-08-10" }),
    )
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { records } = await loadPersistedCommunitySummaries("/p", { maxRecords: 2, maxChars: 2000 })
    expect(records.length).toBe(2)
    expect(records[0].summary).toBe("摘要1")
  })

  it("uses defaults when options omitted", async () => {
    listDirectory.mockResolvedValue([
      { name: "1.json", path: "/p/.novel/community-summaries/1.json", is_dir: false },
    ])
    readFile.mockResolvedValue(JSON.stringify({ communityId: 1, summary: "默认参数摘要", nodeCount: 3, topNodes: ["甲"], generatedAt: "2026-08-10" }))
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { records } = await loadPersistedCommunitySummaries("/p")
    expect(records.length).toBe(1)
  })

  it("truncates lines to maxChars and sorts by nodeCount desc", async () => {
    listDirectory.mockResolvedValue([
      { name: "1.json", path: "/p/.novel/community-summaries/1.json", is_dir: false },
      { name: "2.json", path: "/p/.novel/community-summaries/2.json", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("1.json")) {
        return JSON.stringify({ communityId: 1, summary: "小", nodeCount: 1, topNodes: ["甲"], generatedAt: "2026-08-10" })
      }
      return JSON.stringify({ communityId: 2, summary: "很长的摘要内容".repeat(60), nodeCount: 9, topNodes: ["乙"], generatedAt: "2026-08-10" })
    })
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { text, records } = await loadPersistedCommunitySummaries("/p", { maxRecords: 2, maxChars: 220 })
    // 大社区优先
    expect(records[0].communityId).toBe(2)
    // 超长被截断并加省略号
    expect(text).toContain("…")
  })

  it("truncation with tiny maxChars stops without pushing a line", async () => {
    listDirectory.mockResolvedValue([
      { name: "1.json", path: "/p/.novel/community-summaries/1.json", is_dir: false },
      { name: "2.json", path: "/p/.novel/community-summaries/2.json", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("1.json")) {
        // 先排前面的记录（nodeCount 更大）消耗掉大部分预算
        return JSON.stringify({ communityId: 1, summary: "消耗预算内容".repeat(20), nodeCount: 9, topNodes: ["甲"], generatedAt: "2026-08-10" })
      }
      return JSON.stringify({ communityId: 2, summary: "很长的摘要内容".repeat(60), nodeCount: 1, topNodes: ["乙"], generatedAt: "2026-08-10" })
    })
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { text } = await loadPersistedCommunitySummaries("/p", { maxRecords: 2, maxChars: 200 })
    // 第二条剩余空间不足（room <= 80）→ 不追加省略号行，直接 break
    expect(text).not.toContain("…")
    expect(text).toContain("消耗预算内容")
  })

  it("handles records missing nodeCount / topNodes fields", async () => {
    listDirectory.mockResolvedValue([
      { name: "a.json", path: "/p/.novel/community-summaries/a.json", is_dir: false },
      { name: "b.json", path: "/p/.novel/community-summaries/b.json", is_dir: false },
      { name: "c.json", path: "/p/.novel/community-summaries/c.json", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("a.json")) {
        return JSON.stringify({ communityId: 1, summary: "缺字段记录", generatedAt: "2026-08-10" })
      }
      if (String(path).endsWith("b.json")) {
        return JSON.stringify({ communityId: 2, summary: "完整记录", nodeCount: 3, topNodes: ["丙"], generatedAt: "2026-08-10" })
      }
      return JSON.stringify({ communityId: 3, summary: "另一完整记录", nodeCount: 5, topNodes: ["丁"], generatedAt: "2026-08-10" })
    })
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { text, records } = await loadPersistedCommunitySummaries("/p")
    expect(records.length).toBe(3)
    expect(text).toContain("缺字段记录")
    expect(text).toContain("完整记录")
  })

  it("sorts records missing nodeCount on both comparator sides", async () => {
    listDirectory.mockResolvedValue([
      { name: "a.json", path: "/p/.novel/community-summaries/a.json", is_dir: false },
      { name: "b.json", path: "/p/.novel/community-summaries/b.json", is_dir: false },
      { name: "c.json", path: "/p/.novel/community-summaries/c.json", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => {
      const base = String(path).split("/").pop() ?? ""
      const id = base === "a.json" ? 1 : base === "b.json" ? 2 : 3
      return JSON.stringify({ communityId: id, summary: `无权重摘要${id}`, topNodes: ["缺"], generatedAt: "2026-08-10" })
    })
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { records } = await loadPersistedCommunitySummaries("/p")
    expect(records.length).toBe(3)
    expect(records.map(r => r.communityId).sort((x, y) => x - y)).toEqual([1, 2, 3])
  })

  it("skips bad files and records with empty summaries", async () => {
    listDirectory.mockResolvedValue([
      { name: "bad.json", path: "/p/.novel/community-summaries/bad.json", is_dir: false },
      { name: "empty.json", path: "/p/.novel/community-summaries/empty.json", is_dir: false },
      { name: "good.json", path: "/p/.novel/community-summaries/good.json", is_dir: false },
      { name: "dir", path: "/p/.novel/community-summaries/dir", is_dir: true },
    ])
    readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("bad.json")) throw new Error("corrupt")
      if (String(path).endsWith("empty.json")) return JSON.stringify({ communityId: 3, summary: "   ", nodeCount: 1, topNodes: [], generatedAt: "x" })
      return JSON.stringify({ communityId: 9, summary: "有效摘要", nodeCount: 4, topNodes: ["丙"], generatedAt: "2026-08-10" })
    })
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const { records, text } = await loadPersistedCommunitySummaries("/p")
    expect(records.length).toBe(1)
    expect(records[0].communityId).toBe(9)
    expect(text).toContain("有效摘要")
  })
})
