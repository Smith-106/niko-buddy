import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  normalizePath: vi.fn((p: string) => p),
  listSnapshots: vi.fn(),
  loadSnapshot: vi.fn(),
  snapshotMarkdownPath: vi.fn((_pp: string, chapterNumber: number) => `/pp/snapshots/${chapterNumber}.snapshot.json`),
  loadDismantlingLibrary: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => mocks.normalizePath(p),
}))

vi.mock("./chapter-ingest", () => ({
  listSnapshots: (...args: Parameters<typeof mocks.listSnapshots>) => mocks.listSnapshots(...args),
  loadSnapshot: (...args: Parameters<typeof mocks.loadSnapshot>) => mocks.loadSnapshot(...args),
  snapshotMarkdownPath: (...args: Parameters<typeof mocks.snapshotMarkdownPath>) => mocks.snapshotMarkdownPath(...args),
}))

vi.mock("./dismantling", () => ({
  loadDismantlingLibrary: (...args: unknown[]) => mocks.loadDismantlingLibrary(...args),
}))

import {
  buildMemoryCenterSnapshotCards,
  buildMemoryCenterStats,
  loadMemoryCenterData,
  parseMemoryMarkdownPreview,
} from "./memory-center"
import type { ChapterSnapshot } from "./chapter-ingest"

function snapshot(overrides: Partial<ChapterSnapshot> & { chapterNumber: number }): ChapterSnapshot {
  return {
    chapterId: `ch-${overrides.chapterNumber}`,
    chapterTitle: `第${overrides.chapterNumber}章`,
    summary: "摘要",
    endingHook: "钩子",
    characterStateChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    timelineEvents: [],
    newCanonFacts: [],
    conflicts: [],
    memorySyncedAt: undefined,
    characters: [],
    ...overrides,
  } as ChapterSnapshot
}

describe("parseMemoryMarkdownPreview", () => {
  it("parses sections, groups and items, stripping frontmatter", () => {
    const md = [
      "---",
      "type: structured-memory",
      "memory_type: timeline",
      "---",
      "",
      "# 时间线记忆",
      "",
      "## 已发生事件",
      "- 事件一",
      "- 事件二",
      "",
      "### 人物状态",
      "- 林晚：冷静",
      "- 阿宁：警戒",
      "",
      "### 伏笔",
      "- 锈钥匙",
      "",
      "## 候选区",
      "- 候选一",
      "",
    ].join("\n")

    const sections = parseMemoryMarkdownPreview(md)
    expect(sections).toHaveLength(2)
    expect(sections[0]!.title).toBe("已发生事件")
    expect(sections[0]!.items).toEqual(["事件一", "事件二"])
    expect(sections[0]!.groups).toHaveLength(2)
    expect(sections[0]!.groups[0]!.title).toBe("人物状态")
    expect(sections[0]!.groups[0]!.items).toEqual(["林晚：冷静", "阿宁：警戒"])
    expect(sections[1]!.title).toBe("候选区")
  })

  it("keeps top-level items in overview section when no ## header exists", () => {
    const sections = parseMemoryMarkdownPreview("---\ntype: x\n---\n\n# T\n\n### 分组\n- 项1\n\n- 顶层项")
    expect(sections[0]!.title).toBe("概览")
    expect(sections[0]!.groups[0]!.title).toBe("分组")
    // open group still collects trailing items into the group
    expect(sections[0]!.groups[0]!.items).toEqual(["项1", "顶层项"])
  })

  it("respects maxSections/maxGroupsPerSection/maxItemsPerGroup and skips blank/heading lines", () => {
    const md = [
      "# H",
      "普通段落",
      "",
      "## A",
      "- 1",
      "- 2",
      "- 3",
      "- 4",
      "### G1",
      "- g1a",
      "- g1b",
      "- g1c",
      "- g1d",
      "### G2",
      "- g2a",
      "## B",
      "- b1",
      "## C",
      "- c1",
    ].join("\n")
    const sections = parseMemoryMarkdownPreview(md, 2, 1, 2)
    expect(sections).toHaveLength(2)
    expect(sections[0]!.items).toEqual(["1", "2"])
    expect(sections[0]!.groups).toHaveLength(1)
    expect(sections[0]!.groups[0]!.items).toEqual(["g1a", "g1b"])
  })

  it("drops empty groups and items, handles BOM and no-frontmatter", () => {
    const md = "\uFEFF# T\n\n### 空组\n\n## 有效\n- 项"
    const sections = parseMemoryMarkdownPreview(md)
    // 空组 section (概览) is kept because its group title is non-empty
    expect(sections[0]!.title).toBe("概览")
    expect(sections[1]!.title).toBe("有效")
    expect(sections[1]!.items).toEqual(["项"])
  })

  it("does not split frontmatter when first line is not ---", () => {
    const md = "no frontmatter\n\n## S\n- 项"
    const sections = parseMemoryMarkdownPreview(md)
    expect(sections[0]!.title).toBe("S")
  })

  it("does not strip frontmatter when only opening marker exists", () => {
    const md = "---\nnever closed\n## S\n- 项"
    const sections = parseMemoryMarkdownPreview(md)
    // opening --- is not treated as frontmatter (no closing marker)
    expect(sections[0]!.title).toBe("S")
  })

  it("treats a ---- first line as non-frontmatter (startsWith --- but not exactly ---)", () => {
    const md = "----\n## S\n- 项"
    const sections = parseMemoryMarkdownPreview(md)
    expect(sections[0]!.title).toBe("S")
  })

  it("skips empty bullet items (line '- ' only)", () => {
    // "- " 单独一行 trim 后为 "-"，不匹配 "- " 前缀，直接跳过
    const md = "## S\n- \n- 有效项"
    const sections = parseMemoryMarkdownPreview(md)
    expect(sections[0]!.items).toEqual(["有效项"])
  })
})

describe("buildMemoryCenterSnapshotCards", () => {
  it("sorts newest first, trims lists and reports hasMore", () => {
    const cards = buildMemoryCenterSnapshotCards(
      [
        snapshot({
          chapterNumber: 1,
          characterStateChanges: ["a", "b", "c", "d"],
          knowledgeChanges: ["k"],
          foreshadowingChanges: [],
          timelineEvents: ["t1", "t2"],
          memorySyncedAt: "2026-01-01T00:00:00Z",
        }),
        snapshot({ chapterNumber: 2 }),
      ],
      6,
      3,
    )
    expect(cards.map((c) => c.chapterNumber)).toEqual([2, 1])
    expect(cards[1]!.memorySynced).toBe(true)
    expect(cards[1]!.characterStateChanges).toEqual(["a", "b", "c"])
    expect(cards[1]!.hasMoreCharacterStateChanges).toBe(true)
    expect(cards[1]!.knowledgeChanges).toEqual(["k"])
    expect(cards[1]!.hasMoreKnowledgeChanges).toBe(false)
    expect(cards[1]!.timelineEvents).toEqual(["t1", "t2"])
    expect(cards[0]!.snapshotPath).toContain("2.snapshot.json")
  })
})

describe("buildMemoryCenterStats", () => {
  const files = [
    { key: "character-states", title: "cs", path: "p", sections: [{ title: "s", groups: [{ title: "g1", items: [] }, { title: "g2", items: [] }], items: [] }] },
    {
      key: "foreshadowing-tracker",
      title: "ft",
      path: "p2",
      sections: [
        { title: "进行中", groups: [{ title: "g3", items: [] }, { title: "g4", items: [] }], items: [] },
        { title: "已完成", groups: [], items: [] },
      ],
    },
  ] as unknown as Parameters<typeof buildMemoryCenterStats>[1]

  it("computes snapshot/character/foreshadowing/memory counts", () => {
    const cards = [
      { chapterNumber: 1, memorySynced: true } as never,
      { chapterNumber: 2, memorySynced: false } as never,
    ] as never
    const stats = buildMemoryCenterStats(cards, files)
    expect(stats.snapshotCount).toBe(2)
    expect(stats.syncedSnapshotCount).toBe(1)
    expect(stats.characterCount).toBe(2)
    expect(stats.activeForeshadowingCount).toBe(2)
    expect(stats.memoryFileCount).toBe(2)
  })

  it("falls back to first section when no active section title matches", () => {
    const fallbackFiles = [
      {
        key: "foreshadowing-tracker",
        title: "ft",
        path: "p2",
        sections: [{ title: "伏笔清单", groups: [{ title: "g", items: [] }], items: [] }],
      },
    ] as unknown as Parameters<typeof buildMemoryCenterStats>[1]
    const stats = buildMemoryCenterStats([], fallbackFiles)
    expect(stats.activeForeshadowingCount).toBe(1)
  })

  it("returns zeros for missing character file", () => {
    const stats = buildMemoryCenterStats([], [])
    expect(stats.characterCount).toBe(0)
    expect(stats.activeForeshadowingCount).toBe(0)
  })
})

describe("loadMemoryCenterData", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.loadDismantlingLibrary.mockReset()
    mocks.listSnapshots.mockReset()
    mocks.loadSnapshot.mockReset()
    mocks.readFile.mockResolvedValue("---\ntype: structured-memory\n---\n\n## 进行中\n### 锈钥匙\n- 说明")
    mocks.loadDismantlingLibrary.mockResolvedValue({
      version: 1,
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          title: "拆解项目",
          chapters: [{}, {}],
          analyses: [{}],
          structureMemory: ["s1", "s2", "s3", "s4", "s5", "s6"],
          useInChat: true,
        },
      ],
    })
  })

  it("loads snapshots, files and dismantling projects", async () => {
    mocks.listSnapshots.mockResolvedValue([1, 2])
    mocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) =>
      n === 1 ? snapshot({ chapterNumber: 1 }) : null,
    )

    const data = await loadMemoryCenterData("E:/Novel")
    expect(data.stats.snapshotCount).toBe(1)
    expect(data.snapshots).toHaveLength(1)
    expect(data.files.length).toBeGreaterThan(0)
    expect(data.dismantlingProjects).toEqual([
      {
        id: "p1",
        title: "拆解项目",
        chapterCount: 2,
        analysisCount: 1,
        structureMemoryCount: 6,
        useInChat: true,
        structureMemory: ["s1", "s2", "s3", "s4", "s5"],
      },
    ])
  })

  it("tolerates read failures on memory files (null entries filtered)", async () => {
    mocks.listSnapshots.mockResolvedValue([])
    mocks.readFile.mockRejectedValue(new Error("missing"))
    const data = await loadMemoryCenterData("E:/Novel")
    expect(data.files).toEqual([])
    expect(data.stats.memoryFileCount).toBe(0)
  })

  it("degrades dismantling library failure to empty", async () => {
    mocks.listSnapshots.mockResolvedValue([])
    mocks.loadDismantlingLibrary.mockRejectedValue(new Error("boom"))
    const data = await loadMemoryCenterData("E:/Novel")
    expect(data.dismantlingProjects).toEqual([])
  })
})
