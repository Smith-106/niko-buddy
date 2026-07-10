import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import {
  runDeepChapterGeneration,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"

/**
 * EPIC-002 / ADR-30 / TASK-012: 阶段 1.5 scene-breakdown 插入 + partial 传播 spec.
 *
 * Covers:
 * - sceneBreakdownEnabled=true → runSceneBreakdown + persistSceneBreakdownDraft 调用
 *   + after_scene_breakdown checkpoint fire（阶段 1.5 在 contextPack 后 task_brief 前）
 * - 向后兼容（ADR-30）：sceneBreakdownEnabled=false → 跳过阶段 1.5，after_task_brief
 *   恢复序不变（runSceneBreakdown 不被调用）
 * - partial 传播（spec S-444k typed signal）：sceneResult.partial → notePartial →
 *   DeepChapterGenerationResult.partial=true + partialReason 含 scene-breakdown 前缀
 *   （→ chat-panel pauseDeepChapterSession draft_status pending，防 partial 误标 complete）
 * - runSceneBreakdown 抛错非阻断（加性中间层降级，主链继续 task_brief）
 * - resume at after_scene_breakdown 跳过重复拆解（checkpointStageAtLeast 守卫）
 */

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
  recentSummaries: ["第1章：主角收到匿名信。"],
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
  // Reuse the same long-prose generator pattern as deep-chapter-generation.spec
  // so stage-3 draft passes the minChars gate without expansion.
  const unit = "雨水沿着瓦檐落下，旧屋里的灯影忽明忽暗，主角确认门缝后的动静。第N个细节继续推进。"
  let text = prefix
  let index = 0
  while (text.length < count) {
    text += `${unit}第${index + 1}步。`
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

// Mock scene-breakdown module: capture runSceneBreakdown / persistSceneBreakdownDraft
// invocations without triggering real streamChat (scene-breakdown.ts imports streamChat
// directly from llm-client, bypassing deps). This isolates the stage-1.5 wiring test
// from the already-covered scene-breakdown.spec.ts unit tests.
const sceneMocks = vi.hoisted(() => ({
  runSceneBreakdown: vi.fn(),
  persistSceneBreakdownDraft: vi.fn(),
}))

vi.mock("./scene-breakdown", () => ({
  runSceneBreakdown: sceneMocks.runSceneBreakdown,
  persistSceneBreakdownDraft: sceneMocks.persistSceneBreakdownDraft,
}))

function createDeps(reviewResults: NovelReviewResult[] = []): DeepChapterGenerationDeps {
  const responses = [
    "写作任务书内容",
    chapterText("初稿正文内容"),
    chapterText("返修正文内容"),
    chapterText("最终去AI味正文"),
  ]
  return {
    buildContextPack: vi.fn(async () => contextPack),
    contextPackToPrompt: vi.fn(() => "上下文包内容"),
    reviewChapter: vi.fn(async () => reviewResults),
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

beforeEach(() => {
  sceneMocks.runSceneBreakdown.mockReset()
  sceneMocks.persistSceneBreakdownDraft.mockReset()
  sceneMocks.persistSceneBreakdownDraft.mockResolvedValue(undefined)
})

afterEach(() => {
  // Restore novelConfig defaults so sceneBreakdownEnabled=false between tests.
  const prior = useWikiStore.getState().novelConfig
  useWikiStore.setState({ novelConfig: { ...prior, sceneBreakdownEnabled: false } })
})

describe("EPIC-002 / ADR-30 / TASK-012: 阶段 1.5 scene-breakdown 插入", () => {
  it("sceneBreakdownEnabled=true → 调用 runSceneBreakdown + persistSceneBreakdownDraft + after_scene_breakdown checkpoint", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({ novelConfig: { ...priorNovelConfig, sceneBreakdownEnabled: true } })
    // Scene breakdown returns 2 scenes, no partial.
    sceneMocks.runSceneBreakdown.mockResolvedValue({
      scenes: [
        { sceneId: "scene-1", sceneTitle: "旧屋门口", location: "旧屋", characters: ["主角"], goal: "发现线索", tension: "门后威胁", beat: "推进" },
        { sceneId: "scene-2", sceneTitle: "屋内搜索", location: "旧屋", characters: ["主角"], goal: "找到信纸", tension: "未知脚步声", beat: "悬念" },
      ],
      partial: false,
      latencyMs: 1234,
    })

    const deps = createDeps()
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
    const thinking: string[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      {
        onThinking: (content) => thinking.push(content),
        onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) },
      },
      deps,
    )

    // Stage 1.5 fired: runSceneBreakdown called with blueprint=userRequest + contextPack.
    expect(sceneMocks.runSceneBreakdown).toHaveBeenCalledTimes(1)
    const [blueprintArg, contextPackArg, signalArg] = sceneMocks.runSceneBreakdown.mock.calls[0]
    expect(blueprintArg).toBe("生成第3章")
    expect(contextPackArg).toBe(contextPack)
    // Signal cascaded (PAT-DC3) — may be undefined when the caller passes no
    // external AbortSignal (runDeepChapterGeneration's 4th arg); the cascade
    // contract is that whatever signal exists is forwarded, not that one is
    // synthesized. scene-breakdown.spec covers the signal-cascade unit test.
    expect(signalArg === undefined || (typeof signalArg?.addEventListener === "function")).toBe(true)
    // Factory persistence called (ADR-31).
    expect(sceneMocks.persistSceneBreakdownDraft).toHaveBeenCalledTimes(1)
    const [projectPathArg, chapterIdArg, sceneResultArg] = sceneMocks.persistSceneBreakdownDraft.mock.calls[0]
    expect(projectPathArg).toBe("E:/Novel")
    expect(chapterIdArg).toBe("3")
    expect(sceneResultArg.scenes).toHaveLength(2)
    // after_scene_breakdown checkpoint fired (between after_context and after_task_brief).
    const stagesFired = checkpoints.map((c) => c.stage)
    expect(stagesFired).toContain("after_scene_breakdown")
    const sbIndex = stagesFired.indexOf("after_scene_breakdown")
    const ctxIndex = stagesFired.indexOf("after_context")
    const tbIndex = stagesFired.indexOf("after_task_brief")
    expect(ctxIndex).toBeGreaterThanOrEqual(0)
    expect(sbIndex).toBeGreaterThan(ctxIndex)
    expect(tbIndex).toBeGreaterThan(sbIndex)
    // Stage 1.5 thinking surfaced.
    expect(thinking.join("\n")).toContain("阶段1.5：场景拆解")
    // No partial → normal completion path (chat-panel would route to completeDeepChapterSession).
    expect(result.partial).toBe(false)
    expect(result.partialReason).toBeNull()
  })

  it("向后兼容（ADR-30）：sceneBreakdownEnabled=false → 跳过阶段 1.5，runSceneBreakdown 不被调用", async () => {
    // Default config has sceneBreakdownEnabled=false.
    const deps = createDeps()
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      { onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) } },
      deps,
    )

    // Stage 1.5 skipped entirely.
    expect(sceneMocks.runSceneBreakdown).not.toHaveBeenCalled()
    expect(sceneMocks.persistSceneBreakdownDraft).not.toHaveBeenCalled()
    // after_scene_breakdown NOT fired — recovery order unchanged (ADR-30 backward compat).
    const stagesFired = checkpoints.map((c) => c.stage)
    expect(stagesFired).not.toContain("after_scene_breakdown")
    // after_task_brief still fires (existing order preserved).
    expect(stagesFired).toContain("after_task_brief")
    // Normal completion.
    expect(result.partial).toBe(false)
    expect(result.finalContent).toContain("最终去AI味正文")
  })

  it("partial 传播（S-444k typed signal）：sceneResult.partial → result.partial=true + partialReason 含 scene-breakdown 前缀", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({ novelConfig: { ...priorNovelConfig, sceneBreakdownEnabled: true } })
    // Scene breakdown returns partial (transport stalled mid-stream).
    sceneMocks.runSceneBreakdown.mockResolvedValue({
      scenes: [{ sceneId: "scene-1", sceneTitle: "旧屋门口", location: "旧屋", characters: ["主角"], goal: "线索", tension: "威胁", beat: "推进" }],
      partial: true,
      partialReason: "produced no additional stream output within 60 seconds",
      latencyMs: 5000,
    })

    const deps = createDeps()
    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      {},
      deps,
    )

    // Scene partial propagated to the chapter-level result — chat-panel will route
    // to pauseDeepChapterSession (draft_status pending), NOT completeDeepChapterSession
    // (ready), preventing the truncated draft from being persisted as complete
    // (Draft-first boundary, spec S-444k).
    expect(result.partial).toBe(true)
    expect(result.partialReason).toContain("scene-breakdown")
    expect(result.partialReason).toContain("produced no additional stream output")
    // Scene draft still persisted (pending) even when partial — the partial scene list
    // is a usable Draft-first artifact for continue-unfinished to resume from.
    expect(sceneMocks.persistSceneBreakdownDraft).toHaveBeenCalledTimes(1)
  })

  it("加性降级：runSceneBreakdown 抛错不阻断主链（继续到 task_brief 完成）", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({ novelConfig: { ...priorNovelConfig, sceneBreakdownEnabled: true } })
    sceneMocks.runSceneBreakdown.mockRejectedValue(new Error("scene breakdown failed"))

    const deps = createDeps()
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []

    const result = await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig },
      { onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) } },
      deps,
    )

    // Main chain survived — final content produced normally.
    expect(result.finalContent).toContain("最终去AI味正文")
    expect(result.partial).toBe(false)
    // persistSceneBreakdownDraft NOT called (no scene result to persist).
    expect(sceneMocks.persistSceneBreakdownDraft).not.toHaveBeenCalled()
    // after_scene_breakdown checkpoint still fires (stage 1.5 was attempted; resume
    // should not re-run scene breakdown on a chapter that already attempted it).
    const stagesFired = checkpoints.map((c) => c.stage)
    expect(stagesFired).toContain("after_scene_breakdown")
    // Main chain continued past stage 1.5 to task_brief and completion.
    expect(stagesFired).toContain("after_task_brief")
  })

  it("resume 守卫：checkpoint at after_scene_breakdown 不重复拆解（已过该阶段）", async () => {
    const priorNovelConfig = useWikiStore.getState().novelConfig
    useWikiStore.setState({ novelConfig: { ...priorNovelConfig, sceneBreakdownEnabled: true } })

    const deps = createDeps()
    const resumeCheckpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "生成第3章",
      chapterNumber: 3,
      stage: "after_scene_breakdown",
      taskBrief: "已生成的写作任务书内容",
    }

    await runDeepChapterGeneration(
      { projectPath: "E:/Novel", userRequest: "生成第3章", chapterNumber: 3, llmConfig, resumeCheckpoint },
      {},
      deps,
    )

    // Resume already past after_scene_breakdown → stage 1.5 skipped (no re-run).
    expect(sceneMocks.runSceneBreakdown).not.toHaveBeenCalled()
    expect(sceneMocks.persistSceneBreakdownDraft).not.toHaveBeenCalled()
  })
})
