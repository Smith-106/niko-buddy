// L9 评分器一致性：muse-spark（主产物）vs kiro-sonnet（全量重评，已停止，部分覆盖）。
//
// 回答的问题：两把尺子是「整体差一个常数」，还是对「哪章好哪章差」的看法本身就不同？
// 只在两边都有有效分的章上比较；kiro 覆盖是 ch1 起的连续前缀加若干抽样章，
// 不是均匀抽样，报告里会如实列出覆盖章段。
//
// 运行: node scripts/compare-l9-judges.mjs
// 产物: ../.workflow/harvest-staging/l9-judge-agreement.{md,json}
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const STAGING = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".workflow", "harvest-staging")
const MUSE_PATH = join(STAGING, "quality-gate-97-l9-m-full.json")
const KIRO_PATH = join(STAGING, "quality-gate-97-l9-kiro-full.json")
const DIMS = ["thrill", "pacing", "pull", "consistency", "continuity", "character"]
const PASS_LINE = 9.0

const isNum = (v) => typeof v === "number" && Number.isFinite(v)
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const r2 = (v) => Math.round(v * 100) / 100

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0])
  const out = Array(a.length)
  for (let i = 0; i < idx.length; ) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let t = i; t <= j; t++) out[idx[t][1]] = avg
    i = j + 1
  }
  return out
}

function pearson(x, y) {
  const mx = mean(x)
  const my = mean(y)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
    syy += (y[i] - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

const spearman = (x, y) => pearson(rank(x), rank(y))

function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    console.error(`FATAL: 读不到 ${path}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
}

const muse = load(MUSE_PATH)
const kiro = load(KIRO_PATH)
const chNum = (c) => Number(c.slice(2))

const complete = (r) => isNum(r?.overall) && DIMS.every((d) => isNum(r?.dimensionMedians?.[d]))
const common = Object.keys(kiro.results)
  .filter((c) => complete(kiro.results[c]) && complete(muse.results[c]))
  .sort((a, b) => chNum(a) - chNum(b))

if (common.length < 10) {
  console.error(`FATAL: 两边都有完整分数的章只有 ${common.length} 章，不足以比较`)
  process.exit(2)
}

const mOv = common.map((c) => muse.results[c].overall)
const kOv = common.map((c) => kiro.results[c].overall)

const perDim = DIMS.map((d) => {
  const m = common.map((c) => muse.results[c].dimensionMedians[d])
  const k = common.map((c) => kiro.results[c].dimensionMedians[d])
  return { dimension: d, spearman: r2(spearman(m, k)), museMean: r2(mean(m)), kiroMean: r2(mean(k)), meanGap: r2(mean(k) - mean(m)) }
})

const kiroPass = common.filter((c) => kiro.results[c].overall >= PASS_LINE).length
const musePass = common.filter((c) => muse.results[c].overall >= PASS_LINE).length

// 各自的「最弱维」：每章取中位数最低的维度，统计出现频次
function weakestCount(src) {
  const cnt = Object.fromEntries(DIMS.map((d) => [d, 0]))
  for (const c of common) {
    const dm = src.results[c].dimensionMedians
    const min = Math.min(...DIMS.map((d) => dm[d]))
    for (const d of DIMS) if (dm[d] === min) cnt[d]++
  }
  return cnt
}

// 各自最弱的 10 章（overall 最低）的重合度
const bottomK = Math.min(10, Math.floor(common.length / 4))
const bottom = (src) => [...common].sort((a, b) => src.results[a].overall - src.results[b].overall).slice(0, bottomK)
const bm = new Set(bottom(muse))
const overlap = bottom(kiro).filter((c) => bm.has(c))

const coveredPrefix = common.filter((c) => chNum(c) <= 67).length
const report = {
  generatedAt: new Date().toISOString(),
  models: { muse: muse.model, kiro: kiro.model },
  coverage: {
    compared: common.length,
    chapters: common,
    note: "kiro 全量重评已手动停止。覆盖为 ch1 起的连续前缀 + 若干抽样章，不是均匀抽样；早期章节的结论不一定代表后段。",
    inContiguousPrefix: coveredPrefix,
  },
  overall: {
    spearman: r2(spearman(mOv, kOv)),
    museMean: r2(mean(mOv)),
    kiroMean: r2(mean(kOv)),
    museRange: [Math.min(...mOv), Math.max(...mOv)],
    kiroRange: [Math.min(...kOv), Math.max(...kOv)],
    musePass,
    kiroPass,
  },
  perDimension: perDim,
  weakestDimensionCount: { muse: weakestCount(muse), kiro: weakestCount(kiro) },
  bottomChapters: { k: bottomK, overlap: overlap.length, overlapChapters: overlap },
}

const L = []
L.push("# L9 评分器一致性：muse-spark vs kiro-sonnet")
L.push("")
L.push(`生成时间：${report.generatedAt}`)
L.push("")
L.push("> ⚠️ kiro 全量重评**已手动停止**，只覆盖部分章。覆盖是 ch1 起的连续前缀加若干抽样章，")
L.push("> 不是均匀抽样；以下结论对早期章节更可靠，不能直接外推到后段。")
L.push("")
L.push(`- muse：\`${muse.model}\`（主产物）`)
L.push(`- kiro：\`${kiro.model}\`（全量重评，部分覆盖）`)
L.push(`- 两边都有完整分数的章：**${common.length}**（其中 ch1-67 连续前缀 ${coveredPrefix} 章）`)
L.push("")
L.push("## 1. overall 层面")
L.push("")
L.push(`- 排序相关（Spearman）：**${report.overall.spearman}**`)
L.push(`- 均值：muse ${report.overall.museMean} / kiro ${report.overall.kiroMean}`)
L.push(`- 范围：muse ${report.overall.museRange[0]}~${report.overall.museRange[1]} / kiro ${report.overall.kiroRange[0]}~${report.overall.kiroRange[1]}`)
L.push(`- 过 ${PASS_LINE} 线的章数：muse ${musePass}/${common.length} / kiro ${kiroPass}/${common.length}`)
L.push("")
L.push("## 2. 分维度")
L.push("")
L.push("| 维度 | 排序相关 | muse 均分 | kiro 均分 | kiro−muse |")
L.push("|---|---|---|---|---|")
for (const p of perDim) L.push(`| ${p.dimension} | ${p.spearman} | ${p.museMean} | ${p.kiroMean} | ${p.meanGap} |`)
L.push("")
L.push("## 3. 各自的最弱维（每章取中位数最低的维度，计出现次数）")
L.push("")
L.push("| 维度 | muse | kiro |")
L.push("|---|---|---|")
for (const d of DIMS) L.push(`| ${d} | ${report.weakestDimensionCount.muse[d]} | ${report.weakestDimensionCount.kiro[d]} |`)
L.push("")
L.push(`## 4. 各自最低的 ${bottomK} 章重合度`)
L.push("")
L.push(`重合 ${overlap.length}/${bottomK} 章${overlap.length ? `：${overlap.join(", ")}` : ""}。`)
L.push("")
L.push("## 5. 解读")
L.push("")
L.push("- 排序相关低说明两把尺子对「哪章好哪章差」的看法本身不同，不只是 kiro 整体低一个常数。")
L.push("- 此时 muse 的 pass/fail 结论不能被当作稳定的质量判断。")
L.push("- 相关度高的维度（排序相关接近或超过 0.7）才可以在两把尺子间互相印证。")
L.push("")

writeFileSync(join(STAGING, "l9-judge-agreement.json"), JSON.stringify(report, null, 2) + "\n", "utf8")
writeFileSync(join(STAGING, "l9-judge-agreement.md"), L.join("\n") + "\n", "utf8")
console.log(`比较 ${common.length} 章 | overall Spearman ${report.overall.spearman} | muse pass ${musePass} / kiro pass ${kiroPass}`)
for (const p of perDim) console.log(`  ${p.dimension.padEnd(12)} rho ${String(p.spearman).padStart(5)}  muse ${p.museMean}  kiro ${p.kiroMean}  gap ${p.meanGap}`)
console.log(`最弱维 muse: ${JSON.stringify(report.weakestDimensionCount.muse)}`)
console.log(`最弱维 kiro: ${JSON.stringify(report.weakestDimensionCount.kiro)}`)
console.log(`最低 ${bottomK} 章重合: ${overlap.length}/${bottomK}`)
