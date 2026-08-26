#!/usr/bin/env node
/**
 * gold-review-scan.mjs — 黄金集预审扫描（T01b-3 共识：自动预审 → 人工抽检网格）
 * 扫描 gold 目录全部标注 JSON：
 *   - 字段完整性（缺 gold_id/type/evidence 等）
 *   - 重复 evidence（模板断裂/复制嫌疑）
 *   - 强度分布（strength 全 3/全 5 = 模板嫌疑）
 *   - hook_type 分布（章末）
 * 输出风险分级：low / watch / high + 抽检建议（14 弧全查 + 每 genre 抽 20%）
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const GOLD = resolve("docs/p0/corpus/gold")
const OUT = resolve("docs/p0/corpus/gold-review-report.json")

const all = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = d + "/" + f
    if (statSync(p).isDirectory()) walk(p)
    else if (f.endsWith(".json")) {
      try { all.push({ file: p, data: JSON.parse(readFileSync(p, "utf8")) }) } catch { all.push({ file: p, data: null, corrupt: true }) }
    }
  }
}
walk(GOLD)

const issues = []
let corrupt = 0
const evidenceCount = new Map()
for (const { file, data, corrupt: c } of all) {
  if (c) { corrupt++; continue }
  const issuesThis = []
  for (const k of ["gold_id", "type", "layer", "genre", "batch_id"]) if (!data[k]) issuesThis.push(`缺字段:${k}`)
  if (data.type === "chapter_end" && !data.hook_type) issuesThis.push("缺 hook_type")
  if (data.type === "chapter_end" && !(data.strength >= 1 && data.strength <= 5)) issuesThis.push("strength 越界")
  if (data.type === "arc") {
    const feats = data.anti_ai_features || []
    if (feats.length < 6) issuesThis.push(`特征数 ${feats.length}<6`)
    if (typeof data.overall_anti_ai_score !== "number") issuesThis.push("缺 overall 分")
    for (const f of feats) if (!f.evidence || f.evidence.length < 8) issuesThis.push("evidence 过短")
  } else {
    if (!data.evidence || data.evidence.length < 10) issuesThis.push("evidence 过短")
  }
  // 重复 evidence 检测
  if (data.evidence) {
    const key = String(data.evidence).slice(0, 40)
    evidenceCount.set(key, (evidenceCount.get(key) || 0) + 1)
  }
  if (issuesThis.length) issues.push({ file, genre: data.genre, type: data.type, issues: issuesThis })
}

const dupEvidence = [...evidenceCount.entries()].filter(([, n]) => n > 2).map(([k, n]) => ({ prefix: k, count: n }))

const byGenre = {}
for (const g of all.filter(g => g.data?.type === "chapter_end")) {
  byGenre[g.data.genre] = (byGenre[g.data.genre] || 0) + 1
}
const strengthDist = {}
for (const g of all.filter(g => g.data?.type === "chapter_end")) {
  const s = g.data.strength
  strengthDist[s] = (strengthDist[s] || 0) + 1
}
const hookDist = {}
for (const g of all.filter(g => g.data?.type === "chapter_end")) {
  const h = g.data.hook_type
  hookDist[h] = (hookDist[h] || 0) + 1
}

const arcs = all.filter(g => g.data?.type === "arc")
const ends = all.filter(g => g.data?.type === "chapter_end")
const pending = all.filter(g => g.data?.pending === true)
const report = {
  schema: "gold-review-scan/1.0",
  date: "2026-08-26",
  totals: { files: all.length, corrupt, arcs: arcs.length, chapter_ends: ends.length, pending: pending.length },
  byGenre,
  strengthDist,
  hookDist,
  issues: issues.slice(0, 50),
  issuesTotal: issues.length,
  duplicateEvidence: dupEvidence.slice(0, 10),
  riskLevel: issues.length === 0 && dupEvidence.length === 0 ? "low" : issues.length < 10 ? "watch" : "high",
  sampling: {
    arcsAll: arcs.map(a => a.data.gold_id),
    chapterEndSample: Object.entries(byGenre).flatMap(([g, n]) =>
      all.filter(x => x.data?.type === "chapter_end" && x.data.genre === g).slice(0, Math.max(2, Math.ceil(n * 0.2))).map(x => x.data.gold_id)
    ),
  },
}
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8")
console.log(`[gold-scan] 共 ${all.length} 条（arc ${arcs.length} / 章末 ${ends.length}）| pending ${pending.length}`)
console.log(`[gold-scan] 瑕疵 ${issues.length} | 重复 evidence 组 ${dupEvidence.length} | 风险级 ${report.risk}`)
console.log(`[gold-scan] 报告 → ${OUT}`)
