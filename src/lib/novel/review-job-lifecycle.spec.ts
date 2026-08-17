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

import {
  advanceReviewJobDone,
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
