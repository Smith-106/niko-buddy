/**
 * Embedding pipeline — standard RAG flow.
 *
 *   1. chunkMarkdown(content)        (src/lib/text-chunker.ts)
 *   2. for each chunk:
 *        fetchEmbedding(title + heading_path + chunk_text)
 *        with auto-halve retry on "input too long" errors
 *   3. vector_upsert_chunks(page_id, [{chunk_index, chunk_text,
 *      heading_path, embedding}, …])
 *
 * Search:
 *   1. fetchEmbedding(query)
 *   2. vector_search_chunks(query_emb, topK × 3)
 *   3. group by page_id, max-pool primary score + weighted tail sum
 *   4. return top-K pages, outer API-compatible with the old per-page
 *      `{id, score}[]` shape; matched chunks available on the
 *      optional `matchedChunks` field for future UI surfacing.
 *
 * HTTP goes through the Tauri plugin (`src/lib/tauri-fetch.ts`) so
 * CORS-unfriendly endpoints work the same as the LLM path.
 */

import { readFile, listDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { ChunkFingerprintIndex, chunkFingerprint } from "@/lib/chunk-fingerprint"

// ── Error surfacing ──────────────────────────────────────────────────────

/**
 * Most recent embedding failure description, so Settings → Embedding
 * can show the user WHY vector search fell back to BM25 instead of
 * silently dropping to keyword match. Cleared on any successful
 * embed.
 */
let lastEmbeddingError: string | null = null

export function getLastEmbeddingError(): string | null {
  return lastEmbeddingError
}

// ── Embedding provider adapters ─────────────────────────────────────────

/**
 * A provider owns the provider-specific differences of the embedding
 * request: endpoint resolution, auth headers, request-body shape,
 * response payload shape, and the JSON path used in error messages.
 * `fetchEmbedding` deals only with this interface, so adding a provider
 * never touches the retry/error pipeline.
 *
 * Dispatch is by fixed order: Google → DashScope → Generic. `matches` is
 * asked in that order and the first to win is used, which reproduces the
 * previous string-sniffing precedence byte-for-byte (Google used to be
 * checked first, then DashScope, then the OpenAI-compatible fallback).
 */
export interface EmbeddingProviderAdapter {
  /** Does this provider own `cfg`? Called in ADAPTERS order, first match wins. */
  matches(cfg: EmbeddingConfig): boolean
  /** Resolve the final POST URL (Google normalises its endpoint here). */
  resolveEndpoint(cfg: EmbeddingConfig): string
  /** Request headers, including auth. */
  buildHeaders(cfg: EmbeddingConfig): Record<string, string>
  /** Request body for `text` (raw object; fetchEmbedding stringifies it once). */
  buildRequest(cfg: EmbeddingConfig, text: string): unknown
  /**
   * Extract the embedding vector from a 2xx payload, or null/undefined
   * when the payload doesn't carry it. The shared pipeline additionally
   * validates it is a non-empty finite-number array.
   */
  parseResponse(payload: unknown): number[] | null | undefined
  /** Human-readable JSON path to the embedding, used in "missing" errors. */
  expectedShapeName: string
}

/** Walk a dotted/index path over an unknown object, tolerating missing nodes. */
function readPath(root: unknown, path: Array<string | number>): unknown {
  let cur = root
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== "object") return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

/** Google Gemini / AI Studio native endpoints. */
const googleEmbeddingAdapter: EmbeddingProviderAdapter = {
  matches: (cfg) => isGoogleEmbeddingConfig(cfg),
  resolveEndpoint: (cfg) => googleEmbeddingEndpoint(cfg),
  buildHeaders: (cfg) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (cfg.apiKey) headers["x-goog-api-key"] = cfg.apiKey
    return headers
  },
  buildRequest: (cfg, text) => googleEmbeddingBody(cfg.model, text, cfg.outputDimensionality),
  parseResponse: (payload) => readPath(payload, ["embedding", "values"]) as number[] | null | undefined,
  expectedShapeName: "embedding.values",
}

/** DashScope / Alibaba Cloud embedding endpoints. */
const dashScopeEmbeddingAdapter: EmbeddingProviderAdapter = {
  matches: (cfg) => isDashScopeEmbeddingConfig(cfg),
  resolveEndpoint: (cfg) => cfg.endpoint,
  buildHeaders: (cfg) => bearerHeaders(cfg),
  buildRequest: (cfg, text) => dashScopeEmbeddingBody(cfg.model, text),
  parseResponse: (payload) => readPath(payload, ["output", "embeddings", 0, "embedding"]) as number[] | null | undefined,
  expectedShapeName: "output.embeddings[0].embedding",
}

/** Generic OpenAI-compatible fallback ({ model, input } / data[0].embedding). */
const genericEmbeddingAdapter: EmbeddingProviderAdapter = {
  // Matches everything: always the final fallback, so dispatch never falls through.
  matches: () => true,
  resolveEndpoint: (cfg) => cfg.endpoint,
  buildHeaders: (cfg) => bearerHeaders(cfg),
  buildRequest: (cfg, text) => ({ model: cfg.model, input: text }),
  parseResponse: (payload) => readPath(payload, ["data", 0, "embedding"]) as number[] | null | undefined,
  expectedShapeName: "data[0].embedding",
}

/** Bearer auth headers for DashScope and the generic OpenAI-compatible path. */
function bearerHeaders(cfg: EmbeddingConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  return headers
}

const ADAPTERS: EmbeddingProviderAdapter[] = [
  googleEmbeddingAdapter,
  dashScopeEmbeddingAdapter,
  genericEmbeddingAdapter,
]

/**
 * Pick the adapter for a config. Hard-coded order Google → DashScope →
 * Generic keeps dispatch byte-identical to the old three-way string sniff.
 */
export function getEmbeddingAdapter(cfg: EmbeddingConfig): EmbeddingProviderAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.matches(cfg)) return adapter
  }
  // Unreachable: genericEmbeddingAdapter.matches is always true.
  return genericEmbeddingAdapter
}

// ── fetchEmbedding with auto-halve retry ────────────────────────────────

/**
 * Heuristic: does this error body look like an "input too long /
 * exceeds model context / payload too large" rejection? True for all
 * the phrasings we've seen from OpenAI, LM Studio, llama.cpp,
 * Ollama, and Azure. Safer to over-match than under-match — a false
 * positive just means a retry at half size, which will still succeed
 * on a real auth/model-id error (it won't) or just log the same error.
 */
export function looksLikeOversizeError(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true
  const lower = body.toLowerCase()
  return (
    lower.includes("too long") ||
    lower.includes("maximum context") ||
    lower.includes("max_tokens") ||
    lower.includes("max tokens") ||
    lower.includes("context length") ||
    lower.includes("token limit") ||
    lower.includes("exceeds") ||
    lower.includes("input length")
  )
}

/**
 * POST one embedding request; on an oversize rejection, halve the text
 * and retry up to `maxRetries` times. Returns null on definitive
 * failure (auth, network, dim mismatch, retries exhausted) with a
 * human-readable reason left in `lastEmbeddingError`.
 *
 * The returned vector represents the (possibly truncated) text that
 * actually got through. Chunker config should be tuned to minimise
 * truncation — this is a safety net, not the main line of defence.
 */
export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig,
  maxRetries = 3,
): Promise<number[] | null> {
  if (!cfg.endpoint) return null

  const isGoogleNative = isGoogleEmbeddingConfig(cfg)
  const isDashScope = isDashScopeEmbeddingConfig(cfg)
  const endpoint = isGoogleNative ? googleEmbeddingEndpoint(cfg) : cfg.endpoint
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cfg.apiKey) {
    if (isGoogleNative) {
      headers["x-goog-api-key"] = cfg.apiKey
    } else if (isDashScope) {
      headers.Authorization = `Bearer ${cfg.apiKey}`
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`
    }
  }

  let current = text
  let attempts = 0
  while (attempts <= maxRetries) {
    attempts++
    try {
      const httpFetch = await getHttpFetch()
      const resp = await httpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          isGoogleNative
            ? googleEmbeddingBody(cfg.model, current, cfg.outputDimensionality)
            : isDashScope
            ? dashScopeEmbeddingBody(cfg.model, current)
            : { model: cfg.model, input: current },
        ),
      })

      if (resp.ok) {
        const data = await resp.json()
        const embedding = isGoogleNative
          ? data?.embedding?.values ?? null
          : isDashScope
          ? data?.output?.embeddings?.[0]?.embedding ?? null
          : data?.data?.[0]?.embedding ?? null
        if (isNonEmptyNumberArray(embedding)) {
          lastEmbeddingError = null
          return embedding
        }
        const expectedShape = isGoogleNative
          ? "embedding.values"
          : isDashScope
          ? "output.embeddings[0].embedding"
          : "data[0].embedding"
        lastEmbeddingError = `Embedding response missing ${expectedShape} (got ${JSON.stringify(data).slice(0, 200)})`
        console.warn(`[Embedding] ${lastEmbeddingError}`)
        return null
      }

      // Non-OK: try to read the body for an oversize hint.
      let bodyText = ""
      try {
        bodyText = await resp.text()
      } catch {
        // ignore — some servers return empty bodies on error
      }

      if (looksLikeOversizeError(resp.status, bodyText)) {
        // Can we still halve-and-retry? Need room on both axes:
        // text not yet at the 64-char floor, and retry budget left.
        if (current.length > 64 && attempts <= maxRetries) {
          const prev = current.length
          current = current.slice(0, Math.floor(current.length / 2))
          console.warn(
            `[Embedding] auto-halving after HTTP ${resp.status} at ${prev} chars → retrying at ${current.length} chars (attempt ${attempts}/${maxRetries + 1})`,
          )
          continue
        }
        // Out of retries on a SERVER-oversize error — give the user a
        // message that names the smallest size that still failed so
        // they can tune Settings → Embedding accordingly.
        lastEmbeddingError = `Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars (${bodyText.slice(0, 160)}).`
        console.warn(`[Embedding] ${lastEmbeddingError}`)
        return null
      }

      // Non-oversize definitive failure (auth, rate limit, server down, …).
      lastEmbeddingError = `API ${resp.status} ${resp.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""} at ${endpoint}`
      console.warn(`[Embedding] ${lastEmbeddingError}`)
      return null
    } catch (err) {
      if (isFetchNetworkError(err)) {
        lastEmbeddingError = `Network error reaching ${endpoint}. Check endpoint URL, API key, and connectivity.`
      } else {
        lastEmbeddingError = err instanceof Error ? err.message : String(err)
      }
      console.warn(`[Embedding] ${lastEmbeddingError}`)
      return null
    }
  }

  // Exhausted retries (only reachable if every halving round triggered
  // the retry branch and then the loop condition ended).
  lastEmbeddingError = `Embedding endpoint rejected every size down to ${current.length} chars — the server's context is smaller than ${current.length * 2}. Lower Settings → Embedding → Max Chunk Chars.`
  console.warn(`[Embedding] ${lastEmbeddingError}`)
  return null
}

function isNonEmptyNumberArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
}

function isGoogleEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  const endpoint = cfg.endpoint.toLowerCase()
  return endpoint.includes("generativelanguage.googleapis.com")
    || /:embedcontent(\?|$)/i.test(endpoint)
}

function isDashScopeEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  const endpoint = cfg.endpoint.toLowerCase()
  return endpoint.includes("dashscope.aliyuncs.com") && endpoint.includes("/embeddings/")
}

function dashScopeEmbeddingBody(model: string, text: string): Record<string, unknown> {
  return {
    model: model.trim(),
    input: {
      texts: [text]
    }
  }
}

function googleEmbeddingEndpoint(cfg: EmbeddingConfig): string {
  const raw = stripGoogleApiKeyQuery(cfg.endpoint.trim()).replace(/\/+$/, "")
  if (/:batchEmbedContents(\?|$)/i.test(raw)) {
    return raw.replace(/:batchEmbedContents/i, ":embedContent")
  }
  if (/:embedContent(\?|$)/i.test(raw)) return raw

  const modelPath = googleModelPath(cfg.model)
  if (/\/models\/[^/?]+$/i.test(raw)) {
    return `${raw}:embedContent`
  }
  return `${raw}/models/${encodeURIComponent(modelPath.replace(/^models\//, ""))}:embedContent`
}

function stripGoogleApiKeyQuery(endpoint: string): string {
  if (!endpoint.includes("?")) return endpoint
  try {
    const url = new URL(endpoint)
    url.searchParams.delete("key")
    return url.toString()
  } catch {
    return endpoint.replace(/([?&])key=[^&]*&?/i, (_, prefix: string) => prefix === "?" ? "?" : "&")
      .replace(/[?&]$/, "")
      .replace("?&", "?")
  }
}

function googleModelPath(model: string): string {
  const trimmed = model.trim()
  if (trimmed.startsWith("models/")) return trimmed
  return `models/${trimmed}`
}

function googleEmbeddingBody(
  model: string,
  text: string,
  outputDimensionality?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: googleModelPath(model),
    content: {
      parts: [{ text }],
    },
  }
  if (typeof outputDimensionality === "number" && Number.isFinite(outputDimensionality) && outputDimensionality > 0) {
    body.output_dimensionality = Math.floor(outputDimensionality)
  }
  return body
}

// ── LanceDB v2 operations (via Rust Tauri commands) ──────────────────────

interface ChunkUpsertInput {
  chunkIndex: number
  chunkText: string
  headingPath: string
  embedding: number[]
}

async function vectorUpsertChunks(
  projectPath: string,
  pageId: string,
  chunks: ChunkUpsertInput[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  await invoke("vector_upsert_chunks", {
    projectPath: pp,
    pageId,
    chunks: chunks.map((c) => ({
      chunk_index: c.chunkIndex,
      chunk_text: c.chunkText,
      heading_path: c.headingPath,
      embedding: c.embedding.map((v) => Math.fround(v)),
    })),
  })
}

interface ChunkSearchResult {
  chunk_id: string
  page_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  score: number
}

async function vectorSearchChunks(
  projectPath: string,
  queryEmbedding: number[],
  topK: number,
): Promise<ChunkSearchResult[]> {
  const pp = normalizePath(projectPath)
  return await invoke("vector_search_chunks", {
    projectPath: pp,
    queryEmbedding: queryEmbedding.map((v) => Math.fround(v)),
    topK,
  })
}

async function vectorDeletePage(projectPath: string, pageId: string): Promise<void> {
  const pp = normalizePath(projectPath)
  await invoke("vector_delete_page", {
    projectPath: pp,
    pageId,
  })
}

async function vectorCountChunks(projectPath: string): Promise<number> {
  const pp = normalizePath(projectPath)
  return await invoke("vector_count_chunks", {
    projectPath: pp,
  })
}

export async function legacyVectorRowCount(projectPath: string): Promise<number> {
  try {
    const pp = normalizePath(projectPath)
    return await invoke("vector_legacy_row_count", {
      projectPath: pp,
    })
  } catch {
    return 0
  }
}

export async function dropLegacyVectorTable(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  await invoke("vector_drop_legacy", {
    projectPath: pp,
  })
}

// ── Chunk enrichment ─────────────────────────────────────────────────────

/**
 * Build the text we actually embed for a chunk: page title + heading
 * breadcrumb + chunk content. The breadcrumb is the most important
 * context for a short chunk — a 300-char excerpt about "Mixture of
 * Experts" is far more findable when the embedded text explicitly
 * names its containing sections.
 */
function enrichChunkForEmbedding(
  pageTitle: string,
  chunk: Chunk,
): string {
  const parts: string[] = []
  if (pageTitle.trim().length > 0) parts.push(pageTitle.trim())
  if (chunk.headingPath.trim().length > 0) parts.push(chunk.headingPath.trim())
  parts.push(chunk.text.trim())
  return parts.join("\n\n")
}

// ── Public API: embedPage / embedAllPages / searchByEmbedding ────────────

/**
 * Embed a wiki page: chunk → per-chunk embed → replace the page's
 * vectors in LanceDB in one batch. Every transient failure leaves the
 * existing v2 rows intact (empty upsert is a no-op Rust-side).
 *
 * Called by ingest.ts after writing a page to disk.
 */
export async function embedPage(
  projectPath: string,
  pageId: string,
  title: string,
  content: string,
  cfg: EmbeddingConfig,
): Promise<void> {
  if (!cfg.enabled || !cfg.model) return

  const t0 = performance.now()
  const chunks = chunkMarkdown(content, {
    targetChars: cfg.maxChunkChars ?? 1000,
    overlapChars: cfg.overlapChunkChars ?? 200,
  })
  if (chunks.length === 0) return

  // Cross-page chunk dedup (A12): before upserting, skip any chunk whose
  // content fingerprint already exists in the project's fingerprint index
  // (owned by another page). This prevents the same content, ingested into
  // multiple pages, from creating duplicate vectors that pollute retrieval.
  const fingerprintIndex = await ChunkFingerprintIndex.load(projectPath)
  fingerprintIndex.removeByPage(pageId)

  const rows: ChunkUpsertInput[] = []
  let failedChunks = 0
  let dedupedChunks = 0
  for (const chunk of chunks) {
    const fp = chunkFingerprint(chunk.text)
    if (fingerprintIndex.has(fp)) {
      // Already owned by a different (live) page — skip re-embedding it.
      dedupedChunks++
      continue
    }
    const embedText = enrichChunkForEmbedding(title, chunk)
    const vec = await fetchEmbedding(embedText, cfg)
    if (vec) {
      rows.push({
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        headingPath: chunk.headingPath,
        embedding: vec,
      })
      fingerprintIndex.add(fp, pageId)
    } else {
      failedChunks++
    }
  }
  await fingerprintIndex.save(projectPath)

  if (rows.length === 0) {
    console.log(
      `[Embedding] Indexed nothing for "${pageId}" — ${chunks.length - dedupedChunks} chunks failed, ${dedupedChunks} deduped. See getLastEmbeddingError().`,
    )
    return
  }

  await vectorUpsertChunks(projectPath, pageId, rows)
  const elapsed = Math.round(performance.now() - t0)
  console.log(
    `[Embedding] Indexed "${pageId}": ${rows.length}/${chunks.length} chunks (${failedChunks} failed, ${dedupedChunks} deduped) in ${elapsed}ms`,
  )
}

/**
 * Embed every wiki content page that isn't already indexed (or re-embed
 * all when `force === true`). Driven from Settings → Embedding or on
 * first enable. Skips structural pages (index / log / overview /
 * purpose / schema) — they're aggregate views, not retrieval targets.
 */
export async function embedAllPages(
  projectPath: string,
  cfg: EmbeddingConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (!cfg.enabled || !cfg.model) return 0

  const pp = normalizePath(projectPath)

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    return 0
  }

  const mdFiles: { id: string; path: string }[] = []
  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      if (node.is_dir && node.children) {
        walk(node.children)
      } else if (!node.is_dir && node.name.endsWith(".md")) {
        const id = node.name.replace(/\.md$/, "")
        if (!["index", "log", "overview", "purpose", "schema"].includes(id)) {
          mdFiles.push({ id, path: node.path })
        }
      }
    }
  }
  walk(tree)

  let done = 0
  for (const file of mdFiles) {
    try {
      const content = await readFile(file.path)
      const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
      const title = titleMatch ? titleMatch[1].trim() : file.id
      await embedPage(pp, file.id, title, content, cfg)
    } catch {
      // skip — individual file failure doesn't halt the batch
    }
    done++
    if (onProgress) onProgress(done, mdFiles.length)
  }

  return done
}

/**
 * Vector search over the v2 chunk store, shaped to stay API-compatible
 * with the pre-0.3.11 per-page interface. Under the hood:
 *   1. Embed the query.
 *   2. Over-fetch top-K × 3 chunks.
 *   3. Group by page_id; score each page as max(chunk_scores) plus
 *      0.3 × sum of the other chunks' scores (bounded — capped at
 *      1.0 - max_score), so a page with two good chunks outranks a
 *      page with one equally-good chunk and a weaker one.
 *   4. Sort pages by score, return top-K.
 *
 * The optional `matchedChunks` field gives callers the raw chunk
 * context when they want to surface "matched in this section" in
 * the UI. Existing callers can ignore it.
 */
export interface PageSearchResult {
  id: string
  score: number
  matchedChunks?: Array<{ text: string; headingPath: string; score: number }>
}

export async function searchByEmbedding(
  projectPath: string,
  query: string,
  cfg: EmbeddingConfig,
  topK: number = 10,
): Promise<PageSearchResult[]> {
  if (!cfg.enabled || !cfg.model) return []

  const queryEmb = await fetchEmbedding(query, cfg)
  if (!queryEmb) return []

  const t0 = performance.now()
  let rawChunks: ChunkSearchResult[] = []
  try {
    rawChunks = await vectorSearchChunks(projectPath, queryEmb, Math.max(topK * 3, 30))
  } catch (err) {
    console.log(`[Embedding] LanceDB chunk search failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
  if (rawChunks.length === 0) return []

  // Group by page; keep every matched chunk's score so we can compute
  // a blended per-page score.
  const byPage = new Map<string, ChunkSearchResult[]>()
  for (const c of rawChunks) {
    const bucket = byPage.get(c.page_id)
    if (bucket) bucket.push(c)
    else byPage.set(c.page_id, [c])
  }

  const ranked: PageSearchResult[] = []
  for (const [pageId, chunks] of byPage.entries()) {
    chunks.sort((a, b) => b.score - a.score)
    const top = chunks[0].score
    const tail = chunks.slice(1).reduce((sum, c) => sum + c.score, 0)
    // Cap the tail contribution so many-weak-chunks can't drown a
    // single-strong-chunk page. 0.3 weight is empirical; adjust later
    // with real data.
    const blended = top + Math.min(tail * 0.3, Math.max(0, 1 - top))
    ranked.push({
      id: pageId,
      score: blended,
      matchedChunks: chunks.slice(0, 3).map((c) => ({
        text: c.chunk_text,
        headingPath: c.heading_path,
        score: c.score,
      })),
    })
  }
  ranked.sort((a, b) => b.score - a.score)

  const elapsed = Math.round(performance.now() - t0)
  console.log(
    `[Embedding] LanceDB chunk search: ${rawChunks.length} chunks → ${ranked.length} pages in ${elapsed}ms`,
  )

  return ranked.slice(0, topK)
}

/**
 * Remove a page's embeddings from the v2 index. Called from the
 * source-delete flow so orphaned chunks don't pollute future searches.
 */
export async function removePageEmbedding(
  projectPath: string,
  pageId: string,
): Promise<void> {
  try {
    await vectorDeletePage(projectPath, pageId)
  } catch {
    // non-critical
  }
  // Drop the page's fingerprints (A12) so its freed chunks can re-embed
  // elsewhere; vector deletion frees the slot regardless.
  try {
    const index = await ChunkFingerprintIndex.load(projectPath)
    index.removeByPage(pageId)
    await index.save(projectPath)
  } catch {
    // non-critical
  }
}

/**
 * Total chunks in the v2 index. Surfaces "N chunks indexed" status
 * in Settings.
 */
export async function getEmbeddingCount(projectPath: string): Promise<number> {
  try {
    return await vectorCountChunks(projectPath)
  } catch {
    return 0
  }
}
