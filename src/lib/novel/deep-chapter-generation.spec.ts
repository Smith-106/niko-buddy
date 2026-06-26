import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { GateSummary } from "@/commands/gates"
import type { ContextAssemblyResult } from "./context-assembly"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import {
  runDeepChapterGeneration,
  shouldUseDeepChapterGeneration,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"

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
  task: "chapter-request-1",
  chapterGoal: "Chapter goal",
  outline: "Chapter outline",
  recentSummaries: ["Summary one", "Summary two"],
  previousChapterEnding: "A metal sound came from the door crack.",
  characterStates: "The protagonist is cautious but impatient.",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "The protagonist does not know the owner's identity.",
  foreshadowingStates: "Anonymous letter and rusted key remain unresolved.",
  timeline: "Rainy night, 10 PM.",
  relatedSettings: "An old house at the edge of the blackout zone.",
  canonRules: "The protagonist cannot know the owner identity in advance.",
  writingStyle: "Tense, restrained, visual.",
  searchResults: "Memory fragments about the old house.",
  graphSearchResults: "letter -> house -> key",
  mustDo: "Carry the previous chapter hook forward.",
  mustAvoid: "Do not reveal the owner too early.",
  nextChapterAdvice: "End with a second silhouette in the room.",
  revisionDirectives: "",
}

function chapterText(prefix: string, count = 3200): string {
  const sentence = "Rain pressed against the old window while the floor answered every step with a dry echo. "
  let text = `${prefix} `
  while (text.length < count) {
    text += sentence
  }
  return text.slice(0, count)
}

function createGateSummary(overrides: Partial<GateSummary> = {}): GateSummary {
  return {
    all_passed: true,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
    },
    total_retries: 0,
    max_retry: 3,
    final_text: null,
    ...overrides,
  }
}

function createContextAssemblyResult(): ContextAssemblyResult {
  return {
    task_id: "ctx-ch001",
    sources: [
      { type: "outline", ref: "context/outline", priority: 1, status: "loaded" },
      { type: "snapshots", ref: "context/snapshots", priority: 4, status: "loaded" },
    ],
    token_budget: 14000,
    estimated_tokens: 3200,
    prompt_chars: 12800,
    hard_constraints: ["stay within cognition boundary", "do not overwrite formal text"],
    gaps: [],
  }
}

function createDeps(options?: {
  reviewResults?: NovelReviewResult[]
  gateSummary?: GateSummary
  responses?: string[]
}): DeepChapterGenerationDeps {
  const responses = [...(options?.responses ?? [
    "task brief",
    chapterText("draft body"),
    chapterText("final polished body"),
  ])]

  return {
    buildContextPack: vi.fn(async () => contextPack),
    buildContextPackEnvelope: vi.fn(async () => ({
      pack: contextPack,
      assembly: createContextAssemblyResult(),
    })),
    contextPackToPrompt: vi.fn(() => "CONTEXT"),
    reviewChapter: vi.fn(async () => options?.reviewResults ?? []),
    runDecisionGates: vi.fn(async () => options?.gateSummary ?? createGateSummary()),
    streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onToken(responses.shift() ?? "")
      callbacks.onDone()
    }),
  }
}

describe("runDeepChapterGeneration", () => {
  it("keeps the feature enabled behind the current switch contract", () => {
    expect(shouldUseDeepChapterGeneration({ intent: "write_chapter", confidence: 1, extractedParams: {} }, true)).toBe(true)
    expect(shouldUseDeepChapterGeneration({ intent: "write_chapter", confidence: 1, extractedParams: {} }, false)).toBe(false)
    expect(shouldUseDeepChapterGeneration(null, true)).toBe(true)
  })

  it("publishes task id and context assembly in the first checkpoint", async () => {
    const deps = createDeps()
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      },
      deps,
    )

    expect(result.revised).toBe(false)
    expect(result.gateSummary.all_passed).toBe(true)
    expect(checkpoints[0]).toMatchObject({
      stage: "after_context",
      taskId: "tsk-ch001-chapter-request-1",
      contextAssembly: {
        task_id: "ctx-ch001",
        token_budget: 14000,
      },
    })
  })

  it("revises once when review findings block the draft", async () => {
    let gateCallCount = 0
    const deps = createDeps({
      reviewResults: [{
        severity: "error",
        type: "plot",
        message: "Missing carry-over from previous hook",
        evidence: "draft body",
        relatedMemory: "previous chapter ending",
        suggestion: "Add the hook continuation.",
      }],
      responses: [
        "task brief",
        chapterText("draft body"),
        chapterText("revised body"),
        chapterText("final polished body"),
      ],
    })
    vi.mocked(deps.runDecisionGates).mockImplementation(async () => {
      gateCallCount += 1
      if (gateCallCount === 1) {
        return createGateSummary({
          all_passed: false,
          gate_results: {
            consistency: {
              gate_type: "consistency",
              status: "failed",
              score: 61,
              finding_count: 1,
              retry_count: 1,
              mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
              semantic_findings: [],
              findings_desc: ["- [error] Canon conflict"],
            },
          },
          total_retries: 1,
          max_retry: 3,
        })
      }
      return createGateSummary()
    })

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {},
      deps,
    )

    expect(result.revised).toBe(true)
    expect(result.finalContent).toContain("final polished body")
    expect(deps.streamChat).toHaveBeenCalledTimes(5)
    expect(deps.runDecisionGates).toHaveBeenCalledTimes(3)
  })

  it("aligns final review results with the final gate authority", async () => {
    let gateCallCount = 0
    const deps = createDeps({
      reviewResults: [
        {
          severity: "error",
          type: "setting",
          message: "旧审查提示设定需要人工复核",
          evidence: "draft body",
          relatedMemory: "canon://setting",
          suggestion: "人工确认",
        },
        {
          severity: "warning",
          type: "style",
          message: "句子略长",
          evidence: "draft body",
          relatedMemory: "",
          suggestion: "适度拆句",
        },
      ],
      responses: [
        "task brief",
        chapterText("draft body"),
        chapterText("final polished body"),
      ],
    })
    vi.mocked(deps.runDecisionGates).mockImplementation(async () => {
      gateCallCount += 1
      if (gateCallCount === 1) {
        return createGateSummary({
          all_passed: true,
          gate_results: {
            consistency: {
              gate_type: "consistency",
              status: "passed",
              score: 100,
              finding_count: 0,
              retry_count: 0,
              mechanical_findings: [],
              semantic_findings: [],
              findings_desc: [],
            },
            anti_ai: {
              gate_type: "anti_ai",
              status: "passed",
              score: 98,
              finding_count: 0,
              retry_count: 0,
              mechanical_findings: [],
              semantic_findings: [],
              findings_desc: [],
            },
            quality: {
              gate_type: "quality",
              status: "warning",
              score: 84,
              finding_count: 1,
              retry_count: 0,
              mechanical_findings: [{ severity: "warning", description: "句子略长", location: null, suggestion: "适度拆句" }],
              semantic_findings: [],
              findings_desc: ["- [warning] 句子略长"],
            },
          },
          total_retries: 0,
          max_retry: 3,
        })
      }
      return createGateSummary({
        all_passed: true,
        gate_results: {
          consistency: {
            gate_type: "consistency",
            status: "passed",
            score: 100,
            finding_count: 0,
            retry_count: 0,
            mechanical_findings: [],
            semantic_findings: [],
            findings_desc: [],
          },
          anti_ai: {
            gate_type: "anti_ai",
            status: "passed",
            score: 98,
            finding_count: 0,
            retry_count: 0,
            mechanical_findings: [],
            semantic_findings: [],
            findings_desc: [],
          },
          quality: {
            gate_type: "quality",
            status: "warning",
            score: 84,
            finding_count: 1,
            retry_count: 0,
            mechanical_findings: [{ severity: "warning", description: "句子略长", location: null, suggestion: "适度拆句" }],
            semantic_findings: [],
            findings_desc: ["- [warning] 句子略长"],
          },
        },
        total_retries: 0,
        max_retry: 3,
      })
    })

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {},
      deps,
    )

    expect(result.reviewResults).toEqual([
      expect.objectContaining({
        severity: "warning",
        type: "style",
        message: "句子略长",
      }),
    ])
  })

  it("raises manual review after three failed repair loops", async () => {
    const failingGateSummary = createGateSummary({
      all_passed: false,
      gate_results: {
        consistency: {
          gate_type: "consistency",
          status: "failed",
          score: 61,
          finding_count: 1,
          retry_count: 3,
          mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
          semantic_findings: [],
          findings_desc: ["- [error] Canon conflict"],
        },
      },
      total_retries: 3,
      max_retry: 3,
    })
    const deps = createDeps({
      gateSummary: failingGateSummary,
      responses: [
        "task brief",
        chapterText("draft body"),
        chapterText("retry body one"),
        chapterText("retry body two"),
        chapterText("retry body three"),
      ],
    })

    await expect(runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {},
      deps,
    )).rejects.toThrow("MANUAL_REVIEW_REQUIRED")

    expect(deps.streamChat).toHaveBeenCalledTimes(6)
    expect(deps.runDecisionGates).toHaveBeenCalledTimes(4)
  })

  it("persists max retry in the final checkpoint when manual review is required", async () => {
    const gateSummaries = [
      createGateSummary({
        all_passed: false,
        gate_results: {
          consistency: {
            gate_type: "consistency",
            status: "failed",
            score: 61,
            finding_count: 1,
            retry_count: 1,
            mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
            semantic_findings: [],
            findings_desc: ["- [error] Canon conflict"],
          },
        },
        total_retries: 1,
        max_retry: 3,
      }),
      createGateSummary({
        all_passed: false,
        gate_results: {
          consistency: {
            gate_type: "consistency",
            status: "failed",
            score: 61,
            finding_count: 1,
            retry_count: 1,
            mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
            semantic_findings: [],
            findings_desc: ["- [error] Canon conflict"],
          },
        },
        total_retries: 1,
        max_retry: 3,
      }),
      createGateSummary({
        all_passed: false,
        gate_results: {
          consistency: {
            gate_type: "consistency",
            status: "failed",
            score: 61,
            finding_count: 1,
            retry_count: 1,
            mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
            semantic_findings: [],
            findings_desc: ["- [error] Canon conflict"],
          },
        },
        total_retries: 1,
        max_retry: 3,
      }),
      createGateSummary({
        all_passed: false,
        gate_results: {
          consistency: {
            gate_type: "consistency",
            status: "failed",
            score: 61,
            finding_count: 1,
            retry_count: 1,
            mechanical_findings: [{ severity: "error", description: "Canon conflict", location: "paragraph 2", suggestion: "Fix canon" }],
            semantic_findings: [],
            findings_desc: ["- [error] Canon conflict"],
          },
        },
        total_retries: 1,
        max_retry: 3,
      }),
    ]
    const checkpoints: DeepChapterGenerationResumeCheckpoint[] = []
    const deps = createDeps({
      responses: [
        "task brief",
        chapterText("draft body"),
        chapterText("retry body one"),
        chapterText("retry body two"),
        chapterText("retry body three"),
      ],
    })
    vi.mocked(deps.runDecisionGates).mockImplementation(async () => gateSummaries.shift() ?? createGateSummary())

    await expect(runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      },
      deps,
    )).rejects.toThrow("MANUAL_REVIEW_REQUIRED")

    const finalCheckpoint = checkpoints[checkpoints.length - 1]
    expect(finalCheckpoint?.stage).toBe("after_revision")
    expect(finalCheckpoint?.gateSummary?.total_retries).toBe(3)
    expect(finalCheckpoint?.gateSummary?.gate_results.consistency.retry_count).toBe(3)
  })

  it("resumes from a saved review checkpoint without rerunning earlier stages", async () => {
    const deps = createDeps({
      responses: [chapterText("final polished body")],
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "chapter-request-1",
      taskId: "tsk-ch001-chapter-request-1",
      chapterNumber: 1,
      stage: "after_review",
      contextAssembly: createContextAssemblyResult(),
      taskBrief: "task brief",
      draftContent: chapterText("draft body"),
      reviewResults: [],
      gateSummary: createGateSummary(),
    }

    const result = await runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
        resumeCheckpoint: checkpoint,
      },
      {},
      deps,
    )

    expect(result.revised).toBe(false)
    expect(deps.streamChat).toHaveBeenCalledTimes(1)
    expect(deps.reviewChapter).not.toHaveBeenCalled()
    expect(deps.runDecisionGates).toHaveBeenCalledTimes(1)
  })

  it("stops before review when the user aborts during draft generation", async () => {
    const controller = new AbortController()
    let callIndex = 0
    const deps: DeepChapterGenerationDeps = {
      buildContextPack: vi.fn(async () => contextPack),
      buildContextPackEnvelope: vi.fn(async () => ({
        pack: contextPack,
        assembly: createContextAssemblyResult(),
      })),
      contextPackToPrompt: vi.fn(() => "CONTEXT"),
      reviewChapter: vi.fn(async () => []),
      runDecisionGates: vi.fn(async () => createGateSummary()),
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callIndex += 1
        callbacks.onToken(callIndex === 1 ? "task brief" : chapterText("draft body"))
        if (callIndex === 2) controller.abort()
        callbacks.onDone()
      }),
    }

    await expect(runDeepChapterGeneration(
      {
        projectPath: "E:/Novel",
        userRequest: "chapter-request-1",
        chapterNumber: 1,
        llmConfig,
      },
      {},
      deps,
      controller.signal,
    )).rejects.toThrow("已停止生成")

    expect(deps.reviewChapter).not.toHaveBeenCalled()
    expect(deps.runDecisionGates).not.toHaveBeenCalled()
  })
})
