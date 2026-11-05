// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  runAutonomousDraftCampaign,
  batchAcceptCampaignDrafts,
  filterAcceptableChapters,
  CRUISE_FULL_CONFIG,
  type CampaignChapterResult,
} from "./campaign-runner"
import type { ArbitrationDirective, ArbitrationRequest } from "./cruise-arbitration"
import { readFrontmatterTitle } from "./chapter-typography"

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
  commitAcceptedDeepChapterDraft: vi.fn(),
  registerManagedCampaignDraft: vi.fn(),
  ingestChapter: vi.fn(),
  defaultCanonDualWriteDeps: vi.fn(() => ({})),
  // 覆盖率战役增补（本轮）：补齐未覆盖分支的可观测 mock，默认值与真实
  // 防御语义一致（缺失→空/吞错→null），既有用例行为不变。
  appendStageMetric: vi.fn(),
  updateNovelSessionStatus: vi.fn(),
  buildNextStatus: vi.fn(),
  listBindableNovelCharacters: vi.fn(),
  loadBinding: vi.fn(),
  loadSegmentSummaries: vi.fn(),
  getLatestSegmentSummaryText: vi.fn(),
  enrichWithEventPool: vi.fn(),
}))

vi.mock("./deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("./formal-writeback", () => ({
  commitAcceptedDeepChapterDraft: mocks.commitAcceptedDeepChapterDraft,
}))

vi.mock("./novel-session-status", () => ({
  registerManagedCampaignDraft: mocks.registerManagedCampaignDraft,
  appendStageMetric: mocks.appendStageMetric,
  updateNovelSessionStatus: mocks.updateNovelSessionStatus,
  buildNextStatus: mocks.buildNextStatus,
}))

// 覆盖率战役增补（本轮）：F2 零成本约束读取与事件池注入 milieu mock。
// 默认值复刻真实防御语义：人物/绑定/段摘要缺失时分别得 [] / null / ""。
vi.mock("./bindable-characters", () => ({
  listBindableNovelCharacters: mocks.listBindableNovelCharacters,
}))

vi.mock("./story-simulation/framework-binding", () => ({
  loadBinding: mocks.loadBinding,
}))

vi.mock("./segment-summary", () => ({
  loadSegmentSummaries: mocks.loadSegmentSummaries,
  getLatestSegmentSummaryText: mocks.getLatestSegmentSummaryText,
}))

vi.mock("./chapter-request-builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-request-builder")>()
  return {
    ...actual,
    enrichWithEventPool: mocks.enrichWithEventPool,
  }
})

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
    mocks.commitAcceptedDeepChapterDraft.mockReset()
    mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
    mocks.registerManagedCampaignDraft.mockReset()
    mocks.registerManagedCampaignDraft.mockResolvedValue("draft://autonomous-campaign")
    // 增补 mock 默认值（与真实防御语义一致，既有用例不受影响）
    mocks.appendStageMetric.mockReset()
    mocks.appendStageMetric.mockResolvedValue(undefined)
    mocks.updateNovelSessionStatus.mockReset()
    mocks.updateNovelSessionStatus.mockResolvedValue(undefined)
    mocks.buildNextStatus.mockReset()
    mocks.buildNextStatus.mockImplementation((base: unknown, overrides: unknown) => ({
      ...((base ?? {}) as Record<string, unknown>),
      ...((overrides ?? {}) as Record<string, unknown>),
    }))
    mocks.listBindableNovelCharacters.mockReset()
    mocks.listBindableNovelCharacters.mockResolvedValue([])
    mocks.loadBinding.mockReset()
    mocks.loadBinding.mockResolvedValue(null)
    mocks.loadSegmentSummaries.mockReset()
    mocks.loadSegmentSummaries.mockResolvedValue({})
    mocks.getLatestSegmentSummaryText.mockReset()
    mocks.getLatestSegmentSummaryText.mockReturnValue("")
    mocks.enrichWithEventPool.mockReset()
    mocks.enrichWithEventPool.mockImplementation(async (input: { request: string }) => `${input.request}\n\n【mock事件池】`)
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
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledTimes(2)
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(2)
    const registerOrders = mocks.registerManagedCampaignDraft.mock.invocationCallOrder
    const commitOrders = mocks.commitAcceptedDeepChapterDraft.mock.invocationCallOrder
    expect(registerOrders[0]).toBeLessThan(commitOrders[0])
    expect(commitOrders[0]).toBeLessThan(registerOrders[1])
    expect(registerOrders[1]).toBeLessThan(commitOrders[1])
    for (const index of [0, 1]) {
      const registered = mocks.registerManagedCampaignDraft.mock.calls[index][0] as {
        conversationId: string
        chapterNumber: number
        userRequest: string
        finalContent: string
      }
      const committed = mocks.commitAcceptedDeepChapterDraft.mock.calls[index][0] as {
        conversationId: string
        chapterNumber: number
        userRequest: string
        finalChapterContent: string
        decisionGates?: unknown
        reviewResults?: unknown
      }
      expect(registered.conversationId).toBe(committed.conversationId)
      expect(registered.chapterNumber).toBe(committed.chapterNumber)
      expect(registered.userRequest).toBe(committed.userRequest)
      expect(registered.finalContent).toBe(committed.finalChapterContent)
      expect(committed.finalChapterContent).toContain("chapter_status: final")
      expect(committed.decisionGates).toBeUndefined()
      expect(committed.reviewResults).toBeUndefined()
    }

    // 验证正式通道入参：conversationId / overwriteExisting / taskBrief 透传
    const firstCommitInput = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0] as {
      projectPath: string
      conversationId: string
      userRequest: string
      chapterNumber: number
      chapterPath: string
      finalChapterContent: string
      overwriteExisting: boolean
    }
    expect(firstCommitInput.projectPath).toBe("/mock/project")
    expect(firstCommitInput.conversationId).toBe("autonomous-campaign")
    expect(firstCommitInput.userRequest).toBe("brief-1")
    expect(firstCommitInput.chapterNumber).toBe(1)
    expect(firstCommitInput.chapterPath).toBe("/mock/project/wiki/chapters/chapter-001.md")
    expect(firstCommitInput.overwriteExisting).toBe(true)

    // 验证写入的内容被标记为 final 态
    const firstWriteContent: string = firstCommitInput.finalChapterContent
    expect(firstWriteContent).toContain("chapter_status: final")
    expect(firstWriteContent).toContain("# 第一章 风起")

    // 验证自动执行了 2 次 ingestChapter
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
    expect(acceptResult.ingestedCount).toBe(2)
  })

  it("DF-1: 晋升通道失败不直写、不计入成功，后续章仍提交", async () => {
    mocks.commitAcceptedDeepChapterDraft
      .mockRejectedValueOnce(new Error("status.json 不可用"))
      .mockResolvedValue(undefined)

    const res = await batchAcceptCampaignDrafts("/mock/project", [
      {
        chapterNumber: 1,
        title: "第一章",
        content: "第一章失败内容",
        taskBrief: "b1",
        draftContent: "d1",
        reviewResults: [],
        revised: false,
        wordCount: 100,
        status: "ready",
      },
      {
        chapterNumber: 2,
        title: "第二章",
        content: "第二章成功内容",
        taskBrief: "b2",
        draftContent: "d2",
        reviewResults: [],
        revised: false,
        wordCount: 100,
        status: "ready",
      },
    ],
    {
      autoIngest: false,
    })

    expect(res.acceptedCount).toBe(1)
    expect(res.acceptedCount).toBe(res.chapterPaths.length)
    expect(res.chapterPaths).toEqual([
      "/mock/project/wiki/chapters/chapter-002.md",
    ])
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledTimes(2)
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(2)
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
    // 验证触发了两次正式晋升通道落盘和两次事实摄取（收拢后不再直写）
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(2)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledTimes(2)
    for (const call of mocks.registerManagedCampaignDraft.mock.calls) {
      expect(call[0].decisionGates).toEqual({
        consistency: "passed",
        antiAi: "passed",
        quality: "passed",
      })
    }
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
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce(new Error("status.json 不可用"))

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
    })

    expect(report.results[0].autoAccepted).toBe(false)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
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
    const committedInput = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0] as {
      finalChapterContent: string
    }
    const written: string = committedInput.finalChapterContent
    expect(written).toContain("# 第7章")
  })

  it("batchAcceptCampaignDrafts 裸标题 + 正文富 H1 → 落盘为单一 canonical 富标题（不产生双 H1）", async () => {
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      {
        chapterNumber: 1,
        title: "第1章",
        content: "# 第1章 身体赎回倒计时\n\n白曦在门口站了两秒。",
        taskBrief: "b",
        draftContent: "d",
        reviewResults: [],
        revised: false,
        wordCount: 50,
        status: "ready",
      },
    ])
    expect(res.acceptedCount).toBe(1)
    const committedInput = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0] as {
      finalChapterContent: string
    }
    const written: string = committedInput.finalChapterContent
    // frontmatter 标题已升级为富标题（引号形式由 yaml 序列化决定，只校验解析值）
    expect(readFrontmatterTitle(written)).toBe("第1章 身体赎回倒计时")
    // 单一 canonical H1：不再同时出现「# 第1章」与「# 第1章 身体赎回倒计时」两条标题行
    const h1Lines = written.split("\n").filter((line) => /^#\s+/.test(line))
    expect(h1Lines).toEqual(["# 第1章 身体赎回倒计时"])
  })

  it("R6 格式回声：模型把正文包进代码围栏时，晋升剥除围栏不落进正式正文", async () => {
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      {
        chapterNumber: 1,
        title: "第1章",
        content: "```markdown\n# 第1章 雨夜\n\n白曦推门而入。\n```",
        taskBrief: "b",
        draftContent: "d",
        reviewResults: [],
        revised: false,
        wordCount: 20,
        status: "ready",
      },
    ])
    expect(res.acceptedCount).toBe(1)
    const committedInput = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0] as {
      finalChapterContent: string
    }
    const written: string = committedInput.finalChapterContent
    // 围栏字面量不得进入正式正文
    expect(written).not.toContain("```")
    expect(written).not.toContain("markdown")
    // 正文实体保留
    expect(written).toContain("白曦推门而入。")
    expect(readFrontmatterTitle(written)).toBe("第1章 雨夜")
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
        llmConfig: { ...mockLlmConfig, model: undefined as unknown as string },
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

  it("filterAcceptableChapters 仅保留ready且正文非空", () => {
    const mk = (chapterNumber: number, status: CampaignChapterResult["status"], content: string): CampaignChapterResult => ({
      chapterNumber,
      content,
      taskBrief: "b",
      draftContent: "d",
      reviewResults: [],
      revised: false,
      wordCount: content.length,
      status,
    })
    const out = filterAcceptableChapters([
      mk(1, "ready", "正文"),
      mk(2, "blocked", "正文"),
      mk(3, "ready", "   "),
      mk(4, "partial", "正文"),
    ])
    expect(out.map((c) => c.chapterNumber)).toEqual([1])
  })

  it("F3: arbitrationProvider 缺省时保持现有 paused 行为", async () => {
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

    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 3,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      onProgress,
    })

    // 未传 arbitrationProvider：第二章 blocked 后安全挂起，第三章未被调度
    expect(report.results).toHaveLength(2)
    expect(report.results[1].status).toBe("blocked")
    expect(report.results[1].skipped).toBeFalsy()
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arbitration-pending" }),
    )
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("F3: retry 指令用 revisedBrief 重跑成功后继续下一章", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章首跑被门控阻断",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "failed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: true,
        retryCount: 3,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第一章重跑后全绿",
        taskBrief: "revised-brief-1",
        draftContent: "draft1-retry",
        reviewResults: [],
        revised: true,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章全绿",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const provider = vi.fn(
      async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
        action: "retry-rebrief",
        revisedBrief: "revised-brief-1",
        reason: "放宽门限后重跑",
      }),
    )
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      buildChapterRequest: async (num: number) => `brief-${num}`,
      arbitrationProvider: provider,
      onProgress,
    })

    expect(provider).toHaveBeenCalledTimes(1)
    const arbReq = provider.mock.calls[0][0] as ArbitrationRequest
    expect(arbReq.chapterNumber).toBe(1)
    expect(arbReq.status).toBe("blocked")
    // 重跑确实用 revisedBrief 作为本章请求
    const retryInput = mocks.runDeepChapterGeneration.mock.calls[1][0] as { userRequest: string }
    expect(retryInput.userRequest).toBe("revised-brief-1")
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(3)
    expect(report.results).toHaveLength(2)
    expect(report.results[0].status).toBe("ready")
    expect(report.results[1].status).toBe("ready")
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arbitration-retry" }),
    )
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("F3: retry 重跑仍失败则 paused（单章只重跑一次）", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章首跑被阻断",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "failed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: true,
        retryCount: 3,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第一章重跑仍被阻断",
        taskBrief: "revised-brief-1",
        draftContent: "draft1-retry",
        reviewResults: [],
        revised: true,
        decisionGates: { consistency: "failed", antiAi: "passed", quality: "failed" },
        manualReviewRequired: true,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const provider = vi.fn(
      async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
        action: "retry-rebrief",
        revisedBrief: "revised-brief-1",
        reason: "再次尝试",
      }),
    )
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      arbitrationProvider: provider,
      onProgress,
    })

    // 首跑 + 重跑各一次，重跑仍失败则挂起，不再二次仲裁
    expect(provider).toHaveBeenCalledTimes(1)
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(2)
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("blocked")
    expect(report.results[0].skipped).toBeFalsy()
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arbitration-retry" }),
    )
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("F3: skip 指令标记跳过并继续下一章", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章出现严重冲突",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "failed", antiAi: "passed", quality: "failed" },
        manualReviewRequired: true,
        retryCount: 3,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章全绿",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: [],
        revised: false,
        decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const provider = vi.fn(
      async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
        action: "skip-chapter",
        reason: "本章冲突跳过",
      }),
    )
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      arbitrationProvider: provider,
      onProgress,
    })

    expect(provider).toHaveBeenCalledTimes(1)
    // 跳过章不重跑，下一章照常推进
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(2)
    expect(report.results).toHaveLength(2)
    expect(report.results[0].status).toBe("blocked")
    expect(report.results[0].skipped).toBe(true)
    expect(report.results[1].status).toBe("ready")
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arbitration-skip" }),
    )
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("F3: provider 返回 null 指令时保持 paused", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "第一章出现严重冲突",
      taskBrief: "brief1",
      draftContent: "draft1",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "failed", antiAi: "passed", quality: "failed" },
      manualReviewRequired: true,
      retryCount: 3,
      partial: false,
      partialReason: null,
    })

    const provider = vi.fn(
      async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => null,
    )
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      arbitrationProvider: provider,
      onProgress,
    })

    expect(provider).toHaveBeenCalledTimes(1)
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(1)
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("blocked")
    expect(report.results[0].skipped).toBeFalsy()
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("M2: 缺省novelConfig走满血预设（sceneBreakdown默认开）；显式传入优先", async () => {
    expect(CRUISE_FULL_CONFIG.sceneBreakdownEnabled).toBe(true)
    mocks.runDeepChapterGeneration.mockResolvedValue({
      finalContent: "满血巡航正文",
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
    // 缺省：不断言内部novelConfig值，只验满血链路不断且门控全绿可晋升
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
    })
    expect(report.results[0].status).toBe("ready")
    const calls = mocks.runDeepChapterGeneration.mock.calls
    const lastCall = calls[calls.length - 1]?.[0] as { novelConfig?: { sceneBreakdownEnabled?: boolean } }
    expect(lastCall.novelConfig?.sceneBreakdownEnabled).toBe(true)
  })
})


describe("campaign-runner 覆盖率增补：F2 零成本约束/R3 遥测/仲裁异常路径", () => {
  // 自包含隔离：本块不依赖外层 describe 的 beforeEach，逐用例重置全部 mock
  // （调用记录 + 实现），避免 Once 队列与调用下标串味。
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runDeepChapterGeneration.mockReset()
    mocks.createDirectory.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockReset()
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.commitAcceptedDeepChapterDraft.mockReset()
    mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
    mocks.registerManagedCampaignDraft.mockReset()
    mocks.registerManagedCampaignDraft.mockResolvedValue("draft://autonomous-campaign")
    mocks.ingestChapter.mockReset()
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapter: 1 } })
    mocks.appendStageMetric.mockReset()
    mocks.appendStageMetric.mockResolvedValue(undefined)
    mocks.updateNovelSessionStatus.mockReset()
    mocks.updateNovelSessionStatus.mockResolvedValue(undefined)
    mocks.buildNextStatus.mockReset()
    mocks.buildNextStatus.mockImplementation((base: unknown, overrides: unknown) => ({
      ...((base ?? {}) as Record<string, unknown>),
      ...((overrides ?? {}) as Record<string, unknown>),
    }))
    mocks.listBindableNovelCharacters.mockReset()
    mocks.listBindableNovelCharacters.mockResolvedValue([])
    mocks.loadBinding.mockReset()
    mocks.loadBinding.mockResolvedValue(null)
    mocks.loadSegmentSummaries.mockReset()
    mocks.loadSegmentSummaries.mockResolvedValue({})
    mocks.getLatestSegmentSummaryText.mockReset()
    mocks.getLatestSegmentSummaryText.mockReturnValue("")
    mocks.enrichWithEventPool.mockReset()
    mocks.enrichWithEventPool.mockImplementation(async (input: { request: string }) => `${input.request}\n\n【mock事件池】`)
  })

  function readyOnce(finalContent = "全绿正文内容，故事自然展开，情节完整。") {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent,
      taskBrief: "brief-x",
      draftContent: "draft-x",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
    })
  }

  function blockedOnce() {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "门控失败章节正文",
      taskBrief: "brief-bad",
      draftContent: "draft-bad",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "failed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: true,
      retryCount: 3,
      partial: false,
      partialReason: null,
    })
  }

  it("绑定含视点 + 可绑定人物 → 零成本注入 pov 约束（182-193/289 真分支）", async () => {
    mocks.loadBinding.mockResolvedValue({ frameworkId: "fw", pov: "寨主" })
    mocks.listBindableNovelCharacters.mockResolvedValue(["寨主", "军师"])
    readyOnce()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })
    expect(report.results).toHaveLength(1)
    const input = mocks.runDeepChapterGeneration.mock.calls[0][0]
    // pov 约束与人物约束都进入装配后的 userRequest；军师为非视点人物一并传入
    expect(String(input.userRequest)).toContain("寨主")
    expect(mocks.enrichWithEventPool).not.toHaveBeenCalled()
  })

  it("人物/绑定读取失败 → 降级空约束不断巡航（277/284 catch）", async () => {
    mocks.listBindableNovelCharacters.mockRejectedValueOnce(new Error("entities down"))
    mocks.loadBinding.mockRejectedValueOnce(new Error("binding down"))
    readyOnce()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("ready")
  })

  it("enableEventPool 開启 → 事件池注入装配 userRequest（299-307）", async () => {
    readyOnce()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      enableEventPool: true,
    })
    expect(report.results[0].status).toBe("ready")
    expect(mocks.enrichWithEventPool).toHaveBeenCalledTimes(1)
    expect(mocks.enrichWithEventPool.mock.calls[0][0]).toEqual(
      expect.objectContaining({ chapterNumber: 1, totalChapters: 1, characters: [] }),
    )
    const input = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(String(input.userRequest)).toContain("【mock事件池】")
  })

  it("墙钟回拨 → stageLatencyMs 钳 0（201 cond-expr 真分支）", async () => {
    readyOnce()
    const nowSpy = vi.spyOn(Date, "now")
    // 严格递减时钟：任一 chapterT0 都大于其后所有读数 → d 恒负 → 必走钳制分支。
    // 若实现去掉钳制，latencyMs 将为负数，断言即变红。
    let t = 10 ** 12
    nowSpy.mockImplementation(() => (t -= 1))
    try {
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 1,
        llmConfig: mockLlmConfig,
      })
      expect(report.results[0].status).toBe("ready")
      expect(mocks.appendStageMetric).toHaveBeenCalledWith(
        "/mock/project",
        expect.objectContaining({ latencyMs: 0 }),
      )
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("会话指针 mutator 见空会话 → 两处三元走 null 分支（246/646）", async () => {
    readyOnce()
    mocks.updateNovelSessionStatus.mockImplementation(
      async (_pp: unknown, mutator: (s: unknown) => unknown) => {
        mutator(null)
        return undefined
      },
    )
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })
    expect(report.results[0].status).toBe("ready")
    expect(mocks.updateNovelSessionStatus).toHaveBeenCalledTimes(2)
  })

  it("仲裁 provider 抛错 → 警告后保持安全挂起（430-433 + 暂停尾）", async () => {
    blockedOnce()
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      arbitrationProvider: async () => {
        throw new Error("arb down")
      },
      onProgress,
    })
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("blocked")
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
    // 暂停尾 R3 终局指标照写（appendStageMetric 已 mock 为函数）
    expect(mocks.appendStageMetric).toHaveBeenCalledWith(
      "/mock/project",
      expect.objectContaining({ stage: "campaign:chapter" }),
    )
  })

  it("仲裁指令非法（缺 revisedBrief）→ 警告后保持安全挂起（439-442）", async () => {
    blockedOnce()
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      arbitrationProvider: async () => ({ action: "retry-rebrief", reason: "放宽门限" }),
      onProgress,
    })
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("blocked")
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-paused" }),
    )
  })

  it("自动晋升通道抛错 → 警告且本章 autoAccepted 为 false（388）", async () => {
    readyOnce()
    mocks.createDirectory.mockRejectedValueOnce(new Error("mkdir down"))
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
    })
    expect(report.results).toHaveLength(1)
    expect(report.results[0].status).toBe("ready")
    expect(report.results[0].autoAccepted).toBe(false)
  })

  it("段摘要加载失败 → 前情承接降级空串不断巡航（585）", async () => {
    mocks.loadSegmentSummaries.mockRejectedValueOnce(new Error("seg down"))
    readyOnce()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })
    expect(report.results[0].status).toBe("ready")
    expect(mocks.getLatestSegmentSummaryText).not.toHaveBeenCalled()
  })

  it("taskBrief 缺失 → 晋升请求回退默认文案（736-737）", async () => {
    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        {
          chapterNumber: 7,
          title: "",
          content: "正文内容足够长",
          taskBrief: "",
          draftContent: "d",
          reviewResults: [],
          revised: false,
          wordCount: 7,
          status: "ready",
        },
      ],
      { autoIngest: false },
    )
    expect(res.acceptedCount).toBe(1)
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "请撰写第 7 章正文。" }),
    )
  })
})

describe("campaign-runner 覆盖率增补第二轮：绑定无视点回退", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runDeepChapterGeneration.mockReset()
    mocks.createDirectory.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockReset()
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.commitAcceptedDeepChapterDraft.mockReset()
    mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
    mocks.registerManagedCampaignDraft.mockReset()
    mocks.registerManagedCampaignDraft.mockResolvedValue("draft://autonomous-campaign")
    mocks.ingestChapter.mockReset()
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapter: 1 } })
    mocks.appendStageMetric.mockReset()
    mocks.appendStageMetric.mockResolvedValue(undefined)
    mocks.updateNovelSessionStatus.mockReset()
    mocks.updateNovelSessionStatus.mockResolvedValue(undefined)
    mocks.buildNextStatus.mockReset()
    mocks.listBindableNovelCharacters.mockReset()
    mocks.listBindableNovelCharacters.mockResolvedValue([])
    mocks.loadBinding.mockReset()
    mocks.loadSegmentSummaries.mockReset()
    mocks.loadSegmentSummaries.mockResolvedValue({})
    mocks.getLatestSegmentSummaryText.mockReset()
    mocks.getLatestSegmentSummaryText.mockReturnValue("")
    mocks.enrichWithEventPool.mockReset()
  })

  it("绑定对象无有效视点字段 → extractBindingPovName 回退 null（193）", async () => {
    mocks.loadBinding.mockResolvedValue({ frameworkId: "fw", pov: "   ", viewpoint: 123 })
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "全绿正文内容，故事自然展开，情节完整。",
      taskBrief: "brief-x",
      draftContent: "draft-x",
      reviewResults: [],
      revised: false,
      decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
    })
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
    })
    expect(report.results[0].status).toBe("ready")
    const input = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(String(input.userRequest)).not.toContain("寨主")
  })
})
