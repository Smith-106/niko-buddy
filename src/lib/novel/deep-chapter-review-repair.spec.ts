/**
 * deep-chapter-review-repair 行为 spec（新建：此前无专属 spec）。
 *
 * 覆盖目标（2026-11-05 基线：其它 spec 合跑后仍有 32 行未覆盖）：
 *  - 阶段 5.5 resume 复审分支（hasCheckpointRevision + pending 门控）
 *  - collectPlateauStructuralFlags 全分支（含 detectors 抛错 catch）
 *  - 平台期早退两种出路（diagnose-structure / keep-current）
 *  - 角色名预加载成功路径（character-states 非空）
 *
 * 全部 LLM（reviewChapter / streamChat 经 deps 注入）与文件 IO
 *（@/commands/fs 统一 ENOENT，单测按需覆写）均 mock；其它纯函数走真实实现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ContextPack } from "./context-engine"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { NovelReviewResult } from "./review-adapter"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
import { emptyDecisionGates } from "./deep-chapter-decision-gates"
import { DEFAULT_CHAPTER_LENGTH_SPEC } from "./deep-chapter-prompts"
import { runReviewAndRepair } from "./deep-chapter-review-repair"

// ---- 文件 IO 统一 mock：缺省 ENOENT 空项目（与 deep-chapter-generation.spec 同口径） ----
const fsReadFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => {
  const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
  err.code = "ENOENT"
  throw err
}))
const fsListMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>(async () => []))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    readFile: fsReadFileMock,
    listDirectory: fsListMock,
  }
})

// ---- 机械层三件套可控桩：覆盖 collectPlateauStructuralFlags 全分支（含抛错 catch） ----
const slopStub = vi.hoisted(() => ({
  chorus: [] as Array<{ para: number, shouts: number }>,
  echo: [] as Array<{ family: string, count: number }>,
  silent: [] as Array<{ fromPara: number, toPara: number }>,
  throwOnChorus: false,
}))
vi.mock("./mechanical-slop-detector", async () => {
  const actual = await vi.importActual<typeof import("./mechanical-slop-detector")>("./mechanical-slop-detector")
  return {
    ...actual,
    detectChorusSing: vi.fn(() => {
      if (slopStub.throwOnChorus) throw new Error("detector boom")
      return slopStub.chorus
    }),
    countEchoFamily: vi.fn(() => slopStub.echo),
    detectSilentStretch: vi.fn(() => slopStub.silent),
  }
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

const ERR_FINDING: NovelReviewResult = {
  severity: "error",
  type: "consistency",
  message: "阻断：主角凭空知道密道位置",
  evidence: "正文第3段",
  relatedMemory: "",
  suggestion: "补充信息来源",
}

function makeNovelConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_NOVEL_CONFIG,
    autoGenerateChapterTitle: false,
    sceneBreakdownEnabled: false,
    literaryPolishAfterGate: false,
    deepChapterReview: true,
    ...overrides,
  }
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

/** 约 1200 字中文正文：各轮复用同一修订稿，保证 slop 推送值恒定触发平台期。 */
function chapterText(seed: string, paragraphs = 12): string {
  const block = `${seed}雨水沿着瓦檐落下，旧屋里的灯影忽明忽暗，主角先确认门缝后的动静。他没有急着开口，而是把锈钥匙压在掌心，听见墙后传来短促的摩擦声。两人沿着走廊往里走，地板下的空响让他们意识到这间屋子被人提前动过手脚。`
  return Array.from({ length: paragraphs }, (_, i) => `第${i + 1}段${block}`).join("\n")
}

/** 前 errCalls 次返回阻断 finding，之后返回干净结果。 */
function makeReviewChapter(errCalls: number) {
  let calls = 0
  return vi.fn(async () => (calls++ < errCalls ? [ERR_FINDING] : []))
}

function makeStreamChat(revised: string) {
  return vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
    callbacks.onToken(revised)
    callbacks.onDone()
  })
}

function makeDeps(
  reviewChapter: ReturnType<typeof makeReviewChapter>,
  streamChat: ReturnType<typeof makeStreamChat>,
): DeepChapterGenerationDeps {
  return {
    buildContextPack: vi.fn(async () => ({})),
    contextPackToPrompt: vi.fn(() => ""),
    reviewChapter,
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

const CONTEXT_PACK = { task: "生成第3章" } as unknown as ContextPack

async function runRepair(options: {
  novelConfig?: ReturnType<typeof makeNovelConfig>
  errCalls?: number
  draft?: string
  reviseExtra?: string
  resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
}) {
  const novelConfig = options.novelConfig ?? makeNovelConfig()
  const draft = options.draft ?? chapterText("初稿雨夜旧屋，")
  const revised = draft + "返修补了一句收束过渡，把上一段的悬念往前推了一步。" + (options.reviseExtra ?? "")
  const reviewChapter = makeReviewChapter(options.errCalls ?? 0)
  const streamChat = makeStreamChat(revised)
  const deps = makeDeps(reviewChapter, streamChat)
  const { callbacks, thinking } = makeCallbacks()
  const result = await runReviewAndRepair(
    makeInput(novelConfig),
    novelConfig as DeepChapterGenerationInput["novelConfig"],
    deps,
    undefined,
    callbacks,
    CONTEXT_PACK,
    draft,
    options.resumeCheckpoint,
    LLM,
    "大纲提示",
    "上下文提示",
    "任务书正文（无契约段）",
    DEFAULT_CHAPTER_LENGTH_SPEC,
    undefined,
    vi.fn(),
  )
  return { result, reviewChapter, streamChat, thinking, revised }
}

beforeEach(() => {
  fsReadFileMock.mockImplementation(async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
    err.code = "ENOENT"
    throw err
  })
  fsListMock.mockResolvedValue([])
  slopStub.chorus = []
  slopStub.echo = []
  slopStub.silent = []
  slopStub.throwOnChorus = false
})

describe("runReviewAndRepair 跳过路径", () => {
  it("关闭审稿开关时直接返回初稿，不调用任何 LLM 审查", async () => {
    const { result, reviewChapter, streamChat } = await runRepair({
      novelConfig: makeNovelConfig({ deepChapterReview: false }),
    })
    expect(result.manualHandoff).toBe(false)
    expect(result.revised).toBe(false)
    expect(result.retryCount).toBe(0)
    expect(result.reviewResults).toEqual([])
    expect(reviewChapter).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
  })
})

describe("runReviewAndRepair revision resume 恢复", () => {
  it("after_revision 检查点恢复修订稿：门控按检查点 findings 重建后进一次返修即收敛", async () => {
    const draft = chapterText("初稿雨夜旧屋，")
    const currentContent = `${chapterText("修订稿雨夜旧屋，", 6)}   `
    const resumeCheckpoint = {
      version: 1,
      originalRequest: "写第3章：雨夜旧屋",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "任务书正文（无契约段）",
      draftContent: draft,
      reviewResults: [ERR_FINDING],
      currentContent,
      decisionGates: emptyDecisionGates(),
      retryCount: 0,
    } as unknown as DeepChapterGenerationResumeCheckpoint
    // errCalls=0：跳过 stage4（检查点已有 review），循环内复审干净，一轮即收敛
    const { result, reviewChapter, streamChat } = await runRepair({ resumeCheckpoint })
    // 修订稿原样恢复（trim），revised 标记为 true
    expect(result.revised).toBe(true)
    expect(result.retryCount).toBe(1)
    expect(result.manualHandoff).toBe(false)
    // 仅循环内一次复审 + 一次返修 LLM 调用（无 stage4、无 Track B）
    expect(reviewChapter).toHaveBeenCalledTimes(1)
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("after_revision 检查点且门控为 pending：门控先按 findings 重建，不再重复调用阶段5.5 复审", async () => {
    // 行为锁：阶段5.5「返修后复审」要求 decisionGates.overall === "pending"，
    // 但进入该守卫前 line 241 已用 buildDecisionGates 从检查点 findings 重建
    // overall（pass/warning/fail/manual_review 之一），因此 pending 检查点恢复
    // 走的是「重建门控 → 无阻断 → 直接收敛」，零 LLM 复审调用。
    const draft = chapterText("初稿雨夜旧屋，")
    const currentContent = chapterText("修订稿雨夜旧屋，", 6)
    const resumeCheckpoint = {
      version: 1,
      originalRequest: "写第3章：雨夜旧屋",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "任务书正文（无契约段）",
      draftContent: draft,
      reviewResults: [],
      currentContent,
      decisionGates: emptyDecisionGates(),
      retryCount: 0,
    } as unknown as DeepChapterGenerationResumeCheckpoint

    const { result, reviewChapter, streamChat, thinking } = await runRepair({ resumeCheckpoint })

    expect(result.revised).toBe(true)
    expect(result.retryCount).toBe(0)
    expect(result.manualHandoff).toBe(false)
    expect(result.currentContent).toBe(currentContent.trim())
    // 无 pending 门控 → 不进 stage-5.5，也不进 fix-loop（无阻断问题）
    expect(reviewChapter).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
    expect(thinking.join("\n")).not.toContain("阶段5.5")
  })
})

describe("runReviewAndRepair 平台期早退", () => {
  function mockCharacterStates() {
    fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("character-states.json")) {
        return JSON.stringify({
          characters: [
            {
              characterName: "主角",
              currentLocation: "旧屋",
              status: "在场",
              equipment: [],
              abilities: [],
              relationships: {},
              lastUpdatedChapter: 3,
              lastUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              characterName: "",
              currentLocation: "别处",
              status: "离场",
              equipment: [],
              abilities: [],
              relationships: {},
              lastUpdatedChapter: 2,
              lastUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          lastUpdated: "2026-01-01T00:00:00.000Z",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    })
  }

  it("连续三轮 slop 无变化 + 有结构信号 → diagnose-structure 建议后接受当前稿", async () => {
    mockCharacterStates()
    slopStub.chorus = [{ para: 2, shouts: 3 }]
    slopStub.echo = [{ family: "“锈钥匙”", count: 4 }]
    slopStub.silent = [{ fromPara: 4, toPara: 7 }]
    // stage4 + 前两轮复审阻断，第三轮复审干净 → 平台期判定（3 次 push 恒定）后早退
    // 修订稿含 3 次「"锈钥匙"」引文复读 → 引文频次循环与 echoFams 映射全执行
    const { result, thinking } = await runRepair({
      errCalls: 3,
      reviseExtra: "他握紧“锈钥匙”，把“锈钥匙”藏进袖口，绝不能弄丢“锈钥匙”。",
    })
    expect(result.retryCount).toBe(3)
    expect(result.manualHandoff).toBe(false)
    expect(result.revised).toBe(true)
    const joined = thinking.join("\n")
    expect(joined).toContain("转诊断驱动的结构手术")
    expect(joined).toContain("轮唱×1")
    expect(joined).toContain("复读家族×1")
    expect(joined).toContain("静默段×1")
  })

  it("连续三轮 slop 无变化 + 无结构信号 → keep-current 接受当前稿", async () => {
    const { result, thinking } = await runRepair({ errCalls: 3 })
    expect(result.retryCount).toBe(3)
    expect(result.manualHandoff).toBe(false)
    expect(result.revised).toBe(true)
    expect(thinking.join("\n")).toContain("平台期提前停止")
  })

  it("结构探测器抛错时降级为空信号，不中断返修早退", async () => {
    slopStub.throwOnChorus = true
    const { result, thinking } = await runRepair({ errCalls: 3 })
    expect(result.retryCount).toBe(3)
    expect(result.manualHandoff).toBe(false)
    expect(thinking.join("\n")).toContain("平台期提前停止")
  })
})
