import { useWikiStore, type NovelConfig } from "@/stores/wiki-store"

/**
 * ISS-20260709-023 (DC-7) 渐进式 DI: 缺省回退 useWikiStore 保持向后兼容。
 */
export function resolveReviewModel(novelConfig?: NovelConfig): string {
  const cfg = novelConfig ?? useWikiStore.getState().novelConfig
  const reviewModel = cfg.reviewModel
  return reviewModel?.trim() || ""
}

