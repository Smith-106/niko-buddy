import { describe, expect, it, vi } from "vitest"

const resolveReviewModel = vi.hoisted(() => vi.fn())

vi.mock("./review-model", () => ({
  resolveReviewModel,
}))

import { createChapterPipeline } from "./chapter-pipeline"
import type { IngestResult } from "./chapter-ingest"

describe("createChapterPipeline", () => {
  it("resolves the review model and passes it to ingestChapter", async () => {
    resolveReviewModel.mockReturnValue("gpt-4.1-mini")
    const ingestChapter = vi.fn(async (_pp: string, _cp: string, _reviewModel: string): Promise<IngestResult> => {
      return { snapshot: { chapterNumber: 1 } as IngestResult["snapshot"], failReason: undefined }
    })
    const pipeline = createChapterPipeline({ ingestChapter })
    const result = await pipeline("/project", "/project/wiki/chapters/chapter-001.md")

    expect(resolveReviewModel).toHaveBeenCalledTimes(1)
    expect(ingestChapter).toHaveBeenCalledWith("/project", "/project/wiki/chapters/chapter-001.md", "gpt-4.1-mini")
    expect(result.snapshot).toMatchObject({ chapterNumber: 1 })
  })

  it("propagates empty review model when resolver returns empty string", async () => {
    resolveReviewModel.mockReturnValue("")
    const ingestChapter = vi.fn(async (_pp: string, _cp: string, _reviewModel: string): Promise<IngestResult> => {
      return { snapshot: null }
    })
    const pipeline = createChapterPipeline({ ingestChapter })
    await pipeline("/p", "/p/ch.md")
    expect(ingestChapter).toHaveBeenCalledWith("/p", "/p/ch.md", "")
  })
})
