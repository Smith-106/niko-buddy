// goal-accept-r1r2.mjs — R1 (tasks/commits/clean tree) + R2 (4 reference reports).
// Run from workspace root: node QMAI/scripts/goal-accept-r1r2.mjs
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

function fail(msg) { console.error("FAIL: " + msg); process.exit(1) }
function ok(msg) { console.log("PASS: " + msg) }

// R1: key commits present + clean tree + evidence doc on file.
const log = execSync("git -C QMAI log --oneline -12", { encoding: "utf8" })
for (const c of ["a741863a", "86862911", "4b43eee7", "f5ca5638", "cde30365", "d3747834", "ea0c310e"]) {
  if (!log.includes(c)) fail("missing commit " + c)
}
ok("R1 commits present (8-gap chain + evidence)")
const status = execSync("git -C QMAI status --short", { encoding: "utf8" }).trim()
if (status !== "") fail("dirty tree:\n" + status)
ok("R1 tree clean")
for (const f of [
  "QMAI/docs/decision-log/20260924-103-compact-evidence.md",
  "QMAI/docs/decision-log/20260924-102-final-verdict.md",
]) {
  if (!existsSync(f)) fail("missing " + f)
}
ok("R1 evidence docs on file")

// R2: all 4 reference reports exist with expected baseline markers.
const R2 = [
  ["C:/Users/niko/Desktop/工作目录/拆解/ainovel-cli强在哪-分析报告.md", ["强项总览", "七维评审"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/AI-Novel-Writing-Assistant深度分析报告.md", ["三层导演", "LangGraph"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/niko-buddy深度分析报告.md", ["905", "control-kernel"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/AI写作工具-写作质量对比总报告.md", ["纯写作质量上限", "★★★★★"]],
]
for (const [p, markers] of R2) {
  if (!existsSync(p)) fail("missing report " + p)
  const t = readFileSync(p, "utf8")
  for (const m of markers) if (!t.includes(m)) fail(p + " lacks marker " + m)
}
ok("R2 all 4 reference reports present with baseline markers")
console.log("ALL R1R2 PASS")
