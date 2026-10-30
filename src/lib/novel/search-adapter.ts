import { searchWiki } from "@/lib/search"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { rerankCandidates } from "@/lib/rerank"
import { type EmbeddingConfig } from "@/stores/wiki-store"
import { loadSnapshot, listSnapshots } from "./chapter-ingest"
import { rankByBm25, tokenizeForBm25 } from "./bm25-ranking"
import { computeQueryHash, createRetrievalTrace } from "./retrieval-trace"
import type { RetrievalSpanSink } from "./retrieval-span"
import { applyShardRecall, type ShardRecallSpec } from "./shard-routing"
import {
  RETRIEVAL_BUDGET_PATHS,
  getRetrievalBudgetLedger,
} from "./retrieval-budget"
import {
  SOURCE_RRF_K_DEFAULT,
  SEARCH_SOURCE_TIMEOUT_MS,
  deduplicateResults,
  normalizeResultPath,
  rankSourceResults,
  withTimeout,
} from "./retrieval-source-pipeline"
// P1-IMP-14: 向量检索孪生（本文件 runVectorSearch / context-engine runVectorSearchForContext）
// 公共核心抽到独立模块 —— 不挂本文件导出面，避免 context-engine.spec / 
// context-pack-freeze.spec 的 vi.mock("./search-adapter") 整体替换后拿到 undefined。
import { runVectorSearchShared } from "./vector-search-core"
// ISS-20260709-039 去孪生：图检索孪生体（matched 单遍 + related 并行）唯一定义点。
import { collectGraphScoredSnippets } from "./graph-search-shared"
// M11-3 切片：检索策略纯函数叶已迁至 ./search-strategy（KB 路由 + 权威谓词 +
// 效用重排 + 多查询融合）。本文件保留编排层（novelMixedSearch / retrieveDualTrack）。
// 对外符号经下述 re-export 原位保留（M 系列纪律：调用方 import 面零改）。
import {
  assertNoTechLeak,
  filterAuthoritative,
  kbRoutingView,
  routeByQueryIntent,
  tokensForKbMatch,
  applySearchRecipe,
  SEARCH_RECIPES,
} from "./search-strategy"
import type { KbGap } from "./search-strategy"
export {
  assertNoTechLeak,
  filterAuthoritative,
  fuseAcrossQueries,
  generateMultiQueries,
  isAuthoritativeGenerationPath,
  isHistoricalProjectionSnippet,
  kbRoutingView,
  loadKbCollectionCounts,
  loadKbRoutingMatrix,
  loadKbRoutingViewBuiltFrom,
  reorderByUsefulness,
  routeByQueryIntent,
  tokensForKbMatch,
  applySearchRecipe,
  SEARCH_RECIPES,
  SEARCH_RECIPE_IDS,
  isSearchRecipeId,
  charShingleJaccard,
  getCharShingles,
  mmrRerank,
  nodeDistanceRerank,
} from "./search-strategy"
export type {
  KbGap,
  KbRoutingMatrix,
  MultiQueryOptions,
  UsefulnessCandidate,
  UsefulnessContext,
  SearchRecipeId,
  SearchRecipeConfig,
  MmrOptions,
  NodeDistanceOptions,
  ApplyRecipeOptions,
} from "./search-strategy"

export interface NovelSearchParams {
  projectPath: string
  query: string
  chapterNumber?: number
  topK?: number
  authoritativeOnly?: boolean
  includeGraph?: boolean
  includeVector?: boolean
  includeKeyword?: boolean
  includeRecentChapters?: boolean
  includeCanon?: boolean
  /** ISS-20260709-023 (DC-7) 渐进式 DI: 缺省回退 useWikiStore。 */
  embCfg?: EmbeddingConfig
  /** C3: RRF fusion constant (default 60), overridable per call — kept a param
   *  (rather than a global) so callers can tune fusion sharpness per query. */
  rrfK?: number
  /** 64 号实施接线: 启用检索留痕（retrieval-trace 消费，flag 默认关——
   *  不传则不产生任何 trace IO）。traceChannel 为通道名（如 hybrid/multi-query）。 */
  traceChannel?: string
  /** 64 号实施接线: trace 关联章节号（缺省 0 = 非章节上下文）。 */
  traceChapter?: number
  /** 波1 检索可解释包 additive: 检索时模型 id（路由证据，EB-1）。 */
  traceModelId?: string
  /** R0-c 运行时 span 面（additive 观测）：不传则完全不产生 span，检索语义/排序零改动。 */
  spans?: RetrievalSpanSink
  /** B3-a 分片召回（可选；不传 = 不启用，路径与现状字节等价）：
   *  分片键（none/type/collection）+ 片内上限（perShardTopK）+ 归并策略（shard-major/score-major）。
   *  片内排序仅在给出 perShardTopK 时发生；RRF 融合、权威过滤次序与 span 契约序均不变。 */
  shards?: ShardRecallSpec
  /** ISS-20260802-004: 检索编排配方 (default/diverse/local/balanced)。缺省为 "default"。 */
  recipe?: import("./search-strategy").SearchRecipeId
  /** ISS-20260802-004: 空间距离重排锚点实体名称/路径列表。 */
  anchors?: readonly string[]
  /** ISS-20260802-004: 原始任务/剧情描述字符串（用于图谱节点提取与锚点对齐）。 */
  task?: string
  /** ISS-20260802-004: 检索图谱（测试注入或按需加载）。 */
  graph?: unknown
}

export interface NovelSearchResult {
  type: "keyword" | "vector" | "graph" | "recent_chapter" | "canon"
  path: string
  title: string
  snippet: string
  relevance: number
}

type RankedNovelSearchResult = NovelSearchResult & {
  sourceRank: number
}


// M11-3: isAuthoritativeGenerationPath / isHistoricalProjectionSnippet 已迁至
// ./search-strategy（上已 re-export，符号名/签名不变）。

export async function novelMixedSearch(params: NovelSearchParams): Promise<NovelSearchResult[]> {
  const pp = normalizePath(params.projectPath)
  const topK = params.topK ?? 5
  const results: RankedNovelSearchResult[] = []

  // R0-c：链头 span（分词）——复用 BM25 同一分词器（tokenizeForBm25），观测不改变分词。
  params.spans?.span("tokenize", { tokens: tokenizeForBm25(params.query).length })

  const promises: Promise<void>[] = []

  if (params.includeKeyword !== false) {
    const pKeyword = runSearchBranch("keyword", searchWiki(pp, params.query)).then(items => {
      // 54 号设计 ①: BM25 排序增强 (inkos/mem0 吸收)——只改顺序不改召回集,
      // RRF 融合输入不变形; 零分文档保持原序 (rankByBm25 稳定排序)。
      const bm25Order = rankByBm25(
        params.query,
        items.map((item) => ({ id: item.path, text: `${item.title ?? ""} ${item.snippet ?? ""}` })),
      )
      const byPath = new Map(items.map((item) => [item.path, item]))
      const ordered = bm25Order
        .map((r) => byPath.get(r.id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
      results.push(...ordered.slice(0, topK).map((item, sourceRank) => ({
        type: "keyword" as const,
        path: item.path,
        title: item.title,
        snippet: item.snippet ?? "",
        relevance: item.score ?? 0,
        sourceRank,
      })))
    })
    promises.push(pKeyword)
  }

  if (params.includeVector) {
    const pVector = runSearchBranch("vector", runVectorSearch(pp, params.query, topK, params.embCfg)).then(items => {
      if (items.length === 0) {
        // 54 号设计 ①: 向量失败→BM25 降级——keyword 分支未启用时补跑
        // searchWiki+BM25 作为 lexical 兜底 (标记 keyword, 不新增 type)。
        if (params.includeKeyword === false) {
          return runSearchBranch("keyword", searchWiki(pp, params.query)).then((kwItems) => {
            const bm25Order = rankByBm25(
              params.query,
              kwItems.map((item) => ({ id: item.path, text: `${item.title ?? ""} ${item.snippet ?? ""}` })),
            )
            const byPath = new Map(kwItems.map((item) => [item.path, item]))
            const ordered = bm25Order
              .map((r) => byPath.get(r.id))
              .filter((item): item is NonNullable<typeof item> => item !== undefined)
            results.push(...ordered.slice(0, topK).map((item, sourceRank) => ({
              type: "keyword" as const,
              path: item.path,
              title: item.title,
              snippet: item.snippet ?? "",
              relevance: item.score ?? 0,
              sourceRank,
            })))
          })
        }
        return
      }
      results.push(...rankSourceResults(items))
    })
    promises.push(pVector)
  }

  if (params.includeGraph) {
    const pGraph = runSearchBranch("graph", runGraphSearch(pp, params.query, topK)).then(items => {
      results.push(...rankSourceResults(items))
    })
    promises.push(pGraph)
  }

  if (params.includeRecentChapters) {
    const pRecent = runSearchBranch("recent_chapter", runRecentChapterSearch(pp, topK)).then(items => {
      results.push(...rankSourceResults(items))
    })
    promises.push(pRecent)
  }

  if (params.includeCanon) {
    const pCanon = runSearchBranch("canon", runCanonSearch(pp, params.query)).then(items => {
      results.push(...rankSourceResults(items))
    })
    promises.push(pCanon)
  }

  await Promise.all(promises)

  // B3-a 分片召回（可选）：resolve → 片内上限 → 跨片确定性归并。
  // 不传 `shards` 时完全不走此路径（严格字节等价现状）；片内排序仅在有 perShardTopK 时发生。
  const shardReport = params.shards ? applyShardRecall(results, params.shards) : null
  const recalled: RankedNovelSearchResult[] = shardReport ? shardReport.items : results

  // R0-c：五源 span（各源召回计数；RRF 前快照）——启用分片时附标量分片观测字段。
  if (params.spans) {
    const byType: Record<string, number> = {}
    for (const item of recalled) byType[item.type] = (byType[item.type] ?? 0) + 1
    params.spans.span("sources", {
      total: recalled.length,
      ...byType,
      ...(shardReport
        ? {
            shardKey: shardReport.key,
            shardCount: shardReport.shardCount,
            shardPolicy: shardReport.policy,
            shardPerTopK: shardReport.perShardTopK ?? 0,
            shardKept: shardReport.outputCount,
            shardInput: shardReport.inputCount,
          }
        : {}),
    })
  }

  const merged = deduplicateResults(recalled, params.rrfK ?? SOURCE_RRF_K_DEFAULT)
  // R0-c：RRF span（融合前后计数；K 常量与实现同源）。
  params.spans?.span("rrf", {
    raw: results.length,
    merged: merged.length,
    rrfK: params.rrfK ?? SOURCE_RRF_K_DEFAULT,
  })
  const filtered = params.authoritativeOnly ? filterAuthoritative(merged) : merged
  // R0-c：分档 span（≤3 / 4-20 / >20 三档；与 golden F5 rank 分档同口径）。
  params.spans?.span("tiering", {
    filtered: filtered.length,
    tier1: Math.min(3, filtered.length),
    tier2: Math.max(0, Math.min(20, filtered.length) - 3),
    tier3: Math.max(0, filtered.length - 20),
  })
  let truncated: NovelSearchResult[]
  const recipe = params.recipe ?? "default"
  if (recipe === "default" || !Object.prototype.hasOwnProperty.call(SEARCH_RECIPES, recipe)) {
    truncated = filtered.slice(0, topK)
  } else {
    let graph: unknown = params.graph
    let graphBuildFailed = false
    const hasAnchorsOrTask =
      (params.anchors && params.anchors.length > 0) ||
      (typeof params.task === "string" && params.task.trim().length > 0)

    if (
      !graph &&
      (recipe === "local" || recipe === "balanced") &&
      hasAnchorsOrTask
    ) {
      try {
        const { buildRetrievalGraph } = await import("@/lib/graph-relevance")
        graph = await buildRetrievalGraph(pp)
      } catch (err) {
        logger.warn(
          "Novel Search",
          "[novelMixedSearch] Failed to build retrieval graph for recipe, falling back to default slice",
          { error: toErrorMessage(err) },
        )
        graphBuildFailed = true
      }
    }

    if (graphBuildFailed) {
      // RV-002: on graph-build failure, degrade whole recipe to default slice
      truncated = filtered.slice(0, topK)
    } else {
      try {
        truncated = applySearchRecipe(filtered, {
          recipe,
          topK,
          anchors: params.anchors,
          task: params.task,
          graph,
        })
      } catch (err) {
        logger.warn(
          "Novel Search",
          "[novelMixedSearch] Recipe execution failed, falling back to default slice",
          { error: toErrorMessage(err) },
        )
        truncated = filtered.slice(0, topK)
      }
    }
  }

  // R0-c：rerank 触发-or-跳过 span（候选≤1 时下游 rerankCandidates 即短路跳过）。
  params.spans?.span("rerank_trigger", {
    candidates: truncated.length,
    decision: truncated.length > 1 ? "rerank" : "skip",
  })

  const reranked = await rerankCandidates(
    params.query,
    truncated.map((item) => ({
      ...item,
      id: `${item.type}:${normalizeResultPath(item.path)}`,
      source: item.type,
    })),
    {
      topK,
      purpose: "用于小说剧情搜索，优先返回最能支撑当前剧情推进、设定一致性和记忆调用的结果。",
    },
  )

  // R0-c：封顶降级 span（分档集 → topK 窗口的截断计数；降级绝不静默）。
  params.spans?.span("cap_degrade", {
    before: filtered.length,
    after: truncated.length,
    dropped: Math.max(0, filtered.length - truncated.length),
  })

  // 64 号实施接线（retrieval-trace 消费）：仅当调用方显式传 traceChannel
  // 时留痕（flag 默认关，检索行为不变）。append 失败静默（ADR-45：检索
  // 不得写崩 canon——trace 只是观测层）。
  if (params.traceChannel) {
    const trace = createRetrievalTrace({
      traceId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chapter: params.traceChapter ?? 0,
      query: params.query,
      channel: params.traceChannel,
      latencyMs: 0,
      queryHash: computeQueryHash(params.query),
      modelId: params.traceModelId,
      corpusFilter: { authoritativeOnly: params.authoritativeOnly === true },
      hits: reranked.slice(0, topK).map((r) => ({
        sourceId: normalizeResultPath(r.path),
        sourceType: "material" as const,
        score: typeof r.relevance === "number" ? r.relevance : 0,
      })),
    })
    void appendRetrievalTraceQuietly(pp, trace)
  }

  // P1-IMP-13 (A1a / P1-N2 缺口修复): assertNoTechLeak 常驻调用 — 主检索出口
  // 兜底断言（tech/blocked 元数据若经任何分支漏入结果即 fail-loud；当前
  // NovelSearchResult 无 collection/trust 字段 → 结构性 no-op 安全网）。
  assertNoTechLeak(reranked)

  return reranked
}

/**
 * 64 号实施接线: 追加检索 trace 到 .niko-buddy/retrieval-traces.jsonl（每行一条）。
 * 静默失败（观测层不得影响主检索路径）。
 */
async function appendRetrievalTraceQuietly(
  projectPath: string,
  trace: import("./retrieval-trace").RetrievalTraceEntry,
): Promise<void> {
  try {
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    const filePath = `${projectPath}/.niko-buddy/retrieval-traces.jsonl`
    let existing = ""
    try {
      existing = await readFile(filePath)
    } catch {
      existing = ""
    }
    const line = JSON.stringify(trace)
    await writeFileAtomic(filePath, existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`)
  } catch {
    // 观测层失败静默
  }
}

async function runSearchBranch<T>(label: string, promise: Promise<T>): Promise<T> {
  // R0-d：延迟-成本预算账本接线（观测层，回退语义与迁移前逐字一致）。
  const startedAt = Date.now()
  const ledger = getRetrievalBudgetLedger()
  // 回退策略为路径级常量（返回空结果集，不携带调用级数据）——幂等登记。
  ledger.ensureRollback(RETRIEVAL_BUDGET_PATHS.searchBranch, () => [] as unknown[])
  try {
    return await withTimeout(promise, SEARCH_SOURCE_TIMEOUT_MS, label)
  } catch (err) {
    logger.error("Novel Search", `${label} error`, { error: toErrorMessage(err) })
    ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, Date.now() - startedAt)
    return ledger.rollback<undefined, T>(RETRIEVAL_BUDGET_PATHS.searchBranch, undefined)
  }
}



/**
 * P1-IMP-14: 薄包装（签名零变化）—— 通道 B 向量分支，无相关性门控 + 逐条守卫。
 * 调用点 novelMixedSearch 一字未动；导出仅供 vector-search-parity.spec 与
 * context-engine 孪生对拍（生产调用方无需改用）。
 */
export async function runVectorSearch(
  pp: string,
  query: string,
  topK: number,
  embCfg?: EmbeddingConfig,
): Promise<NovelSearchResult[]> {
  const hits = await runVectorSearchShared({ pp, query, limit: topK, embCfg, perItemGuard: true })
  return hits.map((hit) => ({
    type: "vector" as const,
    path: hit.path,
    title: hit.title,
    snippet: hit.snippet,
    relevance: hit.vr.score,
  }))
}

async function runGraphSearch(
  pp: string,
  query: string,
  topK: number,
): Promise<NovelSearchResult[]> {
  try {
    const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
    const graph = await buildRetrievalGraph(pp)
    if (graph.nodes.size === 0) return []

    const tokens = query
      .split(/[\s,，。！？、]+/)
      .filter(t => t.length >= 2)

    const candidateNames = new Set(tokens)
    for (const [, node] of graph.nodes) {
      const nodeText = `${node.title} ${node.id}`.toLowerCase()
      for (const token of tokens) {
        if (nodeText.includes(token.toLowerCase())) {
          candidateNames.add(node.title)
          candidateNames.add(node.id)
        }
      }
    }

    // ISS-20260709-039 去孪生：候选扩展保留本通道口径（split 小写包含；检索侧为
    // tokenizeQuery + CORR-110 守卫——通道语义不同，刻意不收敛，见 graph-search-shared）。
    // matched 单遍扫描 + related 并行片段已收敛到共享核心（行为等价）。
    const scoredNodes = await collectGraphScoredSnippets(
      graph,
      Array.from(candidateNames),
      { getRelatedNodes, readFile },
    )
    return scoredNodes.slice(0, topK).map(n => ({
      type: "graph" as const,
      path: n.path,
      title: n.title,
      snippet: n.snippet,
      relevance: n.relevance,
    }))
  } catch {
    return []
  }
}

async function runRecentChapterSearch(
  pp: string,
  topK: number,
): Promise<NovelSearchResult[]> {
  try {
    const chapterNumbers = await listSnapshots(pp)
    if (chapterNumbers.length === 0) return []

    const recentNumbers = chapterNumbers.slice(-topK).reverse()
    const items: NovelSearchResult[] = []

    for (const num of recentNumbers) {
      const snap = await loadSnapshot(pp, num)
      if (snap) {
        const paddedNum = String(num).padStart(3, "0")
        items.push({
          type: "recent_chapter",
          path: `${pp}/.novel/snapshots/${paddedNum}.snapshot.json`,
          title: `第${num}章`,
          snippet: snap.summary || snap.endingHook || "",
          relevance: 1,
        })
      }
    }
    return items
  } catch {
    return []
  }
}

async function runCanonSearch(
  pp: string,
  query: string,
): Promise<NovelSearchResult[]> {
  const canonPath = `${pp}/wiki/canon.md`
  try {
    const content = await readFile(canonPath)
    if (!content.trim()) return []

    const queryLower = query.toLowerCase()
    const lines = content.split("\n")
    const matchedLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        const start = Math.max(0, i - 1)
        const end = Math.min(lines.length, i + 2)
        matchedLines.push(lines.slice(start, end).join("\n"))
      }
    }

    if (matchedLines.length === 0) {
      return [{
        type: "canon",
        path: canonPath,
        title: "正史规则",
        snippet: content.slice(0, 500).replace(/\n/g, " "),
        relevance: 0.5,
      }]
    }

    return matchedLines.slice(0, 3).map((snippet, i) => ({
      type: "canon" as const,
      path: canonPath,
      title: "正史规则",
      snippet: snippet.replace(/\n/g, " ").slice(0, 300),
      relevance: 1 - i * 0.1,
    }))
  } catch {
    return []
  }
}

// M11-3: filterAuthoritative 已迁至 ./search-strategy（上已回引，行为不变）。

export interface SearchPlotOptions {
  scene?: string
  topK?: number
  includeKeyword?: boolean
  includeVector?: boolean
  includeGraph?: boolean
  includeRecentChapters?: boolean
  includeCanon?: boolean
}

export async function searchPlot(
  projectPath: string,
  query: string,
  options?: SearchPlotOptions,
): Promise<NovelSearchResult[]> {
  return novelMixedSearch({
    projectPath,
    query,
    topK: options?.topK ?? 10,
    includeKeyword: options?.includeKeyword ?? true,
    includeVector: options?.includeVector ?? true,
    includeGraph: options?.includeGraph ?? true,
    includeRecentChapters: options?.includeRecentChapters ?? true,
    includeCanon: options?.includeCanon ?? false,
  })
}

// ============================================================================
// E-02 (run-execute-1, 双库架构蓝图 EPIC-02): 检索双轨不对称 — 硬注入物理隔离
// ============================================================================

// M11-3: kbRoutingView 定义（含 P1-IMP-08 消费面注释）已迁至 ./search-strategy，
// 上已 re-export；`import { z }` 随 KB schema 同迁。以下三行留守（retrieveDualTrack 在用）。
import { getFactsKnownBy, type CanonFact } from "./canon-graph-client"
import { visibleInfoFor } from "./process-library"
import { trustKeyOfPath, type TrustGrade } from "./trust-grader"

// M11-3: KB 路由消费（KB schema / loadKb* / KbGap / routeByQueryIntent /
// assertNoTechLeak）已迁至 ./search-strategy（上已回引 + re-export，行为不变）。

/**
 * E-02 (C-1): 硬注入条目 — 与 NovelSearchResult 类型隔离 (无 relevance 排名字段,
 * 不产 NovelSearchResult, 物理隔离由类型系统背书)。
 */
export interface HardInjectItem {
  /** canon | process_library */
  source: "canon" | "process_library"
  /** 实体标识 (ref, 供追溯/去重)。 */
  ref: string
  /** 注入文本 (POV 过滤后, 恒真信息)。 */
  text: string
  /** 来源事实 id (canon) 或投影段名 (process_library)。 */
  origin: string
}

/**
 * E-02 (C-1): 双轨检索编排 — 通道 A 硬注入 (RRF 前物理隔离) + 通道 B 语义检索。
 * novelMixedSearch 既有 RRF 代码路径一字不动 (includeCanon:false 走通道 B)。
 * 输出 { hardInject, ranked, gaps, usage } — hy3 RetrievalRouter 形状。
 */
export interface DualTrackParams {
  projectPath: string
  query: string
  chapterNumber?: number
  /** 主 POV 角色 (缺省 undefined → 不注入过程库投影, canon 仍按无 POV 过滤)。 */
  povCharacter?: string
  /** 意图 (draft/plan/revise/style/lookup) — 前置路由门。 */
  intent?: string
  topK?: number
  /** 硬注入预算 cap (chars, 缺省 computeContextBudget 口径)。 */
  hardInjectCapChars?: number
  /** E-06 (C-2): trust 过滤开关 (默认 false → 字节级回退现状)。 */
  trustFilterEnabled?: boolean
  /** E-06 (C-2): path → trust 档位映射 (消费方提供; blocked 条目被剔除)。 */
  trustGrades?: Record<string, TrustGrade>
}

export interface DualTrackResult {
  hardInject: HardInjectItem[]
  ranked: NovelSearchResult[]
  gaps: KbGap[]
  /** P1-IMP-17: KB-VIEW 条目关键词/域匹配零 LLM 检索结果（通道 B 双源）。 */
  kbReferences?: KbReferenceEntry[]
  usage: { hardInjectChars: number; capChars: number; ratio: number; truncatedCount: number }
}

/** P1-IMP-17: KB-VIEW 外部链条目（通道 B 双源之关键词/域匹配零 LLM 源）。 */
export interface KbReferenceEntry {
  collection: string
  name: string
  title: string
  summary?: string
  path: string
  trust: string
  query_intent: string[]
}

// M11-3: tokensForKbMatch 已迁至 ./search-strategy（上已回引，行为不变）。

/**
 * E-02 (C-1/C-4): 双轨装配 — 通道 A 硬注入 (canon 恒真事实 + 过程库 POV 投影,
 * 预算 cap 条目级裁剪, 超限记 truncatedCount 不静默); 通道 B novelMixedSearch
 * (includeCanon:false, 既有 RRF 主体零改动)。硬注入项从不 push 进 RRF results。
 */
export async function retrieveDualTrack(params: DualTrackParams): Promise<DualTrackResult> {
  const capChars = params.hardInjectCapChars ?? 3072
  const hardInject: HardInjectItem[] = []
  let hardInjectChars = 0
  let truncatedCount = 0

  // P1-IMP-17: 前置路由门 — 意图驱动 collection allowlist（routeByQueryIntent）。
  // 空收藏 gap 进 gaps（首版透明化不过滤检索主体）；routed.gaps 镜像进最终 gaps。
  const gaps: KbGap[] = []
  if (params.intent) {
    const routed = routeByQueryIntent(params.intent)
    gaps.push(...routed.gaps)
  }

  // 通道 A: 硬注入 (RRF 前物理隔离)
  const canonFacts: CanonFact[] = params.povCharacter
    ? await getFactsKnownBy(params.projectPath, params.povCharacter, params.chapterNumber).catch(() => [])
    : []
  for (const fact of canonFacts) {
    // CanonFact 无 subject/object 字段（sourceId/targetId 为实体 id，predicate 为关系）
    const text = `${fact.sourceId} ${fact.predicate} ${fact.targetId}`
    const item: HardInjectItem = {
      source: "canon",
      ref: `canon:${fact.id ?? fact.sourceId}:${fact.predicate}`,
      text,
      origin: fact.id ?? "canon-fact",
    }
    if (hardInjectChars + text.length > capChars) {
      truncatedCount += 1
      continue
    }
    hardInject.push(item)
    hardInjectChars += text.length
  }
  if (params.povCharacter && params.chapterNumber) {
    const povText = await visibleInfoFor(params.projectPath, params.povCharacter, params.chapterNumber).catch(() => "")
    if (povText) {
      if (hardInjectChars + povText.length > capChars) {
        truncatedCount += 1
      } else {
        hardInject.push({
          source: "process_library",
          ref: `process_library:${params.povCharacter}:${params.chapterNumber}`,
          text: povText,
          origin: "visibleInfoFor",
        })
        hardInjectChars += povText.length
      }
    }
  }

  // 通道 B: 语义检索 (canon 不参与排名 — includeCanon:false)
  const ranked = await novelMixedSearch({
    projectPath: params.projectPath,
    query: params.query,
    chapterNumber: params.chapterNumber,
    topK: params.topK ?? 8,
    includeCanon: false,
  })

  // P1-IMP-13 (A1a / P1-N2 缺口修复): assertNoTechLeak 常驻调用 — 硬注入条目
  // source 面断言（canon / process_library 恒非 tech；未来新增来源即被拦截）。
  assertNoTechLeak(hardInject.map((item) => ({ collection: item.source })))

  // E-06 (C-2): trust 后置过滤 (GOV-TRUST-05: blocked 条目不进检索视图)。
  // flag 门控 (trustFilterEnabled 默认 false → 字节级回退); 过滤掉的条目进 gaps
  // (IC-02 绝不静默: type=filtered, ref=trust_blocked)。
  // P1-IMP-06: 过滤改归一键查找（直连 r.path 必 miss → normalize 后按 collection/name 与 name 双查找）。
  const trustLookup = (path: string): TrustGrade | undefined => {
    if (!params.trustGrades) return undefined
    const k = trustKeyOfPath(path)
    if (params.trustGrades[k] !== undefined) return params.trustGrades[k]
    const base = k.split("/").pop() ?? k
    return params.trustGrades[base]
  }
  let filteredRanked = ranked
  if (params.trustFilterEnabled && params.trustGrades) {
    const blockedCount = ranked.filter((r) => trustLookup(r.path) === "blocked").length
    filteredRanked = ranked.filter((r) => trustLookup(r.path) !== "blocked")
    if (blockedCount > 0) {
      gaps.push({
        collection: "trust",
        impactedIntents: [params.intent ?? "lookup"],
        message: `trust_blocked: ${blockedCount} 条 blocked 条目被过滤（GOV-TRUST-05）`,
      })
    }
  } else if (params.trustFilterEnabled && !params.trustGrades) {
    // P1-IMP-02: trust 过滤开启但无 grades → 显式报缺（IC-02 绝不静默，GOV-TRUST-05 空转暴露）
    gaps.push({
      collection: "trust",
      impactedIntents: [params.intent ?? "lookup"],
      message: "trust_grades_missing: trustFilterEnabled=true 但 trustGrades 缺失，过滤空转（GOV-TRUST-05）",
    })
  }

  // P1-IMP-13 (A1a / P1-N2 缺口修复): assertNoTechLeak 常驻调用 — 双轨检索出口
  // 兜底断言（trust 过滤后仍拦截 tech/blocked 泄漏；当前结果无 collection/trust
  // 字段 → 结构性 no-op 安全网）。
  assertNoTechLeak(filteredRanked)

  // P1-IMP-17: 通道 B 双源 — KB-VIEW 条目关键词/域匹配零 LLM 检索。
  // 对 routed.collections 允许的 KB-VIEW 非 tech 条目做 query 关键词命中。
  // 零命中 → kbReferences=[] 字节级不变；独立预算不复用 hardInject（LightRAG 分通道）。
  const kbReferences: KbReferenceEntry[] = []
  if (params.intent) {
    const routed = routeByQueryIntent(params.intent)
    const referenceBudget = 2048
    let refChars = 0
    const cols = (kbRoutingView as { collections?: Record<string, Array<Record<string, unknown>>> }).collections ?? {}
    for (const collection of routed.collections) {
      if (collection === "tech") continue // K-11 安全不变量
      const entries = cols[collection] ?? []
      for (const entry of entries) {
        const name = String(entry["name"] ?? "")
        const title = String(entry["title"] ?? "")
        const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
        const hay = `${name} ${title} ${domain}`.toLowerCase()
        // 关键词命中：query 任一 ≥2 字 token 出现在 name/title/domain
        // P1-IMP-17 修复（三模型共识 F1）：复用 tokenizeForBm25（零依赖 CJK
        // bigram + ASCII 词元）替代 split(/\s+/)——中文无空格 query 不再成单巨型 token。
        const tokens = tokensForKbMatch(params.query)
        const hit = tokens.some((t) => hay.includes(t))
        if (!hit) continue
        const summary = entry["purpose"] ? String(entry["purpose"]).slice(0, 200) : undefined
        const entryText = `${title} ${summary ?? ""}`
        if (refChars + entryText.length > referenceBudget) break
        kbReferences.push({
          collection,
          name,
          title,
          summary,
          path: `reference/${collection}/${name}`,
          trust: String(entry["trust"] ?? "reference_only"),
          query_intent: Array.isArray(entry["query_intent"]) ? (entry["query_intent"] as string[]) : [],
        })
        refChars += entryText.length
      }
    }
  }

  return {
    hardInject,
    ranked: filteredRanked,
    gaps,
    kbReferences,
    usage: {
      hardInjectChars,
      capChars,
      ratio: capChars > 0 ? hardInjectChars / capChars : 0,
      truncatedCount,
    },
  }
}

// M11-3: 效用重排（E-02 C-7）+ multi-query 机械层（64 号）已迁至
// ./search-strategy（re-export 保面，行为不变）。
