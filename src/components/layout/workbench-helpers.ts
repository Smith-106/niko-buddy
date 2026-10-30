// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * 工作台「下一步推荐 + 最近使用」纯逻辑（UX 审计批次三·12）。
 *
 * 最近使用只存视图 id 到 localStorage，不碰 .novel/status.json（那是写作运行时真源，这里只是 UI 偏好）。
 */

import type { WikiState } from "@/stores/wiki-store"

type View = WikiState["activeView"]

export const RECENT_VIEWS_KEY = "niko-buddy-recent-views"
export const RECENT_VIEWS_LIMIT = 6

/** 不进「最近使用」的视图：工作台自身、设置页、搜索浮层、开发用视图。 */
const RECENT_EXCLUDED = new Set<string>(["workbench", "settings", "search", "moduleHeatmap", "pipelineMotion"])

export function readRecentViews(): View[] {
  if (typeof localStorage === "undefined") return []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_VIEWS_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is View => typeof v === "string").slice(0, RECENT_VIEWS_LIMIT)
  } catch {
    return []
  }
}

/** 记录一次访问：移到最前、去重、截断。返回新列表；排除项原样返回旧列表。 */
export function recordRecentView(view: View): View[] {
  const prev = readRecentViews()
  if (RECENT_EXCLUDED.has(view)) return prev
  const next = [view, ...prev.filter((v) => v !== view)].slice(0, RECENT_VIEWS_LIMIT)
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(RECENT_VIEWS_KEY, JSON.stringify(next))
    } catch {
      // 存储满或被禁用时只丢偏好，不影响导航
    }
  }
  return next
}

export interface NextStepItem {
  view: View
  labelKey: string
  descKey: string
}

/**
 * 下一步推荐：按有没有打开小说给出 2–3 个最可能的去处。
 * 不读章节进度；更细的「下一章该写什么」由批次四 outline-next-step 再接。
 */
export function nextStepRecommendations(hasProject: boolean): NextStepItem[] {
  if (!hasProject) {
    return [
      { view: "director", labelKey: "wb.next.director", descKey: "wb.next.directorDesc" },
      { view: "bookAnalysis", labelKey: "wb.next.dismantling", descKey: "wb.next.dismantlingDesc" },
      { view: "bookshelf", labelKey: "wb.next.bookshelf", descKey: "wb.next.bookshelfDesc" },
    ]
  }
  return [
    { view: "wiki", labelKey: "wb.next.write", descKey: "wb.next.writeDesc" },
    { view: "reviewCenter", labelKey: "wb.next.review", descKey: "wb.next.reviewDesc" },
    { view: "followUpCenter", labelKey: "wb.next.followUp", descKey: "wb.next.followUpDesc" },
  ]
}
