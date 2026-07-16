import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface CharacterState {
  characterName: string
  currentLocation: string
  status: string
  equipment: string[]
  abilities: string[]
  relationships: Record<string, string>
  lastUpdatedChapter: number
  lastUpdatedAt: string
  // A19 机械层零 LLM (NovelForge-v5 EmotionTracker 移植, ISS-20260715-emotion-ledger):
  // 当前情绪快照入 CharacterState, 历史 delta 累积入独立 EmotionLedgerStore
  // (.novel/emotion-ledger.json) — 职责分离避免双真源。可选字段保向后兼容
  // (旧 character-states.json 无 emotion 字段, load 时 undefined 不报错)。
  emotion?: EmotionState
}

// A19 机械层情绪维度: valence(效价 -1消极~1积极) / arousal(唤醒 -1平静~1激动) /
// dominance(支配 -1屈从~1掌控)。三轴均为 -1.0~1.0, 由确定性算术计算非 LLM 推断。
export interface EmotionState {
  valence: number
  arousal: number
  dominance: number
}

// EmotionLedgerEntry: 每角色一条, netValue 是当前情绪净值 (机械层计算),
// history 累积每章 delta 供 Circuit Breaker 判定情绪债务。
export interface EmotionHistoryEntry {
  chapter: number
  delta: number
  reason: string
}

export interface EmotionLedgerEntry {
  characterName: string
  netValue: number
  valence: number
  arousal: number
  dominance: number
  lastUpdatedChapter: number
  history: EmotionHistoryEntry[]
}

export interface EmotionLedgerStore {
  entries: EmotionLedgerEntry[]
  lastUpdated: string
}

export interface CharacterStateStore {
  characters: CharacterState[]
  lastUpdated: string
}

export function createEmptyCharacterStateStore(): CharacterStateStore {
  return { characters: [], lastUpdated: new Date().toISOString() }
}

export async function saveCharacterStates(
  projectPath: string,
  store: CharacterStateStore,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.novel`)
  // F-002 (ANL-010 C5): upgrade writeFile → writeFileAtomic. A crash mid-write
  // (power loss, panic) left a truncated character-states.json that broke
  // ingest on next load. writeFileAtomic (fs.rs:1190 temp+fsync+rename) is
  // crash-safe — the file is either the old or the new version, never half.
  // This projection is fold_rebuildable (rebuildDerivedMemoryFromSnapshots
  // re-derives it from the snapshot sequence), but a corrupt file blocks
  // the rebuild itself, so atomicity still matters here.
  await writeFileAtomic(
    `${pp}/.novel/character-states.json`,
    JSON.stringify(store, null, 2),
  )
}

export async function loadCharacterStates(
  projectPath: string,
): Promise<CharacterStateStore> {
  const pp = normalizePath(projectPath)
  try {
    const raw = await readFile(`${pp}/.novel/character-states.json`)
    return JSON.parse(raw)
  } catch {
    return createEmptyCharacterStateStore()
  }
}

export function characterStatesToContextText(store: CharacterStateStore): string {
  if (store.characters.length === 0) return ""
  return store.characters
    .map(
      (c) =>
        `- ${c.characterName}：位于${c.currentLocation}，状态：${c.status}，装备：${c.equipment.join("、") || "无"}，能力：${c.abilities.join("、") || "无"}`,
    )
    .join("\n")
}