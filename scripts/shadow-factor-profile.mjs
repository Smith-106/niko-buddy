#!/usr/bin/env node
/**
 * shadow-factor-profile.mjs — 反AI四因子「特征提取轨」影子画像
 *
 * 用途: 在 D:/writing 未授权版权文本上原地只读计算四因子统计分布，
 *      观察检测器在真实商业文本上的行为。文本本体不落盘、不入库、不进 git。
 *
 * ⚠ 合规边界（docs/p0/chinese-benchmark-corpus.md §5.1 特征提取许可）:
 *    - 本脚本只输出聚合统计量（数字），不存储任何原文片段
 *    - 产物 docs/p2/anti-ai-shadow-profile.md 仅内部参考，
 *      禁止作为发版宣称 / block 档解锁 / DEBT-t20 解锁依据
 *    - 正式解锁仍须按 runbook §1 走授权语料轨
 *
 * 用法: node scripts/shadow-factor-profile.mjs [--max-per-family 40]
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCorpusIndexes, runDetection, mean, stddev,
} from "./lib/anti-ai-factors.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS_ROOT = resolve(__dirname, "../../docs/p0/corpus")
const REPORT = resolve(__dirname, "../docs/p2/anti-ai-shadow-profile.md")
const BATCH_ID = "20260821-001"
const WRITING = "D:/writing"

// ── 源配置: 目录 → 标定族映射（与 ingest-local-samples.mjs 同一全谱系映射） ──
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

const MAX_BOOKS = Number(process.argv[process.argv.indexOf("--max-per-family") + 1] ?? 40)
const PIECE_LEN = 500
const PIECES_PER_BOOK = 5

function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) } catch { return new TextDecoder("gb18030").decode(buf) }
}

function clean(t) {
  return t
    .split("\n")
    .filter(l => !/(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击下一页|最新章节|booktxt|xbiquge)/i.test(l))
    .join("\n")
    .replace(/\r/g, "")
}

function segment(text) {
  const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
  const pieces = []
  let buf = ""
  for (const p of paras) {
    if ((buf + p).length > PIECE_LEN && buf.length > 200) { pieces.push(buf); buf = p; if (pieces.length >= PIECES_PER_BOOK) break }
    else buf += (buf ? "\n\n" : "") + p
  }
  if (buf.length > 200 && pieces.length < PIECES_PER_BOOK) pieces.push(buf)
  return pieces
}

// ── 收集样本（原地只读） ──
const familyBooks = {} // genre -> Set(bookId)
for (const src of SOURCES) {
  if (!existsSync(src.root)) { console.warn(`[shadow] 源不存在: ${src.root}`); continue }
  const entries = src.map ? Object.entries(src.map) : [[null, src.genre]]
  for (const [sub, genre] of entries) {
    const dir = sub ? resolve(src.root, sub) : src.root
    if (!existsSync(dir)) continue
    familyBooks[genre] ??= []
    const st = statSync(dir)
    const files = st.isDirectory()
      ? readdirSync(dir, { recursive: true }).filter(f => f.endsWith(".txt")).map(f => resolve(dir, f))
      : []
    // 悬疑目录直接文件
    if (!sub && src.genre === "xuanyi") {
      const walk = d => readdirSync(d).flatMap(f => {
        const p = resolve(d, f)
        return statSync(p).isDirectory() ? walk(p) : (p.endsWith(".txt") || p.endsWith(".md")) && !/docx/i.test(p) ? [p] : []
      })
      files.push(...walk(dir))
    }
    for (const f of files) {
      if ((familyBooks[genre].length) >= MAX_BOOKS * 2) break
      familyBooks[genre].push(f)
    }
  }
}

// ── 种子索引（batch-20260821-001, 与正式标定同源） ──
function loadSeed(layer) {
  const dir = resolve(CORPUS_ROOT, layer, `batch-${BATCH_ID}`)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith(".txt")).map(f => ({
    file: f, text: readFileSync(resolve(dir, f), "utf-8"),
  }))
}
const seedHuman = loadSeed("human")
const seedAi = loadSeed("ai")
console.log(`[shadow] 种子索引源: human ${seedHuman.length} + ai ${seedAi.length}`)
const indexes = buildCorpusIndexes(seedHuman, seedAi)

// ── 检测 ──
const FACTORS = ["nGramOverlap", "sentenceEntropy", "punctuationFingerprint", "paragraphLengthDist"]
const LABELS = { xuanhuan: "玄幻", gufeng: "古风", yanqing: "言情", xuanyi: "悬疑", dushi: "都市", kehuan: "科幻", xihuan: "西幻", lishi: "历史", youxi: "游戏", qingxs: "轻小说" }
const results = {} // genre -> { factor -> [{...piece stats}] }
let totalPieces = 0

for (const [genre, books] of Object.entries(familyBooks)) {
  results[genre] = Object.fromEntries(FACTORS.map(f => [f, []]))
  let used = 0
  for (const book of books) {
    if (used >= MAX_BOOKS) break
    try {
      const raw = decode(readFileSync(book))
      const pieces = segment(clean(raw.slice(0, 8000)))
      if (pieces.length === 0) continue
      used++
      for (const piece of pieces) {
        const det = runDetection(piece, indexes)
        totalPieces++
        results[genre].nGramOverlap.push({ v: det.nGramOverlap.aiOverlap, warn: det.warns.nGramOverlap })
        results[genre].sentenceEntropy.push({ v: det.sentenceEntropy.normalized, raw: det.sentenceEntropy.entropy, warn: det.warns.sentenceEntropy })
        results[genre].punctuationFingerprint.push({ v: det.punctuationFingerprint.aiCosine, warn: det.warns.punctuationFingerprint })
        results[genre].paragraphLengthDist.push({ v: det.paragraphLengthDist.cv, warn: det.warns.paragraphLengthDist })
      }
    } catch { /* 解码失败跳过 */ }
  }
  console.log(`[shadow] ${LABELS[genre]}: ${used} 本 → ${results[genre].nGramOverlap.length} 片`)
}

// ── 种子基线对照（人写种子在同管线下的 warn 率） ──
const seedBaseline = {}
for (const factor of FACTORS) {
  let k = 0
  for (const s of seedHuman) {
    const det = runDetection(s.text, indexes)
    if (det.warns[factor]) k++
  }
  seedBaseline[factor] = { n: seedHuman.length, rate: seedHuman.length ? k / seedHuman.length : 0 }
}

// ── 统计输出 ──
function pctile(vals, q) {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}
function fmtRow(name, arr, unit = "") {
  if (arr.length === 0) return "| — | — | — | — | — | — |"
  const vs = arr.map(x => x.v)
  const wr = arr.filter(x => x.warn).length / arr.length
  return `| ${mean(vs).toFixed(3)} | ${(stddev(vs)).toFixed(3)} | ${pctile(vs, 0.5).toFixed(3)} | ${pctile(vs, 0.95).toFixed(3)} | ${(wr * 100).toFixed(1)}% |`
}

let md = `# 反AI四因子影子画像 — 特征提取轨（未授权来源）

> ⚠ **合规声明（必读）**
> - 来源: \`D:/writing\` 商业网文/出版小说（**未获授权的版权文本**）
> - 方法: 原地只读特征提取（§5.1 许可），文本本体不落盘不入库，仅输出聚合统计量
> - 效力: **仅内部统计参考** —— 禁止作为发版宣称、block 档解锁、DEBT-t20 解锁依据
> - 正式标定仍以 runbook §1 授权语料轨为准 | 生成: ${new Date().toISOString().slice(0, 10)}
> - 参照索引: synthetic-degraded 种子 batch-${BATCH_ID}（与正式标定同源）| 总片数: ${totalPieces}
> - 单本采样: 前 8000 字切 ≤5 片（~500字/片）/ 族上限 ${MAX_BOOKS} 本

## 各族 × 各因子分布（warn 阈值 = T19 阈值面）

`
for (const [genre, byFactor] of Object.entries(results)) {
  md += `### ${LABELS[genre]}（${byFactor.nGramOverlap.length} 片，均视为 human 侧参照）\n\n`
  md += "| 因子 | mean | sd | P50 | P95 | warn 触发率 |\n|---|---|---|---|---|---|\n"
  for (const factor of FACTORS) {
    md += `| ${factor} | ${fmtRow(factor, byFactor[factor]).slice(2)} |\n`
  }
  md += `\n`
}
md += `## 种子基线对照（synthetic-degraded 30 篇 human 同管线）\n\n| 因子 | n | warn 触发率 |\n|---|---|---|\n`
for (const factor of FACTORS) md += `| ${factor} | ${seedBaseline[factor].n} | ${(seedBaseline[factor].rate * 100).toFixed(1)}% |\n`
md += `
## 读法说明

> ⚠ **20260823 反转警示**：本脚本的过滤切片口径（≥30 字段落过滤/500 字窗/仅前 8000 字）已被证实产生
> 系统性伪影——生产等价单元复测（rederive-pl-threshold.mjs，无过滤+全书跨采）下人写 FPR 仅 ~0.1%，
> 阈值维持 0.30/0.35 不变，「分位数化阈值重推导」已被证伪撤下（decision-log t01b 追记五）。
> 本报告的 warn 触发率仅反映「该采样口径下的行为」，不可外推为产品误报风险。

1. warn 触发率是「采样口径下的相对信号」，跨族比较需书本级聚合校正后才有效；绝对数值已被反转证伪
2. 正式轨测量必须走生产等价单元（runbook §1 测量单元纪律），本脚本仅供内部表征与言情饥饿等缺口可视化
3. 本画像不产生 PASS/FAIL 判定——那是正式轨（授权语料 ≥100/族，按族独立解锁）的职责
`

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, md, "utf-8")
console.log(`\n[shadow] 报告 → ${REPORT}`)
console.log("[shadow] 提醒: 产物仅内部统计参考，禁作发版宣称/block解锁依据")
