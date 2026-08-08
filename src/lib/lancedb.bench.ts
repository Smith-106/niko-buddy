/**
 * LanceDB benchmark — measures upsert throughput, search latency, and
 * cold vs hot cache patterns via mocked IPC.
 *
 * All Tauri invoke calls are mocked. This bench measures the JS-side
 * serialization and data-preparation overhead of the embedding pipeline,
 * not the actual LanceDB Rust backend.
 *
 * Run: npx vitest run src/lib/lancedb.bench.ts
 */

import { describe, it, vi } from "vitest"
import { measureLatency, printStats, saveBaseline } from "@/test-helpers/bench-helpers"
import type { BaselineData, BaselineOperation } from "@/test-helpers/bench-helpers"
import { generateEmbeddings } from "@/test-helpers/bench-fixtures"

const ITERATIONS = 50

// Mock Tauri invoke — track call counts for throughput measurement
let invokeCallCount = 0
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCallCount++
    if (cmd === "vector_upsert_chunks") {
      // Simulate successful upsert
      return
    }
    if (cmd === "vector_search_chunks") {
      // Return mock search results
      const topK = (args?.topK as number) ?? 10
      return Array.from({ length: topK }, (_, i) => ({
        chunk_id: `bench-page#${i}`,
        page_id: "bench-page",
        chunk_index: i,
        chunk_text: `Benchmark chunk ${i} for search latency measurement`,
        heading_path: `## Section ${i}`,
        score: 1.0 - i * 0.05,
      }))
    }
    if (cmd === "vector_count_chunks") {
      return 500
    }
    return {}
  }),
}))

// Mock path-utils
vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}))

describe("LanceDB Benchmark", () => {
  const results: BaselineOperation[] = []

  it("measures upsert IPC serialization throughput (10 chunks)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const embeddings = generateEmbeddings(10, 384)
    const chunks = embeddings.map((vec, i) => ({
      chunkIndex: i,
      chunkText: `Chunk ${i}: This is benchmark content for upsert serialization measurement.`,
      headingPath: `## Heading ${i}`,
      embedding: Array.from(vec),
    }))

    invokeCallCount = 0
    const stats = await measureLatency(async () => {
      await invoke("vector_upsert_chunks", {
        projectPath: "/mock/project",
        pageId: "bench-upsert",
        chunks: chunks.map((c) => ({
          chunk_index: c.chunkIndex,
          chunk_text: c.chunkText,
          heading_path: c.headingPath,
          embedding: c.embedding.map((v) => Math.fround(v)),
        })),
      })
    }, ITERATIONS)
    printStats("upsert 10 chunks x384d", stats)
    results.push({ name: "upsert 10 chunks x384d", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures search latency mock (topK=10)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const queryEmb = Array.from(generateEmbeddings(1, 384)[0])

    const stats = await measureLatency(async () => {
      const results = await invoke("vector_search_chunks", {
        projectPath: "/mock/project",
        queryEmbedding: queryEmb.map((v) => Math.fround(v)),
        topK: 10,
      })
      void results
    }, ITERATIONS)
    printStats("search topK=10", stats)
    results.push({ name: "search topK=10", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures cold-start pattern (first invoke per iteration)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")

    const stats = await measureLatency(async () => {
      // Simulate cold start: count + search in sequence
      await invoke("vector_count_chunks", { projectPath: "/mock/project" })
      await invoke("vector_search_chunks", {
        projectPath: "/mock/project",
        queryEmbedding: Array.from(generateEmbeddings(1, 384)[0]).map((v) => Math.fround(v)),
        topK: 10,
      })
    }, ITERATIONS)
    printStats("cold start (count+search)", stats)
    results.push({ name: "cold start (count+search)", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures hot-cache pattern (repeated searches)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    // Warm up
    for (let i = 0; i < 5; i++) {
      await invoke("vector_search_chunks", {
        projectPath: "/mock/project",
        queryEmbedding: Array.from(generateEmbeddings(1, 384)[0]),
        topK: 10,
      })
    }

    const stats = await measureLatency(async () => {
      await invoke("vector_search_chunks", {
        projectPath: "/mock/project",
        queryEmbedding: Array.from(generateEmbeddings(1, 384)[0]).map((v) => Math.fround(v)),
        topK: 10,
      })
    }, ITERATIONS)
    printStats("hot cache (repeated search)", stats)
    results.push({ name: "hot cache (repeated search)", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("saves baseline", () => {
    const data: BaselineData = {
      timestamp: new Date().toISOString(),
      version: "2.4.3",
      iterations: ITERATIONS,
      operations: results,
    }
    saveBaseline("lancedb", data)
  })
})
