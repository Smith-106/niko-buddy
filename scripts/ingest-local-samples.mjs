#!/usr/bin/env node
/**
 * ingest-local-samples.mjs — 本地采样入库（用户裁决：暂搁版权争议）
 *
 * 裁决依据: docs/decision-log/2026-08-22-t01b-corpus-pivot.md 追记二
 * 用户明确指示将 D:/writing 版权文本以「按比例采样」方式入本地语料库。
 *
 * 隔离纪律:
 *   - 语料树位于 hub 根 docs/p0/corpus/ —— 在所有 git 仓库之外（已核实无 .git 链）
 *   - 批次 status="quarantined", license_status="unlicensed-disputed"
 *   - 仅按比例采样片段（每本 ≤5 片 × ~500 字），不整本复制
 *   - 禁止将本批次纳入任何 commit / 打包 / 发布产物
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const WRITING = "D:/writing"
const CORPUS_ROOT = resolve(process.cwd(), "docs/p0/corpus")
const BATCH_ID = "batch-20260823-unlicensed-ref"
const TARGET_PIECES = 120 // 每族目标片数（≥100 达标线）

const SOURCES = [
  {
    root: `${WRITING}/_项目/网文/01、十日(1)/400+本高质量完本合集/400+本高质量完本合集`,
    map: { "01、玄幻": "xuanhuan", "02、仙侠": "gufeng", "07、武侠": "gufeng", "09、高武": "xuanhuan", "15、女频": "yanqing", "10、灵异": "xuanyi", "11、悬疑": "xuanyi" },
  },
  { root: `${WRITING}/悬疑`, genre: "xuanyi" },
]

function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) } catch { return new TextDecoder("gb18030").decode(buf) }
}
function clean(t) {
  return t.split("\n").filter(l => !/(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击下一页|最新章节|booktxt|xbiquge)/i.test(l)).join("\n").replace(/\r/g, "")
}
function segment(text) {
  const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
  const pieces = []
  let buf = ""
  for (const p of paras) {
    if ((buf + p).length > 500 && buf.length > 200) { pieces.push(buf); buf = p; if (pieces.length >= 5) break }
    else buf += (buf ? "\n\n" : "") + p
  }
  if (buf.length > 200 && pieces.length < 5) pieces.push(buf)
  return pieces
}
function walkBooks(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = resolve(dir, f)
    if (statSync(p).isDirectory()) return walkBooks(p)
    return p.endsWith(".txt") ? [p] : []
  })
}

// 收集每族书单
const familyBooks = {}
for (const src of SOURCES) {
  if (!existsSync(src.root)) continue
  const entries = src.map ? Object.entries(src.map) : [[null, src.genre]]
  for (const [sub, genre] of entries) {
    const dir = sub ? resolve(src.root, sub) : src.root
    if (!existsSync(dir)) continue
    familyBooks[genre] ??= []
    familyBooks[genre].push(...walkBooks(dir))
  }
}

// 入库
mkdirSync(resolve(CORPUS_ROOT, "human", BATCH_ID), { recursive: true })
const manifestPath = resolve(CORPUS_ROOT, "manifest.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.batches = manifest.batches.filter(b => b.id !== BATCH_ID)
manifest.samples = manifest.samples.filter(s => s.batch_id !== BATCH_ID)
manifest.batches.push({
  id: BATCH_ID,
  date: "2026-08-23",
  source: "D:/writing 商业网文/出版小说按比例采样（未获授权）",
  license_channel: "unlicensed-disputed",
  count: 0,
  status: "quarantined",
  notes: "⚠ 用户裁决 2026-08-23 暂搁版权争议入本地隔离区。仅本地存在（语料树在所有 git 之外）；禁止 commit/push/打包/发版宣称。正式解锁仍须授权语料轨。",
})

let grandTotal = 0
for (const [genre, books] of Object.entries(familyBooks)) {
  const outDir = resolve(CORPUS_ROOT, "human", BATCH_ID)
  let n = manifest.samples.filter(s => s.batch_id === BATCH_ID && s.genre === genre).length
  let written = 0
  for (const book of books) {
    if (n >= TARGET_PIECES) break
    try {
      for (const piece of segment(clean(decode(readFileSync(book)).slice(0, 8000)))) {
        if (n >= TARGET_PIECES) break
        n++; written++
        const name = `${genre}-${String(n).padStart(3, "0")}.txt`
        writeFileSync(resolve(outDir, name), piece, "utf-8")
        manifest.samples.push({
          file: `human/${BATCH_ID}/${name}`, genre, layer: "human",
          words: piece.replace(/\s+/g, "").length,
          license_status: "unlicensed-disputed",
          source: `sampled:${book.replace(/\\/g, "/").slice(-60)}`,
          batch_id: BATCH_ID,
        })
      }
    } catch { /* 解码失败跳过 */ }
  }
  grandTotal += written
  console.log(`[ingest] ${genre}: ${written} 片 (${n}/${TARGET_PIECES}${n < TARGET_PIECES ? " 不足" : ""})`)
}

const batch = manifest.batches.find(b => b.id === BATCH_ID)
batch.count = grandTotal
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
console.log(`[ingest] 合计 ${grandTotal} 片 → human/${BATCH_ID} (quarantined)`)
console.log("[ingest] 提醒: 本批次仅存于本地语料树，严禁纳入任何 git/打包/发布产物")
