// goal-accept-r1r2.mjs — R1 (tasks/commits/clean tree) + R2 (4 reference reports).
// Run from workspace root: node QMAI/scripts/goal-accept-r1r2.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — 禁止 default-to-pass。
// RV-143 退出码优先级（全序，可测）：ENV-FAULT(2) 支配 FAIL(1)。同一轮内既有断言失败
// 又有环境故障 → exit 2，FAIL 明细保留为 informational（headline 为 ENV-FAULT）。
// RV-153 全量映射：0=pass；1=断言失败；2=环境故障；≥3/126/127/信号退出非本脚本产物 —
// 外层 runner 必须把未知非零映射为 ENV-FAULT（fail-safe），永不得映射为 PASS。
// RV-147 正向执行断言：ok() 计数 + EXPECTED_CHECKS 全等 + CHECKS 行（run/skipped/expected），
// 跳过机制不存在（skipped 恒 0）；杜绝“0 断言 = PASS”静默跳过。
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const EXPECTED_CHECKS = 6 // R1×5（含 RV-146 祖先断言）+ R2×1（RV-147：增删检查时同步更新）
let failures = []
let envFault = null
let checksRun = 0
function fail(msg) { failures.push(msg); console.error("FAIL: " + msg) }
function ok(msg) { checksRun++; console.log("PASS: " + msg) }
// RV-153：逃逸出 try 的异常（Node 默认 exit 1）会被误分类为 FAIL — 显式映射为 ENV-FAULT。
process.on("uncaughtException", (e) => {
  console.error("ENV-FAULT: uncaught: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})

try {

// R1: key commits present + clean tree + evidence doc on file.
// Window -50 (was -30, was -12). RV-145/RV-146/RV-154 边界约定（已实测钉死）：
// {HEAD-inclusive: `git log -N` 精确返回 HEAD 起 N 个提交；远端闭合；自 HEAD 向过去计数；
//  非前瞻性：a741863a 在 dd211789 落地时已为 HEAD 起第 32 个（`git log --format=%H dd211789 -30`
//  实测不含它），在 601a4244 时第 31 个 — 均在 -30 外，故扩容为必要性。RV-145 关闭}。
// 覆盖判据为严格全称（∀ commit ∈ W：present），无率型/比例型判据（RV-154 触发条件不成立）。
// 位置量之外另有下方 merge-base 祖先断言做内容寻址交叉验证（RV-146）。
// RV-149 闭式代价：R1 不逐个重放窗口内提交，仅 `git log -W` 取名 + 存在性断言 —
// T(W)≈const（W 只改变 log 输出行数），回溯/重跑代价不随 W 增长。
const log = execSync("git -C QMAI log --oneline -50", { encoding: "utf8" })
for (const c of ["a741863a", "86862911", "4b43eee7", "f5ca5638", "cde30365", "d3747834", "ea0c310e"]) {
  if (!log.includes(c)) fail("missing commit " + c)
}
ok("R1 commits present (8-gap chain + evidence)")
// RV-146 内容寻址：位置量（-50 窗口）之外，另用 merge-base 做祖先断言 —
// 历史重写（rebase/squash/force-push）改变位置不改变祖先关系时仍可检出。
let ancestryOk = true
try {
  execSync("git -C QMAI merge-base --is-ancestor a741863a HEAD", { encoding: "utf8" })
} catch {
  ancestryOk = false
  fail("a741863a not ancestor of HEAD (history rewritten?)")
}
if (ancestryOk) ok("R1 baseline ancestry intact (content-addressed, RV-146)")
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
if (failures.length === 0) {
  if (checksRun !== EXPECTED_CHECKS) fail(`checks run ${checksRun} != expected ${EXPECTED_CHECKS}`)
}
if (failures.length === 0) console.log("ALL R1R2 PASS")
console.log(`CHECKS run=${checksRun} skipped=0 expected=${EXPECTED_CHECKS}`)
} catch (e) {
  // ENV-FAULT 哨兵：任何环境/通道异常（EPIPE、命令缺失、IO 失败）显式标记；headline 见下方优先级裁决。
  envFault = e
  console.error("ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
}
// RV-143/RV-144：ENV-FAULT 支配 FAIL；故障前的 PASS 行在事后被证明损坏的环境中观测，降级为非验收。
if (envFault) {
  if (failures.length > 0) console.error(`INFO: ${failures.length} FAIL(s) before env fault (informational; headline is ENV-FAULT)`)
  console.error("INFO: any prior PASS lines above are non-acceptance (observed under later-proven-bad environment)")
  process.exit(2)
}
if (failures.length > 0) process.exit(1)
