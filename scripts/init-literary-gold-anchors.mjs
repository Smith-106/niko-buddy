#!/usr/bin/env node
/**
 * Seed / report literary gold anchors for thril≈9 calibration.
 * Does NOT invent human_confirmed gold — only scaffolds file + imports exemplar thrill/pull as provisional.
 *
 * Usage:
 *   node scripts/init-literary-gold-anchors.mjs --project "E:/写作/8人" [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const GOLD_TARGET = 9

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const force = process.argv.includes("--force")
const project = resolve(arg("--project", ""))
if (!project || !existsSync(project)) {
  console.error("Usage: node scripts/init-literary-gold-anchors.mjs --project <path> [--force]")
  process.exit(1)
}

const novelDir = join(project, ".novel")
const outPath = join(novelDir, "literary-gold-anchors.json")
mkdirSync(novelDir, { recursive: true })

let exemplars = []
const exPath = join(novelDir, "style-exemplars.json")
if (existsSync(exPath)) {
  const raw = JSON.parse(readFileSync(exPath, "utf8"))
  exemplars = Array.isArray(raw) ? raw : raw.exemplars || []
}

const provisionalFromEx = exemplars
  .filter((e) => e && (e.markType === "thrill" || e.markType === "pull"))
  .map((e, i) => ({
    id: `ex-import-${e.exemplarId || i}`,
    dimension: e.markType === "pull" ? "pull" : "thrill",
    targetScore: GOLD_TARGET,
    text: String(e.text || ""),
    chapterId: e.chapterId != null ? String(e.chapterId) : undefined,
    note: "provisional from style-exemplars — promote to human_confirmed after author review",
    status: "provisional",
    source: "exemplar_import",
    createdAt: e.createdAt || e.markedAt || new Date().toISOString(),
  }))
  .filter((a) => a.text.trim().length >= 20)

const existing = existsSync(outPath) && !force ? JSON.parse(readFileSync(outPath, "utf8")) : null
if (existing && !force) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "skip-exists",
        path: outPath,
        anchors: (existing.anchors || []).length,
        goldTarget: GOLD_TARGET,
        hint: "use --force to rewrite scaffold",
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const file = {
  schemaVersion: "literary-gold-scale/1.0",
  goldTarget: GOLD_TARGET,
  projectNote:
    `Human thril≈${GOLD_TARGET} calibration (9–10 publishable band). Mark status human_confirmed only after author agrees the segment is 9-band. Need ≥3 human_confirmed thrill anchors before claiming thril≥${GOLD_TARGET} is calibrated. Not a product hard gate — Track A does not require thril/overall≥9.`,
  anchors: provisionalFromEx,
  howToConfirm: [
    "Open draft passages you believe are publishable thril (crisis early + pressure release + agency + outsized craft).",
    `Add { dimension: thrill, targetScore: ${GOLD_TARGET}, status: human_confirmed, text, chapterId }.`,
    "Or re-mark style-exemplars with markType=thrill then re-run this script and promote.",
    `Until human_confirmed≥3, treat LLM thril medians as uncalibrated instrument for 「破 ${GOLD_TARGET}」 claims.`,
  ],
}

writeFileSync(outPath, JSON.stringify(file, null, 2), "utf8")
console.log(
  JSON.stringify(
    {
      ok: true,
      action: "wrote",
      path: outPath,
      goldTarget: GOLD_TARGET,
      provisionalFromExemplars: provisionalFromEx.length,
      styleOnlyExemplars: exemplars.filter((e) => e?.markType === "style").length,
      readiness:
        provisionalFromEx.filter((a) => a.dimension === "thrill").length === 0
          ? "NOT_READY — no thrill exemplars; author must add human_confirmed anchors"
          : "PROVISIONAL_ONLY — promote to human_confirmed",
    },
    null,
    2,
  ),
)
