import { describe, expect, it } from "vitest"
import type { ForceAtlas2Settings } from "graphology-layout-forceatlas2"
import { computeForceAtlas2Positions } from "./graph-layout-engine"
import { GRAPH_LAYOUT_ITERATIONS, GRAPH_LAYOUT_PRESETS } from "./graph-layout"

/**
 * FA2 社区聚类对比证据（#82）：合成小说型社区图谱上，community 预设 vs 默认参数。
 *
 * 基准图谱特征（模拟真实小说图谱）：
 * - 社区内环形 lattice + 社区 hub（话事人/大家族核心）
 * - 跨社区噪声边（人物跨章节、跨故事线互动）
 * - hub300 另含主角 hub（60% 全节点直连，模拟主角无处不在）
 * 度量：ground-truth 标签的平均 silhouette（越高=社区视觉可分性越好）。
 * 调用与线上完全一致：220 iterations、>50 节点开 barnesHut、圆形初始坐标。
 * RNG 为基准内局部种子，保证跨次运行确定性。
 */

interface BenchNode {
  id: string
  x: number
  y: number
  size: number
  community: number
}

interface BenchEdge {
  source: string
  target: string
  weight: number
}

/** 确定性 LCG：每个基准独立实例，避免候选顺序互相污染。 */
function makeRand(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function circleInit(nodes: BenchNode[]): void {
  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2
    node.x = Math.cos(angle) * 100
    node.y = Math.sin(angle) * 100
  })
}

function buildLattice(nodes: BenchNode[], edges: BenchEdge[], communities: number, per: number): void {
  for (let c = 0; c < communities; c++) {
    for (let i = 0; i < per; i++) {
      nodes.push({ id: `c${c}-n${i}`, x: 0, y: 0, size: 6, community: c })
    }
    for (let i = 0; i < per; i++) {
      for (const d of [1, 2]) {
        edges.push({ source: `c${c}-n${i}`, target: `c${c}-n${(i + d) % per}`, weight: 2 })
      }
    }
    for (let i = 1; i < per; i++) {
      edges.push({ source: `c${c}-n0`, target: `c${c}-n${i}`, weight: 3 })
    }
  }
}

function addCrossEdges(
  rand: () => number,
  nodes: BenchNode[],
  edges: BenchEdge[],
  count: number,
): void {
  const ids = nodes.map((n) => n.id)
  const communityOf = new Map(nodes.map((n) => [n.id, n.community]))
  let added = 0
  let guard = 0
  while (added < count && guard++ < count * 100) {
    const a = ids[Math.floor(rand() * ids.length)]
    const b = ids[Math.floor(rand() * ids.length)]
    if (a !== b && communityOf.get(a) !== communityOf.get(b)) {
      edges.push({ source: a, target: b, weight: 1 })
      added++
    }
  }
}

/** 120 节点：3 社区 + 60 条跨社区噪声边。 */
function buildNoisy120(): { nodes: BenchNode[]; edges: BenchEdge[] } {
  const nodes: BenchNode[] = []
  const edges: BenchEdge[] = []
  buildLattice(nodes, edges, 3, 40)
  addCrossEdges(makeRand(42), nodes, edges, 60)
  circleInit(nodes)
  return { nodes, edges }
}

/** 301 节点：3×100 + 150 条噪声边 + 主角 hub（验收带上沿）。 */
function buildHub300(): { nodes: BenchNode[]; edges: BenchEdge[] } {
  const rand = makeRand(1234)
  const nodes: BenchNode[] = []
  const edges: BenchEdge[] = []
  buildLattice(nodes, edges, 3, 100)
  addCrossEdges(rand, nodes, edges, 150)
  nodes.push({ id: "protagonist", x: 0, y: 0, size: 10, community: -1 })
  for (const node of nodes) {
    if (node.id !== "protagonist" && rand() < 0.6) {
      edges.push({ source: "protagonist", target: node.id, weight: 2 })
    }
  }
  circleInit(nodes)
  return { nodes, edges }
}

function meanSilhouette(
  nodes: BenchNode[],
  positions: Record<string, { x: number; y: number }>,
): number {
  // 主角 hub 不参与评分（它本就横跨所有社区）
  const members = nodes.filter((n) => n.community >= 0)
  const byCommunity = new Map<number, string[]>()
  for (const node of members) {
    if (!byCommunity.has(node.community)) byCommunity.set(node.community, [])
    byCommunity.get(node.community)!.push(node.id)
  }
  const dist = (a: string, b: string): number =>
    Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y)
  let sum = 0
  for (const node of members) {
    const own = byCommunity.get(node.community)!.filter((id) => id !== node.id)
    const a = own.reduce((s, id) => s + dist(node.id, id), 0) / own.length
    let b = Infinity
    for (const [community, ids] of byCommunity) {
      if (community === node.community) continue
      const mean = ids.reduce((s, id) => s + dist(node.id, id), 0) / ids.length
      if (mean < b) b = mean
    }
    sum += (b - a) / Math.max(a, b)
  }
  return sum / members.length
}

function runLayout(
  bench: { nodes: BenchNode[]; edges: BenchEdge[] },
  settings: ForceAtlas2Settings,
): number {
  const positions = computeForceAtlas2Positions({
    nodes: bench.nodes.map(({ id, x, y, size }) => ({ id, x, y, size })),
    edges: bench.edges,
    iterations: GRAPH_LAYOUT_ITERATIONS,
    settings,
    // 与线上一致：>50 节点开 Barnes-Hut
    barnesHutOptimize: bench.nodes.length > 50,
  })
  return meanSilhouette(bench.nodes, positions)
}

describe("graph-layout clustering evidence", () => {
  it("community 预设在 noisy120 上 silhouette 优于默认参数", () => {
    const tuned = runLayout(buildNoisy120(), { ...GRAPH_LAYOUT_PRESETS.community })
    const baseline = runLayout(buildNoisy120(), {})
    expect(tuned).toBeGreaterThan(baseline + 0.01)
    expect(tuned).toBeGreaterThanOrEqual(0.6)
  })

  it("community 预设在 hub300 上 silhouette 优于默认参数", () => {
    const tuned = runLayout(buildHub300(), { ...GRAPH_LAYOUT_PRESETS.community })
    const baseline = runLayout(buildHub300(), {})
    expect(tuned).toBeGreaterThan(baseline + 0.01)
    expect(tuned).toBeGreaterThanOrEqual(0.6)
  })
})
