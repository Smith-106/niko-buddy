/**
 * Literary gold scale (mid-loop) — human-anchored calibration for Track B "9-band".
 *
 * Problem: LLM thril medians float 5.8–8.2 under pack change; without human gold
 * segments, "break 9" is uncalibrated. This module does NOT set product hard gates.
 *
 * Sources (priority):
 *  1. `.novel/literary-gold-anchors.json` (explicit human / provisional anchors)
 *  2. style-exemplars with markType thrill|pull (positive style anchors)
 *
 * Pure helpers + optional Node-less load path via injected lists.
 */
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadStyleExemplars, type StyleExemplar } from "./style-exemplars-loader"

export const LITERARY_GOLD_SCALE_SCHEMA = "literary-gold-scale/1.0" as const

/**
 * Calibration bands (not product gates).
 * - humanGoldFloor 9: author-confirmed segments exemplify publishable thril band
 * - reviewerBiasDominant 8.3: step0 instrument hypothesis threshold (unchanged)
 * - mixedLower 7.5: mixed zone floor for narrative only
 */
export const GOLD_THRILL_BANDS = {
  /** NEW median ≥ this → reviewer-bias dominant hypothesis (step0 instrument) */
  reviewerBiasDominant: 8.3,
  /** Soft "publishable literary thril" target for human gold segments */
  humanGoldFloor: 9.0,
  /** Mixed zone lower */
  mixedLower: 7.5,
} as const

/** Default targetScore for new/imported anchors (Track B gold band). */
export const DEFAULT_GOLD_TARGET_SCORE = GOLD_THRILL_BANDS.humanGoldFloor

export type GoldAnchorStatus = "human_confirmed" | "provisional" | "rejected"

export type GoldAnchorDimension = "thrill" | "pull" | "pacing" | "character" | "style"

export interface LiteraryGoldAnchor {
  id: string
  dimension: GoldAnchorDimension
  /** Target score band this segment exemplifies (default 9-band). */
  targetScore: number
  text: string
  chapterId?: string
  note?: string
  status: GoldAnchorStatus
  /** ISO time */
  createdAt?: string
  source?: "human" | "exemplar_import" | "provisional_seed"
}

export interface LiteraryGoldScaleFile {
  schemaVersion: typeof LITERARY_GOLD_SCALE_SCHEMA
  projectNote?: string
  anchors: LiteraryGoldAnchor[]
}

export interface GoldScaleReadiness {
  /** True when ≥min human_confirmed thril anchors exist for thril≈9 calibration. */
  readyForThrill9Calibration: boolean
  /**
   * @deprecated Alias of readyForThrill9Calibration (retarget 8→9). Prefer the 9 name.
   */
  readyForThrill8Calibration: boolean
  humanConfirmedThrillCount: number
  provisionalThrillCount: number
  exemplarThrillCount: number
  exemplarPullCount: number
  minHumanConfirmedRequired: number
  targetBand: number
  warnings: string[]
  /** Short block for review prompts when ready or provisional. */
  promptHint: string
}

export const MIN_HUMAN_CONFIRMED_THRILL_FOR_SEAL = 3

export function normalizeGoldAnchorsFile(raw: unknown): LiteraryGoldScaleFile {
  if (!raw || typeof raw !== "object") {
    return { schemaVersion: LITERARY_GOLD_SCALE_SCHEMA, anchors: [] }
  }
  const obj = raw as { schemaVersion?: string; projectNote?: string; anchors?: unknown }
  const list = Array.isArray(obj.anchors) ? obj.anchors : []
  const anchors: LiteraryGoldAnchor[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const a = item as Record<string, unknown>
    const text = String(a.text ?? "").trim()
    if (!text) continue
    const dim = String(a.dimension ?? "thrill") as GoldAnchorDimension
    const status = (String(a.status ?? "provisional") as GoldAnchorStatus) || "provisional"
    anchors.push({
      id: String(a.id ?? `gold-${anchors.length + 1}`),
      dimension: ["thrill", "pull", "pacing", "character", "style"].includes(dim) ? dim : "thrill",
      targetScore:
        typeof a.targetScore === "number" && Number.isFinite(a.targetScore)
          ? a.targetScore
          : DEFAULT_GOLD_TARGET_SCORE,
      text,
      chapterId: a.chapterId != null ? String(a.chapterId) : undefined,
      note: a.note != null ? String(a.note) : undefined,
      status: ["human_confirmed", "provisional", "rejected"].includes(status)
        ? status
        : "provisional",
      createdAt: a.createdAt != null ? String(a.createdAt) : undefined,
      source:
        a.source === "human" || a.source === "exemplar_import" || a.source === "provisional_seed"
          ? a.source
          : undefined,
    })
  }
  return {
    schemaVersion: LITERARY_GOLD_SCALE_SCHEMA,
    projectNote: obj.projectNote != null ? String(obj.projectNote) : undefined,
    anchors,
  }
}

export function goldAnchorsFromExemplars(exemplars: StyleExemplar[]): LiteraryGoldAnchor[] {
  return exemplars
    .filter((e) => e.markType === "thrill" || e.markType === "pull")
    .map((e, i) => ({
      id: `ex-${e.exemplarId || i}`,
      dimension: e.markType === "pull" ? "pull" : "thrill",
      targetScore: DEFAULT_GOLD_TARGET_SCORE,
      text: e.text,
      chapterId: e.chapterId,
      note: e.note ?? "imported from style-exemplars markType",
      status: "provisional" as const,
      createdAt: e.createdAt,
      source: "exemplar_import" as const,
    }))
}

/**
 * Assess whether the project can calibrate thril≈9 claims.
 * Seal-grade readiness requires ≥3 human_confirmed thrill anchors.
 * Does NOT invent a product hard gate on thril/overall.
 */
export function assessGoldScaleReadiness(input: {
  anchors?: LiteraryGoldAnchor[]
  exemplars?: StyleExemplar[]
  minHumanConfirmed?: number
}): GoldScaleReadiness {
  const min = input.minHumanConfirmed ?? MIN_HUMAN_CONFIRMED_THRILL_FOR_SEAL
  const anchors = input.anchors ?? []
  const exemplars = input.exemplars ?? []
  const targetBand = GOLD_THRILL_BANDS.humanGoldFloor
  const thrillHuman = anchors.filter(
    (a) => a.dimension === "thrill" && a.status === "human_confirmed" && a.text.length >= 20,
  )
  const thrillProv = anchors.filter(
    (a) => a.dimension === "thrill" && a.status === "provisional" && a.text.length >= 20,
  )
  const exThrill = exemplars.filter((e) => e.markType === "thrill")
  const exPull = exemplars.filter((e) => e.markType === "pull")
  const warnings: string[] = []
  if (thrillHuman.length < min) {
    warnings.push(
      `human_confirmed thrill anchors ${thrillHuman.length} < ${min} — thril≥${targetBand} claims remain uncalibrated`,
    )
  }
  if (exThrill.length === 0 && thrillHuman.length === 0 && thrillProv.length === 0) {
    warnings.push(`no thrill gold text (anchors or exemplars) — model has no ${targetBand}-band few-shot`)
  }
  if (exThrill.length === 0 && exemplars.length > 0) {
    warnings.push("style-exemplars present but none markType=thrill — re-mark high thril passages")
  }
  const ready = thrillHuman.length >= min
  const promptHint = ready
    ? `金标量程就绪：${thrillHuman.length} 条 human_confirmed thril≈${targetBand} 锚段；评审 thril 时以这些段为 9–10 档参照（非产品硬门）。`
    : `金标量程未就绪：仅 provisional=${thrillProv.length} / exemplar-thrill=${exThrill.length} / human=${thrillHuman.length}（需≥${min} human_confirmed）。thril 中位不可单独证明「已破 ${targetBand}」。`

  return {
    readyForThrill9Calibration: ready,
    readyForThrill8Calibration: ready,
    humanConfirmedThrillCount: thrillHuman.length,
    provisionalThrillCount: thrillProv.length,
    exemplarThrillCount: exThrill.length,
    exemplarPullCount: exPull.length,
    minHumanConfirmedRequired: min,
    targetBand,
    warnings,
    promptHint,
  }
}

/**
 * Build optional few-shot block for dimension review prompts (Track B thril/pull).
 * Prefer human_confirmed; fall back to provisional (labeled).
 */
export function formatGoldScalePromptBlock(
  anchors: LiteraryGoldAnchor[],
  options?: { dimension?: GoldAnchorDimension; max?: number; maxChars?: number },
): string {
  const dim = options?.dimension ?? "thrill"
  const max = options?.max ?? 3
  const maxChars = options?.maxChars ?? 280
  const confirmed = anchors.filter((a) => a.dimension === dim && a.status === "human_confirmed")
  const provisional = anchors.filter((a) => a.dimension === dim && a.status === "provisional")
  const pick = (confirmed.length > 0 ? confirmed : provisional).slice(0, max)
  if (pick.length === 0) return ""
  const tag = confirmed.length > 0 ? "human_confirmed" : "provisional"
  const lines = pick.map((a, i) => {
    const t = a.text.length > maxChars ? `${a.text.slice(0, maxChars)}…` : a.text
    return `${i + 1}. [target≈${a.targetScore}|${tag}] ${t}`
  })
  return [
    `【文学金标 ${dim} 量程参照 · ${tag} · 非产品硬门】`,
    `以下片段代表人类认可的约 ${GOLD_THRILL_BANDS.humanGoldFloor}+ / 9–10 档，仅作量程锚，不得把 thril/overall≥9 写成产品硬门。`,
    ...lines,
  ].join("\n")
}

/** Merge file anchors + exemplar-derived provisional (dedupe by text prefix). */
export function mergeGoldAnchorsWithExemplars(
  fileAnchors: LiteraryGoldAnchor[],
  exemplars: StyleExemplar[],
): LiteraryGoldAnchor[] {
  const out = [...fileAnchors]
  const seen = new Set(fileAnchors.map((a) => a.text.slice(0, 80)))
  for (const a of goldAnchorsFromExemplars(exemplars)) {
    const key = a.text.slice(0, 80)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}


/** On-disk gold anchors filename (relative to `.novel/`). */
export const LITERARY_GOLD_ANCHORS_FILENAME = "literary-gold-anchors.json"

/**
 * Load project literary gold anchors. Missing file → empty anchors (normal).
 * Corrupt JSON → empty anchors + soft fail (do not break review path).
 */
export async function loadLiteraryGoldAnchors(projectPath: string): Promise<LiteraryGoldAnchor[]> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/.novel/${LITERARY_GOLD_ANCHORS_FILENAME}`
  try {
    const raw = await readFile(filePath)
    const parsed = JSON.parse(raw) as unknown
    return normalizeGoldAnchorsFile(parsed).anchors
  } catch {
    return []
  }
}

/**
 * Load gold anchors + style exemplars and merge for readiness / prompt use.
 */
export async function loadGoldScaleMaterials(projectPath: string): Promise<{
  anchors: LiteraryGoldAnchor[]
  exemplars: StyleExemplar[]
  merged: LiteraryGoldAnchor[]
}> {
  const [fileAnchors, exemplars] = await Promise.all([
    loadLiteraryGoldAnchors(projectPath),
    loadStyleExemplars(projectPath).catch(() => [] as StyleExemplar[]),
  ])
  return {
    anchors: fileAnchors,
    exemplars,
    merged: mergeGoldAnchorsWithExemplars(fileAnchors, exemplars),
  }
}
