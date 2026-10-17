/**
 * retrieval-source-pipeline.ts — 多源检索公共层（纯函数，纯搬迁零语义变更）
 *
 * 从 search-adapter.ts 抽出（巨文件拆分 / WS2 adapter 公共层收敛，
 * swarm ts-bloat-20261017 裁决）。仅承载与 adapter 编排无关的纯函数：
 * 源权重与 RRF 融合参数 / 单源超时包装 / 源内排名标注 / 去重代表选择。
 * 检索语义与阈值一字未改；search-adapter 仍是对外唯一入口。
 */
import { RETRIEVAL_SOURCE_TIMEOUT_MS } from "./retrieval-budget"
import type { NovelSearchResult } from "./search-adapter"

export type RankedNovelSearchResult = NovelSearchResult & {
  sourceRank: number
}
export const SOURCE_RRF_K_DEFAULT = 60
/** R0-d：单源封顶收编到 retrieval-budget（数值不变，2500ms）。 */
export const SEARCH_SOURCE_TIMEOUT_MS = RETRIEVAL_SOURCE_TIMEOUT_MS
export const SOURCE_WEIGHTS: Record<NovelSearchResult["type"], number> = {
  keyword: 1,
  vector: 1,
  graph: 0.95,
  canon: 0.9,
  recent_chapter: 0.75,
}

export const SOURCE_TIE_PRIORITY: Record<NovelSearchResult["type"], number> = {
  keyword: 0,
  vector: 1,
  graph: 2,
  canon: 3,
  recent_chapter: 4,
}

export function withTimeout<T>(
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

export function rankSourceResults(items: NovelSearchResult[]): RankedNovelSearchResult[] {
  return items.map((item, sourceRank) => ({ ...item, sourceRank }))
}

export function deduplicateResults(
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

export function normalizeResultPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

export function toPublicResult(result: NovelSearchResult): NovelSearchResult {
  return {
    type: result.type,
    path: result.path,
    title: result.title,
    snippet: result.snippet,
    relevance: result.relevance,
  }
}

export function shouldReplaceRepresentative(
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
