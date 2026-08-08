import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextLoadContext } from "./context-data-source"
import {
  fallbackPreviousEndingDataSource,
  fallbackRecentSummariesDataSource,
  recentChapterContentsDataSource,
  writingStyleDataSource,
} from "./context-data-sources"

const mocks = vi.hoisted(() => ({
  buildWritingStyleContext: vi.fn(),
  readFile: vi.fn(),
  searchWiki: vi.fn(),
}))

vi.mock("./writing-style-store", () => ({
  buildWritingStyleContext: mocks.buildWritingStyleContext,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
}))

vi.mock("@/lib/search", () => ({
  searchWiki: mocks.searchWiki,
}))

const context: ContextLoadContext = {
  projectPath: "E:/Novel",
  task: "生成第三章正文",
  chapterNumber: 3,
  config: {
    recentSummaryWindow: 8,
    searchTopK: 5,
    snapshotLookback: 3,
    revisionFeedbackWindowConfig: {},
  },
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
    mocks.searchWiki.mockImplementation(async (_projectPath: string, query: string) => {
      const matched = query.match(/chapter_number:(\d+)/)
      return matched ? [{ path: `E:/Novel/wiki/chapters/chapter-${matched[1]}.md` }] : []
    })
    mocks.readFile.mockImplementation(async (path: string) => {
      const matched = path.match(/chapter-(\d+)\.md$/)
      const number = matched?.[1] ?? "0"
      return `---\ntype: chapter\nchapter_number: ${number}\nstatus: final\n---\n第${number}章正文开头\n第${number}章正文关键事实\n第${number}章正文结尾`
    })

    const result = await recentChapterContentsDataSource.load(chapterContext)

    expect(result).toHaveLength(5)
    expect(result[0]).toContain("第1章正文关键事实")
    expect(result[4]).toContain("第5章正文结尾")
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "chapter_number:1")
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "chapter_number:5")
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
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/chapter-1.md" }])
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
})
