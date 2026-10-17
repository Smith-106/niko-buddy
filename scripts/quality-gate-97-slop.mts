// #97 机械轨证据：162 finals 去AI味(slop)分布 + 结构硬门重验
// 零 LLM，纯正则+算术。运行：npx tsx scripts/quality-gate-97-slop.mts
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { slopScore, classifySlop } from "../src/lib/novel/mechanical-slop-detector.ts"

const BASE = "C:/QM-BOOK/身体都是租的，你让我修仙？/QM/chapters"
const stripFm = (t: string) => t.replace(/^---\n.*?\n---\n/s, "")
const nonws = (s: string) => s.replace(/\s+/g, "").length

const rows: Array<{
  ch: number; chars: number; penalty: number; verdict: string
  t1: number; t2: number; t3: number
}> = []
let missing: number[] = []
for (let i = 1; i <= 162; i++) {
  const p = `${BASE}/chapter-${String(i).padStart(3, "0")}.md`
  if (!existsSync(p)) { missing.push(i); continue }
  const body = stripFm(readFileSync(p, "utf-8"))
  const r = slopScore(body)
  rows.push({
    ch: i, chars: nonws(body),
    penalty: Math.round(r.slopPenalty * 100) / 100,
    verdict: classifySlop(r),
    t1: r.tier1Hits.reduce((s: number, h: any) => s + h.count, 0),
    t2: r.tier2Hits.reduce((s: number, h: any) => s + h.count, 0),
    t3: r.tier3Hits.reduce((s: number, h: any) => s + h.count, 0),
  })
}
const pens = rows.map((r) => r.penalty).sort((a, b) => a - b)
const median = pens.length ? pens[Math.floor(pens.length / 2)] : -1
const mean = pens.length ? pens.reduce((a, b) => a + b, 0) / pens.length : -1
const cnt = (v: string) => rows.filter((r) => r.verdict === v).length
const out = {
  tool: "slopScore+classifySlop(src/lib/novel/mechanical-slop-detector.ts)",
  thresholds: "block>=8, warn>=5, clean<5",
  n: rows.length, missing,
  verdicts: { block: cnt("block"), warn: cnt("warn"), clean: cnt("clean") },
  penaltyMedian: median, penaltyMean: Math.round(mean * 100) / 100,
  penaltyMax: pens.length ? pens[pens.length - 1] : -1,
  worst: [...rows].sort((a, b) => b.penalty - a.penalty).slice(0, 10),
  charsMin: Math.min(...rows.map((r) => r.chars)),
  charsTotal: rows.reduce((s, r) => s + r.chars, 0),
}
writeFileSync(
  "../.workflow/harvest-staging/quality-gate-97-slop.json",
  JSON.stringify(out, null, 2),
)
console.log(JSON.stringify({
  n: out.n, missing, verdicts: out.verdicts,
  median, mean: out.mean, max: out.penaltyMax,
  charsMin: out.charsMin, charsTotal: out.charsTotal,
}))
