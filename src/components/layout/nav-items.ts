// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import {
  Activity,
  ArchiveRestore,
  BookOpen,
  Brain,
  Clapperboard,
  ClipboardCheck,
  ClipboardList,
  Compass,
  Database,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Network,
  Play,
  ScrollText,
  Search,
  Stethoscope,
  UserRound,
  Wrench,
} from "lucide-react"
import type { WikiState } from "@/stores/wiki-store"

/** 视图标识（与 wiki-store.activeView 同一联合类型；分组只是展示层，不改分发）。 */
export type NavView = WikiState["activeView"]

export type NavModeGroup = "ma" | "si" | "shen" | "maint"

export interface NavItem {
  view: NavView
  icon: typeof FileText
  labelKey: string
  group: NavModeGroup
}

/**
 * 导航四组（作家语言，纯展示层；content-area.tsx 的 switch 零改动）。
 *
 * 顺序 = 「写作优先」：默认视图 章节库 落在首组第一行（findings-1 F-02）。
 * - ma: 码字（章节库/技能库/设定校正）——日常写作用
 * - si: 构思（工作台/开书导演/大纲/图谱/灵魂/故事模拟/拆文库）——规划与资料
 * - shen: 审校（审查中心/记忆中心）——审稿与一致性
 * - maint: 维护（备份与恢复/诊断中心/数据管理）——不再混入「审校」组（findings-1 F-03）
 *
 * 侧栏与命令面板（Ctrl/⌘+K）共用这一张表，避免两处各写一份导航清单。
 */
export const NAV_ITEMS: NavItem[] = [
  { view: "wiki", icon: FileText, labelKey: "novel.nav.wiki", group: "ma" },
  { view: "skillLibrary", icon: Wrench, labelKey: "novel.nav.skillLibrary", group: "ma" },
  { view: "canonEditor", icon: ScrollText, labelKey: "novel.nav.canonEditor", group: "ma" },
  { view: "workbench", icon: LayoutDashboard, labelKey: "novel.nav.workbench", group: "si" },
  { view: "followUpCenter", icon: ClipboardList, labelKey: "novel.nav.followUpCenter", group: "si" },
  { view: "liveExecution", icon: Activity, labelKey: "novel.nav.liveExecution", group: "si" },
  { view: "creativeHub", icon: Compass, labelKey: "novel.nav.creativeHub", group: "si" },
  { view: "director", icon: Clapperboard, labelKey: "novel.nav.director", group: "si" },
  { view: "sources", icon: FolderOpen, labelKey: "novel.nav.sources", group: "si" },
  { view: "graph", icon: Network, labelKey: "novel.nav.graph", group: "si" },
  { view: "soul", icon: UserRound, labelKey: "novel.nav.soul", group: "si" },
  { view: "storySimulation", icon: Play, labelKey: "novel.nav.storySimulation", group: "si" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "novel.nav.dismantling", group: "si" },
  { view: "reviewCenter", icon: ClipboardCheck, labelKey: "novel.nav.reviewCenter", group: "shen" },
  { view: "lint", icon: Brain, labelKey: "novel.nav.lint", group: "shen" },
  { view: "backupExport", icon: ArchiveRestore, labelKey: "novel.nav.backupExport", group: "maint" },
  { view: "diagnosticsCenter", icon: Stethoscope, labelKey: "novel.nav.diagnosticsCenter", group: "maint" },
  { view: "dataManager", icon: Database, labelKey: "novel.nav.dataManager", group: "maint" },
]

export const SEARCH_NAV_ITEM: { view: NavView; icon: typeof FileText; labelKey: string } = {
  view: "search",
  icon: Search,
  labelKey: "novel.nav.search",
}

export const NAV_GROUP_ORDER: { group: NavModeGroup; labelKey: string }[] = [
  { group: "ma", labelKey: "novel.nav.groupMa" },
  { group: "si", labelKey: "novel.nav.groupSi" },
  { group: "shen", labelKey: "novel.nav.groupShen" },
  { group: "maint", labelKey: "novel.nav.groupMaint" },
]

export const NAV_COLLAPSED_GROUPS_KEY = "niko-buddy-nav-collapsed-groups"

export function readCollapsedGroups(): NavModeGroup[] {
  /* v8 ignore next */
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(NAV_COLLAPSED_GROUPS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is NavModeGroup => NAV_GROUP_ORDER.some((o) => o.group === g))
  } catch {
    return []
  }
}
