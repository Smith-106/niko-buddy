import type { PageSearchResult } from "@/lib/embedding"

/**
 * 向量检索相关性门控 (backport from Mochocyang/QMAI v3.0.1 xiangliangzaoyinzhili).
 *
 * 低于 NOVEL_VECTOR_MIN_MATCH_SCORE 的向量结果视为噪音，在进入 rerank 候选池前过滤。
 * 取 matchedChunks 真实命中分（fallback result.score），避免 page-head 默认分误导。
 * 与 fork IC-02 对齐：被过滤的结果由 context-engine 记 ContextGap，不静默降级。
 */
export const NOVEL_VECTOR_MIN_MATCH_SCORE = 0.45

export function getNovelVectorMatchScore(result: PageSearchResult): number {
  const chunkScores = result.matchedChunks?.map((chunk) => chunk.score) ?? []
  return chunkScores.length > 0 ? Math.max(...chunkScores) : result.score
}

export function selectRelevantNovelVectorResults(
  results: PageSearchResult[],
  topK: number,
): PageSearchResult[] {
  if (topK <= 0) return []
  return results
    .filter((result) => getNovelVectorMatchScore(result) >= NOVEL_VECTOR_MIN_MATCH_SCORE)
    .slice(0, topK)
}

export function buildNovelVectorSnippet(
  result: PageSearchResult,
  maxChars: number = 800,
): string {
  if (maxChars <= 0) return ""

  const snippet = (result.matchedChunks ?? [])
    .filter((chunk) => chunk.score >= NOVEL_VECTOR_MIN_MATCH_SCORE)
    .slice(0, 2)
    .map((chunk) => {
      const text = chunk.text.replace(/\s+/g, " ").trim()
      const heading = chunk.headingPath.replace(/\s+/g, " ").trim()
      return heading ? `${heading}: ${text}` : text
    })
    .filter(Boolean)
    .join("\n")

  return snippet.slice(0, maxChars)
}
