/**
 * v2 embedding 通道降级 stub。
 *
 * v2 无向量数据库/embedding 通道，story-simulation 的节点目标达成判定
 * 依赖 embedding 相似度。此处 embed 抛错，simulation-engine 已内置
 * "embedding 判定失败 → 降级为启发式判定" 分支（isNodeGoalReached），
 * 语义与 v3 一致，仅判定强度从向量相似度降为关键词启发式。
 */
export async function embed(_text: string, _llmConfig?: unknown): Promise<number[]> {
  throw new Error("embedding-client 不可用（v2 无向量通道），降级为启发式判定")
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0)
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0))
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0))
  if (normA === 0 || normB === 0) return 0
  return dot / (normA * normB)
}
