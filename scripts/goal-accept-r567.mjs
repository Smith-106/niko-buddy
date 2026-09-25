// goal-accept-r567.mjs — R5 (feasibility) + R6 (stability) + R7 (UI usability).
// Run from workspace root: node QMAI/scripts/goal-accept-r567.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — 禁止 default-to-pass。
// RV-143 优先级：ENV-FAULT(2) 支配 FAIL(1)；RV-153：逃逸异常映射 ENV-FAULT。
// RV-147 正向执行断言：ok() 计数 + EXPECTED_CHECKS 全等 + CHECKS 行。
import { existsSync, readFileSync } from "node:fs"

const EXPECTED_CHECKS = 5 // R5×3 + R6 + R7（RV-159：增删检查时同步更新 id 清单）
let failures = []
let envFault = null
let checksRun = 0
// RV-25-01：比较点冻结 — 同源断言执行前 finalized=true，此后任何 ok() 写入即
// write-after-finalize（大声开火，不静默）。fail() 不设防：fail 只写 fail 态，
// 迟到 fail 只会让终态更 fail（fail-closed 方向），永不掩盖。
let finalized = false
// RV-151/RV-157 三值账本：每项 (check_id → state∈{pass,fail}) 机读记录；FAIL 为一等结局。
const states = new Map() // check_id → "pass" | "fail"
const EXPECTED_CHECK_IDS = ["r5-artifact", "r5-buildlog", "r5-typecheck", "r6-mocks", "r7-comp"]
function fail(id, msg) { failures.push(`${id}: ${msg}`); states.set(id, "fail"); console.error(`FAIL [${id}]: ` + msg) }
// RV-205/RV-157：first-fail-wins — 已 fail 的 id 后续 ok() 不得再打印 PASS 行（文本与机读一致），
// 记 INFO 降级行，避免文本消费者误读。
function ok(id, msg) { if (finalized) { failures.push(`${id}: write-after-finalize`); console.error(`FAIL [${id}]: write after ledger freeze (RV-25-01)`); return }; if (states.get(id) === "fail") { console.log(`INFO [${id}]: ${msg} (superseded by FAIL; non-acceptance)`); return }; states.set(id, "pass"); checksRun++; console.log("PASS: " + msg) }
// RV-153：逃逸出 try 的异常（Node 默认 exit 1）会被误分类为 FAIL — 显式映射为 ENV-FAULT。
process.on("uncaughtException", (e) => {
  console.error("ENV-FAULT: uncaught: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})
// RV-27-02：unhandledRejection 同理（Node>=15 默认 exit 1，无 stderr 标记）— 同映射为 ENV-FAULT。
// RV-28-01 逃逸语义注记：本映射无条件 — 产品逻辑 bug 若逃逸 try 同样记 ENV-FAULT（分类偏差）。
// 无假阴性放行：ENV-FAULT 下游 exit 2 中止（非 PASS），错误信息随 headline 输出供人工复核。
// try 内同步逻辑错误走 fail()（断言失败 exit 1），不经过此通道。
process.on("unhandledRejection", (e) => {
  console.error("ENV-FAULT: unhandledRejection: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})

try {
function read(id, p) {
  if (!existsSync(p)) fail(id, "missing " + p)
  try {
    return readFileSync(p, "utf8")
  } catch (e) {
    // RV-144 按路径作用域：IO 异常是环境故障而非断言失败 — 抛给外层 ENV-FAULT 裁决。
    throw new Error(`read ${p}: ` + (e instanceof Error ? e.message : String(e)))
  }
}
function noFailLines(id, t, label) {
  const bad = t.split("\n").filter((l) => l.startsWith(" FAIL"))
  if (bad.length > 0) fail(id, label + " has " + bad.length + " FAIL lines")
}

// R5: build artifact + build log + typecheck log (live typecheck is a
// separate acceptance command: `npm --prefix QMAI run typecheck`).
if (!existsSync("QMAI/dist/index.html")) fail("r5-artifact", "missing QMAI/dist/index.html")
ok("r5-artifact", "R5 build artifact QMAI/dist/index.html present")
const buildLog = read("r5-buildlog", "C:/goal-evidence/11-build.log")
if (!buildLog.includes("built in")) fail("r5-buildlog", "build log lacks built-in line")
ok("r5-buildlog", "R5 build log shows successful build")
const tcLog = read("r5-typecheck", "C:/goal-evidence/10-typecheck.log")
if (!tcLog.includes("TYPECHECK_EXIT=0")) fail("r5-typecheck", "typecheck log not EXIT=0")
ok("r5-typecheck", "R5 typecheck log EXIT=0")

// R6: full mocks suite green.
// Fresh 2026-09-25 run (#105): 890 files / 13331 tests (+3 new excludeOutline specs
// in existing trim.spec file, files count unchanged) + graph 75/75, zero FAIL.
// Accept 13328 (old) or 13331 (new) — never lower (no relaxation, growth only).
const mocks = read("r6-mocks", "C:/goal-evidence/12-mocks.log")
for (const m of ["890 passed", "75 passed", "MOCKS_FAIL=0"]) {
  if (!mocks.includes(m)) fail("r6-mocks", "mocks log lacks " + m)
}
if (!mocks.includes("13328 passed") && !mocks.includes("13331 passed")) fail("r6-mocks", "mocks log lacks 13328/13331 passed")
noFailLines("r6-mocks", mocks, "mocks")
ok("r6-mocks", "R6 stability: 890 files / 13331 tests + graph 75/75, zero FAIL")

// R7: component suite green.
// 177 files / 3055 tests total = 176 + graph-view isolation (1 file / 75 tests),
// matching the test:mocks split convention. Evidence log 13-comp.log holds both
// sections (176/2980 + graph 75/75) + COMP_FAIL=0.
const comp = read("r7-comp", "C:/goal-evidence/13-comp.log")
for (const m of ["COMP_FAIL=0", "75 passed"]) {
  if (!comp.includes(m)) fail("r7-comp", "comp log lacks " + m)
}
if (!comp.includes("3055 passed") && !(comp.includes("2980 passed") && comp.includes("176 passed"))) fail("r7-comp", "comp log lacks 3055 (or 2980+176 split) passed")
noFailLines("r7-comp", comp, "comp")
ok("r7-comp", "R7 UI usability: 177 files / 3055 component tests (176/2980 + graph 75/75), zero FAIL")
if (failures.length === 0) {
  // RV-159：集合相等（终态 pass 的 id 清单全等）+ 计数不变式。
  const got = [...states.entries()].filter(([, s]) => s === "pass").map(([id]) => id).sort().join(",")
  const want = [...EXPECTED_CHECK_IDS].sort().join(",")
  if (got !== want) fail("r5-artifact", `check-id set mismatch: got [${got}] want [${want}]`)
  if (checksRun !== EXPECTED_CHECKS) fail("r5-artifact", `checks run ${checksRun} != expected ${EXPECTED_CHECKS}`)
}
// RV-21-03（RV-24-03 强化）：rendered PASS 数 == states 终态 pass 数 — 无条件执行，不在
// failures 守卫内。ok() 只在非 fail 态计数+写 pass，fail() 只写 fail 不计数，故正常 fail
// 场景下恒相等（F1/F2 为凭）；仅外部污染计数器或账本时开火。文本与机读同源（states 派生）。
// RV-25-01：比较前冻结账目 — 此后新增写入者会大声开火，不再静默重引入误报。
finalized = true
{
  const passCount = [...states.values()].filter((s) => s === "pass").length
  if (checksRun !== passCount) fail("r5-artifact", `rendered PASS ${checksRun} != states pass ${passCount} (text/ledger fork)`)
}
if (failures.length === 0) console.log("ALL R567 PASS")
// RV-151 机读账本行。
console.log(`CHECKS run=${checksRun} skipped=0 expected=${EXPECTED_CHECKS} states=${[...states.entries()].map(([id, s]) => `${id}:${s}`).join(",")}`)
} catch (e) {
  envFault = e
  console.error("ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
}
// RV-143/RV-144：ENV-FAULT 支配 FAIL；故障前的 PASS 降级为非验收。
if (envFault) {
  if (failures.length > 0) console.error(`INFO: ${failures.length} FAIL(s) before env fault (informational; headline is ENV-FAULT)`)
  console.error("INFO: any prior PASS lines above are non-acceptance (observed under later-proven-bad environment)")
  process.exit(2)
}
if (failures.length > 0) process.exit(1)
