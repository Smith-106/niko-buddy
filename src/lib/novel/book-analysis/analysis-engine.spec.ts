import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadChapterList,
  loadMetadata,
  splitNovelIntoChapters,
} from "./analysis-engine"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFile: fsMocks.writeFile,
  readFile: fsMocks.readFile,
  listDirectory: fsMocks.listDirectory,
}))

vi.mock("./library-store", () => ({
  findBookLibraryEntry: vi.fn(async () => null),
  upsertBookLibraryEntry: vi.fn(async () => undefined),
}))

import { findBookLibraryEntry, upsertBookLibraryEntry } from "./library-store"

beforeEach(() => {
  for (const mock of Object.values(fsMocks)) mock.mockReset()
  vi.mocked(findBookLibraryEntry).mockResolvedValue(null)
  vi.mocked(upsertBookLibraryEntry).mockResolvedValue(undefined)
})

const sourceText = `第1章 初入江湖
江湖正文开始。
第2章 夜探
夜探正文开始。
第3章 惊变
惊变正文开始。`

describe("splitNovelIntoChapters", () => {
  it("拆分章节 + 写 md 文件 + 元数据 + 注册 library + 进度回调", async () => {
    fsMocks.readFile.mockResolvedValue(sourceText)
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    const onProgress = vi.fn()

    const result = await splitNovelIntoChapters(
      "E:/Novel/raw.txt",
      "E:/Novel",
      { provider: "openai" } as never,
      onProgress,
    )

    expect(result.success).toBe(true)
    expect(result.bookId).toMatch(/^book-/)
    expect(result.metadata.totalChapters).toBe(3)
    expect(result.metadata.totalWords).toBeGreaterThan(0)
    expect(result.metadata.sourceType).toBe("file")
    expect(result.chapters).toHaveLength(3)
    expect(result.chapters[0].title).toBe("第1章 初入江湖")
    expect(result.chapters[0].order).toBe(1)
    expect(result.chapters[0].id).toBe("ch-0001")
    // 目录创建 5 次（book-analysis / bookPath / chapters / characters / skills）
    expect(fsMocks.createDirectory).toHaveBeenCalledTimes(5)
    // 写了 3 个章节 md + 1 个 metadata.json
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(4)
    expect(upsertBookLibraryEntry).toHaveBeenCalledTimes(1)
    // 进度回调：reading_file + splitting_chapters 多阶段
    expect(onProgress).toHaveBeenCalled()
    const stages = onProgress.mock.calls.map((c) => c[0].stage)
    expect(stages).toContain("reading_file")
    expect(stages).toContain("splitting_chapters")
  })

  it("readFile 失败 → throw 读取文件失败", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("not found"))
    await expect(
      splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never),
    ).rejects.toThrow("读取文件失败: not found")
  })

  it("readFile 以非 Error reject → String(error) 拼入异常消息", async () => {
    fsMocks.readFile.mockRejectedValue("io-string")
    await expect(
      splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never),
    ).rejects.toThrow("读取文件失败: io-string")
  })

  it("没有章节标记 → throw", async () => {
    fsMocks.readFile.mockResolvedValue("无章节标记的正文内容。")
    await expect(
      splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never),
    ).rejects.toThrow("未能识别到章节标记")
  })

  it("命中 library 重复 → 复用 bookId 不建目录", async () => {
    fsMocks.readFile.mockResolvedValue(sourceText)
    vi.mocked(findBookLibraryEntry).mockResolvedValue({
      bookId: "book-999",
      sourcePath: "E:/Novel/raw.txt",
      contentHash: "hash",
      title: "raw",
      totalChapters: 3,
      totalWords: 10,
      charactersCount: 1,
      skillsCount: 1,
      status: "completed",
      createdAt: 100,
      updatedAt: 200,
    })

    const result = await splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never, vi.fn())

    expect(result.bookId).toBe("book-999")
    // 复用路径不创建目录
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
    expect(result.metadata.createdAt).toBe(100)
  })

  it("signal aborted → throw 用户取消分析", async () => {
    fsMocks.readFile.mockResolvedValue(sourceText)
    const controller = new AbortController()
    controller.abort()
    await expect(
      splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never, undefined, controller.signal),
    ).rejects.toThrow("用户取消分析")
  })

  it("循环内 signal aborted → throw 用户取消分析（首个章节读取后取消）", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "E:/Novel/raw.txt") return sourceText
      return "章节内容"
    })
    const controller = new AbortController()
    // 在章节循环中（读取第一个章节文件后）触发 abort
    fsMocks.writeFile.mockImplementationOnce(async () => {
      controller.abort()
    })
    fsMocks.writeFile.mockResolvedValue(undefined)
    fsMocks.createDirectory.mockResolvedValue(undefined)

    await expect(
      splitNovelIntoChapters("E:/Novel/raw.txt", "E:/Novel", {} as never, undefined, controller.signal),
    ).rejects.toThrow("用户取消分析")
  })

  it("无文件名（路径以斜杠结尾）→ 未命名作品标题", async () => {
    fsMocks.readFile.mockResolvedValue(sourceText)
    const result = await splitNovelIntoChapters("E:/Novel/", "E:/Novel", {} as never)
    expect(result.metadata.title).toBe("未命名作品")
  })
})

describe("loadChapterList", () => {
  it("解析 md frontmatter + 过滤非 md + 排序 + 缺 wordCount 默认 0", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-0002.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0002.md", is_dir: false },
      { name: "ch-0001.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0001.md", is_dir: false },
      { name: "notes.txt", path: "E:/Novel/book-analysis/b1/chapters/notes.txt", is_dir: false },
      { name: "subdir", path: "E:/Novel/book-analysis/b1/chapters/subdir", is_dir: true },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("ch-0001")) {
        return "---\nid: ch-0001\ntitle: 第1章 初入江湖\norder: 1\nwordCount: 100\n---\n正文"
      }
      if (path.includes("ch-0002")) {
        return "---\nid: ch-0002\ntitle: 第2章 夜探\norder: 2\n---\n正文（无 wordCount）"
      }
      return ""
    })

    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")

    expect(chapters).toHaveLength(2)
    expect(chapters[0].chapterId).toBe("ch-0001")
    expect(chapters[0].order).toBe(1)
    expect(chapters[0].wordCount).toBe(100)
    expect(chapters[0].selected).toBe(false)
    expect(chapters[1].chapterId).toBe("ch-0002")
    expect(chapters[1].wordCount).toBe(0)
  })

  it("单个文件读取失败 → 跳过该章节并记 error", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-0001.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0001.md", is_dir: false },
    ])
    fsMocks.readFile.mockRejectedValue(new Error("io"))

    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })

  it("单个文件以非 Error reject → String(error) 记 error 并跳过", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-0001.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0001.md", is_dir: false },
    ])
    fsMocks.readFile.mockRejectedValue("io-string")

    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })

  it("frontmatter 缺 id/title/order 之一 → 跳过该章节（idMatch && titleMatch && orderMatch 假分支）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-0001.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0001.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValue("---\nid: ch-0001\ntitle: 只有 id 和 title\n---\n正文")

    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })

  it("无 frontmatter 的 md → 跳过", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-0001.md", path: "E:/Novel/book-analysis/b1/chapters/ch-0001.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValue("# 第1章\n没有 frontmatter")

    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })

  it("listDirectory 失败 → 返回空数组", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("no dir"))
    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })

  it("listDirectory 以非 Error reject → String(error) 记 error 并返回空数组", async () => {
    fsMocks.listDirectory.mockRejectedValue("no-dir-string")
    const chapters = await loadChapterList("E:/Novel/book-analysis/b1")
    expect(chapters).toEqual([])
  })
})

describe("loadMetadata", () => {
  it("读取并解析 metadata.json", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      title: "长夜书",
      totalChapters: 3,
      totalWords: 12000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 2,
    }))
    const meta = await loadMetadata("E:/Novel/book-analysis/b1")
    expect(meta?.title).toBe("长夜书")
    expect(meta?.totalChapters).toBe(3)
  })

  it("读取/解析失败 → null", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("missing"))
    expect(await loadMetadata("E:/Novel/book-analysis/b1")).toBeNull()

    fsMocks.readFile.mockResolvedValue("{not-json")
    expect(await loadMetadata("E:/Novel/book-analysis/b1")).toBeNull()
  })

  it("读取以非 Error reject → String(error) 记 error 并返回 null", async () => {
    fsMocks.readFile.mockRejectedValue("missing-string")
    expect(await loadMetadata("E:/Novel/book-analysis/b1")).toBeNull()
  })
})
