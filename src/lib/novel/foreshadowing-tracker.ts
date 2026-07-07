import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface Foreshadowing {
  id: string
  name: string
  description: string
  status: "planted" | "advanced" | "resolved"
  plantedChapter: number
  advancedChapters: number[]
  resolvedChapter?: number
  relatedCharacters: string[]
  relatedEvents: string[]
  notes: string
}

export interface ForeshadowingStore {
  items: Foreshadowing[]
  lastUpdated: string
}

export function createEmptyForeshadowingStore(): ForeshadowingStore {
  return { items: [], lastUpdated: new Date().toISOString() }
}

export async function saveForeshadowingTracker(
  projectPath: string,
  store: ForeshadowingStore,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.novel`)
  // F-002 (ANL-010 C5): upgrade writeFile → writeFileAtomic. Same
  // crash-corruption risk as character-state.ts:30 — a truncated
  // foreshadowing-tracker.json breaks ingest on next load. fold_rebuildable
  // via rebuildDerivedMemoryFromSnapshots, but atomicity protects the
  // rebuild path itself.
  await writeFileAtomic(
    `${pp}/.novel/foreshadowing-tracker.json`,
    JSON.stringify(store, null, 2),
  )
}

export async function loadForeshadowingTracker(
  projectPath: string,
): Promise<ForeshadowingStore> {
  const pp = normalizePath(projectPath)
  try {
    const raw = await readFile(`${pp}/.novel/foreshadowing-tracker.json`)
    return JSON.parse(raw)
  } catch {
    return createEmptyForeshadowingStore()
  }
}

export function foreshadowingToContextText(store: ForeshadowingStore): string {
  const unresolved = store.items.filter((f) => f.status !== "resolved")
  if (unresolved.length === 0) return ""
  return unresolved
    .map(
      (f) =>
        `- [${f.status === "planted" ? "已埋设" : "推进中"}] ${f.name}：${f.description}（第${f.plantedChapter}章埋设）`,
    )
    .join("\n")
}