/**
 * @license MIT © QMAI
 *
 * Graph analysis utilities for discovering surprising connections
 * and knowledge gaps in the wiki knowledge graph.
 */
import type { GraphNode, GraphEdge, CommunityInfo } from "./wiki-graph"

const TYPE_LABELS: Record<string, string> = {
  character: "角色", location: "地点", organization: "组织",
  item: "物品", event: "事件", chapter: "章节", outline: "大纲",
  foreshadowing: "伏笔", secret: "秘密", conflict: "冲突",
  "timeline-point": "时间点", "canon-rule": "正史规则",
  source: "素材", concept: "概念", entity: "实体",
  query: "问答记录", synthesis: "综合整理", overview: "总览",
  comparison: "对比", other: "其他",
}

// v8 ignore next -- typeLabel only called with distant-pair types, all present in TYPE_LABELS
function typeLabel(t: string): string { return TYPE_LABELS[t] ?? t }

function formatNodeList(nodes: GraphNode[], total: number): string {
  const labels = nodes.map((n) => n.label).join("、")
  return total > nodes.length ? `${labels}，以及另外 ${total - nodes.length} 个页面` : labels
}

// ── Types ──────────────────────────────────────────────────────────

export interface SurprisingConnection {
  source: GraphNode
  target: GraphNode
  score: number
  reasons: string[]
  key: string
}

export interface KnowledgeGap {
  type: "isolated-node" | "sparse-community" | "bridge-node"
  title: string
  description: string
  nodeIds: string[]
  suggestion: string
}

// ── Surprising Connections ─────────────────────────────────────────

/**
 * Identify edges that connect nodes across communities, types, or
 * degree classes — scoring each by structural "surprise" signals.
 */
export function findSurprisingConnections(
  nodes: GraphNode[],
  edges: GraphEdge[],
  _communities: CommunityInfo[],
  limit: number = 5,
): SurprisingConnection[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const degreeMap = new Map(nodes.map((n) => [n.id, n.linkCount]))
  const maxDegree = Math.max(...nodes.map((n) => n.linkCount), 1)
  const structuralIds = new Set(["index", "log", "overview"])

  const scored: SurprisingConnection[] = []

  for (const edge of edges) {
    const src = nodeMap.get(edge.source)
    const tgt = nodeMap.get(edge.target)
    if (!src || !tgt) continue
    if (structuralIds.has(src.id) || structuralIds.has(tgt.id)) continue

    let score = 0
    const reasons: string[] = []

    // Cross-community
    if (src.community !== tgt.community) {
      score += 3
      reasons.push("跨社群关联")
    }

    // Cross-type (distant pairs score higher)
    if (src.type !== tgt.type) {
      const distant = new Set([
        "source-concept", "concept-source",
        "source-synthesis", "synthesis-source",
        "query-entity", "entity-query",
      ])
      const pair = `${src.type}-${tgt.type}`
      if (distant.has(pair)) {
        score += 2
        reasons.push(`${typeLabel(src.type)}连接到${typeLabel(tgt.type)}`)
      } else {
        score += 1
        reasons.push("不同类型节点相连")
      }
    }

    // Peripheral-to-hub
    // v8 ignore next -- degreeMap seeded from the same node set; lookup never undefined
    const srcDeg = degreeMap.get(src.id) ?? 0
    // v8 ignore next -- degreeMap seeded from the same node set; lookup never undefined
    const tgtDeg = degreeMap.get(tgt.id) ?? 0
    if (Math.min(srcDeg, tgtDeg) <= 2 && Math.max(srcDeg, tgtDeg) >= maxDegree * 0.5) {
      score += 2
      reasons.push("边缘节点连接到核心节点")
    }

    // Low-weight edge
    if (edge.weight < 2 && edge.weight > 0) {
      score += 1
      reasons.push("弱关联但已形成连接")
    }

    if (score >= 3 && reasons.length > 0) {
      const key = [src.id, tgt.id].sort().join(":::")
      scored.push({ source: src, target: tgt, score, reasons, key })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ── Knowledge Gaps ─────────────────────────────────────────────────

/**
 * Detect structural knowledge gaps: isolated nodes, sparse
 * communities, and bridge nodes connecting multiple clusters.
 */
export function detectKnowledgeGaps(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: CommunityInfo[],
  limit: number = 8,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // 1. Isolated nodes (degree ≤ 1)
  const isolated = nodes.filter(
    (n) => n.linkCount <= 1 && n.type !== "overview" && n.id !== "index" && n.id !== "log",
  )
  if (isolated.length > 0) {
    const top = isolated.slice(0, 5)
    gaps.push({
      type: "isolated-node",
      title: `${isolated.length} 个孤立页面`,
      description: formatNodeList(top, isolated.length),
      nodeIds: isolated.map((n) => n.id),
      suggestion: "这些页面关联较少或暂无关联。建议添加 [[双链]] 连接到相关页面，或通过深度研究补充内容。",
    })
  }

  // 2. Sparse communities
  for (const comm of communities) {
    if (comm.cohesion < 0.15 && comm.nodeCount >= 3) {
      gaps.push({
        type: "sparse-community",
        title: `稀疏簇：${comm.topNodes[0] ?? `社群 ${comm.id}`}`,
        description: `${comm.nodeCount} 个页面，凝聚度 ${comm.cohesion.toFixed(2)}，内部连接偏弱。`,
        nodeIds: nodes.filter((n) => n.community === comm.id).map((n) => n.id),
        suggestion: "该知识区域缺少内部交叉引用。建议在这些页面之间添加链接，或通过研究补足设定缺口。",
      })
    }
  }

  // 3. Bridge nodes (connected to ≥ 3 communities)
  const structuralIds = new Set(["index", "log", "overview"])
  const communityAdj = new Map<string, Set<number>>()
  for (const node of nodes) communityAdj.set(node.id, new Set())
  for (const edge of edges) {
    const s = nodeMap.get(edge.source)
    const t = nodeMap.get(edge.target)
    if (s && t) {
      communityAdj.get(edge.source)?.add(t.community)
      communityAdj.get(edge.target)?.add(s.community)
    }
  }

  const bridges = nodes
    .filter(/* v8 ignore next -- communityAdj pre-seeded for every node; lookup never undefined */(n) => !structuralIds.has(n.id) && (communityAdj.get(n.id)?.size ?? 0) >= 3)
    .sort(/* v8 ignore next -- communityAdj pre-seeded for every node; lookup never undefined */(a, b) => (communityAdj.get(b.id)?.size ?? 0) - (communityAdj.get(a.id)?.size ?? 0))
    .slice(0, 3)

  for (const bridge of bridges) {
    // v8 ignore next -- bridge comes from filtered nodes; communityAdj lookup never undefined
    const commCount = communityAdj.get(bridge.id)?.size ?? 0
    gaps.push({
      type: "bridge-node",
      title: `关键桥梁：${bridge.label}`,
      description: `连接 ${commCount} 个不同知识簇，是当前图谱中的关键交汇点。`,
      nodeIds: [bridge.id],
      suggestion: "该页面连接多个知识区域。建议持续维护；如果内容较薄，扩写它会增强整个小说图谱。",
    })
  }

  return gaps.slice(0, limit)
}
