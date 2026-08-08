/**
 * IPC latency benchmark — measures Tauri IPC round-trip overhead for
 * empty, compute-bound, and large-payload scenarios.
 *
 * All invoke calls are mocked. This bench isolates the JS-side overhead of
 * building arguments, awaiting promises, and handling responses — the
 * actual IPC serialization cost requires a running Tauri app.
 *
 * Comparison note: niko-studio uses HTTP proxy mode (localhost REST API),
 * while QMAI uses Tauri IPC invoke. This bench documents the pattern
 * for future cross-project comparison.
 *
 * Run: npx vitest run src/lib/ipc-latency.bench.ts
 */

import { describe, it, vi } from "vitest"
import { measureLatency, printStats, saveBaseline } from "@/test-helpers/bench-helpers"
import type { BaselineData, BaselineOperation } from "@/test-helpers/bench-helpers"

const ITERATIONS = 50

// Mock Tauri invoke with configurable response sizes
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_file") {
      const size = (args?.size as number) ?? 1024
      // Generate a string of the requested size
      return "x".repeat(size)
    }
    if (cmd === "vector_search_chunks") {
      return Array.from({ length: 10 }, (_, i) => ({
        chunk_id: `ipc-page#${i}`,
        page_id: "ipc-page",
        chunk_index: i,
        chunk_text: "IPC benchmark chunk content for latency measurement",
        heading_path: "## Section",
        score: 0.95 - i * 0.05,
      }))
    }
    return {}
  }),
}))

describe("IPC Latency Benchmark", () => {
  const results: BaselineOperation[] = []

  it("measures IPC empty round-trip (read 1KB file)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const stats = await measureLatency(async () => {
      const content = await invoke("read_file", { path: "/mock/file.md", size: 1024 })
      void content
    }, ITERATIONS)
    printStats("IPC 1KB read", stats)
    results.push({ name: "IPC 1KB read", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures IPC + compute (vector search)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const queryEmb = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1))

    const stats = await measureLatency(async () => {
      const results = await invoke("vector_search_chunks", {
        projectPath: "/mock/project",
        queryEmbedding: queryEmb.map((v) => Math.fround(v)),
        topK: 10,
      })
      void results
    }, ITERATIONS)
    printStats("IPC + compute (search)", stats)
    results.push({ name: "IPC + compute (search)", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures IPC large payload (100KB file read)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const stats = await measureLatency(async () => {
      const content = await invoke("read_file", { path: "/mock/large.md", size: 100 * 1024 })
      void content
    }, ITERATIONS)
    printStats("IPC 100KB read", stats)
    results.push({ name: "IPC 100KB read", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures IPC very large payload (1MB file read)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const stats = await measureLatency(async () => {
      const content = await invoke("read_file", { path: "/mock/huge.md", size: 1024 * 1024 })
      void content
    }, ITERATIONS)
    printStats("IPC 1MB read", stats)
    results.push({ name: "IPC 1MB read", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("saves baseline", () => {
    const data: BaselineData = {
      timestamp: new Date().toISOString(),
      version: "2.4.3",
      iterations: ITERATIONS,
      operations: results,
    }
    saveBaseline("ipc-latency", data)
    console.log("")
    console.log("  [comparison note] QMAI uses Tauri IPC invoke (binary channel).")
    console.log("  [comparison note] niko-studio uses HTTP proxy (localhost REST API).")
    console.log("  [comparison note] Cross-project comparison requires matching payload sizes.")
  })
})
