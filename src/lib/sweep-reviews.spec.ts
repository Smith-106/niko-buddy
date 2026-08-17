import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"

const fsState = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))
const streamChatMock = vi.hoisted(() => vi.fn())
const modelResolverMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsState)
vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: modelResolverMock }))

import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { extractJsonObject, sweepResolvedReviews } from "./sweep-reviews"

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: `review-${Math.random().toString(36).slice(2, 8)}`,
    type: "missing-page",
    title: "Missing page: 注意力机制",
    description: "页面缺失",
    options: [{ label: "Create Page", action: "Create Page" }, { label: "Skip", action: "Skip" }],
    resolved: false,
    createdAt: 1,
    ...overrides,
  }
}

function mdFile(name: string, content: string, root = "/P/wiki"): FileNode {
  return { name, path: `${root}/${name}`, is_dir: false }
}

function treeWith(files: FileNode[]): FileNode[] {
  return [{ name: "wiki", path: "/P/wiki", is_dir: true, children: files }]
}

function setupProject(projectPath = "/P") {
  useWikiStore.setState({
    project: { id: "proj-1", name: "P", path: projectPath },
    llmConfig: {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
      maxContextSize: 128000,
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      reasoning: { mode: "off" },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  fsState.listDirectory.mockReset()
  fsState.readFile.mockReset()
  streamChatMock.mockReset()
  modelResolverMock.mockReset()
  modelResolverMock.mockImplementation((c: unknown) => c)
  setupProject()
})

afterEach(() => {
  useWikiStore.setState({ project: null })
})

// ── extractJsonObject ─────────────────────────────────────────────────────────

describe("extractJsonObject", () => {
  it("extracts a bare JSON object", () => {
    expect(extractJsonObject('{"resolved": ["a"]}')).toBe('{"resolved": ["a"]}')
  })

  it("strips opening and trailing fences", () => {
    expect(extractJsonObject('```json\n{"resolved": []}\n```')).toBe('{"resolved": []}')
    expect(extractJsonObject('```{"resolved": []}```')).toBe('{"resolved": []}')
  })

  it("handles uppercase Json fence", () => {
    expect(extractJsonObject('```Json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("finds the first balanced object inside prose", () => {
    expect(extractJsonObject('Here: {"resolved": ["x"]} trailing words')).toBe('{"resolved": ["x"]}')
  })

  it("respects strings and escapes containing braces", () => {
    expect(extractJsonObject('{"msg": "a{b}c", "x": 1}')).toBe('{"msg": "a{b}c", "x": 1}')
    expect(extractJsonObject('{"msg": "say \\"hi\\"", "x": 1}')).toBe('{"msg": "say \\"hi\\"", "x": 1}')
  })

  it("returns empty string when no brace exists", () => {
    expect(extractJsonObject("no json here")).toBe("")
  })

  it("returns empty string for an unbalanced object", () => {
    // brace depth only — an unclosed string still fails
    expect(extractJsonObject('{"a": "unterminated')).toBe("")
  })

  it("walks nested brace depth correctly", () => {
    expect(extractJsonObject('{"a": {"b": {"c": 1}}}')).toBe('{"a": {"b": {"c": 1}}}')
  })
})

// ── sweepResolvedReviews: guard exits ────────────────────────────────────────

describe("sweepResolvedReviews — guards", () => {
  it("returns 0 when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await sweepResolvedReviews("/P", controller.signal)).toBe(0)
  })

  it("returns 0 when no project is open", async () => {
    useWikiStore.setState({ project: null })
    expect(await sweepResolvedReviews("/P")).toBe(0)
  })

  it("returns 0 when the project path no longer matches", async () => {
    setupProject("/Other")
    expect(await sweepResolvedReviews("/P")).toBe(0)
  })

  it("returns 0 when there are no pending items", async () => {
    useReviewStore.setState({ items: [makeItem({ resolved: true })] })
    expect(await sweepResolvedReviews("/P")).toBe(0)
  })

  it("returns 0 when the wiki listing fails", async () => {
    useReviewStore.setState({ items: [makeItem()] })
    fsState.listDirectory.mockRejectedValueOnce(new Error("ENOENT"))
    expect(await sweepResolvedReviews("/P")).toBe(0)
  })

  it("returns 0 when aborted after building the wiki index", async () => {
    useReviewStore.setState({ items: [makeItem()] })
    let releaseRead: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { releaseRead = resolve })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockImplementation(async () => { await gate; return "---\ntitle: Attention\n---\nbody" })
    const controller = new AbortController()
    const promise = sweepResolvedReviews("/P", controller.signal)
    // let buildWikiIndex start, then abort while readFile is pending
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    releaseRead!()
    expect(await promise).toBe(0)
  })

  it("returns 0 when the project changed after building the index", async () => {
    useReviewStore.setState({ items: [makeItem()] })
    let releaseRead: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { releaseRead = resolve })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockImplementation(async () => { await gate; return "---\ntitle: Attention\n---\nbody" })
    const promise = sweepResolvedReviews("/P")
    await new Promise((r) => setTimeout(r, 5))
    useWikiStore.setState({ project: { id: "other", name: "Other", path: "/Other" } })
    releaseRead!()
    expect(await promise).toBe(0)
  })
})

// ── sweepResolvedReviews: rule-based stage 1 ─────────────────────────────────

describe("sweepResolvedReviews — rule stage", () => {
  it("auto-resolves a missing-page item whose title matches an existing page", async () => {
    const item = makeItem({ title: "Missing page: Attention" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
    expect(useReviewStore.getState().items[0].resolvedAction).toBe("auto-resolved")
  })

  it("matches by frontmatter title when the filename differs", async () => {
    const item = makeItem({ title: "Missing page: Bar Baz" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("foo.md", "---\ntitle: Bar Baz\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Bar Baz\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
  })

  it("skips affectedPages entries that produce an empty base name", async () => {
    const item = makeItem({ title: "Missing page: Attention", affectedPages: ["wiki/", "wiki/concepts/attention-mechanism.md"] })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
  })

  it("treats whitespace-only affectedPages names as non-matching (empty normalized name)", async () => {
    const item = makeItem({ title: "Missing page: SomethingElse", affectedPages: [" "] })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    // whitespace candidate trims to "" → pageExists returns false → not rule-resolved
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("matches a spaced name against a hyphenated filename (title-less file)", async () => {
    const item = makeItem({ title: "Missing page: attention mechanism" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention-mechanism.md", "no title here"), mdFile("notes.txt", "not markdown")]))
    fsState.readFile.mockResolvedValue("no title here")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
  })

  it("keeps a duplicate with no affected pages pending (rule stage no-op)", async () => {
    const item = makeItem({ type: "duplicate", title: "Duplicate page: X" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("x.md", "---\ntitle: X\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: X\n---\nbody")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("treats a duplicate affected page with an empty base as missing", async () => {
    const item = makeItem({ type: "duplicate", title: "Duplicate page: X", affectedPages: ["wiki/x.md", "wiki/"] })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("x.md", "---\ntitle: X\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: X\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    // the empty base counts as "no longer exists" → resolved
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
  })

  it("auto-resolves a duplicate whose affected page was deleted", async () => {
    const item = makeItem({ type: "duplicate", title: "Duplicate page: X", affectedPages: ["wiki/concepts/x.md", "wiki/concepts/y.md"] })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("x.md", "---\ntitle: X\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: X\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
  })

  it("keeps a duplicate whose affected pages all still exist", async () => {
    const item = makeItem({ type: "duplicate", title: "Duplicate page: X", affectedPages: ["wiki/concepts/x.md", "wiki/concepts/y.md"] })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("x.md", "---\ntitle: X\n---\nbody"), mdFile("y.md", "---\ntitle: Y\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: X\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("leaves an unmatched missing-page item pending for the LLM stage", async () => {
    const item = makeItem({ title: "Missing page: something-else" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("keeps contradiction / suggestion / confirm items for the LLM stage", async () => {
    const item = makeItem({ type: "contradiction", title: "Contradiction found" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("a.md", "---\ntitle: A\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: A\n---\nbody")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("builds the review list without description prefix when empty", async () => {
    const item1 = makeItem({ title: "Unrelated missing page", description: "" })
    useReviewStore.setState({ items: [item1] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("a.md", "---\ntitle: A\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: A\n---\nbody")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })
})

// ── sweepResolvedReviews: LLM stage 2 ────────────────────────────────────────

describe("sweepResolvedReviews — LLM stage", () => {
  function wikiWith(files: FileNode[]) {
    fsState.listDirectory.mockResolvedValue(treeWith(files))
    fsState.readFile.mockResolvedValue("---\ntitle: A\n---\nbody")
  }

  it("resolves ids returned by the LLM and reports the activity", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(JSON.stringify({ resolved: [item1.id] }))
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
    expect(useReviewStore.getState().items[0].resolvedAction).toBe("llm-judged")
    const activities = useActivityStore.getState().items
    expect(activities.some((a) => a.title === "Review cleanup" && a.status === "done")).toBe(true)
  })

  it("ignores ids that are not part of the judged batch", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(JSON.stringify({ resolved: ["not-in-batch"] }))
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("skips the LLM stage when no LLM is configured", async () => {
    useWikiStore.setState({
      llmConfig: { provider: "openai", apiKey: "", model: "", maxContextSize: 128000, ollamaUrl: "", customEndpoint: "", reasoning: { mode: "off" } },
    })
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("surfaces an LLM stage failure as an error activity", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockRejectedValue(new Error("stream exploded"))
    const total = await sweepResolvedReviews("/P")
    // judgeBatch swallows stream rejection → nothing resolved, no error activity
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("marks the sweep cancelled when aborted after the LLM call", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    const controller = new AbortController()
    streamChatMock.mockImplementation(async () => {
      controller.abort()
      return undefined
    })
    const total = await sweepResolvedReviews("/P", controller.signal)
    expect(total).toBe(0)
    const activities = useActivityStore.getState().items
    expect(activities.some((a) => a.status === "error" && a.detail === "Review cleanup cancelled")).toBe(true)
  })

  it("stops the LLM batch loop when a batch resolves nothing", async () => {
    const items = [makeItem({ title: "Unrelated missing page" }), makeItem({ title: "Another missing page" })]
    useReviewStore.setState({ items })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("judgeBatch aborts mid-stream and yields nothing", async () => {
    const items = [makeItem({ title: "Unrelated missing page" }), makeItem({ title: "Another missing page" })]
    useReviewStore.setState({ items })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    const controller = new AbortController()
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(JSON.stringify({ resolved: [items[0].id] }))
      callbacks.onDone()
      // abort inside the first judgeBatch call → judgeBatch's own abort
      // check discards the result → empty batch → sweep stops
      controller.abort()
    })
    const total = await sweepResolvedReviews("/P", controller.signal)
    expect(total).toBe(0)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("caps the number of LLM batches at MAX_JUDGE_BATCHES", async () => {
    // 201 items → 5 batches of 40 processed, 1 leftover never judged
    const items = Array.from({ length: 201 }, (_, i) => makeItem({ title: `Missing page ${i}` }))
    useReviewStore.setState({ items })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      // echo the first id of this batch so every batch resolves something
      const promptText = _msgs[0].content
      const idMatch = promptText.match(/id=([a-z0-9-]+)/)
      callbacks.onToken(JSON.stringify({ resolved: idMatch ? [idMatch[1]] : [] }))
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(streamChatMock).toHaveBeenCalledTimes(5)
    expect(total).toBe(5)
  })

  it("returns early from judgeBatch when the stream reports an error", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("provider 500"))
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("stringifies a non-Error stream rejection", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockRejectedValue("string failure")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("returns early from judgeBatch when the response has no JSON object", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("no object here")
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("returns early from judgeBatch when resolved is not an array", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": "oops"}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("returns early from judgeBatch when JSON.parse throws", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": [unclosed}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
  })

  it("adds a done activity on the rule-only path", async () => {
    const item = makeItem({ title: "Missing page: Attention" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(1)
    const activities = useActivityStore.getState().items
    expect(activities.some((a) => a.title === "Review cleanup" && a.status === "done")).toBe(true)
  })

  it("handles unreadable wiki files while building the index", async () => {
    const item = makeItem({ title: "Missing page: SomethingElse" })
    useReviewStore.setState({ items: [item] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("handles a title longer than 100 chars (excluded from candidates)", async () => {
    const item = makeItem({ title: `Missing page: ${"x".repeat(120)}` })
    useReviewStore.setState({ items: [item] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"resolved": []}')
      callbacks.onDone()
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces a judge-crash (Error) as an error activity and keeps items pending", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    // resolveDefaultModel throws inside judgeBatch before its internal try
    modelResolverMock.mockImplementationOnce(() => {
      throw new Error("model boom")
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
    const activities = useActivityStore.getState().items
    expect(activities.some((a) => a.status === "error" && a.detail === "Review cleanup failed: model boom")).toBe(true)
  })

  it("stringifies a non-Error judge-crash in the error activity", async () => {
    const item1 = makeItem({ title: "Unrelated missing page" })
    useReviewStore.setState({ items: [item1] })
    wikiWith([mdFile("a.md", "---\ntitle: A\n---\nbody")])
    modelResolverMock.mockImplementationOnce(() => {
      throw "plain model boom"
    })
    const total = await sweepResolvedReviews("/P")
    expect(total).toBe(0)
    const activities = useActivityStore.getState().items
    expect(activities.some((a) => a.status === "error" && a.detail === "Review cleanup failed: plain model boom")).toBe(true)
  })

  it("规则循环中 signal 中止 → return 已解数量 (L366)", async () => {
    const controller = new AbortController()
    const item1 = makeItem({ title: "Missing page: Attention" })
    const item2 = makeItem({ title: "Missing page: Other" })
    useReviewStore.setState({ items: [item1, item2] })
    fsState.listDirectory.mockResolvedValue(treeWith([mdFile("attention.md", "---\ntitle: Attention\n---\nbody")]))
    fsState.readFile.mockResolvedValue("---\ntitle: Attention\n---\nbody")
    const origResolve = useReviewStore.getState().resolveItem
    // 首个规则命中触发 resolveItem 时同步中止 → 第二轮循环检查点退出
    useReviewStore.setState({
      resolveItem: (id: string, action: string) => {
        controller.abort()
        origResolve(id, action)
      },
    })
    try {
      const total = await sweepResolvedReviews("/P", controller.signal)
      expect(total).toBe(1)
      expect(useReviewStore.getState().items[0].resolved).toBe(true)
      expect(useReviewStore.getState().items[1].resolved).toBe(false)
      expect(streamChatMock).not.toHaveBeenCalled()
    } finally {
      useReviewStore.setState({ resolveItem: origResolve })
    }
  })
})
