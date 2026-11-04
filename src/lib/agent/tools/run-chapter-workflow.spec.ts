import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { createRunChapterWorkflowTool } from "./run-chapter-workflow"

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

  it.skip("forwards the confirmed plan blueprint into deep chapter generation", async () => {
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
        aiWorkflowMode: "standard",
        planBlueprint: blueprint,
      }),
      expect.any(Object),
      undefined,
      undefined,
    )
  })
  it.skip("falls back to getPlanBlueprint when AI omits planBlueprint from tool call params", async () => {
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
    )
  })

  it.skip("prefers AI-provided planBlueprint over the getter fallback", async () => {
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
})
