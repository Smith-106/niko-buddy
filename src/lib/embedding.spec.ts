import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

const fsState = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))
const invokeMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsState)
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => fetchMock,
  isFetchNetworkError: (err: unknown) =>
    err instanceof Error && /network|failed to fetch|load failed/i.test(err.message),
}))

import {
  dropLegacyVectorTable,
  embedAllPages,
  embedPage,
  fetchEmbedding,
  getEmbeddingCount,
  getLastEmbeddingError,
  legacyVectorRowCount,
  looksLikeOversizeError,
  removePageEmbedding,
  searchByEmbedding,
} from "./embedding"

function cfg(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:1234/v1/embeddings",
    apiKey: "sk-test",
    model: "text-embedding-model",
    ...overrides,
  }
}

function okJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function wikiTree(projectPath: string): FileNode[] {
  return [
    {
      name: "entities",
      path: `${projectPath}/wiki/entities`,
      is_dir: true,
      children: [
        { name: "alpha.md", path: `${projectPath}/wiki/entities/alpha.md`, is_dir: false },
        { name: "beta.md", path: `${projectPath}/wiki/entities/beta.md`, is_dir: false },
      ],
    },
    { name: "empty-dir", path: `${projectPath}/wiki/empty-dir`, is_dir: true },
    { name: "index.md", path: `${projectPath}/wiki/index.md`, is_dir: false },
    { name: "log.md", path: `${projectPath}/wiki/log.md`, is_dir: false },
  ]
}

beforeEach(() => {
  fetchMock.mockReset()
  invokeMock.mockReset()
  fsState.readFile.mockReset()
  fsState.listDirectory.mockReset()
})

afterEach(() => {
  vi.mocked(fetchMock).mockReset()
})

// ── looksLikeOversizeError ────────────────────────────────────────────────────

describe("looksLikeOversizeError", () => {
  it("flags 413 always", () => {
    expect(looksLikeOversizeError(413, "")).toBe(true)
  })

  it("flags known message patterns", () => {
    expect(looksLikeOversizeError(400, "input is too long")).toBe(true)
    expect(looksLikeOversizeError(400, "maximum context length exceeded")).toBe(true)
    expect(looksLikeOversizeError(400, "max_tokens exceeded")).toBe(true)
    expect(looksLikeOversizeError(400, "max tokens")).toBe(true)
    expect(looksLikeOversizeError(400, "context length")).toBe(true)
    expect(looksLikeOversizeError(400, "token limit")).toBe(true)
    expect(looksLikeOversizeError(400, "value exceeds limits")).toBe(true)
    expect(looksLikeOversizeError(400, "input length")).toBe(true)
  })

  it("does not flag unrelated errors", () => {
    expect(looksLikeOversizeError(401, "invalid api key")).toBe(false)
    expect(looksLikeOversizeError(500, "internal server error")).toBe(false)
  })
})

// ── fetchEmbedding: OpenAI-compatible default path ────────────────────────────

describe("fetchEmbedding — default (OpenAI-compatible) endpoint", () => {
  it("returns null when no endpoint is configured", async () => {
    expect(await fetchEmbedding("hello", cfg({ endpoint: "" }))).toBeNull()
  })

  it("POSTs {model, input} with Bearer auth and returns data[0].embedding", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
    const vec = await fetchEmbedding("hello", cfg())
    expect(vec).toEqual([0.1, 0.2, 0.3])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:1234/v1/embeddings")
    expect(init.headers.Authorization).toBe("Bearer sk-test")
    expect(JSON.parse(init.body)).toEqual({ model: "text-embedding-model", input: "hello" })
    expect(getLastEmbeddingError()).toBeNull()
  })

  it("accepts a non-finite-free numeric array", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [0] }] }))
    expect(await fetchEmbedding("x", cfg())).toEqual([0])
  })

  it("rejects a malformed embedding shape", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: "nope" }] }))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toContain("Embedding response missing data[0].embedding")
  })

  it("rejects a response with an empty embedding array", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [] }] }))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
  })

  it("rejects a response with an empty data array", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [] }))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toContain("missing data[0].embedding")
  })

  it("rejects embeddings containing non-finite numbers", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1, Number.NaN] }] }))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
  })

  it("auto-halves text on oversize errors and succeeds on a smaller attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("input is too long", { status: 400 }))
      .mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [7] }] }))
    const long = "a".repeat(200)
    const vec = await fetchEmbedding(long, cfg())
    expect(vec).toEqual([7])
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).input)
    expect(bodies[1].length).toBe(100)
  })

  it("gives up halving when the text hits the 64-char floor", async () => {
    fetchMock.mockResolvedValue(new Response("context length exceeded", { status: 400 }))
    const short = "a".repeat(64)
    expect(await fetchEmbedding(short, cfg(), 2)).toBeNull()
    expect(getLastEmbeddingError()).toContain("Endpoint rejected input even at")
  })

  it("falls through to the exhausted-retries tail when maxRetries is negative", async () => {
    // while (attempts <= maxRetries) is false from the start → the loop body
    // never runs and the final exhausted-retries branch reports the original
    // size. Defensive edge case for a caller passing a bogus retry budget.
    expect(await fetchEmbedding("hello", cfg(), -1)).toBeNull()
    expect(getLastEmbeddingError()).toContain("rejected every size down to 5 chars")
  })

  it("exhausts the retry budget and reports the smallest failing size", async () => {
    fetchMock.mockImplementation(async () => new Response("too long", { status: 400 }))
    // maxRetries=1: attempt 1 (300 chars) halves to 150; attempt 2 has no
    // retry budget left → "Endpoint rejected input even at 150 chars".
    expect(await fetchEmbedding("a".repeat(300), cfg(), 1)).toBeNull()
    expect(getLastEmbeddingError()).toContain("Endpoint rejected input even at 150 chars")
  })

  it("reports a definitive non-oversize HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401, statusText: "Unauthorized" }))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toContain("API 401 Unauthorized")
    expect(getLastEmbeddingError()).toContain("http://127.0.0.1:1234/v1/embeddings")
  })

  it("surfaces network errors distinctly", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toContain("Network error reaching")
  })

  it("surfaces non-network thrown errors with their message", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"))
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toBe("boom")
  })

  it("stringifies non-Error thrown values", async () => {
    fetchMock.mockRejectedValueOnce("plain string failure")
    expect(await fetchEmbedding("x", cfg())).toBeNull()
    expect(getLastEmbeddingError()).toBe("plain string failure")
  })

  it("does not attach auth headers when no api key is set", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    await fetchEmbedding("x", cfg({ apiKey: "" }))
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })
})

// ── fetchEmbedding: Google native endpoint ────────────────────────────────────

describe("fetchEmbedding — Google native endpoint", () => {
  const googleCfg = (endpoint: string) =>
    cfg({ endpoint, apiKey: "gkey", model: "models/text-embedding-004", outputDimensionality: 256 })

  it("uses x-goog-api-key header and reads embedding.values", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [0.5] } }))
    const vec = await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"))
    expect(vec).toEqual([0.5])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(":embedContent")
    expect(init.headers["x-goog-api-key"]).toBe("gkey")
    const body = JSON.parse(init.body)
    expect(body.content.parts[0].text).toBe("hi")
    expect(body.output_dimensionality).toBe(256)
  })

  it("rewrites a batchEmbedContents endpoint to embedContent", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/x:batchEmbedContents"))
    expect(fetchMock.mock.calls[0][0]).toContain(":embedContent")
  })

  it("appends :embedContent to a /models/<id> endpoint", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004"))
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent")
  })

  it("builds the full /models path when the endpoint is a bare host", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    // bare model name (no models/ prefix) → prefixed by googleModelPath
    await fetchEmbedding("hi", { ...googleCfg("https://generativelanguage.googleapis.com/v1beta"), model: "text-embedding-004" })
    expect(fetchMock.mock.calls[0][0]).toContain("/models/text-embedding-004:embedContent")
  })

  it("strips a ?key= query from the endpoint before use", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=SECRET"))
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain("SECRET")
    expect(url).not.toContain("?")
  })

  it("falls back to regex stripping when the endpoint is not a valid URL", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    await fetchEmbedding("hi", googleCfg("http://localhost:port with spaces/models/x:embedContent?key=SECRET"))
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain("SECRET")
  })

  it("strips a non-leading &key= query param in the regex fallback", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    await fetchEmbedding("hi", googleCfg("http://localhost:port with spaces/models/x:embedContent?a=1&key=SECRET"))
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain("SECRET")
    expect(url).toContain("a=1")
  })

  it("skips output_dimensionality when invalid", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: [1] } }))
    const noDim = { ...googleCfg("https://generativelanguage.googleapis.com/v1beta/models/x:embedContent"), outputDimensionality: undefined }
    await fetchEmbedding("hi", noDim)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_dimensionality).toBeUndefined()
  })

  it("reports a missing embedding.values shape", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: { values: "bad" } }))
    expect(await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/x:embedContent"))).toBeNull()
    expect(getLastEmbeddingError()).toContain("embedding.values")
  })

  it("handles a completely empty google embedding payload", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ embedding: {} }))
    expect(await fetchEmbedding("hi", googleCfg("https://generativelanguage.googleapis.com/v1beta/models/x:embedContent"))).toBeNull()
    expect(getLastEmbeddingError()).toContain("missing embedding.values")
  })
})

// ── fetchEmbedding: DashScope endpoint ────────────────────────────────────────

describe("fetchEmbedding — DashScope endpoint", () => {
  const dashScopeCfg = () =>
    cfg({ endpoint: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding", apiKey: "ds-key", model: "text-embedding-v4" })

  it("sends the DashScope body shape and reads output.embeddings[0].embedding", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ output: { embeddings: [{ embedding: [3, 4] }] } }))
    const vec = await fetchEmbedding("你好", dashScopeCfg())
    expect(vec).toEqual([3, 4])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("dashscope.aliyuncs.com")
    expect(init.headers.Authorization).toBe("Bearer ds-key")
    const body = JSON.parse(init.body)
    expect(body.input).toEqual({ texts: ["你好"] })
    expect(body.model.trim()).toBe("text-embedding-v4")
  })

  it("reports a missing DashScope shape", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ output: {} }))
    expect(await fetchEmbedding("hi", dashScopeCfg())).toBeNull()
    expect(getLastEmbeddingError()).toContain("output.embeddings[0].embedding")
  })
})

// ── embedPage ─────────────────────────────────────────────────────────────────

describe("embedPage", () => {
  it("returns early when disabled or model missing", async () => {
    await embedPage("/P", "page", "Title", "content", cfg({ enabled: false }))
    await embedPage("/P", "page", "Title", "content", cfg({ model: "" }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("returns early when the page chunks to nothing", async () => {
    await embedPage("/P", "page", "Title", "", cfg())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("embeds every chunk and upserts rows into LanceDB", async () => {
    fetchMock.mockImplementation(async () => okJsonResponse({ data: [{ embedding: [1, 2] }] }))
    const content = "---\ntitle: Alpha Page\n---\n\n# Alpha Page\n\n" + "body text ".repeat(200)
    await embedPage("/P", "alpha", "Alpha Page", content, cfg({ maxChunkChars: 300, overlapChunkChars: 50 }))
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    const upsert = invokeMock.mock.calls.find((c) => c[0] === "vector_upsert_chunks")
    expect(upsert).toBeTruthy()
    const [, args] = upsert
    expect(args.projectPath).toBe("/P")
    expect(args.pageId).toBe("alpha")
    expect(args.chunks.length).toBeGreaterThan(1)
    for (const row of args.chunks) {
      expect(row.chunk_index).toBeTypeOf("number")
      expect(typeof row.embedding[0]).toBe("number")
    }
  })

  it("skips failed chunks and logs when nothing was indexed", async () => {
    fetchMock.mockResolvedValue(new Response("no", { status: 500 }))
    const content = "---\ntitle: T\n---\n\n# T\n\n" + "body text ".repeat(200)
    await embedPage("/P", "alpha", "T", content, cfg({ maxChunkChars: 300 }))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("handles empty title and headingless content gracefully", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({ data: [{ embedding: [1] }] }))
    await embedPage("/P", "alpha", "", "plain content without frontmatter or headings ".repeat(10), cfg())
    expect(fetchMock).toHaveBeenCalled()
  })
})

// ── embedAllPages ─────────────────────────────────────────────────────────────

describe("embedAllPages", () => {
  it("returns 0 when disabled or model missing", async () => {
    expect(await embedAllPages("/P", cfg({ enabled: false }))).toBe(0)
    expect(await embedAllPages("/P", cfg({ model: "" }))).toBe(0)
  })

  it("returns 0 when the wiki listing fails", async () => {
    fsState.listDirectory.mockRejectedValueOnce(new Error("ENOENT"))
    expect(await embedAllPages("/P", cfg())).toBe(0)
  })

  it("walks the tree, skips structural pages, and reports progress", async () => {
    fsState.listDirectory.mockResolvedValue(wikiTree("/P"))
    fsState.readFile.mockImplementation(async (path: string) =>
      String(path).endsWith("alpha.md")
        ? "---\ntitle: Alpha\n---\n\n# Alpha\n\ncontent ".repeat(50)
        : "---\ntitle: Beta\n---\n\n# Beta\n\ncontent ".repeat(50),
    )
    fetchMock.mockImplementation(async () => okJsonResponse({ data: [{ embedding: [1] }] }))
    const progress: Array<[number, number]> = []
    const done = await embedAllPages("/P", cfg(), (d, t) => progress.push([d, t]))
    expect(done).toBe(2)
    expect(progress).toEqual([[1, 2], [2, 2]])
    // structural pages never embedded
    const upserts = invokeMock.mock.calls.filter((c) => c[0] === "vector_upsert_chunks")
    expect(upserts).toHaveLength(2)
    expect(upserts.map((c) => c[1].pageId)).toEqual(["alpha", "beta"])
  })

  it("skips individual files that fail to read", async () => {
    fsState.listDirectory.mockResolvedValue(wikiTree("/P"))
    fsState.readFile.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("content ".repeat(30))
    fetchMock.mockResolvedValue(okJsonResponse({ data: [{ embedding: [1] }] }))
    const done = await embedAllPages("/P", cfg())
    expect(done).toBe(2)
  })

  it("uses the file id as title when no frontmatter title exists", async () => {
    fsState.listDirectory.mockResolvedValue(wikiTree("/P"))
    fsState.readFile.mockResolvedValue("no frontmatter here at all ".repeat(20))
    fetchMock.mockImplementation(async () => okJsonResponse({ data: [{ embedding: [1] }] }))
    await embedAllPages("/P", cfg())
    // both files still embedded (title fell back to id)
    expect(invokeMock.mock.calls.filter((c) => c[0] === "vector_upsert_chunks")).toHaveLength(2)
  })
})

// ── searchByEmbedding ─────────────────────────────────────────────────────────

describe("searchByEmbedding", () => {
  function chunkSearchResult(overrides: Partial<{ page_id: string; score: number; chunk_text: string; heading_path: string; chunk_index: number }> = {}) {
    return {
      chunk_id: "c1",
      page_id: "alpha",
      chunk_index: 0,
      chunk_text: "matched text",
      heading_path: "# Alpha",
      score: 0.9,
      ...overrides,
    }
  }

  it("returns [] when disabled or model missing", async () => {
    expect(await searchByEmbedding("/P", "q", cfg({ enabled: false }))).toEqual([])
    expect(await searchByEmbedding("/P", "q", cfg({ model: "" }))).toEqual([])
  })

  it("returns [] when the query fails to embed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500 }))
    expect(await searchByEmbedding("/P", "q", cfg())).toEqual([])
  })

  it("returns [] when the vector search throws", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockRejectedValueOnce(new Error("lancedb down"))
    expect(await searchByEmbedding("/P", "q", cfg())).toEqual([])
  })

  it("returns [] when the vector search throws a non-Error", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockRejectedValueOnce("lancedb down string")
    expect(await searchByEmbedding("/P", "q", cfg())).toEqual([])
  })

  it("returns [] when no chunks match", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockResolvedValueOnce([])
    expect(await searchByEmbedding("/P", "q", cfg())).toEqual([])
  })

  it("blends per-page scores (max + capped tail) and returns topK", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockResolvedValueOnce([
      chunkSearchResult({ page_id: "alpha", score: 0.9, chunk_text: "a1", heading_path: "# A" }),
      chunkSearchResult({ page_id: "alpha", score: 0.8, chunk_text: "a2" }),
      chunkSearchResult({ page_id: "alpha", score: 0.7, chunk_text: "a3" }),
      chunkSearchResult({ page_id: "beta", score: 0.5, chunk_text: "b1" }),
    ])
    const results = await searchByEmbedding("/P", "q", cfg(), 5)
    expect(results[0].id).toBe("alpha")
    // tail capped at 1 - top: 0.9 + min(0.3*1.5, 0.1) = 0.9 + 0.1
    expect(results[0].score).toBeCloseTo(1.0)
    expect(results[0].matchedChunks).toHaveLength(3)
    expect(results[1].id).toBe("beta")
    expect(results[1].score).toBeCloseTo(0.5)
  })

  it("uses the 30-chunk floor for small topK and slices the final result", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockResolvedValueOnce([chunkSearchResult({ page_id: "alpha", score: 0.6 }), chunkSearchResult({ page_id: "beta", score: 0.4 }), chunkSearchResult({ page_id: "gamma", score: 0.3 })])
    const results = await searchByEmbedding("/P", "q", cfg(), 2)
    expect(invokeMock.mock.calls[0][1].topK).toBe(30)
    expect(results).toHaveLength(2)
  })

  it("passes an inflated topK when topK*3 exceeds the floor", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ data: [{ embedding: [1] }] }))
    invokeMock.mockResolvedValueOnce([chunkSearchResult()])
    await searchByEmbedding("/P", "q", cfg(), 100)
    expect(invokeMock.mock.calls[0][1].topK).toBe(300)
  })
})

// ── vector helpers ────────────────────────────────────────────────────────────

describe("vector wrapper functions", () => {
  it("removePageEmbedding deletes the page", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await removePageEmbedding("/P", "alpha")
    expect(invokeMock).toHaveBeenCalledWith("vector_delete_page", { projectPath: "/P", pageId: "alpha" })
  })

  it("removePageEmbedding swallows invoke failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("down"))
    await expect(removePageEmbedding("/P", "alpha")).resolves.toBeUndefined()
  })

  it("getEmbeddingCount returns the count", async () => {
    invokeMock.mockResolvedValueOnce(42)
    expect(await getEmbeddingCount("/P")).toBe(42)
  })

  it("getEmbeddingCount falls back to 0 on failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("down"))
    expect(await getEmbeddingCount("/P")).toBe(0)
  })

  it("legacyVectorRowCount returns the legacy count", async () => {
    invokeMock.mockResolvedValueOnce(7)
    expect(await legacyVectorRowCount("/P")).toBe(7)
  })

  it("legacyVectorRowCount falls back to 0 on failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("down"))
    expect(await legacyVectorRowCount("/P")).toBe(0)
  })

  it("dropLegacyVectorTable invokes the drop command", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await dropLegacyVectorTable("/P")
    expect(invokeMock).toHaveBeenCalledWith("vector_drop_legacy", { projectPath: "/P" })
  })
})
