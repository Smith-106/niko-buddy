// M11-3 切片：检索策略纯函数层（KB 路由 + 权威谓词 + 效用重排 + 多查询融合）。
// 来源：search-adapter.ts（E-02 KB-VIEW 消费 / E-02 C-7 / 64 号 multi-query 机械层）。
// 本模块仅含同步纯函数 + 类型 + KB-VIEW 只读消费；零新增依赖（复用既有模块）。
// search-adapter.ts 经 re-export 保对外 import 面（M 系列纪律：符号名/签名零改）。
// P1 #69 刚做过检索主链收敛 —— 本模块只收尚未切片的策略叶，不碰孪生体。

import kbRoutingViewRaw from "./kb/kb-routing-view.generated.json"
import { z } from "zod"
import { tokenizeForBm25 } from "./bm25-ranking"
import {
  SOURCE_RRF_K_DEFAULT,
  SOURCE_WEIGHTS,
  normalizeResultPath,
  toPublicResult,
} from "./retrieval-source-pipeline"
import type { NovelSearchResult } from "./search-adapter"
import type { SearchRecipeId } from "@/stores/wiki-store"
export type { SearchRecipeId }

// ============================================================================
// 权威 / 历史投影谓词（源自 search-adapter E-02 前置谓词）
// ============================================================================

export function isAuthoritativeGenerationPath(path: string): boolean {
  return /\/wiki\/(entities|concepts|memory|chapters)\//.test(path)
    || /\/wiki\/canon\.md$/.test(path)
    || /\/\.novel\/snapshots\//.test(path)
}

export function isHistoricalProjectionSnippet(path: string, snippet: string): boolean {
  return /\/history\//.test(path) || /is_historical:\s*true/i.test(snippet)
}

export function filterAuthoritative(items: NovelSearchResult[]): NovelSearchResult[] {
  return items.filter((item) => {
    if (item.type === "canon" || item.type === "recent_chapter") return true
    if (isHistoricalProjectionSnippet(item.path, item.snippet)) return false
    return isAuthoritativeGenerationPath(item.path)
  })
}

// ============================================================================
// KB-VIEW 路由消费（源自 search-adapter E-02 C-6 / P1-IMP-06 / P1-IMP-08）
// ============================================================================

/**
 * P1-IMP-08: KB-VIEW 消费面切仓内 generated JSON —— Niko Buddy 单仓自带数据可构建。
 *
 * 切换点（回退说明，务必保留本注释）：
 *   现状（IMP-08 后）：读 ./kb/kb-routing-view.generated.json（入 git，由
 *     scripts/sync-kb-view-to-niko-buddy.mjs 从 hub reference/REFERENCE-KB-VIEW.json 抽取）。
 *   回退（仅本地联调，单仓 checkout 下该路径不存在 → 构建即碎）：
 *     import kbRoutingViewRaw from "../../../../reference/REFERENCE-KB-VIEW.json"
 *
 * 消费面 = schemaVersion / builtFrom / routing.agent / collectionCounts / byQueryIntent
 * + collections 的 {collection,name,trust} 投影（P1-IMP-06 buildTrustGradeMap 需要，
 * 键序与数组序守恒 → trust 映射与源视图逐键一致）。content 类大字段永不入包。
 */

/** P1-IMP-06: 共享 KB-VIEW（trust 映射 / 路由矩阵读取）*/
export const kbRoutingView = kbRoutingViewRaw as unknown

/**
 * E-02 (C-6, DA-09): 路由矩阵消费 — MUST 从 JSON 读路由, 不得硬编码。
 * 静态 JSON import (构建期绑定, Vite resolveJsonModule), zod 形状校验。
 * 只读 `routing.agent` (写作 Agent 面, E-01 已保证无 tech)。
 */
const KB_ROUTING_AGENT_SCHEMA = z.record(
  z.string(),
  z.array(z.string()),
)

/** P1-IMP-08: collection → 条目数（空收藏判定唯一口径，替代数组长度）。 */
const KB_COLLECTION_COUNTS_SCHEMA = z.record(z.string(), z.number())

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

/**
 * P1-IMP-08: 新鲜度断言 — 消费面 MUST 自带 builtFrom（源视图 sha256 指纹）。
 * 缺 builtFrom = 产物被手改或同步脚本旧版本写出，路由面不可信 → fail-loud，
 * 不静默按旧视图检索（对齐 assertNoTechLeak 模式）。
 */
export function loadKbRoutingViewBuiltFrom(): string {
  const raw = (kbRoutingView as { builtFrom?: unknown }).builtFrom
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      "kb-routing-view.generated.json 缺少 builtFrom (P1-IMP-08 新鲜度断言失败 — " +
        "重跑 node scripts/sync-kb-view-to-niko-buddy.mjs 并重新入 git)",
    )
  }
  return raw
}

/**
 * P1-IMP-08 (V7/N-b): 空收藏判定改读 collectionCounts —— generated 消费面不再携带
 * collections 全量数组，`collections[c].length` 在缺字段时会恒为 0 而误阻断全部路由。
 */
export function loadKbCollectionCounts(): Record<string, number> {
  const raw = (kbRoutingView as { collectionCounts?: unknown }).collectionCounts
  if (raw === undefined) {
    throw new Error(
      "kb-routing-view.generated.json 缺少 collectionCounts (P1-IMP-08 消费面 schema 变更)",
    )
  }
  return KB_COLLECTION_COUNTS_SCHEMA.parse(raw)
}

/** E-02 (C-6): 空收藏显式报缺 — 不静默、不用 tech 冒充 (DA-06)。 */
export interface KbGap {
  collection: string
  impactedIntents: string[]
  message: string
}

/**
 * E-02 (C-6): 意图路由前置门 — 消费 routing.agent 矩阵。
 * 空收藏 (P1-IMP-08: collectionCounts[c] ?? 0 === 0) → 显式 KbGap + 阻断该 collection 路由
 * (其余收藏继续, 部分阻断语义); tech 结构性缺席由数据面保证 + assertNoTechLeak 兜底。
 */
export function routeByQueryIntent(intent: string): {
  collections: string[]
  gaps: KbGap[]
  blocked: string[]
} {
  const matrix = loadKbRoutingMatrix()
  // P1-IMP-08: 新鲜度断言前置（缺 builtFrom 即抛，不带着旧视图继续路由）。
  loadKbRoutingViewBuiltFrom()
  const counts = loadKbCollectionCounts()
  const allowlist = matrix.agent[intent] ?? []
  // P1-IMP-13 (A1a / P1-N2 缺口修复): assertNoTechLeak 常驻调用 — routing 面
  // tech 零出现（K-11 安全不变量：routing.agent 不得路由到 tech 收藏）。
  // 命中即 fail-loud，不静默按旧视图检索。
  assertNoTechLeak(allowlist.map((collection) => ({ collection })))
  const collections: string[] = []
  const gaps: KbGap[] = []
  const blocked: string[] = []
  for (const collection of allowlist) {
    const count = counts[collection] ?? 0
    if (count === 0) {
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
export function assertNoTechLeak(items: readonly unknown[]): void {
  for (const item of items) {
    const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>
    if (obj["collection"] === "tech" || obj["trust"] === "blocked") {
      throw new Error(
        `tech 隔离断言失败: 检索结果含 ${obj["collection"] ?? "?"} (trust=${obj["trust"] ?? "?"}) — ` +
        `写作 Agent 检索面 tech 零出现是安全不变量 (K-11)`,
      )
    }
  }
}

/**
 * P1-IMP-17 通道 B 关键词 token 化（三模型共识 F1）：复用 tokenizeForBm25
 * （零依赖 CJK bigram + ASCII 词元）替代 split(/\s+/)——中文无空格 query
 * 不再成单巨型 token。去重后丢弃单字符 token（CJK unigram 防单字误命中
 * hay，与既有 ≥2 过滤同语义），超 cap 截断控预算。纯函数零 LLM。
 */
export function tokensForKbMatch(query: string, cap = 32): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokenizeForBm25(query)) {
    if (t.length < 2) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= cap) break
  }
  return out
}

// ============================================================================
// 写作特化 rerank 效用层（源自 search-adapter E-02 C-7，纯函数零 LLM）
// ============================================================================

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

// ============================================================================
// 64 号实施（63 号共识 §6 缺口 13）：rag-fusion multi-query 改写（机械层）
// ============================================================================

/**
 * multi-query 发生器（零 LLM）：原查询 + verbatim-lift（引号字面量独立成
 * 查询）+ 实体扩展（facets 拼查询）。确定性：同输入同输出（可被
 * offline-replay 复算）；去重 + 封顶。
 */
export interface MultiQueryOptions {
  /** 生成查询数上限（含原查询，缺省 3）。 */
  maxQueries?: number
  /** verbatim 字面量独立成查询（缺省 true）。 */
  includeVerbatimLift?: boolean
  /** 实体分面扩展查询（缺省 true）。 */
  includeEntityExpand?: boolean
}

export function generateMultiQueries(
  query: string,
  decomposition: import("./bm25-ranking").QueryDecomposition,
  opts?: MultiQueryOptions,
): string[] {
  const maxQueries = opts?.maxQueries ?? 3
  const queries: string[] = [query.trim()]

  if (opts?.includeVerbatimLift !== false) {
    for (const v of decomposition.verbatim) {
      if (v && !queries.includes(v)) queries.push(v)
      if (queries.length >= maxQueries) break
    }
  }
  if (queries.length < maxQueries && opts?.includeEntityExpand !== false) {
    const { character, location, item } = decomposition.facets
    const expanded = [character, location, item].filter((f): f is string => Boolean(f))
    if (expanded.length > 0) {
      const expandedQuery = `${expanded.join(" ")} ${decomposition.rest}`.trim()
      if (expandedQuery && expandedQuery !== query && !queries.includes(expandedQuery)) {
        queries.push(expandedQuery)
      }
    }
  }

  return queries.slice(0, maxQueries)
}

/**
 * 跨子查询 RRF 融合（复用既有贡献公式 weight/(K+rank+1)）。
 * 输入：每子查询已排名的结果数组；输出按归一 path 融合后的排名。
 */
export function fuseAcrossQueries(
  branchResults: NovelSearchResult[][],
  rrfK: number = SOURCE_RRF_K_DEFAULT,
): NovelSearchResult[] {
  const fused = new Map<
    string,
    { result: NovelSearchResult; fusionScore: number }
  >()

  for (const results of branchResults) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank]
      const key = normalizeResultPath(r.path)
      const contribution = SOURCE_WEIGHTS[r.type] ?? 0.8
      const score = contribution / (rrfK + rank + 1)
      const clean = toPublicResult(r)
      const existing = fused.get(key)
      if (!existing) {
        fused.set(key, { result: clean, fusionScore: score })
      } else {
        existing.fusionScore += score
      }
    }
  }

  return Array.from(fused.values())
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .map((item) => ({
      ...item.result,
      relevance: Math.round(item.fusionScore * 1_000_000) / 1_000_000,
    }))
}

// ============================================================================
// ISS-20260802-004: MMR 多样性重排 + NodeDistance 空间衰减 + 检索编排配方
// ============================================================================

export interface SearchRecipeConfig {
  id: SearchRecipeId
  nameKey: string
  descKey: string
  useMmr: boolean
  useNodeDistance: boolean
  mmrLambda: number
  distanceDecay: number
  maxGraphHops: number
}

export const SEARCH_RECIPES: Record<SearchRecipeId, SearchRecipeConfig> = {
  default: {
    id: "default",
    nameKey: "settings.sections.rerank.recipeDefault",
    descKey: "settings.sections.rerank.recipeDefaultDesc",
    useMmr: false,
    useNodeDistance: false,
    mmrLambda: 1.0,
    distanceDecay: 1.0,
    maxGraphHops: 0,
  },
  diverse: {
    id: "diverse",
    nameKey: "settings.sections.rerank.recipeDiverse",
    descKey: "settings.sections.rerank.recipeDiverseDesc",
    useMmr: true,
    useNodeDistance: false,
    mmrLambda: 0.7,
    distanceDecay: 1.0,
    maxGraphHops: 0,
  },
  local: {
    id: "local",
    nameKey: "settings.sections.rerank.recipeLocal",
    descKey: "settings.sections.rerank.recipeLocalDesc",
    useMmr: false,
    useNodeDistance: true,
    mmrLambda: 1.0,
    distanceDecay: 0.8,
    maxGraphHops: 3,
  },
  balanced: {
    id: "balanced",
    nameKey: "settings.sections.rerank.recipeBalanced",
    descKey: "settings.sections.rerank.recipeBalancedDesc",
    useMmr: true,
    useNodeDistance: true,
    mmrLambda: 0.75,
    distanceDecay: 0.85,
    maxGraphHops: 3,
  },
}

/**
 * 字符双字分块 (bi-shingle / 2-gram) Jaccard 相似度。
 * 纯 TypeScript 零额外依赖，对中文/CJK 实体专名天然有效。
 */
export function charShingleJaccard(
  textA: string,
  textB: string,
  shingleSize: number = 2,
): number {
  if (textA === textB) return 1.0
  const a = textA.trim()
  const b = textB.trim()
  if (a === b) return 1.0

  const k = Math.max(1, Math.floor(shingleSize))
  const setA = new Set<string>()
  const setB = new Set<string>()

  for (let i = 0; i <= a.length - k; i++) {
    setA.add(a.slice(i, i + k))
  }
  for (let i = 0; i <= b.length - k; i++) {
    setB.add(b.slice(i, i + k))
  }

  if (setA.size === 0 && setB.size === 0) {
    return a === b ? 1.0 : 0.0
  }

  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) {
      intersection++
    }
  }

  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

export interface MmrOptions<T = unknown> {
  k: number
  lambda?: number // [0, 1], default 0.7
  similarity?: (a: T, b: T) => number
  textOf?: (item: T) => string
}

/**
 * Maximal Marginal Relevance (MMR) 纯函数重排。
 * 在 relevance 分数与已选集最大相似度之间权衡，减少同质冗余。
 * 确定性 tie-break：原始分数高者优先，同分时原始较小索引优先。
 */
export function mmrRerank<T>(candidates: T[], options: MmrOptions<T>): T[] {
  const targetK = Math.min(Math.max(0, options.k), candidates.length)
  if (candidates.length <= 1 || targetK <= 1) {
    return candidates.slice(0, targetK)
  }

  const defaultTextOf = (item: T): string => {
    if (typeof item === "string") return item
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>
      const title = typeof rec.title === "string" ? rec.title : ""
      const snippet = typeof rec.snippet === "string" ? rec.snippet : ""
      const text = `${title} ${snippet}`.trim()
      if (text.length > 0) return text
    }
    return String(item ?? "")
  }
  const textFn = options.textOf ?? defaultTextOf
  const simFn = options.similarity ?? ((a: T, b: T) => charShingleJaccard(textFn(a), textFn(b)))
  const lambda = typeof options.lambda === "number" ? Math.max(0, Math.min(1, options.lambda)) : 0.7

  const getRelevance = (item: T): number => {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>
      if (typeof rec.relevance === "number" && Number.isFinite(rec.relevance)) {
        return rec.relevance
      }
    }
    return 0
  }

  const maxRel = Math.max(...candidates.map(getRelevance))
  const normRelevance = candidates.map((item, idx) => {
    if (maxRel > 0) {
      return Math.max(0, getRelevance(item)) / maxRel
    }
    return (candidates.length - idx) / candidates.length
  })

  const unselected = new Set<number>(candidates.map((_, i) => i))
  const selected: number[] = []

  // Step 1: select highest relevance
  let firstIdx = 0
  let firstScore = -Infinity
  for (const idx of unselected) {
    if (normRelevance[idx] > firstScore) {
      firstScore = normRelevance[idx]
      firstIdx = idx
    }
  }
  selected.push(firstIdx)
  unselected.delete(firstIdx)

  // Step 2 to targetK
  while (selected.length < targetK && unselected.size > 0) {
    let bestIdx = -1
    let bestMmrScore = -Infinity

    for (const u of unselected) {
      let maxSim = 0
      for (const s of selected) {
        const sim = simFn(candidates[u], candidates[s])
        if (sim > maxSim) maxSim = sim
      }

      const mmrScore = lambda * normRelevance[u] - (1 - lambda) * maxSim

      if (bestIdx === -1) {
        bestMmrScore = mmrScore
        bestIdx = u
      } else if (mmrScore - bestMmrScore > 1e-9) {
        bestMmrScore = mmrScore
        bestIdx = u
      } else if (Math.abs(mmrScore - bestMmrScore) <= 1e-9) {
        // Deterministic tie break: higher relevance, then earlier original index
        if (normRelevance[u] > normRelevance[bestIdx]) {
          bestMmrScore = mmrScore
          bestIdx = u
        } else if (normRelevance[u] === normRelevance[bestIdx] && u < bestIdx) {
          bestMmrScore = mmrScore
          bestIdx = u
        }
      }
    }

    if (bestIdx !== -1) {
      selected.push(bestIdx)
      unselected.delete(bestIdx)
    } else {
      break
    }
  }

  return selected.map((idx) => candidates[idx])
}

export interface NodeDistanceOptions {
  anchors: readonly string[]
  graph?: unknown
  decay?: number // default 0.8
  maxDepth?: number // default 3
  unreachableDecay?: number // default decay ** (maxDepth + 1)
}

function extractNodeStem(str: string): string {
  const base = str.replace(/\\/g, "/").split("/").pop() ?? str
  return base.replace(/\.md$/i, "").trim()
}

interface GraphIndex {
  resolveNodeId: (identifier: string) => string | undefined
  getNeighbors: (nodeId: string) => string[]
}

function buildGraphIndex(graph: unknown): GraphIndex | null {
  if (!graph || typeof graph !== "object") return null

  const aliasToId = new Map<string, string>()
  const adjacency = new Map<string, Set<string>>()

  const registerAlias = (alias: string, id: string) => {
    const trimmed = alias.trim()
    if (!trimmed) return
    if (!aliasToId.has(trimmed)) aliasToId.set(trimmed, id)
    const lower = trimmed.toLowerCase()
    if (!aliasToId.has(lower)) aliasToId.set(lower, id)
    const stem = extractNodeStem(trimmed)
    if (stem && !aliasToId.has(stem)) aliasToId.set(stem, id)
    const lowerStem = stem.toLowerCase()
    if (lowerStem && !aliasToId.has(lowerStem)) aliasToId.set(lowerStem, id)
  }

  const addEdge = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    adjacency.get(a)!.add(b)
    adjacency.get(b)!.add(a)
  }

  const gRec = graph as Record<string, unknown>
  if (gRec.nodes instanceof Map) {
    for (const [id, node] of gRec.nodes.entries()) {
      const n = node as Record<string, unknown>
      const nodeId = String(n.id ?? id)
      registerAlias(nodeId, nodeId)
      if (typeof n.title === "string") registerAlias(n.title, nodeId)
      if (typeof n.path === "string") registerAlias(n.path, nodeId)

      if (n.outLinks instanceof Set || Array.isArray(n.outLinks)) {
        for (const target of n.outLinks) addEdge(nodeId, String(target))
      }
      if (n.inLinks instanceof Set || Array.isArray(n.inLinks)) {
        for (const source of n.inLinks) addEdge(nodeId, String(source))
      }
      if (Array.isArray(n.relationEdges)) {
        for (const edge of n.relationEdges) {
          if (edge && typeof edge === "object") {
            const target = (edge as Record<string, unknown>).target
            if (target) addEdge(nodeId, String(target))
          }
        }
      }
    }
  } else if (Array.isArray(gRec.edges)) {
    if (Array.isArray(gRec.nodes)) {
      for (const node of gRec.nodes) {
        if (typeof node === "string") {
          registerAlias(node, node)
        } else if (node && typeof node === "object") {
          const id = String((node as Record<string, unknown>).id ?? "")
          if (id) {
            registerAlias(id, id)
            const title = (node as Record<string, unknown>).title
            if (typeof title === "string") registerAlias(title, id)
          }
        }
      }
    }
    for (const edge of gRec.edges) {
      if (edge && typeof edge === "object") {
        const rec = edge as Record<string, unknown>
        const u = String(rec.source ?? rec.from ?? "")
        const v = String(rec.target ?? rec.to ?? "")
        if (u && v) {
          registerAlias(u, u)
          registerAlias(v, v)
          addEdge(u, v)
        }
      }
    }
  } else if (graph instanceof Map) {
    for (const [key, neighbors] of graph.entries()) {
      const id = String(key)
      registerAlias(id, id)
      if (neighbors instanceof Set || Array.isArray(neighbors)) {
        for (const n of neighbors) {
          const nId = String(n)
          registerAlias(nId, nId)
          addEdge(id, nId)
        }
      }
    }
  } else {
    for (const [key, neighbors] of Object.entries(gRec)) {
      const id = String(key)
      registerAlias(id, id)
      if (neighbors instanceof Set || Array.isArray(neighbors)) {
        for (const n of neighbors) {
          const nId = String(n)
          registerAlias(nId, nId)
          addEdge(id, nId)
        }
      }
    }
  }

  const resolveNodeId = (identifier: string): string | undefined => {
    const trimmed = identifier.trim()
    if (!trimmed) return undefined
    return (
      aliasToId.get(trimmed) ??
      aliasToId.get(trimmed.toLowerCase()) ??
      aliasToId.get(extractNodeStem(trimmed)) ??
      aliasToId.get(extractNodeStem(trimmed).toLowerCase())
    )
  }

  const getNeighbors = (nodeId: string): string[] => {
    const set = adjacency.get(nodeId)
    if (!set) return []
    return Array.from(set)
  }

  return { resolveNodeId, getNeighbors }
}

/**
 * NodeDistance 空间衰减重排纯函数。
 * 基于 BFS 最短图路径计算候选与锚点实体的跳数并施加指数衰减。
 */
export function nodeDistanceRerank<T>(
  candidates: T[],
  options: NodeDistanceOptions,
): T[] {
  if (candidates.length === 0 || !options.anchors || options.anchors.length === 0 || !options.graph) {
    return [...candidates]
  }

  const index = buildGraphIndex(options.graph)
  if (!index) return [...candidates]

  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 3))
  const decay = typeof options.decay === "number" ? Math.max(0, options.decay) : 0.8
  const unreachableDecay = typeof options.unreachableDecay === "number"
    ? options.unreachableDecay
    : Math.pow(decay, maxDepth + 1)

  const distanceMap = new Map<string, number>()
  const queue: { id: string; depth: number }[] = []

  for (const anchor of options.anchors) {
    const resolved = index.resolveNodeId(anchor)
    if (resolved && !distanceMap.has(resolved)) {
      distanceMap.set(resolved, 0)
      queue.push({ id: resolved, depth: 0 })
    }
  }

  if (queue.length === 0) {
    return [...candidates]
  }

  while (queue.length > 0) {
    const curr = queue.shift()!
    if (curr.depth >= maxDepth) continue
    for (const nbr of index.getNeighbors(curr.id)) {
      const nbrId = index.resolveNodeId(nbr) ?? nbr
      if (!distanceMap.has(nbrId)) {
        distanceMap.set(nbrId, curr.depth + 1)
        queue.push({ id: nbrId, depth: curr.depth + 1 })
      }
    }
  }

  const scored = candidates.map((item, originalIndex) => {
    let bestDist = Infinity
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>
      const candidateKeys: string[] = []
      if (typeof rec.title === "string") candidateKeys.push(rec.title)
      if (typeof rec.path === "string") candidateKeys.push(rec.path)
      if (typeof rec.id === "string") candidateKeys.push(rec.id)
      for (const k of candidateKeys) {
        const resolved = index.resolveNodeId(k)
        if (resolved && distanceMap.has(resolved)) {
          const d = distanceMap.get(resolved)!
          if (d < bestDist) bestDist = d
        }
      }
      if (!Number.isFinite(bestDist)) {
        for (const [nodeId, d] of distanceMap) {
          if (nodeId.length >= 2 && candidateKeys.some((k) => k.includes(nodeId))) {
            if (d < bestDist) bestDist = d
          }
        }
      }
    }

    const factor = Number.isFinite(bestDist) ? Math.pow(decay, bestDist) : unreachableDecay
    const originalRel = (item && typeof item === "object" && typeof (item as Record<string, unknown>).relevance === "number")
      ? ((item as Record<string, unknown>).relevance as number)
      : 1.0
    const adjustedScore = originalRel * factor

    return { item, adjustedScore, originalIndex }
  })

  scored.sort((a, b) => {
    if (Math.abs(b.adjustedScore - a.adjustedScore) > 1e-9) {
      return b.adjustedScore - a.adjustedScore
    }
    return a.originalIndex - b.originalIndex
  })

  return scored.map(({ item, adjustedScore }) => {
    if (item && typeof item === "object" && "relevance" in item) {
      return {
        ...item,
        relevance: Math.round(adjustedScore * 1_000_000) / 1_000_000,
      }
    }
    return item
  })
}

export interface ApplyRecipeOptions<T = unknown> {
  recipe?: SearchRecipeId
  topK: number
  anchors?: readonly string[]
  graph?: unknown
  similarity?: (a: T, b: T) => number
  textOf?: (item: T) => string
}

/**
 * 检索配方分发器纯函数。
 * 当 recipe 为 default 或缺失时严格直接 slice(0, topK) 短路保保真度。
 */
export function applySearchRecipe<T>(
  candidates: T[],
  options: ApplyRecipeOptions<T>,
): T[] {
  const recipeId = options.recipe ?? "default"
  if (recipeId === "default" || !(recipeId in SEARCH_RECIPES)) {
    return candidates.slice(0, options.topK)
  }

  const recipe = SEARCH_RECIPES[recipeId]
  let pool = [...candidates]

  if (recipe.useNodeDistance && options.anchors && options.anchors.length > 0 && options.graph) {
    pool = nodeDistanceRerank(pool, {
      anchors: options.anchors,
      graph: options.graph,
      decay: recipe.distanceDecay,
      maxDepth: recipe.maxGraphHops,
    })
  }

  if (recipe.useMmr) {
    pool = mmrRerank(pool, {
      k: options.topK,
      lambda: recipe.mmrLambda,
      similarity: options.similarity,
      textOf: options.textOf,
    })
    return pool
  }

  return pool.slice(0, options.topK)
}
