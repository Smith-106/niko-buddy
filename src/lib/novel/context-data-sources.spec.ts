import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextLoadContext } from "./context-data-source"
import type { ChapterSummariesStore } from "./chapter-summaries"
import type { FileNode } from "@/types/wiki"
import { invalidateChapterCache } from "./chapter-utils"
import {
  fallbackPreviousEndingDataSource,
  fallbackRecentSummariesDataSource,
  recentChapterContentsDataSource,
  writingStyleDataSource,
  outlineDataSource,
  chapterOutlineDataSource,
  volumeContextDataSource,
  snapshotDataSource,
  fallbackCharacterStatesDataSource,
  fallbackForeshadowingStatesDataSource,
  fallbackTimelineDataSource,
  relatedSettingsDataSource,
  canonRulesDataSource,
  searchResultsDataSource,
  graphSearchResultsDataSource,
  revisionFeedbackDataSource,
  cognitionTextDataSource,
  soulDocDataSource,
  characterAurasDataSource,
  storySimulationBindingDataSource,
  getAllDataSources,
} from "./context-data-sources"
import { DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG } from "./revision-feedback"

const mocks = vi.hoisted(() => ({
  buildWritingStyleContext: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  searchWiki: vi.fn(),
  listSnapshots: vi.fn(),
  loadSnapshot: vi.fn(),
  loadChapterSummaries: vi.fn(),
  getChapterVolumes: vi.fn(),
  loadRevisionFeedbackForContext: vi.fn(),
  loadCognitionState: vi.fn(),
  cognitionToContextText: vi.fn(),
  readSoulDoc: vi.fn(),
  loadCharacterStates: vi.fn(),
  characterStatesToContextText: vi.fn(),
  readOutlineContent: vi.fn(),
  readChapterOutlineContent: vi.fn(),
  searchRelevantContentUnified: vi.fn(),
  searchGraphRelevantContent: vi.fn(),
  selectLookbackChapterNumbers: vi.fn(),
  joinNonEmpty: vi.fn(),
}))

vi.mock("./writing-style-store", () => ({
  buildWritingStyleContext: mocks.buildWritingStyleContext,
}))

vi.mock("./chapter-ingest", () => ({
  listSnapshots: mocks.listSnapshots,
  loadSnapshot: mocks.loadSnapshot,
}))

vi.mock("./chapter-summaries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-summaries")>()
  return { ...actual, loadChapterSummaries: mocks.loadChapterSummaries }
})

vi.mock("./volume", () => ({
  getChapterVolumes: mocks.getChapterVolumes,
}))

vi.mock("./revision-feedback", () => ({
  loadRevisionFeedbackForContext: mocks.loadRevisionFeedbackForContext,
  createEmptyRevisionFeedback: () => ({ mustFix: [], shouldImprove: [], carryToNextChapter: [] }),
  DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG: {
    currentChapterIncludeShouldImprove: true,
    previousChapterCarryEnabled: true,
    lookbackChapterCount: 2,
    lookbackIncludeMustFixOnly: true,
  },
}))

vi.mock("./character-cognition", () => ({
  loadCognitionState: mocks.loadCognitionState,
  cognitionToContextText: mocks.cognitionToContextText,
}))

vi.mock("./character-state", () => ({
  loadCharacterStates: mocks.loadCharacterStates,
  characterStatesToContextText: mocks.characterStatesToContextText,
}))

vi.mock("./soul-doc", () => ({
  readSoulDoc: mocks.readSoulDoc,
}))

// ISS-20260709-031: helper 来自其定义源模块（与 context-data-sources.ts 一致），
// 不再经由 ./context-engine 中转 mock。
vi.mock("./context-engine-outline", () => ({
  readOutlineContent: mocks.readOutlineContent,
  readChapterOutlineContent: mocks.readChapterOutlineContent,
}))

vi.mock("./context-retrieval", () => ({
  searchRelevantContentUnified: mocks.searchRelevantContentUnified,
  searchGraphRelevantContent: mocks.searchGraphRelevantContent,
}))

vi.mock("./context-task-brief-builders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-task-brief-builders")>()
  return {
    ...actual,
    selectLookbackChapterNumbers: mocks.selectLookbackChapterNumbers,
    joinNonEmpty: mocks.joinNonEmpty,
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      listDirectory: mocks.listDirectory,
    
  }
})

vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>()
  return {
    ...actual,
      searchWiki: mocks.searchWiki,
    
  }
})

const context: ContextLoadContext = {
  projectPath: "E:/Novel",
  task: "生成第三章正文",
  chapterNumber: 3,
  config: {
    recentSummaryWindow: 8,
    searchTopK: 5,
    snapshotLookback: 3,
    revisionFeedbackWindowConfig: { ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG },
  },
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  invalidateChapterCache()
  mocks.listDirectory.mockResolvedValue([])
  mocks.loadChapterSummaries.mockResolvedValue({ entries: [], lastUpdated: "" })
  mocks.joinNonEmpty.mockImplementation((parts: string[], sep: string) =>
    parts.map((p) => String(p).trim()).filter(Boolean).join(sep),
  )
})

function chapterNode(relativePath: string): FileNode {
  return {
    name: relativePath.split("/").pop() ?? relativePath,
    path: `${context.projectPath}/wiki/chapters/${relativePath}`,
    is_dir: false,
  }
}

function mockFileContents(files: Record<string, string>): void {
  mocks.readFile.mockImplementation(async (path: string) => {
    const content = files[path]
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
}

function snapshot(chapterNumber: number, overrides: Partial<NonNullable<Awaited<ReturnType<typeof mocks.loadSnapshot>>>> = {}) {
  return {
    chapterNumber,
    summary: `第${chapterNumber}章摘要`,
    endingHook: `第${chapterNumber}章结尾钩`,
    characterStateChanges: [`角色${chapterNumber}状态变化`],
    foreshadowingChanges: [`伏笔${chapterNumber}`],
    timelineEvents: [`事件${chapterNumber}`],
    ...overrides,
  }
}

describe("writingStyleDataSource", () => {
  beforeEach(() => {
    mocks.buildWritingStyleContext.mockReset()
    mocks.readFile.mockReset()
    mocks.searchWiki.mockReset()
  })

  it("优先读取当前启用的拆书库文风", async () => {
    mocks.buildWritingStyleContext.mockResolvedValue("目标文风来源：《长夜书》\n风格硬约束：冷峻克制")
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/style.md" }])
    mocks.readFile.mockResolvedValue("旧 wiki 风格")

    const result = await writingStyleDataSource.load(context)

    expect(result).toContain("目标文风来源：《长夜书》")
    expect(result).toContain("冷峻克制")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("没有启用拆书库文风时回退读取 wiki 风格页", async () => {
    mocks.buildWritingStyleContext.mockResolvedValue("")
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/style.md" }])
    mocks.readFile.mockResolvedValue("wiki 中的写作风格")

    const result = await writingStyleDataSource.load(context)

    expect(result).toBe("wiki 中的写作风格")
    expect(mocks.searchWiki).toHaveBeenCalled()
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/wiki/style.md")
  })
})

describe("recentChapterContentsDataSource", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.searchWiki.mockReset()
  })

  it("按最近章节数量窗口读取目标章节之前的章节正文片段", async () => {
    const chapterContext: ContextLoadContext = {
      ...context,
      chapterNumber: 6,
      config: {
        ...context.config,
        recentSummaryWindow: 5,
      },
    }
    mocks.listDirectory.mockResolvedValue(Array.from({ length: 5 }, (_, index) => chapterNode(`chapter-${index + 1}.md`)))
    mocks.readFile.mockImplementation(async (path: string) => {
      const matched = path.match(/chapter-(\d+)\.md$/)
      const number = matched?.[1] ?? "0"
      return `---\ntype: chapter\nchapter_number: ${number}\nstatus: final\n---\n第${number}章正文开头\n第${number}章正文关键事实\n第${number}章正文结尾`
    })

    const result = await recentChapterContentsDataSource.load(chapterContext)

    expect(result).toHaveLength(5)
    expect(result[0]).toContain("第1章正文关键事实")
    expect(result[4]).toContain("第5章正文结尾")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(mocks.listDirectory).toHaveBeenCalledExactlyOnceWith("E:/Novel/wiki/chapters")
    expect(mocks.readFile).toHaveBeenCalledTimes(5)
  })

  it("长章节正文片段保留开头和结尾，避免只读取章节开头", async () => {
    const chapterContext: ContextLoadContext = {
      ...context,
      chapterNumber: 2,
      config: {
        ...context.config,
        recentSummaryWindow: 1,
      },
    }
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-1.md")])
    mocks.readFile.mockResolvedValue(`---\ntype: chapter\nchapter_number: 1\nstatus: final\n---\n开头事实${"中段".repeat(4000)}结尾事实`)

    const result = await recentChapterContentsDataSource.load(chapterContext)

    expect(result).toHaveLength(1)
    expect(result[0]).toContain("开头事实")
    expect(result[0]).toContain("结尾事实")
    expect(result[0]).toContain("章节正文中段已按上下文预算省略")
  })

  it("wiki 无章节页时回退读取 .novel/chapters/{n}/draft.md 作为前情正文片段", async () => {
    const chapterContext: ContextLoadContext = {
      ...context,
      chapterNumber: 3,
      config: {
        ...context.config,
        recentSummaryWindow: 2,
      },
    }
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("/.novel/chapters/1/draft.md")) return "第一章 draft 开篇\n第一章 draft 结尾钩"
      if (path.includes("/.novel/chapters/2/draft.md")) return "第二章 draft 开篇\n第二章 draft 结尾钩"
      throw new Error(`unexpected path ${path}`)
    })

    const result = await recentChapterContentsDataSource.load(chapterContext)

    expect(result).toHaveLength(2)
    expect(result[0]).toContain("（draft）")
    expect(result[0]).toContain("第一章 draft 结尾钩")
    expect(result[1]).toContain("第二章 draft 结尾钩")
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/.novel/chapters/1/draft.md")
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/.novel/chapters/2/draft.md")
  })
})

describe("章节原文 reader 的身份与错误回执", () => {
  it("搜索首项始终是第 1 章时，两个 reader 都回读真实第 81 章", async () => {
    const first = chapterNode("chapter-001.md")
    const target = chapterNode("chapter-0081.md")
    const recordGap = vi.fn()
    mocks.searchWiki.mockResolvedValue([{ path: first.path }, { path: target.path }])
    mocks.listDirectory.mockResolvedValue([first, target])
    mockFileContents({
      [first.path]: "---\nchapter_number: 1\n---\n第一章错误前情",
      [target.path]: "---\nchapter_number: 81\n---\n第八十一章真实开头\n第八十一章真实结尾",
    })
    const loadContext = { ...context, chapterNumber: 82, config: { ...context.config, recentSummaryWindow: 1 }, recordGap }

    expect(await recentChapterContentsDataSource.load(loadContext)).toEqual([
      "## 第81章正文片段\n第八十一章真实开头\n第八十一章真实结尾",
    ])
    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(await fallbackPreviousEndingDataSource.load(loadContext)).toBe("第八十一章真实开头\n第八十一章真实结尾")
    expect(mocks.readFile).not.toHaveBeenCalledWith(first.path)
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("支持嵌套数字文件、matching filename 的无编号字段正文和仅 frontmatter 编号", async () => {
    const legacy = chapterNode("第79章-开局.md")
    const nested = chapterNode("volume-3/chapter-080.md")
    const metadataOnly = chapterNode("尾声.md")
    const recordGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([
      legacy,
      { name: "volume-3", path: "E:/Novel/wiki/chapters/volume-3", is_dir: true, children: [nested] },
      metadataOnly,
    ])
    mockFileContents({
      [legacy.path]: "第七十九章旧格式正文",
      [nested.path]: "---\ntitle: 旧格式标题\nchapter_status: draft\n---\n第八十章正式路径正文",
      [metadataOnly.path]: "---\nchapter_number: '81'\nchapter_status: revised\n---\n第八十一章无数字文件名正文",
    })
    const result = await recentChapterContentsDataSource.load({
      ...context, chapterNumber: 82, config: { ...context.config, recentSummaryWindow: 3 }, recordGap,
    })
    expect(result).toEqual([
      "## 第79章正文片段\n第七十九章旧格式正文",
      "## 第80章正文片段\n第八十章正式路径正文",
      "## 第81章正文片段\n第八十一章无数字文件名正文",
    ])
    expect(mocks.readFile).toHaveBeenCalledTimes(3)
    expect(recordGap).not.toHaveBeenCalled()
    expect(await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 82, recordGap }))
      .toBe("第八十一章无数字文件名正文")
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("草稿 suffix 不抢占同号正式文件", async () => {
    const formal = chapterNode("chapter-2.md")
    const drafts = ["chapter-2-去AI味稿.md", "chapter-2.draft.md", "chapter-2.tmp"].map(chapterNode)
    mocks.listDirectory.mockResolvedValue([...drafts, formal])
    mockFileContents({ [formal.path]: "---\nchapter_number: 2\n---\n第二章正式正文" })
    const loadContext = { ...context, config: { ...context.config, recentSummaryWindow: 1 } }
    expect(await recentChapterContentsDataSource.load(loadContext)).toEqual(["## 第2章正文片段\n第二章正式正文"])
    expect(await fallbackPreviousEndingDataSource.load(loadContext)).toBe("第二章正式正文")
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    for (const draft of drafts) expect(mocks.readFile).not.toHaveBeenCalledWith(draft.path)
  })

  it.each(["ENOENT", "ENOTDIR", "EIO"])("目录 %s 拒绝后 draft 成功仍保留每次 load 的一条 gap", async (code) => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockRejectedValue(new Error(`${code}: chapters`))
    mockFileContents({
      "E:/Novel/.novel/chapters/1/draft.md": "第一章草稿",
      "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿结尾",
    })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 2 }, recordGap: recentGap,
    })).toEqual([
      "## 第1章正文片段（draft）\n第一章草稿",
      "## 第2章正文片段（draft）\n第二章草稿结尾",
    ])
    expect(mocks.listDirectory).toHaveBeenCalledExactlyOnceWith("E:/Novel/wiki/chapters")
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿结尾")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual([
      "E:/Novel/.novel/chapters/1/draft.md", "E:/Novel/.novel/chapters/2/draft.md", "E:/Novel/.novel/chapters/2/draft.md",
    ])
  })

  it("目标 read 拒绝只回退该章，其他正式正文保留，成功 draft 不清除错误", async () => {
    const first = chapterNode("chapter-1.md")
    const second = chapterNode("chapter-2.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([first, second])
    mockFileContents({ [second.path]: "第二章正式正文", "E:/Novel/.novel/chapters/1/draft.md": "第一章草稿" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 2 }, recordGap: recentGap,
    })).toEqual(["## 第1章正文片段（draft）\n第一章草稿", "## 第2章正文片段\n第二章正式正文"])
    expect(mocks.readFile).toHaveBeenCalledTimes(3)
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 2, recordGap: endingGap })).toBe("第一章草稿")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it.each([
    { caseName: "读取拒绝", raw: undefined },
    { caseName: "显式无效编号", raw: "---\nchapter_number: null\n---\n不明章正文" },
    { caseName: "编号 YAML 解析失败", raw: "---\nchapter_number: [\n---\n不明章正文" },
  ])("无数字名候选 $caseName 时保留已验正文，并留下不确定 gap", async ({ raw }) => {
    const second = chapterNode("chapter-2.md")
    const unknown = chapterNode("尾声.md")
    const files: Record<string, string> = {
      [second.path]: "第二章正式正文",
      "E:/Novel/.novel/chapters/1/draft.md": "第一章草稿",
    }
    if (raw !== undefined) files[unknown.path] = raw
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([second, unknown])
    mockFileContents(files)
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 2 }, recordGap: recentGap,
    })).toEqual(["## 第1章正文片段（draft）\n第一章草稿", "## 第2章正文片段\n第二章正式正文"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章正式正文")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("无数字名候选读失败且没有已验正文时，draft 输出仍带 unresolved gap", async () => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([chapterNode("未编号正文.md")])
    mockFileContents({ "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual(["## 第2章正文片段（draft）\n第二章草稿"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("已知同号多个候选不取首项，两个 reader 都回退 exact draft 并记录一条 gap", async () => {
    const first = chapterNode("chapter-2.md")
    const second = chapterNode("第2章-另稿.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([first, second])
    mockFileContents({ [first.path]: "首项正文", [second.path]: "同号另稿正文", "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual(["## 第2章正文片段（draft）\n第二章草稿"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("basename 和 frontmatter 编号冲突不冒充目标，也不丢弃其他正确章节", async () => {
    const first = chapterNode("chapter-1.md")
    const conflicting = chapterNode("chapter-2.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([first, conflicting])
    mockFileContents({
      [first.path]: "---\nchapter_number: 1\n---\n第一章正式正文",
      [conflicting.path]: "---\nchapter_number: 1\n---\n被误标成第二章的正文",
      "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿",
    })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 2 }, recordGap: recentGap,
    })).toEqual(["## 第1章正文片段\n第一章正式正文", "## 第2章正文片段（draft）\n第二章草稿"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it.each(["null", "''", "0", "-2", "2.5", "9007199254740992", "bad", "[2]"])(
    "存在 chapter_number: %s 时不得 truthy 回退 basename",
    async (value) => {
      const formal = chapterNode("chapter-2.md")
      const recentGap = vi.fn()
      const endingGap = vi.fn()
      mocks.listDirectory.mockResolvedValue([formal])
      mockFileContents({ [formal.path]: `---\nchapter_number: ${value}\n---\n身份无效的正文`, "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿" })
      expect(await recentChapterContentsDataSource.load({
        ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
      })).toEqual(["## 第2章正文片段（draft）\n第二章草稿"])
      expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
      expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿")
      expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
    },
  )

  it.each([
    { caseName: "合法 flow mapping", fileName: "chapter-2.md", raw: "---\n{chapter_number: 2, title: ok}\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法 flow 的编号冲突", fileName: "chapter-2.md", raw: "---\n{chapter_number: 1, title: ok}\n---\nFORMAL_BODY", expectedBody: "EXACT_CH2_DRAFT", usesDraft: true },
    { caseName: "合法 block mapping", fileName: "chapter-2.md", raw: "---\nchapter_number: 2\ntitle: ok\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "损坏 block mapping", fileName: "chapter-2.md", raw: "---\nchapter_number: 1\nextra: [\n---\nFORMAL_BODY", expectedBody: "EXACT_CH2_DRAFT", usesDraft: true },
    { caseName: "损坏 flow 与数字文件名", fileName: "chapter-2.md", raw: "---\n{chapter_number: 1, extra: [}\n---\nFORMAL_BODY", expectedBody: "EXACT_CH2_DRAFT", usesDraft: true },
    { caseName: "损坏 flow 与无数字文件名", fileName: "unlabeled.md", raw: "---\n{chapter_number: 2, extra: [}\n---\nFORMAL_BODY", expectedBody: "EXACT_CH2_DRAFT", usesDraft: true },
    { caseName: "合法 flow 与无数字文件名", fileName: "unlabeled.md", raw: "---\n{chapter_number: 2, title: ok}\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "无编号字段的非空声明块解析失败", fileName: "chapter-2.md", raw: "---\nextra: [\n---\nFORMAL_BODY", expectedBody: "EXACT_CH2_DRAFT", usesDraft: true },
    { caseName: "没有 frontmatter", fileName: "chapter-2.md", raw: "FORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法空 frontmatter", fileName: "chapter-2.md", raw: "---\n\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "仅注释的空 frontmatter", fileName: "chapter-2.md", raw: "---\n# {chapter_number: 1, extra: [}\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法空 flow mapping", fileName: "chapter-2.md", raw: "---\n{}\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法空 flow sequence", fileName: "chapter-2.md", raw: "---\n[]\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法 null 元数据", fileName: "chapter-2.md", raw: "---\nnull\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "合法无编号 scalar 元数据", fileName: "chapter-2.md", raw: "---\nlegacy metadata\n---\nFORMAL_BODY", expectedBody: "FORMAL_BODY", usesDraft: false },
    { caseName: "旧正文中的 flow 文本没有声明 FM", fileName: "chapter-2.md", raw: "{chapter_number: 1, extra: [}\nFORMAL_BODY", expectedBody: "{chapter_number: 1, extra: [}\nFORMAL_BODY", usesDraft: false },
  ])("两 reader 的声明 FM 解析边界：$caseName", async ({ fileName, raw, expectedBody, usesDraft }) => {
    const formal = chapterNode(fileName)
    const draftPath = "E:/Novel/.novel/chapters/2/draft.md"
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([formal])
    mockFileContents({ [formal.path]: raw, [draftPath]: "EXACT_CH2_DRAFT" })
    const loadContext = { ...context, config: { ...context.config, recentSummaryWindow: 1 } }

    expect(await recentChapterContentsDataSource.load({ ...loadContext, recordGap: recentGap })).toEqual([
      `## 第2章正文片段${usesDraft ? "（draft）" : ""}\n${expectedBody}`,
    ])
    expect(mocks.listDirectory).toHaveBeenCalledExactlyOnceWith("E:/Novel/wiki/chapters")
    expect(await fallbackPreviousEndingDataSource.load({ ...loadContext, recordGap: endingGap })).toBe(expectedBody)
    if (usesDraft) {
      expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
      expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
    } else {
      expect(recentGap).not.toHaveBeenCalled()
      expect(endingGap).not.toHaveBeenCalled()
      expect(mocks.readFile).not.toHaveBeenCalledWith(draftPath)
    }
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual(usesDraft
      ? [formal.path, draftPath, formal.path, draftPath]
      : [formal.path, formal.path])
  })

  it("数字目标的损坏 flow 只回退该章，另一章已验正文继续保留", async () => {
    const first = chapterNode("chapter-1.md")
    const corrupt = chapterNode("chapter-2.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([first, corrupt])
    mockFileContents({
      [first.path]: "CH1_FORMAL",
      [corrupt.path]: "---\n{chapter_number: 1, extra: [}\n---\nFORMAL_BODY",
      "E:/Novel/.novel/chapters/2/draft.md": "EXACT_CH2_DRAFT",
    })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 2 }, recordGap: recentGap,
    })).toEqual(["## 第1章正文片段\nCH1_FORMAL", "## 第2章正文片段（draft）\nEXACT_CH2_DRAFT"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("EXACT_CH2_DRAFT")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("未知候选损坏 flow 时保留已验目标正文，同时每个 reader 留下总 gap", async () => {
    const known = chapterNode("chapter-2.md")
    const unknown = chapterNode("unlabeled.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    const draftPath = "E:/Novel/.novel/chapters/2/draft.md"
    mocks.listDirectory.mockResolvedValue([known, unknown])
    mockFileContents({
      [known.path]: "CH2_FORMAL",
      [unknown.path]: "---\n{chapter_number: 2, extra: [}\n---\nFORMAL_BODY",
      [draftPath]: "EXACT_CH2_DRAFT",
    })
    const loadContext = { ...context, config: { ...context.config, recentSummaryWindow: 1 } }
    expect(await recentChapterContentsDataSource.load({ ...loadContext, recordGap: recentGap }))
      .toEqual(["## 第2章正文片段\nCH2_FORMAL"])
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(await fallbackPreviousEndingDataSource.load({ ...loadContext, recordGap: endingGap })).toBe("CH2_FORMAL")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
    expect(mocks.readFile).not.toHaveBeenCalledWith(draftPath)
  })

  it("真实空目录与成功空 draft 是无内容，不产生错误 gap", async () => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mockFileContents({ "E:/Novel/.novel/chapters/2/draft.md": "" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual([])
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("")
    expect(recentGap).not.toHaveBeenCalled()
    expect(endingGap).not.toHaveBeenCalled()
  })

  it("无正式候选但 exact draft 成功时，兼容 draft 内容且没有错误 gap", async () => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-3.md")])
    mockFileContents({ "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿结尾" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual(["## 第2章正文片段（draft）\n第二章草稿结尾"])
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿结尾")
    expect(recentGap).not.toHaveBeenCalled()
    expect(endingGap).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalledWith("E:/Novel/wiki/chapters/chapter-3.md")
  })

  it("空正文的正式文件允许 exact draft 回退且不产生错误 gap", async () => {
    const formal = chapterNode("chapter-2.md")
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([formal])
    mockFileContents({ [formal.path]: "---\nchapter_number: 2\n---\n", "E:/Novel/.novel/chapters/2/draft.md": "第二章草稿" })
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual(["## 第2章正文片段（draft）\n第二章草稿"])
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("第二章草稿")
    expect(recentGap).not.toHaveBeenCalled()
    expect(endingGap).not.toHaveBeenCalled()
  })

  it("真实空目录中 draft 自身读取失败仍记录一条 gap", async () => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    mockFileContents({})
    expect(await recentChapterContentsDataSource.load({
      ...context, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual([])
    expect(await fallbackPreviousEndingDataSource.load({ ...context, recordGap: endingGap })).toBe("")
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("并行读取乱序完成仍按章号保序，每次只列目录一次且每个选中文件只读一次", async () => {
    const nodes = [1, 2, 3].map((number) => chapterNode(`chapter-${number}.md`))
    const release = new Map<string, (content: string) => void>()
    const completionOrder: string[] = []
    let notifyStarted: () => void = () => { throw new Error("reads not initialized") }
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    mocks.listDirectory.mockResolvedValue(nodes)
    mocks.readFile.mockImplementation((path: string) => new Promise<string>((resolve) => {
      release.set(path, resolve)
      if (release.size === nodes.length) notifyStarted()
    }).then((content) => { completionOrder.push(path); return content }))
    const recordGap = vi.fn()
    const loading = recentChapterContentsDataSource.load({
      ...context, chapterNumber: 4, config: { ...context.config, recentSummaryWindow: 3 }, recordGap,
    })
    await started
    for (const number of [3, 2, 1]) {
      const resolve = release.get(nodes[number - 1].path)
      if (!resolve) throw new Error(`read not started: ${number}`)
      resolve(`第${number}章正文`)
    }
    expect(await loading).toEqual(["## 第1章正文片段\n第1章正文", "## 第2章正文片段\n第2章正文", "## 第3章正文片段\n第3章正文"])
    expect(completionOrder).toEqual([nodes[2].path, nodes[1].path, nodes[0].path])
    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(mocks.readFile).toHaveBeenCalledTimes(3)
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("下一次 load 回读当前字节，不使用跨 fetch 原文缓存", async () => {
    const formal = chapterNode("chapter-2.md")
    mocks.listDirectory.mockResolvedValue([formal])
    mockFileContents({ [formal.path]: "原正文" })
    expect(await fallbackPreviousEndingDataSource.load(context)).toBe("原正文")
    mockFileContents({ [formal.path]: "当前正文" })
    expect(await fallbackPreviousEndingDataSource.load(context)).toBe("当前正文")
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
  })

  it("前章末尾仍最多 30 行、1200 字符", async () => {
    const formal = chapterNode("chapter-2.md")
    mocks.listDirectory.mockResolvedValue([formal])
    const shortLines = Array.from({ length: 45 }, (_, index) => `line-${index + 1}`)
    mockFileContents({ [formal.path]: `---\nchapter_number: 2\n---\n${shortLines.join("\n")}` })
    const ending = await fallbackPreviousEndingDataSource.load(context)
    expect(ending.split("\n")).toHaveLength(30)
    expect(ending.startsWith("line-16\n")).toBe(true)
    expect(ending.endsWith("line-45")).toBe(true)
    const longLines = Array.from({ length: 45 }, (_, index) => `${index + 1}-${"字".repeat(100)}`)
    mockFileContents({ [formal.path]: `---\nchapter_number: 2\n---\n${longLines.join("\n")}` })
    const capped = await fallbackPreviousEndingDataSource.load(context)
    expect(capped).toHaveLength(1200)
    expect(capped.endsWith(longLines[44])).toBe(true)
  })

  it("目标编号不是安全正整数时不读取目录或 draft，两个 reader 都记录一条 gap", async () => {
    const recentGap = vi.fn()
    const endingGap = vi.fn()
    expect(await recentChapterContentsDataSource.load({
      ...context, chapterNumber: 3.5, config: { ...context.config, recentSummaryWindow: 1 }, recordGap: recentGap,
    })).toEqual([])
    expect(await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3.5, recordGap: endingGap })).toBe("")
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(recentGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
    expect(endingGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })
})

describe("fallbackPreviousEndingDataSource draft fallback", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.searchWiki.mockReset()
  })

  it("wiki 无上一章时从 draft.md 取章末作为 previousChapterEnding", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("前文若干行\n".repeat(5) + "上一章真正的结尾钩子。")

    const ending = await fallbackPreviousEndingDataSource.load({
      ...context,
      chapterNumber: 3,
    })

    expect(ending).toContain("上一章真正的结尾钩子")
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/.novel/chapters/2/draft.md")
  })
})

describe("fallbackRecentSummariesDataSource draft fallback", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.searchWiki.mockReset()
  })

  it("wiki type:chapter 为空时用前章 draft 节选合成 recentSummaries", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("/1/draft.md")) return "第一章事实：陈烬出局。"
      if (path.endsWith("/2/draft.md")) return "第二章事实：Offer 未揭。"
      return ""
    })

    const summaries = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 2 },
    })

    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries.some((s) => s.includes("draft 节选") && s.includes("陈烬"))).toBe(true)
  })
  it("ignores whitespace-only draft bodies (empty head → empty summary line)", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("/1/draft.md")) return "   \n  "
      if (path.endsWith("/2/draft.md")) return "   "
      return ""
    })
    const summaries = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 2 },
    })
    expect(summaries).toEqual([])
  })
})

describe("outlineDataSource / chapterOutlineDataSource", () => {
  it("outlineDataSource.load 返回 readOutlineContent 结果", async () => {
    mocks.readOutlineContent.mockResolvedValue("全书大纲")
    await expect(outlineDataSource.load(context)).resolves.toBe("全书大纲")
    expect(mocks.readOutlineContent).toHaveBeenCalledWith("E:/Novel")
  })

  it("chapterOutlineDataSource.load: 无 chapterNumber 返回空串, 有则读章节大纲并透传 buildSession", async () => {
    await expect(chapterOutlineDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")
    mocks.readChapterOutlineContent.mockResolvedValue("第三章细纲")
    await expect(chapterOutlineDataSource.load(context)).resolves.toBe("第三章细纲")
    expect(mocks.readChapterOutlineContent).toHaveBeenCalledWith("E:/Novel", 3, undefined)
  })
})

describe("volumeContextDataSource", () => {
  it("无 chapterNumber → 空串", async () => {
    await expect(volumeContextDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")
  })

  it("卷为空 → 空串", async () => {
    mocks.getChapterVolumes.mockResolvedValue([])
    await expect(volumeContextDataSource.load(context)).resolves.toBe("")
  })

  it("卷信息渲染: 卷号/标题/概要/章节范围", async () => {
    mocks.getChapterVolumes.mockResolvedValue([
      { volumeNumber: 1, title: "风起", summary: "主角登场", chapterRangeStart: 1, chapterRangeEnd: 10 },
      { volumeNumber: 2, title: "云涌" },
    ])
    const result = await volumeContextDataSource.load(context)
    expect(result).toContain("第1卷：风起")
    expect(result).toContain("概要：主角登场")
    expect(result).toContain("章节范围：第1章 - 第10章")
    expect(result).toContain("第2卷：云涌")
  })

  it("getChapterVolumes 抛错 → recordGap + 空串", async () => {
    const recordGap = vi.fn()
    mocks.getChapterVolumes.mockRejectedValue(new Error("volume dir missing"))
    await expect(volumeContextDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("volumeContext", "datasource_error")
  })
})

describe("snapshotDataSource", () => {
  it("无快照 → 空 payload", async () => {
    mocks.listSnapshots.mockResolvedValue([])
    const result = await snapshotDataSource.load(context)
    expect(result).toEqual({
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      foreshadowingSignals: [],
      timeline: "",
    })
  })

  it("有 chapterNumber: lookback + summaries + 各维度文本渲染", async () => {
    mocks.listSnapshots.mockResolvedValue([1, 2])
    mocks.selectLookbackChapterNumbers.mockReturnValue([2, 1])
    mocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) =>
      n === 1 ? snapshot(1, { characterStateChanges: [], foreshadowingChanges: [], timelineEvents: [] }) : snapshot(2),
    )
    mocks.joinNonEmpty.mockImplementation((parts: string[], sep: string) =>
      parts.map((p) => String(p).trim()).filter(Boolean).join(sep),
    )
    const result = await snapshotDataSource.load(context)
    expect(result.recentSummaries).toEqual(["第1章：第1章摘要", "第2章：第2章摘要"])
    expect(result.previousChapterEnding).toBe("第2章结尾钩")
    expect(result.characterStates).toContain("角色2状态变化")
    expect(result.foreshadowingSignals).toContain("伏笔2")
    expect(result.timeline).toContain("事件2")
    expect(mocks.selectLookbackChapterNumbers).toHaveBeenCalledWith(3, 3)
  })

  it("无 chapterNumber: 最新 N 个快照作 lookback, 末 N 个作摘要", async () => {
    mocks.listSnapshots.mockResolvedValue([1, 2, 3, 4])
    mocks.selectLookbackChapterNumbers.mockReturnValue([])
    mocks.loadSnapshot.mockImplementation(async (_p: string, n: number) => snapshot(n))
    const result = await snapshotDataSource.load({
      ...context,
      chapterNumber: undefined,
      config: { ...context.config, snapshotLookback: 2, recentSummaryWindow: 2 },
    })
    expect(result.recentSummaries).toEqual(["第3章：第3章摘要", "第4章：第4章摘要"])
    expect(result.previousChapterEnding).toBe("第4章结尾钩")
  })

  it("loadSnapshot 返回 null 的条目被过滤", async () => {
    mocks.listSnapshots.mockResolvedValue([1])
    mocks.selectLookbackChapterNumbers.mockReturnValue([1])
    mocks.loadSnapshot.mockResolvedValue(null)
    const result = await snapshotDataSource.load(context)
    expect(result.previousChapterEnding).toBe("")
    expect(result.characterStates).toBe("")
  })

  describe("状态增量窗口", () => {
    const store: ChapterSummariesStore = {
      entries: [1, 2, 3, 4, 155, 162].map((chapter) => ({
        chapter,
        happened: `本章事件${chapter}`,
        stateChanges: [{ kind: "character", entity: "主角", change: `状态变化${chapter}` }],
        keyReveals: [],
        endingHook: "",
      })),
      lastUpdated: "frozen",
    }
    Object.freeze(store.entries)
    Object.freeze(store)

    beforeEach(() => {
      mocks.listSnapshots.mockResolvedValue([1, 2, 3, 4, 155, 162])
      mocks.selectLookbackChapterNumbers.mockReturnValue([])
      mocks.loadSnapshot.mockImplementation(async (_projectPath: string, chapter: number) => snapshot(chapter))
      mocks.loadChapterSummaries.mockResolvedValue(store)
    })

    it("先筛出目标章之前的状态，再取最近 N 章，且不修改共享投影", async () => {
      const result = await snapshotDataSource.load({
        ...context,
        chapterNumber: 4,
        config: { ...context.config, recentSummaryWindow: 2 },
      })

      expect(result.recentStateDeltas).toBe(
        "【近 2 章摘要】\n第2章：本章事件2\n  - [character] 主角: 状态变化2\n第3章：本章事件3\n  - [character] 主角: 状态变化3",
      )
      expect(store.entries.map((entry) => entry.chapter)).toEqual([1, 2, 3, 4, 155, 162])
      expect(store.lastUpdated).toBe("frozen")
    })

    it("首章没有历史状态，不注入当前章或晚章状态", async () => {
      const result = await snapshotDataSource.load({ ...context, chapterNumber: 1 })

      expect(result.recentStateDeltas).toBe("")
    })

    it.each([undefined, 0])("无目标章 %s 时保留最新 N 章的已有行为", async (chapterNumber) => {
      const result = await snapshotDataSource.load({
        ...context,
        chapterNumber,
        config: { ...context.config, recentSummaryWindow: 2 },
      })

      expect(result.recentStateDeltas).toContain("第155章：本章事件155")
      expect(result.recentStateDeltas).toContain("第162章：本章事件162")
      expect(result.recentStateDeltas).not.toContain("第4章：")
    })
  })
})

describe("fallbackCharacterStatesDataSource", () => {
  const legacyContext: ContextLoadContext = {
    ...context,
    chapterNumber: undefined,
  }

  it("结构化 character-states.json 非空时优先 → slice 3000", async () => {
    mocks.loadCharacterStates.mockResolvedValue({ entries: {} })
    mocks.characterStatesToContextText.mockReturnValue("结构化角色状态".repeat(100))
    const result = await fallbackCharacterStatesDataSource.load(legacyContext)
    expect(result).toBe("结构化角色状态".repeat(100).slice(0, 3000))
  })

  it("结构化为空/抛错 → wiki entity 页回退", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/entities/a.md" }])
    mocks.readFile.mockResolvedValue("角色页内容")
    const result = await fallbackCharacterStatesDataSource.load(legacyContext)
    expect(result).toContain("角色页内容")
  })

  it("wiki 搜索抛错 → recordGap + 空串", async () => {
    mocks.loadCharacterStates.mockResolvedValue({ entries: {} })
    mocks.characterStatesToContextText.mockReturnValue("")
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("index down"))
    await expect(fallbackCharacterStatesDataSource.load({ ...legacyContext, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("fallbackCharacterStates", "datasource_error")
  })

  it("wiki 无结果 → 空串", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([])
    await expect(fallbackCharacterStatesDataSource.load(legacyContext)).resolves.toBe("")
  })

  it("readFile 单页失败不影响其余页 (catch(() => ''))", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([{ path: "a.md" }, { path: "b.md" }])
    mocks.readFile.mockImplementation(async (p: string) => (p === "a.md" ? "A 页" : Promise.reject(new Error("boom"))))
    const result = await fallbackCharacterStatesDataSource.load(legacyContext)
    expect(result).toContain("A 页")
  })

  it("结构化角色超 3000 字时按 主角 > 任务提及 > 近期活跃 优先级截选，并经 buildSession 记 truncated gap", async () => {
    const { createContextBuildSession } = await import("./context-engine-gaps")
    const session = createContextBuildSession(null)
    const pad = "历".repeat(120)
    const characters = [
      {
        characterName: "主角林动",
        currentLocation: "青山镇",
        status: `主角状态-${pad}`,
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 1,
        lastSeenChapter: 1,
        lastUpdatedAt: "t",
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        characterName: `旧路人${i + 1}`,
        currentLocation: "旧镇",
        status: `陈旧状态-${pad}`,
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 2,
        lastSeenChapter: 2,
        lastUpdatedAt: "t",
      })),
      {
        characterName: "沈孤鸿",
        currentLocation: "雾港",
        status: `任务点名配角-${pad}`,
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 5,
        lastSeenChapter: 5,
        lastUpdatedAt: "t",
      },
      {
        characterName: "苏照影",
        currentLocation: "玄铁城",
        status: `近期活跃配角-${pad}`,
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 99,
        lastSeenChapter: 99,
        lastUpdatedAt: "t",
      },
    ]

    mocks.loadCharacterStates.mockResolvedValue({ characters, lastUpdated: "t" })
    mocks.characterStatesToContextText.mockImplementation((st: { characters?: typeof characters }) =>
      (st.characters ?? [])
        .map((c) => `- ${c.characterName}：位于${c.currentLocation}，状态：${c.status}，装备：无，能力：无`)
        .join("\n"),
    )

    const result = await fallbackCharacterStatesDataSource.load({
      ...legacyContext,
      task: "写第100章：林动在雾港会见沈孤鸿",
      buildSession: session,
    })

    expect(result.length).toBeLessThanOrEqual(3000)
    expect(result).toContain("主角林动")
    expect(result).toContain("沈孤鸿")
    expect(result).toContain("苏照影")
    expect(result.indexOf("主角林动")).toBeLessThan(result.indexOf("沈孤鸿"))
    expect(result.indexOf("沈孤鸿")).toBeLessThan(result.indexOf("苏照影"))

    const gaps = session.collectGaps()
    expect(gaps).toContainEqual(
      expect.objectContaining({
        type: "truncated",
        ref: "fallbackCharacterStates",
        reason: "budget_exceeded",
        retainedLength: result.length,
      }),
    )
    expect(gaps.find((g) => g.ref === "fallbackCharacterStates")!.originalLength).toBeGreaterThan(3000)
  })

  it("wiki 角色页回退超 3000 字时经 tieredSlice 截断并记录 truncated gap", async () => {
    const { createContextBuildSession } = await import("./context-engine-gaps")
    const session = createContextBuildSession(null)
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([{ path: "a.md" }])
    mocks.readFile.mockResolvedValue("角".repeat(3500))

    const result = await fallbackCharacterStatesDataSource.load({
      ...legacyContext,
      buildSession: session,
    })

    expect(result).toHaveLength(3000)
    expect(session.collectGaps()).toContainEqual({
      type: "truncated",
      ref: "fallbackCharacterStates",
      reason: "tier_compressible",
      originalLength: 3500,
      retainedLength: 3000,
    })
  })
})

describe("fallbackForeshadowingStatesDataSource", () => {
  it("wiki 结果 join 并 slice 2000", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "f1.md" }, { path: "f2.md" }])
    mocks.readFile.mockImplementation(async (p: string) => (p === "f1.md" ? "伏笔页1" : "伏笔页2"))
    const result = await fallbackForeshadowingStatesDataSource.load(context)
    expect(result).toContain("伏笔页1")
    expect(result).toContain("伏笔页2")
  })

  it("无结果 → 空串; 抛错 → recordGap + 空串", async () => {
    mocks.searchWiki.mockResolvedValue([])
    await expect(fallbackForeshadowingStatesDataSource.load(context)).resolves.toBe("")
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("down"))
    await expect(fallbackForeshadowingStatesDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("fallbackForeshadowingStates", "datasource_error")
  })
})

describe("fallbackTimelineDataSource", () => {
  it("取首个结果 readFile slice 2000", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "timeline.md" }])
    mocks.readFile.mockResolvedValue("时间线内容")
    await expect(fallbackTimelineDataSource.load(context)).resolves.toBe("时间线内容")
  })

  it("无结果 → 空串; 抛错 → recordGap", async () => {
    mocks.searchWiki.mockResolvedValue([])
    await expect(fallbackTimelineDataSource.load(context)).resolves.toBe("")
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("down"))
    await expect(fallbackTimelineDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("fallbackTimeline", "datasource_error")
  })
})

describe("relatedSettingsDataSource", () => {
  it("join 多个设定页并 slice 2000", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "s1.md" }])
    mocks.readFile.mockResolvedValue("设定内容")
    await expect(relatedSettingsDataSource.load(context)).resolves.toBe("设定内容")
  })

  it("无结果 → 空串", async () => {
    mocks.searchWiki.mockResolvedValue([])
    await expect(relatedSettingsDataSource.load(context)).resolves.toBe("")
  })

  it("searchWiki 抛错 → recordGap + 空串", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("boom"))
    await expect(relatedSettingsDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("relatedSettings", "datasource_error")
  })

  it("部分文件读取失败 → 过滤后 join", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "s1.md" }, { path: "s2.md" }, { path: "s3.md" }])
    mocks.readFile.mockResolvedValueOnce("A").mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("B")
    await expect(relatedSettingsDataSource.load(context)).resolves.toBe("A\n---\nB")
  })
})

describe("recentChapterContentsDataSource 边界", () => {
  it("chapterNumber <= 1 或缺失 → []", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "x.md" }])
    await expect(
      recentChapterContentsDataSource.load({ ...context, chapterNumber: 1 }),
    ).resolves.toEqual([])
    await expect(
      recentChapterContentsDataSource.load({ ...context, chapterNumber: undefined }),
    ).resolves.toEqual([])
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("wiki 命中但正文为空 → 回退 draft; draft 也空 → null 丢弃", async () => {
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-1.md")])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.includes("/wiki/chapters/")) return "---\ntype: chapter\n---\n   " // 空正文
      throw new Error(`no draft ${p}`)
    })
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 2,
      config: { ...context.config, recentSummaryWindow: 1 },
    })
    expect(result).toEqual([])
  })

  it("正式目录与 draft 读取失败 → null 丢弃且只有一条 gap", async () => {
    const recordGap = vi.fn()
    mocks.listDirectory.mockRejectedValue(new Error("directory down"))
    mocks.readFile.mockRejectedValue(new Error("draft read fail"))
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 2,
      config: { ...context.config, recentSummaryWindow: 1 },
      recordGap,
    })
    expect(result).toEqual([])
    expect(recordGap).toHaveBeenCalledExactlyOnceWith("recentChapterContents", "datasource_error")
  })

  it("readFile 抛错 → null 丢弃", async () => {
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-1.md")])
    mocks.readFile.mockRejectedValue(new Error("read fail"))
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 2,
      config: { ...context.config, recentSummaryWindow: 1 },
    })
    expect(result).toEqual([])
  })
})

describe("fallbackRecentSummariesDataSource wiki 路径", () => {
  it("按目标章先过滤，再从无序 wiki 命中中选最近 N 章", async () => {
    const chapters = [155, 162, 4, 1, 3, 2]
    mocks.searchWiki.mockResolvedValue(chapters.map((chapter) => ({ path: `c${chapter}.md` })))
    mocks.readFile.mockImplementation(async (p: string) => {
      const chapter = Number(p.match(/^c(\d+)\.md$/)?.[1])
      return `---\ntype: chapter\nchapter_number: ${chapter}\nchapter_status: final\n---\n正文${chapter}`
    })

    const result = await fallbackRecentSummariesDataSource.load({
      ...context, chapterNumber: 4, config: { ...context.config, recentSummaryWindow: 2 },
    })

    expect(result).toEqual(["第2章 (final): 正文2", "第3章 (final): 正文3"])
  })

  it("首章不注入当前章或晚章 wiki 摘要", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "c1.md" }, { path: "c162.md" }])
    mocks.readFile.mockImplementation(async (p: string) =>
      `---\ntype: chapter\nchapter_number: ${p === "c1.md" ? 1 : 162}\n---\n正文`,
    )

    await expect(fallbackRecentSummariesDataSource.load({ ...context, chapterNumber: 1 })).resolves.toEqual([])
  })

  it.each([undefined, 0])("无目标章 %s 时仍按 wiki 命中顺序截取窗口", async (chapterNumber) => {
    mocks.searchWiki.mockResolvedValue([{ path: "c162.md" }, { path: "c155.md" }])
    mocks.readFile.mockImplementation(async (p: string) =>
      `---\ntype: chapter\nchapter_number: ${p === "c162.md" ? 162 : 155}\n---\n正文`,
    )
    await expect(fallbackRecentSummariesDataSource.load({
      ...context, chapterNumber, config: { ...context.config, recentSummaryWindow: 1 },
    })).resolves.toEqual(["第162章 (draft): 正文"])
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
  })

  it("type:chapter 命中并解析 meta → 渲染摘要; 无 frontmatter 条目被跳过", async () => {
    mocks.searchWiki.mockResolvedValue([
      { path: "E:/Novel/wiki/chapters/c1.md" },
      { path: "E:/Novel/wiki/chapters/c2.md" },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("c1.md")) {
        return "---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n第一章正文"
      }
      return "没有 frontmatter 的页面"
    })
    const result = await fallbackRecentSummariesDataSource.load(context)
    expect(result).toEqual(["第1章 (final): 第一章正文"])
  })

  it("单个 wiki 章节读取失败时跳过它并保留其余摘要", async () => {
    mocks.searchWiki.mockResolvedValue([
      { path: "E:/Novel/wiki/chapters/c1.md" },
      { path: "E:/Novel/wiki/chapters/c2.md" },
    ])
    mocks.readFile
      .mockRejectedValueOnce(new Error("c1 unavailable"))
      .mockResolvedValueOnce("---\ntype: chapter\nchapter_number: 2\nchapter_status: final\n---\n第二章正文")

    await expect(fallbackRecentSummariesDataSource.load(context)).resolves.toEqual([
      "第2章 (final): 第二章正文",
    ])
  })

  it("searchWiki 抛错 → recordGap; 无摘要且 chapterNumber 缺失 → 不合成 draft 摘要", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("index down"))
    const result = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: undefined,
      recordGap,
    })
    expect(result).toEqual([])
    expect(recordGap).toHaveBeenCalledWith("fallbackRecentSummaries", "datasource_error")
  })

  it("draft 正文为空 → 空摘要串被过滤", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("/1/draft.md")) return "  \n  " // 纯空白
      return "第二章事实。"
    })
    const result = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 2 },
    })
    expect(result).toEqual(["第2章（draft 节选）：第二章事实。"])
  })

  it("已有 wiki 摘要时不再合成 draft 摘要", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/c1.md" }])
    mocks.readFile.mockResolvedValue(
      "---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n正文",
    )
    const result = await fallbackRecentSummariesDataSource.load(context)
    expect(result).toEqual(["第1章 (final): 正文"])
  })

  it("recentSummaryWindow 为 0/缺省 → 取 || 2 窗口合成 draft 摘要", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("第二章 draft 内容")
    const result = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 0 },
    })
    expect(result.some((s) => s.includes("第二章"))).toBe(true)
  })
})

describe("fallbackPreviousEndingDataSource 边界", () => {
  it("chapterNumber <= 1 或缺失 → 空串", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "x.md" }])
    await expect(fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 1 })).resolves.toBe("")
    await expect(fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })

  it("wiki 命中上一章 → 取正文尾部 30 行 excerpt; 无 frontmatter 全文作为正文", async () => {
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-2.md")])
    mocks.readFile.mockResolvedValue(
      "---\ntype: chapter\nchapter_number: 2\nstatus: final\n---\n第2章行一\n第2章行二\n结尾钩子",
    )
    const ending = await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3 })
    expect(ending).toContain("结尾钩子")

    mocks.readFile.mockResolvedValue("无 frontmatter 的结尾行\n真正的钩子")
    const ending2 = await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3 })
    expect(ending2).toContain("真正的钩子")
  })

  it("正式目录抛错 → recordGap; draft 有正文 → 取 draft 结尾", async () => {
    const recordGap = vi.fn()
    mocks.listDirectory.mockRejectedValue(new Error("directory down"))
    mocks.readFile.mockResolvedValue("draft 前文\ndraft 结尾钩子")
    const ending = await fallbackPreviousEndingDataSource.load({
      ...context,
      chapterNumber: 3,
      recordGap,
    })
    expect(ending).toContain("draft 结尾钩子")
    expect(recordGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("正式目录与 draft 读取失败 → 空串且只有一条 gap", async () => {
    const recordGap = vi.fn()
    mocks.listDirectory.mockRejectedValue(new Error("directory down"))
    mocks.readFile.mockRejectedValue(new Error("no draft"))
    await expect(
      fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3, recordGap }),
    ).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledExactlyOnceWith("fallbackPreviousEnding", "datasource_error")
  })

  it("wiki 与 draft 均缺失 → 空串", async () => {
    mocks.searchWiki.mockResolvedValue([])
    mocks.readFile.mockRejectedValue(new Error("no draft file"))
    await expect(fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3 })).resolves.toBe("")
  })
})

describe("fallbackForeshadowingStatesDataSource 读取失败", () => {
  it("部分文件读取失败 → 过滤后 join", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "f1.md" }, { path: "f2.md" }])
    mocks.readFile.mockResolvedValueOnce("伏笔A").mockRejectedValueOnce(new Error("boom"))
    const result = await fallbackForeshadowingStatesDataSource.load(context)
    expect(result).toBe("伏笔A")
  })
})

describe("canonRulesDataSource", () => {
  it("命中 → readFile slice 2000; 未命中 → 空串; 抛错 → recordGap", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "rules.md" }])
    mocks.readFile.mockResolvedValue("正史规则内容")
    await expect(canonRulesDataSource.load(context)).resolves.toBe("正史规则内容")

    mocks.searchWiki.mockResolvedValue([])
    await expect(canonRulesDataSource.load(context)).resolves.toBe("")

    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("down"))
    await expect(canonRulesDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("canonRules", "datasource_error")
  })
})

describe("writingStyleDataSource 错误分支", () => {
  it("buildWritingStyleContext 抛错 → recordGap + wiki 回退", async () => {
    const recordGap = vi.fn()
    mocks.buildWritingStyleContext.mockRejectedValue(new Error("style store down"))
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/style.md" }])
    mocks.readFile.mockResolvedValue("wiki 风格回退")
    await expect(writingStyleDataSource.load({ ...context, recordGap })).resolves.toBe("wiki 风格回退")
    expect(recordGap).toHaveBeenCalledWith("writingStyle", "datasource_error")
  })

  it("全部失败 → 空串 (recordGap 两次)", async () => {
    const recordGap = vi.fn()
    mocks.buildWritingStyleContext.mockRejectedValue(new Error("style store down"))
    mocks.searchWiki.mockRejectedValue(new Error("wiki down"))
    await expect(writingStyleDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledTimes(2)
  })

  it("wiki 未命中 → 空串", async () => {
    mocks.buildWritingStyleContext.mockResolvedValue("")
    mocks.searchWiki.mockResolvedValue([])
    await expect(writingStyleDataSource.load(context)).resolves.toBe("")
  })
})

describe("searchResultsDataSource / graphSearchResultsDataSource", () => {
  it("searchResultsDataSource 透传 unified 搜索结果及 DI 选项（novelConfig / recordGap / buildSession）", async () => {
    const recordGap = vi.fn()
    mocks.searchRelevantContentUnified.mockResolvedValue("相关正文")
    await expect(searchResultsDataSource.load({ ...context, recordGap })).resolves.toBe("相关正文")
    expect(mocks.searchRelevantContentUnified).toHaveBeenCalledWith(
      "E:/Novel",
      "生成第三章正文",
      3,
      5,
      expect.objectContaining({
        novelConfig: context.novelConfig,
        embeddingConfig: context.embeddingConfig,
        rerankConfig: context.rerankConfig,
        recordGap,
        buildSession: context.buildSession,
      }),
    )
  })

  it("searchResultsDataSource 异常时记录 IC-02 datasource_error gap 并降级空串", async () => {
    const recordGap = vi.fn()
    mocks.searchRelevantContentUnified.mockRejectedValueOnce(new Error("search down"))
    await expect(searchResultsDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("searchResults", "datasource_error")
  })

  it("graphSearchResultsDataSource 透传图谱搜索结果及 gap 记录器，异常记录 datasource_error", async () => {
    const recordGap = vi.fn()
    mocks.searchGraphRelevantContent.mockResolvedValueOnce("图谱正文")
    await expect(graphSearchResultsDataSource.load({ ...context, recordGap })).resolves.toBe("图谱正文")
    expect(mocks.searchGraphRelevantContent).toHaveBeenCalledWith("E:/Novel", "生成第三章正文", 3, {
      recordGap,
      buildSession: context.buildSession,
    })

    mocks.searchGraphRelevantContent.mockRejectedValueOnce(new Error("graph down"))
    await expect(graphSearchResultsDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("graphSearchResults", "datasource_error")
  })
})

describe("revisionFeedbackDataSource", () => {
  it("无 chapterNumber → 空反馈对象（C2 类型债：createEmptyRevisionFeedback 替代裸 []）", async () => {
    await expect(
      revisionFeedbackDataSource.load({ ...context, chapterNumber: undefined }),
    ).resolves.toEqual({ mustFix: [], shouldImprove: [], carryToNextChapter: [] })
  })

  it("有 chapterNumber → loadRevisionFeedbackForContext 结果", async () => {
    mocks.loadRevisionFeedbackForContext.mockResolvedValue([{ feedback: "f" }])
    await expect(revisionFeedbackDataSource.load(context)).resolves.toEqual([{ feedback: "f" }])
    expect(mocks.loadRevisionFeedbackForContext).toHaveBeenCalledWith("E:/Novel", 3, { ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG })
  })
})

describe("cognitionTextDataSource", () => {
  it("state 为空 → 空串; state 非空 → 渲染文本", async () => {
    mocks.loadCognitionState.mockResolvedValue(null)
    await expect(cognitionTextDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")

    mocks.loadCognitionState.mockResolvedValue({ version: 1 })
    mocks.cognitionToContextText.mockReturnValue("认知文本")
    await expect(cognitionTextDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("认知文本")
  })

  it("loadCognitionState 抛错 → recordGap + 空串", async () => {
    const recordGap = vi.fn()
    mocks.loadCognitionState.mockRejectedValue(new Error("state down"))
    await expect(cognitionTextDataSource.load({ ...context, chapterNumber: undefined, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("cognitionText", "datasource_error")
  })
})

describe("soulDocDataSource / characterAurasDataSource / getAllDataSources", () => {
  it("soulDocDataSource 透传 readSoulDoc", async () => {
    mocks.readSoulDoc.mockResolvedValue("灵魂文档")
    await expect(soulDocDataSource.load(context)).resolves.toBe("灵魂文档")
  })

  it("characterAurasDataSource 返回空串 (占位)", async () => {
    await expect(characterAurasDataSource.load(context)).resolves.toBe("")
  })

  it("getAllDataSources 返回全部 20 个数据源", async () => {
    const sources = getAllDataSources()
    expect(sources).toHaveLength(20)
    expect(sources.map((s) => s.name)).toEqual([
      "outline",
      "chapterOutline",
      "volumeContext",
      "snapshots",
      "recentChapterContents",
      "fallbackRecentSummaries",
      "fallbackPreviousEnding",
      "fallbackCharacterStates",
      "fallbackForeshadowingStates",
      "fallbackTimeline",
      "relatedSettings",
      "canonRules",
      "writingStyle",
      "searchResults",
      "graphSearchResults",
      "revisionFeedback",
      "cognitionText",
      "soulDoc",
      "characterAuras",
      "storySimulationBinding",
    ])
  })
})

describe("storySimulationBindingDataSource", () => {
  it("无 chapterNumber 或小于等于 0 时返回空串", async () => {
    await expect(storySimulationBindingDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")
    await expect(storySimulationBindingDataSource.load({ ...context, chapterNumber: 0 })).resolves.toBe("")
  })

  it("无激活框架绑定或文件读取失败时返回空串", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("not found"))
    await expect(storySimulationBindingDataSource.load({ ...context, chapterNumber: 3 })).resolves.toBe("")
  })

  it("命中章节分配时返回故事框架指引与阶段任务", async () => {
    const mockBinding = JSON.stringify({
      frameworkId: "fw-1",
      frameworkTitle: "逆天反击战",
      targetChapterCount: 10,
      chapterAllocation: [
        { nodeIndex: 1, nodeTitle: "深渊苏醒", startChapter: 1, endChapter: 3 },
        { nodeIndex: 2, nodeTitle: "探寻真相", startChapter: 4, endChapter: 7 },
      ],
      boundAt: "2026-09-29T00:00:00Z",
    })
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (typeof filePath === "string" && filePath.includes("active-binding.json")) return mockBinding
      return ""
    })

    const result = await storySimulationBindingDataSource.load({ ...context, chapterNumber: 2 })
    expect(result).toContain("## 故事模拟框架指引")
    expect(result).toContain("逆天反击战")
    expect(result).toContain("第1-3章")
    expect(result).toContain("深渊苏醒")
  })
})

describe("IC-02 gaps 恰好一次 (P0)", () => {
  it("storySimulationBinding: 绑定损坏导致装配抛错 → 空串 + 恰一条 gap", async () => {
    const recordGap = vi.fn()
    // loadBinding 内部吞错返回 null（文件缺失=合法无绑定，不记 gap）；
    // 此处用畸形 chapterAllocation（非数组）触发装配期 TypeError，
    // 覆盖外层 catch 这一真正的全源失败路径。
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ frameworkId: "fw-1", frameworkTitle: "坏绑定", chapterAllocation: {} }),
    )
    await expect(
      storySimulationBindingDataSource.load({ ...context, chapterNumber: 3, recordGap }),
    ).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledTimes(1)
    expect(recordGap).toHaveBeenCalledWith("storySimulationBinding", "datasource_error")
  })

  it("storySimulationBinding: 无绑定文件 → 空串 + 零 gap（合法空值非失败）", async () => {
    const recordGap = vi.fn()
    mocks.readFile.mockRejectedValue(new Error("not found"))
    await expect(
      storySimulationBindingDataSource.load({ ...context, chapterNumber: 3, recordGap }),
    ).resolves.toBe("")
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("storySimulationBinding: 成功命中 → 零 gap", async () => {
    const recordGap = vi.fn()
    const mockBinding = JSON.stringify({
      frameworkId: "fw-1",
      frameworkTitle: "逆天反击战",
      targetChapterCount: 10,
      chapterAllocation: [
        { nodeIndex: 1, nodeTitle: "深渊苏醒", startChapter: 1, endChapter: 3 },
      ],
      boundAt: "2026-09-29T00:00:00Z",
    })
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (typeof filePath === "string" && filePath.includes("active-binding.json")) return mockBinding
      return ""
    })
    const result = await storySimulationBindingDataSource.load({ ...context, chapterNumber: 2, recordGap })
    expect(result).toContain("故事模拟框架指引")
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("recentChapterContents: 单章抛错 → 其余保留 + 恰一条 gap", async () => {
    const recordGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-1.md"), chapterNode("chapter-2.md")])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === "E:/Novel/wiki/chapters/chapter-2.md") return "---\ntype: chapter\nchapter_number: 2\nstatus: final\n---\n第二章正文"
      throw new Error(`read fail ${p}`)
    })
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 2 },
      recordGap,
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toContain("第二章正文")
    expect(recordGap).toHaveBeenCalledTimes(1)
    expect(recordGap).toHaveBeenCalledWith("recentChapterContents", "datasource_error")
  })

  it("recentChapterContents: 全成功 → 零 gap", async () => {
    const recordGap = vi.fn()
    mocks.listDirectory.mockResolvedValue([chapterNode("chapter-1.md"), chapterNode("chapter-2.md")])
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n正文内容")
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 3,
      config: { ...context.config, recentSummaryWindow: 2 },
      recordGap,
    })
    expect(result).toHaveLength(2)
    expect(recordGap).not.toHaveBeenCalled()
  })

  it("fallbackRecentSummaries: 单条目读取失败 → 其余保留 + 恰一条 gap", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockResolvedValue([{ path: "c1.md" }, { path: "c2.md" }])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === "c1.md") throw new Error("c1 down")
      return "---\ntype: chapter\nchapter_number: 2\nchapter_status: final\n---\n第二章正文"
    })
    const result = await fallbackRecentSummariesDataSource.load({ ...context, recordGap })
    expect(result).toEqual(["第2章 (final): 第二章正文"])
    expect(recordGap).toHaveBeenCalledTimes(1)
    expect(recordGap).toHaveBeenCalledWith("fallbackRecentSummaries", "datasource_error")
  })

  it("fallbackRecentSummaries: searchWiki 抛错 → 恰一条 gap（条目 flag 未置，无重复计数）", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("index down"))
    const result = await fallbackRecentSummariesDataSource.load({
      ...context,
      chapterNumber: undefined,
      recordGap,
    })
    expect(result).toEqual([])
    expect(recordGap).toHaveBeenCalledTimes(1)
    expect(recordGap).toHaveBeenCalledWith("fallbackRecentSummaries", "datasource_error")
  })

  it("fallbackCharacterStates: 结构化与 wiki 双败 → 仍恰一条（首 catch soft 不重复计数）", async () => {
    const recordGap = vi.fn()
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockRejectedValue(new Error("index down"))
    await expect(fallbackCharacterStatesDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledTimes(1)
    expect(recordGap).toHaveBeenCalledWith("fallbackCharacterStates", "datasource_error")
  })
})
