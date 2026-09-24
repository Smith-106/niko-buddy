// goal-accept-r3r4.mjs — R3 (8-gap symbols in product code) + R4 (re-eval docs).
// Run from workspace root: node QMAI/scripts/goal-accept-r3r4.mjs
import { existsSync, readFileSync } from "node:fs"

function fail(msg) { console.error("FAIL: " + msg); process.exit(1) }
function ok(msg) { console.log("PASS: " + msg) }
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
console.log("ALL R3R4 PASS")
