import { beforeEach, expect, test, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

import { listDirectory, readFile } from "@/commands/fs"
import {
  buildRetrievalGraph,
  calculateRelevance,
  clearGraphCache,
  getRelatedNodes,
  type RetrievalNode,
} from "./graph-relevance"

const mockedListDirectory = vi.mocked(listDirectory)
const mockedReadFile = vi.mocked(readFile)

function wikiTree(projectPath: string): FileNode[] {
  return [
    {
      name: "entities",
      path: `${projectPath}/wiki/entities`,
      is_dir: true,
      children: [
        { name: "A.md", path: `${projectPath}/wiki/entities/A.md`, is_dir: false },
        { name: "B.md", path: `${projectPath}/wiki/entities/B.md`, is_dir: false },
      ],
    },
  ]
}

beforeEach(() => {
  clearGraphCache()
  vi.clearAllMocks()
})

test("shares in-flight graph builds for the same project and data version", async () => {
  mockedListDirectory.mockResolvedValue(wikiTree("/Project"))
  mockedReadFile.mockImplementation(async (path) => {
    if (path.endsWith("A.md")) {
      return "---\ntype: entity\ntitle: Alpha\n---\n\n# Alpha\n[[B]]"
    }
    return "---\ntype: entity\ntitle: Beta\n---\n\n# Beta\n"
  })

  const [first, second] = await Promise.all([
    buildRetrievalGraph("/Project", 12),
    buildRetrievalGraph("/Project", 12),
  ])

  expect(first).toBe(second)
  expect(mockedListDirectory).toHaveBeenCalledTimes(1)
  expect(mockedReadFile).toHaveBeenCalledTimes(2)
})

test("does not reuse graph cache across projects with the same data version", async () => {
  mockedListDirectory.mockImplementation(async (wikiRoot) => {
    const projectPath = String(wikiRoot).replace(/\/wiki$/, "")
    return wikiTree(projectPath)
  })
  mockedReadFile.mockImplementation(async (path) => {
    if (String(path).startsWith("/ProjectA/")) {
      return "---\ntype: entity\ntitle: Project A Node\n---\n\n# Project A Node\n"
    }
    return "---\ntype: entity\ntitle: Project B Node\n---\n\n# Project B Node\n"
  })

  const first = await buildRetrievalGraph("/ProjectA", 12)
  const second = await buildRetrievalGraph("/ProjectB", 12)

  expect([...first.nodes.values()][0]?.title).toBe("Project A Node")
  expect([...second.nodes.values()][0]?.title).toBe("Project B Node")
  expect(mockedListDirectory).toHaveBeenCalledTimes(2)
})

test("returns an empty graph when listing the wiki root fails", async () => {
  mockedListDirectory.mockRejectedValue(new Error("missing wiki"))
  const graph = await buildRetrievalGraph("/NoWiki", 1)
  expect(graph.nodes.size).toBe(0)
  expect(graph.dataVersion).toBe(1)
})

test("skips files that fail to read and historical pages", async () => {
  mockedListDirectory.mockResolvedValue([
    { name: "Broken.md", path: "/P/wiki/Broken.md", is_dir: false },
    { name: "Old.md", path: "/P/wiki/Old.md", is_dir: false },
    { name: "Live.md", path: "/P/wiki/Live.md", is_dir: false },
  ])
  mockedReadFile.mockImplementation(async (p: string) => {
    if (String(p).endsWith("Broken.md")) throw new Error("read fail")
    if (String(p).endsWith("Old.md")) return "---\nis_historical: true\ntitle: Old\n---\n# Old"
    return "---\ntype: entity\ntitle: Live\n---\n# Live"
  })
  const graph = await buildRetrievalGraph("/P", 2)
  expect(graph.nodes.size).toBe(1)
  expect([...graph.nodes.values()][0]?.id).toBe("Live")
})

test("parses block and inline sources plus frontmatter fallbacks", async () => {
  mockedListDirectory.mockResolvedValue([
    { name: "Block.md", path: "/P/wiki/Block.md", is_dir: false },
    { name: "Inline.md", path: "/P/wiki/Inline.md", is_dir: false },
    { name: "NoTitle.md", path: "/P/wiki/NoTitle.md", is_dir: false },
    { name: "EmptyBlock.md", path: "/P/wiki/EmptyBlock.md", is_dir: false },
    { name: "notes.txt", path: "/P/wiki/notes.txt", is_dir: false },
  ])
  mockedReadFile.mockImplementation(async (p: string) => {
    if (String(p).endsWith("/Block.md")) {
      return '---\ntitle: "Quoted Title"\ntype: \'concept\'\nsources:\n  - "source one"\n  - source-two\n---\n# Heading'
    }
    if (String(p).endsWith("Inline.md")) return '---\nsources: [alpha, , "beta gamma"]\n---\ncontent'
    if (String(p).endsWith("EmptyBlock.md")) return "---\nsources:\n\n---\n# Empty"
    return "no frontmatter at all"
  })
  const graph = await buildRetrievalGraph("/P", 3)
  const nodes = [...graph.nodes.values()]
  const block = nodes.find((n) => n.id === "Block")!
  expect(block.title).toBe("Quoted Title")
  expect(block.type).toBe("concept")
  expect(block.sources).toEqual(["source one", "source-two"])
  const inline = nodes.find((n) => n.id === "Inline")!
  expect(inline.sources).toEqual(["alpha", "beta gamma"]) // empty item skipped
  const emptyBlock = nodes.find((n) => n.id === "EmptyBlock")!
  expect(emptyBlock.sources).toEqual([]) // block matched but contains no items
  const noTitle = nodes.find((n) => n.id === "NoTitle")!
  expect(noTitle.title).toBe("NoTitle") // no heading → filename slug fallback
  expect(noTitle.type).toBe("other")
  expect(nodes.find((n) => n.id === "notes")).toBeUndefined() // non-md file skipped
})

test("resolves wikilinks and relation edges between nodes", async () => {
  mockedListDirectory.mockResolvedValue([
    { name: "Hero.md", path: "/P/wiki/Hero.md", is_dir: false },
    { name: "Villain.md", path: "/P/wiki/Villain.md", is_dir: false },
    { name: "Ally.md", path: "/P/wiki/Ally.md", is_dir: false },
  ])
  mockedReadFile.mockImplementation(async (p: string) => {
    const base = String(p).split("/").pop()
    if (base === "Hero.md") {
      return [
        "# Hero",
        "[[Villain]]",
        "- [[Ally]] — 合作",
        "- [[Missing]] — 敌对",
        "- [[Ally]] : ENEMY_OF",
        "- [[Ally]] — 随便聊聊",
      ].join("\n")
    }
    if (base === "Villain.md") return "# Villain\n[[Hero]]"
    return "# Ally"
  })
  const graph = await buildRetrievalGraph("/P", 4)
  const hero = graph.nodes.get("Hero")!
  expect(hero.outLinks.has("Villain")).toBe(true)
  expect(hero.inLinks.has("Villain")).toBe(true) // reciprocal
  const villain = graph.nodes.get("Villain")!
  expect(villain.inLinks.has("Hero")).toBe(true)
  // relation parsed via label (合作 → ALLY_OF) and via type name (ENEMY_OF)
  expect(hero.relationEdges).toEqual([
    { target: "Ally", relation: "ALLY_OF" },
    { target: "Ally", relation: "ENEMY_OF" },
  ])
  // self link skipped
  expect(hero.outLinks.has("Hero")).toBe(false)
})

test("resolveTarget matches case-insensitively and via slug normalization", async () => {
  mockedListDirectory.mockResolvedValue([
    { name: "Big City.md", path: "/P/wiki/Big City.md", is_dir: false },
    { name: "Hero.md", path: "/P/wiki/Hero.md", is_dir: false },
    { name: "Villain.md", path: "/P/wiki/Villain.md", is_dir: false },
  ])
  mockedReadFile.mockImplementation(async (p: string) => {
    if (String(p).endsWith("Big City.md")) return "# Big City"
    if (String(p).endsWith("Hero.md")) return "# Hero\n[[big city]]\n[[Big-City]]\n[[nope]]"
    return "# Villain"
  })
  const graph = await buildRetrievalGraph("/P", 5)
  const hero = graph.nodes.get("Hero")!
  const villain = graph.nodes.get("Villain")!
  const city = graph.nodes.get("Big City")!
  expect(hero.outLinks.has("Big City")).toBe(true)
  // both spellings originate from the same source node → single inlink entry
  expect(city.inLinks.has("Hero")).toBe(true)
  expect(city.inLinks.size).toBe(1)
  expect(villain.outLinks.size).toBe(0)
})

test("evicts a failed build from the cache and allows retry", async () => {
  // listDirectory resolving outside its contract (null tree) makes flattenMd throw,
  // which escapes the internal catch and rejects the build promise → cache eviction.
  mockedListDirectory.mockResolvedValueOnce(null as unknown as FileNode[])
  mockedListDirectory.mockResolvedValueOnce([])
  await expect(buildRetrievalGraph("/P", 9)).rejects.toThrow()
  const graph = await buildRetrievalGraph("/P", 9)
  expect(graph.nodes.size).toBe(0)
})

function node(partial: Partial<RetrievalNode> & { id: string }): RetrievalNode {
  return {
    title: partial.title ?? partial.id,
    type: partial.type ?? "entity",
    path: "/p.md",
    sources: Object.freeze(partial.sources ?? []),
    outLinks: Object.freeze(partial.outLinks ?? new Set<string>()),
    inLinks: Object.freeze(partial.inLinks ?? new Set<string>()),
    relationEdges: Object.freeze(partial.relationEdges ?? []),
    id: partial.id,
  }
}

test("calculateRelevance returns zero for the same node", () => {
  const a = node({ id: "a" })
  expect(calculateRelevance(a, a, { nodes: new Map(), dataVersion: 0 })).toBe(0)
})

test("calculateRelevance combines all scoring signals", () => {
  const graph = {
    dataVersion: 0,
    nodes: new Map([
      ["a", node({ id: "a" })],
      ["b", node({ id: "b" })],
      ["shared", node({ id: "shared", type: "query" })],
    ]),
  }
  const a: RetrievalNode = node({
    id: "a",
    type: "entity",
    sources: ["s1", "s2"],
    outLinks: new Set(["b", "shared"]),
    inLinks: new Set(["shared"]),
    relationEdges: [
      { target: "b", relation: "ALLY_OF" },
      { target: "b", relation: "UNKNOWN_REL" },
      { target: "other", relation: "KNOWS" }, // non-matching target → skipped
    ],
  })
  const b: RetrievalNode = node({
    id: "b",
    type: "concept",
    sources: ["s2"],
    outLinks: new Set(["a", "shared"]),
    inLinks: new Set(["a"]),
    relationEdges: [
      { target: "a", relation: "ENEMY_OF" },
      { target: "a", relation: "MYSTERY_REL" }, // unknown weight → 0.5 fallback
      { target: "z", relation: "KNOWS" }, // non-matching target → skipped
    ],
  })

  const score = calculateRelevance(a, b, graph)
  // direct: both directions → 2 * 3.0 = 6
  // source overlap: 1 * 4.0 = 4
  // common neighbors: shared has degree 0 → 1/log(max(0,2)) * 1.5
  // type affinity: entity→concept = 1.2
  // relations: ALLY_OF 1.5 + ENEMY_OF 1.5 + UNKNOWN 0.5 + MYSTERY 0.5 → 4.0 * 1.5 = 6.0
  expect(score).toBeCloseTo(6 + 4 + (1 / Math.log(2)) * 1.5 + 1.2 + 6.0, 6)
})

test("calculateRelevance tolerates a common neighbor missing from the graph", () => {
  const ghostA: RetrievalNode = node({ id: "ga", outLinks: new Set(["ghost"]) })
  const ghostB: RetrievalNode = node({ id: "gb", outLinks: new Set(["ghost"]) })
  const graph = {
    nodes: new Map([[ghostA.id, ghostA], [ghostB.id, ghostB]]),
    dataVersion: 0,
  }
  // common neighbor "ghost" is not in graph.nodes → neighbor lookup returns undefined
  expect(calculateRelevance(ghostA, ghostB, graph)).toBeCloseTo(0.8, 6)
})

test("calculateRelevance uses the default affinity for unknown node types", () => {
  const a = node({ id: "a", type: "mystery" })
  const b = node({ id: "b", type: "other" })
  const graph = { nodes: new Map([[a.id, a], [b.id, b]]), dataVersion: 0 }
  // affinity fallback 0.5 * 1.0
  expect(calculateRelevance(a, b, graph)).toBeCloseTo(0.5, 6)
})

test("getRelatedNodes returns an empty list for an unknown node id", () => {
  const graph = { nodes: new Map(), dataVersion: 0 }
  expect(getRelatedNodes("ghost", graph)).toEqual([])
})

test("getRelatedNodes ranks and limits results by relevance", () => {
  const a = node({ id: "a" })
  const b: RetrievalNode = node({ id: "b", outLinks: new Set(["a"]) })
  const c: RetrievalNode = node({ id: "c", sources: ["same"] })
  const a2: RetrievalNode = node({ id: "a2", outLinks: new Set(["b"]) })
  const graph = { nodes: new Map([[a.id, a], [b.id, b], [c.id, c], [a2.id, a2]]), dataVersion: 0 }
  const related = getRelatedNodes("a", graph, 2)
  expect(related.length).toBe(2)
  expect(related[0].relevance).toBeGreaterThanOrEqual(related[1].relevance)
  expect(related.every((r) => r.node.id !== "a")).toBe(true)
})

test("getRelatedNodes omits zero-relevance nodes and honors the default limit", () => {
  const a = node({ id: "a" })
  const far = node({ id: "far" })
  const graph = { nodes: new Map([[a.id, a], [far.id, far]]), dataVersion: 0 }
  // unknown type pair → affinity 0.5 > 0, so both appear; limit default 5 keeps all
  const related = getRelatedNodes("a", graph)
  expect(related).toHaveLength(1)
})
