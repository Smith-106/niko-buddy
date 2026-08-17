import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))
const graphRelMocks = vi.hoisted(() => ({
  buildRetrievalGraph: vi.fn(),
  calculateRelevance: vi.fn(),
}))
const wikiStoreMock = vi.hoisted(() => ({ getState: vi.fn() }))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: graphRelMocks.buildRetrievalGraph,
  calculateRelevance: graphRelMocks.calculateRelevance,
}))
vi.mock("@/lib/novel/graph-adapter", () => ({
  NOVEL_NODE_TYPE_LABELS: {
    character: "人物",
    location: "地点",
    organization: "组织",
    item: "物品",
    event: "事件",
    chapter: "章节",
    outline: "大纲",
    foreshadowing: "伏笔",
    secret: "秘密",
    conflict: "冲突",
    "timeline-point": "时间点",
    "canon-rule": "正史规则",
    concept: "概念",
  },
  NOVEL_RELATION_LABELS: {
    APPEARS_IN: "出场于",
    HAPPENS_IN: "发生于",
    BELONGS_TO: "属于",
    HAS_ITEM: "持有",
    ENEMY_OF: "敌对",
    ALLY_OF: "合作",
    SUSPECTS: "怀疑",
    HIDES_FROM: "隐瞒",
    KNOWS: "知道",
    DOES_NOT_KNOW: "不知道",
    ADVANCES_FORESHADOWING: "推进伏笔",
    RESOLVES_FORESHADOWING: "回收伏笔",
    CREATES_FORESHADOWING: "新增伏笔",
    CAUSES: "导致",
    REVEALS: "揭示",
    AFFECTS: "影响",
    LOCATED_AT: "位于",
  },
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: wikiStoreMock.getState },
}))

import { listDirectory, readFile } from "@/commands/fs"
import { buildRetrievalGraph, calculateRelevance } from "@/lib/graph-relevance"
import { buildWikiGraph, type GraphEdge, type GraphNode } from "./wiki-graph"

const mockedListDirectory = vi.mocked(listDirectory)
const mockedReadFile = vi.mocked(readFile)

/**
 * Build a nested FileNode tree under /P/wiki from a flat map of
 * relative path -> content.
 */
function treeFrom(relToContent: Record<string, string>): FileNode[] {
  const root: FileNode[] = []
  const nodes = new Map<string, FileNode>()
  const addPath = (rel: string): FileNode => {
    const parts = rel.split("/")
    const name = parts[parts.length - 1]
    const full = `/P/wiki/${rel}`
    if (parts.length === 1) {
      const node: FileNode = { name, path: full, is_dir: false }
      nodes.set(full, node)
      root.push(node)
      return node
    }
    const dirRel = parts.slice(0, -1).join("/")
    const dirFull = `/P/wiki/${dirRel}`
    let dirNode = nodes.get(dirFull)
    if (!dirNode) {
      dirNode = { name: parts[parts.length - 2], path: dirFull, is_dir: true, children: [] }
      nodes.set(dirFull, dirNode)
      const parentRel = parts.slice(0, -2).join("/")
      if (parentRel) {
        const parent = addPath(parentRel)
        ;(parent.children ??= []).push(dirNode)
      } else {
        root.push(dirNode)
      }
    }
    const fileNode: FileNode = { name, path: full, is_dir: false }
    ;(dirNode.children ??= []).push(fileNode)
    return fileNode
  }
  for (const rel of Object.keys(relToContent)) addPath(rel)
  return root
}

/** Install fs mocks for a flat rel-path -> content wiki. */
function installWiki(relToContent: Record<string, string>): void {
  mockedListDirectory.mockResolvedValue(treeFrom(relToContent))
  mockedReadFile.mockImplementation(async (path: string) => {
    const rel = String(path).replace("/P/wiki/", "")
    if (rel in relToContent) return relToContent[rel]
    throw new Error(`no content for ${path}`)
  })
}

function emptyRetrievalGraph(): {
  nodes: Map<string, unknown>
  dataVersion: number
} {
  return { nodes: new Map(), dataVersion: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  graphRelMocks.buildRetrievalGraph.mockResolvedValue(emptyRetrievalGraph())
  graphRelMocks.calculateRelevance.mockReturnValue(1)
  wikiStoreMock.getState.mockReturnValue({ dataVersion: 0 })
})

describe("buildWikiGraph — early exits", () => {
  it("returns an empty graph when the wiki root cannot be listed", async () => {
    mockedListDirectory.mockRejectedValue(new Error("no wiki"))
    await expect(buildWikiGraph("/P")).resolves.toEqual({ nodes: [], edges: [], communities: [] })
    expect(mockedReadFile).not.toHaveBeenCalled()
  })

  it("returns an empty graph when no markdown files exist", async () => {
    installWiki({ "notes.txt": "hello", "empty-dir/.keep": "x" })
    await expect(buildWikiGraph("/P")).resolves.toEqual({ nodes: [], edges: [], communities: [] })
  })

  it("returns an empty graph when every file is unreadable", async () => {
    mockedListDirectory.mockResolvedValue(treeFrom({ "entities/a.md": "" }))
    mockedReadFile.mockRejectedValue(new Error("permission denied"))
    await expect(buildWikiGraph("/P")).resolves.toEqual({ nodes: [], edges: [], communities: [] })
  })
})

describe("buildWikiGraph — node filtering", () => {
  it("skips unreadable files and hides query-type nodes", async () => {
    mockedListDirectory.mockResolvedValue(
      treeFrom({
        "entities/readable.md": "---\ntype: entity\n---\n# Readable\n",
        "entities/unreadable.md": "x",
        "queries/research.md": "---\ntype: query\n---\n# Research\n",
      }),
    )
    mockedReadFile.mockImplementation(async (path: string) => {
      if (String(path).includes("unreadable.md")) throw new Error("boom")
      if (String(path).includes("research.md")) return "---\ntype: query\n---\n# Research\n"
      return "---\ntype: entity\n---\n# Readable\n"
    })

    const graph = await buildWikiGraph("/P")
    expect(graph.nodes.map((n) => n.id)).toEqual(["readable"])
    expect(graph.edges).toEqual([])
    expect(graph.communities).toHaveLength(1)
    expect(graph.communities[0]?.nodeCount).toBe(1)
    expect(graph.communities[0]?.cohesion).toBe(0)
    expect(graph.nodes[0]?.community).toBe(0)
  })
})

describe("buildWikiGraph — titles, types, tags", () => {
  it("extracts frontmatter title, heading title and filename fallback", async () => {
    installWiki({
      "misc/fm.md": "---\ntitle: Frontmatter Title\n---\nbody\n",
      "misc/head.md": "# Heading Title\n",
      "misc/data-store.md": "body without frontmatter\n",
    })
    const graph = await buildWikiGraph("/P")
    const byId = new Map(graph.nodes.map((n) => [n.id, n.label]))
    expect(byId.get("fm")).toBe("Frontmatter Title")
    expect(byId.get("head")).toBe("Heading Title")
    expect(byId.get("data-store")).toBe("data store")
  })

  it("resolves types from frontmatter, chapter_number, outline_type, path and default", async () => {
    installWiki({
      "misc/fmtype.md": "---\ntype: concept\n---\nbody\n",
      "misc/chapnum.md": "---\nchapter_number: 7\n---\nbody\n",
      "misc/outline-type.md": "---\noutline_type: long-form\n---\nbody\n",
      "chapters/raw.md": "# Raw Chapter\n",
      "outlines/plan.md": "# Plan\n",
      "misc/other.md": "plain\n",
    })
    const graph = await buildWikiGraph("/P")
    const byId = new Map(graph.nodes.map((n) => [n.id, n.type]))
    expect(byId.get("fmtype")).toBe("concept")
    expect(byId.get("chapnum")).toBe("chapter")
    expect(byId.get("outline-type")).toBe("outline")
    expect(byId.get("raw")).toBe("chapter")
    expect(byId.get("plan")).toBe("outline")
    expect(byId.get("other")).toBe("other")
  })

  it("promotes entity tags to novel entity types and keeps unknown tags as entity", async () => {
    installWiki({
      "entities/hero.md":
        "---\ntype: entity\ntags:\n  - character\n---\n# Hero\n",
      "entities/plain.md": "---\ntype: entity\ntags: [not-a-novel-type]\n---\n# Plain\n",
    })
    const graph = await buildWikiGraph("/P")
    const byId = new Map(graph.nodes.map((n) => [n.id, n.type]))
    expect(byId.get("hero")).toBe("character")
    expect(byId.get("plain")).toBe("entity")
  })

  it("parses block-form frontmatter arrays and tolerates empty block fields", async () => {
    installWiki({
      "misc/blockfm.md": [
        "---",
        "title: Block FM",
        "sources:",
        "  - s1.pdf",
        "  - s2.pdf",
        "related:",
        "  - blocktarget",
        "aliases:",
        "  - Block Alias",
        "---",
        "body",
      ].join("\n"),
      "misc/blocktarget.md": "---\ntitle: Block Target\n---\n",
      // sources: with no list items after it -> empty block group
      "misc/emptyfield.md": "---\ntype: entity\nsources:\nother: x\n---\nbody\n",
    })
    const graph = await buildWikiGraph("/P")
    const blockfm = graph.nodes.find((n) => n.id === "blockfm")
    expect(blockfm?.sources).toEqual(["s1.pdf", "s2.pdf"])
    expect(blockfm?.label).toBe("Block FM")
    // related: block form feeds the link resolution
    expect(graph.edges.some((e) => e.source === "blockfm" && e.target === "blocktarget")).toBe(
      true,
    )
    // empty block field contributes nothing and does not break parsing
    const emptyNode = graph.nodes.find((n) => n.id === "emptyfield")
    expect(emptyNode?.sources).toEqual([])
    expect(emptyNode?.type).toBe("entity")
  })

  it("skips relation and plain links that are unresolvable or self-referencing", async () => {
    installWiki({
      // plain self-link (skipped at the source==target check) and a
      // relation link to a nonexistent page (skipped at the null check)
      "entities/selfy.md": [
        "---",
        "type: entity",
        "---",
        "[[selfy]]",
        "- [[ghost]] — 合作",
      ].join("\n"),
      // relation self-link
      "entities/selfer.md": "---\ntype: entity\n---\n- [[selfer]] — 合作\n",
    })
    const graph = await buildWikiGraph("/P")
    expect(graph.edges).toHaveLength(0)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["selfer", "selfy"])
  })
})

describe("buildWikiGraph — links and relations", () => {
  it("creates relation edges, dedupes duplicates and computes relevance weights", async () => {
    installWiki({
      "entities/alpha.md": [
        "---",
        "title: Alpha",
        "type: entity",
        "tags: [character]",
        "sources: [s1.pdf]",
        "related: [beta]",
        "---",
        "# Alpha",
        "",
        "[[beta]]",
        "- [[beta]] — 合作",
        "- [[beta]] — 合作",
        "- [[gamma]] — 未定义关系",
        "",
      ].join("\n"),
      "entities/beta.md": [
        "---",
        "title: Beta",
        "type: entity",
        "---",
        "# Beta",
        "",
        "[[alpha]]",
        "- [[alpha]] — 合作",
        "",
      ].join("\n"),
      "entities/gamma.md": "---\ntype: entity\n---\n# Gamma\n",
    })
    wikiStoreMock.getState.mockReturnValue({ dataVersion: 5 })
    graphRelMocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([
        ["alpha", { id: "alpha" }],
        ["beta", { id: "beta" }],
      ]),
      dataVersion: 5,
    })
    graphRelMocks.calculateRelevance.mockReturnValue(3.5)

    const graph = await buildWikiGraph("/P")

    expect(graphRelMocks.buildRetrievalGraph).toHaveBeenCalledWith("/P", 5)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["alpha", "beta", "gamma"])
    expect(graph.nodes.find((n) => n.id === "alpha")?.type).toBe("character")

    const edgeKey = (e: GraphEdge) => `${e.source}->${e.target}:${e.relation ?? ""}`
    const edges = new Map(graph.edges.map((e) => [edgeKey(e), e]))
    // alpha->beta (relation, deduped), alpha->gamma (plain link captured from
    // the unrecognized-relation line), beta->alpha (relation).
    expect(graph.edges).toHaveLength(3)
    expect(edges.has("alpha->beta:ALLY_OF")).toBe(true)
    expect(edges.has("beta->alpha:ALLY_OF")).toBe(true)
    expect(edges.has("alpha->gamma:")).toBe(true)
    // Relevance weight came from the retrieval graph.
    expect(edges.get("alpha->beta:ALLY_OF")?.weight).toBe(3.5)
    expect(edges.get("beta->alpha:ALLY_OF")?.weight).toBe(3.5)
    // gamma is not in the retrieval graph -> default weight 1.
    expect(edges.get("alpha->gamma:")?.weight).toBe(1)

    // Link counts are incremented per raw relation line (before edge dedup):
    // alpha 2x relation + gamma + inbound = 4, beta 2x relation + own = 3.
    const linkCounts = new Map(graph.nodes.map((n) => [n.id, n.linkCount]))
    expect(linkCounts.get("alpha")).toBe(4)
    expect(linkCounts.get("beta")).toBe(3)
    expect(linkCounts.get("gamma")).toBe(1)
  })

  it("recognises relation names written as the type key", async () => {
    installWiki({
      "entities/a.md": "---\ntype: entity\n---\n- [[b]] — ENEMY_OF\n",
      "entities/b.md": "---\ntype: entity\n---\n",
    })
    const graph = await buildWikiGraph("/P")
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "a", target: "b", relation: "ENEMY_OF" }),
    ])
  })

  it("falls back to weight 1 when the retrieval graph rejects", async () => {
    installWiki({
      "entities/a.md": "---\ntype: entity\n---\n[[b]]\n",
      "entities/b.md": "---\ntype: entity\n---\n",
    })
    graphRelMocks.buildRetrievalGraph.mockRejectedValue(new Error("embedding down"))
    const graph = await buildWikiGraph("/P")
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]?.weight).toBe(1)
  })

  it("falls back to weight 1 when the retrieval graph misses an endpoint", async () => {
    installWiki({
      "entities/a.md": "---\ntype: entity\n---\n[[b]]\n",
      "entities/b.md": "---\ntype: entity\n---\n",
    })
    graphRelMocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([["alpha", { id: "alpha" }]]), // neither endpoint present
      dataVersion: 0,
    })
    const graph = await buildWikiGraph("/P")
    expect(graph.edges[0]?.weight).toBe(1)
  })
})

describe("buildWikiGraph — resolveTarget variants", () => {
  it("resolves direct ids, case-insensitive ids, space ids, hyphen ids, labels and aliases", async () => {
    installWiki({
      // Link sources — each targets one resolution shape.
      "entities/src1.md": "[[alpha]]\n",
      "entities/src2.md": "[[BETA]]\n",
      "entities/src3.md": "[[Beta Beta]]\n",
      "entities/src4.md": "[[Data-Store]]\n",
      "entities/src5.md": "[[Labeled Page]]\n",
      "entities/src6.md": "[[Al]]\n",
      "entities/src7.md": "[[alias-two]]\n",
      "entities/src8.md": "[[ghost]]\n",
      // Targets — distinct ids and metadata shapes.
      "entities/alpha.md": "---\ntitle: Alpha\n---\n",
      "entities/Beta.md": "",
      "entities/beta beta.md": "",
      "entities/data store.md": "",
      "entities/labeled.md": "---\ntitle: Labeled Page\n---\n",
      "entities/aliaser.md": "---\naliases: [Al, Alias Two]\n---\n",
    })
    const graph = await buildWikiGraph("/P")
    const keys = graph.edges.map((e) => `${e.source}->${e.target}`)
    expect(keys).toContain("src1->alpha") // direct id match
    expect(keys).toContain("src2->Beta") // case-insensitive id match
    expect(keys).toContain("src3->beta beta") // id with spaces vs spaced raw
    expect(keys).toContain("src4->data store") // hyphenated raw vs spaced id
    expect(keys).toContain("src5->labeled") // label match
    expect(keys).toContain("src6->aliaser") // alias exact match
    expect(keys).toContain("src7->aliaser") // alias hyphenated match
    expect(keys).not.toContain("src8->ghost") // unresolvable -> no edge
  })
})

describe("buildWikiGraph — snapshot-based APPEARS_IN edges", () => {
  it("links linkless novel entities to chapters sharing their snapshot", async () => {
    installWiki({
      "entities/draco.md": [
        "---",
        "title: Draco",
        "type: entity",
        "tags: [character]",
        "snapshot: snap-1",
        "---",
        "# Draco",
      ].join("\n"),
      "entities/plain.md": "---\ntype: entity\nsnapshot: snap-1\n---\n",
      "entities/busy.md":
        "---\ntype: entity\ntags: [location]\nsnapshot: snap-1\n---\n[[ch1]]\n",
      "chapters/ch1.md": "---\nchapter_number: 1\nsnapshot: snap-1\n---\n",
      "chapters/ch2.md": "---\nchapter_number: 2\nsnapshot: snap-2\n---\n",
    })

    const graph = await buildWikiGraph("/P")
    const appearsIn = graph.edges.filter((e) => e.relation === "APPEARS_IN")
    expect(appearsIn).toHaveLength(1)
    // The final weight pass recomputes weights from the retrieval graph;
    // with no retrieval nodes present the synthetic edge lands at 1 while
    // the confidence survives.
    expect(appearsIn[0]).toMatchObject({
      source: "draco",
      target: "ch1",
      weight: 1,
      confidence: 0.5,
    })
    // ch2 has a different snapshot; plain is not a novel entity; busy has links.
    expect(graph.edges.some((e) => e.target === "ch2")).toBe(false)
    expect(graph.edges.some((e) => e.source === "plain")).toBe(false)
    expect(graph.edges.some((e) => e.source === "busy" && e.relation === "APPEARS_IN")).toBe(false)
  })
})

describe("buildWikiGraph — community detection", () => {
  it("computes cohesion, top nodes and renumbered community ids", async () => {
    installWiki({
      // Star: c1 links c2..c6; c2 links back (reverse edge) and c1 has two
      // relation edges to c2 with different relation keys (dup-key edge).
      "entities/c1.md": [
        "---",
        "type: entity",
        "---",
        "[[c2]] [[c3]] [[c4]] [[c5]] [[c6]]",
        "- [[c2]] — 合作",
        "- [[c2]] — 敌对",
      ].join("\n"),
      "entities/c2.md": "---\ntype: entity\n---\n[[c1]]\n",
      "entities/c3.md": "---\ntype: entity\n---\n",
      "entities/c4.md": "---\ntype: entity\n---\n",
      "entities/c5.md": "---\ntype: entity\n---\n",
      "entities/c6.md": "---\ntype: entity\n---\n",
      "entities/iso1.md": "---\ntype: entity\n---\n",
      "entities/iso2.md": "---\ntype: entity\n---\n",
    })

    const graph = await buildWikiGraph("/P")
    expect(graph.nodes).toHaveLength(8)

    // Edge multiplicity sanity: c1->c2 relation edges deduped to two keys,
    // c1->c3..c6 plain edges, c2->c1 plain edge.
    expect(graph.edges).toHaveLength(7)

    const communityById = new Map(graph.nodes.map((n) => [n.id, n.community]))
    // The star community contains c1..c6 and is the largest.
    const largest = graph.communities.reduce((a, b) => (b.nodeCount > a.nodeCount ? b : a))
    expect(largest.nodeCount).toBeGreaterThanOrEqual(6)
    expect(largest.topNodes.length).toBeLessThanOrEqual(5)
    expect(largest.cohesion).toBeGreaterThan(0)
    expect(largest.cohesion).toBeLessThanOrEqual(1)

    // Isolated nodes each get a singleton community.
    const singletons = graph.communities.filter((c) => c.nodeCount === 1)
    expect(singletons.length).toBeGreaterThanOrEqual(2)
    expect(communityById.get("iso1")).not.toBe(communityById.get("iso2"))

    // Community ids are sequential and every node references a valid id.
    const ids = graph.communities.map((c) => c.id)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids.map((_, i) => i))
    for (const node of graph.nodes) {
      expect(ids).toContain(node.community)
    }
  })
})
