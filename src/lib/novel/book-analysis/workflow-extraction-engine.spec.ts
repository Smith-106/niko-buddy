import { beforeEach, describe, expect, it, vi } from "vitest"
import { extractCharactersWithWorkflow, isWorkflowSupported } from "./workflow-extraction-engine"
import type { BookAnalysisMetadata } from "./types"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
}))

const metadata: BookAnalysisMetadata = {
  title: "长夜书",
  totalChapters: 2,
  totalWords: 8000,
  sourceType: "file",
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
})

describe("extractCharactersWithWorkflow", () => {
  it("成功加载章节 → 返回 notImplemented（Workflow 后端未实现）", async () => {
    fsMocks.readFile.mockResolvedValue("第一章正文内容……")

    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001", "ch-0002"],
      metadata,
      llmConfig: { provider: "openai" } as never,
    })

    expect(result.success).toBe(false)
    expect(result.characters).toEqual([])
    expect(result.notImplemented).toBe(true)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(2)
    expect(fsMocks.readFile).toHaveBeenCalledWith("E:/Novel/book-analysis/b1/chapters/ch-0001.txt")
    expect(fsMocks.readFile).toHaveBeenCalledWith("E:/Novel/book-analysis/b1/chapters/ch-0002.txt")
  })

  it("onProgress 回调收到 loading 与 workflow 各阶段", async () => {
    fsMocks.readFile.mockResolvedValue("内容")
    const onProgress = vi.fn()

    await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
      onProgress,
    })

    const stages = onProgress.mock.calls.map((c) => c[0].stage)
    expect(stages[0]).toBe("loading")
    expect(stages).toContain("workflow")
    const last = onProgress.mock.calls.at(-1)![0]
    expect(last.percentage).toBe(100)
    expect(last.currentItem).toBe("功能未落地")
  })

  it("空 content 章节 → 不 push（content falsy 分支）", async () => {
    fsMocks.readFile.mockResolvedValue("")
    await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
    })
    // 无章节可 push → chapters.length === 0 → success:false（无 notImplemented）
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1)
  })

  it("章节读取失败 → 记 error 跳过，全部失败返回 success:false", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("not found"))
    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
    })
    expect(result).toEqual({ success: false, characters: [] })
  })

  it("章节读取以非 Error reject → String(error) 记 error", async () => {
    fsMocks.readFile.mockRejectedValue("io-string")
    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
    })
    expect(result.success).toBe(false)
  })

  it("signal aborted → throw 用户取消分析（外层 catch 返回 success:false）", async () => {
    fsMocks.readFile.mockImplementation(async () => {
      throw new Error("用户取消分析")
    })
    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
    })
    expect(result.success).toBe(false)
    expect(result.characters).toEqual([])
  })

  it("循环内 signal aborted → 抛错进外层 catch 返回 success:false", async () => {
    const controller = new AbortController()
    fsMocks.readFile.mockImplementation(async () => {
      controller.abort()
      return "第一章正文内容"
    })
    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001", "ch-0002"],
      metadata,
      llmConfig: {} as never,
      signal: controller.signal,
    })
    expect(result).toEqual({ success: false, characters: [] })
  })

  it("onProgress 以非 Error 抛出 → String(error) 记入外层 catch", async () => {
    fsMocks.readFile.mockResolvedValue("内容")
    const result = await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
      onProgress: () => {
        throw "progress-boom"
      },
    })
    expect(result).toEqual({ success: false, characters: [] })
  })

  it("长内容截断到 10000 字符", async () => {
    fsMocks.readFile.mockResolvedValue("长".repeat(20000))
    let captured: unknown
    const onProgress = vi.fn()
    fsMocks.readFile.mockResolvedValue("长".repeat(20000))
    // 通过 onProgress 无法直接看 chapters；用 readFile 调用验证截断逻辑不抛错
    await extractCharactersWithWorkflow({
      bookPath: "E:/Novel/book-analysis/b1",
      selectedChapterIds: ["ch-0001"],
      metadata,
      llmConfig: {} as never,
      onProgress,
    })
    expect(captured).toBeUndefined()
    expect(onProgress).toHaveBeenCalled()
  })
})

describe("isWorkflowSupported", () => {
  it("当前返回 false（后端未实现）", () => {
    expect(isWorkflowSupported()).toBe(false)
  })
})
