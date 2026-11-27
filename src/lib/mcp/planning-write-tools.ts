// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * planning-write-tools.ts — 6 项零 LLM 规划/治理写工具门面（TASK-002）。
 *
 * 严格依赖与安全边界：
 * 1. 所有 novel 域符号均经 `@/lib/novel` 顶层 barrel 导入（零深导入）；
 * 2. 严格零 LLM 调用（`llmCalls: 0`），绝不触碰正式章节（`wiki/chapters/*` / `QM/chapters/*`）、
 *    正式记忆（`canon` / `snapshots`）或采纳接口（`acceptChapterDraft`）；
 * 3. `director.commit_phase` 必须调用真实的 `collectProjectSnapshot` + `tryAdvanceDirector` +
 *    `assertIrreversible` + `saveDirectorPersisted`，严禁绕过任何阶段门或回退 `done` 阶段；
 * 4. 全部 6 个工具均要求 `SessionScope::Project`，在 `WriterSub` / `Architect` / `FullLegacy` 可见，
 *    在只读 `Reviewer` Profile 中严格隐藏。
 */

import {
  DIRECTOR_PHASES,
  EMPTY_BOOK_RULES,
  REQUIRED_WORLD_LAYERS,
  WORLD_LAYERS,
  assertIrreversible,
  bookRulesToPromptFragment,
  collectProjectSnapshot,
  computeCheckpointDigest,
  getActiveForeshadowings,
  isPipelineCompleted,
  loadBookRules,
  loadDirectorPersisted,
  loadForeshadowingTracker,
  loadStoryCompass,
  loadSubplotBoard,
  loadWorldBlueprint,
  markAbandoned,
  mergeWorldBlueprintPatch,
  normalizeBookRules,
  retryDirector,
  saveBookRules,
  saveDirectorPersisted,
  saveForeshadowingTracker,
  saveStoryCompass,
  saveSubplotBoard,
  saveWorldBlueprint,
  tryAdvanceDirector,
  updateCompass,
  validateWorldBlueprint,
  withProjectLock,
  worldBlueprintToPromptFragment,
  deriveWorldBlueprint,
  type BookRules,
  type CompassUpdate,
  type DirectorIdeaInput,
  type DirectorPersistedFile,
  type DirectorPhase,
  type DirectorSnapshot,
  type FanficMode,
  type Foreshadowing,
  type ForeshadowingStatus,
  type ForeshadowingStore,
  type StoryCompass,
  type Subplot,
  type SubplotBoardStore,
  type SubplotStatus,
  type WorldBlueprint,
  type WorldBlueprintSeed,
  type WorldLayer,
  type WorldValidation,
} from "@/lib/novel"
import { normalizePath } from "@/lib/path-utils"

const PLANNING_WRITE_META = {
  llmCalls: 0 as const,
  draftFirst: true as const,
  formalChaptersMutated: false as const,
}

const ASCII_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/
const WORLD_LAYER_SET: ReadonlySet<string> = new Set(WORLD_LAYERS)
const DIRECTOR_PHASE_SET: ReadonlySet<string> = new Set(DIRECTOR_PHASES)
const FANFIC_MODE_SET: ReadonlySet<string> = new Set(["canon", "au", "ooc", "cp"])
const FORESHADOWING_STATUS_SET: ReadonlySet<string> = new Set([
  "planted",
  "advanced",
  "resolved",
  "abandoned",
])
const SUBPLOT_STATUS_SET: ReadonlySet<string> = new Set([
  "proposed",
  "active",
  "paused",
  "resolved",
])

const UPSERT_WORLD_KEYS = new Set([
  "worldType",
  "mode",
  "layers",
  "crossRefs",
  "deriveFromEntities",
  "fillMissingRequired",
])
const CROSS_REF_KEYS = new Set(["from", "to", "term"])

const COMMIT_PHASE_KEYS = new Set([
  "idea",
  "expectedPhase",
  "retryIfFailed",
  "persistOnBlocked",
])
const IDEA_KEYS = new Set(["title", "genre", "coreConflict"])

const UPSERT_BOOK_RULES_KEYS = new Set([
  "mode",
  "version",
  "prohibitions",
  "allowedDeviations",
  "protagonist",
  "genreLock",
  "eraConstraints",
  "fanficMode",
])
const PROTAGONIST_KEYS = new Set(["name", "personalityLock", "behavioralConstraints"])
const GENRE_LOCK_KEYS = new Set(["primary", "forbidden"])
const ERA_CONSTRAINTS_KEYS = new Set(["enabled", "anachronismTerms", "period", "region"])

const COMPASS_UPDATE_KEYS = new Set([
  "endingDirection",
  "newThreads",
  "resolvedThreads",
  "estimatedScale",
  "declareFinalVolume",
])

const FORESHADOWING_UPSERT_KEYS = new Set([
  "id",
  "name",
  "description",
  "status",
  "plantedChapter",
  "advancedChapters",
  "resolvedChapter",
  "relatedCharacters",
  "relatedEvents",
  "notes",
])

const SUBPLOT_UPSERT_KEYS = new Set([
  "id",
  "title",
  "status",
  "startChapter",
  "resolvedChapter",
  "lastSeenChapter",
  "targetResolutionChapter",
  "abandoned",
  "relatedCharacters",
  "summary",
  "progressEntry",
  "progress",
  "notes",
])

const MAX_CHAPTER_NUMBER = 100_000
const MAX_VOLUME_NUMBER = 1_000

// ──────────────────────────────────────────────────────────────────────────
// 共享参数校验原语（与 Rust 侧 normalize_strict_object_args 1:1 对齐）
// ──────────────────────────────────────────────────────────────────────────

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function assertProjectPath(projectPath: string, toolName: string): string {
  const root = projectRoot(projectPath)
  if (!root) throw new Error(`${toolName} 需要已打开的项目`)
  return root
}

/**
 * 严格校验对象入参：
 * - 必须是普通 object；
 * - 拒绝任何未知键（即使值为 null/undefined）；
 * - 必填键拒绝 null/undefined；
 * - 可选键的显式 null/undefined 自动剥离（兼容部分 JSON Schema 客户端）。
 */
function normalizeStrictObject(
  raw: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
  toolName: string,
  contextLabel = "params",
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${toolName}: ${contextLabel} 必须是对象`)
  }
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${toolName}: 未知参数 \`${key}\``)
    }
    const val = src[key]
    if (val === null || val === undefined) {
      if (requiredKeys.has(key)) {
        throw new Error(`${toolName}: 必填参数 \`${key}\` 不接受 null 或缺失`)
      }
      continue
    }
    out[key] = val
  }
  for (const reqKey of requiredKeys) {
    if (!(reqKey in out)) {
      throw new Error(`${toolName}: 缺少必填参数 \`${reqKey}\``)
    }
  }
  return out
}

function validateSingleLineString(
  raw: unknown,
  toolName: string,
  field: string,
  minChars: number,
  maxChars: number,
): string {
  if (typeof raw !== "string") {
    throw new Error(`${toolName}: \`${field}\` 必须是字符串`)
  }
  const trimmed = raw.trim()
  if (trimmed.length < minChars || raw.length > maxChars || CONTROL_CHAR_RE.test(raw)) {
    throw new Error(
      `${toolName}: \`${field}\` 须为 ${minChars}..=${maxChars} 字符且不含控制字符的单行文本`,
    )
  }
  return trimmed
}

function validateMultilineString(
  raw: unknown,
  toolName: string,
  field: string,
  minChars: number,
  maxChars: number,
): string {
  if (typeof raw !== "string") {
    throw new Error(`${toolName}: \`${field}\` 必须是字符串`)
  }
  const trimmed = raw.trim()
  if (trimmed.length < minChars || raw.length > maxChars) {
    throw new Error(`${toolName}: \`${field}\` 长度须在 ${minChars}..=${maxChars} 字符之间`)
  }
  return trimmed
}

function validateAsciiId(raw: unknown, toolName: string, field: string): string {
  if (typeof raw !== "string" || !ASCII_ID_PATTERN.test(raw)) {
    throw new Error(`${toolName}: \`${field}\` 必须是 1..=128 个 ASCII [a-zA-Z0-9_-] 字符`)
  }
  return raw
}

function validatePositiveInt(
  raw: unknown,
  toolName: string,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`${toolName}: \`${field}\` 必须是 ${min}..=${max} 的整数`)
  }
  return raw
}

function validateBoolean(raw: unknown, toolName: string, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new Error(`${toolName}: \`${field}\` 必须是 boolean`)
  }
  return raw
}

function validateStringArray(
  raw: unknown,
  toolName: string,
  field: string,
  options: { maxItems: number; maxItemChars: number; singleLine?: boolean },
): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${toolName}: \`${field}\` 必须是字符串数组`)
  }
  if (raw.length > options.maxItems) {
    throw new Error(`${toolName}: \`${field}\` 最多 ${options.maxItems} 项（收到 ${raw.length}）`)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = options.singleLine
      ? validateSingleLineString(raw[i], toolName, `${field}[${i}]`, 1, options.maxItemChars)
      : validateMultilineString(raw[i], toolName, `${field}[${i}]`, 1, options.maxItemChars)
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

function validatePositiveIntArray(
  raw: unknown,
  toolName: string,
  field: string,
  maxItems: number,
  maxVal: number,
): number[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${toolName}: \`${field}\` 必须是整数数组`)
  }
  if (raw.length > maxItems) {
    throw new Error(`${toolName}: \`${field}\` 最多 ${maxItems} 项（收到 ${raw.length}）`)
  }
  const set = new Set<number>()
  for (let i = 0; i < raw.length; i += 1) {
    set.add(validatePositiveInt(raw[i], toolName, `${field}[${i}]`, 1, maxVal))
  }
  return [...set].sort((a, b) => a - b)
}

function mergeUniqueStrings(base: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...base, ...incoming]) {
    const trimmed = s.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

async function runLocked<T>(
  root: string,
  lockRunner: (<R>(projectPath: string, fn: () => Promise<R>) => Promise<R>) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (lockRunner) return lockRunner(root, fn)
  return withProjectLock(root, fn)
}

// ============================================================================
// 1. director.upsert_world
// ============================================================================

export interface DirectorUpsertWorldDeps {
  loadWorldBlueprint?: (projectPath: string) => Promise<WorldBlueprint | null>
  saveWorldBlueprint?: (projectPath: string, bp: WorldBlueprint) => Promise<void>
  deriveWorldBlueprint?: (
    projectPath: string,
    worldType?: string,
    seed?: WorldBlueprintSeed,
  ) => Promise<WorldBlueprint>
  loadDirectorPersisted?: (projectPath: string) => Promise<DirectorPersistedFile>
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface DirectorUpsertWorldResult {
  projectPath: string
  path: string
  worldType: string
  version: string
  mode: "merge" | "replace"
  blueprint: WorldBlueprint
  validation: WorldValidation
  missingRequiredLayers: WorldLayer[]
  promptFragmentChars: number
  meta: typeof PLANNING_WRITE_META
}

export async function runDirectorUpsertWorld(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: DirectorUpsertWorldDeps,
): Promise<DirectorUpsertWorldResult> {
  const toolName = "director.upsert_world"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, UPSERT_WORLD_KEYS, new Set(), toolName)

  const worldType =
    "worldType" in clean
      ? validateSingleLineString(clean.worldType, toolName, "worldType", 1, 128)
      : undefined

  let mode: "merge" | "replace" = "merge"
  if ("mode" in clean) {
    if (clean.mode !== "merge" && clean.mode !== "replace") {
      throw new Error(`${toolName}: \`mode\` 仅支持 merge | replace`)
    }
    mode = clean.mode
  }

  let layers: Partial<Record<WorldLayer, string[]>> | undefined
  if ("layers" in clean) {
    if (!clean.layers || typeof clean.layers !== "object" || Array.isArray(clean.layers)) {
      throw new Error(`${toolName}: \`layers\` 必须是对象`)
    }
    const rawLayers = clean.layers as Record<string, unknown>
    const parsedLayers: Partial<Record<WorldLayer, string[]>> = {}
    for (const [key, val] of Object.entries(rawLayers)) {
      if (!WORLD_LAYER_SET.has(key)) {
        throw new Error(`${toolName}: \`layers\` 包含未知世界层 \`${key}\``)
      }
      if (val === null || val === undefined) continue
      parsedLayers[key as WorldLayer] = validateStringArray(val, toolName, `layers.${key}`, {
        maxItems: 100,
        maxItemChars: 2_000,
      })
    }
    if (Object.keys(parsedLayers).length > 0) {
      layers = parsedLayers
    }
  }

  let crossRefs: Array<{ from: WorldLayer; to: WorldLayer; term: string }> | undefined
  if ("crossRefs" in clean) {
    if (!Array.isArray(clean.crossRefs)) {
      throw new Error(`${toolName}: \`crossRefs\` 必须是数组`)
    }
    if (clean.crossRefs.length > 200) {
      throw new Error(`${toolName}: \`crossRefs\` 最多 200 项`)
    }
    crossRefs = clean.crossRefs.map((entry, idx) => {
      const obj = normalizeStrictObject(
        entry,
        CROSS_REF_KEYS,
        CROSS_REF_KEYS,
        toolName,
        `crossRefs[${idx}]`,
      )
      if (typeof obj.from !== "string" || !WORLD_LAYER_SET.has(obj.from)) {
        throw new Error(`${toolName}: crossRefs[${idx}].from 必须是合法世界层`)
      }
      if (typeof obj.to !== "string" || !WORLD_LAYER_SET.has(obj.to)) {
        throw new Error(`${toolName}: crossRefs[${idx}].to 必须是合法世界层`)
      }
      const term = validateSingleLineString(obj.term, toolName, `crossRefs[${idx}].term`, 1, 256)
      return { from: obj.from as WorldLayer, to: obj.to as WorldLayer, term }
    })
  }

  const deriveFromEntities =
    "deriveFromEntities" in clean
      ? validateBoolean(clean.deriveFromEntities, toolName, "deriveFromEntities")
      : false
  const fillMissingRequired =
    "fillMissingRequired" in clean
      ? validateBoolean(clean.fillMissingRequired, toolName, "fillMissingRequired")
      : false

  if (
    worldType === undefined
    && layers === undefined
    && crossRefs === undefined
    && !deriveFromEntities
    && !fillMissingRequired
  ) {
    throw new Error(
      `${toolName}: 至少需提供 worldType / layers / crossRefs / deriveFromEntities / fillMissingRequired 之一`,
    )
  }

  const loadBp = deps?.loadWorldBlueprint ?? loadWorldBlueprint
  const saveBp = deps?.saveWorldBlueprint ?? saveWorldBlueprint
  const deriveBp = deps?.deriveWorldBlueprint ?? deriveWorldBlueprint
  const loadDirector = deps?.loadDirectorPersisted ?? loadDirectorPersisted

  return runLocked(root, deps?.withLock, async () => {
    const existing = await loadBp(root)
    const effectiveWorldType = worldType ?? existing?.worldType ?? "fantasy"
    const idea =
      deriveFromEntities || fillMissingRequired
        ? (await loadDirector(root).catch(() => null))?.ideaInput
        : undefined

    const base = deriveFromEntities
      ? await deriveBp(root, effectiveWorldType, {
          existing,
          idea,
          fillMissingRequired: false,
        })
      : existing

    const blueprint = mergeWorldBlueprintPatch(base, {
      worldType: effectiveWorldType,
      mode,
      layers,
      crossRefs,
      fillMissingRequired,
      idea,
    })

    await saveBp(root, blueprint)
    const validation = validateWorldBlueprint(blueprint)
    const missingRequiredLayers = REQUIRED_WORLD_LAYERS.filter(
      (layer) => (blueprint.layers[layer] ?? []).length === 0,
    )

    return {
      projectPath: root,
      path: `${root}/.novel/world-blueprint.json`,
      worldType: blueprint.worldType,
      version: blueprint.version,
      mode,
      blueprint,
      validation,
      missingRequiredLayers,
      promptFragmentChars: worldBlueprintToPromptFragment(blueprint).length,
      meta: PLANNING_WRITE_META,
    }
  })
}

// ============================================================================
// 2. director.commit_phase
// ============================================================================

export interface DirectorCommitPhaseDeps {
  loadDirectorPersisted?: (projectPath: string) => Promise<DirectorPersistedFile>
  saveDirectorPersisted?: (projectPath: string, file: DirectorPersistedFile) => Promise<void>
  collectProjectSnapshot?: (
    projectPath: string,
    idea: DirectorIdeaInput,
  ) => Promise<DirectorSnapshot>
  loadWorldBlueprint?: (projectPath: string) => Promise<WorldBlueprint | null>
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface DirectorCommitPhaseResult {
  projectPath: string
  path: string
  previousPhase: DirectorPhase
  currentPhase: DirectorPhase
  advanced: boolean
  completed: boolean
  alreadyCompleted: boolean
  persisted: boolean
  blockedReason: string | null
  gap: string | null
  state: DirectorPersistedFile["state"]
  ideaInput: DirectorIdeaInput
  snapshot: DirectorSnapshot
  meta: typeof PLANNING_WRITE_META
}

export async function runDirectorCommitPhase(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: DirectorCommitPhaseDeps,
): Promise<DirectorCommitPhaseResult> {
  const toolName = "director.commit_phase"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, COMMIT_PHASE_KEYS, new Set(), toolName)

  let ideaPatch: Partial<DirectorIdeaInput> | undefined
  if ("idea" in clean) {
    const cleanIdea = normalizeStrictObject(clean.idea, IDEA_KEYS, new Set(), toolName, "idea")
    const nextPatch: Partial<DirectorIdeaInput> = {}
    if ("title" in cleanIdea) {
      nextPatch.title = validateSingleLineString(cleanIdea.title, toolName, "idea.title", 1, 200)
    }
    if ("genre" in cleanIdea) {
      nextPatch.genre = validateSingleLineString(cleanIdea.genre, toolName, "idea.genre", 1, 128)
    }
    if ("coreConflict" in cleanIdea) {
      nextPatch.coreConflict = validateMultilineString(
        cleanIdea.coreConflict,
        toolName,
        "idea.coreConflict",
        1,
        2_000,
      )
    }
    if (Object.keys(nextPatch).length > 0) {
      ideaPatch = nextPatch
    }
  }

  let expectedPhase: DirectorPhase | undefined
  if ("expectedPhase" in clean) {
    if (typeof clean.expectedPhase !== "string" || !DIRECTOR_PHASE_SET.has(clean.expectedPhase)) {
      throw new Error(
        `${toolName}: \`expectedPhase\` 必须是 ${DIRECTOR_PHASES.join(" | ")} 之一`,
      )
    }
    expectedPhase = clean.expectedPhase as DirectorPhase
  }

  const retryIfFailed =
    "retryIfFailed" in clean
      ? validateBoolean(clean.retryIfFailed, toolName, "retryIfFailed")
      : true
  const persistOnBlocked =
    "persistOnBlocked" in clean
      ? validateBoolean(clean.persistOnBlocked, toolName, "persistOnBlocked")
      : false

  const loadPersisted = deps?.loadDirectorPersisted ?? loadDirectorPersisted
  const savePersisted = deps?.saveDirectorPersisted ?? saveDirectorPersisted
  const collectSnap = deps?.collectProjectSnapshot ?? collectProjectSnapshot
  const loadBp = deps?.loadWorldBlueprint ?? loadWorldBlueprint

  return runLocked(root, deps?.withLock, async () => {
    const persisted = await loadPersisted(root)
    const previousPhase = persisted.state.currentPhase

    if (expectedPhase !== undefined && previousPhase !== expectedPhase) {
      throw new Error(
        `${toolName}: expectedPhase 不匹配（期望 ${expectedPhase}，当前阶段为 ${previousPhase}）`,
      )
    }

    const mergedIdea: DirectorIdeaInput = {
      title: ideaPatch?.title ?? persisted.ideaInput.title,
      genre: ideaPatch?.genre ?? persisted.ideaInput.genre,
      coreConflict: ideaPatch?.coreConflict ?? persisted.ideaInput.coreConflict,
    }
    const ideaChanged =
      mergedIdea.title !== persisted.ideaInput.title
      || mergedIdea.genre !== persisted.ideaInput.genre
      || mergedIdea.coreConflict !== persisted.ideaInput.coreConflict

    const snapshot = await collectSnap(root, mergedIdea)
    const blueprint = await loadBp(root).catch(() => null)

    if (isPipelineCompleted(persisted.state)) {
      if (ideaChanged) {
        await savePersisted(root, {
          fileVersion: 1,
          state: persisted.state,
          ideaInput: mergedIdea,
        })
      }
      return {
        projectPath: root,
        path: `${root}/.novel/director-pipeline.json`,
        previousPhase,
        currentPhase: persisted.state.currentPhase,
        advanced: false,
        completed: true,
        alreadyCompleted: true,
        persisted: ideaChanged,
        blockedReason: null,
        gap: null,
        state: persisted.state,
        ideaInput: mergedIdea,
        snapshot,
        meta: PLANNING_WRITE_META,
      }
    }

    const baseState =
      retryIfFailed && persisted.state.statuses[previousPhase] === "failed"
        ? retryDirector(persisted.state)
        : persisted.state

    // 必须走真实确定性门控链，严禁绕过阶段门或回退已完成阶段
    const outcome = tryAdvanceDirector(baseState, snapshot, blueprint)
    assertIrreversible(persisted.state, outcome.state)

    const shouldPersistState = outcome.advanced || persistOnBlocked
    const finalState = shouldPersistState ? outcome.state : persisted.state
    const didPersist = shouldPersistState || ideaChanged

    if (didPersist) {
      await savePersisted(root, {
        fileVersion: 1,
        state: finalState,
        ideaInput: mergedIdea,
      })
    }

    return {
      projectPath: root,
      path: `${root}/.novel/director-pipeline.json`,
      previousPhase,
      currentPhase: finalState.currentPhase,
      advanced: outcome.advanced,
      completed: outcome.completed,
      alreadyCompleted: false,
      persisted: didPersist,
      blockedReason: outcome.blockedReason ?? null,
      gap: outcome.gap ?? null,
      state: finalState,
      ideaInput: mergedIdea,
      snapshot,
      meta: PLANNING_WRITE_META,
    }
  })
}

// ============================================================================
// 3. rules.upsert_book_rules
// ============================================================================

export interface RulesUpsertBookRulesDeps {
  loadBookRules?: (projectPath: string) => Promise<BookRules | null>
  saveBookRules?: (projectPath: string, rules: BookRules) => Promise<void>
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface RulesUpsertBookRulesResult {
  projectPath: string
  path: string
  mode: "merge" | "replace"
  rules: BookRules
  promptFragment: string
  meta: typeof PLANNING_WRITE_META
}

export async function runRulesUpsertBookRules(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: RulesUpsertBookRulesDeps,
): Promise<RulesUpsertBookRulesResult> {
  const toolName = "rules.upsert_book_rules"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, UPSERT_BOOK_RULES_KEYS, new Set(), toolName)

  let mode: "merge" | "replace" = "merge"
  if ("mode" in clean) {
    if (clean.mode !== "merge" && clean.mode !== "replace") {
      throw new Error(`${toolName}: \`mode\` 仅支持 merge | replace`)
    }
    mode = clean.mode
  }

  const version =
    "version" in clean
      ? validateSingleLineString(clean.version, toolName, "version", 1, 32)
      : undefined
  const prohibitions =
    "prohibitions" in clean
      ? validateStringArray(clean.prohibitions, toolName, "prohibitions", {
          maxItems: 200,
          maxItemChars: 200,
          singleLine: true,
        })
      : undefined
  const allowedDeviations =
    "allowedDeviations" in clean
      ? validateStringArray(clean.allowedDeviations, toolName, "allowedDeviations", {
          maxItems: 200,
          maxItemChars: 200,
          singleLine: true,
        })
      : undefined

  let protagonistPatch:
    | { name: string; personalityLock?: string[]; behavioralConstraints?: string[] }
    | undefined
  if ("protagonist" in clean) {
    const p = normalizeStrictObject(
      clean.protagonist,
      PROTAGONIST_KEYS,
      new Set(["name"]),
      toolName,
      "protagonist",
    )
    protagonistPatch = {
      name: validateSingleLineString(p.name, toolName, "protagonist.name", 1, 128),
      ...("personalityLock" in p
        ? {
            personalityLock: validateStringArray(
              p.personalityLock,
              toolName,
              "protagonist.personalityLock",
              { maxItems: 100, maxItemChars: 200, singleLine: true },
            ),
          }
        : {}),
      ...("behavioralConstraints" in p
        ? {
            behavioralConstraints: validateStringArray(
              p.behavioralConstraints,
              toolName,
              "protagonist.behavioralConstraints",
              { maxItems: 100, maxItemChars: 200, singleLine: true },
            ),
          }
        : {}),
    }
  }

  let genreLockPatch: { primary: string; forbidden?: string[] } | undefined
  if ("genreLock" in clean) {
    const g = normalizeStrictObject(
      clean.genreLock,
      GENRE_LOCK_KEYS,
      new Set(["primary"]),
      toolName,
      "genreLock",
    )
    genreLockPatch = {
      primary: validateSingleLineString(g.primary, toolName, "genreLock.primary", 1, 128),
      ...("forbidden" in g
        ? {
            forbidden: validateStringArray(g.forbidden, toolName, "genreLock.forbidden", {
              maxItems: 100,
              maxItemChars: 200,
              singleLine: true,
            }),
          }
        : {}),
    }
  }

  let eraConstraintsPatch:
    | { enabled: boolean; anachronismTerms?: string[]; period?: string; region?: string }
    | undefined
  if ("eraConstraints" in clean) {
    const e = normalizeStrictObject(
      clean.eraConstraints,
      ERA_CONSTRAINTS_KEYS,
      new Set(["enabled"]),
      toolName,
      "eraConstraints",
    )
    eraConstraintsPatch = {
      enabled: validateBoolean(e.enabled, toolName, "eraConstraints.enabled"),
      ...("anachronismTerms" in e
        ? {
            anachronismTerms: validateStringArray(
              e.anachronismTerms,
              toolName,
              "eraConstraints.anachronismTerms",
              { maxItems: 200, maxItemChars: 200, singleLine: true },
            ),
          }
        : {}),
      ...("period" in e
        ? {
            period: validateSingleLineString(e.period, toolName, "eraConstraints.period", 1, 128),
          }
        : {}),
      ...("region" in e
        ? {
            region: validateSingleLineString(e.region, toolName, "eraConstraints.region", 1, 128),
          }
        : {}),
    }
  }

  let fanficMode: FanficMode | undefined
  if ("fanficMode" in clean) {
    if (typeof clean.fanficMode !== "string" || !FANFIC_MODE_SET.has(clean.fanficMode)) {
      throw new Error(`${toolName}: \`fanficMode\` 仅支持 canon | au | ooc | cp`)
    }
    fanficMode = clean.fanficMode as FanficMode
  }

  const hasRuleField =
    version !== undefined
    || prohibitions !== undefined
    || allowedDeviations !== undefined
    || protagonistPatch !== undefined
    || genreLockPatch !== undefined
    || eraConstraintsPatch !== undefined
    || fanficMode !== undefined

  if (mode === "merge" && !hasRuleField) {
    throw new Error(`${toolName}: merge 模式下至少需提供一个规则字段`)
  }

  const loadRules = deps?.loadBookRules ?? loadBookRules
  const saveRules = deps?.saveBookRules ?? saveBookRules

  return runLocked(root, deps?.withLock, async () => {
    const existing = mode === "merge" ? await loadRules(root) : null
    const base: BookRules = existing ?? { ...EMPTY_BOOK_RULES }

    const merged: BookRules = {
      version: version ?? base.version ?? "1.0",
      prohibitions:
        prohibitions !== undefined
          ? mode === "merge"
            ? mergeUniqueStrings(base.prohibitions, prohibitions)
            : prohibitions
          : [...base.prohibitions],
      allowedDeviations:
        allowedDeviations !== undefined
          ? mode === "merge"
            ? mergeUniqueStrings(base.allowedDeviations, allowedDeviations)
            : allowedDeviations
          : [...base.allowedDeviations],
    }

    if (protagonistPatch) {
      const prev = mode === "merge" ? base.protagonist : undefined
      merged.protagonist = {
        name: protagonistPatch.name,
        personalityLock:
          protagonistPatch.personalityLock !== undefined
            ? mode === "merge" && prev
              ? mergeUniqueStrings(prev.personalityLock, protagonistPatch.personalityLock)
              : protagonistPatch.personalityLock
            : [...(prev?.personalityLock ?? [])],
        behavioralConstraints:
          protagonistPatch.behavioralConstraints !== undefined
            ? mode === "merge" && prev
              ? mergeUniqueStrings(prev.behavioralConstraints, protagonistPatch.behavioralConstraints)
              : protagonistPatch.behavioralConstraints
            : [...(prev?.behavioralConstraints ?? [])],
      }
    } else if (mode === "merge" && base.protagonist) {
      merged.protagonist = {
        name: base.protagonist.name,
        personalityLock: [...base.protagonist.personalityLock],
        behavioralConstraints: [...base.protagonist.behavioralConstraints],
      }
    }

    if (genreLockPatch) {
      const prev = mode === "merge" ? base.genreLock : undefined
      merged.genreLock = {
        primary: genreLockPatch.primary,
        forbidden:
          genreLockPatch.forbidden !== undefined
            ? mode === "merge" && prev
              ? mergeUniqueStrings(prev.forbidden, genreLockPatch.forbidden)
              : genreLockPatch.forbidden
            : [...(prev?.forbidden ?? [])],
      }
    } else if (mode === "merge" && base.genreLock) {
      merged.genreLock = {
        primary: base.genreLock.primary,
        forbidden: [...base.genreLock.forbidden],
      }
    }

    if (eraConstraintsPatch) {
      const prev = mode === "merge" ? base.eraConstraints : undefined
      const period = eraConstraintsPatch.period ?? (mode === "merge" ? prev?.period : undefined)
      const region = eraConstraintsPatch.region ?? (mode === "merge" ? prev?.region : undefined)
      merged.eraConstraints = {
        enabled: eraConstraintsPatch.enabled,
        anachronismTerms:
          eraConstraintsPatch.anachronismTerms !== undefined
            ? mode === "merge" && prev
              ? mergeUniqueStrings(prev.anachronismTerms, eraConstraintsPatch.anachronismTerms)
              : eraConstraintsPatch.anachronismTerms
            : [...(prev?.anachronismTerms ?? [])],
        ...(period ? { period } : {}),
        ...(region ? { region } : {}),
      }
    } else if (mode === "merge" && base.eraConstraints) {
      merged.eraConstraints = {
        enabled: base.eraConstraints.enabled,
        anachronismTerms: [...base.eraConstraints.anachronismTerms],
        ...(base.eraConstraints.period ? { period: base.eraConstraints.period } : {}),
        ...(base.eraConstraints.region ? { region: base.eraConstraints.region } : {}),
      }
    }

    const effectiveFanfic = fanficMode ?? (mode === "merge" ? base.fanficMode : undefined)
    if (effectiveFanfic) {
      merged.fanficMode = effectiveFanfic
    }

    const normalized = normalizeBookRules(merged) ?? { ...EMPTY_BOOK_RULES }
    await saveRules(root, normalized)

    return {
      projectPath: root,
      path: `${root}/.novel/book-rules.json`,
      mode,
      rules: normalized,
      promptFragment: bookRulesToPromptFragment(normalized),
      meta: PLANNING_WRITE_META,
    }
  })
}

// ============================================================================
// 4. compass.update
// ============================================================================

export interface CompassUpdateDeps {
  loadStoryCompass?: (projectPath: string) => Promise<StoryCompass>
  saveStoryCompass?: (projectPath: string, compass: StoryCompass) => Promise<void>
  now?: () => string
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface CompassUpdateResult {
  projectPath: string
  path: string
  compass: StoryCompass
  openThreadCount: number
  addedThreads: string[]
  removedThreads: string[]
  meta: typeof PLANNING_WRITE_META
}

export async function runCompassUpdate(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: CompassUpdateDeps,
): Promise<CompassUpdateResult> {
  const toolName = "compass.update"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, COMPASS_UPDATE_KEYS, new Set(), toolName)

  const patch: CompassUpdate = {}
  if ("endingDirection" in clean) {
    patch.endingDirection = validateMultilineString(
      clean.endingDirection,
      toolName,
      "endingDirection",
      0,
      2_000,
    )
  }
  if ("newThreads" in clean) {
    patch.newThreads = validateStringArray(clean.newThreads, toolName, "newThreads", {
      maxItems: 100,
      maxItemChars: 300,
      singleLine: true,
    })
  }
  if ("resolvedThreads" in clean) {
    patch.resolvedThreads = validateStringArray(
      clean.resolvedThreads,
      toolName,
      "resolvedThreads",
      {
        maxItems: 100,
        maxItemChars: 300,
        singleLine: true,
      },
    )
  }
  if ("estimatedScale" in clean) {
    patch.estimatedScale = validateSingleLineString(
      clean.estimatedScale,
      toolName,
      "estimatedScale",
      0,
      200,
    )
  }
  if ("declareFinalVolume" in clean) {
    patch.declareFinalVolume = validatePositiveInt(
      clean.declareFinalVolume,
      toolName,
      "declareFinalVolume",
      1,
      MAX_VOLUME_NUMBER,
    )
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(
      `${toolName}: 至少需提供 endingDirection / newThreads / resolvedThreads / estimatedScale / declareFinalVolume 之一`,
    )
  }

  const loadCompass = deps?.loadStoryCompass ?? loadStoryCompass
  const saveCompass = deps?.saveStoryCompass ?? saveStoryCompass
  const nowFn = deps?.now ?? (() => new Date().toISOString())

  return runLocked(root, deps?.withLock, async () => {
    const before = await loadCompass(root)
    const beforeSet = new Set(before.openThreads)
    const after = updateCompass(before, patch, { now: nowFn() })
    await saveCompass(root, after)

    const afterSet = new Set(after.openThreads)
    const addedThreads = after.openThreads.filter((t) => !beforeSet.has(t))
    const removedThreads = before.openThreads.filter((t) => !afterSet.has(t))

    return {
      projectPath: root,
      path: `${root}/.novel/story-compass.json`,
      compass: after,
      openThreadCount: after.openThreads.length,
      addedThreads,
      removedThreads,
      meta: PLANNING_WRITE_META,
    }
  })
}

// ============================================================================
// 5. foreshadowing.upsert
// ============================================================================

export interface ForeshadowingUpsertDeps {
  loadForeshadowingTracker?: (projectPath: string) => Promise<ForeshadowingStore>
  saveForeshadowingTracker?: (projectPath: string, store: ForeshadowingStore) => Promise<void>
  now?: () => string
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface ForeshadowingUpsertResult {
  projectPath: string
  path: string
  action: "created" | "updated"
  item: Foreshadowing
  totalCount: number
  activeCount: number
  meta: typeof PLANNING_WRITE_META
}

async function generateStableAsciiId(
  prefix: string,
  label: string,
  existingIds: ReadonlySet<string>,
): Promise<string> {
  const digest = (await computeCheckpointDigest(`${prefix}:${label}`)).slice(0, 12)
  let candidate = `${prefix}_${digest}`
  let suffix = 2
  while (existingIds.has(candidate)) {
    candidate = `${prefix}_${digest}_${suffix}`
    suffix += 1
  }
  return candidate
}

export async function runForeshadowingUpsert(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: ForeshadowingUpsertDeps,
): Promise<ForeshadowingUpsertResult> {
  const toolName = "foreshadowing.upsert"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, FORESHADOWING_UPSERT_KEYS, new Set(), toolName)

  const id = "id" in clean ? validateAsciiId(clean.id, toolName, "id") : undefined
  const name =
    "name" in clean ? validateSingleLineString(clean.name, toolName, "name", 1, 200) : undefined
  if (id === undefined && name === undefined) {
    throw new Error(`${toolName}: 至少需提供 \`id\` 或 \`name\``)
  }

  const description =
    "description" in clean
      ? validateMultilineString(clean.description, toolName, "description", 0, 2_000)
      : undefined
  let status: ForeshadowingStatus | undefined
  if ("status" in clean) {
    if (typeof clean.status !== "string" || !FORESHADOWING_STATUS_SET.has(clean.status)) {
      throw new Error(`${toolName}: \`status\` 仅支持 planted | advanced | resolved | abandoned`)
    }
    status = clean.status as ForeshadowingStatus
  }
  const plantedChapter =
    "plantedChapter" in clean
      ? validatePositiveInt(clean.plantedChapter, toolName, "plantedChapter", 1, MAX_CHAPTER_NUMBER)
      : undefined
  const advancedChapters =
    "advancedChapters" in clean
      ? validatePositiveIntArray(
          clean.advancedChapters,
          toolName,
          "advancedChapters",
          200,
          MAX_CHAPTER_NUMBER,
        )
      : undefined
  const resolvedChapter =
    "resolvedChapter" in clean
      ? validatePositiveInt(
          clean.resolvedChapter,
          toolName,
          "resolvedChapter",
          1,
          MAX_CHAPTER_NUMBER,
        )
      : undefined
  const relatedCharacters =
    "relatedCharacters" in clean
      ? validateStringArray(clean.relatedCharacters, toolName, "relatedCharacters", {
          maxItems: 100,
          maxItemChars: 128,
          singleLine: true,
        })
      : undefined
  const relatedEvents =
    "relatedEvents" in clean
      ? validateStringArray(clean.relatedEvents, toolName, "relatedEvents", {
          maxItems: 100,
          maxItemChars: 200,
          singleLine: true,
        })
      : undefined
  const notes =
    "notes" in clean ? validateMultilineString(clean.notes, toolName, "notes", 0, 2_000) : undefined

  const loadTracker = deps?.loadForeshadowingTracker ?? loadForeshadowingTracker
  const saveTracker = deps?.saveForeshadowingTracker ?? saveForeshadowingTracker
  const nowFn = deps?.now ?? (() => new Date().toISOString())

  return runLocked(root, deps?.withLock, async () => {
    const store = await loadTracker(root)
    const items = [...store.items]
    const existingIndex =
      id !== undefined
        ? items.findIndex((entry) => entry.id === id)
        : items.findIndex((entry) => entry.name.trim() === name)

    let action: "created" | "updated"
    let upserted: Foreshadowing

    if (existingIndex >= 0) {
      action = "updated"
      let existing = items[existingIndex]
      if (status === "abandoned" && existing.status !== "abandoned") {
        // 复用既有不可逆转移守卫（禁止 resolved -> abandoned）
        existing = markAbandoned(existing)
      }
      const nextStatus = status ?? existing.status
      const nextResolvedChapter =
        resolvedChapter !== undefined ? resolvedChapter : existing.resolvedChapter
      upserted = {
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        status: nextStatus,
        plantedChapter: plantedChapter ?? existing.plantedChapter,
        advancedChapters: advancedChapters ?? [...existing.advancedChapters],
        ...(nextResolvedChapter !== undefined ? { resolvedChapter: nextResolvedChapter } : {}),
        relatedCharacters: relatedCharacters ?? [...existing.relatedCharacters],
        relatedEvents: relatedEvents ?? [...existing.relatedEvents],
        notes: notes ?? existing.notes,
      }
      items[existingIndex] = upserted
    } else {
      if (name === undefined) {
        throw new Error(`${toolName}: 新建伏笔（id=${id} 不存在）时必须提供 \`name\``)
      }
      if (status === "abandoned") {
        throw new Error(`${toolName}: 新建伏笔不允许直接设为 abandoned（请先创建 planted/advanced）`)
      }
      action = "created"
      const existingIds = new Set(items.map((entry) => entry.id))
      const assignedId = id ?? (await generateStableAsciiId("fs", name, existingIds))
      upserted = {
        id: assignedId,
        name,
        description: description ?? "",
        status: status ?? "planted",
        plantedChapter: plantedChapter ?? 1,
        advancedChapters: advancedChapters ?? [],
        ...(resolvedChapter !== undefined ? { resolvedChapter } : {}),
        relatedCharacters: relatedCharacters ?? [],
        relatedEvents: relatedEvents ?? [],
        notes: notes ?? "",
      }
      items.push(upserted)
    }

    const nextStore: ForeshadowingStore = {
      items,
      lastUpdated: nowFn(),
    }
    await saveTracker(root, nextStore)

    return {
      projectPath: root,
      path: `${root}/.novel/foreshadowing-tracker.json`,
      action,
      item: upserted,
      totalCount: nextStore.items.length,
      activeCount: getActiveForeshadowings(nextStore).length,
      meta: PLANNING_WRITE_META,
    }
  })
}

// ============================================================================
// 6. subplot.upsert
// ============================================================================

export interface SubplotUpsertDeps {
  loadSubplotBoard?: (projectPath: string) => Promise<SubplotBoardStore>
  saveSubplotBoard?: (projectPath: string, store: SubplotBoardStore) => Promise<void>
  now?: () => string
  withLock?: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>
}

export interface SubplotUpsertResult {
  projectPath: string
  path: string
  action: "created" | "updated"
  item: Subplot
  totalCount: number
  activeCount: number
  meta: typeof PLANNING_WRITE_META
}

export async function runSubplotUpsert(
  projectPath: string,
  params: Record<string, unknown>,
  deps?: SubplotUpsertDeps,
): Promise<SubplotUpsertResult> {
  const toolName = "subplot.upsert"
  const root = assertProjectPath(projectPath, toolName)
  const clean = normalizeStrictObject(params, SUBPLOT_UPSERT_KEYS, new Set(), toolName)

  const id = "id" in clean ? validateAsciiId(clean.id, toolName, "id") : undefined
  const title =
    "title" in clean ? validateSingleLineString(clean.title, toolName, "title", 1, 200) : undefined
  if (id === undefined && title === undefined) {
    throw new Error(`${toolName}: 至少需提供 \`id\` 或 \`title\``)
  }

  let status: SubplotStatus | undefined
  if ("status" in clean) {
    if (typeof clean.status !== "string" || !SUBPLOT_STATUS_SET.has(clean.status)) {
      throw new Error(`${toolName}: \`status\` 仅支持 proposed | active | paused | resolved`)
    }
    status = clean.status as SubplotStatus
  }
  const startChapter =
    "startChapter" in clean
      ? validatePositiveInt(clean.startChapter, toolName, "startChapter", 1, MAX_CHAPTER_NUMBER)
      : undefined
  const resolvedChapter =
    "resolvedChapter" in clean
      ? validatePositiveInt(
          clean.resolvedChapter,
          toolName,
          "resolvedChapter",
          1,
          MAX_CHAPTER_NUMBER,
        )
      : undefined
  const lastSeenChapter =
    "lastSeenChapter" in clean
      ? validatePositiveInt(
          clean.lastSeenChapter,
          toolName,
          "lastSeenChapter",
          1,
          MAX_CHAPTER_NUMBER,
        )
      : undefined
  const targetResolutionChapter =
    "targetResolutionChapter" in clean
      ? validatePositiveInt(
          clean.targetResolutionChapter,
          toolName,
          "targetResolutionChapter",
          1,
          MAX_CHAPTER_NUMBER,
        )
      : undefined
  const abandoned =
    "abandoned" in clean ? validateBoolean(clean.abandoned, toolName, "abandoned") : undefined
  const relatedCharacters =
    "relatedCharacters" in clean
      ? validateStringArray(clean.relatedCharacters, toolName, "relatedCharacters", {
          maxItems: 100,
          maxItemChars: 128,
          singleLine: true,
        })
      : undefined
  const summary =
    "summary" in clean
      ? validateMultilineString(clean.summary, toolName, "summary", 0, 2_000)
      : undefined
  const progressEntry =
    "progressEntry" in clean
      ? validateMultilineString(clean.progressEntry, toolName, "progressEntry", 1, 1_000)
      : undefined
  const progress =
    "progress" in clean
      ? validateStringArray(clean.progress, toolName, "progress", {
          maxItems: 200,
          maxItemChars: 1_000,
        })
      : undefined
  const notes =
    "notes" in clean ? validateMultilineString(clean.notes, toolName, "notes", 0, 2_000) : undefined

  const loadBoard = deps?.loadSubplotBoard ?? loadSubplotBoard
  const saveBoard = deps?.saveSubplotBoard ?? saveSubplotBoard
  const nowFn = deps?.now ?? (() => new Date().toISOString())

  return runLocked(root, deps?.withLock, async () => {
    const store = await loadBoard(root)
    const items = [...store.items]
    const existingIndex =
      id !== undefined
        ? items.findIndex((entry) => entry.id === id)
        : items.findIndex((entry) => entry.title.trim() === title)

    let action: "created" | "updated"
    let upserted: Subplot

    if (existingIndex >= 0) {
      action = "updated"
      const existing = items[existingIndex]
      const baseProgress = progress !== undefined ? [...progress] : [...existing.progress]
      if (progressEntry && baseProgress[baseProgress.length - 1] !== progressEntry) {
        baseProgress.push(progressEntry)
      }
      const nextResolved = resolvedChapter !== undefined ? resolvedChapter : existing.resolvedChapter
      const nextLastSeen = lastSeenChapter !== undefined ? lastSeenChapter : existing.lastSeenChapter
      const nextTarget =
        targetResolutionChapter !== undefined
          ? targetResolutionChapter
          : existing.targetResolutionChapter
      const nextAbandoned = abandoned !== undefined ? abandoned : existing.abandoned

      upserted = {
        ...existing,
        title: title ?? existing.title,
        status: status ?? existing.status,
        startChapter: startChapter ?? existing.startChapter,
        ...(nextResolved !== undefined ? { resolvedChapter: nextResolved } : {}),
        ...(nextLastSeen !== undefined ? { lastSeenChapter: nextLastSeen } : {}),
        ...(nextTarget !== undefined ? { targetResolutionChapter: nextTarget } : {}),
        ...(nextAbandoned !== undefined ? { abandoned: nextAbandoned } : {}),
        relatedCharacters: relatedCharacters ?? [...existing.relatedCharacters],
        summary: summary ?? existing.summary,
        progress: baseProgress,
        notes: notes ?? existing.notes,
      }
      items[existingIndex] = upserted
    } else {
      if (title === undefined) {
        throw new Error(`${toolName}: 新建支线（id=${id} 不存在）时必须提供 \`title\``)
      }
      action = "created"
      const existingIds = new Set(items.map((entry) => entry.id))
      const assignedId = id ?? (await generateStableAsciiId("sp", title, existingIds))
      const initialProgress = progress !== undefined ? [...progress] : []
      if (progressEntry && initialProgress[initialProgress.length - 1] !== progressEntry) {
        initialProgress.push(progressEntry)
      }
      upserted = {
        id: assignedId,
        title,
        status: status ?? "active",
        startChapter: startChapter ?? 1,
        ...(resolvedChapter !== undefined ? { resolvedChapter } : {}),
        ...(lastSeenChapter !== undefined ? { lastSeenChapter } : {}),
        ...(targetResolutionChapter !== undefined ? { targetResolutionChapter } : {}),
        ...(abandoned !== undefined ? { abandoned } : {}),
        relatedCharacters: relatedCharacters ?? [],
        summary: summary ?? "",
        progress: initialProgress,
        notes: notes ?? "",
      }
      items.push(upserted)
    }

    const nextStore: SubplotBoardStore = {
      items,
      lastUpdated: nowFn(),
    }
    await saveBoard(root, nextStore)

    return {
      projectPath: root,
      path: `${root}/.novel/subplot-board.json`,
      action,
      item: upserted,
      totalCount: nextStore.items.length,
      activeCount: nextStore.items.filter((s) => s.status !== "resolved" && s.abandoned !== true)
        .length,
      meta: PLANNING_WRITE_META,
    }
  })
}
