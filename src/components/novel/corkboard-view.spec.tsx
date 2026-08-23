// @vitest-environment jsdom
/**
 * CorkboardView — 场景卡片墙（F-010）。
 * 覆盖：无项目、加载骨架、多章多场景卡片渲染（标题/摘要/字数/情绪标签）、
 * 空数据、加载失败、outline 快照过滤、字数缺失降级、情绪标签截断、dataVersion 重取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: {
    project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null,
    dataVersion: 0,
  },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const ingest = vi.hoisted(() => ({
  listSnapshots: vi.fn<(projectPath: string) => Promise<number[]>>(async () => []),
  loadSnapshot: vi.fn<(projectPath: string, n: number) => Promise<unknown>>(async () => null),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshots: ingest.listSnapshots,
  loadSnapshot: ingest.loadSnapshot,
}))

const arcs = vi.hoisted(() => ({
  loadEmotionalArcs: vi.fn<(projectPath: string) => Promise<{ beats: Array<{ character: string; chapterNumber: number; emotion: string; intensity: number; trigger: string; notes: string }> }>>(async () => ({ beats: [] })),
}))

vi.mock("@/lib/novel/emotional-arcs", () => ({
  loadEmotionalArcs: arcs.loadEmotionalArcs,
}))

// countChapterBodyWords 为纯函数，用真实实现（输入章节 markdown 控制结果）
const fs = vi.hoisted(() => ({
  listDirectory: vi.fn<(path: string) => Promise<Array<{ name: string; path: string; is_dir: boolean }>>>(async () => []),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: fs.listDirectory,
  readFile: fs.readFile,
}))

import { CorkboardView, loadCorkboardCards } from "./corkboard-view"

function snapshotRaw(chapterNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    summary: `第${chapterNumber}章摘要`,
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.dataVersion = 0
  ingest.listSnapshots.mockResolvedValue([])
  ingest.loadSnapshot.mockResolvedValue(null)
  arcs.loadEmotionalArcs.mockResolvedValue({ beats: [] })
  fs.listDirectory.mockResolvedValue([])
})

afterEach(() => cleanup())

describe("CorkboardView", () => {
  it("renders nothing when no project is open", () => {
    wiki.state.project = null
    render(<CorkboardView />)
    expect(ingest.listSnapshots).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.corkboard.title")).not.toBeInTheDocument()
  })

  it("shows the loading skeleton while fetching", async () => {
    let resolve!: (v: number[]) => void
    ingest.listSnapshots.mockImplementationOnce(() => new Promise((res) => { resolve = res }))
    render(<CorkboardView />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    resolve([1])
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("renders multi-chapter cards with title/summary/wordCount/emotions", async () => {
    ingest.listSnapshots.mockResolvedValue([1, 2])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) =>
      snapshotRaw(n, { chapterTitle: `标题${n}`, summary: `第${n}章场景摘要` }),
    )
    fs.listDirectory.mockResolvedValue([
      { name: "001.md", path: "E:/Novel/wiki/chapters/001.md", is_dir: false },
      { name: "002.md", path: "E:/Novel/wiki/chapters/002.md", is_dir: false },
    ])
    fs.readFile.mockImplementation(async (path: string) =>
      path.endsWith("001.md")
        ? "---\ntitle: 一\nchapter_number: 1\n---\n# 第一章\n\n正文内容若干。"
        : "---\ntitle: 二\nchapter_number: 2\n---\n# 第二章\n\n第二节正文。",
    )
    arcs.loadEmotionalArcs.mockResolvedValue({
      beats: [
        { character: "甲", chapterNumber: 1, emotion: "怒", intensity: 0.8, trigger: "", notes: "" },
        { character: "乙", chapterNumber: 1, emotion: "惧", intensity: 0.6, trigger: "", notes: "" },
        { character: "丙", chapterNumber: 2, emotion: "喜", intensity: 0.7, trigger: "", notes: "" },
      ],
    })

    render(<CorkboardView />)
    expect(await screen.findByText("novel.corkboard.title")).toBeInTheDocument()
    expect(ingest.listSnapshots).toHaveBeenCalledWith("E:/Novel")

    const card1 = document.querySelector('[data-corkboard-card="1"]')
    const card2 = document.querySelector('[data-corkboard-card="2"]')
    expect(card1).toBeTruthy()
    expect(card2).toBeTruthy()
    expect(card1?.textContent).toContain("标题1")
    expect(card1?.textContent).toContain("第1章场景摘要")
    expect(card2?.textContent).toContain("第2章场景摘要")
    // 字数徽标（真实 countChapterBodyWords：去 frontmatter/标题/空白后计数）
    expect(card1?.textContent).toContain("novel.corkboard.words")
    // 情绪标签容器
    expect(document.querySelector('[data-corkboard-emotions="1"]')?.textContent).toContain("怒")
    expect(document.querySelector('[data-corkboard-emotions="2"]')?.textContent).toContain("喜")
  })

  it("shows the empty state when there are no snapshots", async () => {
    render(<CorkboardView />)
    expect(await screen.findByText("novel.corkboard.noData")).toBeInTheDocument()
    expect(screen.getByText("novel.corkboard.noDataHint")).toBeInTheDocument()
  })

  it("falls back to the empty state when loading fails", async () => {
    ingest.listSnapshots.mockRejectedValue(new Error("boom"))
    render(<CorkboardView />)
    expect(await screen.findByText("novel.corkboard.noData")).toBeInTheDocument()
  })

  it("filters outline snapshots (negative numbers)", async () => {
    ingest.listSnapshots.mockResolvedValue([-1, 1])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => snapshotRaw(n))
    render(<CorkboardView />)
    await screen.findByText("novel.corkboard.title")
    expect(document.querySelector('[data-corkboard-card="-1"]')).toBeNull()
    expect(document.querySelector('[data-corkboard-card="1"]')).toBeTruthy()
    expect(ingest.loadSnapshot).toHaveBeenCalledTimes(1)
    expect(ingest.loadSnapshot).toHaveBeenCalledWith("E:/Novel", 1)
  })

  it("degrades gracefully when the chapters directory is missing (no word badge)", async () => {
    ingest.listSnapshots.mockResolvedValue([1])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => snapshotRaw(n, { chapterTitle: "有题" }))
    fs.listDirectory.mockRejectedValue(new Error("no dir"))
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="1"]')).toBeTruthy())
    expect(document.querySelector('[data-corkboard-card="1"]')?.textContent).not.toContain("novel.corkboard.words")
  })

  it("caps emotion labels at three per card", async () => {
    ingest.listSnapshots.mockResolvedValue([1])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => snapshotRaw(n))
    arcs.loadEmotionalArcs.mockResolvedValue({
      beats: ["怒", "惧", "喜", "惊"].map((emotion) => ({
        character: "甲", chapterNumber: 1, emotion, intensity: 0.5, trigger: "", notes: "",
      })),
    })
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-emotions="1"]')).toBeTruthy())
    const chips = document.querySelectorAll('[data-corkboard-emotions="1"] > span')
    expect(chips.length).toBe(3)
  })

  it("refetches when dataVersion changes", async () => {
    const { rerender } = render(<CorkboardView />)
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(1))
    wiki.state.dataVersion = 1
    rerender(<CorkboardView />)
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(2))
  })

  it("ignores a stale rejected fetch after the project changes (cancelled flag)", async () => {
    let rejectFirst!: (error: unknown) => void
    ingest.listSnapshots.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej }))
    const { rerender } = render(<CorkboardView />)
    wiki.state.project = { id: "p2", name: "Other", path: "E:/Other" }
    rerender(<CorkboardView />)
    rejectFirst(new Error("陈旧错误"))
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("陈旧错误")).not.toBeInTheDocument()
  })
})

describe("loadCorkboardCards — 派生纯逻辑", () => {
  it("sorts cards by chapter number ascending", async () => {
    ingest.listSnapshots.mockResolvedValue([3, 1, 2])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => snapshotRaw(n))
    const cards = await loadCorkboardCards("E:/Novel")
    expect(cards.map((c) => c.chapterNumber)).toEqual([1, 2, 3])
  })

  it("skips chapters whose snapshot fails to load", async () => {
    ingest.listSnapshots.mockResolvedValue([1, 2])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => (n === 1 ? null : snapshotRaw(n)))
    const cards = await loadCorkboardCards("E:/Novel")
    expect(cards.map((c) => c.chapterNumber)).toEqual([2])
  })

  it("returns an empty list when every snapshot is an outline", async () => {
    ingest.listSnapshots.mockResolvedValue([-1, -2])
    expect(await loadCorkboardCards("E:/Novel")).toEqual([])
  })
})
