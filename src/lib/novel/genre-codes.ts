/**
 * 55 号设计 W1-1 (54⑧ 收尾): 题材 (genre) 码表统一模块。
 *
 * 单真源纪律 (55 号设计报告 §八.1):
 * - 运行时真源 = NovelConfig.genre (`.qmai/novel-config.json`, 英文稳定码)。
 * - 本模块是「UI 码 → de-ai-rules 中文流派名」的唯一映射层;
 *   未知码/undefined 一律透传 undefined → 生成链与现状逐字节一致。
 * - 不接 audit-taxonomy 的 GENRE_AUDIT_ACTIVATION (门控敏感, 观察项)。
 */

import type { WebNovelGenre } from "./de-ai-rules"

/**
 * 大纲生成对话框的 9 个题材码 (与 i18n `novel.outlineGenerator.genres.*` 同源)。
 * 映射到 de-ai-rules 的 WEB_NOVEL_GENRES 中文流派名; 无语义精确对应 → undefined
 * (未知 → 默认是 getGenreBaseline 既有契约, 不强配)。
 */
export const OUTLINE_GENRE_CODE_TO_WEB_NOVEL: Readonly<Record<string, WebNovelGenre | undefined>> = {
  mystery: "悬疑",
  xianxia: "仙侠",
  romance: "言情",
  scifi: "科幻",
  historical: "历史",
  urban: "都市",
  // fantasy/military/general: 无语义精确对应 (奇幻/军事/通用 → 默认基线)
  fantasy: undefined,
  military: undefined,
  general: undefined,
}

/** 全部可持久化的题材码 (设置页下拉与对话框共用; 空串 = 未设置)。 */
export const OUTLINE_GENRE_CODES = [
  "mystery",
  "xianxia",
  "romance",
  "military",
  "scifi",
  "fantasy",
  "historical",
  "urban",
  "general",
] as const

export type OutlineGenreCode = (typeof OUTLINE_GENRE_CODES)[number]

/**
 * 把 NovelConfig.genre (英文码) 解析为 de-ai-rules 消费的中文流派名。
 * undefined / 未知码 → undefined (调用方用默认基线, 零行为变更)。
 */
export function resolveDeAiGenre(code?: string): WebNovelGenre | undefined {
  if (!code) return undefined
  return OUTLINE_GENRE_CODE_TO_WEB_NOVEL[code]
}
