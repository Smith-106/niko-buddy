import { normalizePath } from "@/lib/path-utils"
import {
  loadCharacterStates,
  buildLibraryArtifact,
  type CharacterState,
  type LibraryArtifact,
  type RelationshipEdgeEntry,
} from "@/lib/novel"

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


// ============================================================================
// Wave 3B：自由文本关系 → 有 schema 的关系边（确定性推导，幂等，不猜语义）
// ============================================================================

/**
 * 稳定 entryId：同 from/to 恒等（重复推导不产生重复条目）。
 *
 * 分隔符必须转义：名字里自带 `->` 时（`甲->乙` → `丙` 与 `甲` → `乙->丙`）
 * 拼出的 id 会碰撞，`seen` 会静默丢边。这里按 percent-encode 转义 `%` `-` `>`。
 */
export function relationshipEntryId(from: string, to: string): string {
  const esc = (value: string) => value.replace(/%/g, "%25").replace(/-/g, "%2D").replace(/>/g, "%3E")
  return `rel:${esc(from)}->${esc(to)}`
}

/** entryId 上限（与 RELATIONSHIP_EDGE_ENTRY_SCHEMA 一致）。 */
const RELATIONSHIP_ENTRY_ID_MAX = 128

/**
 * 从既有 `character-states.json` 推导关系库条目。
 *
 * 诚实边界：真源是自由文本 → `kind` 固定 `unknown`，原文落 `note`；
 * **不**用关键词猜「师徒/敌对」，也不猜测强度。空文本关系丢弃（不造边）。
 */
export function deriveRelationshipEntries(
  store: { characters: readonly CharacterState[] },
  opts?: { projectId?: string },
): RelationshipEdgeEntry[] {
  const seen = new Set<string>()
  const edges: RelationshipEdgeEntry[] = []
  for (const character of store.characters) {
    const from = (character.characterName ?? "").trim()
    if (from.length === 0) continue
    for (const [to, description] of Object.entries(character.relationships ?? {})) {
      const note = typeof description === "string" ? description.trim() : ""
      if (note.length === 0) continue
      const target = to.trim()
      if (target.length === 0) continue
      const entryId = relationshipEntryId(from, target)
      // 超长 id 会让 buildLibraryArtifact 抛 AssetLibraryError（整库迁移失败）；
      // 这里跳过并在 note 侧保留原文不可见——由调用方通过 entryCount 差异感知。
      if (entryId.length > RELATIONSHIP_ENTRY_ID_MAX) continue
      if (seen.has(entryId)) continue
      seen.add(entryId)
      edges.push({
        entryId,
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        from,
        to: target,
        kind: "unknown",
        note: note.slice(0, 512),
      })
    }
  }
  // 码点序（不是 localeCompare）：hash 必须跨环境稳定，否则同一真源在 zh/ja/en 下
  // 排出不同顺序 → 已迁移的库会在另一台机器上从 noop 变成 conflict。
  edges.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
  return edges
}

/** 推导 → 库产物（守恒 hash 由 entries 确定性重算；同一真源两次结果一致）。 */
export function buildRelationshipLibraryArtifact(
  store: { characters: readonly CharacterState[] },
  opts?: { projectId?: string; generatedAt?: string },
): LibraryArtifact {
  return buildLibraryArtifact({
    libraryId: "relationship_edge",
    entries: deriveRelationshipEntries(store, { projectId: opts?.projectId }),
    generatedAt: opts?.generatedAt ?? new Date().toISOString(),
    generatorVersion: "relationship-derive/1.0",
  })
}
