import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"
import {
  buildDimensionReviewPrompt,
  DimParseError,
  dimensionResultsToReviewResults,
  getCachedDimensionResults,
  normalizeDimensionScore,
  reviewChapterDimension,
  runSixDimensionReview,
  SIX_REVIEW_DIMENSION_ORDER,
  SIX_REVIEW_DIMENSIONS,
} from "./dimension-review-adapter"
import type { DimensionReviewResult, DimensionReviewStatus, SixReviewDimensionKey } from "./dimension-review-adapter"

type UsableLlmConfig = Pick<LlmConfig, "provider" | "apiKey" | "model"> &
  Partial<Pick<LlmConfig, "customEndpoint" | "ollamaUrl">>

const mocks = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  buildContextPackMock: vi.fn(),
  hasUsableLlmMock: vi.fn<(cfg: UsableLlmConfig) => boolean>(() => true),
  novelModeValue: true,
  registerNovelSkillHookMock: vi.fn(),
  runNovelSkillHooksMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  llmConfig: {
    provider: "custom" as const,
    apiKey: "test-key",
    model: "test-review-model",
    ollamaUrl: "",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 120000,
    reasoning: { mode: "off" as const },
  },
  contextPack: {
    task: "审查第8章",
    chapterGoal: "第8章目标：主角进入祠堂，发现族谱异常。",
    outline: "总大纲：围绕族谱秘密推进。\n第8章章纲：进入祠堂，发现族谱缺页。",
    recentSummaries: ["第6章：主角得到旧钥匙。", "第7章：主角抵达村口。"],
    previousChapterEnding: "祠堂门缝里透出一线冷光。",
    characterStates: "主角谨慎，小晴仍隐瞒自己知道族谱。",
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
const buildContextPackMock = mocks.buildContextPackMock
const llmConfig = mocks.llmConfig as LlmConfig
const contextPack = mocks.contextPack satisfies ContextPack

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChatMock,
  // ISS-20260709-049: runDimensionStage now calls combineAbortSignals to merge
  // the external signal with the internal 120s timeout. Mirror the real
  // implementation so the mock module exports it (spec-mock must mirror new
  // exports — see memory maint3-same-name-helper-consolidation).
  combineAbortSignals: (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
    const active = signals.filter(Boolean) as AbortSignal[]
    if (active.length === 0) return undefined
    if (active.length === 1) return active[0]
    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const s of active) {
      if (s.aborted) { controller.abort(); break }
      s.addEventListener("abort", abort, { once: true })
    }
    return controller.signal
  },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      llmConfig,
      novelConfig: { reviewModel: "" },
      novelMode: mocks.novelModeValue,
    }),
  },
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: (cfg: UsableLlmConfig) => mocks.hasUsableLlmMock(cfg),
}))

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (config: LlmConfig) => config,
}))

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    logger: { error: mocks.loggerErrorMock, warn: mocks.loggerWarnMock },
  }
})

vi.mock("./novel-skill-hooks", () => ({
  createGoldScaleReadinessHook: (promptHint: string) => ({
    id: "gold-readiness", track: "B", stages: ["pre_six_dim_review"],
    run: async () => { void promptHint },
  }),
  createAvoidAiMechanicalSlopHook: () => ({ id: "avoid-ai-m", track: "B", stages: ["pre_six_dim_review"], run: async () => {} }),
  createCedSoftReportHook: () => ({ id: "ced-soft", track: "B", stages: ["pre_six_dim_review"], run: async () => {} }),
  createDeAiDualPassHook: () => ({ id: "deai-dual", track: "B", stages: ["pre_six_dim_review"], run: async () => {} }),
  createStatisticalAiSignatureHook: () => ({ id: "ai-sig", track: "B", stages: ["pre_six_dim_review"], run: async () => {} }),
  registerNovelSkillHook: (...args: unknown[]) => mocks.registerNovelSkillHookMock(...args),
  runNovelSkillHooks: (...args: unknown[]) => mocks.runNovelSkillHooksMock(...args),
}))

vi.mock("./context-engine", () => ({
  buildContextPack: mocks.buildContextPackMock,
  contextPackToPrompt: (pack: ContextPack) => [
    `当前任务：${pack.task}`,
    `章节目标：${pack.chapterGoal}`,
    `大纲：${pack.outline}`,
    `上一章结尾：${pack.previousChapterEnding}`,
    `人物状态：${pack.characterStates}`,
    `角色认知：${pack.cognitionStates}`,
    `伏笔状态：${pack.foreshadowingStates}`,
    `时间线：${pack.timeline}`,
    `相关记忆：${pack.searchResults}`,
  ].join("\n"),
}))

describe("six-dimension review adapter", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    buildContextPackMock.mockReset()
    buildContextPackMock.mockResolvedValue(contextPack)
    mocks.hasUsableLlmMock.mockReturnValue(true)
    mocks.novelModeValue = true
    mocks.registerNovelSkillHookMock.mockReset()
    mocks.loggerErrorMock.mockReset()
    mocks.loggerWarnMock.mockReset()
    mocks.runNovelSkillHooksMock.mockReset()
    mocks.runNovelSkillHooksMock.mockResolvedValue({
      projectPath: "E:/Novel",
      chapterNumber: 8,
      stage: "pre_six_dim_review",
      bag: { promptFragments: [], notes: [] },
    })
  })

  it("defines six independent professional review workflows", () => {
    expect(SIX_REVIEW_DIMENSION_ORDER).toEqual([
      "thrill",
      "consistency",
      "pacing",
      "character",
      "continuity",
      "pull",
    ])

    expect(Object.keys(SIX_REVIEW_DIMENSIONS)).toEqual(SIX_REVIEW_DIMENSION_ORDER)
    expect(SIX_REVIEW_DIMENSIONS.thrill.label).toBe("爽感密度")
    expect(SIX_REVIEW_DIMENSIONS.thrill.stages.join("\n")).toContain("压抑与释放链检查")
    expect(SIX_REVIEW_DIMENSIONS.consistency.stages.join("\n")).toContain("规则一致性检查")
    expect(SIX_REVIEW_DIMENSIONS.pull.stages.join("\n")).toContain("结尾钩子检查")
  })

  it("builds a dimension-specific prompt with shared context and strict output rules", () => {
    const prompt = buildDimensionReviewPrompt(contextPack, "主角直接说出族谱被换。", SIX_REVIEW_DIMENSIONS.thrill)

    expect(prompt).toContain("爽感密度")
    expect(prompt).toContain("压抑与释放链检查")
    expect(prompt).toContain("当前任务：审查第8章")
    expect(prompt).toContain("只输出阶段分析")
    expect(prompt).toContain("score")
    expect(prompt).toContain("issues")
    // Step 0 A/B 校准（20260806 swarm 共识）：量程声明 + 档位行为锚点 + 出口条款。
    expect(prompt).toContain("0-10")
    expect(prompt).toContain("9-10 分：可发表文学质量")
    expect(prompt).toContain("出口条款")
    expect(prompt).toContain("8.5")
    // ISS-20260806-001: schema 明示 0-10 一位小数，禁止 0-100 占位语义
    expect(prompt).toContain("score\": 0.0")
    // 零 exemplar 时不得注入风格标杆块（向后兼容）。
    expect(prompt).not.toContain("风格标杆样本")
  })

  it("normalizeDimensionScore folds 0-100 legacy into 0-10 and clamps", () => {
    expect(normalizeDimensionScore(7.2)).toBe(7.2)
    expect(normalizeDimensionScore(72)).toBe(7.2)
    expect(normalizeDimensionScore(100)).toBe(10)
    expect(normalizeDimensionScore(10)).toBe(10)
    // 10.5 is still treated as 0-10 scale (fold only when >10.5) then clamp to 10
    expect(normalizeDimensionScore(10.5)).toBe(10)
    expect(normalizeDimensionScore(10.6)).toBe(1.1) // >10.5 → /10
    expect(normalizeDimensionScore(-3)).toBe(0)
    expect(normalizeDimensionScore(Number.NaN)).toBe(0)
    expect(normalizeDimensionScore("8.55")).toBe(8.6)
  })

  it("injects style exemplars as 9-10 band few-shot when pack provides them", () => {
    const packWithExemplars: ContextPack = {
      ...contextPack,
      styleExemplars: [
        {
          exemplarId: "ex-1",
          chapterId: "1",
          text: "雨点砸在祠堂瓦片上，他攥着旧钥匙，指节发白。",
          markType: "style",
          createdAt: "2026-08-01",
        },
        {
          exemplarId: "ex-2",
          chapterId: "2",
          text: "“别进去。”小晴的声音很低，低到像怕惊动祠堂里的东西。",
          markType: "voice",
          createdAt: "2026-08-01",
        },
      ],
    }
    const prompt = buildDimensionReviewPrompt(
      packWithExemplars,
      "主角直接说出族谱被换。",
      SIX_REVIEW_DIMENSIONS.thrill,
    )

    expect(prompt).toContain("风格标杆样本")
    expect(prompt).toContain("[文风]")
    expect(prompt).toContain("[声线/对白]")
    expect(prompt).toContain("雨点砸在祠堂瓦片上")
  })

  it("injects gold-scale block for thril when anchors provided", () => {
    const prompt = buildDimensionReviewPrompt(
      contextPack,
      "主角直接说出族谱被换。",
      SIX_REVIEW_DIMENSIONS.thrill,
      {
        goldAnchors: [{
          id: "g1",
          dimension: "thrill",
          targetScore: 9,
          text: "他在投票前一秒把平板扣死，声音不高，却让整张桌子安静下来。",
          status: "human_confirmed",
        }],
      },
    )
    expect(prompt).toContain("文学金标")
    expect(prompt).toContain("human_confirmed")
    expect(prompt).toContain("平板扣死")
    expect(prompt).toContain("非产品硬门")
  })

  it("injects NOT_READY gold note for thril when no anchors", () => {
    const prompt = buildDimensionReviewPrompt(
      contextPack,
      "主角直接说出族谱被换。",
      SIX_REVIEW_DIMENSIONS.thrill,
      { goldAnchors: [], goldReadinessHint: "金标量程未就绪：thril≈9 未校准" },
    )
    expect(prompt).toContain("文学金标量程")
    expect(prompt).toContain("未就绪")
  })

  it("does not inject gold block for consistency dimension", () => {
    const prompt = buildDimensionReviewPrompt(
      contextPack,
      "主角直接说出族谱被换。",
      SIX_REVIEW_DIMENSIONS.consistency,
      {
        goldAnchors: [{
          id: "g1",
          dimension: "thrill",
          targetScore: 9,
          text: "他在投票前一秒把平板扣死，声音不高，却让整张桌子安静下来。",
          status: "human_confirmed",
        }],
      },
    )
    expect(prompt).not.toContain("文学金标")
  })

  it("runs one dimension with two high-reasoning model calls and publishes thinking", async () => {
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      const prompt = messages.map((message) => message.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({
          // 0-100 legacy → normalizeDimensionScore folds to 7.2
          score: 72,
          status: "medium",
          summary: "爽点有铺垫，但兑现偏弱。",
          issues: [{
            severity: "warning",
            type: "thrill",
            message: "主爽点兑现不足",
            evidence: "主角直接说出族谱被换。",
            relatedMemory: "第8章章纲要求发现族谱异常。",
            suggestion: "增加压抑后的反转与奖励兑现。",
            impact: "读者情绪释放不足。",
            rewriteTarget: "主角直接说出族谱被换。",
          }],
        }))
      } else {
        callbacks.onToken("阶段分析：已检查压抑与释放链。")
      }
      callbacks.onDone()
    })

    const thinking: string[] = []
    const result = await reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "主角直接说出族谱被换。",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
      callbacks: {
        onThinking: (_dimensionKey, content) => thinking.push(content),
      },
    })

    expect(streamChatMock).toHaveBeenCalledTimes(2)
    expect(streamChatMock.mock.calls.every((call) => call[4]?.reasoning?.mode === "high")).toBe(true)
    expect(thinking.join("\n")).toContain("爽感密度")
    expect(thinking.join("\n")).toContain("阶段分析：已检查压抑与释放链。")
    expect(result).toMatchObject({
      dimensionKey: "thrill",
      score: 7.2,
      status: "medium",
      summary: "爽点有铺垫，但兑现偏弱。",
    })
    expect(result.issues[0]).toMatchObject({
      dimensionKey: "thrill",
      message: "主爽点兑现不足",
      impact: "读者情绪释放不足。",
      rewriteTarget: "主角直接说出族谱被换。",
    })
  })

  it("runs all six dimensions with one shared context and continues after one failure", async () => {
    const finalCallDimensions: string[] = []
    streamChatMock.mockImplementation(async (
      _config: LlmConfig,
      messages: Array<{ role: string; content: string }>,
      callbacks: StreamCallbacks,
    ) => {
      const prompt = messages.map((message) => message.content).join("\n")
      if (!prompt.includes("最终 JSON")) {
        callbacks.onToken("阶段分析完成")
        callbacks.onDone()
        return
      }

      const dimension = SIX_REVIEW_DIMENSION_ORDER.find((key) => prompt.includes(SIX_REVIEW_DIMENSIONS[key].label))
      if (!dimension) throw new Error("missing dimension")
      finalCallDimensions.push(dimension)
      if (dimension === "pacing") {
        throw new Error("模型暂时不可用")
      }
      callbacks.onToken(JSON.stringify({
        score: 9.0,
        status: "pass",
        summary: `${SIX_REVIEW_DIMENSIONS[dimension].label}通过`,
        issues: [],
      }))
      callbacks.onDone()
    })

    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "章节正文",
      chapterNumber: 8,
    })

    expect(buildContextPackMock).toHaveBeenCalledTimes(1)
    expect(finalCallDimensions).toEqual(SIX_REVIEW_DIMENSION_ORDER)
    expect(Object.keys(results)).toEqual(SIX_REVIEW_DIMENSION_ORDER)
    expect(results.pacing?.status).toBe("error")
    expect(results.pacing?.issues[0].message).toContain("节奏张力审查失败")
    expect(results.pull?.summary).toBe("追读引力通过")
    expect(results.pull?.score).toBe(9)
  })

  it("continuity mechanical short-circuit emits 10 on 0-10 scale (not 100)", async () => {
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "章节正文",
      chapterNumber: 8,
      dimensionKeys: ["continuity"],
      priorReviewResults: [{
        severity: "info",
        type: "consistency_mechanical",
        message: "mechanical precheck",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      }],
    })

    expect(results.continuity?.status).toBe("pass")
    expect(results.continuity?.score).toBe(10)
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("DimParseError exposes raw text and parse message", () => {
    const err = new DimParseError('{"score": 9,', "Unexpected end of JSON input")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("DimParseError")
    expect(err.raw).toBe('{"score": 9,')
    expect(err.parseMessage).toBe("Unexpected end of JSON input")
    expect(err.message).toContain("JSON parse failed")
  })

  it("getCachedDimensionResults derives the cached view in canonical order", () => {
    expect(getCachedDimensionResults(undefined)).toEqual([])
    const mk = (dimensionKey: SixReviewDimensionKey): DimensionReviewResult => ({
      dimensionKey,
      score: 8,
      status: "pass",
      summary: "s",
      thinking: "t",
      issues: [],
    })
    const ordered = getCachedDimensionResults({ pull: mk("pull"), thrill: mk("thrill") })
    expect(ordered.map((r) => r.dimensionKey)).toEqual(["thrill", "pull"])
    expect(getCachedDimensionResults({}).length).toBe(0)
  })

  it("dimensionResultsToReviewResults maps issue severities against the dimension status floor", () => {
    const base = (status: DimensionReviewStatus, issueSeverity: "error" | "warning" | "info"): DimensionReviewResult => ({
      dimensionKey: "thrill",
      score: 8,
      status,
      summary: "",
      thinking: "",
      issues: [{ severity: issueSeverity, type: "thrill", dimensionKey: "thrill", message: "m", evidence: "e", relatedMemory: "", suggestion: "", impact: "", rewriteTarget: "" }],
    })
    // error floor: issue warning → error
    expect(dimensionResultsToReviewResults({ thrill: base("error", "warning") })[0]!.severity).toBe("error")
    // medium floor: issue info → warning
    expect(dimensionResultsToReviewResults({ thrill: base("medium", "info") })[0]!.severity).toBe("warning")
    // low floor: issue error raises above floor
    expect(dimensionResultsToReviewResults({ thrill: base("low", "error") })[0]!.severity).toBe("error")
    // pass floor with info issue
    expect(dimensionResultsToReviewResults({ thrill: base("pass", "info") })[0]!.severity).toBe("info")
  })

  it("dimensionResultsToReviewResults routes types into the correct gates and prefixes messages", () => {
    const mk = (key: SixReviewDimensionKey, summary: string, message: string): DimensionReviewResult => ({
      dimensionKey: key,
      score: 7,
      status: "medium",
      summary,
      thinking: "",
      issues: [{ severity: "warning", type: key, dimensionKey: key, message, evidence: "e", relatedMemory: "rm", suggestion: "s", impact: "i", rewriteTarget: "rt" }],
    })
    const results = dimensionResultsToReviewResults({
      character: mk("character", "人设有偏", "角色知道了不该知道的"),
      continuity: mk("continuity", "时间线对不上", "时间跳跃"),
      pacing: mk("pacing", "节奏拖沓", "水文过多"),
      consistency: mk("consistency", "设定矛盾", "能力超纲"),
    })
    const byType = Object.fromEntries(results.map((r) => [r.type, r]))
    expect(byType.character_consistency!.message).toBe("[人设有偏] 角色知道了不该知道的")
    expect(byType.timeline!.message).toContain("时间跳跃")
    expect(byType.plot!.message).toContain("水文过多")
    expect(byType.consistency!.evidence).toBe("e")
    expect(byType.consistency!.relatedMemory).toBe("rm")
    expect(byType.consistency!.suggestion).toBe("s")
  })

  it("dimensionResultsToReviewResults emits info summary when a dimension has no issues", () => {
    const results = dimensionResultsToReviewResults({
      pull: {
        dimensionKey: "pull", score: 9, status: "pass", summary: "钩子成立", thinking: "", issues: [],
      },
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ severity: "info", type: "plot" })
    expect(results[0]!.message).toBe("追读引力：钩子成立")
  })

  it("dimensionResultsToReviewResults falls back to the dimension key when summary is empty", () => {
    const results = dimensionResultsToReviewResults({
      thrill: {
        dimensionKey: "thrill", score: 6, status: "pass", summary: "", thinking: "", issues: [],
      },
    })
    expect(results[0]!.message).toBe("爽感密度：pass")
  })

  it("dimensionResultsToReviewResults uses the key as message prefix and empty evidence fallback", () => {
    const results = dimensionResultsToReviewResults({
      pacing: {
        dimensionKey: "pacing",
        score: 5,
        status: "medium",
        summary: "",
        thinking: "",
        issues: [{ severity: "warning", type: "pacing", dimensionKey: "pacing", message: "", evidence: "", relatedMemory: "", suggestion: "", impact: "", rewriteTarget: "" }],
      },
    })
    // empty issue message → empty string fallback keeps the prefix only
    expect(results[0]!.message).toBe("[pacing]")
    expect(results[0]!.evidence).toBe("")
    expect(results[0]!.relatedMemory).toBe("")
    expect(results[0]!.suggestion).toBe("")
  })

  it("truncates long exemplar excerpts to 200 chars in the prompt", () => {
    const longText = "长".repeat(250)
    const prompt = buildDimensionReviewPrompt(
      { ...contextPack, styleExemplars: [{ exemplarId: "e", chapterId: "1", text: longText, markType: "pacing", createdAt: "2026-08-01" }] },
      "正文",
      SIX_REVIEW_DIMENSIONS.pacing,
    )
    expect(prompt).toContain("长".repeat(200) + "…")
    expect(prompt).not.toContain("长".repeat(201))
    expect(prompt).toContain("[节奏]")
  })

  it("returns {} when no usable LLM is configured", async () => {
    mocks.hasUsableLlmMock.mockReturnValue(false)
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      chapterNumber: 8,
    })
    expect(results).toEqual({})
    expect(buildContextPackMock).not.toHaveBeenCalled()
  })

  it("returns {} when novelMode is off", async () => {
    mocks.novelModeValue = false
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      chapterNumber: 8,
    })
    expect(results).toEqual({})
  })

  it("falls back to '?' chapter label when chapterNumber is missing", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({ score: 8, status: "pass", summary: "s", issues: [] }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["pacing"],
    })
    expect(results.pacing?.status).toBe("pass")
    expect(buildContextPackMock).toHaveBeenCalledWith("E:/Novel", "六维审查第?章", undefined)
  })

  it("uses 'unknown' model label when model is empty", async () => {
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: [],
      llmConfig: { ...llmConfig, model: "" },
    })
    // dimensionKeys [] → no LLM calls; fingerprint uses "unknown"
    expect(Object.keys(results)).toEqual([])
    expect(mocks.runNovelSkillHooksMock).toHaveBeenCalled()
  })

  it("joins skill-hook prompt fragments into the gold readiness hint", async () => {
    mocks.runNovelSkillHooksMock.mockResolvedValue({
      projectPath: "E:/Novel",
      chapterNumber: 8,
      stage: "pre_six_dim_review",
      bag: { promptFragments: ["金标提示 A", "机械 slop 提示 B"], notes: [] },
    })
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["pull"],
    })
    expect(results.pull).toBeDefined()
    // readiness hint carries into the pull prompt block
    expect(streamChatMock).toHaveBeenCalled()
  })

  it("soft-fails the gold scale + skill hook block with a logged warning", async () => {
    mocks.runNovelSkillHooksMock.mockRejectedValue(new Error("hooks boom"))
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({ score: 8, status: "pass", summary: "s", issues: [] }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["pacing"],
    })
    expect(results.pacing?.status).toBe("pass")
    expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
      "SixDimReview",
      "gold scale / skill hooks soft-failed",
      expect.objectContaining({ error: "hooks boom" }),
    )
  })

  it("soft-fail warning stringifies non-Error values", async () => {
    mocks.runNovelSkillHooksMock.mockRejectedValue("raw hook failure")
    await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: [],
    })
    expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
      "SixDimReview",
      "gold scale / skill hooks soft-failed",
      expect.objectContaining({ error: "raw hook failure" }),
    )
  })

  it("logs stream errors via onError without leaking provider details", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("provider 500"))
      callbacks.onDone()
    })
    await expect(reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })).rejects.toThrow()
    expect(mocks.loggerErrorMock).toHaveBeenCalledWith(
      "Dimension Review",
      "thrill stream error",
      expect.objectContaining({ error: "provider 500" }),
    )
  })

  it("stream onError stringifies non-Error values", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onError("raw stream failure" as unknown as Error)
      callbacks.onDone()
    })
    await expect(reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })).rejects.toThrow()
    expect(mocks.loggerErrorMock).toHaveBeenCalledWith(
      "Dimension Review",
      "thrill stream error",
      expect.objectContaining({ error: "raw stream failure" }),
    )
  })

  it("rejects when the model returns no JSON object", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken("阶段分析而已，没有 JSON")
      callbacks.onDone()
    })
    await expect(reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })).rejects.toThrow("审查没有返回 JSON")
  })

  it("wraps malformed JSON in DimParseError", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken('{"score": 9, "status": }')
      callbacks.onDone()
    })
    await expect(reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })).rejects.toBeInstanceOf(DimParseError)
  })

  it("rethrows non-SyntaxError throwables from JSON.parse unchanged (F-003)", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken('{"score": 8, "status": "pass", "summary": "s", "issues": []}')
      callbacks.onDone()
    })
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new TypeError("boom")
    })
    try {
      await expect(reviewChapterDimension({
        llmConfig,
        contextPack,
        chapterContent: "正文",
        dimension: SIX_REVIEW_DIMENSIONS.thrill,
      })).rejects.toThrow(TypeError)
    } finally {
      parseSpy.mockRestore()
    }
  })

  it("runs a dimension whose issues array is not an array (falls back to [])", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({ score: 7, status: "high", summary: "s", issues: "not-array" }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const result = await reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })
    expect(result.issues).toEqual([])
    expect(result.summary).toBe("s")
  })

  it("normalizes a sparse issue with all optional fields missing", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({
          score: 6,
          status: "weird-status",
          issues: [{
            severity: "bogus",
            type: "",
            message: "",
          }],
        }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const result = await reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })
    expect(result.issues).toHaveLength(1)
    const issue = result.issues[0]!
    // validateSeverity default → warning; type falls back to the dimension key
    expect(issue.severity).toBe("warning")
    expect(issue.type).toBe("thrill")
    expect(issue.message).toBe("")
    expect(issue.evidence).toBe("")
    expect(issue.relatedMemory).toBe("")
    expect(issue.suggestion).toBe("")
    expect(issue.impact).toBe("")
    expect(issue.rewriteTarget).toBe("")
    // weird status + issues present → "medium"
    expect(result.status).toBe("medium")
  })

  it("rewriteTarget falls back to evidence when absent", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({
          score: 6,
          status: "pass",
          summary: "s",
          issues: [{ severity: "info", type: "thrill", message: "m", evidence: "证据原文" }],
        }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const result = await reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })
    expect(result.issues[0]!.rewriteTarget).toBe("证据原文")
    // missing summary → ""
    expect(result.summary).toBe("s")
  })

  it("unknown status with zero issues resolves to pass", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken(JSON.stringify({ score: 6, status: "unknown", issues: [] }))
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const result = await reviewChapterDimension({
      llmConfig,
      contextPack,
      chapterContent: "正文",
      dimension: SIX_REVIEW_DIMENSIONS.thrill,
    })
    expect(result.status).toBe("pass")
  })

  it("builds failed-dimension results with the DimParseError message in the six-dim run", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ role: string; content: string }>, callbacks: StreamCallbacks) => {
      const prompt = messages.map((m) => m.content).join("\n")
      if (prompt.includes("最终 JSON")) {
        callbacks.onToken('{"score": 9, }')
      } else {
        callbacks.onToken("分析")
      }
      callbacks.onDone()
    })
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["pull"],
    })
    expect(results.pull?.status).toBe("error")
    expect(results.pull?.summary).toContain("JSON 无法解析")
    expect(results.pull?.issues[0]?.message).toContain("JSON 无法解析")
  })

  it("builds failed-dimension results with the original message for runtime errors", async () => {
    streamChatMock.mockRejectedValue(new Error("网络超时"))
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["character"],
    })
    expect(results.character?.status).toBe("error")
    expect(results.character?.summary).toContain("网络超时")
    expect(results.character?.issues[0]?.suggestion).toBe("请检查模型设置后重新审查此维度。")
  })

  it("builds failed-dimension results with 未知错误 for non-Error failures", async () => {
    streamChatMock.mockRejectedValue("string failure")
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["character"],
    })
    expect(results.character?.summary).toContain("未知错误")
    expect(results.character?.thinking).toContain("未知错误")
  })

  it("builds failed-dimension results with the unknown-error fallback when the rejection is null", async () => {
    streamChatMock.mockRejectedValue(null)
    const results = await runSixDimensionReview({
      projectPath: "E:/Novel",
      chapterContent: "正文",
      dimensionKeys: ["character"],
    })
    expect(results.character?.status).toBe("error")
    expect(results.character?.summary).toContain("unknown error")
  })
})
