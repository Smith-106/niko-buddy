import { createAtomicJsonStore } from "./projection-store"

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

function foreshadowingLastActivityChapter(item: Foreshadowing): number {
  let latest = Number.isFinite(item.plantedChapter) ? item.plantedChapter : 0
  if (typeof item.resolvedChapter === "number" && Number.isFinite(item.resolvedChapter)) {
    latest = Math.max(latest, item.resolvedChapter)
  }
  for (const ch of item.advancedChapters ?? []) {
    if (Number.isFinite(ch)) latest = Math.max(latest, ch)
  }
  return latest
}

/**
 * 百章级伏笔留存策略（确定性纯函数）：
 * - 当活跃伏笔（planted/advanced）数量 <= cap 时，绝不驱逐任何活跃伏笔；
 * - 优先驱逐最早的已回收/已废弃（resolved/abandoned）伏笔；
 * - 最终恢复原相对顺序，不修改入参数组。
 */
export function retainForeshadowingItems(
  items: readonly Foreshadowing[],
  cap: number,
): Foreshadowing[] {
  if (cap <= 0 || items.length === 0) return []
  if (items.length <= cap) return [...items]

  const active: Array<{ index: number; latestChapter: number }> = []
  const inactive: Array<{ index: number; latestChapter: number }> = []

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const entry = { index: i, latestChapter: foreshadowingLastActivityChapter(item) }
    if (item.status === "planted" || item.status === "advanced") {
      active.push(entry)
    } else {
      inactive.push(entry)
    }
  }

  const keptIndices = new Set<number>()
  if (active.length <= cap) {
    for (const entry of active) keptIndices.add(entry.index)
    const remainingSlots = cap - active.length
    if (remainingSlots > 0 && inactive.length > 0) {
      inactive.sort((a, b) => {
        if (b.latestChapter !== a.latestChapter) return b.latestChapter - a.latestChapter
        return b.index - a.index
      })
      for (let i = 0; i < remainingSlots && i < inactive.length; i += 1) {
        keptIndices.add(inactive[i].index)
      }
    }
  } else {
    active.sort((a, b) => {
      if (b.latestChapter !== a.latestChapter) return b.latestChapter - a.latestChapter
      return b.index - a.index
    })
    for (let i = 0; i < cap && i < active.length; i += 1) {
      keptIndices.add(active[i].index)
    }
  }

  return items.filter((_, index) => keptIndices.has(index))
}

// E-03 (run-execute-1, 双库架构蓝图): 直写迁移到 createAtomicJsonStore 工厂
// (三模型共识 2026-09-04)。load 语义保留 lenient (missing/corrupt → emptyCtor),
// 与工厂默认一致, 零行为变化。
const store = createAtomicJsonStore<ForeshadowingStore>(
  "foreshadowing-tracker.json",
  createEmptyForeshadowingStore,
  { arrayFieldCaps: { items: { cap: 500, retain: retainForeshadowingItems } } },
)

export async function saveForeshadowingTracker(
  projectPath: string,
  storeData: ForeshadowingStore,
): Promise<void> {
  await store.save(projectPath, storeData)
}

export async function loadForeshadowingTracker(
  projectPath: string,
): Promise<ForeshadowingStore> {
  return store.load(projectPath)
}

/**
 * 当前活跃伏笔（planted/advanced）：编辑器注入通道的上游真源。
 * resolved/abandoned 视为已退出伏笔链（与 markAbandoned/toContextText/debt 分析同口径）。
 */
export function getActiveForeshadowings(store: ForeshadowingStore): Foreshadowing[] {
  return store.items.filter((f) => f.status === "planted" || f.status === "advanced")
}

/**
 * 伏笔库章节水位：items 引用的最大章节号（至少 1）。
 * 与 foreshadowing-panel 甘特 current 口径一致：无独立 currentChapter 真源时，
 * 以库内最大引用为水位，避免在编辑器侧发明章节解析启发式。
 */
export function getForeshadowingWatermark(items: readonly Foreshadowing[]): number {
  let max = 1
  for (const f of items) {
    if (Number.isFinite(f.plantedChapter)) max = Math.max(max, f.plantedChapter)
    if (typeof f.resolvedChapter === "number" && Number.isFinite(f.resolvedChapter)) {
      max = Math.max(max, f.resolvedChapter)
    }
    for (const a of f.advancedChapters ?? []) {
      if (Number.isFinite(a)) max = Math.max(max, a)
    }
  }
  return max
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
  const unresolved = getActiveForeshadowings(store)
  if (unresolved.length === 0) return ""
  return unresolved
    .map(
      (f) =>
        `- [${f.status === "planted" ? "已埋设" : "推进中"}] ${f.name}：${f.description}（第${f.plantedChapter}章埋设）`,
    )
    .join("\n")
}