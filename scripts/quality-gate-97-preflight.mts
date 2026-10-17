// #97: 复现 runContinuityMechanicalPreflight，看 critical 构成
// 运行：npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-preflight.mts
import { readFileSync } from "node:fs"
import { runContinuityMechanicalPreflight } from "../src/lib/novel/review-adapter.ts"

const projectPath = "C:/QM-BOOK/身体都是租的，你让我修仙？/QM/chapters"
const projRoot = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const chapterNumber = Number(process.argv[2] ?? 162)
// chapterText: QM final body (strip frontmatter)
const raw = readFileSync(`${projectPath}/chapter-${String(chapterNumber).padStart(3, "0")}.md`, "utf-8")
const body = raw.replace(/^---\n.*?\n---\n/s, "")

const results = await runContinuityMechanicalPreflight(projRoot, chapterNumber, { chapterText: body })
const sev = { error: 0, warning: 0, info: 0 } as Record<string, number>
const type = {} as Record<string, number>
for (const r of results) {
  sev[r.severity] = (sev[r.severity] ?? 0) + 1
  const k = `${r.type}`
  type[k] = (type[k] ?? 0) + 1
}
console.log(JSON.stringify({ n: results.length, sev, type }, null, 2))
// dump all messages for offline subtype/prefix analysis (no body text)
const { writeFileSync } = await import("node:fs")
writeFileSync(
  `../.workflow/harvest-staging/quality-gate-97-preflight-ch${chapterNumber}.json`,
  JSON.stringify(results.map((r) => ({ severity: r.severity, type: r.type, message: (r as any).message ?? "", evidence: (r as any).evidence ?? "" })), null, 2),
)
// print first 5 error findings (message+evidence only, no body)
for (const r of results.filter((x) => x.severity === "error").slice(0, 5)) {
  console.log("---ERROR---", JSON.stringify({ type: r.type, message: (r as any).message?.slice(0, 200), evidence: (r as any).evidence }, null, 2)?.slice(0, 800))
}
for (const r of results.filter((x) => x.severity === "warning").slice(0, 3)) {
  console.log("---WARN---", JSON.stringify({ type: r.type, message: (r as any).message?.slice(0, 200) }, null, 2)?.slice(0, 500))
}
