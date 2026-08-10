#!/usr/bin/env node
/**
 * Wave A G3 — retrieval / context-pack assembly p95 smoke (honest env fail).
 *
 * Measures wall time for repeated lightweight retrieval-ish work:
 * 1) Read chapter draft (disk)
 * 2) List/read snapshot JSON files under .novel/snapshots
 * 3) Optional: simple string search over draft (BM25 substitute = includes)
 *
 * Does NOT require embedding API keys. For full vector path, set
 * SMOKE_EMBED=1 and provide project embedding config (future).
 *
 * Usage:
 *   node scripts/smoke-retrieval-p95.mjs --project "E:/写作/8人" [--n 30] [--warmup 3]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const project = resolve(arg("--project", ""))
const n = Math.max(5, parseInt(arg("--n", "30"), 10) || 30)
const warmup = Math.max(0, parseInt(arg("--warmup", "3"), 10) || 3)

if (!project || !existsSync(project)) {
  console.error('Usage: node scripts/smoke-retrieval-p95.mjs --project <novel-root> [--n 30] [--warmup 3]')
  process.exit(1)
}

const novelDir = join(project, ".novel")
const chaptersDir = join(novelDir, "chapters")
const snapDir = join(novelDir, "snapshots")

function listDraftPaths() {
  if (!existsSync(chaptersDir)) return []
  return readdirSync(chaptersDir)
    .filter((d) => /^\d+$/.test(d))
    .map((d) => join(chaptersDir, d, "draft.md"))
    .filter((p) => existsSync(p))
}

function listSnapshots() {
  if (!existsSync(snapDir)) return []
  return readdirSync(snapDir)
    .filter((f) => f.endsWith(".snapshot.json"))
    .map((f) => join(snapDir, f))
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function oneProbe(drafts, snaps, query) {
  const t0 = performance.now()
  let hitChars = 0
  let snapFacts = 0
  for (const p of drafts) {
    const text = readFileSync(p, "utf8")
    hitChars += text.length
    if (query && text.includes(query)) hitChars += 1
  }
  for (const p of snaps.slice(0, 12)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"))
      snapFacts += Array.isArray(j.newCanonFacts) ? j.newCanonFacts.length : 0
      snapFacts += Array.isArray(j.characters) ? j.characters.length : 0
    } catch {
      // ignore bad json
    }
  }
  const ms = performance.now() - t0
  return { ms, hitChars, snapFacts }
}

const drafts = listDraftPaths()
const snaps = listSnapshots()
const envNote = []
if (!drafts.length) envNote.push("no drafts under .novel/chapters/*/draft.md")
if (!snaps.length) envNote.push("no snapshots under .novel/snapshots")

const queries = ["投票", "清理", "矩阵", "白砚", "会议室"]
const samples = []

for (let i = 0; i < warmup; i++) {
  oneProbe(drafts, snaps, queries[i % queries.length])
}
for (let i = 0; i < n; i++) {
  samples.push(oneProbe(drafts, snaps, queries[i % queries.length]).ms)
}

const sorted = [...samples].sort((a, b) => a - b)
const sum = samples.reduce((a, b) => a + b, 0)
const result = {
  at: new Date().toISOString(),
  schema: "retrieval-p95-smoke/1.0",
  project,
  path: "disk-draft+snapshot-scan (not LanceDB embedding)",
  n,
  warmup,
  draftCount: drafts.length,
  snapshotCount: snaps.length,
  envNote,
  ms: {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    mean: samples.length ? sum / samples.length : null,
  },
  honest:
    "This is local FS pack-assembly proxy latency, not vector search SLA. " +
    "Set future SMOKE_EMBED=1 for embedding path when keys available.",
  productHardGate: false,
}

const outDir = resolve(__dirname, "../../.workflow/harvest-staging")
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `retrieval-p95-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`)
writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8")
console.log(JSON.stringify({ ok: true, outPath, ...result }, null, 2))
process.exit(envNote.length && !drafts.length ? 2 : 0)
