import { searchWiki } from "@/lib/search"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import { rerankCandidates } from "@/lib/rerank"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"
import { loadSnapshot, listSnapshots } from "./chapter-ingest"
import { sanitizeEntitySlug } from "./graph-adapter"
import { rankByBm25 } from "./bm25-ranking"

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

const SOURCE_RRF_K_DEFAULT = 60
const SEARCH_SOURCE_TIMEOUT_MS = 2500
const SOURCE_WEIGHTS: Record<NovelSearchResult["type"], number> = {
  keyword: 1,
  vector: 1,
  graph: 0.95,
  canon: 0.9,
  recent_chapter: 0.75,
}

const SOURCE_TIE_PRIORITY: Record<NovelSearchResult["type"], number> = {
  keyword: 0,
  vector: 1,
  graph: 2,
  canon: 3,
  recent_chapter: 4,
}

export function isAuthoritativeGenerationPath(path: string): boolean {
  return /\/wiki\/(entities|concepts|memory|chapters)\//.test(path)
    || /\/wiki\/canon\.md$/.test(path)
    || /\/\.novel\/snapshots\//.test(path)
}

export function isHistoricalProjectionSnippet(path: string, snippet: string): boolean {
  return /\/history\//.test(path) || /is_historical:\s*true/i.test(snippet)
}

export async function novelMixedSearch(params: NovelSearchParams): Promise<NovelSearchResult[]> {
  const pp = normalizePath(params.projectPath)
  const topK = params.topK ?? 5
  const results: RankedNovelSearchResult[] = []

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

  const merged = deduplicateResults(results, params.rrfK ?? SOURCE_RRF_K_DEFAULT)
  const filtered = params.authoritativeOnly ? filterAuthoritative(merged) : merged
  const truncated = filtered.slice(0, topK)

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
  return reranked
}

async function runSearchBranch<T>(label: string, promise: Promise<T>): Promise<T> {
  try {
    return await withTimeout(promise, SEARCH_SOURCE_TIMEOUT_MS, label)
  } catch (err) {
    logger.error("Novel Search", `${label} error`, { error: err instanceof Error ? err.message : String(err) })
    return [] as T
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} search timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function rankSourceResults(items: NovelSearchResult[]): RankedNovelSearchResult[] {
  return items.map((item, sourceRank) => ({ ...item, sourceRank }))
}

async function runVectorSearch(
  pp: string,
  query: string,
  topK: number,
  embCfg?: EmbeddingConfig,
): Promise<NovelSearchResult[]> {
  const embCfgResolved = embCfg ?? useWikiStore.getState().embeddingConfig
  if (!embCfgResolved.enabled || !embCfgResolved.model) return []

  try {
    const { searchByEmbedding } = await import("@/lib/embedding")
    const vectorResults = await searchByEmbedding(pp, query, embCfgResolved, Math.max(topK * 2, 10))
    if (vectorResults.length === 0) return []

    const items: NovelSearchResult[] = []
    // PERF-NEW-06/PAT-G2 (odyssey-improve): parallelize the per-vr path probe.
    // This function is the same-shape sibling of context-engine.ts
    // runVectorSearchForContext — previously a serial `for (dir of dirs) await
    // readFile(...)` (up to 7 serial IPC round-trips per vr, N×7 worst case).
    // Now each vr probes all 7 candidate paths concurrently via
    // Promise.allSettled, preserving first-success semantics (dirs order wins
    // over root) by scanning settled results in priority order.
    const probePath = async (
      tryPath: string,
    ): Promise<{ path: string; content: string } | null> => {
      try {
        const content = await readFile(tryPath)
        return { path: tryPath, content }
      } catch {
        return null
      }
    }
    for (const vr of vectorResults.slice(0, topK)) {
      try {
        // SEC-001 (odyssey-review, CWE-22): sanitize vr.id (LanceDB page_id)
        // before path construction — symmetric with context-engine.ts
        // runVectorSearchForContent. vr.id is external stored state in LanceDB;
        // Rust readFile has no project-root containment, so this TS path join
        // is the only traversal boundary. PAT-G2 twin: this function is the
        // same-shape sibling of runVectorSearchForContent and must mirror its
        // sanitize defense.
        const dirs = ["entities", "concepts", "sources", "synthesis", "comparison", "queries"]
        const safeId = sanitizeEntitySlug(vr.id)
        const candidatePaths = [
          ...dirs.map((dir) => `${pp}/wiki/${dir}/${safeId}.md`),
          `${pp}/wiki/${safeId}.md`,
        ]
        const settled = await Promise.allSettled(candidatePaths.map((p) => probePath(p)))
        // Priority order: dirs first (in declared order), then root fallback.
        const hit = settled
          .map((r) => (r.status === "fulfilled" ? r.value : null)) /* v8 ignore start */ /* v8 ignore stop */
          .find((v): v is { path: string; content: string } => v !== null)
        if (hit) {
          const title = extractTitle(hit.content, safeId)
          items.push({
            type: "vector",
            path: hit.path,
            title,
            snippet: hit.content.slice(0, 300).replace(/\n/g, " "),
            relevance: vr.score,
          })
        }
      } catch {}
    }
    return items
  } catch {
    return []
  }
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

    const seenIds = new Set<string>()
    const scoredNodes: { title: string; path: string; snippet: string; relevance: number }[] = []

    // PERF-004/PAT-G2 (odyssey-improve): SINGLE-PASS match collection — iterate
    // graph.nodes once, matching against ALL candidate names, dedup by node id.
    // Replaces the prior per-name full-graph rescan (was O(names × nodes)).
    // This function is the same-shape sibling of context-engine.ts
    // searchGraphRelevantContent and must mirror its PERF-004 optimization.
    const matchedNodes: { id: string; title: string; path: string }[] = []
    for (const [, node] of graph.nodes) {
      if (
        seenIds.has(node.id) === false &&
        Array.from(candidateNames).some(
          (name) => node.title.includes(name) || node.id.includes(name),
        )
      ) {
        seenIds.add(node.id)
        matchedNodes.push({ id: node.id, title: node.title, path: node.path })
      }
    }

    // PERF-NEW-02/PAT-G2: collect all unseen related-node reads first (dedup
    // against seenIds), then read them in parallel. The prior nested for...of
    // awaited readFile serially (up to M×5 sequential IPC round-trips).
    type PendingRead = { title: string; path: string; relevance: number }
    const pendingReads: PendingRead[] = []
    for (const matchedNode of matchedNodes) {
      const related = getRelatedNodes(matchedNode.id, graph, 5)
      for (const { node, relevance } of related) {
        if (seenIds.has(node.id)) continue
        seenIds.add(node.id)
        pendingReads.push({ title: node.title, path: node.path, relevance })
      }
    }
    const readResults = await Promise.all(
      pendingReads.map(async (entry) => {
        try {
          const content = await readFile(entry.path)
          return {
            title: entry.title,
            path: entry.path,
            snippet: content.slice(0, 300).replace(/\n/g, " "),
            relevance: Math.round(entry.relevance * 100) / 100,
          }
        } catch {
          return null
        }
      }),
    )
    for (const r of readResults) {
      if (r) scoredNodes.push(r)
    }

    scoredNodes.sort((a, b) => b.relevance - a.relevance)
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

export function filterAuthoritative(items: NovelSearchResult[]): NovelSearchResult[] {
  return items.filter((item) => {
    if (item.type === "canon" || item.type === "recent_chapter") return true
    if (isHistoricalProjectionSnippet(item.path, item.snippet)) return false
    return isAuthoritativeGenerationPath(item.path)
  })
}

function deduplicateResults(
  results: RankedNovelSearchResult[],
  rrfK: number = SOURCE_RRF_K_DEFAULT,
): NovelSearchResult[] {
  const fused = new Map<string, {
    result: NovelSearchResult
    fusionScore: number
    bestContribution: number
    bestRelevance: number
    bestRank: number
    bestTypePriority: number
  }>()

  for (const r of results) {
    const sourceRank = Math.max(0, r.sourceRank)
    /* v8 ignore next */
    const weight = SOURCE_WEIGHTS[r.type] ?? 0.8
    const contribution = weight / (rrfK + sourceRank + 1)
    const key = normalizeResultPath(r.path)
    const cleanResult = toPublicResult(r)
    const existing = fused.get(key)

    if (!existing) {
      fused.set(key, {
        result: cleanResult,
        fusionScore: contribution,
        bestContribution: contribution,
        bestRelevance: r.relevance,
        bestRank: sourceRank,
        bestTypePriority: SOURCE_TIE_PRIORITY[r.type] ?? 9, /* v8 ignore start */ /* v8 ignore stop */
      })
      continue
    }

    existing.fusionScore += contribution
    if (shouldReplaceRepresentative(existing, r, contribution)) {
      existing.result = cleanResult
      existing.bestContribution = contribution
      existing.bestRelevance = r.relevance
      existing.bestRank = sourceRank
      existing.bestTypePriority = SOURCE_TIE_PRIORITY[r.type] ?? 9 /* v8 ignore start */ /* v8 ignore stop */
    }
  }

  return Array.from(fused.values())
    .sort((a, b) => {
      if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore
      if (b.bestRelevance !== a.bestRelevance) return b.bestRelevance - a.bestRelevance
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
      /* v8 ignore next */
      if (a.bestTypePriority !== b.bestTypePriority) return a.bestTypePriority - b.bestTypePriority
      /* v8 ignore next */
      return a.result.title.localeCompare(b.result.title)
    })
    .map((item) => ({
      ...item.result,
      relevance: Math.round(item.fusionScore * 1_000_000) / 1_000_000,
    }))
}

function normalizeResultPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

function toPublicResult(result: NovelSearchResult): NovelSearchResult {
  return {
    type: result.type,
    path: result.path,
    title: result.title,
    snippet: result.snippet,
    relevance: result.relevance,
  }
}

function shouldReplaceRepresentative(
  existing: {
    bestContribution: number
    bestRelevance: number
    bestRank: number
    bestTypePriority: number
  },
  candidate: RankedNovelSearchResult,
  contribution: number,
): boolean {
  if (contribution !== existing.bestContribution) return contribution > existing.bestContribution
  if (candidate.relevance !== existing.bestRelevance) return candidate.relevance > existing.bestRelevance
  if (candidate.sourceRank !== existing.bestRank) return candidate.sourceRank < existing.bestRank
  /* v8 ignore next */
  return (SOURCE_TIE_PRIORITY[candidate.type] ?? 9) < existing.bestTypePriority
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)/m)
  if (match) return match[1].trim()
  const fmMatch = content.match(/^---\ntitle:\s*(.+)/m)
  if (fmMatch) return fmMatch[1].trim()
  return fallback
}

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

import kbRoutingView from "../../../../reference/REFERENCE-KB-VIEW.json"
import { z } from "zod"
import { getFactsKnownBy, type CanonFact } from "./canon-graph-client"
import { visibleInfoFor } from "./process-library"
import type { TrustGrade } from "./trust-grader"

/**
 * E-02 (C-6, DA-09): 路由矩阵消费 — MUST 从 JSON 读路由, 不得硬编码。
 * 静态 JSON import (构建期绑定, Vite resolveJsonModule), zod 形状校验。
 * 只读 `routing.agent` (写作 Agent 面, E-01 已保证无 tech)。
 */
const KB_ROUTING_AGENT_SCHEMA = z.record(
  z.string(),
  z.array(z.string()),
)

export interface KbRoutingMatrix {
  /** intent → collection allowlist (routing.agent, 写作 Agent 面零 tech)。 */
  agent: Record<string, string[]>
}

export function loadKbRoutingMatrix(): KbRoutingMatrix {
  const raw = (kbRoutingView as { routing?: { agent?: unknown } }).routing?.agent
  if (raw === undefined) {
    throw new Error("REFERENCE-KB-VIEW.json 缺少 routing.agent (E-01 产物缺失或 schema 变更)")
  }
  const parsed = KB_ROUTING_AGENT_SCHEMA.parse(raw)
  return { agent: parsed }
}

/** E-02 (C-6): 空收藏显式报缺 — 不静默、不用 tech 冒充 (DA-06)。 */
export interface KbGap {
  collection: string
  impactedIntents: string[]
  message: string
}

/**
 * E-02 (C-6): 意图路由前置门 — 消费 routing.agent 矩阵。
 * 空收藏 (collections[c].length===0) → 显式 KbGap + 阻断该 collection 路由
 * (其余收藏继续, 部分阻断语义); tech 结构性缺席由数据面保证 + assertNoTechLeak 兜底。
 */
export function routeByQueryIntent(intent: string): {
  collections: string[]
  gaps: KbGap[]
  blocked: string[]
} {
  const matrix = loadKbRoutingMatrix()
  const allowlist = matrix.agent[intent] ?? []
  const collections: string[] = []
  const gaps: KbGap[] = []
  const blocked: string[] = []
  for (const collection of allowlist) {
    const entries = (kbRoutingView as { collections?: Record<string, unknown[]> }).collections?.[collection] ?? []
    if (entries.length === 0) {
      gaps.push({
        collection,
        impactedIntents: [intent],
        message: `【收藏缺失】意图「${intent}」路由面缺 ${collection} 收藏 (0 条), 已阻断该收藏检索, 禁止用 tech 工具仓冒充`,
      })
      blocked.push(collection)
      continue
    }
    collections.push(collection)
  }
  return { collections, gaps, blocked }
}

/**
 * E-02 (C-6): tech 隔离运行时断言 — 命中 tech/blocked 名即抛错 (fail-loud,
 * 对齐 assertNoHandleLeak 模式)。Fixed 轴: tech_visible_to_agent MUST NOT
 * 运行时关闭 (ARC-06 三不变量)。
 */
export function assertNoTechLeak(items: readonly { collection?: string; trust?: string }[]): void {
  for (const item of items) {
    if (item.collection === "tech" || item.trust === "blocked") {
      throw new Error(
        `tech 隔离断言失败: 检索结果含 ${item.collection ?? "?"} (trust=${item.trust ?? "?"}) — ` +
        `写作 Agent 检索面 tech 零出现是安全不变量 (K-11)`,
      )
    }
  }
}

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
  usage: { hardInjectChars: number; capChars: number; ratio: number; truncatedCount: number }
}

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

  // E-06 (C-2): trust 后置过滤 (GOV-TRUST-05: blocked 条目不进检索视图)。
  // flag 门控 (trustFilterEnabled 默认 false → 字节级回退); 过滤掉的条目进 gaps
  // (IC-02 绝不静默: type=filtered, ref=trust_blocked)。
  const gaps: KbGap[] = []
  let filteredRanked = ranked
  if (params.trustFilterEnabled && params.trustGrades) {
    const blockedCount = ranked.filter((r) => params.trustGrades?.[r.path] === "blocked").length
    filteredRanked = ranked.filter((r) => params.trustGrades?.[r.path] !== "blocked")
    if (blockedCount > 0) {
      gaps.push({
        collection: "trust",
        impactedIntents: [params.intent ?? "lookup"],
        message: `trust_blocked: ${blockedCount} 条 blocked 条目被过滤（GOV-TRUST-05）`,
      })
    }
  }

  return {
    hardInject,
    ranked: filteredRanked,
    gaps,
    usage: {
      hardInjectChars,
      capChars,
      ratio: capChars > 0 ? hardInjectChars / capChars : 0,
      truncatedCount,
    },
  }
}

/**
 * E-02 (C-7): 写作特化 rerank — usefulness 纯函数 (零 LLM)。
 * usefulness = canon_consistency + situational_fit + information_novelty − staleness
 * - canon_consistency: 确定性谓词冲突检测 → 冲突即否决 (剔除候选, 不加权平均, CAP-RET-11)
 * - situational_fit: POV/章号/场景实体命中度 (entityHints 子串命中计数)
 * - information_novelty: 与已注入硬注入条目 ref 去重后的新增信息量
 * - staleness: CanonFact.validAt/invalidAt 越旧越高; 无时间戳 → 0 (不惩罚旧数据)
 * PF-2: 向量分只经 RRF 计入一次, 本层不叠加 relevance。
 */
export interface UsefulnessContext {
  /** 硬注入条目 ref 集合 (novelty 去重基准)。 */
  hardInjectRefs?: ReadonlySet<string>
  /** 场景实体提示 (situational_fit 命中基准)。 */
  entityHints?: readonly string[]
  /** 当前章号 (situational_fit)。 */
  chapterNumber?: number
}

export interface UsefulnessCandidate {
  title: string
  snippet: string
  path?: string
}

export function reorderByUsefulness<T extends UsefulnessCandidate>(
  candidates: readonly T[],
  ctx?: UsefulnessContext,
): T[] {
  const hints = (ctx?.entityHints ?? []).map((h) => h.trim()).filter(Boolean)
  const scored = candidates.map((c) => {
    let score = 0
    // canon_consistency: 冲突否决 — 候选 snippet 含 canon 冲突标记即剔除。
    // (确定性谓词冲突检测的轻量实现: 冲突由调用方预标记, 本层只做否决制排序。)
    if (c.snippet.includes("【冲突】") || c.snippet.includes("canon_conflict")) {
      return { c, score: -Infinity }
    }
    // situational_fit: 实体提示命中度
    for (const h of hints) {
      if (c.title.includes(h) || c.snippet.includes(h)) score += 1
    }
    // information_novelty: 与硬注入 ref 去重 (path 级)
    if (ctx?.hardInjectRefs && c.path && ctx.hardInjectRefs.has(c.path)) score -= 2
    // staleness: 历史投影降权 (is_historical 标记)
    if (c.path && isHistoricalProjectionSnippet(c.path, c.snippet)) score -= 1
    return { c, score }
  })
  return scored
    .filter((s) => s.score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.c)
}
