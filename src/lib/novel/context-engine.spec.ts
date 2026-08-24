import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest"
import {
  contextPackToPrompt,
  truncateActiveEntitiesByBudget,
  buildContextPack,
  clearTemporalFactsCache,
  __resetTemporalFactsCacheForTests,
  loadTemporalFactsCached,
  extractChapterNumberFromTask,
  selectLookbackChapterNumbers,
  mergeForeshadowingSignals,
  buildChapterGoal,
  buildMustDo,
  buildMustAvoid,
  buildNextChapterAdvice,
  joinNonEmpty,
  readOutlineContent,
  pickChapterOutlineByNumber,
  readChapterOutlineContent,
  selectActiveEntities,
  computeIrrelevantRatio,
  searchRelevantContent,
  searchRelevantContentUnified,
  searchGraphRelevantContent,
  extractChapterGoal,
  buildRelatedChaptersContext,
  type ContextPack,
  type SourceTier,
  type ContextGap,
  type ContextEntity,
  type RelatedChaptersContextInput,
} from "./context-engine"
import { computeContextBudget } from "@/lib/context-budget"
import { rerankActiveEntitiesByTemporalFacts, type TemporalFact } from "./temporal-memory"
import { DEFAULT_NOVEL_CONFIG, useWikiStore, type LlmConfig, type NovelConfig, type EmbeddingConfig } from "@/stores/wiki-store"
import i18n from "@/i18n"
import type { ChapterSnapshot } from "./chapter-ingest"

// HARD-1/2/3 守恒断言 (TASK-006): Track B 纯 contextPack 内变换不得触达
// wiki-store 的写入类 setter (status.json / chapter-save-strategy / decision_gates)。
// 用 vi.hoisted 捕获 vi.fn，经 vi.mock 覆盖对应 setter，集成测全流后断言未被调用
// (WARNING-5 修法: 非 grep 缺席弱断言)。真实 useWikiStore 经 importOriginal 透传，
// 不影响其余测试。
const hoisted = vi.hoisted(() => {
  const defaultRawData: Record<string, unknown> = {}
  const state = {
    setNovelConfig: vi.fn(),
    defaultRawData,
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    getFileModifiedTime: vi.fn(),
    fileExists: vi.fn(),
    searchWiki: vi.fn(),
    tokenizeQuery: vi.fn(),
    parseFrontmatter: vi.fn(),
    rerankCandidates: vi.fn(),
    searchByEmbedding: vi.fn(),
    buildRetrievalGraph: vi.fn(),
    getRelatedNodes: vi.fn(),
    listSnapshots: vi.fn(),
    loadSnapshot: vi.fn(),
    buildRevisionDirectives: vi.fn(),
    readEmotionalArcsText: vi.fn(),
    readSubplotBoardText: vi.fn(),
    readResourceLedgerText: vi.fn(),
    readEmotionLedgerText: vi.fn(),
    readAuraEvolutionText: vi.fn(),
    factsFromCommittedSnapshots: vi.fn(),
    renderTemporalCanonBlock: vi.fn(),
    auditTemporalFactsStatus: vi.fn(),
    temporalEmptySoftGapRef: vi.fn(),
    loadProjectionStatusLedger: vi.fn(),
    buildCharacterAuraContext: vi.fn(),
    isAuthoritativeGenerationPath: vi.fn(),
    isHistoricalProjectionSnippet: vi.fn(),
    novelMixedSearch: vi.fn(),
    sanitizeEntitySlug: vi.fn(),
    getAllDataSources: vi.fn(),
    selectRelevantNovelVectorResults: vi.fn(),
    reorderByEntityBoost: vi.fn(),
    loadStyleExemplars: vi.fn(),
    pickTopKExemplars: vi.fn(),
    appendRoutingROISample: vi.fn(),
    buildRelatedChapters: vi.fn(),
    buildAppearancesFromSnapshots: vi.fn(),
    findOverdueForeshadowing: vi.fn(),
    relatedChaptersToContextText: vi.fn(),
    loadForeshadowingTracker: vi.fn(),
    loadPersistedCommunitySummaries: vi.fn(),
    searchCommunitySummaries: vi.fn(),
    loadAllImpl: null as null | ((ctx: unknown) => Promise<Record<string, unknown>>),
    lastLoadContext: undefined as unknown,
    registeredDataSources: undefined as unknown,
    MockDataSourceRegistry: class {
      registerAll(sources: unknown[]): void {
        state.registeredDataSources = sources
      }
      async loadAll(context: unknown): Promise<Record<string, unknown>> {
        state.lastLoadContext = context
        if (state.loadAllImpl) return state.loadAllImpl(context)
        return state.defaultRawData
      }
    },
  }

  // 默认实现：纯净默认值，测试各自覆写。
  state.tokenizeQuery.mockImplementation((q: string) => q.split(/\s+/).filter(Boolean))
  state.parseFrontmatter.mockImplementation((content: string) => {
    const fm: Record<string, unknown> = {}
    if (content.startsWith("---")) {
      const end = content.indexOf("\n---", 3)
      const block = end > 0 ? content.slice(3, end) : ""
      for (const line of block.split("\n")) {
        const idx = line.indexOf(":")
        if (idx > 0) {
          const k = line.slice(0, idx).trim()
          const raw = line.slice(idx + 1).trim()
          if (raw.startsWith("[") && raw.endsWith("]")) {
            fm[k] = raw
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean)
          } else {
            const num = Number(raw)
            fm[k] = raw !== "" && !Number.isNaN(num) ? num : raw
          }
        }
      }
    }
    return {
      content: content.replace(/^---[\s\S]*?---\s*/m, ""),
      frontmatter: Object.keys(fm).length > 0 ? fm : undefined,
    }
  })
  state.rerankCandidates.mockImplementation(async (_q: unknown, candidates: unknown[]) => candidates)
  state.selectRelevantNovelVectorResults.mockImplementation((results: unknown[], limit: number) =>
    results.slice(0, limit),
  )
  state.reorderByEntityBoost.mockImplementation((hits: unknown[]) => hits)
  state.pickTopKExemplars.mockImplementation((ex: unknown[]) => ex)
  state.buildRelatedChapters.mockImplementation(() => ({ chapters: [] }))
  state.relatedChaptersToContextText.mockImplementation(() => "RELATED-TEXT")
  state.auditTemporalFactsStatus.mockImplementation(() => ({
    schemaVersion: "temporal-facts-audit/1.0",
    level: "ok",
    enabled: true,
    chapterNumber: 0,
    factCount: 0,
    shouldRecordGap: false,
    message: "",
    productHardGate: false,
  }))
  state.temporalEmptySoftGapRef.mockImplementation((n: number) => `temporal-gap:${n}`)
  state.sanitizeEntitySlug.mockImplementation((id: string) => id.replace(/[\/\\]/g, "_"))
  state.isAuthoritativeGenerationPath.mockImplementation(() => true)
  state.isHistoricalProjectionSnippet.mockImplementation(() => false)
  state.factsFromCommittedSnapshots.mockImplementation(() => [])
  state.renderTemporalCanonBlock.mockImplementation(() => "")
  state.searchCommunitySummaries.mockImplementation(async () => "")

  return state
})

// T25 (A-04.4/F-13): canon 三源并行测试面 —— canon 迁移门（T09 会话状态）与
// T14 投影读出口均 mock，不依赖 Tauri 运行时。默认实现由 resetHoistedDefaults 重置。
const t25 = vi.hoisted(() => ({
  loadNovelSessionStatus: vi.fn(),
  queryCanonEdges: vi.fn(),
  compileFromCommittedSnapshot: vi.fn(),
}))
vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: t25.loadNovelSessionStatus,
}))
vi.mock("./canon-graph-client", () => ({
  queryCanonEdges: t25.queryCanonEdges,
}))
// 技法源：默认透传真实离线编译器（compileFromCommittedSnapshot 纯函数），
// 失败降级用例可覆写为抛错。
vi.mock("./craft/technique-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./craft/technique-compiler")>()
  return { ...actual, compileFromCommittedSnapshot: t25.compileFromCommittedSnapshot }
})

// 捕获 parseFrontmatter 的默认实现，供 resetHoistedDefaults 恢复（避免用例间覆写泄漏）。
const defaultParseFrontmatter = hoisted.parseFrontmatter.getMockImplementation()

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    setNovelConfig: hoisted.setNovelConfig,
  }
})
vi.mock("@/commands/fs", () => ({
  listDirectory: hoisted.listDirectory,
  readFile: hoisted.readFile,
  getFileModifiedTime: hoisted.getFileModifiedTime,
  fileExists: hoisted.fileExists,
}))
vi.mock("@/lib/search", () => ({
  searchWiki: hoisted.searchWiki,
  tokenizeQuery: hoisted.tokenizeQuery,
}))
vi.mock("@/lib/frontmatter", () => ({ parseFrontmatter: hoisted.parseFrontmatter }))
vi.mock("@/lib/rerank", () => ({ rerankCandidates: hoisted.rerankCandidates }))
vi.mock("@/lib/embedding", () => ({ searchByEmbedding: hoisted.searchByEmbedding }))
vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: hoisted.buildRetrievalGraph,
  getRelatedNodes: hoisted.getRelatedNodes,
}))
vi.mock("./chapter-ingest", () => ({
  listSnapshots: hoisted.listSnapshots,
  loadSnapshot: hoisted.loadSnapshot,
}))
vi.mock("./revision-feedback", () => ({ buildRevisionDirectives: hoisted.buildRevisionDirectives }))
vi.mock("./context-derived-stores", () => ({
  readEmotionalArcsText: hoisted.readEmotionalArcsText,
  readSubplotBoardText: hoisted.readSubplotBoardText,
  readResourceLedgerText: hoisted.readResourceLedgerText,
  readEmotionLedgerText: hoisted.readEmotionLedgerText,
  readAuraEvolutionText: hoisted.readAuraEvolutionText,
}))
vi.mock("./temporal-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./temporal-memory")>()
  return {
    ...actual,
    factsFromCommittedSnapshots: hoisted.factsFromCommittedSnapshots,
    renderTemporalCanonBlock: hoisted.renderTemporalCanonBlock,
  }
})
vi.mock("./temporal-facts-audit", () => ({
  auditTemporalFactsStatus: hoisted.auditTemporalFactsStatus,
  temporalEmptySoftGapRef: hoisted.temporalEmptySoftGapRef,
}))
vi.mock("./projection-status-ledger", () => ({ loadProjectionStatusLedger: hoisted.loadProjectionStatusLedger }))
vi.mock("./character-aura", () => ({ buildCharacterAuraContext: hoisted.buildCharacterAuraContext }))
vi.mock("./search-adapter", () => ({
  isAuthoritativeGenerationPath: hoisted.isAuthoritativeGenerationPath,
  isHistoricalProjectionSnippet: hoisted.isHistoricalProjectionSnippet,
  novelMixedSearch: hoisted.novelMixedSearch,
}))
vi.mock("./graph-adapter", () => ({ sanitizeEntitySlug: hoisted.sanitizeEntitySlug }))
vi.mock("./context-data-source", () => ({ DataSourceRegistry: hoisted.MockDataSourceRegistry }))
vi.mock("./context-data-sources", () => ({ getAllDataSources: hoisted.getAllDataSources }))
vi.mock("./vector-relevance", () => ({ selectRelevantNovelVectorResults: hoisted.selectRelevantNovelVectorResults }))
vi.mock("./entity-boost", () => ({ reorderByEntityBoost: hoisted.reorderByEntityBoost }))
vi.mock("./style-exemplars-loader", () => ({
  loadStyleExemplars: hoisted.loadStyleExemplars,
  pickTopKExemplars: hoisted.pickTopKExemplars,
}))
vi.mock("./character-cognition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./character-cognition")>()
  return { ...actual, appendRoutingROISample: hoisted.appendRoutingROISample }
})
vi.mock("./related-chapters", () => ({
  buildRelatedChapters: hoisted.buildRelatedChapters,
  buildAppearancesFromSnapshots: hoisted.buildAppearancesFromSnapshots,
  findOverdueForeshadowing: hoisted.findOverdueForeshadowing,
  relatedChaptersToContextText: hoisted.relatedChaptersToContextText,
}))
vi.mock("./foreshadowing-tracker", () => ({ loadForeshadowingTracker: hoisted.loadForeshadowingTracker }))
vi.mock("./community-summary", () => ({
  loadPersistedCommunitySummaries: hoisted.loadPersistedCommunitySummaries,
  searchCommunitySummaries: hoisted.searchCommunitySummaries,
}))

// ── 测试夹具 ────────────────────────────────────────────────────────────────

// T25: 真实离线技法编译器（mock 默认实现透传目标）。vi.importActual 是异步的，
// 在 beforeAll 捕获一次同步引用 —— compileFromCommittedSnapshot 本体是纯同步函数，
// mock 默认实现必须保持同步返回（返回 Promise 会让 loadTechniqueBlocks 拿到
// Promise.pack 而走 catch 降级）。
let realCompileFromCommittedSnapshot!: typeof import("./craft/technique-compiler")["compileFromCommittedSnapshot"]
beforeAll(async () => {
  const actual = await vi.importActual<typeof import("./craft/technique-compiler")>(
    "./craft/technique-compiler",
  )
  realCompileFromCommittedSnapshot = actual.compileFromCommittedSnapshot
})

const mkLlmConfig = (maxContextSize: number): LlmConfig => ({
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize,
})

const mkEmbeddingConfig = (enabled: boolean, model: string): EmbeddingConfig => ({
  enabled,
  endpoint: "http://127.0.0.1:1",
  apiKey: "test-key",
  model,
})

const mkNovelConfig = (overrides: Partial<NovelConfig> = {}): NovelConfig => ({
  ...DEFAULT_NOVEL_CONFIG,
  exemplarEnabled: false,
  conditionalRoutingEnabled: false,
  relatedChaptersEnabled: false,
  temporalFactsEnabled: false,
  communitySummaryEnabled: false,
  entityBoostEnabled: false,
  ...overrides,
})

function fixtureRawData(): Record<string, unknown> & { snapshots: Record<string, unknown> } {
  return {
    snapshots: {
      recentSummaries: ["第1章摘要", "第2章摘要"],
      previousChapterEnding: "上一章结尾",
      characterStates: "快照角色状态",
      timeline: "快照时间线",
      foreshadowingSignals: ["伏笔甲：未回收", "伏笔乙：已解决"],
    },
    fallbackRecentSummaries: [],
    fallbackPreviousEnding: "",
    fallbackCharacterStates: "",
    fallbackTimeline: "",
    fallbackForeshadowingStates: "",
    recentChapterContents: ["## 第2章正文片段\n内容"],
    outline: "## 大纲\n第一章 起",
    volumeContext: "第一卷",
    chapterOutline: "第3章细纲：目标",
    revisionFeedback: [],
    cognitionText: "林晚秋知道：剑",
    soulDoc: "项目灵魂",
    relatedSettings: "地点设定",
    canonRules: "正史规则",
    writingStyle: "写作风格",
    searchResults: "相关记忆",
    graphSearchResults: "图谱节点",
  }
}

const basePack: ContextPack = {
  task: "生成第2章正文",
  chapterGoal: "",
  outline: "",
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
  recentChapterContents: [],
  gaps: [],
}

function resetHoistedDefaults(): void {
  hoisted.listDirectory.mockReset().mockImplementation(async () => [])
  hoisted.readFile.mockReset().mockImplementation(async () => "")
  hoisted.getFileModifiedTime.mockReset().mockImplementation(async () => 0)
  hoisted.searchWiki.mockReset().mockImplementation(async () => [])
  hoisted.novelMixedSearch.mockReset().mockImplementation(async () => [])
  hoisted.searchByEmbedding.mockReset().mockImplementation(async () => [])
  hoisted.buildRetrievalGraph.mockReset().mockImplementation(async () => ({ nodes: new Map() }))
  hoisted.getRelatedNodes.mockReset().mockImplementation(() => [])
  hoisted.listSnapshots.mockReset().mockImplementation(async () => [])
  hoisted.loadSnapshot.mockReset().mockImplementation(async () => null)
  hoisted.buildRevisionDirectives.mockReset().mockImplementation(() => "")
  hoisted.readEmotionalArcsText.mockReset().mockImplementation(async () => "")
  hoisted.readSubplotBoardText.mockReset().mockImplementation(async () => "")
  hoisted.readResourceLedgerText.mockReset().mockImplementation(async () => "")
  hoisted.readEmotionLedgerText.mockReset().mockImplementation(async () => "")
  hoisted.readAuraEvolutionText.mockReset().mockImplementation(async () => "")
  hoisted.factsFromCommittedSnapshots.mockReset().mockImplementation(() => [])
  hoisted.renderTemporalCanonBlock.mockReset().mockImplementation(() => "")
  hoisted.auditTemporalFactsStatus.mockReset().mockImplementation(() => ({
    schemaVersion: "temporal-facts-audit/1.0",
    level: "ok",
    enabled: true,
    chapterNumber: 0,
    factCount: 0,
    shouldRecordGap: false,
    message: "",
    productHardGate: false,
  }))
  hoisted.loadProjectionStatusLedger.mockReset().mockImplementation(async () => ({}))
  hoisted.buildCharacterAuraContext.mockReset().mockImplementation(async () => "")
  hoisted.isAuthoritativeGenerationPath.mockReset().mockImplementation(() => true)
  hoisted.isHistoricalProjectionSnippet.mockReset().mockImplementation(() => false)
  hoisted.sanitizeEntitySlug.mockReset().mockImplementation((id: string) => id.replace(/[\/\\]/g, "_"))
  hoisted.getAllDataSources.mockReset().mockImplementation(() => [])
  hoisted.selectRelevantNovelVectorResults.mockReset().mockImplementation((results: unknown[], limit: number) =>
    results.slice(0, limit),
  )
  hoisted.reorderByEntityBoost.mockReset().mockImplementation((hits: unknown[]) => hits)
  hoisted.loadStyleExemplars.mockReset().mockImplementation(async () => [])
  hoisted.pickTopKExemplars.mockReset().mockImplementation((ex: unknown[]) => ex)
  hoisted.appendRoutingROISample.mockReset().mockImplementation(async () => {})
  hoisted.buildRelatedChapters.mockReset().mockImplementation(() => ({ chapters: [] }))
  hoisted.buildAppearancesFromSnapshots.mockReset().mockImplementation(() => [])
  hoisted.findOverdueForeshadowing.mockReset().mockImplementation(() => [])
  hoisted.relatedChaptersToContextText.mockReset().mockImplementation(() => "RELATED-TEXT")
  hoisted.loadForeshadowingTracker.mockReset().mockImplementation(async () => ({ items: [] }))
  hoisted.loadPersistedCommunitySummaries.mockReset().mockImplementation(async () => ({ text: "" }))
  hoisted.searchCommunitySummaries.mockReset().mockImplementation(async () => "")
  // parseFrontmatter 默认实现由模块初始化时设置；部分用例会覆写并可能泄漏，这里恢复默认。
  if (defaultParseFrontmatter) {
    hoisted.parseFrontmatter.mockReset().mockImplementation(defaultParseFrontmatter)
  }
  hoisted.defaultRawData = fixtureRawData()
  hoisted.loadAllImpl = null
  hoisted.lastLoadContext = undefined
  // T25: canon 迁移门默认关闭（null → 默认折叠路径）；canon 查询默认空集；
  // 技法编译默认透传真实离线编译器。
  t25.loadNovelSessionStatus.mockReset().mockResolvedValue(null)
  t25.queryCanonEdges.mockReset().mockResolvedValue([])
  t25.compileFromCommittedSnapshot.mockReset().mockImplementation(
    () => realCompileFromCommittedSnapshot(),
  )
  useWikiStore.setState({
    novelMode: true,
    novelConfig: mkNovelConfig(),
    llmConfig: mkLlmConfig(204800),
    embeddingConfig: mkEmbeddingConfig(false, ""),
    revisionFeedbackWindowConfig: undefined,
  })
  __resetTemporalFactsCacheForTests()
}

beforeEach(() => {
  resetHoistedDefaults()
})

// ════════════════════════════════════════════════════════════════════════════
// 既有测试（字节级 prompt 基线——不得破坏）
// ════════════════════════════════════════════════════════════════════════════

describe("contextPackToPrompt", () => {
  it("将最近章节正文片段写入小说上下文包", () => {
    // S1-S8 (d75e98d): recentChapterContents 是 L0 原文段，仅 layeredRecall="full"
    // 时渲染（避免上下文膨胀）；默认 default 模式跳过。测试显式开 full。
    const prompt = contextPackToPrompt({
      ...basePack,
      recentChapterContents: [
        "## 第1章正文片段\n黑背心纹身大汉倒在雨里。",
      ],
    }, undefined, { layeredRecall: "full" })

    expect(prompt).toContain("最近章节正文片段")
    expect(prompt).toContain("黑背心纹身大汉倒在雨里")
  })
})

describe("rerankActiveEntitiesByTemporalFacts", () => {
  const mkFact = (subject: string, validFrom: number): TemporalFact => ({
    id: `fact-${subject}`,
    subject,
    predicate: "持有",
    object: "轩辕剑",
    validFrom,
    source: `chapter-${validFrom}`,
  })

  const mkEntity = (name: string, tags: string[]): ContextEntity => ({
    entityId: name,
    name,
    type: "character",
    tags,
  })

  it("全名匹配: temporal fact subject 命中 → entity boost 到 rank0", () => {
    const entities = [
      mkEntity("苏明月", ["relevance:low"]), // rank 2, 不命中
      mkEntity("林晚秋", ["relevance:low"]), // rank 2, 命中
    ]
    const facts = [mkFact("林晚秋", 3)]
    const result = rerankActiveEntitiesByTemporalFacts(entities, facts, 5)
    expect(result[0].name).toBe("林晚秋")
    expect(result[1].name).toBe("苏明月")
  })

  it("零命中退化: temporalFacts 为 null → 原序返回 (加性不破坏)", () => {
    const entities = [mkEntity("苏明月", []), mkEntity("林晚秋", [])]
    const result = rerankActiveEntitiesByTemporalFacts(entities, null, 5)
    expect(result.map((e) => e.name)).toEqual(["苏明月", "林晚秋"])
  })

  it("只升不降: rank0 entity 命中不动, rank1/2 命中升 rank0", () => {
    const entities = [
      mkEntity("高_rank0", ["relevance:high"]), // rank 0, 命中也不动
      mkEntity("低_rank2", ["relevance:low"]), // rank 2, 命中升 0
    ]
    const facts = [mkFact("高_rank0", 3), mkFact("低_rank2", 3)]
    const result = rerankActiveEntitiesByTemporalFacts(entities, facts, 5)
    // 两者都最终 rank0, 稳定排序保持原相对顺序 (只升不降, D6)
    expect(result[0].name).toBe("高_rank0")
    expect(result[1].name).toBe("低_rank2")
  })

  it("稳定排序: 同 finalRank 内保持原 activeEntities 数组顺序 (NEW-W7)", () => {
    const entities = [
      mkEntity("乙", ["relevance:low"]), // rank 2, 命中 → boost 0
      mkEntity("甲", ["relevance:low"]), // rank 2, 命中 → boost 0
      mkEntity("丙", []), // rank 1, 不命中 → 1
    ]
    const facts = [mkFact("乙", 3), mkFact("甲", 3)]
    const result = rerankActiveEntitiesByTemporalFacts(entities, facts, 5)
    // 乙、甲都 boost 到 rank0, 稳定排序保持原序 乙→甲; 丙 rank1 在最后
    expect(result.map((e) => e.name)).toEqual(["乙", "甲", "丙"])
  })
})

describe("contextPackToPrompt activeEntities conditional render + serialize", () => {
  const mkEntity = (name: string, tags: string[]): ContextEntity => ({
    entityId: name,
    name,
    type: "character",
    tags,
  })

  it("flag=true 且 activeEntities 非空: 渲染 '- {entity.name}' 行且无 [object Object]", () => {
    const pack: ContextPack = {
      ...basePack,
      canonRules: "## 禁止违背\n不得违背已确立的时序事实。",
      activeEntities: [mkEntity("林晚秋", ["relevance:high"]), mkEntity("苏明月", [])],
    }
    const prompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(prompt).toContain("- 林晚秋")
    expect(prompt).toContain("- 苏明月")
    expect(prompt).not.toContain("[object Object]")
  })

  it("flag=true 含 activeEntities 段 title (i18n)", () => {
    const pack: ContextPack = { ...basePack, activeEntities: [mkEntity("林晚秋", [])] }
    const prompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(prompt).toContain(i18n.t("novel.contextPack.activeEntities"))
  })

  it("flag=false 字节级不变: 扩后输出 === 无 activeEntities 时的 baseline (严格 ===)", () => {
    const baseline = contextPackToPrompt(basePack) // 无 activeEntities 字段
    const packWithEntities: ContextPack = { ...basePack, activeEntities: [mkEntity("林晚秋", [])] }
    const flagFalse = contextPackToPrompt(packWithEntities, undefined, { temporalFactsEnabled: false })
    expect(flagFalse).toBe(baseline) // 严格 ===, 字节级不变 (R1)
    expect(flagFalse).not.toContain("- 林晚秋")
  })

  it("canon baseline 无条件: flag=false 与 flag=true 两态都渲染 canonRules 段 (D4)", () => {
    const pack: ContextPack = {
      ...basePack,
      canonRules: "## 禁止违背\n不得违背已确立的时序事实。",
      activeEntities: [mkEntity("林晚秋", [])],
    }
    const falsePrompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: false })
    const truePrompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(falsePrompt).toContain("## 禁止违背")
    expect(truePrompt).toContain("## 禁止违背")
  })
})

describe("TASK-003 protected/compressible tiering", () => {
  it("SourceTier 类型包含 protected 与 compressible 两个取值", () => {
    const tiers: SourceTier[] = ["protected", "compressible"]
    expect(tiers).toContain("protected")
    expect(tiers).toContain("compressible")
  })

  it("ContextGap 记录被裁源的 type/ref/reason 字段（IC-02 契约）", () => {
    const gap: ContextGap = {
      type: "truncated",
      ref: "canon-rules:fallback",
      reason: "budget_exceeded",
      originalLength: 9000,
      retainedLength: 8000,
    }
    expect(gap.type).toBe("truncated")
    expect(gap.ref).toBe("canon-rules:fallback")
    expect(gap.reason).toBe("budget_exceeded")
    expect(gap.originalLength).toBeGreaterThan(gap.retainedLength)
  })

  it("protected 段在 contextPackToPrompt 中不被压缩（canonRules 全量出现在 prompt）", () => {
    // 模拟一个 protected tier 的 canon rules 内容（即便很长也不应被 prompt 层裁剪）
    const longCanon = "正史规则：".repeat(1) + Array.from({ length: 200 }, (_, i) => `规则${i}`).join("；")
    const prompt = contextPackToPrompt({
      ...basePack,
      canonRules: longCanon,
    })
    // protected 段的全量内容应出现在 prompt 中（contextPackToPrompt 不再对 canon 做截断）
    expect(prompt).toContain(longCanon)
  })

  it("compressible 段经 prompt 层呈现（recentSummaries 数组内容可见）", () => {
    const summaries = ["第1章：起因揭示", "第2章：冲突升级"]
    const prompt = contextPackToPrompt({
      ...basePack,
      recentSummaries: summaries,
    })
    // compressible 段的内容应被注入到 prompt（虽然底层读取时可能被 tieredSlice 截断，
    // 但 prompt 装配层应呈现已注入的内容）
    expect(prompt).toContain("第1章：起因揭示")
    expect(prompt).toContain("第2章：冲突升级")
  })

  it("gaps[] 字段存在于 ContextPack（IC-02 契约 — 禁静默降级）", () => {
    const pack: ContextPack = {
      ...basePack,
      gaps: [
        {
          type: "truncated",
          ref: "character-states:fallback",
          reason: "tier_compressible",
          originalLength: 5000,
          retainedLength: 2000,
        },
      ],
    }
    expect(pack.gaps).toBeDefined()
    expect(pack.gaps!.length).toBe(1)
    expect(pack.gaps![0].reason).toBe("tier_compressible")
  })
})

describe("TASK-003 chapterNumber 自适应预算", () => {
  it("chapterNumber undefined 走原逻辑（向后兼容）", () => {
    const withoutChapter = computeContextBudget(204_800)
    const withChapterOne = computeContextBudget(204_800, 1)
    // undefined 和 chapter 1 (<=10 满额) 应该得到相同的预算
    expect(withoutChapter.indexBudget).toBe(withChapterOne.indexBudget)
    expect(withoutChapter.pageBudget).toBe(withChapterOne.pageBudget)
  })

  it("chapterNumber=5 vs 500 预算不同（自适应 — 章 500 更压缩）", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    // 早期章节应该比后期章节获得更大的 index/page 预算
    expect(early.indexBudget).toBeGreaterThan(late.indexBudget)
    expect(early.pageBudget).toBeGreaterThan(late.pageBudget)
  })

  it("chapterNumber<=10 满额（scale=1.0）", () => {
    const baseline = computeContextBudget(204_800)
    const chapter10 = computeContextBudget(204_800, 10)
    expect(chapter10.indexBudget).toBe(baseline.indexBudget)
    expect(chapter10.pageBudget).toBe(baseline.pageBudget)
  })

  it("chapterNumber=100 对数衰减到 ~80%", () => {
    const baseline = computeContextBudget(204_800)
    const chapter100 = computeContextBudget(204_800, 100)
    // scale at n=100 should be 0.8, so budgets should be ~80% of baseline
    // (floor() introduces off-by-one tolerance, use ~)
    expect(chapter100.indexBudget).toBeGreaterThanOrEqual(Math.floor(baseline.indexBudget * 0.79))
    expect(chapter100.indexBudget).toBeLessThanOrEqual(Math.floor(baseline.indexBudget * 0.81))
  })

  it("chapterNumber>100 继续向 0.6 收敛（n=10000 < n=100）", () => {
    const baseline = computeContextBudget(204_800)
    const chapter100 = computeContextBudget(204_800, 100)
    const chapter10000 = computeContextBudget(204_800, 10_000)
    // scale at n=100 is 0.8, at n=10000 is 0.7 (0.6 + 0.4*1/4) — still
    // converging toward 0.6 asymptotically. The key property: later
    // chapters get strictly smaller budgets than chapter 100, and the
    // budget stays above the 0.6 floor.
    expect(chapter10000.indexBudget).toBeLessThan(chapter100.indexBudget)
    expect(chapter10000.indexBudget).toBeGreaterThanOrEqual(Math.floor(baseline.indexBudget * 0.6))
    expect(chapter10000.indexBudget).toBeLessThanOrEqual(Math.floor(baseline.indexBudget * 0.75))
  })

  it("responseReserve 不受 chapterNumber 缩放影响（LLM 回答空间恒定）", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    expect(early.responseReserve).toBe(late.responseReserve)
  })

  it("DEFAULT_MAX_CTX fallback 保持不变（falsy maxContextSize）", () => {
    const fromZero = computeContextBudget(0, 500)
    const fromUndefined = computeContextBudget(undefined, 500)
    const fromExplicit = computeContextBudget(204_800, 500)
    expect(fromZero.maxCtx).toBe(204_800)
    expect(fromUndefined.maxCtx).toBe(204_800)
    expect(fromExplicit.maxCtx).toBe(204_800)
  })
})

describe("Track B temporal-facts routing integration", () => {
  const mkFact = (subject: string, validFrom: number): TemporalFact => ({
    id: `fact-${subject}`,
    subject,
    predicate: "持有",
    object: "轩辕剑",
    validFrom,
    source: `chapter-${validFrom}`,
  })
  const mkEntity = (name: string, tags: string[]): ContextEntity => ({
    entityId: name,
    name,
    type: "character",
    tags,
  })

  it("flag=true 全流: rerank boost + activeEntities 段渲染 + budget tier 应用", () => {
    const facts: TemporalFact[] = [mkFact("林晚秋", 3)]
    const entities: ContextEntity[] = [
      mkEntity("苏明月", ["relevance:low"]),
      mkEntity("林晚秋", ["relevance:low"]),
      mkEntity("陈墨", ["relevance:high"]),
    ]
    const reranked = rerankActiveEntitiesByTemporalFacts(entities, facts, 5)
    expect(reranked[0].name).toBe("林晚秋")

    const tierBudget = { rank0Floor: 8, rank1CompressibleCap: 2, rank2CompressibleCap: 1 }
    const many: ContextEntity[] = [
      mkEntity("r0a", ["relevance:high"]),
      ...Array.from({ length: 5 }, (_, i) => mkEntity(`r1_${i}`, [])),
      ...Array.from({ length: 5 }, (_, i) => mkEntity(`r2_${i}`, ["relevance:low"])),
    ]
    const truncated = truncateActiveEntitiesByBudget(many, tierBudget, 5)
    expect(truncated.entities.filter((e) => e.tags?.includes("relevance:high")).length).toBe(1)
    expect(truncated.entities.filter((e) => e.name.startsWith("r1_")).length).toBe(2)
    expect(truncated.entities.filter((e) => e.name.startsWith("r2_")).length).toBe(1)
    expect(truncated.gap).not.toBeNull()

    const pack: ContextPack = { ...basePack, activeEntities: reranked }
    const prompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(prompt).toContain(i18n.t("novel.contextPack.activeEntities"))
    expect(prompt).toContain("- 林晚秋")
    expect(prompt).not.toContain("[object Object]")
  })

  it("flag=false 字节级不变: 不渲染 activeEntities 段, 输出 === 无 activeEntities 基线 (R1)", () => {
    const entities = [mkEntity("林晚秋", ["relevance:high"]), mkEntity("陈墨", [])]
    const promptOff = contextPackToPrompt(
      { ...basePack, activeEntities: entities },
      undefined,
      { temporalFactsEnabled: false },
    )
    const baseline = contextPackToPrompt({ ...basePack })
    expect(promptOff).toBe(baseline)
    expect(promptOff).not.toContain("林晚秋")
  })

  it("canon baseline 无条件: flag=false 与 flag=true 两态都含 canonRules 段 (D4)", () => {
    const pack: ContextPack = {
      ...basePack,
      canonRules: "## 禁止违背\n不得违背已确立的时序事实。",
      activeEntities: [mkEntity("林晚秋", ["relevance:high"])],
    }
    const falsePrompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: false })
    const truePrompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(falsePrompt).toContain("## 禁止违背")
    expect(truePrompt).toContain("## 禁止违背")
  })

  it("HARD-1/2/3 守恒: Track B 全流不触 status.json / Draft-first / 门控 (mock 断言非 grep)", () => {
    const reranked = rerankActiveEntitiesByTemporalFacts(
      [mkEntity("林晚秋", ["relevance:low"])],
      [mkFact("林晚秋", 3)],
      5,
    )
    const budget = computeContextBudget(200_000, 5)
    const truncated = truncateActiveEntitiesByBudget(reranked, budget.activeEntitiesBudget, 5)
    const prompt = contextPackToPrompt(
      { ...basePack, activeEntities: truncated.entities },
      undefined,
      { temporalFactsEnabled: true },
    )
    expect(prompt).toContain("林晚秋")
    expect(hoisted.setNovelConfig).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 新增覆盖（只扩展，不改既有断言）
// ════════════════════════════════════════════════════════════════════════════

describe("extractChapterNumberFromTask", () => {
  it("中文 第N章 提取", () => {
    expect(extractChapterNumberFromTask("生成第12章正文")).toBe(12)
    expect(extractChapterNumberFromTask("第 5 章任务")).toBe(5)
  })

  it("英文 chapter / ch. / ch 提取", () => {
    expect(extractChapterNumberFromTask("chapter 8 outline")).toBe(8)
    expect(extractChapterNumberFromTask("ch. 3 task")).toBe(3)
    expect(extractChapterNumberFromTask("ch 4 task")).toBe(4)
  })

  it("越界/零/无匹配 → undefined", () => {
    expect(extractChapterNumberFromTask("第0章")).toBeUndefined()
    expect(extractChapterNumberFromTask("第100000章")).toBeUndefined()
    expect(extractChapterNumberFromTask("第999999999章")).toBeUndefined()
    expect(extractChapterNumberFromTask("普通任务文本")).toBeUndefined()
    expect(extractChapterNumberFromTask("")).toBeUndefined()
  })

  it("首匹配优先（中文在前）", () => {
    expect(extractChapterNumberFromTask("第1章然后 chapter 2")).toBe(1)
  })
})

describe("selectLookbackChapterNumbers", () => {
  it("常规回看", () => {
    expect(selectLookbackChapterNumbers(5, 3)).toEqual([4, 3, 2])
  })
  it("第1章无前章", () => {
    expect(selectLookbackChapterNumbers(1, 3)).toEqual([])
  })
  it("回看超出起始边界截断", () => {
    expect(selectLookbackChapterNumbers(5, 10)).toEqual([4, 3, 2, 1])
  })
  it("lookback=0 或 chapterNumber=0", () => {
    expect(selectLookbackChapterNumbers(3, 0)).toEqual([])
    expect(selectLookbackChapterNumbers(0, 3)).toEqual([])
  })
})

describe("mergeForeshadowingSignals", () => {
  it("空输入 → 空串", () => {
    expect(mergeForeshadowingSignals([], "")).toBe("")
    expect(mergeForeshadowingSignals([], "有搜索但无信号")).toBe("")
    expect(mergeForeshadowingSignals(["   "], "")).toBe("")
  })

  it("非未回收信号 → 原样合并", () => {
    expect(mergeForeshadowingSignals(["伏笔A", "伏笔B"], "x")).toBe("伏笔A\n伏笔B")
  })

  it("未回收信号 + 关键词出现在搜索 → 追加反复出现提示", () => {
    const out = mergeForeshadowingSignals(["伏笔甲：未回收"], "近期提到伏笔甲")
    expect(out).toContain("伏笔甲：未回收")
    expect(out).toContain("以下伏笔近期反复出现")
    expect(out).toContain("伏笔甲")
  })

  it("未解决 / 新增伏笔 也归为未回收", () => {
    expect(mergeForeshadowingSignals(["线索A：未解决"], "x")).toContain("线索A")
    expect(mergeForeshadowingSignals(["新钩子：新增伏笔"], "x")).toContain("新钩子")
  })

  it("未回收但关键词未在搜索中出现 → 无追加段", () => {
    const out = mergeForeshadowingSignals(["钩子X：未回收"], "完全不相关")
    expect(out).toBe("钩子X：未回收")
    expect(out).not.toContain("以下伏笔近期反复出现")
  })

  it("空关键词（冒号开头）不进入 repeated", () => {
    const out = mergeForeshadowingSignals(["：未回收"], "未回收")
    expect(out).toBe("：未回收")
    expect(out).not.toContain("以下伏笔近期反复出现")
  })

  it("多信号重复名去重", () => {
    const out = mergeForeshadowingSignals(["甲：未回收", "甲：未回收", "乙：未回收"], "甲 乙")
    expect(out).toContain("甲、乙")
  })
})

describe("buildChapterGoal / extractChapterGoal", () => {
  it("两源目标不同 → 都进 parts", () => {
    const goal = buildChapterGoal("第3章 目标A", "第3章 目标B", 3)
    expect(goal).toContain("目标A")
    expect(goal).toContain("目标B")
  })

  it("两源目标相同 → 去重", () => {
    const goal = buildChapterGoal("第3章 目标X", "第3章 目标X", 3)
    expect(goal).toBe("目标X")
  })

  it("都无目标 → 空串", () => {
    expect(buildChapterGoal("", "", 3)).toBe("")
    expect(buildChapterGoal("无标记内容", "", undefined)).toBe("")
  })

  it("extractChapterGoal: 无 chapterNumber 或空 outline → 空", () => {
    expect(extractChapterGoal("第3章 x", undefined)).toBe("")
    expect(extractChapterGoal("", 3)).toBe("")
  })

  it("extractChapterGoal: 剥离 frontmatter 后按行找标记", () => {
    const outline = "---\ntitle: 大纲\n---\n## 第3章 对决开始\n正文"
    expect(extractChapterGoal(outline, 3)).toBe("对决开始")
  })

  it("extractChapterGoal: 标记行无正文 → 返回 cleaned 全文", () => {
    const outline = "## 第4章\n正文内容"
    expect(extractChapterGoal(outline, 4)).toBe("## 第4章\n正文内容")
  })

  it("extractChapterGoal: 英文 Chapter 标记", () => {
    expect(extractChapterGoal("## Chapter 5: 目标", 5)).toBe("目标")
    expect(extractChapterGoal("## Chapter 5", 5)).toBe("## Chapter 5")
  })

  it("extractChapterGoal: 行内非行首英文标记 → includesChapterMarker 兜底", () => {
    const outline = "阅读 Chapter 3 讨论\n其他行"
    expect(extractChapterGoal(outline, 3)).toBe(outline)
  })

  it("extractChapterGoal: 无任何标记 → 空", () => {
    expect(extractChapterGoal("普通文本", 3)).toBe("")
  })

  it("extractChapterGoal: 超长结果截断 2500", () => {
    const long = "第3章 " + "x".repeat(3000)
    const out = extractChapterGoal(long, 3)
    expect(out.length).toBe(2500)
  })

  it("中文数字章节标签（numberToChineseChapter 各分支）", () => {
    // 通过 extractChapterGoal 的 chapterLabels 驱动 numberToChineseChapter
    expect(extractChapterGoal("## 第1章 a", 1)).toBe("a") // 1-9
    expect(extractChapterGoal("## 第10章 a", 10)).toBe("a") // 十
    expect(extractChapterGoal("## 第11章 a", 11)).toBe("a") // 十一
    expect(extractChapterGoal("## 第15章 a", 15)).toBe("a") // 十五
    expect(extractChapterGoal("## 第19章 a", 19)).toBe("a") // 十九
    expect(extractChapterGoal("## 第20章 a", 20)).toBe("a") // 二十（个位0）
    expect(extractChapterGoal("## 第21章 a", 21)).toBe("a") // 二十一
    expect(extractChapterGoal("## 第45章 a", 45)).toBe("a") // 四十五
    expect(extractChapterGoal("## 第99章 a", 99)).toBe("a") // 九十九
    expect(extractChapterGoal("## 第100章 a", 100)).toBe("a") // 一百
    expect(extractChapterGoal("## 第105章 a", 105)).toBe("a") // 一百零五
    expect(extractChapterGoal("## 第123章 a", 123)).toBe("a") // 一百二十三（递归）
    expect(extractChapterGoal("## 第999章 a", 999)).toBe("a") // 九百九十九
    expect(extractChapterGoal("## 第1000章 a", 1000)).toBe("a") // >=1000 → String
  })
})

describe("buildMustDo / buildMustAvoid / buildNextChapterAdvice / joinNonEmpty", () => {
  it("buildMustDo: 章节目标逐行成项", () => {
    const out = buildMustDo("目标一\n\n目标二", "", "")
    expect(out).toBe("- 目标一\n- 目标二")
  })

  it("buildMustDo: 上一章结尾 / 伏笔追加", () => {
    const out = buildMustDo("", "结尾文本", "伏笔1\n伏笔2")
    expect(out).toContain("结尾文本")
    expect(out).toContain("伏笔1")
  })

  it("buildMustDo: 全空 → 空串", () => {
    expect(buildMustDo("", "", "")).toBe("")
  })

  it("buildMustAvoid: 全空 → 空串；全有 → 三项", () => {
    expect(buildMustAvoid("", "", "")).toBe("")
    const out = buildMustAvoid("正史", "时间线", "人物状态")
    expect(out).toContain("正史")
    expect(out).toContain("时间线")
    expect(out).toContain("人物状态")
  })

  it("buildNextChapterAdvice: 全空 → 空串", () => {
    expect(
      buildNextChapterAdvice({
        chapterGoal: "",
        recentSummaries: [],
        previousChapterEnding: "",
        foreshadowingStates: "",
        timeline: "",
        searchResults: "",
      }),
    ).toBe("")
  })

  it("buildNextChapterAdvice: 全字段注入 + 摘要取最后两条", () => {
    const out = buildNextChapterAdvice({
      chapterGoal: "目标",
      recentSummaries: ["S1", "S2", "S3"],
      previousChapterEnding: "结尾",
      foreshadowingStates: "伏笔",
      timeline: "时间线",
      searchResults: "检索",
    })
    expect(out).toContain("目标")
    expect(out).toContain("结尾")
    expect(out).toContain("伏笔")
    expect(out).toContain("时间线")
    expect(out).toContain("检索")
    expect(out).toContain("S2；S3")
  })

  it("joinNonEmpty: 空部分剔除 + trim + separator", () => {
    expect(joinNonEmpty([], "\n")).toBe("")
    expect(joinNonEmpty(["a", "  ", "b"], "\n\n")).toBe("a\n\nb")
    expect(joinNonEmpty(["  a  "], "-")).toBe("a")
  })
})

describe("readOutlineContent", () => {
  it("命中多结果 → join", async () => {
    hoisted.searchWiki.mockResolvedValue([
      { title: "大纲", path: "/o1.md", snippet: "" },
      { title: "大纲2", path: "/o2.md", snippet: "" },
    ])
    hoisted.readFile.mockImplementation(async (p: string) => (p === "/o1.md" ? "c1" : "c2"))
    await expect(readOutlineContent("/p")).resolves.toBe("c1\n\n---\n\nc2")
  })

  it("无结果 → 空串", async () => {
    await expect(readOutlineContent("/p")).resolves.toBe("")
  })

  it("searchWiki 抛错 → 空串", async () => {
    hoisted.searchWiki.mockRejectedValue(new Error("boom"))
    await expect(readOutlineContent("/p")).resolves.toBe("")
  })

  it("单文件读取失败 → 空条目被 join 剔除", async () => {
    hoisted.searchWiki.mockResolvedValue([{ title: "t", path: "/bad.md", snippet: "" }])
    hoisted.readFile.mockRejectedValue(new Error("no"))
    await expect(readOutlineContent("/p")).resolves.toBe("")
  })
})

describe("pickChapterOutlineByNumber / readChapterOutlineContent", () => {
  it("frontmatter chapter_number 精确匹配", () => {
    const out = pickChapterOutlineByNumber(
      [{ path: "a.md", content: "---\nchapter_number: 3\n---\n第3章正文" }],
      3,
    )
    expect(out).toBe("---\nchapter_number: 3\n---\n第3章正文")
  })

  it("heading 内容标记匹配", () => {
    const out = pickChapterOutlineByNumber([{ path: "a.md", content: "## 第3章 目标" }], 3)
    expect(out).toBe("## 第3章 目标")
  })

  it("heading 路径标记匹配", () => {
    const out = pickChapterOutlineByNumber([{ path: "wiki/chapter3.md", content: "无标记" }], 3)
    expect(out).toBe("无标记")
  })

  it("无匹配 → 空串", () => {
    expect(pickChapterOutlineByNumber([{ path: "a.md", content: "普通" }], 3)).toBe("")
  })

  it("超长内容（非 build 期）→ 截断至 6000 且不记 gap", () => {
    const long = "第3章" + "x".repeat(7000)
    const out = pickChapterOutlineByNumber([{ path: "a.md", content: long }], 3)
    expect(out.length).toBe(6000)
  })

  it("readChapterOutlineContent: 无 chapterNumber → 空", async () => {
    await expect(readChapterOutlineContent("/p")).resolves.toBe("")
  })

  it("readChapterOutlineContent: wiki/outlines 直达命中", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "ch3.md", path: "/p/wiki/outlines/ch3.md", is_dir: false },
    ])
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.includes("outlines") ? "## 第3章 直达" : "",
    )
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("## 第3章 直达")
  })

  it("readChapterOutlineContent: 目录为空内容 → 搜索兜底", async () => {
    hoisted.listDirectory.mockResolvedValue([{ name: "a.md", path: "/p/wiki/outlines/a.md", is_dir: false }])
    hoisted.readFile.mockResolvedValue("   ")
    hoisted.searchWiki
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ title: "t", path: "/p/wiki/x.md", snippet: "" }])
      .mockResolvedValueOnce([])
    hoisted.readFile.mockImplementation(async (p: string) =>
      p === "/p/wiki/x.md" ? "第3章 搜索命中" : "",
    )
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("第3章 搜索命中")
  })

  it("readChapterOutlineContent: wiki 目录不可用 → project-root FILLED", async () => {
    hoisted.listDirectory.mockRejectedValue(new Error("no dir"))
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.endsWith("Chapter-3-Outline-FILLED.md") ? "根目录第3章大纲" : "",
    )
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("根目录第3章大纲")
  })

  it("readChapterOutlineContent: 首个 root 名空 → 第二个名命中", async () => {
    hoisted.listDirectory.mockRejectedValue(new Error("no dir"))
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.endsWith("Chapter-3-Outline.md") ? "备选大纲" : "",
    )
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("备选大纲")
  })

  it("readChapterOutlineContent: 全部搜索失败 → 空串", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    hoisted.searchWiki.mockResolvedValue([])
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("")
  })

  it("readChapterOutlineContent: 搜索命中但 readFile 失败 → 换下一条 query", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    hoisted.searchWiki
      .mockResolvedValueOnce([{ title: "t", path: "/bad.md", snippet: "" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    hoisted.readFile.mockRejectedValue(new Error("no"))
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("")
  })
})

describe("selectActiveEntities", () => {
  it("entities 目录不存在 → 空", async () => {
    hoisted.listDirectory.mockRejectedValue(new Error("no"))
    await expect(
      selectActiveEntities("/p", { outline: "x", sceneCharacters: "y" }),
    ).resolves.toEqual([])
  })

  it("无 md 文件 → 空", async () => {
    hoisted.listDirectory.mockResolvedValue([{ name: "readme.txt", path: "/p/readme.txt", is_dir: false }])
    await expect(
      selectActiveEntities("/p", { outline: "x", sceneCharacters: "y" }),
    ).resolves.toEqual([])
  })

  it("双源匹配 + tags 过滤 + 优先级排序（含 relevance:low 匹配项）", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
      { name: "b.md", path: "/p/wiki/entities/b.md", is_dir: false },
      { name: "c.md", path: "/p/wiki/entities/c.md", is_dir: false },
      { name: "d.md", path: "/p/wiki/entities/d.md", is_dir: false },
    ])
    hoisted.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("a.md")) return "---\ntitle: 林晚秋\ntype: character\ntags: [relevance:high, location:chapter-3]\n---\n"
      if (p.endsWith("b.md")) return "---\ntitle: 苏明月\n---\n"
      if (p.endsWith("c.md")) return "---\ntitle: 背景路标\ntype: location\ntags: relevance:low\n---\n"
      if (p.endsWith("d.md")) return "---\ntitle: 陈墨\ntags: relevance:low\n---\n"
      return ""
    })
    const entities = await selectActiveEntities("/p", {
      chapterNumber: 3,
      outline: "林晚秋 出场",
      sceneCharacters: "苏明月 陈墨",
    })
    const names = entities.map((e) => e.name)
    expect(names).toEqual(["林晚秋", "苏明月", "陈墨"]) // rank0(location) → rank1(默认) → rank2(relevance:low)
  })

  it("readFile 失败条目被跳过 + 无 title 条目跳过", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
      { name: "b.md", path: "/p/wiki/entities/b.md", is_dir: false },
    ])
    hoisted.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("a.md")) throw new Error("no")
      return "---\ntype: character\n---\n" // 无 title
    })
    await expect(
      selectActiveEntities("/p", { outline: "x", sceneCharacters: "y" }),
    ).resolves.toEqual([])
  })

  it("零匹配 → 回退全量（含 warning）", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
      { name: "b.md", path: "/p/wiki/entities/b.md", is_dir: false },
    ])
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.endsWith("a.md") ? "---\ntitle: 甲\n---\n" : "---\ntitle: 乙\n---\n",
    )
    const entities = await selectActiveEntities("/p", { outline: "无关", sceneCharacters: "无关" })
    expect(entities.map((e) => e.name)).toEqual(["甲", "乙"])
  })

  it("tags 非数组非字符串（如数字）→ 空 tags", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
    ])
    hoisted.readFile.mockResolvedValue("---\ntitle: 丙\ntags: 42\n---\n")
    const entities = await selectActiveEntities("/p", { outline: "丙", sceneCharacters: "" })
    expect(entities[0].tags).toEqual([])
    expect(entities[0].type).toBe("entity")
  })
})

describe("computeIrrelevantRatio", () => {
  it("候选名被 activeEntities 覆盖比例计算", () => {
    const pack: ContextPack = {
      ...basePack,
      characterStates: "林晚秋不知道：A\n林晚秋知道：B\n- 苏明月：C\n无关行",
      relatedSettings: "设定文本",
      cognitionStates: "路标知道：X",
    }
    const ratio = computeIrrelevantRatio(pack, [
      { entityId: "1", name: "林晚秋", type: "character" },
    ])
    // 候选: 林晚秋, 苏明月, 路标 → 无关 2/3
    expect(ratio).toBeCloseTo(2 / 3, 5)
  })

  it("零候选 → 0", () => {
    expect(computeIrrelevantRatio(basePack, [])).toBe(0)
  })

  it("零 active entities → 1（全部视为无关）", () => {
    const pack: ContextPack = { ...basePack, characterStates: "- 甲：x" }
    expect(computeIrrelevantRatio(pack, [])).toBe(1)
  })

  it("activeNames 全空名 → 1", () => {
    const pack: ContextPack = { ...basePack, characterStates: "- 甲：x" }
    expect(computeIrrelevantRatio(pack, [{ entityId: "1", name: "", type: "character" }])).toBe(1)
  })

  it("超长候选名被剔除 + 空白行跳过 + 非字符串字段跳过", () => {
    const pack: ContextPack = {
      ...basePack,
      characterStates: `${"名".repeat(21)}知道：x\n  \n- 短名：y`,
      relatedSettings: 42 as unknown as string,
    }
    expect(computeIrrelevantRatio(pack, [{ entityId: "1", name: "短名", type: "c" }])).toBe(0)
  })

  it("空关键词空格名（如 ' 不知道：'）不产生候选", () => {
    const pack: ContextPack = { ...basePack, characterStates: " 不知道：x" }
    expect(computeIrrelevantRatio(pack, [])).toBe(1)
  })
})

describe("searchRelevantContent / searchRelevantContentUnified（向量路径）", () => {
  it("searchRelevantContent: 关键词+索引+向量合并去重 + 第N章查询", async () => {
    hoisted.searchWiki.mockImplementation(async (_pp: string, query: string) => {
      if (query.includes("关键词索引")) {
        return [{ title: "索引条目", snippet: "idx-snip", path: "/i.md" }]
      }
      return [{ title: "角色", snippet: "kw-snip", path: "/k.md" }]
    })
    hoisted.searchByEmbedding.mockResolvedValue([{ id: "alice" }])
    hoisted.readFile.mockResolvedValue("# Alice\n内容")
    const out = await searchRelevantContent("/p", "甲 乙", 5, 2, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(out).toContain("kw-snip")
    expect(out).toContain("idx-snip")
    expect(out).toContain("Alice")
  })

  it("searchRelevantContent: 向量启用但零结果 / embedding 未启用 → 无向量项", async () => {
    const outDisabled = await searchRelevantContent("/p", "task", undefined, 2, {
      embeddingConfig: mkEmbeddingConfig(false, ""),
      novelConfig: mkNovelConfig(),
    })
    expect(outDisabled).toBe("")
    hoisted.searchByEmbedding.mockResolvedValue([])
    const outEmpty = await searchRelevantContent("/p", "task", undefined, 2, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(outEmpty).toBe("")
  })

  it("searchRelevantContent: 向量检索抛错 → catch 降级", async () => {
    hoisted.searchByEmbedding.mockRejectedValue(new Error("emb"))
    const out = await searchRelevantContent("/p", "task", undefined, 2, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("")
  })

  it("searchRelevantContent: entityBoost 开/关 + weight 传递", async () => {
    hoisted.searchWiki.mockResolvedValue([{ title: "t", snippet: "s", path: "/t.md" }])
    await searchRelevantContent("/p", "林晚秋 苏明月", undefined, 2, {
      novelConfig: mkNovelConfig({ entityBoostEnabled: true }),
      entityNames: ["已知实体"],
    })
    expect(hoisted.reorderByEntityBoost).toHaveBeenCalledTimes(1)
    const [, boostEntities, weight] = hoisted.reorderByEntityBoost.mock.calls[0] as unknown[]
    expect(boostEntities).toEqual(expect.arrayContaining(["已知实体", "林晚秋", "苏明月"]))
    expect(weight).toBe(0.4)
    hoisted.reorderByEntityBoost.mockClear()

    await searchRelevantContent("/p", "林晚秋", undefined, 2, {
      novelConfig: mkNovelConfig({ entityBoostEnabled: true, entityBoostWeight: 0.9 }),
    })
    const [, , weight2] = hoisted.reorderByEntityBoost.mock.calls[0] as unknown[]
    expect(weight2).toBe(0.9)
  })

  it("searchRelevantContent: searchWiki 抛错 → catch 空", async () => {
    hoisted.searchWiki.mockRejectedValue(new Error("search"))
    const out = await searchRelevantContent("/p", "task", 3, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("")
  })

  it("searchRelevantContentUnified: 过滤 + 去重 + 合并", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/mem.md", title: "M1", snippet: "s1" },
      { type: "canon", path: "/p/wiki/mem.md", title: "M1-dup", snippet: "s1" }, // 同路径去重
    ])
    hoisted.searchWiki.mockResolvedValue([{ title: "idx", snippet: "is", path: "/p/wiki/i.md" }])
    hoisted.searchByEmbedding.mockResolvedValue([{ id: "alice" }])
    hoisted.readFile.mockResolvedValue("# Alice\n内容")
    const out = await searchRelevantContentUnified("/p", "甲", 5, 2, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(out).toContain("M1")
    expect(out).toContain("idx")
    expect(out).toContain("Alice")
  })

  it("searchRelevantContentUnified: 过滤分支（snippet 空 / path 缺失 / 非权威 / 历史片段）", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "" }, // snippet 空 → 过滤
      { type: "memory", path: undefined, title: "B", snippet: "sb" }, // path 非 string → 过滤
      { type: "memory", path: "/p/wiki/c.md", title: "C", snippet: "sc" }, // 非权威 → 过滤
      { type: "memory", path: "/p/wiki/d.md", title: "D", snippet: "sd" }, // 历史片段 → 过滤
      { type: "memory", path: "/p/wiki/e.md", title: "E", snippet: "se" }, // 通过
    ])
    hoisted.isAuthoritativeGenerationPath.mockImplementation((p: string) => !p.includes("c.md"))
    hoisted.isHistoricalProjectionSnippet.mockImplementation((_p: string, s: string) => s === "sd")
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("- E: se")
  })

  it("searchRelevantContentUnified: rerankCandidates 抛错 → catch 回退 candidates", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" },
    ])
    hoisted.rerankCandidates.mockRejectedValue(new Error("rerank"))
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("- A: sa")
  })

  it("searchRelevantContentUnified: rerank 返回缺失 snippet 的结果 → ?? 兜底空串（entityBoost 开/关）", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" },
    ])
    hoisted.rerankCandidates.mockImplementationOnce(async () => [
      { title: "A", path: "/p/wiki/a.md" },
    ])
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const outOff = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(outOff).toBe("- A: ")
    hoisted.rerankCandidates.mockImplementationOnce(async () => [
      { title: "A", path: "/p/wiki/a.md" },
    ])
    const outOn = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig({ entityBoostEnabled: true }),
    })
    expect(outOn).toBe("- A: ")
  })

  it("searchRelevantContentUnified: entityBoost on 时 ordered 携带 path/id", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" },
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" }, // 合并去重
    ])
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig({ entityBoostEnabled: true, entityBoostWeight: 0.7 }),
    })
    expect(out).toBe("- A: sa")
  })

  it("searchRelevantContentUnified: novelMixedSearch 抛错 → []", async () => {
    hoisted.novelMixedSearch.mockRejectedValue(new Error("mixed"))
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("")
  })
})

describe("searchGraphRelevantContent", () => {
  const node = (id: string, title: string, path: string) => ({ id, title, path })

  it("graph 空 → 空串", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({ nodes: new Map() })
    await expect(searchGraphRelevantContent("/p", "任务", undefined)).resolves.toBe("")
  })

  it("title/id 双路匹配 + 关联扩展 + 社区摘要拼接", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, ReturnType<typeof node>>([
        ["n1", node("n1", "林晚秋", "/p/wiki/entities/n1.md")],
        ["n2", node("n2", "路人", "/p/wiki/entities/n2.md")],
        ["n3", node("n3", "无关", "/p/wiki/entities/n3.md")],
      ]),
    })
    hoisted.getRelatedNodes.mockReturnValue([
      { node: node("r1", "关联者", "/p/wiki/entities/r1.md"), relevance: 0.8 },
      { node: node("n1", "林晚秋", "/p/wiki/entities/n1.md"), relevance: 0.9 }, // 已 seen → 跳过
    ])
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.endsWith("r1.md") ? "# 关联者内容" : "",
    )
    hoisted.searchCommunitySummaries.mockResolvedValue("社区摘要文本")
    const out = await searchGraphRelevantContent("/p", "林晚秋 任务", undefined)
    expect(out).toContain("关联者")
    expect(out).toContain("社区摘要文本")
  })

  it("id 命中分支（title 不中）+ 内层 seed 循环 break", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, ReturnType<typeof node>>([
        ["k1", node("k1", "空标题", "/p/wiki/entities/k1.md")], // title.length < 2
        ["sig", node("sig", "短", "/p/wiki/entities/sig.md")],
      ]),
    })
    hoisted.getRelatedNodes.mockReturnValue([
      { node: node("sig-doc", "sig 详情", "/p/sig-doc.md"), relevance: 0.9 },
    ])
    hoisted.readFile.mockResolvedValue("内容")
    const out = await searchGraphRelevantContent("/p", "sig 任务", undefined)
    expect(out).toContain("sig 详情")
  })

  it("rerankCandidates 抛错 → catch 用 scoredNodes", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, ReturnType<typeof node>>([["a", node("a", "关联者", "/p/a.md")]]),
    })
    hoisted.getRelatedNodes.mockReturnValue([
      { node: node("a-rel", "甲 关联", "/p/a-rel.md"), relevance: 1 },
    ])
    hoisted.rerankCandidates.mockRejectedValue(new Error("rerank"))
    hoisted.readFile.mockResolvedValue("内容")
    const out = await searchGraphRelevantContent("/p", "关联者 任务", undefined)
    expect(out).toContain("甲 关联")
  })

  it("buildRetrievalGraph 抛错 → 外层 catch 空串", async () => {
    hoisted.buildRetrievalGraph.mockRejectedValue(new Error("graph"))
    await expect(searchGraphRelevantContent("/p", "x", undefined)).resolves.toBe("")
  })

  it("无匹配节点 + 社区摘要失败 → 空/仅节点", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, ReturnType<typeof node>>([["a", node("a", "甲", "/p/a.md")]]),
    })
    hoisted.readFile.mockResolvedValue("")
    hoisted.searchCommunitySummaries.mockRejectedValue(new Error("cs"))
    const out = await searchGraphRelevantContent("/p", "完全无关", undefined)
    expect(out).toBe("")
  })
})

describe("truncateActiveEntitiesByBudget 补齐", () => {
  const mkEntity = (name: string, tags?: string[]): ContextEntity => ({
    entityId: name,
    name,
    type: "character",
    tags,
  })

  it("budget undefined → 原样返回不截断", () => {
    const entities = [mkEntity("a"), mkEntity("b")]
    const r = truncateActiveEntitiesByBudget(entities, undefined, 5)
    expect(r.entities).toBe(entities)
    expect(r.gap).toBeNull()
  })

  it("chapterNumber 为 0 → location 检查跳过（falsy）", () => {
    const budget = { rank0Floor: 1, rank1CompressibleCap: 1, rank2CompressibleCap: 1 }
    const r = truncateActiveEntitiesByBudget(
      [mkEntity("x", ["location:chapter-5"])],
      budget,
      0,
    )
    expect(r.entities.length).toBe(1) // rank1, 容量 1 → 保留
    expect(r.gap).toBeNull()
  })

  it("location:chapter-N 命中 → rank0 不受 cap 限制", () => {
    const budget = { rank0Floor: 1, rank1CompressibleCap: 0, rank2CompressibleCap: 0 }
    const r = truncateActiveEntitiesByBudget(
      [mkEntity("a", ["location:chapter-7"]), mkEntity("b", ["relevance:low"])],
      budget,
      7,
    )
    expect(r.entities.map((e) => e.name)).toEqual(["a"])
    expect(r.gap).not.toBeNull()
  })

  it("rank1 超量截断 + rank2 超量截断 → truncated gap", () => {
    const budget = { rank0Floor: 1, rank1CompressibleCap: 2, rank2CompressibleCap: 1 }
    const r = truncateActiveEntitiesByBudget(
      [
        ...Array.from({ length: 3 }, (_, i) => mkEntity(`r1_${i}`)),
        ...Array.from({ length: 3 }, (_, i) => mkEntity(`r2_${i}`, ["relevance:low"])),
      ],
      budget,
      5,
    )
    expect(r.entities.filter((e) => e.name.startsWith("r1_")).length).toBe(2)
    expect(r.entities.filter((e) => e.name.startsWith("r2_")).length).toBe(1)
    expect(r.gap).toEqual({
      type: "truncated",
      ref: "activeEntities",
      reason: "tier_compressible",
      originalLength: 6,
      retainedLength: 3,
    })
  })

  it("无 tags → rank1（默认）", () => {
    const budget = { rank0Floor: 1, rank1CompressibleCap: 0, rank2CompressibleCap: 0 }
    const r = truncateActiveEntitiesByBudget([mkEntity("naked")], budget, 5)
    expect(r.entities).toEqual([])
    expect(r.gap).not.toBeNull()
  })
})

describe("loadTemporalFactsCached / 缓存管理", () => {
  it("无快照 → 空事实 + 空 revision 缓存命中", async () => {
    await expect(loadTemporalFactsCached("/p1")).resolves.toEqual([])
    // 第二次调用走缓存（entries 空路径的 cache hit）
    await expect(loadTemporalFactsCached("/p1")).resolves.toEqual([])
  })

  it("有快照 → 折叠 + 缓存命中 + mtime 失败回退 0", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "3.snapshot.json", path: "/p1/.novel/snapshots/3.snapshot.json", is_dir: false },
      { name: "outline-2.snapshot.json", path: "/p1/.novel/snapshots/outline-2.snapshot.json", is_dir: false },
      { name: "readme.txt", path: "/p1/.novel/snapshots/readme.txt", is_dir: false },
      { name: "abc.snapshot.json", path: "/p1/.novel/snapshots/abc.snapshot.json", is_dir: false },
    ])
    hoisted.getFileModifiedTime.mockImplementation(async (p: string) =>
      p.includes("3.snapshot") ? 100 : Promise.reject(new Error("mtime")),
    )
    const facts: TemporalFact[] = [{ id: "f1", subject: "林晚秋", predicate: "持有", object: "剑", validFrom: 3, source: "chapter-3" }]
    hoisted.listSnapshots.mockResolvedValue([3, 5])
    hoisted.loadSnapshot.mockImplementation(async (_pp: string, n: number) =>
      n === 3 ? ({ chapterNumber: 3 } as ChapterSnapshot) : null,
    )
    hoisted.factsFromCommittedSnapshots.mockReturnValue(facts)
    await expect(loadTemporalFactsCached("/p1")).resolves.toEqual(facts)
    // cache hit → factsFromCommittedSnapshots 不再调用
    hoisted.factsFromCommittedSnapshots.mockClear()
    await expect(loadTemporalFactsCached("/p1")).resolves.toEqual(facts)
    expect(hoisted.factsFromCommittedSnapshots).not.toHaveBeenCalled()
  })

  it("listSnapshots 抛错 → loadTemporalFactsCached reject（build 侧 catch 处理）", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "3.snapshot.json", path: "/p1/.novel/snapshots/3.snapshot.json", is_dir: false },
    ])
    hoisted.listSnapshots.mockRejectedValue(new Error("ingest"))
    await expect(loadTemporalFactsCached("/p1")).rejects.toThrow("ingest")
  })

  it("同一 path revision 变化 → 缓存失效重算（set 移动插入序）", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    await loadTemporalFactsCached("/p-same") // 0:0:0:0
    hoisted.listDirectory.mockResolvedValue([
      { name: "2.snapshot.json", path: "/p-same/.novel/snapshots/2.snapshot.json", is_dir: false },
    ])
    hoisted.getFileModifiedTime.mockResolvedValue(50)
    hoisted.listSnapshots.mockResolvedValue([2])
    hoisted.loadSnapshot.mockResolvedValue({ chapterNumber: 2 } as ChapterSnapshot)
    const facts: TemporalFact[] = [{ id: "f2", subject: "苏明月", predicate: "到达", object: "城", validFrom: 2, source: "chapter-2" }]
    hoisted.factsFromCommittedSnapshots.mockReturnValue(facts)
    await expect(loadTemporalFactsCached("/p-same")).resolves.toEqual(facts)
  })

  it("缓存 eviction：超过 16 个项目驱逐最旧", async () => {
    for (let i = 0; i < 17; i += 1) {
      await expect(loadTemporalFactsCached(`/proj-${i}`)).resolves.toEqual([])
    }
    // 再查第 0 个（已被驱逐）→ 重新计算（仍为空，不抛错）
    await expect(loadTemporalFactsCached("/proj-0")).resolves.toEqual([])
  })

  it("clearTemporalFactsCache 单项目 + 全清 + 测试重置", async () => {
    await loadTemporalFactsCached("/clear-me")
    clearTemporalFactsCache("/clear-me")
    await loadTemporalFactsCached("/clear-me")
    clearTemporalFactsCache()
    await loadTemporalFactsCached("/clear-me")
    __resetTemporalFactsCacheForTests()
    await loadTemporalFactsCached("/clear-me")
  })
})

describe("buildRelatedChaptersContext", () => {
  const base: RelatedChaptersContextInput = {
    currentChapter: 5,
    chapterOutline: "第5章细纲",
    foreshadowing: { items: [], lastUpdated: "" },
  }

  it("appearances 显式提供 + overdue findings 非空 → 组合文本", () => {
    hoisted.buildRelatedChapters.mockReturnValue([{ id: "c1" }] as never)
    hoisted.relatedChaptersToContextText.mockReturnValue("反查正文")
    hoisted.findOverdueForeshadowing.mockReturnValue([{ finding: "伏笔A逾期" }] as never)
    const r = buildRelatedChaptersContext({ ...base, appearances: [] })
    expect(r.text).toContain("反查正文")
    expect(r.text).toContain("伏笔逾期提醒")
    expect(r.text).toContain("伏笔A逾期")
  })

  it("无 appearances 但有 snapshots → buildAppearancesFromSnapshots 构造", () => {
    buildRelatedChaptersContext({ ...base, snapshots: [{ chapterNumber: 1 }] as unknown as readonly ChapterSnapshot[] })
    expect(hoisted.buildAppearancesFromSnapshots).toHaveBeenCalledTimes(1)
  })

  it("两者皆无 → appearances []；无 overdue → 无提醒段", () => {
    hoisted.relatedChaptersToContextText.mockReturnValue("")
    hoisted.findOverdueForeshadowing.mockReturnValue([])
    const r = buildRelatedChaptersContext(base)
    expect(r.text).toBe("")
    expect(hoisted.buildRelatedChapters).toHaveBeenCalledWith(
      expect.objectContaining({ appearances: [] }),
      undefined,
    )
  })
})

describe("buildContextPack 集成", () => {
  it("novelMode=false → emptyPack", async () => {
    const pack = await buildContextPack("/p", "生成第2章正文", undefined, {
      novelMode: false,
    })
    expect(pack.task).toBe("生成第2章正文")
    expect(pack.gaps).toEqual([])
    expect(pack.styleExemplars).toEqual([])
    expect(pack.activeEntities).toEqual([])
    expect(pack.chapterGoal).toBe("")
    expect(pack.relatedChapters).toBeUndefined()
    expect(pack.temporalFacts).toBeUndefined()
    // Wave 5: emptyPack 不装配 contextUsage（additive 降级）
    expect(pack.contextUsage).toBeUndefined()
  })

  it("novelMode 缺省回退 store（默认 true）→ 全量装配", async () => {
    const pack = await buildContextPack("/p", "生成第2章正文", 3)
    expect(pack.task).toBe("生成第2章正文")
    expect(pack.chapterGoal).toBe("细纲：目标") // 第3章细纲：目标 → 剥标签
    expect(pack.outline).toBe("## 大纲\n第一章 起\n\n第一卷\n\n第3章细纲：目标")
    expect(pack.recentChapterContents).toEqual(["## 第2章正文片段\n内容"])
    expect(pack.recentSummaries).toEqual(["第1章摘要", "第2章摘要"])
    expect(pack.previousChapterEnding).toBe("上一章结尾")
    expect(pack.characterStates).toContain("快照角色状态")
    expect(pack.timeline).toBe("快照时间线")
    expect(pack.foreshadowingStates).toContain("伏笔甲：未回收")
    expect(pack.soulDoc).toBe("项目灵魂")
    expect(pack.cognitionStates).toBe("林晚秋知道：剑")
    expect(pack.relatedSettings).toBe("地点设定")
    expect(pack.canonRules).toBe("正史规则")
    expect(pack.writingStyle).toBe("写作风格")
    expect(pack.searchResults).toBe("相关记忆")
    expect(pack.graphSearchResults).toBe("图谱节点")
    expect(pack.mustDo).toContain("- 细纲：目标")
    expect(pack.mustAvoid).toContain("正史规则")
    expect(pack.nextChapterAdvice).toContain("第2章摘要")
    expect(pack.revisionDirectives).toBe("")
    expect(pack.gaps).toEqual([])
    expect(pack.styleExemplars).toEqual([])
    expect(pack.activeEntities).toEqual([])
    expect(pack.relatedChapters).toBe("")
    expect(pack.communitySummaries).toBeUndefined()
    expect(pack.temporalFacts).toEqual([]) // chapter 3 > 0 → loadTemporalFactsCached 空折叠
    // Wave 5: 全量装配冻结 contextUsage（预算线来自 currentBuildBudget；
    // user-memory 读取失败 → memoryChars 0 不阻断）
    expect(pack.contextUsage).toBeDefined()
    expect(pack.contextUsage!.maxCtx).toBeGreaterThan(0)
    expect(pack.contextUsage!.bodyChars).toBeGreaterThan(0)
    expect(pack.contextUsage!.retrievalChars).toBeGreaterThan(0)
    expect(typeof pack.contextUsage!.memoryChars).toBe("number")
  })

  it("chapterNumber undefined → 从 task 提取 + 记录到 load context", async () => {
    await buildContextPack("/p", "生成第7章正文")
    const ctx = hoisted.lastLoadContext as {
      chapterNumber?: number
      maxContextSize?: number
      config: { recentSummaryWindow: number; searchTopK: number; snapshotLookback: number }
    }
    expect(ctx.chapterNumber).toBe(7)
    expect(ctx.maxContextSize).toBe(204800)
    expect(ctx.config.snapshotLookback).toBe(3)
  })

  it("buildLoadContext: window/searchTopK fallback（store 0/负值 → 默认）", async () => {
    useWikiStore.setState({ novelConfig: mkNovelConfig({ recentSummaryWindow: 0, searchTopK: -1 }) })
    await buildContextPack("/p", "任务")
    const ctx = hoisted.lastLoadContext as {
      config: { recentSummaryWindow: number; searchTopK: number }
    }
    expect(ctx.config.recentSummaryWindow).toBe(8)
    expect(ctx.config.searchTopK).toBe(5)
  })

  it("buildLoadContext: options 优先于 store（window/searchTopK 直通）", async () => {
    useWikiStore.setState({ novelConfig: mkNovelConfig({ recentSummaryWindow: 99 }) })
    await buildContextPack("/p", "任务", 2, {
      novelConfig: mkNovelConfig({ recentSummaryWindow: 3, searchTopK: 7 }),
      llmConfig: mkLlmConfig(5000),
      revisionFeedbackWindowConfig: { lookback: 1 },
    })
    const ctx = hoisted.lastLoadContext as {
      maxContextSize?: number
      config: { recentSummaryWindow: number; searchTopK: number; revisionFeedbackWindowConfig?: unknown }
    }
    expect(ctx.maxContextSize).toBe(5000)
    expect(ctx.config.recentSummaryWindow).toBe(3)
    expect(ctx.config.searchTopK).toBe(7)
    expect(ctx.config.revisionFeedbackWindowConfig).toEqual({ lookback: 1 })
  })

  it("temporalFacts 折叠注入 canonRules + rerank + 预算截断 gap", async () => {
    hoisted.listDirectory.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({
        name: `e${i}.md`,
        path: `/p/wiki/entities/e${i}.md`,
        is_dir: false,
      })),
    )
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.includes("/wiki/entities/") ? `---\ntitle: rank1_${p.match(/e(\d+)\.md/)?.[1] ?? "x"}\n---\n` : "",
    )
    hoisted.renderTemporalCanonBlock.mockReturnValue("时间线正史块")
    hoisted.loadAllImpl = async () => ({
      ...fixtureRawData(),
      snapshots: {
        recentSummaries: ["S1"],
        previousChapterEnding: "结尾",
        characterStates: "角色",
        timeline: "时间线",
        foreshadowingSignals: [],
      },
    })
    hoisted.loadStyleExemplars.mockResolvedValue([
      { id: "x1", text: "示例段落", markType: "style" as const, source: "c1" },
    ])
    hoisted.loadForeshadowingTracker.mockResolvedValue({ items: [] })
    hoisted.relatedChaptersToContextText.mockReturnValue("四维反查文本")
    const pack = await buildContextPack("/p", "任务", 3, {
      llmConfig: mkLlmConfig(1000),
      novelConfig: mkNovelConfig({
        exemplarEnabled: true,
        relatedChaptersEnabled: true,
        temporalFactsEnabled: true,
        conditionalRoutingEnabled: true,
      }),
    })
    expect(pack.canonRules).toContain("时间线正史块")
    expect(pack.temporalFacts).toEqual([])
    expect(pack.styleExemplars).toHaveLength(1)
    expect(pack.relatedChapters).toBe("四维反查文本")
    // 零匹配 → 回退全量 40 实体；maxCtx=1000 → rank1CompressibleCap=30 → 40 个 rank1 被截断 → gap
    expect(pack.activeEntities!.length).toBe(30)
    const activeGap = pack.gaps!.find((g) => g.ref === "activeEntities")
    expect(activeGap).toBeDefined()
    expect(activeGap!.reason).toBe("tier_compressible")
  })

  it("conditionalRoutingEnabled=true → selectActiveEntities 注入 + ROI variant enabled", async () => {
    // 通过 mock 函数被 build 调用的路径：selectActiveEntities 是 context-engine 内部真实函数，
    // 依赖 mocked listDirectory/readFile/parseFrontmatter —— 直接在 build 内触发。
    hoisted.listDirectory.mockResolvedValue([
      { name: "e.md", path: "/p/wiki/entities/e.md", is_dir: false },
    ])
    hoisted.readFile.mockResolvedValue("---\ntitle: 林晚秋\ntype: character\ntags: [relevance:high]\n---\n")
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: true }),
    })
    expect(pack.activeEntities).toEqual([
      { entityId: "/p/wiki/entities/e.md", name: "林晚秋", type: "character", tags: ["relevance:high"] },
    ])
    expect(hoisted.appendRoutingROISample).toHaveBeenCalledTimes(1)
    const sample = hoisted.appendRoutingROISample.mock.calls[0][1] as { variant: string; chapterId: string }
    expect(sample.variant).toBe("enabled")
    expect(sample.chapterId).toBe("3")
  })

  it("conditionalRoutingEnabled=false → ROI variant disabled + chapterId unknown", async () => {
    await buildContextPack("/p", "任务", undefined, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: false }),
    })
    const sample = hoisted.appendRoutingROISample.mock.calls[0][1] as { variant: string; chapterId: string }
    expect(sample.variant).toBe("disabled")
    expect(sample.chapterId).toBe("unknown")
  })

  it("selectActiveEntities 抛错 → catch 降级 []（不阻断 pack）", async () => {
    hoisted.listDirectory.mockRejectedValue(new Error("no entities dir"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: true }),
    })
    expect(pack.activeEntities).toEqual([])
  })

  it("exemplar 加载失败 → catch 降级 []", async () => {
    hoisted.loadStyleExemplars.mockRejectedValue(new Error("exem"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ exemplarEnabled: true }),
    })
    expect(pack.styleExemplars).toEqual([])
  })

  it("relatedChapters 构建失败 → catch 降级空串", async () => {
    hoisted.loadForeshadowingTracker.mockRejectedValue(new Error("fs"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ relatedChaptersEnabled: true }),
    })
    expect(pack.relatedChapters).toBe("")
  })

  it("relatedChaptersPromise 内 snapshots 加载失败 → 跳过出场维度", async () => {
    hoisted.loadForeshadowingTracker.mockResolvedValue({ items: [] })
    hoisted.listSnapshots.mockRejectedValue(new Error("snap"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ relatedChaptersEnabled: true }),
    })
    expect(pack.relatedChapters).toBe("RELATED-TEXT")
  })

  it("audit empty_soft + shouldRecordGap → warn + gap 注入", async () => {
    hoisted.auditTemporalFactsStatus.mockReturnValue({
      schemaVersion: "temporal-facts-audit/1.0",
      level: "empty_soft",
      enabled: true,
      chapterNumber: 3,
      factCount: 0,
      shouldRecordGap: true,
      message: "soft gap",
      productHardGate: false,
    })
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ temporalFactsEnabled: true }),
    })
    expect(pack.gaps!.some((g) => g.ref === "temporal-gap:3" && g.type === "load_failed")).toBe(true)
  })

  it("audit 非 empty_soft 且不记 gap → 无注入", async () => {
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ temporalFactsEnabled: true }),
    })
    expect(pack.gaps!.some((g) => g.ref.startsWith("temporal-gap:"))).toBe(false)
  })

  it("communitySummaryEnabled=true → 加载社区摘要文本", async () => {
    useWikiStore.setState({ novelConfig: mkNovelConfig({ communitySummaryEnabled: true }) })
    hoisted.loadPersistedCommunitySummaries.mockResolvedValue({ text: "社区摘要正文" })
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ communitySummaryEnabled: true }),
    })
    expect(pack.communitySummaries).toBe("社区摘要正文")
  })

  it("communitySummaryEnabled=true 但加载失败 → catch 空串 → undefined", async () => {
    useWikiStore.setState({ novelConfig: mkNovelConfig({ communitySummaryEnabled: true }) })
    hoisted.loadPersistedCommunitySummaries.mockRejectedValue(new Error("cs"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ communitySummaryEnabled: true }),
    })
    expect(pack.communitySummaries).toBeUndefined()
  })

  it("loadTemporalFactsCached 抛错 → catch null（canonRules 保持原样）", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "3.snapshot.json", path: "/p/.novel/snapshots/3.snapshot.json", is_dir: false },
    ])
    hoisted.listSnapshots.mockRejectedValue(new Error("ingest"))
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.temporalFacts).toBeNull()
    expect(pack.canonRules).toBe("正史规则")
  })

  it("gap recorder：build 期内数据源截断 → pack.gaps 携带 truncated", async () => {
    hoisted.loadAllImpl = async () => {
      const ce = await import("./context-engine")
      // 内容 > maxPageSize（maxCtx=5000 → pageBudget=2500 → maxPageSize=2500）→ 截断 + 记 gap
      ce.pickChapterOutlineByNumber(
        [{ path: "o.md", content: "第3章" + "x".repeat(9000) }],
        3,
      )
      return fixtureRawData()
    }
    const pack = await buildContextPack("/p", "任务", 3, { llmConfig: mkLlmConfig(5000) })
    const truncGap = pack.gaps!.find((g) => g.ref === "chapter-outline:3:heading")
    expect(truncGap).toBeDefined()
    expect(truncGap!.reason).toBe("budget_exceeded")
    expect(truncGap!.retainedLength).toBe(2500)
    // build 结束后 active 标志已清：build 外直接截断不再记 gap
    const direct = pickChapterOutlineByNumber(
      [{ path: "o.md", content: "第3章" + "x".repeat(9000) }],
      3,
    )
    expect(direct.length).toBe(6000)
  })

  it("recordGap 回调（DC-8）：数据源 load 失败显式记 load_failed gap", async () => {
    hoisted.loadAllImpl = async (ctx) => {
      const c = ctx as { recordGap?: (ref: string, reason?: string) => void }
      c.recordGap?.("datasource-x", "datasource_error")
      return fixtureRawData()
    }
    const pack = await buildContextPack("/p", "任务", 3)
    const loadFailed = pack.gaps!.find((g) => g.ref === "datasource-x")
    expect(loadFailed).toEqual({
      type: "load_failed",
      ref: "datasource-x",
      reason: "datasource_error",
      originalLength: 0,
      retainedLength: 0,
    })
  })

  it("mutex：并发 build 串行化且各自结果正确", async () => {
    const order: string[] = []
    let calls = 0
    hoisted.loadAllImpl = async () => {
      calls += 1
      order.push(calls === 1 ? "first" : "second")
      if (calls === 1) await new Promise((r) => setTimeout(r, 10))
      return fixtureRawData()
    }
    const p1 = buildContextPack("/p", "任务A", 3)
    const p2 = buildContextPack("/p", "任务B", 3)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(order).toEqual(["first", "second"])
    expect(r1.task).toBe("任务A")
    expect(r2.task).toBe("任务B")
  })

  it("mutex：build 抛错 → reject 透传且链不卡死后续调用", async () => {
    hoisted.loadAllImpl = async () => {
      throw new Error("load-boom")
    }
    await expect(buildContextPack("/p", "任务", 3)).rejects.toThrow("load-boom")
    hoisted.loadAllImpl = null
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.task).toBe("任务")
  })

  it("finally 清理：失败 build 的 gaps 不泄漏到下一次 build", async () => {
    hoisted.loadAllImpl = async (ctx) => {
      const c = ctx as { recordGap?: (ref: string, reason?: string) => void }
      c.recordGap?.("leaked-ref", "datasource_error")
      throw new Error("abort")
    }
    await expect(buildContextPack("/p", "任务", 3)).rejects.toThrow("abort")
    hoisted.loadAllImpl = null
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.gaps).toEqual([])
  })
})

describe("contextPackToPrompt 补充分支", () => {
  const mkEntity = (name: string, tags: string[]): ContextEntity => ({
    entityId: name,
    name,
    type: "character",
    tags,
  })

  it("excludeOutline=true 跳过 outline 段；false 渲染", () => {
    const pack: ContextPack = { ...basePack, outline: "大纲正文" }
    const without = contextPackToPrompt(pack, undefined, { excludeOutline: true })
    expect(without).not.toContain("大纲正文")
    const withOutline = contextPackToPrompt(pack, undefined, { excludeOutline: false })
    expect(withOutline).toContain("大纲正文")
  })

  it("layeredRecall=scenario_persona 且 temporal off → 跳过 canonRules；temporal on → 渲染", () => {
    const pack: ContextPack = { ...basePack, canonRules: "正史" }
    const skipped = contextPackToPrompt(pack, undefined, { layeredRecall: "scenario_persona" })
    expect(skipped).not.toContain("正史")
    const kept = contextPackToPrompt(pack, undefined, {
      layeredRecall: "scenario_persona",
      temporalFactsEnabled: true,
    })
    expect(kept).toContain("正史")
  })

  it("layeredRecall=full → 全部段渲染（recentChapterContents + canonRules + activeEntities）", () => {
    const pack: ContextPack = {
      ...basePack,
      recentChapterContents: ["正文片段"],
      canonRules: "正史",
      activeEntities: [mkEntity("林晚秋", [])],
    }
    const prompt = contextPackToPrompt(pack, undefined, { layeredRecall: "full" })
    expect(prompt).toContain("正文片段")
    expect(prompt).toContain("正史")
    expect(prompt).toContain("林晚秋")
  })

  it("temporal=true 但 activeEntities 为空 → 段跳过", () => {
    const prompt = contextPackToPrompt(basePack, undefined, { temporalFactsEnabled: true })
    expect(prompt).not.toContain(i18n.t("novel.contextPack.activeEntities"))
  })

  it("activeEntities 序列化：有 tags 与无 tags 两种形态", () => {
    const pack: ContextPack = {
      ...basePack,
      activeEntities: [mkEntity("有标签", ["a", "b"]), mkEntity("无标签", [])],
    }
    const prompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    expect(prompt).toContain("- 有标签 (tags: a, b)")
    expect(prompt).toContain("- 无标签")
  })

  it("SECTION_PRIORITY 排序：已知优先级段在未知(999)段之前", () => {
    const pack: ContextPack = {
      ...basePack,
      canonRules: "正史", // 禁止违背 → 5
      activeEntities: [mkEntity("林晚秋", [])], // 当前章节关联实体 → 999
      mustDo: "必须项", // 本章必须完成 → 999
    }
    const prompt = contextPackToPrompt(pack, undefined, { temporalFactsEnabled: true })
    const canonIdx = prompt.indexOf(i18n.t("novel.contextPack.canonRules"))
    const entityIdx = prompt.indexOf(i18n.t("novel.contextPack.activeEntities"))
    const mustDoIdx = prompt.indexOf(i18n.t("novel.contextPack.mustDo.title"))
    expect(canonIdx).toBeGreaterThan(-1)
    expect(entityIdx).toBeGreaterThan(canonIdx)
    expect(mustDoIdx).toBeGreaterThan(canonIdx)
  })

  it("sectionCharBudget：字符串截断 + 数组逐项预算", () => {
    const pack: ContextPack = { ...basePack, characterStates: "abcdef" }
    expect(contextPackToPrompt(pack, undefined, { sectionCharBudget: 3 })).toContain("abc…")
    const arrPack: ContextPack = { ...basePack, recentSummaries: ["aaa", "bbbb"] }
    // budget 5: aaa(3) 满入, bbbb 只剩 2 → "bb…"
    expect(contextPackToPrompt(arrPack, undefined, { sectionCharBudget: 5 })).toContain("bb…")
    // budget 3: aaa 满入, 第二项因 used>=budget break
    expect(contextPackToPrompt(arrPack, undefined, { sectionCharBudget: 3 })).toContain("aaa")
    // budget 10: 全入
    const all = contextPackToPrompt(arrPack, undefined, { sectionCharBudget: 10 })
    expect(all).toContain("aaa")
    expect(all).toContain("bbbb")
  })

  it("sectionCharBudget 0/负数/undefined → 原样", () => {
    const pack: ContextPack = { ...basePack, recentSummaries: ["aaa"] }
    expect(contextPackToPrompt(pack, undefined, { sectionCharBudget: 0 })).toContain("aaa")
    expect(contextPackToPrompt(pack, undefined, { sectionCharBudget: -5 })).toContain("aaa")
    expect(contextPackToPrompt(pack)).toContain("aaa")
  })

  it("tokenBudget：未提供/<=0/足够大 → 原样返回", () => {
    const pack: ContextPack = { ...basePack, characterStates: "状态" }
    expect(contextPackToPrompt(pack)).toContain("状态")
    expect(contextPackToPrompt(pack, 0)).toContain("状态")
    expect(contextPackToPrompt(pack, -1)).toContain("状态")
    const longPack: ContextPack = { ...basePack, characterStates: "状".repeat(500) }
    expect(contextPackToPrompt(longPack, 10_000_000)).toContain("状态")
  })

  it("tokenBudget：超预算且估算 token 未超 → 原样（CJK 加权）", () => {
    const pack: ContextPack = { ...basePack, characterStates: "状".repeat(100) }
    // length > 100, 但 CJK 估算 = ceil(100/1.5) = 67 <= 100 → 不裁剪
    const prompt = contextPackToPrompt(pack, 100)
    expect(prompt).not.toContain("上下文已按Token预算裁剪")
  })

  it("tokenBudget：超预算且估算超 → 头尾裁剪", () => {
    const head = "H".repeat(300)
    const tail = "T".repeat(300)
    const pack: ContextPack = { ...basePack, characterStates: head + tail }
    const full = contextPackToPrompt(pack)
    const trimmed = contextPackToPrompt(pack, 100)
    expect(trimmed).toContain("[...上下文已按Token预算裁剪...]")
    // tokenBudget=100 → targetChars=400 → head 160, tail 240
    expect(trimmed).toBe(
      full.slice(0, 160) + "\n\n[...上下文已按Token预算裁剪...]\n\n" + full.slice(-240),
    )
  })

  it("recentChapterContents 默认模式跳过（仅 full 渲染）", () => {
    const pack: ContextPack = { ...basePack, recentChapterContents: ["L0原文"] }
    expect(contextPackToPrompt(pack)).not.toContain("L0原文")
  })
})

describe("searchRelevantContent 向量 probePath 分支", () => {
  it("title 三种来源：# heading / ---title / vrId 兜底 + 读取失败跳过", async () => {
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([
      { id: "heading-one" },
      { id: "title-two" },
      { id: "bare-three" },
      { id: "missing-four" },
    ])
    hoisted.readFile.mockImplementation(async (p: string) => {
      if (p.includes("heading-one")) return "# 标题甲\n正文"
      if (p.includes("title-two")) return "---\ntitle: 标题乙\n---\n正文"
      if (p.includes("bare-three")) return "无标题正文"
      throw new Error("no file")
    })
    const out = await searchRelevantContent("/p", "任务", undefined, 4, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(out).toContain("标题甲")
    expect(out).toContain("标题乙")
    expect(out).toContain("bare-three") // vrId 兜底
    expect(out).not.toContain("missing-four")
  })

  it("SEC-001：vr.id 路径穿越被 sanitize 后探测（sanitizeEntitySlug 生效）", async () => {
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([{ id: "evil/../../escape" }])
    hoisted.readFile.mockResolvedValue("# Safe")
    const out = await searchRelevantContent("/p", "任务", undefined, 1, {
      embeddingConfig: mkEmbeddingConfig(true, "m"),
      novelConfig: mkNovelConfig(),
    })
    expect(hoisted.sanitizeEntitySlug).toHaveBeenCalledWith("evil/../../escape")
    expect(out).toContain("Safe")
  })
})

describe("buildContextPack 内 runVectorSearchForContext gap 记录（build 期 active）", () => {
  it("向量命中数 > 门控后数 → 记 tier_compressible gap", async () => {
    hoisted.loadAllImpl = async () => {
      const ce = await import("./context-engine")
      await ce.searchRelevantContentUnified("/p", "任务", 3, 1, {
        embeddingConfig: mkEmbeddingConfig(true, "m"),
        novelConfig: mkNovelConfig(),
      })
      return fixtureRawData()
    }
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.novelMixedSearch.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }])
    hoisted.selectRelevantNovelVectorResults.mockImplementation((results: unknown[], limit: number) =>
      results.slice(0, limit),
    )
    hoisted.readFile.mockResolvedValue("# X")
    const pack = await buildContextPack("/p", "任务", 3)
    const gap = pack.gaps!.find((g) => g.ref === "vector-context")
    expect(gap).toBeDefined()
    expect(gap!.type).toBe("truncated")
    expect(gap!.reason).toBe("tier_compressible")
    expect(gap!.originalLength).toBe(3)
    expect(gap!.retainedLength).toBe(1)
  })

  it("门控后无差异（build 期）→ 不记 gap", async () => {
    hoisted.loadAllImpl = async () => {
      const ce = await import("./context-engine")
      await ce.searchRelevantContentUnified("/p", "任务", 3, 1, {
        embeddingConfig: mkEmbeddingConfig(true, "m"),
        novelConfig: mkNovelConfig(),
      })
      return fixtureRawData()
    }
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.novelMixedSearch.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([{ id: "a" }])
    hoisted.readFile.mockResolvedValue("# X")
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.gaps!.some((g) => g.ref === "vector-context")).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 全口径补齐（第二轮：针对 v8 报告的具体缺口）
// ════════════════════════════════════════════════════════════════════════════

describe("第二轮补齐：buildContextPack 异常/降级分支", () => {
  it("conditional routing 失败（Error）→ catch 降级 []", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "e.md", path: "/p/wiki/entities/e.md", is_dir: false },
    ])
    hoisted.parseFrontmatter.mockImplementation(() => {
      throw new Error("fm-boom")
    })
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: true }),
    })
    expect(pack.activeEntities).toEqual([])
  })

  it("conditional routing 失败（非 Error）→ String(error) 分支", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "e.md", path: "/p/wiki/entities/e.md", is_dir: false },
    ])
    hoisted.parseFrontmatter.mockImplementation(() => {
      throw "fm-string"
    })
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: true }),
    })
    expect(pack.activeEntities).toEqual([])
  })

  it("exemplar 加载失败（非 Error）→ String(error) 分支", async () => {
    hoisted.loadStyleExemplars.mockRejectedValue("string-err")
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ exemplarEnabled: true }),
    })
    expect(pack.styleExemplars).toEqual([])
  })

  it("relatedChapters 构建失败（非 Error）→ String(error) 分支", async () => {
    hoisted.loadForeshadowingTracker.mockRejectedValue("string-err")
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ relatedChaptersEnabled: true }),
    })
    expect(pack.relatedChapters).toBe("")
  })

  it("temporal 加载失败（非 Error）→ String(error) 分支", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "3.snapshot.json", path: "/p/.novel/snapshots/3.snapshot.json", is_dir: false },
    ])
    hoisted.listSnapshots.mockRejectedValue("ingest-string")
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.temporalFacts).toBeNull()
  })

  it("ROI 采样写入失败（Error）→ 非致命", async () => {
    hoisted.appendRoutingROISample.mockRejectedValue(new Error("roi"))
    const pack = await buildContextPack("/p", "任务", 3, { novelConfig: mkNovelConfig() })
    expect(pack.task).toBe("任务")
  })

  it("ROI 采样写入失败（非 Error）→ String(error) 分支", async () => {
    hoisted.appendRoutingROISample.mockRejectedValue("roi-string")
    const pack = await buildContextPack("/p", "任务", 3, { novelConfig: mkNovelConfig() })
    expect(pack.task).toBe("任务")
  })

  it("recordGap 在 build 结束后调用 → guard no-op（DC-8 守卫）", async () => {
    hoisted.loadAllImpl = async (ctx) => {
      const c = ctx as { recordGap?: (ref: string, reason?: string) => void }
      setTimeout(() => c.recordGap?.("late-ref", "datasource_error"), 0)
      return fixtureRawData()
    }
    const pack = await buildContextPack("/p", "任务", 3)
    await new Promise((r) => setTimeout(r, 10))
    expect(pack.gaps!.some((g) => g.ref === "late-ref")).toBe(false)
  })

  it("relatedChapters 装配：chapterNumber undefined + 空 chapterOutline + temporalFactsEnabled", async () => {
    hoisted.loadAllImpl = async () => ({ ...fixtureRawData(), chapterOutline: "" })
    hoisted.loadForeshadowingTracker.mockResolvedValue({ items: [] })
    hoisted.relatedChaptersToContextText.mockReturnValue("RC")
    const pack = await buildContextPack("/p", "任务", undefined, {
      novelConfig: mkNovelConfig({ relatedChaptersEnabled: true, temporalFactsEnabled: true }),
    })
    expect(pack.relatedChapters).toBe("RC")
    expect(pack.temporalFacts).toBeNull() // targetChapter 0 → null → rerank 收到 null
  })

  it("fallback rawData 路径（缺字段 → 降级 fallback 字段）", async () => {
    const base = fixtureRawData() as { snapshots: Record<string, unknown> }
    hoisted.loadAllImpl = async () => ({
      ...base,
      snapshots: {
        ...base.snapshots,
        recentSummaries: [],
        previousChapterEnding: "",
        characterStates: "",
        timeline: "",
        foreshadowingSignals: "not-array",
      },
      fallbackRecentSummaries: ["回退摘要"],
      fallbackPreviousEnding: "回退结尾",
      fallbackCharacterStates: "回退角色",
      fallbackTimeline: "回退时间线",
      fallbackForeshadowingStates: "回退伏笔",
    })
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.recentSummaries).toEqual(["回退摘要"])
    expect(pack.recentChapterContents).toEqual(["## 第2章正文片段\n内容"])
    expect(pack.previousChapterEnding).toBe("回退结尾")
    expect(pack.timeline).toBe("回退时间线")
    expect(pack.foreshadowingStates).toContain("回退伏笔")
    expect(pack.characterStates).toContain("回退角色")
    expect(pack.revisionDirectives).toBe("")
  })
})

describe("第二轮补齐：readChapterOutlineContent 深分支", () => {
  it("嵌套目录 flatten（dir 有/无 children）+ 读失败条目剔除", async () => {
    hoisted.listDirectory.mockResolvedValue([
      {
        name: "outlines",
        path: "/p/wiki/outlines",
        is_dir: true,
        children: [
          { name: "ch3.md", path: "/p/wiki/outlines/ch3.md", is_dir: false },
          { name: "notes.txt", path: "/p/wiki/outlines/notes.txt", is_dir: false },
          { name: "sub", path: "/p/wiki/outlines/sub", is_dir: true, children: [] },
          { name: "bad.md", path: "/p/wiki/outlines/bad.md", is_dir: false },
        ],
      },
    ])
    hoisted.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("ch3.md")) return "## 第3章 嵌套命中"
      throw new Error("no file")
    })
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("## 第3章 嵌套命中")
  })

  it("查询抛错 → catch [] 继续后续查询", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    hoisted.searchWiki
      .mockRejectedValueOnce(new Error("q1"))
      .mockResolvedValueOnce([{ title: "t", path: "/p/wiki/x.md", snippet: "" }])
      .mockResolvedValueOnce([])
    hoisted.readFile.mockResolvedValue("第3章 命中")
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("第3章 命中")
  })

  it("搜索命中但内容为空 → tieredSlice 空串提前返回", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    hoisted.searchWiki
      .mockResolvedValueOnce([{ title: "t", path: "/p/wiki/x.md", snippet: "" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    hoisted.readFile.mockResolvedValue("")
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("")
  })
})

describe("第二轮补齐：pickChapterOutlineByNumber / selectActiveEntities 细节", () => {
  it("frontmatter chapter_number 字符串 / 无效值分支", () => {
    hoisted.parseFrontmatter.mockImplementation(() => ({ content: "内容4", frontmatter: { chapter_number: "4" } }))
    const s = pickChapterOutlineByNumber(
      [{ path: "a.md", content: "内容4" }],
      4,
    )
    expect(s).toContain("内容4")
    hoisted.parseFrontmatter.mockImplementation(() => ({ content: "内容", frontmatter: { chapter_number: [1] } }))
    const bad = pickChapterOutlineByNumber(
      [{ path: "b.md", content: "内容" }],
      4,
    )
    expect(bad).toBe("")
  })

  it("selectActiveEntities: hints.outline/sceneCharacters undefined → ?? 空串", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
    ])
    hoisted.readFile.mockResolvedValue("---\ntitle: 甲\n---\n")
    const entities = await selectActiveEntities("/p", {
      chapterNumber: 3,
      outline: undefined as unknown as string,
      sceneCharacters: undefined as unknown as string,
    })
    expect(entities.map((e) => e.name)).toEqual(["甲"]) // 零匹配 → 回退全量
  })

  it("selectActiveEntities: tags 字符串逗号分隔 → split 分支", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
    ])
    hoisted.readFile.mockResolvedValue("---\ntitle: 甲\ntags: relevance:high, location:chapter-3\n---\n")
    const entities = await selectActiveEntities("/p", { chapterNumber: 3, outline: "甲", sceneCharacters: "" })
    expect(entities[0].tags).toEqual(["relevance:high", "location:chapter-3"])
  })
})

// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 第三轮补齐：100% 战役（r4nb）
// 覆盖：readChapterOutlineContent 搜索 catch / flatten 无 children 目录节点 /
// sceneCharacters 双源降级 / fallbackRecentSummaries / recentChapterContents
// 非数组 / chapterOutline 非字符串（relatedChapters 侧） / selectActiveEntities
// 回退全量 + 字符串 tags / computeIrrelevantRatio doesNotKnow 超长名 /
// extractChapterGoal 空白行 + 负章号 / searchRelevantContent 缺省 novelConfig、
// snippet 缺失、weight null / unified 索引 reject、snippet 缺失、weight null /
// searchGraphRelevantContent 单字符 token、≥2 关联节点 sort、读失败剔除。
// 不可达分支（另案说明）：tieredSlice compressible（仅 protected 调用点）、
// temporalFactsCache eviction break（while 守卫自洽）、buildMustDo/Advice 的
// firstForeshadowing falsy（外层 trim 守卫）、matchSource 空名（!name 守卫）、
// runVectorSearchForContext 的 catch 箭头（内部 try/catch 永不 reject）、
// probePath fulfilled?null（内部 catch 永不 reject）、seenIds 重复（Map 单次
// 迭代）、unified vectorResults snippet ??（上游已规整为 string）、CJK match
// null（i18n 标题恒含中文）。
// ════════════════════════════════════════════════════════════════════════════
describe("第三轮补齐：context-engine 分支全覆盖", () => {
  it("readChapterOutlineContent: 搜索全部 reject → catch 空串（catch 箭头）", async () => {
    hoisted.listDirectory.mockResolvedValue([])
    hoisted.readFile.mockResolvedValue("") // project-root FILLED 空 → 进入搜索路径
    hoisted.searchWiki.mockRejectedValue(new Error("search-down"))
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("")
  })

  it("readChapterOutlineContent: 目录节点无 children 字段 → flatten 跳过", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "sub", path: "/p/wiki/outlines/sub", is_dir: true }, // 无 children
      { name: "ch3.md", path: "/p/wiki/outlines/ch3.md", is_dir: false },
    ])
    hoisted.readFile.mockImplementation(async (p: string) =>
      p.endsWith("ch3.md") ? "## 第3章 目标" : "",
    )
    await expect(readChapterOutlineContent("/p", 3)).resolves.toBe("## 第3章 目标")
  })

  it("buildContextPack: sceneCharacters 双源（snapshot 空串 + fallback 非空）", async () => {
    hoisted.loadAllImpl = async () => ({
      ...fixtureRawData(),
      snapshots: { ...fixtureRawData().snapshots, characterStates: "" },
      fallbackCharacterStates: "降级角色状态",
    })
    hoisted.listDirectory.mockRejectedValue(new Error("no entities dir"))
    const pack = await buildContextPack("/p", "任务", 3, {
      novelConfig: mkNovelConfig({ conditionalRoutingEnabled: true }),
    })
    expect(pack.activeEntities).toEqual([])
  })

  it("buildContextPack: snapshots.recentSummaries 空/非数组 → fallbackRecentSummaries 兜底", async () => {
    hoisted.loadAllImpl = async () => ({
      ...fixtureRawData(),
      snapshots: { ...fixtureRawData().snapshots, recentSummaries: "not-array" as unknown as string[] },
      fallbackRecentSummaries: ["回退摘要"],
    })
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.recentSummaries).toEqual(["回退摘要"])
  })

  it("buildContextPack: recentChapterContents 非数组 → 空数组", async () => {
    hoisted.loadAllImpl = async () => ({
      ...fixtureRawData(),
      recentChapterContents: "not-an-array" as unknown as string[],
    })
    const pack = await buildContextPack("/p", "任务", 3)
    expect(pack.recentChapterContents).toEqual([])
  })

  it("buildContextPack: chapterOutline 非字符串 → relatedChapters 空串；构建抛错由 finally 兜底", async () => {
    hoisted.loadAllImpl = async () => ({
      ...fixtureRawData(),
      chapterOutline: 42 as unknown as string,
    })
    await expect(
      buildContextPack("/p", "任务", 3, {
        novelConfig: mkNovelConfig({ relatedChaptersEnabled: true }),
      }),
    ).rejects.toThrow()
  })

  it("selectActiveEntities: 零匹配回退全量 + tags 字符串分支", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
    ])
    hoisted.readFile.mockResolvedValue(
      "---\ntitle: 甲\ntags: relevance:high, location:chapter-3\n---\n",
    )
    const entities = await selectActiveEntities("/p", {
      chapterNumber: 3,
      outline: "无关",
      sceneCharacters: "无关",
    })
    expect(entities[0].tags).toEqual(["relevance:high", "location:chapter-3"])
  })

  it("computeIrrelevantRatio: doesNotKnow 超长名 → 名长守卫 false 侧（零候选 → 0）", () => {
    const pack: ContextPack = {
      ...basePack,
      characterStates: `${"名".repeat(21)}不知道：x`,
    }
    expect(computeIrrelevantRatio(pack, [])).toBe(0)
  })

  it("extractChapterGoal: 空白行 continue + 负章号 digits 兜底", () => {
    // 前置非标记行 + 空行 → `if (!trimmed) continue` 命中（cleaned 已整体 trim，行首空行不存活）
    expect(extractChapterGoal("前言\n\n## 第3章 目标", 3)).toBe("目标")
    expect(extractChapterGoal("第-1章 x", -1)).toBe("x")
  })

  it("contextPackToPrompt: canonRules 数组 → renderIf 数组分支", () => {
    const prompt = contextPackToPrompt(
      { ...basePack, canonRules: ["规则甲", "规则乙"] as unknown as string },
      undefined,
      { layeredRecall: "default" },
    )
    expect(prompt).toContain("规则甲")
    expect(prompt).toContain("规则乙")
  })

  it("searchRelevantContent: options.novelConfig 缺省回退 store（?? 右侧）", async () => {
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContent("/p", "任务", undefined, 2)
    expect(out).toBe("")
  })

  it("searchRelevantContent: keyword/index 结果 snippet 缺失 → ?? 空串", async () => {
    hoisted.searchWiki.mockResolvedValue([
      { title: "kw", snippet: undefined, path: "/k.md" },
      { title: "idx", snippet: undefined, path: "/i.md" },
    ])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContent("/p", "任务", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toContain("- kw: ")
    expect(out).toContain("- idx: ")
  })

  it("searchRelevantContent: entityBoostWeight null → ?? 0.4", async () => {
    hoisted.searchWiki.mockResolvedValue([{ title: "t", snippet: "s", path: "/t.md" }])
    await searchRelevantContent("/p", "任务", undefined, 2, {
      novelConfig: mkNovelConfig({
        entityBoostEnabled: true,
        entityBoostWeight: null as unknown as number,
      }),
    })
    const [, , weight] = hoisted.reorderByEntityBoost.mock.calls[0] as unknown[]
    expect(weight).toBe(0.4)
  })

  it("searchRelevantContentUnified: searchWiki(索引) reject → catch 降级", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([])
    hoisted.searchWiki.mockRejectedValue(new Error("idx-down"))
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("")
  })

  it("searchRelevantContentUnified: semantic snippet 缺失 → ?? 空串后过滤", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: undefined },
    ])
    hoisted.searchWiki.mockResolvedValue([{ title: "idx", snippet: "is", path: "/p/wiki/i.md" }])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("- idx: is") // semantic 空 snippet 被过滤
  })

  it("searchRelevantContentUnified: index snippet 缺失 → ?? 空串后过滤", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" },
    ])
    hoisted.searchWiki.mockResolvedValue([{ title: "idx", snippet: undefined, path: "/p/wiki/i.md" }])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig(),
    })
    expect(out).toBe("- A: sa") // index 空 snippet 被过滤
  })

  it("searchRelevantContentUnified: options.novelConfig 缺省回退 store", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([])
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2)
    expect(out).toBe("")
  })

  it("searchRelevantContentUnified: entityBoostEnabled + weight null → ?? 0.4", async () => {
    hoisted.novelMixedSearch.mockResolvedValue([
      { type: "memory", path: "/p/wiki/a.md", title: "A", snippet: "sa" },
    ])
    hoisted.searchWiki.mockResolvedValue([])
    hoisted.searchByEmbedding.mockResolvedValue([])
    const out = await searchRelevantContentUnified("/p", "甲", undefined, 2, {
      novelConfig: mkNovelConfig({
        entityBoostEnabled: true,
        entityBoostWeight: null as unknown as number,
      }),
    })
    expect(out).toBe("- A: sa")
  })

  it("searchGraphRelevantContent: 单字符 token 不种候选（token 守卫 false）", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, { id: string; title: string; path: string }>([
        ["a", { id: "a", title: "甲", path: "/p/a.md" }],
      ]),
    })
    hoisted.readFile.mockResolvedValue("")
    const out = await searchGraphRelevantContent("/p", "甲 x", undefined)
    expect(out).toBe("")
  })

  it("searchGraphRelevantContent: ≥2 关联节点读取成功 → sort 比较器执行", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, { id: string; title: string; path: string }>([
        ["n1", { id: "n1", title: "林晚秋", path: "/p/wiki/entities/n1.md" }],
        ["n2", { id: "n2", title: "路人", path: "/p/wiki/entities/n2.md" }],
      ]),
    })
    hoisted.getRelatedNodes.mockReturnValue([
      { node: { id: "r1", title: "关联者甲", path: "/p/r1.md" }, relevance: 0.5 },
      { node: { id: "r2", title: "关联者乙", path: "/p/r2.md" }, relevance: 0.9 },
    ])
    hoisted.readFile.mockResolvedValue("# 关联者内容")
    const out = await searchGraphRelevantContent("/p", "林晚秋 路人", undefined)
    expect(out).toContain("关联者甲")
    expect(out).toContain("关联者乙")
  })

  it("searchGraphRelevantContent: 关联节点读取失败 → null 剔除（if r false）", async () => {
    hoisted.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map<string, { id: string; title: string; path: string }>([
        ["n1", { id: "n1", title: "林晚秋", path: "/p/wiki/entities/n1.md" }],
      ]),
    })
    hoisted.getRelatedNodes.mockReturnValue([
      { node: { id: "r", title: "乙 关联", path: "/p/r.md" }, relevance: 1 },
    ])
    hoisted.readFile.mockRejectedValue(new Error("no file"))
    const out = await searchGraphRelevantContent("/p", "林晚秋 任务", undefined)
    expect(out).toBe("")
  })
})


// ════════════════════════════════════════════════════════════════════════════
// T25 (A-04.4/F-13/F-19): 三源真并行（wiki / canon / 技法）+ canon 事实块注入
// + temporal/character fromCanonGraph 接线。VIEW 契约不动 —— 既有 pack 字段与
// prompt 字节基线全部由上方既有用例守恒，本块只断言 additive 面。
// ════════════════════════════════════════════════════════════════════════════

describe("T25 三源真并行 + canon 事实块注入", () => {
  it("全量装配注入三源计时探针（sourceTimingsMs 三槽位有限非负）+ 技法块文本", async () => {
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(pack.sourceTimingsMs).toBeDefined()
    for (const value of Object.values(pack.sourceTimingsMs!)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    // 源3 技法：T27b 离线编译产物，仅渲染 injectionPoint="chapter_task_brief" 的块
    // （真实编译器离线路径）；protagonist_brief / ending_guard 面不进 ContextPack。
    expect(pack.techniqueBlocks).toContain("【爽点循环与延宕节奏注入】")
    expect(pack.techniqueBlocks).toContain("【章末钩子注入】")
    expect(pack.techniqueBlocks).not.toContain("【主角愿望—动机—行动注入】")
    expect(pack.techniqueBlocks).not.toContain("【终局章三戒守卫】")
  })

  it("canon_migration=dual → 源2 走 T14 读出口：queryCanonEdges 过滤当前章 + fromCanonGraph 视图注入", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    t25.queryCanonEdges.mockResolvedValue([
      {
        id: "c1",
        sourceId: "白砚",
        targetId: "轩辕剑",
        predicate: "OWNS",
        edgeKind: "world_fact",
        validAt: 2,
        invalidAt: 9,
        confidence: 0.8,
        archived: false,
      },
    ])
    hoisted.renderTemporalCanonBlock.mockReturnValue("CANON-BLOCK-MARKER")

    const pack = await buildContextPack("/p", "生成第3章正文", 3, {
      novelConfig: mkNovelConfig({ temporalFactsEnabled: true }),
    })

    // T13/T14 IPC 契约：projectPath 即 projectId；世界时态过滤当前章有效 + 仅未归档。
    // C（include_invalidated）：第二查询召回已失效窗口边（former 标记），共 2 次调用。
    expect(t25.queryCanonEdges).toHaveBeenCalledTimes(2)
    expect(t25.queryCanonEdges).toHaveBeenCalledWith("/p", { valid_at_chapter: 3, archived: false })
    expect(t25.queryCanonEdges).toHaveBeenCalledWith("/p", expect.objectContaining({ include_invalidated: true }))
    // fromCanonGraph 视图转换（真函数）：TemporalFact 窗口语义逐字段对齐。
    expect(pack.temporalFacts).toEqual([
      {
        id: "c1",
        subject: "白砚",
        predicate: "OWNS",
        object: "轩辕剑",
        validFrom: 2,
        validUntil: 9,
        source: "canon-graph:c1",
        confidence: 0.8,
      },
    ])
    // 注入路径与折叠路径同款：renderTemporalCanonBlock → canonRules 合并。
    expect(hoisted.renderTemporalCanonBlock).toHaveBeenCalled()
    expect(pack.canonRules).toContain("CANON-BLOCK-MARKER")
    expect(t25.loadNovelSessionStatus).toHaveBeenCalledWith("/p")
  })

  it("canon_migration=shadow → 同 dual 走 canon 读出口", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "shadow" })
    t25.queryCanonEdges.mockResolvedValue([])
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    // C：第二查询（include_invalidated）同样发出，共 2 次。
    expect(t25.queryCanonEdges).toHaveBeenCalledTimes(2)
    expect(pack.temporalFacts).toEqual([])
  })

  // ── C (方案 X / include_invalidated)：P0 护栏集成回归 ──
  it("C (P0 护栏)：第二查询召回 former → pack.formerFacts 打标 + 独立分块渲染 + 不入 temporalFacts/mustAvoid/canonRules", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    // 按 filter 区分两查询返回：第一查（当前有效）vs 第二查（include_invalidated 召回已失效窗口）。
    t25.queryCanonEdges.mockImplementation((_pp: string, filter: Record<string, unknown>) => {
      if (filter.include_invalidated === true) {
        return Promise.resolve([
          {
            id: "old1",
            sourceId: "白砚",
            targetId: "伪证信物",
            predicate: "OWNS",
            edgeKind: "world_fact",
            validAt: 1,
            invalidAt: 4,
            confidence: 0.7,
            archived: false,
          },
        ])
      }
      return Promise.resolve([
        {
          id: "cur1",
          sourceId: "白砚",
          targetId: "真剑",
          predicate: "OWNS",
          edgeKind: "world_fact",
          validAt: 2,
          confidence: 0.9,
          archived: false,
        },
      ])
    })
    hoisted.renderTemporalCanonBlock.mockReturnValue("CANON-BLOCK-MARKER")

    const pack = await buildContextPack("/p", "生成第6章正文", 6, {
      novelConfig: mkNovelConfig({ temporalFactsEnabled: true }),
    })

    // P0 护栏 1：former 不并入当前有效 temporalFacts（current/former 数学互斥）。
    expect(pack.temporalFacts!.map((f) => f.id)).toEqual(["cur1"])
    // former 流入 pack.formerFacts 并打 former:true 标记（真实被消费）。
    expect(pack.formerFacts).toHaveLength(1)
    expect(pack.formerFacts![0]).toMatchObject({ id: "old1", former: true, object: "伪证信物" })

    // 独立分块渲染（真实消费链闭环）：prompt 含 formerFacts 段标题 + former 边内容。
    const prompt = contextPackToPrompt(pack)
    expect(prompt).toContain("曾成立的事实") // i18n 段标题（zh）
    expect(prompt).toContain("伪证信物") // former 边内容进入独立分块
    // P0 护栏 2：former 内容不入 mustAvoid（禁语义倒置——避免把失效事实当当前真值去“避免违背”）。
    expect(pack.mustAvoid).not.toContain("伪证信物")
    // P0 护栏 3：former 不并入 canonRules 渲染块（renderTemporalCanonBlock 只吃 temporalFacts，不吃 formerFacts）。
    expect(pack.canonRules).toContain("CANON-BLOCK-MARKER")
    expect(pack.canonRules).not.toContain("伪证信物")
  })

  it("C (字节级不变)：无 former 边时 formerFacts=undefined → prompt 不渲染该段", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    t25.queryCanonEdges.mockResolvedValue([]) // 两查询均空
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(pack.formerFacts).toBeUndefined()
    const prompt = contextPackToPrompt(pack)
    expect(prompt).not.toContain("曾成立的事实")
  })

  it("canon_migration=legacy / 缺省 → 默认仍 fold：不触 canon 读出口（向后兼容 A-04.4）", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "legacy" })
    const legacyPack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(t25.queryCanonEdges).not.toHaveBeenCalled()
    expect(legacyPack.temporalFacts).toEqual([])

    t25.loadNovelSessionStatus.mockClear()
    const defaultPack = await buildContextPack("/p2", "生成第3章正文", 3)
    expect(t25.loadNovelSessionStatus).toHaveBeenCalledWith("/p2") // 门照常读取
    expect(t25.queryCanonEdges).not.toHaveBeenCalled()
    expect(defaultPack.temporalFacts).toEqual([])
  })

  it("无章节号（targetChapter≤0）→ 不读迁移门、不加载数据源（原语义）", async () => {
    await buildContextPack("/p", "任务")
    expect(t25.loadNovelSessionStatus).not.toHaveBeenCalled()
    expect(t25.queryCanonEdges).not.toHaveBeenCalled()
  })

  it("canon 读出口失败 → 降级 null + raw canonRules 兜底（不阻断装配）", async () => {
    t25.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    t25.queryCanonEdges.mockRejectedValue(new Error("ipc down"))
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(pack.temporalFacts).toBeNull()
    expect(pack.canonRules).toBe("正史规则")
  })

  it("折叠路径失败 → 同款降级 null + raw canonRules 兜底（原 catch 语义上移保留）", async () => {
    hoisted.listDirectory.mockResolvedValue([
      { name: "001.snapshot.json", path: "/p/.novel/snapshots/001.snapshot.json", is_dir: false },
    ])
    hoisted.getFileModifiedTime.mockResolvedValue(1000)
    hoisted.listSnapshots.mockRejectedValue(new Error("ingest"))
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(pack.temporalFacts).toBeNull()
    expect(pack.canonRules).toBe("正史规则")
    // 计时探针仍在（canon 槽位已计入本次失败耗时）
    expect(pack.sourceTimingsMs!.canon).toBeGreaterThanOrEqual(0)
  })

  it("三源并发启动证明：wiki 被 gate 卡住期间 canon 源已启动（Promise.all 真并行）", async () => {
    const started: string[] = []
    let releaseWiki!: () => void
    const wikiGate = new Promise<void>((resolve) => {
      releaseWiki = resolve
    })
    hoisted.loadAllImpl = async () => {
      started.push("wiki")
      await wikiGate
      return fixtureRawData()
    }
    t25.loadNovelSessionStatus.mockImplementation(async () => {
      started.push("canon")
      return null
    })

    const packPromise = buildContextPack("/p", "生成第3章正文", 3)
    // wiki 仍被 gate 卡住时，canon 源必须已经启动 —— 若 wiki 串行 await 先行，
    // canon 源此刻不可能出现（这正是 T25 要消除的串行装配形态）。
    await vi.waitFor(() => expect(started).toContain("canon"), { timeout: 2000 })
    expect(started).toContain("wiki")

    releaseWiki()
    const pack = await packPromise
    expect(pack.task).toBe("生成第3章正文")
    expect(pack.sourceTimingsMs).toBeDefined()
  })

  it("技法编译失败 → 降级不注入（undefined）且不阻断装配", async () => {
    t25.compileFromCommittedSnapshot.mockImplementation(() => {
      throw new Error("snapshot corrupt")
    })
    const pack = await buildContextPack("/p", "生成第3章正文", 3)
    expect(pack.techniqueBlocks).toBeUndefined()
    expect(pack.task).toBe("生成第3章正文")
    // 其余两源不受影响：wiki 数据照常装配、计时探针三槽位齐全。
    expect(pack.chapterGoal).toBe("细纲：目标")
    expect(pack.sourceTimingsMs!.technique).toBeGreaterThanOrEqual(0)
  })
})
