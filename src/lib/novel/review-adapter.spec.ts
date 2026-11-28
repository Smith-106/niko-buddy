import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import type { ChapterSnapshot } from "./chapter-ingest"
import { buildReviewPrompt, buildCanonModalityContext, clampReviewStageTimeoutMs, ReviewParseError, REVIEW_STAGE_TIMEOUT_DEFAULT_MS, reviewChapter, resolveReviewGateKey, runAuditTriadPreflight, runContinuityMechanicalPreflight, CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES, CORR108_LEGACY_ANTI_AI_REVIEW_TYPES } from "./review-adapter"
import type { NovelReviewResult } from "./review-adapter"
import { ALL_AUDIT_DIMENSION_IDS, AUDIT_TAXONOMY, type AuditDimensionId } from "./audit-taxonomy"
import { buildDecisionGates } from "./deep-chapter-decision-gates"
import type { TemporalFact } from "./temporal-memory"

const mocks = vi.hoisted(() => ({
  resolveNovelModelMock: vi.fn((config: LlmConfig) => config),
  streamChatMock: vi.fn(),
  collectContinuityMetricMock: vi.fn(),
  fsWriteFileAtomicMock: vi.fn(async () => undefined),
  fsCreateDirectoryMock: vi.fn(async () => undefined),
  fsFileExistsMock: vi.fn(async () => false),
  auditFindingsOverride: undefined as unknown,
  // C1 真接线 (ISS-20260719-002) 后 reviewChapter 无条件真实执行
  // runContinuityMechanicalPreflight：node 测试环境无 tauri invoke，loader 的
  // readFile 会抛 ReferenceError(window is not defined)，loadCharacterStates 对
  // 非-ENOENT 错误 rethrow → preflight catch → 每次审稿都产 engine_error warning
  // 污染结果。修复：mock readFile 抛 ENOENT（模拟 E:/Novel 首运行空项目），让
  // 4 个 loader 走正常降级返空 store，checkContinuity 与短路语义真实可达。
  fsReadFileMock: vi.fn<(path: string) => Promise<string>>(async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
    err.code = "ENOENT"
    throw err
  }),
  // REV-CE-003 test-gen: checkContinuityMock 用于驱动 review-adapter production path
  // 的 critical 短路分支 (review-adapter.ts:430-432) + toConsistencyReviewResult 非空
  // findings 调用 (review-adapter.ts:351)。production path 调 checkContinuity (ADR-29
  // 权威 API, 经 buildReadonlyStoreFromInput 转 store)。默认调用真实 checkContinuity
  // (via vi.importActual in factory), 仅在 continuityFindingsOverride 非 undefined
  // 时覆写。
  checkContinuityMock: vi.fn(),
  continuityFindingsOverride: undefined as unknown,
  // engine-degraded path: checkContinuity 抛错 → runContinuityMechanicalPreflight catch
  // (review-adapter.ts:396-409) 产 engine_error warning。
  continuityThrow: undefined as unknown,
  // preflight snapshots-load path (review-adapter.ts:311-312): listSnapshots/loadSnapshot
  // 来自 ./chapter-ingest — 默认返空 (ENOENT 语义), 测试注入 [1,2] 让 map/filter 执行。
  listSnapshotsMock: vi.fn<(projectPath: string) => Promise<number[]>>(async () => []),
  loadSnapshotMock: vi.fn<(projectPath: string, chapterNumber: number) => Promise<ChapterSnapshot | null>>(async () => null),
  // override store 降级 (review-adapter.ts:329-333): loadContinuityOverrides 抛错 → catch。
  overrideLoadError: undefined as unknown,
  // character-aura 重匹配 (review-adapter.ts:507-513): 返回新光环替换 contextPack / 抛错降级。
  buildCharacterAuraContextMock: vi.fn<
    (projectPath: string, task: string, options?: { matchingText?: string }) => Promise<string | null>
  >(async () => null),
  // hasUsableLlm 可控 (review-adapter.ts:435): 默认可用, 测试置 false 驱动早退。
  llmUsable: true,
  // override store 非空 payload (review-adapter.ts:327 假分支 + :342 真分支)。
  overrideStorePayload: undefined as unknown,
  // slop 阻断 (review-adapter.ts:444): classifySlop === "block" → 短路返 anti_ai error。
  slopBlock: false,
  // 角色行为模式 (review-adapter.ts:461): detectCharacterActions/characterActionsToText 覆写。
  actionHitsOverride: undefined as unknown,
  actionTextOverride: undefined as unknown,
  novelConfig: { reviewModel: "", reviewReasoningEffort: "high" as "low" | "medium" | "high" },
  llmConfig: {
    provider: "custom" as const,
    apiKey: "test-key",
    model: "test-review-model",
    ollamaUrl: "",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 120000,
    reasoning: { mode: "auto" as const },
  },
  contextPack: {
    task: "审稿第8章",
    chapterGoal: "第8章目标：主角按照章纲进入祠堂，发现族谱被改动。",
    outline: "总大纲：主线围绕族谱秘密推进。\n第8章章纲：进入祠堂，发现族谱异常。",
    recentSummaries: ["第6章：主角得到旧钥匙。", "第7章：主角抵达村口。"],
    previousChapterEnding: "祠堂门缝里透出一线冷光。",
    characterStates: "主角谨慎，小晴仍然隐瞒她知道族谱。 ",
    soulDoc: "项目灵魂：悬疑、克制、现实压力。",
    characterAuras: "主角表达克制，不会突然热血喊口号。",
    cognitionStates: "主角不知道族谱已经被人换过。",
    foreshadowingStates: "旧钥匙、族谱缺页、门缝冷光都未回收。",
    timeline: "雨夜，进入祠堂前后不超过一小时。",
    relatedSettings: "祠堂位于村东，只有一扇正门。",
    canonRules: "不能提前揭露小晴真实身份。",
    writingStyle: "短句、悬疑、画面感。",
    searchResults: "相关记忆：旧钥匙来自第6章。",
    graphSearchResults: "旧钥匙 -> 祠堂 -> 族谱缺页。",
    mustDo: "必须承接门缝冷光并推进族谱异常。",
    mustAvoid: "不能让主角凭空知道族谱被换。",
    nextChapterAdvice: "下一章继续追查族谱缺页。",
    revisionDirectives: "上一轮反馈：避免重复解释。",
  },
}))

const streamChatMock = mocks.streamChatMock
const llmConfig = mocks.llmConfig as LlmConfig
const contextPack = mocks.contextPack satisfies ContextPack

vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    readFile: mocks.fsReadFileMock,
    writeFileAtomic: mocks.fsWriteFileAtomicMock,
    createDirectory: mocks.fsCreateDirectoryMock,
    fileExists: mocks.fsFileExistsMock,
  }
})

vi.mock("./process-library", async () => {
  const actual = await vi.importActual<typeof import("./process-library")>("./process-library")
  return {
    ...actual,
    auditChapter: async (
      projectPath: string,
      chapterNumber: number,
      presentCharacters: string[],
      presentItems: string[],
      presentParticles: Record<string, string[]> | undefined,
      options?: Parameters<typeof actual.auditChapter>[5],
    ) => {
      if (mocks.auditFindingsOverride !== undefined) {
        return { findings: mocks.auditFindingsOverride }
      }
      return actual.auditChapter(projectPath, chapterNumber, presentCharacters, presentItems, presentParticles, options)
    },
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: mocks.streamChatMock,
      // TASK-010: collectContinuityMetric mirror — 薄包装层调, 可断言 readOnly 跳过 metric 写盘
      collectContinuityMetric: mocks.collectContinuityMetricMock,
      extractJsonArraySpan: (text: string): string | null => {
        // Mirror real implementation for test use.
        const fenceMatch = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/)
        const cleaned = fenceMatch ? fenceMatch[1].trim() : text.trim()
        const end = cleaned.lastIndexOf("]")
        if (end === -1) return null
        let depth = 0
        for (let i = end; i >= 0; i -= 1) {
          const ch = cleaned[i]
          if (ch === "]") depth += 1
          else if (ch === "[") {
            depth -= 1
            if (depth === 0) return cleaned.slice(i, end + 1)
          }
        }
        const greedy = cleaned.match(/\[[\s\S]*\]/)
        return greedy ? greedy[0] : null
      },
    
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: {
        getState: () => ({
          llmConfig,
          novelConfig: mocks.novelConfig,
          novelMode: true,
        }),
      },
    
  }
})

vi.mock("@/lib/has-usable-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/has-usable-llm")>()
  return {
    ...actual,
      hasUsableLlm: () => mocks.llmUsable,
    
  }
})

vi.mock("./model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-resolver")>()
  return {
    ...actual,
    resolveNovelModel: (config: LlmConfig, novelConfig: NovelConfig, task: string) =>
      (mocks.resolveNovelModelMock as (c: LlmConfig, n: NovelConfig, t: string) => LlmConfig)(config, novelConfig, task),
  }
})

// REV-CE-003 test-gen: partial mock for ./deterministic-continuity-engine。
// PAT-G2 spec-mock mirror: factory spreads real module (via vi.importActual) so
// 全部 export 透传, only checkContinuity is wrapped (production path 迁移后调
// checkContinuity + buildReadonlyStoreFromInput, legacy runContinuityEngine 不在
// production path)。默认透传真实行为 (continuityFindingsOverride undefined → 调真实
// checkContinuity), 仅 critical 短路测试设 continuityFindingsOverride 强制返 critical
// finding 驱动 :430-432 分支。buildReadonlyStoreFromInput / DEFAULT_CONTINUITY_CONFIG
// 经 ...actual 透传 (PAT-G2 mirror 全 export)。
vi.mock("./deterministic-continuity-engine", async () => {
  const actual = await vi.importActual<typeof import("./deterministic-continuity-engine")>(
    "./deterministic-continuity-engine",
  )
  return {
    ...actual,
    checkContinuity: mocks.checkContinuityMock.mockImplementation((store, config, overrideStore) => {
      if (mocks.continuityThrow !== undefined) throw mocks.continuityThrow
      if (mocks.continuityFindingsOverride !== undefined) {
        return mocks.continuityFindingsOverride
      }
      return actual.checkContinuity(store, config, overrideStore)
    }),
  }
})

// C1 真接线后 preflight 的 listSnapshots/loadSnapshot 走真实 ./chapter-ingest import
// (node 测试环境 ENOENT → 空)。此处替换为可控 mock: 默认返空 (行为等价),
// snapshots-load 测试注入 [1,2] 驱动 review-adapter.ts:311-312 的 map/filter。
vi.mock("./chapter-ingest", () => ({
  listSnapshots: (projectPath: string) => mocks.listSnapshotsMock(projectPath),
  loadSnapshot: (projectPath: string, chapterNumber: number) => mocks.loadSnapshotMock(projectPath, chapterNumber),
}))

// G3 override 读端降级 (AC-006.5): 默认返空 store (等价真实 loader 的 ENOENT 降级),
// 测试注入 overrideLoadError 驱动 review-adapter.ts:329-333 catch。
vi.mock("./continuity-overrides-store", () => ({
  loadContinuityOverrides: () => {
    if (mocks.overrideLoadError !== undefined) throw mocks.overrideLoadError
    return mocks.overrideStorePayload !== undefined ? mocks.overrideStorePayload : { overrides: [] }
  },
}))

// 审稿前角色光环重匹配 (review-adapter.ts:502-514): 默认返 null (沿用阶段1光环),
// 测试注入替换光环 (508-509) 或抛错 (511-513 catch)。
vi.mock("./character-aura", () => ({
  buildCharacterAuraContext: (projectPath: string, task: string, options?: { matchingText?: string }) =>
    mocks.buildCharacterAuraContextMock(projectPath, task, options),
}))

// A19 机械层 (slop + 行为模式): 默认透传真实实现, 仅注入 flag 时覆写以驱动
// review-adapter.ts:444 (slop block 短路) + :461 (行为模式 message 构造)。
vi.mock("./mechanical-slop-detector", async () => {
  const actual = await vi.importActual<typeof import("./mechanical-slop-detector")>("./mechanical-slop-detector")
  return {
    ...actual,
    slopScore: (content: string) =>
      mocks.slopBlock
        ? ({ slopPenalty: 9.4 } as unknown as ReturnType<typeof actual.slopScore>)
        : actual.slopScore(content),
    classifySlop: (report: unknown) => (mocks.slopBlock ? "block" : actual.classifySlop(report as never)),
    slopReportToText: (report: unknown) => (mocks.slopBlock ? "机械 slop 文本" : actual.slopReportToText(report as never)),
    detectCharacterActions: (content: string, characterNames?: readonly string[]) =>
      mocks.actionHitsOverride !== undefined ? mocks.actionHitsOverride : actual.detectCharacterActions(content, characterNames),
    characterActionsToText: (hits: unknown) =>
      mocks.actionTextOverride !== undefined ? mocks.actionTextOverride : actual.characterActionsToText(hits as never),
  }
})

vi.mock("./context-engine", () => ({
  buildContextPack: vi.fn(async () => mocks.contextPack),
  contextPackToPrompt: (pack: ContextPack) => [
    `当前任务：${pack.task}`,
    `当前章节目标：${pack.chapterGoal}`,
    `大纲要求：${pack.outline}`,
    `最近剧情摘要：${pack.recentSummaries.join(" / ")}`,
    `上一章结尾：${pack.previousChapterEnding}`,
    `当前人物状态：${pack.characterStates}`,
    `角色认知状态：${pack.cognitionStates}`,
    `当前伏笔状态：${pack.foreshadowingStates}`,
    `时间线：${pack.timeline}`,
    `相关记忆检索：${pack.searchResults}`,
    `图谱检索：${pack.graphSearchResults}`,
    `修改反馈：${pack.revisionDirectives}`,
  ].join("\n"),
}))

describe("review-adapter staged review", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    llmConfig.reasoning = { mode: "auto" }
    mocks.novelConfig.reviewReasoningEffort = "high"
  })

  it("builds a staged deep review prompt with outline, memory, foreshadowing, and cognition checks", () => {
    const prompt = buildReviewPrompt(contextPack, "主角直接说出族谱被换。")

    expect(prompt).toContain("阶段1：审查任务识别")
    expect(prompt).toContain("阶段2：上下文检索")
    expect(prompt).toContain("阶段3：章节目标对齐")
    expect(prompt).toContain("阶段4：事实与记忆核对")
    expect(prompt).toContain("阶段5：逐维度审查")
    expect(prompt).toContain("阶段6：阻断判定")
    expect(prompt).toContain("阶段7：二次复核")
    expect(prompt).toContain("高级 thinking")
    expect(prompt).toContain("角色认知状态：主角不知道族谱已经被人换过。")
    expect(prompt).toContain("当前伏笔状态：旧钥匙、族谱缺页、门缝冷光都未回收。")
  })

  it("runs a single merged deep review with high reasoning and publishes thinking", async () => {
    llmConfig.reasoning = { mode: "off" }
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      const prompt = messages.map((message) => message.content).join("\n")
      if (prompt.includes("最终审查 JSON")) {
        callbacks.onToken(JSON.stringify([{
          severity: "error",
          type: "cognition",
          message: "主角知道了不该知道的信息。",
          evidence: "主角直接说出族谱被换。",
          relatedMemory: "角色认知状态：主角不知道族谱已经被人换过。",
          suggestion: "改为通过族谱缺页和行为细节推断异常。",
        }]))
      } else {
        callbacks.onToken("阶段分析完成")
      }
      callbacks.onDone()
    })

    const thinking: string[] = []
    const results = await reviewChapter(
      "E:/Novel",
      "主角直接说出族谱被换。",
      8,
      { onThinking: (content) => thinking.push(content) },
    )

    // 4 次串行审稿已合并为 1 次（阶段1-7 + 全维度走在同一次高级 thinking 里）
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock.mock.calls.every((call) => call[4]?.reasoning?.mode === "high")).toBe(true)
    expect(thinking.join("\n")).toContain("深度审查")
    expect(results).toEqual([{
      severity: "error",
      type: "cognition",
      message: "主角知道了不该知道的信息。",
      evidence: "主角直接说出族谱被换。",
      relatedMemory: "角色认知状态：主角不知道族谱已经被人换过。",
      suggestion: "改为通过族谱缺页和行为细节推断异常。",
    }])
  })

  it("reuses a provided contextPack instead of building one", async () => {
    const { buildContextPack } = await import("./context-engine")
    vi.mocked(buildContextPack).mockClear()
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter(
      "E:/Novel",
      "测试正文",
      8,
      { contextPack },
    )

    expect(buildContextPack).not.toHaveBeenCalled()
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("passes the provided abort signal into the merged review streaming", async () => {
    const controller = new AbortController()
    const receivedSignals: Array<AbortSignal | undefined> = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
      signal?: AbortSignal,
    ) => {
      receivedSignals.push(signal)
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter(
      "E:/Novel",
      "测试正文",
      8,
      undefined,
      controller.signal,
    )

    expect(streamChatMock).toHaveBeenCalledTimes(1)
    // 审稿使用“外部停止信号 + 超时信号”的组合信号；
    // 外部信号中止后，传入流式审稿的组合信号必须立即中止。
    for (const signal of receivedSignals) {
      expect(signal).toBeDefined()
      expect(signal?.aborted).toBe(false)
    }
    controller.abort()
    for (const signal of receivedSignals) {
      expect(signal?.aborted).toBe(true)
    }
  })

  it("extracts the final JSON array even when the model streams analysis prose, citations and fenced JSON first", async () => {
    // 单次合并审稿里模型常先输出分析文字（含 [1] 之类括号引用）再给 JSON，
    // extractJsonArray 必须从末尾配平括号、只取最后那个完整数组。
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("逐维度审查完成，认知维度发现问题[见证据1]，时间线维度 pass。\n最终审查 JSON：\n")
      callbacks.onToken('```json\n[{"severity":"error","type":"cognition","message":"主角提前知道族谱被换","evidence":"主角直接说出族谱被换","relatedMemory":"主角不知道族谱已被换","suggestion":"改为推断"}]\n```')
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([{
      severity: "error",
      type: "cognition",
      message: "主角提前知道族谱被换",
      evidence: "主角直接说出族谱被换",
      relatedMemory: "主角不知道族谱已被换",
      suggestion: "改为推断",
    }])
  })

  it("no JSON array → ReviewParseError surfaced to caller", async () => {
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("逐维度审查完成，未发现需要返修的阻断问题。")
      callbacks.onDone()
    })

    await expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toMatchObject({
      name: "ReviewParseError",
      message: expect.stringContaining("did not return a JSON array"),
    })
  })

  it("ISS-20260711-001: retries re-asking the model when a chunk returns no JSON array before giving up", async () => {
    // Previously extractJsonArray==null threw immediately with zero retry
    // because the parse ran in the caller after runReviewStage returned.
    // Now parse lives inside runReviewStage and a null-JSON response retriggers
    // the stream up to 2× (3 calls total) before surfacing the error.
    vi.useFakeTimers()
    try {
      let calls = 0
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
      ) => {
        calls += 1
        callbacks.onToken("# 第16章 标题\n\n正文 markdown，没有 JSON 数组。")
        callbacks.onDone()
      })
      const pending = expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toMatchObject({
        name: "ReviewParseError",
        message: expect.stringContaining("did not return a JSON array"),
      })
      await vi.runAllTimersAsync()
      await pending
      expect(streamChatMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("#7: 内部 5 分钟阶段超时被归一为可读超时错误，不再误报 Request cancelled", async () => {
    // streamChat 只看到组合信号中止，会上报 "Request cancelled"（AbortError）。
    // 若无 #7 归一化，日志会先出现「被取消」再出现重试，造成「被取消却又重跑」的困惑。
    // 归一化后应抛出明确的中文超时错误，且不含 "Request cancelled"。
    vi.useFakeTimers()
    try {
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
      ) => {
        // 先让 5 分钟内部计时器触发（置位 stageTimedOut 并 abort 组合信号），
        // 再模拟 streamChat 只看到信号中止而误报 AbortError。
        await new Promise<void>((resolve) => setTimeout(resolve, 300000))
        callbacks.onError(Object.assign(new Error("Request cancelled"), { name: "AbortError" }))
      })
      const pending = expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toThrow(
        /超过 5 分钟未完成，已超时/,
      )
      await vi.runAllTimersAsync()
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it("#7: 用户主动取消仍抛「已停止生成」，不被超时归一化吞掉", async () => {
    const controller = new AbortController()
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      controller.abort()
      callbacks.onError(Object.assign(new Error("Request cancelled"), { name: "AbortError" }))
    })
    await expect(reviewChapter("E:/Novel", "正文", 8, { contextPack }, controller.signal)).rejects.toThrow(
      "已停止生成",
    )
  })

  it("propagates stream failures instead of silently degrading to an empty review result", async () => {
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onError(new Error("review stream hung"))
    })

    await expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toThrow("review stream hung")
  })

  it("uses the configured review reasoning effort instead of forcing high", async () => {
    mocks.novelConfig.reviewReasoningEffort = "low"
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock.mock.calls.every((call) => call[4]?.reasoning?.mode === "low")).toBe(true)
  })

  it("starts the merged review already aborted when the stop signal fired beforehand", async () => {
    const controller = new AbortController()
    controller.abort()
    const receivedSignals: Array<AbortSignal | undefined> = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
      signal?: AbortSignal,
    ) => {
      receivedSignals.push(signal)
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter(
      "E:/Novel",
      "测试正文",
      8,
      undefined,
      controller.signal,
    ).catch(() => undefined)

    for (const signal of receivedSignals) {
      expect(signal?.aborted).toBe(true)
    }
  })

  it("分段审查回调检查点处 signal 已中止 → 抛已停止生成 (L534)", async () => {
    // 在 L516 检查点之后、分段回调 L534 之前同步中止：
    // 用 reviewReasoningEffort getter 副作用在 L519 求值时 abort。
    const controller = new AbortController()
    const original = mocks.novelConfig.reviewReasoningEffort
    Object.defineProperty(mocks.novelConfig, "reviewReasoningEffort", {
      configurable: true,
      get: () => {
        controller.abort()
        return "high"
      },
    })
    try {
      await expect(
        reviewChapter("E:/Novel", "正文", 8, undefined, controller.signal),
      ).rejects.toThrow("已停止生成")
      // 中止发生在 streamChat 之前 → LLM 不应被调用
      expect(streamChatMock).not.toHaveBeenCalled()
    } finally {
      delete (mocks.novelConfig as { reviewReasoningEffort?: string }).reviewReasoningEffort
      mocks.novelConfig.reviewReasoningEffort = original
    }
  })
})

// ============================================================================
// REV-CE-003 test-gen: toConsistencyReviewResult production-path 接线覆盖
// ============================================================================
// 本次 gapfix (175bdbe) 删 review-adapter 内联 continuityFindingToReviewResult 改调
// engine export toConsistencyReviewResult。函数行为已有 deterministic-continuity-engine
// .spec.ts 4 个单元测试覆盖, 但 review-adapter production path 调用点 (review-adapter.ts
// :351) + critical 短路分支 (:430-432 Consistency P0 门控) 需独立接线测试。守 fix-don't-
// hide: 不 mock toConsistencyReviewResult 自身, 只覆写 checkContinuity 驱动 preflight
// 拿到非空 critical findings, 让 toConsistencyReviewResult 走真实 production path。
  it("onSemanticReviewCompleted fires for a complete [] review but not for incomplete findings or truncated windows", async () => {
    const completed = vi.fn()
    const failed = vi.fn()

    // 1) 完整审查（合法空 findings）→ 回调。
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })
    const results = await reviewChapter("E:/Novel", "测试正文", 8, { contextPack, onSemanticReviewCompleted: completed })
    expect(results).toEqual([])
    expect(completed).toHaveBeenCalledTimes(1)

    // 2) findings 缺合法 severity/type → 结果同形，但回调不点。
    completed.mockClear()
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify([{ severity: "notice", message: "x" }]))
      callbacks.onDone()
    })
    await reviewChapter("E:/Novel", "测试正文", 8, { contextPack, onSemanticReviewCompleted: failed })
    expect(failed).not.toHaveBeenCalled()

    // 3) 配置短窗（REVIEW_CHAPTER_MAX_CHARS 地板 2000 < 分块 8k）→ slice 截断 → 回调不点。
    const prevMax = process.env.REVIEW_CHAPTER_MAX_CHARS
    process.env.REVIEW_CHAPTER_MAX_CHARS = "2000"
    try {
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
      ) => {
        callbacks.onToken("[]")
        callbacks.onDone()
      })
      await reviewChapter("E:/Novel", "字".repeat(17_000), 8, { contextPack, onSemanticReviewCompleted: failed })
      expect(failed).not.toHaveBeenCalled()
    } finally {
      if (prevMax === undefined) delete process.env.REVIEW_CHAPTER_MAX_CHARS
      else process.env.REVIEW_CHAPTER_MAX_CHARS = prevMax
    }
  })

describe("REV-CE-003 toConsistencyReviewResult production-path 接线", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    mocks.continuityFindingsOverride = undefined
    mocks.checkContinuityMock.mockClear()
  })

  it("critical 机械 finding 短路 LLM 审查 (Consistency P0 先于 Anti-AI/Quality)", async () => {
    // checkContinuity 返 1 个 dead_character_state critical finding → preflight
    // toConsistencyReviewResult 映射 critical→error → reviewChapter:430 some(r=>r.severity
    // ==='error') 短路 return continuityResults, 不调 streamChat (Consistency P0 先于 LLM)。
    mocks.continuityFindingsOverride = [
      {
        type: "dead_character_state",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: "character:死者",
        message: "死亡角色在第8章仍出现活跃状态变更",
        chapter: 8,
      },
    ]

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    // 短路: streamChat 不被调 (Consistency P0 阻断 approve 不走 LLM 审查)
    expect(streamChatMock).not.toHaveBeenCalled()
    // toConsistencyReviewResult production path: critical→error, type=consistency_mechanical
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe("error")
    expect(results[0].type).toBe("consistency_mechanical")
    expect(results[0].message).toContain("死亡角色")
    // G2 DD-2: evidence 改空字符串 (非 f.ref) — ref 是实体标识非正文片段, 透传到 continuityMeta.ref
    expect(results[0].evidence).toBe("")
    expect(results[0].continuityMeta?.ref).toBe("character:死者")
    expect(results[0].continuityMeta?.subtype).toBe("consistency_mechanical")
    expect(results[0].continuityMeta?.chapter).toBe(8)
    expect(results[0].suggestion).toBeTruthy()
  })

  it("warning 机械 finding 不短路, 走 LLM 审查并合并 mechanical+LLM 结果", async () => {
    // checkContinuity 返 1 个 dormant_thread warning finding → toConsistencyReviewResult
    // 映射 warning→warning (非 error) → 不短路 → 走 LLM 审查 → 合并 mechanical+LLM 结果。
    mocks.continuityFindingsOverride = [
      {
        type: "dormant_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:S1",
        message: "休眠 subplot 5 章未推进",
        chapter: 8,
      },
    ]
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify([{
        severity: "warning",
        type: "cognition",
        message: "LLM 审查发现认知问题",
        evidence: "证据",
        relatedMemory: "",
        suggestion: "建议",
      }]))
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    // 不短路: streamChat 被调 (warning 非阻断走 LLM 审查)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    // 合并: mechanical warning (dormant_thread) + LLM warning (cognition) 共 2 条
    expect(results).toHaveLength(2)
    const mechanical = results.find((r) => r.type === "consistency_mechanical")
    expect(mechanical).toBeDefined()
    expect(mechanical?.severity).toBe("warning")
    expect(mechanical?.message).toContain("休眠 subplot")
    const llm = results.find((r) => r.type === "cognition")
    expect(llm).toBeDefined()
  })
})

// ============================================================================
// S3c (roadmap R12): 进程内伪端点契约测试试点 (REV-CE-003 critical 短路)
//
// 参考 (reference/ 只读): studio 互鉴 — 契约测试用进程内伪端点注入, 不引入
// 真实 HTTP 服务。本块定义显式 FakeContinuityEndpoint (进程内注入端点契约),
// 验证 review-adapter 对 continuity 端点的三个契约:
//   ① critical finding → 短路 LLM, 返回 error (Consistency P0 先于 LLM)
//   ② warning finding → 不短路, LLM 合并
//   ③ 契约字段 (ref/subtype/chapter) 透传 continuityMeta
// 伪端点 = 进程内对象, 零网络零遥测 (无外部调用铁律)。
// ============================================================================

describe("S3c 进程内伪端点契约 (REV-CE-003 pilot)", () => {
  // FakeContinuityEndpoint: 进程内伪端点 — 模拟 reviewChapter 的 continuity
  // 依赖面 (runContinuityMechanicalPreflight), 返回结构化 findings 数组。
  // 契约: handle(chapter) → ContinuityFinding[] (与 engine 同构, 非 HTTP)。
  interface FakeContinuityEndpoint {
    handle(chapter: number): Array<{
      type: string
      subtype: string
      severity: string
      ref: string
      message: string
      chapter: number
    }>
  }

  function makeEndpoint(findings: Array<{
    type: string
    subtype: string
    severity: string
    ref: string
    message: string
    chapter: number
  }>): FakeContinuityEndpoint {
    return { handle: () => findings }
  }

  beforeEach(() => {
    streamChatMock.mockReset()
    mocks.continuityFindingsOverride = undefined
    mocks.checkContinuityMock.mockClear()
  })

  it("契约① critical finding 短路 LLM 审查 (P0 先于 P1/P2)", async () => {
    // 伪端点注入: dead_character_state critical → reviewChapter 必须短路
    const endpoint = makeEndpoint([{
      type: "dead_character_state",
      subtype: "consistency_mechanical",
      severity: "critical",
      ref: "character:已故长老",
      message: "已故长老在第8章仍出现活跃状态变更",
      chapter: 8,
    }])
    mocks.continuityFindingsOverride = endpoint.handle(8)

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    // 契约断言: 短路 → streamChat 不被调
    expect(streamChatMock).not.toHaveBeenCalled()
    // critical → error, 单条返回
    expect(results).toHaveLength(1)
    expect(results[0]!.severity).toBe("error")
    expect(results[0]!.type).toBe("consistency_mechanical")
  })

  it("契约② warning finding 不短路, LLM 审查合并", async () => {
    const endpoint = makeEndpoint([{
      type: "dormant_thread",
      subtype: "consistency_mechanical",
      severity: "warning",
      ref: "subplot:权谋线",
      message: "权谋线休眠 6 章未推进",
      chapter: 8,
    }])
    mocks.continuityFindingsOverride = endpoint.handle(8)
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify([{
        severity: "warning",
        type: "cognition",
        message: "LLM 审查发现认知问题",
        evidence: "证据",
        relatedMemory: "",
        suggestion: "建议",
      }]))
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(2)
    expect(results.some((r) => r.type === "consistency_mechanical" && r.severity === "warning")).toBe(true)
    expect(results.some((r) => r.type === "cognition")).toBe(true)
  })

  it("契约③ 字段透传: ref/subtype/chapter 进入 continuityMeta", async () => {
    const endpoint = makeEndpoint([{
      type: "overdue_thread",
      subtype: "consistency_mechanical",
      severity: "critical",
      ref: "subplot:复仇线",
      message: "复仇线逾期 12 章未回收",
      chapter: 8,
    }])
    mocks.continuityFindingsOverride = endpoint.handle(8)

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toHaveLength(1)
    expect(results[0]!.continuityMeta?.ref).toBe("subplot:复仇线")
    expect(results[0]!.continuityMeta?.subtype).toBe("consistency_mechanical")
    expect(results[0]!.continuityMeta?.chapter).toBe(8)
  })
})

// ============================================================================
// 全口径 100% 收口: 剩余可达分支覆盖 (ReviewParseError / 分段 / preflight
// snapshots-load / override 降级 / 引擎降级 / slop 阻断 / 行为模式 / 光环重匹配 /
// reasoning 流 / retry 窗口中止)。不可达分支逐条记录在完成报告。
// ============================================================================

describe("review-adapter — 全口径收口 (可达分支 100%) ", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    mocks.continuityFindingsOverride = undefined
    mocks.continuityThrow = undefined
    mocks.overrideLoadError = undefined
    mocks.overrideStorePayload = undefined
    mocks.llmUsable = true
    mocks.slopBlock = false
    mocks.actionHitsOverride = undefined
    mocks.actionTextOverride = undefined
    mocks.buildCharacterAuraContextMock.mockReset()
    mocks.buildCharacterAuraContextMock.mockResolvedValue(null)
    mocks.listSnapshotsMock.mockReset()
    mocks.listSnapshotsMock.mockResolvedValue([])
    mocks.loadSnapshotMock.mockReset()
    mocks.loadSnapshotMock.mockResolvedValue(null)
    mocks.novelConfig.reviewReasoningEffort = "high"
  })

  it("ReviewParseError 构造器保存 raw + parseMessage (F-003)", () => {
    const err = new ReviewParseError("[bad", "Unexpected token")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ReviewParseError")
    expect(err.raw).toBe("[bad")
    expect(err.parseMessage).toBe("Unexpected token")
    expect(err.message).toContain("Unexpected token")
  })

  it("超长章节 (>8000 字) 分段审查, 每段带分段标题", async () => {
    // 18000 字 → 3 段 (8000/8000/2000), REVIEW_MAX_CHUNKS=3 上限
    const longContent = "第8章 正文内容。".repeat(2000) // 2000 × 9 字 ≈ 18000 字
    const chunkLabels: string[] = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      const prompt = messages.map((m) => m.content).join("\n")
      const label = prompt.match(/【(第\d+段\/共\d+段)】/)?.[1]
      if (label) chunkLabels.push(label)
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", longContent, 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(3)
    expect(chunkLabels).toEqual(["第1段/共3段", "第2段/共3段", "第3段/共3段"])
  })

  it("preflight 加载已存在的 snapshots 用于引擎 fold 反推", async () => {
    mocks.listSnapshotsMock.mockResolvedValue([1, 2])
    mocks.loadSnapshotMock.mockImplementation(async (_pp: string, n: number) => ({
      chapterId: `chapter-${n}`,
      chapterNumber: n,
      summary: "摘要",
      characters: [],
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: [],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
      sourceType: "chapter",
      sourceSequence: n,
      revision: 1,
      snapshotId: `chapter-${n}-r1`,
    }))
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(mocks.listSnapshotsMock).toHaveBeenCalledTimes(1)
    expect(mocks.loadSnapshotMock).toHaveBeenCalledTimes(2)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it("override store 加载失败时降级到 raw findings, 不阻断审查", async () => {
    // 非 Error 抛出值 → catch 内 toErrorMessage(err) 的 String 侧
    mocks.overrideLoadError = "override store corrupt"
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("override store 加载失败(Error 值) 时降级到 raw findings, 不阻断审查", async () => {
    // Error 实例 → catch 内 toErrorMessage(err) 的 err.message 侧
    mocks.overrideLoadError = new Error("override store corrupt")
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("override store 非空时应用 override 双跑, 不阻断审查", async () => {
    mocks.overrideStorePayload = {
      overrides: [{
        ref: "character:死者",
        reasonCode: "intentional_death",
        note: "设计性死亡后回忆出场",
        severity: "critical",
      }],
    }
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("连续性引擎抛错(Error 值) 时降级为单条 engine_error warning, 不阻断审查", async () => {
    // Error 实例 → :396 三元 err.message 侧
    mocks.continuityThrow = new Error("engine boom")
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toHaveLength(1)
    expect(results[0]!.type).toBe("consistency_mechanical")
    expect(results[0]!.severity).toBe("warning")
    expect(results[0]!.message).toContain("连续性引擎执行异常")
    expect(results[0]!.evidence).toBe("engine_error")
  })

  it("连续性引擎抛错(非 Error 值) 时经 String(err) 记录降级", async () => {
    mocks.continuityThrow = "engine boom"
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toHaveLength(1)
    expect(results[0]!.type).toBe("consistency_mechanical")
    expect(results[0]!.evidence).toBe("engine_error")
  })

  it("机械 slop 阻断时短路返回 anti_ai error, 不调 LLM", async () => {
    mocks.slopBlock = true

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.severity).toBe("error")
    expect(results[0]!.type).toBe("anti_ai")
    expect(results[0]!.message).toContain("机械 slop 阻断")
    expect(results[0]!.evidence).toContain("9.4/10")
  })

  it("角色行为模式命中 ≥3 次重复动作时产出 character_behavior warning", async () => {
    mocks.actionHitsOverride = [{ action: "点头", totalCount: 4 }]
    mocks.actionTextOverride = "重复动作清单"
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    const behavior = results.find((r) => r.type === "character_behavior")
    expect(behavior).toBeDefined()
    expect(behavior!.severity).toBe("warning")
    expect(behavior!.message).toContain('"点头"×4')
    expect(behavior!.evidence).toBe("重复动作清单")
  })

  it("审稿前重匹配初稿角色光环并替换 contextPack", async () => {
    mocks.buildCharacterAuraContextMock.mockResolvedValue("主角：克制、寡言（初稿新增光环）")
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "初稿正文：主角在祠堂沉默。", 8, { contextPack })

    // 真实行为模式检测可能对初稿正文产出 character_behavior warning — 不影响光环替换断言
    expect(results).toBeDefined()
    // matchingText 必须包含初稿正文 (补齐新登场角色的光环匹配)
    const callArgs = mocks.buildCharacterAuraContextMock.mock.calls[0]
    const matchingText = String(callArgs[2]?.matchingText ?? "")
    expect(matchingText).toContain("初稿正文：主角在祠堂沉默。")
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("光环重匹配抛错(Error 值) 时沿用阶段1光环继续审查", async () => {
    // Error 实例 → :513 三元 err.message 侧
    mocks.buildCharacterAuraContextMock.mockRejectedValue(new Error("aura boom"))
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("光环重匹配抛错(非 Error 值) 时经 String(err) 记录并沿用阶段1光环", async () => {
    mocks.buildCharacterAuraContextMock.mockRejectedValue("aura boom")
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("模型输出畸形 JSON 数组时经 3 次重试后抛 ReviewParseError (F-003)", async () => {
    vi.useFakeTimers()
    try {
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
      ) => {
        // 数组 span 存在但内容无法 JSON.parse → SyntaxError → ReviewParseError
        callbacks.onToken('[{"severity": ]')
        callbacks.onDone()
      })
      const pending = expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toBeInstanceOf(ReviewParseError)
      await vi.runAllTimersAsync()
      await pending
      expect(streamChatMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reasoning 通道 token 经 thinking publisher 展示", async () => {
    const thinking: string[] = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onReasoningToken?.("分阶段分析：先核对记忆库，再逐维度判定")
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter("E:/Novel", "正文", 8, { onThinking: (content) => thinking.push(content) })

    expect(thinking.join("\n")).toContain("分阶段分析：先核对记忆库")
  })

  it("模型流超时 (5 分钟) 时 timeout 回调中止组合信号", async () => {
    vi.useFakeTimers()
    try {
      // 模拟真实 streamChat: 一直等待组合信号被中止 (5min 超时触发) 后才继续
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
      ) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        callbacks.onToken("[]")
        callbacks.onDone()
      })

      const pending = reviewChapter("E:/Novel", "正文", 8, { contextPack })
      await vi.advanceTimersByTimeAsync(300000)
      const results = await pending
      expect(results).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("重试窗口内用户中止 → combineSignals 立即合并已中止信号", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let calls = 0
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
        _signal?: AbortSignal,
      ) => {
        calls += 1
        if (calls === 1) {
          // 首次无 JSON → runReviewStage catch → 2s 重试延迟
          callbacks.onToken("只有分析文字")
          callbacks.onDone()
        } else {
          // 重试时外部信号已中止: streamChat 收到的是已中止的组合信号,
          // 流结束后 runReviewStage 的 aborted 检查抛 "已停止生成"
          callbacks.onToken("[]")
          callbacks.onDone()
        }
      })

      const pending = reviewChapter("E:/Novel", "正文", 8, { contextPack }, controller.signal).catch((e: unknown) => e)
      // 让首次调用落定并进入 2s 重试延迟
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      // 重试窗口内用户中止
      controller.abort()
      const outcome = await vi.advanceTimersByTimeAsync(5000).then(() => pending)
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe("已停止生成")
    } finally {
      vi.useRealTimers()
    }
  })

  it("LLM 配置不可用时返回空审查结果", async () => {
    mocks.llmUsable = false
    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })
    expect(results).toEqual([])
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("novelMode 关闭时返回空审查结果", async () => {
    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack, novelMode: false })
    expect(results).toEqual([])
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("无章节号时 preflight 早退, 不走 snapshots 加载", async () => {
    const { buildContextPack } = await import("./context-engine")
    vi.mocked(buildContextPack).mockClear()
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    // 不传 chapterNumber 也不传 contextPack → 内部 buildContextPack 走
    // `审稿第${chapterNumber || "?"}章` 的 "?" 分支 + preflight 早退
    const results = await reviewChapter("E:/Novel", "正文")

    expect(results).toEqual([])
    expect(mocks.listSnapshotsMock).not.toHaveBeenCalled()
    expect(buildContextPack).toHaveBeenCalledWith("E:/Novel", "审稿第?章", undefined, {
      novelConfig: undefined,
      llmConfig: undefined,
      novelMode: true,
    })
  })

  it("R2-W09: reviewChapter 未传 contextPack 时向 buildContextPack 透传注入的 novelConfig / llmConfig / novelMode", async () => {
    const { buildContextPack } = await import("./context-engine")
    vi.mocked(buildContextPack).mockClear()
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })
    const injectedLlm = { provider: "openai", apiKey: "sk-di", model: "gpt-4o", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 } as LlmConfig
    const injectedNovel = { ...mocks.novelConfig, searchTopK: 9 } as unknown as NovelConfig
    await reviewChapter("E:/Novel", "正文", 4, {
      llmConfig: injectedLlm,
      novelConfig: injectedNovel,
      novelMode: true,
    })
    expect(buildContextPack).toHaveBeenCalledWith("E:/Novel", "审稿第4章", 4, {
      novelConfig: injectedNovel,
      llmConfig: injectedLlm,
      novelMode: true,
    })
  })

  it("characterOnly 模式使用角色一致性专项提示词", async () => {
    const thinking: string[] = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      const prompt = messages.map((m) => m.content).join("\n")
      expect(prompt).toContain("角色一致性专项审查")
      expect(prompt).toContain("角色提取")
      expect(prompt).not.toContain("阶段1：审查任务识别")
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter("E:/Novel", "正文", 8, { contextPack, characterOnly: true, onThinking: (c) => thinking.push(c) })

    expect(thinking.join("\n")).toContain("角色一致性审查")
  })

  it("characterOnly + 超长章节时使用分段角色审查标题", async () => {
    const thinking: string[] = []
    const longContent = "第8章 正文内容。".repeat(2000)
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter("E:/Novel", longContent, 8, { contextPack, characterOnly: true, onThinking: (c) => thinking.push(c) })

    const joined = thinking.join("\n")
    expect(joined).toContain("角色一致性审查（第1/3段）")
    expect(joined).toContain("角色一致性审查（第3/3段）")
  })

  it("稀疏审查条目使用默认回退值", async () => {
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken(JSON.stringify([{ severity: "warning" }]))
      callbacks.onDone()
    })

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(results).toEqual([{
      severity: "warning",
      type: "unknown",
      message: "",
      evidence: "",
      relatedMemory: "",
      suggestion: "",
    }])
  })

  it("streamChat 抛非 Error 值时经 toError 包装成 Error", async () => {
    vi.useFakeTimers()
    try {
      streamChatMock.mockImplementation(async () => {
        throw "boom-string"
      })
      const pending = expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toThrow("boom-string")
      await vi.runAllTimersAsync()
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it("onError 收到非 Error 值时仅记录 message 不泄漏详情", async () => {
    vi.useFakeTimers()
    try {
      streamChatMock.mockImplementation(async (
        _config: LlmConfig,
        _messages: Array<{ role: string; content: string }>,
        callbacks: StreamCallbacks,
      ) => {
        callbacks.onError("raw-string" as unknown as Error)
      })
      const pending = expect(reviewChapter("E:/Novel", "正文", 8, { contextPack })).rejects.toBeTruthy()
      await vi.runAllTimersAsync()
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it("审稿中途 (preflight 后) 用户中止 → 抛 已停止生成", async () => {
    const controller = new AbortController()
    let releasePreflight!: () => void
    const gate = new Promise<void>((resolve) => {
      releasePreflight = resolve
    })
    // 挂起 preflight 的 snapshots 加载, 让中止发生在审稿中途 (第二个 aborted 检查点)
    mocks.listSnapshotsMock.mockImplementation(async () => {
      await gate
      return []
    })
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    const pending = reviewChapter("E:/Novel", "正文", 8, { contextPack }, controller.signal).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    releasePreflight()
    const outcome = await pending
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe("已停止生成")
  })

  it("config 未配置 reviewReasoningEffort 时回退默认 high", async () => {
    (mocks.novelConfig as { reviewReasoningEffort?: string }).reviewReasoningEffort = undefined
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      _messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock.mock.calls.every((call) => call[4]?.reasoning?.mode === "high")).toBe(true)
  })
})

// ==========================================================================
// T24 (TASK-P3-24): resolveReviewGateKey 改读 T22 GATE_MAPPING（唯一真源）
// ==========================================================================
describe("T24 resolveReviewGateKey — GATE_MAPPING 唯一真源 + CORR-108 legacy 对照", () => {
  it("37 维 id 经 GATE_MAPPING 归门（每门抽代表维验证三门归属）", () => {
    expect(resolveReviewGateKey("timeline_consistency")).toBe("consistency")
    expect(resolveReviewGateKey("subplot_resolution")).toBe("consistency")
    expect(resolveReviewGateKey("slop_mechanical")).toBe("anti_ai")
    expect(resolveReviewGateKey("de_ai_residual")).toBe("anti_ai")
    expect(resolveReviewGateKey("thrill_density")).toBe("quality")
    expect(resolveReviewGateKey("reading_power")).toBe("quality")
  })

  it("normalize 口径与 resolveDecisionGateKey 一致（trim + 大小写不敏感）", () => {
    expect(resolveReviewGateKey("  TIMELINE_CONSISTENCY ")).toBe("consistency")
    expect(resolveReviewGateKey("De_Ai_Residual")).toBe("anti_ai")
  })

  it("CORR-108 legacy alias 集归类不变（历史对照常量保真）", () => {
    for (const type of CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES) {
      expect(resolveReviewGateKey(type)).toBe("consistency")
    }
    for (const type of CORR108_LEGACY_ANTI_AI_REVIEW_TYPES) {
      expect(resolveReviewGateKey(type)).toBe("anti_ai")
    }
  })

  it("legacy alias 与 37 维注册表无冲突碰撞（双真源一致性守卫）", () => {
    const legacyAll = [...CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES, ...CORR108_LEGACY_ANTI_AI_REVIEW_TYPES]
    // 若未来某 legacy alias 升格为 37 维 id，其 GATE_MAPPING 归属必须与 legacy 归类一致
    for (const type of legacyAll) {
      expect(resolveReviewGateKey(type)).toBe(resolveReviewGateKey(type.trim().toLowerCase()))
    }
  })

  it("未知 type 保守缺省 quality（P2 永不覆盖 P0/P1）", () => {
    expect(resolveReviewGateKey("unknown_type")).toBe("quality")
    expect(resolveReviewGateKey("")).toBe("quality")
  })

  // ── P1 behavior routing（2026-11-11）：生产者别名 → 规范维度身份归一 ──────
  // review-adapter 机械层产 raw type `character_behavior`（detectCharacterActions）；
  // T22 注册表里的规范 id 是 `behavioral_repetition`（gate anti_ai，即 P1）。
  // 别名未注册时曾落到 quality 缺省 → P1 finding 混入 P2 计数。
  //
  // 下面两个常量在本 spec 独立硬编码（不遍历实现自带的别名表）：别名必须
  // 非规范，目标必须已注册且归 anti_ai —— 任一侧漂移即红。
  const BEHAVIOR_ALIAS_TYPE = "character_behavior"
  const BEHAVIOR_CANONICAL_TYPE = "behavioral_repetition"

  function finding(overrides: Partial<NovelReviewResult> & { type: string }): NovelReviewResult {
    return {
      severity: "warning",
      message: "问题描述",
      evidence: "正文片段",
      relatedMemory: "",
      suggestion: "修改建议",
      ...overrides,
    }
  }

  describe("P1 behavior routing — character_behavior 经 behavioral_repetition 归 anti_ai", () => {
    it("别名 key 本身未注册 37 维；目标维度已注册且 GATE_MAPPING 归 anti_ai", () => {
      expect(ALL_AUDIT_DIMENSION_IDS as readonly string[]).not.toContain(BEHAVIOR_ALIAS_TYPE)
      expect(ALL_AUDIT_DIMENSION_IDS as readonly string[]).toContain(BEHAVIOR_CANONICAL_TYPE)
      expect(AUDIT_TAXONOMY[BEHAVIOR_CANONICAL_TYPE as AuditDimensionId].gate).toBe("anti_ai")
      // 规范 id 自身直接命中同一条唯一真源路径（GATE_MAPPING 唯一真源，非硬编码门）
      expect(resolveReviewGateKey(BEHAVIOR_CANONICAL_TYPE)).toBe("anti_ai")
    })

    it("character_behavior 及其 normalize 变体解析到 P1(anti_ai)，不再落 Quality 缺省", () => {
      expect(resolveReviewGateKey(BEHAVIOR_ALIAS_TYPE)).toBe("anti_ai")
      expect(resolveReviewGateKey("  Character_Behavior ")).toBe("anti_ai")
      expect(resolveReviewGateKey("CHARACTER_BEHAVIOR")).toBe("anti_ai")
    })

    it("near-miss / 未知 / 既有 legacy alias 归类不变（别名归一不扩大范围）", () => {
      for (const nearMiss of [
        "character_behavior_pattern",
        "character_behaviors",
        "behaviour_repetition",
        "behavior",
        "behavioral_repetition_mechanical",
      ]) {
        expect(resolveReviewGateKey(nearMiss), `near-miss ${nearMiss} 必须仍缺省 quality`).toBe("quality")
      }
      expect(resolveReviewGateKey("")).toBe("quality")
      expect(resolveReviewGateKey("unknown_type")).toBe("quality")
      // 既有 legacy alias 归类逐项不变
      for (const type of CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES) {
        expect(resolveReviewGateKey(type)).toBe("consistency")
      }
      for (const type of CORR108_LEGACY_ANTI_AI_REVIEW_TYPES) {
        expect(resolveReviewGateKey(type)).toBe("anti_ai")
      }
    })

    it("行为 finding 折叠进 anti_ai.findings（不进 quality），raw 字段原样保留", () => {
      const behavior = finding({
        type: BEHAVIOR_ALIAS_TYPE,
        message: '角色行为模式: "点头"×4',
        evidence: "角色行为模式检测:\n- ⚠️ \"点头\" 共 4 次",
        suggestion: "减少重复动作标签, 用差异化微动作替代, 避免角色标签化",
      })
      const gates = buildDecisionGates([behavior], 0)

      expect(gates.anti_ai.findings).toEqual([behavior])
      expect(gates.quality.findings).toEqual([])
      // raw type/severity/evidence/suggestion 一字不改（只改归属，不改 finding）
      const folded = gates.anti_ai.findings[0]!
      expect(folded.type).toBe("character_behavior")
      expect(folded.severity).toBe("warning")
      expect(folded.evidence).toBe(behavior.evidence)
      expect(folded.suggestion).toBe(behavior.suggestion)
      // P1 判 warning，不臆造 pass
      expect(gates.anti_ai.verdict).toBe("warning")
      expect(gates.anti_ai.status).toBe("passed")
      expect(gates.overall).toBe("warning")
    })

    it("tuili：行为 warning 不再计入 P2 warn→fail 计数；加 P0 error 后 overall 仍 fail", () => {
      // 2 条真 Quality warning + 1 条行为 warning，题材 tuili
      // （Quality 升级阈值 DEFAULT_UPGRADE_THRESHOLD=3：2 < 3 不升级）
      const qualityA = finding({ type: "pacing_tension", message: "节奏松弛" })
      const qualityB = finding({ type: "reading_power", message: "爽点偏弱" })
      const behavior = finding({ type: BEHAVIOR_ALIAS_TYPE, message: '角色行为模式: "推眼镜"×3' })

      const gates = buildDecisionGates([qualityA, qualityB, behavior], 0, undefined, "tuili")

      // 行为 finding 只落 P1，不参与 P2 计数
      expect(gates.anti_ai.findings.map((item) => item.type)).toEqual(["character_behavior"])
      expect(gates.quality.findings.map((item) => item.type)).toEqual(["pacing_tension", "reading_power"])
      expect(gates.quality.verdict).toBe("warning")
      expect(gates.quality.status).toBe("passed")
      expect(gates.anti_ai.verdict).toBe("warning")
      expect(gates.overall).toBe("warning")

      // 加一条 P0 error：overall 必须 fail，且 P2 的 warning 结果不能掩盖 P0
      const p0Error = finding({ type: "timeline_consistency", severity: "error", message: "时间线错位" })
      const withP0 = buildDecisionGates([qualityA, qualityB, behavior, p0Error], 0, undefined, "tuili")

      expect(withP0.quality.verdict).toBe("warning")
      expect(withP0.quality.findings.map((item) => item.type)).toEqual(["pacing_tension", "reading_power"])
      expect(withP0.consistency.verdict).toBe("fail")
      expect(withP0.overall).toBe("fail")
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 落点③：buildCanonModalityContext — canon 图事实（携带 modality）提示词组装，
// 仅渲染 belief/hypothesis（角色认知）与 retconned（回溯改写）；assertive/无模态不注入。
// ════════════════════════════════════════════════════════════════════════════
describe("buildCanonModalityContext (落点③: canon 模态区分)", () => {
  function makeTemporalFact(overrides: Partial<TemporalFact> & { id: string }): TemporalFact {
    return {
      subject: "主角",
      predicate: "是",
      object: "凡人",
      validFrom: 1,
      source: "canon-graph:x",
      ...overrides,
    }
  }

  it("仅渲染 belief/hypothesis/retconned 非 Assertive；assertive 不重复注入", () => {
    const facts: TemporalFact[] = [
      makeTemporalFact({ id: "a", modality: "belief", subject: "主角", predicate: "持有", object: "轩辕剑" }),
      makeTemporalFact({ id: "b", modality: "assertive", subject: "配角", predicate: "位于", object: "凌霄殿" }),
    ]
    const ctx = buildCanonModalityContext(facts)
    expect(ctx).toContain("# canon 图事实（模态区分）")
    expect(ctx).toContain("[角色认知·belief] 主角 持有 轩辕剑（角色所信，非客观事实")
    // assertive 事实已由 context-engine 独立分块呈现，此处不重复注入（A1+C1）
    expect(ctx).not.toContain("[事实]")
    expect(ctx).not.toContain("凌霄殿")
  })

  it("hypothesis 同样标记角色认知", () => {
    const facts: TemporalFact[] = [
      makeTemporalFact({ id: "h", modality: "hypothesis", subject: "主角", object: "非凡人" }),
    ]
    const ctx = buildCanonModalityContext(facts)
    expect(ctx).toContain("[角色认知·hypothesis]")
  })

  it("retconned 标记回溯改写", () => {
    const facts: TemporalFact[] = [
      makeTemporalFact({ id: "r", modality: "retconned", subject: "主角", object: "凡人" }),
    ]
    const ctx = buildCanonModalityContext(facts)
    expect(ctx).toContain("[回溯改写] 主角 是 凡人")
  })

  it("全 Assertive / 无模态事实 → 返回空串（不重复注入，由 context-engine 独立分块呈现）", () => {
    const facts: TemporalFact[] = [makeTemporalFact({ id: "n", subject: "主角", object: "凡人" })]
    const ctx = buildCanonModalityContext(facts)
    expect(ctx).toBe("")
  })

  it("空输入返回空串（不污染 prompt）", () => {
    expect(buildCanonModalityContext([])).toBe("")
  })
})


// ============================================================================
// 53 号报告 P0-3 接线①: selectAuditDimensions → buildReviewPrompt (additive)
// ============================================================================

describe("53 P0-3 genre 激活维度注入 (buildReviewPrompt)", () => {
  it("genre 未传 → 全量 37 维现状 (无激活段注入)", () => {
    const prompt = buildReviewPrompt(contextPack, "正文", false)
    expect(prompt).not.toContain("本轮审查维度激活集")
  })
  it("已注册题材 (tuili) → 注入激活子集段 (Consistency+Anti-AI+Quality 子集)", () => {
    const prompt = buildReviewPrompt(contextPack, "正文", false, "tuili")
    expect(prompt).toContain("本轮审查维度激活集（按题材《tuili》裁剪）")
    // Consistency 维度 label 恒激活
    expect(prompt).toContain("时间线一致性")
    // 未注册题材 → 不注入
    const unknown = buildReviewPrompt(contextPack, "正文", false, "unknown-genre")
    expect(unknown).not.toContain("本轮审查维度激活集")
  })
  it("characterOnly 模式不注入激活段 (角色专项审查现状)", () => {
    const prompt = buildReviewPrompt(contextPack, "正文", true, "tuili")
    expect(prompt).not.toContain("本轮审查维度激活集")
  })
})

describe("clampReviewStageTimeoutMs", () => {
  it("未配置/非法值回退默认 5 分钟", () => {
    expect(clampReviewStageTimeoutMs(undefined)).toBe(REVIEW_STAGE_TIMEOUT_DEFAULT_MS)
    expect(clampReviewStageTimeoutMs(0)).toBe(REVIEW_STAGE_TIMEOUT_DEFAULT_MS)
    expect(clampReviewStageTimeoutMs(Number.NaN)).toBe(REVIEW_STAGE_TIMEOUT_DEFAULT_MS)
    expect(clampReviewStageTimeoutMs("900000")).toBe(REVIEW_STAGE_TIMEOUT_DEFAULT_MS)
  })

  it("合法值生效并钳制到 60s–30min", () => {
    expect(clampReviewStageTimeoutMs(900_000)).toBe(900_000)
    expect(clampReviewStageTimeoutMs(1_000)).toBe(60_000)
    expect(clampReviewStageTimeoutMs(9_999_999)).toBe(1_800_000)
  })
})

describe("W1-03 门控优先级（Consistency P0 先于 Anti-AI P1）与过程库三口诀 chapterText", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    mocks.continuityFindingsOverride = undefined
    mocks.continuityThrow = undefined
    mocks.slopBlock = false
    mocks.actionHitsOverride = undefined
    mocks.actionTextOverride = undefined
    mocks.llmUsable = true
  })

  it("P0 机械连续性 error 与 P1 机械 slop 阻断同时命中时：P0 恒前置且不被 P1 短路遮蔽", async () => {
    mocks.slopBlock = true
    mocks.actionHitsOverride = [{ action: "皱眉", totalCount: 4 }]
    mocks.actionTextOverride = '重复动作: "皱眉"×4'
    mocks.continuityFindingsOverride = [{
      type: "dead_character_state",
      subtype: "consistency_mechanical",
      severity: "critical",
      ref: "character:已故掌门",
      message: "已故掌门在第8章仍出现活跃状态变更",
      chapter: 8,
    }]

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(results).toHaveLength(3)
    // 严格按 P0(consistency_mechanical) → P1(anti_ai slop) → P1(character_behavior) 排序
    expect(results[0]!.type).toBe("consistency_mechanical")
    expect(results[0]!.severity).toBe("error")
    expect(results[1]!.type).toBe("anti_ai")
    expect(results[1]!.severity).toBe("error")
    expect(results[2]!.type).toBe("character_behavior")
    expect(results[2]!.severity).toBe("warning")
  })

  it("P0 仅有 warning 但 P1 slop 触发阻断时：仍保留前置 P0 warning 不被吞掉", async () => {
    mocks.slopBlock = true
    mocks.continuityFindingsOverride = [{
      type: "dormant_thread",
      subtype: "consistency_mechanical",
      severity: "warning",
      ref: "subplot:暗线",
      message: "暗线休眠 6 章未推进",
      chapter: 8,
    }]

    const results = await reviewChapter("E:/Novel", "正文", 8, { contextPack })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(results).toHaveLength(2)
    expect(results[0]!.type).toBe("consistency_mechanical")
    expect(results[0]!.severity).toBe("warning")
    expect(results[1]!.type).toBe("anti_ai")
    expect(results[1]!.severity).toBe("error")
  })

  it("injectedContinuityResults 含 P0 error 时：与 P1 slop 并存仍以 P0 前置短路", async () => {
    mocks.slopBlock = true
    const injectedP0: NovelReviewResult = {
      severity: "error",
      type: "consistency_mechanical",
      message: "过程库三口诀：角色越界知情",
      evidence: "doesNotKnow:密室密码",
      relatedMemory: "",
      suggestion: "删去越界认知",
    }

    const results = await reviewChapter("E:/Novel", "正文", 8, {
      contextPack,
      injectedContinuityResults: [injectedP0],
    })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(results[0]).toEqual(injectedP0)
    expect(results[1]!.type).toBe("anti_ai")
    expect(results[1]!.severity).toBe("error")
  })
})

describe("R2-W05 & R2-W08：state_delta_light_check 归位 P0 consistency 与当前书目角色名透传", () => {
  it("resolveReviewGateKey 将 state_delta_light_check 及大小写变体归一到 P0 consistency", () => {
    expect(resolveReviewGateKey("state_delta_light_check")).toBe("consistency")
    expect(resolveReviewGateKey("  STATE_DELTA_LIGHT_CHECK ")).toBe("consistency")
  })

  it("reviewChapter 从 character-states.json 读取当前书目角色名传给 detectCharacterActions", async () => {
    mocks.actionHitsOverride = undefined
    mocks.actionTextOverride = undefined
    mocks.slopBlock = false
    const prevImpl = mocks.fsReadFileMock.getMockImplementation()
    mocks.fsReadFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("character-states.json")) {
        return JSON.stringify({
          characters: [
            { characterName: "林墨", currentLocation: "祠堂", status: "正常", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 1, lastUpdatedAt: "" },
          ],
          lastUpdated: "",
        })
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })
    streamChatMock.mockImplementationOnce(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken("[]")
      callbacks.onDone()
    })

    try {
      const results = await reviewChapter(
        "E:/Novel",
        "林墨推了推眼镜，林墨又推了推眼镜，林墨第三次推了推眼镜。",
        8,
        { contextPack, injectedContinuityResults: [] },
      )

      const behavior = results.find((r) => r.type === "character_behavior")
      expect(behavior).toBeDefined()
      expect(behavior!.evidence).toContain("林墨: 3 次")
    } finally {
      if (prevImpl) mocks.fsReadFileMock.mockImplementation(prevImpl)
    }
  })
})

describe("B1 零 LLM 机械降级与只读预检契约", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    mocks.collectContinuityMetricMock.mockReset()
    mocks.fsWriteFileAtomicMock.mockReset()
    mocks.fsCreateDirectoryMock.mockReset()
    mocks.continuityFindingsOverride = undefined
    mocks.continuityThrow = undefined
    mocks.auditFindingsOverride = undefined
    mocks.slopBlock = false
    mocks.actionHitsOverride = undefined
    mocks.actionTextOverride = undefined
    mocks.llmUsable = true
  })

  it("runAuditTriadPreflight(readOnly: true, includeNonBlocking: true) 跳过磁盘写且返回非阻断发现", async () => {
    mocks.auditFindingsOverride = [
      {
        type: "presence_path",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "character:林墨",
        message: "角色在场路径疑似矛盾",
        chapter: 8,
      },
      {
        type: "data_gap",
        subtype: "data_gap",
        severity: "info",
        ref: "process:cognition",
        message: "缺少认知条目",
        chapter: 8,
        missingField: "cognition",
      },
    ]

    const defaultOnly = await runAuditTriadPreflight("E:/Novel", 8, { readOnly: true })
    expect(defaultOnly).toEqual([])
    expect(mocks.fsWriteFileAtomicMock).not.toHaveBeenCalled()
    expect(mocks.fsCreateDirectoryMock).not.toHaveBeenCalled()

    const withNonBlocking = await runAuditTriadPreflight("E:/Novel", 8, {
      readOnly: true,
      includeNonBlocking: true,
    })
    expect(withNonBlocking).toHaveLength(2)
    expect(withNonBlocking.map((r) => r.severity)).toEqual(["warning", "info"])
    expect(mocks.fsWriteFileAtomicMock).not.toHaveBeenCalled()
    expect(mocks.fsCreateDirectoryMock).not.toHaveBeenCalled()
  })

  it("runContinuityMechanicalPreflight(readOnly: true) 正常与异常分支均跳过 collectContinuityMetric 和 audit 写盘", async () => {
    mocks.auditFindingsOverride = [
      {
        type: "lost_item",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "item:青铜钥匙",
        message: "物品去向未交代",
        chapter: 8,
      },
    ]
    const results = await runContinuityMechanicalPreflight("E:/Novel", 8, {
      chapterText: "正文",
      readOnly: true,
      includeNonBlockingAudit: true,
    })
    expect(results.some((r) => r.severity === "warning" && r.message.includes("物品去向未交代"))).toBe(true)
    expect(mocks.collectContinuityMetricMock).not.toHaveBeenCalled()
    expect(mocks.fsWriteFileAtomicMock).not.toHaveBeenCalled()

    // 异常分支同样跳过 metric 写盘
    mocks.continuityThrow = new Error("engine boom")
    const degraded = await runContinuityMechanicalPreflight("E:/Novel", 8, { readOnly: true })
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.evidence).toBe("engine_error")
    expect(mocks.collectContinuityMetricMock).not.toHaveBeenCalled()
  })

  it("reviewChapter 在无可用 LLM 时仍返回前置 P0/P1 机械层结果，且不调用 streamChat 或 onSemanticReviewCompleted", async () => {
    mocks.llmUsable = false
    mocks.continuityFindingsOverride = [
      {
        type: "dormant_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:暗线",
        message: "暗线休眠 6 章未推进",
        chapter: 8,
      },
    ]
    mocks.actionHitsOverride = [{ action: "推眼镜", totalCount: 3 }]
    mocks.actionTextOverride = '重复动作: "推眼镜"×3'
    const onSemanticDone = vi.fn()

    const results = await reviewChapter("E:/Novel", "正文", 8, {
      contextPack,
      onSemanticReviewCompleted: onSemanticDone,
    })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(onSemanticDone).not.toHaveBeenCalled()
    expect(results).toHaveLength(2)
    expect(results[0]?.type).toBe("consistency_mechanical")
    expect(results[1]?.type).toBe("character_behavior")
  })

  it("reviewChapter 在 novelMode=false 时先于机械预检直接返回 []", async () => {
    mocks.llmUsable = false
    mocks.slopBlock = true
    mocks.continuityFindingsOverride = [
      {
        type: "dead_character_state",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: "character:已故掌门",
        message: "已故掌门复现",
        chapter: 8,
      },
    ]

    const results = await reviewChapter("E:/Novel", "正文", 8, {
      contextPack,
      novelMode: false,
    })

    expect(results).toEqual([])
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("P3-B2: reviewChapter 解析 canon_audit 模型槽位并锁定 temperature=0.15", async () => {
    mocks.resolveNovelModelMock.mockClear()
    streamChatMock.mockImplementationOnce(async (_cfg, _msgs, callbacks: StreamCallbacks) => {
      callbacks.onToken?.("[]")
      callbacks.onDone?.()
    })

    const results = await reviewChapter("E:/Novel", "主角推开祠堂木门，雨声落在青石阶上。", 8, {
      contextPack,
      novelConfig: {
        reviewModel: "review-m",
        canonAuditModel: "canon-m",
        reviewReasoningEffort: "medium",
      } as NovelConfig,
      llmConfig,
      novelMode: true,
    })

    expect(results).toEqual([])
    expect(mocks.resolveNovelModelMock).toHaveBeenCalledWith(llmConfig, expect.objectContaining({ canonAuditModel: "canon-m" }), "canon_audit")
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock.mock.calls[0]?.[4]).toEqual({
      temperature: 0.15,
      reasoning: { mode: "medium" },
      promptCacheKey: expect.stringMatching(/^niko:review_chapter:ch8:/),
    })
  })
})
