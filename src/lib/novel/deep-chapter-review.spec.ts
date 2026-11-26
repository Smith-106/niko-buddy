/** deep-chapter-review.ts 行为与 W1-03 回归测试 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextPack } from "./context-engine"
import type { DeepChapterGenerationDeps } from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"

const preflightMock = vi.hoisted(() =>
  vi.fn<(projectPath: string, chapterNumber?: number, options?: { chapterText?: string }) => Promise<NovelReviewResult[]>>(
    async () => [],
  ),
)

vi.mock("./review-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./review-adapter")>()
  return {
    ...actual,
    runContinuityMechanicalPreflight: (
      projectPath: string,
      chapterNumber?: number,
      options?: { chapterText?: string },
    ) => preflightMock(projectPath, chapterNumber, options),
  }
})

import { runFullReviewWithSixDim } from "./deep-chapter-review"

describe("deep-chapter-review.ts", () => {
  beforeEach(() => {
    preflightMock.mockReset()
    preflightMock.mockResolvedValue([])
  })

  it("exports runFullReviewWithSixDim", () => {
    expect(runFullReviewWithSixDim).toBeDefined()
  })

  it("W1-03: runFullReviewWithSixDim 向 runContinuityMechanicalPreflight 补传 { chapterText: content } 并透传预检结果", async () => {
    const mechanicalFinding: NovelReviewResult = {
      severity: "warning",
      type: "consistency_mechanical",
      message: "过程库三口诀预检命中",
      evidence: "doesNotKnow:密室密码",
      relatedMemory: "",
      suggestion: "删除越界信息",
    }
    preflightMock.mockResolvedValueOnce([mechanicalFinding])

    const reviewChapter = vi.fn(async (_projectPath, _content, _chapterNumber, options) => {
      options?.onSemanticReviewCompleted?.()
      return [mechanicalFinding]
    })
    const runSixDimensionReview = vi.fn(async () => ({}))
    const deps = {
      buildContextPack: vi.fn(),
      contextPackToPrompt: vi.fn(),
      reviewChapter,
      runSixDimensionReview,
      streamChat: vi.fn(),
    } as unknown as DeepChapterGenerationDeps

    const chapterBody = "苏砚推开铁门，在暴雨中低声念出了密室密码。"
    const out = await runFullReviewWithSixDim(
      chapterBody,
      5,
      "/mock/project",
      deps,
      undefined,
      { task: "审稿第5章" } as unknown as ContextPack,
      {},
    )

    expect(preflightMock).toHaveBeenCalledTimes(1)
    expect(preflightMock).toHaveBeenCalledWith("/mock/project", 5, { chapterText: chapterBody })
    expect(reviewChapter).toHaveBeenCalledWith(
      "/mock/project",
      chapterBody,
      5,
      expect.objectContaining({ injectedContinuityResults: [mechanicalFinding] }),
    )
    expect(runSixDimensionReview).toHaveBeenCalledWith(
      expect.objectContaining({ priorReviewResults: [mechanicalFinding] }),
    )
    expect(out.semanticReviewCompleted).toBe(true)
    expect(out.reviewResults).toEqual([mechanicalFinding])
  })

  it("R2-W09: 第 9 参 runtimeConfig（novelConfig / llmConfig）透传给 reviewChapter 与 runSixDimensionReview", async () => {
    const reviewChapter = vi.fn(async (_projectPath, _content, _chapterNumber, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const runSixDimensionReview = vi.fn(async () => ({}))
    const deps = {
      buildContextPack: vi.fn(),
      contextPackToPrompt: vi.fn(),
      reviewChapter,
      runSixDimensionReview,
      streamChat: vi.fn(),
    } as unknown as DeepChapterGenerationDeps

    const injectedNovel = { deepChapterReview: true, searchTopK: 8 } as never
    const injectedLlm = { provider: "openai", apiKey: "sk-di", model: "gpt-4o", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 } as never

    await runFullReviewWithSixDim(
      "章节正文",
      6,
      "/mock/project",
      deps,
      undefined,
      { task: "审稿第6章" } as unknown as ContextPack,
      {},
      "xuanhuan",
      { novelConfig: injectedNovel, llmConfig: injectedLlm },
    )

    expect(reviewChapter).toHaveBeenCalledWith(
      "/mock/project",
      "章节正文",
      6,
      expect.objectContaining({
        novelConfig: injectedNovel,
        llmConfig: injectedLlm,
        genre: "xuanhuan",
      }),
    )
    expect(runSixDimensionReview).toHaveBeenCalledWith(
      expect.objectContaining({
        novelConfig: injectedNovel,
        llmConfig: injectedLlm,
      }),
    )
  })
})
