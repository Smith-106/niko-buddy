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
    mocks.runDeepChapterGeneration.mockReset()
    mocks.createDirectory.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockReset()
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.ingestChapter.mockReset()
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

  it("全自动巡航模式 (cruiseMode: true)：门控全绿时自动提交晋升与事实库双写", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValue({
      finalContent: "巡航生成的正文内容",
      taskBrief: "brief",
      draftContent: "draft",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
    })

    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      onProgress,
    })

    expect(report.completedChapters).toBe(2)
    expect(report.results[0].autoAccepted).toBe(true)
    expect(report.results[1].autoAccepted).toBe(true)
    // 验证触发了两次原子写落盘和两次事实摄取
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
  })

  it("全自动巡航模式安全挂起：某章出现 blocked 时停止后续连写并保留现场", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章全绿",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章出现严重冲突",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "failed", antiAi: "passed", quality: "failed" },
        manualReviewRequired: true,
        retryCount: 3,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第三章（不应被执行）",
        taskBrief: "brief3",
        draftContent: "draft3",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 3,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      onProgress,
    })

    // 第一章成功自动晋升，第二章 blocked 后中断，第三章未被调度
    expect(report.results).toHaveLength(2)
    expect(report.results[0].autoAccepted).toBe(true)
    expect(report.results[1].status).toBe("blocked")
    expect(report.results[1].autoAccepted).toBe(false)
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "cruise-paused",
      }),
    )
  })

  it("触发 onThinking 回调并支持 buildChapterRequest 与 partial 状态", async () => {
    mocks.runDeepChapterGeneration.mockImplementationOnce(async (_input, callbacks) => {
      callbacks?.onThinking?.("正在思考剧情走向并构建人物心理变化...")
      return {
        finalContent: "部分内容",
        taskBrief: "brief",
        draftContent: "draft",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: true,
        partialReason: "hit token limit",
      }
    })

    const onProgress = vi.fn()
    const buildChapterRequest = vi.fn(async (num: number) => `特别定制的第 ${num} 章任务需求`)

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      buildChapterRequest,
      onProgress,
    })

    expect(buildChapterRequest).toHaveBeenCalledWith(1)
    expect(report.results[0].status).toBe("partial")
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "thinking",
        message: expect.stringContaining("正在思考剧情走向"),
      }),
    )
  })

  it("单章遭遇异常时记录 failed 状态并在非巡航模式下继续后续推进", async () => {
    mocks.runDeepChapterGeneration
      .mockRejectedValueOnce(new Error("网络异常中断"))
      .mockRejectedValueOnce("字符串异常")
      .mockResolvedValueOnce({
        finalContent: "第三章成功",
        taskBrief: "brief",
        draftContent: "draft",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const onChapterComplete = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 3,
      llmConfig: mockLlmConfig,
      onChapterComplete,
    })

    expect(report.results).toHaveLength(3)
    expect(report.results[0].status).toBe("failed")
    expect(report.results[0].error).toBe("网络异常中断")
    expect(report.results[1].status).toBe("failed")
    expect(report.results[1].error).toBe("字符串异常")
    expect(report.results[2].status).toBe("ready")
    expect(report.summary.allPassed).toBe(false)
    expect(report.summary.failedCount).toBe(2)
  })

  it("巡航模式下遇到不可恢复异常立即中断战役", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("巡航严重错误"))

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
    })

    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("failed")
  })

  it("巡航模式下自动晋升异常被捕获且不崩溃整个流程", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "成功内容",
      taskBrief: "brief",
      draftContent: "draft",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
    })
    mocks.writeFileAtomic.mockRejectedValueOnce(new Error("写入文件权限受限"))

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
    })

    expect(report.results[0].autoAccepted).toBe(false)
  })

  it("batchAcceptCampaignDrafts 默认标题回退与过滤空白内容", async () => {
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      {
        chapterNumber: 7,
        content: "第七章内容",
        taskBrief: "b",
        draftContent: "d",
        reviewResults: [],
        revised: false,
        wordCount: 50,
        status: "ready",
      },
      {
        chapterNumber: 8,
        content: "   ",
        taskBrief: "b",
        draftContent: "d",
        reviewResults: [],
        revised: false,
        wordCount: 0,
        status: "ready",
      },
    ])
    expect(res.acceptedCount).toBe(1)
    const written = mocks.writeFileAtomic.mock.calls[0][1] as string
    expect(written).toContain("# 第7章")
  })

  it("batchAcceptCampaignDrafts 单章事实摄取失败时记录日志且不中断后续章节", async () => {
    mocks.ingestChapter.mockRejectedValueOnce(new Error("事实摄取超时"))

    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        {
          chapterNumber: 10,
          title: "第十章",
          content: "第十章内容",
          taskBrief: "b",
          draftContent: "d",
          reviewResults: [],
          revised: false,
          wordCount: 100,
          status: "ready",
        },
      ],
      {
        autoIngest: true,
        llmConfig: mockLlmConfig,
      },
    )

    expect(res.acceptedCount).toBe(1)
    expect(res.ingestedCount).toBe(0)
  })

  it("在已取消信号下发生异常时退出循环", async () => {
    const controller = new AbortController()
    mocks.runDeepChapterGeneration.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error("异常中断")
    })

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      signal: controller.signal,
    })

    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("failed")
  })

  it("batchAcceptCampaignDrafts 在 llmConfig.model 为空时回退 default 模型，或 autoIngest 为 false 时跳过摄取", async () => {
    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        {
          chapterNumber: 11,
          title: "第十一章",
          content: "第十一章内容",
          taskBrief: "b",
          draftContent: "d",
          reviewResults: [],
          revised: false,
          wordCount: 100,
          status: "ready",
        },
      ],
      {
        autoIngest: true,
        llmConfig: { ...mockLlmConfig, model: undefined as any },
      },
    )

    expect(res.acceptedCount).toBe(1)
    expect(mocks.ingestChapter).toHaveBeenCalledWith(
      "/mock/project",
      "/mock/project/wiki/chapters/chapter-011.md",
      "default",
      undefined,
      expect.anything(),
    )

    // autoIngest 为 false 时直接跳过
    const resNoIngest = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        {
          chapterNumber: 12,
          title: "第十二章",
          content: "第十二章内容",
          taskBrief: "b",
          draftContent: "d",
          reviewResults: [],
          revised: false,
          wordCount: 100,
          status: "ready",
        },
      ],
      {
        autoIngest: false,
      },
    )
    expect(resNoIngest.acceptedCount).toBe(1)
    expect(resNoIngest.ingestedCount).toBe(0)
  })

  it("batchAcceptCampaignDrafts 动态模块导入失败时捕获异常并记录日志", async () => {
    const spy = vi.spyOn(Promise, "all").mockRejectedValueOnce(new Error("模块加载器崩溃"))

    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        {
          chapterNumber: 13,
          title: "第十三章",
          content: "第十三章内容",
          taskBrief: "b",
          draftContent: "d",
          reviewResults: [],
          revised: false,
          wordCount: 100,
          status: "ready",
        },
      ],
      {
        autoIngest: true,
        llmConfig: mockLlmConfig,
      },
    )

    expect(res.acceptedCount).toBe(1)
    expect(res.ingestedCount).toBe(0)
    spy.mockRestore()
  })
})

