// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import {
  Activity,
  ArchiveRestore,
  BookOpen,
  Brain,
  CircleQuestionMark,
  Clapperboard,
  ClipboardCheck,
  ClipboardList,
  Compass,
  Database,
  Download,
  FileText,
  FolderOpen,
  Layers,
  LayoutDashboard,
  Library,
  Network,
  PenTool,
  Play,
  Plug,
  Radar,
  Route,
  ScrollText,
  Search,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  UserRound,
  Workflow,
  Wrench,
} from "lucide-react"
import type { WikiState } from "@/stores/wiki-store"

/** 视图标识（与 wiki-store.activeView 同一联合类型；分组只是展示层，不改分发）。 */
export type NavView = WikiState["activeView"]

export type NavModeGroup = "ma" | "si" | "shen" | "maint"

/** 导航分层：primary 常驻展示，secondary 收进 More 抽屉；undefined 按 primary 处理（向后兼容）。 */
export type NavTier = "primary" | "secondary"

export interface NavItem {
  view: NavView
  icon: typeof FileText
  labelKey: string
  group: NavModeGroup
  tier?: NavTier
}

/**
 * 导航四组（作家语言，纯展示层；content-area.tsx 的 switch 零改动）。
 *
 * B 波收敛：有书时默认只展开 ma（写和审：章节库/审查中心/跟进中心/主控直达）；
 * si（开书）/shen（查账）/maint（备份/诊断/数据/模型/帮助）默认收起只露组头。
 * 导出不占侧栏常驻格：maint 组里 exportCenter 降为 secondary（More 里按需开），
 * 书稿导出主入口在写作台工具条（manuscript）与交稿尾部，侧栏只留按需入口。
 * - ma: 写和审（章节库/审查中心/跟进中心）
 * - si: 开书（工作台/书架/题材/导演/拆文）——没有书时默认展开
 * - shen: 查账（大纲/图谱/灵魂/设定/审校/技能）
 * - maint: 设置（备份/诊断/数据/模型/帮助，以及退出日常一级的页；导出收进 More）
 *
 * 侧栏与命令面板（Ctrl/⌘+K）共用这一张表，避免两处各写一份导航清单。
 */
export const NAV_ITEMS: NavItem[] = [
  { view: "wiki", icon: FileText, labelKey: "novel.nav.wiki", group: "ma", tier: "primary" },
  { view: "reviewCenter", icon: ClipboardCheck, labelKey: "novel.nav.reviewCenter", group: "ma", tier: "primary" },
  { view: "followUpCenter", icon: ClipboardList, labelKey: "novel.nav.followUpCenter", group: "ma", tier: "primary" },
  { view: "mainControl", icon: Sparkles, labelKey: "novel.nav.mainControl", group: "ma", tier: "primary" },
  { view: "workbench", icon: LayoutDashboard, labelKey: "novel.nav.workbench", group: "si", tier: "primary" },
  { view: "bookshelf", icon: Library, labelKey: "novel.nav.bookshelf", group: "si", tier: "primary" },
  { view: "genreLibrary", icon: Shapes, labelKey: "novel.nav.genreLibrary", group: "si", tier: "secondary" },
  { view: "storyModeLibrary", icon: Layers, labelKey: "novel.nav.storyModeLibrary", group: "si", tier: "secondary" },
  { view: "director", icon: Clapperboard, labelKey: "novel.nav.director", group: "si", tier: "primary" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "novel.nav.dismantling", group: "si", tier: "primary" },
  { view: "sources", icon: FolderOpen, labelKey: "novel.nav.sources", group: "shen", tier: "primary" },
  { view: "graph", icon: Network, labelKey: "novel.nav.graph", group: "shen", tier: "primary" },
  { view: "soul", icon: UserRound, labelKey: "novel.nav.soul", group: "shen", tier: "primary" },
  { view: "canonEditor", icon: ScrollText, labelKey: "novel.nav.canonEditor", group: "shen", tier: "primary" },
  { view: "lint", icon: Brain, labelKey: "novel.nav.lint", group: "shen", tier: "secondary" },
  { view: "skillLibrary", icon: Wrench, labelKey: "novel.nav.skillLibrary", group: "shen", tier: "secondary" },
  { view: "liveExecution", icon: Activity, labelKey: "novel.nav.liveExecution", group: "maint", tier: "secondary" },
  { view: "creativeHub", icon: Compass, labelKey: "novel.nav.creativeHub", group: "maint", tier: "primary" },
  { view: "titleStudio", icon: PenTool, labelKey: "novel.nav.titleStudio", group: "maint", tier: "primary" },
  { view: "styleEngine", icon: SlidersHorizontal, labelKey: "novel.nav.styleEngine", group: "maint", tier: "secondary" },
  { view: "antiAiRules", icon: ShieldCheck, labelKey: "novel.nav.antiAiRules", group: "maint", tier: "secondary" },
  { view: "storySimulation", icon: Play, labelKey: "novel.nav.storySimulation", group: "maint", tier: "secondary" },
  { view: "workflowEditor", icon: Workflow, labelKey: "novel.nav.workflowEditor", group: "maint", tier: "secondary" },
  { view: "marketRadar", icon: Radar, labelKey: "novel.nav.marketRadar", group: "maint", tier: "secondary" },
  { view: "backupExport", icon: ArchiveRestore, labelKey: "novel.nav.backupExport", group: "maint", tier: "primary" },
  { view: "diagnosticsCenter", icon: Stethoscope, labelKey: "novel.nav.diagnosticsCenter", group: "maint", tier: "secondary" },
  { view: "dataManager", icon: Database, labelKey: "novel.nav.dataManager", group: "maint", tier: "secondary" },
  { view: "modelRoutes", icon: Route, labelKey: "novel.nav.modelRoutes", group: "maint", tier: "secondary" },
  { view: "mcpManager", icon: Plug, labelKey: "novel.nav.mcpManager", group: "maint", tier: "secondary" },
  { view: "exportCenter", icon: Download, labelKey: "novel.nav.exportCenter", group: "maint", tier: "secondary" },
  { view: "help", icon: CircleQuestionMark, labelKey: "novel.nav.help", group: "maint", tier: "secondary" },
]

/** 是否常驻展示（tier 缺省按 primary 处理，保持旧数据兼容）。 */
export function isNavPrimaryTier(item: Pick<NavItem, "tier">): boolean {
  return (item.tier ?? "primary") === "primary"
}

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

/**
 * 有书时首刷只展开写和审：无存储偏好时 si/shen/maint 收起。
 * 没有书时开书组不收起。用户点过一次分组后以存储为准。
 */
export const DEFAULT_COLLAPSED_GROUPS: NavModeGroup[] = ["si", "shen", "maint"]

/** 无存储偏好时的首刷折叠。projectIsNull 为真才展开开书组。 */
export function initialCollapsedGroups(projectIsNull: boolean): NavModeGroup[] {
  if (typeof localStorage !== "undefined" && localStorage.getItem(NAV_COLLAPSED_GROUPS_KEY) !== null) {
    return readCollapsedGroups()
  }
  if (projectIsNull) return DEFAULT_COLLAPSED_GROUPS.filter((group) => group !== "si")
  return [...DEFAULT_COLLAPSED_GROUPS]
}

export function readCollapsedGroups(): NavModeGroup[] {
  /* v8 ignore next */
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(NAV_COLLAPSED_GROUPS_KEY)
    if (raw === null) return [...DEFAULT_COLLAPSED_GROUPS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is NavModeGroup => NAV_GROUP_ORDER.some((o) => o.group === g))
  } catch {
    return []
  }
}
