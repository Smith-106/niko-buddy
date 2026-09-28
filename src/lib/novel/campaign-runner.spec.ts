// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  runAutonomousDraftCampaign,
  batchAcceptCampaignDrafts,
  type CampaignChapterResult,
} from "./campaign-runner"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

const mocks = vi.hoisted(() => ({
  runDeepChapterGeneration: vi.fn(),
  createDirectory: vi.fn(),
  writeFileAtomic: vi.fn(),
  ingestChapter: vi.fn(),
  defaultCanonDualWriteDeps: vi.fn(() => ({})),
}))

vi.mock("./deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("./chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))

vi.mock("./canon-dual-write", () => ({
  defaultCanonDualWriteDeps: mocks.defaultCanonDualWriteDeps,
}))

describe("Autonomous Draft Campaign Runner (预演式批量战役调度器)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapter: 1 } })
  })

  it("连续调度多章批量生成，正确收集战役报告与前情传递", async () => {
    let callCount = 0
    mocks.runDeepChapterGeneration.mockImplementation(async (input) => {
      callCount++
      return {
        finalContent: `第 ${input.chapterNumber} 章正文内容，故事展开。`,
        taskBrief: `任务书 ${input.chapterNumber}`,
        draftContent: `初稿 ${input.chapterNumber}`,
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      }
    })

    const onChapterStart = vi.fn()
    const onChapterComplete = vi.fn()
    const onProgress = vi.fn()

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 3,
      llmConfig: mockLlmConfig,
      onChapterStart,
      onChapterComplete,
      onProgress,
    })

    expect(report.completedChapters).toBe(3)
    expect(report.startChapter).toBe(1)
    expect(report.endChapter).toBe(3)
    expect(report.results).toHaveLength(3)
    expect(report.summary.allPassed).toBe(true)
    expect(report.summary.readyCount).toBe(3)
    expect(report.summary.failedCount).toBe(0)
    expect(onChapterStart).toHaveBeenCalledTimes(3)
    expect(onChapterComplete).toHaveBeenCalledTimes(3)
    expect(callCount).toBe(3)

    // 验证第二章调用时传入了第一章的前情承接指令
    const secondCallInput = mocks.runDeepChapterGeneration.mock.calls[1][0]
    expect(secondCallInput.chapterNumber).toBe(2)
    expect(secondCallInput.dismantlingReferenceDirective).toContain("【前序连贯性前情承接】")
  })

  it("单章生成发生阻断时，正确记录 blocked 状态而不崩溃整体流水线", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "第一章正文",
      taskBrief: "任务书1",
      draftContent: "初稿1",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: true, // 阻断转人工
      retryCount: 3,
      partial: false,
      partialReason: null,
    })

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 5,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })

    expect(report.results[0].status).toBe("blocked")
    expect(report.summary.allPassed).toBe(false)
    expect(report.summary.failedCount).toBe(1)
  })

  it("支持 AbortSignal 取消战役推进", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        signal: controller.signal,
      }),
    ).rejects.toThrow("批量战役已被用户取消")
  })

  it("batchAcceptCampaignDrafts 批量验收晋升：将 Ready 草稿写入正式目录并触发事实摄取", async () => {
    const mockResults: CampaignChapterResult[] = [
      {
        chapterNumber: 1,
        title: "第一章 风起",
        content: "这是第一章正式内容",
        taskBrief: "brief-1",
        draftContent: "draft-1",
        reviewResults: [],
        revised: false,
        wordCount: 100,
        status: "ready",
      },
      {
        chapterNumber: 2,
        title: "第二章 云涌",
        content: "这是第二章正式内容",
        taskBrief: "brief-2",
        draftContent: "draft-2",
        reviewResults: [],
        revised: false,
        wordCount: 100,
        status: "ready",
      },
      {
        chapterNumber: 3,
        content: "",
        taskBrief: "",
        draftContent: "",
        reviewResults: [],
        revised: false,
        wordCount: 0,
        status: "failed", // 失败章跳过
      },
    ]

    const onProgress = vi.fn()
    const acceptResult = await batchAcceptCampaignDrafts(
      "/mock/project",
      mockResults,
      {
        autoIngest: true,
        llmConfig: mockLlmConfig,
        onProgress,
      },
    )

    expect(acceptResult.acceptedCount).toBe(2)
    expect(acceptResult.chapterPaths).toHaveLength(2)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)

    // 验证写入的内容被标记为 final 态
    const firstWriteContent = mocks.writeFileAtomic.mock.calls[0][1] as string
    expect(firstWriteContent).toContain("chapter_status: final")
    expect(firstWriteContent).toContain("# 第一章 风起")

    // 验证自动执行了 2 次 ingestChapter
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
    expect(acceptResult.ingestedCount).toBe(2)
  })
})
