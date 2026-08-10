#!/usr/bin/env node
/**
 * Production pack → step0 measurement fixture entry.
 *
 * Prefer this over hand-crafted thin packs so Track B N≥5 shares the same
 * ContextPack shape as deep-chapter (task/outline/exemplars fields present).
 *
 * Usage (from QMAI/):
 *   node scripts/build-step0-production-fixture.mjs \
 *     --project "E:/写作/8人" \
 *     --chapter 4 \
 *     --chapter-file "E:/写作/8人/.novel/chapters/4/draft.md" \
 *     --out "../.workflow/harvest-staging/fixtures/step0-ab-prompts.ch4.json" \
 *     [--model claude-sonnet-4-6] [--samples 5] [--label post-wave3]
 *
 * Notes:
 * - Does NOT call LLM.
 * - If --pack-json is provided, uses that ContextPack (from a prior export).
 * - Without --pack-json, builds a minimal production-shaped pack from outline/
 *   chapter files on disk (not full wiki temporal graph — full pack requires app runtime).
 * - Always embeds literary-experiment protocol metadata for same-model compare.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

const project = arg("project")
const chapter = Number(arg("chapter", "0"))
const chapterFile = arg("chapter-file")
const out = arg("out")
const packJson = arg("pack-json")
const model = arg("model", "claude-sonnet-4-6")
const samples = Math.min(10, Math.max(1, Number(arg("samples", "5")) || 5))
const label = arg("label", chapter ? `ch${chapter}-production` : "production")

if (!project || !chapterFile || !out || !Number.isFinite(chapter) || chapter <= 0) {
  console.error(`Usage:
  node scripts/build-step0-production-fixture.mjs \\
    --project <path> --chapter <n> --chapter-file <draft.md> --out <fixture.json> \\
    [--pack-json pack.json] [--model claude-sonnet-4-6] [--samples 5] [--label post-wave3]
`)
  process.exit(1)
}

const chapterText = readFileSync(resolve(chapterFile), "utf8").replace(/^\uFEFF/, "")

function readOptional(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : ""
  } catch {
    return ""
  }
}

/** Minimal production-shaped pack when full buildContextPack is unavailable offline. */
function buildOfflineProductionPack() {
  const outlinePath = resolve(project, ".novel/outline.md")
  const chapterOutline = resolve(project, `.novel/chapters/${chapter}/outline.md`)
  const outline = [readOptional(outlinePath), readOptional(chapterOutline)].filter(Boolean).join("\n\n")
  return {
    task: `六维审查第${chapter}章（production measurement）`,
    chapterGoal: `第${chapter}章目标（offline pack — prefer --pack-json from app runtime）`,
    outline: outline || `第${chapter}章纲要（文件缺失时占位）`,
    recentChapterContents: [],
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "FIX-1：不得提前揭露 Offer / 最终存活者 / 机制名。",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "评估 thril/pull/pacing 与 Track A 相关维；不得因文学分判产品 FAIL。",
    mustAvoid: "跨模型对照；截断窗结案；overall≥9 硬门。",
    nextChapterAdvice: "",
    revisionDirectives: "",
    gaps: [{ source: "offline-fixture-builder", reason: "full buildContextPack requires app runtime; use --pack-json when available" }],
    styleExemplars: [],
    temporalFacts: [],
  }
}

let pack
if (packJson) {
  const raw = JSON.parse(readFileSync(resolve(packJson), "utf8"))
  // Accept: bare ContextPack | { pack } export | full step0 fixture
  if (raw && typeof raw === "object" && raw.pack && typeof raw.pack === "object") {
    pack = raw.pack
  } else {
    pack = raw
  }
} else {
  pack = buildOfflineProductionPack()
}

const protocol = {
  schemaVersion: "literary-experiment/1.0",
  model,
  samples,
  window: "full_chapter",
  mode: "NEW_only",
  productHardGate: false,
  overallGe9IsShipCriterion: false,
  dimensions: ["thrill", "consistency", "pacing", "character", "continuity", "pull"],
  label,
  notes: [
    "Track B diagnosis only; Track A Consistency>Anti-AI>Quality unchanged",
    "Do not compare medians across different models",
    packJson ? "pack from --pack-json (prefer production buildContextPack export)" : "offline minimal pack — prefer --pack-json for full temporal/entity path",
  ],
}

function fnv1a16(text) {
  let hash = 0xcbf29ce484222325n
  const bytes = new TextEncoder().encode(text)
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i])
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

function packHashPayload(p) {
  // Stable-enough: JSON of key fields sorted by key names we care about
  const keys = [
    "task","chapterGoal","outline","recentSummaries","previousChapterEnding","characterStates",
    "soulDoc","characterAuras","cognitionStates","foreshadowingStates","timeline","relatedSettings",
    "canonRules","writingStyle","searchResults","graphSearchResults","mustDo","mustAvoid",
    "nextChapterAdvice","revisionDirectives","styleExemplars","gaps","recentChapterContents",
  ]
  const picked = {}
  for (const k of keys) if (k in (p || {})) picked[k] = p[k]
  return JSON.stringify(picked)
}

const packHash = fnv1a16(packHashPayload(pack))
const chapterTextHash = fnv1a16(chapterText)
const measurementFingerprint = {
  schemaVersion: "measurement-fingerprint/1.0",
  id: fnv1a16([model, String(samples), "full_chapter", "NEW_only", packJson ? "production-measurement" : "production-measurement-offline", packHash, chapterTextHash].join("|")),
  model,
  samples,
  window: "full_chapter",
  mode: "NEW_only",
  packKind: packJson ? "production-measurement" : "production-measurement-offline",
  label,
  packHash,
  chapterTextHash,
  chapterTextChars: chapterText.length,
  shape: {
    outlineChars: (pack?.outline || "").length,
    previousEndingChars: (pack?.previousChapterEnding || "").length,
    recentChapterCount: Array.isArray(pack?.recentChapterContents) ? pack.recentChapterContents.length : 0,
    styleExemplarCount: Array.isArray(pack?.styleExemplars) ? pack.styleExemplars.length : 0,
    gapCount: Array.isArray(pack?.gaps) ? pack.gaps.length : 0,
    characterStateChars: (pack?.characterStates || "").length,
  },
  notes: ["Cross-pack thril deltas are instrument-sensitive"],
}

const fixture = {
  generatedAt: new Date().toISOString(),
  packKind: packJson ? "production-measurement" : "production-measurement-offline",
  protocol,
  project: resolve(project),
  chapter,
  sampleChars: chapterText.length,
  pack,
  chapterText,
  prompts: { old: {} },
  windowNote: `full chapterText; N=${samples} NEW-only; model ${model}; fp=${measurementFingerprint.id.slice(0, 12)}`,
  diagnosis: {
    mode: "NEW_only",
    samples,
    label,
    product_hard_gate: false,
    same_model_required: true,
  },
  measurementFingerprint,
}

const outPath = resolve(out)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(fixture, null, 2), "utf8")
console.log(JSON.stringify({
  ok: true,
  out: outPath,
  sampleChars: fixture.sampleChars,
  model,
  samples,
  packKind: fixture.packKind,
  label,
  outlineChars: fixture.measurementFingerprint?.shape?.outlineChars,
  packHash: fixture.measurementFingerprint?.packHash?.slice(0, 8),
  fp: fixture.measurementFingerprint?.id?.slice(0, 12),
}, null, 2))
