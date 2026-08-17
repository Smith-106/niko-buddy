import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextLoadContext } from "./context-data-source"
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
  getAllDataSources,
} from "./context-data-sources"

const mocks = vi.hoisted(() => ({
  buildWritingStyleContext: vi.fn(),
  readFile: vi.fn(),
  searchWiki: vi.fn(),
  listSnapshots: vi.fn(),
  loadSnapshot: vi.fn(),
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

vi.mock("./volume", () => ({
  getChapterVolumes: mocks.getChapterVolumes,
}))

vi.mock("./revision-feedback", () => ({
  loadRevisionFeedbackForContext: mocks.loadRevisionFeedbackForContext,
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

vi.mock("./context-engine", () => ({
  readOutlineContent: mocks.readOutlineContent,
  readChapterOutlineContent: mocks.readChapterOutlineContent,
  searchRelevantContentUnified: mocks.searchRelevantContentUnified,
  searchGraphRelevantContent: mocks.searchGraphRelevantContent,
  selectLookbackChapterNumbers: mocks.selectLookbackChapterNumbers,
  joinNonEmpty: mocks.joinNonEmpty,
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

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.joinNonEmpty.mockImplementation((parts: string[], sep: string) =>
    parts.map((p) => String(p).trim()).filter(Boolean).join(sep),
  )
})

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

  it("chapterOutlineDataSource.load: 无 chapterNumber 返回空串, 有则读章节大纲", async () => {
    await expect(chapterOutlineDataSource.load({ ...context, chapterNumber: undefined })).resolves.toBe("")
    mocks.readChapterOutlineContent.mockResolvedValue("第三章细纲")
    await expect(chapterOutlineDataSource.load(context)).resolves.toBe("第三章细纲")
    expect(mocks.readChapterOutlineContent).toHaveBeenCalledWith("E:/Novel", 3)
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
})

describe("fallbackCharacterStatesDataSource", () => {
  it("结构化 character-states.json 非空时优先 → slice 3000", async () => {
    mocks.loadCharacterStates.mockResolvedValue({ entries: {} })
    mocks.characterStatesToContextText.mockReturnValue("结构化角色状态".repeat(100))
    const result = await fallbackCharacterStatesDataSource.load(context)
    expect(result).toBe("结构化角色状态".repeat(100).slice(0, 3000))
  })

  it("结构化为空/抛错 → wiki entity 页回退", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/entities/a.md" }])
    mocks.readFile.mockResolvedValue("角色页内容")
    const result = await fallbackCharacterStatesDataSource.load(context)
    expect(result).toContain("角色页内容")
  })

  it("wiki 搜索抛错 → recordGap + 空串", async () => {
    mocks.loadCharacterStates.mockResolvedValue({ entries: {} })
    mocks.characterStatesToContextText.mockReturnValue("")
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("index down"))
    await expect(fallbackCharacterStatesDataSource.load({ ...context, recordGap })).resolves.toBe("")
    expect(recordGap).toHaveBeenCalledWith("fallbackCharacterStates", "datasource_error")
  })

  it("wiki 无结果 → 空串", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([])
    await expect(fallbackCharacterStatesDataSource.load(context)).resolves.toBe("")
  })

  it("readFile 单页失败不影响其余页 (catch(() => ''))", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("missing"))
    mocks.searchWiki.mockResolvedValue([{ path: "a.md" }, { path: "b.md" }])
    mocks.readFile.mockImplementation(async (p: string) => (p === "a.md" ? "A 页" : Promise.reject(new Error("boom"))))
    const result = await fallbackCharacterStatesDataSource.load(context)
    expect(result).toContain("A 页")
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
  })

  it("wiki 命中但正文为空 → 回退 draft; draft 也空 → null 丢弃", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/chapter-1.md" }])
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

  it("searchWiki 抛错 → null 丢弃", async () => {
    mocks.searchWiki.mockRejectedValue(new Error("wiki down"))
    const result = await recentChapterContentsDataSource.load({
      ...context,
      chapterNumber: 2,
      config: { ...context.config, recentSummaryWindow: 1 },
    })
    expect(result).toEqual([])
  })

  it("readFile 抛错 → null 丢弃", async () => {
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/chapter-1.md" }])
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
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/chapter-2.md" }])
    mocks.readFile.mockResolvedValue(
      "---\ntype: chapter\nchapter_number: 2\nstatus: final\n---\n第2章行一\n第2章行二\n结尾钩子",
    )
    const ending = await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3 })
    expect(ending).toContain("结尾钩子")

    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/chapter-2.md" }])
    mocks.readFile.mockResolvedValue("无 frontmatter 的结尾行\n真正的钩子")
    const ending2 = await fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3 })
    expect(ending2).toContain("真正的钩子")
  })

  it("searchWiki 抛错 → recordGap; draft 有正文 → 取 draft 结尾", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("wiki down"))
    mocks.readFile.mockResolvedValue("draft 前文\ndraft 结尾钩子")
    const ending = await fallbackPreviousEndingDataSource.load({
      ...context,
      chapterNumber: 3,
      recordGap,
    })
    expect(ending).toContain("draft 结尾钩子")
    expect(recordGap).toHaveBeenCalledWith("fallbackPreviousEnding", "datasource_error")
  })

  it("searchWiki 抛错且 draft 为空 → 空串", async () => {
    const recordGap = vi.fn()
    mocks.searchWiki.mockRejectedValue(new Error("wiki down"))
    mocks.readFile.mockRejectedValue(new Error("no draft"))
    await expect(
      fallbackPreviousEndingDataSource.load({ ...context, chapterNumber: 3, recordGap }),
    ).resolves.toBe("")
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
  it("searchResultsDataSource 透传 unified 搜索结果", async () => {
    mocks.searchRelevantContentUnified.mockResolvedValue("相关正文")
    await expect(searchResultsDataSource.load(context)).resolves.toBe("相关正文")
    expect(mocks.searchRelevantContentUnified).toHaveBeenCalledWith("E:/Novel", "生成第三章正文", 3, 5)
  })

  it("graphSearchResultsDataSource 透传图谱搜索结果", async () => {
    mocks.searchGraphRelevantContent.mockResolvedValue("图谱正文")
    await expect(graphSearchResultsDataSource.load(context)).resolves.toBe("图谱正文")
    expect(mocks.searchGraphRelevantContent).toHaveBeenCalledWith("E:/Novel", "生成第三章正文", 3)
  })
})

describe("revisionFeedbackDataSource", () => {
  it("无 chapterNumber → []", async () => {
    await expect(
      revisionFeedbackDataSource.load({ ...context, chapterNumber: undefined }),
    ).resolves.toEqual([])
  })

  it("有 chapterNumber → loadRevisionFeedbackForContext 结果", async () => {
    mocks.loadRevisionFeedbackForContext.mockResolvedValue([{ feedback: "f" }])
    await expect(revisionFeedbackDataSource.load(context)).resolves.toEqual([{ feedback: "f" }])
    expect(mocks.loadRevisionFeedbackForContext).toHaveBeenCalledWith("E:/Novel", 3, {})
  })
})

describe("cognitionTextDataSource", () => {
  it("state 为空 → 空串; state 非空 → 渲染文本", async () => {
    mocks.loadCognitionState.mockResolvedValue(null)
    await expect(cognitionTextDataSource.load(context)).resolves.toBe("")

    mocks.loadCognitionState.mockResolvedValue({ version: 1 })
    mocks.cognitionToContextText.mockReturnValue("认知文本")
    await expect(cognitionTextDataSource.load(context)).resolves.toBe("认知文本")
  })

  it("loadCognitionState 抛错 → recordGap + 空串", async () => {
    const recordGap = vi.fn()
    mocks.loadCognitionState.mockRejectedValue(new Error("state down"))
    await expect(cognitionTextDataSource.load({ ...context, recordGap })).resolves.toBe("")
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

  it("getAllDataSources 返回全部 18 个数据源", async () => {
    const sources = getAllDataSources()
    expect(sources).toHaveLength(18)
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
    ])
  })
})
