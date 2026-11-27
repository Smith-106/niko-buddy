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
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { runAutonomousNovelIncubator } from "./autonomous-incubator"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

function installStageAwareMockLlm(streamChatMock: ReturnType<typeof vi.fn>) {
  const responses = {
    soulDoc: "# 灵魂文档\n\n探讨记忆与秩序边界的悬疑长篇。",
    worldBlueprint: JSON.stringify({
      worldType: "科幻未来",
      layers: {
        axioms: ["记忆哈希可审计且改写必付神经熵增代价"],
        background: ["旧城与上城以记忆税隔离"],
        geography: ["上城算力白塔", "旧城沉降区黑市"],
        cultures: ["以记忆完整度评定信用等级"],
        conflicts: ["觉醒代码冲击记忆垄断体制"],
      },
      crossRefs: [],
    }),
    characters: JSON.stringify([
      { name: "苏砚", role: "主角", profile: "# 苏砚\n\n冷静克制的记忆修复师。" },
      { name: "陆沉舟", role: "对抗者", profile: "# 陆沉舟\n\n算力审查署执行官。" },
      { name: "沈知微", role: "盟友", profile: "# 沈知微\n\n旧城地下档案员。" },
    ]),
    outline: "# 全书总纲\n\n### 第1章 断点唤醒\n苏砚修复芯片时触发觉醒代码。\n\n### 第2章 档案交换\n苏砚与沈知微追查断层日志。",
    framework: JSON.stringify({
      nodes: [
        { phase: "起", title: "断点唤醒", coreConflict: "禁码现世", involvedCharacters: ["苏砚"], goal: "查明来源", causeFromPrev: "开篇", expectedOutcome: "卷入风波" },
        { phase: "承", title: "黑市结盟", coreConflict: "审查围堵", involvedCharacters: ["苏砚", "陆沉舟", "沈知微"], goal: "获取日志", causeFromPrev: "行踪暴露", expectedOutcome: "结盟转移" },
        { phase: "转", title: "白塔陷阱", coreConflict: "身份反转", involvedCharacters: ["苏砚", "陆沉舟"], goal: "广播真相", causeFromPrev: "渗透触发警报", expectedOutcome: "撕开黑箱" },
        { phase: "合", title: "垄断瓦解", coreConflict: "新旧交替", involvedCharacters: ["苏砚", "沈知微"], goal: "重建存证", causeFromPrev: "真相公开", expectedOutcome: "引出新局" },
      ],
    }),
  }

  streamChatMock.mockImplementation(
    async (_cfg: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
      let payload = responses.soulDoc
      if (prompt.includes("【世界观蓝图】")) payload = responses.worldBlueprint
      else if (prompt.includes("【核心角色档案】")) payload = responses.characters
      else if (prompt.includes("【宏观总纲与分章规划】")) payload = responses.outline
      else if (prompt.includes("【起承转合故事模拟框架】")) payload = responses.framework
      callbacks.onToken(payload)
      callbacks.onDone()
    },
  )
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

vi.mock("@/commands/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/commands/fs")>()),
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
  fileExists: vi.fn(async () => false),
  readFile: vi.fn(async () => {
    throw new Error("ENOENT")
  }),
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
    mocks.streamChat.mockReset()
    installStageAwareMockLlm(mocks.streamChat)
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
