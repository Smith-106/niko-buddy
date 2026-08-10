#!/usr/bin/env node
/**
 * Real-path verification (no full LLM):
 *  1) Gold materials load + thril prompt contains 金标 block
 *  2) Optional: temporal/character seed presence on disk
 *
 * Usage:
 *   node scripts/verify-gold-and-pack.mjs --project "E:/写作/8人"
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const project = resolve(arg("--project", ""))
if (!project || !existsSync(project)) {
  console.error("Usage: node scripts/verify-gold-and-pack.mjs --project <path>")
  process.exit(1)
}

// --- Pure gold readiness (no TS runtime) ---
const goldPath = join(project, ".novel", "literary-gold-anchors.json")
const gold = existsSync(goldPath) ? JSON.parse(readFileSync(goldPath, "utf8")) : { anchors: [] }
const thrilHuman = (gold.anchors || []).filter(
  (a) => a.dimension === "thrill" && a.status === "human_confirmed" && String(a.text || "").length >= 20,
)
const pullHuman = (gold.anchors || []).filter(
  (a) => a.dimension === "pull" && a.status === "human_confirmed" && String(a.text || "").length >= 20,
)

// Format gold block the same way as formatGoldScalePromptBlock (inline mirror)
function formatGoldBlock(anchors, dim = "thrill") {
  const confirmed = anchors.filter((a) => a.dimension === dim && a.status === "human_confirmed")
  if (confirmed.length === 0) return ""
  const lines = confirmed.slice(0, 3).map((a, i) => {
    const t = a.text.length > 280 ? `${a.text.slice(0, 280)}…` : a.text
    return `${i + 1}. [target≈${a.targetScore}|human_confirmed] ${t}`
  })
  return [
    `【文学金标 ${dim} 量程参照 · human_confirmed · 非产品硬门】`,
    `以下片段代表人类认可的约 9+ / 9–10 档，仅作量程锚，不得把 thril/overall≥9 写成产品硬门。`,
    ...lines,
  ].join("\n")
}

const goldBlock = formatGoldBlock(gold.anchors || [], "thrill")
const notReadyNote =
  thrilHuman.length < 3
    ? `【文学金标量程 · thril · 非产品硬门】\n金标量程未就绪：human=${thrilHuman.length}`
    : ""

// Minimal context pack shape for buildDimensionReviewPrompt-like thril prompt
const thrilPromptParts = [
  "六维独立审查维度：爽感密度",
  "评分量程与档位",
  "9-10 分：可发表文学质量",
  goldBlock || notReadyNote,
  "章节正文：",
  "（verify-only stub body）",
]
const thrilPrompt = thrilPromptParts.filter(Boolean).join("\n")

const hasJinBiao = thrilPrompt.includes("文学金标")
const hasHumanConfirmed = thrilPrompt.includes("human_confirmed")
const ready = thrilHuman.length >= 3

// Disk pack richness
const snapDir = join(project, ".novel", "snapshots")
const snaps = existsSync(snapDir)
  ? readdirSync(snapDir).filter((n) => n.endsWith(".snapshot.json"))
  : []
const charPath = join(project, ".novel", "character-states.json")
const charStore = existsSync(charPath) ? JSON.parse(readFileSync(charPath, "utf8")) : { characters: [] }
const ledgerPath = join(project, ".novel", "projection-status.json")
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null

// Approximate temporal fact count from snapshots.newCanonFacts
let canonFactCount = 0
let charStateChangeCount = 0
for (const f of snaps) {
  try {
    const s = JSON.parse(readFileSync(join(snapDir, f), "utf8"))
    canonFactCount += Array.isArray(s.newCanonFacts) ? s.newCanonFacts.length : 0
    charStateChangeCount += Array.isArray(s.characterStateChanges) ? s.characterStateChanges.length : 0
  } catch {
    /* ignore */
  }
}

const report = {
  ok: ready && hasJinBiao && hasHumanConfirmed && snaps.length > 0 && (charStore.characters || []).length > 0,
  gold: {
    path: goldPath,
    thrilHumanConfirmed: thrilHuman.length,
    pullHumanConfirmed: pullHuman.length,
    readyForThrill9Calibration: ready,
    promptContains文学金标: hasJinBiao,
    promptContainsHumanConfirmed: hasHumanConfirmed,
    goldBlockChars: goldBlock.length,
  },
  packDisk: {
    snapshotFiles: snaps.length,
    snapshotNames: snaps,
    newCanonFactsTotal: canonFactCount,
    characterStateChangesTotal: charStateChangeCount,
    characterStatesFile: existsSync(charPath),
    characterCount: (charStore.characters || []).length,
    projectionLedger: Boolean(ledger),
    temporalLikelyNonEmpty: canonFactCount > 0,
    characterStatesLikelyNonEmpty: (charStore.characters || []).length > 0 || charStateChangeCount > 0,
  },
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 2)
