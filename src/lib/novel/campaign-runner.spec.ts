// @vitest-environment node
import { Buffer } from "node:buffer"
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
import type { IngestResult } from "./chapter-ingest"
import { readFrontmatterTitle } from "./chapter-typography"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { buildDecisionGates } from "./deep-chapter-decision-gates"
import type { DeepChapterGenerationResult } from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

const mocks = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  runDeepChapterGeneration: vi.fn(),
  createDirectory: vi.fn(),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    mocks.files.set(path, Buffer.from(content, "utf8"))
  }),
  findChapterFileByNumber: vi.fn(async (): Promise<string | null> => null),
  commitAcceptedDeepChapterDraft: vi.fn<typeof import("./formal-writeback").commitAcceptedDeepChapterDraft>(),
  registerManagedCampaignDraft: vi.fn<typeof import("./novel-session-status").registerManagedCampaignDraft>(),
  ingestChapter: vi.fn<typeof import("./chapter-ingest").ingestChapter>(),
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
  loadOutlineModel: vi.fn(),
  getChapterVolumes: vi.fn(),
}))

vi.mock("./deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("@/commands/fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/commands/fs")>(),
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
  fileExists: async (path: string) => mocks.files.has(path),
  readFile: async (path: string) => {
    const bytes = mocks.files.get(path)
    if (!bytes) throw new Error(`ENOENT: ${path}`)
    return bytes.toString("utf8")
  },
  readFileAsBase64: async (path: string) => {
    const bytes = mocks.files.get(path)
    if (!bytes) throw new Error(`ENOENT: ${path}`)
    return { base64: bytes.toString("base64"), mimeType: "text/markdown" }
  },
  writeFilesAtomic: async (files: Array<[string, string]>) => {
    for (const [path, content] of files) mocks.files.set(path, Buffer.from(content, "utf8"))
  },
  deleteFile: async (path: string) => { mocks.files.delete(path) },
}))

vi.mock("./chapter-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chapter-utils")>(),
  findChapterFileByNumber: mocks.findChapterFileByNumber,
}))

vi.mock("./formal-writeback", async (importOriginal) => ({
  ...await importOriginal<typeof import("./formal-writeback")>(),
  commitAcceptedDeepChapterDraft: mocks.commitAcceptedDeepChapterDraft,
}))

vi.mock("./novel-session-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("./novel-session-status")>(),
  registerManagedCampaignDraft: mocks.registerManagedCampaignDraft,
  appendStageMetric: mocks.appendStageMetric,
  updateNovelSessionStatus: mocks.updateNovelSessionStatus,
  buildNextStatus: mocks.buildNextStatus,
}))

vi.mock("./emotion-ledger", async (importOriginal) => ({
  ...await importOriginal<typeof import("./emotion-ledger")>(),
  updateEmotionLedgerFromChapter: vi.fn(),
}))

vi.mock("./promotion-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("./promotion-bridge")>(),
  promote: vi.fn(),
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

vi.mock("./rebuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild")>()),
  verifyRebuildOutcome: vi.fn(async () => {}),
}))
vi.mock("./chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))

vi.mock("./canon-dual-write", () => ({
  defaultCanonDualWriteDeps: mocks.defaultCanonDualWriteDeps,
}))

vi.mock("./outline-model-store", () => ({
  loadOutlineModel: mocks.loadOutlineModel,
}))

vi.mock("./volume", () => ({
  getChapterVolumes: mocks.getChapterVolumes,
}))

const p0Findings: NovelReviewResult[] = [{
  type: "consistency",
  severity: "error",
  message: "角色获知尚未揭露的事实",
  evidence: "冲突段落",
  suggestion: "保留角色认知边界",
  relatedMemory: "",
}]
const previewGates = () => buildDecisionGates([], 0, false, undefined, false)

function generatedBody(finalContent: string, changes: Partial<DeepChapterGenerationResult> = {}): DeepChapterGenerationResult {
  return {
    finalContent,
    taskBrief: "任务书",
    draftContent: finalContent,
    reviewResults: [],
    revised: false,
    decisionGates: previewGates(),
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    ...changes,
  }
}

async function reviewedChapter(
  chapterNumber: number,
  content: string,
  changes: Partial<CampaignChapterResult> = {},
): Promise<CampaignChapterResult> {
  return {
    title: `第${chapterNumber}章`,
    taskBrief: "b",
    draftContent: "d",
    reviewResults: [],
    revised: false,
    wordCount: content.length,
    status: "ready",
    decisionGates: buildDecisionGates([], 0),
    ...changes,
    chapterNumber,
    content,
    reviewedBodySha256: await computeCheckpointDigest(JSON.stringify([chapterNumber, content])),
  }
}

function verifiedIngest(chapterNumber: number): IngestResult {
  const chapterId = `chapter-${chapterNumber}`
  const canonOutcome = { status: "skipped", reason: "no_facts" } as const
  return {
    snapshot: {
      chapterId, chapterNumber, summary: "提取摘要",
      characters: [], locations: [], organizations: [], items: [], events: [],
      characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
      foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [], conflicts: [],
      endingHook: "", graphNodes: [], graphEdges: [],
    },
    ledgerSaveFailed: false,
    factsStoreFailed: false,
    failedProjections: [],
    pendingProjections: [],
    committedProjections: ["sync_snapshot_to_memory"],
    canonOutcome,
    receipt: {
      readPath: `/mock/project/wiki/chapters/chapter-${String(chapterNumber).padStart(3, "0")}.md`,
      chapterNumber,
      bodySha256: "body-sha",
      contentSha256: "document-sha",
      snapshotIdAtExtractionCommit: `${chapterId}-r7`,
      snapshotRevisionAtExtractionCommit: 7,
      snapshotJsonSha256AtExtractionCommit: "json-sha-7",
      canonOutcome,
    },
    projectionReceipt: {
      extractionHistoryPath: `/mock/project/.novel/history/${chapterId}-r7.json`,
      snapshotId: `${chapterId}-r8`,
      revision: 8,
      snapshotJsonSha256: "json-sha-8",
    },
  }
}

beforeEach(() => {
  mocks.files.clear()
  mocks.findChapterFileByNumber.mockReset()
})

describe("Autonomous Draft Campaign Runner (预演式批量战役调度器)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runDeepChapterGeneration.mockReset()
    mocks.createDirectory.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockReset()
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
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "no_llm" })
    mocks.loadOutlineModel.mockReset()
    mocks.loadOutlineModel.mockResolvedValue({ model: null, migratedFrom: null })
    mocks.getChapterVolumes.mockReset()
    mocks.getChapterVolumes.mockResolvedValue([])
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
        decisionGates: previewGates(),
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
      reviewResults: p0Findings,
      revised: false,
      decisionGates: buildDecisionGates(p0Findings, 3, true),
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
    mocks.ingestChapter.mockResolvedValueOnce(verifiedIngest(1)).mockResolvedValueOnce(verifiedIngest(2))
    const mockResults: CampaignChapterResult[] = [
      await reviewedChapter(1, "这是第一章正式内容", { title: "第一章 风起", taskBrief: "brief-1" }),
      await reviewedChapter(2, "这是第二章正式内容", { title: "第二章 云涌", taskBrief: "brief-2" }),
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
      const registered = mocks.registerManagedCampaignDraft.mock.calls[index][0]
      const committed = mocks.commitAcceptedDeepChapterDraft.mock.calls[index][0]
      expect(registered.conversationId).toBe(committed.conversationId)
      expect(registered.chapterNumber).toBe(committed.chapterNumber)
      expect(registered.userRequest).toBe(committed.userRequest)
      expect(registered.finalContent).toBe(mockResults[index].content)
      expect(registered.decisionGates).toEqual(mockResults[index].decisionGates)
      expect(registered.finalConsistencyReviewed).toBe(true)
      expect(committed.finalChapterContent.split("\n---\n")[1]).toBe(registered.finalContent)
    }

    const firstCommitInput = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0]
    expect(firstCommitInput.projectPath).toBe("/mock/project")
    expect(firstCommitInput.conversationId).toMatch(/^autonomous-campaign-1-[\da-f-]{36}$/)
    expect(firstCommitInput.userRequest).toBe("brief-1")
    expect(firstCommitInput.chapterNumber).toBe(1)
    expect(firstCommitInput.chapterPath).toBe("/mock/project/wiki/chapters/chapter-001.md")
    expect(firstCommitInput.overwriteExisting).toBeUndefined()
    expect(firstCommitInput.expectedExistingContent).toBeNull()

    // 验证写入的内容被标记为 final 态
    const firstWriteContent: string = firstCommitInput.finalChapterContent
    expect(firstWriteContent).toContain("chapter_status: final")
    expect(readFrontmatterTitle(firstWriteContent)).toBe("第一章 风起")

    // 验证自动执行了 2 次 ingestChapter
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
    expect(acceptResult.ingestedCount).toBe(2)
  })

  it("batchAcceptCampaignDrafts 显式透传 awaitCommunitySummary: true，确保异步社区摘要模式下回读不误判 pending", async () => {
    mocks.ingestChapter.mockResolvedValueOnce(verifiedIngest(1))
    const asyncNovelConfig = { ...CRUISE_FULL_CONFIG, communitySummaryAsync: true }
    const acceptResult = await batchAcceptCampaignDrafts(
      "/mock/project",
      [await reviewedChapter(1, "这是第一章正式内容", { title: "第一章 风起", taskBrief: "brief-1" })],
      {
        autoIngest: true,
        llmConfig: mockLlmConfig,
        novelConfig: asyncNovelConfig,
      },
    )

    expect(acceptResult.acceptedCount).toBe(1)
    expect(acceptResult.ingestedCount).toBe(1)
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(1)
    expect(mocks.ingestChapter.mock.calls[0]?.[4]).toMatchObject({
      llmConfig: mockLlmConfig,
      novelConfig: asyncNovelConfig,
      awaitCommunitySummary: true,
    })
  })

  it("DF-1: 晋升通道失败不直写、不计入成功，后续章仍提交", async () => {
    mocks.commitAcceptedDeepChapterDraft
      .mockRejectedValueOnce(new Error("status.json 不可用"))
      .mockResolvedValue(undefined)

    const res = await batchAcceptCampaignDrafts("/mock/project", [
      await reviewedChapter(1, "第一章失败内容", { taskBrief: "b1" }),
      await reviewedChapter(2, "第二章成功内容", { taskBrief: "b2" }),
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
    const decisionGates = buildDecisionGates([], 0)
    mocks.ingestChapter.mockResolvedValueOnce(verifiedIngest(1)).mockResolvedValueOnce(verifiedIngest(2))
    mocks.runDeepChapterGeneration.mockResolvedValue({
      finalContent: "巡航生成的正文内容",
      taskBrief: "brief",
      draftContent: "draft",
      reviewResults: [],
      revised: false,
      decisionGates,
      finalConsistencyReviewed: true,
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
      confirmAutoAccept: true,
      onProgress,
    })

    expect(report.completedChapters).toBe(2)
    expect(report.results[0].autoAccepted).toBe(true)
    expect(report.results[1].autoAccepted).toBe(true)
    expect(report.results.every((chapter) => chapter.autoIngested === true)).toBe(true)
    expect(report.summary.allPassed).toBe(true)
    // 验证触发了两次正式晋升通道落盘和两次事实摄取（收拢后不再直写）
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledTimes(2)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(2)
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledTimes(2)
    for (const call of mocks.registerManagedCampaignDraft.mock.calls) {
      expect(call[0].decisionGates).toEqual(decisionGates)
      expect(call[0].finalConsistencyReviewed).toBe(true)
    }
  })

  it("counts only verified memory while separately reporting formally accepted cruise chapters", async () => {
    const pending = { ...verifiedIngest(1), pendingProjections: ["rebuild_graph"] }
    const receiptless = { ...verifiedIngest(2), projectionReceipt: undefined }
    mocks.ingestChapter
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(receiptless)
      .mockResolvedValueOnce(verifiedIngest(3))
    mocks.runDeepChapterGeneration.mockResolvedValue(generatedBody("已复核的正文。", {
      decisionGates: buildDecisionGates([], 0), finalConsistencyReviewed: true,
    }))

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project", startChapter: 1, chapterCount: 3, llmConfig: mockLlmConfig, cruiseMode: true, confirmAutoAccept: true,
    })

    expect(report.results.map((chapter) => [chapter.autoAccepted, chapter.autoIngested])).toEqual([
      [true, false], [true, false], [true, true],
    ])
    expect(report.summary.allPassed).toBe(true)
  })

  it.each([
    { decisionGates: buildDecisionGates([], 0) },
    { decisionGates: buildDecisionGates(p0Findings, 1), finalConsistencyReviewed: true, reviewResults: p0Findings },
  ])("pauses ready cruise output with no valid adoption receipt: %o", async (gates) => {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce(generatedBody("预演正文。", gates))
    const onProgress = vi.fn()
    const arbitrationProvider = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project", startChapter: 1, chapterCount: 2, llmConfig: mockLlmConfig,
      cruiseMode: true, confirmAutoAccept: true, onProgress, arbitrationProvider,
    })

    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledOnce()
    expect(report.results).toMatchObject([{ status: "ready", autoAccepted: false, autoIngested: false }])
    expect(report.results[0].reviewedBodySha256).toBeUndefined()
    expect(report.summary).toMatchObject({ readyCount: 1, allPassed: false })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "cruise-paused", message: expect.stringContaining("缺少与正文绑定的复核凭证"),
    }))
    expect(arbitrationProvider).not.toHaveBeenCalled()
    expect(mocks.registerManagedCampaignDraft).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("全自动巡航模式安全挂起：某章出现 blocked 时停止后续连写并保留现场", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章全绿",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章出现严重冲突",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: p0Findings,
        revised: false,
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
        decisionGates: previewGates(),
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
      confirmAutoAccept: true,
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
        decisionGates: previewGates(),
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
        decisionGates: previewGates(),
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
      confirmAutoAccept: true,
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
      decisionGates: buildDecisionGates([], 0),
      finalConsistencyReviewed: true,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
    })
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce(new Error("status.json 不可用"))

    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      confirmAutoAccept: true,
      onProgress,
    })

    expect(report.results[0]).toMatchObject({ status: "ready", autoAccepted: false, autoIngested: false })
    expect(report.summary.allPassed).toBe(false)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "cruise-paused", message: expect.stringContaining("正式正文未验收落盘"),
    }))
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("batchAcceptCampaignDrafts 默认标题回退与过滤空白内容", async () => {
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      await reviewedChapter(7, "第七章内容", { title: undefined }),
      await reviewedChapter(8, "   "),
    ])
    expect(res.acceptedCount).toBe(1)
    const written = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0].finalChapterContent
    expect(readFrontmatterTitle(written)).toBe("第7章")
    expect(written.split("\n---\n")[1]).toBe("第七章内容")
  })

  it("batchAcceptCampaignDrafts 裸标题 + 正文富 H1 → 落盘为单一 canonical 富标题（不产生双 H1）", async () => {
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      await reviewedChapter(1, "# 第1章 身体赎回倒计时\n\n白曦在门口站了两秒。"),
    ])
    expect(res.acceptedCount).toBe(1)
    const written = mocks.commitAcceptedDeepChapterDraft.mock.calls[0][0].finalChapterContent
    // frontmatter 标题已升级为富标题（引号形式由 yaml 序列化决定，只校验解析值）
    expect(readFrontmatterTitle(written)).toBe("第1章 身体赎回倒计时")
    // 单一 canonical H1：不再同时出现「# 第1章」与「# 第1章 身体赎回倒计时」两条标题行
    const h1Lines = written.split("\n").filter((line) => /^#\s+/.test(line))
    expect(h1Lines).toEqual(["# 第1章 身体赎回倒计时"])
  })

  it("writes the exact reviewed body including fences and gives a later attempt its own draft", async () => {
    const { registerManagedCampaignDraft, novelDraftArtifactPath, loadNovelDraftArtifact } = await vi.importActual<typeof import("./novel-session-status")>("./novel-session-status")
    const { commitAcceptedDeepChapterDraft } = await vi.importActual<typeof import("./formal-writeback")>("./formal-writeback")
    mocks.registerManagedCampaignDraft.mockImplementation(registerManagedCampaignDraft)
    mocks.commitAcceptedDeepChapterDraft.mockImplementation(commitAcceptedDeepChapterDraft)
    const body = "```markdown\n# 第1章 雨夜\n\n白曦推门而入。\n```\n"
    const reviewed = await reviewedChapter(1, body)
    const res = await batchAcceptCampaignDrafts("/mock/project", [
      reviewed,
    ])

    expect(res.acceptedCount).toBe(1)
    const [path] = res.chapterPaths
    const written = mocks.files.get(path)?.toString("utf8") ?? ""
    expect(written).toContain("chapter_status: final")
    expect(written.split("\n---\n")[1]).toBe(body)
    const firstId = mocks.registerManagedCampaignDraft.mock.calls[0][0].conversationId
    const firstPath = novelDraftArtifactPath("/mock/project", firstId)
    const firstDraftBytes = mocks.files.get(firstPath)
    expect(await loadNovelDraftArtifact("/mock/project", firstId)).toMatchObject({
      draft_status: "accepted",
      chapter_number: 1,
      content: body,
      adoption_gate: { status: "passed", bodySha256: reviewed.reviewedBodySha256 },
    })

    // 删除正式文件后重试，新的受管草稿不能覆盖已采纳草稿。
    mocks.files.delete(path)
    const retry = await batchAcceptCampaignDrafts("/mock/project", [await reviewedChapter(1, "重新审查后的正文。")])
    const retryId = mocks.registerManagedCampaignDraft.mock.calls[1][0].conversationId
    expect(retry.acceptedCount).toBe(1)
    expect(retryId).not.toBe(firstId)
    expect(mocks.files.get(firstPath)).toEqual(firstDraftBytes)
  })

  it("does not register, write or ingest a mutated body, a receiptless draft, or P0-blocked content", async () => {
    const changed = { ...await reviewedChapter(1, "original body"), content: "original body " }
    const receiptless = { ...await reviewedChapter(2, "receiptless body"), reviewedBodySha256: undefined }
    const blocked = await reviewedChapter(3, "blocked body", { decisionGates: buildDecisionGates(p0Findings, 1) })

    await expect(batchAcceptCampaignDrafts("/mock/project", [changed, receiptless, blocked], {
      autoIngest: true, llmConfig: mockLlmConfig,
    })).resolves.toEqual({ acceptedCount: 0, ingestedCount: 0, chapterPaths: [] })

    expect(mocks.registerManagedCampaignDraft).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("leaves a conflicting substantive target untouched instead of registering or accepting it", async () => {
    const chapterPath = "/mock/project/wiki/chapters/chapter-004.md"
    const existing = Buffer.from("---\ntype: chapter\nchapter_number: 4\nchapter_status: final\n---\n旧正文。", "utf8")
    mocks.files.set(chapterPath, existing)
    const chapter = await reviewedChapter(4, "新正文。")

    await expect(batchAcceptCampaignDrafts("/mock/project", [chapter])).resolves.toEqual({
      acceptedCount: 0, chapterPaths: [], ingestedCount: 0,
    })
    expect(mocks.registerManagedCampaignDraft).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.files.get(chapterPath)).toEqual(existing)
  })

  it("adopts only the unchanged skeleton handed off by the incubator", async () => {
    const { unpackOutlineToChapterFiles } = await import("./outline-chapter-unpack")
    const { registerManagedCampaignDraft } = await vi.importActual<typeof import("./novel-session-status")>("./novel-session-status")
    const { commitAcceptedDeepChapterDraft } = await vi.importActual<typeof import("./formal-writeback")>("./formal-writeback")
    mocks.registerManagedCampaignDraft.mockImplementation(registerManagedCampaignDraft)
    mocks.commitAcceptedDeepChapterDraft.mockImplementation(commitAcceptedDeepChapterDraft)
    const projectPath = "/mock/project"
    const skeletons = await unpackOutlineToChapterFiles({
      projectPath,
      outlineContent: "## 第1章 风起\n第一章提纲。\n\n## 第2章 云涌\n第二章提纲。",
    })
    const [unchangedPath, changedPath] = skeletons.createdFiles
    const changed = Buffer.from(`${mocks.files.get(changedPath)?.toString("utf8")}作者修改。`, "utf8")
    mocks.files.set(changedPath, changed)
    const body = "完整复核正文。"

    const accepted = await batchAcceptCampaignDrafts(projectPath, [await reviewedChapter(1, body), await reviewedChapter(2, body)], {
      incubationSkeletons: skeletons.createdSkeletons,
    })

    expect(accepted).toEqual({ acceptedCount: 1, chapterPaths: [unchangedPath], ingestedCount: 0 })
    expect(mocks.files.get(unchangedPath)?.toString("utf8")).toContain("chapter_status: final")
    expect(mocks.files.get(unchangedPath)?.toString("utf8").split("\n---\n")[1]).toBe(body)
    expect(mocks.files.get(changedPath)).toEqual(changed)
  })

  it("batchAcceptCampaignDrafts 单章事实摄取失败时记录日志且不中断后续章节", async () => {
    mocks.ingestChapter.mockRejectedValueOnce(new Error("事实摄取超时"))

    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [
        await reviewedChapter(10, "第十章内容"),
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
        await reviewedChapter(11, "第十一章内容"),
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
        await reviewedChapter(12, "第十二章内容"),
      ],
      {
        autoIngest: false,
      },
    )
    expect(resNoIngest.acceptedCount).toBe(1)
    expect(resNoIngest.ingestedCount).toBe(0)
  })

  it("batchAcceptCampaignDrafts 动态模块导入失败时捕获异常并记录日志", async () => {
    const chapter = await reviewedChapter(13, "第十三章内容")
    const spy = vi.spyOn(Promise, "all").mockRejectedValueOnce(new Error("模块加载器崩溃"))

    const res = await batchAcceptCampaignDrafts(
      "/mock/project",
      [chapter],
      {
        autoIngest: true,
        llmConfig: mockLlmConfig,
      },
    )

    expect(res.acceptedCount).toBe(1)
    expect(res.ingestedCount).toBe(0)
    spy.mockRestore()
  })

  it("filterAcceptableChapters 仅保留带复核凭证、未自动落盘且正文非空的就绪章节", async () => {
    const out = filterAcceptableChapters([
      await reviewedChapter(1, "正文"),
      await reviewedChapter(2, "正文", { status: "blocked" }),
      await reviewedChapter(3, "   "),
      await reviewedChapter(4, "正文", { status: "partial" }),
      await reviewedChapter(5, "正文", { autoAccepted: true }),
      { ...await reviewedChapter(6, "正文"), reviewedBodySha256: undefined },
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
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章出现严重冲突",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: p0Findings,
        revised: false,
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
      confirmAutoAccept: true,
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
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
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
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
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
      confirmAutoAccept: true,
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
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
      confirmAutoAccept: true,
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

  it("F3: a retry that is only ready without formal acceptance still pauses", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce(generatedBody("首跑未通过。", {
        decisionGates: buildDecisionGates(p0Findings, 1, true),
        reviewResults: p0Findings,
        manualReviewRequired: true,
      }))
      .mockResolvedValueOnce(generatedBody("重跑正文未获复核凭证。", { decisionGates: buildDecisionGates([], 0) }))
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project", startChapter: 1, chapterCount: 2, llmConfig: mockLlmConfig, cruiseMode: true, confirmAutoAccept: true,
      arbitrationProvider: async () => ({ action: "retry-rebrief", reason: "测试修订", revisedBrief: "重写本章" }),
      onProgress,
    })

    expect(report.results).toMatchObject([{ status: "ready", autoAccepted: false }])
    expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(2)
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "cruise-paused", message: expect.stringContaining("缺少与正文绑定的复核凭证"),
    }))
  })

  it("F3: skip 指令标记跳过并继续下一章", async () => {
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章出现严重冲突",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: buildDecisionGates(p0Findings, 3, true),
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
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
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
      confirmAutoAccept: true,
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
      decisionGates: buildDecisionGates(p0Findings, 3, true),
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
      confirmAutoAccept: true,
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
      decisionGates: previewGates(),
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
      confirmAutoAccept: true,
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
    mocks.commitAcceptedDeepChapterDraft.mockReset()
    mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
    mocks.registerManagedCampaignDraft.mockReset()
    mocks.registerManagedCampaignDraft.mockResolvedValue("draft://autonomous-campaign")
    mocks.ingestChapter.mockReset()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "no_llm" })
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
    mocks.loadOutlineModel.mockReset()
    mocks.loadOutlineModel.mockResolvedValue({ model: null, migratedFrom: null })
    mocks.getChapterVolumes.mockReset()
    mocks.getChapterVolumes.mockResolvedValue([])
  })

  function readyOnce(reviewed = false) {
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "正文内容，故事自然展开，情节完整。",
      taskBrief: "brief-x",
      draftContent: "draft-x",
      reviewResults: [],
      revised: false,
      decisionGates: reviewed ? buildDecisionGates([], 0) : previewGates(),
      finalConsistencyReviewed: reviewed,
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
      reviewResults: p0Findings,
      revised: false,
      decisionGates: buildDecisionGates(p0Findings, 3, true),
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
      confirmAutoAccept: true,
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
      confirmAutoAccept: true,
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
    readyOnce(true)
    mocks.createDirectory.mockRejectedValueOnce(new Error("mkdir down"))
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      confirmAutoAccept: true,
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
        await reviewedChapter(7, "正文内容足够长", { taskBrief: "", title: "" }),
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
    mocks.commitAcceptedDeepChapterDraft.mockReset()
    mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
    mocks.registerManagedCampaignDraft.mockReset()
    mocks.registerManagedCampaignDraft.mockResolvedValue("draft://autonomous-campaign")
    mocks.ingestChapter.mockReset()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "no_llm" })
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
    mocks.loadOutlineModel.mockReset()
    mocks.loadOutlineModel.mockResolvedValue({ model: null, migratedFrom: null })
    mocks.getChapterVolumes.mockReset()
    mocks.getChapterVolumes.mockResolvedValue([])
  })

  it("绑定对象无有效视点字段 → extractBindingPovName 回退 null（193）", async () => {
    mocks.loadBinding.mockResolvedValue({ frameworkId: "fw", pov: "   ", viewpoint: 123 })
    mocks.runDeepChapterGeneration.mockResolvedValueOnce({
      finalContent: "全绿正文内容，故事自然展开，情节完整。",
      taskBrief: "brief-x",
      draftContent: "draft-x",
      reviewResults: [],
      revised: false,
      decisionGates: previewGates(),
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

  it("W1-02 联动：阶段7润色改文经阶段7.6完成语义复核后，巡航模式可基于最终交付正文自动验收落盘", async () => {
    const actualDeepGen = await vi.importActual<typeof import("./deep-chapter-generation")>("./deep-chapter-generation")
    const { DEFAULT_NOVEL_CONFIG } = await import("@/stores/wiki-store")
    const makeUniqueProse = (seed: string) =>
      Array.from(
        { length: 40 },
        (_, i) => `第${i + 1}段：${seed}，门缝漏出的微光映在潮湿石阶上，脚步停在走廊拐角处等待回应。`,
      ).join("\n")
    const draftBody = makeUniqueProse("初稿里苏砚沿着廊檐试探推门")
    const polishedBody = makeUniqueProse("润色后暴雨砸在祠堂青瓦上苏砚收紧掌心锈钥匙")
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const deps = {
      buildContextPack: vi.fn(async () => ({
        task: "写第1章",
        chapterGoal: "推门查案",
        outline: "第1章：雨夜推门",
        recentSummaries: [],
        previousChapterEnding: "",
        characterStates: "",
        soulDoc: "",
        characterAuras: "",
        cognitionStates: "",
        foreshadowingStates: "",
        timeline: "",
        relatedSettings: "",
        canonRules: "",
        writingStyle: "",
        searchResults: "",
        graphSearchResults: "",
        mustDo: "推门查案",
        mustAvoid: "不越界剧透",
        nextChapterAdvice: "留下门后黑影",
        revisionDirectives: "",
      })),
      contextPackToPrompt: vi.fn(() => "上下文"),
      reviewChapter,
      streamChat: vi.fn(async (_cfg, messages, callbacks) => {
        const prompt = messages
          .map((m: { content: string | Array<{ type: string; text?: string }> }) =>
            typeof m.content === "string"
              ? m.content
              : m.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
          )
          .join("\n")
        if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(polishedBody)
        } else if (prompt.includes("正文")) {
          callbacks.onToken(draftBody)
        } else {
          callbacks.onToken("写作任务书：推门查案")
        }
        callbacks.onDone()
      }),
      gateEvidence: { appendEvents: vi.fn(async () => {}) },
    }
    mocks.ingestChapter.mockResolvedValueOnce(verifiedIngest(1))
    mocks.runDeepChapterGeneration.mockImplementationOnce(async (input, callbacks, _deps, signal) =>
      actualDeepGen.runDeepChapterGeneration(
        {
          ...input,
          novelConfig: {
            ...DEFAULT_NOVEL_CONFIG,
            deepChapterReview: true,
            autoGenerateChapterTitle: false,
            sceneBreakdownEnabled: false,
            outlineThrillSoftGateEnabled: false,
            stateDeltaLightCheckEnabled: false,
          },
        },
        callbacks,
        deps as never,
        signal,
      ),
    )

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      confirmAutoAccept: true,
    })

    // 阶段4审初稿 + 阶段7.6复核润色终稿
    expect(reviewChapter).toHaveBeenCalledTimes(2)
    expect(reviewChapter.mock.calls[1][1]).toBe(polishedBody)
    expect(report.results[0].status).toBe("ready")
    expect(report.results[0].content).toBe(polishedBody)
    expect(report.results[0].autoAccepted).toBe(true)
    expect(report.results[0].autoIngested).toBe(true)
    expect(report.results[0].reviewedBodySha256).toBeTruthy()
    expect(mocks.registerManagedCampaignDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        finalContent: polishedBody,
        finalConsistencyReviewed: true,
      }),
    )
  })

  it("Draft-first 硬守卫：cruiseMode: true 但未传 confirmAutoAccept 时发出 cruise-draft-only 并保持 ready，不自动落盘", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValue(
      generatedBody("门控全绿但未二次确认的正文。", {
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
      }),
    )
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
    expect(report.summary.allPassed).toBe(true)
    expect(report.results.every((r) => r.status === "ready" && r.autoAccepted === false && r.autoIngested === false)).toBe(true)
    expect(report.results.every((r) => Boolean(r.reviewedBodySha256))).toBe(true)
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cruise-draft-only" }),
    )
    expect(mocks.registerManagedCampaignDraft).not.toHaveBeenCalled()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("弧末结算真实接线：outlineModel 命中弧尾时发出 stage: arc-settlement 并记录 arcSettlementTriggered", async () => {
    mocks.loadOutlineModel.mockResolvedValueOnce({
      migratedFrom: null,
      model: {
        schemaVersion: 2,
        updatedAt: "2026-01-01",
        volumes: [
          {
            number: 1,
            title: "第一卷",
            arc: "初出茅庐",
            chapters: [
              {
                id: "v01c001", volume: 1, chapter: 1, title: "第一章", pov: "", arc: "入门篇",
                entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [],
                prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "2026-01-01",
              },
              {
                id: "v01c002", volume: 1, chapter: 2, title: "第二章", pov: "", arc: "入门篇",
                entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [],
                prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "2026-01-01",
              },
              {
                id: "v01c003", volume: 1, chapter: 3, title: "第三章", pov: "", arc: "宗门大比",
                entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [],
                prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "2026-01-01",
              },
            ],
          },
        ],
      },
    })
    mocks.runDeepChapterGeneration.mockResolvedValue(generatedBody("正文", { decisionGates: previewGates() }))
    const onProgress = vi.fn()

    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      onProgress,
    })

    expect(report.results[0].arcSettlementTriggered).toBeUndefined()
    expect(report.results[1].arcSettlementTriggered).toBe(true)
    expect(report.results[1].arcEndChapter).toBe(2)
    expect(report.arcSettlementTriggered).toBe(true)
    expect(report.arcSettlementChapters).toEqual([2])
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "arc-settlement",
        current: 2,
        total: 2,
      }),
    )
  })

  it("弧末结算真实接线：outlineModel 缺失时回退 getChapterVolumes；显式 arcEndChapters 可覆盖；读错非致命降级", async () => {
    mocks.loadOutlineModel.mockResolvedValueOnce({ model: null, migratedFrom: null })
    mocks.getChapterVolumes.mockResolvedValueOnce([
      { volumeNumber: 1, title: "第一卷", summary: "", chapterRangeStart: 1, chapterRangeEnd: 5 },
    ])
    mocks.runDeepChapterGeneration.mockResolvedValue(generatedBody("正文", { decisionGates: previewGates() }))
    const onProgressVol = vi.fn()

    const volReport = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 5,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      onProgress: onProgressVol,
    })
    expect(volReport.results[0].arcSettlementTriggered).toBe(true)
    expect(volReport.arcSettlementTriggered).toBe(true)
    expect(onProgressVol).toHaveBeenCalledWith(expect.objectContaining({ stage: "arc-settlement" }))

    // 显式 arcEndChapters + 读盘失败非致命降级
    mocks.loadOutlineModel.mockRejectedValueOnce(new Error("corrupt outline"))
    mocks.getChapterVolumes.mockRejectedValueOnce(new Error("search down"))
    const onProgressExplicit = vi.fn()
    const explicitReport = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 3,
      chapterCount: 1,
      llmConfig: mockLlmConfig,
      arcEndChapters: [3],
      onProgress: onProgressExplicit,
    })
    expect(explicitReport.results[0].arcSettlementTriggered).toBe(true)
    expect(explicitReport.arcSettlementChapters).toEqual([3])
    expect(onProgressExplicit).toHaveBeenCalledWith(expect.objectContaining({ stage: "arc-settlement" }))
  })

  it("REV1-003：弧末章首跑失败经仲裁 retry 成功后，仍触发 arcSettlementTriggered、发出 stage: arc-settlement、携带段摘要且指标不重复写入", async () => {
    mocks.loadSegmentSummaries.mockResolvedValue({ "1-1": "第一卷弧末段摘要" } as never)
    mocks.getLatestSegmentSummaryText.mockReturnValue("第一卷弧末段摘要")
    mocks.runDeepChapterGeneration
      .mockResolvedValueOnce({
        finalContent: "第一章首跑被 P0 阻断",
        taskBrief: "brief1",
        draftContent: "draft1",
        reviewResults: [],
        revised: false,
        decisionGates: buildDecisionGates(p0Findings, 3, true),
        manualReviewRequired: true,
        retryCount: 3,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第一章重跑后门控全绿正文",
        taskBrief: "revised-brief-1",
        draftContent: "draft1-retry",
        reviewResults: [],
        revised: true,
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })
      .mockResolvedValueOnce({
        finalContent: "第二章承接正文",
        taskBrief: "brief2",
        draftContent: "draft2",
        reviewResults: [],
        revised: false,
        decisionGates: buildDecisionGates([], 0),
        finalConsistencyReviewed: true,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
      })

    const provider = vi.fn(
      async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
        action: "retry-rebrief",
        revisedBrief: "revised-brief-1",
        reason: "修订任务书重跑弧末章",
      }),
    )
    const onProgress = vi.fn()
    const report = await runAutonomousDraftCampaign({
      projectPath: "/mock/project",
      startChapter: 1,
      chapterCount: 2,
      llmConfig: mockLlmConfig,
      cruiseMode: true,
      confirmAutoAccept: true,
      arcEndChapters: [1],
      buildChapterRequest: async (num: number) => `brief-${num}`,
      arbitrationProvider: provider,
      onProgress,
    })

    expect(report.results).toHaveLength(2)
    expect(report.results[0].status).toBe("ready")
    expect(report.results[0].arcSettlementTriggered).toBe(true)
    expect(report.results[0].arcEndChapter).toBe(1)
    expect(report.arcSettlementTriggered).toBe(true)
    expect(report.arcSettlementChapters).toEqual([1])
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arbitration-retry", current: 1, total: 2 }),
    )
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "arc-settlement", current: 1, total: 2 }),
    )
    // 段摘要经公共后置路径注入第二章承接指令（dismantlingReferenceDirective）
    const ch2Call = mocks.runDeepChapterGeneration.mock.calls[2][0] as {
      dismantlingReferenceDirective?: string
    }
    expect(ch2Call.dismantlingReferenceDirective).toContain("第一卷弧末段摘要")
    expect(ch2Call.dismantlingReferenceDirective).toContain("第一章重跑后门控全绿正文")
    // R3 指标不因 retry 走公共后置路径而双写：2 章严格 2 条
    expect(mocks.appendStageMetric).toHaveBeenCalledTimes(2)
  })
})
