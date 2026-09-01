// G3 (39 号修复): ForceAtlas2 布局纯函数引擎 — Web Worker 与主线程 fallback 共用。
// 逻辑等价于 graph-view.tsx 原 GraphLoader 内联块; 图对象不可 postMessage,
// 以节点/边数组序列化进出, 保证两条路径产出完全一致的坐标。
import Graph from "graphology"
import forceAtlas2, { type ForceAtlas2Settings } from "graphology-layout-forceatlas2"

export interface ForceAtlas2NodeInput {
  id: string
  x: number
  y: number
  /** 渲染尺寸; adjustSizes=true 时 FA2 依赖它做防碰撞 (缺省按 1 处理, 会改变布局) */
  size: number
}

export interface ForceAtlas2EdgeInput {
  source: string
  target: string
  weight: number
}

export interface ForceAtlas2LayoutInput {
  nodes: ForceAtlas2NodeInput[]
  edges: ForceAtlas2EdgeInput[]
  iterations: number
  settings: ForceAtlas2Settings
  barnesHutOptimize: boolean
}

export type NodePositions = Record<string, { x: number; y: number }>

export function computeForceAtlas2Positions(input: ForceAtlas2LayoutInput): NodePositions {
  const { nodes, edges, iterations, settings, barnesHutOptimize } = input

  const graph = new Graph()
  for (const node of nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y, size: node.size })
  }
  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
    const key = `${edge.source}->${edge.target}`
    if (!graph.hasEdge(key) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
      graph.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight })
    }
  }

  const inferred = forceAtlas2.inferSettings(graph)
  forceAtlas2.assign(graph, {
    iterations,
    settings: { ...inferred, ...settings, barnesHutOptimize },
  })

  const positions: NodePositions = {}
  graph.forEachNode((nodeId, attrs) => {
    positions[nodeId] = { x: attrs.x, y: attrs.y }
  })
  return positions
}
