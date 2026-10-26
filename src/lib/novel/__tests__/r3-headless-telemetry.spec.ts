// @vitest-environment node
/**
 * R3 无头遥测补洞单测（T4，UC1–UC6）。
 * mock appendStageMetric / updateNovelSessionStatus，零真实 IO。
 * 真实截断语义（1024 shift）见 novel-session-status.spec 既有用例，本文件仅断言委托行为。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { runAutonomousNovelIncubator } from "../autonomous-incubator"
import { runAutonomousDraftCampaign } from "../campaign-runner"
import type { ArbitrationDirective, ArbitrationRequest } from "../cruise-arbitration"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "",
  model: "test",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeSoulDoc: vi.fn(),
  saveWorldBlueprint: vi.fn(),
  saveBinding: vi.fn(),
  loadBinding: vi.fn(),
  unpackOutlineToChapterFiles: vi.fn(),
  streamChat: vi.fn(),
  appendStageMetric: vi.fn(),
  updateNovelSessionStatus: vi.fn(),
  buildNextStatus: vi.fn(),
  registerManagedCampaignDraft: vi.fn(),
  runDeepChapterGeneration: vi.fn(),
  listBindableNovelCharacters: vi.fn(),
  loadSegmentSummaries: vi.fn(),
  getLatestSegmentSummaryText: vi.fn(),
  shouldTriggerArcSettlement: vi.fn(),
  commitAcceptedDeepChapterDraft: vi.fn(),
  ingestChapter: vi.fn(),
  defaultCanonDualWriteDeps: vi.fn(() => ({})),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("../soul-doc", () => ({
  writeSoulDoc: mocks.writeSoulDoc,
}))

vi.mock("../world-blueprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../world-blueprint")>()
  return {
    ...actual,
    saveWorldBlueprint: mocks.saveWorldBlueprint,
  }
})

vi.mock("../outline-chapter-unpack", () => ({
  unpackOutlineToChapterFiles: mocks.unpackOutlineToChapterFiles,
}))

vi.mock("../story-simulation/framework-binding", () => ({
  saveBinding: mocks.saveBinding,
  loadBinding: mocks.loadBinding,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
  combineAbortSignals: vi.fn(() => undefined),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30000,
}))

vi.mock("../novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../novel-session-status")>()
  void actual
  return {
    appendStageMetric: mocks.appendStageMetric,
    updateNovelSessionStatus: mocks.updateNovelSessionStatus,
    buildNextStatus: mocks.buildNextStatus,
    registerManagedCampaignDraft: mocks.registerManagedCampaignDraft,
  }
})

vi.mock("../deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("../bindable-characters", () => ({
  listBindableNovelCharacters: mocks.listBindableNovelCharacters,
}))

vi.mock("../segment-summary", () => ({
  loadSegmentSummaries: mocks.loadSegmentSummaries,
  getLatestSegmentSummaryText: mocks.getLatestSegmentSummaryText,
}))

vi.mock("../arc-settlement", () => ({
  shouldTriggerArcSettlement: mocks.shouldTriggerArcSettlement,
}))

vi.mock("../formal-writeback", () => ({
  commitAcceptedDeepChapterDraft: mocks.commitAcceptedDeepChapterDraft,
}))

vi.mock("../chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))

vi.mock("../canon-dual-write", () => ({
  defaultCanonDualWriteDeps: mocks.defaultCanonDualWriteDeps,
}))

function resetAllMocks() {
  vi.clearAllMocks()
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.writeSoulDoc.mockResolvedValue(undefined)
  mocks.saveWorldBlueprint.mockResolvedValue(undefined)
  mocks.saveBinding.mockResolvedValue({
    frameworkId: "fw-test",
    targetChapterCount: 5,
    bindingVersion: "1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapterAllocation: [],
  })
  mocks.loadBinding.mockResolvedValue(null)
  mocks.unpackOutlineToChapterFiles.mockResolvedValue({
    totalParsed: 5,
    createdCount: 5,
    skippedCount: 0,
    createdFiles: [],
    chapters: [],
  })
  mocks.streamChat.mockResolvedValue(undefined)
  // appendStageMetric 真实契约：永不 reject（内层 try/catch 吞错），此处 resolve 即模拟“已吞错”。
  mocks.appendStageMetric.mockResolvedValue(undefined)
  // updateNovelSessionStatus 默认：执行 mutator（触发 buildNextStatus），返回其结果。
  mocks.updateNovelSessionStatus.mockImplementation(async (_pp: unknown, mutator: (s: unknown) => unknown) => {
    const fakeBase = {}
    return (await mutator(fakeBase)) as never
  })
  // buildNextStatus mock：简单合并并捕获 overrides（真实工厂覆盖见其自有单测）。
  mocks.buildNextStatus.mockImplementation((base: unknown, overrides: unknown) => ({
    ...((base as Record<string, unknown>) ?? {}),
    ...(overrides as Record<string, unknown>),
  }))
  mocks.registerManagedCampaignDraft.mockResolvedValue("draft://mock")
  mocks.listBindableNovelCharacters.mockResolvedValue([])
  mocks.loadSegmentSummaries.mockResolvedValue([])
  mocks.getLatestSegmentSummaryText.mockReturnValue("")
  mocks.shouldTriggerArcSettlement.mockReturnValue(false)
  mocks.commitAcceptedDeepChapterDraft.mockResolvedValue(undefined)
  mocks.ingestChapter.mockResolvedValue({ snapshot: { chapter: 1 } })
}

function readyGenResult(chapterNumber: number, finalContent: string) {
  return {
    finalContent,
    taskBrief: `任务书 ${chapterNumber}`,
    draftContent: `初稿 ${chapterNumber}`,
    reviewResults: [],
    revised: false,
    decisionGates: { consistency: "passed", antiAi: "passed", quality: "passed" },
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
  }
}

function blockedGenResult(chapterNumber: number, finalContent = `第 ${chapterNumber} 章被阻断正文`) {
  return {
    finalContent,
    taskBrief: `任务书 ${chapterNumber}`,
    draftContent: `初稿 ${chapterNumber}`,
    reviewResults: [],
    revised: false,
    decisionGates: { consistency: "failed", antiAi: "passed", quality: "passed" },
    manualReviewRequired: true,
    retryCount: 0,
    partial: false,
    partialReason: null,
  }
}

describe("R3 无头遥测补洞", () => {
  beforeEach(() => {
    resetAllMocks()
    mocks.runDeepChapterGeneration.mockReset()
  })

  describe("UC1 孵化 6 阶段遥测", () => {
    it("6 阶段各恰 1 条，stage 名与 §6 逐字一致且 timestamp 可解析", async () => {
      const result = await runAutonomousNovelIncubator({
        projectPath: "/mock/project",
        idea: "测试灵感",
        title: "测试书名",
        genre: "测试流派",
        targetChapters: 5,
        llmConfig: mockLlmConfig,
      })
      expect(result.soulDoc.length).toBeGreaterThan(0)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(6)
      const stages = mocks.appendStageMetric.mock.calls.map((c) => (c[1] as { stage: string }).stage)
      expect(stages).toEqual([
        "incubator:soul-doc",
        "incubator:world-blueprint",
        "incubator:characters",
        "incubator:outline",
        "incubator:unpack-chapters",
        "incubator:framework-binding",
      ])
      for (const call of mocks.appendStageMetric.mock.calls) {
        const entry = call[1] as { timestamp?: string; latencyMs?: number; tokenCost?: number; partial?: boolean }
        expect(Number.isFinite(Date.parse(entry.timestamp ?? ""))).toBe(true)
        expect(Number.isFinite(entry.latencyMs)).toBe(true)
        expect((entry.latencyMs ?? -1) >= 0).toBe(true)
      }
    })

    it("tokenCost 均为有限正数且 partial 恒 false、孵化不写 chapterId", async () => {
      await runAutonomousNovelIncubator({
        projectPath: "/mock/project",
        idea: "测试灵感",
        title: "测试书名",
        genre: "测试流派",
        targetChapters: 5,
        llmConfig: mockLlmConfig,
      })
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(6)
      for (const call of mocks.appendStageMetric.mock.calls) {
        const entry = call[1] as { tokenCost?: number; partial?: boolean; chapterId?: string }
        expect(Number.isFinite(entry.tokenCost)).toBe(true)
        expect((entry.tokenCost ?? 0) > 0).toBe(true)
        expect(entry.partial).toBe(false)
        expect(entry.chapterId).toBeUndefined()
      }
    })
  })

  describe("UC2 战役 N 章遥测", () => {
    it("3 ready 章各 1 条 campaign:chapter，chapterId/tokenCost/partial 映射正确", async () => {
      mocks.runDeepChapterGeneration.mockImplementation(async (input: { chapterNumber: number }) => {
        const n = input.chapterNumber
        return readyGenResult(n, `第${n}章正文内容展开叙事ABCDEFGHIJ`)
      })
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 3,
        llmConfig: mockLlmConfig,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report.results).toHaveLength(3)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(3)
      const calls = mocks.appendStageMetric.mock.calls
      const ids = calls.map((c) => (c[1] as { chapterId: string }).chapterId)
      expect(ids).toEqual(["chapter-001", "chapter-002", "chapter-003"])
      for (let i = 0; i < 3; i++) {
        const entry = calls[i][1] as { stage: string; tokenCost: number; partial: boolean; timestamp: string }
        expect(entry.stage).toBe("campaign:chapter")
        expect(entry.tokenCost).toBe(report.results[i].wordCount)
        expect(entry.tokenCost).toBeGreaterThan(0)
        expect(entry.partial).toBe(false)
        expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true)
      }
    })

    it("partial/blocked/failed 映射 partial:true（非 cruise 直通）", async () => {
      mocks.runDeepChapterGeneration
        .mockResolvedValueOnce(readyGenResult(1, "第一章全绿正文内容XYZ"))
        .mockRejectedValueOnce(new Error("模拟生成异常"))
        .mockResolvedValueOnce({
          ...readyGenResult(3, "第三章阻断正文内容XYZ"),
          manualReviewRequired: true,
        })
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 3,
        llmConfig: mockLlmConfig,
        cruiseMode: false,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report.results.map((r) => r.status)).toEqual(["ready", "failed", "blocked"])
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(3)
      const partials = mocks.appendStageMetric.mock.calls.map((c) => (c[1] as { partial: boolean }).partial)
      expect(partials).toEqual([false, true, true])
      const failedEntry = mocks.appendStageMetric.mock.calls[1][1] as { tokenCost: number; chapterId: string }
      expect(failedEntry.tokenCost).toBe(0)
      expect(failedEntry.chapterId).toBe("chapter-002")
    })

    it("skip 章 1 条且 partial:true、chapterId 保留原章号", async () => {
      mocks.runDeepChapterGeneration
        .mockResolvedValueOnce({ ...readyGenResult(1, "第一章待仲裁正文"), manualReviewRequired: true })
        .mockResolvedValueOnce(readyGenResult(2, "第二章全绿正文内容XYZ"))
      const provider = vi.fn(
        async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
          action: "skip-chapter",
          reason: "跳过本章",
        }),
      )
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        cruiseMode: true,
        buildChapterRequest: async (n: number) => `写第${n}章`,
        arbitrationProvider: provider,
      })
      expect(report.results[0].skipped).toBe(true)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(2)
      const first = mocks.appendStageMetric.mock.calls[0][1] as { partial: boolean; chapterId: string }
      expect(first.partial).toBe(true)
      expect(first.chapterId).toBe("chapter-001")
    })
  })

  describe("UC3 顶层起止指针", () => {
    it("起 running+startChapter、终 completed/blocked+endChapter（经 buildNextStatus）", async () => {
      mocks.runDeepChapterGeneration.mockImplementation(async (input: { chapterNumber: number }) =>
        readyGenResult(input.chapterNumber, `第${input.chapterNumber}章正文内容XYZ`),
      )
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report.summary.allPassed).toBe(true)
      expect(mocks.updateNovelSessionStatus).toHaveBeenCalledTimes(2)
      const buildCalls = mocks.buildNextStatus.mock.calls
      expect(buildCalls.length).toBeGreaterThanOrEqual(2)
      const firstOverrides = buildCalls[0][1] as { status: string; active_step_index: number }
      expect(firstOverrides.status).toBe("running")
      expect(firstOverrides.active_step_index).toBe(1)
      const lastOverrides = buildCalls[buildCalls.length - 1][1] as {
        status: string
        active_step_index: number
      }
      expect(lastOverrides.status).toBe("completed")
      expect(lastOverrides.active_step_index).toBe(2)

      // 未全过 → 终态 blocked
      resetAllMocks()
      mocks.runDeepChapterGeneration.mockResolvedValueOnce(blockedGenResult(5))
      const report2 = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 5,
        chapterCount: 1,
        llmConfig: mockLlmConfig,
        cruiseMode: false,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report2.summary.allPassed).toBe(false)
      const buildCalls2 = mocks.buildNextStatus.mock.calls
      const last2 = buildCalls2[buildCalls2.length - 1][1] as { status: string; active_step_index: number }
      expect(last2.status).toBe("blocked")
      expect(last2.active_step_index).toBe(5)
    })
  })

  describe("UC4 retry 只记终局", () => {
    it("单章 retry 全程只新增 1 条（终局 ready），首跑不写", async () => {
      mocks.runDeepChapterGeneration
        .mockResolvedValueOnce(blockedGenResult(1, "第一章首跑被阻断"))
        .mockResolvedValueOnce(readyGenResult(1, "第一章重跑后全绿正文XYZ"))
        .mockResolvedValueOnce(readyGenResult(2, "第二章全绿正文内容XYZ"))
      const provider = vi.fn(
        async (_req: ArbitrationRequest): Promise<ArbitrationDirective | null> => ({
          action: "retry-rebrief",
          revisedBrief: "revised-brief-1",
          reason: "重跑",
        }),
      )
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        cruiseMode: true,
        buildChapterRequest: async (n: number) => `brief-${n}`,
        arbitrationProvider: provider,
      })
      expect(mocks.runDeepChapterGeneration).toHaveBeenCalledTimes(3)
      expect(report.results).toHaveLength(2)
      expect(report.results[0].status).toBe("ready")
      // 两章终局 → 恰 2 条（第一章首跑未写，重跑终局写 1 条）
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(2)
      const first = mocks.appendStageMetric.mock.calls[0][1] as {
        chapterId: string
        partial: boolean
        tokenCost: number
      }
      expect(first.chapterId).toBe("chapter-001")
      expect(first.partial).toBe(false)
      expect(first.tokenCost).toBe(report.results[0].wordCount)
    })
  })

  describe("UC5 1024 截断委托", () => {
    it("每终局恰 1 次 append、无预检/去重（截断由 appendStageMetric 内 shift 承担）", async () => {
      mocks.runDeepChapterGeneration.mockImplementation(async (input: { chapterNumber: number }) =>
        readyGenResult(input.chapterNumber, `第${input.chapterNumber}章正文内容XYZ`),
      )
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 7,
        chapterCount: 3,
        llmConfig: mockLlmConfig,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      // 无去重表、无长度预检：append 次数恒等于终局章数
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(report.results.length)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(3)
      // 真正 1024 shift 语义由 novel-session-status 既有单测覆盖，此处不断言越界行为
    })
  })

  describe("UC6 遥测失败主链照常", () => {
    it("孵化：append 以 resolve 模拟已吞错，主链返回完整 6 产物", async () => {
      mocks.appendStageMetric.mockImplementation(async () => undefined)
      const result = await runAutonomousNovelIncubator({
        projectPath: "/mock/project",
        idea: "测试灵感",
        title: "测试书名",
        genre: "测试流派",
        targetChapters: 5,
        llmConfig: mockLlmConfig,
      })
      expect(result.soulDoc.length).toBeGreaterThan(0)
      expect(result.characters.length).toBeGreaterThan(0)
      expect(result.outlineContent.length).toBeGreaterThan(0)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(6)
    })

    it("战役：顶层 update 拒因被吞，report 照常返回", async () => {
      mocks.runDeepChapterGeneration.mockImplementation(async (input: { chapterNumber: number }) =>
        readyGenResult(input.chapterNumber, `第${input.chapterNumber}章正文内容XYZ`),
      )
      mocks.updateNovelSessionStatus.mockRejectedValue(new Error("status IO down"))
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 1,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report.results).toHaveLength(2)
      expect(report.summary.allPassed).toBe(true)
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(2)
    })

    it("战役：per-chapter append 拒因被吞，巡航处置不变", async () => {
      mocks.runDeepChapterGeneration.mockImplementation(async (input: { chapterNumber: number }) =>
        readyGenResult(input.chapterNumber, `第${input.chapterNumber}章正文内容XYZ`),
      )
      // 首条遥测拒因（模拟落盘失败），调用方吞错后主链与后续遥测照常
      mocks.appendStageMetric.mockRejectedValueOnce(new Error("metric IO down"))
      mocks.appendStageMetric.mockResolvedValue(undefined)
      const report = await runAutonomousDraftCampaign({
        projectPath: "/mock/project",
        startChapter: 3,
        chapterCount: 2,
        llmConfig: mockLlmConfig,
        cruiseMode: true,
        buildChapterRequest: async (n: number) => `写第${n}章`,
      })
      expect(report.results.map((r) => r.status)).toEqual(["ready", "ready"])
      expect(mocks.appendStageMetric).toHaveBeenCalledTimes(2)
    })
  })
})
