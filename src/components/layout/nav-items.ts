// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import {
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

export type NavModeGroup = "si" | "ma" | "review" | "shen" | "tools" | "maint"

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
 * 导航六组（作家语言，纯展示层；content-area.tsx 的 switch 零改动）。按作者的工作顺序排：
 * - si 开书：工作台/书架/导演/故事模拟/拆文库（题材库、故事模式收进 More）——没有书时默认展开
 * - ma 写作：章节库/主控（AI 实况已并入主控页签，不再单列）
 * - review 审改：审查中心/跟进中心（记忆中心、去 AI 规则收进 More）
 * - shen 设定资料：资料源/图谱/角色灵魂/设定编辑
 * - tools 创作工具：创作中枢/书名工坊（风格引擎、技能库、工作流、市场雷达收进 More）
 * - maint 维护：备份（导出中心、诊断、数据、模型路由、MCP、帮助收进 More）
 *
 * UX 审计批次三·10：旧「设置」组 14 项拆成「创作工具」与「维护」，组名改「维护」，
 * 不再与设置页「模型与写作设置」撞名。组 id 沿用 si/ma/shen/maint，用户存过的折叠偏好继续有效。
 * 有书时默认只展开写作和审改。
 *
 * 侧栏与命令面板（Ctrl/⌘+K）共用这一张表，避免两处各写一份导航清单。
 */
export const NAV_ITEMS: NavItem[] = [
  { view: "workbench", icon: LayoutDashboard, labelKey: "novel.nav.workbench", group: "si", tier: "primary" },
  { view: "bookshelf", icon: Library, labelKey: "novel.nav.bookshelf", group: "si", tier: "primary" },
  { view: "director", icon: Clapperboard, labelKey: "novel.nav.director", group: "si", tier: "primary" },
  { view: "storySimulation", icon: Play, labelKey: "novel.nav.storySimulation", group: "si", tier: "primary" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "novel.nav.dismantling", group: "si", tier: "primary" },
  { view: "genreLibrary", icon: Shapes, labelKey: "novel.nav.genreLibrary", group: "si", tier: "secondary" },
  { view: "storyModeLibrary", icon: Layers, labelKey: "novel.nav.storyModeLibrary", group: "si", tier: "secondary" },
  { view: "wiki", icon: FileText, labelKey: "novel.nav.wiki", group: "ma", tier: "primary" },
  { view: "mainControl", icon: Sparkles, labelKey: "novel.nav.mainControl", group: "ma", tier: "primary" },
  { view: "reviewCenter", icon: ClipboardCheck, labelKey: "novel.nav.reviewCenter", group: "review", tier: "primary" },
  { view: "followUpCenter", icon: ClipboardList, labelKey: "novel.nav.followUpCenter", group: "review", tier: "primary" },
  { view: "lint", icon: Brain, labelKey: "novel.nav.lint", group: "review", tier: "secondary" },
  { view: "antiAiRules", icon: ShieldCheck, labelKey: "novel.nav.antiAiRules", group: "review", tier: "secondary" },
  { view: "sources", icon: FolderOpen, labelKey: "novel.nav.sources", group: "shen", tier: "primary" },
  { view: "graph", icon: Network, labelKey: "novel.nav.graph", group: "shen", tier: "primary" },
  { view: "soul", icon: UserRound, labelKey: "novel.nav.soul", group: "shen", tier: "primary" },
  { view: "canonEditor", icon: ScrollText, labelKey: "novel.nav.canonEditor", group: "shen", tier: "primary" },
  { view: "creativeHub", icon: Compass, labelKey: "novel.nav.creativeHub", group: "tools", tier: "primary" },
  { view: "titleStudio", icon: PenTool, labelKey: "novel.nav.titleStudio", group: "tools", tier: "primary" },
  { view: "styleEngine", icon: SlidersHorizontal, labelKey: "novel.nav.styleEngine", group: "tools", tier: "secondary" },
  { view: "skillLibrary", icon: Wrench, labelKey: "novel.nav.skillLibrary", group: "tools", tier: "secondary" },
  { view: "workflowEditor", icon: Workflow, labelKey: "novel.nav.workflowEditor", group: "tools", tier: "secondary" },
  { view: "marketRadar", icon: Radar, labelKey: "novel.nav.marketRadar", group: "tools", tier: "secondary" },
  { view: "backupExport", icon: ArchiveRestore, labelKey: "novel.nav.backupExport", group: "maint", tier: "primary" },
  { view: "exportCenter", icon: Download, labelKey: "novel.nav.exportCenter", group: "maint", tier: "secondary" },
  { view: "diagnosticsCenter", icon: Stethoscope, labelKey: "novel.nav.diagnosticsCenter", group: "maint", tier: "secondary" },
  { view: "dataManager", icon: Database, labelKey: "novel.nav.dataManager", group: "maint", tier: "secondary" },
  { view: "modelRoutes", icon: Route, labelKey: "novel.nav.modelRoutes", group: "maint", tier: "secondary" },
  { view: "mcpManager", icon: Plug, labelKey: "novel.nav.mcpManager", group: "maint", tier: "secondary" },
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
  { group: "si", labelKey: "novel.nav.groupSi" },
  { group: "ma", labelKey: "novel.nav.groupMa" },
  { group: "review", labelKey: "novel.nav.groupReview" },
  { group: "shen", labelKey: "novel.nav.groupShen" },
  { group: "tools", labelKey: "novel.nav.groupTools" },
  { group: "maint", labelKey: "novel.nav.groupMaint" },
]

export const NAV_COLLAPSED_GROUPS_KEY = "niko-buddy-nav-collapsed-groups"

/**
 * 有书时首刷只展开写作和审改：无存储偏好时 si/shen/tools/maint 收起。
 * 没有书时开书组不收起。用户点过一次分组后以存储为准。
 */
export const DEFAULT_COLLAPSED_GROUPS: NavModeGroup[] = ["si", "shen", "tools", "maint"]

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
