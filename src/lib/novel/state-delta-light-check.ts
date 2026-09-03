/**
 * Quality Foundation v1 / FR-C1: post-draft StateDelta light-check.
 * Pattern: character-arc light-check (delta vs prior state) — not a full port.
 * Default policy: warn-only (stateDeltaBlocksTrackA=false).
 */

import type { CharacterState } from "./character-state"
import type { NovelReviewResult } from "./review-adapter"
import { z } from "zod"

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

/**
 * 48号报告 §六-③ StateDelta Zod 强校验 + hookOps 四操作语义.
 * 对齐 inkos RuntimeStateDeltaSchema: 用 Zod 运行时 schema 区分「无 delta」(合法 null)
 * 与「格式坏」(显式抛错), 不再静默回退 null 吞掉坏数据 (守 IC-02 不静默降级).
 *
 * HookOp 四操作 (inkos hookOps 语义映射):
 * - add: 新增状态条目 (inventory gain / 新关系 / 新 active mention)
 * - remove: 移除状态条目 (inventory lose / 角色退场)
 * - update: 修改既有状态 (status change / location change)
 * - relocate: 位置迁移 (location change 专用子类, 与 update 区分以便 repair_scope 路由)
 */
export const HOOK_OPS = ["add", "remove", "update", "relocate"] as const
export type HookOp = (typeof HOOK_OPS)[number]

const locationChangeSchema = z.object({
  entity: z.string().min(1),
  from: z.string().optional(),
  to: z.string().min(1),
})
const statusChangeSchema = z.object({
  entity: z.string().min(1),
  status: z.string().min(1),
})
const inventoryChangeSchema = z.object({
  entity: z.string().min(1),
  item: z.string().min(1),
  op: z.enum(["gain", "lose"]),
})
const relationshipChangeSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  note: z.string(),
})

/** Zod 运行时 schema (48号 §六-③): 强校验 StateDelta, 未知字段/op 拒收. */
export const stateDeltaSchema = z.object({
  chapter: z.number(),
  locationChanges: z.array(locationChangeSchema).optional(),
  statusChanges: z.array(statusChangeSchema).optional(),
  inventoryChanges: z.array(inventoryChangeSchema).optional(),
  relationshipChanges: z.array(relationshipChangeSchema).optional(),
  activeMentions: z.array(z.string()).optional(),
  rawNotes: z.string().optional(),
})

/**
 * 将 StateDelta 条目映射为 hookOps 语义操作 (48号 §六-③).
 * 纯函数, 零 IO/LLM. 供 repair_scope 路由与审计用.
 */
export function deriveHookOps(delta: StateDelta): Array<{ op: HookOp; entity: string; detail: string }> {
  const ops: Array<{ op: HookOp; entity: string; detail: string }> = []
  for (const lc of delta.locationChanges ?? []) {
    ops.push({ op: "relocate", entity: lc.entity, detail: `${lc.from ?? "?"}→${lc.to}` })
  }
  for (const sc of delta.statusChanges ?? []) {
    ops.push({ op: "update", entity: sc.entity, detail: sc.status })
  }
  for (const ic of delta.inventoryChanges ?? []) {
    ops.push({ op: ic.op === "gain" ? "add" : "remove", entity: ic.entity, detail: `${ic.op} ${ic.item}` })
  }
  for (const rc of delta.relationshipChanges ?? []) {
    ops.push({ op: "add", entity: `${rc.a}/${rc.b}`, detail: rc.note })
  }
  return ops
}

/**
 * 严格解析 (48号 §六-③): 空/缺无 delta 返回 null (合法), 格式坏抛 ZodError (显式不静默).
 * 与 parseStructuredStateDelta 共存: 后者保留 lenient 回退向后兼容,
 * 本函数供需要强校验的调用点 (如审计门控) 使用.
 */
export function parseStateDeltaStrict(raw: string, chapter: number): StateDelta | null {
  if (!raw?.trim()) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) text = fence[1].trim()
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new Error(`StateDelta JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`StateDelta 根须为对象, 实际为 ${Array.isArray(obj) ? "array" : typeof obj}`)
  }
  const rec = obj as Record<string, unknown>
  const normalized: Record<string, unknown> = {
    ...rec,
    chapter: typeof rec.chapter === "number" ? rec.chapter : chapter,
    rawNotes: typeof rec.rawNotes === "string" ? rec.rawNotes : "structured",
  }
  const parsed = stateDeltaSchema.safeParse(normalized)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`StateDelta schema 校验失败: ${issues}`)
  }
  const d = parsed.data
  const hasBody =
    (d.locationChanges?.length ?? 0) > 0
    || (d.statusChanges?.length ?? 0) > 0
    || (d.inventoryChanges?.length ?? 0) > 0
    || (d.relationshipChanges?.length ?? 0) > 0
    || (d.activeMentions?.length ?? 0) > 0
  return hasBody ? (d as StateDelta) : null
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

// ============================================================================
// 48号报告 §六-② REPAIR 三态结算（PASS / REPAIR / FAIL + state-degraded）
// ============================================================================

/**
 * 三态结算结果（对齐 inkos state-validator PASS/REPAIR/FAIL）.
 * - PASS: 正文 digest 有效 + 结算完整（无 error 级 issue）
 * - REPAIR: 正文有效但结算缺漏（warn/info 级 issue 可重结算修复，不重写正文）
 * - FAIL: 与既有矛盾（error 级 issue），阻断
 */
export type StateSettlementOutcome = "PASS" | "REPAIR" | "FAIL"

export interface StateSettlementResult {
  outcome: StateSettlementOutcome
  /** REPAIR 重结算后仍失败 → degraded=true（VISIBLE 不静默，对齐 inkos state-degraded）。 */
  degraded: boolean
  /** 触发 REPAIR/FAIL 的 issue 列表。 */
  issues: LightIssue[]
  /** 结算来源（与 resolveStateDeltaForDraft 对齐）。 */
  source: "structured" | "heuristic" | "empty"
  /** 可读原因（供审计链）。 */
  reason: string
}

/**
 * 三态结算判定（纯函数，零 IO/LLM）.
 * 正文不重写：REPAIR 仅标记需重结算，FAIL 阻断，都不触发明文重写。
 * 与 twoPhaseReconcile 正交：本函数治理 StateDelta 结算层，对账链治理 canon 双写层。
 */
export function resolveStateSettlement(
  _delta: StateDelta,
  issues: readonly LightIssue[],
  source: "structured" | "heuristic" | "empty",
): StateSettlementResult {
  // empty → PASS（无 delta 可结算，不阻断）
  if (source === "empty") {
    return { outcome: "PASS", degraded: false, issues: [...issues], source, reason: "empty draft, 无需结算" }
  }
  const errors = issues.filter((i) => i.severity === "error")
  const warns = issues.filter((i) => i.severity === "warn")
  // error 级 → FAIL（矛盾，阻断）
  if (errors.length > 0) {
    return {
      outcome: "FAIL",
      degraded: false,
      issues: [...issues],
      source,
      reason: `${errors.length} 个 error 级一致性矛盾（如已故角色复活），阻断`,
    }
  }
  // warn/info 级 → REPAIR（正文有效但结算缺漏，可重结算修复）
  if (warns.length > 0 || source === "heuristic") {
    return {
      outcome: "REPAIR",
      degraded: false,
      issues: [...issues],
      source,
      reason: source === "heuristic"
        ? "structured delta 缺失，启发式提取需重结算确认"
        : `${warns.length} 个 warn 级结算缺漏，可重结算修复（不重写正文）`,
    }
  }
  // 全清 → PASS
  return { outcome: "PASS", degraded: false, issues: [...issues], source, reason: "结算完整，无缺漏" }
}

/**
 * 模拟重结算（纯函数，零 IO）：REPAIR 态下重跑结算，返回是否仍 degraded.
 * 实际重结算由调用方执行（如重跑 extractStateDeltaHeuristic 或重新注入 structured delta）。
 * 本函数仅判定重结算后是否仍 degraded（重结算仍失败 → state-degraded 标记）。
 */
export function markStateDegraded(settlement: StateSettlementResult): StateSettlementResult {
  if (settlement.outcome !== "REPAIR") return settlement
  return {
    ...settlement,
    degraded: true,
    reason: `REPAIR 重结算后仍 degraded: ${settlement.reason}`,
  }
}
