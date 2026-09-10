#!/usr/bin/env node
/**
 * ingest-c1-ai-1to1.mjs — C1 staging → ai 层 1:1 摄取（专用，一次性）
 *
 * 背景：ingest-authorized-corpus.mjs 的 segment() 会把 350-500 字成条文本按
 * 500 字边界重切，破坏条的完整性。C1 续采的条目在 _c1-write.py 已逐条
 * 校验（350-500 core 字符 + bad-pattern 拒收），故此脚本按 1:1 整条入库，
 * 复用授权轨语义：status=indexed、license=authorized、配额硬上限 200/族。
 *
 * 用法：node scripts/ingest-c1-ai-1to1.mjs  （在 hub 根执行，路径硬编码）
 * 幂等：重跑前先清 ai/batch-20260910-c1-ai 与 manifest 中该批条目。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

const HUB = resolve(process.cwd())
const CORPUS_ROOT = resolve(HUB, "docs/p0/corpus")
const STAGING = resolve(HUB, "docs/p0/corpus/_staging-ai-c1-fanout")
const BATCH_ID = "batch-20260910-c1-ai"
const LAYER = "ai"
const LICENSE_STATUS = "authorized"
const HARD_CAP = 200
const BAD = /(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击|最新章节|GCR|最终稿|（本段|本段为)/

// ---- 校验函数（与 _c1-write.py 同语义：350-500 core + bad-pattern）----
const coreLen = (t) => t.replace(/\s+/g, "").length

// ---- 读入 staging ----
const genres = ["yanqing", "gufeng", "xuanhuan", "dushi", "xuanyi"]
const groups = new Map()
for (const g of genres) {
  const dir = resolve(STAGING, g)
  if (!existsSync(dir)) continue
  const files = readdirSync(dir).filter(f => f.endsWith(".txt")).sort()
  const seen = new Set() // 文件名唯一
  const items = []
  for (const f of files) {
    if (seen.has(f)) continue
    seen.add(f)
    const raw = readFileSync(resolve(dir, f), "utf-8")
    const text = raw.replace(/\r/g, "").trim()
    const n = coreLen(text)
    if (n < 350 || n > 500) { console.error(`✗ ${g}/${f}: core ${n} 越界 [350,500]`); process.exit(1) }
    if (BAD.test(text)) { console.error(`✗ ${g}/${f}: 命中 bad-pattern`); process.exit(1) }
    items.push({ file: f, text })
  }
  groups.set(g, items)
}

// ---- manifest ----
const manifestPath = resolve(CORPUS_ROOT, "manifest.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
// 幂等：清本批本层旧条目
manifest.samples = manifest.samples.filter(s => !(s.batch_id === BATCH_ID && s.layer === LAYER))
let batch = manifest.batches.find(b => b.id === BATCH_ID)
if (!batch) { batch = { id: BATCH_ID, layers: [] }; manifest.batches.push(batch) }
Object.assign(batch, {
  date: "2026-09-10",
  source: "docs/p0/corpus/_staging-ai-c1（C1 续采 139→400，1:1 整条摄取）",
  license_channel: LICENSE_STATUS,
  status: "indexed",
})
batch.layers = [...new Set([...(batch.layers ?? []), LAYER])]

// ---- 既有 ai 同族计数（跨批合并计额，硬上限 200/族）----
const existingByGenre = new Map()
for (const s of manifest.samples) {
  if (s.layer !== "ai") continue
  existingByGenre.set(s.genre, (existingByGenre.get(s.genre) ?? 0) + 1)
}

// ---- 入库 ----
mkdirSync(resolve(CORPUS_ROOT, LAYER, BATCH_ID), { recursive: true })
const outDir = resolve(CORPUS_ROOT, LAYER, BATCH_ID)
let grandTotal = 0
const stopping = []
for (const [g, items] of groups) {
  let n = existingByGenre.get(g) ?? 0
  let written = 0
  for (const it of items) {
    if (n >= HARD_CAP) break
    n++; written++; grandTotal++
    writeFileSync(resolve(outDir, it.file), it.text, "utf-8")
    manifest.samples.push({
      file: `${LAYER}/${BATCH_ID}/${it.file}`, genre: g, layer: LAYER,
      words: coreLen(it.text),
      license_status: LICENSE_STATUS,
      source: "c1-staging:1to1",
      batch_id: BATCH_ID,
    })
  }
  console.log(`[c1-1to1] ${LAYER}/${g}: +${written}（该族累计 ${n}/硬上限 ${HARD_CAP}）`)
  if (n >= HARD_CAP) stopping.push(`${g}: 触及硬上限 ${HARD_CAP}`)
}

batch.count = manifest.samples.filter(s => s.batch_id === BATCH_ID).length
if (stopping.length > 0) batch.stopping_conditions = stopping
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
const aiTotal = manifest.samples.filter(s => s.layer === "ai").length
console.log(`[c1-1to1] ✓ 本批 ${grandTotal} 条；ai 层总样本 ${aiTotal}（目标 400）`)
