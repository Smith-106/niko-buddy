import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"

/**
 * Hook: 获取标签翻译（根据 novelMode 切换）。
 * MIT licensed implementation.
 *
 * @param originalKey - 原始键
 * @param novelKey - Novel 模式下的键
 * @returns 当前模式下的翻译文本
 */
export function useNovelLabel(originalKey: string, novelKey: string): string {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  return novelMode ? t(novelKey) : t(originalKey)
}

/**
 * Hook: 获取当前是否为 Novel 模式。
 * MIT licensed implementation.
 *
 * @returns boolean 表示是否在 Novel 模式下
 */
export function useNovelMode(): boolean {
  return useWikiStore((s) => s.novelMode)
}
