/**
 * Benchmark helper utilities for QMAI performance testing.
 *
 * Provides measureLatency (P50/P95/P99), printStats, saveBaseline, and
 * compareBaseline — modelled after niko-studio's gateway-benchmark pattern.
 *
 * Run: npx vitest run src/test-helpers/*.bench.ts src/lib/*.bench.ts src/lib/novel/*.bench.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchStats {
  p50: number
  p95: number
  p99: number
  avg: number
  min: number
  max: number
  iterations: number
}

export interface BaselineOperation {
  name: string
  p50: number
  p95: number
  p99: number
  avg: number
}

export interface BaselineData {
  timestamp: string
  version: string
  iterations: number
  operations: BaselineOperation[]
}

export interface ComparisonResult {
  operation: string
  baselineP50: number
  currentP50: number
  deltaPercent: number
  regression: boolean
}

// ---------------------------------------------------------------------------
// Core measurement
// ---------------------------------------------------------------------------

/**
 * Run `fn` for `iterations` times and compute latency percentile statistics.
 * Mirrors the niko-studio gateway-benchmark measureLatency pattern.
 */
export async function measureLatency(
  fn: () => Promise<void> | void,
  iterations: number,
): Promise<BenchStats> {
  const latencies: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await fn()
    latencies.push(performance.now() - start)
  }
  latencies.sort((a, b) => a - b)
  const pct = (p: number) =>
    Math.round(latencies[Math.floor((p / 100) * latencies.length)] * 100) / 100
  return {
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    avg:
      Math.round(
        (latencies.reduce((s, v) => s + v, 0) / latencies.length) * 100,
      ) / 100,
    min: pct(0),
    max: pct(100),
    iterations,
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Print a formatted stats line to the console.
 */
export function printStats(name: string, stats: BenchStats): void {
  console.log(
    `  ${name.padEnd(36)} | P50: ${String(stats.p50).padStart(8)}ms  P95: ${String(stats.p95).padStart(8)}ms  P99: ${String(stats.p99).padStart(8)}ms  avg: ${String(stats.avg).padStart(8)}ms`,
  )
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

const BASELINE_DIR = resolve(__dirname, "baselines")

/**
 * Persist baseline data to `baselines/{name}.json`.
 */
export function saveBaseline(name: string, data: BaselineData): void {
  mkdirSync(BASELINE_DIR, { recursive: true })
  const filePath = join(BASELINE_DIR, `${name}.json`)
  writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`  [baseline] saved to ${filePath}`)
}

/**
 * Read an existing baseline and compare each operation's P50 against `data`.
 * Returns null if no baseline file exists yet (first run).
 */
export function compareBaseline(
  name: string,
  data: BaselineData,
): ComparisonResult[] | null {
  const filePath = join(BASELINE_DIR, `${name}.json`)
  if (!existsSync(filePath)) return null
  const prev: BaselineData = JSON.parse(readFileSync(filePath, "utf-8"))
  const prevMap = new Map(prev.operations.map((o) => [o.name, o]))
  const results: ComparisonResult[] = []
  for (const op of data.operations) {
    const base = prevMap.get(op.name)
    if (!base) continue
    const deltaPercent =
      base.p50 > 0
        ? Math.round(((op.p50 - base.p50) / base.p50) * 10000) / 100
        : 0
    results.push({
      operation: op.name,
      baselineP50: base.p50,
      currentP50: op.p50,
      deltaPercent,
      regression: deltaPercent > 20,
    })
  }
  return results
}
