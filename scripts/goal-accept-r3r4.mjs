// goal-accept-r3r4.mjs — R3 (8-gap symbols in product code) + R4 (re-eval docs).
// Run from workspace root: node QMAI/scripts/goal-accept-r3r4.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — 禁止 default-to-pass。
// RV-143 优先级：ENV-FAULT(2) 支配 FAIL(1)；RV-153：逃逸异常映射 ENV-FAULT。
// RV-147 正向执行断言：ok() 计数 + EXPECTED_CHECKS 全等 + CHECKS 行。
import { existsSync, readFileSync } from "node:fs"

const EXPECTED_CHECKS = 3 // R3 + R3b + R4（RV-159：增删检查时同步更新 id 清单）
let failures = []
let envFault = null
let checksRun = 0
// RV-25-01：比较点冻结 — 同源断言执行前 finalized=true，此后任何 ok() 写入即
// write-after-finalize（大声开火，不静默）。fail() 不设防：fail 只写 fail 态，
// 迟到 fail 只会让终态更 fail（fail-closed 方向），永不掩盖。
let finalized = false
// RV-151/RV-157 三值账本：每项 (check_id → state∈{pass,fail}) 机读记录；FAIL 为一等结局。
const states = new Map() // check_id → "pass" | "fail"
const EXPECTED_CHECK_IDS = ["r3-gaps", "r3b-fixes", "r4-reeval"]
function fail(id, msg) { failures.push(`${id}: ${msg}`); states.set(id, "fail"); console.error(`FAIL [${id}]: ` + msg) }
// RV-205/RV-157：first-fail-wins — 已 fail 的 id 后续 ok() 不得再打印 PASS 行（文本与机读一致），
// 记 INFO 降级行，避免文本消费者误读。
function ok(id, msg) { if (finalized) { failures.push(`${id}: write-after-finalize`); console.error(`FAIL [${id}]: write after ledger freeze (RV-25-01)`); return }; if (states.get(id) === "fail") { console.log(`INFO [${id}]: ${msg} (superseded by FAIL; non-acceptance)`); return }; states.set(id, "pass"); checksRun++; console.log("PASS: " + msg) }
// RV-153：逃逸出 try 的异常（Node 默认 exit 1）会被误分类为 FAIL — 显式映射为 ENV-FAULT。
process.on("uncaughtException", (e) => {
  console.error("ENV-FAULT: uncaught: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})

try {
function mustContain(id, file, syms) {
  if (!existsSync(file)) fail(id, "missing " + file)
  let t = ""
  try {
    t = readFileSync(file, "utf8")
  } catch (e) {
    // RV-144 按路径作用域：IO 异常是环境故障而非断言失败 — 抛给外层 ENV-FAULT 裁决。
    throw new Error(`read ${file}: ` + (e instanceof Error ? e.message : String(e)))
  }
  for (const s of syms) if (!t.includes(s)) fail(id, file + " lacks " + s)
}

// R3: every gap lands in product code (no parallel implementations).
mustContain("r3-gaps", "QMAI/src/lib/novel/deep-chapter-task-brief.ts",
  ["buildChapterContractSection", "parseChapterContractSection", "checkChapterContract"])
mustContain("r3-gaps", "QMAI/src/lib/novel/deep-chapter-generation.ts", ["applyChapterContractCheck"])
mustContain("r3-gaps", "QMAI/src/lib/novel/repair-loop.ts",
  ["TRIAD_MAX_REWORK", "createChapterTriadState", "triadPlanGate", "triadDraftGate", "triadReviewGate", "advanceChapterTriad"])
mustContain("r3-gaps", "QMAI/src/lib/novel/mechanical-slop-detector.ts", ["rollupStyleStats", "bookStyleStatsToText"])
mustContain("r3-gaps", "QMAI/src/lib/novel/related-chapters.ts", ["recentCast", "renderCastIntros"])
mustContain("r3-gaps", "QMAI/src/lib/novel/dimension-review-adapter.ts",
  ["minimalReworkSet", "minimalReworkSetFromDimensionIssues", "dimensionResultsToReviewResults"])
mustContain("r3-gaps", "QMAI/src/lib/novel/volume.ts", ["checkFinaleAutoComplete"])
mustContain("r3-gaps", "QMAI/src/lib/novel/story-compass.ts", ["evaluateCompletionChecklist", "checkCompleteBookAllowed"])
mustContain("r3-gaps", "QMAI/src/lib/novel/context-compact.ts", ["compactContextSections", "buildRestorePack"])
ok("r3-gaps", "R3 8-gap symbols all present in product code")

// R3b: #104 fixes land in product code + spec (not just commit messages).
// (f1) trimContextPack honors excludeOutline on both prompt paths.
mustContain("r3b-fixes", "QMAI/src/lib/novel/context-engine.ts",
  ["const excludeOutline = Boolean(options?.excludeOutline)"])
mustContain("r3b-fixes", "QMAI/src/lib/novel/context-engine.trim.spec.ts",
  ["excludeOutline", "UNIQUE-OUTLINE-103"])
// (f2) trim fields order aligned to CONTEXT_DROP_ORDER (techniqueBlocks @130).
// (f3) compactSectionText stale-comment correction.
mustContain("r3b-fixes", "QMAI/src/lib/novel/context-compact.ts", ["compactSectionText"])
ok("r3b-fixes", "R3b #104 fixes present (excludeOutline both paths + spec + compact alias)")

// R4: re-eval chain docs with rating markers.
mustContain("r4-reeval", "QMAI/docs/decision-log/20260924-90-reeval-closure.md", ["四维度重评", "★★★★→★★★★★"])
mustContain("r4-reeval", "QMAI/docs/decision-log/20260924-91-triad-closure.md", ["①⑤②⑤③⑤④⑤+"])
mustContain("r4-reeval", "QMAI/docs/decision-log/20260924-102-final-verdict.md", ["四维度终评", "§五"])
ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")
if (failures.length === 0) {
  // RV-159：集合相等（终态 pass 的 id 清单全等）+ 计数不变式。
  const got = [...states.entries()].filter(([, s]) => s === "pass").map(([id]) => id).sort().join(",")
  const want = [...EXPECTED_CHECK_IDS].sort().join(",")
  if (got !== want) fail("r3-gaps", `check-id set mismatch: got [${got}] want [${want}]`)
  if (checksRun !== EXPECTED_CHECKS) fail("r3-gaps", `checks run ${checksRun} != expected ${EXPECTED_CHECKS}`)
}
// RV-21-03（RV-24-03 强化）：rendered PASS 数 == states 终态 pass 数 — 无条件执行，不在
// failures 守卫内。ok() 只在非 fail 态计数+写 pass，fail() 只写 fail 不计数，故正常 fail
// 场景下恒相等（F1/F2 为凭）；仅外部污染计数器或账本时开火。文本与机读同源（states 派生）。
// RV-25-01：比较前冻结账目 — 此后新增写入者会大声开火，不再静默重引入误报。
finalized = true
{
  const passCount = [...states.values()].filter((s) => s === "pass").length
  if (checksRun !== passCount) fail("r3-gaps", `rendered PASS ${checksRun} != states pass ${passCount} (text/ledger fork)`)
}
if (failures.length === 0) console.log("ALL R3R4 PASS")
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
