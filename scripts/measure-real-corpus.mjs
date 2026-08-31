#!/usr/bin/env node
/**
 * measure-real-corpus.mjs — 36 号 DD-3 真实语料标定（一次性操作工具，本地手测）
 *
 * 目的:
 *   在真实书稿（默认 E:/写作/_项目/8人/.novel/chapters/{1..6}/draft.md）上
 *   实测生产检测器分布，输出 slop / echo / intensity / cavity 标定报告。
 *
 * 纪律:
 *   - 真实语料不进 git（ADR-19 零 IO 仅约束生产链/CI；本脚本为一次性操作工具，
 *     与 anti-ai-calibrate.js 同类，本地手动执行）。
 *   - spec 侧断言以快照常量锁定（见 de-ai-calibration.spec.ts 36 号段）。
 *
 * 用法:
 *   node scripts/measure-real-corpus.mjs                    # 默认语料路径
 *   REAL_CORPUS_DIR="E:/other/novel/chapters" node scripts/measure-real-corpus.mjs
 *
 * 输出:
 *   控制台分布报告（P5/P50/P95 + FPR/TPR + echo 重叠 + weightedScore 归一）。
 *   退出码 0 = 不变式满足；非 0 = 语料迭代跑飞（FPR>0 或 max slop≥warn）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { registerHooks } from "node:module"

// Node ≥23.6 原生 TS type-stripping；生产源码用 extensionless imports，
// 需 resolve hook 补全 .ts 扩展名
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".")) return nextResolve(specifier, context)
    try {
      return nextResolve(specifier, context)
    } catch {
      const base = fileURLToPath(new URL(specifier, context.parentURL))
      const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      for (const c of candidates) {
        if (existsSync(c)) return nextResolve(`file://${c.replace(/\\/g, "/")}`, context)
      }
      throw new Error(`cannot resolve ${specifier} from ${context.parentURL}`)
    }
  },
})

const { slopScore, classifySlop, overCorrectionReport } = await import("../src/lib/novel/mechanical-slop-detector.ts")
const { chapterStructuralSignature, signaturesSimilar, NGRAM_OVERLAP_MIN } = await import("../src/lib/novel/narrative-echo-detector.ts")
const { runDeAiDualPass } = await import("../src/lib/novel/de-ai-dual-pass.ts")

const CORPUS_DIR = process.env.REAL_CORPUS_DIR ?? "E:/写作/_项目/8人/.novel/chapters"

function stripTitle(text) {
  return text.replace(/^#\s+第?[一二三四五六七八九十\d]+章.*$/m, "").trim()
}

function pct(values, p) {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length))
  return s[i]
}

if (!existsSync(CORPUS_DIR)) {
  console.error(`[real-corpus] 语料目录不存在: ${CORPUS_DIR}`)
  process.exit(2)
}

const chapters = []
for (const d of readdirSync(CORPUS_DIR).sort()) {
  const m = d.match(/^\d+$/)
  if (!m) continue
  const p = resolve(CORPUS_DIR, d, "draft.md")
  if (!existsSync(p)) continue
  chapters.push({ n: parseInt(d, 10), text: stripTitle(readFileSync(p, "utf-8")) })
}
if (chapters.length === 0) {
  console.error(`[real-corpus] 未找到编号章节（预期 {n}/draft.md）: ${CORPUS_DIR}`)
  process.exit(2)
}

console.log(`[real-corpus] 语料: ${CORPUS_DIR} — ${chapters.length} 章\n`)

// ---- A: slop ----
const slopPenalties = chapters.map((c) => slopScore(c.text).slopPenalty)
const verdicts = chapters.map((c) => classifySlop(slopScore(c.text)))
console.log("== slop ==")
console.log(`  slopPenalty: P5=${pct(slopPenalties, 5)} P50=${pct(slopPenalties, 50)} P95=${pct(slopPenalties, 95)} max=${Math.max(...slopPenalties)}`)
console.log(`  verdict: ${verdicts.filter((v) => v === "clean").length}/${chapters.length} clean`)
console.log(`  FPR_warn=${verdicts.filter((v) => v !== "clean").length} FPR_block=${verdicts.filter((v) => v === "block").length}`)

// ---- B: echo 跨章（所有两两对）----
const sigs = chapters.map((c) => chapterStructuralSignature(c.text))
let echoFP = 0
const overlaps = []
for (let i = 0; i < sigs.length; i++) {
  for (let j = i + 1; j < sigs.length; j++) {
    const a = sigs[i].ngramHashes
    const b = sigs[j].ngramHashes
    const ov = a.length === 0 || b.length === 0 ? 0 : a.filter((h) => new Set(b).has(h)).length / Math.min(a.length, b.length)
    overlaps.push(ov)
    if (signaturesSimilar(sigs[i], sigs[j])) echoFP++
  }
}
console.log("== echo 跨章 ==")
console.log(`  ngramOverlap: 对=${overlaps.length} max=${Math.max(...overlaps).toFixed(4)} P95=${pct(overlaps, 95).toFixed(4)} (NGRAM_OVERLAP_MIN=${NGRAM_OVERLAP_MIN})`)
console.log(`  signaturesSimilar FP=${echoFP}（真实跨章回纹应为 0）`)

// ---- C: F-009 weightedScore（原始 + 每千字归一）----
console.log("== F-009 weightedScore (原始 + 每千字归一) ==")
const weighted = chapters.map((c) => {
  const ws = runDeAiDualPass(c.text).pass1.weightedScore
  const chars = c.text.replace(/\s+/g, "").length
  return { ws, perK: (ws / Math.max(500, chars)) * 1000 }
})
console.log(`  weightedScore: P50=${pct(weighted.map((w) => w.ws), 50)} P95=${pct(weighted.map((w) => w.ws), 95)} max=${Math.max(...weighted.map((w) => w.ws))}`)
console.log(`  per-k: P50=${pct(weighted.map((w) => w.perK), 50).toFixed(2)} P95=${pct(weighted.map((w) => w.perK), 95).toFixed(2)} max=${Math.max(...weighted.map((w) => w.perK)).toFixed(2)}`)

// ---- D: cavity ----
const cvs = chapters.map((c) => overCorrectionReport(c.text).sentenceLengthCV)
console.log("== cavity ==")
console.log(`  sentenceLengthCV: min=${Math.min(...cvs).toFixed(3)} max=${Math.max(...cvs).toFixed(3)} P95=${pct(cvs, 95).toFixed(3)} (CAVITY_CV_HIGH=0.85)`)

// ---- 不变式 ----
const fail = []
if (verdicts.some((v) => v !== "clean")) fail.push("FPR_warn>0")
if (echoFP > 0) fail.push("echo FP>0")
if (pct(slopPenalties, 95) >= 5) fail.push("slop P95>=warn")
if (fail.length) {
  console.log(`\n[FAIL] ${fail.join(" / ")}`)
  process.exit(1)
}
console.log("\n[OK] 不变式满足：真实语料零误杀")
