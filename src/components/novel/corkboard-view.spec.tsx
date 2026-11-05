// @vitest-environment jsdom
/**
 * CorkboardView — 场景卡片墙（F-010）。
 * 覆盖：无项目、加载骨架、多章多场景卡片渲染（标题/摘要/字数/情绪标签）、
 * 空数据、加载失败、outline 快照过滤、字数缺失降级、情绪标签截断、dataVersion 重取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

// W-覆盖增补缝：被测组件只读之外的写入/选择函数（既有用例从未调用，增补时保持默认空实现）
const extraMocks = vi.hoisted(() => ({
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
  deleteFile: vi.fn<(path: string) => Promise<void>>(async () => {}),
  setSelectedFile: vi.fn<(path: string) => void>(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: {
    project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null,
    dataVersion: 0,
    setSelectedFile: extraMocks.setSelectedFile,
  },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
    
  }
})

const ingest = vi.hoisted(() => ({
  listSnapshots: vi.fn<(projectPath: string) => Promise<number[]>>(async () => []),
  loadSnapshot: vi.fn<(projectPath: string, n: number) => Promise<unknown>>(async () => null),
}))

vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual,
      listSnapshots: ingest.listSnapshots,
      loadSnapshot: ingest.loadSnapshot,
    
  }
})

const arcs = vi.hoisted(() => ({
  loadEmotionalArcs: vi.fn<(projectPath: string) => Promise<{ beats: Array<{ character: string; chapterNumber: number; emotion: string; intensity: number; trigger: string; notes: string }> }>>(async () => ({ beats: [] })),
}))

vi.mock("@/lib/novel/emotional-arcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/emotional-arcs")>()
  return {
    ...actual,
      loadEmotionalArcs: arcs.loadEmotionalArcs,
    
  }
})

// countChapterBodyWords 为纯函数，用真实实现（输入章节 markdown 控制结果）
const fs = vi.hoisted(() => ({
  listDirectory: vi.fn<(path: string) => Promise<Array<{ name: string; path: string; is_dir: boolean }>>>(async () => []),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      listDirectory: fs.listDirectory,
      readFile: fs.readFile,
      writeFileAtomic: extraMocks.writeFileAtomic,
      deleteFile: extraMocks.deleteFile,
    
  }
})

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

  it("renders draft-only chapters (no snapshot) as cards so they can be opened/deleted", async () => {
    // chapter-001-draft.md 未 ingest（无 snapshot）→ 仍应出卡片。
    ingest.listSnapshots.mockResolvedValue([15])
    ingest.loadSnapshot.mockImplementation(async (_pp, n) => snapshotRaw(n, { chapterTitle: "仓库激战" }))
    fs.listDirectory.mockResolvedValue([
      { name: "chapter-001-draft.md", path: "E:/Novel/wiki/chapters/chapter-001-draft.md", is_dir: false },
      { name: "chapter-015.md", path: "E:/Novel/wiki/chapters/chapter-015.md", is_dir: false },
    ])
    fs.readFile.mockImplementation(async (path: string) =>
      path.includes("001-draft")
        ? "---\ntitle: \"第1章 draft\"\nchapter_number: 1\n---\n# 第1章 draft\n\n草稿正文。"
        : "---\nchapter_number: '15'\ntitle: 第15章 仓库激战\n---\n# 第15章\n\n正文。",
    )
    render(<CorkboardView />)
    await screen.findByText("novel.corkboard.title")
    // draft 章（无快照）也出卡片 → 可删除
    expect(document.querySelector('[data-corkboard-card="1"]')).toBeTruthy()
    // 带引号 '15' 的 frontmatter 也能归并到同一卡片（不重复出 15）
    expect(document.querySelectorAll('[data-corkboard-card="15"]').length).toBe(1)
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



describe("CorkboardView 覆盖增补（W-未覆盖分支：新建/删除/打开/文件卡片容错）", () => {
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  function chaptersOf(projectPath: string, files: Array<{ name: string; content: string }>) {
    fs.listDirectory.mockImplementation(async (path: string) => {
      if (path === `${projectPath}/wiki/chapters`) {
        return files.map((f) => ({ name: f.name, path: `${projectPath}/wiki/chapters/${f.name}`, is_dir: false }))
      }
      return []
    })
    const byName = new Map(files.map((f) => [`${projectPath}/wiki/chapters/${f.name}`, f.content]))
    fs.readFile.mockImplementation(async (path: string) => {
      const found = byName.get(path)
      if (found === undefined) throw new Error(`ENOENT ${path}`)
      return found
    })
  }

  it("新建场景卡片成功 → 落盘 chapter-001 + 提示已创建 + 刷新列表", async () => {
    const pp = "E:/CBCreate"
    wiki.state.project = { id: "c1", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([1])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: `标题${n}` }))
    chaptersOf(pp, [])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="1"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/createScene/))
    await waitFor(() =>
      expect(extraMocks.writeFileAtomic).toHaveBeenCalledWith(
        `${pp}/wiki/chapters/chapter-001.md`,
        expect.stringContaining("chapter_number: 1"),
      ),
    )
    expect(screen.getByText(/novel\.corkboard\.created/)).toBeInTheDocument()
    // 刷新触发第二次快照拉取
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(2))
  })

  it("新建场景卡片落盘失败 → 提示创建失败且不刷新", async () => {
    const pp = "E:/CBCreateFail"
    wiki.state.project = { id: "c2", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([])
    chaptersOf(pp, [])
    extraMocks.writeFileAtomic.mockRejectedValueOnce(new Error("EACCES"))
    render(<CorkboardView />)
    expect(await screen.findByText("novel.corkboard.noData")).toBeInTheDocument()

    fireEvent.click(screen.getAllByText(/createScene/)[1])
    await waitFor(() => expect(screen.getByText(/novel\.corkboard\.createFailed/)).toBeInTheDocument())
    expect(ingest.listSnapshots).toHaveBeenCalledTimes(1)
  })

  it("空态按钮同样可新建（覆盖空态 onClick 箭头）", async () => {
    const pp = "E:/CBEmptyCreate"
    wiki.state.project = { id: "c3", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([])
    chaptersOf(pp, [])
    render(<CorkboardView />)
    expect(await screen.findByText("novel.corkboard.noData")).toBeInTheDocument()

    fireEvent.click(screen.getAllByText(/createScene/)[1])
    await waitFor(() =>
      expect(extraMocks.writeFileAtomic).toHaveBeenCalledWith(
        `${pp}/wiki/chapters/chapter-001.md`,
        expect.stringContaining("chapter_number: 1"),
      ),
    )
  })

  it("删除流程：悬停删除 → 确认 → 文件删除 + 提示已删除 + 刷新", async () => {
    const pp = "E:/CBDel"
    wiki.state.project = { id: "c4", name: "C", path: pp }
    const chapterPath = `${pp}/wiki/chapters/chapter-005.md`
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [
      { name: "chapter-005.md", content: "---\ntitle: 决战\nchapter_number: 5\n---\n# 决战\n\n正文。" },
    ])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/deleteChapter/))
    expect(screen.getByTitle(/confirmDelete/)).toBeInTheDocument()
    fireEvent.click(screen.getByTitle(/confirmDelete/))
    await waitFor(() => expect(extraMocks.deleteFile).toHaveBeenCalledWith(chapterPath))
    expect(screen.getByText(/novel\.corkboard\.deleted/)).toBeInTheDocument()
    // pendingDelete 复位：确认按钮消失，删除按钮恢复
    await waitFor(() => expect(screen.queryByTitle(/confirmDelete/)).toBeNull())
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(2))
  })

  it("删除流程：取消后不删除文件", async () => {
    const pp = "E:/CBCancel"
    wiki.state.project = { id: "c5", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [
      { name: "chapter-005.md", content: "---\ntitle: 决战\nchapter_number: 5\n---\n# 决战\n\n正文。" },
    ])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/deleteChapter/))
    fireEvent.click(screen.getByTitle(/cancelDelete/))
    expect(screen.queryByTitle(/confirmDelete/)).toBeNull()
    expect(extraMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("删除流程：章节文件不存在 → 提示未找到且不删文件", async () => {
    const pp = "E:/CBDelNF"
    wiki.state.project = { id: "c6", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/deleteChapter/))
    fireEvent.click(screen.getByTitle(/confirmDelete/))
    await waitFor(() => expect(screen.getByText(/novel\.corkboard\.chapterNotFound/)).toBeInTheDocument())
    expect(extraMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("删除流程：删除失败 → 提示删除失败", async () => {
    const pp = "E:/CBDelFail"
    wiki.state.project = { id: "c7", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [
      { name: "chapter-005.md", content: "---\ntitle: 决战\nchapter_number: 5\n---\n# 决战\n\n正文。" },
    ])
    extraMocks.deleteFile.mockRejectedValueOnce(new Error("EACCES"))
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/deleteChapter/))
    fireEvent.click(screen.getByTitle(/confirmDelete/))
    await waitFor(() => expect(screen.getByText(/novel\.corkboard\.deleteFailed/)).toBeInTheDocument())
  })

  it("打开章节：找到文件 → 选中文件", async () => {
    const pp = "E:/CBOpen"
    wiki.state.project = { id: "c8", name: "C", path: pp }
    const chapterPath = `${pp}/wiki/chapters/chapter-005.md`
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [
      { name: "chapter-005.md", content: "---\ntitle: 决战\nchapter_number: 5\n---\n# 决战\n\n正文。" },
    ])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/openChapter/))
    await waitFor(() => expect(extraMocks.setSelectedFile).toHaveBeenCalledWith(chapterPath))
  })

  it("打开章节：文件缺失 → 不选中任何文件", async () => {
    const pp = "E:/CBOpenMiss"
    wiki.state.project = { id: "c9", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([5])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n, { chapterTitle: "决战" }))
    chaptersOf(pp, [])
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="5"]')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/openChapter/))
    await waitFor(() => expect(ingest.listSnapshots).toHaveBeenCalledTimes(1))
    expect(extraMocks.setSelectedFile).not.toHaveBeenCalled()
  })

  it("文件卡片容错：无编号零编号与单文件读取失败被跳过，数字文件名回退生效", async () => {
    const pp = "E:/CBEdge"
    wiki.state.project = { id: "c10", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([1])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n))
    fs.listDirectory.mockImplementation(async (path: string) => {
      if (path === `${pp}/wiki/chapters`) {
        return ["001.md", "002.md", "bad.md", "zero.md", "boom.md"].map((name) => ({
          name,
          path: `${pp}/wiki/chapters/${name}`,
          is_dir: false,
        }))
      }
      return []
    })
    fs.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("boom.md")) throw new Error("EACCES boom.md")
      if (path.endsWith("001.md")) return "---\ntitle: 一\nchapter_number: 1\n---\n# 第一章\n\n正文若干。"
      if (path.endsWith("002.md")) return "---\ntitle: \n---\n# 无题\n\n草稿。"
      if (path.endsWith("bad.md")) return "# 无 frontmatter\n\n一些文字。"
      if (path.endsWith("zero.md")) return "---\nchapter_number: 0\n---\n# 零\n\n无。"
      throw new Error(`ENOENT ${path}`)
    })
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-card="1"]')).toBeTruthy())
    // 002.md 无 frontmatter 编号 → 由文件名回退为第 2 章；bad/zero/boom 被跳过
    expect(document.querySelector('[data-corkboard-card="2"]')).toBeTruthy()
    expect(document.querySelectorAll("[data-corkboard-card]").length).toBe(2)
  })

  it("情绪标签：空白情绪被跳过", async () => {
    const pp = "E:/CBEmo"
    wiki.state.project = { id: "c11", name: "C", path: pp }
    ingest.listSnapshots.mockResolvedValue([1])
    ingest.loadSnapshot.mockImplementation(async (_p, n) => snapshotRaw(n))
    chaptersOf(pp, [])
    arcs.loadEmotionalArcs.mockResolvedValue({
      beats: [
        { character: "甲", chapterNumber: 1, emotion: "   ", intensity: 0.5, trigger: "", notes: "" },
        { character: "甲", chapterNumber: 1, emotion: "怒", intensity: 0.5, trigger: "", notes: "" },
      ],
    })
    render(<CorkboardView />)
    await waitFor(() => expect(document.querySelector('[data-corkboard-emotions="1"]')).toBeTruthy())
    const chips = document.querySelectorAll('[data-corkboard-emotions="1"] > span')
    expect(chips.length).toBe(1)
    expect(chips[0]?.textContent).toBe("怒")
  })
})
