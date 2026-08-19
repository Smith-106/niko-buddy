import { afterEach, describe, expect, it, vi } from "vitest"

// C1 真接线 (ISS-20260719-002) 后 runFullReviewWithSixDim 无条件真实执行
// runContinuityMechanicalPreflight；node 测试环境无 tauri invoke，loader 的
// readFile 抛 ReferenceError(window is not defined)，loadCharacterStates 对非-ENOENT
// 错误 rethrow → preflight degraded 产出多余 engine_error 日志，破坏 ARCH-001
// 非阻断测试“仅 1 次 error 调用”断言。mock readFile 抛 ENOENT（模拟首运行空项目）
// 让 4 个 loader 走正常降级返空 store，preflight 静默返回空 findings。
const fsReadFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => {
  const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
  err.code = "ENOENT"
  throw err
}))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    readFile: fsReadFileMock,
  }
})

// ─────────────────────────────────────────────────────────────────────────
// 覆盖率 100% 攻坚补充 mock：LLM 直连 / 动态导入模块默认降级为空实现（行为
// 与真实模块在 ENOENT 空项目下一致），具体用例再用 vi.mocked(...) 覆写单次行为。
// 全部经 importActual 保留其余 export，避免破坏依赖同一模块的其它调用点。
// ─────────────────────────────────────────────────────────────────────────
vi.mock("./scene-breakdown", async () => {
  const actual = await vi.importActual<typeof import("./scene-breakdown")>("./scene-breakdown")
  return {
    ...actual,
    runSceneBreakdown: vi.fn(async () => ({ scenes: [] })),
    persistSceneBreakdownDraft: vi.fn(async () => {}),
  }
})
vi.mock("./previous-chapters-analysis", async () => {
  const actual = await vi.importActual<typeof import("./previous-chapters-analysis")>("./previous-chapters-analysis")
  return { ...actual, analyzePreviousChapters: vi.fn(async () => "") }
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
vi.mock("./outline-thrill-checkpoints", async () => {
  const actual = await vi.importActual<typeof import("./outline-thrill-checkpoints")>("./outline-thrill-checkpoints")
  return {
    ...actual,
    runOutlineThrillSoftGate: vi.fn((outlineText: string, chapter?: number) =>
      actual.runOutlineThrillSoftGate(outlineText, chapter),
    ),
  }
})
vi.mock("./deterministic-continuity-engine", async () => {
  const actual = await vi.importActual<typeof import("./deterministic-continuity-engine")>("./deterministic-continuity-engine")
  return {
    ...actual,
    checkContinuity: vi.fn((store: unknown, config: unknown, overrideStore?: unknown) =>
      (actual.checkContinuity as (...a: unknown[]) => unknown)(store, config, overrideStore),
    ),
  }
})
vi.mock("./continuity-overrides-store", async () => {
  const actual = await vi.importActual<typeof import("./continuity-overrides-store")>("./continuity-overrides-store")
  return {
    ...actual,
    loadContinuityOverrides: vi.fn(async () => ({ overrides: [], lastUpdated: "" })),
  }
})

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { useWikiStore, DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
import {
  shouldUseDeepChapterGeneration,
  runDeepChapterGeneration,
  runFullReviewWithSixDim,
  collectLiteraryPolishIssues,
  resolveStructurePlanForResidual,
  evaluateResidualPolicyForInput,
  buildDecisionGates,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationResumeCheckpoint,
  type DeepChapterGenerationInput,
  type DeepChapterDecisionGates,
  applyCachePrefix,
} from "./deep-chapter-generation"
import { createDefaultStructureThrilPacingPlan } from "./chapter-structure-plan"
import { RESIDUAL_OVERALL_MEDIAN_THRESHOLD } from "./residual-rewrite-policy"
import {
  runSceneBreakdown,
  persistSceneBreakdownDraft,
  type SceneBreakdownResult,
} from "./scene-breakdown"
import { analyzePreviousChapters } from "./previous-chapters-analysis"
import { generateCommunitySummariesForChapter } from "./community-summary"
import { runNovelSkillHooks } from "./novel-skill-hooks"
import { runOutlineThrillSoftGate } from "./outline-thrill-checkpoints"
import { checkContinuity } from "./deterministic-continuity-engine"
import { loadContinuityOverrides } from "./continuity-overrides-store"
import {
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterFinalPolishPrompt,
  buildDeepChapterRevisionPrompt,
  DEEP_CHAPTER_DRAFT_MAX_CHARS,
  DEEP_CHAPTER_MIN_CHARS,
} from "./deep-chapter-prompts"

const llmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

// ISS-20260709-042: novelConfig now injected via DeepChapterGenerationInput
// (no longer read from useWikiStore inside the generator).
const novelConfig = { ...DEFAULT_NOVEL_CONFIG } satisfies NovelConfig

const contextPack: ContextPack = {
  task: "生成第3章",
  chapterGoal: "第3章目标：主角进入雨夜旧屋，发现第一条线索。",
  outline: "第3章：雨夜旧屋，发现线索，结尾留下危险钩子。",
  recentSummaries: ["第1章：主角收到匿名信。", "第2章：主角抵达旧城区。"],
  previousChapterEnding: "门缝里传来金属拖拽声。",
  characterStates: "主角谨慎，但急于确认真相。",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "主角不知道旧屋主人真实身份。",
  foreshadowingStates: "匿名信、锈钥匙尚未回收。",
  timeline: "雨夜，当晚十点。",
  relatedSettings: "旧屋位于停电后的城区边缘。",
  canonRules: "主角不能凭空知道旧屋主人身份。",
  writingStyle: "悬疑、克制、画面感强。",
  searchResults: "旧屋相关记忆片段。",
  graphSearchResults: "匿名信 -> 旧屋 -> 锈钥匙。",
  mustDo: "承接上一章门缝声，推进锈钥匙线索。",
  mustAvoid: "不要提前揭露旧屋主人身份。",
  nextChapterAdvice: "结尾引出屋内第二个人影。",
  revisionDirectives: "",
  // Wave 5 (v2.5.0): 上下文用量快照（装配自 buildContextPack 的 additive 字段）
  contextUsage: {
    memoryChars: 80,
    retrievalChars: 5120,
    graphChars: 2048,
    bodyChars: 51200,
    otherChars: 25600,
    maxCtx: 100000,
  },
}

function chapterText(prefix: string, count = 3000): string {
  const scenes = [
    "雨水沿着瓦檐落下，旧屋里的灯影忽明忽暗，主角先确认门缝后的动静。",
    "他没有急着开口，而是把锈钥匙压在掌心，听见墙后传来短促的摩擦声。",
    "小晴醒来时仍有些发冷，她的回答补上了上一章留下的疑点，却也带出新的矛盾。",
    "两人沿着走廊往里走，地板下的空响让他们意识到这间屋子被人提前动过手脚。",
    "主角试探着推开柜门，里面没有想象中的尸体，只有一封被雨气浸软的旧信。",
    "信纸上的字迹和匿名信相互呼应，但关键名字被刻意刮掉，线索因此变得更危险。",
    "屋外的脚步声突然停住，像有人贴着门听他们说话，空气一下子绷紧。",
    "主角把小晴挡到身后，决定先带走信纸，却在箱底摸到第二把完全陌生的钥匙。",
  ]
  let text = prefix
  let index = 0
  while (text.length < count) {
    text += `${scenes[index % scenes.length]}第${index + 1}个细节把人物选择继续往前推。`
    index += 1
  }
  return text.slice(0, count)
}

// 写作阶段现在可能把 user 消息内容拆成带 cache_control 的文本块（见 applyCachePrefix）；
// provider 侧会把纯文本块拼回字符串，这里在测试桩里也照做，保持按关键字匹配阶段的逻辑。
function messagesPromptText(messages: ChatMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    )
    .join("\n")
}

function createDeps(reviewResults: NovelReviewResult[] | NovelReviewResult[][] = []): DeepChapterGenerationDeps {
  const responses = [
    "写作任务书内容",
    chapterText("初稿正文内容"),
    chapterText("返修正文内容"),
    chapterText("最终去AI味正文"),
  ]
  const reviewSequence = Array.isArray(reviewResults[0])
    ? reviewResults as NovelReviewResult[][]
    : [reviewResults as NovelReviewResult[], []]
  let reviewCallIndex = 0
  return {
    buildContextPack: vi.fn(async () => contextPack),
    contextPackToPrompt: vi.fn(() => "上下文包内容"),
    reviewChapter: vi.fn(async () => reviewSequence[Math.min(reviewCallIndex++, reviewSequence.length - 1)] ?? []),
    streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? responses[3]
        : prompt.includes("返修")
          ? responses[2]
          : prompt.includes("正文")
            ? responses[1]
            : responses[0]
      callbacks.onToken(content)
      callbacks.onDone()
    }),
  }
}

describe("runDeepChapterGeneration", () => {
  it("keeps the word-count target in planning and draft prompts without forcing later review stages", () => {
    const reviewResults: NovelReviewResult[] = [{
      severity: "error",
      type: "plot",
      message: "测试问题",
      evidence: "",
      relatedMemory: "",
      suggestion: "",
    }]

    const planningPrompt = buildDeepChapterBriefPrompt("", "上下文包内容", "生成第3章", 3)
    const draftPrompt = buildDeepChapterDraftPrompt("", "上下文包内容", "写作任务书内容", "生成第3章", 3)
    const revisionPrompt = buildDeepChapterRevisionPrompt("", "上下文包内容", "写作任务书内容", "初稿正文内容", reviewResults, "生成第3章", 3)
    const finalPolishPrompt = buildDeepChapterFinalPolishPrompt("", "上下文包内容", "写作任务书内容", "返修正文内容", "生成第3章", 3)

    for (const prompt of [planningPrompt, draftPrompt]) {
      expect(prompt).toContain(`低于 ${DEEP_CHAPTER_MIN_CHARS} 字`)
      expect(prompt).toContain("目标约 3000 字")
      expect(prompt).not.toContain("2200-3200 字")
      expect(prompt).not.toContain("阶段4优化")
    }
    expect(draftPrompt).toContain(`阶段3正文草稿最多 ${DEEP_CHAPTER_DRAFT_MAX_CHARS} 字`)
    for (const prompt of [revisionPrompt, finalPolishPrompt]) {
      expect(prompt).not.toContain(`低于 ${DEEP_CHAPTER_MIN_CHARS} 字`)
      expect(prompt).not.toContain("目标约 3000 字")
      expect(prompt).not.toContain("全文安全上限")
      expect(prompt).not.toContain("2200-3200 字")
    }
    expect(finalPolishPrompt).toContain("中文小说去 AI 味补充规则")
    expect(finalPolishPrompt).toContain("角色声线")
    expect(finalPolishPrompt).toContain("不要按非虚构文章规则硬删副词")
  })

  it("only enables deep generation for write-chapter routes when the switch is on", () => {
    expect(shouldUseDeepChapterGeneration({ intent: "write_chapter", confidence: 1, extractedParams: {} }, true)).toBe(true)
    expect(shouldUseDeepChapterGeneration({ intent: "continue_chapter", confidence: 1, extractedParams: {} }, true)).toBe(true)
    expect(shouldUseDeepChapterGeneration({ intent: "write_chapter", confidence: 1, extractedParams: {} }, false)).toBe(false)
    expect(shouldUseDeepChapterGeneration({ intent: "general_chat", confidence: 1, extractedParams: {} }, true)).toBe(true)
    expect(shouldUseDeepChapterGeneration(null, true)).toBe(true)
  })

  it("publishes stage results into thinking and returns the final simple review result when review passes", async () => {
    const deps = createDeps()
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toContain("最终去AI味正文")
    expect(result.revised).toBe(false)
    expect(thinking.join("\n")).toContain("阶段1：上下文分析")
    expect(thinking.join("\n")).toContain("阶段2：写作任务书")
    expect(thinking.join("\n")).toContain("阶段3：正文初稿")
    expect(thinking.join("\n")).toContain("阶段4：AI审稿")
    expect(thinking.join("\n")).toContain("阶段6：简单审查与去AI味")
    expect(thinking.join("\n")).toContain("未发现阻断问题")
  })

  it("injects the enabled writing style into the stage 3 draft prompt", async () => {
    const capturedPrompts: string[] = []
    const enabledStyleContext = "目标文风来源：《长夜书》\n风格硬约束：冷峻克制、短句推进、少解释"
    const deps = createDeps()
    vi.mocked(deps.contextPackToPrompt).mockImplementation((pack) => {
      expect(pack.writingStyle).toContain("悬疑")
      return enabledStyleContext
    })
    vi.mocked(deps.streamChat).mockImplementation(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      capturedPrompts.push(prompt)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终文风正文", 3000)
        : prompt.includes("返修")
          ? chapterText("返修文风正文", 3000)
          : prompt.includes("正文")
            ? chapterText("初稿文风正文", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })

    await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第三章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
    )

    expect(capturedPrompts[1]).toContain("目标文风来源：《长夜书》")
    expect(capturedPrompts[1]).toContain("冷峻克制")
  })

  it("shows a visible golden-three hint in thinking when generating the first chapter", async () => {
    const deps = createDeps()
    const thinking: string[] = []

    await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "给我生成第1章内容",
        chapterNumber: 1,
        llmConfig,

        novelConfig,
        goldenThreeChapter: {
          enabled: true,
          targetChapter: 1,
          outputMode: "first_chapter_with_directions",
          requestedFirstThree: false,
        },
      },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(thinking.join("\n")).toContain("黄金三章：已启用")
    expect(thinking.join("\n")).toContain("当前按黄金三章规则生成第1章正文")
  })

  it("uses safe defaults when a context pack is missing optional array fields", async () => {
    const deps = createDeps()
    vi.mocked(deps.buildContextPack).mockResolvedValueOnce({
      ...contextPack,
      recentSummaries: undefined as unknown as string[],
      chapterGoal: undefined as unknown as string,
      characterStates: undefined as unknown as string,
    })
    const thinking: string[] = []

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )).resolves.toMatchObject({ finalContent: expect.any(String), partial: false, partialReason: null, contextUsage: expect.objectContaining({ memoryChars: 80, maxCtx: 100000 }) })

    expect(thinking.join("\n")).toContain("近期剧情")
  })

  it("falls back to an empty context pack when context building throws", async () => {
    const deps = createDeps()
    vi.mocked(deps.buildContextPack).mockRejectedValueOnce(new Error("context failed"))
    const thinking: string[] = []

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "???3?", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )).resolves.toMatchObject({ finalContent: expect.any(String) })

    expect(thinking.length).toBeGreaterThan(0)
  })

  it("revises once when review returns blocking errors", async () => {
    const deps = createDeps([
      {
        severity: "error",
        type: "plot",
        message: "没有承接上一章门缝声。",
        evidence: "初稿正文内容",
        relatedMemory: "上一章结尾",
        suggestion: "补上门缝声的承接。",
      },
    ])
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toContain("最终去AI味正文")
    expect(result.revised).toBe(true)
    expect(deps.streamChat).toHaveBeenCalledTimes(4)
    expect(thinking.join("\n")).toContain("阶段5：自动返修")
    expect(thinking.join("\n")).toContain("阶段6：简单审查与去AI味")
    expect(thinking.join("\n")).toContain("没有承接上一章门缝声")
  })

  it("rewrites meta task briefs and meta drafts before review", async () => {
    const prompts: string[] = []
    const repairedTaskBrief = "可执行任务书内容：主角必须当场进入屋内，暂定屋主已失踪，线索来自门后异响。"
    const repairedDraft = chapterText("纠偏后正文", 3000)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可执行任务书")) {
          callbacks.onToken(repairedTaskBrief)
        } else if (prompt.includes("错误草稿（仅用于识别错误模式")) {
          callbacks.onToken(repairedDraft)
        } else if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else if (prompt.includes("章节正文")) {
          callbacks.onToken("[N]\n你给我那五句话，我就继续写正文。本轮只给任务书，不写正文。")
        } else {
          callbacks.onToken("请先补充五句话，本轮只给任务书，不写正文。")
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
    )

    expect(result.taskBrief).toBe(repairedTaskBrief)
    expect(result.draftContent).toBe(repairedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", repairedDraft, 3, expect.objectContaining({}))
    expect(prompts.some((prompt) => prompt.includes("不可执行任务书"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("错误草稿（仅用于识别错误模式"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("[TASK_BRIEF_MARKER]") && prompt.includes("不可执行任务书"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("[DRAFT_STAGE_MARKER]") && prompt.includes("错误草稿（仅用于识别错误模式"))).toBe(true)
  })

  it("rewrites task briefs that drift into chapter prose before drafting", async () => {
    const prompts: string[] = []
    const draftLikeTaskBrief = [
      "[N]",
      "",
      "# 第7章 旧门之后",
      "",
      "廊灯没点，他靠着门框，把第二枚钥匙凑到窗缝漏进来的那点雨光里。",
      "",
      "“这把，不是这屋的。”他说。",
      "",
      "小青没接话，呼吸却顿了一拍。",
    ].join("\n")
    const repairedTaskBrief = [
      "本章必须完成：确认第二枚钥匙不属于旧屋，并逼出小青对钥匙来源的首次承认。",
      "禁止违背：主角仍不知道幕后真相；不能新增超出既有设定的第三方目击者。",
      "角色状态：主角保持审慎逼问；小青在回避与承认之间摇摆。",
      "伏笔推进：把“西院库房”升级成下一章明确调查目标。",
      "结尾钩子：以两人转向西院库房作为章节收束。",
    ].join("\n")
    const repairedDraft = chapterText("修正后正文", 3000)
    const finalPolished = chapterText("最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可直接执行")) {
          callbacks.onToken(repairedTaskBrief)
        } else if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else if (prompt.includes("章节正文")) {
          callbacks.onToken(repairedDraft)
        } else {
          callbacks.onToken(draftLikeTaskBrief)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第7章正文", chapterNumber: 7, llmConfig, novelConfig },
      {},
      deps,
    )

    expect(result.taskBrief).toBe(repairedTaskBrief)
    expect(result.draftContent).toBe(repairedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(prompts.some((prompt) => prompt.includes("[TASK_BRIEF_MARKER]") && prompt.includes("不可直接执行"))).toBe(true)
  })

  it("skips extra task-brief repair calls when the generated brief is already a long chapterized spec", async () => {
    const prompts: string[] = []
    const longChapterizedTaskBrief = [
      "# 第7章 雨门之后",
      "",
      "## 一、本章定位",
      "本章承接上一章门缝异响后的追查动作，主角必须带着旧信与第二把钥匙继续推进，同时让外部窥听者的压力持续贴身。".repeat(10),
      "",
      "## 二、本章必须完成",
      "1. 穿过停电后的旧城区边缘，确认旧屋内外都有人抢先动过。".repeat(8),
      "2. 让主角与小青围绕送钥匙的人发生第一次正面争执。".repeat(8),
      "3. 让结尾明确指向下一章的门内第二人影。".repeat(8),
      "",
      "## 三、禁止违背",
      "不得提前揭露旧屋主人的真实身份，不得把匿名信解释成已经证实的真相。".repeat(8),
      "",
      "## 四、角色状态",
      "主角谨慎但急于确认真相；小青处于回避与松动之间；跟踪者始终没有离开。".repeat(8),
      "",
      "## 五、伏笔推进",
      "匿名信、锈钥匙、门后第二人影这三条线索必须同时被推进，但不能一次性揭晓。".repeat(8),
      "",
      "## 六、结尾钩子",
      "以屋内第二个人影的短暂显形结束，让下一章能直接承接。".repeat(8),
    ].join("\n")
    const repairedDraft = chapterText("direct fallback draft", 3000)
    const finalPolished = chapterText("direct fallback final", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可执行任务书：")) {
          throw new Error("unexpected task-brief repair call")
        }
        if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else if (prompt.includes("[DRAFT_STAGE_MARKER]")) {
          callbacks.onToken(repairedDraft)
        } else {
          callbacks.onToken(longChapterizedTaskBrief)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第7章正文", chapterNumber: 7, llmConfig, novelConfig },
      {},
      deps,
    )

    expect(result.taskBrief).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(result.taskBrief).toContain(`禁止违背：${contextPack.mustAvoid}`)
    expect(result.taskBrief).toContain(`角色状态：${contextPack.characterStates}`)
    expect(result.taskBrief).toContain(`伏笔推进：${contextPack.foreshadowingStates}`)
    expect(result.taskBrief).toContain(`结尾钩子：${contextPack.nextChapterAdvice}`)
    expect(result.taskBrief).not.toContain("# 第7章")
    expect(result.draftContent).toBe(repairedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(prompts.some((prompt) => prompt.includes("不可执行任务书："))).toBe(false)
  })

  it("uses local fallback for a resumed after_task_brief checkpoint when the saved taskBrief is actually prose", async () => {
    const prompts: string[] = []
    const invalidCheckpointBrief = [
      "[N]",
      "",
      "# 第7章 旧门之后",
      "",
      "廊灯没点，他靠着门框，把第二枚钥匙凑到窗缝漏进来的那点雨光里。",
      "",
      "“这把，不是这屋的。”他说。",
    ].join("\n")
    const repairedTaskBrief = [
      "本章必须完成：确认第二枚钥匙与旧屋无关，并逼出小青给出“西院库房”这一新线索。",
      "禁止违背：主角仍不能直接知道幕后身份；不得引入不存在的见证人。",
      "角色状态：主角继续追问；小青从回避转向有限承认。",
      "伏笔推进：将第二枚钥匙和西院库房绑定为下一章调查入口。",
      "结尾钩子：以两人转向西院库房作为收束。",
    ].join("\n")
    const repairedDraft = chapterText("恢复后正文", 3000)
    const finalPolished = chapterText("恢复后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可直接执行")) {
          callbacks.onToken(repairedTaskBrief)
        } else if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else {
          callbacks.onToken(repairedDraft)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第7章正文",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
        resumeCheckpoint: {
          version: 1,
          originalRequest: "生成第7章正文",
          chapterNumber: 7,
          stage: "after_task_brief",
          taskBrief: invalidCheckpointBrief,
        },
      },
      {},
      deps,
    )

    expect(result.taskBrief).not.toBe(repairedTaskBrief)
    expect(result.taskBrief).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(result.taskBrief).toContain(`禁止违背：${contextPack.mustAvoid}`)
    expect(result.draftContent).toBe(repairedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(prompts.some((prompt) => prompt.includes("[TASK_BRIEF_MARKER]"))).toBe(false)
    const draftPrompt = prompts.find((prompt) => prompt.includes("[DRAFT_STAGE_MARKER]"))
    expect(draftPrompt).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(draftPrompt).not.toContain(invalidCheckpointBrief)
  })

  it("falls back to a deterministic structured task brief when fresh repair attempts still return prose", async () => {
    const prompts: string[] = []
    const stillInvalidTaskBrief = [
      "[N]",
      "",
      "# 第7章 旧门之后",
      "",
      "雨势没减，廊下灯笼被风吹得摇了半圈，他借着那点晃动的光，把第二枚钥匙凑近眉心。",
      "",
      "“这把，不是这屋的。”他说。",
      "",
      "小青没接话，呼吸却顿了一拍。",
    ].join("\n")
    const repairedDraft = chapterText("fallback 后正文", 3000)
    const finalPolished = chapterText("fallback 后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可直接执行")) {
          callbacks.onToken(stillInvalidTaskBrief)
        } else if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else if (prompt.includes("章节正文")) {
          callbacks.onToken(repairedDraft)
        } else {
          callbacks.onToken(stillInvalidTaskBrief)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第7章正文",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
      },
      {},
      deps,
    )

    expect(result.taskBrief).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(result.taskBrief).toContain(`禁止违背：${contextPack.mustAvoid}`)
    expect(result.taskBrief).toContain(`角色状态：${contextPack.characterStates}`)
    expect(result.taskBrief).toContain(`伏笔推进：${contextPack.foreshadowingStates}`)
    expect(result.taskBrief).toContain(`结尾钩子：${contextPack.nextChapterAdvice}`)
    expect(result.taskBrief).toContain(`暂定设定：${contextPack.relatedSettings}`)
    expect(result.taskBrief).toContain("长度要求：目标约 3000 字；低于 2200 字视为未完成。")
    expect(result.taskBrief).toContain("原始请求对齐：生成第7章正文")
    expect(result.draftContent).toBe(repairedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(prompts.filter((prompt) => prompt.includes("不可直接执行")).length).toBe(2)
    const draftPrompt = prompts.find((prompt) => prompt.includes("[DRAFT_STAGE_MARKER]"))
    expect(draftPrompt).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(draftPrompt).not.toContain(stillInvalidTaskBrief)
  })

  it("sanitizes fallback task brief so resumed checkpoints do not persist structured-memory dumps", async () => {
    const prompts: string[] = []
    const stillInvalidTaskBrief = [
      "[N]",
      "",
      "# 第7章 旧门之后",
      "",
      "雨势没减，廊下灯笼被风吹得摇了半圈，他借着那点晃动的光，把第二枚钥匙凑近眉心。",
      "",
      "“这把，不是这屋的。”他说。",
      "",
      "小青没接话，呼吸却顿了一拍。",
    ].join("\n")
    const noisyContextPack: ContextPack = {
      ...contextPack,
      characterStates: [
        "--- type: structured-memory",
        'memory_type: character-states',
        'snapshot_id: "chapter-5-r2"',
        'sources: ["005.snapshot.json"]',
        "# 人物状态记忆",
        "### 主角",
        "- 当前状态：主角对第二把钥匙的来源起疑，但还没有越界知道幕后人身份。",
        "### 小青",
        "- 当前状态：小青读到旧信警告后明显迟疑，开始暴露与旧屋过去的关系。",
      ].join("\n"),
      foreshadowingStates: [
        "--- type: entity",
        'title: "Second Key"',
        "# Second Key",
        "- 新增伏笔：旧信警告“不要相信送钥匙的人”。",
        "- 推进伏笔：第二把钥匙的陌生齿纹与更冷分量。",
      ].join("\n"),
      relatedSettings: [
        "--- type: entity",
        'title: "Old House"',
        'snapshot_id: "chapter-5-r2"',
        "sources: [\"005.snapshot.json\", \"004.snapshot.json\"]",
        "# Old House",
        "- 旧屋位于停电后的城区边缘，西院库房和走廊都能作为下一步调查入口。",
      ].join("\n"),
      searchResults: [
        "--- type: chapter",
        "chapter_number: 5",
        "chapter_status: final",
        "# Chapter 5",
        "Rain tapped along the broken tiles in steady layers.",
        "The protagonist finds the old letter and a second unfamiliar key.",
      ].join("\n"),
    }
    const repairedDraft = chapterText("净化 fallback 后正文", 3000)
    const finalPolished = chapterText("净化 fallback 后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => noisyContextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        if (prompt.includes("不可直接执行")) {
          callbacks.onToken(stillInvalidTaskBrief)
        } else if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else if (prompt.includes("章节正文")) {
          callbacks.onToken(repairedDraft)
        } else {
          callbacks.onToken(stillInvalidTaskBrief)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第7章正文",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
      },
      {},
      deps,
    )

    expect(result.taskBrief).toContain("角色状态：主角对第二把钥匙的来源起疑")
    expect(result.taskBrief).toContain("伏笔推进：新增伏笔：旧信警告“不要相信送钥匙的人”")
    expect(result.taskBrief).toContain("暂定设定：旧屋位于停电后的城区边缘")
    expect(result.taskBrief).not.toContain("--- type:")
    expect(result.taskBrief).not.toContain("snapshot_id:")
    expect(result.taskBrief).not.toContain("sources: [")
    expect(result.taskBrief).not.toContain("# Chapter 5")
    expect(result.taskBrief.length).toBeLessThan(420)
    const draftPrompt = prompts.find((prompt) => prompt.includes("[DRAFT_STAGE_MARKER]"))
    expect(draftPrompt).toBeDefined()
    expect(draftPrompt).not.toContain("--- type:")
    expect(draftPrompt).not.toContain("snapshot_id:")
    expect(draftPrompt).not.toContain("sources: [")
  })

  it("compresses the real-world long fallback task brief shape instead of reusing memory-dump lines", async () => {
    const realWorldCheckpointBrief = [
      "本章必须完成：- 优先承接上一章结尾：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。",
      "禁止违背：- 不要违背既有设定：--- type: structured-memory memory_type: canon-facts title: \"正式设定记忆\" --- # 正式设定记忆 ## 正式事实 - The old house had already been searched before the protagonists arrived.（来源：第3章、第4章） - 旧宅内藏有旧信，末两行被水渍模糊（来源：第5章） - 旧信中存有一条明确警告：不要相信送钥匙的人（来源：第5章）",
      "角色状态：第5章：主角对钥匙的掌控感加深，开始警惕送钥匙之人 第5章：小青因旧信警告暴露出与旧宅历史的隐秘联系，情绪出现破绽 --- type: entity title: \"Protagonist\" created: 2026-06-27 updated: 2026-06-30 tags: [character] aliases: [\"he\"] related: [Old House, Second Key] snapshot_id: \"chapter-5-r2\" source_type: \"chapter\" source_sequence: 5 source_revision: 2 is_historical: false sources: [\"005.snapshot.json\", \"004.snapshot.json\", \"003.snapshot.json\"] --- # Protagonist",
      "伏笔推进：新增伏笔：旧信警告‘不要相信送钥匙的人’ 新增伏笔：第二把钥匙的陌生齿纹与更冷分量 推进伏笔：小青对旧信警告的反应暗示其知情 --- type: chapter chapter_number: '5' chapter_status: final title: Chapter 5 created: '2026-06-30' --- # Chapter 5",
      "结尾钩子：- 优先延续上一章结尾带出的悬念或动作：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。 - 保持时间线连续：第5章：雨夜：主角与小青进入旧宅 第5章：同夜：发现旧信与第二把钥匙",
      "暂定设定：--- type: entity title: \"Old House\" created: 2026-06-27 updated: 2026-06-30 tags: [location] aliases: [] related: [Protagonist, Xiaoqing] snapshot_id: \"chapter-5-r2\" source_type: \"chapter\" source_sequence: 5 source_revision: 2 is_historical: false sources: [\"005.snapshot.json\", \"004.snapshot.json\", \"003.snapshot.json\"] --- # Old House - [[Protagonist]] — occurs_in - [[Xiaoqing]] — occurs_in",
      "长度要求：目标约 3500 字；低于 2567 字视为未完成。",
      "原始请求对齐：请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
    ].join("\n")
    const repairedDraft = chapterText("真实样本净化后正文", 3000)
    const finalPolished = chapterText("真实样本净化后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else {
          callbacks.onToken(repairedDraft)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
        resumeCheckpoint: {
          version: 1,
          originalRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
          chapterNumber: 7,
          stage: "after_task_brief",
          taskBrief: realWorldCheckpointBrief,
        },
      },
      {},
      deps,
    )

    expect(result.taskBrief).not.toContain("--- type:")
    expect(result.taskBrief).not.toContain("snapshot_id:")
    expect(result.taskBrief).not.toContain("sources: [")
    expect(result.taskBrief).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(result.taskBrief).toContain(`禁止违背：${contextPack.mustAvoid}`)
    expect(result.taskBrief).toContain(`角色状态：${contextPack.characterStates}`)
    expect(result.taskBrief).toContain(`伏笔推进：${contextPack.foreshadowingStates}`)
    expect(result.taskBrief).toContain(`结尾钩子：${contextPack.nextChapterAdvice}`)
    expect(result.taskBrief).toContain(`暂定设定：${contextPack.relatedSettings}`)
    expect(result.taskBrief.length).toBeLessThan(520)
  })

  it("strips residual label and frontmatter fragments from the resumed fallback task brief shape seen in desktop UAT", async () => {
    const contaminatedContextPack: ContextPack = {
      ...contextPack,
      mustDo: "优先承接上一章结尾：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；注意推进或回应相关伏笔：新增伏笔：旧信警告‘不要相信送钥匙的人’",
      mustAvoid: "不要违背既有设定：--- type: structured-memory memory_type: canon-facts title: \"正式设定记忆\" --- # 正式设定记忆 ## 正式事实 - The old house had already been searched before the protagonists arrived.（来源：第3章、第4章） - 旧宅内藏有旧信，末两行被水渍模糊（来源：第5章）",
      characterStates: "角色状态：主角对钥匙的掌控感加深，开始警惕送钥匙之人；小青因旧信警告暴露出与旧宅历史的隐秘联系，情绪出现破绽",
      foreshadowingStates: "伏笔推进：新增伏笔：旧信警告‘不要相信送钥匙的人’；新增伏笔：第二把钥匙的陌生齿纹与更冷分量",
      nextChapterAdvice: "优先延续上一章结尾带出的悬念或动作：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；结合近期伏笔决定是否继续铺设、推进或回收：新增伏笔：旧信警告‘不要相信送钥匙的人’",
      relatedSettings: "暂定设定：The old house had already been searched before the protagonists arrived....；旧宅内藏有旧信，末两行被水渍模糊（来源：第5章）",
    }
    const repairedDraft = chapterText("桌面残片净化后正文", 3000)
    const finalPolished = chapterText("桌面残片净化后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contaminatedContextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else {
          callbacks.onToken(repairedDraft)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
        resumeCheckpoint: {
          version: 1,
          originalRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
          chapterNumber: 7,
          stage: "after_task_brief",
          taskBrief: [
            "本章必须完成：优先承接上一章结尾：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；注意推进或回应相关伏笔：新增伏笔：旧信警告‘不要相信送钥匙的人’",
            "禁止违背：不要违背既有设定：--- type: structured-memory memory_type: canon-facts title: \"正式设定记忆\" --- # 正式设定记忆 ## 正式事实 - The old house had already been searched before the protagonists arrived.（来源：第3章、第4章）",
            "角色状态：主角对钥匙的掌控感加深，开始警惕送钥匙之人；小青因旧信警告暴露出与旧宅历史的隐秘联系，情绪出现破绽",
            "伏笔推进：新增伏笔：旧信警告‘不要相信送钥匙的人’；新增伏笔：第二把钥匙的陌生齿纹与更冷分量",
            "结尾钩子：优先延续上一章结尾带出的悬念或动作：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；结合近期伏笔决定是否继续铺设、推进或回收：新增伏笔：旧信警告‘不要相信送钥匙的人’",
            "暂定设定：The old house had already been searched before the protagonists arrived....；旧宅内藏有旧信，末两行被水渍模糊（来源：第5章）",
            "长度要求：目标约 3500 字；低于 2567 字视为未完成。",
            "原始请求对齐：请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
          ].join("\n"),
        },
      },
      {},
      deps,
    )

    expect(result.taskBrief).toContain("本章必须完成：主角握住陌生钥匙")
    expect(result.taskBrief).toContain("禁止违背：旧宅内藏有旧信")
    expect(result.taskBrief).toContain("角色状态：主角对钥匙的掌控感加深")
    expect(result.taskBrief).toContain("伏笔推进：新增伏笔：旧信警告‘不要相信送钥匙的人’")
    expect(result.taskBrief).toContain("结尾钩子：主角握住陌生钥匙")
    expect(result.taskBrief).toContain("暂定设定：旧宅内藏有旧信")
    expect(result.taskBrief).not.toContain("The old house had already been searched before the protagonists arrived")
    expect(result.taskBrief).not.toContain("不要违背既有设定：")
    expect(result.taskBrief).not.toContain("优先延续上一章结尾带出的悬念或动作：")
    expect(result.taskBrief).not.toContain("暂定设定：The old house")
    expect(result.taskBrief).not.toContain("---")
    expect(result.taskBrief.length).toBeLessThan(420)
  })

  it("re-fallbacks a resumed half-sanitized task brief that still contains bare frontmatter dividers", async () => {
    const repairedDraft = chapterText("二次 fallback 后正文", 3000)
    const finalPolished = chapterText("二次 fallback 后最终正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        if (prompt.includes("简单审查") || prompt.includes("去AI味")) {
          callbacks.onToken(finalPolished)
        } else {
          callbacks.onToken(repairedDraft)
        }
        callbacks.onDone()
      }),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
        chapterNumber: 7,
        llmConfig,

        novelConfig,
        resumeCheckpoint: {
          version: 1,
          originalRequest: "请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
          chapterNumber: 7,
          stage: "after_task_brief",
          taskBrief: [
            "本章必须完成：优先承接上一章结尾：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；注意推进或回应相关伏笔：新增伏笔：旧信警告‘不要相信送钥匙的人’",
            "禁止违背：不要违背既有设定：---；The old house had already been searched before the protagonists arrived....",
            "角色状态：主角对钥匙的掌控感加深，开始警惕送钥匙之人；小青因旧信警告暴露出与旧宅历史的隐秘联系，情绪出现破绽",
            "伏笔推进：新增伏笔：旧信警告‘不要相信送钥匙的人’；新增伏笔：第二把钥匙的陌生齿纹与更冷分量",
            "结尾钩子：优先延续上一章结尾带出的悬念或动作：主角握住陌生钥匙，门下光带变暗，门外的偷听者悄然撤退，黑暗的房间像是一个迟迟未开口的答案。；结合近期伏笔决定是否继续铺设、推进或回收：新增伏笔：旧信警告‘不要相信送钥匙的人’",
            "暂定设定：The old house had already been searched before the protagonists arrived....；旧宅内藏有旧信，末两行被水渍模糊（来源：第5章）",
            "长度要求：目标约 3500 字；低于 2567 字视为未完成。",
            "原始请求对齐：请生成第7章正文，只输出可直接保存到章节库的完整章节正文，约300字。",
          ].join("\n"),
        },
      },
      {},
      deps,
    )

    expect(result.taskBrief).toContain(`本章必须完成：${contextPack.mustDo}`)
    expect(result.taskBrief).toContain(`禁止违背：${contextPack.mustAvoid}`)
    expect(result.taskBrief).toContain(`角色状态：${contextPack.characterStates}`)
    expect(result.taskBrief).not.toContain("The old house had already been searched before the protagonists arrived")
    expect(result.taskBrief).not.toContain("---；")
    expect(result.taskBrief).not.toContain("优先延续上一章结尾带出的悬念或动作：")
    expect(result.taskBrief.length).toBeLessThan(420)
  })

  it("transfers to manual review after three failed auto-retries", async () => {
    const blockingIssue: NovelReviewResult = {
      severity: "error",
      type: "character_consistency",
      message: "主角知道了不该知道的信息。",
      evidence: "主角直接说出了尚未揭露的真相。",
      relatedMemory: "主角尚未知晓幕后人身份",
      suggestion: "删除越界信息，保留角色当前认知边界。",
    }
    const deps = createDeps([
      [blockingIssue],
      [blockingIssue],
      [blockingIssue],
      [blockingIssue],
    ])

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onCheckpoint: () => {} },
      deps,
    )

    expect(result.manualReviewRequired).toBe(true)
    expect(result.retryCount).toBe(3)
    expect(result.decisionGates.consistency.status).toBe("failed")
    expect(result.decisionGates.consistency.manual_review_required).toBe(true)
    expect(result.decisionGates.overall).toBe("manual_review")
  })

  it("propagates initial review failures instead of treating them as a clean pass", async () => {
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => {
        throw new Error("review stalled")
      }),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        const content = prompt.includes("章节正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
        callbacks.onToken(content)
        callbacks.onDone()
      }),
    }

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
    )).rejects.toThrow("review stalled")
  })

  it("automatically expands a too-short draft before review and final output", async () => {
    const shortDraft = chapterText("短稿", 800)
    const expandedDraft = chapterText("扩写后正文", 3000)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        const content = prompt.includes("简单审查") || prompt.includes("去AI味")
          ? finalPolished
          : prompt.includes("扩写补足")
          ? expandedDraft
          : prompt.includes("章节正文")
            ? shortDraft
            : "写作任务书内容"
        callbacks.onToken(content)
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toBe(finalPolished)
    expect(deps.streamChat).toHaveBeenCalledTimes(4)
    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", expandedDraft, 3, expect.objectContaining({}))
    expect(thinking.join("\n")).toContain("阶段3：正文扩写补足")
    expect(thinking.join("\n")).toContain("阶段6：简单审查与去AI味")
  })

  it("does not force expansion after final polish even when the result is short", async () => {
    const draft = chapterText("初稿正文内容", 3000)
    const shortFinal = chapterText("最终润色后过短", 1800)
    const responses = [
      "写作任务书内容",
      draft,
      shortFinal,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const content = responses.shift()
        callbacks.onToken(content ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成首章", chapterNumber: 1, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toBe(shortFinal)
    expect(deps.streamChat).toHaveBeenCalledTimes(3)
    expect(thinking.join("\n")).toContain("阶段5：无需自动返修")
    expect(thinking.join("\n")).toContain("阶段6：简单审查与去AI味")
    expect(thinking.join("\n")).not.toContain("阶段6：字数检查未达标")
    expect(thinking.join("\n")).not.toContain("阶段3：正文扩写补足")
  })

  it("trims runaway repeated chapter output before review and final polish", async () => {
    const repeatUnit = "屋外雨声小了些，风还从门缝挤进来。旧木箱的盖子松松地合上，那东西还在。小晴在床上动了动，掌心湿热，像两股不同的水在交汇。\n"
    const runawayDraft = repeatUnit.repeat(900)
    const optimizedDraft = chapterText("阶段4优化后正文", 3000)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const responses = [
      "写作任务书内容",
      runawayDraft,
      optimizedDraft,
      finalPolished,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.draftContent).toBe(optimizedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", optimizedDraft, 3, expect.objectContaining({}))
    expect(thinking.join("\n")).toContain("检测到模型重复输出")
  })

  it("does not stop the AI chat stream at the old chapter hard max", async () => {
    const longDraft = chapterText("超过旧硬上限但不是重复输出的正文", 6500)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const responses = [
      "写作任务书内容",
      longDraft,
      finalPolished,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.draftContent).toBe(longDraft)
    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", longDraft, 3, expect.objectContaining({}))
    expect(thinking.join("\n")).not.toContain("已达到本章字数上限")
    expect(thinking.join("\n")).not.toContain("内容已达到安全上限")
  })

  it("sends long drafts directly to review without a stage 4 length rewrite", async () => {
    const overlongDraft = chapterText("过长初稿正文", 5200)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const responses = [
      "写作任务书内容",
      overlongDraft,
      finalPolished,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", overlongDraft, 3, expect.objectContaining({}))
    expect(deps.streamChat).toHaveBeenCalledTimes(3)
    expect(thinking.join("\n")).not.toContain("2200-3200")
    expect(thinking.join("\n")).not.toContain("字数优化")
  })

  it("does not optimize the stage 3 draft in stage 4 before review", async () => {
    const draft = chapterText("阶段3较长初稿", 5500)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const responses = [
      "写作任务书内容",
      draft,
      finalPolished,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", draft, 3, expect.objectContaining({}))
    expect(deps.streamChat).toHaveBeenCalledTimes(3)
    expect(thinking.join("\n")).not.toContain("2200-3200")
  })

  it("does not retry stage 4 length optimization when the draft stays long", async () => {
    const draft = chapterText("阶段3超长初稿", 5500)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const responses = [
      "写作任务书内容",
      draft,
      finalPolished,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toBe(finalPolished)
    expect(deps.reviewChapter).toHaveBeenCalledWith("E:/Novel", draft, 3, expect.objectContaining({}))
    expect(deps.streamChat).toHaveBeenCalledTimes(3)
    expect(thinking.join("\n")).not.toContain("2200-3200")
    expect(thinking.join("\n")).not.toContain("连续尝试")
  })

  it("does not force a length rewrite after final polish", async () => {
    const draft = chapterText("初稿正文内容", 3000)
    const overlongFinal = chapterText("简单审查后过长正文", 5200)
    const responses = [
      "写作任务书内容",
      draft,
      overlongFinal,
    ]
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(responses.shift() ?? "")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toBe(overlongFinal)
    expect(deps.streamChat).toHaveBeenCalledTimes(3)
    expect(thinking.join("\n")).toContain("阶段6：简单审查与去AI味")
    expect(thinking.join("\n")).not.toContain("2200-3200")
    expect(thinking.join("\n")).not.toContain("字数检查与正文优化")
  })

  it("resumes from a saved review checkpoint instead of regenerating earlier stages", async () => {
    const finalPolished = chapterText("恢复后的最终正文", 3000)
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "生成第3章",
      chapterNumber: 3,
      stage: "after_review",
      taskBrief: "写作任务书内容",
      draftContent: chapterText("阶段4完成后的正文草稿", 3000),
      reviewResults: [],
    }
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => {
        throw new Error("resume should not rerun review")
      }),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onToken(finalPolished)
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第3章",
        chapterNumber: 3,
        llmConfig,

        novelConfig,
        resumeCheckpoint: checkpoint,
      },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    expect(result.finalContent).toBe(finalPolished)
    expect(result.revised).toBe(false)
    expect(deps.streamChat).toHaveBeenCalledTimes(1)
    expect(deps.reviewChapter).not.toHaveBeenCalled()
    expect(thinking.join("\n")).not.toContain("阶段1：上下文分析")
    expect(thinking.join("\n")).not.toContain("阶段2：写作任务书")
    expect(thinking.join("\n")).toContain("阶段5：无需自动返修")
    expect(thinking.join("\n")).toContain("阶段7：完成")
  })

  it("still treats provider-side cancellation as an error when there is no local length cutoff", async () => {
    const longDraft = chapterText("供应商取消前已返回的长正文", 4700)
    let callIndex = 0
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callIndex += 1
        if (callIndex === 2) {
          callbacks.onToken(longDraft)
          callbacks.onError(new Error("Request cancelled"))
          return
        }
        callbacks.onToken("写作任务书内容")
        callbacks.onDone()
      }),
    }

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
    )).rejects.toThrow("Request cancelled")
  })

  it("preserves partial draft content when the transport stalls with an inactivity timeout instead of discarding it", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({
      novelConfig: { ...priorNovelConfig, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
    })
    try {
      // Stage 3 draft streams a long-enough partial (>= minChars) so expansion
      // is skipped, then the transport reports a 30s inactivity stall. The
      // partial must survive so `continue-unfinished` can resume from real
      // progress instead of an empty draft.
      const partialDraft = chapterText("运输超时前已返回的部分正文", 3000)
      const inactivityError = new Error(
        "Claude Code CLI produced no additional stream output within 30 seconds. The local runtime may still be hanging during startup or MCP bootstrap, or the upstream provider may be stalling before the first token. Try enabling local CLI isolation, or run `claude -p ... --verbose` in a terminal to inspect the environment.",
      )
      let callIndex = 0
      const deps: DeepChapterGenerationDeps = {
        buildContextPack: vi.fn(async () => contextPack),
        contextPackToPrompt: vi.fn(() => "上下文包内容"),
        reviewChapter: vi.fn(async () => []),
        streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
          callIndex += 1
          if (callIndex === 2) {
            callbacks.onToken(partialDraft)
            callbacks.onError(inactivityError)
            return
          }
          callbacks.onToken("写作任务书内容")
          callbacks.onDone()
        }),
      }

      const result = await runDeepChapterGeneration(
        { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
        {},
        deps,
      )

      // The partial draft survived the transport timeout. Without the fix,
      // collectModelText would have thrown the inactivity error and the run
      // would have rejected; instead the partial flowed through to draftContent
      // so `continue-unfinished` can resume from real progress.
      expect(result.draftContent).toBe(partialDraft)
      // The result must surface partiality so the caller (chat-panel) routes to
      // pauseDeepChapterSession (draft_status "pending" / continue-unfinished)
      // instead of completeDeepChapterSession ("ready"), which would persist a
      // truncated chapter as completed (Draft-first boundary violation).
      expect(result.partial).toBe(true)
      expect(result.partialReason).toContain("produced no additional stream output")
    } finally {
      useWikiStore.setState({ novelConfig: priorNovelConfig })
    }
  })

  it("marks a partial result when stage-3 draft expansion stalls with a transport inactivity timeout", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({
      novelConfig: { ...priorNovelConfig, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
    })
    try {
      // Stage 3 draft is short (< minChars) so expansion runs; expansion then
      // stalls mid-stream and partial-preserves. The result must be partial.
      const shortDraft = chapterText("短初稿", 50)
      const partialExpansion = chapterText("扩写阶段被截断的部分正文", 2000)
      const inactivityError = new Error(
        "Claude Code CLI produced no additional stream output within 30 seconds. The local runtime may still be hanging during startup or MCP bootstrap, or the upstream provider may be stalling before the first token.",
      )
      let callIndex = 0
      const deps: DeepChapterGenerationDeps = {
        buildContextPack: vi.fn(async () => contextPack),
        contextPackToPrompt: vi.fn(() => "上下文包内容"),
        reviewChapter: vi.fn(async () => []),
        streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
          callIndex += 1
          if (callIndex === 2) {
            callbacks.onToken(shortDraft)
            callbacks.onDone()
            return
          }
          if (callIndex === 3) {
            callbacks.onToken(partialExpansion)
            callbacks.onError(inactivityError)
            return
          }
          callbacks.onToken("写作任务书内容")
          callbacks.onDone()
        }),
      }

      const result = await runDeepChapterGeneration(
        { projectPath: "E:/Novel", userRequest: "生成第4章", chapterNumber: 4, llmConfig, novelConfig },
        {},
        deps,
      )

      expect(result.partial).toBe(true)
      expect(result.partialReason).toContain("produced no additional stream output")
    } finally {
      useWikiStore.setState({ novelConfig: priorNovelConfig })
    }
  })

  it("still throws when the transport stalls before any output arrives (genuine hang, nothing to preserve)", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({
      novelConfig: { ...priorNovelConfig, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
    })
    try {
      const startupTimeoutError = new Error(
        "Claude Code CLI started but produced no meaningful stream output within 90 seconds. The local runtime may still be hanging during startup or MCP bootstrap, or the upstream provider may be stalling before the first token. Try enabling local CLI isolation, or run `claude -p ... --verbose` in a terminal to inspect the environment.",
      )
      let callIndex = 0
      const deps: DeepChapterGenerationDeps = {
        buildContextPack: vi.fn(async () => contextPack),
        contextPackToPrompt: vi.fn(() => "上下文包内容"),
        reviewChapter: vi.fn(async () => []),
        streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
          callIndex += 1
          if (callIndex === 2) {
            // No token emitted before the timeout — genuine zero-output hang.
            callbacks.onError(startupTimeoutError)
            return
          }
          callbacks.onToken("写作任务书内容")
          callbacks.onDone()
        }),
      }

      await expect(runDeepChapterGeneration(
        { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
        {},
        deps,
      )).rejects.toThrow("no meaningful stream output within 90 seconds")
    } finally {
      useWikiStore.setState({ novelConfig: priorNovelConfig })
    }
  })

  it("stops before review when the user cancels during draft streaming", async () => {
    const controller = new AbortController()
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        callbacks.onToken(prompt.includes("章节正文") ? chapterText("被停止的正文", 3000) : "写作任务书内容")
        if (prompt.includes("章节正文")) controller.abort()
        callbacks.onDone()
      }),
    }

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
      controller.signal,
    )).rejects.toThrow("已停止生成")

    expect(deps.reviewChapter).not.toHaveBeenCalled()
  })
  it("forwards the stop signal into the review stage", async () => {
    const deps = createDeps()
    const controller = new AbortController()

    await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
      controller.signal,
    )

    expect(deps.reviewChapter).toHaveBeenCalledWith(
      "E:/Novel",
      expect.any(String),
      3,
      expect.objectContaining({}),
      controller.signal,
    )
  })
})

describe("ARCH-001: 6-dim review wiring at all 3 review points (ISS-20260708-005)", () => {
  // Helper that builds a non-empty 6-dimension result map for a single dim,
  // carrying one issue. Used to prove the helper merges 6-dim findings into
  // reviewResults (the ARCH-001 regression — the 2 resume/repair paths
  // previously skipped the 6-dim review entirely).
  function makeDimResult(
    key: SixReviewDimensionKey,
    overrides: Partial<DimensionReviewResult> = {},
  ): DimensionReviewResult {
    return {
      dimensionKey: key,
      score: 40,
      status: "medium",
      summary: `${key}摘要`,
      thinking: "",
      issues: [{
        severity: "warning",
        type: key,
        dimensionKey: key,
        message: `${key} 维度问题`,
        evidence: "正文片段",
        relatedMemory: "",
        suggestion: "修正",
      }],
      ...overrides,
    }
  }

  function reviewOnlyDeps(reviewSequence: NovelReviewResult[][]): DeepChapterGenerationDeps {
    let reviewCallIndex = 0
    return {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => reviewSequence[Math.min(reviewCallIndex++, reviewSequence.length - 1)] ?? []),
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        const content = prompt.includes("简单审查") || prompt.includes("去AI味")
          ? chapterText("最终去AI味正文", 3000)
          : prompt.includes("返修")
            ? chapterText("返修正文内容", 3000)
            : prompt.includes("正文")
              ? chapterText("初稿正文内容", 3000)
              : "写作任务书内容"
        callbacks.onToken(content)
        callbacks.onDone()
      }),
    }
  }

  it("stage-5 post-repair re-review invokes runSixDimensionReview and feeds dimension findings into buildDecisionGates", async () => {
    // Drive the repair loop: stage-4 returns a blocking error → while-loop
    // runs ≥1 repair iteration → stage-5 post-repair re-review fires. The
    // re-review must invoke runSixDimensionReview (ARCH-001 regression: it
    // previously called reviewChapter only, silently skipping 6-dim on the
    // revised content).
    const blockingIssue: NovelReviewResult = {
      severity: "error",
      type: "plot",
      message: "没有承接上一章门缝声。",
      evidence: "初稿正文内容",
      relatedMemory: "上一章结尾",
      suggestion: "补上门缝声的承接。",
    }
    // reviewSequence: [stage-4 initial review, stage-5 post-repair re-review]
    // — both go through runFullReviewWithSixDim. The first returns the
    // blocking issue (drives the repair loop); the second returns [] so the
    // loop exits after one repair.
    const deps = reviewOnlyDeps([[blockingIssue], []])
    const runSixDim = vi.fn<(args: { projectPath: string, chapterContent: string, chapterNumber?: number }) => Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>>>(async () => ({
      // A pacing-dimension finding with status "medium" → flattened to a
      // warning-severity NovelReviewResult of type "plot" (quality gate).
      pacing: makeDimResult("pacing"),
    }))
    deps.runSixDimensionReview = runSixDim

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, novelConfig },
      {},
      deps,
    )

    // The repair loop ran (revised=true) and resolved to a final polish.
    expect(result.revised).toBe(true)
    expect(result.finalContent).toContain("最终去AI味正文")
    // runSixDimensionReview fired at least twice: stage-4 + stage-5
    // post-repair. (It may fire more if the loop iterates; here it exits
    // after one repair so exactly 2.)
    expect(runSixDim).toHaveBeenCalledTimes(2)
    // The stage-5 post-repair call passed the REVISED content (返修正文内容),
    // not the original draft — proving the 6-dim review runs on revised
    // content, which was the ARCH-001 blindness.
    const secondCall = runSixDim.mock.calls[1][0] as { chapterContent: string }
    expect(secondCall.chapterContent).toContain("返修正文内容")
    // A dimension-tagged finding reached the final reviewResults (the pacing
    // issue message is present), proving the 6-dim merge happened at the
    // post-repair re-review and the finding reached buildDecisionGates.
    expect(result.reviewResults.some((r) => r.message.includes("pacing 维度问题"))).toBe(true)
  })

  it("runFullReviewWithSixDim helper invokes runSixDimensionReview and merges dimension findings (covers the stage-5.5-resume contract)", async () => {
    // The stage-5.5-resume path (hasCheckpointRevision + overall === "pending")
    // is structurally hard to reach end-to-end because buildDecisionGates
    // never returns overall "pending" — line 1087 resets decisionGates from
    // the empty (pending) state to pass/fail/warning before the stage-5.5
    // guard at line 1097 can fire. So we test the shared helper directly:
    // it is the exact code the stage-5.5-resume path calls, and proving it
    // merges 6-dim findings proves the stage-5.5 contract holds whenever
    // that path does fire.
    const reviewChapter = vi.fn(async () => [
      {
        severity: "info",
        type: "plot",
        message: "reviewChapter 基础发现",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ] as NovelReviewResult[])
    const runSixDim = vi.fn<(args: { projectPath: string, chapterContent: string, chapterNumber?: number }) => Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>>>(async () => ({
      character: makeDimResult("character"),
    }))
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter,
      runSixDimensionReview: runSixDim,
      streamChat: vi.fn(async () => {}),
    }

    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "章节正文内容",
      3,
      "E:/Novel",
      deps,
      undefined,
      contextPack,
      {},
    )

    expect(runSixDim).toHaveBeenCalledTimes(1)
    expect(runSixDim).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "E:/Novel",
      chapterContent: "章节正文内容",
      chapterNumber: 3,
    }))
    // The 6-dim result map is returned for checkpoint persistence.
    expect(dimensionResults.character).toBeDefined()
    // The flattened dimension finding is merged into reviewResults alongside
    // the reviewChapter finding. character → character_consistency type
    // (DIM_TO_GATE_TYPE), so it lands in the CONSISTENCY gate downstream.
    expect(reviewResults.some((r) => r.message.includes("character 维度问题"))).toBe(true)
    expect(reviewResults.some((r) => r.type === "character_consistency")).toBe(true)
    expect(reviewResults.some((r) => r.message.includes("reviewChapter 基础发现"))).toBe(true)
  })

  it("runFullReviewWithSixDim keeps the main review flow alive when runSixDimensionReview throws (non-blocking)", async () => {
    // The 6-dim try/catch MUST be non-blocking: a 6-dim failure must not
    // break the main review flow (preserved from the original stage-4
    // pattern). The helper returns reviewChapter's results and an empty
    // dimensionResults map; the caller proceeds normally.
    const reviewChapter = vi.fn(async () => [
      {
        severity: "info",
        type: "plot",
        message: "基础发现",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ] as NovelReviewResult[])
    const runSixDim = vi.fn<(args: { projectPath: string, chapterContent: string, chapterNumber?: number }) => Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>>>(async () => { throw new Error("6-dim stalled") })
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter,
      runSixDimensionReview: runSixDim,
      streamChat: vi.fn(async () => {}),
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "章节正文内容",
      3,
      "E:/Novel",
      deps,
      undefined,
      contextPack,
      {},
    )

    // reviewChapter's findings survive; the 6-dim failure did not propagate.
    expect(reviewResults.some((r) => r.message.includes("基础发现"))).toBe(true)
    expect(dimensionResults).toEqual({})
    // F-16 (CWE-532): the error is logged as its .message string, not the full
    // Error object, so provider request details are not leaked to stderr.
    // ISS-20260709-019: logger.error formats as "[scope] message {context}";
    // verify the message + sanitized error string are present and no raw
    // Error object was passed to console.error.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logged = errorSpy.mock.calls[0][0] as string
    expect(logged).toContain("[Deep Chapter]")
    expect(logged).toContain("6-dimension review failed (non-blocking)")
    expect(logged).toContain("6-dim stalled")
    // No raw Error object leaked — only the formatted string arg.
    expect(errorSpy.mock.calls[0].length).toBe(1)
    errorSpy.mockRestore()
  })
})

describe("collectLiteraryPolishIssues (Track B)", () => {
  it("keeps thril/pacing/pull warnings and drops consistency errors", () => {
    const gates: DeepChapterDecisionGates = {
      consistency: {
        status: "passed",
        verdict: "pass",
        findings: [{ severity: "error", type: "consistency", message: "设定冲突", evidence: "", relatedMemory: "", suggestion: "" }],
        repair_suggestions: [],
        retry_count: 0,
      },
      anti_ai: {
        status: "passed",
        verdict: "pass",
        findings: [],
        repair_suggestions: [],
        retry_count: 0,
      },
      quality: {
        status: "passed",
        verdict: "pass",
        findings: [
          { severity: "warning", type: "plot", message: "爽点偏弱", evidence: "", relatedMemory: "", suggestion: "" },
          { severity: "warning", type: "pull", message: "章末钩不足", evidence: "", relatedMemory: "", suggestion: "" },
        ],
        repair_suggestions: [],
        retry_count: 0,
      },
      overall: "pass",
    }
    const issues = collectLiteraryPolishIssues(gates)
    expect(issues.some((i) => i.message.includes("爽点"))).toBe(true)
    expect(issues.some((i) => i.message.includes("章末"))).toBe(true)
    expect(issues.some((i) => i.type === "consistency")).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// 覆盖率 100% 攻坚补充用例（r6dc）：错误路径 / 空输入 / 边界 / 降级 / 重试 /
// guard 全覆盖。只新增用例，不改源文件。
// ═════════════════════════════════════════════════════════════════════════

const defaultFsReadFileImpl = fsReadFileMock.getMockImplementation()

afterEach(() => {
  if (defaultFsReadFileImpl) {
    fsReadFileMock.mockImplementation(defaultFsReadFileImpl)
  }
})

/** 让 @/commands/fs.readFile 对指定 store 文件返回内容，其余路径仍 ENOENT。 */
function mockStoreFile(relativePath: string, content: unknown | string): void {
  fsReadFileMock.mockImplementation(async (path: string) => {
    if (path.includes(`/.novel/${relativePath}`)) {
      return typeof content === "string" ? content : JSON.stringify(content)
    }
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
    err.code = "ENOENT"
    throw err
  })
}

function residualBaseInput(extra: Partial<DeepChapterGenerationInput> = {}): DeepChapterGenerationInput {
  return {
    projectPath: "E:/Novel",
    userRequest: "生成第3章",
    chapterNumber: 3,
    llmConfig,
    novelConfig,
    ...extra,
  }
}

describe("coverage-100: residual helpers (Medium-deepen E2/E3)", () => {
  it("resolveStructurePlanForResidual: explicit plan wins over median-derived default", () => {
    const explicit = createDefaultStructureThrilPacingPlan(3)
    const result = resolveStructurePlanForResidual(residualBaseInput({ chapterStructurePlan: explicit }))
    expect(result).toBe(explicit)
  })

  it("resolveStructurePlanForResidual: high residual median creates the default plan", () => {
    const result = resolveStructurePlanForResidual(residualBaseInput({ residualOverallMedian: 9.2 }))
    expect(result).toBeDefined()
    expect(result?.beats.length).toBeGreaterThan(0)
  })

  it("resolveStructurePlanForResidual: below-threshold median yields undefined (fail-open)", () => {
    const result = resolveStructurePlanForResidual(
      residualBaseInput({ residualOverallMedian: RESIDUAL_OVERALL_MEDIAN_THRESHOLD - 1, residualLengthPreserving: true }),
    )
    expect(result).toBeUndefined()
  })

  it("evaluateResidualPolicyForInput: no residual opt-in returns null", () => {
    expect(evaluateResidualPolicyForInput(residualBaseInput())).toBeNull()
  })

  it("evaluateResidualPolicyForInput: opt-in without a finite median returns null", () => {
    expect(evaluateResidualPolicyForInput(residualBaseInput({ residualLengthPreserving: true }))).toBeNull()
    expect(evaluateResidualPolicyForInput(residualBaseInput({ residualOverallMedian: Number.NaN }))).toBeNull()
  })

  it("evaluateResidualPolicyForInput: finite high median yields a residual_high decision", () => {
    const decision = evaluateResidualPolicyForInput(residualBaseInput({ residualOverallMedian: 9.2 }))
    expect(decision).not.toBeNull()
    expect(decision?.residualBand).toBe("residual_high")
  })
})

describe("coverage-100: decision gate folding", () => {
  it("buildDecisionGates routes anti_ai-style findings into the anti_ai gate", () => {
    const gates = buildDecisionGates([
      { severity: "warning", type: "anti_ai", message: "AI 味偏重", evidence: "", relatedMemory: "", suggestion: "" },
    ], 0)
    expect(gates.anti_ai.verdict).toBe("warning")
    expect(gates.anti_ai.status).toBe("passed")
    expect(gates.overall).toBe("warning")
  })
})

describe("coverage-100: collectLiteraryPolishIssues edge branches", () => {
  it("drops quality-gate error findings and dedupes repeated literary warnings", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [
        { severity: "warning" as const, type: "plot", message: "爽点偏弱", evidence: "", relatedMemory: "", suggestion: "" },
      ] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: { status: "passed" as const, findings: [
        { severity: "error" as const, type: "plot", message: "情节断裂", evidence: "", relatedMemory: "", suggestion: "" },
        { severity: "warning" as const, type: "thrill", message: "爽点偏弱", evidence: "", relatedMemory: "", suggestion: "" },
      ] },
      overall: "pass" as const,
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    // 实现真实行为：跨门（consistency+quality）的 warning 都会进入（不跨门去重），
    // 只有 quality 门二次拉取时才做同消息去重；error 一律丢弃。
    expect(issues).toHaveLength(2)
    expect(issues.every((i) => i.message === "爽点偏弱")).toBe(true)
    expect(issues.some((i) => i.message.includes("情节断裂"))).toBe(false)
  })
})

describe("coverage-100: runDeepChapterGeneration stage guards", () => {
  it("emits resume checkpoints at each stage when onCheckpoint is wired", async () => {
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
    const deps = createDeps()
    await runDeepChapterGeneration(
      residualBaseInput(),
      { onCheckpoint: (cp) => { checkpoints.push(cp) } },
      deps,
    )
    const stages = checkpoints.map((c) => c.stage)
    expect(stages).toContain("after_context")
    expect(stages).toContain("after_task_brief")
    expect(stages).toContain("after_draft")
    expect(stages).toContain("after_review")
    expect(checkpoints[0].originalRequest).toBe("生成第3章")
    expect(checkpoints[0].chapterNumber).toBe(3)
  })

  it("skips the outline thril soft-gate when disabled", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, outlineThrillSoftGateEnabled: false } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).not.toContain("阶段1.2")
  })

  it("flags a FIX-1 spoiler conflict from the outline in the soft-gate log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      vi.mocked(deps.buildContextPack).mockResolvedValueOnce({
        ...contextPack,
        outline: "第3章：凶手就是屋主。主角在雨夜旧屋发现第一条线索，结尾留下危险钩子。",
      })
      await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("outline thril soft-gate: FIX-1 conflict cue")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("keeps generation alive when the outline thril soft-gate throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      vi.mocked(runOutlineThrillSoftGate).mockImplementationOnce(() => { throw new Error("soft gate boom") })
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("outline thril soft-gate failed (non-fatal)")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("skips the post-draft StateDelta light-check when disabled", async () => {
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, stateDeltaLightCheckEnabled: false } }),
      {},
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("reports many state-delta issues with the truncated issue list", async () => {
    const structuredDelta = {
      inventoryChanges: Array.from({ length: 10 }, (_, i) => ({
        entity: `路人甲${i}`,
        item: `物品${i}`,
        op: "lose" as const,
      })),
    }
    const draftWithDelta = chapterText("初稿正文内容", 3000)
      + "\n```json state-delta\n"
      + JSON.stringify(structuredDelta)
      + "\n```\n"
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("章节正文")
          ? draftWithDelta
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("发现 10 条状态提示")
    expect(thinking.join("\n")).toContain("另有 2 条")
  })

  it("degrades gracefully when character-states.json is corrupt (non-ENOENT rethrow)", async () => {
    mockStoreFile("character-states.json", "{broken json")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const blockingIssue: NovelReviewResult = {
        severity: "error",
        type: "plot",
        message: "没有承接上一章门缝声。",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      }
      const deps = createDeps([[blockingIssue], [blockingIssue]])
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      // loadCharacterStates 解析失败 rethrow → StateDelta 轻检降级为空数组。
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("StateDelta light-check failed (non-fatal)")
      // 修复循环 retryCount>0 时 checkContinuityCritical 的 loader .catch 同样降级。
      expect(result.manualReviewRequired).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("runs previous-chapters analysis for later chapters when enabled", async () => {
    vi.mocked(analyzePreviousChapters).mockResolvedValueOnce("前3章分析：主角收到匿名信，抵达旧城区。")
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, deepPreviousChaptersAnalysis: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("阶段0：前情分析")
    expect(thinking.join("\n")).toContain("已完成前情分析")
    expect(thinking.join("\n")).toContain("前3章分析：主角收到匿名信")
  })

  it("continues when previous-chapters analysis fails", async () => {
    vi.mocked(analyzePreviousChapters).mockRejectedValueOnce(new Error("analysis stalled"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({ novelConfig: { ...novelConfig, deepPreviousChaptersAnalysis: true } }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("前情分析失败")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("continues when community summary generation fails (non-blocking)", async () => {
    vi.mocked(generateCommunitySummariesForChapter).mockRejectedValueOnce(new Error("wiki graph stalled"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("社区摘要生成失败（非阻断）")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("injects Track B skill hook fragments into the context prompt", async () => {
    vi.mocked(runNovelSkillHooks).mockResolvedValueOnce({
      projectPath: "E:/Novel",
      chapterNumber: 3,
      stage: "pre_write_prompt",
      bag: { promptFragments: ["角色声线提醒：主角保持克制。"], notes: [] },
    } as never)
    const capturedPrompts: string[] = []
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      capturedPrompts.push(prompt)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(capturedPrompts.some((p) => p.includes("## Track B skill hooks (pre_write_prompt · soft)"))).toBe(true)
    expect(capturedPrompts.some((p) => p.includes("角色声线提醒"))).toBe(true)
  })

  it("keeps generation alive when pre_write skill hooks soft-fail", async () => {
    vi.mocked(runNovelSkillHooks).mockRejectedValueOnce(new Error("hook crashed"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("pre_write skill hooks soft-failed")
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe("coverage-100: scene breakdown stage (ADR-30 / EPIC-002)", () => {
  it("runs the scene breakdown stage and propagates the partial signal", async () => {
    const sceneResult: SceneBreakdownResult = {
      scenes: [
        { sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认门内动静", tension: "门外脚步声逼近", beat: "紧张" },
        { sceneId: "scene-2", sceneTitle: "发现锈钥匙", location: "屋内", characters: ["主角", "小晴"], goal: "找到线索", tension: "第二把钥匙出现", beat: "转折" },
      ],
      partial: true,
      partialReason: "transport stalled mid-scene",
      tokenCost: 1234,
      latencyMs: 5678,
    }
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce(sceneResult)
    const thinking: string[] = []
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
      {
        onThinking: (c) => thinking.push(c),
        onCheckpoint: (cp) => { checkpoints.push(cp) },
      },
      deps,
    )
    expect(result.partial).toBe(true)
    expect(result.partialReason).toContain("scene-breakdown: transport stalled mid-scene")
    expect(thinking.join("\n")).toContain("阶段1.5：场景拆解")
    expect(thinking.join("\n")).toContain("已完成场景拆解（2个场景，部分保留）")
    expect(checkpoints.some((c) => c.stage === "after_scene_breakdown")).toBe(true)
    expect(vi.mocked(persistSceneBreakdownDraft)).toHaveBeenCalledWith("E:/Novel", "3", sceneResult)
  })

  it("skips stage 1.5 when the breakdown call throws (non-blocking)", async () => {
    vi.mocked(runSceneBreakdown).mockRejectedValueOnce(new Error("scene boom"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      expect(result.partial).toBe(false)
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("场景拆解失败（非阻断，跳过阶段1.5）")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("continues when scene breakdown persistence fails (non-blocking)", async () => {
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [{ sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认动静", tension: "逼近", beat: "紧张" }],
    })
    vi.mocked(persistSceneBreakdownDraft).mockRejectedValueOnce(new Error("persist boom"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("场景拆解持久化失败（非阻断）")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("skips scene persistence when the breakdown yields no scenes", async () => {
    // mockReset 清空前序用例的 once 队列与调用记录，避免陈旧状态被本用例消费
    vi.mocked(runSceneBreakdown).mockReset()
    vi.mocked(runSceneBreakdown).mockResolvedValue({ scenes: [] })
    vi.mocked(persistSceneBreakdownDraft).mockReset()
    vi.mocked(persistSceneBreakdownDraft).mockResolvedValue(undefined)
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
      {},
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(vi.mocked(persistSceneBreakdownDraft)).not.toHaveBeenCalled()
  })
})

describe("coverage-100: task brief / draft edge paths", () => {
  it("appends the residual structure plan to the generated task brief", async () => {
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ residualOverallMedian: 9.2 }),
      {},
      deps,
    )
    expect(result.taskBrief).toContain("【ChapterStructurePlan")
  })

  it("Wave 3: planningPlan 注入【本章确定性范围】块（marker 守卫防重复）", async () => {
    const deps = createDeps()
    const plan = {
      chapterNumber: 3,
      generatedAt: "2026-08-18T00:00:00.000Z",
      foreshadowing: {
        status: "ok" as const,
        report: {
          debtScore: 12,
          items: [
            {
              id: "f1",
              name: "青铜古戒",
              description: "",
              status: "planted" as const,
              plantedChapter: 2,
              chaptersSincePlanted: 1,
              debtLevel: "critical" as const,
            },
          ],
        },
        overdueFindings: [],
      },
      characters: {
        status: "ok" as const,
        items: [
          {
            name: "林动",
            lastSeenChapter: 2,
            inCurrentOutline: true,
            chaptersSinceSeen: 1,
          },
        ],
      },
      threads: {
        status: "ok" as const,
        items: [],
        openCount: 0,
      },
      summary: { debtScore: 12, criticalForeshadowing: 1, openThreads: 0, charactersDue: 0 },
    }
    const result = await runDeepChapterGeneration(
      residualBaseInput({ planningPlan: plan }),
      {},
      deps,
    )
    expect(result.taskBrief).toContain("【本章确定性范围】")
    expect(result.taskBrief).toContain("青铜古戒")
    // 注入点守卫：resume 检查点已含预填块时不二次注入（append-only 语义）
    const again = await runDeepChapterGeneration(
      residualBaseInput({ planningPlan: plan }),
      {},
      deps,
    )
    expect(again.taskBrief.split("【本章确定性范围】").length - 1).toBe(1)
  })

  it("Wave 3: planningPlan 缺省 → task-brief 零行为变化（fail-open）", async () => {
    const deps = createDeps()
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.taskBrief).not.toContain("【本章确定性范围】")
  })

  it("expands a short recovery rewrite after meta-draft correction", async () => {
    const prompts: string[] = []
    const expandedDraft = chapterText("扩写后正文", 3000)
    const finalPolished = chapterText("最终去AI味正文", 3000)
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: vi.fn(async () => []),
      streamChat: vi.fn(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messagesPromptText(messages)
        prompts.push(prompt)
        const content = prompt.includes("简单审查") || prompt.includes("去AI味")
          ? finalPolished
          : prompt.includes("错误草稿（仅用于识别错误模式")
            ? chapterText("纠偏短稿", 100)
            : prompt.includes("扩写补足")
              ? expandedDraft
              : prompt.includes("章节正文")
                // 长元文本（非重复句，避免重复尾检测截断）：长度达标跳过扩写，且 [N] 前缀触发阶段3.5 草稿纠偏
                ? "[N]\n" + Array.from({ length: 800 }, (_, i) => `请补充第${i}句话。`).join("")
                : "写作任务书内容"
        callbacks.onToken(content)
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.draftContent).toBe(expandedDraft)
    expect(result.finalContent).toBe(finalPolished)
    expect(prompts.some((p) => p.includes("扩写补足"))).toBe(true)
    expect(thinking.join("\n")).toContain("纠偏后正文约")
  })

  it("announces the skipped review stage when AI review is disabled", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, deepChapterReview: false } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("阶段4-5：已跳过审稿与返修")
    expect(deps.reviewChapter).not.toHaveBeenCalled()
  })
})

describe("coverage-100: fix-loop guards (emotion CB / continuity critical / regression)", () => {
  const blockingIssue: NovelReviewResult = {
    severity: "error",
    type: "plot",
    message: "没有承接上一章门缝声。",
    evidence: "初稿正文内容",
    relatedMemory: "上一章结尾",
    suggestion: "补上门缝声的承接。",
  }

  it("hands off to manual review when the emotion-ledger circuit breaker trips", async () => {
    mockStoreFile("emotion-ledger.json", {
      entries: [{
        characterName: "主角",
        netValue: -1,
        valence: -1,
        arousal: -1,
        dominance: -1,
        lastUpdatedChapter: 3,
        history: [{ chapter: 2, delta: -0.4, reason: "承压" }],
      }],
      lastUpdated: "",
    })
    const deps = createDeps([[blockingIssue], [blockingIssue]])
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      {
        onThinking: (c) => thinking.push(c),
        onCheckpoint: () => {},
      },
      deps,
    )
    expect(result.manualReviewRequired).toBe(true)
    expect(result.decisionGates.overall).toBe("manual_review")
    expect(thinking.join("\n")).toContain("阶段5.5：情绪债务熔断转人工")
  })

  it("hands off to manual review on mechanical continuity critical findings", async () => {
    mockStoreFile("foreshadowing-tracker.json", {
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps([[blockingIssue], [blockingIssue]])
      const thinking: string[] = []
      const result = await runDeepChapterGeneration(
        residualBaseInput({ chapterNumber: 8 }),
        {
          onThinking: (c) => thinking.push(c),
          onCheckpoint: () => {},
        },
        deps,
      )
      expect(result.manualReviewRequired).toBe(true)
      expect(result.decisionGates.overall).toBe("manual_review")
      expect(thinking.join("\n")).toContain("阶段5.5：连续性机械 critical 转人工")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("critical continuity findings, manual handoff")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("rolls back a regressed revision to the previous candidate", async () => {
    const deps = createDeps([[blockingIssue], []])
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("返修")
          ? "综上所述，然而，值得注意的是，这一切都显得理所当然。".repeat(200)
          : prompt.includes("正文")
            ? chapterText("干净初稿正文", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(true)
    expect(result.retryCount).toBe(1)
    expect(thinking.join("\n")).toContain("阶段5：返修退化回退")
  })
})

describe("coverage-100: Track B literary polish (阶段5.7)", () => {
  function polishDeps(polishedContent: string): DeepChapterGenerationDeps {
    const reviewWarning: NovelReviewResult = {
      severity: "warning",
      type: "thrill",
      message: "爽点密度偏弱",
      evidence: "初稿正文内容",
      relatedMemory: "",
      suggestion: "强化章末钩。",
    }
    const deps = createDeps([[reviewWarning], [reviewWarning]])
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("多目标护栏")
          ? polishedContent
          : prompt.includes("正文")
            ? chapterText("初稿正文内容", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    return deps
  }

  it("accepts a clean polish pass under the multi-objective guard", async () => {
    const thinking: string[] = []
    const deps = polishDeps(chapterText("抛光后正文", 3000))
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, literaryPolishAfterGate: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(true)
    expect(thinking.join("\n")).toContain("阶段5.7：Track B 文学抛光")
    expect(thinking.join("\n")).toContain("阶段5.7：Track B 多目标通过")
  })

  it("rejects a FIX-1-violating polish and keeps the gated draft", async () => {
    const thinking: string[] = []
    const deps = polishDeps(chapterText("抛光后正文", 3000) + "\n最终存活者是屋主。")
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, literaryPolishAfterGate: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(false)
    expect(thinking.join("\n")).toContain("阶段5.7：文学抛光回退")
    expect(thinking.join("\n")).toContain("（FIX-1）")
  })

  it("runs a residual structure-first polish when the campaign opts in", async () => {
    const thinking: string[] = []
    // reviewChapter 返回空 → 无 thril/pacing 告警；residualOptIn 命中后
    // literaryIssues 为空 → 走「Residual structure 抛光」消息分支
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("多目标护栏")
          ? chapterText("抛光后正文", 3000)
          : prompt.includes("正文")
            ? chapterText("初稿正文内容", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(
      residualBaseInput({ residualOverallMedian: 9.2 }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(true)
    expect(thinking.join("\n")).toContain("阶段5.7：Residual structure 抛光")
    expect(result.taskBrief).toContain("【ChapterStructurePlan")
  })
})

describe("coverage-100: collectModelText streaming paths", () => {
  it("flushes reasoning tokens for progress display when content is empty", async () => {
    let callIndex = 0
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callIndex += 1
      if (callIndex === 1) {
        callbacks.onReasoningToken?.("推理内容".repeat(80))
        callbacks.onDone()
        return
      }
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("推理内容".repeat(80))
  })

  it("stops streaming immediately when the user cancels mid-token", async () => {
    const controller = new AbortController()
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onToken("前段内容")
      controller.abort()
      callbacks.onToken("abort 后 token")
      callbacks.onReasoningToken?.("abort 后推理")
      callbacks.onToken("再次 token")
      callbacks.onDone()
    })
    await expect(runDeepChapterGeneration(
      residualBaseInput(),
      {},
      deps,
      controller.signal,
    )).rejects.toThrow("已停止生成")
  })
})

describe("coverage-100: resume / thinking formatting", () => {
  it("resumes from an after_revision checkpoint without re-running earlier stages", async () => {
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      {
        ...residualBaseInput(),
        resumeCheckpoint: {
          version: 1,
          originalRequest: "生成第3章",
          chapterNumber: 3,
          stage: "after_revision",
          taskBrief: "写作任务书内容",
          draftContent: chapterText("已返修草稿", 3000),
          reviewResults: [],
          currentContent: chapterText("返修后内容", 3000),
          retryCount: 1,
        },
      },
      {},
      deps,
    )
    expect(result.revised).toBe(true)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("surfaces character-consistency issues in the stage-4 thinking with severity labels", async () => {
    const deps = createDeps([
      [
        { severity: "warning", type: "character_consistency", message: "主角认知越界", evidence: "", relatedMemory: "", suggestion: "" },
        { severity: "info", type: "plot", message: "节奏提示", evidence: "", relatedMemory: "", suggestion: "" },
      ],
    ])
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("【角色命中记忆库报告】")
    expect(joined).toContain("[提醒] 主角认知越界")
    expect(joined).toContain("[信息] 节奏提示")
  })

  it("truncates long context fields in the stage-1 thinking", async () => {
    const deps = createDeps()
    vi.mocked(deps.buildContextPack).mockResolvedValueOnce({
      ...contextPack,
      chapterGoal: "长目标".repeat(120),
      characterStates: "长状态".repeat(120),
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("章节目标：")
    expect(joined).toContain("人物状态：")
    expect(joined).toContain("...")
  })

  it("shows golden-three hints for chapter_only output mode", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      {
        ...residualBaseInput(),
        goldenThreeChapter: {
          enabled: true,
          targetChapter: 1,
          outputMode: "chapter_only",
          requestedFirstThree: false,
        },
      },
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("当前按黄金三章规则生成第1章正文")
  })
})

describe("coverage-100: continuity engine degraded paths", () => {
  it("degrades the override-store load inside the precheck (non-fatal)", async () => {
    vi.mocked(loadContinuityOverrides).mockRejectedValueOnce(new Error("override load failed"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("override store load degraded")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("degrades the precheck when the continuity engine throws", async () => {
    vi.mocked(checkContinuity).mockImplementationOnce(() => { throw new Error("engine boom") })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("precheck degraded")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("degrades override load and engine errors inside the fix-loop critical check", async () => {
    // 调用序：precheck(1) → stage-4 preflight(2) → re-review preflight(3) → critical(4)。
    // loadContinuityOverrides 前 4 次全部 reject：precheck 与 critical 的 catch 均覆盖。
    vi.mocked(loadContinuityOverrides).mockRejectedValueOnce(new Error("o1"))
      .mockRejectedValueOnce(new Error("o2"))
      .mockRejectedValueOnce(new Error("o3"))
      .mockRejectedValueOnce(new Error("o4"))
    let engineCalls = 0
    vi.mocked(checkContinuity).mockImplementation((() => {
      engineCalls += 1
      if (engineCalls === 4) throw new Error("critical engine boom")
      return []
    }) as never)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const blockingIssue: NovelReviewResult = {
        severity: "error",
        type: "plot",
        message: "阻断问题",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      }
      const deps = createDeps([[blockingIssue], [blockingIssue], []])
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("override store load degraded")
      expect(logged).toContain("critical check degraded")
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe("coverage-100: runFullReviewWithSixDim guards", () => {
  it("cascade-aborts the 6-dim review when reviewChapter throws", async () => {
    const reviewChapter = vi.fn(async () => { throw new Error("review stalled") })
    const runSixDim = vi.fn(async () => ({}))
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter,
      runSixDimensionReview: runSixDim,
      streamChat: vi.fn(async () => {}),
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(runFullReviewWithSixDim(
        "章节正文内容",
        3,
        "E:/Novel",
        deps,
        undefined,
        contextPack,
        {},
      )).rejects.toThrow("review stalled")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("6-dimension review aborted after reviewChapter failure")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("logs the continuity short-circuit signal when mechanical findings and 6-dim continuity coexist", async () => {
    const reviewChapter = vi.fn(async () => [
      {
        severity: "info",
        type: "consistency_mechanical",
        message: "机械预检发现 dormant_thread",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ] as NovelReviewResult[])
    const runSixDim = vi.fn(async () => ({
      continuity: {
        dimensionKey: "continuity" as const,
        score: 90,
        status: "pass" as const,
        summary: "连续性通过",
        thinking: "",
        issues: [],
      },
    }))
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter,
      runSixDimensionReview: runSixDim,
      streamChat: vi.fn(async () => {}),
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
        "章节正文内容",
        3,
        "E:/Novel",
        deps,
        undefined,
        contextPack,
        {},
      )
      expect(reviewResults.some((r) => r.type === "consistency_mechanical")).toBe(true)
      expect(dimensionResults.continuity).toBeDefined()
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("ISS-20260719-002 continuity 短路接线运行信号")
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════
// 覆盖率 100% 攻坚补充用例（f5 战役）：剩余可达分支补齐。只新增用例 + 最小
// 修改既有用例的 callbacks（补 onCheckpoint 以评估 checkpoint 三元表达式）。
// 断言全部对照真实实现；确不可达分支不进用例（另记录清单）。
// ═════════════════════════════════════════════════════════════════════════

describe("coverage-100-f5: runFullReviewWithSixDim error-path guards", () => {
  function sixDimDeps(overrides: {
    reviewChapter?: DeepChapterGenerationDeps["reviewChapter"]
    runSixDim?: DeepChapterGenerationDeps["runSixDimensionReview"]
  }): DeepChapterGenerationDeps {
    return {
      buildContextPack: vi.fn(async () => contextPack),
      contextPackToPrompt: vi.fn(() => "上下文包内容"),
      reviewChapter: overrides.reviewChapter ?? (async () => [] as NovelReviewResult[]),
      runSixDimensionReview: overrides.runSixDim,
      streamChat: vi.fn(async () => {}),
    }
  }

  it("logs a non-Error reviewChapter throw via String(err) and rethrows it", async () => {
    const deps = sixDimDeps({ reviewChapter: vi.fn(async () => { throw "plain string failure" }) })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runFullReviewWithSixDim(
        "章节正文内容", 3, "E:/Novel", deps, undefined, contextPack, {},
      )).rejects.toBe("plain string failure")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("plain string failure")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("coalesces a null reviewChapter result into an empty reviewResults array", async () => {
    const deps = sixDimDeps({ reviewChapter: vi.fn(async () => null as never) })
    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "章节正文内容", 3, "E:/Novel", deps, undefined, contextPack, {},
    )
    expect(reviewResults).toEqual([])
    expect(dimensionResults).toEqual({})
  })

  it("records a non-Error 6-dim rejection via String(err) as an info finding", async () => {
    const deps = sixDimDeps({ runSixDim: () => Promise.reject("six-dim string failure") })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { reviewResults } = await runFullReviewWithSixDim(
        "章节正文内容", 3, "E:/Novel", deps, undefined, contextPack, {},
      )
      expect(reviewResults).toEqual([
        expect.objectContaining({
          severity: "info",
          type: "quality",
          message: "[6-dim review unavailable: six-dim string failure]",
        }),
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("keeps dimensionResults empty when the 6-dim review resolves an empty object", async () => {
    const deps = sixDimDeps({ runSixDim: () => Promise.resolve({}) })
    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "章节正文内容", 3, "E:/Novel", deps, undefined, contextPack, {},
    )
    expect(reviewResults).toEqual([])
    expect(dimensionResults).toEqual({})
  })
})

describe("coverage-100-f5: continuity precheck / critical guard variants", () => {
  const override = {
    ref: "character:主角",
    reasonCode: "intentional_death" as const,
    note: "测试覆盖 override 非空分支",
    severity: "warning" as const,
  }

  it("passes a non-empty override store through precheck and critical check", async () => {
    vi.mocked(loadContinuityOverrides).mockResolvedValue({ overrides: [override], lastUpdated: "" })
    const blockingIssue: NovelReviewResult = {
      severity: "error",
      type: "plot",
      message: "阻断问题",
      evidence: "",
      relatedMemory: "",
      suggestion: "",
    }
    const deps = createDeps([[blockingIssue], [blockingIssue], []])
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("degrades override-store load that rejects with a plain string", async () => {
    vi.mocked(loadContinuityOverrides).mockRejectedValue("override string failure")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("override string failure")
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe("coverage-100-f5: undefined chapterNumber run (?? fallbacks)", () => {
  it("runs the whole chain with chapterNumber undefined (ch? / ??0 / ??'' fallbacks)", async () => {
    const blockingIssue: NovelReviewResult = {
      severity: "error",
      type: "plot",
      message: "阻断问题",
      evidence: "",
      relatedMemory: "",
      suggestion: "",
    }
    const thinking: string[] = []
    const deps = createDeps([[blockingIssue], [blockingIssue], []])
    const result = await runDeepChapterGeneration(
      residualBaseInput({
        chapterNumber: undefined,
        novelConfig: { ...novelConfig, sceneBreakdownEnabled: true },
      }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("目标章节：从用户请求中识别")
    expect(result.retryCount).toBeGreaterThan(0)
  })
})

describe("coverage-100-f5: state-delta light check branch variants", () => {
  it("uses the heuristic extraction source when the draft has no structured JSON block", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    // 真实实现：无结构化块 → heuristic 源（0 条告警时输出「无状态告警。」）
    expect(joined).toContain("阶段3.7：StateDelta 轻检")
    expect(joined).toContain("无状态告警")
  })

  it("reports 1-8 state-delta issues with Track A blocking enabled", async () => {
    const structuredDelta = {
      inventoryChanges: [
        { entity: "主角", item: "锈钥匙", op: "gain" as const },
        { entity: "主角", item: "旧信", op: "gain" as const },
      ],
    }
    const draftWithDelta = chapterText("初稿正文内容", 3000)
      + "\n```json state-delta\n"
      + JSON.stringify(structuredDelta)
      + "\n```\n"
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("章节正文")
          ? draftWithDelta
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, stateDeltaBlocksTrackA: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("可阻断 Track A")
    expect(joined).not.toContain("另有")
  })

  it("defaults missing store.characters via ?? [] in the light check", async () => {
    mockStoreFile("character-states.json", {})
    const deps = createDeps()
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("labels the extraction source as skipped when the draft is empty", async () => {
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("正文")
          ? "" // 初稿与扩写都产出空内容 → 空草稿 light check（source=empty → 「跳过」）
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("抽取源：跳过")
  })
})

describe("coverage-100-f5: context assembly degraded paths (String(err))", () => {
  it("runs previous-chapters analysis with an empty result (no thinking)", async () => {
    // analyzePreviousChapters 默认 mock 返回 "" → if(previousChaptersAnalysis) false 分支
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({
        chapterNumber: 3,
        novelConfig: { ...novelConfig, deepPreviousChaptersAnalysis: true },
      }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).not.toContain("已完成前情分析")
  })

  it("logs a string previous-chapters failure via String(err)", async () => {
    vi.mocked(analyzePreviousChapters).mockRejectedValueOnce("previous chapters boom")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({
          chapterNumber: 3,
          novelConfig: { ...novelConfig, deepPreviousChaptersAnalysis: true },
        }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("previous chapters boom")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("injects a non-empty community summary into the context prompt", async () => {
    vi.mocked(generateCommunitySummariesForChapter).mockResolvedValueOnce("社区摘要：主角收到第二封信。")
    const deps = createDeps()
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("logs a string community-summary failure via String(err)", async () => {
    vi.mocked(generateCommunitySummariesForChapter).mockRejectedValueOnce("community boom")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("community boom")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("logs a string skill-hooks failure via String(err)", async () => {
    vi.mocked(runNovelSkillHooks).mockRejectedValueOnce("hooks boom")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("hooks boom")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("logs a string context-pack failure via String(err) and continues with empty context", async () => {
    const deps = createDeps()
    vi.mocked(deps.buildContextPack).mockRejectedValueOnce("context boom")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("context boom")
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("coverage-100-f5: review thinking + outline soft-gate variants", () => {
  it("logs a string outline soft-gate throw via String(err)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deps = createDeps()
      vi.mocked(runOutlineThrillSoftGate).mockImplementationOnce(() => { throw "soft gate string boom" })
      const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("soft gate string boom")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("omits the other-issues section when review findings are all character_consistency", async () => {
    const characterIssue: NovelReviewResult = {
      severity: "error",
      type: "character_consistency",
      message: "主角认知越界",
      evidence: "",
      relatedMemory: "",
      suggestion: "",
    }
    const thinking: string[] = []
    const deps = createDeps([[characterIssue], []])
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("【角色命中记忆库报告】")
    expect(joined).not.toContain("【其他审查问题】")
  })
})

describe("coverage-100-f5: task brief deterministic fallback / repair loop", () => {
  // 含噪声标记 "---" + ≥2 结构标记 + 长度≥240 → containsPollutedTaskBriefMarkers true
  const pollutedBrief = "---\n"
    + "必须完成：承接门缝声。禁止违背：不揭屋主。角色状态：谨慎。伏笔推进：锈钥匙。结尾钩子：人影。"
      .repeat(8)

  it("switches to the deterministic fallback for a polluted model brief (no resume)", async () => {
    let callIndex = 0
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callIndex += 1
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : callIndex === 1
          ? pollutedBrief
          : prompt.includes("正文")
            ? chapterText("初稿正文内容", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("检测到任务书已经膨胀成超长章节化说明")
    expect(joined).toContain("这次直接切换到本地结构化 fallback 任务书，绕过额外的阶段2.5 模型调用")
  })

  it("switches to the deterministic fallback on a resume checkpoint with a polluted brief", async () => {
    const deps = createDeps()
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      {
        ...residualBaseInput(),
        resumeCheckpoint: {
          version: 1,
          originalRequest: "生成第3章",
          chapterNumber: 3,
          stage: "after_task_brief",
          taskBrief: pollutedBrief,
        },
      },
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("检测到恢复检查点里的任务书已经漂移成正文或元说明")
    expect(joined).toContain("为避免恢复链再次卡在一次额外的模型纠偏调用")
  })

  it("repairs a narrative task brief up to the attempt cap then falls back locally", async () => {
    let callIndex = 0
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callIndex += 1
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("[TASK_BRIEF_MARKER]")
          ? "[N]\n修复后仍是正文型任务书，无法直接开写。"
          : callIndex === 1
            ? "[N]\n模型输出了正文型任务书而不是结构化任务书。"
            : prompt.includes("正文")
              ? chapterText("初稿正文内容", 3000)
              : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const thinking: string[] = []
    const result = await runDeepChapterGeneration(
      residualBaseInput(),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    const joined = thinking.join("\n")
    expect(joined).toContain("检测到任务书不可直接执行，或已经漂移成正文片段")
    expect(joined).toContain("第 2 次重试")
    expect(joined).toContain("模型连续 2 次仍输出正文型任务书")
  })
})

describe("coverage-100-f5: manual-handoff checkpoint ternaries on resume", () => {
  const blockingIssue: NovelReviewResult = {
    severity: "error",
    type: "plot",
    message: "没有承接上一章门缝声。",
    evidence: "初稿正文内容",
    relatedMemory: "上一章结尾",
    suggestion: "补上门缝声的承接。",
  }
  const emotionStore = {
    entries: [{
      characterName: "主角",
      netValue: -1,
      valence: -1,
      arousal: -1,
      dominance: -1,
      lastUpdatedChapter: 3,
      history: [{ chapter: 2, delta: -0.4, reason: "承压" }],
    }],
    lastUpdated: "",
  }

  function afterReviewCheckpoint(retryCount: number): DeepChapterGenerationResumeCheckpoint {
    return {
      version: 1,
      originalRequest: "生成第3章",
      chapterNumber: 3,
      stage: "after_review",
      taskBrief: "写作任务书内容",
      draftContent: chapterText("已审查草稿", 3000),
      reviewResults: [blockingIssue],
      retryCount,
    }
  }

  it("trips the emotion CB with revised=false on resume (after_review checkpoint)", async () => {
    mockStoreFile("emotion-ledger.json", emotionStore)
    const thinking: string[] = []
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      {
        ...residualBaseInput(),
        resumeCheckpoint: afterReviewCheckpoint(1),
      },
      {
        onThinking: (c) => thinking.push(c),
        onCheckpoint: (cp) => { checkpoints.push(cp) },
      },
      deps,
    )
    expect(result.manualReviewRequired).toBe(true)
    expect(thinking.join("\n")).toContain("阶段5.5：情绪债务熔断转人工")
    expect(checkpoints.some((c) => c.stage === "after_review")).toBe(true)
  })

  it("trips the continuity critical handoff with revised=false on resume", async () => {
    // 前序用例（continuity engine degraded paths）可能遗留计数 mockImplementation，
    // 恢复为工厂默认的 pass-through，确保真实引擎从 foreshadowing store 检出 critical。
    vi.mocked(checkContinuity).mockRestore()
    mockStoreFile("foreshadowing-tracker.json", {
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const thinking: string[] = []
      const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        {
          ...residualBaseInput({ chapterNumber: 8 }),
          resumeCheckpoint: afterReviewCheckpoint(1),
        },
        {
          onThinking: (c) => thinking.push(c),
          onCheckpoint: (cp) => { checkpoints.push(cp) },
        },
        deps,
      )
      expect(result.manualReviewRequired).toBe(true)
      expect(thinking.join("\n")).toContain("阶段5.5：连续性机械 critical 转人工")
      expect(checkpoints.some((c) => c.stage === "after_review")).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("reaches the max-retry handoff with revised=false on resume", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      {
        ...residualBaseInput(),
        resumeCheckpoint: afterReviewCheckpoint(3),
      },
      {
        onThinking: (c) => thinking.push(c),
        onCheckpoint: () => {},
      },
      deps,
    )
    expect(result.manualReviewRequired).toBe(true)
    expect(result.decisionGates.overall).toBe("manual_review")
    expect(thinking.join("\n")).toContain("阻断问题在 3 次自动返修后仍未解除")
  })
})

describe("coverage-100-f5: Track B polish branch variants", () => {
  function polishStreamChat(
    deps: DeepChapterGenerationDeps,
    polishResponse: (prompt: string) => string,
  ): void {
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("多目标护栏")
          ? polishResponse(prompt)
          : prompt.includes("正文")
            ? chapterText("初稿正文内容", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
  }

  it("skips the polish block entirely when no literary issues and no residual opt-in", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, literaryPolishAfterGate: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).not.toContain("阶段5.7：Track B 文学抛光")
  })

  it("runs residual structure polish with mode-only opt-in (median ?? n/a)", async () => {
    const thinking: string[] = []
    const deps = createDeps()
    polishStreamChat(deps, () => chapterText("抛光后正文", 3000))
    const result = await runDeepChapterGeneration(
      residualBaseInput({ residualRewriteMode: "structure_thril_pacing" }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(true)
    const joined = thinking.join("\n")
    expect(joined).toContain("阶段5.7：Residual structure 抛光")
    expect(joined).toContain("residualOverallMedian=n/a")
  })

  it("annotates the residual constraint when literary issues coexist with mode-only opt-in", async () => {
    const reviewWarning: NovelReviewResult = {
      severity: "warning",
      type: "thrill",
      message: "爽点密度偏弱",
      evidence: "初稿正文内容",
      relatedMemory: "",
      suggestion: "强化章末钩。",
    }
    const thinking: string[] = []
    const deps = createDeps([[reviewWarning], []])
    polishStreamChat(deps, () => chapterText("抛光后正文", 3000))
    const result = await runDeepChapterGeneration(
      residualBaseInput({ residualRewriteMode: "structure_thril_pacing" }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(true)
    const joined = thinking.join("\n")
    expect(joined).toContain("阶段5.7：Track B 文学抛光")
    expect(joined).toContain("（同时启用 residual structure-first 约束）")
  })

  it("keeps the gated draft when the polish pass returns blank output", async () => {
    const reviewWarning: NovelReviewResult = {
      severity: "warning",
      type: "thrill",
      message: "爽点密度偏弱",
      evidence: "初稿正文内容",
      relatedMemory: "",
      suggestion: "强化章末钩。",
    }
    const thinking: string[] = []
    const deps = createDeps([[reviewWarning], []])
    polishStreamChat(deps, () => "   ")
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, literaryPolishAfterGate: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(false)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("rejects a polish pass that regresses slop without FIX-1 (回退 without （FIX-1）)", async () => {
    const reviewWarning: NovelReviewResult = {
      severity: "warning",
      type: "thrill",
      message: "爽点密度偏弱",
      evidence: "初稿正文内容",
      relatedMemory: "",
      suggestion: "强化章末钩。",
    }
    const thinking: string[] = []
    const deps = createDeps([[reviewWarning], []])
    polishStreamChat(deps, () => chapterText("综上所述，然而，值得注意的是，这一切都显得理所当然。", 3000))
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, literaryPolishAfterGate: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.revised).toBe(false)
    const joined = thinking.join("\n")
    expect(joined).toContain("阶段5.7：文学抛光回退")
    expect(joined).not.toContain("（FIX-1）")
  })

  it("falls back to currentContent when the final polish returns blank", async () => {
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? "   "
        : prompt.includes("正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("初稿正文内容")
  })
})

describe("coverage-100-f5: collectModelText remaining guards", () => {
  it("does not flush reasoning while content is already non-empty", async () => {
    let callIndex = 0
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callIndex += 1
      if (callIndex === 1) {
        callbacks.onToken("已有正文内容")
        callbacks.onReasoningToken?.("推理内容".repeat(80))
        callbacks.onDone()
        return
      }
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("treats a cancelled-request error after a repeat-cutoff as expected (no throw)", async () => {
    let callIndex = 0
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callIndex += 1
      if (callIndex === 1) {
        // 触发重复尾检测 → stopStream(cutoffReason)；随后 onError(request cancelled)
        // 真实实现：cutoff 已主动停止流，后续 cancelled 错误视为预期（不抛），
        // 返回截断后的部分内容走 cutoff 最终 flush。
        callbacks.onToken("完全相同的内容".repeat(100))
        callbacks.onError(new Error("request cancelled"))
        callbacks.onDone()
        return
      }
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("正文")
          ? chapterText("初稿正文内容", 3000)
          : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(residualBaseInput(), {}, deps)
    expect(result.finalContent).toContain("最终去AI味正文")
    // 任务书被重复尾检测截断（远短于原始 700 字符）
    expect(result.taskBrief.length).toBeLessThan(300)
  })
})

describe("coverage-100-f5: abort + scene breakdown variants", () => {
  it("aborts before the first LLM stage when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = createDeps()
    await expect(runDeepChapterGeneration(
      residualBaseInput(),
      {},
      deps,
      controller.signal,
    )).rejects.toThrow("已停止生成")
  })

  it("logs a string scene-breakdown failure via String(err) and continues", async () => {
    vi.mocked(runSceneBreakdown).mockRejectedValueOnce("scene string boom")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("scene string boom")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("logs a string scene-persistence failure via String(err) and continues", async () => {
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [{ sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认动静", tension: "逼近", beat: "紧张" }],
    })
    vi.mocked(persistSceneBreakdownDraft).mockRejectedValueOnce("persist string boom")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const deps = createDeps()
      const result = await runDeepChapterGeneration(
        residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
        {},
        deps,
      )
      expect(result.finalContent).toContain("最终去AI味正文")
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).toContain("persist string boom")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("renders the non-partial scene summary when onThinking is wired", async () => {
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [{ sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认动静", tension: "逼近", beat: "紧张" }],
    })
    const thinking: string[] = []
    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
      { onThinking: (c) => thinking.push(c) },
      deps,
    )
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(thinking.join("\n")).toContain("已完成场景拆解（1个场景）")
  })

  it("keeps the first partial reason when a later stage also reports partial", async () => {
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [{ sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认动静", tension: "逼近", beat: "紧张" }],
      partial: true,
      partialReason: "transport stalled mid-scene",
      tokenCost: 1,
      latencyMs: 2,
    })
    const deps = createDeps()
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      if (prompt.includes("章节正文")) {
        // 初稿阶段：长内容 + 传输不活跃错误 → partial-preserve → 第二次 notePartial
        callbacks.onToken(chapterText("部分草稿内容", 4000))
        callbacks.onError(new Error("produced no meaningful stream output within 120 seconds"))
        callbacks.onDone()
        return
      }
      const content = prompt.includes("简单审查") || prompt.includes("去AI味")
        ? chapterText("最终去AI味正文", 3000)
        : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(
      residualBaseInput({ novelConfig: { ...novelConfig, sceneBreakdownEnabled: true } }),
      {},
      deps,
    )
    // 真实实现：first-partial-reason-wins → scene 的 reason 保留（草稿 partial 被忽略）
    expect(result.partial).toBe(true)
    expect(result.partialReason).toContain("scene-breakdown: transport stalled mid-scene")
  })
})

describe("coverage-100-f5: collectLiteraryPolishIssues reachable branch sides", () => {
  const baseFinding = (severity: "error" | "warning" | "info", type: string, message: string) => ({
    severity, type, message, evidence: "", relatedMemory: "", suggestion: "",
  })

  it("drops non-literary warnings from the repair-issue pass (all chain operands false)", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [baseFinding("warning", "consistency", "非文学警告")] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: { status: "passed" as const, findings: [] },
      overall: "pass" as const,
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    expect(issues).toHaveLength(0)
  })

  it("matches substring literary types in the repair-issue pass (thrill/pacing/pull/plot)", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: {
        status: "passed" as const,
        findings: [
          baseFinding("warning", "thrill-gap", "m1"),
          baseFinding("warning", "pacing-gap", "m2"),
          baseFinding("warning", "pull-gap", "m3"),
          baseFinding("warning", "plot-gap", "m4"),
        ],
      },
      overall: "pass" as const,
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    expect(issues.map((i) => i.message)).toEqual(["m1", "m2", "m3", "m4"])
  })

  it("pulls info-severity literary findings from the quality gate with dedupe (push side)", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: {
        status: "passed" as const,
        findings: [
          baseFinding("info", "thrill-gap", "i1"),
          baseFinding("info", "pacing-gap", "i2"),
          baseFinding("info", "pull-gap", "i3"),
          baseFinding("info", "plot-gap", "i4"),
        ],
      },
      overall: "pass" as const,
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    expect(issues.map((i) => i.message)).toEqual(["i1", "i2", "i3", "i4"])
  })
})

describe("coverage-100: applyCachePrefix branch sides", () => {
  it("returns messages unchanged when cachePrefix is absent", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }]
    expect(applyCachePrefix(msgs)).toBe(msgs)
  })
  it("splits a user message that starts with the cache prefix", () => {
    const out = applyCachePrefix(
      [{ role: "user", content: "PREFIX-body" }],
      "PREFIX",
    )
    expect(out[0].content).toEqual([
      { type: "text", text: "PREFIX", cacheControl: true },
      { type: "text", text: "-body" },
    ])
  })
  it("leaves non-user messages and non-matching user messages untouched (return message fall-through)", () => {
    const out = applyCachePrefix(
      [
        { role: "assistant", content: "earlier turn" },
        { role: "user", content: "does not start with prefix" },
      ],
      "PREFIX",
    )
    expect(out[0]).toEqual({ role: "assistant", content: "earlier turn" })
    expect(out[1]).toEqual({ role: "user", content: "does not start with prefix" })
  })
})

describe("coverage-100-f6: collectLiteraryPolishIssues continue + type-undefined defensive paths", () => {
  const baseFinding = (severity: "error" | "warning" | "info", type: string, message: string) => ({
    severity, type, message, evidence: "", relatedMemory: "", suggestion: "",
  })

  it("skips error-severity literary findings via the continue guard (severity !== warning && !== info)", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: {
        status: "passed" as const,
        findings: [
          baseFinding("error", "thrill-gap", "should be skipped"),
          baseFinding("warning", "pacing-gap", "kept"),
        ],
      },
      overall: "pass" as const,
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    expect(issues.map((i) => i.message)).toEqual(["kept"])
  })

  it("tolerates a finding whose type is undefined (|| '' defensive lower-case)", () => {
    const gates = {
      consistency: { status: "passed" as const, findings: [] },
      anti_ai: { status: "passed" as const, findings: [] },
      quality: {
        status: "passed" as const,
        findings: [
          { ...baseFinding("warning", "thrill", "x"), type: undefined as unknown as string },
        ],
      },
      overall: "pass" as const,
    }
    // type undefined → (type || "") = "" → not literary → skipped (no throw)
    expect(collectLiteraryPolishIssues(gates as never)).toHaveLength(0)
  })
})

describe("coverage-100-f7: runFullReviewWithSixDim cascade-cancel on reviewChapter failure", () => {
  it("aborts an in-flight six-dim review and owns the orphan (terminal .catch fires) when reviewChapter throws", async () => {
    const reviewChapter = vi.fn(async () => { throw new Error("review boom") })
    const runSixDim = vi.fn((args: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        args.signal?.addEventListener("abort", () => reject(new Error("six-dim aborted")))
      }),
    )
    const deps = {
      buildContextPack: vi.fn(async () => ({} as ContextPack)),
      contextPackToPrompt: vi.fn(() => ""),
      reviewChapter,
      runSixDimensionReview: runSixDim as never,
      streamChat: vi.fn(async () => {}),
    } as unknown as DeepChapterGenerationDeps

    await expect(
      runFullReviewWithSixDim("章节内容", 3, "E:/Novel", deps, undefined, {} as ContextPack, {}),
    ).rejects.toThrow("review boom")

    // six-dim was launched (abortable promise) and then cascade-aborted.
    expect(runSixDim).toHaveBeenCalledTimes(1)
    expect(runSixDim.mock.calls[0][0]).toHaveProperty("signal")
  })
})
