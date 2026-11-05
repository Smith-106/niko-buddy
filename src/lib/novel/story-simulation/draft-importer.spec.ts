/**
 * importDraftToChapters 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：全量导入/frontmatter 生成/标题前缀与转义/起始章节号/选择性导入/
 * 空选择抛错/覆盖与备份/备份失败继续/进度回调/autoIngest 成功与单章失败。
 * 文件写入与章节工具一律 mock，不触碰真实文件系统，不调用 LLM。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createDirectory,
  writeFileAtomic,
  fileExists,
  readFile,
} from "@/commands/fs"
import { getNextChapterNumber } from "@/lib/novel/chapter-utils"
import { backupChapterFile } from "@/lib/novel/chapter-backup"
import { ingestChapter } from "@/lib/novel/chapter-ingest"
import { defaultCanonDualWriteDeps } from "@/lib/novel/canon-dual-write"
import type { StoryDraft, StoryFramework } from "./types"
import { importDraftToChapters } from "./draft-importer"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
  fileExists: vi.fn(async () => false),
  readFile: vi.fn(async () => ""),
}))

vi.mock("@/lib/novel/chapter-utils", () => ({
  getNextChapterNumber: vi.fn(async () => 7),
}))

vi.mock("@/lib/novel/chapter-backup", () => ({
  backupChapterFile: vi.fn(async () => "/proj/.niko-buddy/chapter-backups/chapter-007-stamp-template.md"),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  ingestChapter: vi.fn(async () => undefined),
}))

vi.mock("@/lib/novel/canon-dual-write", () => ({
  defaultCanonDualWriteDeps: vi.fn(() => ({ tag: "deps" })),
}))

const mockedMkdir = vi.mocked(createDirectory)
const mockedWrite = vi.mocked(writeFileAtomic)
const mockedExists = vi.mocked(fileExists)
const mockedRead = vi.mocked(readFile)
const mockedNext = vi.mocked(getNextChapterNumber)
const mockedBackup = vi.mocked(backupChapterFile)
const mockedIngest = vi.mocked(ingestChapter)
const mockedDeps = vi.mocked(defaultCanonDualWriteDeps)

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

function writtenFiles(): Array<{ path: string; content: string }> {
  return mockedWrite.mock.calls.map(([p, c]) => ({
    path: String(p),
    content: String(c),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks 不恢复实现，此处显式复位跨用例残留
  mockedMkdir.mockResolvedValue(undefined)
  mockedWrite.mockResolvedValue(undefined)
  mockedExists.mockResolvedValue(false)
  mockedRead.mockRejectedValue(new Error("not found"))
  mockedNext.mockResolvedValue(7)
  mockedBackup.mockResolvedValue(
    "/proj/.niko-buddy/chapter-backups/chapter-007-stamp-template.md",
  )
  mockedIngest.mockResolvedValue({ snapshot: null })
  mockedDeps.mockReturnValue({ tag: "deps" } as unknown as ReturnType<typeof defaultCanonDualWriteDeps>)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

describe("importDraftToChapters 全量导入", () => {
  it("自动起始章节号导入全部章节并生成 frontmatter", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft())

    expect(mockedNext).toHaveBeenCalledWith("/proj")
    expect(result.startChapter).toBe(7)
    expect(result.importedCount).toBe(3)
    expect(result.chapterPaths).toEqual([
      "/proj/wiki/chapters/chapter-007.md",
      "/proj/wiki/chapters/chapter-008.md",
      "/proj/wiki/chapters/chapter-009.md",
    ])
    expect(result.backedUpPaths).toEqual([])
    expect(mockedMkdir).toHaveBeenCalledWith("/proj/wiki/chapters")
    expect(writtenFiles()).toHaveLength(3)

    const first = writtenFiles()[0]!.content
    expect(first).toContain("type: chapter")
    expect(first).toContain("chapter_number: 7")
    expect(first).toContain("chapter_status: draft")
    // 不以"第"开头的标题自动加前缀
    expect(first).toContain('title: "第7章 启程"')
    expect(first).toContain("# 第7章 启程")
    expect(first).toContain("source: story-simulation")
    expect(first).toContain('framework_id: "fw-1"')
    // 框架标题中的引号被转义
    expect(first).toContain('framework_title: "框架\\"标题\\""')
    expect(first).toContain("created: ")
    expect(first).toContain("第一章正文")
  })

  it("已带「第」前缀的标题不重复加前缀", async () => {
    await importDraftToChapters("/proj", framework(), draft())
    const second = writtenFiles()[1]!.content
    expect(second).toContain('title: "第9章 决战"')
    expect(second).not.toContain("第8章 第9章")
  })

  it("显式 startChapter 覆盖自动编号", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 3,
    })
    expect(mockedNext).not.toHaveBeenCalled()
    expect(result.startChapter).toBe(3)
    expect(result.chapterPaths[0]).toBe("/proj/wiki/chapters/chapter-003.md")
  })

  it("空草稿抛错", async () => {
    await expect(
      importDraftToChapters("/proj", framework(), { ...draft(), chapters: [] }),
    ).rejects.toThrow("未选择任何章节")
    expect(mockedWrite).not.toHaveBeenCalled()
  })
})

describe("importDraftToChapters 选择性导入", () => {
  it("只导入选中索引且章节号连续分配", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 5,
      selectedIndices: [0, 2],
    })
    expect(result.importedCount).toBe(2)
    expect(result.chapterPaths).toEqual([
      "/proj/wiki/chapters/chapter-005.md",
      "/proj/wiki/chapters/chapter-006.md",
    ])
    expect(writtenFiles()[0]!.content).toContain("第一章正文")
    expect(writtenFiles()[1]!.content).toContain("第三章正文")
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

describe("importDraftToChapters 覆盖与备份", () => {
  it("文件已存在且未开覆盖时抛错", async () => {
    mockedExists.mockResolvedValueOnce(true)
    await expect(
      importDraftToChapters("/proj", framework(), draft(), { startChapter: 1 }),
    ).rejects.toThrow("章节文件已存在：chapter-001.md")
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it("覆盖模式先备份再写入并返回备份路径", async () => {
    mockedExists.mockResolvedValue(true)
    mockedRead.mockResolvedValue("旧正文")
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 7,
      overwrite: true,
    })
    expect(mockedBackup).toHaveBeenCalledTimes(3)
    expect(mockedBackup.mock.calls[0]?.[0]).toMatchObject({
      projectPath: "/proj",
      chapterPath: "/proj/wiki/chapters/chapter-007.md",
      chapterNumber: 7,
      content: "旧正文",
      source: "template",
    })
    expect(result.backedUpPaths).toHaveLength(3)
    expect(mockedWrite).toHaveBeenCalledTimes(3)
  })

  it("备份失败时告警但继续覆盖", async () => {
    mockedExists.mockResolvedValue(true)
    mockedRead.mockResolvedValue("旧正文")
    mockedBackup.mockRejectedValueOnce(new Error("disk full"))
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      startChapter: 7,
      overwrite: true,
    })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("备份 chapter-007.md 失败"),
    )
    expect(result.importedCount).toBe(3)
    expect(result.backedUpPaths).toHaveLength(2)
  })
})

describe("importDraftToChapters 自动摄取", () => {
  const llmConfig = { provider: "x", model: "m-test", apiKey: "k" } as unknown as import("@/stores/wiki-store").LlmConfig

  it("autoIngest 为空时不加载摄取模块", async () => {
    await importDraftToChapters("/proj", framework(), draft())
    expect(mockedDeps).not.toHaveBeenCalled()
    expect(mockedIngest).not.toHaveBeenCalled()
  })

  it("autoIngest 开启时逐章摄取", async () => {
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      autoIngest: true,
      llmConfig,
    })
    expect(result.importedCount).toBe(3)
    expect(mockedDeps).toHaveBeenCalledTimes(3)
    expect(mockedIngest).toHaveBeenCalledTimes(3)
    expect(mockedIngest.mock.calls[0]?.slice(0, 3)).toEqual([
      "/proj",
      "/proj/wiki/chapters/chapter-007.md",
      "m-test",
    ])
  })

  it("llmConfig 缺 model 时回退默认模型名", async () => {
    const noModel = { provider: "x", apiKey: "k" } as unknown as import("@/stores/wiki-store").LlmConfig
    await importDraftToChapters("/proj", framework(), draft(), {
      autoIngest: true,
      llmConfig: noModel,
    })
    expect(mockedIngest).toHaveBeenCalledTimes(3)
    expect(mockedIngest.mock.calls[0]?.[2]).toBe("default")
  })

  it("单章摄取失败时告警并继续其余章节", async () => {
    mockedIngest.mockRejectedValueOnce(new Error("llm down"))
    const result = await importDraftToChapters("/proj", framework(), draft(), {
      autoIngest: true,
      llmConfig,
    })
    expect(result.importedCount).toBe(3)
    expect(mockedIngest).toHaveBeenCalledTimes(3)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("自动摄取"),
      expect.anything(),
    )
  })
})

describe("importDraftToChapters 摄取模块加载失败", () => {
  // 必须位于文件末尾：vi.resetModules + vi.doMock 会影响本文件后续动态导入，
  // 此处之后不再有 autoIngest 用例，故放在最后。
  it("动态导入失败时告警且仍返回导入结果", async () => {
    vi.resetModules()
    vi.doMock("@/lib/novel/chapter-ingest", () => {
      throw new Error("module load fail")
    })
    vi.doMock("@/commands/fs", () => ({
      createDirectory: vi.fn(async () => undefined),
      writeFileAtomic: vi.fn(async () => undefined),
      fileExists: vi.fn(async () => false),
      readFile: vi.fn(async () => ""),
    }))
    vi.doMock("@/lib/novel/chapter-utils", () => ({
      getNextChapterNumber: vi.fn(async () => 7),
    }))
    vi.doMock("@/lib/novel/chapter-backup", () => ({
      backupChapterFile: vi.fn(async () => "bak"),
    }))

    const fresh = await import("./draft-importer")
    const llmConfig = { provider: "x", model: "m", apiKey: "k" } as unknown as import("@/stores/wiki-store").LlmConfig
    const result = await fresh.importDraftToChapters("/proj", framework(), draft(), {
      autoIngest: true,
      llmConfig,
    })
    expect(result.importedCount).toBe(3)
    expect(console.warn).toHaveBeenCalledWith(
      "[draft-import] 加载章节摄取模块失败:",
      expect.anything(),
    )
  })
})
