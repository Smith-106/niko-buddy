// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * skills-read-tools.ts — 零 LLM / 零写盘 / 零外网只读技能 MCP 工具门面（Wave 2）。
 *
 * 严格依赖与安全边界：
 * 1. 所有 novel 域符号严格仅经 `@/lib/novel` 顶层 barrel 导入（零 `@/lib/novel/*` 深导入，
 *    满足 ESLint `boundaries/dependencies` 窄接口）；
 * 2. 严格零 LLM 调用、零磁盘写入（绝不调用带惰性迁移写盘的 `loadUserSkillConfig` /
 *    `loadDeAiSkillConfig`）；
 * 3. 入参校验与 Rust 侧 `normalize_strict_object_args` 1:1 对称：
 *    - 拒绝非对象与任意未知键（含值为 `null` 的未知键）；
 *    - 合法可选字段容忍 `undefined` 与显式 `null`（KB `1a05e035`）；
 *    - `skills.get` 在剥离 `null` 后强制至少存在 `ids`/`names`/`stage` 之一；
 * 4. 所有导出符号均使用只读前缀（`run`/`load`/`SKILLS_`/`DEFAULT_`/`MIN_`/`MAX_`），
 *    零写前缀导出。
 */

import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  DEFAULT_SKILL_PRIORITY,
  USER_SKILL_CONFIG_FILE,
  ensureBuiltinSkills,
  getAllDeAiSkills,
  normalizeDeAiSkillConfig,
  normalizeUserSkillConfig,
  resolveSkillReference,
  resolveTaskSkillNames,
  type DeAiSkill,
  type DeAiSkillConfig,
  type SkillKind,
  type SkillMode,
  type SkillStage,
  type UserSkill,
  type UserSkillConfig,
} from "@/lib/novel"
import { isPathInside, normalizePath } from "@/lib/path-utils"
import { useWikiStore, type NovelConfig, type TaskPromptKey } from "@/stores/wiki-store"

const READ_ONLY_META = {
  readOnly: true as const,
  llmCalls: 0 as const,
  diskWrites: 0 as const,
}

const USER_SKILL_LEGACY_ROOT_FILE = "writing-skills.json"
const DE_AI_SKILL_CONFIG_FILE = ".niko-buddy/de-ai-skills.json"
const DE_AI_SKILL_LEGACY_ROOT_FILE = "de-ai-skills.json"
const DE_AI_SKILL_LEGACY_TXT_FILE = "de-ai-skill.txt"

const ALL_TASK_PROMPT_KEYS: readonly TaskPromptKey[] = [
  "writing",
  "outline",
  "review",
  "summary",
  "extract",
]

export const SKILLS_STAGE_VALUES = [
  "planning",
  "drafting",
  "review",
  "rewrite",
  "output",
  "outline",
  "writing",
  "summary",
  "extract",
] as const

export type SkillsStageFilter = (typeof SKILLS_STAGE_VALUES)[number]

export const SKILLS_KIND_VALUES = ["writing", "de_ai", "all"] as const

export type SkillsKindFilter = (typeof SKILLS_KIND_VALUES)[number]

export const SKILLS_MAX_QUERY_CHARS = 200
export const SKILLS_MAX_SELECTOR_ITEMS = 20
export const SKILLS_DEFAULT_PAGE_LIMIT = 50
export const SKILLS_MAX_PAGE_LIMIT = 200
export const SKILLS_MAX_OFFSET = 100_000
export const DEFAULT_MAX_CHARS_PER_SKILL = 6_000
export const MIN_MAX_CHARS_PER_SKILL = 200
export const MAX_MAX_CHARS_PER_SKILL = 20_000
export const DEFAULT_MAX_TOTAL_CHARS = 18_000
export const MIN_MAX_TOTAL_CHARS = 500
export const MAX_MAX_TOTAL_CHARS = 30_000

const SKILLS_STAGE_SET: ReadonlySet<string> = new Set(SKILLS_STAGE_VALUES)
const SKILLS_KIND_SET: ReadonlySet<string> = new Set(SKILLS_KIND_VALUES)

const STAGE_TO_SKILL_STAGE: Record<SkillsStageFilter, SkillStage> = {
  planning: "planning",
  outline: "planning",
  drafting: "drafting",
  writing: "drafting",
  review: "review",
  rewrite: "rewrite",
  output: "output",
  summary: "output",
  extract: "output",
}

const STAGE_TO_TASK_KEY: Record<SkillsStageFilter, TaskPromptKey | null> = {
  planning: "outline",
  outline: "outline",
  drafting: "writing",
  writing: "writing",
  review: "review",
  rewrite: null,
  output: null,
  summary: "summary",
  extract: "extract",
}

const SKILLS_LIST_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "kind",
  "includeDeAi",
  "includeBuiltin",
  "enabledOnly",
  "query",
  "offset",
  "limit",
])

const SKILLS_GET_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ids",
  "names",
  "stage",
  "includeDeAi",
  "includeDisabled",
  "stripFrontmatter",
  "maxCharsPerSkill",
  "maxTotalChars",
])

// 单行文本禁止换行及 C0/DEL/C1 控制字符（与 Rust char::is_control 1:1 对称）
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/

export interface ReadOnlyWritingSkillLoadResult {
  config: UserSkillConfig
  source: "project_v2" | "legacy_json" | "built_in_default"
  corrupt: boolean
}

export interface ReadOnlyDeAiSkillLoadResult {
  config: DeAiSkillConfig
  source: "project_v2" | "legacy_json" | "legacy_txt" | "built_in_default"
  corrupt: boolean
}

export interface SkillsReadDeps {
  readFileText?: (path: string) => Promise<string>
  getNovelConfig?: () => Pick<NovelConfig, "taskSkillNames"> | undefined
}

export interface SkillsListItem {
  id: string
  name: string
  description: string
  library: "writing" | "de_ai"
  source: UserSkill["source"] | DeAiSkill["source"]
  builtin: boolean
  enabled: boolean
  skillKinds: SkillKind[]
  stages: SkillStage[]
  modes: SkillMode[]
  priority: number
  tags: string[]
  categoryId: string
  configuredTaskKeys: TaskPromptKey[]
  configuredForStage: boolean
  contentChars: number
  isDefaultDeAi?: boolean
}

export interface SkillsListResult {
  projectPath: string
  filters: {
    stage: SkillsStageFilter | null
    mappedSkillStage: SkillStage | null
    mappedTaskKey: TaskPromptKey | null
    kind: SkillsKindFilter
    includeDeAi: boolean
    includeBuiltin: boolean
    enabledOnly: boolean
    query: string | null
    offset: number
    limit: number
  }
  sources: {
    writing: ReadOnlyWritingSkillLoadResult["source"]
    writingCorrupt: boolean
    deAi: ReadOnlyDeAiSkillLoadResult["source"]
    deAiCorrupt: boolean
  }
  counts: {
    totalInCatalog: number
    writingTotal: number
    deAiTotal: number
    matched: number
  }
  total: number
  returned: number
  hasMore: boolean
  items: SkillsListItem[]
  meta: {
    readOnly: true
    llmCalls: 0
    diskWrites: 0
  }
}

export interface SkillsGetItem {
  id: string
  name: string
  description: string
  library: "writing" | "de_ai"
  source: UserSkill["source"] | DeAiSkill["source"]
  builtin: boolean
  enabled: boolean
  skillKinds: SkillKind[]
  stages: SkillStage[]
  modes: SkillMode[]
  priority: number
  tags: string[]
  categoryId: string
  configuredTaskKeys: TaskPromptKey[]
  configuredForStage: boolean
  content: string
  frontmatterStripped: boolean
  originalChars: number
  returnedChars: number
  truncated: boolean
}

export interface SkillsGetResult {
  projectPath: string
  query: {
    ids: string[]
    names: string[]
    stage: SkillsStageFilter | null
    mappedSkillStage: SkillStage | null
    mappedTaskKey: TaskPromptKey | null
    includeDeAi: boolean
    includeDisabled: boolean
    stripFrontmatter: boolean
    maxCharsPerSkill: number
    maxTotalChars: number
  }
  returned: number
  totalReturnedChars: number
  totalTruncated: boolean
  skills: SkillsGetItem[]
  notFound: string[]
  disabledSkipped: string[]
  omittedDueToBudget: string[]
  meta: {
    readOnly: true
    llmCalls: 0
    diskWrites: 0
  }
}

interface UnifiedSkillRecord {
  id: string
  name: string
  description: string
  library: "writing" | "de_ai"
  source: UserSkill["source"] | DeAiSkill["source"]
  builtin: boolean
  enabled: boolean
  skillKinds: SkillKind[]
  stages: SkillStage[]
  modes: SkillMode[]
  priority: number
  tags: string[]
  categoryId: string
  configuredTaskKeys: TaskPromptKey[]
  configuredForStage: boolean
  content: string
  linkedPath?: string
  isDefaultDeAi?: boolean
}

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
  if (raw === undefined || raw === null) return undefined
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
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${toolName} 的 ${field} 必须是 ${min}..${max} 的整数`)
  }
  return raw
}

function readOptionalSingleLineString(
  params: Record<string, unknown>,
  field: string,
  maxChars: number,
  toolName: string,
): string | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") {
    throw new Error(`${toolName} 的 ${field} 必须是字符串`)
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error(`${toolName} 的 ${field} 必须是单行文本（禁止换行与控制字符）`)
  }
  if ([...raw].length > maxChars) {
    throw new Error(`${toolName} 的 ${field} 超过 ${maxChars} 字符上限`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error(`${toolName} 的 ${field} 不能为空字符串`)
  }
  return trimmed
}

function readOptionalEnum<T extends string>(
  params: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
  allowedList: readonly T[],
  toolName: string,
): T | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string" || !allowed.has(raw)) {
    throw new Error(`${toolName} 的 ${field} 仅支持：${allowedList.join(" / ")}`)
  }
  return raw as T
}

function readOptionalSelectorArray(
  params: Record<string, unknown>,
  field: string,
  toolName: string,
): string[] | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new Error(`${toolName} 的 ${field} 必须是字符串数组`)
  }
  if (raw.length === 0) {
    throw new Error(`${toolName} 的 ${field} 不能为空数组`)
  }
  if (raw.length > SKILLS_MAX_SELECTOR_ITEMS) {
    throw new Error(`${toolName} 的 ${field} 最多允许 ${SKILLS_MAX_SELECTOR_ITEMS} 项`)
  }
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`${toolName} 的 ${field} 每项必须是非空字符串`)
    }
    if (CONTROL_CHAR_RE.test(item)) {
      throw new Error(`${toolName} 的 ${field} 每项必须是单行文本（禁止换行与控制字符）`)
    }
    if ([...item].length > SKILLS_MAX_QUERY_CHARS) {
      throw new Error(`${toolName} 的 ${field} 单项超过 ${SKILLS_MAX_QUERY_CHARS} 字符上限`)
    }
    const trimmed = item.trim()
    if (trimmed.length === 0) {
      throw new Error(`${toolName} 的 ${field} 不允许包含空字符串`)
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      deduped.push(trimmed)
    }
  }
  return deduped
}

function isFileByPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".json")
}

/**
 * 严格只读加载项目写作技能配置（绝不调用带惰性迁移写盘的 `loadUserSkillConfig`）。
 *
 * 读取顺序：`.niko-buddy/writing-skills.json` → `writing-skills.json` → 内置默认；
 * 无论文件存在与否，均经 `ensureBuiltinSkills(normalizeUserSkillConfig(...))` 合并全部内置技能。
 */
export async function loadWritingSkillConfigReadOnly(
  projectPath: string,
  readFileText: (path: string) => Promise<string> = readFile,
): Promise<ReadOnlyWritingSkillLoadResult> {
  const root = projectRoot(projectPath)
  if (!root) {
    return {
      config: ensureBuiltinSkills(normalizeUserSkillConfig(null)),
      source: "built_in_default",
      corrupt: false,
    }
  }

  try {
    const raw = await readFileText(`${root}/${USER_SKILL_CONFIG_FILE}`)
    try {
      return {
        config: ensureBuiltinSkills(normalizeUserSkillConfig(JSON.parse(raw))),
        source: "project_v2",
        corrupt: false,
      }
    } catch {
      return {
        config: ensureBuiltinSkills(normalizeUserSkillConfig(null)),
        source: "built_in_default",
        corrupt: true,
      }
    }
  } catch {
    // 主配置文件不存在，只读回退旧根路径（严禁迁移落盘）
  }

  try {
    const legacyRaw = await readFileText(`${root}/${USER_SKILL_LEGACY_ROOT_FILE}`)
    try {
      return {
        config: ensureBuiltinSkills(normalizeUserSkillConfig(JSON.parse(legacyRaw))),
        source: "legacy_json",
        corrupt: false,
      }
    } catch {
      return {
        config: ensureBuiltinSkills(normalizeUserSkillConfig(null)),
        source: "built_in_default",
        corrupt: true,
      }
    }
  } catch {
    // 旧根路径同样不存在，回退内置默认
  }

  return {
    config: ensureBuiltinSkills(normalizeUserSkillConfig(null)),
    source: "built_in_default",
    corrupt: false,
  }
}

/**
 * 严格只读加载去 AI 味技能配置（绝不调用带惰性迁移写盘的 `loadDeAiSkillConfig`）。
 *
 * 读取顺序：`.niko-buddy/de-ai-skills.json` → `de-ai-skills.json` → `de-ai-skill.txt` → 内置默认。
 */
export async function loadDeAiSkillConfigReadOnly(
  projectPath: string,
  readFileText: (path: string) => Promise<string> = readFile,
): Promise<ReadOnlyDeAiSkillLoadResult> {
  const root = projectRoot(projectPath)
  if (!root) {
    return {
      config: normalizeDeAiSkillConfig(null),
      source: "built_in_default",
      corrupt: false,
    }
  }

  try {
    const raw = await readFileText(`${root}/${DE_AI_SKILL_CONFIG_FILE}`)
    try {
      return {
        config: normalizeDeAiSkillConfig(JSON.parse(raw)),
        source: "project_v2",
        corrupt: false,
      }
    } catch {
      return {
        config: normalizeDeAiSkillConfig(null),
        source: "built_in_default",
        corrupt: true,
      }
    }
  } catch {
    // 新路径不存在，只读回退旧路径（不迁移落盘）
  }

  try {
    const legacyRaw = await readFileText(`${root}/${DE_AI_SKILL_LEGACY_ROOT_FILE}`)
    try {
      return {
        config: normalizeDeAiSkillConfig(JSON.parse(legacyRaw)),
        source: "legacy_json",
        corrupt: false,
      }
    } catch {
      return {
        config: normalizeDeAiSkillConfig(null),
        source: "built_in_default",
        corrupt: true,
      }
    }
  } catch {
    // 无旧 JSON，回退旧 txt
  }

  try {
    const legacyTxt = (await readFileText(`${root}/${DE_AI_SKILL_LEGACY_TXT_FILE}`)).trim()
    if (legacyTxt) {
      const legacySkill: DeAiSkill = {
        id: "project:legacy-de-ai-skill",
        name: "旧版自定义去AI味 Skill",
        description: "从旧版 de-ai-skill.txt 读取的项目规则。",
        templateId: "legacy",
        content: legacyTxt,
        source: "legacy",
      }
      return {
        config: normalizeDeAiSkillConfig({
          defaultSkillId: legacySkill.id,
          projectSkills: [legacySkill],
        }),
        source: "legacy_txt",
        corrupt: false,
      }
    }
  } catch {
    // 无旧 txt，回退内置默认
  }

  return {
    config: normalizeDeAiSkillConfig(null),
    source: "built_in_default",
    corrupt: false,
  }
}

function buildConfiguredTaskMap(
  novelConfig: Pick<NovelConfig, "taskSkillNames"> | undefined,
): Map<TaskPromptKey, Set<string>> {
  const map = new Map<TaskPromptKey, Set<string>>()
  for (const key of ALL_TASK_PROMPT_KEYS) {
    const names = resolveTaskSkillNames(novelConfig, key)
    if (names.length > 0) {
      map.set(key, new Set(names))
    }
  }
  return map
}

function findConfiguredTaskKeys(
  id: string,
  name: string,
  taskMap: ReadonlyMap<TaskPromptKey, ReadonlySet<string>>,
): TaskPromptKey[] {
  const keys: TaskPromptKey[] = []
  for (const key of ALL_TASK_PROMPT_KEYS) {
    const configured = taskMap.get(key)
    if (configured && (configured.has(id) || configured.has(name))) {
      keys.push(key)
    }
  }
  return keys
}

function buildUnifiedCatalog(
  writingConfig: UserSkillConfig,
  deAiConfig: DeAiSkillConfig,
  novelConfig: Pick<NovelConfig, "taskSkillNames"> | undefined,
  mappedTaskKey: TaskPromptKey | null,
): {
  records: UnifiedSkillRecord[]
  writingTotal: number
  deAiTotal: number
} {
  const taskMap = buildConfiguredTaskMap(novelConfig)
  const writingDisabled = new Set(writingConfig.disabledSkillIds)
  const deAiDisabled = new Set(deAiConfig.disabledSkillIds)

  const writingRecords: UnifiedSkillRecord[] = writingConfig.skills.map((skill) => {
    const configuredTaskKeys = findConfiguredTaskKeys(skill.id, skill.name, taskMap)
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      library: "writing",
      source: skill.source,
      builtin: skill.source === "built-in",
      enabled: !writingDisabled.has(skill.id),
      skillKinds: [...skill.kind],
      stages: [...skill.stages],
      modes: [...skill.modes],
      priority: skill.priority,
      tags: [...skill.tags],
      categoryId: skill.categoryId,
      configuredTaskKeys,
      configuredForStage: mappedTaskKey !== null && configuredTaskKeys.includes(mappedTaskKey),
      content: skill.content,
      linkedPath: skill.linkedPath,
    }
  })

  const deAiSkills = getAllDeAiSkills(deAiConfig)
  const deAiRecords: UnifiedSkillRecord[] = deAiSkills.map((skill) => {
    const configuredTaskKeys = findConfiguredTaskKeys(skill.id, skill.name, taskMap)
    const tags = ["de-ai"]
    if (skill.templateId && skill.templateId !== "de-ai") {
      tags.push(skill.templateId)
    }
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      library: "de_ai",
      source: skill.source,
      builtin: skill.source === "built-in",
      enabled: !deAiDisabled.has(skill.id),
      skillKinds: ["style"],
      stages: ["rewrite", "output"],
      modes: ["fast", "standard", "strict"],
      priority: DEFAULT_SKILL_PRIORITY,
      tags,
      categoryId: "",
      configuredTaskKeys,
      configuredForStage: mappedTaskKey !== null && configuredTaskKeys.includes(mappedTaskKey),
      content: skill.content,
      isDefaultDeAi: skill.id === deAiConfig.defaultSkillId,
    }
  })

  return {
    records: [...writingRecords, ...deAiRecords],
    writingTotal: writingRecords.length,
    deAiTotal: deAiRecords.length,
  }
}

function compareSkillRecords(left: UnifiedSkillRecord, right: UnifiedSkillRecord): number {
  if (left.configuredForStage !== right.configuredForStage) {
    return left.configuredForStage ? -1 : 1
  }
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1
  }
  if (left.priority !== right.priority) {
    return left.priority - right.priority
  }
  return left.id.localeCompare(right.id)
}

function matchesStageFilter(
  record: UnifiedSkillRecord,
  mappedSkillStage: SkillStage | null,
): boolean {
  if (mappedSkillStage === null) return true
  return record.configuredForStage || record.stages.includes(mappedSkillStage)
}

function matchesQuery(record: UnifiedSkillRecord, needleLower: string): boolean {
  if (record.id.toLowerCase().includes(needleLower)) return true
  if (record.name.toLowerCase().includes(needleLower)) return true
  if (record.description.toLowerCase().includes(needleLower)) return true
  if (record.categoryId.toLowerCase().includes(needleLower)) return true
  return record.tags.some((tag) => tag.toLowerCase().includes(needleLower))
}

function resolveNovelConfig(deps?: SkillsReadDeps): Pick<NovelConfig, "taskSkillNames"> | undefined {
  if (deps?.getNovelConfig) return deps.getNovelConfig()
  try {
    return useWikiStore.getState().novelConfig
  } catch {
    return undefined
  }
}

function resolveSafeLinkedSkillPath(linkedPath: string, root: string): string | null {
  const normalizedRoot = normalizePath(root.trim()).replace(/\/+$/, "")
  if (!normalizedRoot) return null
  if (CONTROL_CHAR_RE.test(linkedPath)) return null
  const trimmed = linkedPath.trim()
  if (!trimmed) return null
  // 拒绝 UNC 网络/设备路径前缀（// 或 \\）
  if (trimmed.startsWith("//") || trimmed.startsWith("\\\\")) return null
  const normalized = normalizePath(trimmed)
  if (normalized.startsWith("//")) return null
  const stripped = normalized.replace(/\/+$/, "")
  if (!stripped) return null
  const rawSegments = stripped.split("/")
  if (rawSegments.some((seg) => seg === "..")) return null

  const isUnixAbs = stripped.startsWith("/")
  const isWinDriveAbs = /^[A-Za-z]:\//.test(stripped)
  let resolvedBase: string
  if (isUnixAbs || isWinDriveAbs) {
    const pathBody = isWinDriveAbs ? stripped.slice(2) : stripped
    if (pathBody.includes(":")) return null
    resolvedBase = stripped.replace(/\/+/g, "/")
  } else {
    // 相对路径拒绝盘符相对路径（如 `C:foo`）与冒号流技巧
    if (/^[A-Za-z]:/.test(stripped) || stripped.includes(":")) return null
    const cleanRelSegments = rawSegments.filter((seg) => seg !== "" && seg !== ".")
    if (cleanRelSegments.length === 0) return null
    resolvedBase = `${normalizedRoot}/${cleanRelSegments.join("/")}`
  }

  const targetPath = isFileByPath(resolvedBase)
    ? resolvedBase
    : `${resolvedBase}/SKILL.md`
  const normalizedTarget = normalizePath(targetPath)
  if (
    !isPathInside(normalizedTarget, normalizedRoot) ||
    normalizedTarget.toLowerCase() === normalizedRoot.toLowerCase()
  ) {
    return null
  }
  return normalizedTarget
}

async function readLinkedSkillSingleFileReadOnly(
  record: UnifiedSkillRecord,
  root: string,
  readFileText: (path: string) => Promise<string>,
): Promise<string> {
  if (record.source !== "linked" || typeof record.linkedPath !== "string") {
    return record.content
  }
  const targetPath = resolveSafeLinkedSkillPath(record.linkedPath, root)
  if (!targetPath) {
    // 越界或非法外链路径：fail-closed，绝不触发 readFileText，直接回退已缓存正文
    return record.content
  }
  try {
    const content = await readFileText(targetPath)
    return content.trim().length > 0 ? content : record.content
  } catch {
    // 严格只读且单文件失败不抛出，平滑回退已缓存正文
    return record.content
  }
}

function truncateSkillContent(body: string, limit: number): { text: string; truncated: boolean } {
  if (body.length <= limit) {
    return { text: body, truncated: false }
  }
  const marker = "\n...[技能正文已截断]"
  if (limit > marker.length) {
    return {
      text: `${body.slice(0, limit - marker.length)}${marker}`,
      truncated: true,
    }
  }
  return {
    text: body.slice(0, Math.max(0, limit)),
    truncated: true,
  }
}

/**
 * 零 LLM / 零写盘技能目录浏览（对应 MCP `skills.list` / `skills-list`）。
 * 仅返回轻量元数据与 `contentChars`，绝不返回正文，防止上下文膨胀。
 */
export async function runSkillsList(
  projectPath: string,
  params: Record<string, unknown> = {},
  deps?: SkillsReadDeps,
): Promise<SkillsListResult> {
  const toolName = "skills.list"
  const root = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, SKILLS_LIST_ALLOWED_KEYS, toolName)

  const stage = readOptionalEnum(params, "stage", SKILLS_STAGE_SET, SKILLS_STAGE_VALUES, toolName)
  const kind = readOptionalEnum(params, "kind", SKILLS_KIND_SET, SKILLS_KIND_VALUES, toolName) ?? "all"
  const includeDeAi = readOptionalBoolean(params, "includeDeAi", toolName) ?? true
  const includeBuiltin = readOptionalBoolean(params, "includeBuiltin", toolName) ?? true
  const enabledOnly = readOptionalBoolean(params, "enabledOnly", toolName) ?? false
  const query = readOptionalSingleLineString(params, "query", SKILLS_MAX_QUERY_CHARS, toolName)
  const offset = readOptionalIntInRange(params, "offset", 0, SKILLS_MAX_OFFSET, toolName) ?? 0
  const limit = readOptionalIntInRange(params, "limit", 1, SKILLS_MAX_PAGE_LIMIT, toolName) ?? SKILLS_DEFAULT_PAGE_LIMIT

  const mappedSkillStage = stage ? STAGE_TO_SKILL_STAGE[stage] : null
  const mappedTaskKey = stage ? STAGE_TO_TASK_KEY[stage] : null
  const reader = deps?.readFileText ?? readFile

  const [writingLoad, deAiLoad] = await Promise.all([
    loadWritingSkillConfigReadOnly(root, reader),
    loadDeAiSkillConfigReadOnly(root, reader),
  ])
  const novelConfig = resolveNovelConfig(deps)

  const { records, writingTotal, deAiTotal } = buildUnifiedCatalog(
    writingLoad.config,
    deAiLoad.config,
    novelConfig,
    mappedTaskKey,
  )

  const queryLower = query ? query.toLowerCase() : null
  const filtered = records
    .filter((record) => {
      if (kind === "writing" && record.library !== "writing") return false
      if (kind === "de_ai" && record.library !== "de_ai") return false
      if (!includeDeAi && record.library === "de_ai") return false
      if (!includeBuiltin && record.builtin) return false
      if (enabledOnly && !record.enabled) return false
      if (!matchesStageFilter(record, mappedSkillStage)) return false
      if (queryLower !== null && !matchesQuery(record, queryLower)) return false
      return true
    })
    .sort(compareSkillRecords)

  const page = filtered.slice(offset, offset + limit)
  const items: SkillsListItem[] = page.map((record) => ({
    id: record.id,
    name: record.name,
    description: record.description,
    library: record.library,
    source: record.source,
    builtin: record.builtin,
    enabled: record.enabled,
    skillKinds: record.skillKinds,
    stages: record.stages,
    modes: record.modes,
    priority: record.priority,
    tags: record.tags,
    categoryId: record.categoryId,
    configuredTaskKeys: record.configuredTaskKeys,
    configuredForStage: record.configuredForStage,
    contentChars: record.content.length,
    ...(record.isDefaultDeAi !== undefined ? { isDefaultDeAi: record.isDefaultDeAi } : {}),
  }))

  return {
    projectPath: root,
    filters: {
      stage: stage ?? null,
      mappedSkillStage,
      mappedTaskKey,
      kind,
      includeDeAi,
      includeBuiltin,
      enabledOnly,
      query: query ?? null,
      offset,
      limit,
    },
    sources: {
      writing: writingLoad.source,
      writingCorrupt: writingLoad.corrupt,
      deAi: deAiLoad.source,
      deAiCorrupt: deAiLoad.corrupt,
    },
    counts: {
      totalInCatalog: records.length,
      writingTotal,
      deAiTotal,
      matched: filtered.length,
    },
    total: filtered.length,
    returned: items.length,
    hasMore: offset + items.length < filtered.length,
    items,
    meta: READ_ONLY_META,
  }
}

function findByNameSelector(
  pool: readonly UnifiedSkillRecord[],
  name: string,
  includeDisabled: boolean,
): UnifiedSkillRecord | undefined {
  const candidates = includeDisabled
    ? pool
    : [...pool.filter((s) => s.enabled), ...pool.filter((s) => !s.enabled)]
  const exactName = candidates.find((s) => s.name === name)
  if (exactName) return exactName
  const exactId = candidates.find((s) => s.id === name)
  if (exactId) return exactId
  return resolveSkillReference(candidates, { name })
}

/**
 * 零 LLM / 零写盘技能正文按需水合（对应 MCP `skills.get` / `skills-get`）。
 * 强制提供 `ids` / `names` / `stage` 至少一项；默认剥离 YAML frontmatter 并严守单条与总量字符预算。
 */
export async function runSkillsGet(
  projectPath: string,
  params: Record<string, unknown> = {},
  deps?: SkillsReadDeps,
): Promise<SkillsGetResult> {
  const toolName = "skills.get"
  const root = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, SKILLS_GET_ALLOWED_KEYS, toolName)

  const ids = readOptionalSelectorArray(params, "ids", toolName)
  const names = readOptionalSelectorArray(params, "names", toolName)
  const stage = readOptionalEnum(params, "stage", SKILLS_STAGE_SET, SKILLS_STAGE_VALUES, toolName)
  const includeDeAi = readOptionalBoolean(params, "includeDeAi", toolName) ?? true
  const includeDisabled = readOptionalBoolean(params, "includeDisabled", toolName) ?? false
  const stripFrontmatter = readOptionalBoolean(params, "stripFrontmatter", toolName) ?? true
  const maxCharsPerSkill = readOptionalIntInRange(
    params,
    "maxCharsPerSkill",
    MIN_MAX_CHARS_PER_SKILL,
    MAX_MAX_CHARS_PER_SKILL,
    toolName,
  ) ?? DEFAULT_MAX_CHARS_PER_SKILL
  const maxTotalChars = readOptionalIntInRange(
    params,
    "maxTotalChars",
    MIN_MAX_TOTAL_CHARS,
    MAX_MAX_TOTAL_CHARS,
    toolName,
  ) ?? DEFAULT_MAX_TOTAL_CHARS

  if (!ids && !names && !stage) {
    throw new Error("skills.get 至少需要提供 ids、names 或 stage 之一")
  }

  const mappedSkillStage = stage ? STAGE_TO_SKILL_STAGE[stage] : null
  const mappedTaskKey = stage ? STAGE_TO_TASK_KEY[stage] : null
  const reader = deps?.readFileText ?? readFile

  const [writingLoad, deAiLoad] = await Promise.all([
    loadWritingSkillConfigReadOnly(root, reader),
    loadDeAiSkillConfigReadOnly(root, reader),
  ])
  const novelConfig = resolveNovelConfig(deps)

  const { records } = buildUnifiedCatalog(
    writingLoad.config,
    deAiLoad.config,
    novelConfig,
    mappedTaskKey,
  )
  const pool = includeDeAi
    ? records
    : records.filter((record) => record.library !== "de_ai")

  const selected: UnifiedSkillRecord[] = []
  const selectedIds = new Set<string>()
  const notFound: string[] = []
  const notFoundSet = new Set<string>()
  const disabledSkipped: string[] = []
  const disabledSkippedSet = new Set<string>()

  const pushNotFound = (token: string) => {
    if (!notFoundSet.has(token)) {
      notFoundSet.add(token)
      notFound.push(token)
    }
  }
  const pushDisabled = (skillId: string) => {
    if (!disabledSkippedSet.has(skillId)) {
      disabledSkippedSet.add(skillId)
      disabledSkipped.push(skillId)
    }
  }
  const pushSelected = (record: UnifiedSkillRecord) => {
    if (!record.enabled && !includeDisabled) {
      pushDisabled(record.id)
      return
    }
    if (!selectedIds.has(record.id)) {
      selectedIds.add(record.id)
      selected.push(record)
    }
  }

  const hasExplicitSelector = Boolean((ids && ids.length > 0) || (names && names.length > 0))
  if (ids) {
    for (const id of ids) {
      const matched = pool.find((record) => record.id === id)
      if (!matched) {
        pushNotFound(id)
        continue
      }
      pushSelected(matched)
    }
  }

  if (names) {
    for (const name of names) {
      const matched = findByNameSelector(pool, name, includeDisabled)
      if (!matched) {
        pushNotFound(name)
        continue
      }
      pushSelected(matched)
    }
  }

  if (!hasExplicitSelector && stage) {
    const stageMatched = pool
      .filter((record) => matchesStageFilter(record, mappedSkillStage))
      .sort(compareSkillRecords)
    for (const record of stageMatched) {
      pushSelected(record)
    }
  }

  const skills: SkillsGetItem[] = []
  const omittedDueToBudget: string[] = []
  let remainingBudget = maxTotalChars
  let totalReturnedChars = 0
  let totalTruncated = false

  for (const record of selected) {
    if (remainingBudget <= 0) {
      omittedDueToBudget.push(record.id)
      totalTruncated = true
      continue
    }

    const rawContent = await readLinkedSkillSingleFileReadOnly(record, root, reader)
    let body = rawContent.trim()
    let frontmatterStripped = false
    if (stripFrontmatter) {
      const parsed = parseFrontmatter(rawContent)
      body = (parsed?.body ?? rawContent).trim()
      frontmatterStripped = Boolean(parsed?.rawBlock)
    }

    const originalChars = body.length
    const effectiveCap = Math.min(maxCharsPerSkill, remainingBudget)
    const { text: content, truncated } = truncateSkillContent(body, effectiveCap)
    const returnedChars = content.length

    if (truncated) {
      totalTruncated = true
    }
    remainingBudget -= returnedChars
    totalReturnedChars += returnedChars

    skills.push({
      id: record.id,
      name: record.name,
      description: record.description,
      library: record.library,
      source: record.source,
      builtin: record.builtin,
      enabled: record.enabled,
      skillKinds: record.skillKinds,
      stages: record.stages,
      modes: record.modes,
      priority: record.priority,
      tags: record.tags,
      categoryId: record.categoryId,
      configuredTaskKeys: record.configuredTaskKeys,
      configuredForStage: record.configuredForStage,
      content,
      frontmatterStripped,
      originalChars,
      returnedChars,
      truncated,
    })
  }

  return {
    projectPath: root,
    query: {
      ids: ids ?? [],
      names: names ?? [],
      stage: stage ?? null,
      mappedSkillStage,
      mappedTaskKey,
      includeDeAi,
      includeDisabled,
      stripFrontmatter,
      maxCharsPerSkill,
      maxTotalChars,
    },
    returned: skills.length,
    totalReturnedChars,
    totalTruncated,
    skills,
    notFound,
    disabledSkipped,
    omittedDueToBudget,
    meta: READ_ONLY_META,
  }
}
