// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// context-retrieval.ts — F8 (Round-8 评估)：检索簇从 context-engine.ts 抽出的第三个子模块。
//
// 抽出范围（与 engine 字节级成冸）：computeIrrelevantRatio /
// searchRelevantContent / searchRelevantContentUnified / runVectorSearchForContext /
// searchGraphRelevantContent。本模块是检索簇的唯一定义点；
// context-engine 经 re-export 保持既有 import 面不变（spec 与
// context-data-sources 不动——后者仍经由 context-engine re-export 消费）。
//
// 端夏校准：原来的模块级 contextGaps / contextGapsActive 不下沉；
// 改为参数注入（gapSink + gapsActive）。这是 engine 建立的模式
// 同款（recordGap 注入卷，参见 buildLoadContext）：非 build 期间默认
// 关闭（__setGapRecorderForTests 默认 active=false），这是乎所有直接
// 调用的单测环境下的原始行为。
//

import { searchWiki, tokenizeQuery } from "@/lib/search"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { logger } from "@/lib/utils"
import {
  isAuthoritativeGenerationPath,
  isHistoricalProjectionSnippet,
  novelMixedSearch,
  retrieveDualTrack,
  reorderByUsefulness,
  type NovelSearchResult,
} from "./search-adapter"
import { runVectorSearchShared } from "./vector-search-core"
import { RETRIEVAL_BUDGET_PATHS, getRetrievalBudgetLedger } from "./retrieval-budget"
import { rerankCandidates } from "@/lib/rerank"
import { selectRelevantNovelVectorResults } from "./vector-relevance"
import { reorderByEntityBoost } from "./entity-boost"
import type { BuildContextOptions, ContextEntity, ContextGap, ContextPack } from "./context-engine"

/**
 * Build-scoped gap recorder。默认关闭（active=false）——与 engine 内
 * 原来的 contextGapsActive=false 默认一致，直接调用的单测
 * 环境下不记录任何 gap。build 期间由 context-engine wrapper
 * 设 record。
 */
let gapSink: ContextGap[] | null = null
let gapsActive = false

/** 仅供单测 / engine wrapper 注入：设置 build 作用域的 gap 记录器。 */
export function __setGapRecorderForTests(sink: ContextGap[] | null, active: boolean): void {
  gapSink = sink
  gapsActive = active
}

/**
 * EPIC-003 / ADR-32 / TASK-008: contextPack 无关内容占比启发式统计（ROI 采集）。
 *
 * 启发式：从 contextPack 的 characterStates + relatedSettings + cognitionStates
 * 字段提取候选 entity name（行首 / "X知道" / "X不知道" 模式 + 标点分隔的短词），
 * 统计其中未被 activeEntities name 覆盖的比例 = irrelevantRatio。
 *
 * 这是 stub-grade 启发式（非精确 NER），用于 A/B 趋势对比（enabled vs disabled
 * 平均占比下降即验证条件路由降低无关内容）。零候选时返回 0（无法判定）。
 *
 * G-002/G-003 跨章节统计：多次 contextPack 装配累积样本，A/B variant 对比。
 * 导出用于 conditional-routing-roi.spec.ts 直接测试。
 */
export function computeIrrelevantRatio(
  pack: ContextPack,
  activeEntities: ContextEntity[],
): number {
  // 从 contextPack 字段提取候选 entity name（character/setting 类）。
  const candidateNames = new Set<string>()
  const fields = [pack.characterStates, pack.relatedSettings, pack.cognitionStates]
  for (const field of fields) {
    if (!field || typeof field !== "string") continue
    for (const line of field.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // 模式1："X知道：..." / "X不知道：..." / "X知晓：..."（cognitionStates 典型）
      // 注意：doesNotKnow 模式 "X不知道：" 必须先匹配（否则 knows 正则的 `(.+?)`
      // 会贪婪捕获 "X不" 作 name 污染候选集）。`[^不\n]+?` 排除 "不" 前缀。
      const doesNotKnowMatch = trimmed.match(/^([^不\n]+?)不知道[了了]?[：:]/)
      if (doesNotKnowMatch && doesNotKnowMatch[1]) {
        const name = doesNotKnowMatch[1].trim()
        if (name.length >= 1 && name.length <= 20) candidateNames.add(name)
        continue
      }
      const cognitionMatch = trimmed.match(/^([^不\n]+?)知道[了了]?[：:]/)
      if (cognitionMatch && cognitionMatch[1]) {
        const name = cognitionMatch[1].trim()
        if (name.length >= 1 && name.length <= 20) candidateNames.add(name)
        continue
      }
      // 模式2：行首短名词（characterStates / relatedSettings 列表项 "- Alice：..."）
      const listItemMatch = trimmed.match(/^[-*]?\s*([^\s：:、，,]{1,20})[：:]/)
      if (listItemMatch && listItemMatch[1]) {
        candidateNames.add(listItemMatch[1].trim())
      }
    }
  }
  if (candidateNames.size === 0) return 0 // 无候选 → 0（无法判定无关占比）

  // activeEntities name 集合（路由筛选出的相关 entity）。
  const activeNames = new Set(
    activeEntities.map((e) => e.name).filter((n) => n.length > 0),
  )
  if (activeNames.size === 0) {
    // 零 active entity（路由降级全量或 disabled）→ 全部候选视为无关。
    return 1
  }

  // 统计未被 activeEntities 覆盖的候选占比 = irrelevantRatio。
  let irrelevantCount = 0
  for (const name of candidateNames) {
    if (!activeNames.has(name)) irrelevantCount += 1
  }
  return irrelevantCount / candidateNames.size
}

export async function searchRelevantContent(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
  options: BuildContextOptions = {},
): Promise<string> {
  const tokens = tokenizeQuery(task)
  const entityHints = tokens.filter(t => t.length >= 2).slice(0, 5)
  const queryParts = [task]
  if (chapterNumber) {
    queryParts.push(`第${chapterNumber}章`)
  }
  if (entityHints.length > 0) {
    queryParts.push(entityHints.join(" "), "伏笔", "人物", "设定", "时间线")
  } else {
    queryParts.push("伏笔", "人物", "设定")
  }
  const query = queryParts.join(" ")

  const [keywordResults, indexResults, vectorResults] = await Promise.all([
    searchWiki(pp, query).catch(() => []),
    searchWiki(pp, `关键词索引 向量索引 ${task}`).catch(() => []),
    runVectorSearchForContext(pp, query, limit, options).catch(() => []), /* v8 ignore start */ /* v8 ignore stop */
  ])

  const seen = new Set<string>()
  const merged: string[] = []

  const add = (title: string, snippet: string) => {
    const key = `${title}|${snippet.slice(0, 50)}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(`- ${title}: ${snippet}`)
    }
  }

  const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
  const boostEntities = [...(options.entityNames ?? []), ...entityHints]
  type Hit = { title: string; snippet: string }
  let hits: Hit[] = [
    ...keywordResults.slice(0, limit).map((r) => ({ title: r.title, snippet: r.snippet ?? "" })),
    ...indexResults.slice(0, limit).map((r) => ({ title: r.title, snippet: r.snippet ?? "" })),
    ...vectorResults.slice(0, limit).map((r) => ({ title: r.title, snippet: r.snippet })),
  ]
  if (novelConfig.entityBoostEnabled) {
    hits = reorderByEntityBoost(hits, boostEntities, novelConfig.entityBoostWeight ?? 0.4)
  }
  for (const r of hits) {
    add(r.title, r.snippet)
  }

  return merged.slice(0, Math.max(limit, limit * 2)).join("\n")
}

export async function searchRelevantContentUnified(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
  options: BuildContextOptions = {},
): Promise<string> {
  const tokens = tokenizeQuery(task)
  const entityHints = tokens.filter((t) => t.length >= 2).slice(0, 5)
  const queryParts = [task]
  if (chapterNumber) {
    queryParts.push(`chapter ${chapterNumber}`)
  }
  if (entityHints.length > 0) {
    queryParts.push(entityHints.join(" "), "伏笔", "人物", "设定", "时间线")
  } else {
    queryParts.push("伏笔", "人物", "设定")
  }
  const query = queryParts.join(" ")

  // E-02 (C-3/C-10): 双轨编排 flag 前置读取（同步 store 读，无行为变更）。
  const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
  const [semanticResults, indexResults, vectorResults] = await Promise.all([
    (async (): Promise<NovelSearchResult[]> => {
      if (novelConfig.dualKbRoutingEnabled) {
        // E-02 (C-3): 写作路径经 dual-track 编排 — canon 不参与 RRF 排名。
        // 本层不传 povCharacter → 通道 A 空（通道 A 由 buildContextPackUnlocked
        // 第四源承载，避免二次 load）；只消费通道 B（includeCanon:false）。
        const dual = await retrieveDualTrack({
          projectPath: pp,
          query,
          chapterNumber,
          topK: Math.max(limit * 2, 6),
        }).catch(() => null)
        return dual ? dual.ranked : []
      }
      return novelMixedSearch({
        projectPath: pp,
        query,
        chapterNumber,
        topK: Math.max(limit * 2, 6),
        authoritativeOnly: true,
        includeKeyword: true,
        includeVector: true,
        includeGraph: true,
        includeRecentChapters: true,
        includeCanon: true,
      }).catch(() => [])
    })(),
    searchWiki(pp, `关键词索引 向量索引 ${task}`, {
      rerank: true,
      topK: Math.max(limit, 4),
      rerankPurpose: "用于补充剧情上下文中的索引和记忆条目。",
    }).catch(() => []),
    runVectorSearchForContext(pp, query, limit, options).catch(() => []), /* v8 ignore start */ /* v8 ignore stop */
  ])

  const candidates = [
    ...semanticResults.map((result) => ({
      id: `${result.type}:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: result.type,
    })),
    ...indexResults.map((result) => ({
      id: `index:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: "index",
    })),
    ...vectorResults.map((result, index) => ({
      id: `vector-context:${index}:${result.title}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "", /* v8 ignore start */ /* v8 ignore stop */
      source: "vector_context",
    })),
  ].filter((item) => {
    const path = typeof (item as { path?: unknown }).path === "string"
      ? (item as { path?: string }).path ?? "" /* v8 ignore start */ /* v8 ignore stop */
      : ""
    /* v8 ignore next */
    const snippet = item.snippet ?? ""
    if (!snippet || !path || isHistoricalProjectionSnippet(path, snippet)) return false
    return isAuthoritativeGenerationPath(path)
  })

  // PERF (odyssey-review): dedupe candidates by path before rerank. The three
  // sources (semantic > index > vector) can return the same path with different
  // ids/titles; keeping only the first-seen (source-priority order) avoids
  // wasting rerank scoring budget on cross-source duplicates.
  const dedupedCandidates = (() => {
    const seenPaths = new Set<string>()
    return candidates.filter((item) => {
      const p = item.path
      if (seenPaths.has(p)) return false
      seenPaths.add(p)
      return true
    })
  })()

  const rerankStartedAt = Date.now()
  const budgetLedger = getRetrievalBudgetLedger()
  // R0-d：回退策略为“保留原候选”（每次调用传 ctx，共享账本不持调用级数据）。
  budgetLedger.ensureRollback(
    RETRIEVAL_BUDGET_PATHS.contextRerank,
    (ctx: typeof candidates) => ctx,
  )
  const reranked = await rerankCandidates(query, dedupedCandidates, {
    topK: Math.max(limit * 2, limit),
    purpose: "用于构建小说写作上下文，优先保留最能支撑当前章节任务的记忆、设定、伏笔和正史约束。",
  }).catch(() => {
    // R0-d：LLM rerank 失败/超时→回退原始候选（字节级语义不变）；账本记账实测耗时。
    budgetLedger.check(RETRIEVAL_BUDGET_PATHS.contextRerank, Date.now() - rerankStartedAt)
    return budgetLedger.rollback<typeof candidates, typeof candidates>(
      RETRIEVAL_BUDGET_PATHS.contextRerank,
      candidates,
    )
  })

  // E-02 (C-7): 写作特化 usefulness rerank（flag 门控，默认 false → 现状排序）。
  // canon_consistency 否决制（冲突候选剔除，不加权平均）；置于 rerankCandidates 之后。
  const usefulnessOrdered = novelConfig.usefulnessRerankEnabled
    ? reorderByUsefulness(reranked, { entityHints, chapterNumber })
    : reranked

  // Quality Foundation v1: additive entity boost after LLM/heuristic rerank (flag-off = no-op).
  const boostEntities = [
    ...(options.entityNames ?? []),
    ...entityHints,
  ]
  const ordered =
    novelConfig.entityBoostEnabled
      ? reorderByEntityBoost(
          usefulnessOrdered.map((r) => ({
            title: r.title,
            snippet: r.snippet ?? "",
            path: (r as { path?: string }).path,
            id: (r as { id?: string }).id,
          })),
          boostEntities,
          novelConfig.entityBoostWeight ?? 0.4,
        )
      : usefulnessOrdered.map((r) => ({
          title: r.title,
          snippet: r.snippet ?? "",
        }))

  const merged: string[] = []
  const seen = new Set<string>()
  for (const result of ordered) {
    /* v8 ignore next */
    const key = `${result.title}|${(result.snippet ?? "").slice(0, 50)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(`- ${result.title}: ${result.snippet}`)
  }

  return merged.slice(0, Math.max(limit * 2, limit)).join("\n")
}

/**
 * P1-IMP-14: 薄包装（签名零变化，调用点 :1932/:2018 字节级不变）。
 *
 * 公共流程（fetch / sanitize / 并行 probe / 标题与 snippet 口径 / 外层降级 []）
 * 已收一到 vector-search-core.runVectorSearchShared。本侧保留两处真实差异：
 *   1. IC-02 相关性门控 + ContextGap 记账 —— 经 selectCandidates 回调在调用侧完成
 *      （vector-relevance / gap 记账不下沉到共享核心），位置与改前一致：
 *      fetch 空判之后、probe 循环之前。
 *   2. 无逐条异常守卫（perItemGuard 缺省 false）—— 单条 throw 仍冒泡外层 catch → 整批 []。
 * P1-IMP-14: 导出仅供 vector-search-parity.spec 与检索侧孪生对拍；
 * 既有调用点（:1972 / :2058）一字未动，签名零变化。
 */
export async function runVectorSearchForContext(
  pp: string,
  query: string,
  limit: number,
  options: BuildContextOptions = {},
): Promise<{ title: string; snippet: string; path: string }[]> {
  const hits = await runVectorSearchShared({
    pp,
    query,
    limit,
    // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（解析在共享核心内）。
    embCfg: options.embeddingConfig,
    selectCandidates: (results, n) => {
      // IC-02: 向量结果按 0.45 相关性门控，低于阈值的视为噪音不进入包装/候选池。
      // 取 matchedChunks 真实命中分（fallback result.score）。被过滤结果记 ContextGap
      // （type=truncated / reason=tier_compressible），不静默降级。
      // (backport from Mochocyang/QMAI v3.0.1 xiangliangzaoyinzhili)
      const gatedVectorResults = selectRelevantNovelVectorResults(results, n)
      if (gapsActive && gapSink && results.length - gatedVectorResults.length > 0) {
        gapSink.push({
          type: "truncated",
          ref: "vector-context",
          reason: "tier_compressible",
          originalLength: results.length,
          retainedLength: gatedVectorResults.length,
        })
      }
      return gatedVectorResults
    },
  })
  // 投影顺序与改前 probePath 返回对象一致（title, snippet, path）。
  return hits.map((hit) => ({ title: hit.title, snippet: hit.snippet, path: hit.path }))
}

export async function searchGraphRelevantContent(
  pp: string,
  task: string,
  _chapterNumber: number | undefined,
): Promise<string> {
  try {
    const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
    const graph = await buildRetrievalGraph(pp)
    if (graph.nodes.size === 0) return ""

    const tokens = tokenizeQuery(task)
    // PERF-004 (ISS-011): two-phase candidate collection — Phase 1 seeds
    // from query tokens, Phase 2 expands by scanning graph nodes ONCE into
    // a SEPARATE `nextNames` Set (do NOT mutate candidateNames during
    // iteration — Set mutation during for...of is a correctness hazard and
    // can skip nodes depending on insertion order).
    const candidateNames = new Set<string>()
    for (const token of tokens) {
      if (token.length >= 2) candidateNames.add(token)
    }

    const nextNames = new Set<string>()
    // Snapshot the seed set so expansion never reads a mutating collection.
    const seedNames = Array.from(candidateNames)
    for (const [, node] of graph.nodes) {
      // CORR-110: guard against empty/short titles polluting the candidate set.
      // `task.includes('')` is ALWAYS true (empty string is a substring of every
      // string), so a malformed entity page with an empty title would match
      // every task and pull in every empty-titled node. Apply the same
      // `length >= 2` minimum the token-seed path (line ~1083) uses.
      if (node.title.length >= 2 && task.includes(node.title)) {
        nextNames.add(node.title)
        nextNames.add(node.id)
      } else if (node.id.length >= 2 && task.includes(node.id)) {
        nextNames.add(node.title)
        nextNames.add(node.id)
      }
      for (let i = 0; i < seedNames.length; i++) {
        const name = seedNames[i]
        if (node.title.includes(name) || node.id.includes(name)) {
          nextNames.add(node.title)
          nextNames.add(node.id)
          break
        }
      }
    }
    const allNames = [...candidateNames, ...nextNames]

    // PERF-004 (ISS-011): SINGLE-PASS match collection — iterate graph.nodes
    // once, matching against ALL candidate names, dedup by node id. Replaces
    // the per-name full-graph rescan (was O(names × nodes), now O(nodes)).
    const seenIds = new Set<string>()
    const scoredNodes: { title: string; snippet: string; relevance: number }[] = []
    const matchedNodes = []
    for (const [, node] of graph.nodes) {
      if (allNames.some((name) => node.title.includes(name) || node.id.includes(name))) {
        /* v8 ignore next */
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id)
          matchedNodes.push(node)
        }
      }
    }

    // PERF-NEW-02: collect all unseen related-node reads first (dedup against
    // seenIds), then read them in parallel. The prior nested for...of awaited
    // readFile serially (up to M×5 sequential IPC round-trips). Each matched
    // node's related set is independent, so the reads parallelize cleanly.
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
            snippet: content.slice(0, 300).replace(/\n/g, " "),
            relevance: Math.round(entry.relevance * 100) / 100,
          }
        } catch {
          logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 2433 })
          return null
        }
      }),
    )
    for (const r of readResults) {
      if (r) scoredNodes.push(r)
    }

    scoredNodes.sort((a, b) => b.relevance - a.relevance)
    const topNodes = await rerankCandidates(
      task,
      scoredNodes.slice(0, 10).map((node, index) => ({
        id: `graph:${index}:${node.title}`,
        title: node.title,
        snippet: node.snippet,
        source: "graph_context",
        relevance: node.relevance,
      })),
      {
        topK: 10,
        purpose: "用于补充图谱关联上下文，优先保留和当前任务最直接相关的关联节点。",
      },
    ).catch(() => scoredNodes.slice(0, 10))

    const nodeResults = topNodes.length > 0
      ? topNodes.map(
          n => `- 【${n.title}】(关联度 ${n.relevance}): ${n.snippet}`,
        ).join("\n")
      : ""

    // 追加社区摘要向量检索
    let communityResults = ""
    try {
      const { searchCommunitySummaries } = await import("./community-summary")
      communityResults = await searchCommunitySummaries(pp, task, 3)
    } catch {
      // 社区摘要检索失败不影响主流程
    }

    return [nodeResults, communityResults].filter(Boolean).join("\n")
  } catch {
    logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 2474 })
    return ""
  }
}
