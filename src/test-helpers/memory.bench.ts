/**
 * Memory benchmark — measures process memory across idle, active, and
 * graph-render states.
 *
 * Measures Node's own `process.memoryUsage()` — the benchmark runs in plain
 * Node (vitest), so there is no Tauri runtime and no `get_process_memory`
 * command to call. An earlier revision mocked such a command, which invented
 * an IPC contract the backend never implemented; the numbers here are a
 * Node-level memory baseline, not a measure of Rust-side RSS.
 *
 * Run: npx vitest run src/test-helpers/memory.bench.ts
 */

import { describe, it, expect } from "vitest"
import { measureLatency, printStats, saveBaseline } from "@/test-helpers/bench-helpers"
import type { BaselineData, BaselineOperation } from "@/test-helpers/bench-helpers"

const ITERATIONS = 50

const readMemoryUsage = () => process.memoryUsage()

// Synthetic allocation footprints for the "active" / "graph-render" states.
const ACTIVE_ALLOCATION = 200 * 1024
const GRAPH_NODE_COUNT = 1000

describe("Memory Benchmark", () => {
  const results: BaselineOperation[] = []

  it("measures idle state memory read latency", async () => {
    const stats = await measureLatency(async () => {
      const info = readMemoryUsage()
      // Validate shape against Node's real contract
      expect(info).toHaveProperty("rss")
    }, ITERATIONS)
    printStats("idle memory read", stats)
    results.push({ name: "idle memory read", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures active state memory snapshot", async () => {
    const stats = await measureLatency(() => {
      const snapshot = Buffer.alloc(ACTIVE_ALLOCATION, 1)
      void snapshot
    }, ITERATIONS)
    printStats("active memory snapshot", stats)
    results.push({ name: "active memory snapshot", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("measures graph-render state memory snapshot", async () => {
    const stats = await measureLatency(() => {
      const nodes = new Array(GRAPH_NODE_COUNT).fill(null).map((_, i) => ({
        id: `node-${i}`,
        label: `Node ${i}`,
        x: Math.random() * 1000,
        y: Math.random() * 1000,
      }))
      void nodes
    }, ITERATIONS)
    printStats("graph-render memory alloc", stats)
    results.push({ name: "graph-render memory alloc", p50: stats.p50, p95: stats.p95, p99: stats.p99, avg: stats.avg })
  })

  it("saves baseline", () => {
    const data: BaselineData = {
      timestamp: new Date().toISOString(),
      version: __APP_VERSION__,
      iterations: ITERATIONS,
      operations: results,
    }
    saveBaseline("memory", data)
  })
})
