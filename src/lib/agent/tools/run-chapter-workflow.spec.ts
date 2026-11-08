import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  PLAN_BLUEPRINT_MAX_CHARS,
  createRunChapterWorkflowTool,
  normalizePlanBlueprint,
} from "./run-chapter-workflow"

/**
 * 计划落盘被 mock：RVF-09 要断「落盘发生了 / 落盘失败不阻断」，不能真写盘。
 * 生产侧导入的是模块路径本身（shared → novel 的深导入被 eslint 策略允许），
 * 所以 mock 这条同名路径就能拦住。
 */
const planStoreMocks = vi.hoisted(() => ({
  saveConfirmedPlan: vi.fn(
    async (_projectPath: string, _chapterNumber: number, _plan: string): Promise<void> => undefined,
  ),
}))

vi.mock("@/lib/novel/confirmed-plan-store", () => ({
  saveConfirmedPlan: planStoreMocks.saveConfirmedPlan,
}))

beforeEach(() => {
  planStoreMocks.saveConfirmedPlan.mockReset()
  planStoreMocks.saveConfirmedPlan.mockResolvedValue(undefined)
})

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
}

describe("createRunChapterWorkflowTool", () => {
  it("rejects an empty userRequest before starting the workflow", async () => {
    const runDeepChapterGeneration = vi.fn()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    await expect(tool.execute({ userRequest: "   " })).resolves.toContain("缺少 userRequest")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("wraps deep chapter generation as an auto action tool", async () => {
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks.onWorkflowEvent?.({
        type: "started",
        id: "deep_chapter:chapter_context",
        name: "chapter_context",
        title: "读取上下文",
        timestamp: 100,
      })
      return {
        finalContent: "最终正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const onToolEvent = vi.fn()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      onToolEvent,
    })

    expect(tool.name).toBe("run_chapter_workflow")
    expect(tool.category).toBe("action")
    expect(tool.permission).toBe("auto")
    expect(tool.buildRequiredToolFallbackParams?.({ taskGoal: "生成第3章" })).toEqual({
      userRequest: "生成第3章",
    })

    const result = await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
      chapterNumber: 3,
    })

    expect(runDeepChapterGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "E:/Novel",
        userRequest: "生成第3章",
        chapterNumber: 3,
      }),
      expect.any(Object),
      undefined,
      undefined,
      // RV-002 ①：第 5 参是共识轨迹回调（单模型 runner 忽略，但调用形状固定）。
      expect.any(Function),
    )
    expect(result).toContain("最终正文")
    expect(result).toContain("任务书")
  })

  it.skip("uses the runner tool call id as parent id for workflow child events", async () => {
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks.onWorkflowEvent?.({
        type: "started",
        id: "deep_chapter:chapter_context",
        name: "chapter_context",
        title: "读取上下文",
        timestamp: 100,
      })
      return {
        finalContent: "最终正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const onToolEvent = vi.fn()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "strict",
      runDeepChapterGeneration,
      onToolEvent,
    })

    await tool.execute(
      { userRequest: "继续第3章" },
      undefined,
      { callId: "agent_tool_call_7", toolName: "run_chapter_workflow" },
    )

    expect(onToolEvent).toHaveBeenCalledWith(expect.objectContaining({
      callId: "agent_tool_call_7:chapter_context",
      parentCallId: "agent_tool_call_7",
      name: "chapter_context",
    }))
  })

  it.skip("forwards workflow child events through the execution context emitter", async () => {
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks.onWorkflowEvent?.({
        type: "started",
        id: "deep_chapter:chapter_context",
        name: "chapter_context",
        title: "读取上下文",
        timestamp: 100,
      })
      return {
        finalContent: "最终正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "strict",
      runDeepChapterGeneration,
    })
    const onToolEvent = vi.fn()

    await tool.execute(
      { userRequest: "继续第3章" },
      undefined,
      { callId: "agent_tool_call_8", toolName: "run_chapter_workflow", onToolEvent } as any,
    )

    expect(onToolEvent).toHaveBeenCalledWith(expect.objectContaining({
      callId: "agent_tool_call_8:chapter_context",
      parentCallId: "agent_tool_call_8",
      name: "chapter_context",
    }))
  })

  it.skip("forwards deep chapter activity events through tool execution context", async () => {
    const onActivityEvent = vi.fn()
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks?.onActivityEvent?.({
        id: "activity-1",
        stageId: "read_context",
        kind: "extract_result",
        title: "提取结果",
        content: "上一章结尾：铜铃线索未揭示。",
        timestamp: 100,
      })
      return {
        finalContent: "正文",
        taskBrief: "任务书",
        draftContent: "草稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })

    const tool = createRunChapterWorkflowTool({
      projectPath: "C:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    await tool.execute(
      { userRequest: "生成第14章" },
      undefined,
      { callId: "workflow-1", toolName: "run_chapter_workflow", onActivityEvent },
    )

    expect(onActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "activity-1",
      stageId: "read_context",
      kind: "extract_result",
    }))
  })

  it.skip("forwards every nested chapter request trace into the parent Agent collector", async () => {
    const onRequestTrace = vi.fn()
    const trace = {
      provider: "custom" as const,
      model: "test-model",
      apiMode: "chat_completions",
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
      status: "success" as const,
    }
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks.onRequestTrace?.(trace)
      return {
        finalContent: "正文",
        taskBrief: "任务书",
        draftContent: "草稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "C:/Novel",
      llmConfig,
      aiWorkflowMode: "strict",
      runDeepChapterGeneration,
    })

    await tool.execute(
      { userRequest: "生成第14章" },
      undefined,
      { callId: "workflow-trace", toolName: "run_chapter_workflow", onRequestTrace },
    )

    expect(onRequestTrace).toHaveBeenCalledOnce()
    expect(onRequestTrace).toHaveBeenCalledWith(trace)
  })

  it("forwards the confirmed plan blueprint into deep chapter generation", async () => {
    const runDeepChapterGeneration = vi.fn(async () => {
      return {
        finalContent: "最终正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    const blueprint = "维度四·场景序列编排：1. 雨夜旧屋揭示线索 2. 屋外脚步声悬念收束"
    await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
      chapterNumber: 3,
      planBlueprint: blueprint,
    })

    expect(runDeepChapterGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "E:/Novel",
        userRequest: "生成第3章",
        chapterNumber: 3,
        planBlueprint: blueprint,
      }),
      expect.any(Object),
      undefined,
      undefined,
      // RV-002 ①：第 5 参是共识轨迹回调（单模型 runner 忽略，但调用形状固定）。
      expect.any(Function),
    )
  })
  it("falls back to getPlanBlueprint when AI omits planBlueprint from tool call params", async () => {
    const runDeepChapterGeneration = vi.fn(async () => ({
      finalContent: "最终正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
    }))
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getPlanBlueprint: () => "兜底计划：场景序列 1→2→3",
    })

    // AI 调用时未带 planBlueprint 参数
    await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
      chapterNumber: 3,
    })

    expect(runDeepChapterGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        planBlueprint: "兜底计划：场景序列 1→2→3",
      }),
      expect.any(Object),
      undefined,
      undefined,
      // RV-002 ①：第 5 参是共识轨迹回调（单模型 runner 忽略，但调用形状固定）。
      expect.any(Function),
    )
  })

  it("prefers AI-provided planBlueprint over the getter fallback", async () => {
    const runDeepChapterGeneration = vi.fn(async () => ({
      finalContent: "最终正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
    }))
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getPlanBlueprint: () => "兜底计划",
    })

    await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
      planBlueprint: "AI传入的计划",
    })

    expect(runDeepChapterGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        planBlueprint: "AI传入的计划",
      }),
      expect.any(Object),
      undefined,
      undefined,
      // RV-002 ①：第 5 参是共识轨迹回调（单模型 runner 忽略，但调用形状固定）。
      expect.any(Function),
    )
  })

  it.skip("passes getSelectedSkillsPrompt into deep chapter generation", async () => {
    const runDeepChapterGeneration = vi.fn(async () => ({
      finalContent: "最终正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
    }))
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getSelectedSkillsPrompt: () => "## 本次启用 Skill\n规则：combat-action",
    })

    await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
      chapterNumber: 3,
    })

    expect(runDeepChapterGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsPrompt: "## 本次启用 Skill\n规则：combat-action",
      }),
      expect.any(Object),
      undefined,
      undefined,
    )
  })

  it("includes plan compliance in the tool result when available", async () => {
    const runDeepChapterGeneration = vi.fn(async () => ({
      finalContent: "最终正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
      planCompliance: "履约度：基本符合",
    }))
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    const result = await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
    })

    expect(result).toContain("计划履约度")
    expect(result).toContain("履约度：基本符合")
  })

  it("includes execution report summary in the tool result when available", async () => {
    const runDeepChapterGeneration = vi.fn(async () => ({
      finalContent: "最终正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: true,
      executionReport: "执行状态：已返修\n完成场景：S1/S2\n待处理偏离项：无",
    }))
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    const result = await tool.execute({
      intent: "write_chapter",
      userRequest: "生成第3章",
    })

    expect(result).toContain("执行报告")
    expect(result).toContain("执行状态：已返修")
    expect(result).toContain("最终正文")
  })

  it("以终结型工具身份把终稿交付给会话，履约修复后以最后一次为准", async () => {
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks.onFinalContent?.("  去AI味后的正文  ")
      callbacks.onFinalContent?.("履约修复后的正文")
      callbacks.onFinalContent?.("   ")
      return {
        finalContent: "履约修复后的正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: true,
      }
    })
    const onFinalContent = vi.fn()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "strict",
      runDeepChapterGeneration,
    })

    expect(tool.finalizesRun).toBe(true)

    await tool.execute(
      { intent: "write_chapter", userRequest: "生成第240章" },
      undefined,
      { callId: "workflow-final", toolName: "run_chapter_workflow", onFinalContent },
    )

    expect(onFinalContent.mock.calls.map((call) => call[0])).toEqual([
      "去AI味后的正文",
      "履约修复后的正文",
    ])
  })

  it("G3 负例：不传 stageJournal 时深章输入不含该键（chat 路径零变更）", async () => {
    const runDeepChapterGeneration = vi.fn(async (input) => {
      expect("stageJournal" in input).toBe(false)
      return {
        finalContent: "正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })
    await tool.execute({ userRequest: "写第3章" })
    expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
  })

  it("G3 正例：stageJournal 同引用透传给深章输入", async () => {
    const stageJournal = { projectId: "p1", deps: {} as never, ttlMs: 1000 }
    const runDeepChapterGeneration = vi.fn(async (input) => {
      expect(input.stageJournal).toBe(stageJournal)
      return {
        finalContent: "正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      stageJournal,
    })
    await tool.execute({ userRequest: "写第3章" })
    expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
  })

  it("G3：onThinking 产出 kind=stage_output 活动事件，content 截断 240 字", async () => {
    const onActivityEvent = vi.fn()
    const runDeepChapterGeneration = vi.fn(async (_input, callbacks) => {
      callbacks?.onThinking?.("任务书片段")
      callbacks?.onThinking?.("   ")
      callbacks?.onThinking?.("x".repeat(300))
      return {
        finalContent: "正文",
        taskBrief: "任务书",
        draftContent: "初稿",
        reviewResults: [],
        decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
        manualReviewRequired: false,
        retryCount: 0,
        partial: false,
        partialReason: null,
        status: "passed",
        verdict: "pass",
        findings: [],
        revised: false,
      }
    })
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      onActivityEvent,
    })
    await tool.execute({ userRequest: "写第3章" })

    // 空白思考被跳过，只产生两条
    expect(onActivityEvent).toHaveBeenCalledTimes(2)
    const first = onActivityEvent.mock.calls[0][0] as { kind: string; content: string; stageId: string }
    expect(first.kind).toBe("stage_output")
    expect(first.stageId).toBe("run_chapter_workflow")
    expect(first.content.startsWith("任务书片段")).toBe(true)
    const second = onActivityEvent.mock.calls[1][0] as { content: string }
    expect(second.content).toHaveLength(241)
    expect(second.content.endsWith("…")).toBe(true)
  })

  it("共识轨迹经第 5 参回流成一条 activities 事件（RV-002 ①）", async () => {
    const onActivityEvent = vi.fn()
    const runDeepChapterGeneration = vi.fn(
      async (
        _input: unknown,
        _callbacks: unknown,
        _deps: unknown,
        _signal: unknown,
        onConsensusTrace?: (trace: unknown) => void,
      ) => {
        onConsensusTrace?.({
          seatCount: 3,
          debateRounds: 2,
          averageScores: [{ candidate: "seat-1", average: 8.5 }],
          winner: "seat-1",
          rationaleDigest: "digest",
          failedSeats: ["seat-3"],
        })
        return {
          finalContent: "正文",
          taskBrief: "任务书",
          draftContent: "草稿",
          reviewResults: [],
          decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
          manualReviewRequired: false,
          retryCount: 0,
          partial: false,
          partialReason: null,
          status: "passed",
          verdict: "pass",
          findings: [],
          revised: false,
        }
      },
    )
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: runDeepChapterGeneration as never,
      onActivityEvent,
    })

    await tool.execute({ userRequest: "生成第3章", chapterNumber: 3 })

    expect(onActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "consensus_writing", kind: "analysis" }),
    )
    const consensus = onActivityEvent.mock.calls[0][0] as { title: string; content: string }
    expect(consensus.title.length).toBeGreaterThan(0)
    expect(consensus.content).toContain("seat-1")
    expect(consensus.content).toContain("seat-3")
  })

  it("RV-02：兜底参数缺上下文时形状与旧行为逐字段相同（只有 userRequest）", () => {
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: vi.fn(),
    })
    expect(tool.buildRequiredToolFallbackParams!({ taskGoal: "生成第3章" })).toEqual({
      userRequest: "生成第3章",
    })
  })

  it("RV-02：兜底参数携带章节号与计划（第二参显式传入）", () => {
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: vi.fn(),
    })
    const build = tool.buildRequiredToolFallbackParams as (
      input: { taskGoal: string },
      context?: { chapterNumber?: number; planBlueprint?: string },
    ) => Record<string, unknown>
    expect(build({ taskGoal: "生成第3章" }, { chapterNumber: 3, planBlueprint: "计划A" })).toEqual({
      userRequest: "生成第3章",
      chapterNumber: 3,
      planBlueprint: "计划A",
    })
    // 缺值不得假填（undefined / 0 / 空串都不进参数）：下游 `chapterNumber ?? 0` 会跑错章。
    expect(build({ taskGoal: "生成草稿" }, { chapterNumber: 0, planBlueprint: "" })).toEqual({
      userRequest: "生成草稿",
    })
  })

  it("RV-02：兜底参数也能从 options.getFallbackParams 取值（未显式传第二参时）", () => {
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: vi.fn(),
      getFallbackParams: () => ({ chapterNumber: 7, planBlueprint: "计划B" }),
    })
    expect(tool.buildRequiredToolFallbackParams!({ taskGoal: "生成第7章" })).toEqual({
      userRequest: "生成第7章",
      chapterNumber: 7,
      planBlueprint: "计划B",
    })
  })

  it("RV-03：计划文本不超过上限时原样透传", () => {
    expect(normalizePlanBlueprint(undefined)).toBeUndefined()
    expect(normalizePlanBlueprint("")).toBe("")
    const exact = "字".repeat(PLAN_BLUEPRINT_MAX_CHARS)
    expect(normalizePlanBlueprint(exact)).toBe(exact)
  })

  it("RV-03：超长计划截断至上限并加显式标记（不得当权威计划原样执行）", () => {
    const overlong = "字".repeat(PLAN_BLUEPRINT_MAX_CHARS + 5000)
    const normalized = normalizePlanBlueprint(overlong)!
    expect(normalized.length).toBe(PLAN_BLUEPRINT_MAX_CHARS)
    expect(normalized).toContain("已截断")
    expect(normalized).toContain("不得作为「必须原样执行」的权威计划")
    expect(normalized.startsWith("字")).toBe(true)
  })

  it("RV-03：超长计划经 execute 传给生成链时已被截断（模型参数与 getter 两条来源）", async () => {
    const runDeepChapterGeneration = vi.fn(async (_input: { planBlueprint?: string }) => ({
      finalContent: "正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
    }))
    const overlong = "计".repeat(PLAN_BLUEPRINT_MAX_CHARS + 1)
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getPlanBlueprint: () => overlong,
    })

    // 来源一：会话层 getter
    await tool.execute({ userRequest: "写第3章" })
    const fromGetter = runDeepChapterGeneration.mock.calls[0][0]
    expect(fromGetter.planBlueprint?.length).toBe(PLAN_BLUEPRINT_MAX_CHARS)
    expect(fromGetter.planBlueprint).toContain("已截断")

    // 来源二：模型自己传的参数（更长，同样被截断）
    await tool.execute({ userRequest: "写第3章", planBlueprint: "计".repeat(PLAN_BLUEPRINT_MAX_CHARS * 2) })
    const fromParams = runDeepChapterGeneration.mock.calls[1][0]
    expect(fromParams.planBlueprint?.length).toBe(PLAN_BLUEPRINT_MAX_CHARS)
    expect(fromParams.planBlueprint).toContain("已截断")
  })

  /** 成功结果的最小形状（只测落盘与降级，不关心其余字段）。 */
  const okResult = {
    finalContent: "最终正文",
    taskBrief: "任务书",
    draftContent: "初稿",
    reviewResults: [],
    decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    status: "passed",
    verdict: "pass",
    findings: [],
    revised: false,
  }

  it("RVF-09：planBlueprint 有值且章号有效时落盘（断言落盘参数）", async () => {
    const runDeepChapterGeneration = vi.fn(async () => okResult)
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    await tool.execute({ userRequest: "写第3章", chapterNumber: 3, planBlueprint: "模型自拟计划A" })

    // 生产侧只传三个参（source 缺省 "model"）：不得把模型文本标成用户确认。
    expect(planStoreMocks.saveConfirmedPlan).toHaveBeenCalledTimes(1)
    expect(planStoreMocks.saveConfirmedPlan).toHaveBeenCalledWith("E:/Novel", 3, "模型自拟计划A")
  })

  it("RVF-09：落盘失败不阻断生成（finalContent 照常交付）", async () => {
    planStoreMocks.saveConfirmedPlan.mockRejectedValueOnce(new Error("磁盘只读"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const runDeepChapterGeneration = vi.fn(async () => okResult)
      const tool = createRunChapterWorkflowTool({
        projectPath: "E:/Novel",
        llmConfig,
        aiWorkflowMode: "standard",
        runDeepChapterGeneration,
      })

      const result = await tool.execute({
        userRequest: "写第3章",
        chapterNumber: 3,
        planBlueprint: "模型自拟计划A",
      })

      expect(planStoreMocks.saveConfirmedPlan).toHaveBeenCalledTimes(1)
      expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
      expect(result).toContain("最终正文")
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("RVF-03：落盘章号优先取装配层结构化值（写键与读键同源）", async () => {
    const runDeepChapterGeneration = vi.fn(async () => okResult)
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      // 模型没传章号（schema 允许省略）→ 旧实现完全不落盘，回读恒 miss。
      getFallbackParams: () => ({ chapterNumber: 12 }),
    })

    await tool.execute({ userRequest: "继续写", planBlueprint: "计划C" })

    expect(planStoreMocks.saveConfirmedPlan).toHaveBeenCalledWith("E:/Novel", 12, "计划C")
  })

  it("RVF-03：模型参数与结构化值不一致时不落盘，并记诊断（写错章比不写更糟）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const runDeepChapterGeneration = vi.fn(async () => okResult)
      const tool = createRunChapterWorkflowTool({
        projectPath: "E:/Novel",
        llmConfig,
        aiWorkflowMode: "standard",
        runDeepChapterGeneration,
        getFallbackParams: () => ({ chapterNumber: 12 }),
      })

      const result = await tool.execute({
        userRequest: "写第3章",
        chapterNumber: 3,
        planBlueprint: "计划D",
      })

      expect(planStoreMocks.saveConfirmedPlan).not.toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((call) => String(call[0])).join("\n")
      expect(warned).toContain("章号不一致")
      // 不落盘不等于不生成：本轮正文照常交付。
      expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
      expect(result).toContain("最终正文")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("模型把章号写成字符串：数字串归一成 number，非数字串归一成 undefined", async () => {
    // 工具 schema 声明 integer，但模型实际常把 "12" 作为字符串传（JSON 宽松）。
    // 字符串分支必须归一，否则 chapterNumber 会以原始字符串进生成链（下游 `?? 0` 误读）。
    const runDeepChapterGeneration = vi.fn(
      async (_input: { chapterNumber?: number }) => okResult,
    )
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
    })

    await tool.execute({ userRequest: "写第十二章", chapterNumber: "12", planBlueprint: "计划E" })

    expect(planStoreMocks.saveConfirmedPlan).toHaveBeenCalledWith("E:/Novel", 12, "计划E")
    expect(runDeepChapterGeneration.mock.calls[0]?.[0]).toMatchObject({ chapterNumber: 12 })

    // 非数字串（Number() → NaN）→ undefined：不得把 NaN 当成章号写盘/进生成链。
    planStoreMocks.saveConfirmedPlan.mockClear()
    runDeepChapterGeneration.mockClear()
    await tool.execute({ userRequest: "写下一章", chapterNumber: "十二章", planBlueprint: "计划F" })

    expect(planStoreMocks.saveConfirmedPlan).not.toHaveBeenCalled()
    const secondInput = runDeepChapterGeneration.mock.calls[0]?.[0]
    expect(secondInput?.chapterNumber).toBeUndefined()
  })
})

/**
 * DEBT-20261108-01：智能体工具路径的 workflowMode 也必须落到管线真实开关上
 * （此前只被 normalizeParams 解析、不传入生成链）。
 */
describe("createRunChapterWorkflowTool workflowMode 深度映射", () => {
  const fakeResult = () => ({
    finalContent: "正文",
    taskBrief: "任务书",
    draftContent: "初稿",
    reviewResults: [],
    decisionGates: {} as import("@/lib/novel/deep-chapter-generation").DeepChapterDecisionGates,
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    status: "passed",
    verdict: "pass",
    findings: [],
    revised: false,
  })

  /** 捕获管线实参：mock 的 calls 元组在 vi.fn 无参声明时索引不到，故显式收口。 */
  function captureNovelConfig() {
    const captured: { value?: unknown } = {}
    const runDeepChapterGeneration = vi.fn(async (input: { novelConfig: unknown }) => {
      captured.value = input.novelConfig
      return fakeResult()
    })
    return { captured, runDeepChapterGeneration }
  }

  it("fast 关闭共识与门控后打磨", async () => {
    const { captured, runDeepChapterGeneration } = captureNovelConfig()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getNovelConfig: () =>
        ({ consensusEnabled: true, literaryPolishAfterGate: true }) as import("@/stores/wiki-store").NovelConfig,
    })
    await tool.execute({ userRequest: "生成第3章", chapterNumber: 3, workflowMode: "fast" })
    expect(captured.value).toMatchObject({ consensusEnabled: false, literaryPolishAfterGate: false })
  })

  it("strict 打开共识与门控后打磨", async () => {
    const { captured, runDeepChapterGeneration } = captureNovelConfig()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getNovelConfig: () =>
        ({ consensusEnabled: false, literaryPolishAfterGate: false }) as import("@/stores/wiki-store").NovelConfig,
    })
    await tool.execute({ userRequest: "生成第3章", chapterNumber: 3, workflowMode: "strict" })
    expect(captured.value).toMatchObject({ consensusEnabled: true, literaryPolishAfterGate: true })
  })

  it("未传档位时原配置引用直通（零行为变更）", async () => {
    const original = {
      consensusEnabled: true,
      literaryPolishAfterGate: false,
    } as import("@/stores/wiki-store").NovelConfig
    const { captured, runDeepChapterGeneration } = captureNovelConfig()
    const tool = createRunChapterWorkflowTool({
      projectPath: "E:/Novel",
      llmConfig,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      getNovelConfig: () => original,
    })
    await tool.execute({ userRequest: "生成第3章", chapterNumber: 3 })
    expect(captured.value).toBe(original)
  })
})
