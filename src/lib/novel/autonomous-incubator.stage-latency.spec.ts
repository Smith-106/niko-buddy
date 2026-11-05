// @vitest-environment node
/**
 * 孵化器阶段延迟遥测（stageLatencyMs 钳位语义）专项补测。
 *
 * 与 autonomous-incubator.spec.ts 分离：本文件 mock 掉 appendStageMetric，
 * 使 6 个阶段的 latencyMs 负载可被直接观测（既有 spec 走真实 appendStageMetric，
 * 无 session-status 时静默 no-op，负载不可见）。
 *
 * 覆盖点：负差值（时钟回拨 / NTP 校正 / 单调钟穿越）必须钳为 0，不得写出负延迟；
 * 正差值原样透传（证伪「恒返回 0」的实现）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { runAutonomousNovelIncubator } from "./autonomous-incubator"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

const STEP_MS = 60_000

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeSoulDoc: vi.fn(),
  saveWorldBlueprint: vi.fn(),
  saveBinding: vi.fn(),
  unpackOutlineToChapterFiles: vi.fn(),
  appendStageMetric: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("./soul-doc", () => ({
  writeSoulDoc: mocks.writeSoulDoc,
}))

vi.mock("./world-blueprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./world-blueprint")>()
  return {
    ...actual,
    saveWorldBlueprint: mocks.saveWorldBlueprint,
  }
})

// campaign-runner 仅在被调用时才需要（本用例不跑巡航），整模块替身可切断
// formal-writeback → novel 桶文件的重量级模块图导入。
vi.mock("./campaign-runner", () => ({
  runAutonomousDraftCampaign: vi.fn(),
}))

vi.mock("./outline-chapter-unpack", () => ({
  unpackOutlineToChapterFiles: mocks.unpackOutlineToChapterFiles,
}))

vi.mock("./story-simulation/framework-binding", () => ({
  saveBinding: mocks.saveBinding,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
  combineAbortSignals: vi.fn(() => undefined),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30000,
}))

// 只替换 appendStageMetric（延迟负载的唯一出口）：不走 importOriginal，
// 避免把 novel 桶文件（draft-manager / 审核链）拖进本用例的模块图。
vi.mock("./novel-session-status", () => ({
  appendStageMetric: mocks.appendStageMetric,
  updateNovelSessionStatus: vi.fn(),
  buildNextStatus: vi.fn(),
  registerManagedCampaignDraft: vi.fn(),
  loadNovelSessionStatus: vi.fn(),
}))

interface StageMetricPayload {
  stage: string
  tokenCost: number
  latencyMs: number
  partial: boolean
  timestamp: string
}

function stageMetrics(): StageMetricPayload[] {
  return mocks.appendStageMetric.mock.calls.map((call) => call[1] as StageMetricPayload)
}

describe("autonomous-incubator 阶段延迟遥测钳位（增补）", () => {
  beforeEach(() => {
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
    mocks.unpackOutlineToChapterFiles.mockResolvedValue({
      totalParsed: 5,
      createdCount: 5,
      skippedCount: 0,
      createdFiles: ["/test/project/wiki/chapters/chapter-001.md"],
      chapters: [],
    })
  })

  it("时钟回拨（结束时刻早于开始时刻）→ 6 个阶段延迟全部钳为 0，且 tokenCost 仍正常采集", async () => {
    let clock = 2_000_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (clock -= STEP_MS))
    try {
      await runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "赛博都市里的机械记忆修复师",
        targetChapters: 5,
        llmConfig: mockLlmConfig,
      })
    } finally {
      nowSpy.mockRestore()
    }

    const metrics = stageMetrics()
    expect(metrics).toHaveLength(6)
    expect(metrics.map((m) => m.stage)).toEqual([
      "incubator:soul-doc",
      "incubator:world-blueprint",
      "incubator:characters",
      "incubator:outline",
      "incubator:unpack-chapters",
      "incubator:framework-binding",
    ])
    // 关键断言：时钟倒退不产出负延迟
    expect(metrics.map((m) => m.latencyMs)).toEqual([0, 0, 0, 0, 0, 0])
    // 证伪「整体早退/空负载」：tokenCost 仍按产物内容采集为正
    expect(metrics.every((m) => m.tokenCost > 0)).toBe(true)
    expect(metrics.every((m) => m.partial === false)).toBe(true)
  })

  it("单调前进时钟 → 延迟按真实差值透传（非恒 0 钳死）", async () => {
    let clock = 2_000_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (clock += STEP_MS))
    try {
      await runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "少年偶得神秘古玉，踏上一剑破万法的修真飞升之路",
        targetChapters: 5,
        llmConfig: mockLlmConfig,
      })
    } finally {
      nowSpy.mockRestore()
    }

    const latencies = stageMetrics().map((m) => m.latencyMs)
    expect(latencies).toHaveLength(6)
    expect(latencies.every((v) => v > 0)).toBe(true)
    expect(latencies.every((v) => v % STEP_MS === 0)).toBe(true)
  })
})
