import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import {
  shouldUseDeepChapterGeneration,
  runDeepChapterGeneration,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第三章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )).resolves.toMatchObject({ finalContent: expect.any(String), partial: false, partialReason: null })

    expect(thinking.join("\n")).toContain("近期剧情")
  })

  it("falls back to an empty context pack when context building throws", async () => {
    const deps = createDeps()
    vi.mocked(deps.buildContextPack).mockRejectedValueOnce(new Error("context failed"))
    const thinking: string[] = []

    await expect(runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "???3?", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第7章正文", chapterNumber: 7, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第7章正文", chapterNumber: 7, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      {},
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成首章", chapterNumber: 1, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
        { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
        { projectPath: "E:/Novel", userRequest: "生成第4章", chapterNumber: 4, llmConfig },
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
        { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
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
