/**
 * `context.inspect` 门面测试（native-context-readback 计划 C3）。
 *
 * 覆盖的是**承诺的边界**，不是 happy path：
 * 1. 默认 0 次 pack 构建，且响应里没有正文/pack/prompt，也没有秘密值；
 * 2. 显式 `includePack` 返回**实际完整** pack（renderer 依赖的 optional 字段都在）；
 * 3. 六维键来自生产真源（`SIX_REVIEW_DIMENSION_ORDER` / `SIX_REVIEW_DIMENSIONS`），
 *    不是手写第二份枚举；六个键逐一可选；
 * 4. 构建用**同一份实际内存配置**做 DI，并注入丢弃 ROI 的 sink（不写项目遥测）；
 * 5. embedding/rerank 生效时未显式 `allowRetrievalNetwork` 就在构建前拒绝；
 *    显式允许后仍用真实（enabled）配置构建，绝不改写成 disabled；
 * 6. 项目/配置/正文漂移一律显式失败；
 * 7. 分页重组 == 源生产 prompt，且 `chapterWindowOmitted` 与分页截断分开报告。
 *
 * 本文件不宣判任何评分：`N>=5` / `overall median>=9` 是 Goal 层的锁定量，
 * 回读工具只回事实。
 */

import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_PROMPT_PAGE_CHARS,
  MAX_PROMPT_PAGE_CHARS,
  INSPECTION_CACHE_TTL_MS,
  MAX_INSPECTION_CACHE_ENTRIES,
  PREPARE_RETRIEVAL_MODES,
  SIX_DIMENSION_KEYS,
  defaultInspectionTask,
  createContextInspectionCache,
  inspectContext,
  isSixReviewDimensionKey,
  runPrepareWriteContext,
  runWithLocalOnlyRetrieval,
  type ContextInspectionDeps,
  type ContextInspectionResult,
  type ContextRuntimeConfig,
  type InspectedChapter,
  type PrepareRetrievalMode,
  type PrepareWriteContextDeps,
} from "./context-inspection"
import {
  SIX_REVIEW_DIMENSIONS,
  SIX_REVIEW_DIMENSION_ORDER,
  assessGoldScaleReadiness,
  buildDimensionReviewPrompt,
  canonicalizeContextPackForHash,
  computeCheckpointDigest,
  contextPackToPrompt,
  fingerprintText,
  resolveReviewChapterMaxChars,
  type BuildContextOptions,
  type ChapterDraft,
  type ChapterPlanView,
  type ContextPack,
  type LiteraryGoldAnchor,
  type RoutingROISample,
} from "@/lib/novel"
import * as checkpointDigest from "@/lib/novel/checkpoint-digest"
import { DEFAULT_NOVEL_CONFIG, DEFAULT_RERANK_CONFIG, useWikiStore } from "@/stores/wiki-store"

// ── 夹具 ────────────────────────────────────────────────────────────────────

const CHAPTER_TEXT = "第一行正文\n第二行正文\n第三行正文"
const CHAPTER: InspectedChapter = {
  index: 3,
  number: 3,
  name: "chapter-003.md",
  path: "/proj/wiki/chapters/chapter-003.md",
}

function makeConfig(overrides: Partial<ContextRuntimeConfig> = {}): ContextRuntimeConfig {
  return {
    novelMode: true,
    novelConfig: {
      ...DEFAULT_NOVEL_CONFIG,
      chapterTargetChars: 4321,
      hardInjectEnabled: true,
      taskPrompts: {
        writing: { extra: "SECRET_TASK_EXTRA" },
        outline: {},
        review: {},
        summary: {},
        extract: {},
      },
    },
    llmConfig: {
      provider: "openai",
      apiKey: "sk-SECRET-LLM",
      model: "gpt-test-model",
      ollamaUrl: "",
      customEndpoint: "https://secret.example/v1",
      maxContextSize: 128_000,
      httpConnectTimeoutMs: 11_000,
    },
    embeddingConfig: {
      enabled: false,
      endpoint: "http://secret-embed.local/v1/embeddings",
      apiKey: "sk-SECRET-EMBED",
      model: "embed-test-model",
    },
    rerankConfig: { ...DEFAULT_RERANK_CONFIG },
    revisionFeedbackWindowConfig: {
      currentChapterIncludeShouldImprove: true,
      previousChapterCarryEnabled: true,
      lookbackChapterCount: 3,
      lookbackIncludeMustFixOnly: false,
    },
    ...overrides,
  }
}

function makePack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    task: "六维审查第3章",
    chapterGoal: "",
    outline: "本章章纲：主角在矿脉前做出选择",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    ...overrides,
  }
}

interface BuildCall {
  projectPath: string
  task: string
  chapterNumber: number | undefined
  options: BuildContextOptions
}

interface Harness {
  deps: ContextInspectionDeps
  calls: BuildCall[]
  state: {
    config: ContextRuntimeConfig
    pack: ContextPack
    chapterText: string
    projectPath: string
    configReads: number
    textReads: number
    goldLoads: number
    now: number
  }
}

function harness(options: {
  config?: ContextRuntimeConfig
  pack?: ContextPack
  chapterText?: string
  projectPath?: string
  overrides?: Partial<ContextInspectionDeps>
} = {}): Harness {
  const state = {
    config: options.config ?? makeConfig(),
    pack: options.pack ?? makePack(),
    chapterText: options.chapterText ?? CHAPTER_TEXT,
    projectPath: options.projectPath ?? "/proj",
    configReads: 0,
    textReads: 0,
    goldLoads: 0,
    now: 1_700_000_000_000,
  }
  const calls: BuildCall[] = []
  const deps: ContextInspectionDeps = {
    readProjectPath: () => state.projectPath,
    readFileText: async () => {
      state.textReads += 1
      return state.chapterText
    },
    readRuntimeConfig: () => {
      state.configReads += 1
      return state.config
    },
    buildContextPack: async (projectPath, task, chapterNumber, buildOptions) => {
      calls.push({ projectPath, task, chapterNumber, options: buildOptions })
      return state.pack
    },
    loadGoldMaterials: async () => {
      state.goldLoads += 1
      return { anchors: [], exemplars: [], merged: [] }
    },
    assessGoldReadiness: assessGoldScaleReadiness,
    inspectionCache: createContextInspectionCache(),
    now: () => state.now,
    ...options.overrides,
  }
  return { deps, calls, state }
}

function request(params: Record<string, unknown> = {}) {
  return { projectPath: "/proj", chapter: CHAPTER, params }
}

function inspectionIdOf(result: ContextInspectionResult): string {
  expect(result.inspectionId).toBeTypeOf("string")
  if (!result.inspectionId) throw new Error("显式构建未返回 inspectionId")
  return result.inspectionId
}

// ── 1. 默认只回元数据 ────────────────────────────────────────────────────────

describe("context.inspect — 默认只回元数据", () => {
  it("默认 0 次 pack 构建，且不含正文/pack/prompt", async () => {
    const h = harness()
    const result = await inspectContext(request(), h.deps)

    expect(h.calls).toHaveLength(0)
    expect(h.state.configReads).toBe(2)
    expect(h.state.goldLoads).toBe(0)
    expect(h.state.textReads).toBe(2)
    expect(result.inspectionId).toBeUndefined()
    expect(result.contextPackBuilt).toBe(false)
    expect(result.contextPack).toBeUndefined()
    expect(result.dimension).toBeUndefined()
    expect(result.chapterText).toBeUndefined()
    expect(result.packMetadata).toBeUndefined()
    expect(result.buildPolicy).toBeUndefined()

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(CHAPTER_TEXT)
    expect(serialized).not.toContain("本章章纲")
  })

  it("不泄漏任何秘密值：apiKey / customEndpoint / embedding endpoint / taskPrompt 原文", async () => {
    const h = harness()
    const result = await inspectContext(request(), h.deps)
    const serialized = JSON.stringify(result)

    for (const secret of [
      "sk-SECRET-LLM",
      "sk-SECRET-EMBED",
      "https://secret.example/v1",
      "http://secret-embed.local/v1/embeddings",
      "SECRET_TASK_EXTRA",
    ]) {
      expect(serialized).not.toContain(secret)
    }

    const llm = result.effectiveConfig.llm as Record<string, unknown>
    expect(llm.configured).toEqual({ apiKey: true, customEndpoint: true, ollamaUrl: false })
    const embedding = result.effectiveConfig.embedding as Record<string, unknown>
    expect(embedding.configured).toEqual({ endpoint: true, apiKey: true })
  })

  it("公开配置是**实际生效值**而不是默认值，合法数字/开关原样保留", async () => {
    const h = harness()
    const result = await inspectContext(request(), h.deps)

    const novelConfig = result.effectiveConfig.novelConfig as Record<string, unknown>
    expect(novelConfig.chapterTargetChars).toBe(4321)
    expect(novelConfig.hardInjectEnabled).toBe(true)
    // DEFAULT_NOVEL_CONFIG 是 3000，如果投影走默认值这里会红。
    expect(novelConfig.chapterTargetChars).not.toBe(DEFAULT_NOVEL_CONFIG.chapterTargetChars)

    const llm = result.effectiveConfig.llm as Record<string, unknown>
    expect(llm.model).toBe("gpt-test-model")
    expect(llm.maxContextSize).toBe(128_000)
    expect(llm.httpConnectTimeoutMs).toBe(11_000)

    const taskPrompts = result.effectiveConfig.taskPrompts as Record<string, { chars: number }>
    expect(taskPrompts.writing.chars).toBe("SECRET_TASK_EXTRA".length)
  })

  it("章节元数据带完整文本 UTF-8 SHA-256 与明确的 hash 域", async () => {
    const h = harness()
    const result = await inspectContext(request(), h.deps)

    expect(result.chapter).toMatchObject({
      index: 3,
      number: 3,
      name: "chapter-003.md",
      path: CHAPTER.path,
      chars: CHAPTER_TEXT.length,
    })
    expect(result.chapter.textSha256).toBe(await computeCheckpointDigest(CHAPTER_TEXT))
    expect(result.chapter.textHashDomain).toContain("no BOM/newline/frontmatter normalization")
  })

  it("includeChapter=true 才返回整章原文，且 hash 域不做归一化", async () => {
    const raw = "\uFEFF第一段\r\n第二段\n"
    const h = harness({ chapterText: raw })
    const result = await inspectContext(request({ includeChapter: true }), h.deps)

    expect(result.chapterText).toBe(raw)
    expect(result.chapter.textSha256).toBe(await computeCheckpointDigest(raw))
    // 归一化（去 BOM / CRLF→LF）会得到不同的 hash：证明域声明不是装饰。
    expect(result.chapter.textSha256).not.toBe(
      await computeCheckpointDigest(raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")),
    )
  })

  it("reviewWindow 用生产 resolveReviewChapterMaxChars，omission 与窗口分离", async () => {
    const maxChars = resolveReviewChapterMaxChars()
    const short = harness()
    const shortResult = await inspectContext(request(), short.deps)
    expect(shortResult.reviewWindow.maxChars).toBe(maxChars)
    expect(shortResult.reviewWindow.chapterWindowOmitted).toBe(CHAPTER_TEXT.length > maxChars)

    const long = harness({ chapterText: "字".repeat(maxChars + 10) })
    const longResult = await inspectContext(request(), long.deps)
    expect(longResult.reviewWindow.chapterWindowOmitted).toBe(true)
    // 默认路径没有 prompt，所以不存在「分页截断」字段可混淆。
    expect(longResult.dimension).toBeUndefined()
  })

  it("默认 task 由章号派生，可被调用方显式覆盖", async () => {
    const h = harness({ config: makeConfig() })
    await inspectContext(request({ includePack: true }), h.deps)
    expect(h.calls[0].task).toBe(defaultInspectionTask(3))

    const h2 = harness()
    await inspectContext(request({ includePack: true, task: "冻结任务：评估第3章" }), h2.deps)
    expect(h2.calls[0].task).toBe("冻结任务：评估第3章")
  })
})

// ── 2. includePack 返回实际完整 pack ────────────────────────────────────────

describe("context.inspect — includePack 返回真实完整 ContextPack", () => {
  it("renderer 依赖的 optional 字段全部保留（不是 PACK_HASH_KEYS 投影）", async () => {
    const pack = Object.assign(makePack({ recentChapterContents: ["前章正文"] }), {
      styleExemplars: [
        {
          exemplarId: "ex-1",
          chapterId: "ch-1",
          text: "好段落",
          markType: "thrill" as const,
          createdAt: "2026-11-20T00:00:00.000Z",
        },
      ],
      activeEntities: [{ entityId: "e1", name: "甲", type: "character", tags: ["relevance:high"] }],
      hardInject: [{ id: "h1", text: "硬注入条目", source: "canon" }],
      gaps: [
        { type: "truncated" as const, ref: "canonRules", reason: "budget_exceeded" as const, originalLength: 100, retainedLength: 40 },
      ],
    }) as ContextPack

    const h = harness({ pack })
    const result = await inspectContext(request({ includePack: true }), h.deps)

    expect(h.calls).toHaveLength(1)
    expect(result.contextPackBuilt).toBe(true)
    // 保留完整产物的独立副本，不能让调用方修改生产对象或批次缓存。
    expect(result.contextPack).toEqual(pack)
    expect(result.contextPack).not.toBe(pack)
    expect(result.contextPack?.styleExemplars).toHaveLength(1)
    expect(result.contextPack?.activeEntities).toHaveLength(1)
    expect(result.contextPack?.hardInject).toHaveLength(1)
    expect(result.contextPack?.recentChapterContents).toEqual(["前章正文"])
    expect(result.packMetadata?.gapCount).toBe(1)
    expect(result.packMetadata?.fields).toContain("styleExemplars")
    expect(result.packMetadata?.fields).toContain("activeEntities")
  })

  it("pack 元数据标明算法域，且 canonicalSha256 可独立复算", async () => {
    const h = harness()
    const result = await inspectContext(request({ includePack: true }), h.deps)
    const metadata = result.packMetadata
    expect(metadata).toBeDefined()
    expect(metadata?.algorithms.productionFingerprint).toContain("fnv1a-64")
    expect(metadata?.algorithms.productionFingerprint).toContain("UTF-8")
    expect(metadata?.algorithms.canonicalSha256).toContain("sha256")
    expect(metadata?.canonicalSha256).toMatch(/^[0-9a-f]{64}$/)
    const canonical = canonicalizeContextPackForHash(h.state.pack)
    expect(metadata?.productionFingerprint).toBe(fingerprintText(canonical))
    expect(metadata?.canonicalSha256).toBe(await computeCheckpointDigest(canonical))
    // 与章节 hash 不同域：不会互相冒充。
    expect(metadata?.canonicalSha256).not.toBe(result.chapter.textSha256)
  })

  it("语义非空只认章节相关字段，静态基线单独报告（首章无前章合法）", async () => {
    const staticOnly = harness({ pack: makePack({ outline: "", soulDoc: "灵魂文档", mustDo: "必须做" }) })
    const staticResult = await inspectContext(request({ includePack: true }), staticOnly.deps)
    expect(staticResult.packMetadata?.semanticNonempty.chapterContext).toBe(false)
    expect(staticResult.packMetadata?.semanticNonempty.staticBaselineOnly).toBe(true)
    expect(staticResult.packMetadata?.semanticNonempty.presentFields).toEqual([])
    expect(staticResult.packMetadata?.semanticNonempty.baselinePresentFields).toEqual([
      "soulDoc",
      "mustDo",
    ])

    // 第 1 章：previousChapterEnding / recent* 为空是合法的，章纲存在即算真实上下文。
    const firstChapter = harness()
    const firstResult = await inspectContext(
      { projectPath: "/proj", chapter: { ...CHAPTER, index: 1, number: 1 }, params: { includePack: true } },
      firstChapter.deps,
    )
    expect(firstResult.packMetadata?.semanticNonempty.chapterContext).toBe(true)
    expect(firstResult.packMetadata?.semanticNonempty.presentFields).toContain("outline")
    expect(firstResult.packMetadata?.semanticNonempty.presentFields).not.toContain("previousChapterEnding")
  })
})

// ── 3. 六维真源 + 分页 ─────────────────────────────────────────────────────

describe("context.inspect — 六维键取自生产真源", () => {
  it("SIX_DIMENSION_KEYS 与 SIX_REVIEW_DIMENSION_ORDER / SIX_REVIEW_DIMENSIONS 完全一致", () => {
    expect([...SIX_DIMENSION_KEYS]).toEqual([...SIX_REVIEW_DIMENSION_ORDER])
    expect([...SIX_DIMENSION_KEYS]).toEqual(Object.keys(SIX_REVIEW_DIMENSIONS))
    // 六个键都必须是生产定义里的键（不是手写字符串蒙对）。
    for (const key of SIX_DIMENSION_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(SIX_REVIEW_DIMENSIONS, key)).toBe(true)
      expect(SIX_REVIEW_DIMENSIONS[key].key).toBe(key)
    }
  })

  it("非法键被拒绝，且错误信息指向生产常量（含旧计划的错拼）", async () => {
    for (const bad of ["structure", "text", "thril", "consistency ", ""]) {
      const h = harness()
      await expect(inspectContext(request({ dimension: bad }), h.deps)).rejects.toThrow(
        /SIX_REVIEW_DIMENSION_ORDER|dimension/,
      )
      expect(h.calls).toHaveLength(0)
    }
    expect(isSixReviewDimensionKey("thril")).toBe(false)
    for (const key of SIX_REVIEW_DIMENSION_ORDER) {
      expect(isSixReviewDimensionKey(key)).toBe(true)
    }
  })

  it("六个生产键逐一可选，且返回对应维度的真实 prompt", async () => {
    for (const key of SIX_REVIEW_DIMENSION_ORDER) {
      const h = harness()
      const result = await inspectContext(request({ dimension: key }), h.deps)
      expect(h.calls).toHaveLength(1)
      expect(result.dimension?.key).toBe(key)
      expect(result.dimension?.promptKind).toBe("production-user-analysis-prompt")
      expect(result.dimension?.systemPromptIncluded).toBe(false)
      expect(result.dimension?.promptScope).toBe("base-production-user-analysis-prompt")
      expect(result.dimension?.runtimeSkillHookFragmentsApplied).toBe(false)
      expect(result.dimension?.goldReadinessHintSource).toBe("assessGoldScaleReadiness.promptHint")
      expect(result.dimension?.prompt).toContain(`六维独立审查维度：${SIX_REVIEW_DIMENSIONS[key].label}`)
      expect(result.dimension?.totalChars).toBeGreaterThan(0)
      // includePack 未开 → 不返回完整 pack（避免六份重复回传）。
      expect(result.contextPack).toBeUndefined()
    }
  })

  it("基座 prompt 与生产 buildDimensionReviewPrompt 逐字一致（含 gold readiness 与 hardInject）", async () => {
    const h = harness()
    const result = await inspectContext(request({ dimension: "continuity" }), h.deps)
    const expected = buildDimensionReviewPrompt(
      h.state.pack,
      CHAPTER_TEXT,
      SIX_REVIEW_DIMENSIONS.continuity,
      {
        goldAnchors: [],
        goldReadinessHint: assessGoldScaleReadiness({ anchors: [], exemplars: [] }).promptHint,
        hardInjectEnabled: true,
      },
    )
    expect(result.dimension?.prompt).toBe(expected)
    expect(result.dimension?.promptSha256).toBe(await computeCheckpointDigest(expected))
    expect(result.dimension?.hardInjectEnabled).toBe(true)
  })

  it("分页重组 == 源生产 prompt；totalChars/nextOffset/responseTruncated 与 chapterWindowOmitted 分开", async () => {
    const pageLimit = 500
    const expected = buildDimensionReviewPrompt(
      makePack(),
      CHAPTER_TEXT,
      SIX_REVIEW_DIMENSIONS.thrill,
      {
        goldAnchors: [],
        goldReadinessHint: assessGoldScaleReadiness({ anchors: [], exemplars: [] }).promptHint,
        hardInjectEnabled: true,
      },
    )
    expect(expected.length).toBeGreaterThan(pageLimit * 2)

    const h = harness()
    let offset = 0
    let assembled = ""
    let pages = 0
    let lastTruncated = false
    let lastTotal = -1
    let inspectionId: string | undefined
    const expectedSha256 = await computeCheckpointDigest(expected)
    for (;;) {
      const result = await inspectContext(
        request({ inspectionId, dimension: "thrill", promptOffset: offset, promptLimit: pageLimit }),
        h.deps,
      )
      const page = result.dimension
      inspectionId = inspectionIdOf(result)
      expect(page).toBeDefined()
      if (!page) throw new Error("dimension 缺失")
      expect(page.pageOffset).toBe(offset)
      expect(page.totalChars).toBe(expected.length)
      expect(page.pageChars).toBe(page.prompt.length)
      expect(page.chapterWindowOmitted).toBe(false)
      expect(page.promptSha256).toBe(expectedSha256)
      expect(page.pageSha256).toBe(await computeCheckpointDigest(page.prompt))
      assembled += page.prompt
      pages += 1
      lastTruncated = page.responseTruncated
      lastTotal = page.totalChars
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBe(offset + page.prompt.length)
      offset = page.nextOffset
      if (pages > 100) throw new Error("分页失控")
    }

    expect(assembled).toBe(expected)
    expect(pages).toBeGreaterThan(2)
    expect(lastTruncated).toBe(false)
    expect(lastTotal).toBe(expected.length)
    expect(h.calls).toHaveLength(1)
    expect(h.state.goldLoads).toBe(1)
  })

  it("章节窗口省略独立报告：窗口省略 ≠ 响应分页截断", async () => {
    const maxChars = resolveReviewChapterMaxChars()
    const longText = "甲".repeat(maxChars + 500)
    const h = harness({ chapterText: longText })
    const result = await inspectContext(
      request({ dimension: "pull", promptLimit: MAX_PROMPT_PAGE_CHARS }),
      h.deps,
    )

    expect(result.reviewWindow.chapterWindowOmitted).toBe(true)
    expect(result.dimension?.chapterWindowOmitted).toBe(true)
    // 窗口省略发生在 prompt 内部（章首+章末保留）；分页只是切片，不改变正文窗口。
    expect(result.dimension?.prompt).toContain("…[中间正文已省略，保留章首与章末供审查]…")
    // 一次读完 = 响应未截断，但章节窗口仍已省略：两个概念必须分开报告。
    expect(result.dimension?.nextOffset).toBeNull()
    expect(result.dimension?.responseTruncated).toBe(false)
    expect(result.dimension?.pageChars).toBe(result.dimension?.totalChars)
    expect(result.dimension?.prompt).not.toContain("甲".repeat(maxChars + 500))
  })

  it("promptOffset 超出 prompt 长度显式报错（不返回空页假装成功）", async () => {
    const h = harness()
    const first = await inspectContext(request({ dimension: "pacing" }), h.deps)
    const total = first.dimension?.totalChars ?? 0
    await expect(
      inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "pacing", promptOffset: total + 1 }), h.deps),
    ).rejects.toThrow(/promptOffset 超出/)
  })

  it("分页常量与 Rust schema 上限一致（默认 16000 / 硬上限 50000）", () => {
    expect(DEFAULT_PROMPT_PAGE_CHARS).toBe(16_000)
    expect(MAX_PROMPT_PAGE_CHARS).toBe(50_000)
  })
})

// ── 4. 构建 DI 与遥测 ──────────────────────────────────────────────────────

describe("context.inspect — 构建用实际配置 DI，遥测丢弃", () => {
  it("build 收到同一份实际内存配置（引用相等）与丢弃 ROI 的 sink", async () => {
    const config = makeConfig()
    const h = harness({ config })
    const result = await inspectContext(request({ includePack: true }), h.deps)

    const call = h.calls[0]
    expect(call.projectPath).toBe("/proj")
    expect(call.chapterNumber).toBe(3)
    // 引用相等 = 报告出来的配置与真正参与构建的配置是同一份快照。
    expect(call.options.llmConfig).toBe(config.llmConfig)
    expect(call.options.novelConfig).toBe(config.novelConfig)
    expect(call.options.embeddingConfig).toBe(config.embeddingConfig)
    expect(call.options.rerankConfig).toBe(config.rerankConfig)
    expect(call.options.revisionFeedbackWindowConfig).toBe(config.revisionFeedbackWindowConfig)
    expect(call.options.novelMode).toBe(true)

    // telemetry sink 必须显式注入：缺省会让生产默认 sink 写 cognition-state.json。
    const sink = call.options.telemetrySink
    expect(typeof sink).toBe("function")
    expect(sink?.("/proj", {} as RoutingROISample)).toBeUndefined()
    expect(result.buildPolicy?.telemetryDiscarded).toBe(true)
    expect(result.buildPolicy?.zeroIoClaimed).toBe(false)
    expect(result.buildPolicy?.buildTriggered).toBe(true)
  })

  it("构建失败显式冒泡，不返回部分成功", async () => {
    const h = harness({
      overrides: {
        buildContextPack: async () => {
          throw new Error("build 爆炸了")
        },
      },
    })
    await expect(inspectContext(request({ includePack: true }), h.deps)).rejects.toThrow("build 爆炸了")
  })
})

// ── 5. 检索网络闸 ──────────────────────────────────────────────────────────

describe("context.inspect — 检索网络必须显式 opt-in", () => {
  it("embedding 生效时未授权 → 构建前拒绝（0 次 build）", async () => {
    const config = makeConfig({
      embeddingConfig: { ...makeConfig().embeddingConfig, enabled: true },
    })
    const h = harness({ config })
    await expect(inspectContext(request({ includePack: true }), h.deps)).rejects.toThrow(
      /allowRetrievalNetwork/,
    )
    expect(h.calls).toHaveLength(0)
  })

  it("rerank 生效时未授权同样拒绝", async () => {
    const config = makeConfig({ rerankConfig: { ...DEFAULT_RERANK_CONFIG, enabled: true } })
    const h = harness({ config })
    await expect(inspectContext(request({ dimension: "thrill" }), h.deps)).rejects.toThrow(
      /allowRetrievalNetwork/,
    )
    expect(h.calls).toHaveLength(0)
  })

  it("显式允许后按**真实 enabled 配置**构建，不强制 disabled", async () => {
    const embeddingConfig = { ...makeConfig().embeddingConfig, enabled: true }
    const config = makeConfig({ embeddingConfig })
    const h = harness({ config })
    const result = await inspectContext(
      request({ includePack: true, allowRetrievalNetwork: true }),
      h.deps,
    )

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].options.embeddingConfig?.enabled).toBe(true)
    expect(result.buildPolicy).toMatchObject({
      retrievalNetworkAllowed: true,
      effectiveNetworkEnabled: true,
      zeroIoClaimed: false,
    })
  })

  it("未构建的默认路径不需要网络授权（也不假装零 IO）", async () => {
    const config = makeConfig({ rerankConfig: { ...DEFAULT_RERANK_CONFIG, enabled: true } })
    const h = harness({ config })
    const result = await inspectContext(request(), h.deps)
    expect(h.calls).toHaveLength(0)
    expect(result.contextPackBuilt).toBe(false)
    expect(result.buildPolicy).toBeUndefined()
  })
})

// ── 6. 漂移拒绝 ────────────────────────────────────────────────────────────

describe("context.inspect — 项目/配置/正文漂移一律拒绝", () => {
  it("配置在构建期间变化 → 拒绝", async () => {
    const before = makeConfig()
    const after = makeConfig({ novelConfig: { ...before.novelConfig, chapterTargetChars: 9999 } })
    let reads = 0
    const h = harness({
      overrides: {
        readRuntimeConfig: () => {
          reads += 1
          return reads === 1 ? before : after
        },
      },
    })
    await expect(inspectContext(request({ includePack: true }), h.deps)).rejects.toThrow(/生效配置/)
  })

  it("正文在构建期间变化 → 拒绝", async () => {
    let reads = 0
    const h = harness({
      overrides: {
        readFileText: async () => {
          reads += 1
          return reads === 1 ? CHAPTER_TEXT : `${CHAPTER_TEXT}\n被改过的一行`
        },
      },
    })
    await expect(inspectContext(request({ includePack: true }), h.deps)).rejects.toThrow(/章节正文/)
  })

  it("项目在构建期间被切换 → 拒绝", async () => {
    let reads = 0
    const h = harness({
      overrides: {
        readProjectPath: () => {
          reads += 1
          return reads === 1 ? "/proj" : "/another-project"
        },
      },
    })
    await expect(inspectContext(request({ includePack: true }), h.deps)).rejects.toThrow(/项目/)
  })

  it("调用开始时项目已与请求不一致 → 立即拒绝", async () => {
    const h = harness({ projectPath: "/another-project" })
    await expect(inspectContext(request(), h.deps)).rejects.toThrow(/项目/)
  })
})

// ── 7. 参数校验 ────────────────────────────────────────────────────────────

describe("context.inspect — 非法参数显式拒绝", () => {
  it("布尔/整数/字符串参数类型严格", async () => {
    const cases: Array<Record<string, unknown>> = [
      { includePack: "true" },
      { includeChapter: 1 },
      { allowRetrievalNetwork: "yes" },
      { promptOffset: -1 },
      { promptOffset: 1.5 },
      { promptLimit: 0 },
      { promptLimit: MAX_PROMPT_PAGE_CHARS + 1 },
      { promptLimit: "1000" },
      { task: "" },
      { task: 42 },
      { inspectionId: 42 },
      { inspectionId: " " },
    ]
    for (const params of cases) {
      const h = harness()
      await expect(inspectContext(request(params), h.deps)).rejects.toThrow(/context\.inspect/)
      expect(h.calls).toHaveLength(0)
    }
  })

  it("未知键和每个合法键的显式 null 都拒绝，不静默忽略拼写错误", async () => {
    const cases: Array<Record<string, unknown>> = [
      { includePacks: true }, { dimenion: "thrill" }, { extra: 1 },
      ...["chapter", "task", "inspectionId", "dimension", "includePack", "includeChapter",
        "allowRetrievalNetwork", "promptOffset", "promptLimit"].map((key) => ({ [key]: null })),
    ]
    for (const params of cases) {
      const h = harness()
      await expect(inspectContext(request(params), h.deps)).rejects.toThrow(/context\.inspect/)
      expect(h.calls).toHaveLength(0)
      expect(h.state.goldLoads).toBe(0)
    }
  })

  it("缺少项目路径或章节条目 → 拒绝", async () => {
    const h = harness()
    await expect(
      inspectContext({ projectPath: "", chapter: CHAPTER, params: {} }, h.deps),
    ).rejects.toThrow(/项目/)
    await expect(
      inspectContext(
        { projectPath: "/proj", chapter: { ...CHAPTER, path: "" }, params: {} },
        h.deps,
      ),
    ).rejects.toThrow(/章节条目/)
  })
})

describe("context.inspect — 指纹、完整大小与静态风格边界", () => {
  it("生产 FNV-1a 64-bit 使用标准已知答案", () => {
    for (const [text, expected] of [
      ["", "cbf29ce484222325"],
      ["a", "af63dc4c8601ec8c"],
      ["hello", "a430d84680aabd0b"],
      ["foobar", "85944171f73967e8"],
      ["é", "0ac21707b7181e01"],
    ]) expect(fingerprintText(text)).toBe(expected)
  })

  it("非 canonical 大字段影响完整 pack 大小，UTF-8 bytes 与 UTF-16 长度分域", async () => {
    const small = harness()
    const large = harness({ pack: makePack({ activeEntities: [
      { entityId: "e1", name: "甲😀".repeat(2_000), type: "character", tags: [] },
    ] }) })
    const before = await inspectContext(request({ includePack: true }), small.deps)
    const after = await inspectContext(request({ includePack: true }), large.deps)
    const metadata = after.packMetadata
    const full = JSON.stringify(large.state.pack)
    const canonical = canonicalizeContextPackForHash(large.state.pack)
    expect(metadata?.packChars).toBe(full.length)
    expect(metadata?.canonicalChars).toBe(canonical.length)
    expect(metadata?.packUtf8Bytes).toBe(new TextEncoder().encode(full).length)
    expect(metadata?.canonicalUtf8Bytes).toBe(new TextEncoder().encode(canonical).length)
    expect(metadata?.packChars).toBeGreaterThan(before.packMetadata?.packChars ?? 0)
    expect(metadata?.packUtf8Bytes).toBeGreaterThan(metadata?.packChars ?? 0)
    expect(metadata?.canonicalSha256).toBe(before.packMetadata?.canonicalSha256)
    expect(metadata?.lengthDomains.packChars).toContain("JSON.stringify(full ContextPack)")
    expect(metadata?.lengthDomains.canonicalChars).toContain("utf16-code-units")
  })

  it("只有 styleExemplars 是静态风格基线，不能充作章节前情", async () => {
    const h = harness({ pack: makePack({ outline: "", styleExemplars: [
      { exemplarId: "style-1", chapterId: "ch-1", text: "风格示例", markType: "thrill", createdAt: "2026-11-20T00:00:00.000Z" },
    ] }) })
    const result = await inspectContext(request({ includePack: true }), h.deps)
    expect(result.packMetadata?.semanticNonempty).toMatchObject({
      chapterContext: false, staticBaselineOnly: true, presentFields: [],
      baselinePresentFields: ["styleExemplars"],
    })
  })

  it("分页 offset / chars 明确是 UTF-16 code units，页 SHA 仍对该页的 UTF-8 计算", async () => {
    const h = harness({ chapterText: "甲😀乙" })
    const first = await inspectContext(request({ dimension: "continuity" }), h.deps)
    const fullPrompt = first.dimension?.prompt ?? ""
    const emojiOffset = fullPrompt.indexOf("😀")
    expect(emojiOffset).toBeGreaterThan(0)
    const result = await inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "continuity",
      promptOffset: emojiOffset + 1, promptLimit: 1 }), h.deps)
    expect(result.chapter.chars).toBe(4)
    expect(result.chapter.charsDomain).toBe("utf16-code-units")
    expect(result.dimension?.offsetDomain).toBe("utf16-code-units")
    expect(result.dimension?.pageChars).toBe(1)
    expect(result.dimension?.prompt).toBe(fullPrompt.slice(emojiOffset + 1, emojiOffset + 2))
    expect(result.dimension?.pageSha256).toBe(await computeCheckpointDigest(result.dimension?.prompt ?? ""))
  })
})

describe("context.inspect — inspectionId 冻结批次", () => {
  it("首次 includePack 后同 ID 六维和多页只 build / gold load 一次", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const inspectionId = inspectionIdOf(first)
    expect(first.inspection).toMatchObject({ cacheHit: false, externalSourcesRevalidated: false,
      acceptOrIngestRequiresNewInspection: true })
    expect(first.inspection?.expiresAt).toBe((first.inspection?.createdAt ?? 0) + INSPECTION_CACHE_TTL_MS)
    for (const key of SIX_REVIEW_DIMENSION_ORDER) {
      const expected = buildDimensionReviewPrompt(h.state.pack, CHAPTER_TEXT, SIX_REVIEW_DIMENSIONS[key], {
        goldAnchors: [], goldReadinessHint: assessGoldScaleReadiness({ anchors: [], exemplars: [] }).promptHint,
        hardInjectEnabled: true,
      })
      const expectedSha256 = await computeCheckpointDigest(expected)
      let offset = 0
      let assembled = ""
      let pages = 0
      for (;;) {
        const result = await inspectContext(request({ inspectionId, dimension: key, promptOffset: offset,
          promptLimit: 700 }), h.deps)
        const page = result.dimension
        if (!page) throw new Error("dimension 缺失")
        expect(result.inspectionId).toBe(inspectionId)
        expect(result.inspection?.cacheHit).toBe(true)
        expect(result.buildPolicy?.buildTriggered).toBe(false)
        expect(result.packMetadata?.canonicalSha256).toBe(first.packMetadata?.canonicalSha256)
        expect(page.promptSha256).toBe(expectedSha256)
        expect(page.pageSha256).toBe(await computeCheckpointDigest(page.prompt))
        assembled += page.prompt
        pages += 1
        if (page.nextOffset === null) break
        offset = page.nextOffset
        if (pages > 100) throw new Error("分页失控")
      }
      expect(pages).toBeGreaterThan(1)
      expect(assembled).toBe(expected)
    }
    expect(h.calls).toHaveLength(1)
    expect(h.state.goldLoads).toBe(1)
  })

  it("未带 ID 的两次显式请求各发新随机 ID，不宣称隐式缓存", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const second = await inspectContext(request({ dimension: "pull" }), h.deps)
    expect(inspectionIdOf(second)).not.toBe(inspectionIdOf(first))
    expect(h.calls).toHaveLength(2)
    expect(h.state.goldLoads).toBe(2)
  })

  it("未知 ID 在读文件 / 构建前失败，不静默重建", async () => {
    const h = harness()
    await expect(inspectContext(request({ inspectionId: "unknown-id", includePack: true }), h.deps))
      .rejects.toThrow(/未知或已失效.*不会静默重建/)
    expect(h.calls).toHaveLength(0)
    expect(h.state.textReads).toBe(0)
    expect(h.state.goldLoads).toBe(0)
  })

  it("TTL 到界即过期，删除 ID 后仍明确失败", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const inspectionId = inspectionIdOf(first)
    h.state.now += INSPECTION_CACHE_TTL_MS
    await expect(inspectContext(request({ inspectionId, dimension: "thrill" }), h.deps)).rejects.toThrow(/已过期/)
    await expect(inspectContext(request({ inspectionId, includePack: true }), h.deps)).rejects.toThrow(/未知或已失效/)
    expect(h.deps.inspectionCache?.size).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.state.goldLoads).toBe(1)
  })

  it("容量最多 8 条，第 9 次新构建淘汰最早批次而非重建旧 ID", async () => {
    const h = harness()
    const ids: string[] = []
    for (let index = 0; index <= MAX_INSPECTION_CACHE_ENTRIES; index += 1) {
      ids.push(inspectionIdOf(await inspectContext(request({ includePack: true }), h.deps)))
      h.state.now += 1
    }
    expect(new Set(ids).size).toBe(MAX_INSPECTION_CACHE_ENTRIES + 1)
    expect(h.deps.inspectionCache?.size).toBe(MAX_INSPECTION_CACHE_ENTRIES)
    await expect(inspectContext(request({ inspectionId: ids[0], dimension: "thrill" }), h.deps)).rejects.toThrow(/已失效/)
    await inspectContext(request({ inspectionId: ids[1], dimension: "thrill" }), h.deps)
    expect(h.calls).toHaveLength(MAX_INSPECTION_CACHE_ENTRIES + 1)
  })

  it("跨项目 ID 拒绝并删除，不回传另一项目的 pack 或私有配置", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const reads = h.state.textReads
    h.state.projectPath = "/another-project"
    await expect(inspectContext({ projectPath: h.state.projectPath, chapter: CHAPTER,
      params: { inspectionId: inspectionIdOf(first), includePack: true } }, h.deps)).rejects.toThrow(/项目/)
    expect(h.state.textReads).toBe(reads)
    expect(h.calls).toHaveLength(1)
    expect(h.deps.inspectionCache?.size).toBe(0)
  })

  it("chapter 的 path/name/index/number 任一漂移都拒绝旧 ID", async () => {
    const changes: Partial<InspectedChapter>[] = [
      { path: "/proj/other.md" }, { name: "chapter-003-renamed.md" }, { index: 4 }, { number: 4 },
    ]
    for (const change of changes) {
      const h = harness()
      const first = await inspectContext(request({ includePack: true }), h.deps)
      await expect(inspectContext({ projectPath: "/proj", chapter: { ...CHAPTER, ...change },
        params: { inspectionId: inspectionIdOf(first), includePack: true } }, h.deps)).rejects.toThrow(/章节定位/)
      expect(h.calls).toHaveLength(1)
      expect(h.deps.inspectionCache?.size).toBe(0)
    }
  })

  it("正文漂移删除 ID，只有不带旧 ID 的显式新 inspection 才再构建", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const inspectionId = inspectionIdOf(first)
    h.state.chapterText += "\n新正文"
    await expect(inspectContext(request({ inspectionId, dimension: "thrill" }), h.deps)).rejects.toThrow(/章节正文/)
    await expect(inspectContext(request({ inspectionId, includePack: true }), h.deps)).rejects.toThrow(/已失效/)
    expect(h.calls).toHaveLength(1)
    const fresh = await inspectContext(request({ includePack: true }), h.deps)
    expect(inspectionIdOf(fresh)).not.toBe(inspectionId)
    expect(h.calls).toHaveLength(2)
  })

  it.each(["public", "private"])("完整配置 %s 字段漂移都拒绝 ID，私有值不外泄", async (kind) => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const inspectionId = inspectionIdOf(first)
    if (kind === "public") h.state.config.novelConfig.chapterTargetChars += 1
    else h.state.config.llmConfig.apiKey = "sk-PRIVATE-ROTATED"
    await expect(inspectContext(request({ inspectionId, dimension: "pull" }), h.deps)).rejects.toThrow(/生效配置/)
    expect(h.calls).toHaveLength(1)
    expect(h.deps.inspectionCache?.size).toBe(0)
    const serialized = JSON.stringify(first)
    for (const secret of ["sk-SECRET-LLM", "sk-PRIVATE-ROTATED", "https://secret.example/v1",
      "sk-SECRET-EMBED", "http://secret-embed.local/v1/embeddings", "SECRET_TASK_EXTRA"]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain("privateConfigFingerprint")
  })

  it.each(["task", "network"])("冻结 %s 政策变化拒绝 ID，不触发新检索", async (kind) => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true, task: "冻结任务", allowRetrievalNetwork: true }), h.deps)
    await expect(inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "thrill",
      task: kind === "task" ? "另一任务" : "冻结任务", allowRetrievalNetwork: kind !== "network" }), h.deps))
      .rejects.toThrow(kind === "task" ? /冻结 task/ : /检索网络策略/)
    expect(h.calls).toHaveLength(1)
    expect(h.state.goldLoads).toBe(1)
    expect(h.deps.inspectionCache?.size).toBe(0)
  })

  it("完整可序列化字段独立保值，调用方和生产对象的后续修改不污染缓存", async () => {
    const pack = Object.assign(makePack({ recentChapterContents: ["原前章"] }), {
      extension: { nested: [{ value: "完整扩展字段" }], nullable: null },
    })
    const expected = JSON.parse(JSON.stringify(pack)) as typeof pack
    const h = harness({ pack })
    const first = await inspectContext(request({ includePack: true, dimension: "thrill" }), h.deps)
    if (!first.contextPack || !first.packMetadata) throw new Error("pack 缺失")
    first.contextPack.outline = "调用方改写"
    first.contextPack.recentChapterContents?.push("调用方追加")
    first.packMetadata.semanticNonempty.presentFields.push("调用方污染")
    pack.outline = "生产共享对象改写"
    pack.extension.nested[0].value = "生产扩展字段改写"
    expect(Object.isFrozen(pack)).toBe(false)
    const second = await inspectContext(request({ inspectionId: inspectionIdOf(first), includePack: true,
      dimension: "thrill" }), h.deps)
    expect(second.contextPack).toEqual(expected)
    expect(second.packMetadata?.semanticNonempty.presentFields).not.toContain("调用方污染")
    expect(second.dimension?.promptSha256).toBe(first.dimension?.promptSha256)
    expect(h.calls).toHaveLength(1)
  })
})

describe("context.inspect — 所有 await 后的最终漂移检查", () => {
  it("默认 metadata 也在读正文后的 await 期间核对配置与正文", async () => {
    for (const kind of ["config", "body"]) {
      const h = harness()
      const read = h.deps.readFileText
      let reads = 0
      h.deps.readFileText = async (path) => {
        reads += 1
        const text = await read(path)
        if (reads === 1) {
          if (kind === "config") h.state.config.novelConfig.chapterTargetChars += 1
          else h.state.chapterText += "默认路径期间改写"
        }
        return text
      }
      await expect(inspectContext(request(), h.deps)).rejects.toThrow(kind === "config" ? /生效配置/ : /章节正文/)
      expect(h.calls).toHaveLength(0)
    }
  })

  it.each([false, true])("includePack=%s 的配置投影 await 后改设置仍拒绝", async (includePack) => {
    const h = harness()
    const originalDigest = checkpointDigest.computeCheckpointDigest
    const spy = vi.spyOn(checkpointDigest, "computeCheckpointDigest").mockImplementation(async (text) => {
      const digest = await originalDigest(text)
      if (text === "SECRET_TASK_EXTRA") h.state.config.novelConfig.chapterTargetChars += 1
      return digest
    })
    try {
      await expect(inspectContext(request({ includePack }), h.deps)).rejects.toThrow(/生效配置/)
    } finally {
      spy.mockRestore()
    }
    expect(h.deps.inspectionCache?.size).toBe(0)
  })

  it("最终正文 SHA await 后发生项目切换仍拒绝", async () => {
    const h = harness()
    const originalDigest = checkpointDigest.computeCheckpointDigest
    let textHashes = 0
    const spy = vi.spyOn(checkpointDigest, "computeCheckpointDigest").mockImplementation(async (text) => {
      const digest = await originalDigest(text)
      if (text === CHAPTER_TEXT && ++textHashes === 2) h.state.projectPath = "/another-project"
      return digest
    })
    try {
      await expect(inspectContext(request(), h.deps)).rejects.toThrow(/项目/)
    } finally {
      spy.mockRestore()
    }
  })

  it("cache hit 的最后一次正文读取 await 期间配置漂移删除批次", async () => {
    const h = harness()
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const read = h.deps.readFileText
    let reads = 0
    h.deps.readFileText = async (path) => {
      const text = await read(path)
      if (++reads === 2) h.state.config.llmConfig.apiKey = "sk-PRIVATE-END-DRIFT"
      return text
    }
    await expect(inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "pull" }), h.deps))
      .rejects.toThrow(/生效配置/)
    expect(h.calls).toHaveLength(1)
    expect(h.state.goldLoads).toBe(1)
    expect(h.deps.inspectionCache?.size).toBe(0)
  })
})

describe("context.inspect — gold 只加载一次且异常显式软降级", () => {
  it("gold 材料使用独立快照；后续维度不再加载或重新读取共享材料", async () => {
    const anchor: LiteraryGoldAnchor = { id: "test-provisional", dimension: "thrill", targetScore: 9,
      text: "原测试 provisional 锚段", status: "provisional" }
    const materials = { anchors: [anchor], exemplars: [], merged: [anchor] }
    let loads = 0
    const h = harness({ overrides: { loadGoldMaterials: async () => { loads += 1; return materials } } })
    const first = await inspectContext(request({ includePack: true }), h.deps)
    const expected = buildDimensionReviewPrompt(h.state.pack, CHAPTER_TEXT, SIX_REVIEW_DIMENSIONS.thrill, {
      goldAnchors: materials.merged, goldReadinessHint: assessGoldScaleReadiness(materials).promptHint,
      hardInjectEnabled: true,
    })
    anchor.text = "共享材料被修改"
    materials.merged.length = 0
    const result = await inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "thrill" }), h.deps)
    expect(result.dimension?.prompt).toBe(expected)
    expect(result.dimension?.goldAnchorCount).toBe(1)
    expect(result.dimension?.goldMaterialsSoftFailed).toBe(false)
    expect(loads).toBe(1)
  })

  it("loader throw 时空 hint / 零 anchor / 稳定标记，同 ID 多维和分页不再加载", async () => {
    let loads = 0
    const h = harness({ overrides: { loadGoldMaterials: async () => {
      loads += 1
      throw new Error("PRIVATE_GOLD_ERROR https://private.example/sk-secret")
    } } })
    const first = await inspectContext(request({ dimension: "thrill" }), h.deps)
    const expected = buildDimensionReviewPrompt(h.state.pack, CHAPTER_TEXT, SIX_REVIEW_DIMENSIONS.thrill, {
      goldAnchors: [], goldReadinessHint: "", hardInjectEnabled: true,
    })
    expect(first.dimension?.prompt).toBe(expected)
    expect(first.dimension).toMatchObject({ goldAnchorCount: 0, goldMaterialsSoftFailed: true,
      goldMaterialsDiagnostic: "gold-materials-load-soft-failed" })
    for (const dimension of SIX_REVIEW_DIMENSION_ORDER) {
      const result = await inspectContext(request({ inspectionId: inspectionIdOf(first), dimension,
        promptLimit: 500 }), h.deps)
      expect(result.dimension?.goldAnchorCount).toBe(0)
      expect(result.dimension?.goldMaterialsSoftFailed).toBe(true)
    }
    await inspectContext(request({ inspectionId: inspectionIdOf(first), dimension: "thrill", promptOffset: 500,
      promptLimit: 500 }), h.deps)
    expect(loads).toBe(1)
    expect(h.calls).toHaveLength(1)
    expect(JSON.stringify(first)).not.toContain("PRIVATE_GOLD_ERROR")
    expect(JSON.stringify(first)).not.toContain("private.example")
  })

  it("readiness assess throw 同样软降级，不捏造 gold 就绪或分数", async () => {
    const h = harness({ overrides: { assessGoldReadiness: () => { throw new Error("PRIVATE_READINESS_ERROR") } } })
    const result = await inspectContext(request({ dimension: "pull" }), h.deps)
    const expected = buildDimensionReviewPrompt(h.state.pack, CHAPTER_TEXT, SIX_REVIEW_DIMENSIONS.pull, {
      goldAnchors: [], goldReadinessHint: "", hardInjectEnabled: true,
    })
    expect(result.dimension?.prompt).toBe(expected)
    expect(result.dimension).toMatchObject({ goldAnchorCount: 0, goldMaterialsSoftFailed: true,
      goldMaterialsDiagnostic: "gold-readiness-assess-soft-failed" })
    expect(h.state.goldLoads).toBe(1)
    expect(JSON.stringify(result)).not.toContain("PRIVATE_READINESS_ERROR")
    expect(result.dimension).not.toHaveProperty("score")
  })
})

describe("context.inspect — 内部章复查 callback 契约", () => {
  it("内部 callback await 先完成，再读最终正文与完整配置", async () => {
    const h = harness()
    const events: string[] = []
    const readText = h.deps.readFileText
    const readConfig = h.deps.readRuntimeConfig
    h.deps.readFileText = async (path) => { events.push("text"); return readText(path) }
    h.deps.readRuntimeConfig = () => { events.push("config"); return readConfig() }
    await inspectContext({ ...request(), recheckChapter: async () => {
      await Promise.resolve()
      events.push("chapter-recheck")
    } }, h.deps)
    expect(events).toEqual(["config", "text", "chapter-recheck", "text", "config"])
    expect(h.calls).toHaveLength(0)
    expect(h.state.goldLoads).toBe(0)
  })

  it.each(["metadata", "fresh", "cache"] as const)("%s callback 抛错显式拒绝并失效，不重建", async (mode) => {
    const h = harness()
    const seed = mode === "cache" ? await inspectContext(request({ includePack: true }), h.deps) : undefined
    const inspectionId = seed ? inspectionIdOf(seed) : undefined
    const params = mode === "metadata" ? {} : { includePack: true, inspectionId, dimension: "pull" }
    await expect(inspectContext({ ...request(params), recheckChapter: async () => {
      throw new Error("目录身份复查失败")
    } }, h.deps)).rejects.toThrow("目录身份复查失败")
    expect(h.deps.inspectionCache?.size).toBe(0)
    expect(h.calls).toHaveLength(mode === "metadata" ? 0 : 1)
    expect(h.state.goldLoads).toBe(mode === "metadata" ? 0 : 1)
    if (inspectionId) {
      await expect(inspectContext(request({ inspectionId, includePack: true }), h.deps)).rejects.toThrow(/已失效/)
      expect(h.calls).toHaveLength(1)
    }
  })

  it("内部 callback 不是 MCP 参数，wire params 仍严格拒绝它", async () => {
    const h = harness()
    await expect(inspectContext(request({ recheckChapter: async () => undefined }), h.deps)).rejects.toThrow(/参数未知/)
    expect(h.calls).toHaveLength(0)
  })
})

// ── R2-B2: runPrepareWriteContext 零 LLM / 零写盘写作准备门面 ────────────────

function makePlanningView(chapterNumber: number): ChapterPlanView {
  return {
    chapterNumber,
    generatedAt: "2026-11-26T00:00:00.000Z",
    foreshadowing: {
      status: "ok",
      report: { currentChapter: chapterNumber, items: [], debtScore: 0 },
      overdueFindings: [],
    },
    characters: { status: "ok", items: [] },
    threads: { status: "ok", items: [], openCount: 0 },
    summary: { debtScore: 0, criticalForeshadowing: 0, openThreads: 0, charactersDue: 0 },
  } as unknown as ChapterPlanView
}

function makePrepareHarness(options: {
  config?: ContextRuntimeConfig
  chapters?: Array<{ name: string; path: string }>
  drafts?: ChapterDraft[]
  pack?: ContextPack
  projectPath?: string
  overrides?: Partial<PrepareWriteContextDeps>
} = {}) {
  const state = {
    projectPath: options.projectPath ?? "/proj",
    config: options.config ?? makeConfig(),
    chapters: options.chapters ?? [],
    drafts: options.drafts ?? [],
    pack: options.pack ?? makePack({ worldBlueprint: "# 世界观骨架\n- 灵气枯竭时代" }),
    planCalls: [] as number[],
    goldLoads: 0,
  }
  const calls: BuildCall[] = []
  const deps: PrepareWriteContextDeps = {
    readProjectPath: () => state.projectPath,
    readRuntimeConfig: () => state.config,
    listChapters: async () => state.chapters,
    listDrafts: async () => state.drafts,
    buildContextPack: async (projectPath, task, chapterNumber, buildOptions) => {
      calls.push({ projectPath, task, chapterNumber, options: buildOptions })
      return { ...state.pack, task }
    },
    buildChapterPlan: async (_projectPath, chapterNumber) => {
      state.planCalls.push(chapterNumber)
      return makePlanningView(chapterNumber)
    },
    loadGoldMaterials: async () => {
      state.goldLoads += 1
      return { anchors: [], exemplars: [], merged: [] }
    },
    assessGoldReadiness: assessGoldScaleReadiness,
    ...options.overrides,
  }
  return { deps, calls, state }
}

describe("context.prepare (runPrepareWriteContext) — R2-B2", () => {
  it("0 章新书准备第 1 章上下文：返回世界观/大纲/规划视图、丢弃 ROI 遥测且零写盘零秘密泄漏", async () => {
    const h = makePrepareHarness({ chapters: [] })
    const result = await runPrepareWriteContext("/proj", { includePack: true }, h.deps)

    expect(result.mode).toBe("new_book_chapter_1")
    expect(result.isNewBook).toBe(true)
    expect(result.existingChapterCount).toBe(0)
    expect(result.targetChapter).toBe(1)
    expect(result.novelMode).toBe(true)
    expect(result.warning).toBeNull()
    expect(result.warnings).toEqual([])
    expect(result.planningView?.chapterNumber).toBe(1)
    expect(h.state.planCalls).toEqual([1])
    expect(result.contextPack?.worldBlueprint).toContain("灵气枯竭时代")
    expect(result.prompt.text).toContain("本章章纲")
    expect(result.meta).toEqual({ llmCalls: 0, diskWrites: 0 })
    expect(result.buildPolicy).toMatchObject({
      telemetryDiscarded: true,
      retrievalNetworkAllowed: false,
      effectiveNetworkEnabled: false,
      zeroIoClaimed: false,
      llmCalls: 0,
      diskWrites: 0,
    })

    // telemetrySink 必须显式丢弃 ROI（不写 cognition-state.json）
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.chapterNumber).toBe(1)
    expect(typeof h.calls[0]?.options.telemetrySink).toBe("function")
    expect(h.calls[0]?.options.telemetrySink?.("/proj", {} as RoutingROISample)).toBeUndefined()

    // 零凭据泄漏
    const serialized = JSON.stringify(result)
    for (const secret of ["sk-SECRET-LLM", "sk-SECRET-EMBED", "https://secret.example/v1", "SECRET_TASK_EXTRA"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("第 N+1 章续写上下文按字符分页（offset / limit / totalChars / hasMore / nextOffset），拼回与源 prompt 逐字一致", async () => {
    const longOutline = "第一段剧情推进与冲突展开。".repeat(80)
    const h = makePrepareHarness({
      chapters: [
        { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md" },
        { name: "chapter-002.md", path: "/proj/wiki/chapters/chapter-002.md" },
        { name: "第3章-暗潮.md", path: "/proj/wiki/chapters/第3章-暗潮.md" },
      ],
      pack: makePack({ outline: longOutline, previousChapterEnding: "上一章结尾停在悬崖边。" }),
    })

    const expectedTask = "准备写作第4章"
    const expectedFull = contextPackToPrompt(
      { ...h.state.pack, task: expectedTask },
      h.state.config.novelConfig.contextTokenBudget,
      {
        temporalFactsEnabled: h.state.config.novelConfig.temporalFactsEnabled === true,
        hardInjectEnabled: h.state.config.novelConfig.hardInjectEnabled === true,
      },
    )
    expect(expectedFull.length).toBeGreaterThan(600)

    let offset = 0
    let assembled = ""
    let pages = 0
    for (;;) {
      const pageRes = await runPrepareWriteContext(
        "/proj",
        { offset, limit: 300, includePlanningView: false },
        h.deps,
      )
      expect(pageRes.mode).toBe("next_chapter")
      expect(pageRes.isNewBook).toBe(false)
      expect(pageRes.existingChapterCount).toBe(3)
      expect(pageRes.targetChapter).toBe(4)
      expect(pageRes.planningView).toBeUndefined()
      expect(pageRes.prompt.offset).toBe(offset)
      expect(pageRes.prompt.limit).toBe(300)
      expect(pageRes.prompt.totalChars).toBe(expectedFull.length)
      expect(pageRes.prompt.pageChars).toBe(pageRes.prompt.text.length)
      assembled += pageRes.prompt.text
      pages += 1
      if (!pageRes.prompt.hasMore) {
        expect(pageRes.prompt.nextOffset).toBeNull()
        break
      }
      expect(pageRes.prompt.nextOffset).toBe(offset + pageRes.prompt.pageChars)
      offset = pageRes.prompt.nextOffset!
      if (pages > 50) throw new Error("分页失控")
    }
    expect(pages).toBeGreaterThan(2)
    expect(assembled).toBe(expectedFull)
    expect(h.state.planCalls).toEqual([])

    // offset 越界明确报错
    await expect(
      runPrepareWriteContext("/proj", { offset: expectedFull.length + 1 }, h.deps),
    ).rejects.toThrow(/offset 超出长度/)
  })

  it("待审草稿 draftId + dimension 返回六维标准与生产审查 prompt 并支持分页，includeDraft=true 才携带正文", async () => {
    const draft: ChapterDraft = {
      id: "draft_review_7",
      chapterName: "第7章-伏笔回收",
      content: "草稿正文第一段，主角在雨夜揭开谜底。\n".repeat(40),
      createdAt: 1_700_000_500_000,
      status: "draft",
      sourceConversationId: "mcp:chapter.write",
    }
    const h = makePrepareHarness({ drafts: [draft] })

    const noDraftText = await runPrepareWriteContext(
      "/proj",
      { draftId: "draft_review_7", dimension: "thrill", offset: 0, limit: 400 },
      h.deps,
    )
    expect(noDraftText.mode).toBe("draft_review")
    expect(noDraftText.targetChapter).toBe(7)
    expect(noDraftText.draft).toMatchObject({
      draftId: "draft_review_7",
      chapterName: "第7章-伏笔回收",
      chapterNumber: 7,
      chars: draft.content.length,
    })
    expect(noDraftText.draftText).toBeUndefined()
    expect(noDraftText.dimension?.key).toBe("thrill")
    expect(noDraftText.dimension?.label).toBe(SIX_REVIEW_DIMENSIONS.thrill.label)
    expect(noDraftText.dimension?.reviewPromptBuilt).toBe(true)
    expect(noDraftText.dimension?.hasMore).toBe(true)
    expect(noDraftText.dimension?.nextOffset).toBe(400)

    const withDraftText = await runPrepareWriteContext(
      "/proj",
      {
        draftId: "draft_review_7",
        dimension: "thrill",
        includeDraft: true,
        offset: 400,
        limit: MAX_PROMPT_PAGE_CHARS,
      },
      h.deps,
    )
    expect(withDraftText.draftText).toBe(draft.content)
    const combinedReview = `${noDraftText.dimension?.prompt ?? ""}${withDraftText.dimension?.prompt ?? ""}`
    const expectedReview = buildDimensionReviewPrompt(
      { ...h.state.pack, task: "六维审查第7章（草稿 draft_review_7）" },
      draft.content,
      SIX_REVIEW_DIMENSIONS.thrill,
      {
        goldAnchors: [],
        goldReadinessHint: assessGoldScaleReadiness({ anchors: [], exemplars: [] }).promptHint,
        hardInjectEnabled: true,
      },
    )
    expect(combinedReview).toBe(expectedReview)
  })

  it("novelMode=false 时不崩溃，显式发出 warning 与 warnings 告警", async () => {
    const h = makePrepareHarness({
      config: makeConfig({ novelMode: false }),
      pack: makePack({ outline: "" }),
    })
    const result = await runPrepareWriteContext("/proj", {}, h.deps)

    expect(result.novelMode).toBe(false)
    expect(result.warning).toBeTruthy()
    expect(result.warning).toContain("novelMode=false")
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.meta).toEqual({ llmCalls: 0, diskWrites: 0 })
  })

  it("严格校验非法 dimension / targetChapter / draftId / offset / limit / 未知键与网络检索门禁", async () => {
    const badParams: Array<Record<string, unknown>> = [
      { dimension: "thril" },
      { dimension: "structure" },
      { dimension: "" },
      { targetChapter: 0 },
      { targetChapter: -2 },
      { targetChapter: 1.5 },
      { draftId: "../evil" },
      { draftId: "" },
      { draftId: "a".repeat(129) },
      { offset: -1 },
      { offset: 1.2 },
      { limit: 0 },
      { limit: MAX_PROMPT_PAGE_CHARS + 1 },
      { unknownKey: true },
    ]
    for (const params of badParams) {
      const h = makePrepareHarness()
      await expect(runPrepareWriteContext("/proj", params, h.deps)).rejects.toThrow(/context\.prepare_write/)
      expect(h.calls).toHaveLength(0)
    }

    // 启用了检索网络但未传 allowRetrievalNetwork=true 时在构建前拒绝
    const netHarness = makePrepareHarness({
      config: makeConfig({
        embeddingConfig: { ...makeConfig().embeddingConfig, enabled: true },
      }),
    })
    await expect(runPrepareWriteContext("/proj", {}, netHarness.deps)).rejects.toThrow(
      /allowRetrievalNetwork/,
    )
    expect(netHarness.calls).toHaveLength(0)
  })
})

// ── P1-B1: retrievalMode 零网络纯内存守卫、冲突拒绝与 workflowHint ──────────

describe("context.prepare (runPrepareWriteContext) — P1-B1 retrievalMode & workflowHint", () => {
  it("1) retrievalMode=local_only 同时包裹 buildContextPack 与 buildChapterPlan，传入禁网副本且不改原配置、不写 localStorage", async () => {
    const setItemSpy = vi.fn()
    const storageMap = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
      setItem: (key: string, value: string) => {
        setItemSpy(key, value)
        storageMap.set(key, value)
      },
      removeItem: (key: string) => void storageMap.delete(key),
    })

    const prevOffline = useWikiStore.getState().offlineMode
    useWikiStore.setState({ offlineMode: false })

    try {
      const config = makeConfig({
        embeddingConfig: { ...makeConfig().embeddingConfig, enabled: true },
        rerankConfig: { ...DEFAULT_RERANK_CONFIG, enabled: true },
      })
      const observedOffline: string[] = []
      const h = makePrepareHarness({
        config,
        overrides: {
          buildContextPack: async (projectPath, task, chapterNumber, buildOptions) => {
            observedOffline.push(`pack:${String(useWikiStore.getState().offlineMode)}`)
            h.calls.push({ projectPath, task, chapterNumber, options: buildOptions })
            return { ...h.state.pack, task }
          },
          buildChapterPlan: async (_projectPath, chapterNumber) => {
            observedOffline.push(`plan:${String(useWikiStore.getState().offlineMode)}`)
            h.state.planCalls.push(chapterNumber)
            return makePlanningView(chapterNumber)
          },
        },
      })

      const result = await runPrepareWriteContext("/proj", { retrievalMode: "local_only" }, h.deps)

      expect(PREPARE_RETRIEVAL_MODES).toEqual(["local_only", "configured_network"])
      expect(observedOffline).toEqual(["pack:true", "plan:true"])
      // 退出后纯内存恢复，且零 localStorage 写入
      expect(useWikiStore.getState().offlineMode).toBe(false)
      expect(setItemSpy).not.toHaveBeenCalled()

      // 传给 buildContextPack 的是禁网副本，绝不修改 configAtStart 原对象
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]?.options.embeddingConfig?.enabled).toBe(false)
      expect(h.calls[0]?.options.rerankConfig?.enabled).toBe(false)
      expect(h.calls[0]?.options.embeddingConfig).not.toBe(config.embeddingConfig)
      expect(h.calls[0]?.options.rerankConfig).not.toBe(config.rerankConfig)
      expect(config.embeddingConfig.enabled).toBe(true)
      expect(config.rerankConfig.enabled).toBe(true)

      expect(result.buildPolicy).toEqual({
        telemetryDiscarded: true,
        retrievalMode: "local_only",
        retrievalNetworkAllowed: false,
        effectiveNetworkEnabled: true,
        networkRetrievalSkipped: true,
        zeroIoClaimed: false,
        llmCalls: 0,
        diskWrites: 0,
      })

      // 异常路径同样在 finally 恢复 offlineMode 且零 localStorage 写入
      const failHarness = makePrepareHarness({
        config,
        overrides: {
          buildContextPack: async () => {
            expect(useWikiStore.getState().offlineMode).toBe(true)
            throw new Error("模拟构建中断")
          },
        },
      })
      await expect(
        runPrepareWriteContext("/proj", { retrievalMode: "local_only" }, failHarness.deps),
      ).rejects.toThrow("模拟构建中断")
      expect(useWikiStore.getState().offlineMode).toBe(false)
      expect(setItemSpy).not.toHaveBeenCalled()
    } finally {
      useWikiStore.setState({ offlineMode: prevOffline })
      vi.unstubAllGlobals()
    }
  })

  it("2) retrievalMode=configured_network 与兼容参数 allowRetrievalNetwork=true 保留真实配置且不触发离线守卫", async () => {
    const prevOffline = useWikiStore.getState().offlineMode
    useWikiStore.setState({ offlineMode: false })
    try {
      for (const params of [
        { retrievalMode: "configured_network" as PrepareRetrievalMode },
        { allowRetrievalNetwork: true },
        { retrievalMode: "configured_network" as PrepareRetrievalMode, allowRetrievalNetwork: true },
      ]) {
        const config = makeConfig({
          embeddingConfig: { ...makeConfig().embeddingConfig, enabled: true },
          rerankConfig: { ...DEFAULT_RERANK_CONFIG, enabled: true },
        })
        let guardCalls = 0
        const h = makePrepareHarness({
          config,
          overrides: {
            runWithLocalOnlyRetrieval: async <T,>(fn: () => Promise<T>): Promise<T> => {
              guardCalls += 1
              return fn()
            },
          },
        })

        const result = await runPrepareWriteContext("/proj", params, h.deps)
        expect(guardCalls).toBe(0)
        expect(useWikiStore.getState().offlineMode).toBe(false)
        expect(h.calls[0]?.options.embeddingConfig).toBe(config.embeddingConfig)
        expect(h.calls[0]?.options.rerankConfig).toBe(config.rerankConfig)
        expect(result.buildPolicy).toMatchObject({
          retrievalMode: "configured_network",
          retrievalNetworkAllowed: true,
          effectiveNetworkEnabled: true,
          networkRetrievalSkipped: false,
        })
      }
    } finally {
      useWikiStore.setState({ offlineMode: prevOffline })
    }
  })

  it("3) 冲突组合、非法 retrievalMode 及双缺省网络启用场景一律 fail-closed 拒绝", async () => {
    const conflicts: Array<Record<string, unknown>> = [
      { retrievalMode: "local_only", allowRetrievalNetwork: true },
      { retrievalMode: "configured_network", allowRetrievalNetwork: false },
    ]
    for (const params of conflicts) {
      const h = makePrepareHarness()
      await expect(runPrepareWriteContext("/proj", params, h.deps)).rejects.toThrow(/参数冲突/)
      expect(h.calls).toHaveLength(0)
    }

    for (const bad of ["auto", "", null, 123, true]) {
      const h = makePrepareHarness()
      await expect(runPrepareWriteContext("/proj", { retrievalMode: bad }, h.deps)).rejects.toThrow(
        /retrievalMode 非法/,
      )
      expect(h.calls).toHaveLength(0)
    }

    // 双缺省且 rerank 启用 -> 仍 fail-closed 拒绝
    const rerankHarness = makePrepareHarness({
      config: makeConfig({ rerankConfig: { ...DEFAULT_RERANK_CONFIG, enabled: true } }),
    })
    await expect(runPrepareWriteContext("/proj", {}, rerankHarness.deps)).rejects.toThrow(
      /allowRetrievalNetwork/,
    )
    expect(rerankHarness.calls).toHaveLength(0)
  })

  it("4) runWithLocalOnlyRetrieval 并发引用计数与外部用户切换保护（不踩踏、不写 localStorage）", async () => {
    const setItemSpy = vi.fn()
    const storageMap = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
      setItem: (key: string, value: string) => {
        setItemSpy(key, value)
        storageMap.set(key, value)
      },
      removeItem: (key: string) => void storageMap.delete(key),
    })

    const prevOffline = useWikiStore.getState().offlineMode
    try {
      // A. 并发重叠：先结束的任务不得过早恢复 offlineMode
      useWikiStore.setState({ offlineMode: false })
      let releaseA!: () => void
      let releaseB!: () => void
      const waitA = new Promise<void>((r) => { releaseA = r })
      const waitB = new Promise<void>((r) => { releaseB = r })

      const taskA = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitA
        return "A"
      })
      const taskB = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitB
        return "B"
      })
      releaseA()
      expect(await taskA).toBe("A")
      // B 仍在途，offlineMode 必须保持 true
      expect(useWikiStore.getState().offlineMode).toBe(true)
      releaseB()
      expect(await taskB).toBe("B")
      expect(useWikiStore.getState().offlineMode).toBe(false)
      expect(setItemSpy).not.toHaveBeenCalled()

      // B. 初始已为 offlineMode=true 时，退出后保持 true
      useWikiStore.setState({ offlineMode: true })
      await runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
      })
      expect(useWikiStore.getState().offlineMode).toBe(true)

      // C. 初始 offlineMode=true，期间外部切换为 false -> 退出不得覆盖回 true
      await runWithLocalOnlyRetrieval(async () => {
        useWikiStore.setState({ offlineMode: false })
      })
      expect(useWikiStore.getState().offlineMode).toBe(false)

      // D. 初始 offlineMode=false，期间用户调用 setOfflineMode(true) -> 退出不得覆盖回 false
      storageMap.set("niko-buddy-offline-mode", "0")
      useWikiStore.setState({ offlineMode: false })
      await runWithLocalOnlyRetrieval(async () => {
        useWikiStore.getState().setOfflineMode(true)
      })
      expect(useWikiStore.getState().offlineMode).toBe(true)
      // 仅用户显式调用 setOfflineMode 写了一次 localStorage，守卫自身未额外写盘
      expect(setItemSpy).toHaveBeenCalledTimes(1)
    } finally {
      useWikiStore.setState({ offlineMode: prevOffline })
      vi.unstubAllGlobals()
    }
  })

  it("5) runPrepareWriteContext 直接产出精简 workflowHint（覆盖新书/续写分页/草稿审读/六维分维）", async () => {
    const newBookH = makePrepareHarness({ chapters: [] })
    const newBookRes = await runPrepareWriteContext("/proj", {}, newBookH.deps)
    expect(newBookRes.workflowHint).toContain("第 1 章")
    expect(newBookRes.workflowHint).toContain("chapter.write")
    expect(newBookRes.workflowHint).toContain('detailLevel="compact"')

    const pagedH = makePrepareHarness({
      chapters: [{ name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md" }],
      pack: makePack({ outline: "长章纲内容。".repeat(120) }),
    })
    const pagedRes = await runPrepareWriteContext("/proj", { limit: 120, includePlanningView: false }, pagedH.deps)
    expect(pagedRes.prompt.hasMore).toBe(true)
    expect(pagedRes.workflowHint).toContain(`offset=${pagedRes.prompt.nextOffset}`)

    const draft: ChapterDraft = {
      id: "draft_hint_3",
      chapterName: "第3章-线索",
      content: "草稿审读测试正文。".repeat(30),
      createdAt: 1_700_000_000_000,
      status: "draft",
      sourceConversationId: "mcp:chapter.write",
    }
    const draftH = makePrepareHarness({ drafts: [draft] })
    const draftRes = await runPrepareWriteContext("/proj", { draftId: "draft_hint_3" }, draftH.deps)
    expect(draftRes.workflowHint).toContain("draft_hint_3")
    expect(draftRes.workflowHint).toContain("gate.check_mechanical")

    const dimRes = await runPrepareWriteContext(
      "/proj",
      { draftId: "draft_hint_3", dimension: "thrill", limit: 200 },
      draftH.deps,
    )
    expect(dimRes.dimension?.hasMore).toBe(true)
    expect(dimRes.workflowHint).toContain("draft_hint_3")
    expect(dimRes.workflowHint).toContain(`offset=${dimRes.dimension?.nextOffset}`)
  })

  it("6) 并发重入 A+B 期间用户先 setOfflineMode(false) 再 setOfflineMode(true) -> 最终保留用户 true 与 storage='1'", async () => {
    const storageMap = new Map<string, string>([["niko-buddy-offline-mode", "0"]])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
      setItem: (key: string, value: string) => void storageMap.set(key, value),
      removeItem: (key: string) => void storageMap.delete(key),
    })

    const prevOffline = useWikiStore.getState().offlineMode
    useWikiStore.setState({ offlineMode: false })
    try {
      let releaseA!: () => void
      let releaseB!: () => void
      const waitA = new Promise<void>((r) => { releaseA = r })
      const waitB = new Promise<void>((r) => { releaseB = r })

      const taskA = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitA
        return "A"
      })

      // 用户在 A 期间将 offlineMode 切为 false（storage="0"，memory true->false）
      useWikiStore.getState().setOfflineMode(false)
      expect(useWikiStore.getState().offlineMode).toBe(false)

      // 并发调用 B 进入并再次将内存 offlineMode 拉回 true
      const taskB = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitB
        return "B"
      })

      // 用户在 B 期间再次切换为 true（storage="1"，内存已是 true）
      useWikiStore.getState().setOfflineMode(true)

      releaseA()
      releaseB()
      expect(await Promise.all([taskA, taskB])).toEqual(["A", "B"])

      // 两个并发守卫全部退出后，必须尊重用户最新的 true 意图
      expect(useWikiStore.getState().offlineMode).toBe(true)
      expect(storageMap.get("niko-buddy-offline-mode")).toBe("1")
    } finally {
      useWikiStore.setState({ offlineMode: prevOffline })
      vi.unstubAllGlobals()
    }
  })

  it("7) 并发重入 A+B 期间用户先 setOfflineMode(true) 再 setOfflineMode(false) -> 最终保留用户 false 与 storage='0'", async () => {
    const storageMap = new Map<string, string>([["niko-buddy-offline-mode", "0"]])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
      setItem: (key: string, value: string) => void storageMap.set(key, value),
      removeItem: (key: string) => void storageMap.delete(key),
    })

    const prevOffline = useWikiStore.getState().offlineMode
    useWikiStore.setState({ offlineMode: false })
    try {
      let releaseA!: () => void
      let releaseB!: () => void
      const waitA = new Promise<void>((r) => { releaseA = r })
      const waitB = new Promise<void>((r) => { releaseB = r })

      const taskA = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitA
        return "A"
      })

      // 用户先切为 true（storage="1"）
      useWikiStore.getState().setOfflineMode(true)

      const taskB = runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        await waitB
        return "B"
      })

      // 用户再切回 false（storage="0"）
      useWikiStore.getState().setOfflineMode(false)

      releaseA()
      releaseB()
      expect(await Promise.all([taskA, taskB])).toEqual(["A", "B"])

      expect(useWikiStore.getState().offlineMode).toBe(false)
      expect(storageMap.get("niko-buddy-offline-mode")).toBe("0")
    } finally {
      useWikiStore.setState({ offlineMode: prevOffline })
      vi.unstubAllGlobals()
    }
  })

  it("8) 外部 Zustand 订阅器在 setOfflineModeInMemory(true) 同步抛错时，不泄漏 refCount 且后续调用仍能正常还原 offlineMode", async () => {
    const prevOffline = useWikiStore.getState().offlineMode
    useWikiStore.setState({ offlineMode: false })

    let shouldThrowOnce = true
    const unsubscribeFaulty = useWikiStore.subscribe((state, prevState) => {
      if (shouldThrowOnce && state.offlineMode && !prevState.offlineMode) {
        shouldThrowOnce = false
        throw new Error("external subscriber boom")
      }
    })

    try {
      const fnSpy = vi.fn(async () => "never-reached")
      await expect(runWithLocalOnlyRetrieval(fnSpy)).rejects.toThrow("external subscriber boom")
      expect(fnSpy).not.toHaveBeenCalled()
      // 同步抛错后 finally 必须归零 refCount 并把 offlineMode 还原回 false
      expect(useWikiStore.getState().offlineMode).toBe(false)

      // 后续正常调用不得卡在 true，退出后完整还原回 false
      const nextVal = await runWithLocalOnlyRetrieval(async () => {
        expect(useWikiStore.getState().offlineMode).toBe(true)
        return "ok"
      })
      expect(nextVal).toBe("ok")
      expect(useWikiStore.getState().offlineMode).toBe(false)
    } finally {
      unsubscribeFaulty()
      useWikiStore.setState({ offlineMode: prevOffline })
    }
  })
})
