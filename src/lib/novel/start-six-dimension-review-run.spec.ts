import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { startSixDimensionReviewRun } from "./start-six-dimension-review-run"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"

const mocks = vi.hoisted(() => ({
  runSixDimensionReview: vi.fn(),
  saveGenerationHistoryEntry: vi.fn(),
  advanceReviewJobRunning: vi.fn(async () => undefined),
  advanceReviewJobDone: vi.fn(async () => undefined),
  advanceReviewJobFailed: vi.fn(async () => undefined),
}))

vi.mock("./dimension-review-adapter", () => ({
  runSixDimensionReview: mocks.runSixDimensionReview,
}))

vi.mock("./generation-history", () => ({
  saveGenerationHistoryEntry: mocks.saveGenerationHistoryEntry,
}))

vi.mock("./review-job-lifecycle", () => ({
  advanceReviewJobRunning: mocks.advanceReviewJobRunning,
  advanceReviewJobDone: mocks.advanceReviewJobDone,
  advanceReviewJobFailed: mocks.advanceReviewJobFailed,
}))

function dimensionResult(dimensionKey: SixReviewDimensionKey): DimensionReviewResult {
  return {
    dimensionKey,
    score: 8.8,
    status: "pass",
    summary: `${dimensionKey} done`,
    thinking: `## ${dimensionKey}`,
    issues: [],
  }
}

describe("startSixDimensionReviewRun", () => {
  beforeEach(() => {
    useWikiStore.getState().setReviewRun(null)
    mocks.runSixDimensionReview.mockReset()
    mocks.saveGenerationHistoryEntry.mockReset()
  })

  it("stores dimension progress, thinking, results, and history while running", async () => {
    mocks.runSixDimensionReview.mockImplementation(async (args: {
      callbacks?: {
        onDimensionProgress?: (dimensionKey: string, progress: string) => void
        onDimensionThinking?: (dimensionKey: string, thinking: string) => void
        onDimensionResult?: (dimensionKey: string, result: DimensionReviewResult) => void
      }
    }) => {
      args.callbacks?.onDimensionProgress?.("thrill", "爽感密度：正在检查压抑与释放链")
      args.callbacks?.onDimensionThinking?.("thrill", "## 爽感密度\n正在分析")
      args.callbacks?.onDimensionResult?.("thrill", dimensionResult("thrill"))
      const current = useWikiStore.getState().reviewRun
      expect(current?.running).toBe(true)
      expect(current?.activeDimension).toBe("thrill")
      expect(current?.dimensionProgress).toContain("爽感密度")
      expect(current?.dimensionThinking?.thrill).toContain("正在分析")
      expect(current?.dimensionResults?.thrill?.score).toBe(8.8)
      return {
        thrill: dimensionResult("thrill"),
        pull: dimensionResult("pull"),
      }
    })

    await startSixDimensionReviewRun({
      fileContent: "---\nchapterNumber: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })

    const run = useWikiStore.getState().reviewRun
    expect(run?.running).toBe(false)
    expect(run?.dimensionResults?.thrill?.summary).toBe("thrill done")
    expect(run?.dimensionResults?.pull?.summary).toBe("pull done")
    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({
        kind: "review",
        sourcePath: "E:/Novel/wiki/chapters/008.md",
        dimensionResults: expect.objectContaining({
          thrill: expect.objectContaining({ score: 8.8 }),
        }),
      }),
    )
  })

  it("returns early when file content is blank or no file is selected", async () => {
    await startSixDimensionReviewRun({
      fileContent: "   ",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    await startSixDimensionReviewRun({
      fileContent: "正文",
      projectPath: "E:/Novel",
      selectedFile: "",
      t: ((key: string) => key) as never,
    })
    expect(mocks.runSixDimensionReview).not.toHaveBeenCalled()
  })

  it("uses the no-chapter history title without frontmatter", async () => {
    mocks.runSixDimensionReview.mockResolvedValue({})
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    await startSixDimensionReviewRun({
      fileContent: "纯正文，没有 frontmatter",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/intro.md",
      t: ((key: string) => key) as never,
    })
    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({ title: "novel.review.historyEntryTitleNoChapter" }),
    )
  })

  it("routes callbacks through injected storeActions even when the store is null", async () => {
    mocks.runSixDimensionReview.mockImplementation(async (args: {
      callbacks?: {
        onDimensionThinking?: (key: string, t: string) => void
        onDimensionResult?: (key: string, r: DimensionReviewResult) => void
        onMeasurementFingerprint?: (fp: unknown) => void
      }
    }) => {
      args.callbacks?.onDimensionThinking?.("thrill", "think")
      args.callbacks?.onDimensionResult?.("thrill", dimensionResult("thrill"))
      args.callbacks?.onMeasurementFingerprint?.({ id: "fp-1" })
      return { thrill: dimensionResult("thrill") }
    })
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    const setReviewRun = vi.fn()
    const finishReviewRun = vi.fn()
    const getReviewRun = vi.fn(() => null)
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
      storeActions: { setReviewRun, finishReviewRun, getReviewRun },
    })
    expect(finishReviewRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ measurementFingerprint: { id: "fp-1" } }))
    expect(finishReviewRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dimensionThinking: { thrill: "think" } }))
  })

  it("does not preserve dimension results when the selected file differs", async () => {
    useWikiStore.getState().setReviewRun({
      runId: "previous-run",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/chapters/OTHER.md",
      running: false,
      results: [],
      dimensionResults: { pull: { ...dimensionResult("pull"), summary: "old pull" } },
    })
    const newThrillResult = { ...dimensionResult("thrill"), summary: "new thrill" }
    mocks.runSixDimensionReview.mockResolvedValue({ thrill: newThrillResult })
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
      dimensionKey: "thrill",
    })
    const run = useWikiStore.getState().reviewRun
    expect(run?.dimensionResults?.thrill?.summary).toBe("new thrill")
    expect(run?.dimensionResults?.pull).toBeUndefined()
  })

  it("handles Error rejections through the catch path", async () => {
    mocks.runSixDimensionReview.mockRejectedValue(new Error("provider boom"))
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    expect(useWikiStore.getState().reviewRun?.error).toBe("novel.review.runFailed")
    expect(mocks.advanceReviewJobFailed).toHaveBeenCalledWith("E:/Novel", "provider boom")
  })

  it("handles review failure through the catch path", async () => {
    mocks.advanceReviewJobRunning.mockRejectedValueOnce(new Error("job-running-fail"))
    mocks.runSixDimensionReview.mockRejectedValue("plain string failure")
    mocks.advanceReviewJobFailed.mockRejectedValueOnce(new Error("job-fail"))
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    const run = useWikiStore.getState().reviewRun
    expect(run?.running).toBe(false)
    expect(run?.error).toBe("novel.review.runFailed")
    expect(mocks.advanceReviewJobFailed).toHaveBeenCalledWith("E:/Novel", "plain string failure")
  })

  it("tolerates advanceReviewJobDone rejection after a successful review", async () => {
    mocks.runSixDimensionReview.mockResolvedValue({})
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    mocks.advanceReviewJobDone.mockRejectedValueOnce(new Error("job-done-fail"))
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
    })
    expect(useWikiStore.getState().reviewRun?.running).toBe(false)
  })

  it("preserves nothing when the store lacks dimensionResults", async () => {
    useWikiStore.getState().setReviewRun({
      runId: "previous-run",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/chapters/008.md",
      running: false,
      results: [],
    })
    const newThrillResult = { ...dimensionResult("thrill"), summary: "new thrill" }
    mocks.runSixDimensionReview.mockResolvedValue({ thrill: newThrillResult })
    mocks.saveGenerationHistoryEntry.mockResolvedValue(undefined)
    await startSixDimensionReviewRun({
      fileContent: "---\nchapter_number: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
      dimensionKey: "thrill",
    })
    const run = useWikiStore.getState().reviewRun
    expect(run?.dimensionResults?.thrill?.summary).toBe("new thrill")
  })

  it("reruns only the selected dimension and preserves existing dimension results", async () => {
    const oldPullResult = { ...dimensionResult("pull"), summary: "old pull result" }
    const newThrillResult = { ...dimensionResult("thrill"), summary: "new thrill result" }
    useWikiStore.getState().setReviewRun({
      runId: "previous-run",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/chapters/008.md",
      running: false,
      results: [],
      dimensionResults: {
        pull: oldPullResult,
      },
    })
    mocks.runSixDimensionReview.mockResolvedValue({
      thrill: newThrillResult,
    })

    await startSixDimensionReviewRun({
      fileContent: "---\nchapterNumber: 8\n---\n正文",
      projectPath: "E:/Novel",
      selectedFile: "E:/Novel/wiki/chapters/008.md",
      t: ((key: string) => key) as never,
      dimensionKey: "thrill",
    })

    expect(mocks.runSixDimensionReview).toHaveBeenCalledWith(expect.objectContaining({
      dimensionKeys: ["thrill"],
    }))
    const run = useWikiStore.getState().reviewRun
    expect(run?.dimensionResults?.thrill?.summary).toBe("new thrill result")
    expect(run?.dimensionResults?.pull?.summary).toBe("old pull result")
    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({
        dimensionResults: expect.objectContaining({
          thrill: expect.objectContaining({ summary: "new thrill result" }),
          pull: expect.objectContaining({ summary: "old pull result" }),
        }),
      }),
    )
  })
})
