import { describe, expect, it } from "vitest"
import {
  createIdleReviewJob,
  formatReviewJobLine,
  isWriteUnblockedByReview,
  markReviewDone,
  markReviewFailed,
  markReviewQueued,
  markReviewRunning,
  markWriteReady,
} from "./write-review-split"

describe("write-review-split", () => {
  it("write stays unblocked through review lifecycle", () => {
    let job = createIdleReviewJob()
    job = markWriteReady(job, 4)
    expect(isWriteUnblockedByReview(job)).toBe(true)
    job = markReviewQueued(job, 4)
    expect(job.phase).toBe("queued")
    expect(job.blocksWrite).toBe(false)
    job = markReviewDone(job)
    expect(job.phase).toBe("done")
    expect(isWriteUnblockedByReview(job)).toBe(true)
    const failed = markReviewFailed(job, "timeout")
    expect(failed.phase).toBe("failed")
    expect(failed.productHardGate).toBe(false)
    expect(formatReviewJobLine(failed)).toContain("blocksWrite=false")
  })

  it("markReviewRunning starts an idle job when none exists", () => {
    const job = markReviewRunning(undefined)
    expect(job.phase).toBe("running")
    expect(job.blocksWrite).toBe(false)
    expect(job.reviewStartedAt).toBeTruthy()
  })

  it("markReviewRunning preserves an existing queued job and its chapter", () => {
    const queued = markReviewQueued(markWriteReady(null, 7), 7)
    const running = markReviewRunning(queued)
    expect(running.phase).toBe("running")
    expect(running.chapterNumber).toBe(7)
  })

  it("markReviewDone records note without gate blocks", () => {
    const done = markReviewDone(createIdleReviewJob(), "finished clean")
    expect(done.phase).toBe("done")
    expect(done.note).toBe("finished clean")
    expect(done.blocksWrite).toBe(false)
  })

  it("markWriteReady preserves running phase and falls back to base chapterNumber", () => {
    const running = markReviewRunning(null)
    const ready = markWriteReady(running, 5)
    expect(ready.phase).toBe("running")
    expect(ready.chapterNumber).toBe(5)

    // chapterNumber 参数缺省 → 沿用 base.chapterNumber
    const base = markWriteReady(null, 9)
    const again = markWriteReady(base, undefined)
    expect(again.chapterNumber).toBe(9)
  })

  it("nullish job falls back to idle across queue/done/failed, with note defaults", () => {
    const queued = markReviewQueued(undefined, undefined)
    expect(queued.phase).toBe("queued")
    expect(queued.writeReadyAt).toBeTruthy() // base 无 writeReadyAt → 新时间戳

    const done = markReviewDone(undefined)
    expect(done.phase).toBe("done")
    expect(done.note).toBe("review done (non-blocking)")

    const failed = markReviewFailed(undefined)
    expect(failed.phase).toBe("failed")
    expect(failed.note).toBe("review failed (write still unblocked)")
  })

  it("formatReviewJobLine omits absent optional fields", () => {
    const line = formatReviewJobLine(createIdleReviewJob())
    expect(line).toContain("phase=idle")
    expect(line).not.toContain("ch=")
    expect(line).not.toContain("writeReady=")
    expect(line).not.toContain("queued=")
  })
})
