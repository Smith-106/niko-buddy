import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export type ForeshadowingStatus = "planted" | "advanced" | "resolved" | "abandoned"

/** 状态转移合法性：markAbandoned 仅允许 planted/advanced → abandoned。 */
export const ABANDONABLE_STATUSES: readonly ForeshadowingStatus[] = ["planted", "advanced"]

export interface Foreshadowing {
  id: string
  name: string
  description: string
  status: ForeshadowingStatus
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

/**
 * 将伏笔标记为「已废弃」：合法转移为 planted/advanced → abandoned；
 * 已是 resolved 或 abandoned 的项拒绝变更并抛错（防误弃已回收/已废弃伏笔）。
 * 返回变更后的新对象（immutable），不原地改写入参。
 */
export function markAbandoned(f: Foreshadowing): Foreshadowing {
  if (f.status === "resolved" || f.status === "abandoned") {
    throw new Error(
      `无法废弃已 ${f.status} 的伏笔 "${f.name}"（仅 planted/advanced 可 → abandoned）`,
    )
  }
  return { ...f, status: "abandoned" }
}

export function foreshadowingToContextText(store: ForeshadowingStore): string {
  // abandoned 视为已退出活跃伏笔链：不进入生成链上下文（与 resolved 等价过滤）。
  const unresolved = store.items.filter(
    (f) => f.status === "planted" || f.status === "advanced",
  )
  if (unresolved.length === 0) return ""
  return unresolved
    .map(
      (f) =>
        `- [${f.status === "planted" ? "已埋设" : "推进中"}] ${f.name}：${f.description}（第${f.plantedChapter}章埋设）`,
    )
    .join("\n")
}