// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * atomic-read-tools.ts — Phase 2 五项零 LLM / 零写盘 / 零外网原子只读 MCP 工具门面。
 *
 * 严格依赖纪律：
 * 1. 所有 novel 域能力均经 `@/lib/novel` 顶层 barrel 导入（零深导入）；
 * 2. 严格零 LLM 调用、零磁盘写入、零出网请求（`searchWiki` 显式关闭 vector 与 rerank，
 *    `outline.read` 绝不调用 `searchWiki`）；
 * 3. 与 Rust 侧 `tools.rs` 1:1 对齐参数与返回契约：
 *    - `foreshadowing.list` (`foreshadowing-list`)
 *    - `character.read` (`character-read`)
 *    - `outline.read` (`outline-read`)
 *    - `style.exemplars` (`style-exemplars`)
 *    - `chapter.search` (`chapter-search`)
 */

import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  STYLE_EXEMPLAR_TEXT_MAX_CHARS,
  STYLE_EXEMPLARS_TOP_K,
  analyzeForeshadowingDebt,
  excludeDeadFromCast,
  flattenOutlineChapters,
  flattenOutlineMarkdownFiles,
  getCharacterAuraBindings,
  getForeshadowingWatermark,
  isDraftChapterFile,
  listBindableNovelCharacters,
  listChapterDrafts,
  listCharacterAuras,
  listEntityFiles,
  listScopeFiles,
  loadCharacterStates,
  loadForeshadowingTracker,
  loadOutlineModel,
  loadStyleExemplars,
  parseChapterOrdinal,
  pickTopKExemplars,
  readChapterOutlineDirect,
  readDraftChapterNumber,
  selectOutlineSources,
  type ChapterDraft,
  type CharacterAura,
  type CharacterAuraBinding,
  type CharacterState,
  type CharacterStateStore,
  type EmotionState,
  type Foreshadowing,
  type ForeshadowingDebtItem,
  type ForeshadowingDebtReport,
  type ForeshadowingStatus,
  type ForeshadowingStore,
  type OutlineModelChapter,
  type StyleExemplar,
  type StyleExemplarMarkType,
} from "@/lib/novel"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { searchWiki, tokenizeQuery, type SearchResult } from "@/lib/search"
import type { FileNode } from "@/types/wiki"

const READ_ONLY_META = {
  readOnly: true as const,
  llmCalls: 0 as const,
  diskWrites: 0 as const,
}

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const DEFAULT_OUTLINE_FILE_LIMIT = 16_000
const MAX_OUTLINE_FILE_LIMIT = 50_000
const MAX_OUTLINE_FILENAME_CHARS = 128
const MAX_OUTLINE_WINDOW = 10
const MAX_ENTITY_MARKDOWN_CHARS = 20_000
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const DEFAULT_CONTEXT_CHARS = 120
const MIN_CONTEXT_CHARS = 20
const MAX_CONTEXT_CHARS = 1000
const MAX_QUERY_CHARS = 500
const MAX_LOCAL_CHAPTER_SCAN = 200

const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/
const FORBIDDEN_FILENAME_CHAR_RE = /[\\/:*?"<>|]/

const FORESHADOWING_LIST_KEYS = new Set([
  "status",
  "character",
  "currentChapter",
  "includeDebt",
  "debtLevel",
  "offset",
  "limit",
])
const FORESHADOWING_STATUS_FILTERS = new Set([
  "all",
  "active",
  "planted",
  "advanced",
  "resolved",
  "abandoned",
  "overdue",
])
const DEBT_LEVELS = new Set(["critical", "warning", "normal"])

const CHARACTER_READ_KEYS = new Set([
  "name",
  "query",
  "aliveOnly",
  "includeAura",
  "includeState",
  "includeRelationships",
  "offset",
  "limit",
])

const OUTLINE_READ_KEYS = new Set([
  "chapterNumber",
  "window",
  "volume",
  "filename",
  "includeSummaryOnly",
  "offset",
  "limit",
])

const STYLE_EXEMPLARS_KEYS = new Set([
  "markTypes",
  "category",
  "chapterId",
  "topK",
  "maxCharsPerItem",
  "offset",
  "limit",
])
const VALID_STYLE_MARK_TYPES: readonly StyleExemplarMarkType[] = [
  "style",
  "voice",
  "pacing",
  "thrill",
  "pull",
  "consistency",
]
const VALID_STYLE_MARK_TYPE_SET: ReadonlySet<string> = new Set(VALID_STYLE_MARK_TYPES)

const CHAPTER_SEARCH_KEYS = new Set([
  "query",
  "scope",
  "chapterStart",
  "chapterEnd",
  "limit",
  "contextChars",
])
const CHAPTER_SEARCH_SCOPES = new Set([
  "chapters",
  "all",
  "entities",
  "outlines",
  "memory",
  "drafts",
])

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function assertProjectPath(projectPath: string, toolName: string): string {
  const root = projectRoot(projectPath)
  if (!root) throw new Error(`${toolName} 需要已打开的项目`)
  return root
}

function assertObjectParams(
  params: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  toolName: string,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${toolName} 的 params 必须是对象`)
  }
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${toolName} 的参数未知：${key}`)
    }
  }
  return params
}

function readOptionalBoolean(
  params: Record<string, unknown>,
  field: string,
  toolName: string,
): boolean | undefined {
  const raw = params[field]
  if (raw === undefined) return undefined
  if (typeof raw !== "boolean") {
    throw new Error(`${toolName} 的 ${field} 必须是 boolean，收到 ${typeof raw}`)
  }
  return raw
}

function readOptionalIntInRange(
  params: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  toolName: string,
): number | undefined {
  const raw = params[field]
  if (raw === undefined) return undefined
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${toolName} 的 ${field} 必须是 ${min}..${max} 的整数`)
  }
  return raw
}

function readOptionalNonEmptyString(
  params: Record<string, unknown>,
  field: string,
  toolName: string,
  maxLength = 500,
): string | undefined {
  const raw = params[field]
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${toolName} 的 ${field} 必须是非空字符串`)
  }
  const trimmed = raw.trim()
  if (trimmed.length > maxLength) {
    throw new Error(`${toolName} 的 ${field} 超过 ${maxLength} 字符上限`)
  }
  return trimmed
}

function validateSafeOutlineFilename(raw: unknown, toolName: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${toolName} 的 filename 必须是非空字符串`)
  }
  if (raw !== raw.trim()) {
    throw new Error(`${toolName} 的 filename 不允许包含首尾空白字符`)
  }
  if (raw.length > MAX_OUTLINE_FILENAME_CHARS) {
    throw new Error(`${toolName} 的 filename 超过 ${MAX_OUTLINE_FILENAME_CHARS} 字符上限`)
  }
  if (
    raw.includes("..")
    || FORBIDDEN_FILENAME_CHAR_RE.test(raw)
    || CONTROL_CHAR_RE.test(raw)
  ) {
    throw new Error(`${toolName} 的 filename 非法（禁止路径分隔符、..、冒号或控制字符）：${raw}`)
  }
  if (!raw.toLowerCase().endsWith(".md")) {
    throw new Error(`${toolName} 的 filename 必须以 .md 结尾：${raw}`)
  }
  if (raw.startsWith(".")) {
    throw new Error(`${toolName} 的 filename 不允许以点号开头：${raw}`)
  }
  const stem = raw.slice(0, -3)
  if (!stem || stem.endsWith(".")) {
    throw new Error(`${toolName} 的 filename 缺少有效文件名主体：${raw}`)
  }
  const firstSegment = (stem.split(".")[0] ?? "").trimEnd()
  if (WINDOWS_RESERVED_BASENAME_RE.test(firstSegment)) {
    throw new Error(`${toolName} 的 filename 命中 Windows 保留设备名：${raw}`)
  }
  return raw
}

// ============================================================================
// 1. foreshadowing.list
// ============================================================================

export type ForeshadowingListStatusFilter =
  | "all"
  | "active"
  | "planted"
  | "advanced"
  | "resolved"
  | "abandoned"
  | "overdue"

export interface ForeshadowingListDeps {
  loadTracker: (projectPath: string) => Promise<ForeshadowingStore>
}

export interface ForeshadowingListItem extends Foreshadowing {
  debtLevel: "critical" | "warning" | "normal" | null
  chaptersSincePlanted: number | null
  lastAdvancedChapter: number | null
  chaptersSinceAdvanced: number | null
}

export interface ForeshadowingListResult {
  projectPath: string
  currentChapter: number
  watermarkChapter: number
  lastUpdated: string
  total: number
  filteredTotal: number
  offset: number
  limit: number
  hasMore: boolean
  countsByStatus: Record<ForeshadowingStatus, number>
  items: ForeshadowingListItem[]
  debt?: ForeshadowingDebtReport
  meta: typeof READ_ONLY_META
}

const DEBT_PRIORITY_ORDER: Record<"critical" | "warning" | "normal", number> = {
  critical: 0,
  warning: 1,
  normal: 2,
}

export async function runForeshadowingList(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<ForeshadowingListDeps>,
): Promise<ForeshadowingListResult> {
  const toolName = "foreshadowing.list"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, FORESHADOWING_LIST_KEYS, toolName)

  let status: ForeshadowingListStatusFilter = "all"
  if (params.status !== undefined) {
    if (typeof params.status !== "string" || !FORESHADOWING_STATUS_FILTERS.has(params.status)) {
      throw new Error(
        `${toolName} 的 status 非法：${String(params.status)}（合法值：all, active, planted, advanced, resolved, abandoned, overdue）`,
      )
    }
    status = params.status as ForeshadowingListStatusFilter
  }

  let debtLevelFilter: "critical" | "warning" | "normal" | undefined
  if (params.debtLevel !== undefined) {
    if (typeof params.debtLevel !== "string" || !DEBT_LEVELS.has(params.debtLevel)) {
      throw new Error(
        `${toolName} 的 debtLevel 非法：${String(params.debtLevel)}（合法值：critical, warning, normal）`,
      )
    }
    debtLevelFilter = params.debtLevel as "critical" | "warning" | "normal"
  }

  const characterFilter = readOptionalNonEmptyString(params, "character", toolName, 128)
  const explicitCurrentChapter = readOptionalIntInRange(params, "currentChapter", 1, 100_000, toolName)
  const includeDebtExplicit = readOptionalBoolean(params, "includeDebt", toolName)
  const offset = readOptionalIntInRange(params, "offset", 0, 100_000, toolName) ?? 0
  const limit = readOptionalIntInRange(params, "limit", 1, MAX_PAGE_LIMIT, toolName) ?? DEFAULT_PAGE_LIMIT

  const loadTracker = depsOverrides?.loadTracker ?? loadForeshadowingTracker
  const store = await loadTracker(projectPath)
  const items = Array.isArray(store.items) ? store.items : []
  const watermarkChapter = getForeshadowingWatermark(items)
  const currentChapter = explicitCurrentChapter ?? watermarkChapter

  const debtReport = analyzeForeshadowingDebt(
    { items, lastUpdated: store.lastUpdated ?? "" },
    currentChapter,
  )
  const debtById = new Map<string, ForeshadowingDebtItem>()
  for (const debtItem of debtReport.items) {
    debtById.set(debtItem.id, debtItem)
  }

  const countsByStatus: Record<ForeshadowingStatus, number> = {
    planted: 0,
    advanced: 0,
    resolved: 0,
    abandoned: 0,
  }
  for (const item of items) {
    if (item.status in countsByStatus) {
      countsByStatus[item.status] += 1
    }
  }

  const charNeedle = characterFilter?.toLowerCase()
  const filtered = items.filter((item) => {
    const debtInfo = debtById.get(item.id)
    if (status === "active") {
      if (item.status !== "planted" && item.status !== "advanced") return false
    } else if (status === "overdue") {
      if (item.status !== "planted" && item.status !== "advanced") return false
      if (!debtInfo || (debtInfo.debtLevel !== "warning" && debtInfo.debtLevel !== "critical")) {
        return false
      }
    } else if (status !== "all") {
      if (item.status !== status) return false
    }

    if (debtLevelFilter !== undefined) {
      if (!debtInfo || debtInfo.debtLevel !== debtLevelFilter) return false
    }

    if (charNeedle) {
      const related = Array.isArray(item.relatedCharacters) ? item.relatedCharacters : []
      const hitRelated = related.some((name) => name.toLowerCase().includes(charNeedle))
      const hitDesc = (item.description ?? "").toLowerCase().includes(charNeedle)
      const hitName = (item.name ?? "").toLowerCase().includes(charNeedle)
      if (!hitRelated && !hitDesc && !hitName) return false
    }
    return true
  })

  const enriched: ForeshadowingListItem[] = filtered.map((item) => {
    const debtInfo = debtById.get(item.id)
    return {
      ...item,
      debtLevel: debtInfo?.debtLevel ?? null,
      chaptersSincePlanted: debtInfo?.chaptersSincePlanted ?? null,
      lastAdvancedChapter: debtInfo?.lastAdvancedChapter ?? null,
      chaptersSinceAdvanced: debtInfo?.chaptersSinceAdvanced ?? null,
    }
  })

  enriched.sort((a, b) => {
    const rankA = a.debtLevel ? DEBT_PRIORITY_ORDER[a.debtLevel] : 3
    const rankB = b.debtLevel ? DEBT_PRIORITY_ORDER[b.debtLevel] : 3
    if (rankA !== rankB) return rankA - rankB
    if (a.plantedChapter !== b.plantedChapter) return a.plantedChapter - b.plantedChapter
    return a.id.localeCompare(b.id)
  })

  const paged = enriched.slice(offset, offset + limit)
  const hasMore = offset + paged.length < enriched.length
  const includeDebt =
    includeDebtExplicit ?? (status === "overdue" || debtLevelFilter !== undefined)

  return {
    projectPath,
    currentChapter,
    watermarkChapter,
    lastUpdated: store.lastUpdated ?? "",
    total: items.length,
    filteredTotal: enriched.length,
    offset,
    limit,
    hasMore,
    countsByStatus,
    items: paged,
    ...(includeDebt ? { debt: debtReport } : {}),
    meta: READ_ONLY_META,
  }
}

// ============================================================================
// 2. character.read
// ============================================================================

export interface CharacterReadDeps {
  loadCharacterStates: (projectPath: string) => Promise<CharacterStateStore>
  listBindableNovelCharacters: (projectPath: string) => Promise<string[]>
  getCharacterAuraBindings: (projectPath: string) => Promise<CharacterAuraBinding[]>
  listCharacterAuras: (projectPath: string) => Promise<CharacterAura[]>
  listEntityFiles: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  readFileText: (path: string) => Promise<string>
}

export interface CharacterReadStateProjection {
  currentLocation: string
  status: string
  equipment: string[]
  abilities: string[]
  lastUpdatedChapter: number
  lastUpdatedAt: string
  lastSeenChapter?: number
  emotion?: EmotionState
  relationships?: Record<string, string>
}

export interface CharacterReadAuraProjection {
  binding: CharacterAuraBinding
  aura: {
    id: string
    name: string
    builtIn: boolean
    category: string | null
    sourceNote: string
    styleDescription: string
    behaviorRules: string
    boundaries: string
    expressionDna?: string
    mentalModel?: string
    decisionHeuristics?: string
    valueAntiPatterns?: string
    honestyBoundaries?: string
  } | null
}

export interface CharacterReadRecord {
  name: string
  alive: boolean
  deathChapter: number | null
  bindable: boolean
  entityPath: string | null
  aliases: string[]
  state?: CharacterReadStateProjection | null
  relationships?: Record<string, string>
  aura?: CharacterReadAuraProjection | null
  entityMarkdown?: string | null
}

export interface CharacterReadResult {
  projectPath: string
  total: number
  filteredTotal: number
  offset: number
  limit: number
  hasMore: boolean
  lastUpdated: string
  warnings: string[]
  characters: CharacterReadRecord[]
  meta: typeof READ_ONLY_META
}

function validateSafeCharacterName(raw: unknown, toolName: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${toolName} 的 name 必须是非空字符串`)
  }
  const trimmed = raw.trim()
  if (trimmed.length > 128) {
    throw new Error(`${toolName} 的 name 超过 128 字符上限`)
  }
  if (
    trimmed.includes("/")
    || trimmed.includes("\\")
    || trimmed.includes("..")
    || trimmed.includes("\0")
    || CONTROL_CHAR_RE.test(trimmed)
  ) {
    throw new Error(`${toolName} 的 name 非法（禁止路径分隔符、.. 或控制字符）：${trimmed}`)
  }
  return trimmed
}

function projectCharacterAura(
  binding: CharacterAuraBinding | undefined,
  aurasById: ReadonlyMap<string, CharacterAura>,
): CharacterReadAuraProjection | null {
  if (!binding) return null
  const aura = aurasById.get(binding.auraId)
  return {
    binding,
    aura: aura
      ? {
          id: aura.id,
          name: aura.name,
          builtIn: aura.builtIn,
          category: aura.category ?? null,
          sourceNote: aura.sourceNote,
          styleDescription: aura.styleDescription,
          behaviorRules: aura.behaviorRules,
          boundaries: aura.boundaries,
          ...(aura.expressionDna ? { expressionDna: aura.expressionDna } : {}),
          ...(aura.mentalModel ? { mentalModel: aura.mentalModel } : {}),
          ...(aura.decisionHeuristics ? { decisionHeuristics: aura.decisionHeuristics } : {}),
          ...(aura.valueAntiPatterns ? { valueAntiPatterns: aura.valueAntiPatterns } : {}),
          ...(aura.honestyBoundaries ? { honestyBoundaries: aura.honestyBoundaries } : {}),
        }
      : null,
  }
}

export async function runCharacterRead(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<CharacterReadDeps>,
): Promise<CharacterReadResult> {
  const toolName = "character.read"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, CHARACTER_READ_KEYS, toolName)

  const name = validateSafeCharacterName(params.name, toolName)
  const query = readOptionalNonEmptyString(params, "query", toolName, 200)
  const aliveOnly = readOptionalBoolean(params, "aliveOnly", toolName) ?? false
  const includeAura = readOptionalBoolean(params, "includeAura", toolName) ?? (name !== undefined)
  const includeState = readOptionalBoolean(params, "includeState", toolName) ?? true
  const includeRelationships = readOptionalBoolean(params, "includeRelationships", toolName) ?? true
  const offset = readOptionalIntInRange(params, "offset", 0, 100_000, toolName) ?? 0
  const limit = readOptionalIntInRange(params, "limit", 1, MAX_PAGE_LIMIT, toolName) ?? DEFAULT_PAGE_LIMIT

  const deps: CharacterReadDeps = {
    loadCharacterStates,
    listBindableNovelCharacters,
    getCharacterAuraBindings,
    listCharacterAuras,
    listEntityFiles,
    readFileText: readFile,
    ...depsOverrides,
  }

  const warnings: string[] = []

  const [stateStore, bindableNames, bindings, auras, entityFiles] = await Promise.all([
    deps.loadCharacterStates(projectPath).catch(() => {
      // 脱敏告警：绝不泄露损坏 JSON 原文或内部堆栈
      warnings.push("character-states.json 不可读或已损坏，已降级为空状态表。")
      return { characters: [] as CharacterState[], lastUpdated: "" }
    }),
    deps.listBindableNovelCharacters(projectPath).catch(() => {
      warnings.push("可绑定角色列表扫描降级为空。")
      return [] as string[]
    }),
    deps.getCharacterAuraBindings(projectPath).catch(() => {
      warnings.push("角色灵魂绑定读取降级为空。")
      return [] as CharacterAuraBinding[]
    }),
    includeAura
      ? deps.listCharacterAuras(projectPath).catch(() => {
          warnings.push("角色灵魂库读取降级为空。")
          return [] as CharacterAura[]
        })
      : Promise.resolve([] as CharacterAura[]),
    deps.listEntityFiles(projectPath).catch(() => [] as Array<{ name: string; path: string }>),
  ])

  const stateByLower = new Map<string, CharacterState>()
  const canonicalDisplayByLower = new Map<string, string>()

  const registerName = (rawName: string): string => {
    const trimmed = rawName.trim()
    const key = trimmed.toLowerCase()
    if (!canonicalDisplayByLower.has(key)) {
      canonicalDisplayByLower.set(key, trimmed)
    }
    return canonicalDisplayByLower.get(key)!
  }

  for (const state of stateStore.characters ?? []) {
    if (!state?.characterName?.trim()) continue
    const display = registerName(state.characterName)
    stateByLower.set(display.toLowerCase(), state)
  }

  const bindableLowerSet = new Set<string>()
  for (const bName of bindableNames) {
    if (!bName?.trim()) continue
    const display = registerName(bName)
    bindableLowerSet.add(display.toLowerCase())
  }

  const bindingByLower = new Map<string, CharacterAuraBinding>()
  for (const binding of bindings) {
    if (!binding?.characterName?.trim()) continue
    const display = registerName(binding.characterName)
    bindingByLower.set(display.toLowerCase(), binding)
  }

  const entityPathByLower = new Map<string, string>()
  for (const file of entityFiles) {
    const normPath = normalizePath(file.path)
    const inCharactersDir = /\/entities\/characters\//i.test(normPath)
    const lower = file.name.trim().toLowerCase()
    if (!lower) continue
    if (inCharactersDir) {
      registerName(file.name)
      entityPathByLower.set(lower, normPath)
    } else if (canonicalDisplayByLower.has(lower) && !entityPathByLower.has(lower)) {
      entityPathByLower.set(lower, normPath)
    }
  }

  const aurasById = new Map<string, CharacterAura>()
  for (const aura of auras) {
    aurasById.set(aura.id, aura)
  }

  const allDisplayNames = [...canonicalDisplayByLower.values()]
  const { excluded: deadNames } = excludeDeadFromCast(allDisplayNames, stateStore)
  const deadLowerSet = new Set(deadNames.map((n) => n.toLowerCase()))

  const records: CharacterReadRecord[] = allDisplayNames.map((displayName) => {
    const lower = displayName.toLowerCase()
    const state = stateByLower.get(lower)
    const binding = bindingByLower.get(lower)
    const alive = !deadLowerSet.has(lower)
    const aliases = Array.isArray(binding?.aliases)
      ? binding.aliases.filter((a) => typeof a === "string" && a.trim().length > 0)
      : []

    const record: CharacterReadRecord = {
      name: displayName,
      alive,
      deathChapter: typeof state?.deathChapter === "number" ? state.deathChapter : null,
      bindable: bindableLowerSet.has(lower),
      entityPath: entityPathByLower.get(lower) ?? null,
      aliases,
    }

    if (includeState) {
      if (state) {
        const stateProj: CharacterReadStateProjection = {
          currentLocation: state.currentLocation,
          status: state.status,
          equipment: Array.isArray(state.equipment) ? [...state.equipment] : [],
          abilities: Array.isArray(state.abilities) ? [...state.abilities] : [],
          lastUpdatedChapter: state.lastUpdatedChapter,
          lastUpdatedAt: state.lastUpdatedAt,
          ...(typeof state.lastSeenChapter === "number" ? { lastSeenChapter: state.lastSeenChapter } : {}),
          ...(state.emotion ? { emotion: { ...state.emotion } } : {}),
          ...(includeRelationships ? { relationships: { ...(state.relationships ?? {}) } } : {}),
        }
        record.state = stateProj
      } else {
        record.state = null
      }
    }

    if (includeRelationships) {
      record.relationships = { ...(state?.relationships ?? {}) }
    }

    if (includeAura) {
      record.aura = projectCharacterAura(binding, aurasById)
    }

    return record
  })

  let filtered = records
  if (name !== undefined) {
    const nameLower = name.toLowerCase()
    const exact = records.filter((r) => r.name === name)
    if (exact.length > 0) {
      filtered = exact
    } else {
      filtered = records.filter(
        (r) =>
          r.name.toLowerCase() === nameLower
          || r.aliases.some((alias) => alias.toLowerCase() === nameLower),
      )
    }
  }

  if (query !== undefined) {
    const needle = query.toLowerCase()
    filtered = filtered.filter((r) => {
      if (r.name.toLowerCase().includes(needle)) return true
      if (r.aliases.some((alias) => alias.toLowerCase().includes(needle))) return true
      const state = stateByLower.get(r.name.toLowerCase())
      if (state) {
        if ((state.currentLocation ?? "").toLowerCase().includes(needle)) return true
        if ((state.status ?? "").toLowerCase().includes(needle)) return true
        if ((state.abilities ?? []).some((a) => a.toLowerCase().includes(needle))) return true
        if ((state.equipment ?? []).some((e) => e.toLowerCase().includes(needle))) return true
      }
      if (r.aura?.aura?.name.toLowerCase().includes(needle)) return true
      return false
    })
  }

  if (aliveOnly) {
    filtered = filtered.filter((r) => r.alive)
  }

  filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))

  const paged = filtered.slice(offset, offset + limit)
  const hasMore = offset + paged.length < filtered.length

  // 单角色精确查询时顺带读回其实体页 Markdown（只读、上限截断，不影响列表查询性能）
  if (name !== undefined) {
    for (const item of paged) {
      if (item.entityPath) {
        try {
          const md = await deps.readFileText(item.entityPath)
          item.entityMarkdown =
            md.length > MAX_ENTITY_MARKDOWN_CHARS ? md.slice(0, MAX_ENTITY_MARKDOWN_CHARS) : md
        } catch {
          warnings.push(`角色实体文件读取失败：${item.name}`)
          item.entityMarkdown = null
        }
      } else {
        item.entityMarkdown = null
      }
    }
  }

  return {
    projectPath,
    total: records.length,
    filteredTotal: filtered.length,
    offset,
    limit,
    hasMore,
    lastUpdated: stateStore.lastUpdated ?? "",
    warnings,
    characters: paged,
    meta: READ_ONLY_META,
  }
}

// ============================================================================
// 3. outline.read
// ============================================================================

export interface OutlineReadDeps {
  loadOutlineModel: typeof loadOutlineModel
  readChapterOutlineDirect: (projectPath: string, chapterNumber: number) => Promise<string>
  listDirectory: (path: string) => Promise<FileNode[]>
  readFileText: (path: string) => Promise<string>
}

export interface OutlineChapterSummaryEntry {
  id: string
  volume: number
  chapter: number
  title: string
  pov: string
  arc: string
  goal: string
  entityCount: number
  constraintCount: number
  foreshadowPlantCount: number
  foreshadowPayoffCount: number
}

export interface OutlineReadResult {
  projectPath: string
  mode: "file" | "chapter_window" | "volume" | "overview"
  modelLoaded: boolean
  modelError: string | null
  outlineFiles: Array<{ name: string; path: string }>
  filename?: string
  path?: string
  content?: string
  totalChars?: number
  chapterNumber?: number
  window?: number
  range?: { start: number; end: number }
  volume?: number
  volumes?: Array<{ number: number; title: string; arc: string; chapterCount: number }>
  chapters?: Array<OutlineModelChapter | OutlineChapterSummaryEntry>
  directMarkdown?: string | null
  primaryMarkdown?: string | null
  total: number
  filteredTotal: number
  offset: number
  limit: number
  hasMore: boolean
  meta: typeof READ_ONLY_META
}

function toOutlineChapterSummary(ch: OutlineModelChapter): OutlineChapterSummaryEntry {
  return {
    id: ch.id,
    volume: ch.volume,
    chapter: ch.chapter,
    title: ch.title,
    pov: ch.pov,
    arc: ch.arc,
    goal: ch.prose?.goal ?? "",
    entityCount: Array.isArray(ch.entities) ? ch.entities.length : 0,
    constraintCount: Array.isArray(ch.constraints) ? ch.constraints.length : 0,
    foreshadowPlantCount: Array.isArray(ch.foreshadow?.plant) ? ch.foreshadow.plant.length : 0,
    foreshadowPayoffCount: Array.isArray(ch.foreshadow?.payoff) ? ch.foreshadow.payoff.length : 0,
  }
}

export async function runOutlineRead(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<OutlineReadDeps>,
): Promise<OutlineReadResult> {
  const toolName = "outline.read"
  const root = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, OUTLINE_READ_KEYS, toolName)

  const hasFilename = params.filename !== undefined
  const hasChapterNumber = params.chapterNumber !== undefined
  const hasVolume = params.volume !== undefined
  const hasWindow = params.window !== undefined

  if (hasFilename && (hasChapterNumber || hasVolume || hasWindow)) {
    throw new Error(`${toolName} 参数冲突：filename 与 chapterNumber/volume/window 不能同时传入`)
  }
  if (hasWindow && !hasChapterNumber) {
    throw new Error(`${toolName} 参数冲突：window 必须与 chapterNumber 一起传入`)
  }

  const filename = hasFilename ? validateSafeOutlineFilename(params.filename, toolName) : undefined
  const chapterNumber = readOptionalIntInRange(params, "chapterNumber", 1, 100_000, toolName)
  const windowSize = readOptionalIntInRange(params, "window", 0, MAX_OUTLINE_WINDOW, toolName) ?? 0
  const volume = readOptionalIntInRange(params, "volume", 1, 10_000, toolName)
  const includeSummaryOnly = readOptionalBoolean(params, "includeSummaryOnly", toolName) ?? false
  const offset = readOptionalIntInRange(params, "offset", 0, 10_000_000, toolName) ?? 0

  const deps: OutlineReadDeps = {
    loadOutlineModel,
    readChapterOutlineDirect: (pp, chNum) => readChapterOutlineDirect(pp, chNum),
    listDirectory,
    readFileText: readFile,
    ...depsOverrides,
  }

  // 绝不调用 searchWiki（零外网保证）：只读本地 outline-model.json 与 wiki/outlines 目录。
  const [modelResult, outlineTree] = await Promise.all([
    deps.loadOutlineModel(projectPath).catch(() => ({
      model: null,
      migratedFrom: null,
      error: "outline-model.json 读取失败",
    })),
    deps.listDirectory(`${root}/wiki/outlines`).catch(() => [] as FileNode[]),
  ])

  const selectedFiles = selectOutlineSources(flattenOutlineMarkdownFiles(outlineTree))
  const outlineFiles = selectedFiles.map((f) => ({
    name: f.name,
    path: normalizePath(f.path),
  }))

  const model = modelResult.model
  const modelLoaded = model !== null
  const modelError = modelResult.error ?? null

  if (filename !== undefined) {
    const limit =
      readOptionalIntInRange(params, "limit", 1, MAX_OUTLINE_FILE_LIMIT, toolName)
      ?? DEFAULT_OUTLINE_FILE_LIMIT
    const targetPath = `${root}/wiki/outlines/${filename}`
    let content: string
    try {
      content = await deps.readFileText(targetPath)
    } catch {
      throw new Error(`找不到大纲文件：${filename}`)
    }
    const start = Math.min(offset, content.length)
    const slice = content.slice(start, start + limit)
    const hasMore = start + slice.length < content.length
    return {
      projectPath,
      mode: "file",
      modelLoaded,
      modelError,
      outlineFiles,
      filename,
      path: targetPath,
      content: slice,
      totalChars: content.length,
      total: content.length,
      filteredTotal: content.length,
      offset: start,
      limit,
      hasMore,
      meta: READ_ONLY_META,
    }
  }

  const limit =
    readOptionalIntInRange(params, "limit", 1, MAX_PAGE_LIMIT, toolName) ?? DEFAULT_PAGE_LIMIT
  const allChapters = model ? flattenOutlineChapters(model) : []
  const volumesSummary = (model?.volumes ?? []).map((v) => ({
    number: v.number,
    title: v.title,
    arc: v.arc,
    chapterCount: v.chapters.length,
  }))

  if (chapterNumber !== undefined) {
    const start = Math.max(1, chapterNumber - windowSize)
    const end = chapterNumber + windowSize
    let matched = allChapters.filter((ch) => ch.chapter >= start && ch.chapter <= end)
    if (volume !== undefined) {
      matched = matched.filter((ch) => ch.volume === volume)
    }
    const paged = matched.slice(offset, offset + limit)
    const hasMore = offset + paged.length < matched.length
    const directMarkdown = includeSummaryOnly
      ? null
      : (await deps.readChapterOutlineDirect(root, chapterNumber).catch(() => "")) || null

    return {
      projectPath,
      mode: "chapter_window",
      modelLoaded,
      modelError,
      outlineFiles,
      chapterNumber,
      window: windowSize,
      range: { start, end },
      ...(volume !== undefined ? { volume } : {}),
      volumes: volumesSummary,
      chapters: includeSummaryOnly ? paged.map(toOutlineChapterSummary) : paged,
      directMarkdown,
      total: allChapters.length,
      filteredTotal: matched.length,
      offset,
      limit,
      hasMore,
      meta: READ_ONLY_META,
    }
  }

  if (volume !== undefined) {
    const matched = allChapters.filter((ch) => ch.volume === volume)
    const paged = matched.slice(offset, offset + limit)
    const hasMore = offset + paged.length < matched.length
    return {
      projectPath,
      mode: "volume",
      modelLoaded,
      modelError,
      outlineFiles,
      volume,
      volumes: volumesSummary,
      chapters: includeSummaryOnly ? paged.map(toOutlineChapterSummary) : paged,
      total: allChapters.length,
      filteredTotal: matched.length,
      offset,
      limit,
      hasMore,
      meta: READ_ONLY_META,
    }
  }

  const paged = allChapters.slice(offset, offset + limit)
  const hasMore = offset + paged.length < allChapters.length
  let primaryMarkdown: string | null = null
  if (!modelLoaded && !includeSummaryOnly && outlineFiles.length > 0) {
    const rawPrimary = await deps.readFileText(outlineFiles[0]!.path).catch(() => "")
    if (rawPrimary) {
      primaryMarkdown =
        rawPrimary.length > DEFAULT_OUTLINE_FILE_LIMIT
          ? rawPrimary.slice(0, DEFAULT_OUTLINE_FILE_LIMIT)
          : rawPrimary
    }
  }

  return {
    projectPath,
    mode: "overview",
    modelLoaded,
    modelError,
    outlineFiles,
    volumes: volumesSummary,
    chapters: includeSummaryOnly ? paged.map(toOutlineChapterSummary) : paged,
    primaryMarkdown,
    total: allChapters.length,
    filteredTotal: allChapters.length,
    offset,
    limit,
    hasMore,
    meta: READ_ONLY_META,
  }
}

// ============================================================================
// 4. style.exemplars
// ============================================================================

export interface StyleExemplarsDeps {
  loadStyleExemplars: (projectPath: string) => Promise<StyleExemplar[]>
}

export interface StyleExemplarReadItem extends StyleExemplar {
  truncated: boolean
  originalChars: number
}

export interface StyleExemplarsResult {
  projectPath: string
  total: number
  filteredTotal: number
  offset: number
  limit: number
  hasMore: boolean
  countsByMarkType: Record<StyleExemplarMarkType, number>
  defaultTopK: number
  maxCharsPerItem: number
  items: StyleExemplarReadItem[]
  meta: typeof READ_ONLY_META
}

export async function runStyleExemplars(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<StyleExemplarsDeps>,
): Promise<StyleExemplarsResult> {
  const toolName = "style.exemplars"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, STYLE_EXEMPLARS_KEYS, toolName)

  let markTypes: StyleExemplarMarkType[] | undefined
  if (params.markTypes !== undefined) {
    if (!Array.isArray(params.markTypes) || params.markTypes.length === 0) {
      throw new Error(
        `${toolName} 的 markTypes 必须是非空数组（合法值：${VALID_STYLE_MARK_TYPES.join(", ")}）`,
      )
    }
    const dedup = new Set<StyleExemplarMarkType>()
    for (const item of params.markTypes) {
      if (typeof item !== "string" || !VALID_STYLE_MARK_TYPE_SET.has(item)) {
        throw new Error(
          `${toolName} 的 markTypes 包含非法值：${String(item)}（合法值：${VALID_STYLE_MARK_TYPES.join(", ")}）`,
        )
      }
      dedup.add(item as StyleExemplarMarkType)
    }
    markTypes = [...dedup]
  }

  const category = readOptionalNonEmptyString(params, "category", toolName, 128)
  const chapterId = readOptionalNonEmptyString(params, "chapterId", toolName, 128)
  const topK = readOptionalIntInRange(params, "topK", 1, 100, toolName)
  const maxCharsPerItem =
    readOptionalIntInRange(params, "maxCharsPerItem", 50, 10_000, toolName)
    ?? STYLE_EXEMPLAR_TEXT_MAX_CHARS
  const offset = readOptionalIntInRange(params, "offset", 0, 100_000, toolName) ?? 0
  const limit = readOptionalIntInRange(params, "limit", 1, MAX_PAGE_LIMIT, toolName) ?? DEFAULT_PAGE_LIMIT

  const loadFn = depsOverrides?.loadStyleExemplars ?? loadStyleExemplars
  let all: StyleExemplar[]
  try {
    all = await loadFn(projectPath)
  } catch {
    // 严格脱敏：不泄露损坏 JSON 原文或本地文件路径
    throw new Error("style exemplars file is corrupt")
  }

  const countsByMarkType: Record<StyleExemplarMarkType, number> = {
    style: 0,
    voice: 0,
    pacing: 0,
    thrill: 0,
    pull: 0,
    consistency: 0,
  }
  for (const ex of all) {
    if (ex.markType in countsByMarkType) {
      countsByMarkType[ex.markType] += 1
    }
  }

  const categoryLower = category?.toLowerCase()
  const categoryIsMarkType =
    categoryLower !== undefined && VALID_STYLE_MARK_TYPE_SET.has(categoryLower)
  const chapterIdLower = chapterId?.toLowerCase()

  const filtered = all.filter((ex) => {
    if (markTypes && !markTypes.includes(ex.markType)) return false
    if (categoryLower !== undefined) {
      if (categoryIsMarkType) {
        if (ex.markType !== categoryLower) return false
      } else {
        const noteLower = (ex.note ?? "").toLowerCase()
        if (!noteLower.includes(categoryLower) && !ex.markType.toLowerCase().includes(categoryLower)) {
          return false
        }
      }
    }
    if (chapterIdLower !== undefined) {
      if ((ex.chapterId ?? "").toLowerCase() !== chapterIdLower) return false
    }
    return true
  })

  const createdAtTs = (ex: StyleExemplar): number => {
    const t = Date.parse(ex.createdAt)
    return Number.isFinite(t) ? t : 0
  }

  let ranked: StyleExemplar[]
  if (topK !== undefined) {
    // pickTopKExemplars 会为 contextPack token 预算把 text 硬截断到 STYLE_EXEMPLAR_TEXT_MAX_CHARS(2000)；
    // 先按 exemplarId 建立原始未截断条目列表，待多样性筛选后再还原原文，最后统一按 maxCharsPerItem 截断一次，
    // 保证 originalChars / truncated 诚实反映原文且支持 maxCharsPerItem > 2000。
    const originalsById = new Map<string, StyleExemplar[]>()
    for (const ex of filtered) {
      const bucket = originalsById.get(ex.exemplarId)
      if (bucket) {
        bucket.push(ex)
      } else {
        originalsById.set(ex.exemplarId, [ex])
      }
    }
    ranked = pickTopKExemplars(filtered, topK).map((picked) => {
      const bucket = originalsById.get(picked.exemplarId)
      if (!bucket || bucket.length === 0) return picked
      const matchIdx = bucket.findIndex(
        (orig) =>
          orig.chapterId === picked.chapterId
          && orig.markType === picked.markType
          && orig.note === picked.note
          && orig.createdAt === picked.createdAt
          && (orig.text.length > STYLE_EXEMPLAR_TEXT_MAX_CHARS
            ? orig.text.slice(0, STYLE_EXEMPLAR_TEXT_MAX_CHARS)
            : orig.text) === picked.text,
      )
      const restored = matchIdx >= 0 ? bucket.splice(matchIdx, 1)[0]! : bucket.shift()!
      return {
        ...picked,
        text: restored.text,
      }
    })
  } else {
    ranked = [...filtered].sort((a, b) => createdAtTs(b) - createdAtTs(a))
  }

  const paged = ranked.slice(offset, offset + limit)
  const hasMore = offset + paged.length < ranked.length

  const items: StyleExemplarReadItem[] = paged.map((ex) => {
    const originalText = ex.text
    const originalChars = originalText.length
    const truncated = originalChars > maxCharsPerItem
    return {
      ...ex,
      text: truncated ? originalText.slice(0, maxCharsPerItem) : originalText,
      truncated,
      originalChars,
    }
  })

  return {
    projectPath,
    total: all.length,
    filteredTotal: ranked.length,
    offset,
    limit,
    hasMore,
    countsByMarkType,
    defaultTopK: STYLE_EXEMPLARS_TOP_K,
    maxCharsPerItem,
    items,
    meta: READ_ONLY_META,
  }
}

// ============================================================================
// 5. chapter.search
// ============================================================================

export type ChapterSearchScope = "chapters" | "all" | "entities" | "outlines" | "memory" | "drafts"

export interface ChapterSearchDeps {
  searchWiki: (
    projectPath: string,
    query: string,
    options?: { includeVector?: boolean; rerank?: boolean; topK?: number },
  ) => Promise<SearchResult[]>
  listChapters: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  readFileText: (path: string) => Promise<string>
}

export interface ChapterSearchHit {
  sourceKind: "chapter" | "entity" | "outline" | "memory" | "draft" | "wiki"
  path: string
  title: string
  chapterNumber: number | null
  draftId?: string
  score: number
  titleMatch: boolean
  snippet: string
}

export interface ChapterSearchResult {
  projectPath: string
  query: string
  scope: ChapterSearchScope
  chapterStart: number | null
  chapterEnd: number | null
  contextChars: number
  totalMatched: number
  limit: number
  truncated: boolean
  results: ChapterSearchHit[]
  meta: {
    readOnly: true
    llmCalls: 0
    diskWrites: 0
    networkUsed: false
  }
}

function classifyPathKind(rawPath: string): ChapterSearchHit["sourceKind"] {
  const norm = normalizePath(rawPath).toLowerCase()
  if (norm.includes("/.qm-drafts/")) return "draft"
  if (norm.includes("/wiki/chapters/") || norm.includes("/qm/chapters/")) return "chapter"
  if (norm.includes("/wiki/entities/") || norm.includes("/qm/entities/")) return "entity"
  if (norm.includes("/wiki/outlines/") || norm.includes("/qm/outlines/")) return "outline"
  if (norm.includes("/wiki/memory/") || norm.includes("/qm/memory/")) return "memory"
  return "wiki"
}

function extractChapterNumberFromNameOrPath(rawPath: string, rawName?: string): number | null {
  const stem = rawName ? rawName.replace(/\.md$/i, "") : getFileStem(rawPath)
  const ordinal = parseChapterOrdinal(stem)
  if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal > 0) return ordinal
  const fromDraft = readDraftChapterNumber(stem)
  if (fromDraft !== undefined) return fromDraft
  const digits = /(\d+)/.exec(stem)
  if (!digits) return null
  const num = Number(digits[1])
  return Number.isSafeInteger(num) && num > 0 ? num : null
}

function buildContextSnippet(text: string, query: string, tokens: readonly string[], contextChars: number): string {
  const flat = text.replace(/\r?\n/g, " ")
  const lower = flat.toLowerCase()
  const needle = query.trim().toLowerCase()
  let idx = needle ? lower.indexOf(needle) : -1
  let anchorLen = needle.length
  if (idx === -1) {
    for (const token of tokens) {
      const tIdx = lower.indexOf(token)
      if (tIdx !== -1) {
        idx = tIdx
        anchorLen = token.length
        break
      }
    }
  }
  const maxTotal = contextChars * 2 + Math.max(anchorLen, 1)
  if (idx === -1) {
    return flat.length > maxTotal ? `${flat.slice(0, maxTotal)}...` : flat
  }
  const start = Math.max(0, idx - contextChars)
  const end = Math.min(flat.length, idx + anchorLen + contextChars)
  let snippet = flat.slice(start, end)
  if (start > 0) snippet = `...${snippet}`
  if (end < flat.length) snippet = `${snippet}...`
  return snippet
}

function scoreLocalText(
  title: string,
  content: string,
  query: string,
  tokens: readonly string[],
): { score: number; titleMatch: boolean } {
  const phrase = query.trim().toLowerCase()
  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()

  const titleHasPhrase = phrase.length > 0 && titleLower.includes(phrase)
  let contentPhraseHits = 0
  if (phrase.length > 0) {
    let pos = 0
    while (contentPhraseHits < 10) {
      const idx = contentLower.indexOf(phrase, pos)
      if (idx === -1) break
      contentPhraseHits += 1
      pos = idx + phrase.length
    }
  }

  let titleTokens = 0
  let contentTokens = 0
  for (const token of tokens) {
    if (titleLower.includes(token)) titleTokens += 1
    if (contentLower.includes(token)) contentTokens += 1
  }

  const score =
    (titleHasPhrase ? 50 : 0)
    + contentPhraseHits * 20
    + titleTokens * 5
    + contentTokens
  return { score, titleMatch: titleHasPhrase || titleTokens > 0 }
}

function inChapterRange(
  chapterNumber: number | null,
  chapterStart?: number,
  chapterEnd?: number,
): boolean {
  if (chapterStart === undefined && chapterEnd === undefined) return true
  if (chapterNumber === null) return false
  if (chapterStart !== undefined && chapterNumber < chapterStart) return false
  if (chapterEnd !== undefined && chapterNumber > chapterEnd) return false
  return true
}

function extractTitleFromMarkdown(content: string, fallbackName: string): string {
  const { frontmatter } = parseFrontmatter(content)
  const fmTitle = typeof frontmatter?.title === "string" ? frontmatter.title.trim() : ""
  if (fmTitle) return fmTitle
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
  if (heading) return heading
  return fallbackName.replace(/\.md$/i, "")
}

export async function runChapterSearch(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<ChapterSearchDeps>,
): Promise<ChapterSearchResult> {
  const toolName = "chapter.search"
  const root = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, CHAPTER_SEARCH_KEYS, toolName)

  const query = readOptionalNonEmptyString(params, "query", toolName, MAX_QUERY_CHARS)
  if (!query) {
    throw new Error(`${toolName} 需要非空字符串参数 query`)
  }

  let scope: ChapterSearchScope = "chapters"
  if (params.scope !== undefined) {
    if (typeof params.scope !== "string" || !CHAPTER_SEARCH_SCOPES.has(params.scope)) {
      throw new Error(
        `${toolName} 的 scope 非法：${String(params.scope)}（合法值：chapters, all, entities, outlines, memory, drafts）`,
      )
    }
    scope = params.scope as ChapterSearchScope
  }

  const chapterStart = readOptionalIntInRange(params, "chapterStart", 1, 100_000, toolName)
  const chapterEnd = readOptionalIntInRange(params, "chapterEnd", 1, 100_000, toolName)
  if (chapterStart !== undefined && chapterEnd !== undefined && chapterStart > chapterEnd) {
    throw new Error(
      `${toolName} 参数冲突：chapterStart（${chapterStart}）不得大于 chapterEnd（${chapterEnd}）`,
    )
  }

  const limit =
    readOptionalIntInRange(params, "limit", 1, MAX_SEARCH_LIMIT, toolName) ?? DEFAULT_SEARCH_LIMIT
  const contextChars =
    readOptionalIntInRange(params, "contextChars", MIN_CONTEXT_CHARS, MAX_CONTEXT_CHARS, toolName)
    ?? DEFAULT_CONTEXT_CHARS

  const deps: ChapterSearchDeps = {
    searchWiki: (pp, q, opts) => searchWiki(pp, q, opts),
    listChapters: (pp) => listScopeFiles(pp, "chapters"),
    listDrafts: (pp) => listChapterDrafts(pp),
    readFileText: readFile,
    ...depsOverrides,
  }

  const rawTokens = tokenizeQuery(query)
  const tokens = rawTokens.length > 0 ? rawTokens : [query.toLowerCase()]
  let hits: ChapterSearchHit[] = []

  if (scope === "drafts") {
    const drafts = await deps.listDrafts(projectPath)
    for (const draft of drafts) {
      const chapterNumber = readDraftChapterNumber(draft.chapterName) ?? null
      if (!inChapterRange(chapterNumber, chapterStart, chapterEnd)) continue
      const { score, titleMatch } = scoreLocalText(draft.chapterName, draft.content, query, tokens)
      if (score <= 0) continue
      hits.push({
        sourceKind: "draft",
        path: `${root}/.qm-drafts/${draft.id}.md`,
        title: draft.chapterName,
        chapterNumber,
        draftId: draft.id,
        score,
        titleMatch,
        snippet: buildContextSnippet(draft.content, query, tokens, contextChars),
      })
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  } else {
    // 严格零出网：强制 includeVector: false, rerank: false。
    const wikiTopK = Math.max(limit * 4, 100)
    const wikiResults = await deps
      .searchWiki(projectPath, query, { includeVector: false, rerank: false, topK: wikiTopK })
      .catch(() => [] as SearchResult[])

    const hitsByPath = new Map<string, ChapterSearchHit>()
    for (const result of wikiResults) {
      const normPath = normalizePath(result.path)
      const kind = classifyPathKind(normPath)
      if (scope === "chapters" && kind !== "chapter") continue
      if (scope === "entities" && kind !== "entity") continue
      if (scope === "outlines" && kind !== "outline") continue
      if (scope === "memory" && kind !== "memory") continue

      const chapterNumber = kind === "chapter" ? extractChapterNumberFromNameOrPath(normPath) : null
      if (kind === "chapter" && !inChapterRange(chapterNumber, chapterStart, chapterEnd)) continue
      if (scope === "chapters" && !inChapterRange(chapterNumber, chapterStart, chapterEnd)) continue

      hitsByPath.set(normPath, {
        sourceKind: kind,
        path: normPath,
        title: result.title,
        chapterNumber,
        score: result.score,
        titleMatch: result.titleMatch,
        snippet: buildContextSnippet(result.snippet, query, tokens, contextChars),
      })
    }

    // scope === "chapters" 时以本地章节文件扫描补全，避免 searchWiki 的全库 topK 截断导致指定章号范围漏召回，
    // 并在应用 limit 前按 chapterStart..=chapterEnd 与 contextChars 精确裁剪。
    if (scope === "chapters") {
      const chapters = await deps.listChapters(projectPath).catch(() => [])
      const scopedChapters = chapters
        .filter((ch) => !isDraftChapterFile(ch.name))
        .map((ch) => ({
          ...ch,
          normPath: normalizePath(ch.path),
          chapterNumber: extractChapterNumberFromNameOrPath(ch.path, ch.name),
        }))
        .filter((ch) => inChapterRange(ch.chapterNumber, chapterStart, chapterEnd))
        .slice(0, MAX_LOCAL_CHAPTER_SCAN)

      const reads = await Promise.all(
        scopedChapters.map(async (ch) => {
          try {
            const content = await deps.readFileText(ch.path)
            return { ch, content }
          } catch {
            return null
          }
        }),
      )

      for (const item of reads) {
        if (!item) continue
        const { ch, content } = item
        const title = extractTitleFromMarkdown(content, ch.name)
        const { score, titleMatch } = scoreLocalText(title, content, query, tokens)
        const existing = hitsByPath.get(ch.normPath)
        if (score <= 0 && !existing) continue
        const snippet = buildContextSnippet(content, query, tokens, contextChars)
        if (existing) {
          existing.snippet = snippet
          existing.chapterNumber = ch.chapterNumber
          existing.title = title || existing.title
          if (score > existing.score) existing.score = score
          existing.titleMatch = existing.titleMatch || titleMatch
        } else {
          hitsByPath.set(ch.normPath, {
            sourceKind: "chapter",
            path: ch.normPath,
            title,
            chapterNumber: ch.chapterNumber,
            score,
            titleMatch,
            snippet,
          })
        }
      }
    }

    hits = [...hitsByPath.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })
  }

  const sliced = hits.slice(0, limit)
  return {
    projectPath,
    query,
    scope,
    chapterStart: chapterStart ?? null,
    chapterEnd: chapterEnd ?? null,
    contextChars,
    totalMatched: hits.length,
    limit,
    truncated: hits.length > limit,
    results: sliced,
    meta: {
      readOnly: true,
      llmCalls: 0,
      diskWrites: 0,
      networkUsed: false,
    },
  }
}
