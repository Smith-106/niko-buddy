// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"

export interface NeighborhoodOptions {
  focusId: string
  /** 跳数，只支持 1 或 2，默认 1 */
  depth?: number
  /** 每个节点展开时保留的最强邻居数，默认 40 */
  maxNeighborsPerNode?: number
  /** 子图节点总数上限（BFS 顺序截断），默认 150 */
  maxTotalNodes?: number
}

export interface NeighborhoodResult {
  focusId: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 每个已展开节点被收起的弱连接数（>0 才记录） */
  omittedNeighborCounts: Record<string, number>
  /** 因按节点上限收起的边数 */
  omittedEdgeCount: number
  /** 是否触发了总数上限截断 */
  truncated: boolean
}

const DEFAULT_DEPTH = 1
const DEFAULT_MAX_NEIGHBORS_PER_NODE = 40
const DEFAULT_MAX_TOTAL_NODES = 150

/** 默认焦点：连接最多的节点（通常是主角），没有节点时返回 null */
export function pickDefaultFocus(nodes: readonly GraphNode[]): GraphNode | null {
  let best: GraphNode | null = null
  for (const node of nodes) {
    if (!best || node.linkCount > best.linkCount) best = node
  }
  return best
}

function clampDepth(depth: number | undefined): number {
  if (!Number.isFinite(depth ?? NaN)) return DEFAULT_DEPTH
  return Math.max(1, Math.min(2, Math.floor(depth as number)))
}

export function extractNeighborhood(
  allNodes: readonly GraphNode[],
  allEdges: readonly GraphEdge[],
  options: NeighborhoodOptions,
): NeighborhoodResult {
  const depth = clampDepth(options.depth)
  const maxNeighborsPerNode = Math.max(
    1,
    Math.floor(options.maxNeighborsPerNode ?? DEFAULT_MAX_NEIGHBORS_PER_NODE),
  )
  const maxTotalNodes = Math.max(
    2,
    Math.floor(options.maxTotalNodes ?? DEFAULT_MAX_TOTAL_NODES),
  )

  const empty: NeighborhoodResult = {
    focusId: options.focusId,
    depth,
    nodes: [],
    edges: [],
    omittedNeighborCounts: {},
    omittedEdgeCount: 0,
    truncated: false,
  }

  const nodeById = new Map(allNodes.map((node) => [node.id, node]))
  if (!nodeById.has(options.focusId)) return empty

  const adjacency = new Map<string, { to: string; weight: number }[]>()
  for (const edge of allEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
    if (edge.source === edge.target) continue
    const forward = adjacency.get(edge.source) ?? []
    forward.push({ to: edge.target, weight: edge.weight })
    adjacency.set(edge.source, forward)
    const backward = adjacency.get(edge.target) ?? []
    backward.push({ to: edge.source, weight: edge.weight })
    adjacency.set(edge.target, backward)
  }

  const rankNeighbor = (nodeId: string) => nodeById.get(nodeId)?.linkCount ?? 0
  const sortedNeighbors = (nodeId: string): string[] => {
    const seen = new Set<string>()
    return (adjacency.get(nodeId) ?? [])
      .filter((entry) => {
        if (entry.to === nodeId || seen.has(entry.to)) return false
        seen.add(entry.to)
        return true
      })
      .sort(
        (a, b) =>
          b.weight - a.weight || rankNeighbor(b.to) - rankNeighbor(a.to) || (a.to < b.to ? -1 : 1),
      )
      .map((entry) => entry.to)
  }

  // BFS：visited 顺序即展示优先级（先焦点，再近跳，再强连接）
  const visited: string[] = [options.focusId]
  const visitedSet = new Set<string>([options.focusId])
  const queue: { id: string; depth: number }[] = [{ id: options.focusId, depth: 0 }]
  const omittedNeighborCounts: Record<string, number> = {}
  let omittedEdgeCount = 0

  while (queue.length > 0) {
    const current = queue.shift() as { id: string; depth: number }
    if (current.depth >= depth) continue
    const neighbors = sortedNeighbors(current.id)
    const kept = neighbors.slice(0, maxNeighborsPerNode)
    const cut = neighbors.length - kept.length
    if (cut > 0) {
      omittedNeighborCounts[current.id] = cut
      omittedEdgeCount += cut
    }
    for (const neighborId of kept) {
      if (visitedSet.has(neighborId)) continue
      visitedSet.add(neighborId)
      visited.push(neighborId)
      queue.push({ id: neighborId, depth: current.depth + 1 })
    }
  }

  let truncated = false
  let includedIds = visited
  if (visited.length > maxTotalNodes) {
    truncated = true
    includedIds = visited.slice(0, maxTotalNodes)
  }
  const includedSet = new Set(includedIds)
  const nodes = includedIds
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => node !== undefined)
  const edges = allEdges.filter((edge) => includedSet.has(edge.source) && includedSet.has(edge.target))

  return {
    focusId: options.focusId,
    depth,
    nodes,
    edges,
    omittedNeighborCounts,
    omittedEdgeCount,
    truncated,
  }
}
