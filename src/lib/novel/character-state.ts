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