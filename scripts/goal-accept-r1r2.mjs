// goal-accept-r1r2.mjs — R1 (tasks/commits/clean tree) + R2 (4 reference reports).
// Run from workspace root: node QMAI/scripts/goal-accept-r1r2.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — execSync 抛错即非零退出，禁止 default-to-pass。
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

function fail(msg) { console.error("FAIL: " + msg); process.exit(1) }
function ok(msg) { console.log("PASS: " + msg) }

try {

// R1: key commits present + clean tree + evidence doc on file.
// Window -50 (was -30, was -12): history grew by 15 commits (#112 十五批:
// 1053f597/c4a3307f/2b662828/823fdfb6/b20f4950/1707d3b9/33e0297c/6f6afd64/
// 2d6c5b06/4faddf29/b5728820/e982041f/9c1dfd95/0701e9e8/601a4244),
// old chain would slide out of a -30 window (a741863a 现为 HEAD 起第 31 个).
// Wider window keeps the same assertion (chain present), no relaxation.
// New commits are additionally required below (strictly stronger R1).
const log = execSync("git -C QMAI log --oneline -50", { encoding: "utf8" })
for (const c of ["a741863a", "86862911", "4b43eee7", "f5ca5638", "cde30365", "d3747834", "ea0c310e"]) {
  if (!log.includes(c)) fail("missing commit " + c)
}
ok("R1 commits present (8-gap chain + evidence)")
for (const c of ["3fb5667c", "69a8aa58", "d076892e", "3059fa9f", "1f95ceb4"]) {
  if (!log.includes(c)) fail("missing commit " + c)
}
ok("R1 new chain present (#103 gap-list + 3x #104 fixes + #105 review)")
const status = execSync("git -C QMAI status --short", { encoding: "utf8" }).trim()
if (status !== "") fail("dirty tree:\n" + status)
ok("R1 tree clean")
for (const f of [
  "QMAI/docs/decision-log/20260924-103-compact-evidence.md",
  "QMAI/docs/decision-log/20260924-102-final-verdict.md",
  "QMAI/docs/decision-log/20260924-103-gap-list.md",
  "QMAI/docs/decision-log/20260924-105-final-review.md",
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
} catch (e) {
  // ENV-FAULT 哨兵：任何环境/通道异常（EPIPE、命令缺失、IO 失败）显式标记并以非零退出。
  console.error("ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
