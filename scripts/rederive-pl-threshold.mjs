#!/usr/bin/env node
/**
 * rederive-pl-threshold.mjs — P0: paragraphLengthDist 分位数阈值重推导
 *
 * 方法（回应 ox 方法学审查 F1/F2/F3/H1/H3）:
 *   - 生产等价单元: 无 ≥30 字段落过滤（生产 splitParagraphs 只丢空段）
 *   - 窗口跨全书: 每本 ≤12 个 ~2500 字窗，按文件长度等分偏移（非仅开头 8000 字）
 *   - 公式忠实: 直接调用 lib runDetection 读 .paragraphLengthDist.cv（与生产同源）
 *   - 书本级聚合视图: 每书 mean-CV / any-warn（相关性校正视角）
 *   - 文本不落盘不入库，仅输出统计量
 *
 * 用法: node scripts/rederive-pl-threshold.mjs [--books-per-family 40]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildCorpusIndexes, runDetection } from "./lib/anti-ai-factors.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS_ROOT = resolve(__dirname, "../../docs/p0/corpus")
const WRITING = "D:/writing"
const MAX_BOOKS = Number(process.argv[process.argv.indexOf("--books-per-family") + 1] ?? 40)
const WIN = 2500
const WINS_PER_BOOK = 12

const SOURCES = [
  {
    root: `${WRITING}/_项目/网文/01、十日(1)/400+本高质量完本合集/400+本高质量完本合集`,
    map: {
      "01、玄幻": "xuanhuan", "09、高武": "xuanhuan",
      "02、仙侠": "gufeng", "07、武侠": "gufeng",
      "15、女频": "yanqing",
      "10、灵异": "xuanyi", "11、悬疑": "xuanyi",
      "03、都市": "dushi", "04、科幻": "kehuan", "05、奇幻": "xihuan",
      "06、历史": "lishi", "08、游戏": "youxi", "14、轻小说": "qingxs",
    },
  },
  { root: `${WRITING}/悬疑`, genre: "xuanyi" },
]

function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) } catch { return new TextDecoder("gb18030").decode(buf) }
}
function clean(t) {
  return t.split("\n").filter(l => !/(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击下一页|最新章节|booktxt|xbiquge)/i.test(l)).join("\n").replace(/\r/g, "")
}
// 生产等价切分：只丢空段（与 anti-ai-candidate-pool.ts splitParagraphs 同语义）
function prodParagraphs(t) { return t.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0) }
function walkBooks(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = resolve(dir, f)
    if (statSync(p).isDirectory()) return walkBooks(p)
    return p.endsWith(".txt") ? [p] : []
  })
}
function quantile(vals, q) {
  if (!vals.length) return NaN
  const s = [...vals].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// ── 索引种子 ──
function loadSeed(layer, batch) {
  const dir = resolve(CORPUS_ROOT, layer, batch)
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".txt")).map(f => ({ file: f, text: readFileSync(resolve(dir, f), "utf-8") })) : []
}
const seedsH = loadSeed("human", "batch-20260821-001")
const seedsA = loadSeed("ai", "batch-20260821-001")
console.error(`[rederive] 索引种子 human ${seedsH.length} + ai ${seedsA.length}`)
const indexes = buildCorpusIndexes(seedsH, seedsA)

// ── human 侧: 生产等价单元采样 ──
const familyBooks = {}
for (const src of SOURCES) {
  if (!existsSync(src.root)) continue
  for (const [sub, genre] of src.map ? Object.entries(src.map) : [[null, src.genre]]) {
    const dir = sub ? resolve(src.root, sub) : src.root
    if (!existsSync(dir)) continue
    ;(familyBooks[genre] ??= []).push(...walkBooks(dir))
  }
}

// cv 单元: { genre, book, idx, cv, paras }
const humanUnits = []
let skippedShort = 0
for (const [genre, books] of Object.entries(familyBooks)) {
  let used = 0
  for (const book of books) {
    if (used >= MAX_BOOKS) break
    let text
    try { text = clean(decode(readFileSync(book))) } catch { continue }
    if (text.length < WIN / 2) { skippedShort++; continue }
    used++
    const nWins = Math.min(WINS_PER_BOOK, Math.max(1, Math.floor(text.length / WIN)))
    for (let i = 0; i < nWins; i++) {
      const off = Math.floor(((i + 1) / (nWins + 1)) * Math.max(0, text.length - WIN))
      const paras = prodParagraphs(text.slice(off, off + WIN))
      if (paras.length < 3) { skippedShort++; continue } // 与生产一致: 段数不足不判 PL
      const det = runDetection(paras.join("\n\n"), indexes)
      humanUnits.push({ genre, book, idx: i, cv: det.paragraphLengthDist.cv })
    }
  }
  console.error(`[rederive] ${genre}: ${used} 本 × ≤${WINS_PER_BOOK} 窗`)
}
console.error(`[rederive] human 单元 ${humanUnits.length}（跳过短单元 ${skippedShort}）`)

// ── ai 侧: 本地语料全量 ──
const aiUnits = []
for (const batch of ["batch-20260821-001", "batch-20260822-writing"]) {
  for (const s of loadSeed("ai", batch)) {
    const paras = prodParagraphs(s.text)
    if (paras.length < 3) continue
    const det = runDetection(s.text, indexes)
    aiUnits.push({ batch, file: s.file, cv: det.paragraphLengthDist.cv })
  }
}
console.error(`[rederive] ai 单元 ${aiUnits.length}`)

// ── 分布输出 ──
const hCVs = humanUnits.map(u => u.cv)
const aCVs = aiUnits.map(u => u.cv)
console.log("\n=== CV 分布（生产等价单元，无过滤，全书跨采）===")
console.log("quantile |  human(all) | ai(all)")
for (const q of [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
  console.log(`P${(q * 100).toFixed(1).replace(/\.0$/, "")}       |  ${quantile(hCVs, q).toFixed(4)}      | ${quantile(aCVs, q).toFixed(4)}`)
}

console.log("\n=== 候选阈值矩阵 ===")
console.log("threshold@ | humanFPR | aiRecall(CV<thr) | 说明")
for (const [name, thr] of [["fixed0.30(现行)", 0.30], ["fixed0.35(短文放宽)", 0.35], ["P5", quantile(hCVs, 0.05)], ["P10", quantile(hCVs, 0.10)], ["P2.5", quantile(hCVs, 0.025)]]) {
  const fpr = humanUnits.filter(u => u.cv < thr).length / humanUnits.length
  const rec = aiUnits.filter(u => u.cv < thr).length / aiUnits.length
  console.log(`${name.padEnd(18)} | ${(fpr * 100).toFixed(2)}%   | ${(rec * 100).toFixed(2)}%`)
}

console.log("\n=== 分族 FPR @ 各候选 ===")
const cands = [["0.30", 0.30], ["P5", quantile(hCVs, 0.05)], ["P10", quantile(hCVs, 0.10)]]
const genres = [...new Set(humanUnits.map(u => u.genre))]
console.log("genre\\thr | " + cands.map(([n]) => n.padStart(6)).join(" | "))
for (const g of genres) {
  const us = humanUnits.filter(u => u.genre === g)
  const row = cands.map(([, t]) => (us.filter(u => u.cv < t).length / us.length * 100).toFixed(1).padStart(5) + "%")
  console.log(`${g.padEnd(9)} | ${row.join(" | ")}`)
}

console.log("\n=== 书本级聚合视图（每书 mean-CV 分位 + any-warn 书口径 FPR @P5/@P10/@0.30）===")
const byBook = {}
for (const u of humanUnits) {
  byBook[u.book] ??= []
  byBook[u.book].push(u.cv)
}
const bookMeans = Object.values(byBook).map(vs => vs.reduce((a, b) => a + b, 0) / vs.length)
for (const q of [0.05, 0.25, 0.5]) console.log(`book-mean-CV P${q * 100}: ${quantile(bookMeans, q).toFixed(4)}`)
for (const [, t] of cands) {
  const bw = Object.values(byBook).map(vs => vs.some(cv => cv < t))
  console.log(`book-level any-warn FPR @${t.toFixed(3)}: ${(bw.filter(Boolean).length / bw.length * 100).toFixed(2)}%（n=${bw.length} 本）`)
}
