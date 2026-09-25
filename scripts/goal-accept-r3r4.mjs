// goal-accept-r3r4.mjs — R3 (8-gap symbols in product code) + R4 (re-eval docs).
// Run from workspace root: node QMAI/scripts/goal-accept-r3r4.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — 禁止 default-to-pass。
// RV-143 优先级：ENV-FAULT(2) 支配 FAIL(1)；RV-153：逃逸异常映射 ENV-FAULT。
// RV-147 正向执行断言：ok() 计数 + EXPECTED_CHECKS 全等 + CHECKS 行。
import { existsSync, readFileSync } from "node:fs"

const EXPECTED_CHECKS = 3 // R3 + R3b + R4（增删检查时同步更新）
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
function mustContain(file, syms) {
  if (!existsSync(file)) fail("missing " + file)
  const t = readFileSync(file, "utf8")
  for (const s of syms) if (!t.includes(s)) fail(file + " lacks " + s)
}

// R3: every gap lands in product code (no parallel implementations).
mustContain("QMAI/src/lib/novel/deep-chapter-task-brief.ts",
  ["buildChapterContractSection", "parseChapterContractSection", "checkChapterContract"])
mustContain("QMAI/src/lib/novel/deep-chapter-generation.ts", ["applyChapterContractCheck"])
mustContain("QMAI/src/lib/novel/repair-loop.ts",
  ["TRIAD_MAX_REWORK", "createChapterTriadState", "triadPlanGate", "triadDraftGate", "triadReviewGate", "advanceChapterTriad"])
mustContain("QMAI/src/lib/novel/mechanical-slop-detector.ts", ["rollupStyleStats", "bookStyleStatsToText"])
mustContain("QMAI/src/lib/novel/related-chapters.ts", ["recentCast", "renderCastIntros"])
mustContain("QMAI/src/lib/novel/dimension-review-adapter.ts",
  ["minimalReworkSet", "minimalReworkSetFromDimensionIssues", "dimensionResultsToReviewResults"])
mustContain("QMAI/src/lib/novel/volume.ts", ["checkFinaleAutoComplete"])
mustContain("QMAI/src/lib/novel/story-compass.ts", ["evaluateCompletionChecklist", "checkCompleteBookAllowed"])
mustContain("QMAI/src/lib/novel/context-compact.ts", ["compactContextSections", "buildRestorePack"])
ok("R3 8-gap symbols all present in product code")

// R3b: #104 fixes land in product code + spec (not just commit messages).
// (f1) trimContextPack honors excludeOutline on both prompt paths.
mustContain("QMAI/src/lib/novel/context-engine.ts",
  ["const excludeOutline = Boolean(options?.excludeOutline)"])
mustContain("QMAI/src/lib/novel/context-engine.trim.spec.ts",
  ["excludeOutline", "UNIQUE-OUTLINE-103"])
// (f2) trim fields order aligned to CONTEXT_DROP_ORDER (techniqueBlocks @130).
// (f3) compactSectionText stale-comment correction.
mustContain("QMAI/src/lib/novel/context-compact.ts", ["compactSectionText"])
ok("R3b #104 fixes present (excludeOutline both paths + spec + compact alias)")

// R4: re-eval chain docs with rating markers.
mustContain("QMAI/docs/decision-log/20260924-90-reeval-closure.md", ["四维度重评", "★★★★→★★★★★"])
mustContain("QMAI/docs/decision-log/20260924-91-triad-closure.md", ["①⑤②⑤③⑤④⑤+"])
mustContain("QMAI/docs/decision-log/20260924-102-final-verdict.md", ["四维度终评", "§五"])
ok("R4 re-eval chain (#90 -> #91 -> #102) on file")
if (failures.length === 0) {
  if (checksRun !== EXPECTED_CHECKS) fail(`checks run ${checksRun} != expected ${EXPECTED_CHECKS}`)
}
if (failures.length === 0) console.log("ALL R3R4 PASS")
console.log(`CHECKS run=${checksRun} skipped=0 expected=${EXPECTED_CHECKS}`)
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
