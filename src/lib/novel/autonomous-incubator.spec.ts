// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  runAutonomousNovelIncubator,
  runEndToEndAutonomousNovelProduction,
} from "./autonomous-incubator"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "gpt-4o",
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
  unpackOutlineToChapterFiles: vi.fn(),
  runAutonomousDraftCampaign: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("./soul-doc", () => ({
  writeSoulDoc: mocks.writeSoulDoc,
}))

vi.mock("./world-blueprint", async () => {
  const actual = await vi.importActual<typeof import("./world-blueprint")>("./world-blueprint")
  return {
    ...actual,
    saveWorldBlueprint: mocks.saveWorldBlueprint,
  }
})

vi.mock("./story-simulation/framework-binding", () => ({
  saveBinding: mocks.saveBinding,
}))

vi.mock("./outline-chapter-unpack", () => ({
  unpackOutlineToChapterFiles: mocks.unpackOutlineToChapterFiles,
}))

vi.mock("./campaign-runner", () => ({
  runAutonomousDraftCampaign: mocks.runAutonomousDraftCampaign,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
  combineAbortSignals: vi.fn(),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30000,
}))

describe("Autonomous Novel Incubator (全自动小说冷启动孵化器)", () => {
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
      createdFiles: [
        "/test/project/wiki/chapters/chapter-001.md",
        "/test/project/wiki/chapters/chapter-002.md",
        "/test/project/wiki/chapters/chapter-003.md",
        "/test/project/wiki/chapters/chapter-004.md",
        "/test/project/wiki/chapters/chapter-005.md",
      ],
      chapters: [],
    })
    mocks.runAutonomousDraftCampaign.mockResolvedValue({
      projectPath: "/test/project",
      startChapter: 1,
      endChapter: 3,
      totalChapters: 3,
      completedChapters: 3,
      totalWords: 9000,
      startTime: "",
      endTime: "",
      results: [],
      summary: { allPassed: true, readyCount: 3, failedCount: 0 },
    })
  })

  it("仅需单句灵感，全自动链式孵化六大核心产物并完成绑定", async () => {
    const onProgress = vi.fn()

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "赛博朋克都市中一名被遗忘的机械记忆修复师意外唤醒了神明代码",
      targetChapters: 5,
      llmConfig: mockLlmConfig,
      onProgress,
    })

    // 1. 基本信息与流派智能提取
    expect(result.title).toBeDefined()
    expect(result.genre).toBe("科幻未来")
    expect(result.projectPath).toBe("/test/project")

    // 2. 阶段 1：灵魂文档写入
    expect(mocks.writeSoulDoc).toHaveBeenCalledWith(
      "/test/project",
      expect.stringContaining("灵魂文档"),
    )

    // 3. 阶段 2：世界观蓝图完备性校验与持久化
    expect(mocks.saveWorldBlueprint).toHaveBeenCalledWith(
      "/test/project",
      expect.objectContaining({
        layers: expect.objectContaining({
          axioms: expect.any(Array),
          background: expect.any(Array),
          geography: expect.any(Array),
          cultures: expect.any(Array),
          conflicts: expect.any(Array),
        }),
      }),
    )

    // 4. 阶段 3：核心角色塑造
    expect(result.characters).toHaveLength(3)
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      expect.stringContaining("wiki/characters"),
      expect.any(String),
    )

    // 5. 阶段 4：大纲总纲推演与落盘
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/test/project/wiki/outlines/story-outline.md",
      expect.stringContaining("全书总纲与分卷计划"),
    )

    // 6. 阶段 5：章节骨架零人工自动铺排
    expect(mocks.unpackOutlineToChapterFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/test/project",
        overwriteExisting: false,
      }),
    )
    expect(result.unpackedSkeletons.createdCount).toBe(5)

    // 7. 阶段 6：起承转合框架绑定
    expect(mocks.saveBinding).toHaveBeenCalledWith(
      "/test/project",
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ phase: "起" }),
          expect.objectContaining({ phase: "承" }),
          expect.objectContaining({ phase: "转" }),
          expect.objectContaining({ phase: "合" }),
        ]),
      }),
      5,
    )

    // 8. 进度通知全覆盖
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "soul-doc", current: 1 }),
    )
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "complete", current: 6 }),
    )
  })

  it("端到端一键生产流水线：孵化完成后直接衔接批量战役巡航", async () => {
    const onProgress = vi.fn()

    const res = await runEndToEndAutonomousNovelProduction({
      projectPath: "/test/project",
      idea: "少年偶得神秘古玉，踏上一剑破万法的修真飞升之路",
      genre: "玄幻修真",
      title: "一剑破天",
      targetChapters: 10,
      llmConfig: mockLlmConfig,
      autoStartCruise: true,
      cruiseChapterCount: 3,
      onProgress,
    })

    expect(res.incubation.title).toBe("一剑破天")
    expect(res.incubation.genre).toBe("玄幻修真")
    expect(res.campaign).toBeDefined()
    expect(res.campaign?.completedChapters).toBe(3)

    // 验证调用了批量战役调度器且启用了 cruiseMode: true
    expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/test/project",
        startChapter: 1,
        chapterCount: 3,
        cruiseMode: true,
      }),
    )
  })
})
