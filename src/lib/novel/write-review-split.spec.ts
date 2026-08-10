import { describe, expect, it } from "vitest"
import {
  createIdleReviewJob,
  formatReviewJobLine,
  isWriteUnblockedByReview,
  markReviewDone,
  markReviewFailed,
  markReviewQueued,
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
})
