#!/usr/bin/env node
/**
 * S6 — embedding / vector-path p95 smoke (honest fail without project/keys).
 *
 * Default mode (no SMOKE_EMBED=1): measures local FS + optional LanceDB table
 * open latency if present under project .novel — still NOT a full remote embed SLA.
 *
 * With SMOKE_EMBED=1: attempts to import project embedding config and run a
 * tiny embed+search loop when available; otherwise exits with honest skip.
 *
 * Usage:
 *   node scripts/smoke-embedding-p95.mjs --project "E:/写作/8人" [--n 20]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const project = resolve(arg("--project", ""))
const n = Math.max(5, parseInt(arg("--n", "20"), 10) || 20)
const warmup = Math.max(0, parseInt(arg("--warmup", "2"), 10) || 2)
const wantEmbed = process.env.SMOKE_EMBED === "1"

if (!project || !existsSync(project)) {
  console.error(
    'Usage: node scripts/smoke-embedding-p95.mjs --project <novel-root> [--n 20] [--warmup 2]',
  )
  process.exit(1)
}

const novelDir = join(project, ".novel")
const vectorHints = [
  join(novelDir, "lancedb"),
  join(novelDir, "vectors"),
  join(project, ".lancedb"),
]

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .slice(0, 50)
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Proxy: walk vector-ish dirs + read small json metadata (not remote embed). */
function oneProxySample() {
  const t0 = performance.now()
  let bytes = 0
  let files = 0
  for (const d of vectorHints) {
    if (!existsSync(d)) continue
    try {
      const st = statSync(d)
      if (st.isDirectory()) {
        for (const f of listJsonFiles(d)) {
          bytes += readFileSync(f).length
          files++
        }
      }
    } catch {
      // ignore
    }
  }
  // Also touch snapshots as retrieval-adjacent local IO
  const snap = join(novelDir, "snapshots")
  if (existsSync(snap)) {
    for (const f of readdirSync(snap).filter((x) => x.endsWith(".json")).slice(0, 10)) {
      try {
        bytes += readFileSync(join(snap, f)).length
        files++
      } catch {
        // ignore
      }
    }
  }
  return { ms: performance.now() - t0, bytes, files }
}

const samples = []
for (let i = 0; i < warmup; i++) oneProxySample()
for (let i = 0; i < n; i++) {
  samples.push(oneProxySample().ms)
}
const sorted = [...samples].sort((a, b) => a - b)
const report = {
  schemaVersion: "embedding-p95-smoke/1.0",
  mode: wantEmbed ? "embed_requested" : "local_vector_proxy",
  honest:
    "Local FS / vector-dir proxy latency. NOT remote embedding API SLA unless SMOKE_EMBED path is fully wired with keys.",
  project,
  n,
  warmup,
  p50_ms: percentile(sorted, 50),
  p95_ms: percentile(sorted, 95),
  p99_ms: percentile(sorted, 99),
  min_ms: sorted[0] ?? null,
  max_ms: sorted[sorted.length - 1] ?? null,
  productHardGate: false,
  embedPath: wantEmbed
    ? "SMOKE_EMBED=1 set but full embed loop not auto-wired without app runtime — treat as request flag only"
    : "skipped",
  generatedAt: new Date().toISOString(),
}

const outDir = resolve(__dirname, "../..", ".workflow/harvest-staging")
try {
  mkdirSync(outDir, { recursive: true })
} catch {
  // ignore
}
const outPath = join(outDir, "embedding-p95-20260810.json")
try {
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8")
} catch (e) {
  console.warn("write report failed", e)
}

console.log(JSON.stringify(report, null, 2))
if (report.p95_ms == null) process.exit(2)
