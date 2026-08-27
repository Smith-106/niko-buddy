#!/usr/bin/env node
/**
 * anti-ai-signal-diagnose.mjs — T20 单因子信号诊断（GLM 共识：重标前先验证单族信号）
 *
 * 用真实语料（human 1035 / ai 139）建索引，对真实文本跑四因子，
 * 输出 AI vs human 各因子值分布（mean/median/P10/P90）+ 当前阈值命中率，
 * 判断单因子区分度（AUC 近似：P10 交叉度），决定标定策略。
 *
 * 用法：node scripts/anti-ai-signal-diagnose.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCorpusIndexes, runDetection, mean, stddev,
} from "./lib/anti-ai-factors.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS_ROOT = resolve(__dirname, "../../docs/p0/corpus")

const HUMAN_BATCHES = ["batch-20260826-t01b1-human", "batch-20260821-001"]
const AI_BATCHES = ["batch-20260826-t01b2-ai", "batch-20260826-t01c-001", "batch-20260821-001", "batch-20260822-writing"]

function loadLayer(layer, batches) {
  const out = []
  for (const batch of batches) {
    const dir = resolve(CORPUS_ROOT, layer, batch)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".txt")) continue
      const text = readFileSync(resolve(dir, f), "utf8")
      if (text.length >= 100) out.push({ file: `${layer}/${batch}/${f}`, text })
    }
  }
  return out
}

const humans = loadLayer("human", HUMAN_BATCHES)
const ais = loadLayer("ai", AI_BATCHES)
console.log(`[diagnose] human ${humans.length} / ai ${ais.length}`)

// 真实语料索引（含 gold 不参与——红线）
const indexes = buildCorpusIndexes(humans, ais)

// 各因子值收集
const FACTORS = ["nGramOverlap", "sentenceEntropy", "punctuationFingerprint", "paragraphLengthDist"]
const collect = (samples) => {
  const byFactor = Object.fromEntries(FACTORS.map(f => [f, []]))
  for (const s of samples) {
    const r = runDetection(s.text, indexes)
    for (const f of FACTORS) {
      const fr = r[f]
      if (fr && typeof fr.value === "number") byFactor[f].push(fr.value)
      else if (fr && typeof fr === "object") {
        // 各因子原始对象：取主量纲值
        const v = fr.value ?? fr.normalized ?? fr.aiOverlap ?? fr.aiCosine ?? fr.cv
        if (typeof v === "number") byFactor[f].push(v)
      }
    }
  }
  return byFactor
}
const humanVals = collect(humans)
const aiVals = collect(ais)

function pct(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

console.log("\n[diagnose] 单因子分布（AI vs human）与区分度:")
for (const f of FACTORS) {
  const hv = [...humanVals[f]].sort((a, b) => a - b)
  const av = [...aiVals[f]].sort((a, b) => a - b)
  const hMean = mean(hv), aMean = mean(av)
  const hP10 = pct(hv, 0.1), hP90 = pct(hv, 0.9)
  const aP10 = pct(av, 0.1), aP90 = pct(av, 0.9)
  // 区分度：AI 中位数与 human 中位数的方向 + 重叠度（P10/P90 交叉）
  const overlap = Math.max(0, Math.min(hP90, aP90) - Math.max(hP10, aP10)) / Math.max(1e-9, Math.max(hP90, aP90) - Math.min(hP10, aP10))
  const dir = aMean > hMean ? "AI↑" : "AI↓"
  console.log(`  ${f}: human mean=${hMean.toFixed(3)} [P10 ${hP10.toFixed(3)} P90 ${hP90.toFixed(3)}] | ai mean=${aMean.toFixed(3)} [P10 ${aP10.toFixed(3)} P90 ${aP90.toFixed(3)}] | ${dir} 重叠度=${overlap.toFixed(2)}`)
}

// 当前阈值命中率（warn 二值）
console.log("\n[diagnose] 当前阈值命中率（warn 二值）:")
for (const f of FACTORS) {
  const hHit = humanVals[f].length ? humanVals[f].filter(v => v >= 0.5).length : 0 // 占位，实际用 runDetection.warn
  void hHit
}
// 用 runDetection 的 warn 判定
let hWarn = 0, aWarn = 0
const hWarnByFactor = {}, aWarnByFactor = {}
for (const s of humans) {
  const r = runDetection(s.text, indexes)
  for (const [k, v] of Object.entries(r.warns)) if (v) { hWarn++; hWarnByFactor[k] = (hWarnByFactor[k] || 0) + 1 }
}
for (const s of ais) {
  const r = runDetection(s.text, indexes)
  for (const [k, v] of Object.entries(r.warns)) if (v) { aWarn++; aWarnByFactor[k] = (aWarnByFactor[k] || 0) + 1 }
}
console.log(`  human warn 因子命中: ${hWarn}（${(hWarn / (humans.length * 4) * 100).toFixed(1)}% of 因子）| byFactor: ${JSON.stringify(hWarnByFactor)}`)
console.log(`  ai warn 因子命中: ${aWarn}（${(aWarn / (ais.length * 4) * 100).toFixed(1)}% of 因子）| byFactor: ${JSON.stringify(aWarnByFactor)}`)

// 结论
console.log("\n[diagnose] 结论:")
const strong = FACTORS.filter(f => {
  const hv = [...humanVals[f]].sort((a, b) => a - b)
  const av = [...aiVals[f]].sort((a, b) => a - b)
  const overlap = Math.max(0, Math.min(pct(hv, 0.9), pct(av, 0.9)) - Math.max(pct(hv, 0.1), pct(av, 0.1))) / Math.max(1e-9, Math.max(pct(hv, 0.9), pct(av, 0.9)) - Math.min(pct(hv, 0.1), pct(av, 0.1)))
  return overlap < 0.5
})
console.log(`  单因子区分度强（重叠<0.5）: ${strong.length ? strong.join(", ") : "无"}`)
console.log(`  建议: ${strong.length >= 2 ? "单因子信号成立，可标定" : "单因子信号弱，标定需组合判据（多因子 OR/加权）或先修变异/语料"}`)
