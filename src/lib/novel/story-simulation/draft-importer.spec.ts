/**
 * importDraftToChapters 真实行为测试（Draft-first 边界加固）。
 * 覆盖：全部路由至 writeDraft(.qm-drafts/) / 零 writeFileAtomic 覆写 /
 * 标题前缀规范化 / 起始章节号 / 选择性导入 / 空选择抛错 / 进度回调 /
 * autoIngest 严格延期告警且零 ingestChapter 调用 / utils.todayStamp 来源日期。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { writeFileAtomic } from "@/commands/fs"
import { getNextChapterNumber } from "@/lib/novel/chapter-utils"
import { ingestChapter } from "@/lib/novel/chapter-ingest"
import { logger, todayStamp } from "@/lib/utils"
import { writeDraft } from "../draft-manager"
import type { StoryDraft, StoryFramework } from "./types"
import { importDraftToChapters } from "./draft-importer"

vi.mock("@/commands/fs", () => ({
  writeFileAtomic: vi.fn(async () => undefined),
}))

vi.mock("@/lib/novel/chapter-utils", () => ({
  getNextChapterNumber: vi.fn(async () => 7),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  ingestChapter: vi.fn(async () => undefined),
}))

vi.mock("../draft-manager", () => ({
  writeDraft: vi.fn(),
}))

const mockedWriteAtomic = vi.mocked(writeFileAtomic)
const mockedNext = vi.mocked(getNextChapterNumber)
const mockedIngest = vi.mocked(ingestChapter)
const mockedWriteDraft = vi.mocked(writeDraft)

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: '框架"标题"',
    premise: "前提",
    targetWords: 10000,
    simulationMode: "hybrid",
    sourceChapters: 2,
    nodes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function draft(): StoryDraft {
  return {
    branchId: "b-1",
    frameworkId: "fw-1",
    chapters: [
      { title: "启程", content: "第一章正文", correspondingNode: 0 },
      { title: "第9章 决战", content: "第二章正文", correspondingNode: 1 },
      { title: "尾声", content: "第三章正文", correspondingNode: 1 },
    ],
    totalWords: 3000,
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

function writtenDraftCalls(): Array<{
  projectPath: string
  chapterName: string
  content: string
  meta?: { sourceConversationId?: string }
}> {
  return mockedWriteDraft.mock.calls.map(([projectPath, chapterName, content, meta]) => ({
    projectPath: String(projectPath),
    chapterName: String(chapterName),
    content: String(content),
    meta: meta as { sourceConversationId?: string } | undefined,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriteAtomic.mockResolvedValue(undefined)
  mockedNext.mockResolvedValue(7)
  mockedIngest.mockResolvedValue({ snapshot: null })
  let seq = 0
  mockedWriteDraft.mockImplementation(async (_pp, chapterName, content, meta) => {
    seq += 1
    return {
      id: `draft_sim_${seq}`,
      chapterName,
      content,
      createdAt: seq,
      status: "draft",
      sourceConversationId: meta?.sourceConversationId,
    }
  })
  vi.spyOn(logger, "warn").mockImplementation(() => undefined)
})

describe("importDraftToChapters 全量导入（Draft-first）", () => {
  it("自动起始章节号全部路由至 writeDraft(.qm-drafts/)，零 writeFileAtomic 覆写", async () => {
    const stamp = todayStamp()
    const result = await importDraftToChapters("/proj", framework(), draft())

    expect(mockedNext).toHaveBeenCalledWith("/proj")
    expect(result.startChapter).toBe(7)
    expect(result.importedCount).toBe(3)
    expect(result.routedToDrafts).toBe(true)
    expect(result.draftIds).toEqual(["draft_sim_1", "draft_sim_2", "draft_sim_3"])
    expect(result.chapterPaths).toEqual([
      "/proj/.qm-drafts/draft_sim_1.md",
      "/proj/.qm-drafts/draft_sim_2.md",
      "/proj/.qm-drafts/draft_sim_3.md",
    ])
    expect(result.backedUpPaths).toEqual([])
    expect(mockedWriteAtomic).not.toHaveBeenCalled()
    expect(mockedWriteDraft).toHaveBeenCalledTimes(3)

    const calls = writtenDraftCalls()
    expect(calls[0]).toEqual({
      projectPath: "/proj",
      chapterName: "chapter-007",
      content: "# 第7章 启程\n\n第一章正文\n",
      meta: { sourceConversationId: `story-simulation-fw-1-${stamp}` },
    })
    expect(calls[0]!.content).not.toContain("---")
  })

  it("已带「第」前缀的标题不重复加前缀，且剥离正文误带 frontmatter", async () => {
    const withFm = draft()
    withFm.chapters[1] = {
      title: "第9章 决战",
      content: "---\ntype: chapter\n---\n\n第二章正文",
      correspondingNode: 1,
    }
    await importDraftToChapters("/proj", framework(), withFm)
    const second = writtenDraftCalls()[1]!
    expect(second.chapterName).toBe("chapter-008")
    expect(second.content).toBe("# 第9章 决战\n\n第二章正文\n")
    expect(second.content).not.toContain("第8章 第9章")
    expect(second.content).not.toContain("type: chapter")
  })

  it("显式 startChapter 覆盖自动编号", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 3,
    })
    expect(mockedNext).not.toHaveBeenCalled()
    expect(result.startChapter).toBe(3)
    expect(writtenDraftCalls()[0]!.chapterName).toBe("chapter-003")
    expect(result.chapterPaths[0]).toBe("/proj/.qm-drafts/draft_sim_1.md")
  })

  it("空草稿抛错且零写盘", async () => {
    await expect(
      importDraftToChapters("/proj", framework(), { ...draft(), chapters: [] }),
    ).rejects.toThrow("未选择任何章节")
    expect(mockedWriteDraft).not.toHaveBeenCalled()
    expect(mockedWriteAtomic).not.toHaveBeenCalled()
  })
})

describe("importDraftToChapters 选择性导入", () => {
  it("只导入选中索引且章节号连续分配", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 5,
      selectedIndices: [0, 2],
    })
    expect(result.importedCount).toBe(2)
    expect(result.draftIds).toEqual(["draft_sim_1", "draft_sim_2"])
    expect(result.chapterPaths).toEqual([
      "/proj/.qm-drafts/draft_sim_1.md",
      "/proj/.qm-drafts/draft_sim_2.md",
    ])
    expect(writtenDraftCalls()[0]!.chapterName).toBe("chapter-005")
    expect(writtenDraftCalls()[0]!.content).toContain("第一章正文")
    expect(writtenDraftCalls()[1]!.chapterName).toBe("chapter-006")
    expect(writtenDraftCalls()[1]!.content).toContain("第三章正文")
  })

  it("越界索引被过滤，全越界时抛错", async () => {
    await expect(
      importDraftToChapters("/proj", framework(), draft(), {
        selectedIndices: [-1, 99],
      }),
    ).rejects.toThrow("未选择任何章节")
  })

  it("上报导入进度", async () => {
    const progress: Array<[number, number, string]> = []
    await importDraftToChapters("/proj", framework(), draft(), {
      onProgress: (c, t, title) => progress.push([c, t, title]),
    })
    expect(progress).toEqual([
      [1, 3, "启程"],
      [2, 3, "第9章 决战"],
      [3, 3, "尾声"],
    ])
  })
})

describe("importDraftToChapters Draft-first 防早摄取与无正式覆写", () => {
  const llmConfig = { provider: "x", model: "m-test", apiKey: "k" } as unknown as import("@/stores/wiki-store").LlmConfig

  it("即使开启 autoIngest + 提供 llmConfig 也绝不提前调用 ingestChapter，仅 logger.warn 延期告警", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      autoIngest: true,
      llmConfig,
    })
    expect(result.importedCount).toBe(3)
    expect(result.routedToDrafts).toBe(true)
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(mockedWriteAtomic).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      "draft-import",
      expect.stringContaining("deferred"),
      expect.objectContaining({
        projectPath: "/proj",
        importedCount: 3,
        draftIds: ["draft_sim_1", "draft_sim_2", "draft_sim_3"],
      }),
    )
  })

  it("未开启 autoIngest 时不记录延期告警且零 ingestChapter 调用", async () => {
    await importDraftToChapters("/proj", framework(), draft())
    expect(mockedIngest).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("无论 overwrite 开关如何，所有章节均安全入待审草稿箱且不覆写正式章", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 7,
      overwrite: true,
    })
    expect(result.importedCount).toBe(3)
    expect(result.routedToDrafts).toBe(true)
    expect(result.backedUpPaths).toEqual([])
    expect(mockedWriteAtomic).not.toHaveBeenCalled()
    expect(mockedWriteDraft).toHaveBeenCalledTimes(3)
  })
})
