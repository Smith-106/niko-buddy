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
 *    - 正式解锁仍须按 runbook §1 走授权语料轨（按族独立解锁，测量单元纪律见 §1）
 *
 * 采样口径 (20260823 对齐生产等价单元, 修三条伪影——decision-log t01b 追记五/七):
 *    - 无 ≥30 字段落过滤（生产 splitParagraphs 只丢空段）[旧伪影①]
 *    - ~2500 字窗 × ≤12 窗/本，全书等分偏移 [旧伪影②③: 500字窗+仅前8000字]
 *    - 新增书本级聚合视图 (mean-CV 分位 + any-warn 书口径 FPR)
 *
 * 用法: node scripts/shadow-factor-profile.mjs [--max-per-family 40]
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCorpusIndexes, runDetection,
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
const WIN = 2500          // 生产章节尺度窗（网文章节 2000-4000 字）
const WINS_PER_BOOK = 12  // 全书等分偏移窗口数

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

// ── 收集书单（原地只读） ──
const familyBooks = {} // genre -> [file]
for (const src of SOURCES) {
  if (!existsSync(src.root)) { console.warn(`[shadow] 源不存在: ${src.root}`); continue }
  const entries = src.map ? Object.entries(src.map) : [[null, src.genre]]
  for (const [sub, genre] of entries) {
    const dir = sub ? resolve(src.root, sub) : src.root
    if (!existsSync(dir)) continue
    familyBooks[genre] ??= []
    const st = statSync(dir)
    if (st.isDirectory()) {
      const files = src.genre === "xuanyi" && !sub
        ? readdirSync(dir).flatMap(f => {
            const p = resolve(dir, f)
            return statSync(p).isDirectory() ? walkTxt(p) : (p.endsWith(".txt") || p.endsWith(".md")) && !/docx/i.test(p) ? [p] : []
          })
        : readdirSync(dir, { recursive: true }).filter(f => f.endsWith(".txt")).map(f => resolve(dir, f))
      for (const f of files) {
        if (familyBooks[genre].length >= MAX_BOOKS * 2) break
        familyBooks[genre].push(f)
      }
    }
  }
}
function walkTxt(d) {
  return readdirSync(d).flatMap(f => {
    const p = resolve(d, f)
    return statSync(p).isDirectory() ? walkTxt(p) : p.endsWith(".txt") ? [p] : []
  })
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
if (seedHuman.length === 0 || seedAi.length === 0) {
  console.error("[shadow] 致命: 种子语料缺失 —— nGramOverlap/标点指纹将空转失真 (F6 教训), 中止")
  process.exit(1)
}
const indexes = buildCorpusIndexes(seedHuman, seedAi)

// ── 检测（生产等价单元：无段落过滤 + 全书等分偏移窗） ──
const FACTORS = ["nGramOverlap", "sentenceEntropy", "punctuationFingerprint", "paragraphLengthDist"]
const LABELS = { xuanhuan: "玄幻", gufeng: "古风", yanqing: "言情", xuanyi: "悬疑", dushi: "都市", kehuan: "科幻", xihuan: "西幻", lishi: "历史", youxi: "游戏", qingxs: "轻小说" }
const results = {} // genre -> { factor -> [{v, warn}] }
const bookCVs = {} // genre -> Map(book -> [cv,...])
let totalUnits = 0

for (const [genre, books] of Object.entries(familyBooks)) {
  results[genre] = Object.fromEntries(FACTORS.map(f => [f, []]))
  bookCVs[genre] = new Map()
  let used = 0
  for (const book of books) {
    if (used >= MAX_BOOKS) break
    let text
    try { text = clean(decode(readFileSync(book))) } catch { continue }
    if (text.length < WIN / 2) continue
    used++
    const nWins = Math.min(WINS_PER_BOOK, Math.max(1, Math.floor(text.length / WIN)))
    for (let i = 0; i < nWins; i++) {
      const off = Math.floor(((i + 1) / (nWins + 1)) * Math.max(0, text.length - WIN))
      // 生产等价分段: 只丢空段（无 ≥30 字过滤）
      const unit = text.slice(off, off + WIN).split(/\n+/).map(p => p.trim()).filter(p => p.length > 0).join("\n\n")
      const det = runDetection(unit, indexes)
      totalUnits++
      results[genre].nGramOverlap.push({ v: det.nGramOverlap.aiOverlap, warn: det.warns.nGramOverlap })
      results[genre].sentenceEntropy.push({ v: det.sentenceEntropy.normalized, warn: det.warns.sentenceEntropy })
      results[genre].punctuationFingerprint.push({ v: det.punctuationFingerprint.aiCosine, warn: det.warns.punctuationFingerprint })
      results[genre].paragraphLengthDist.push({ v: det.paragraphLengthDist.cv, warn: det.warns.paragraphLengthDist })
      if (!bookCVs[genre].has(book)) bookCVs[genre].set(book, [])
      bookCVs[genre].get(book).push(det.paragraphLengthDist.cv)
    }
  }
  console.log(`[shadow] ${LABELS[genre]}: ${used} 本 × ≤${WINS_PER_BOOK} 窗 → ${results[genre].nGramOverlap.length} 单元`)
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
function quantile(vals, q) {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

let md = `# 反AI四因子影子画像 — 特征提取轨（未授权来源）

> ⚠ **合规声明（必读）**
> - 来源: \`D:/writing\` 商业网文/出版小说（**未获授权的版权文本**）
> - 方法: 原地只读特征提取（§5.1 许可），文本本体不落盘不入库，仅输出聚合统计量
> - 效力: **仅内部统计参考** —— 禁止作为发版宣称、block 档解锁、DEBT-t20 解锁依据
> - 正式标定仍以 runbook §1 授权语料轨为准 | 生成: ${new Date().toISOString().slice(0, 10)}
> - 参照索引: synthetic-degraded 种子 batch-${BATCH_ID}（与正式标定同源）| 总单元数: ${totalUnits}
> - 采样口径: **生产等价单元**（无≥30字过滤, ~${WIN}字窗×≤${WINS_PER_BOOK}窗全书等分偏移;
>   20260823 修复旧版三条采样伪影, 见 decision-log t01b 追记五/七）
> - 单元阈值面: T19（PL CV<0.3/短文0.35; 熵归一化<0.7; 标点余弦>0.85×1.2; ngram>0.4×1.5）

## 各族 × 各因子分布（生产等价单元）

`
for (const [genre, byFactor] of Object.entries(results)) {
  md += `### ${LABELS[genre]}（${byFactor.nGramOverlap.length} 单元，均视为 human 侧参照）\n\n`
  md += "| 因子 | mean | P50 | P95 | warn 触发率 |\n|---|---|---|---|---|\n"
  for (const factor of FACTORS) {
    const arr = byFactor[factor]
    if (arr.length === 0) { md += `| ${factor} | — | — | — | — |\n`; continue }
    const vs = arr.map(x => x.v)
    const wr = arr.filter(x => x.warn).length / arr.length
    const mu = vs.reduce((a, b) => a + b, 0) / vs.length
    md += `| ${factor} | ${mu.toFixed(3)} | ${quantile(vs, 0.5).toFixed(3)} | ${quantile(vs, 0.95).toFixed(3)} | ${(wr * 100).toFixed(1)}% |\n`
  }
  md += `\n`
}

md += `## 书本级聚合视图（每书 mean-CV + any-warn 书口径 FPR）\n\n`
for (const [genre, cvMap] of Object.entries(bookCVs)) {
  const allMeans = [...cvMap.values()].map(vs => vs.reduce((a, b) => a + b, 0) / vs.length)
  if (allMeans.length === 0) continue
  md += `- **${LABELS[genre]}**: book-mean-CV P5=${quantile(allMeans, 0.05).toFixed(3)} P25=${quantile(allMeans, 0.25).toFixed(3)} P50=${quantile(allMeans, 0.5).toFixed(3)}（n=${allMeans.length} 本）\n`
}
{
  const allMaps = Object.values(bookCVs)
  const allBookMeans = allMaps.flatMap(m => [...m.values()]).map(vs => vs.reduce((a, b) => a + b, 0) / vs.length)
  if (allBookMeans.length > 0) {
    md += `\n| 阈值 | 全体书本 any-warn FPR | n=书本数 |\n|---|---|---|\n`
    for (const t of [0.30, 0.35]) {
      const bw = allMaps.flatMap(m => [...m.values()]).map(vs => vs.some(cv => cv < t))
      md += `| CV<${t.toFixed(2)} | ${(bw.filter(Boolean).length / bw.length * 100).toFixed(2)}% | ${bw.length} |\n`
    }
  }
}

md += `
## 种子基线对照（synthetic-degraded 30 篇 human 同管线）

| 因子 | n | warn 触发率 |
|---|---|---|
`
for (const factor of FACTORS) md += `| ${factor} | ${seedBaseline[factor].n} | ${(seedBaseline[factor].rate * 100).toFixed(1)}% |\n`

md += `
## 读法说明

> ⚠ **20260823 反转警示**：旧版过滤切片口径（≥30 字段落过滤/500 字窗/仅前 8000 字）曾产生
> 35–53% 的伪影 warn 率。本版已对齐生产等价单元；正式轨测量必须走 runbook §1 测量单元纪律。

1. warn 触发率是「生产等价单元口径下的相对信号」，跨族比较需书本级聚合校正后才有效
2. 正式轨测量以 rederive-pl-threshold.mjs 口径为准；本脚本仅供内部表征与缺口可视化（如言情饥饿）
3. 本画像不产生 PASS/FAIL 判定——那是正式轨（授权语料 ≥100/族，按族独立解锁）的职责
`

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, md, "utf-8")
console.log(`\n[shadow] 报告 → ${REPORT}`)
console.log("[shadow] 提醒: 产物仅内部统计参考，禁作发版宣称/block解锁依据")
