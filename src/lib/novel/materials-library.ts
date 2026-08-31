/**
 * R-inkos-3 (23-inkos-coverage roadmap P1): MaterialsLibrary — 结构化素材库.
 *
 * 吸收来源：reference/inkos packages/core/src/materials（角色/设定/地点/物品卡
 * 统一管理，写作时按需注入）— 23 号覆盖审计三模型 2/3 absorb_now、终裁
 * roadmap P1 后本 goal 落地。
 *
 * 定位：作品内世界元素卡（人物/设定/地点/物品/情节片段）的结构化管理与
 * 上下文注入，与 memory-center（跨会话用户记忆）/ subplot-board（支线进度）
 * 同层互补，不构成第二真源（A23/ADR-26）——素材卡是 canon 的索引投影，
 * 权威事实仍在 Truth Files/canon 体系。
 *
 * 持久化：createAtomicJsonStore（writeFileAtomic temp+fsync+rename，
 * 与 subplot-board/emotional-arcs 同契约）。
 */

import { createAtomicJsonStore } from "./projection-store"

export type MaterialKind =
  | "character" // 角色卡
  | "setting" // 设定/世界观
  | "location" // 地点
  | "item" // 物品/信物
  | "plot_fragment" // 情节片段/桥段素材

export type MaterialStatus = "draft" | "active" | "retired"

export interface MaterialCard {
  id: string
  kind: MaterialKind
  title: string
  /** 检索/注入用标签（自由标注，如 "第一卷" "反派" "伏笔载体"）。 */
  tags: string[]
  /** 一句话摘要（进 context 注入）。 */
  summary: string
  /** 详细内容（不进 context 注入，检索命中后按需展开）。 */
  detail: string
  /** 关联章号（素材首次出现/被引用的章节）。 */
  relatedChapters: number[]
  status: MaterialStatus
  /** 最后一次在正文中引用的章号（可选，供休眠/过期分析）。 */
  lastSeenChapter?: number
}

export interface MaterialsStore {
  items: MaterialCard[]
  lastUpdated: string
}

export function createEmptyMaterialsStore(): MaterialsStore {
  return { items: [], lastUpdated: new Date().toISOString() }
}

const materialsStore = createAtomicJsonStore<MaterialsStore>(
  "materials-library.json",
  createEmptyMaterialsStore,
)

export async function saveMaterialsLibrary(
  projectPath: string,
  store: MaterialsStore,
): Promise<void> {
  await materialsStore.save(projectPath, store)
}

export async function loadMaterialsLibrary(
  projectPath: string,
): Promise<MaterialsStore> {
  return materialsStore.load(projectPath)
}

/**
 * 按 id upsert 素材卡：存在则覆盖字段（保留 lastSeenChapter 除非显式传入），
 * 不存在则追加。返回更新后的 store（纯函数语义，调用方决定持久化）。
 */
export function upsertMaterial(
  store: MaterialsStore,
  card: MaterialCard,
): MaterialsStore {
  const idx = store.items.findIndex((m) => m.id === card.id)
  const items =
    idx >= 0
      ? store.items.map((m, i) => (i === idx ? card : m))
      : [...store.items, card]
  return { items, lastUpdated: new Date().toISOString() }
}

/**
 * 过滤素材卡：全部条件可选，命中任一 kind / 全部 tags 交集 / status。
 * 无任何过滤条件时返回全部。
 */
export function filterMaterials(
  store: MaterialsStore,
  filter: {
    kinds?: MaterialKind[]
    /** 素材卡必须同时携带全部给定标签。 */
    allTags?: string[]
    statuses?: MaterialStatus[]
  } = {},
): MaterialCard[] {
  return store.items.filter((m) => {
    if (filter.kinds && !filter.kinds.includes(m.kind)) return false
    if (filter.statuses && !filter.statuses.includes(m.status)) return false
    if (filter.allTags && filter.allTags.length > 0) {
      for (const t of filter.allTags) {
        if (!m.tags.includes(t)) return false
      }
    }
    return true
  })
}

/**
 * 渲染 active/draft 素材卡为 protected-tier 上下文文本（retired 不注入，
 * 与 subplotBoardToContextText 的 resolved-only 过滤约定一致）。
 * 按材料类型分组，卡内输出 title+tags+summary（detail 不注入——控制预算）。
 */
export function materialsToContextText(store: MaterialsStore): string {
  const active = store.items.filter((m) => m.status !== "retired")
  if (active.length === 0) return ""
  const kindLabel: Record<MaterialKind, string> = {
    character: "角色",
    setting: "设定",
    location: "地点",
    item: "物品",
    plot_fragment: "桥段",
  }
  return active
    .map((m) => {
      const tags = m.tags.length > 0 ? `（${m.tags.join("、")}）` : ""
      return `- [${kindLabel[m.kind]}] ${m.title}${tags}：${m.summary}`
    })
    .join("\n")
}
