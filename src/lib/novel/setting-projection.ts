import { normalizePath } from "@/lib/path-utils"
import { loadCharacterStates, type CharacterState } from "@/lib/novel"

/**
 * 设定中心（Wave 3A）：**零新真源只读投影**。
 *
 * 数据来源全部是既有真源（不写任何文件、不新增 store）：
 * - `.novel/character-states.json` → `relationships: Record<string, string>`（自由文本，无 schema）
 * - 世界蓝图由 `loadWorldBlueprint` 单独读取（见 world-library-view）
 *
 * 诚实边界：关系目前是**自由文本**，没有关系类型/强度/方向的结构化字段，
 * 因此本投影只做「谁 → 谁：原文」的呈现，并显式标注无法判定的部分（N/A），
 * 结构化关系契约与迁移留给下一轮（3B）。
 */
export interface RelationshipEdge {
  from: string
  to: string
  /** 原文自由文本（可能是「师徒/敌对/暗恋」等任意描述） */
  description: string
  /** 该角色最近更新的章号；**缺失/非有限 → null**（UI 必须显示 N/A，不得写 0）。 */
  lastChapter: number | null
}

export interface CastRow {
  name: string
  location: string | null
  status: string | null
  lastChapter: number | null
  isAlive: boolean | null
  relationCount: number
}

export interface SettingProjection {
  cast: CastRow[]
  edges: RelationshipEdge[]
  /** 有角色但没有关系记录（诚实缺口，不是 0）。 */
  charactersWithoutRelations: number
}

/** 章号归一：仅保留有限数字，缺失/NaN/字符串一律 null（缺失 ≠ 第 0 章）。 */
function asChapter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 纯函数：角色状态 → 只读设定投影（不读盘、不造字段）。 */
export function projectSettingState(store: { characters: readonly CharacterState[] }): SettingProjection {
  const cast: CastRow[] = []
  const edges: RelationshipEdge[] = []
  let charactersWithoutRelations = 0

  for (const character of store.characters) {
    const name = asText(character.characterName) ?? ""
    const relations = character.relationships ?? {}
    const entries = Object.entries(relations).filter(([, description]) => asText(description) !== null)
    if (entries.length === 0) charactersWithoutRelations += 1
    for (const [to, description] of entries) {
      edges.push({
        from: name,
        to,
        description: (asText(description) as string),
        lastChapter: asChapter(character.lastUpdatedChapter),
      })
    }
    cast.push({
      name,
      location: asText(character.currentLocation),
      status: asText(character.status),
      lastChapter: asChapter(character.lastUpdatedChapter),
      isAlive: typeof character.isAlive === "boolean" ? character.isAlive : null,
      relationCount: entries.length,
    })
  }

  cast.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
  edges.sort((a, b) => a.from.localeCompare(b.from, "zh-Hans-CN") || a.to.localeCompare(b.to, "zh-Hans-CN"))
  return { cast, edges, charactersWithoutRelations }
}

export type SettingProjectionLoader = (projectPath: string) => Promise<SettingProjection>

/** 默认装载：读既有 character-states 真源，纯内存投影。 */
export const loadSettingProjection: SettingProjectionLoader = async (projectPath) => {
  const store = await loadCharacterStates(normalizePath(projectPath))
  return projectSettingState(store)
}
