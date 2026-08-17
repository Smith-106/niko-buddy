import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { startNovelReviewRun } from "./start-review-run"

const mocks = vi.hoisted(() => ({
  reviewChapter: vi.fn(),
  saveGenerationHistoryEntry: vi.fn(),
  persistRevisionFeedbackForChapter: vi.fn(),
  pickRevisionFeedbackFromReviewResults: vi.fn(() => []),
}))

vi.mock("./review-adapter", () => ({
  reviewChapter: mocks.reviewChapter,
}))

vi.mock("./generation-history", () => ({
  saveGenerationHistoryEntry: mocks.saveGenerationHistoryEntry,
}))

vi.mock("./revision-feedback", () => ({
  persistRevisionFeedbackForChapter: mocks.persistRevisionFeedbackForChapter,
  pickRevisionFeedbackFromReviewResults: mocks.pickRevisionFeedbackFromReviewResults,
}))

describe("startNovelReviewRun", () => {
  beforeEach(() => {
    useWikiStore.getState().setReviewRun(null)
    mocks.reviewChapter.mockReset()
    mocks.saveGenerationHistoryEntry.mockReset()
    mocks.persistRevisionFeedbackForChapter.mockReset()
    mocks.pickRevisionFeedbackFromReviewResults.mockReset()
    mocks.pickRevisionFeedbackFromReviewResults.mockReturnValue([])
  })

  it("stores staged review thinking while the review is running", async () => {
    mocks.reviewChapter.mockImplementation(async (
      _projectPath: string,
      _fileContent: string,
      _chapterNumber: number | undefined,
      callbacks: { onThinking?: (content: string) => void },
    ) => {
      callbacks.onThinking?.("## 阶段1：审查任务识别\n正在识别目标章节")
      const current = useWikiStore.getState().reviewRun
      expect(current?.running).toBe(true)
      expect(current?.thinking).toContain("阶段1：审查任务识别")
      return []
    })

    await startNovelReviewRun({
      fileContent: "---\nchapterNumber: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })

    expect(useWikiStore.getState().reviewRun?.thinking).toContain("阶段1：审查任务识别")
  })

  it("parses Chinese chapter stems and persists revision feedback", async () => {
    mocks.reviewChapter.mockResolvedValue([{ severity: "warning", type: "consistency", message: "m", evidence: "e", relatedMemory: "rm", suggestion: "s" }])
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    mocks.persistRevisionFeedbackForChapter.mockResolvedValue(undefined)
    const onHistorySaved = vi.fn()

    await startNovelReviewRun({
      fileContent: "---\nchapterNumber: 2\n---\n正文内容",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/第3章.md",
      t: ((key: string) => key) as never,
      onHistorySaved,
    })

    expect(onHistorySaved).toHaveBeenCalledTimes(1)
    expect(mocks.persistRevisionFeedbackForChapter).toHaveBeenCalledWith(
      "E:/Novel",
      3,
      "review",
      expect.anything(),
    )
    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chapterNumber: 3 }),
    )
  })

  it("falls back to frontmatter chapter number without a numeric stem", async () => {
    mocks.reviewChapter.mockResolvedValue([])
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    mocks.persistRevisionFeedbackForChapter.mockResolvedValue(undefined)

    await startNovelReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/intro.md",
      t: ((key: string) => key) as never,
    })

    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chapterNumber: 8, title: "novel.review.historyEntryTitle" }),
    )
    expect(mocks.persistRevisionFeedbackForChapter).toHaveBeenCalledWith("E:/Novel", 8, "review", expect.anything())
  })

  it("uses the no-chapter history title when neither stem nor frontmatter has a number", async () => {
    mocks.reviewChapter.mockResolvedValue([])
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)

    await startNovelReviewRun({
      fileContent: "纯正文，没有 frontmatter",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/intro.md",
      t: ((key: string) => key) as never,
    })

    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chapterNumber: undefined, title: "novel.review.historyEntryTitleNoChapter" }),
    )
    expect(mocks.persistRevisionFeedbackForChapter).not.toHaveBeenCalled()
  })

  it("returns early when file content is blank or no file is selected", async () => {
    await startNovelReviewRun({
      fileContent: "   ",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    await startNovelReviewRun({
      fileContent: "正文",
      projectPath: "E:/Novel",
      selectedFile: "",
      t: ((key: string) => key) as never,
    })
    expect(mocks.reviewChapter).not.toHaveBeenCalled()
  })

  it("handles review failure via the catch path", async () => {
    mocks.reviewChapter.mockRejectedValue(new Error("provider boom"))

    await startNovelReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })

    const state = useWikiStore.getState().reviewRun
    expect(state?.running).toBe(false)
    expect(state?.error).toBe("novel.review.runFailed")
    expect(mocks.saveGenerationHistoryEntry).not.toHaveBeenCalled()
  })

  it("handles non-Error rejections and stale run ids in finally", async () => {
    mocks.reviewChapter.mockRejectedValue("plain string failure")
    await startNovelReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    expect(useWikiStore.getState().reviewRun?.error).toBe("novel.review.runFailed")

    // runId 已被替换 → finally 不再写回旧 run
    mocks.reviewChapter.mockImplementation(async (
      _p: string,
      _f: string,
      _n: number | undefined,
      callbacks: { onThinking?: (content: string) => void },
    ) => {
      callbacks.onThinking?.("思考中")
      useWikiStore.getState().setReviewRun(null)
      return []
    })
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    await startNovelReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    expect(useWikiStore.getState().reviewRun).toBeNull()
  })
})
