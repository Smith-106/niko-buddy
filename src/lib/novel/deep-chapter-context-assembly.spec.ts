/**
 * deep-chapter-context-assembly 行为测试（新建：此前无专属 spec）。
 *
 * 覆盖目标（2026-11-05 基线：与 generation 专属 spec 合跑后仍有 19 行未覆盖）：
 *  - applyStagePromptBudget notes 播报（167）
 *  - 任务自定义技能装载成功/失败两路（270-285）
 *  - resume 已过 after_scene_breakdown 早退（350）
 *  - 场景拆解两连败 break（376）
 * 全部 LLM（streamChat 经 deps 注入）与动态导入模块均 mock；纯函数走真实实现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_NOVEL_CONFIG, type LlmConfig } from "@/stores/wiki-store"
import type { ContextPack } from "./context-engine"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
import { DEFAULT_CHAPTER_LENGTH_SPEC } from "./deep-chapter-prompts"
import {
  assembleContext,
  generateTaskBrief,
  isSceneBreakdownCheckpointComplete,
  runSceneBreakdownStage,
} from "./deep-chapter-context-assembly"
import type { UserSkill } from "./skill-library"

// ---- 文件 IO 统一 mock：缺省 ENOENT 空项目 ----
const fsReadFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => {
  const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
  err.code = "ENOENT"
  throw err
}))
const fsListMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>(async () => []))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, readFile: fsReadFileMock, listDirectory: fsListMock }
})

const sceneMocks = vi.hoisted(() => ({
  runSceneBreakdown: vi.fn(),
  persistSceneBreakdownDraft: vi.fn(),
}))
vi.mock("./scene-breakdown", async () => {
  const actual = await vi.importActual<typeof import("./scene-breakdown")>("./scene-breakdown")
  return { ...actual, runSceneBreakdown: sceneMocks.runSceneBreakdown, persistSceneBreakdownDraft: sceneMocks.persistSceneBreakdownDraft }
})

vi.mock("./community-summary", async () => {
  const actual = await vi.importActual<typeof import("./community-summary")>("./community-summary")
  return { ...actual, generateCommunitySummariesForChapter: vi.fn(async () => "") }
})

vi.mock("./novel-skill-hooks", async () => {
  const actual = await vi.importActual<typeof import("./novel-skill-hooks")>("./novel-skill-hooks")
  return {
    ...actual,
    runNovelSkillHooks: vi.fn(async () => ({
      projectPath: "",
      stage: "pre_write_prompt",
      bag: { promptFragments: [], notes: [] },
    })),
  }
})

vi.mock("./planning", () => ({ buildChapterPlan: vi.fn(async () => null) }))

const skillStoreMocks = vi.hoisted(() => ({ loadUserSkillConfig: vi.fn() }))
vi.mock("./user-skill-store", async () => {
  const actual = await vi.importActual<typeof import("./user-skill-store")>("./user-skill-store")
  return { ...actual, loadUserSkillConfig: skillStoreMocks.loadUserSkillConfig }
})

const userMemoryMocks = vi.hoisted(() => ({ loadUserMemoryForProject: vi.fn() }))
vi.mock("@/lib/user-memory/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/user-memory/session")>("@/lib/user-memory/session")
  return { ...actual, loadUserMemoryForProject: userMemoryMocks.loadUserMemoryForProject }
})

const LLM = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

const PACK: ContextPack = {
  task: "生成第3章",
  chapterGoal: "目标",
  outline: "第3章大纲：雨夜旧屋",
  recentChapterContents: [],
  recentSummaries: [],
  previousChapterEnding: "",
  characterStates: "",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "",
  timeline: "",
  relatedSettings: "",
  canonRules: "主角不能凭空知道旧屋主人身份。",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
  gaps: [],
  styleExemplars: [],
  activeEntities: [],
} as unknown as ContextPack

function makeNovelConfig(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_NOVEL_CONFIG, autoGenerateChapterTitle: false, sceneBreakdownEnabled: false, ...overrides }
}

function makeInput(novelConfig: ReturnType<typeof makeNovelConfig>): DeepChapterGenerationInput {
  return {
    projectPath: "/P",
    userRequest: "写第3章：雨夜旧屋",
    chapterNumber: 3,
    llmConfig: LLM,
    novelConfig: novelConfig as DeepChapterGenerationInput["novelConfig"],
  }
}

function makeStreamChat(text: string) {
  return vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

function makeDeps(streamChat: ReturnType<typeof makeStreamChat>): DeepChapterGenerationDeps {
  return {
    buildContextPack: vi.fn(async () => PACK),
    contextPackToPrompt: vi.fn(() => "CTX正文"),
    streamChat,
  } as unknown as DeepChapterGenerationDeps
}

function makeCallbacks() {
  const thinking: string[] = []
  const checkpoints: unknown[] = []
  const callbacks: DeepChapterGenerationCallbacks = {
    onThinking: vi.fn((content: string) => {
      thinking.push(content)
    }),
    onCheckpoint: vi.fn(async (checkpoint: DeepChapterGenerationResumeCheckpoint) => {
      checkpoints.push(checkpoint)
    }),
  }
  return { callbacks, thinking, checkpoints }
}

beforeEach(() => {
  vi.clearAllMocks()
  userMemoryMocks.loadUserMemoryForProject.mockResolvedValue(null)
  skillStoreMocks.loadUserSkillConfig.mockResolvedValue({ version: 1, selectedSkillId: null, disabledSkillIds: [], skills: [], categories: [] })
  sceneMocks.runSceneBreakdown.mockResolvedValue({ scenes: [] })
  sceneMocks.persistSceneBreakdownDraft.mockResolvedValue(undefined)
})

describe("assembleContext", () => {
  it("组装 outline/上下文/cachePrefix 并落 after_context 检查点", async () => {
    const novelConfig = makeNovelConfig()
    const { callbacks, thinking, checkpoints } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(novelConfig),
      callbacks,
      undefined,
      undefined,
      "",
      async () => null,
    )
    expect(out.contextPack).toBe(PACK)
    expect(out.customDeAiSkill).toBeNull()
    expect(out.outlinePrompt).toContain("第3章大纲：雨夜旧屋")
    expect(out.contextPrompt).toContain("CTX正文")
    expect(out.cachePrefix).toContain("第3章大纲")
    expect(thinking.join("\n")).toContain("上下文")
    expect(checkpoints).toHaveLength(1)
    expect((checkpoints[0] as { stage: string }).stage).toBe("after_context")
  })

  it("loadSmartDeAiSkill 返回技能时回传 customDeAiSkill", async () => {
    const { callbacks } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(makeNovelConfig()),
      callbacks,
      undefined,
      undefined,
      "",
      async () => "de-ai-skill",
    )
    expect(out.customDeAiSkill).toBe("de-ai-skill")
  })

  it("任务自定义技能命中时拼入 contextPrompt", async () => {
    const skill = { id: "s1", name: "悬念钩子", content: "每章结尾留钩子" } as unknown as UserSkill
    skillStoreMocks.loadUserSkillConfig.mockResolvedValue({
      version: 1, selectedSkillId: null, disabledSkillIds: [], skills: [skill], categories: [],
    })
    const novelConfig = makeNovelConfig({ taskSkillNames: { writing: ["悬念钩子"], outline: [], review: [], summary: [], extract: [] } })
    const { callbacks } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(novelConfig),
      callbacks,
      undefined,
      undefined,
      "",
      async () => null,
    )
    expect(out.contextPrompt).toContain("## 任务自定义技能（用户配置）")
    expect(out.contextPrompt).toContain("### 悬念钩子\n每章结尾留钩子")
  })

  it("任务技能名单命中空集时不拼段（picked 为空）", async () => {
    const novelConfig = makeNovelConfig({ taskSkillNames: { writing: ["不存在"], outline: [], review: [], summary: [], extract: [] } })
    const { callbacks } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(novelConfig),
      callbacks,
      undefined,
      undefined,
      "",
      async () => null,
    )
    expect(out.contextPrompt).not.toContain("任务自定义技能")
  })

  it("任务技能装载失败不阻断（catch → 空片段继续）", async () => {
    skillStoreMocks.loadUserSkillConfig.mockRejectedValueOnce(new Error("skill store boom"))
    const novelConfig = makeNovelConfig({ taskSkillNames: { writing: ["悬念钩子"], outline: [], review: [], summary: [], extract: [] } })
    const { callbacks } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(novelConfig),
      callbacks,
      undefined,
      undefined,
      "",
      async () => null,
    )
    expect(out.contextPrompt).not.toContain("任务自定义技能")
    expect(out.contextPrompt).toContain("CTX正文")
  })

  it("前情分析与社区摘要拼入上下文", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    vi.mocked(generateCommunitySummariesForChapter).mockResolvedValueOnce("COMM摘要")
    const { callbacks } = makeCallbacks()
    const out = await assembleContext(
      makeDeps(makeStreamChat("x")),
      makeInput(makeNovelConfig()),
      callbacks,
      undefined,
      undefined,
      "前情：主角收到信",
      async () => null,
    )
    expect(out.communitySummaryInjection).toBe("COMM摘要")
    expect(out.contextPrompt).toContain("## 前情分析")
    expect(out.contextPrompt).toContain("## 相关社区摘要")
  })
})

describe("generateTaskBrief 阶段预算播报", () => {
  it("计划超 20000 字上限被截断并播报 notes", async () => {
    const streamChat = makeStreamChat("任务书正文")
    const { callbacks, thinking } = makeCallbacks()
    const input = makeInput(makeNovelConfig())
    const brief = await generateTaskBrief(
      { ...input, planBlueprint: "计".repeat(21000) },
      LLM,
      makeDeps(streamChat),
      undefined,
      callbacks,
      "大纲",
      "上下文".repeat(500),
      DEFAULT_CHAPTER_LENGTH_SPEC,
      undefined,
      PACK,
      "CACHE",
    )
    expect(brief).toBe("任务书正文")
    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(thinking.join("\n")).toContain("已截断")
  })

  it("resume 检查点已有 taskBrief 时短路，不调 LLM", async () => {
    const streamChat = makeStreamChat("任务书正文")
    const { callbacks } = makeCallbacks()
    const brief = await generateTaskBrief(
      makeInput(makeNovelConfig()),
      LLM,
      makeDeps(streamChat),
      undefined,
      callbacks,
      "大纲",
      "上下文",
      DEFAULT_CHAPTER_LENGTH_SPEC,
      { taskBrief: "  已有任务书  ", stage: "after_task_brief" } as never,
      PACK,
      undefined,
    )
    expect(brief).toBe("已有任务书")
    expect(streamChat).not.toHaveBeenCalled()
  })
})

describe("runSceneBreakdownStage", () => {
  it("开关关闭直接返回", async () => {
    const notePartial = vi.fn()
    await runSceneBreakdownStage(
      makeInput(makeNovelConfig()),
      makeNovelConfig() as never,
      undefined,
      PACK,
      makeCallbacks().callbacks,
      undefined,
      notePartial,
    )
    expect(sceneMocks.runSceneBreakdown).not.toHaveBeenCalled()
    expect(notePartial).not.toHaveBeenCalled()
  })

  it("resume 已过 after_scene_breakdown 时跳过（isSceneBreakdownCheckpointComplete）", async () => {
    expect(isSceneBreakdownCheckpointComplete({ stage: "after_scene_breakdown" } as never)).toBe(true)
    expect(isSceneBreakdownCheckpointComplete({ stage: "after_context" } as never)).toBe(false)
    expect(isSceneBreakdownCheckpointComplete(undefined)).toBe(false)
    const notePartial = vi.fn()
    await runSceneBreakdownStage(
      makeInput(makeNovelConfig({ sceneBreakdownEnabled: true })),
      makeNovelConfig({ sceneBreakdownEnabled: true }) as never,
      { stage: "after_scene_breakdown" } as never,
      PACK,
      makeCallbacks().callbacks,
      undefined,
      notePartial,
    )
    expect(sceneMocks.runSceneBreakdown).not.toHaveBeenCalled()
    expect(notePartial).not.toHaveBeenCalled()
  })

  it("两连败 break：非阻断继续，不记 partial", async () => {
    sceneMocks.runSceneBreakdown.mockRejectedValue(new Error("scene boom"))
    const notePartial = vi.fn()
    const { thinking } = makeCallbacks()
    const { callbacks } = makeCallbacks()
    await runSceneBreakdownStage(
      makeInput(makeNovelConfig({ sceneBreakdownEnabled: true })),
      makeNovelConfig({ sceneBreakdownEnabled: true }) as never,
      undefined,
      PACK,
      callbacks,
      undefined,
      notePartial,
    )
    expect(sceneMocks.runSceneBreakdown).toHaveBeenCalledTimes(2)
    expect(sceneMocks.persistSceneBreakdownDraft).not.toHaveBeenCalled()
    expect(notePartial).not.toHaveBeenCalled()
    expect(thinking.join("\n")).toBe("")
    void thinking
  })
})
