// goal-accept-r1r2.mjs — R1 (tasks/commits/clean tree) + R2 (4 reference reports).
// Run from workspace root: node QMAI/scripts/goal-accept-r1r2.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — 禁止 default-to-pass。
// RV-143 退出码优先级（全序，可测）：ENV-FAULT(2) 支配 FAIL(1)。同一轮内既有断言失败
// 又有环境故障 → exit 2，FAIL 明细保留为 informational（headline 为 ENV-FAULT）。
// RV-31-10 firstLine 独立定义（实现是定义的实例，非定义本身）：`${ErrorName}: ${message 首个非空行}`。
// RV-153 全量映射：0=pass；1=断言失败；2=环境故障；≥3/126/127/信号退出非本脚本产物 —
// 外层 runner 必须把未知非零映射为 ENV-FAULT（fail-safe），永不得映射为 PASS。
// RV-147 正向执行断言：ok() 计数 + EXPECTED_CHECKS 全等 + CHECKS 行（run/skipped/expected），
// 跳过机制不存在（skipped 恒 0）；杜绝“0 断言 = PASS”静默跳过。
import { execSync, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

let failures = []
let envFault = null
let checksRun = 0
// RV-25-01：比较点冻结 — 同源断言执行前 finalized=true，此后任何 ok() 写入即
// write-after-finalize（大声开火，不静默）。fail() 不设防：fail 只写 fail 态，
// 迟到 fail 只会让终态更 fail（fail-closed 方向），永不掩盖。
let finalized = false
// RV-151/RV-157 三值账本：每项 (check_id → state∈{pass,fail}) 机读记录；FAIL 为一等结局，
// 不再是 informational 文本。降级须带类型标记（见下方 ENV-FAULT 终态改写）。
const states = new Map() // check_id → "pass" | "fail"
const EXPECTED_CHECK_IDS = ["r1-8gap", "r1-ancestry", "r1-newchain", "r1-cleantree", "r1-evdocs", "r2-reports"]
const EXPECTED_CHECKS = EXPECTED_CHECK_IDS.length // R1×5（含 RV-146 祖先断言）+ R2×1（RV-40B-07 单源派生：增删检查时只改 id 清单）
function fail(id, msg) { failures.push(`${id}: ${msg}`); states.set(id, "fail"); console.error(`FAIL [${id}]: ` + msg) }
// RV-205/RV-157：first-fail-wins — 已 fail 的 id 后续 ok() 不得再打印 PASS 行（文本与机读一致），
// 记 INFO 降级行，避免文本消费者误读。
function ok(id, msg) { if (finalized) { failures.push(`${id}: write-after-finalize`); console.error(`FAIL [${id}]: write after ledger freeze (RV-25-01)`); return }; if (states.get(id) === "fail") { console.log(`INFO [${id}]: ${msg} (superseded by FAIL; non-acceptance)`); return }; states.set(id, "pass"); checksRun++; console.log("PASS: " + msg) }
// RV-30-01/02/03/08 首行安全范式：首个非空行（空首行不真空通过）；按行切分（CRLF 安全）；String() 包裹防二次抛错掩盖原始失败；全空回退 String(e)。截断不漏报分类信息：错误类型名+message 恒在首行，帧行只含调用位置，noCrash 哨兵只需分类信息。
// RV-153：逃逸出 try 的异常（Node 默认 exit 1）会被误分类为 FAIL — 显式映射为 ENV-FAULT。
process.on("uncaughtException", (e) => {
  let uncaughtLine = "";
  try { uncaughtLine = String((e && e.stack) || (e && e.message) || e).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")[0] ?? String(e) } catch { uncaughtLine = "unrenderable:" + typeof e }
  console.error("ENV-FAULT: uncaught: " + uncaughtLine)
  process.exit(2)
})
// RV-27-02：unhandledRejection 同理（Node>=15 默认 exit 1，无 stderr 标记）— 同映射为 ENV-FAULT。
// RV-28-01 逃逸语义注记：本映射无条件 — 产品逻辑 bug 若逃逸 try 同样记 ENV-FAULT（分类偏差）。
// 无假阴性放行：ENV-FAULT 下游 exit 2 中止（非 PASS），错误信息随 headline 输出供人工复核。
// try 内同步逻辑错误走 fail()（断言失败 exit 1），不经过此通道。
process.on("unhandledRejection", (e) => {
  let unhandledLine = "";
  try { unhandledLine = String((e && e.stack) || (e && e.message) || e).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")[0] ?? String(e) } catch { unhandledLine = "unrenderable:" + typeof e }
  console.error("ENV-FAULT: unhandledRejection: " + unhandledLine)
  process.exit(2)
})

try {

// R1: key commits present + clean tree + evidence doc on file.
// RV-156（根治 RV-145/RV-146/RV-149/RV-163/RV-164）：位置窗口（git log -N）已删除 —
// 存在性断言改用 `git cat-file -e <sha>`（内容寻址，与 HEAD 距离无关，+1/提交衰减消解）；
// 祖先断言 `merge-base --is-ancestor` 为主门控。窗口常量不复存在，无扩容、无余量、无老化。
// RV-204：类型约束 — `^{commit}` 后缀，tree/blob/tag 哈希注入必须拒绝。
// 注意：execSync 走 shell（Windows cmd 会吞 `^`），故用 execFileSync 绕过 shell（RV-204 实证教训）。
for (const c of ["a741863a", "86862911", "4b43eee7", "f5ca5638", "cde30365", "d3747834", "ea0c310e"]) {
  try {
    execFileSync("git", ["-C", "QMAI", "cat-file", "-e", `${c}^{commit}`], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" })
  } catch {
    fail("r1-8gap", "missing commit " + c)
  }
}
ok("r1-8gap", "R1 commits present (8-gap chain + evidence)")
// RV-146 内容寻址主门控：历史重写（rebase/squash/force-push）改变位置不改变祖先关系时仍可检出。
let ancestryOk = true
try {
  execSync("git -C QMAI merge-base --is-ancestor a741863a HEAD", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL" }) // RV-31-07 统一 + RV-38-11 timeout（超时→catch→FAIL ancestry，fail-closed）
} catch {
  ancestryOk = false
  fail("r1-ancestry", "a741863a not ancestor of HEAD (history rewritten?)")
}
if (ancestryOk) ok("r1-ancestry", "R1 baseline ancestry intact (content-addressed, RV-146)")
for (const c of ["3fb5667c", "69a8aa58", "d076892e", "3059fa9f", "1f95ceb4"]) {
  try {
    execFileSync("git", ["-C", "QMAI", "cat-file", "-e", `${c}^{commit}`], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" })
  } catch {
    fail("r1-newchain", "missing commit " + c)
  }
}
ok("r1-newchain", "R1 new chain present (#103 gap-list + 3x #104 fixes + #105 review)")
const status = execSync("git -C QMAI status --short", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL", env: { ...process.env, GIT_PAGER: "cat" } }).trim() // RV-30-04（RV-29-06 同理：大脏树超限走 catch→ENV-FAULT fail-closed）+ RV-38-11 timeout + RV-40A-01（env 整体替换改合并：子进程须继承 PATH/SystemRoot，与 all.mjs:103 一致）
// OBS-33-E2 前提显式化：status 已 .trim()（见上行），判空 !== ""（locale/CRLF 安全）；若改为全等比较须处理 \r。
if (status !== "") fail("r1-cleantree", "dirty tree:\n" + status)
ok("r1-cleantree", "R1 tree clean")
for (const f of [
  "QMAI/docs/decision-log/20260924-103-compact-evidence.md",
  "QMAI/docs/decision-log/20260924-102-final-verdict.md",
  "QMAI/docs/decision-log/20260924-103-gap-list.md",
  "QMAI/docs/decision-log/20260924-105-final-review.md",
]) {
  if (!existsSync(f)) fail("r1-evdocs", "missing " + f)
}
ok("r1-evdocs", "R1 evidence docs on file")

// R2: all 4 reference reports exist with expected baseline markers.
const R2 = [
  ["C:/Users/niko/Desktop/工作目录/拆解/ainovel-cli强在哪-分析报告.md", ["强项总览", "七维评审"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/AI-Novel-Writing-Assistant深度分析报告.md", ["三层导演", "LangGraph"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/niko-buddy深度分析报告.md", ["905", "control-kernel"]],
  ["C:/Users/niko/Desktop/工作目录/拆解/AI写作工具-写作质量对比总报告.md", ["纯写作质量上限", "★★★★★"]],
]
for (const [p, markers] of R2) {
  if (!existsSync(p)) fail("r2-reports", "missing report " + p)
  const t = readFileSync(p, "utf8")
  for (const m of markers) if (!t.includes(m)) fail("r2-reports", p + " lacks marker " + m)
}
ok("r2-reports", "R2 all 4 reference reports present with baseline markers")
if (failures.length === 0) {
  // RV-159：集合相等（终态 pass 的 id 清单全等）+ 计数不变式。须带 failures 守卫（RV-40A-02/F12 实证：
  // 无条件执行时合法单失败会触发 set-mismatch fail()，把已 ok 的 id 翻成 fail，导致 checksRun != passCount，
  // 同源断言误报 fork。失败运行的覆盖度问题在修好产品失败后的下一轮 pass 运行暴露，不掩盖 exit 1）。
  const got = [...states.entries()].filter(([, s]) => s === "pass").map(([id]) => id).sort().join(",")
  const want = [...EXPECTED_CHECK_IDS].sort().join(",")
  if (got !== want) fail("r1-8gap", `check-id set mismatch: got [${got}] want [${want}]`)
  if (checksRun !== EXPECTED_CHECKS) fail("r1-8gap", `checks run ${checksRun} != expected ${EXPECTED_CHECKS}`)
}
// RV-21-03（RV-24-03 强化）：rendered PASS 数 == states 终态 pass 数 — 无条件执行，不在
// failures 守卫内。ok() 只在非 fail 态计数+写 pass，fail() 只写 fail 不计数，故正常 fail
// 场景下恒相等（F1/F2 为凭）；仅外部污染计数器或账本时开火。文本与机读同源（states 派生）。
// RV-25-01：比较前冻结账目 — 此后新增写入者会大声开火，不再静默重引入误报。
finalized = true
{
  const passCount = [...states.values()].filter((s) => s === "pass").length
  if (checksRun !== passCount) fail("r1-8gap", `rendered PASS ${checksRun} != states pass ${passCount} (text/ledger fork)`)
}
if (failures.length === 0) console.log("ALL R1R2 PASS")
// RV-151 机读账本行：wrapper 解析 states（env==0∧fail==0 全过才 PASS）。
console.log(`CHECKS run=${checksRun} skipped=0 expected=${EXPECTED_CHECKS} states=${[...states.entries()].map(([id, s]) => `${id}:${s}`).join(",")}`)
} catch (e) {
  // ENV-FAULT 哨兵：任何环境/通道异常（EPIPE、命令缺失、IO 失败）显式标记；headline 见下方优先级裁决。
  envFault = e
  console.error("ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
}
// RV-143/RV-144：ENV-FAULT 支配 FAIL；故障前的 PASS 行在事后被证明损坏的环境中观测，降级为非验收。
if (envFault) {
  if (failures.length > 0) console.error(`INFO: ${failures.length} FAIL(s) before env fault (informational; headline is ENV-FAULT): ${failures.join(" | ")}`)
  console.error("INFO: any prior PASS lines above are non-acceptance (observed under later-proven-bad environment)")
  process.exit(2)
}
if (failures.length > 0) process.exit(1)
