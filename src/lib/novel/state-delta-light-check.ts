/**
 * Quality Foundation v1 / FR-C1: post-draft StateDelta light-check.
 * Pattern: character-arc light-check (delta vs prior state) — not a full port.
 * Default policy: warn-only (stateDeltaBlocksTrackA=false).
 */

import type { CharacterState } from "./character-state"
import type { NovelReviewResult } from "./review-adapter"

export type LightIssueSeverity = "info" | "warn" | "error"

export interface StateDelta {
  chapter: number
  locationChanges?: Array<{ entity: string; from?: string; to: string }>
  statusChanges?: Array<{ entity: string; status: string }>
  inventoryChanges?: Array<{ entity: string; item: string; op: "gain" | "lose" }>
  relationshipChanges?: Array<{ a: string; b: string; note: string }>
  /** Characters observed active in draft text (names). */
  activeMentions?: string[]
  rawNotes?: string
}

export interface LightIssue {
  code: string
  severity: LightIssueSeverity
  message: string
  entity?: string
  evidence?: string
}

const DEAD_STATUS_RE = /死|亡|牺牲|殒命|遇害|身亡|阵亡|驾崩|去世/

export function findCharacter(
  prev: readonly CharacterState[],
  name: string,
): CharacterState | undefined {
  const key = name.trim()
  if (!key) return undefined
  return prev.find((c) => c.characterName === key)
    ?? prev.find((c) => c.characterName.includes(key) || key.includes(c.characterName))
}

export function isCharacterDead(c: CharacterState): boolean {
  if (c.isAlive === false) return true
  if (typeof c.deathChapter === "number" && c.deathChapter >= 0) return true
  return DEAD_STATUS_RE.test(c.status ?? "")
}

/**
 * Pure light-check: prior character states + proposed delta → issues.
 * Does not I/O or mutate stores.
 */
export function runLightCheck(
  prev: readonly CharacterState[],
  delta: StateDelta,
): LightIssue[] {
  const issues: LightIssue[] = []

  for (const ch of delta.locationChanges ?? []) {
    const cur = findCharacter(prev, ch.entity)
    if (!cur) {
      issues.push({
        code: "unknown_entity_location",
        severity: "info",
        message: `位置变更引用未知角色「${ch.entity}」`,
        entity: ch.entity,
      })
      continue
    }
    if (ch.from && cur.currentLocation && ch.from !== cur.currentLocation) {
      issues.push({
        code: "location_from_mismatch",
        severity: "warn",
        message: `「${ch.entity}」声明从「${ch.from}」出发，但状态库位置为「${cur.currentLocation}」`,
        entity: ch.entity,
        evidence: `from=${ch.from}; store=${cur.currentLocation}`,
      })
    }
    if (isCharacterDead(cur)) {
      issues.push({
        code: "dead_character_location",
        severity: "error",
        message: `已故角色「${ch.entity}」出现位置变更「${ch.to}」`,
        entity: ch.entity,
        evidence: cur.status,
      })
    }
  }

  for (const ch of delta.statusChanges ?? []) {
    const cur = findCharacter(prev, ch.entity)
    if (!cur) continue
    if (isCharacterDead(cur) && !DEAD_STATUS_RE.test(ch.status)) {
      issues.push({
        code: "dead_character_status_revive",
        severity: "error",
        message: `已故角色「${ch.entity}」状态被改为「${ch.status}」且未见死亡标记`,
        entity: ch.entity,
        evidence: cur.status,
      })
    }
  }

  for (const inv of delta.inventoryChanges ?? []) {
    const cur = findCharacter(prev, inv.entity)
    if (!cur) {
      issues.push({
        code: "unknown_entity_inventory",
        severity: "info",
        message: `物品变更引用未知角色「${inv.entity}」`,
        entity: inv.entity,
      })
      continue
    }
    if (inv.op === "lose") {
      const has = (cur.equipment ?? []).some(
        (e) => e === inv.item || e.includes(inv.item) || inv.item.includes(e),
      )
      if (!has) {
        issues.push({
          code: "inventory_lose_missing",
          severity: "warn",
          message: `「${inv.entity}」失去「${inv.item}」，但状态库装备列表中未找到`,
          entity: inv.entity,
          evidence: (cur.equipment ?? []).join("、") || "（空）",
        })
      }
    }
  }

  for (const name of delta.activeMentions ?? []) {
    const cur = findCharacter(prev, name)
    if (!cur) continue
    if (isCharacterDead(cur)) {
      issues.push({
        code: "dead_character_active",
        severity: "error",
        message: `已故角色「${cur.characterName}」在本章正文中仍呈活跃描写`,
        entity: cur.characterName,
        evidence: cur.status || `deathChapter=${cur.deathChapter}`,
      })
    }
  }

  // Location vs draft mention: if delta says character moves to X but store already
  // has X, treat as info (no-op move); if draft-implied to conflicts with store without from — covered above.

  return dedupeIssues(issues)
}

function dedupeIssues(issues: LightIssue[]): LightIssue[] {
  const seen = new Set<string>()
  const out: LightIssue[] = []
  for (const i of issues) {
    /* v8 ignore next */
    const k = `${i.code}|${i.entity ?? ""}|${i.message}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(i)
  }
  return out
}

/**
 * Heuristic StateDelta from draft text + prior states (no LLM).
 * - activeMentions: prior characters whose names appear in draft
 * - inventory lose: 「失去/丢掉/交出」 + equipment item near character context (global scan)
 * - location: 「{name}…在{place}」 weak regex when place ≠ store location
 */
export function extractStateDeltaHeuristic(
  draft: string,
  prev: readonly CharacterState[],
  chapter: number,
): StateDelta {
  const text = draft ?? ""
  const activeMentions: string[] = []
  const locationChanges: NonNullable<StateDelta["locationChanges"]> = []
  const inventoryChanges: NonNullable<StateDelta["inventoryChanges"]> = []

  for (const c of prev) {
    const name = c.characterName?.trim()
    if (!name || name.length < 2) continue
    if (!text.includes(name)) continue
    activeMentions.push(name)

    // Weak location: name … 在 + short place (stop at 门/口/前… or punctuation).
    try {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(
        `${escaped}(?:[^。！？\\n]{0,24})?在([\\u4e00-\\u9fff]{2,6}?)(?=[门口前后旁里外上下左右边附近着了]|[，。！？\\s]|$)`,
      )
      const m = text.match(re)
      const place = m?.[1]
      if (
        place
        && c.currentLocation
        && place !== c.currentLocation
        && !c.currentLocation.includes(place)
        && !place.includes(c.currentLocation)
      ) {
        locationChanges.push({
          entity: name,
          from: c.currentLocation,
          to: place,
        })
      }
    } catch {
      // invalid name for regex — skip location heuristic
    }

    for (const item of c.equipment ?? []) {
      if (!item || item.length < 2) continue
      if (!text.includes(item)) continue
      if (/失去|丢掉|交出|被夺|遗失|销毁/.test(text)) {
        inventoryChanges.push({ entity: name, item, op: "lose" })
      }
    }
  }

  return {
    chapter,
    activeMentions,
    locationChanges: locationChanges.length ? locationChanges : undefined,
    inventoryChanges: inventoryChanges.length ? inventoryChanges : undefined,
    rawNotes: "heuristic",
  }
}

/**
 * Map light issues → NovelReviewResult.
 * When blocksTrackA is false, severity is capped at warning (errors demoted).
 */
export function lightIssuesToReviewResults(
  issues: LightIssue[],
  options: { blocksTrackA?: boolean; chapter?: number } = {},
): NovelReviewResult[] {
  const blocks = options.blocksTrackA === true
  return issues.map((issue) => {
    let severity: NovelReviewResult["severity"] =
      issue.severity === "error" ? "error" : issue.severity === "info" ? "info" : "warning"
    if (!blocks && severity === "error") severity = "warning"
    return {
      severity,
      type: "state_delta_light_check",
      message: issue.message,
      evidence: issue.evidence ?? issue.code,
      relatedMemory: issue.entity ? `character:${issue.entity}` : "character-states",
      suggestion: blocks
        ? "核对 .novel/character-states 与正文；必要时修正状态或正文。"
        : "（warn-only）建议核对角色状态与正文；默认不阻断 Track A。",
      continuityMeta: {
        subtype: issue.code,
        ref: `state-delta:${issue.code}:${issue.entity ?? "na"}`,
        chapter: options.chapter ?? 0,
      },
    }
  })
}

/**
 * Pull optional embedded StateDelta JSON from draft:
 * - fenced block marked state-delta / statedelta
 * - or any ```json object with locationChanges/activeMentions keys
 */
export function extractEmbeddedStateDeltaJson(draft: string): string | null {
  if (!draft?.trim()) return null
  const labeled = draft.match(/```(?:json)?\s*state[-_]?delta\s*([\s\S]*?)```/i)
  if (labeled?.[1]?.trim()) return labeled[1].trim()
  const fences = [...draft.matchAll(/```json\s*([\s\S]*?)```/gi)]
  for (const m of fences) {
    const body = m[1]?.trim()
    if (!body) continue
    if (/"(?:locationChanges|activeMentions|inventoryChanges|statusChanges)"/.test(body)) {
      return body
    }
  }
  return null
}

/**
 * Parse model/tool JSON into StateDelta. Returns null if invalid / empty.
 * Accepts fenced ```json blocks or raw object.
 */
export function parseStructuredStateDelta(
  raw: string,
  chapter: number,
): StateDelta | null {
  if (!raw?.trim()) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) text = fence[1].trim()
  try {
    const obj = JSON.parse(text) as unknown
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    const rec = obj as Record<string, unknown>
    const delta: StateDelta = {
      chapter: typeof rec.chapter === "number" ? rec.chapter : chapter,
      rawNotes: typeof rec.rawNotes === "string" ? rec.rawNotes : "structured",
    }
    if (Array.isArray(rec.locationChanges)) {
      delta.locationChanges = rec.locationChanges
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          entity: String(x.entity ?? ""),
          from: x.from != null ? String(x.from) : undefined,
          to: String(x.to ?? ""),
        }))
        .filter((x) => x.entity && x.to)
    }
    if (Array.isArray(rec.statusChanges)) {
      delta.statusChanges = rec.statusChanges
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ entity: String(x.entity ?? ""), status: String(x.status ?? "") }))
        .filter((x) => x.entity && x.status)
    }
    if (Array.isArray(rec.inventoryChanges)) {
      delta.inventoryChanges = rec.inventoryChanges
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          entity: String(x.entity ?? ""),
          item: String(x.item ?? ""),
          op: x.op === "gain" ? "gain" as const : "lose" as const,
        }))
        .filter((x) => x.entity && x.item)
    }
    if (Array.isArray(rec.relationshipChanges)) {
      delta.relationshipChanges = rec.relationshipChanges
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          a: String(x.a ?? ""),
          b: String(x.b ?? ""),
          note: String(x.note ?? ""),
        }))
        .filter((x) => x.a && x.b)
    }
    if (Array.isArray(rec.activeMentions)) {
      delta.activeMentions = rec.activeMentions.map((x) => String(x)).filter(Boolean)
    }
    const hasBody =
      (delta.locationChanges?.length ?? 0) > 0
      || (delta.statusChanges?.length ?? 0) > 0
      || (delta.inventoryChanges?.length ?? 0) > 0
      || (delta.relationshipChanges?.length ?? 0) > 0
      || (delta.activeMentions?.length ?? 0) > 0
    return hasBody ? delta : null
  } catch {
    return null
  }
}

/** Prefer structured delta when valid; else heuristic. */
export function resolveStateDeltaForDraft(
  draft: string,
  prev: readonly CharacterState[],
  chapter: number,
  structuredRaw?: string | null,
): { delta: StateDelta; source: "structured" | "heuristic" | "empty" } {
  if (!draft?.trim()) {
    return { delta: { chapter, rawNotes: "empty" }, source: "empty" }
  }
  if (structuredRaw) {
    const structured = parseStructuredStateDelta(structuredRaw, chapter)
    if (structured) return { delta: structured, source: "structured" }
  }
  return {
    delta: extractStateDeltaHeuristic(draft, prev, chapter),
    source: "heuristic",
  }
}

/** Run extract → check → review results. Empty draft → info skip. Structured optional. */
export function runStateDeltaLightCheckOnDraft(
  draft: string,
  prev: readonly CharacterState[],
  chapter: number,
  options: { blocksTrackA?: boolean; structuredRaw?: string | null } = {},
): {
  delta: StateDelta
  issues: LightIssue[]
  reviewResults: NovelReviewResult[]
  source: "structured" | "heuristic" | "empty"
} {
  if (!draft?.trim()) {
    const issues: LightIssue[] = [{
      code: "extract_skipped_empty_draft",
      severity: "info",
      message: "StateDelta light-check skipped: empty draft",
    }]
    return {
      delta: { chapter, rawNotes: "empty" },
      issues,
      reviewResults: lightIssuesToReviewResults(issues, { ...options, chapter }),
      source: "empty",
    }
  }
  const { delta, source } = resolveStateDeltaForDraft(
    draft,
    prev,
    chapter,
    options.structuredRaw,
  )
  const issues = runLightCheck(prev, delta)
  return {
    delta,
    issues,
    reviewResults: lightIssuesToReviewResults(issues, { ...options, chapter }),
    source,
  }
}
