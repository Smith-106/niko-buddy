/**
 * context-pack-freeze.spec.ts
 *
 * T25b (TASK-P3-25b): ContextPack 冻结不变量。
 *
 * 三条不变量：
 *   1. 同章所有角色调用共享同一 pack（digest 断言）
 *   2. canon 事实集哈希并入 task_brief（hash 随事实集变化）
 *   3. 前缀字节稳定性断言（provider prefix cache 前提）
 *
 * 数据源：T25 buildContextPackUnlocked 三源并行（含 pack.sourceTimingsMs）；
 * canon 源用 fixture/mock 不依赖真实 LanceDB。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest"
import {
  buildContextPack,
  contextPackToPrompt,
  type ContextPack,
} from "./context-engine"
import { buildFallbackTaskBrief } from "./deep-chapter-task-brief"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import type { ChapterLengthSpec } from "./deep-chapter-prompts"
import {
  DEFAULT_NOVEL_CONFIG,
  useWikiStore,
  type LlmConfig,
  type NovelConfig,
  type EmbeddingConfig,
} from "@/stores/wiki-store"

// ── Mock infrastructure ──────────────────────────────────────────────────

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

// T25: canon 三源并行 mock
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
vi.mock("./craft/technique-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./craft/technique-compiler")>()
  return { ...actual, compileFromCommittedSnapshot: t25.compileFromCommittedSnapshot }
})

// Store mock
const defaultParseFrontmatter = hoisted.parseFrontmatter.getMockImplementation()
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    setNovelConfig: hoisted.setNovelConfig,
  }
})

// IO module mocks
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

// ── Test fixtures ─────────────────────────────────────────────────────────

const lengthSpec: ChapterLengthSpec = {
  targetChars: 5000,
  minChars: 4000,
  draftMaxChars: 5500,
  maxOutputTokens: 12000,
}

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
      previousChapterEnding: "主角被困在塔顶",
      characterStates: "林动：状态正常",
      timeline: "第3日",
      foreshadowingSignals: ["匕首伏笔：未回收"],
    },
    fallbackRecentSummaries: [],
    fallbackPreviousEnding: "",
    fallbackCharacterStates: "",
    fallbackTimeline: "",
    fallbackForeshadowingStates: "",
    recentChapterContents: ["## 第2章正文\n内容"],
    outline: "## 大纲\n第一章 起",
    volumeContext: "第一卷",
    chapterOutline: "第3章细纲：目标",
    revisionFeedback: [],
    cognitionText: "林晚秋知道：剑",
    soulDoc: "项目灵魂",
    relatedSettings: "场景：荒原",
    canonRules: "正史规则：不得违背设定",
    writingStyle: "写作风格",
    searchResults: "相关记忆",
    graphSearchResults: "图谱节点",
  }
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
  hoisted.selectRelevantNovelVectorResults.mockReset().mockImplementation(
    (results: unknown[], limit: number) => results.slice(0, limit),
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
}

beforeEach(() => {
  resetHoistedDefaults()
})

// ── Helpers ───────────────────────────────────────────────────────────────

/** 剥离 sourceTimingsMs 遥测字段，使 digest 比较仅覆盖语义内容。 */
function stripSourceTimingsMs(pack: ContextPack): Omit<ContextPack, "sourceTimingsMs"> {
  const { sourceTimingsMs: _unused, ...rest } = pack as ContextPack &
    { sourceTimingsMs?: Record<string, number> }
  return rest
}

// ════════════════════════════════════════════════════════════════════════════
// 不变量 1: 同章所有角色调用共享同一 pack（digest 断言）
// ════════════════════════════════════════════════════════════════════════════
describe("Invariant 1: 同章共享 pack (digest 断言)", () => {
  it("两回同输入 buildContextPack 产出同 digest", async () => {
    const pack1 = await buildContextPack("/test/project", "生成第3章正文", 3)
    const pack2 = await buildContextPack("/test/project", "生成第3章正文", 3)

    // 仅比较语义内容，排除 sourceTimingsMs（遥测计时点随 execution 差异）
    const digest1 = await computeCheckpointDigestOf(stripSourceTimingsMs(pack1))
    const digest2 = await computeCheckpointDigestOf(stripSourceTimingsMs(pack2))
    expect(digest1).toBe(digest2)
  })

  it("不同 chapterNumber 产出不同 digest", async () => {
    const pack3 = await buildContextPack("/test/project", "生成第3章正文", 3)
    const pack5 = await buildContextPack("/test/project", "生成第5章正文", 5)

    const digest3 = await computeCheckpointDigestOf(stripSourceTimingsMs(pack3))
    const digest5 = await computeCheckpointDigestOf(stripSourceTimingsMs(pack5))
    expect(digest3).not.toBe(digest5)
  })

  it("空白 projectPath 仍产出确定的 digest（空 pack 退化）", async () => {
    const pack = await buildContextPack("", "生成第3章正文", 3)
    const digest = await computeCheckpointDigestOf(stripSourceTimingsMs(pack))
    expect(typeof digest).toBe("string")
    expect(digest.length).toBe(64)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 不变量 2: canon 事实集哈希并入 task_brief
// ════════════════════════════════════════════════════════════════════════════
describe("Invariant 2: canon 事实集哈希并入 task_brief", () => {
  const basePackForBrief: ContextPack = {
    task: "生成第3章正文",
    chapterGoal: "目标：推进冲突",
    outline: "大纲",
    recentChapterContents: [],
    recentSummaries: [],
    previousChapterEnding: "主角被困在塔顶",
    characterStates: "林动：状态正常",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "匕首伏笔：埋设于第1章",
    timeline: "时间线：第3日",
    relatedSettings: "场景：荒原",
    canonRules: "正史规则：林晚秋持有轩辕剑",
    writingStyle: "",
    voiceStyleGuide: undefined,
    searchResults: "",
    graphSearchResults: "",
    mustDo: "必须完成：冲突升级",
    mustAvoid: "禁止违背：正史规则",
    nextChapterAdvice: "结尾留下下一章钩子",
    revisionDirectives: "",
    communitySummaries: undefined,
    relatedChapters: undefined,
    references: undefined,
    techniqueBlocks: undefined,
    contextUsage: undefined,
    styleExemplars: [],
    activeEntities: [],
    temporalFacts: null,
    gaps: [],
  } as unknown as ContextPack

  it("传入 canonHash 时 task_brief 包含该哈希", async () => {
    const canonFacts = "林晚秋持有轩辕剑"
    const canonHash = await computeCheckpointDigestOf(canonFacts)
    const brief = buildFallbackTaskBrief(basePackForBrief, "写第3章高潮戏", 3, lengthSpec, canonHash)
    expect(brief).toContain("正史指纹")
    expect(brief).toContain(canonHash)
  })

  it("不传 canonHash 时 task_brief 不含正史指纹行", async () => {
    const brief = buildFallbackTaskBrief(basePackForBrief, "写第3章高潮戏", 3, lengthSpec)
    expect(brief).not.toContain("正史指纹")
  })

  it("canon 事实集变化时哈希不同", async () => {
    const canonFactsA = "林晚秋持有轩辕剑"
    const canonFactsB = "林晚秋持有赤霄剑"

    const hashA = await computeCheckpointDigestOf(canonFactsA)
    const hashB = await computeCheckpointDigestOf(canonFactsB)

    expect(hashA).not.toBe(hashB)

    const briefA = buildFallbackTaskBrief(basePackForBrief, "写第3章", 3, lengthSpec, hashA)
    const briefB = buildFallbackTaskBrief(basePackForBrief, "写第3章", 3, lengthSpec, hashB)

    expect(briefA).toContain(hashA)
    expect(briefB).toContain(hashB)
    expect(briefA).not.toBe(briefB)
  })

  it("通过 buildContextPack 集成的 canonRules 算出哈希并验证 task_brief 含正史指纹", async () => {
    hoisted.defaultRawData = {
      ...fixtureRawData(),
      canonRules: "正史规则：林晚秋持有轩辕剑",
    }

    const pack = await buildContextPack("/test/project", "生成第3章正文", 3)
    const canonHash = await computeCheckpointDigestOf(pack.canonRules)
    const brief = buildFallbackTaskBrief(pack, "写第3章", 3, lengthSpec, canonHash)
    expect(brief).toContain("正史指纹")
    expect(brief).toContain(canonHash)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 不变量 3: 前缀字节稳定性断言（provider prefix cache 前提）
// ════════════════════════════════════════════════════════════════════════════
describe("Invariant 3: 前缀字节稳定性断言", () => {
  it("同输入两次 build + contextPackToPrompt 前 100 字节完全一致", async () => {
    const pack1 = await buildContextPack("/test/project", "生成第3章正文", 3)
    const pack2 = await buildContextPack("/test/project", "生成第3章正文", 3)

    const prompt1 = contextPackToPrompt(pack1)
    const prompt2 = contextPackToPrompt(pack2)

    expect(prompt1.slice(0, 100)).toBe(prompt2.slice(0, 100))
  })

  it("同输入三次 build 前 200 字节全一致", async () => {
    const pack1 = await buildContextPack("/test/project", "生成第3章正文", 3)
    const pack2 = await buildContextPack("/test/project", "生成第3章正文", 3)
    const pack3 = await buildContextPack("/test/project", "生成第3章正文", 3)

    const p1 = contextPackToPrompt(pack1)
    const p2 = contextPackToPrompt(pack2)
    const p3 = contextPackToPrompt(pack3)

    expect(p1.slice(0, 200)).toBe(p2.slice(0, 200))
    expect(p2.slice(0, 200)).toBe(p3.slice(0, 200))
  })

  it("不同 task 前缀不同（prompt 首行含 task 文本）", async () => {
    const packA = await buildContextPack("/test/project", "生成第3章正文——高潮对决", 3)
    const packB = await buildContextPack("/test/project", "生成第5章正文——余波平息", 5)

    const promptA = contextPackToPrompt(packA)
    const promptB = contextPackToPrompt(packB)

    // task 不同时 prompt 首行不同，前缀必然不同
    expect(promptA.slice(0, 30)).not.toBe(promptB.slice(0, 30))
  })
})