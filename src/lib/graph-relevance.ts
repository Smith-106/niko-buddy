/**
 * @license MIT © QMAI
 *
 * Retrieval graph — builds an in-memory graph from wiki pages and
 * computes relevance scores for context retrieval.
 */
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { NOVEL_RELATION_LABELS } from "@/lib/novel/graph-adapter"

// ── Types ──────────────────────────────────────────────────────────

/** Typed outgoing edge with relation label. */
export interface RelationEdge {
  readonly target: string
  readonly relation: string
}

export interface RetrievalNode {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly path: string
  readonly sources: readonly string[]
  readonly outLinks: ReadonlySet<string>
  readonly inLinks: ReadonlySet<string>
  readonly relationEdges: readonly RelationEdge[]
}

export interface RetrievalGraph {
  readonly nodes: ReadonlyMap<string, RetrievalNode>
  readonly dataVersion: number
}

// ── Constants ──────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

const W = {
  directLink: 3.0,
  sourceOverlap: 4.0,
  commonNeighbor: 1.5,
  typeAffinity: 1.0,
  relationTypeMatch: 1.5,
} as const

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity:    { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0, query: 0.8 },
  concept:   { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2, query: 1.0 },
  source:    { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, synthesis: 1.0 },
  query:     { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8, query: 0.5 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, synthesis: 0.8 },
}

const RELATION_WEIGHT: Record<string, number> = {
  ENEMY_OF: 1.5, ALLY_OF: 1.5, BELONGS_TO: 1.3, HAS_ITEM: 1.0,
  KNOWS: 0.8, DOES_NOT_KNOW: 0.5, SUSPECTS: 1.2, HIDES_FROM: 1.2,
  CAUSES: 1.0, REVEALS: 1.0, AFFECTS: 0.8,
  APPEARS_IN: 0.5, HAPPENS_IN: 0.5, LOCATED_AT: 0.6,
  ADVANCES_FORESHADOWING: 1.2, RESOLVES_FORESHADOWING: 1.2, CREATES_FORESHADOWING: 1.2,
}

// ── Cache ──────────────────────────────────────────────────────────

const graphCache = new Map<string, Promise<RetrievalGraph>>()

// ── Helpers ────────────────────────────────────────────────────────

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const n of nodes) {
    if (n.is_dir && n.children) out.push(...flattenMd(n.children))
    else if (!n.is_dir && n.name.endsWith(".md")) out.push(n)
  }
  return out
}

function stemId(fileName: string): string {
  return fileName.replace(/\.md$/, "")
}

function parseFrontmatter(content: string): { title: string; type: string; sources: string[]; isHistorical: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  const fm = fmMatch ? fmMatch[1] : ""

  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m)
  const histMatch = fm.match(/^is_historical:\s*(true|false)\s*$/mi)

  const sources: string[] = []
  const blockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m)
  if (blockMatch) {
    for (const line of blockMatch[1].split("\n")) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m) sources.push(m[1])
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m)
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "")
        if (trimmed) sources.push(trimmed)
      }
    }
  }

  let title = titleMatch?.[1]?.trim() ?? ""
  if (!title) {
    const heading = content.match(/^#\s+(.+)$/m)
    title = heading?.[1]?.trim() ?? ""
  }

  return {
    title,
    type: typeMatch?.[1]?.trim().toLowerCase() ?? "other",
    sources,
    isHistorical: histMatch?.[1]?.toLowerCase() === "true",
  }
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const re = new RegExp(WIKILINK_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) links.push(m[1].trim())
  return links
}

function relationNameToType(name: string): string | undefined {
  const norm = name.trim()
  for (const [type, label] of Object.entries(NOVEL_RELATION_LABELS)) {
    if (norm === type || norm === label) return type
  }
  return undefined
}

function extractRelationLinks(content: string): Array<{ target: string; relation: string }> {
  const links: Array<{ target: string; relation: string }> = []
  const re = /^\s*-\s*\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]\s*(?:—|-|:|：)\s*([^\n]+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const rel = relationNameToType(m[2])
    if (rel) links.push({ target: m[1].trim(), relation: rel })
  }
  return links
}

function resolveTarget(raw: string, nodeIds: ReadonlySet<string>): string | null {
  if (nodeIds.has(raw)) return raw
  const norm = raw.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeIds) {
    const lo = id.toLowerCase()
    if (lo === norm || lo === raw.toLowerCase() || lo.replace(/\s+/g, "-") === norm) return id
  }
  return null
}

function neighbors(node: RetrievalNode): ReadonlySet<string> {
  const s = new Set<string>()
  for (const id of node.outLinks) s.add(id)
  for (const id of node.inLinks) s.add(id)
  return s
}

function degree(node: RetrievalNode): number {
  return node.outLinks.size + node.inLinks.size
}

// ── Core API ───────────────────────────────────────────────────────

/** Build (or retrieve cached) retrieval graph for a project. */
export async function buildRetrievalGraph(
  projectPath: string,
  dataVersion: number = 0,
): Promise<RetrievalGraph> {
  const pp = normalizePath(projectPath)
  const key = `${pp}:${dataVersion}`
  const cached = graphCache.get(key)
  if (cached) return cached

  const promise = buildGraphInternal(pp, dataVersion).catch((err) => {
    graphCache.delete(key)
    throw err
  })
  graphCache.set(key, promise)
  return promise
}

async function buildGraphInternal(projectPath: string, dataVersion: number): Promise<RetrievalGraph> {
  const wikiRoot = `${projectPath}/wiki`
  let tree: FileNode[]
  try { tree = await listDirectory(wikiRoot) } catch { return { nodes: new Map(), dataVersion } }

  const mdFiles = flattenMd(tree)

  // First pass — read all files
  type RawNode = {
    id: string; title: string; type: string; path: string
    sources: string[]; rawLinks: string[]
    rawRels: Array<{ target: string; relation: string }>; fileName: string
  }
  const rawNodes: RawNode[] = []

  for (const file of mdFiles) {
    const id = stemId(file.name)
    let content = ""
    try { content = await readFile(file.path) } catch { continue }
    const fm = parseFrontmatter(content)
    if (fm.isHistorical) continue
    rawNodes.push({
      id, title: fm.title || file.name.replace(/\.md$/, "").replace(/-/g, " "),
      type: fm.type, path: file.path, sources: fm.sources,
      rawLinks: extractWikilinks(content),
      rawRels: extractRelationLinks(content),
      fileName: file.name,
    })
  }

  const nodeIds = new Set(rawNodes.map((n) => n.id))

  // Second pass — resolve links
  const outLinks = new Map<string, Set<string>>()
  const inLinks = new Map<string, Set<string>>()
  const relEdges = new Map<string, RelationEdge[]>()
  for (const id of nodeIds) { outLinks.set(id, new Set()); inLinks.set(id, new Set()); relEdges.set(id, []) }

  for (const raw of rawNodes) {
    for (const target of raw.rawLinks) {
      const rid = resolveTarget(target, nodeIds)
      if (!rid || rid === raw.id) continue
      outLinks.get(raw.id)!.add(rid)
      inLinks.get(rid)!.add(raw.id)
    }
    for (const rel of raw.rawRels) {
      const rid = resolveTarget(rel.target, nodeIds)
      if (!rid || rid === raw.id) continue
      relEdges.get(raw.id)!.push({ target: rid, relation: rel.relation })
    }
  }

  // Build immutable nodes
  const nodes = new Map<string, RetrievalNode>()
  for (const raw of rawNodes) {
    nodes.set(raw.id, {
      id: raw.id, title: raw.title, type: raw.type, path: raw.path,
      sources: Object.freeze([...raw.sources]),
      outLinks: Object.freeze(outLinks.get(raw.id) ?? new Set<string>()),
      inLinks: Object.freeze(inLinks.get(raw.id) ?? new Set<string>()),
      relationEdges: Object.freeze(relEdges.get(raw.id) ?? []),
    })
  }

  return { nodes, dataVersion }
}

/**
 * Calculate relevance score between two nodes using multiple signals:
 * direct links, source overlap, common neighbours (Adamic-Adar),
 * type affinity, and relation-type weights.
 */
export function calculateRelevance(
  nodeA: RetrievalNode,
  nodeB: RetrievalNode,
  graph: RetrievalGraph,
): number {
  if (nodeA.id === nodeB.id) return 0

  // Direct link
  const direct = ((nodeA.outLinks.has(nodeB.id) ? 1 : 0) + (nodeB.outLinks.has(nodeA.id) ? 1 : 0)) * W.directLink

  // Source overlap
  const srcA = new Set(nodeA.sources)
  let shared = 0
  for (const s of nodeB.sources) if (srcA.has(s)) shared++
  const sourceScore = shared * W.sourceOverlap

  // Common neighbours — Adamic-Adar
  const nbA = neighbors(nodeA)
  const nbB = neighbors(nodeB)
  let aa = 0
  for (const nid of nbA) {
    if (nbB.has(nid)) {
      const nb = graph.nodes.get(nid)
      if (nb) aa += 1 / Math.log(Math.max(degree(nb), 2))
    }
  }
  const neighborScore = aa * W.commonNeighbor

  // Type affinity
  const affMap = TYPE_AFFINITY[nodeA.type]
  const typeScore = (affMap?.[nodeB.type] ?? 0.5) * W.typeAffinity

  // Relation type match
  let relWeight = 0
  for (const e of nodeA.relationEdges) if (e.target === nodeB.id) relWeight += RELATION_WEIGHT[e.relation] ?? 0.5
  for (const e of nodeB.relationEdges) if (e.target === nodeA.id) relWeight += RELATION_WEIGHT[e.relation] ?? 0.5
  const relScore = relWeight * W.relationTypeMatch

  return direct + sourceScore + neighborScore + typeScore + relScore
}

/** Retrieve the most relevant nodes for a given node. */
export function getRelatedNodes(
  nodeId: string,
  graph: RetrievalGraph,
  limit: number = 5,
): ReadonlyArray<{ node: RetrievalNode; relevance: number }> {
  const source = graph.nodes.get(nodeId)
  if (!source) return []

  const scored: Array<{ node: RetrievalNode; relevance: number }> = []
  for (const [id, node] of graph.nodes) {
    if (id === nodeId) continue
    const rel = calculateRelevance(source, node, graph)
    if (rel > 0) scored.push({ node, relevance: rel })
  }

  scored.sort((a, b) => b.relevance - a.relevance)
  return scored.slice(0, limit)
}

/** Clear the in-memory graph cache. */
export function clearGraphCache(): void {
  graphCache.clear()
}
