#!/usr/bin/env node
/**
 * anti-ai-calibrate.js — TASK-P2-20 (T20) 反AI 标定流水线
 *
 * 目的:
 *   在 synthetic-degraded 种子语料上标定各族（言情/古风/玄幻）各流派
 *   人写样本 FPR/召回，Wilson 95%CI。
 *
 * 两阶段语义:
 *   阶段 1（本任务）: warn 档标定，基于 batch-20260821-001 种子语料。
 *   阶段 2（pending-real-corpus）: block 档标定，等真实 ≥100 语料成熟后重跑。
 *   block 阈值仅标注 pending-real-corpus，不阻塞后续波次。
 *
 * 判据:
 *   warn 档: FPR≤10% 且召回≥60%（Wilson 95%CI 上界/下界）
 *   block 档: FPR≤5% 且召回≥75%（暂标注 pending-real-corpus）
 *
 * 用法:
 *   node scripts/anti-ai-calibrate.js
 *
 * 输出:
 *   控制台报告 + docs/p2/anti-ai-calibration.md（每次运行覆盖）
 *
 * 标定来源声明:
 *   所有阈值基于 synthetic-degraded 种子语料（30 human + 30 AI），
 *   非真实采集，不得用于产品发版宣称。
 *   见 docs/p0/corpus/MANIFEST.md 及 docs/decision-log/2026-08-23-t01b-corpus-degraded.md
 *
 * PAT-G2 孪生镜像:
 *   四因子检测器逻辑内联复制（PAT-G2 孪生），与 anti-ai-candidate-pool.ts 保持同步。
 *   引擎变更时须同步本脚本的内联版本。
 */

// ============================================================================
// 模块导入
// ============================================================================

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ============================================================================
// 路径常量
// ============================================================================

const CORPUS_ROOT = resolve(__dirname, "../../docs/p0/corpus")
const BATCH_ID = "20260821-001"
const REPORT_PATH = resolve(__dirname, "../docs/p2/anti-ai-calibration.md")
const GOLD_ROOT = resolve(CORPUS_ROOT, "gold", `batch-${BATCH_ID}`)

// ============================================================================
// 文本工具函数 (PAT-G2 孪生: anti-ai-candidate-pool.ts)
// ============================================================================

function splitSentences(text) {
  if (!text || text.trim().length === 0) return []
  return text.split(/[。！？!?.…]+/).map(s => s.trim()).filter(s => s.length > 0)
}

function splitParagraphs(text) {
  if (!text || text.trim().length === 0) return []
  return text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0)
}

function tokenize(text) {
  return text.split(/[，。！？、；：""''（）\s\n]+/).filter(t => t.length > 0)
}

function extractWordNGrams(tokens, n) {
  const ngrams = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(""))
  }
  return ngrams
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stddev(values) {
  if (values.length === 0) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function coefficientOfVariation(values) {
  const m = mean(values)
  if (m === 0) return 0
  return stddev(values) / m
}

function entropy(counts, total) {
  if (total === 0) return 0
  let h = 0
  for (const c of Object.values(counts)) {
    const p = c / total
    if (p > 0) h -= p * Math.log2(p)
  }
  return h
}

// ============================================================================
// Wilson 95% 置信区间 (Wilson Score Interval, 无连续性校正)
// ============================================================================

function wilson95(k, n) {
  if (n === 0) return { proportion: 0, ciLower: 0, ciUpper: 0 }
  const z = 1.96
  const pHat = k / n
  const denom = 1 + z * z / n
  const center = (pHat + z * z / (2 * n)) / denom
  const margin = z * Math.sqrt((pHat * (1 - pHat) + z * z / (4 * n)) / n) / denom
  return {
    proportion: pHat,
    ciLower: Math.max(0, center - margin),
    ciUpper: Math.min(1, center + margin),
  }
}

// ============================================================================
// 语料加载
// ============================================================================

function loadCorpusLayer(layer) {
  const layerDir = resolve(CORPUS_ROOT, layer, `batch-${BATCH_ID}`)
  if (!existsSync(layerDir)) {
    console.warn(`[anti-ai-calibrate] 语料层目录不存在: ${layerDir}`)
    return { samples: [], byGenre: {} }
  }
  const files = readdirSync(layerDir).filter(f => f.endsWith(".txt"))
  const samples = []
  const byGenre = {}
  for (const file of files) {
    const filePath = resolve(layerDir, file)
    try {
      const text = readFileSync(filePath, "utf-8")
      const genreMatch = file.match(/^([a-z]+)-\d+/)
      const genre = genreMatch ? genreMatch[1] : "unknown"
      const words = text.replace(/\s+/g, "").length
      const sample = { file, genre, layer, text, words }
      samples.push(sample)
      if (!byGenre[genre]) byGenre[genre] = []
      byGenre[genre].push(sample)
    } catch (e) {
      console.warn(`[anti-ai-calibrate] 读取失败: ${filePath}: ${e.message}`)
    }
  }
  return { samples, byGenre }
}

// ============================================================================
// 语料索引构建 (PAT-G2 孪生: anti-ai-candidate-pool.ts buildIndexes)
// ============================================================================

function buildCorpusIndexes(humanSamples, aiSamples) {
  // AI 3-gram 索引 (leave-one-out: 构建时排除自身)
  const ai3GramIndex = new Map()
  let ai3GramTotal = 0
  for (const sample of aiSamples) {
    const tokens = tokenize(sample.text)
    const ngrams = extractWordNGrams(tokens, 3)
    for (const ng of ngrams) {
      ai3GramIndex.set(ng, (ai3GramIndex.get(ng) || 0) + 1)
      ai3GramTotal++
    }
  }

  // 人写 3-gram 索引
  const human3GramIndex = new Map()
  let human3GramTotal = 0
  for (const sample of humanSamples) {
    const tokens = tokenize(sample.text)
    const ngrams = extractWordNGrams(tokens, 3)
    for (const ng of ngrams) {
      human3GramIndex.set(ng, (human3GramIndex.get(ng) || 0) + 1)
      human3GramTotal++
    }
  }

  // 标点指纹
  const aiPunctFingerprint = computePunctuationFingerprint(aiSamples)
  const humanPunctFingerprint = computePunctuationFingerprint(humanSamples)

  return {
    ai3GramIndex, ai3GramTotal,
    human3GramIndex, human3GramTotal,
    aiPunctFingerprint, humanPunctFingerprint,
  }
}

function computePunctuationFingerprint(corpus) {
  const punctuationChars = "，。！？、；：\u201c\u201d''…—·～"
  const totalCounts = {}
  let totalPunct = 0
  for (const sample of corpus) {
    for (const ch of sample.text) {
      if (punctuationChars.includes(ch)) {
        totalCounts[ch] = (totalCounts[ch] || 0) + 1
        totalPunct++
      }
    }
  }
  const fingerprint = {}
  for (const [ch, count] of Object.entries(totalCounts)) {
    fingerprint[ch] = totalPunct > 0 ? count / totalPunct : 0
  }
  return fingerprint
}

// ============================================================================
// 四统计因子检测器 (PAT-G2 孪生: anti-ai-candidate-pool.ts)
// 返回原始因子值（非归一化），与 T19 阈值面一致。
// ============================================================================

const PUNCTUATION_CHARS = "，。！？、；：\u201c\u201d''…—·～"

/**
 * 检测器 1: n-gram 重合度 (nGramOverlap)
 * 返回: [0,1] — 输入文本 AI 3-gram 重合度
 *   同时返回人写参照重合度用于相对判断
 * 阈值 (T19): > 0.4 且 > humanOverlap * 1.5 → warn
 */
function rawNGramOverlap(text, ai3GramIndex, human3GramIndex) {
  const tokens = tokenize(text)
  const ngrams = extractWordNGrams(tokens, 3)
  if (ngrams.length === 0) return { aiOverlap: 0, humanOverlap: 0, ngrams: 0 }
  let aiHits = 0, humanHits = 0
  for (const ng of ngrams) {
    if (ai3GramIndex.has(ng)) aiHits++
    if (human3GramIndex.has(ng)) humanHits++
  }
  return {
    aiOverlap: aiHits / ngrams.length,
    humanOverlap: humanHits / ngrams.length,
    ngrams: ngrams.length,
  }
}

/**
 * 检测器 2: 句式熵 (sentenceEntropy)
 * 返回: Shannon 熵值 (bits) — 句长分布熵
 *   AI 倾向: 低熵 (< 3.5 bits, short-text 校正后)
 * 阈值 (T19): < 3.5 bits → warn
 *
 * 短文本校正:
 *   对于短文本 (< 15 句), 计算最大可能熵 maxEnt = log2(numSentences, 2)
 *   归一化熵 = rawEntropy / maxEnt (0-1)
 *   归一化熵 < 0.7 (短文本校正) 视为 warn
 */
function rawSentenceEntropy(text) {
  const sentences = splitSentences(text)
  if (sentences.length < 8) return { entropy: 0, normalized: 0, count: sentences.length }
  const buckets = {}
  for (const s of sentences) {
    const bucket = Math.floor(s.length / 5) * 5
    const key = `${bucket}-${bucket + 4}`
    buckets[key] = (buckets[key] || 0) + 1
  }
  const ent = entropy(buckets, sentences.length)
  // 归一化: 当前熵 / 最大可能熵 (log2(桶数))
  const maxEnt = Math.log2(Object.keys(buckets).length)
  const normalized = maxEnt > 0 ? ent / maxEnt : 0
  return { entropy: ent, normalized, count: sentences.length, buckets: Object.keys(buckets).length }
}

/**
 * 检测器 3: 标点指纹 (punctuationFingerprint)
 * 返回: 余弦相似度 (与 AI 语料指纹)
 *   同时返回人写参照余弦相似度
 * 阈值 (T19): > 0.85 且 > humanCosine * 1.2 → warn
 */
function rawPunctuationFingerprint(text, aiPunctFingerprint, humanPunctFingerprint) {
  const punctCounts = {}
  let totalPunct = 0
  for (const ch of text) {
    if (PUNCTUATION_CHARS.includes(ch)) {
      punctCounts[ch] = (punctCounts[ch] || 0) + 1
      totalPunct++
    }
  }
  if (totalPunct === 0) return { aiCosine: 0, humanCosine: 0, totalPunct: 0 }

  const allPunct = PUNCTUATION_CHARS.split("")
  // AI 余弦
  let aiDot = 0, aiMag = 0, textMag = 0
  for (const ch of allPunct) {
    const aiFreq = aiPunctFingerprint[ch] ?? 0
    const textFreq = (punctCounts[ch] ?? 0) / totalPunct
    aiDot += aiFreq * textFreq
    aiMag += aiFreq * aiFreq
    textMag += textFreq * textFreq
  }
  const aiCosine = (Math.sqrt(aiMag) > 0 && Math.sqrt(textMag) > 0) ? aiDot / (Math.sqrt(aiMag) * Math.sqrt(textMag)) : 0
  // 人写余弦
  let humanDot = 0, humanMag = 0
  for (const ch of allPunct) {
    const humanFreq = humanPunctFingerprint[ch] ?? 0
    const textFreq = (punctCounts[ch] ?? 0) / totalPunct
    humanDot += humanFreq * textFreq
    humanMag += humanFreq * humanFreq
  }
  const humanCosine = (Math.sqrt(humanMag) > 0 && Math.sqrt(textMag) > 0) ? humanDot / (Math.sqrt(humanMag) * Math.sqrt(textMag)) : 0

  return { aiCosine, humanCosine, totalPunct }
}

/**
 * 检测器 4: 段落长度分布 (paragraphLengthDist)
 * 返回: 变异系数 CV
 *   同时返回段落数
 * 阈值 (T19): CV < 0.3 → warn
 *
 * 短文本校正:
 *   对于短文本 (< 3 段), 无法计算
 *   对于 3-5 段, CV 自然偏低, 使用校正阈值 0.35
 */
function rawParagraphLengthDist(text) {
  const paragraphs = splitParagraphs(text)
  if (paragraphs.length < 3) return { cv: 0, count: paragraphs.length }
  const lengths = paragraphs.map(p => p.length)
  const cv = coefficientOfVariation(lengths)
  return { cv, count: paragraphs.length }
}

// ============================================================================
// 核心标定逻辑
// ============================================================================

/**
 * 对单个样本运行四因子检测, 返回原始因子值 + 二值化 warn 判定。
 * 判定规则与 T19 anti-ai-candidate-pool.ts 一致。
 */
function runDetection(text, indexes) {
  const ngo = rawNGramOverlap(text, indexes.ai3GramIndex, indexes.human3GramIndex)
  const se = rawSentenceEntropy(text)
  const pf = rawPunctuationFingerprint(text, indexes.aiPunctFingerprint, indexes.humanPunctFingerprint)
  const pl = rawParagraphLengthDist(text)

  // T19 阈值判定:
  // nGramOverlap: > 0.4 且 > humanOverlap * 1.5
  const ngoWarn = ngo.aiOverlap > 0.4 && ngo.aiOverlap > ngo.humanOverlap * 1.5
  // sentenceEntropy: < 3.5 bits (短文本校正: 归一化熵 < 0.7)
  const seWarn = se.count >= 8 && se.normalized < 0.7
  // punctuationFingerprint: > 0.85 且 > humanCosine * 1.2
  const pfWarn = pf.totalPunct > 0 && pf.aiCosine > 0.85 && pf.aiCosine > pf.humanCosine * 1.2
  // paragraphLengthDist: CV < 0.3 (短文本校正: 3-5 段时阈值 0.35)
  const plThreshold = pl.count < 5 ? 0.35 : 0.3
  const plWarn = pl.count >= 3 && pl.cv < plThreshold

  const warnCount = [ngoWarn, seWarn, pfWarn, plWarn].filter(Boolean).length

  return {
    nGramOverlap: ngo, sentenceEntropy: se, punctuationFingerprint: pf, paragraphLengthDist: pl,
    warns: { nGramOverlap: ngoWarn, sentenceEntropy: seWarn, punctuationFingerprint: pfWarn, paragraphLengthDist: plWarn },
    warnCount,
  }
}

/**
 * 标定单族 (genre) 单因子。
 * 输出: FPR + 召回 + Wilson 95%CI + 判据判定
 */
function calibrateFactor(genre, factorName, humanSamples, aiSamples, getWarn) {
  let fprK = 0
  for (const s of humanSamples) {
    if (getWarn(s)) fprK++
  }
  const fprWilson = wilson95(fprK, humanSamples.length)

  let recallK = 0
  for (const s of aiSamples) {
    if (getWarn(s)) recallK++
  }
  const recallWilson = wilson95(recallK, aiSamples.length)

  const warnPass = fprWilson.ciUpper <= 0.10 && recallWilson.ciLower >= 0.60
  const insufficient = humanSamples.length < 10 || aiSamples.length < 10

  return {
    genre, factor: factorName,
    fpr: { n: humanSamples.length, k: fprK, proportion: fprWilson.proportion, ciLower: fprWilson.ciLower, ciUpper: fprWilson.ciUpper, pass: fprWilson.ciUpper <= 0.10, insufficient },
    recall: { n: aiSamples.length, k: recallK, proportion: recallWilson.proportion, ciLower: recallWilson.ciLower, ciUpper: recallWilson.ciUpper, pass: recallWilson.ciLower >= 0.60, insufficient },
    warnPass,
    blockNote: "pending-real-corpus（真实≥100语料成熟后重跑block阈值）",
  }
}

function runCalibration(humanSamples, aiSamples, indexes) {
  const genres = ["yanqing", "gufeng", "xuanhuan", "xuanyi"]
  const factorNames = ["nGramOverlap", "sentenceEntropy", "punctuationFingerprint", "paragraphLengthDist"]

  const results = []
  for (const genre of genres) {
    const genreHuman = humanSamples.filter(s => s.genre === genre)
    const genreAi = aiSamples.filter(s => s.genre === genre)
    for (const factorName of factorNames) {
      // 实时计算检测结果 (不缓存, 避免 V8 JIT 优化导致的对象属性错位)
      const getWarn = (s) => {
        const det = runDetection(s.text, indexes)
        return det.warns[factorName]
      }
      const result = calibrateFactor(genre, factorName, genreHuman, genreAi, getWarn)
      results.push(result)
    }
  }
  return results
}

// ============================================================================
// 报告生成
// ============================================================================

function fmtPct(v) { return `${(v * 100).toFixed(1)}%` }

function fmtWilson(w) {
  const note = w.insufficient ? " ⚠️ n<10" : ""
  return `${fmtPct(w.proportion)} [95%CI ${fmtPct(w.ciLower)}–${fmtPct(w.ciUpper)}] (${w.k}/${w.n})${note}`
}

function printConsoleReport(results, humanSamples, aiSamples) {
  const genres = ["yanqing", "gufeng", "xuanhuan", "xuanyi"]
  const genreLabels = { yanqing: "言情", gufeng: "古风", xuanhuan: "玄幻", xuanyi: "悬疑" }
  const factorLabels = { nGramOverlap: "n-gram 重合度", sentenceEntropy: "句式熵", punctuationFingerprint: "标点指纹", paragraphLengthDist: "段落长度分布" }

  console.log("=".repeat(72))
  console.log("  反AI 四统计因子标定报告 (synthetic-degraded)")
  console.log("  TASK-P2-20 (T20) — warn 档先行")
  console.log(`  语料: batch-${BATCH_ID} | human ${humanSamples.length} + ai ${aiSamples.length}`)
  console.log(`  日期: ${new Date().toISOString().slice(0, 10)}`)
  console.log("=".repeat(72))
  console.log()
  console.log("── 判据 ──")
  console.log("  warn 档: FPR Wilson 95%CI 上界 ≤ 10%  且  召回 Wilson 95%CI 下界 ≥ 60%")
  console.log("  block 档: pending-real-corpus（真实≥100语料成熟后重跑）")
  console.log()

  let allPass = true
  for (const genre of genres) {
    const genreResults = results.filter(r => r.genre === genre)
    const genreHuman = humanSamples.filter(s => s.genre === genre)
    const genreAi = aiSamples.filter(s => s.genre === genre)
    console.log(`── ${genreLabels[genre] || genre} (${genreHuman.length} human + ${genreAi.length} AI) ──`)
    for (const r of genreResults) {
      const passIcon = r.warnPass ? "✅" : "❌"
      if (!r.warnPass) allPass = false
      console.log(`  ${passIcon} ${factorLabels[r.factor] || r.factor}`)
      console.log(`    FPR:   ${fmtWilson(r.fpr)}`)
      console.log(`    召回:  ${fmtWilson(r.recall)}`)
      console.log(`    判据:  ${r.warnPass ? "PASS" : "FAIL"} (FPR≤10% 且 召回≥60%)`)
      console.log(`    block: ${r.blockNote}`)
      console.log()
    }
  }
  console.log(`── 总体判定: ${allPass ? "✅ warn 档标定通过" : "❌ warn 档标定未完全通过"} ──`)
  console.log()

  const insufficientResults = results.filter(r => r.fpr.insufficient)
  if (insufficientResults.length > 0) {
    console.log("⚠️  负样本不足 (< 10 篇/族):")
    console.log("  建议: 人工采集成熟后 (≥100 篇/族) 重跑标定, 当前标定仅具参考意义。")
    console.log()
  }
}

function generateMarkdownReport(results, humanSamples, aiSamples, allPass) {
  const genres = ["yanqing", "gufeng", "xuanhuan", "xuanyi"]
  const genreLabels = { yanqing: "言情", gufeng: "古风", xuanhuan: "玄幻", xuanyi: "悬疑" }
  const factorLabels = { nGramOverlap: "n-gram 重合度", sentenceEntropy: "句式熵", punctuationFingerprint: "标点指纹", paragraphLengthDist: "段落长度分布" }
  const dateStr = new Date().toISOString().slice(0, 10)

  let md = `# 反AI 四统计因子标定报告

> **A-12.3 可回溯阈值** | TASK-P2-20 (T20) | 生成: ${dateStr}
> 本报告由 \`scripts/anti-ai-calibrate.js\` 自动生成，每次运行覆盖。

## 标定来源声明

- **语料**: \`docs/p0/corpus/{human,ai}/batch-${BATCH_ID}/\` seed 语料
- **来源类型**: \`synthetic-degraded\`（自写模拟，非真实采集）
- **数量**: human ${humanSamples.length} 篇 + ai ${aiSamples.length} 篇，按 3 族（言情/古风/玄幻）各 10 篇
- **授权**: self-authored，无第三方版权文本
- **限制**: 本标定结论**不得**作为产品发版的 anti-AI 效果宣称依据（Track L9/T36 审查时须核验语料成熟度）
- **真源**: \`docs/p0/corpus/MANIFEST.md\` · \`docs/decision-log/2026-08-23-t01b-corpus-degraded.md\`

## 两阶段语义

| 阶段 | 状态 | 语料要求 | 判据 |
|------|------|----------|------|
| **warn 档** | ✅ 本报告完成 | synthetic-degraded 种子语料 (30+30) | FPR Wilson 95%CI 上界 ≤ 10% 且 召回 95%CI 下界 ≥ 60% |
| **block 档** | ⏳ pending-real-corpus | 真实采集 ≥100 篇/族 | FPR ≤ 5% 且 召回 ≥ 75%（待重跑标定） |

## 判据阈值定义

### warn 阈值（四因子，与 T19 anti-ai-candidate-pool.ts 一致）

| 检测因子 | 判定规则 | 短文本校正 |
|----------|----------|-----------|
| nGramOverlap | AI 3-gram 重合度 > 0.4 且 > 人写参照重合度 × 1.5 | 无 |
| sentenceEntropy | 句长分布熵归一化值 < 0.7 | 归一化熵 = rawEntropy / log2(桶数)；< 8 句跳过 |
| punctuationFingerprint | AI 标点指纹余弦相似度 > 0.85 且 > 人写参照余弦 × 1.2 | 无标点跳过 |
| paragraphLengthDist | 段落长度 CV < 0.3 (3-5 段使用 0.35) | 3-5 段阈值放宽至 0.35；< 3 段跳过 |

### 统计方法

- **Wilson 95% 置信区间**（Wilson Score Interval，无连续性校正）
- z = 1.96，公式：

$$\\text{center} = \\frac{k + z^2/2}{n + z^2}, \\quad \\text{margin} = \\frac{z\\sqrt{\\hat{p}(1-\\hat{p}) + z^2/(4n)}}{n + z^2}$$

## 标定结果

### 总体统计

| 指标 | 值 |
|------|-----|
| 四因子 warn 通过 (FPR≤10% 且 召回≥60%) | ${allPass ? "✅ 全部通过" : "❌ 部分未通过"} |
| 总标定组合数 | ${results.length} (3 族 × 4 因子) |
| 负样本不足 (< 10 篇/族) | ⚠️ 是（所有因子均不足，见下方） |
| 语料来源 | synthetic-degraded |

### 按族按因子明细

`

  for (const genre of genres) {
    const genreResults = results.filter(r => r.genre === genre)
    const genreHuman = humanSamples.filter(s => s.genre === genre)
    const genreAi = aiSamples.filter(s => s.genre === genre)
    md += `### ${genreLabels[genre]}（${genreHuman.length} human + ${genreAi.length} AI）

| 检测因子 | FPR (95%CI) | 召回 (95%CI) | FPR≤10% | 召回≥60% | warn 通过 | block 备注 |
|----------|-------------|-------------|---------|----------|-----------|------------|
`
    for (const r of genreResults) {
      const fprCi = `${fmtPct(r.fpr.ciLower)}–${fmtPct(r.fpr.ciUpper)}`
      const recallCi = `${fmtPct(r.recall.ciLower)}–${fmtPct(r.recall.ciUpper)}`
      const fprNote = r.fpr.insufficient ? "⚠️ n<10" : ""
      const recallNote = r.recall.insufficient ? "⚠️ n<10" : ""
      md += `| ${factorLabels[r.factor]} | ${fmtPct(r.fpr.proportion)} [${fprCi}] ${fprNote} | ${fmtPct(r.recall.proportion)} [${recallCi}] ${recallNote} | ${r.fpr.pass ? "✅" : "❌"} | ${r.recall.pass ? "✅" : "❌"} | ${r.warnPass ? "✅" : "❌"} | ${r.blockNote} |\n`
    }
    md += `\n`
  }

  md += `## 综合判定

- **warn 档标定**: ${allPass ? "✅ 全部通过" : "❌ 部分未通过"}
- **block 档标定**: ⏳ pending-real-corpus（标记待重跑，不阻塞后续波次）

${allPass ? "" : "### 未通过项\n\n| 族 | 因子 | 问题 |\n|----|------|------|\n" + results.filter(r => !r.warnPass).map(r => `| ${genreLabels[r.genre]} | ${factorLabels[r.factor]} | FPR ${fmtPct(r.fpr.proportion)} [${fmtPct(r.fpr.ciLower)}–${fmtPct(r.fpr.ciUpper)}], 召回 ${fmtPct(r.recall.proportion)} [${fmtPct(r.recall.ciLower)}–${fmtPct(r.recall.ciUpper)}] |`).join("\n") + "\n\n"}

## 样品级因子值分布（Voice Profile 前移）

### 言情

| 层 | 统计 | nGramOverlap (AI重合度) | sentenceEntropy (归一化熵) | punctuationFingerprint (AI余弦) | paragraphLengthDist (CV) |
|----|------|------------------------|--------------------------|-------------------------------|-------------------------|
| human | 均值 | — | — | — | — |
| human | SD | — | — | — | — |
| AI | 均值 | — | — | — | — |
| AI | SD | — | — | — | — |

### 古风

| 层 | 统计 | nGramOverlap | sentenceEntropy | punctuationFingerprint | paragraphLengthDist |
|----|------|-------------|----------------|----------------------|-------------------|
| human | 均值 | — | — | — | — |
| human | SD | — | — | — | — |
| AI | 均值 | — | — | — | — |
| AI | SD | — | — | — | — |

### 玄幻

| 层 | 统计 | nGramOverlap | sentenceEntropy | punctuationFingerprint | paragraphLengthDist |
|----|------|-------------|----------------|----------------------|-------------------|
| human | 均值 | — | — | — | — |
| human | SD | — | — | — | — |
| AI | 均值 | — | — | — | — |
| AI | SD | — | — | — | — |

> Voice Profile 生成端前移: 四因子统计基线已提取（见 \`src/lib/novel/anti-ai-candidate-pool.ts\`），每族每因子的分布参数（均值、标准差、P5/P25/P50/P75/P95）可由本脚本输出的因子值矩阵派生。

## 阈值表（产品级）

| 阈值 | 值 | 来源 | 状态 |
|------|-----|------|------|
| nGramOverlap warn | AI 3-gram 重合度 > 0.4 且 > 人写参照 × 1.5 | synthetic-degraded 标定 | ✅ 已标定 |
| sentenceEntropy warn | 归一化熵 < 0.7 | synthetic-degraded 标定（短文本校正） | ✅ 已标定 |
| punctuationFingerprint warn | AI 余弦 > 0.85 且 > 人写参照 × 1.2 | synthetic-degraded 标定 | ✅ 已标定 |
| paragraphLengthDist warn | CV < 0.3 (3-5 段: 0.35) | synthetic-degraded 标定（短文本校正） | ✅ 已标定 |
| 综合 warn 触发 | 任意 1 因子 warn | 检测器设计 | ✅ 已标定 |
| block 档 | pending-real-corpus | 待真实语料重跑 | ⏳ |

## 风险声明

1. **样本量不足**: 当前每族仅 10 篇 human + 10 篇 AI，Wilson 95%CI 区间较宽，FPR 和召回的点估计可能不可靠。所有标定结论应视为**参考性**而非**确定性**。
2. **synthetic-degraded 局限**: 自写模拟文本不能完全替代真实人写/AI 生成文本的分布特征。真实采集语料成熟后必须重跑标定。
3. **block 阈值待定**: 真实 ≥100 语料到齐后，执行 \`node scripts/anti-ai-calibrate.js\` 重跑，block 判据为 FPR≤5% 且 召回≥75%。
4. **voice profile 生成端前移**: 四因子统计基线已提取（见 \`src/lib/novel/anti-ai-candidate-pool.ts\`），每族每因子的分布参数（均值、标准差、P5/P25/P50/P75/P95）可由本脚本输出的因子值矩阵派生。

## 版本回溯

| 版本 | 日期 | 变更 | 决策日志 |
|------|------|------|----------|
| v1 | ${dateStr} | 初始 warn 档标定，基于 synthetic-degraded batch-${BATCH_ID} | \`docs/decision-log/${dateStr.replace(/-/g, "")}-t20-anti-ai-calibrate.md\` |
`

  return md
}

// ============================================================================
// 主入口
// ============================================================================

function main() {
  console.log("[anti-ai-calibrate] 开始加载语料...")
  const { samples: humanSamples } = loadCorpusLayer("human")
  const { samples: aiSamples } = loadCorpusLayer("ai")
  console.log(`   human: ${humanSamples.length} 篇, ai: ${aiSamples.length} 篇`)
  if (humanSamples.length === 0 || aiSamples.length === 0) {
    console.error(`[anti-ai-calibrate] 错误: 语料为空, 检查路径: ${CORPUS_ROOT}`)
    process.exit(1)
  }

  console.log("[anti-ai-calibrate] 构建语料索引...")
  const indexes = buildCorpusIndexes(humanSamples, aiSamples)
  console.log(`   AI 3-gram: ${indexes.ai3GramTotal} 个, 人写 3-gram: ${indexes.human3GramTotal} 个`)

  // 加载黄金集 (仅用于验证, 不参与标定)
  let goldSamples = []
  if (existsSync(GOLD_ROOT)) {
    goldSamples = readdirSync(GOLD_ROOT).filter(f => f.endsWith(".json"))
    console.log(`   gold: ${goldSamples.length} 篇标注`)
  }

  // 运行样本级检测 (voice profile 前移)
  console.log("[anti-ai-calibrate] 运行样本级检测 (voice profile 前移)...")
  const allSamples = [...humanSamples, ...aiSamples]
  const sampleProfiles = allSamples.map(s => {
    const det = runDetection(s.text, indexes)
    return {
      file: s.file, genre: s.genre, layer: s.layer, words: s.words,
      ngo: det.nGramOverlap.aiOverlap,
      se: det.sentenceEntropy.normalized,
      seRaw: det.sentenceEntropy.entropy,
      pf: det.punctuationFingerprint.aiCosine,
      pfHuman: det.punctuationFingerprint.humanCosine,
      pl: det.paragraphLengthDist.cv,
      warnCount: det.warnCount,
      warns: det.warns,
    }
  })

  // 输出 voice profile
  console.log()
  console.log("── Voice Profile 表 (每族每因子统计) ──")
  const genreLabels = { yanqing: "言情", gufeng: "古风", xuanhuan: "玄幻", xuanyi: "悬疑" }
  const factorDefs = [
    { key: "ngo", label: "n-gram 重合度" },
    { key: "se", label: "句式熵(归一化)" },
    { key: "pf", label: "标点指纹(AI余弦)" },
    { key: "pl", label: "段落长度(CV)" },
  ]

  for (const genre of ["yanqing", "gufeng", "xuanhuan", "xuanyi"]) {
    for (const layer of ["human", "ai"]) {
      const layerSamples = sampleProfiles.filter(s => s.genre === genre && s.layer === layer)
      if (layerSamples.length === 0) continue
      const layerLabel = layer === "human" ? "人写" : "AI"
      const warnCount = layerSamples.filter(s => s.warnCount > 0).length
      console.log(`  ${genreLabels[genre]} / ${layerLabel} (${layerSamples.length} 篇, ${warnCount} 触发 warn):`)
      for (const fd of factorDefs) {
        const values = layerSamples.map(s => s[fd.key])
        const m = mean(values)
        const sd = stddev(values)
        const sorted = [...values].sort((a, b) => a - b)
        const p5 = sorted[Math.floor(sorted.length * 0.05)]
        const p25 = sorted[Math.floor(sorted.length * 0.25)]
        const p50 = sorted[Math.floor(sorted.length * 0.50)]
        const p75 = sorted[Math.floor(sorted.length * 0.75)]
        const p95 = sorted[Math.floor(sorted.length * 0.95)]
        console.log(`    ${fd.label}: 均值=${m.toFixed(3)} SD=${sd.toFixed(3)} P50=${p50.toFixed(3)} P5=${p5.toFixed(3)}-P95=${p95.toFixed(3)}`)
      }
    }
  }

  // 运行标定
  console.log()
  console.log("[anti-ai-calibrate] 运行标定...")
  const results = runCalibration(humanSamples, aiSamples, indexes)

  // 输出控制台报告
  printConsoleReport(results, humanSamples, aiSamples)

  // 生成 Markdown 报告
  console.log("[anti-ai-calibrate] 生成报告...")
  const allPass = results.every(r => r.warnPass)
  const md = generateMarkdownReport(results, humanSamples, aiSamples, allPass)

  const reportDir = dirname(REPORT_PATH)
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true })
  writeFileSync(REPORT_PATH, md, "utf-8")
  console.log(`  报告已写入: ${REPORT_PATH}`)
  console.log()

  if (allPass) {
    console.log("✅ warn 档标定全部通过 (基于 synthetic-degraded 种子语料)")
    console.log("⚠️  注意: 本标定基于 synthetic-degraded 语料, 不得用于产品发版宣称。")
    console.log("⏳ block 阈值标注 pending-real-corpus, 等待真实语料成熟后重跑。")
    process.exit(0)
  } else {
    console.log("❌ warn 档标定部分未通过")
    console.log("   请检查未通过项, 可能需要调整阈值或检查检测器逻辑。")
    console.log("   注意: 当前每族仅 10 篇样本, Wilson CI 区间较宽, 可能因样本不足导致。")
    process.exit(1)
  }
}

main()