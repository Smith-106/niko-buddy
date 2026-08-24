#!/usr/bin/env node
/**
 * corpus-check.mjs — 语料树一致性校验（N4 / 蓝图 T01b-2，20260824 三模型共识落地）
 *
 * 校验项：
 *   1. 命名规范：{genre}-{NNN}.txt（genre 枚举内、3 位零填充）
 *   2. genre ∈ GENRE_ENUM；批次 status ∈ 已知状态集
 *   3. 磁盘文件 ↔ manifest.samples 双向对账（缺失/多余）
 *   4. 各批配额报告（目标 100/族·层，硬上限 200）
 *
 * 用法：
 *   node scripts/corpus-check.mjs [--corpus-root <dir>]   # 默认 hub 根 docs/p0/corpus
 *
 * 退出码：0=全部通过（或仅警告）；1=存在违规。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { GENRE_ENUM } from "./lib/corpus-guard.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const argIdx = process.argv.indexOf("--corpus-root")
const CORPUS_ROOT = resolve(argIdx >= 0 ? process.argv[argIdx + 1] : resolve(__dirname, "../../docs/p0/corpus"))

const STATUS_ENUM = ["pending", "indexed", "blocked", "quarantined"]
const TARGET_PER_GENRE = 100
const HARD_CAP = 200

let violations = 0
let warnings = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); violations++ }
const warn = (msg) => { console.warn(`  ⚠ ${msg}`); warnings++ }

console.log(`[corpus-check] 语料根: ${CORPUS_ROOT}`)
if (!existsSync(CORPUS_ROOT)) {
  console.error("[corpus-check] ✗ 语料根不存在")
  process.exit(1)
}

// manifest 加载
const manifestPath = join(CORPUS_ROOT, "manifest.json")
if (!existsSync(manifestPath)) {
  console.error("[corpus-check] ✗ manifest.json 不存在")
  process.exit(1)
}
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
} catch (err) {
  console.error(`[corpus-check] ✗ manifest 解析失败: ${err.message}`)
  process.exit(1)
}

// 1+2: 批次状态枚举 + 样本命名/genre
const batches = manifest.batches ?? []
for (const b of batches) {
  if (!STATUS_ENUM.includes(b.status)) fail(`批次 ${b.id}: 非法 status "${b.status}"（合法: ${STATUS_ENUM.join("|")}）`)
  if (!/^batch-\d{8}-[a-z0-9-]+$/.test(b.id)) fail(`批次 id 不合规范: ${b.id}`)
}

const nameRe = /^([a-z]+)-(\d{3})\.txt$/
const manifestFiles = new Set()
const seenInManifest = new Map() // file -> sample（查重）
for (const s of manifest.samples ?? []) {
  const key = `${s.layer}/${s.batch_id}/${s.file.split("/").pop()}`
  if (seenInManifest.has(key)) warn(`manifest 重复条目: ${key}`)
  seenInManifest.set(key, s)
  manifestFiles.add(key)

  if (!["human", "ai", "gold"].includes(s.layer)) fail(`样本 ${key}: 非法 layer "${s.layer}"`)
  if (s.layer === "gold") continue // 金标准为 JSON 结构文件，跳过文本命名校验
  const base = s.file.split("/").pop()
  const m = nameRe.exec(base)
  if (!m) { fail(`样本 ${key}: 文件名不合 {genre}-{NNN}.txt 规范`); continue }
  if (!GENRE_ENUM.includes(m[1])) fail(`样本 ${key}: genre "${m[1]}" 越界（枚举: ${GENRE_ENUM.join("|")}）`)
  if (typeof s.words !== "number" || s.words <= 0) warn(`样本 ${key}: words 字段异常 (${s.words})`)
}

// 3: 磁盘 ↔ manifest 双向对账（仅 indexed 批强制；其他批只报告不判违规）
console.log("\n[corpus-check] 批次对账:")
for (const layer of ["human", "ai"]) {
  const layerDir = join(CORPUS_ROOT, layer)
  if (!existsSync(layerDir)) continue
  const batchDirs = readdirSync(layerDir).filter((d) => {
    try { return statSync(join(layerDir, d)).isDirectory() } catch { return false }
  })
  for (const batchDir of batchDirs) {
    const dir = join(layerDir, batchDir)
    const files = readdirSync(dir).filter((f) => f.endsWith(".txt"))
    for (const f of files) {
      const key = `${layer}/${batchDir}/${f}`
      if (!manifestFiles.has(key)) {
        const isQuarantinedBatch = batches.some((b) => b.id === batchDir && b.status === "quarantined")
        if (isQuarantinedBatch) warn(`磁盘有而 manifest 无（隔离批，仅报告）: ${key}`)
        else fail(`磁盘有而 manifest 无: ${key}`)
      }
    }
  }
}
for (const [key] of seenInManifest) {
  const [, , fileName] = key.split("/")
  const dir = join(CORPUS_ROOT, key.split("/").slice(0, 2).join("/"))
  if (!existsSync(join(dir, fileName))) {
    const batchId = key.split("/")[1]
    const isQuarantined = batches.some((b) => b.id === batchId && b.status === "quarantined")
    if (isQuarantined) warn(`manifest 有而磁盘无（隔离批，仅报告）: ${key}`)
    else fail(`manifest 有而磁盘无: ${key}`)
  }
}

// 4: 配额报告（按批 × 层 × 族计数）
console.log("\n[corpus-check] 配额报告（目标 100/族·层，硬上限 200）:")
const counts = new Map()
for (const s of manifest.samples ?? []) {
  if (s.layer === "gold") continue
  const k = `${s.batch_id}|${s.layer}|${s.genre}`
  counts.set(k, (counts.get(k) ?? 0) + 1)
}
for (const [k, n] of [...counts.entries()].sort()) {
  const [batchId, layer, genre] = k.split("|")
  const flag = n >= HARD_CAP ? " ⚠触顶" : n < TARGET_PER_GENRE ? " （未达标）" : ""
  console.log(`  ${batchId} ${layer}/${genre}: ${n}${flag}`)
  if (n > HARD_CAP) fail(`${k}: 超过硬上限 ${HARD_CAP}（实际 ${n}）`)
}

console.log(`\n[corpus-check] ${violations === 0 && warnings === 0 ? "✓ 全部通过" : `完成：${violations} 违规 / ${warnings} 警告`}`)
process.exit(violations === 0 ? 0 : 1)
