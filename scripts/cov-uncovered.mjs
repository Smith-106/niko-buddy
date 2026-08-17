// Usage:
//   node scripts/cov-uncovered.mjs <coverage-final.json> <target-substr> [--branches]
//   node scripts/cov-uncovered.mjs --src <coverage-final.json> <target-substr> [--branches]
import { readFileSync } from "node:fs"

let srcMode = false
let args = process.argv.slice(2)
if (args[0] === "--src") {
  srcMode = true
  args = args.slice(1)
}
const [jsonPath, target, mode] = args
const report = JSON.parse(readFileSync(jsonPath, "utf8"))
const entry = Object.entries(report).find(([k]) => k.includes(target))
if (!entry) {
  console.error(`target ${target} not found in report`)
  process.exit(1)
}
const [file, data] = entry
const src = srcMode ? readFileSync(file, "utf8").split(/\r?\n/) : []

const stmts = Object.entries(data.s)
const funcs = Object.entries(data.f)
const branches = Object.entries(data.b)
const uncoveredLines = new Set()
for (const [idx, count] of stmts) {
  if (Number(count) > 0) continue
  const loc = data.statementMap[idx]
  if (!loc) continue
  uncoveredLines.add(loc.start.line)
  if (srcMode) {
    console.log(`STMT ${idx} @${loc.start.line}: ${(src[loc.start.line - 1] ?? "").trim().slice(0, 110)}`)
  }
}
if (srcMode) {
  for (const [idx, count] of funcs) {
    if (Number(count) > 0) continue
    const loc = data.fnMap[idx]?.loc ?? data.fnMap[idx]
    const line = loc?.start?.line ?? 0
    console.log(`FUNC ${idx} @${line}: ${(src[line - 1] ?? "").trim().slice(0, 110)}`)
  }
}
const sortedLines = [...uncoveredLines].sort((a, b) => a - b)
let branchTotal = 0
let branchCovered = 0
const branchDetail = []
for (const [idx, counts] of branches) {
  const arr = Array.isArray(counts) ? counts : []
  branchTotal += arr.length
  branchCovered += arr.filter((c) => Number(c) > 0).length
  const bad = arr.map((c, i) => (Number(c) <= 0 ? i : -1)).filter((i) => i >= 0)
  if (bad.length > 0) {
    const loc = data.branchMap[idx]
    const line = loc?.locations?.[0]?.start?.line ?? loc?.loc?.start?.line ?? "?"
    if (srcMode) {
      console.log(`BRANCH idx ${idx} (line ~${line}): [${bad}] uncovered | ${(src[Number(line) - 1] ?? "").trim().slice(0, 110)}`)
    } else {
      branchDetail.push({ line, idx: Number(idx), bad: bad.join(",") })
    }
  }
}
if (!srcMode) {
  console.log(`file: ${file}`)
  console.log(`s ${stmts.length} / b ${branchTotal} / f ${funcs.length} / l ${sortedLines.length}  (branch covered ${branchCovered}/${branchTotal})`)
  console.log(`uncovered lines: ${sortedLines.join(",")}`)
  if (mode === "--branches") {
    for (const d of branchDetail) console.log(`  branch idx ${d.idx} (line ~${d.line}): branches [${d.bad}] uncovered`)
  }
}
