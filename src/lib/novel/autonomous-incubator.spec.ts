// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  runAutonomousNovelIncubator,
  runEndToEndAutonomousNovelProduction,
} from "./autonomous-incubator"
import { isDirectorStateValid } from "./director-orchestrator"
import { logger } from "@/lib/utils"

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

const BANNED_PLACEHOLDERS = ["租赁公司", "合同线索提供者", "林玄", "顾渊", "白芷"] as const

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

vi.mock("@/commands/fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/commands/fs")>(),
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
    validateWorldBlueprint: (...args: Parameters<typeof actual.validateWorldBlueprint>) =>
      mocks.validateWorldBlueprint(...args),
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

interface StageMockOverrides {
  soulDoc?: string
  worldBlueprint?: string
  characters?: string
  outline?: string
  framework?: string
}

function defaultStageResponses(overrides: StageMockOverrides = {}) {
  const defaultCharacters = [
    {
      name: "苏砚",
      role: "主角 (Protagonist)",
      profile: "# 苏砚\n\n- **身份**：失忆的记忆修复师\n- **性格**：冷静克制、执拗求真\n- **核心动机**：还原被篡改的底层记忆协议",
    },
    {
      name: "陆沉舟",
      role: "主要对抗者 (Antagonist)",
      profile: "# 陆沉舟\n\n- **身份**：城市算力审查官\n- **性格**：理性冷酷、控制欲强\n- **核心动机**：封锁觉醒代码以维持城邦秩序",
    },
    {
      name: "沈知微",
      role: "重要盟友 (Ally)",
      profile: "# 沈知微\n\n- **身份**：旧城地下档案员\n- **性格**：机敏果断、戒备心重\n- **核心动机**：查明十年前数据断层的真相",
    },
  ]

  const defaultWorldBlueprint = {
    worldType: "科幻未来",
    layers: {
      axioms: ["记忆可被编码为可审计的哈希片段", "改写深层记忆必须支付神经熵增代价"],
      background: ["霓虹穹顶之下，旧城与上城以记忆税隔离"],
      geography: ["上城白塔算力中枢", "旧城沉降区记忆黑市"],
      cultures: ["以记忆完整度划分公民信用等级"],
      conflicts: ["觉醒代码冲击记忆垄断体制引发全城封锁"],
      technology: ["神经接口与冷库记忆晶体"],
      factions: ["算力审查署", "旧城拾忆人行会"],
    },
    crossRefs: [],
  }

  const defaultOutline = [
    "# 宏观总纲与分章规划",
    "",
    "### 第1章 断点唤醒",
    "苏砚在旧城黑市修复一枚封存芯片时触发觉醒代码，引来陆沉舟的审查小队追踪。",
    "",
    "### 第2章 档案交换",
    "苏砚与沈知微达成交易，在沉降区旧机房比对出十年前被抹除的原始日志。",
    "",
    "### 第3章 白塔渗透",
    "三人围绕白塔冷库密钥展开首次正面交锋，陆沉舟提前封锁通道。",
    "",
    "### 第4章 逆转协议",
    "苏砚借神经熵增反制审查网，揭露白塔背后的记忆收割链。",
    "",
    "### 第5章 新序黎明",
    "记忆垄断协议崩塌，苏砚与沈知微在余波中迎向更深层的跨城危机。",
  ].join("\n")

  const defaultFramework = {
    nodes: [
      {
        phase: "起",
        title: "断点唤醒·异码现世",
        coreConflict: "苏砚在常规修复中意外唤醒禁封代码，打破旧城平静",
        involvedCharacters: ["苏砚"],
        goal: "弄清代码来源并躲过首批封锁",
        causeFromPrev: "开篇触发事件",
        expectedOutcome: "苏砚确认代码与自身记忆缺口直接相关",
      },
      {
        phase: "承",
        title: "黑市结盟·审查围堵",
        coreConflict: "陆沉舟全城追查与旧城地下情报网的博弈",
        involvedCharacters: ["苏砚", "陆沉舟", "沈知微"],
        goal: "拿到十年前的原始断层日志",
        causeFromPrev: "代码波动暴露修复工坊位置",
        expectedOutcome: "苏砚与沈知微结盟但被迫转移阵地",
      },
      {
        phase: "转",
        title: "白塔陷阱·真相反转",
        coreConflict: "陆沉舟布下白塔杀局，苏砚发现自己曾是协议共创者",
        involvedCharacters: ["苏砚", "陆沉舟"],
        goal: "打破封锁并将原始日志广播全城",
        causeFromPrev: "渗透白塔冷库触发预设警报",
        expectedOutcome: "苏砚以自身记忆为代价撕开算力黑箱",
      },
      {
        phase: "合",
        title: "垄断瓦解·余波再起",
        coreConflict: "旧城秩序重组与外部城邦干预的隐忧",
        involvedCharacters: ["苏砚", "沈知微"],
        goal: "建立去中心化记忆存证机制",
        causeFromPrev: "白塔真相公之于众引发体制崩塌",
        expectedOutcome: "首卷收束并引出跨城算力联盟的新悬念",
      },
    ],
  }

  return {
    soulDoc: overrides.soulDoc ?? "# 作品灵魂文档\n\n## 核心主旨\n探讨记忆真实性与个体自由意志的边界。\n\n## 创作红线\n杜绝机械降神与人设崩塌。",
    worldBlueprint: overrides.worldBlueprint ?? JSON.stringify(defaultWorldBlueprint),
    characters: overrides.characters ?? JSON.stringify(defaultCharacters),
    outline: overrides.outline ?? defaultOutline,
    framework: overrides.framework ?? JSON.stringify(defaultFramework),
  }
}

function installStageAwareMockLlm(overrides: StageMockOverrides = {}) {
  const responses = defaultStageResponses(overrides)
  const capturedPrompts: string[] = []
  mocks.streamChat.mockImplementation(
    async (_cfg: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
      capturedPrompts.push(prompt)
      let payload = responses.soulDoc
      if (prompt.includes("【世界观蓝图】")) payload = responses.worldBlueprint
      else if (prompt.includes("【核心角色档案】")) payload = responses.characters
      else if (prompt.includes("【宏观总纲与分章规划】")) payload = responses.outline
      else if (prompt.includes("【起承转合故事模拟框架】")) payload = responses.framework
      callbacks.onToken(payload)
      callbacks.onDone()
    },
  )
  return capturedPrompts
}

describe("Autonomous Novel Incubator (全自动小说冷启动孵化器 — P0-01 真实 LLM 与 fail-closed)", () => {
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
    mocks.saveBinding.mockImplementation(async (_pp, fw, targetChapters) => ({
      frameworkId: fw.id,
      frameworkTitle: fw.title,
      targetChapterCount: targetChapters,
      chapterAllocation: [],
      boundAt: new Date().toISOString(),
    }))
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
    installStageAwareMockLlm()
  })

  it("全 5 个内容阶段均经真实 LLM 推演、串联阶段 3 真实角色至阶段 4/6，且 0 假数据残留", async () => {
    const capturedPrompts = installStageAwareMockLlm()
    const onProgress = vi.fn()

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "赛博朋克都市中一名被遗忘的机械记忆修复师意外唤醒了神明代码",
      targetChapters: 5,
      llmConfig: mockLlmConfig,
      onProgress,
    })

    // 1. 五个内容阶段（1/2/3/4/6）全部真实调用 LLM
    expect(mocks.streamChat).toHaveBeenCalledTimes(5)
    expect(result.title).toBeDefined()
    expect(result.genre).toBe("科幻未来")
    expect(result.projectPath).toBe("/test/project")

    // 2. 阶段 1：灵魂文档写入
    expect(mocks.writeSoulDoc).toHaveBeenCalledWith(
      "/test/project",
      expect.stringContaining("灵魂文档"),
    )

    // 3. 阶段 2：世界观蓝图经真实 LLM 生成并校验落盘
    expect(mocks.saveWorldBlueprint).toHaveBeenCalledWith(
      "/test/project",
      expect.objectContaining({
        layers: expect.objectContaining({
          axioms: expect.arrayContaining([expect.stringContaining("记忆")]),
          background: expect.any(Array),
          geography: expect.any(Array),
          cultures: expect.any(Array),
          conflicts: expect.any(Array),
        }),
      }),
    )

    // 4. 阶段 3：核心角色由真实 LLM 生成并落盘
    expect(result.characters.map((c) => c.name)).toEqual(["苏砚", "陆沉舟", "沈知微"])
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/test/project/wiki/entities/characters/苏砚.md",
      expect.stringContaining("记忆修复师"),
    )

    // 5. 阶段 4 与阶段 6 提示词串联阶段 3 真实角色姓名
    const outlinePrompt = capturedPrompts[3]
    const frameworkPrompt = capturedPrompts[4]
    for (const realName of ["苏砚", "陆沉舟", "沈知微"]) {
      expect(outlinePrompt).toContain(realName)
      expect(frameworkPrompt).toContain(realName)
    }

    // 6. 阶段 5：章节骨架零人工自动铺排
    expect(mocks.unpackOutlineToChapterFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/test/project",
        overwriteExisting: false,
      }),
    )
    expect(result.unpackedSkeletons.createdCount).toBe(5)

    // 7. 阶段 6：起承转合 4 节点框架绑定使用真实角色
    expect(mocks.saveBinding).toHaveBeenCalledWith(
      "/test/project",
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ phase: "起", involvedCharacters: ["苏砚"] }),
          expect.objectContaining({ phase: "承", involvedCharacters: ["苏砚", "陆沉舟", "沈知微"] }),
          expect.objectContaining({ phase: "转", involvedCharacters: ["苏砚", "陆沉舟"] }),
          expect.objectContaining({ phase: "合", involvedCharacters: ["苏砚", "沈知微"] }),
        ]),
      }),
      5,
    )

    // 8. 进度通知全覆盖
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "soul-doc", current: 1 }))
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "complete", current: 6 }))

    // 9. P0-01 硬守卫：全部产物与提示词中 0 假数据残留
    const serializedAll = JSON.stringify({
      result,
      savedFramework: mocks.saveBinding.mock.calls[0][1],
      capturedPrompts,
    })
    for (const banned of BANNED_PLACEHOLDERS) {
      expect(serializedAll).not.toContain(banned)
    }

    // 10. TASK-005 导演管线兼容性：阶段 4 写出 story-outline.md 与 volume-plan.md，
    //     阶段 6 后落盘 .novel/director-pipeline.json（idea/world/character/outline=done, chapters=running）
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/test/project/wiki/outlines/story-outline.md",
      expect.stringContaining("第1章"),
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/test/project/wiki/outlines/volume-plan.md",
      expect.stringContaining("分卷规划"),
    )
    const directorCall = mocks.writeFileAtomic.mock.calls.find(
      ([path]) => path === "/test/project/.novel/director-pipeline.json",
    )
    expect(directorCall).toBeDefined()
    const persistedDirector = JSON.parse(String(directorCall![1]))
    expect(persistedDirector.fileVersion).toBe(1)
    expect(isDirectorStateValid(persistedDirector.state)).toBe(true)
    expect(persistedDirector.state.currentPhase).toBe("chapters")
    expect(persistedDirector.state.statuses).toEqual({
      idea: "done",
      world: "done",
      character: "done",
      outline: "done",
      chapters: "running",
    })
    expect(persistedDirector.ideaInput).toMatchObject({
      title: result.title,
      genre: "科幻未来",
    })
    expect(persistedDirector.ideaInput.coreConflict.length).toBeGreaterThan(0)
  })

  it("P0-01 角色文件名清洗防路径穿越、处理超长尾点与 Windows 保留设备名", async () => {
    const longWithTrailingDotAt64 = `${"a".repeat(63)}.tail`
    installStageAwareMockLlm({
      characters: JSON.stringify([
        { name: "../../etc/passwd", role: "主角", profile: "# 角色A" },
        { name: "苏/砚:黑*客?", role: "对手", profile: "# 角色B" },
        { name: "../..", role: "盟友", profile: "# 角色C" },
        { name: "CON", role: "配角1", profile: "# 角色D" },
        { name: "nul", role: "配角2", profile: "# 角色E" },
        { name: longWithTrailingDotAt64, role: "配角3", profile: "# 角色F" },
      ]),
    })

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "星际密室悬疑故事",
      targetChapters: 5,
      llmConfig: mockLlmConfig,
    })

    for (const ch of result.characters) {
      expect(ch.filePath.startsWith("/test/project/wiki/entities/characters/")).toBe(true)
      expect(ch.filePath).not.toContain("..")
      const fileName = ch.filePath.slice("/test/project/wiki/entities/characters/".length)
      expect(fileName).not.toContain("/")
      expect(fileName).not.toContain("\\")
      expect(fileName.endsWith(".md")).toBe(true)
      const stem = fileName.slice(0, -3)
      expect(stem.endsWith(".")).toBe(false)
      expect(stem.endsWith("_")).toBe(false)
    }
    expect(result.characters[2].filePath).toBe("/test/project/wiki/entities/characters/character-3.md")
    expect(result.characters[3].filePath).toBe("/test/project/wiki/entities/characters/char-CON.md")
    expect(result.characters[4].filePath).toBe("/test/project/wiki/entities/characters/char-nul.md")
    expect(result.characters[5].filePath).toBe(`/test/project/wiki/entities/characters/${"a".repeat(63)}.md`)
  })

  it("P0-01 fail-closed：无可用 API Key 时拒绝静态回退，抛出带阶段名的错误且零 LLM 调用", async () => {
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "奇幻世界探险",
        llmConfig: { ...mockLlmConfig, apiKey: "", provider: "openai" },
      }),
    ).rejects.toThrow(/阶段1:soul-doc.*缺少可用的 LLM 配置/)
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("P0-01 ollama 配置：有 ollamaUrl 时无需 apiKey 可正常调用；缺 ollamaUrl 时 fail-loud", async () => {
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "奇幻世界探险",
        llmConfig: { ...mockLlmConfig, apiKey: "", provider: "ollama", ollamaUrl: "" },
      }),
    ).rejects.toThrow(/阶段1:soul-doc.*缺少可用的 LLM 配置/)
    expect(mocks.streamChat).not.toHaveBeenCalled()

    const ollamaResult = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "奇幻世界探险",
      llmConfig: { ...mockLlmConfig, apiKey: "", provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" },
    })
    expect(ollamaResult.soulDoc).toContain("灵魂文档")
    expect(mocks.streamChat).toHaveBeenCalledTimes(5)
  })

  it("P0-01 fail-closed：LLM 流式 onError、抛错或返回空内容一律抛带阶段名错误，绝不静默降级", async () => {
    // 1) 流式 onError
    mocks.streamChat.mockImplementationOnce(async (_cfg, _messages, callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("LLM Token 超限或断网"))
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "探寻古老遗迹的秘密",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段1:soul-doc.*LLM Token 超限或断网/)

    // 2) 直接抛异常
    mocks.streamChat.mockRejectedValueOnce(new Error("RPC 异常中断"))
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "探寻古老遗迹的秘密",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段1:soul-doc.*RPC 异常中断/)

    // 3) 空输出
    mocks.streamChat.mockImplementationOnce(async (_cfg, _messages, callbacks: StreamCallbacks) => {
      callbacks.onToken("   ")
      callbacks.onDone()
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "探寻古老遗迹的秘密",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段1:soul-doc.*空内容/)
  })

  it("P0-01 fail-closed：世界观蓝图非法 JSON 或缺失必填层时抛阶段2错误，禁止填伪造占位", async () => {
    installStageAwareMockLlm({ worldBlueprint: "这里没有任何 JSON 对象" })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "修仙世界",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段2:world-blueprint.*JSON/)

    installStageAwareMockLlm({
      worldBlueprint: JSON.stringify({
        worldType: "玄幻修真",
        layers: { axioms: ["灵气守恒"], background: [] },
      }),
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "修仙世界",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段2:world-blueprint.*完备性校验失败/)
    expect(mocks.saveWorldBlueprint).not.toHaveBeenCalled()
  })

  it("P0-01 fail-closed：角色非法结构、大纲无分章标题、框架缺起承转合节点均按阶段报错", async () => {
    // 阶段 3：角色缺必填字段
    installStageAwareMockLlm({
      characters: JSON.stringify([{ name: "苏砚", role: "", profile: "" }]),
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "悬疑奇案",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段3:characters.*缺少必填字段/)

    // 阶段 4：大纲不含任何可解析章节标题
    installStageAwareMockLlm({
      outline: "# 仅有简介\n没有分章标题。",
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "悬疑奇案",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段4:outline.*缺少可解析的分章标题/)

    // 阶段 6：框架缺少起承转合完整 4 阶段
    installStageAwareMockLlm({
      framework: JSON.stringify({
        nodes: [{ phase: "起", title: "只有一幕", coreConflict: "c", involvedCharacters: ["苏砚"], goal: "g", causeFromPrev: "p", expectedOutcome: "o" }],
      }),
    })
    await expect(
      runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "悬疑奇案",
        llmConfig: mockLlmConfig,
      }),
    ).rejects.toThrow(/阶段6:framework-binding.*4 个起承转合节点/)
    expect(mocks.saveBinding).not.toHaveBeenCalled()
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
    expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/test/project",
        startChapter: 1,
        chapterCount: 3,
        cruiseMode: false,
      }),
    )
  })

  it("题材与书名推导分支覆盖：悬疑推理、都市逆袭、奇幻冒险、短书名与标点符号灵感", async () => {
    const resSuspense = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "深夜老宅发生诡异凶杀案，侦探追查神秘凶手",
      llmConfig: mockLlmConfig,
    })
    expect(resSuspense.genre).toBe("悬疑推理")

    const resUrban = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "职场小透明重生回到十年前商海狂潮，开启神豪逆袭之路",
      llmConfig: mockLlmConfig,
    })
    expect(resUrban.genre).toBe("都市逆袭")

    const resFantasy = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "漂流在浩瀚云海中的浮岛文明与巨兽",
      llmConfig: mockLlmConfig,
    })
    expect(resFantasy.genre).toBe("奇幻冒险")

    const resShort = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "道",
      llmConfig: mockLlmConfig,
    })
    expect(resShort.title).toBe("玄幻修真传奇")

    const resPunctuation = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "，，，！？",
      llmConfig: mockLlmConfig,
    })
    expect(resPunctuation.title).toBe("未命名神作")
  })

  it("端到端生产流水线：未开启 autoStartCruise、缺省 targetChapters 与 cruiseChapterCount 封顶", async () => {
    const res = await runEndToEndAutonomousNovelProduction({
      projectPath: "/test/project",
      idea: "平凡少年的奇幻成长之旅",
      targetChapters: undefined,
      novelConfig: {
        preset: "action",
        temperature: 0.8,
      } as unknown as import("@/stores/wiki-store").NovelConfig,
      llmConfig: mockLlmConfig,
      autoStartCruise: false,
    })

    expect(res.incubation).toBeDefined()
    expect(res.campaign).toBeUndefined()
    expect(mocks.runAutonomousDraftCampaign).not.toHaveBeenCalled()

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
      expect.objectContaining({ chapterCount: 2 }),
    )

    const resDefaultCap = await runEndToEndAutonomousNovelProduction({
      projectPath: "/test/project",
      idea: "少年逆袭记",
      targetChapters: undefined,
      cruiseChapterCount: 5,
      llmConfig: mockLlmConfig,
      autoStartCruise: true,
    })
    expect(resDefaultCap.campaign).toBeDefined()
    expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ chapterCount: 5, cruiseMode: false }),
    )
  })

  it("unpack 产物是退化形状时 tokenCost 近似不抛错（数字项 / 循环引用）", async () => {
    const cyclic: Record<string, unknown> = { name: "self" }
    cyclic.self = cyclic
    mocks.unpackOutlineToChapterFiles.mockResolvedValue([1, cyclic])

    const result = await runAutonomousNovelIncubator({
      projectPath: "/test/project",
      idea: "赛博朋克都市中一名被遗忘的机械记忆修复师意外唤醒了神明代码",
      targetChapters: 5,
      llmConfig: mockLlmConfig,
    })

    expect(result.projectPath).toBe("/test/project")
    expect(mocks.unpackOutlineToChapterFiles).toHaveBeenCalled()
  })

  it("TASK-005：目标章数 > 20 时 volume-plan.md 确定性拆分为多卷，且 director-pipeline 落盘失败非致命", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    mocks.writeFileAtomic.mockImplementation(async (path: string) => {
      if (path.endsWith("/.novel/director-pipeline.json")) {
        throw new Error("disk quota exceeded")
      }
    })

    try {
      const result = await runAutonomousNovelIncubator({
        projectPath: "/test/project",
        idea: "赛博朋克都市中一名被遗忘的机械记忆修复师意外唤醒了神明代码",
        title: "断层记忆",
        genre: "科幻未来",
        targetChapters: 25,
        llmConfig: mockLlmConfig,
      })

      expect(result.title).toBe("断层记忆")
      const volumeCall = mocks.writeFileAtomic.mock.calls.find(
        ([path]) => path === "/test/project/wiki/outlines/volume-plan.md",
      )
      expect(volumeCall).toBeDefined()
      const volumeText = String(volumeCall![1])
      expect(volumeText).toContain("第 1 卷（第 1-20 章）")
      expect(volumeText).toContain("第 2 卷（第 21-25 章）")
      expect(warnSpy).toHaveBeenCalledWith(
        "autonomous-incubator",
        expect.stringContaining("director-pipeline.json"),
        expect.objectContaining({ error: expect.stringContaining("disk quota exceeded") }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
