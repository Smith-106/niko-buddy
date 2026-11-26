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
import { ReviewParseError } from "./review-adapter"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
import { emptyDecisionGates } from "./deep-chapter-decision-gates"
import { DEFAULT_CHAPTER_LENGTH_SPEC } from "./deep-chapter-prompts"
import { runFullReviewWithSixDim } from "./deep-chapter-review"
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

function makeInput(
  novelConfig: ReturnType<typeof makeNovelConfig>,
  genre?: string,
  chapterNumber = 3,
): DeepChapterGenerationInput {
  return {
    projectPath: "/P",
    userRequest: `写第${chapterNumber}章：雨夜旧屋`,
    chapterNumber,
    ...(genre ? { genre } : {}),
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
  const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
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
  reviewChapter?: DeepChapterGenerationDeps["reviewChapter"]
  streamChat?: DeepChapterGenerationDeps["streamChat"]
  signal?: AbortSignal
  genre?: string
  chapterNumber?: number
}) {
  const novelConfig = options.novelConfig ?? makeNovelConfig()
  const draft = options.draft ?? chapterText("初稿雨夜旧屋，")
  const revised = draft + "返修补了一句收束过渡，把上一段的悬念往前推了一步。" + (options.reviseExtra ?? "")
  const reviewChapter = options.reviewChapter ?? makeReviewChapter(options.errCalls ?? 0)
  const streamChat = options.streamChat ?? makeStreamChat(revised)
  const deps = makeDeps(reviewChapter as ReturnType<typeof makeReviewChapter>, streamChat as ReturnType<typeof makeStreamChat>)
  const { callbacks, thinking, checkpoints } = makeCallbacks()
  const result = await runReviewAndRepair(
    makeInput(novelConfig, options.genre, options.chapterNumber),
    novelConfig as DeepChapterGenerationInput["novelConfig"],
    deps,
    options.signal,
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
  return { result, reviewChapter, streamChat, thinking, checkpoints, revised }
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
  it("after_revision 已复审检查点（revisionReviewPending=false）恢复修订稿：门控按 findings 重建后进一次返修即收敛", async () => {
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
      revisionReviewPending: false,
      decisionGates: emptyDecisionGates(),
      retryCount: 0,
    } as unknown as DeepChapterGenerationResumeCheckpoint
    // errCalls=0：跳过 stage4 与 stage5.5（已复审），按 findings 重建门控后进循环返修并一轮收敛
    const { result, reviewChapter, streamChat } = await runRepair({ resumeCheckpoint })
    expect(result.revised).toBe(true)
    expect(result.retryCount).toBe(1)
    expect(result.manualHandoff).toBe(false)
    // 仅循环内一次复审 + 一次返修 LLM 调用（无 stage4、无 stage5.5、无 Track B）
    expect(reviewChapter).toHaveBeenCalledTimes(1)
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("W1-01: after_revision 且 revisionReviewPending=true 检查点不重跑阶段4，必须触发阶段5.5 返修后复审", async () => {
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
      revisionReviewPending: true,
      decisionGates: emptyDecisionGates(),
      retryCount: 1,
    } as unknown as DeepChapterGenerationResumeCheckpoint

    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const { result, streamChat, thinking, checkpoints } = await runRepair({
      resumeCheckpoint,
      reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })

    expect(result.revised).toBe(true)
    expect(result.retryCount).toBe(1)
    expect(result.manualHandoff).toBe(false)
    expect(result.currentContent).toBe(currentContent)
    expect(result.semanticallyReviewedContent).toBe(currentContent)
    // 绝不重跑 stage4（送审的是 currentContent 而非 draft）且必须触发阶段5.5 复审
    expect(reviewChapter).toHaveBeenCalledTimes(1)
    expect(reviewChapter.mock.calls[0][1]).toBe(currentContent)
    expect(streamChat).not.toHaveBeenCalled()
    expect(thinking.join("\n")).toContain("阶段5.5：返修后复审")
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      stage: "after_revision",
      revisionReviewPending: false,
      semanticallyReviewedContent: currentContent,
    })
  })

  it("W1-01: 已审检查点持久化并恢复透传 semanticallyReviewedContent；revisionReviewPending=true 检查点严禁落该字段", async () => {
    // 1) 运行阶段4（阻断）→ 返修（pending checkpoint）→ 阶段5复审（通过）
    let calls = 0
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      calls += 1
      options?.onSemanticReviewCompleted?.()
      return calls === 1 ? [ERR_FINDING] : []
    })
    const { result, checkpoints, revised } = await runRepair({
      reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(result.semanticallyReviewedContent).toBe(revised)
    // checkpoints: [0]=after_review, [1]=after_revision(pending:true), [2]=after_revision(pending:false)
    expect(checkpoints).toHaveLength(3)
    expect(checkpoints[0].stage).toBe("after_review")
    expect(checkpoints[0].semanticallyReviewedContent).toBeTruthy()
    expect(checkpoints[1].stage).toBe("after_revision")
    expect(checkpoints[1].revisionReviewPending).toBe(true)
    expect(checkpoints[1].semanticallyReviewedContent).toBeUndefined()
    expect(checkpoints[2].stage).toBe("after_revision")
    expect(checkpoints[2].revisionReviewPending).toBe(false)
    expect(checkpoints[2].semanticallyReviewedContent).toBe(revised)

    // 2) 从已审检查点恢复：semanticallyReviewedContent === currentContent 时透传
    const draft = chapterText("初稿雨夜旧屋，")
    const current = chapterText("已审定修订稿，", 6)
    const restored = await runRepair({
      draft,
      resumeCheckpoint: {
        version: 1,
        originalRequest: "写第3章：雨夜旧屋",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "任务书正文（无契约段）",
        draftContent: draft,
        reviewResults: [],
        currentContent: current,
        revisionReviewPending: false,
        decisionGates: emptyDecisionGates(),
        retryCount: 1,
        semanticallyReviewedContent: current,
      },
    })
    expect(restored.reviewChapter).not.toHaveBeenCalled()
    expect(restored.result.semanticallyReviewedContent).toBe(current)

    // 3) 若检查点内 semanticallyReviewedContent 与 currentContent 不一致 → 拒绝透传（fail-closed）
    const mismatched = await runRepair({
      draft,
      resumeCheckpoint: {
        version: 1,
        originalRequest: "写第3章：雨夜旧屋",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "任务书正文（无契约段）",
        draftContent: draft,
        reviewResults: [],
        currentContent: current,
        revisionReviewPending: false,
        decisionGates: emptyDecisionGates(),
        retryCount: 1,
        semanticallyReviewedContent: "旧版本正文",
      },
    })
    expect(mismatched.result.semanticallyReviewedContent).toBeUndefined()
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

describe("W1-05 stage5 reviewParseFailed 补检与阶段5.7 护栏/回滚", () => {
  const THRILL_WARNING: NovelReviewResult = {
    severity: "warning",
    type: "thrill",
    message: "爽点密度偏弱",
    evidence: "片段",
    relatedMemory: "",
    suggestion: "增强章末钩",
  }

  it("1) stage5 返修后复审触发 ReviewParseError → manualHandoff=true、落盘 checkpoint 且 semanticallyReviewedContent=undefined", async () => {
    let calls = 0
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      calls += 1
      if (calls === 1) {
        options?.onSemanticReviewCompleted?.()
        return [ERR_FINDING]
      }
      throw new ReviewParseError("broken-stage5-json", "unexpected token")
    })

    const { result, checkpoints, thinking } = await runRepair({
      reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })

    expect(result.manualReviewRequired).toBe(true)
    expect(result.manualHandoff).toBe(true)
    expect(result.semanticallyReviewedContent).toBeUndefined()
    expect(result.reviewResults.some((r) => r.type === "review_parse_failed")).toBe(true)
    // BLK-01: 解析失败时三门必须落 pending（不伪通过）
    expect(result.decisionGates.consistency.status).toBe("pending")
    expect(result.decisionGates.anti_ai.status).toBe("pending")
    expect(result.decisionGates.quality.status).toBe("pending")
    expect(result.decisionGates.overall).toBe("pending")
    expect(thinking.join("\n")).toContain("返修复审解析失败转人工")
    const lastCheckpoint = checkpoints[checkpoints.length - 1]
    expect(lastCheckpoint).toMatchObject({
      stage: "after_revision",
      revisionReviewPending: true,
      manualReviewRequired: true,
    })
    expect(lastCheckpoint.decisionGates?.overall).toBe("pending")
    expect(lastCheckpoint.semanticallyReviewedContent).toBeUndefined()
  })

  it("2) 阶段5.7 护栏拒绝（guard.accept=false）→ 跳过复审零额外 reviewChapter 调用并完整保留绿稿状态", async () => {
    const draft = chapterText("门控绿稿正文，")
    const fix1ViolatingPolish = `${draft}\n最终存活者是屋主。`
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return [THRILL_WARNING]
    })

    const { result, thinking, checkpoints } = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(fix1ViolatingPolish) as unknown as DeepChapterGenerationDeps["streamChat"],
    })

    // 仅阶段4跑过 1 次审稿，阶段5.7 护栏拒绝后不再多跑 runFullReviewWithSixDim
    expect(reviewChapter).toHaveBeenCalledTimes(1)
    expect(result.currentContent).toBe(draft)
    expect(result.revised).toBe(false)
    expect(result.semanticallyReviewedContent).toBe(draft)
    expect(result.decisionGates.overall).toBe("warning")
    expect(thinking.join("\n")).toContain("阶段5.7：文学抛光回退")
    // 只有阶段4 的 after_review checkpoint，不落伪造的 after_revision checkpoint
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].stage).toBe("after_review")
  })

  it("3) 阶段5.7 护栏放行但复审引入阻断错误或 reviewParseFailed → 完整回滚至抛光前快照", async () => {
    const draft = chapterText("门控绿稿正文，")
    const polished = chapterText("抛光改写正文，")

    for (const mode of ["blocking", "parse_failed"] as const) {
      let calls = 0
      const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
        calls += 1
        if (calls === 1) {
          options?.onSemanticReviewCompleted?.()
          return [THRILL_WARNING]
        }
        if (mode === "blocking") {
          options?.onSemanticReviewCompleted?.()
          return [ERR_FINDING]
        }
        throw new ReviewParseError("bad-stage57-json", "unexpected token")
      })

      const { result, checkpoints, thinking } = await runRepair({
        novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
        draft,
        reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
        streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
      })

      expect(reviewChapter).toHaveBeenCalledTimes(2)
      expect(result.currentContent).toBe(draft)
      expect(result.revised).toBe(false)
      expect(result.decisionGates.overall).toBe("warning")
      expect(result.reviewResults).toEqual([THRILL_WARNING])
      expect(result.semanticallyReviewedContent).toBe(draft)
      expect(thinking.join("\n")).toContain("阶段5.7：文学抛光回退")
      expect(checkpoints).toHaveLength(1)
      expect(checkpoints[0].stage).toBe("after_review")
    }
  })

  it("4) 阶段5.7 复审抛非取消异常时完整回滚至快照；用户取消异常则继续上抛", async () => {
    const draft = chapterText("门控绿稿正文，")
    const polished = chapterText("抛光改写正文，")

    // 非取消异常 → 完整回滚
    let calls = 0
    const failingReview = vi.fn(async (_pp, _content, _ch, options) => {
      calls += 1
      if (calls === 1) {
        options?.onSemanticReviewCompleted?.()
        return [THRILL_WARNING]
      }
      throw new Error("review transport 502")
    })
    const rolled = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      reviewChapter: failingReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
    })
    expect(rolled.result.currentContent).toBe(draft)
    expect(rolled.result.revised).toBe(false)
    expect(rolled.result.semanticallyReviewedContent).toBe(draft)
    expect(rolled.thinking.join("\n")).toContain("阶段5.7：文学抛光回退")

    // 用户取消 → 上抛不吞
    const controller = new AbortController()
    let cancelCalls = 0
    const cancellingReview = vi.fn(async (_pp, _content, _ch, options) => {
      cancelCalls += 1
      if (cancelCalls === 1) {
        options?.onSemanticReviewCompleted?.()
        return [THRILL_WARNING]
      }
      controller.abort()
      throw new Error("已停止生成")
    })
    await expect(
      runRepair({
        novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
        draft,
        signal: controller.signal,
        reviewChapter: cancellingReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
        streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
      }),
    ).rejects.toThrow("已停止生成")
  })

  it("5) BLK-01: 从 stage5 reviewParseFailed 检查点恢复——仍失败保 pending+manualHandoff，成功则重置，关闭审稿不可静默放行", async () => {
    const draft = chapterText("初稿正文，")
    const current = chapterText("待复审修订稿，", 6)
    const parseFailedCheckpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "写第3章：雨夜旧屋",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "任务书正文（无契约段）",
      draftContent: draft,
      reviewResults: [{
        severity: "warning",
        type: "review_parse_failed",
        message: "审查输出解析失败",
        evidence: "bad",
        relatedMemory: "review-adapter",
        suggestion: "重试",
      }],
      currentContent: current,
      revisionReviewPending: true,
      decisionGates: emptyDecisionGates(),
      retryCount: 1,
      manualReviewRequired: true,
    }

    // (a) 恢复后阶段5.5 再次解析失败 → 保持 revisionReviewPending=true、manualReviewRequired=true、三门 pending、manualHandoff=true
    const stillFailingReview = vi.fn(async () => {
      throw new ReviewParseError("still-broken", "unexpected token")
    })
    const stillFailed = await runRepair({
      draft,
      resumeCheckpoint: parseFailedCheckpoint,
      reviewChapter: stillFailingReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(stillFailingReview).toHaveBeenCalledTimes(1)
    expect(stillFailed.result.manualHandoff).toBe(true)
    expect(stillFailed.result.manualReviewRequired).toBe(true)
    expect(stillFailed.result.semanticallyReviewedContent).toBeUndefined()
    expect(stillFailed.result.decisionGates.consistency.status).toBe("pending")
    expect(stillFailed.result.decisionGates.overall).toBe("pending")
    expect(stillFailed.checkpoints[0]).toMatchObject({
      stage: "after_revision",
      revisionReviewPending: true,
      manualReviewRequired: true,
    })
    expect(stillFailed.checkpoints[0].semanticallyReviewedContent).toBeUndefined()

    // (b) 恢复后阶段5.5 审稿成功 → 重置 manualReviewRequired=false 并签发 semanticallyReviewedContent
    const cleanReview = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const recovered = await runRepair({
      draft,
      resumeCheckpoint: parseFailedCheckpoint,
      reviewChapter: cleanReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(cleanReview).toHaveBeenCalledTimes(1)
    expect(recovered.result.manualHandoff).toBe(false)
    expect(recovered.result.manualReviewRequired).toBe(false)
    expect(recovered.result.semanticallyReviewedContent).toBe(current)
    expect(recovered.checkpoints[0]).toMatchObject({
      stage: "after_revision",
      revisionReviewPending: false,
      semanticallyReviewedContent: current,
    })

    // (c) 关闭审稿开关恢复 manualReviewRequired=true 检查点 → 绝不以 manualHandoff=false 落出到阶段7
    const disabledReview = await runRepair({
      novelConfig: makeNovelConfig({ deepChapterReview: false }),
      draft,
      resumeCheckpoint: parseFailedCheckpoint,
    })
    expect(disabledReview.result.manualHandoff).toBe(true)
    expect(disabledReview.result.manualReviewRequired).toBe(true)
    expect(disabledReview.result.semanticallyReviewedContent).toBeUndefined()
  })

  it("6) BLK-02 & R2-REV-001: 阶段5.7 无 signal 抛中文 AbortError 直接上抛；纯 Quality warning 升级豁免回滚，真实 error 严格回滚", async () => {
    const draft = chapterText("门控绿稿正文，")
    const polished = chapterText("抛光改写正文，")

    // BLK-02: 无 signal、中文消息但 name === "AbortError" → 直接上抛
    let abortCalls = 0
    const abortReview = vi.fn(async (_pp, _content, _ch, options) => {
      abortCalls += 1
      if (abortCalls === 1) {
        options?.onSemanticReviewCompleted?.()
        return [THRILL_WARNING]
      }
      throw new DOMException("已取消", "AbortError")
    })
    await expect(
      runRepair({
        novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
        draft,
        reviewChapter: abortReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
        streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "已取消" })

    // R2-REV-001: mystery 题材（normalizeAuditGenre→"悬疑"）下 P0/P1 全绿 + 0 error + 3 条纯 Quality warning
    // 触发 upgradedToFail（overall="fail"）→ 与 decideDraftAdoptionGate 同源豁免，保留阶段5.7 抛光成果
    let upgradeCalls = 0
    const threeQualityWarnings: NovelReviewResult[] = [1, 2, 3].map((idx) => ({
      severity: "warning",
      type: "quality",
      message: `质量告警-${idx}`,
      evidence: "片段",
      relatedMemory: "",
      suggestion: "调整",
    }))
    const upgradeReview = vi.fn(async (_pp, _content, _ch, options) => {
      upgradeCalls += 1
      options?.onSemanticReviewCompleted?.()
      return upgradeCalls === 1 ? [THRILL_WARNING] : threeQualityWarnings
    })
    const preserved = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      genre: "mystery",
      reviewChapter: upgradeReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
    })
    expect(preserved.result.currentContent).toBe(polished)
    expect(preserved.result.revised).toBe(true)
    expect(preserved.result.semanticallyReviewedContent).toBe(polished)
    expect(preserved.result.decisionGates.consistency.status).toBe("passed")
    expect(preserved.result.decisionGates.anti_ai.status).toBe("passed")
    expect(preserved.result.decisionGates.quality.status).toBe("failed")
    expect(preserved.result.decisionGates.overall).toBe("fail")
    expect(preserved.thinking.join("\n")).not.toContain("阶段5.7：文学抛光回退")

    // R2-REV-001 反例：同题材下引入 P0 consistency / P1 anti_ai / P2 quality error → 严格回滚
    for (const errType of ["consistency", "anti_ai", "quality"] as const) {
      let errCalls = 0
      const errorReview = vi.fn(async (_pp, _content, _ch, options) => {
        errCalls += 1
        options?.onSemanticReviewCompleted?.()
        if (errCalls === 1) return [THRILL_WARNING]
        return [{
          severity: "error" as const,
          type: errType,
          message: `阻断错误-${errType}`,
          evidence: "片段",
          relatedMemory: "",
          suggestion: "修复",
        }]
      })
      const rolled = await runRepair({
        novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
        draft,
        genre: "mystery",
        reviewChapter: errorReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
        streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
      })
      expect(rolled.result.currentContent).toBe(draft)
      expect(rolled.result.revised).toBe(false)
      expect(rolled.result.semanticallyReviewedContent).toBe(draft)
      expect(rolled.thinking.join("\n")).toContain("阶段5.7：文学抛光回退")
    }
  })
})

describe("N-1/3v2 semanticReviewCompleted 透传与 ReviewParseError / 熔断对齐", () => {
  const THREE_QUALITY_WARNINGS: NovelReviewResult[] = [1, 2, 3].map((idx) => ({
    severity: "warning",
    type: "quality",
    message: `质量告警-${idx}`,
    evidence: "片段",
    relatedMemory: "",
    suggestion: "调整",
  }))

  const THRILL_WARNING: NovelReviewResult = {
    severity: "warning",
    type: "thrill",
    message: "爽点密度偏弱",
    evidence: "片段",
    relatedMemory: "",
    suggestion: "增强章末钩",
  }

  it("runFullReviewWithSixDim 捕获 ReviewParseError 时显式返回 semanticReviewCompleted=false", async () => {
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      // 即使错误抛出前被异常触发过回调，ReviewParseError 仍须 fail-closed 返回 false
      options?.onSemanticReviewCompleted?.()
      throw new ReviewParseError("broken-json", "unexpected token")
    })
    const deps = makeDeps(
      reviewChapter as unknown as ReturnType<typeof makeReviewChapter>,
      makeStreamChat(""),
    )
    const out = await runFullReviewWithSixDim(
      chapterText("正文"),
      3,
      "/P",
      deps,
      undefined,
      CONTEXT_PACK,
      {},
    )
    expect(out.reviewParseFailed).toBe(true)
    expect(out.semanticReviewCompleted).toBe(false)
    expect(out.reviewResults[0]?.type).toBe("review_parse_failed")
  })

  it("stage4 实跑审查点：未调 onSemanticReviewCompleted → 三门 pending；调回调 → 三门 passed", async () => {
    const draft = chapterText("阶段4初稿正文，")

    // 未调回调（fail-closed）
    const unreviewed = await runRepair({
      draft,
      reviewChapter: vi.fn(async () => []) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(unreviewed.result.semanticallyReviewedContent).toBeUndefined()
    expect(unreviewed.result.decisionGates.consistency.status).toBe("pending")
    expect(unreviewed.result.decisionGates.anti_ai.status).toBe("pending")
    expect(unreviewed.result.decisionGates.quality.status).toBe("pending")
    expect(unreviewed.result.decisionGates.overall).toBe("pending")
    expect(unreviewed.checkpoints[0]?.decisionGates?.overall).toBe("pending")
    expect(unreviewed.checkpoints[0]?.semanticallyReviewedContent).toBeUndefined()

    // 调回调 → passed
    const reviewed = await runRepair({
      draft,
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(reviewed.result.semanticallyReviewedContent).toBe(draft)
    expect(reviewed.result.decisionGates.consistency.status).toBe("passed")
    expect(reviewed.result.decisionGates.anti_ai.status).toBe("passed")
    expect(reviewed.result.decisionGates.quality.status).toBe("passed")
    expect(reviewed.result.decisionGates.overall).toBe("pass")
    expect(reviewed.checkpoints[0]?.decisionGates?.overall).toBe("pass")
    expect(reviewed.checkpoints[0]?.semanticallyReviewedContent).toBe(draft)
  })

  it("stage5.5 恢复复审点（revisionReviewPending=true + emptyDecisionGates）：未调回调 → pending；调回调 → passed", async () => {
    const draft = chapterText("初稿正文，")
    const current = chapterText("待复审修订稿，", 6)
    const pendingCheckpoint = {
      version: 1,
      originalRequest: "写第3章：雨夜旧屋",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "任务书正文（无契约段）",
      draftContent: draft,
      reviewResults: [],
      currentContent: current,
      revisionReviewPending: true,
      decisionGates: emptyDecisionGates(),
      retryCount: 1,
    } as unknown as DeepChapterGenerationResumeCheckpoint

    // 未调回调 → 必进阶段 5.5，但三门保持 pending，不签发 semanticallyReviewedContent
    const unreviewedReview = vi.fn<DeepChapterGenerationDeps["reviewChapter"]>(async () => [])
    const unreviewed = await runRepair({
      draft,
      resumeCheckpoint: pendingCheckpoint,
      reviewChapter: unreviewedReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(unreviewedReview).toHaveBeenCalledTimes(1)
    expect(unreviewedReview.mock.calls[0][1]).toBe(current)
    expect(unreviewed.result.semanticallyReviewedContent).toBeUndefined()
    expect(unreviewed.result.decisionGates.consistency.status).toBe("pending")
    expect(unreviewed.result.decisionGates.anti_ai.status).toBe("pending")
    expect(unreviewed.result.decisionGates.quality.status).toBe("pending")
    expect(unreviewed.result.decisionGates.overall).toBe("pending")
    expect(unreviewed.checkpoints[0]).toMatchObject({
      stage: "after_revision",
      revisionReviewPending: false,
    })
    expect(unreviewed.checkpoints[0]?.decisionGates?.overall).toBe("pending")
    expect(unreviewed.checkpoints[0]?.semanticallyReviewedContent).toBeUndefined()

    // 调回调 → 三门 passed，overall=pass
    const reviewed = await runRepair({
      draft,
      resumeCheckpoint: pendingCheckpoint,
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(reviewed.result.semanticallyReviewedContent).toBe(current)
    expect(reviewed.result.decisionGates.consistency.status).toBe("passed")
    expect(reviewed.result.decisionGates.anti_ai.status).toBe("passed")
    expect(reviewed.result.decisionGates.quality.status).toBe("passed")
    expect(reviewed.result.decisionGates.overall).toBe("pass")
  })

  it("stage5 正常复审分支：未调回调 → pending；调回调 → passed", async () => {
    // 1) stage4 阻断触发返修，stage5 返回 [] 但未调回调 → 三门 pending
    let unreviewedCalls = 0
    const unreviewedStage5 = await runRepair({
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        unreviewedCalls += 1
        if (unreviewedCalls === 1) {
          options?.onSemanticReviewCompleted?.()
          return [ERR_FINDING]
        }
        return []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(unreviewedStage5.result.revised).toBe(true)
    expect(unreviewedStage5.result.semanticallyReviewedContent).toBeUndefined()
    expect(unreviewedStage5.result.decisionGates.consistency.status).toBe("pending")
    expect(unreviewedStage5.result.decisionGates.anti_ai.status).toBe("pending")
    expect(unreviewedStage5.result.decisionGates.quality.status).toBe("pending")
    expect(unreviewedStage5.result.decisionGates.overall).toBe("pending")

    // 2) stage5 调用回调并返回 [] → 三门 passed
    let reviewedCalls = 0
    const reviewedStage5 = await runRepair({
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        reviewedCalls += 1
        options?.onSemanticReviewCompleted?.()
        return reviewedCalls === 1 ? [ERR_FINDING] : []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(reviewedStage5.result.revised).toBe(true)
    expect(reviewedStage5.result.semanticallyReviewedContent).toBe(reviewedStage5.revised)
    expect(reviewedStage5.result.decisionGates.consistency.status).toBe("passed")
    expect(reviewedStage5.result.decisionGates.anti_ai.status).toBe("passed")
    expect(reviewedStage5.result.decisionGates.quality.status).toBe("passed")
    expect(reviewedStage5.result.decisionGates.overall).toBe("pass")
  })

  it("stage5.7 Track B 抛光：进入前已审且抛光后未完成语义复核 → 强制回滚原已审稿；进入前未审 → 保留 pending；完成复核 → passed", async () => {
    const draft = chapterText("门控绿稿正文，")
    const polished = chapterText("抛光通过正文，")

    // 1) 进入 5.7 前原稿已完成语义复核，stage5.7 复审未调回调 → 禁止反降级覆盖，回滚保留原已审稿与原门控
    let unreviewedCalls = 0
    const unreviewedStage57 = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        unreviewedCalls += 1
        if (unreviewedCalls === 1) {
          options?.onSemanticReviewCompleted?.()
          return [THRILL_WARNING]
        }
        return []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
    })
    expect(unreviewedStage57.result.currentContent).toBe(draft)
    expect(unreviewedStage57.result.revised).toBe(false)
    expect(unreviewedStage57.result.semanticallyReviewedContent).toBe(draft)
    expect(unreviewedStage57.result.decisionGates.consistency.status).toBe("passed")
    expect(unreviewedStage57.result.decisionGates.anti_ai.status).toBe("passed")
    expect(unreviewedStage57.result.decisionGates.quality.status).toBe("passed")
    expect(unreviewedStage57.result.decisionGates.overall).toBe("warning")

    // 1b) 对照：进入 5.7 前原稿本身未完成语义复核，stage5.7 亦未调回调 → 保留抛光稿并标 pending
    const bothUnreviewed = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      reviewChapter: vi.fn(async () => [THRILL_WARNING]) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
    })
    expect(bothUnreviewed.result.currentContent).toBe(polished)
    expect(bothUnreviewed.result.revised).toBe(true)
    expect(bothUnreviewed.result.semanticallyReviewedContent).toBeUndefined()
    expect(bothUnreviewed.result.decisionGates.overall).toBe("pending")

    // 2) stage5.7 复审调用回调 → 三门 passed、签发 semanticallyReviewedContent
    let reviewedCalls = 0
    const reviewedStage57 = await runRepair({
      novelConfig: makeNovelConfig({ literaryPolishAfterGate: true }),
      draft,
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        reviewedCalls += 1
        options?.onSemanticReviewCompleted?.()
        return reviewedCalls === 1 ? [THRILL_WARNING] : []
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      streamChat: makeStreamChat(polished) as unknown as DeepChapterGenerationDeps["streamChat"],
    })
    expect(reviewedStage57.result.currentContent).toBe(polished)
    expect(reviewedStage57.result.revised).toBe(true)
    expect(reviewedStage57.result.semanticallyReviewedContent).toBe(polished)
    expect(reviewedStage57.result.decisionGates.consistency.status).toBe("passed")
    expect(reviewedStage57.result.decisionGates.anti_ai.status).toBe("passed")
    expect(reviewedStage57.result.decisionGates.quality.status).toBe("passed")
    expect(reviewedStage57.result.decisionGates.overall).toBe("pass")
  })

  it("3 处熔断转人工点（emotion CB / continuity critical / MAX_GATE_RETRY）对齐透传 genre 与 semanticReviewCompleted", async () => {
    const findingsWithUpgrade: NovelReviewResult[] = [ERR_FINDING, ...THREE_QUALITY_WARNINGS]

    // (a) MAX_GATE_RETRY 熔断（L494）：调回调 + genre=mystery → anti_ai=passed, quality=failed(upgradedToFail)
    const retryReviewed = await runRepair({
      genre: "mystery",
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return findingsWithUpgrade
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(retryReviewed.result.manualHandoff).toBe(true)
    expect(retryReviewed.result.decisionGates.overall).toBe("manual_review")
    expect(retryReviewed.result.decisionGates.consistency.status).toBe("failed")
    expect(retryReviewed.result.decisionGates.anti_ai.status).toBe("passed")
    expect(retryReviewed.result.decisionGates.quality.status).toBe("failed")
    expect(retryReviewed.result.decisionGates.quality.verdict).toBe("manual_review")

    // (a2) MAX_GATE_RETRY 熔断：未调回调 → 非 error 门保持 pending（不伪通）
    const retryUnreviewed = await runRepair({
      genre: "mystery",
      reviewChapter: vi.fn(async () => findingsWithUpgrade) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(retryUnreviewed.result.manualHandoff).toBe(true)
    expect(retryUnreviewed.result.decisionGates.overall).toBe("manual_review")
    expect(retryUnreviewed.result.decisionGates.consistency.status).toBe("failed")
    expect(retryUnreviewed.result.decisionGates.anti_ai.status).toBe("pending")
    expect(retryUnreviewed.result.decisionGates.quality.status).toBe("pending")

    // (b) 情绪债务熔断（L409）
    fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("emotion-ledger.json")) {
        return JSON.stringify({
          entries: [{
            characterName: "主角",
            valence: -1,
            arousal: -1,
            dominance: -1,
            netValue: -5,
            lastUpdatedChapter: 2,
            history: [],
          }],
          lastUpdated: "2026-01-01T00:00:00.000Z",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    })
    const emotionReviewed = await runRepair({
      genre: "mystery",
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return findingsWithUpgrade
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(emotionReviewed.result.manualHandoff).toBe(true)
    expect(emotionReviewed.thinking.join("\n")).toContain("情绪债务熔断转人工")
    expect(emotionReviewed.result.decisionGates.overall).toBe("manual_review")
    expect(emotionReviewed.result.decisionGates.anti_ai.status).toBe("passed")
    expect(emotionReviewed.result.decisionGates.quality.status).toBe("failed")

    const emotionUnreviewed = await runRepair({
      genre: "mystery",
      reviewChapter: vi.fn(async () => findingsWithUpgrade) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(emotionUnreviewed.result.manualHandoff).toBe(true)
    expect(emotionUnreviewed.result.decisionGates.anti_ai.status).toBe("pending")
    expect(emotionUnreviewed.result.decisionGates.quality.status).toBe("pending")

    // (c) 连续性机械 critical 熔断（L457）
    fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [{
            id: "f1",
            name: "锈钥匙",
            description: "旧屋锈钥匙",
            status: "planted",
            plantedChapter: 1,
            advancedChapters: [],
            relatedCharacters: ["主角"],
            relatedEvents: [],
            notes: "",
          }],
          lastUpdated: "",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const continuityReviewed = await runRepair({
        genre: "mystery",
        chapterNumber: 8,
        reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
          options?.onSemanticReviewCompleted?.()
          return findingsWithUpgrade
        }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      })
      expect(continuityReviewed.result.manualHandoff).toBe(true)
      expect(continuityReviewed.thinking.join("\n")).toContain("连续性机械 critical 转人工")
      expect(continuityReviewed.result.decisionGates.overall).toBe("manual_review")
      expect(continuityReviewed.result.decisionGates.anti_ai.status).toBe("passed")
      expect(continuityReviewed.result.decisionGates.quality.status).toBe("failed")

      const continuityUnreviewed = await runRepair({
        genre: "mystery",
        chapterNumber: 8,
        reviewChapter: vi.fn(async () => findingsWithUpgrade) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      })
      expect(continuityUnreviewed.result.manualHandoff).toBe(true)
      expect(continuityUnreviewed.result.decisionGates.anti_ai.status).toBe("pending")
      expect(continuityUnreviewed.result.decisionGates.quality.status).toBe("pending")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("R2-W03 & R2-W05：透传 genre 到 reviewChapter、checkpoint 重建严守 semanticReviewCompleted、initialStateDeltaResults 接入 P0 门与重检", async () => {
    const draft = chapterText("初稿正文，")
    const receivedGenres: Array<string | undefined> = []
    const reviewChapter = vi.fn(async (_pp, _content, _ch, options) => {
      receivedGenres.push(options?.genre)
      options?.onSemanticReviewCompleted?.()
      return []
    })

    // 1) genre 透传至 runFullReviewWithSixDim → reviewChapter
    await runRepair({
      draft,
      genre: "mystery",
      reviewChapter: reviewChapter as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(receivedGenres).toEqual(["mystery"])

    // 2) after_review 检查点 overall=pending 且缺 semanticallyReviewedContent → 重建仍保持 pending（不伪通过）
    const pendingRestored = await runRepair({
      draft,
      genre: "mystery",
      resumeCheckpoint: {
        version: 1,
        originalRequest: "写第3章",
        chapterNumber: 3,
        stage: "after_review",
        taskBrief: "任务书",
        draftContent: draft,
        reviewResults: [],
        decisionGates: emptyDecisionGates(),
        retryCount: 0,
      },
    })
    expect(pendingRestored.result.decisionGates.overall).toBe("pending")
    expect(pendingRestored.result.decisionGates.consistency.status).toBe("pending")

    // 3) initialStateDeltaResults 含 P0 error 时阻断并触发阶段5返修，recheckStateDelta 消除后收敛
    const stateDeltaError: NovelReviewResult = {
      severity: "error",
      type: "state_delta_light_check",
      message: "已故角色「老周」在本章正文中仍呈活跃描写",
      evidence: "dead_character_active",
      relatedMemory: "character:老周",
      suggestion: "删除已故角色活跃出场",
    }
    const revisedText = chapterText("已清除已故角色的返修正文，")
    const recheckStateDelta = vi.fn(async () => [])
    const reviewForDelta = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const { callbacks } = makeCallbacks()
    const novelConfig = makeNovelConfig()
    const deps = makeDeps(
      reviewForDelta as unknown as ReturnType<typeof makeReviewChapter>,
      makeStreamChat(revisedText),
    )
    const out = await runReviewAndRepair(
      makeInput(novelConfig, "mystery", 3),
      novelConfig as DeepChapterGenerationInput["novelConfig"],
      deps,
      undefined,
      callbacks,
      CONTEXT_PACK,
      draft,
      undefined,
      LLM,
      "大纲",
      "上下文",
      "任务书",
      DEFAULT_CHAPTER_LENGTH_SPEC,
      undefined,
      vi.fn(),
      undefined,
      [stateDeltaError],
      recheckStateDelta,
    )
    expect(out.revised).toBe(true)
    expect(out.retryCount).toBe(1)
    expect(recheckStateDelta).toHaveBeenCalledWith(revisedText)
    expect(out.decisionGates.consistency.status).toBe("passed")
    expect(out.decisionGates.overall).toBe("pass")
  })

  it("P1-1 (BLK-01 恢复防绕过): 3 处熔断在 revised=true 时落盘 revisionReviewPending=false，且恢复新/旧熔断检查点均不重跑阶段5.5并保持 manualReviewRequired=true", async () => {
    // (a1) retryCountCircuitBreaker（revised=true）→ 末检查点 stage=after_revision, manualReviewRequired=true, revisionReviewPending=false
    const retryTripped = await runRepair({
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return [ERR_FINDING]
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    const retryFinalCkpt = retryTripped.checkpoints[retryTripped.checkpoints.length - 1]
    expect(retryTripped.result.revised).toBe(true)
    expect(retryFinalCkpt).toMatchObject({
      stage: "after_revision",
      manualReviewRequired: true,
      revisionReviewPending: false,
    })
    expect(retryFinalCkpt.decisionGates?.overall).toBe("manual_review")

    // (a2) emotion-ledger Circuit Breaker（revised=true）→ 末检查点同样落 revisionReviewPending=false
    fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("emotion-ledger.json")) {
        return JSON.stringify({
          entries: [{
            characterName: "主角",
            valence: -1,
            arousal: -1,
            dominance: -1,
            netValue: -5,
            lastUpdatedChapter: 2,
            history: [],
          }],
          lastUpdated: "2026-01-01T00:00:00.000Z",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    })
    const emotionTripped = await runRepair({
      reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
        options?.onSemanticReviewCompleted?.()
        return [ERR_FINDING]
      }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    const emotionFinalCkpt = emotionTripped.checkpoints[emotionTripped.checkpoints.length - 1]
    expect(emotionTripped.result.revised).toBe(true)
    expect(emotionFinalCkpt).toMatchObject({
      stage: "after_revision",
      manualReviewRequired: true,
      revisionReviewPending: false,
    })

    // (a3) continuity critical Circuit Breaker（revised=true）→ 末检查点同样落 revisionReviewPending=false
    fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [{
            id: "f1",
            name: "锈钥匙",
            description: "旧屋锈钥匙",
            status: "planted",
            plantedChapter: 1,
            advancedChapters: [],
            relatedCharacters: ["主角"],
            relatedEvents: [],
            notes: "",
          }],
          lastUpdated: "",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let continuityFinalCkpt: DeepChapterGenerationResumeCheckpoint
    try {
      const continuityTripped = await runRepair({
        chapterNumber: 8,
        reviewChapter: vi.fn(async (_pp, _content, _ch, options) => {
          options?.onSemanticReviewCompleted?.()
          return [ERR_FINDING]
        }) as unknown as DeepChapterGenerationDeps["reviewChapter"],
      })
      continuityFinalCkpt = continuityTripped.checkpoints[continuityTripped.checkpoints.length - 1]
      expect(continuityTripped.result.revised).toBe(true)
      expect(continuityFinalCkpt).toMatchObject({
        stage: "after_revision",
        manualReviewRequired: true,
        revisionReviewPending: false,
      })
    } finally {
      warnSpy.mockRestore()
    }

    // (a4) after_review（revised=false）直接触发 retryCountCircuitBreaker → stage=after_review 且不伪造 revisionReviewPending
    const unrevisedDraft = chapterText("未返修初稿，")
    const unrevisedTripped = await runRepair({
      draft: unrevisedDraft,
      resumeCheckpoint: {
        version: 1,
        originalRequest: "写第3章：雨夜旧屋",
        chapterNumber: 3,
        stage: "after_review",
        taskBrief: "任务书正文（无契约段）",
        draftContent: unrevisedDraft,
        reviewResults: [ERR_FINDING],
        decisionGates: retryFinalCkpt.decisionGates && {
          ...retryFinalCkpt.decisionGates,
          overall: "fail",
        },
        retryCount: 3,
      },
    })
    const unrevisedCkpt = unrevisedTripped.checkpoints[unrevisedTripped.checkpoints.length - 1]
    expect(unrevisedTripped.result.revised).toBe(false)
    expect(unrevisedTripped.result.manualHandoff).toBe(true)
    expect(unrevisedCkpt.stage).toBe("after_review")
    expect(unrevisedCkpt.manualReviewRequired).toBe(true)
    expect(unrevisedCkpt.revisionReviewPending).toBeUndefined()

    // (b1) 从新熔断检查点恢复（after_revision + manualReviewRequired=true + revisionReviewPending=false）
    // → 不得重跑阶段 5.5，直接保持 manualReviewRequired=true / manualHandoff=true
    const cleanReview = vi.fn(async (_pp, _content, _ch, options) => {
      options?.onSemanticReviewCompleted?.()
      return []
    })
    const resumedNew = await runRepair({
      draft: retryFinalCkpt.draftContent,
      resumeCheckpoint: retryFinalCkpt,
      reviewChapter: cleanReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(cleanReview).not.toHaveBeenCalled()
    expect(resumedNew.result.manualReviewRequired).toBe(true)
    expect(resumedNew.result.manualHandoff).toBe(true)
    expect(resumedNew.result.semanticallyReviewedContent).toBeUndefined()
    expect(resumedNew.thinking.join("\n")).not.toContain("阶段5.5：返修后复审")

    // (b2) 从旧版熔断检查点恢复（缺 revisionReviewPending 字段，但 manualReviewRequired=true 且 overall="manual_review"）
    // → 向后兼容防绕过：同样不重跑阶段 5.5，保持 manualReviewRequired=true / manualHandoff=true
    const legacyCircuitBreakerCkpt: DeepChapterGenerationResumeCheckpoint = {
      ...retryFinalCkpt,
    }
    delete legacyCircuitBreakerCkpt.revisionReviewPending
    const resumedLegacy = await runRepair({
      draft: legacyCircuitBreakerCkpt.draftContent,
      resumeCheckpoint: legacyCircuitBreakerCkpt,
      reviewChapter: cleanReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(cleanReview).not.toHaveBeenCalled()
    expect(resumedLegacy.result.manualReviewRequired).toBe(true)
    expect(resumedLegacy.result.manualHandoff).toBe(true)
    expect(resumedLegacy.result.semanticallyReviewedContent).toBeUndefined()
    expect(resumedLegacy.thinking.join("\n")).not.toContain("阶段5.5：返修后复审")

    // (b3) 旧版熔断检查点同时缺 revisionReviewPending 与 decisionGates → fail-closed 不重跑阶段 5.5
    const legacyWithoutGates: DeepChapterGenerationResumeCheckpoint = {
      ...legacyCircuitBreakerCkpt,
    }
    delete legacyWithoutGates.decisionGates
    const resumedWithoutGates = await runRepair({
      draft: legacyWithoutGates.draftContent,
      resumeCheckpoint: legacyWithoutGates,
      reviewChapter: cleanReview as unknown as DeepChapterGenerationDeps["reviewChapter"],
    })
    expect(cleanReview).not.toHaveBeenCalled()
    expect(resumedWithoutGates.result.manualReviewRequired).toBe(true)
    expect(resumedWithoutGates.result.manualHandoff).toBe(true)
    expect(resumedWithoutGates.result.semanticallyReviewedContent).toBeUndefined()
  })
})
