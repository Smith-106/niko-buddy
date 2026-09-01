import type { SkillKind, SkillStage, SkillMode, SkillCategory, UserSkill } from "@/lib/novel/skill-library"
import type { DeAiSkill } from "@/lib/novel/de-ai-skill-library"
import { getStore } from "@/lib/web-store"
import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { join } from "@tauri-apps/api/path"

export type FavoriteSkillLibrary = "writing" | "de-ai"

export type FavoriteSkillSource = "built-in" | "project" | "uploaded" | "linked" | "legacy"

/**
 * 收藏快照：收藏时固化技能的展示信息，避免原技能被修改/删除后收藏失效。
 * kind/stages/modes 对 de-ai 技能硬编码（DeAiSkill 接口无这些字段）。
 */
export interface FavoriteSkillSnapshot {
  name: string
  description: string
  content: string
  kind: SkillKind[]
  stages: SkillStage[]
  modes: SkillMode[]
  category: string
  /** de-ai 技能的 templateId；writing 为空字符串 */
  templateId: string
}

/**
 * 收藏条目。
 * - favoriteId：crypto.randomUUID() 生成，唯一标识。
 * - skillId：来源技能 id（如 "built-in:comprehensive"、"skill:1700000000000"）。
 * - originProjectPath："" 表示内置/全局；否则为源项目绝对路径。
 */
export interface FavoriteSkillEntry {
  favoriteId: string
  library: FavoriteSkillLibrary
  skillId: string
  originProjectPath: string
  source: FavoriteSkillSource
  snapshot: FavoriteSkillSnapshot
  favoritedAt: number
}

export interface FavoriteSkillConfig {
  version: 1
  favorites: FavoriteSkillEntry[]
}

const EMPTY_FAVORITE_CONFIG: FavoriteSkillConfig = {
  version: 1,
  favorites: [],
}

/**
 * writing 技能快照映射。
 * category 从 writingCategories 反查 categoryId 对应 name（参考 v5 设计 4.2 节）。
 */
export function buildWritingSnapshot(
  skill: UserSkill,
  content: string,
  categories: SkillCategory[],
): FavoriteSkillSnapshot {
  const category = categories.find((c) => c.id === skill.categoryId)
  return {
    name: skill.name,
    description: skill.description,
    content,
    kind: skill.kind,
    stages: skill.stages,
    modes: skill.modes,
    category: category?.name ?? "",
    templateId: "",
  }
}

/**
 * de-ai 技能快照映射。
 * kind/stages/modes 硬编码，参考 deAiSkillToUserSkill:590-606。
 * kind 用 ["style"]（DeAiSkill→UserSkill 标准转换值，v5 设计 E3 已确认）。
 */
export function buildDeAiSnapshot(
  skill: DeAiSkill,
  content: string,
): FavoriteSkillSnapshot {
  return {
    name: skill.name,
    description: skill.description,
    content,
    kind: ["style"],
    stages: ["rewrite", "output"],
    modes: ["fast", "standard", "strict"],
    category: "去AI味",
    templateId: skill.templateId,
  }
}

const FAVORITE_SKILL_CONFIG_KEY = "favoriteSkills"
const configSaveQueues = new Map<string, Promise<void>>()

// G7 (39 号修复): 收藏分轨 — 内置/全局 (originProjectPath === "") 留 app KV;
// 项目级收藏落 {projectPath}/.qmai/skill-favorites.json (随项目迁移)。
const PROJECT_FAVORITES_FILE = ".qmai/skill-favorites.json"

async function loadProjectFavorites(projectPath: string): Promise<FavoriteSkillConfig> {
  try {
    const content = await readFile(await join(projectPath, PROJECT_FAVORITES_FILE))
    const config = JSON.parse(content) as FavoriteSkillConfig
    if (!config || typeof config !== "object" || !Array.isArray(config.favorites)) {
      return EMPTY_FAVORITE_CONFIG
    }
    return { version: 1, favorites: config.favorites.filter(isValidFavoriteEntry) }
  } catch {
    return EMPTY_FAVORITE_CONFIG
  }
}

/**
 * 从全局 web-store + 项目文件加载收藏配置 (G7 分轨)。
 * 失败时返回空配置，不抛异常（参考 project-store.ts 模式）。
 */
export async function loadFavorites(projectPath?: string): Promise<FavoriteSkillConfig> {
  try {
    const store = await getStore()
    const config = await store.get<FavoriteSkillConfig>(FAVORITE_SKILL_CONFIG_KEY)
    const globalFavorites = !config || typeof config !== "object" || !Array.isArray(config.favorites)
      ? []
      : config.favorites.filter(isValidFavoriteEntry)
    if (!projectPath) {
      return { version: 1, favorites: globalFavorites }
    }
    const projectConfig = await loadProjectFavorites(projectPath)
    return {
      version: 1,
      favorites: [...globalFavorites, ...projectConfig.favorites],
    }
  } catch (err) {
    console.warn("[skill-favorite] 加载收藏配置失败:", err)
    return EMPTY_FAVORITE_CONFIG
  }
}

function isValidFavoriteEntry(value: unknown): value is FavoriteSkillEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<FavoriteSkillEntry>
  return (
    typeof entry.favoriteId === "string" &&
    typeof entry.library === "string" &&
    typeof entry.skillId === "string" &&
    typeof entry.originProjectPath === "string" &&
    typeof entry.source === "string" &&
    typeof entry.favoritedAt === "number" &&
    entry.snapshot !== null &&
    typeof entry.snapshot === "object"
  )
}

/**
 * 保存收藏配置 (G7 分轨): 内置/全局 → app KV; 项目级 → 项目文件。
 * 串行化写入，防止竞态。
 */
export async function saveFavorites(config: FavoriteSkillConfig, projectPath?: string): Promise<void> {
  const globalFavorites = config.favorites.filter((f) => f.originProjectPath === "")
  const projectFavorites = projectPath
    ? config.favorites.filter((f) => f.originProjectPath !== "")
    : []
  const key = FAVORITE_SKILL_CONFIG_KEY
  const previous = configSaveQueues.get(key) ?? Promise.resolve()
  const next = previous
    .then(() => persistFavorites({ version: 1, favorites: globalFavorites }))
    .then(() => {
      if (projectPath && projectFavorites.length > 0) {
        return persistProjectFavorites(projectPath, { version: 1, favorites: projectFavorites })
      }
      return undefined
    })
    .catch(() => persistFavorites({ version: 1, favorites: globalFavorites }))
  configSaveQueues.set(key, next)
  await next
}

async function persistProjectFavorites(projectPath: string, config: FavoriteSkillConfig): Promise<void> {
  try {
    await createDirectory(await join(projectPath, ".qmai"))
  } catch {
    // .qmai 已存在或创建失败均继续
  }
  await writeFileAtomic(await join(projectPath, PROJECT_FAVORITES_FILE), JSON.stringify(config, null, 2))
}

async function persistFavorites(config: FavoriteSkillConfig): Promise<void> {
  const store = await getStore()
  await store.set(FAVORITE_SKILL_CONFIG_KEY, config)
  await store.save()
}
