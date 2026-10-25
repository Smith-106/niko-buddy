// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// graph-search-shared.ts — P1 去孪生（ISS-20260709-038/039）：图检索孪生收敛 DRY。
//
// 收敛对象（行为等价，逐行对拍）：
//   - `context-retrieval.ts searchGraphRelevantContent`（检索簇唯一定义点）
//   - `search-adapter.ts runGraphSearch`（novelMixedSearch 图通道，私有）
// 两处此前各持一份逐字同构的孪生体：PERF-004 单遍 matched 扫描（seenIds 去重）
// + PERF-NEW-02 待读收集（related 去重并行 readFile + relevance 四舍五入）+ 按
// relevance 降序。本模块是该孪生体的唯一定义点；两侧只保留真实差异：
//   1. 查询归一化（tokenize 口径）：检索侧 `tokenizeQuery(task)` + CORR-110 空标题
//      守卫 + nextNames 两阶段扩展；adapter 侧 `split(/[\s,，。！？、]+/)` 小写包含
//      扩展——刻意不收敛（通道语义不同，见两侧注释），candidateNames 以入参传入。
//   2. 后处理：检索侧 rerankCandidates + `【title】(关联度)` 成文 + 社区摘要拼接；
//      adapter 侧截断 topK 映射 NovelSearchResult——保留在调用侧。
//   3. 读错观测：检索侧 logger.warn 留痕；adapter 侧静默 null——经 onReadError 注入。
//
// 依赖注入（getRelatedNodes/readFile 入参）而非模块内动态导入：保持本模块零 IO
// 导入 + 可单测（见 p1-iss-038-039-convergence.spec.ts），两侧动态导入点不动。

export interface GraphSearchNodeLike {
  id: string
  title: string
  path: string
}

export interface GraphLike<N extends GraphSearchNodeLike> {
  nodes: ReadonlyMap<string, N>
}

export interface GraphRelated<N extends GraphSearchNodeLike> {
  node: N
  relevance: number
}

export interface GraphScoredSnippet {
  title: string
  path: string
  snippet: string
  relevance: number
}

export interface GraphSnippetDeps<N extends GraphSearchNodeLike, G extends GraphLike<N>> {
  getRelatedNodes: (
    id: string,
    graph: G,
    depth: number,
  ) => readonly GraphRelated<N>[]
  readFile: (path: string) => Promise<string>
}

export interface GraphSnippetOptions {
  /** related 扩展深度（缺省 5，与两侧改前一致）。 */
  depth?: number
  /** 单条 readFile 失败观测（缺省静默 null；检索侧注入 logger.warn）。 */
  onReadError?: (entry: { title: string; path: string }, error: unknown) => void
  /** snippet 截断长度（缺省 300，与两侧改前一致）。 */
  snippetChars?: number
}

/**
 * PERF-004 单遍 matched 收集：遍历 graph.nodes 一次，用全部 candidateNames
 * 匹配（title/id includes 任一），按 node.id 去重。替换改前 per-name 全图
 * 重扫（O(names × nodes) → O(nodes)）。
 */
export function collectGraphMatchedNodes<N extends GraphSearchNodeLike>(
  graph: GraphLike<N>,
  candidateNames: readonly string[],
): { matched: N[]; seenIds: Set<string> } {
  const seenIds = new Set<string>()
  const matched: N[] = []
  for (const [, node] of graph.nodes) {
    if (candidateNames.some((name) => node.title.includes(name) || node.id.includes(name))) {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id)
        matched.push(node)
      }
    }
  }
  return { matched, seenIds }
}

/**
 * PERF-NEW-02 并行 related 片段收集：先收齐全部未见 related 节点读请求
 * （对 seenIds 去重），再并行 readFile；失败项按 onReadError 处理后丢弃。
 * 返回按 relevance 降序（与两侧改前 `scoredNodes.sort` 一致）。
 */
export async function readGraphRelatedSnippets<N extends GraphSearchNodeLike, G extends GraphLike<N>>(
  matched: N[],
  graph: G,
  seenIds: Set<string>,
  deps: GraphSnippetDeps<N, G>,
  options: GraphSnippetOptions = {},
): Promise<GraphScoredSnippet[]> {
  const depth = options.depth ?? 5
  const snippetChars = options.snippetChars ?? 300
  type PendingRead = { title: string; path: string; relevance: number }
  const pendingReads: PendingRead[] = []
  for (const matchedNode of matched) {
    const related = deps.getRelatedNodes(matchedNode.id, graph, depth)
    for (const { node, relevance } of related) {
      if (seenIds.has(node.id)) continue
      seenIds.add(node.id)
      pendingReads.push({ title: node.title, path: node.path, relevance })
    }
  }
  const readResults = await Promise.all(
    pendingReads.map(async (entry) => {
      try {
        const content = await deps.readFile(entry.path)
        return {
          title: entry.title,
          path: entry.path,
          snippet: content.slice(0, snippetChars).replace(/\n/g, " "),
          relevance: Math.round(entry.relevance * 100) / 100,
        }
      } catch (error) {
        options.onReadError?.({ title: entry.title, path: entry.path }, error)
        return null
      }
    }),
  )
  const scored: GraphScoredSnippet[] = []
  for (const r of readResults) {
    if (r) scored.push(r)
  }
  scored.sort((a, b) => b.relevance - a.relevance)
  return scored
}

/**
 * 孪生体一站式：matched 单遍收集 + related 并行片段 + 降序。两侧调用侧只做
 * 查询归一化（candidateNames 构造）与后处理（rerank/成文/截断映射）。
 */
export async function collectGraphScoredSnippets<N extends GraphSearchNodeLike, G extends GraphLike<N>>(
  graph: G,
  candidateNames: readonly string[],
  deps: GraphSnippetDeps<N, G>,
  options: GraphSnippetOptions = {},
): Promise<GraphScoredSnippet[]> {
  const { matched, seenIds } = collectGraphMatchedNodes(graph, candidateNames)
  return readGraphRelatedSnippets(matched, graph, seenIds, deps, options)
}
