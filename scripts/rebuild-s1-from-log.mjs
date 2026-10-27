// 从可信 run log 重建 S1 JSON 章节 checkpoint（幽灵污染后的修复工具）。
// 用法: node scripts/rebuild-s1-from-log.mjs <logPath> <jsonPath>
// 只重建在 log 中满 60/60 distinct 样本的章节；其余不动。
import { readFileSync, writeFileSync } from "node:fs"
const [logPath, jsonPath] = process.argv.slice(2)
if (!logPath || !jsonPath) { console.error("usage: rebuild-s1-from-log.mjs <log> <json>"); process.exit(2) }
const raw = readFileSync(logPath, "utf8").replace(/\0/g, "")
const re = /\[ch(\d+)\/([a-z]+)\/s(\d+)\] score=([0-9.]+)/g
const samples = new Map() // key ch/dim/s -> score
let m
while ((m = re.exec(raw)) !== null) {
  samples.set(`${m[1]}/${m[2]}/${m[3]}`, Number(m[4]))
}
function median(v) { const s = [...v].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid] }
const byChapter = new Map()
for (const [k, v] of samples) {
  const [ch, dim] = k.split("/").length === 3 ? [k.split("/")[0], k.split("/")[1]] : [null, null]
  if (!byChapter.has(ch)) byChapter.set(ch, new Map())
  const dm = byChapter.get(ch)
  if (!dm.has(dim)) dm.set(dim, [])
  dm.get(dim).push(v)
}
const j = JSON.parse(readFileSync(jsonPath, "utf8"))
j.results = j.results || {}
for (const [ch, dm] of byChapter) {
  const dims = {}
  let complete = true
  for (const [dim, scores] of dm) {
    if (scores.length !== 10) { complete = false; break }
    const med = median(scores)
    dims[dim] = { scores, median: med, measurementFingerprint: "rebuilt-from-log", errors: [] }
  }
  if (!complete || Object.keys(dims).length !== 6) { console.log(`ch${ch}: incomplete, skipped`); continue }
  const medVals = Object.values(dims).map((d) => d.median)
  const overall = median(medVals)
  j.results[`ch${ch}`] = { dimensions: dims, dimensionMedians: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v.median])), overall, pass: overall >= 9.0 }
  console.log(`ch${ch}: rebuilt overall=${overall} pass=${overall >= 9.0}`)
}
j.model = "muse-spark-1.3-contributor"
writeFileSync(jsonPath, JSON.stringify(j, null, 2) + "\n")
console.log("saved:", jsonPath)
