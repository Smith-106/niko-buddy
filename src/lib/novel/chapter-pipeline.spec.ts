import { describe, expect, it, vi } from "vitest"

const resolveReviewModel = vi.hoisted(() => vi.fn())

vi.mock("./review-model", () => ({
  resolveReviewModel,
}))

import { createBatchChapterPipeline, createChapterPipeline, queryResumeCandidates } from "./chapter-pipeline"
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

describe("createBatchChapterPipeline（R3 批量层）", () => {
  const ok = (n: number) => ({ snapshot: { chapterNumber: n } as IngestResult["snapshot"], failReason: undefined })
  it("默认串行：逐章调 ingestChapter，失败隔离不中断", async () => {
    const ingestChapter = vi.fn(async (_pp: string, cp: string, _m: string): Promise<IngestResult> => {
      if (cp.includes("bad")) throw new Error("boom")
      return ok(1)
    })
    const run = createBatchChapterPipeline({ ingestChapter })
    const s = await run("/p", ["/p/a.md", "/p/bad.md", "/p/c.md"])
    expect(s.total).toBe(3)
    expect(s.succeeded).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.results[1].result.failReason).toBe("extract_failed")
    expect(ingestChapter).toHaveBeenCalledTimes(3)
  })
  it("注入 runBatch 时走调用方实现", async () => {
    const ingestChapter = vi.fn()
    const runBatch = vi.fn(async (_pp: string, paths: readonly string[], _m: string) => paths.map((p) => ({ chapterPath: p, result: ok(7) })))
    const run = createBatchChapterPipeline({ ingestChapter, runBatch })
    const s = await run("/p", ["/p/a.md", "/p/b.md"])
    expect(s.succeeded).toBe(2)
    expect(ingestChapter).not.toHaveBeenCalled()
    expect(runBatch).toHaveBeenCalledTimes(1)
  })
})

describe("queryResumeCandidates（R2 可见化）", () => {
  it("未注入 scanResume 回空；注入时透传", async () => {
    expect(await queryResumeCandidates({ ingestChapter: vi.fn() }, "/p", 1)).toEqual([])
    const list = [{ digest: "d", stage: "gen", createdAt: 1, expiresAt: 2 }]
    const out = await queryResumeCandidates({ ingestChapter: vi.fn(), scanResume: async () => list }, "/p", 1)
    expect(out).toEqual(list)
  })
})
