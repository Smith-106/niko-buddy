import { describe, expect, it, vi, afterEach } from "vitest"

// 与 deep-chapter-generation.spec.ts 一致的轻量 mock：LLM 直连/动态导入默认降级为空实现。
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
  return { ...actual, loadContinuityOverrides: vi.fn(async () => ({ overrides: [], lastUpdated: "" })) }
})

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import {
  runDeepChapterGeneration,
  type DeepChapterGenerationDeps,
} from "./deep-chapter-generation"
import {
  runSceneBreakdown,
  type SceneBreakdownResult,
} from "./scene-breakdown"

const llmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

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
    "信纸上的字迹和匿名信相互呼应，但关键名字被刻意刮掉，线索所以变得更危险。",
    "屋外的脚步声突然停住，像有人贴着门听他们说话，空气一下子绷紧。",
    "主角把小晴挡到身后，打定主意先带走信纸，却在箱底摸到第二把完全陌生的钥匙。",
  ]
  let text = prefix
  let index = 0
  while (text.length < count) {
    text += `${scenes[index % scenes.length]}第${index + 1}个细节把人物选择继续往前推。`
    index += 1
  }
  return text.slice(0, count)
}

function messagesPromptText(messages: ChatMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    )
    .join("\n")
}

function baseDeps(): DeepChapterGenerationDeps {
  return {
    buildContextPack: vi.fn(async () => contextPack),
    contextPackToPrompt: vi.fn(() => "上下文包内容"),
    reviewChapter: vi.fn(async () => [] as NovelReviewResult[]),
    streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      const content = prompt.includes("去AI味") || prompt.includes("简单审查")
        ? chapterText("最终去AI味正文", 3000)
        : prompt.includes("返修")
          ? chapterText("返修正文内容", 3000)
          : prompt.includes("章节正文") || prompt.includes("正文")
            ? chapterText("初稿正文内容", 3000)
            : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    }),
  }
}

afterEach(() => {
  vi.mocked(runSceneBreakdown).mockReset()
  vi.mocked(runSceneBreakdown).mockResolvedValue({ scenes: [] })
})

describe("CORR-107 partial clear (first-wins + 成功清除)", () => {
  it("partial 后完整成功则 partialReason 为 null 且走 complete 路由（scene partial → 初稿完整成功即清除）", async () => {
    // scene 阶段 partial（transport-inactivity，2 scenes 部分保留）
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [
        { sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认门内动静", tension: "门外脚步声逼近", beat: "紧张" },
        { sceneId: "scene-2", sceneTitle: "发现锈钥匙", location: "屋内", characters: ["主角", "小晴"], goal: "找到线索", tension: "第二把钥匙出现", beat: "转折" },
      ],
      partial: true,
      partialReason: "produced no additional stream output within 60 seconds (scene-stage-first)",
      tokenCost: 1,
      latencyMs: 2,
    } satisfies SceneBreakdownResult)
    const deps = baseDeps()
    // 初稿/扩写/终稿全部完整成功（长初稿 3000 ≥ minChars，不触发扩写；终稿完整）
    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第3章",
        chapterNumber: 3,
        llmConfig,
        novelConfig: { ...novelConfig, sceneBreakdownEnabled: true, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
      },
      {},
      deps,
    )
    // CORR-107：后续完整成功 supersede 早期 partial → 不再误标 partial，不再误路由 pause
    expect(result.partial).toBe(false)
    expect(result.partialReason).toBeNull()
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("partial 后仍失败则保留首因（scene partial → 初稿仍 partial，不被覆盖）", async () => {
    const sceneReason = "produced no additional stream output within 60 seconds (scene-stage-first)"
    vi.mocked(runSceneBreakdown).mockResolvedValueOnce({
      scenes: [
        { sceneId: "scene-1", sceneTitle: "雨夜抵达", location: "旧屋门前", characters: ["主角"], goal: "确认动静", tension: "逼近", beat: "紧张" },
      ],
      partial: true,
      partialReason: sceneReason,
      tokenCost: 1,
      latencyMs: 2,
    } satisfies SceneBreakdownResult)
    const deps = baseDeps()
    const draftReason = "produced no meaningful stream output within 120 seconds (draft-stage-second)"
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      if (prompt.includes("扩写")) {
        const content = chapterText("扩写内容", 3000)
        callbacks.onToken(content)
        callbacks.onDone()
        return
      }
      if (prompt.includes("章节正文") || (prompt.includes("正文") && !prompt.includes("去AI味") && !prompt.includes("返修"))) {
        // 初稿阶段：长内容 + 传输不活跃错误 → partial-preserve（长草稿 ≥ minChars，不触发扩写）
        callbacks.onToken(chapterText("部分草稿内容", 4000))
        callbacks.onError(new Error(draftReason))
        callbacks.onDone()
        return
      }
      const content = prompt.includes("去AI味") || prompt.includes("简单审查")
        ? chapterText("最终去AI味正文", 3000)
        : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第3章",
        chapterNumber: 3,
        llmConfig,
        novelConfig: { ...novelConfig, sceneBreakdownEnabled: true, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
      },
      {},
      deps,
    )
    // 首因保留：scene 先 partial，初稿再 partial（本阶段 hadPartial，无成功清除）
    expect(result.partial).toBe(true)
    expect(result.partialReason).toContain("scene-breakdown")
    expect(result.partialReason).toContain("scene-stage-first")
    expect(result.partialReason).not.toContain("draft-stage-second")
  })

  it("两次 partial 则保留首次原因（初稿 partial → 扩写仍 partial，first-wins）", async () => {
    const deps = baseDeps()
    const firstReason = "produced no additional stream output within 30 seconds (first-partial-marker-AAA)"
    const secondReason = "produced no meaningful stream output within 45 seconds (second-partial-marker-BBB)"
    vi.mocked(deps.streamChat).mockImplementation(async (_c: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messagesPromptText(messages)
      if (prompt.includes("扩写")) {
        // 扩写阶段：部分内容 + 传输不活跃 → 第二次 partial-preserve（first-wins 应保留首次）
        callbacks.onToken(chapterText("扩写阶段被截断的部分正文", 2000))
        callbacks.onError(new Error(secondReason))
        callbacks.onDone()
        return
      }
      if (prompt.includes("章节正文") || (prompt.includes("正文") && !prompt.includes("去AI味") && !prompt.includes("返修"))) {
        // 初稿短草稿（< minChars）触发扩写；初稿本身 partial-preserve（首次）
        callbacks.onToken(chapterText("短初稿", 50))
        callbacks.onError(new Error(firstReason))
        callbacks.onDone()
        return
      }
      const content = prompt.includes("去AI味") || prompt.includes("简单审查")
        ? chapterText("最终去AI味正文", 3000)
        : "写作任务书内容"
      callbacks.onToken(content)
      callbacks.onDone()
    })
    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "生成第4章",
        chapterNumber: 4,
        llmConfig,
        novelConfig: { ...novelConfig, sceneBreakdownEnabled: false, deepChapterReview: false, deepPreviousChaptersAnalysis: false },
      },
      {},
      deps,
    )
    expect(result.partial).toBe(true)
    expect(result.partialReason).toContain("first-partial-marker-AAA")
    expect(result.partialReason).not.toContain("second-partial-marker-BBB")
  })
})
