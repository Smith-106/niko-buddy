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
  validateWorldBlueprint: vi.fn(),
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
  mocks.validateWorldBlueprint.mockImplementation(actual.validateWorldBlueprint)
  return {
    ...actual,
    saveWorldBlueprint: mocks.saveWorldBlueprint,
    validateWorldBlueprint: (...args: any[]) => mocks.validateWorldBlueprint(...args),
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
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.createDirectory.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockReset()
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.writeSoulDoc.mockReset()
    mocks.writeSoulDoc.mockResolvedValue(undefined)
    mocks.saveWorldBlueprint.mockReset()
    mocks.saveWorldBlueprint.mockResolvedValue(undefined)
    mocks.saveBinding.mockReset()
    mocks.saveBinding.mockResolvedValue({
      frameworkId: "fw-test",
      targetChapterCount: 5,
      bindingVersion: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapterAllocation: [],
    })
    mocks.unpackOutlineToChapterFiles.mockReset()
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
    mocks.runAutonomousDraftCampaign.mockReset()
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
    mocks.streamChat.mockReset()
    const actual = await vi.importActual<typeof import("./world-blueprint")>("./world-blueprint")
    mocks.validateWorldBlueprint.mockReset()
    mocks.validateWorldBlueprint.mockImplementation(actual.validateWorldBlueprint)
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

  it("大模型流式调用成功时优先采用大模型生成的内容", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks) => {
      callbacks.onToken("这是大模型自主创作的高质量内容")
      callbacks.onDone()
    })

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "少年得到一把能够斩断因果的神剑",
      llmConfig: mockLlmConfig,
    })

    expect(result.soulDoc).toBe("这是大模型自主创作的高质量内容")
    expect(result.outlineContent).toBe("这是大模型自主创作的高质量内容")
  })

  it("大模型报错或抛出异常时平滑回退至确定性生成逻辑", async () => {
    // 首次调用触发 onError
    mocks.streamChat.mockImplementationOnce(async (_cfg, _messages, callbacks) => {
      callbacks.onError(new Error("LLM Token 超限或断网"))
    })
    // 第二次调用直接抛出异常
    mocks.streamChat.mockRejectedValueOnce(new Error("RPC 异常中断"))

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "探寻古老遗迹的秘密",
      llmConfig: mockLlmConfig,
    })

    expect(result.soulDoc).toContain("作品灵魂文档")
    expect(result.outlineContent).toContain("全书总纲与分卷计划")
  })

  it("无 apiKey 时走回退；若 provider 为 ollama 则尝试调用 streamChat", async () => {
    // 1. 无 apiKey 且 provider 不为 ollama -> 直接走 fallback，不调用 streamChat
    const noKeyResult = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "奇幻世界探险",
      llmConfig: { ...mockLlmConfig, apiKey: "", provider: "openai" },
    })
    expect(noKeyResult.soulDoc).toContain("作品灵魂文档")
    expect(mocks.streamChat).not.toHaveBeenCalled()

    // 2. provider 为 ollama 即使无 key 也调用 streamChat
    mocks.streamChat.mockImplementationOnce(async (_cfg, _msg, callbacks) => {
      callbacks.onToken("Ollama 本地模型生成的灵魂文档")
      callbacks.onDone()
    })
    const ollamaResult = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "奇幻世界探险",
      llmConfig: { ...mockLlmConfig, apiKey: "", provider: "ollama" },
    })
    expect(ollamaResult.soulDoc).toBe("Ollama 本地模型生成的灵魂文档")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("题材与书名推导分支覆盖：悬疑推理、都市逆袭、奇幻冒险、短书名与标点符号灵感", async () => {
    // 悬疑推理
    const resSuspense = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "深夜老宅发生诡异凶杀案，侦探追查神秘凶手",
      llmConfig: mockLlmConfig,
    })
    expect(resSuspense.genre).toBe("悬疑推理")

    // 都市逆袭
    const resUrban = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "职场小透明重生回到十年前商海狂潮，开启神豪逆袭之路",
      llmConfig: mockLlmConfig,
    })
    expect(resUrban.genre).toBe("都市逆袭")

    // 奇幻冒险 (未命中特定模式)
    const resFantasy = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "漂流在浩瀚云海中的浮岛文明与巨兽",
      llmConfig: mockLlmConfig,
    })
    expect(resFantasy.genre).toBe("奇幻冒险")

    // 短字灵感 (length < 2) -> `${genre}传奇`
    const resShort = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "道",
      llmConfig: mockLlmConfig,
    })
    expect(resShort.title).toBe("玄幻修真传奇")

    // 全标点灵感 -> words[0] 为空 -> 未命名神作
    const resPunctuation = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "，，，！？",
      llmConfig: mockLlmConfig,
    })
    expect(resPunctuation.title).toBe("未命名神作")
  })

  it("世界观蓝图验证不完备时触发自动补齐逻辑", async () => {
    mocks.validateWorldBlueprint.mockImplementationOnce((bpArg: any) => {
      bpArg.layers.axioms = []
      bpArg.layers.background = []
      bpArg.layers.geography = []
      bpArg.layers.cultures = []
      bpArg.layers.conflicts = []
      return {
        verdict: "incomplete",
        missingLayers: ["axioms", "background", "geography", "cultures", "conflicts"],
      }
    })

    const res = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "修仙世界",
      llmConfig: mockLlmConfig,
    })

    expect(res.worldBlueprint.layers.axioms).toEqual(["基础公理"])
    expect(res.worldBlueprint.layers.background).toEqual(["时代背景"])
    expect(res.worldBlueprint.layers.geography).toEqual(["核心地理"])
    expect(res.worldBlueprint.layers.cultures).toEqual(["文化习俗"])
    expect(res.worldBlueprint.layers.conflicts).toEqual(["核心冲突"])
  })

  it("端到端生产流水线：未开启 autoStartCruise 或缺省 targetChapters 与自定义 novelConfig", async () => {
    const res = await runEndToEndAutonomousNovelProduction({
      projectPath: "/test/project",
      idea: "平凡少年的奇幻成长之旅",
      targetChapters: undefined, // 触发缺省值 10
      novelConfig: {
        preset: "action",
        temperature: 0.8,
      } as any,
      llmConfig: mockLlmConfig,
      autoStartCruise: false,
    })

    expect(res.incubation).toBeDefined()
    expect(res.campaign).toBeUndefined()
    expect(mocks.runAutonomousDraftCampaign).not.toHaveBeenCalled()

    // 开启 autoStartCruise 且 cruiseChapterCount (5) > targetChapters (2) 触发 Math.min 另一分支
    const resCruise = await runEndToEndAutonomousNovelProduction({
      projectPath: "/test/project",
      idea: "少年逆袭记",
      targetChapters: 2,
      cruiseChapterCount: 5,
      llmConfig: mockLlmConfig,
      autoStartCruise: true,
    })
    expect(resCruise.campaign).toBeDefined()
    expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterCount: 2,
      }),
    )
  })
})
