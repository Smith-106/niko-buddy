import { describe, expect, it } from "vitest"
import { markReviewQueued, markWriteReady } from "./write-review-split"
import { formatReviewJobStatusLine, getReviewJobUiModel } from "./review-job-ui"

describe("review-job-ui (S4)", () => {
  it("maps queued job to UI model with write unblocked", () => {
    const job = markReviewQueued(markWriteReady(null, 7), 7)
    const ui = getReviewJobUiModel(job)
    expect(ui).not.toBeNull()
    expect(ui!.phase).toBe("queued")
    expect(ui!.chapterNumber).toBe(7)
    expect(ui!.writeUnblocked).toBe(true)
    expect(ui!.productHardGate).toBe(false)
    expect(ui!.blocksWrite).toBe(false)
    expect(ui!.statusLine).toContain("blocksWrite=false")
    expect(formatReviewJobStatusLine(job)).toContain("queued")
  })

  it("null job returns null model and fallback line", () => {
    expect(getReviewJobUiModel(null)).toBeNull()
    expect(formatReviewJobStatusLine(undefined)).toContain("no review_job")
  })
})
