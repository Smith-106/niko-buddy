import { beforeEach, describe, expect, it, vi } from "vitest"

const statusMocks = vi.hoisted(() => ({
  loadNovelSessionStatus: vi.fn(),
  saveNovelSessionStatus: vi.fn(),
}))

const splitMocks = vi.hoisted(() => ({
  markReviewRunning: vi.fn((job: unknown) => ({ ...(job as object), phase: "running" })),
  markReviewDone: vi.fn((job: unknown, note?: string) => ({ ...(job as object), phase: "done", note })),
  markReviewFailed: vi.fn((job: unknown, note?: string) => ({ ...(job as object), phase: "failed", note })),
}))

vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: statusMocks.loadNovelSessionStatus,
  saveNovelSessionStatus: statusMocks.saveNovelSessionStatus,
}))
vi.mock("./write-review-split", () => ({
  markReviewRunning: splitMocks.markReviewRunning,
  markReviewDone: splitMocks.markReviewDone,
  markReviewFailed: splitMocks.markReviewFailed,
}))

import type {
  DimensionReviewResult,
  SixReviewDimensionKey,
} from "./dimension-review-adapter"
import {
  advanceReviewJobDone,
  advanceReviewJobDoneWithDimensionResults,
  advanceReviewJobFailed,
  advanceReviewJobRunning,
} from "./review-job-lifecycle"

describe("review-job-lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const status = { review_job: null, updated_at: "old" } as never

  it("advanceReviewJobRunning returns null when status missing", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    const job = await advanceReviewJobRunning("C:/novel")
    expect(job).toBeNull()
    expect(statusMocks.saveNovelSessionStatus).not.toHaveBeenCalled()
  })

  it("advanceReviewJobRunning marks running and persists", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(status)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
    const job = await advanceReviewJobRunning("C:/novel", 7)
    expect(job?.phase).toBe("running")
    expect(job?.chapterNumber).toBe(7)
    expect(splitMocks.markReviewRunning).toHaveBeenCalledWith(null)
    const [path, saved] = statusMocks.saveNovelSessionStatus.mock.calls[0]
    expect(path).toBe("C:/novel")
    expect(saved.review_job.phase).toBe("running")
    expect(saved.updated_at).toBeTruthy()
  })

  it("advanceReviewJobRunning keeps existing chapterNumber when omitted", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({
      review_job: { phase: "queued", chapterNumber: 3 },
    } as never)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
    const job = await advanceReviewJobRunning("C:/novel")
    expect(job?.chapterNumber).toBe(3)
  })

  it("advanceReviewJobDone marks done with note", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(status)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
    const job = await advanceReviewJobDone("C:/novel", "finish note")
    expect(job?.phase).toBe("done")
    expect(job?.note).toBe("finish note")
    expect(splitMocks.markReviewDone).toHaveBeenCalledWith(null, "finish note")
  })

  it("advanceReviewJobDone returns null when status missing", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    expect(await advanceReviewJobDone("C:/novel")).toBeNull()
  })

  it("advanceReviewJobFailed marks failed with note", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(status)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
    const job = await advanceReviewJobFailed("C:/novel", "boom")
    expect(job?.phase).toBe("failed")
    expect(splitMocks.markReviewFailed).toHaveBeenCalledWith(null, "boom")
  })

  it("advanceReviewJobFailed returns null when status missing", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    expect(await advanceReviewJobFailed("C:/novel")).toBeNull()
  })
})

describe("review-job-lifecycle — advanceReviewJobDoneWithDimensionResults（G2 dimension_results 落盘）", () => {
  const dimensionResult = (
    dimensionKey: SixReviewDimensionKey,
    score: number,
    summary: string,
  ): DimensionReviewResult => ({
    dimensionKey,
    score,
    status: "pass",
    summary,
    thinking: "",
    issues: [],
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("合并而非覆盖既有 dimension_results（保留其他章节/维度已有结果）", async () => {
    const existingPacing = dimensionResult("pacing", 70, "旧节奏结论")
    statusMocks.loadNovelSessionStatus.mockResolvedValue({
      review_job: { phase: "running", chapterNumber: 12 },
      dimension_results: { pacing: existingPacing },
      updated_at: "old",
    } as never)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)

    const job = await advanceReviewJobDoneWithDimensionResults(
      "C:/novel",
      { thrill: dimensionResult("thrill", 88, "新惊悚结论") },
      "six-dim done",
    )

    expect(job?.phase).toBe("done")
    expect(job?.note).toBe("six-dim done")
    expect(splitMocks.markReviewDone).toHaveBeenCalledWith({ phase: "running", chapterNumber: 12 }, "six-dim done")
    const [path, saved] = statusMocks.saveNovelSessionStatus.mock.calls[0]
    expect(path).toBe("C:/novel")
    expect(saved.review_job.phase).toBe("done")
    expect(Object.keys(saved.dimension_results).sort()).toEqual(["pacing", "thrill"])
    expect(saved.dimension_results.pacing).toBe(existingPacing)
    expect(saved.dimension_results.thrill.score).toBe(88)
    expect(saved.updated_at).toBeTruthy()
  })

  it("status 尚无 dimension_results 时以空底合并（?? {} 回退）", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ review_job: null, updated_at: "old" } as never)
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)

    const job = await advanceReviewJobDoneWithDimensionResults("C:/novel", {
      consistency: dimensionResult("consistency", 61, "一致性结论"),
    })

    expect(job?.phase).toBe("done")
    const saved = statusMocks.saveNovelSessionStatus.mock.calls[0]![1]
    expect(saved.dimension_results).toEqual({
      consistency: dimensionResult("consistency", 61, "一致性结论"),
    })
    expect(splitMocks.markReviewDone).toHaveBeenCalledWith(null, undefined)
  })

  it("status 缺失时返回 null 且不落盘", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)

    expect(await advanceReviewJobDoneWithDimensionResults("C:/novel", {})).toBeNull()
    expect(statusMocks.saveNovelSessionStatus).not.toHaveBeenCalled()
  })
})
