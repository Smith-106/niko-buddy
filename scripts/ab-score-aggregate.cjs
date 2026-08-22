#!/usr/bin/env node
/**
 * ab-score-aggregate.js — T36 真实补验轮统计计算
 * 
 * 计算：
 *   1. 门槛①：六维 overall 中位差（精品−基线）+ bootstrap 95% CI（10000 次重采样）
 *   2. 门槛③：两评审 accept/reject 向量 Cohen's κ
 * 
 * 输入：
 *   docs/p6/ab-evidence/secret-mapping.json — ID→臂映射
 *   docs/p6/ab-evidence/judges/judge-1-scores.json — J1 评分
 *   docs/p6/ab-evidence/judges/judge-2-scores.json — J2 评分
 *   docs/p6/ab-evidence/judges/judge-1-preferences.json — J1 偏好
 *   docs/p6/ab-evidence/judges/judge-2-preferences.json — J2 偏好
 *   docs/p6/ab-evidence/pair-index.json — 配对索引
 * 
 * 输出：stdout (统计报告)
 */

const fs = require('fs')
const path = require('path')

const EVIDENCE_DIR = path.join(__dirname, '..', 'docs', 'p6', 'ab-evidence')

// ─── 读取数据 ───────────────────────────────────────────────────────────────

const readJSON = (file) => JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, file), 'utf-8'))

const secret = readJSON('secret-mapping.json')
const j1Scores = readJSON('judges/judge-1-scores.json')
const j2Scores = readJSON('judges/judge-2-scores.json')
const j1Prefs = readJSON('judges/judge-1-preferences.json')
const j2Prefs = readJSON('judges/judge-2-preferences.json')
const pairIndex = readJSON('pair-index.json')

// 判官身份从判官池数据读取（DEBT-20260828-t31b-01）：
// scores 文件的 `model` 字段即判官池成员（registry 默认池 flash+ox 的数据侧镜像），
// 不再在脚本内硬编码双子代理标签。
const j1Model = (j1Scores.model || 'deepseek-v4-flash')
const j2Model = (j2Scores.model || 'ox-alpha-free')
const judgeLabel = (full) => (full.includes('/') ? full.split('/').pop() : full)

// 统一数据格式（兼容 scores 可能是数组或 {scores:[]}）
const j1ScoresArr = j1Scores.scores || j1Scores
const j2ScoresArr = j2Scores.scores || j2Scores
const j1PrefsArr = j1Prefs.preferences || j1Prefs
const j2PrefsArr = j2Prefs.preferences || j2Prefs
const secretItems = secret.items || secret
const pairs = pairIndex.pairs || pairIndex

// 构建 ID→臂 映射
const idToArm = {}
for (const item of secretItems) {
  idToArm[item.id] = item.arm
}

// 构建 ID→总分 映射（按 judge）
const j1OverallById = {}
const j2OverallById = {}
for (const s of j1ScoresArr) { j1OverallById[s.id] = s.scores.overall }
for (const s of j2ScoresArr) { j2OverallById[s.id] = s.scores.overall }

// ─── 按配对整理 ─────────────────────────────────────────────────────────────

// 每个配对：{ bookId, chapterIndex, baselineId, premiumId, j1Diff, j2Diff, j1Pref, j2Pref }
const pairedData = pairs.map(p => {
  const baselineId = p.baselineId || p.labelA  // 兼容不同字段名
  const premiumId = p.premiumId || p.labelB
  const j1Baseline = j1OverallById[baselineId]
  const j1Premium = j1OverallById[premiumId]
  const j2Baseline = j2OverallById[baselineId]
  const j2Premium = j2OverallById[premiumId]
  
  const j1Diff = j1Premium - j1Baseline
  const j2Diff = j2Premium - j2Baseline
  
  // 偏好：找出这个配对在偏好数组中的对应项
  const j1Pref = j1PrefsArr.find(x => x.textA_id === baselineId && x.textB_id === premiumId)
  const j2Pref = j2PrefsArr.find(x => x.textA_id === baselineId && x.textB_id === premiumId)
  
  return {
    bookId: p.bookId,
    chapterIndex: p.chapterIndex,
    baselineId,
    premiumId,
    j1Baseline, j1Premium, j1Diff,
    j2Baseline, j2Premium, j2Diff,
    j1Pref: j1Pref?.preference || null,
    j2Pref: j2Pref?.preference || null
  }
})

// ─── 统计函数 ───────────────────────────────────────────────────────────────

const median = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length

const bootstrapCI = (diffs, nResamples = 10000, alpha = 0.05) => {
  const medians = []
  const n = diffs.length
  for (let i = 0; i < nResamples; i++) {
    const sample = []
    for (let j = 0; j < n; j++) {
      sample.push(diffs[Math.floor(Math.random() * n)])
    }
    medians.push(median(sample))
  }
  medians.sort((a, b) => a - b)
  const lower = medians[Math.floor(nResamples * alpha / 2)]
  const upper = medians[Math.floor(nResamples * (1 - alpha / 2))]
  return { lower, upper, median: median(diffs), nResamples }
}

const cohensKappa = (ratings1, ratings2) => {
  // ratings1, ratings2: 数组，每个元素为 0 或 1
  const n = ratings1.length
  if (n === 0) return { kappa: 0, po: 0, pe: 0, n }
  
  // 观察一致率
  let agreements = 0
  let count1 = 0, count2 = 0
  for (let i = 0; i < n; i++) {
    if (ratings1[i] === ratings2[i]) agreements++
    if (ratings1[i] === 1) count1++
    if (ratings2[i] === 1) count2++
  }
  const po = agreements / n
  
  // 随机一致期望
  const p1 = count1 / n
  const p2 = count2 / n
  const pe = p1 * p2 + (1 - p1) * (1 - p2)
  
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe)
  return { kappa, po, pe, n, p1, p2 }
}

// ─── 计算门槛①：中位差 + bootstrap 95%CI ────────────────────────────────────

console.log('═'.repeat(60))
console.log('T36 真实补验轮 — 统计计算报告')
console.log('═'.repeat(60))

// 每位评审的配对 diff
const j1Diffs = pairedData.map(p => p.j1Diff).filter(d => d !== undefined && !isNaN(d))
const j2Diffs = pairedData.map(p => p.j2Diff).filter(d => d !== undefined && !isNaN(d))

// 平均 diff（取两评审均值作为综合分）
const avgDiffs = pairedData.map(p => {
  const d = ((p.j1Diff || 0) + (p.j2Diff || 0)) / 2
  return d
}).filter(d => !isNaN(d))

console.log(`\n## 门槛①：六维 overall 中位差（精品−基线）`)
console.log(`\n配对样本数 N = ${pairedData.length}`)
console.log(`\n### J1 (${judgeLabel(j1Model)})`)
const j1CI = bootstrapCI(j1Diffs, 10000)
console.log(`  中位差: ${j1CI.median.toFixed(4)}`)
console.log(`  均值差: ${mean(j1Diffs).toFixed(4)}`)
console.log(`  95%CI: [${j1CI.lower.toFixed(4)}, ${j1CI.upper.toFixed(4)}]`)
console.log(`  CI 含 0: ${j1CI.lower <= 0 && j1CI.upper >= 0 ? '⚠️ 是' : '✓ 否'}`)
console.log(`  meetsMinDiff(≥+0.5): ${j1CI.median >= 0.5 ? '✓ 是' : '✗ 否'}`)
console.log(`  significant: ${j1CI.lower > 0 ? '✓ 是' : '✗ 否（CI 含 0 或跨零）'}`)

console.log(`\n### J2 (${judgeLabel(j2Model)})`)
const j2CI = bootstrapCI(j2Diffs, 10000)
console.log(`  中位差: ${j2CI.median.toFixed(4)}`)
console.log(`  均值差: ${mean(j2Diffs).toFixed(4)}`)
console.log(`  95%CI: [${j2CI.lower.toFixed(4)}, ${j2CI.upper.toFixed(4)}]`)
console.log(`  CI 含 0: ${j2CI.lower <= 0 && j2CI.upper >= 0 ? '⚠️ 是' : '✓ 否'}`)
console.log(`  meetsMinDiff(≥+0.5): ${j2CI.median >= 0.5 ? '✓ 是' : '✗ 否'}`)
console.log(`  significant: ${j2CI.lower > 0 ? '✓ 是' : '✗ 否'}`)

console.log(`\n### 综合（两评审均值）`)
const avgCI = bootstrapCI(avgDiffs, 10000)
console.log(`  中位差: ${avgCI.median.toFixed(4)}`)
console.log(`  均值差: ${mean(avgDiffs).toFixed(4)}`)
console.log(`  95%CI: [${avgCI.lower.toFixed(4)}, ${avgCI.upper.toFixed(4)}]`)
console.log(`  CI 含 0: ${avgCI.lower <= 0 && avgCI.upper >= 0 ? '⚠️ 是' : '✓ 否'}`)
console.log(`  meetsMinDiff(≥+0.5): ${avgCI.median >= 0.5 ? '✓ 是' : '✗ 否'}`)
console.log(`  significant: ${avgCI.lower > 0 ? '✓ 是' : '✗ 否'}`)

// ─── 计算门槛③：Cohen's κ ───────────────────────────────────────────────────

console.log(`\n\n## 门槛③：盲评 κ（审评间一致性）`)

// 将偏好转为 accept premium 向量
// 对每个配对：preference='B'（B=premium）→ accept=1, preference='A' 或 'tie' → accept=0
const j1Accept = pairedData.map(p => {
  if (p.j1Pref === 'B') return 1
  return 0
})
const j2Accept = pairedData.map(p => {
  if (p.j2Pref === 'B') return 1
  return 0
})

const kappa = cohensKappa(j1Accept, j2Accept)
console.log(`\n  接受精品臂的判定向量（premium=1, baseline/tie=0）`)
console.log(`  J1: [${j1Accept.join(',')}]`)
console.log(`  J2: [${j2Accept.join(',')}]`)
console.log(`  Po (观察一致率): ${kappa.po.toFixed(4)}`)
console.log(`  Pe (随机一致期望): ${kappa.pe.toFixed(4)}`)
console.log(`  Cohen's κ: ${kappa.kappa.toFixed(4)}`)
console.log(`  κ≥0.6: ${kappa.kappa >= 0.6 ? '✓ 是' : '✗ 否'}`)

// 考虑 tie 的多值 κ（三值：prefer_baseline=0, tie=1, prefer_premium=2）
const j1Pref3 = pairedData.map(p => {
  if (p.j1Pref === 'A') return 0
  if (p.j1Pref === 'B') return 2
  return 1
})
const j2Pref3 = pairedData.map(p => {
  if (p.j2Pref === 'A') return 0
  if (p.j2Pref === 'B') return 2
  return 1
})

const kappa3 = (() => {
  const n = j1Pref3.length
  let agreements = 0
  const counts = [0, 0, 0] // J1 边际
  const counts2 = [0, 0, 0] // J2 边际
  for (let i = 0; i < n; i++) {
    if (j1Pref3[i] === j2Pref3[i]) agreements++
    counts[j1Pref3[i]]++
    counts2[j2Pref3[i]]++
  }
  const po = agreements / n
  const pe = counts.reduce((s, c, i) => s + (c / n) * (counts2[i] / n), 0)
  const k = pe === 1 ? 1 : (po - pe) / (1 - pe)
  return { kappa: k, po, pe, n }
})()

console.log(`\n  三值 κ（baseline=0, tie=1, premium=2）`)
console.log(`  J1: [${j1Pref3.join(',')}]`)
console.log(`  J2: [${j2Pref3.join(',')}]`)
console.log(`  Po: ${kappa3.po.toFixed(4)}`)
console.log(`  Pe: ${kappa3.pe.toFixed(4)}`)
console.log(`  Cohen's κ: ${kappa3.kappa.toFixed(4)}`)

// ─── 详细配对数据 ────────────────────────────────────────────────────────────

console.log(`\n\n## 详细配对数据`)
console.log(`\n${'Book'.padEnd(8)} ${'Ch'.padEnd(4)} ${'J1_base'.padEnd(8)} ${'J1_prem'.padEnd(8)} ${'J1_diff'.padEnd(8)} ${'J2_base'.padEnd(8)} ${'J2_prem'.padEnd(8)} ${'J2_diff'.padEnd(8)} ${'J1_pref'.padEnd(8)} ${'J2_pref'.padEnd(8)}`)
console.log('-'.repeat(90))
for (const p of pairedData) {
  console.log(`${(p.bookId || '').padEnd(8)} ${String(p.chapterIndex || '').padEnd(4)} ${String(p.j1Baseline ?? '-').padEnd(8)} ${String(p.j1Premium ?? '-').padEnd(8)} ${(p.j1Diff != null ? p.j1Diff.toFixed(1) : '-').padEnd(8)} ${String(p.j2Baseline ?? '-').padEnd(8)} ${String(p.j2Premium ?? '-').padEnd(8)} ${(p.j2Diff != null ? p.j2Diff.toFixed(1) : '-').padEnd(8)} ${(p.j1Pref || '-').padEnd(8)} ${(p.j2Pref || '-').padEnd(8)}`)
}

// ─── 按书分拆统计 ────────────────────────────────────────────────────────────

console.log(`\n\n## 按书分拆统计`)

for (const bookId of ['book-a', 'book-b']) {
  const bookPairs = pairedData.filter(p => p.bookId === bookId)
  const bookAvgDiffs = bookPairs.map(p => ((p.j1Diff || 0) + (p.j2Diff || 0)) / 2)
  const bookCI = bootstrapCI(bookAvgDiffs, 10000)
  console.log(`\n### ${bookId === 'book-a' ? '都市迷踪（都市冒险）' : '锦瑟长安（古风家族）'}`)
  console.log(`  N = ${bookPairs.length}`)
  console.log(`  中位差: ${bookCI.median.toFixed(4)}`)
  console.log(`  95%CI: [${bookCI.lower.toFixed(4)}, ${bookCI.upper.toFixed(4)}]`)
  console.log(`  CI 含 0: ${bookCI.lower <= 0 && bookCI.upper >= 0 ? '⚠️ 是' : '✓ 否'}`)
}

// ─── 逐维分析 ────────────────────────────────────────────────────────────────

console.log(`\n\n## 逐维分析`)

const dims = ['thrill', 'arc_consistency', 'hook_strength', 'salient_detail', 'rhythm', 'immersion']
const dimLabels = {
  thrill: '爽点闭环', arc_consistency: '弧光一致', hook_strength: '钩子强度',
  salient_detail: '显著细节', rhythm: '节奏张弛', immersion: '文笔沉浸'
}

// 构建逐维 ID→评分 映射
const j1DimById = {}, j2DimById = {}
for (const s of j1ScoresArr) { j1DimById[s.id] = s.scores }
for (const s of j2ScoresArr) { j2DimById[s.id] = s.scores }

for (const dim of dims) {
  const dimDiffs = pairedData.map(p => {
    const j1b = j1DimById[p.baselineId]?.[dim]
    const j1p = j1DimById[p.premiumId]?.[dim]
    const j2b = j2DimById[p.baselineId]?.[dim]
    const j2p = j2DimById[p.premiumId]?.[dim]
    const avg = ((j1p - j1b) + (j2p - j2b)) / 2
    return avg
  }).filter(d => !isNaN(d))
  
  const dimCI = bootstrapCI(dimDiffs, 10000)
  console.log(`\n### ${dimLabels[dim]} (${dim})`)
  console.log(`  中位差: ${dimCI.median.toFixed(4)}`)
  console.log(`  95%CI: [${dimCI.lower.toFixed(4)}, ${dimCI.upper.toFixed(4)}]`)
  console.log(`  CI 含 0: ${dimCI.lower <= 0 && dimCI.upper >= 0 ? '⚠️ 是' : '✓ 否'}`)
}

// ─── 总判定 ──────────────────────────────────────────────────────────────────

console.log(`\n\n## 总判定`)
console.log(`\n### 门槛① 六维 overall 中位差（精品−基线 ≥+0.5 且 95%CI 不含 0）`)
const threshold1Pass = avgCI.median >= 0.5 && avgCI.lower > 0
console.log(`  综合中位差: ${avgCI.median.toFixed(4)}`)
console.log(`  95%CI: [${avgCI.lower.toFixed(4)}, ${avgCI.upper.toFixed(4)}]`)
console.log(`  判定: ${threshold1Pass ? '✓ PASS' : '✗ FAIL'}`)

console.log(`\n### 门槛③ 盲评 κ≥0.6`)
console.log(`  Cohen's κ: ${kappa.kappa.toFixed(4)} (二值：精品与否)`)
console.log(`  Cohen's κ: ${kappa3.kappa.toFixed(4)} (三值：baseline/tie/premium)`)
console.log(`  判定: ${kappa.kappa >= 0.6 ? '✓ PASS' : '✗ FAIL'}`)
console.log(`  注：蓝图 A-24.2 允许 AI 评分者，κ 为真判定（非 AI-proxy 参考）`)

// ─── 输出 JSON 摘要 ─────────────────────────────────────────────────────────

const summary = {
  experiment: 'T36 真实补验轮',
  date: new Date().toISOString().split('T')[0],
  sampleSize: pairedData.length,
  judges: [`J1-${judgeLabel(j1Model)}`, `J2-${judgeLabel(j2Model)}`],
  threshold1: {
    medianDiff: avgCI.median,
    ci95: [avgCI.lower, avgCI.upper],
    meetsMinDiff: avgCI.median >= 0.5,
    significant: avgCI.lower > 0,
    pass: threshold1Pass,
    j1: { medianDiff: j1CI.median, ci95: [j1CI.lower, j1CI.upper] },
    j2: { medianDiff: j2CI.median, ci95: [j2CI.lower, j2CI.upper] }
  },
  threshold3: {
    cohensKappa: kappa.kappa,
    cohensKappa3: kappa3.kappa,
    po: kappa.po,
    pe: kappa.pe,
    pass: kappa.kappa >= 0.6,
    note: 'AI 评分者，蓝图 A-24.2 允许，κ 为真判定'
  },
  byBook: {
    bookA: { medianDiff: bootstrapCI(pairedData.filter(p => p.bookId === 'book-a').map(p => ((p.j1Diff || 0) + (p.j2Diff || 0)) / 2), 10000).median },
    bookB: { medianDiff: bootstrapCI(pairedData.filter(p => p.bookId === 'book-b').map(p => ((p.j1Diff || 0) + (p.j2Diff || 0)) / 2), 10000).median }
  }
}

console.log(`\n\n## JSON 摘要`)
console.log(JSON.stringify(summary, null, 2))