#!/usr/bin/env node
/**
 * Residual rewrite toolkit — CLI for evaluateResidualRewritePolicy +
 * buildStructureFirstRewriteConstraint (+ default ChapterStructurePlan block).
 *
 * Product truth remains TypeScript pure modules under src/lib/novel/:
 *   residual-rewrite-policy.ts
 *   structure-first-rewrite.ts
 *   chapter-structure-plan.ts
 * This script mirrors the pure decision table for campaign/tooling without a
 * build step. Keep logic in sync when the TS modules change.
 *
 * Usage (from QMAI/):
 *   node scripts/residual-rewrite-toolkit.mjs evaluate \
 *     --median 8.8 --mode densify_only
 *   node scripts/residual-rewrite-toolkit.mjs evaluate \
 *     --median 8.8 --mode structure_thril_pacing --length-preserving
 *   node scripts/residual-rewrite-toolkit.mjs constraint \
 *     --median 8.8 --mode densify_only --chapter 5
 *   node scripts/residual-rewrite-toolkit.mjs plan-default --chapter 5
 *   node scripts/residual-rewrite-toolkit.mjs gate-modes --median 8.8
 *
 * Exit codes:
 *   evaluate: 0 accept, 2 reject, 1 usage/error
 *   others: 0 ok, 1 error
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const RESIDUAL_OVERALL_MEDIAN_THRESHOLD = 8.6

const MODES = [
  "structure_thril_pacing",
  "densify_only",
  "short_compress",
  "micro_thril",
  "other",
]

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

/** Mirror of residual-rewrite-policy.ts evaluateResidualRewritePolicy */
function evaluateResidualRewritePolicy(input) {
  const threshold =
    input.threshold != null && Number.isFinite(input.threshold)
      ? input.threshold
      : RESIDUAL_OVERALL_MEDIAN_THRESHOLD
  const median = Number(input.residualOverallMedian)
  const mode = input.mode
  const high =
    Number.isFinite(median) && median >= threshold
      ? "residual_high"
      : "below_residual"

  const base = {
    mode,
    productHardGate: false,
    threshold,
    residualBand: high,
  }

  if (!Number.isFinite(median)) {
    return {
      ...base,
      accept: false,
      reason: "residualOverallMedian is not a finite number",
      requiredMode: null,
    }
  }

  if (high === "below_residual") {
    return {
      ...base,
      accept: true,
      reason: `residual overall ${median} < ${threshold}; densify/short-compress not auto-banned`,
      requiredMode: null,
    }
  }

  if (mode === "densify_only") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: densify_only banned as primary lever (densify ceiling)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "short_compress") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: short_compress banned (wave short-structure regression)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "structure_thril_pacing") {
    if (input.lengthPreserving === false) {
      return {
        ...base,
        accept: false,
        reason:
          "structure_thril_pacing requires lengthPreserving=true for residual chapters (no short-compress)",
        requiredMode: "structure_thril_pacing",
      }
    }
    return {
      ...base,
      accept: true,
      reason: `residual overall ${median} >= ${threshold}: structure_thril_pacing accepted (length-preserving)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "micro_thril") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: micro_thril alone insufficient (wave8 flat/regress); use structure_thril_pacing`,
      requiredMode: "structure_thril_pacing",
    }
  }

  return {
    ...base,
    accept: false,
    reason: `residual overall ${median} >= ${threshold}: mode=${mode} not approved; require structure_thril_pacing`,
    requiredMode: "structure_thril_pacing",
  }
}

function createDefaultStructureThrilPacingPlan(chapterNumber) {
  return {
    schemaVersion: "chapter-structure-plan/1.0",
    chapterNumber,
    fix1NonSpoiler: true,
    source: "campaign",
    thrilCheckpointCoverage: [
      "crisis_info_early",
      "pressure_release",
      "protagonist_agency",
      "chapter_end_hook",
      "fix1_no_conflict",
    ],
    beats: [
      {
        id: "beat-1",
        label: "开篇压迫",
        purpose: "opening_pressure",
        thrilCheckpointId: "crisis_info_early",
        pressure: "前 40% 内给出可感危机/代价，非纯说明",
      },
      {
        id: "beat-2",
        label: "压抑链",
        purpose: "pressure_escalation",
        thrilCheckpointId: "pressure_release",
        pressure: "至少一条可指认的压抑→升级链条",
      },
      {
        id: "beat-3",
        label: "能动转折",
        purpose: "agency_turn",
        thrilCheckpointId: "protagonist_agency",
        agency: "主角选择推动局面，非纯旁观",
      },
      {
        id: "beat-4",
        label: "释放与代价",
        purpose: "release",
        thrilCheckpointId: "pressure_release",
      },
      {
        id: "beat-5",
        label: "章末钩",
        purpose: "end_hook",
        thrilCheckpointId: "chapter_end_hook",
        hook: "下一阶段具体期待；不提前揭 Offer/机制名",
      },
    ],
    notes: ["structure_thril_pacing default; length-preserving residual rewrite"],
  }
}

function buildStructurePlanPromptBlock(plan) {
  const lines = [
    "【ChapterStructurePlan — structure-first thril-pacing】",
    plan.chapterNumber != null
      ? `- 章节：${plan.chapterNumber}`
      : "- 章节：（未指定）",
    "- 长度：优先保长（structure thril-pacing，非 short-compress）",
    "- FIX-1：禁止 Offer/最终存活者/机制名提前揭穿（fix1NonSpoiler=true）",
    "- 节拍（按序执行，非 densify 堆料）：",
  ]
  for (const beat of plan.beats ?? []) {
    const thril = beat.thrilCheckpointId
      ? ` [thril:${beat.thrilCheckpointId}]`
      : ""
    lines.push(`  ${beat.id}. ${beat.label} (${beat.purpose})${thril}`)
    if (beat.pressure?.trim()) lines.push(`     压迫：${beat.pressure.trim()}`)
    if (beat.agency?.trim()) lines.push(`     能动：${beat.agency.trim()}`)
    if (beat.hook?.trim()) lines.push(`     钩：${beat.hook.trim()}`)
  }
  return lines.join("\n")
}

/** Mirror of structure-first-rewrite.ts buildStructureFirstRewriteConstraint */
function buildStructureFirstRewriteConstraint(plan, residualDecision) {
  const lines = [
    "",
    "【Structure-first 改写约束】",
    "- 主杠杆：structure thril-pacing 全章结构改写（开篇压迫→能动转折→章末钩）。",
    "- 禁止将 densify-only / short-compress / 纯 micro-thril 作为 residual 高分章主杠杆。",
    "- overall≥9 是书稿里程碑 stretch，不是 Track A 产品硬门（productHardGate=false）。",
    "- 改写测试控制线 overall≥9.5（SSOT：L9_OVERALL_TEST_CONTROL_MEDIAN=9.5）：为稳定保住 ≥9，KEEP/抛光循环以 9.5 为控制目标；结案宣称仍认 truepack N≥5 overall≥9。",
  ]
  if (residualDecision) {
    lines.push(
      `- 策略判定：accept=${residualDecision.accept} band=${residualDecision.residualBand} mode=${residualDecision.mode}`,
    )
    lines.push(`- 原因：${residualDecision.reason}`)
    if (residualDecision.requiredMode) {
      lines.push(`- 要求模式：${residualDecision.requiredMode}`)
    }
    lines.push(`- productHardGate=${residualDecision.productHardGate}`)
  }
  if (plan?.beats?.length) {
    lines.push(buildStructurePlanPromptBlock(plan))
  } else {
    lines.push(
      "- （无有效 ChapterStructurePlan：先补 plan 再写；勿 densify 硬堆）",
    )
  }
  return lines.join("\n")
}

function usage() {
  console.error(`Usage:
  node scripts/residual-rewrite-toolkit.mjs evaluate --median <n> --mode <mode> [--length-preserving|--no-length-preserving] [--threshold 8.6] [--json]
  node scripts/residual-rewrite-toolkit.mjs constraint --median <n> --mode <mode> [--chapter n] [--length-preserving] [--out file.md] [--json]
  node scripts/residual-rewrite-toolkit.mjs plan-default [--chapter n] [--out file.json]
  node scripts/residual-rewrite-toolkit.mjs gate-modes --median <n> [--json]

Modes: ${MODES.join(" | ")}
`)
}

function parseCommon() {
  const median = Number(arg("median"))
  const mode = arg("mode", "structure_thril_pacing")
  const threshold = arg("threshold") != null ? Number(arg("threshold")) : undefined
  let lengthPreserving
  if (flag("length-preserving")) lengthPreserving = true
  if (flag("no-length-preserving")) lengthPreserving = false
  if (mode === "structure_thril_pacing" && lengthPreserving === undefined) {
    lengthPreserving = true
  }
  return { median, mode, threshold, lengthPreserving }
}

const cmd = process.argv[2]

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage()
  process.exit(cmd ? 0 : 1)
}

if (cmd === "evaluate") {
  const { median, mode, threshold, lengthPreserving } = parseCommon()
  if (!Number.isFinite(median) || !MODES.includes(mode)) {
    usage()
    process.exit(1)
  }
  const decision = evaluateResidualRewritePolicy({
    residualOverallMedian: median,
    mode,
    lengthPreserving,
    threshold,
  })
  if (flag("json")) {
    console.log(JSON.stringify(decision, null, 2))
  } else {
    console.log(
      `${decision.accept ? "ACCEPT" : "REJECT"}  mode=${decision.mode}  band=${decision.residualBand}`,
    )
    console.log(decision.reason)
    if (decision.requiredMode) console.log(`requiredMode=${decision.requiredMode}`)
    console.log(`productHardGate=${decision.productHardGate}`)
  }
  process.exit(decision.accept ? 0 : 2)
}

if (cmd === "constraint") {
  const { median, mode, threshold, lengthPreserving } = parseCommon()
  if (!Number.isFinite(median) || !MODES.includes(mode)) {
    usage()
    process.exit(1)
  }
  const chapter = arg("chapter") != null ? Number(arg("chapter")) : undefined
  const decision = evaluateResidualRewritePolicy({
    residualOverallMedian: median,
    mode,
    lengthPreserving,
    threshold,
  })
  const plan = createDefaultStructureThrilPacingPlan(
    Number.isFinite(chapter) ? chapter : undefined,
  )
  const text = buildStructureFirstRewriteConstraint(plan, decision)
  const out = arg("out")
  if (out) {
    writeFileSync(resolve(out), text + "\n", "utf8")
    console.error(`wrote ${resolve(out)}`)
  }
  if (flag("json")) {
    console.log(
      JSON.stringify(
        { decision, constraint: text, planChapter: plan.chapterNumber ?? null },
        null,
        2,
      ),
    )
  } else {
    console.log(text)
  }
  process.exit(decision.accept ? 0 : 2)
}

if (cmd === "plan-default") {
  const chapter = arg("chapter") != null ? Number(arg("chapter")) : undefined
  const plan = createDefaultStructureThrilPacingPlan(
    Number.isFinite(chapter) ? chapter : undefined,
  )
  const out = arg("out")
  const body = JSON.stringify(plan, null, 2) + "\n"
  if (out) {
    writeFileSync(resolve(out), body, "utf8")
    console.error(`wrote ${resolve(out)}`)
  }
  if (flag("block")) {
    console.log(buildStructurePlanPromptBlock(plan))
  } else {
    process.stdout.write(body)
  }
  process.exit(0)
}

if (cmd === "gate-modes") {
  const median = Number(arg("median"))
  if (!Number.isFinite(median)) {
    usage()
    process.exit(1)
  }
  const rows = MODES.map((mode) =>
    evaluateResidualRewritePolicy({
      residualOverallMedian: median,
      mode,
      lengthPreserving: mode === "structure_thril_pacing" ? true : undefined,
    }),
  )
  if (flag("json")) {
    console.log(JSON.stringify({ median, threshold: RESIDUAL_OVERALL_MEDIAN_THRESHOLD, rows }, null, 2))
  } else {
    console.log(`median=${median} threshold=${RESIDUAL_OVERALL_MEDIAN_THRESHOLD}`)
    for (const d of rows) {
      console.log(
        `${d.accept ? "OK " : "NO "}  ${d.mode.padEnd(24)}  ${d.reason}`,
      )
    }
  }
  process.exit(0)
}

usage()
process.exit(1)
