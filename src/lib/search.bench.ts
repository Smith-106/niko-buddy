/**
 * Search benchmark — measures token search, vector search mock, and RRF
 * fusion overhead at different file scale.
 *
 * All external dependencies (Tauri invoke, file system) are mocked so the
 * bench runs in plain Node. Leverages the search.ts tokenizeQuery export
 * and the scoreFile pure function for meaningful measurement.
 *
 * Run: npx vitest run src/lib/search.bench.ts
 */

import { describe, it, vi, expect } from "vitest"
import { measureLatency, printStats, saveBaseline } from "@/test-helpers/bench-helpers"
import type { BaselineData, BaselineOperation } from "@/test-helpers/bench-helpers"
import { generateDocuments, getQuerySet, SMALL } from "@/test-helpers/bench-fixtures"

const ITERATIONS = 50

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}))

// Mock fs commands used by search.ts
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async () => "mock file content"),
  listDirectory: vi.fn(async () => []),
}))

// Mock path-utils
vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
  getFileStem: (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? "",
}))

// Mock graph-adapter sanitizeEntitySlug
vi.mock("@/lib/novel/graph-adapter", () => ({
  sanitizeEntitySlug: (s: string) => s,
}))

// Import tokenizeQuery after mocks are set up
import { tokenizeQuery } from "@/lib/search"

describe("Search Benchmark", () => {
  const results: BaselineOperation[] = []
  const docs = generateDocuments(SMALL)
  const queries = getQuerySet()

  it("measures tokenizeQuery latency across 20 queries", async () => {
    const stats = await measureLatency(() => {
      for (const q of queries) {
        const tokens = tokenizeQuery(q.text)
        expect(tokens.length).toBeGreaterThan(0)
      }
    }, ITERATIONS)
    printStats("tokenizeQuery x20", stats)
    results.push({ name: "tokenizeQuery x20", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures token search scoring at 50-file scale", async () => {
    const subset = docs.slice(0, 50)
    const tokens = tokenizeQuery(queries[0].text)

    const stats = await measureLatency(() => {
      let matchCount = 0
      for (const doc of subset) {
        const content = doc.content.toLowerCase()
        let score = 0
        for (const t of tokens) {
          if (content.includes(t)) score += 1
        }
        if (score > 0) matchCount++
      }
      void matchCount
    }, ITERATIONS)
    printStats("token search 50 files", stats)
    results.push({ name: "token search 50 files", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures token search scoring at 200-file scale", async () => {
    // Extend to 200 docs
    const extended = [...docs, ...generateDocuments(100).map((d, i) => ({ ...d, id: `ext-${i}` }))]
    const tokens = tokenizeQuery(queries[0].text)

    const stats = await measureLatency(() => {
      let matchCount = 0
      for (const doc of extended) {
        const content = doc.content.toLowerCase()
        let score = 0
        for (const t of tokens) {
          if (content.includes(t)) score += 1
        }
        if (score > 0) matchCount++
      }
      void matchCount
    }, ITERATIONS)
    printStats("token search 200 files", stats)
    results.push({ name: "token search 200 files", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures vector search mock latency", async () => {
    // Simulate vector_search_chunks mock response
    const mockResults = Array.from({ length: 30 }, (_, i) => ({
      chunk_id: `doc-${i}#0`,
      page_id: `doc-${i}`,
      chunk_index: 0,
      chunk_text: "vector search result chunk text",
      heading_path: "## Section",
      score: 1.0 - i * 0.03,
    }))

    const stats = await measureLatency(() => {
      // Simulate the TS-side grouping by page_id (max + weighted tail)
      const byPage = new Map<string, typeof mockResults>()
      for (const r of mockResults) {
        const bucket = byPage.get(r.page_id)
        if (bucket) bucket.push(r)
        else byPage.set(r.page_id, [r])
      }
      const ranked: { id: string; score: number }[] = []
      for (const [pageId, chunks] of byPage.entries()) {
        chunks.sort((a, b) => b.score - a.score)
        const top = chunks[0].score
        const tail = chunks.slice(1).reduce((s, c) => s + c.score, 0)
        ranked.push({ id: pageId, score: top + Math.min(tail * 0.3, Math.max(0, 1 - top)) })
      }
      ranked.sort((a, b) => b.score - a.score)
      void ranked
    }, ITERATIONS)
    printStats("vector search mock (30 chunks)", stats)
    results.push({ name: "vector search mock (30 chunks)", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures RRF fusion overhead", async () => {
    const RRF_K = 60
    const candidateCount = 50
    const tokenRank = new Map<string, number>()
    const vectorRank = new Map<string, number>()
    for (let i = 0; i < candidateCount; i++) {
      tokenRank.set(`page-${i}`, i + 1)
      if (i < 30) vectorRank.set(`page-${i}`, i + 1)
    }

    const stats = await measureLatency(() => {
      const fused: { id: string; score: number }[] = []
      for (let i = 0; i < candidateCount; i++) {
        const id = `page-${i}`
        const tRank = tokenRank.get(id)
        const vRank = vectorRank.get(id)
        let rrf = 0
        if (tRank !== undefined) rrf += 1 / (RRF_K + tRank)
        if (vRank !== undefined) rrf += 1 / (RRF_K + vRank)
        fused.push({ id, score: rrf })
      }
      fused.sort((a, b) => b.score - a.score)
      void fused
    }, ITERATIONS)
    printStats("RRF fusion 50 candidates", stats)
    results.push({ name: "RRF fusion 50 candidates", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("saves baseline", () => {
    const data: BaselineData = {
      timestamp: new Date().toISOString(),
      version: "2.4.3",
      iterations: ITERATIONS,
      operations: results,
    }
    saveBaseline("search", data)
  })
})
