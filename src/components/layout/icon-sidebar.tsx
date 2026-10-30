// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react"
import {
  ArrowLeftRight, ChevronRight, Eye, GitMerge, Image, Languages, Monitor, Moon, Search, Settings, Sun, Trash2,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CoverPromptWorkbench } from "@/components/novel/cover-prompt-workbench"
import { TranslationWorkbenchView } from "@/components/novel/translation-workbench-view"
import { FanficMergeDialog } from "@/components/novel/fanfic-merge-dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useTranslation } from "react-i18next"
import logoImg from "@/assets/niko-buddy-logo.png"
import { saveTheme } from "@/lib/project-store"
import { applyTheme } from "@/lib/theme-utils"
import {
  NAV_COLLAPSED_GROUPS_KEY,
  NAV_GROUP_ORDER,
  NAV_ITEMS,
  SEARCH_NAV_ITEM,
  initialCollapsedGroups,
  isNavPrimaryTier,
  type NavModeGroup,
  type NavView,
} from "./nav-items"

interface IconSidebarProps {
  onToggleSidebar?: () => void
  onOpenSidebar?: () => void
  onSwitchProject: () => void
}

export function IconSidebar({ onToggleSidebar, onOpenSidebar, onSwitchProject }: IconSidebarProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setSearchPanelOpen = useWikiStore((s) => s.setSearchPanelOpen)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const theme = useWikiStore((s) => s.theme)
  const setTheme = useWikiStore((s) => s.setTheme)
  // F-09（findings-1）/ W-08（findings-2）：旧版只统计六维审查的 items，
  // 「保存前审稿」写入的 novelReviewEntries 不进任何计数 → 导航上连一个红点都没有。
  // 这里合并两个未解决来源（消费点仍待补，见交付报告残留项）。
  const pendingReviewItems = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  const pendingNovelEntries = useReviewStore((s) => s.novelReviewEntries.filter((e) => !e.resolved).length)
  const pendingCount = pendingReviewItems + pendingNovelEntries
  const project = useWikiStore((s) => s.project)
  // F-012: 封面 Prompt 工作台入口（独立 dialog，不新增 activeView，不进主链热路径）
  const [coverWorkbenchOpen, setCoverWorkbenchOpen] = useState(false)
  const [translationViewOpen, setTranslationViewOpen] = useState(false)
  const [fanficMergeOpen, setFanficMergeOpen] = useState(false)
  // 有书时只展开写作和审改。没有书时开书组展开。用户点过后以存储为准。
  const [collapsedGroups, setCollapsedGroups] = useState<NavModeGroup[]>(() =>
    initialCollapsedGroups(useWikiStore.getState().project === null),
  )
  // 二级导航收纳：默认只展示 primary，secondary 收进 More；命中 secondary 时自动展开。
  const [expandedMore, setExpandedMore] = useState<NavModeGroup[]>([])
  const toggleMore = (group: NavModeGroup) => {
    setExpandedMore((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]))
  }
  const toggleGroup = (group: NavModeGroup) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]
      try {
        localStorage.setItem(NAV_COLLAPSED_GROUPS_KEY, JSON.stringify(next))
      } catch {
        /* 存储不可用时静默降级：折叠仅本次会话生效 */
      }
      return next
    })
  }

  // 没有书且还没点过分组时展开开书组。当前页所在组即使被折起也展开，避免高亮落在看不见的地方。
  // secondary 命中时同步展开该组 More，保证 data-view 可达。
  useEffect(() => {
    const activeItem = NAV_ITEMS.find((item) => item.view === activeView)
    const activeGroup = activeItem?.group
    const hasStoredPreference = typeof localStorage !== "undefined" && localStorage.getItem(NAV_COLLAPSED_GROUPS_KEY) !== null
    if (!hasStoredPreference) {
      setCollapsedGroups(initialCollapsedGroups(project === null).filter((group) => group !== activeGroup))
      if (activeItem && !isNavPrimaryTier(activeItem) && activeGroup) {
        setExpandedMore((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]))
      }
      return
    }
    if (activeGroup) {
      setCollapsedGroups((prev) => (prev.includes(activeGroup) ? prev.filter((group) => group !== activeGroup) : prev))
      if (activeItem && !isNavPrimaryTier(activeItem)) {
        setExpandedMore((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]))
      }
    }
  }, [activeView, project])

  const handleCycleTheme = () => {
    const themes: ("light" | "dark" | "deep-blue" | "eye-care" | "system")[] = ["system", "light", "dark", "deep-blue", "eye-care"]
    const currentIndex = themes.indexOf(theme)
    const nextIndex = (currentIndex + 1) % themes.length
    const nextTheme = themes[nextIndex]
    
    setTheme(nextTheme)
    saveTheme(nextTheme)
    applyTheme(nextTheme)
  }

  const getThemeIcon = () => {
    switch (theme) {
      case "light": return <Sun className="h-5 w-5 shrink-0" />
      case "dark": return <Moon className="h-5 w-5 shrink-0" />
      case "deep-blue": return <Monitor className="h-5 w-5 shrink-0" />
      case "eye-care": return <Eye className="h-5 w-5 shrink-0" />
      case "system": return <ArrowLeftRight className="h-5 w-5 shrink-0" />
      default: return <Sun className="h-5 w-5 shrink-0" />
    }
  }

  const getThemeTooltip = () => {
    switch (theme) {
      case "system": return t("theme.toLight")
      case "light": return t("theme.toDark")
      case "dark": return t("theme.toDeepBlue")
      case "deep-blue": return t("theme.toEyeCare")
      case "eye-care": return t("theme.toSystem")
      default: return t("theme.switch")
    }
  }

  const handleNavClick = (view: NavView) => {
    setSearchPanelOpen(false)
    const normalizedSelectedFile = selectedFile?.replace(/\\/g, "/") ?? ""
    if (
      view === "wiki" &&
      normalizedSelectedFile &&
      !normalizedSelectedFile.includes("/wiki/chapters/")
    ) {
      setSelectedFile(null)
    }
    if (
      view === "sources" &&
      normalizedSelectedFile &&
      !normalizedSelectedFile.includes("/wiki/outlines/")
    ) {
      setSelectedFile(null)
    }
    setActiveView(view)
  }

  const handleSearchClick = () => {
    setSearchPanelOpen(false)
    setActiveView("search")
  }

  return (
    <>
      <div className="flex h-full w-44 shrink-0 flex-col border-r bg-muted/50 py-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="soft-button mx-2 mb-2 flex items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
          title={t("iconSidebar.toggleSidebar")}
        >
          <img
            src={logoImg}
            alt={t("iconSidebar.logoAlt")}
            className="h-6 w-6 shrink-0 rounded-[28%]"
          />
          <span className="truncate text-sm font-semibold">Niko Buddy</span>
        </button>
        {/* Top: main nav items —— 本栏唯一可滚动组。14 个导航项在 720px 视口下就已
            超出 w-12 窄栏高度，而 flex 项的 min-height:auto 会阻止收缩，溢出将逃出
            本栏并撑高 document（整页可滚 = 底部按钮被推到视口外）。这里显式 min-h-0 +
            overflow-y-auto 把溢出收进本栏，底部操作组保持 shrink-0 永不被挤走。 */}
        <nav
          aria-label={t("novel.nav.railLabel", { defaultValue: "主导航" })}
          className="nav-rail-scroll flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto px-2"
        >
          {NAV_GROUP_ORDER.map(({ group, labelKey: groupLabelKey }) => {
            const items = NAV_ITEMS.filter((item) => item.group === group)
            const collapsed = collapsedGroups.includes(group)
            const primaryItems = items.filter(isNavPrimaryTier)
            const secondaryItems = items.filter((item) => !isNavPrimaryTier(item))
            const moreOpen = expandedMore.includes(group)
            const activeIsSecondary = secondaryItems.some((item) => item.view === activeView)
            const showSecondary = moreOpen || activeIsSecondary
            const visibleItems = collapsed ? [] : showSecondary ? items : primaryItems
            // PAT-U5（ISS-20260712-006 batch-2）：分组折叠/更多按钮补 aria-controls + region。
            const groupPanelId = `nav-group-${group}`
            return (
              <div key={group} data-nav-group={group}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={!collapsed}
                  aria-controls={groupPanelId}
                  className="flex h-6 w-full items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
                  <span className="min-w-0 flex-1 truncate text-left">{t(groupLabelKey)}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{items.length}</span>
                </button>
                <div id={groupPanelId} role="region" aria-label={t(groupLabelKey)}>
                {visibleItems.map(({ view, icon: Icon, labelKey }) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => handleNavClick(view)}
                      data-view={view}
                      title={t(labelKey)}
                      aria-current={activeView === view ? "page" : undefined}
                      className={`soft-button flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
                        activeView === view
                          ? "qm-selected"
                          : "text-muted-foreground qm-hover"
                      }`}
                    >
                      <Icon className="h-[1.125rem] w-[1.125rem] shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm">{t(labelKey)}</span>
                      {view === "reviewCenter" && pendingCount > 0 && (
                        <span data-testid="nav-badge" className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground">
                          {pendingCount > 99 ? "99+" : pendingCount}
                        </span>
                      )}
                    </button>
                  ))}
                {!collapsed && secondaryItems.length > 0 && !showSecondary ? (
                  <button
                    type="button"
                    onClick={() => toggleMore(group)}
                    data-testid={`nav-more-${group}`}
                    aria-expanded={false}
                    aria-controls={groupPanelId}
                    className="soft-button flex h-7 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate text-left">
                      {t("novel.nav.more", { count: secondaryItems.length, defaultValue: `更多 (${secondaryItems.length})` })}
                    </span>
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  </button>
                ) : null}
                {!collapsed && secondaryItems.length > 0 && showSecondary && !activeIsSecondary ? (
                  <button
                    type="button"
                    onClick={() => toggleMore(group)}
                    data-testid={`nav-more-${group}`}
                    aria-expanded={true}
                    aria-controls={groupPanelId}
                    className="soft-button flex h-7 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate text-left">
                      {t("novel.nav.less", { defaultValue: "收起" })}
                    </span>
                    <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
                  </button>
                ) : null}
                </div>
              </div>
            )
          })}
          <button
            type="button"
            onClick={handleSearchClick}
            data-view="search"
            title={t(SEARCH_NAV_ITEM.labelKey)}
            aria-current={activeView === "search" ? "page" : undefined}
            className={`soft-button flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
              activeView === "search"
                ? "qm-selected"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <Search className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">{t(SEARCH_NAV_ITEM.labelKey)}</span>
          </button>
        </nav>
        {/* Bottom: 低频工具（压缩为图标行）+ 主题 + 设置 + 切换小说 */}
        <div className="flex shrink-0 flex-col gap-0.5 border-t px-2 pb-1 pt-1">
          <div className="flex items-center gap-0.5" data-testid="nav-utility-row">
            {/* F-012: 封面 Prompt 工作台（独立 dialog） */}
            <button
              type="button"
              onClick={() => setCoverWorkbenchOpen(true)}
              data-cover-workbench-entry="true"
              title={t("novel.nav.coverWorkbench")}
              aria-label={t("novel.nav.coverWorkbench")}
              className="soft-button flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <Image className="h-[1.125rem] w-[1.125rem] shrink-0" />
            </button>
            {/* 65 号 G2: 翻译工作台入口（独立 dialog，零 activeView） */}
            <button
              type="button"
              onClick={() => setTranslationViewOpen(true)}
              data-translation-workbench-entry="true"
              title={t("novel.nav.translationWorkbench")}
              aria-label={t("novel.nav.translationWorkbench")}
              className="soft-button flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <Languages className="h-[1.125rem] w-[1.125rem] shrink-0" />
            </button>
            {/* 65 号 G2: 同人正典合并入口（Draft-first pending） */}
            <button
              type="button"
              onClick={() => setFanficMergeOpen(true)}
              data-fanfic-merge-entry="true"
              title={t("novel.nav.fanficMerge")}
              aria-label={t("novel.nav.fanficMerge")}
              className="soft-button flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <GitMerge className="h-[1.125rem] w-[1.125rem] shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchPanelOpen(false)
                setActiveView("trash")
                onOpenSidebar?.()
              }}
              data-view="trash"
              title={t("nav.trash")}
              aria-label={t("nav.trash")}
              aria-current={activeView === "trash" ? "page" : undefined}
              className={`soft-button flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                activeView === "trash"
                  ? "qm-selected"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Trash2 className="h-[1.125rem] w-[1.125rem] shrink-0" />
            </button>
          </div>
          {/* Theme toggle */}
          <button
            type="button"
            onClick={handleCycleTheme}
            title={getThemeTooltip()}
            className="soft-button flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            {getThemeIcon()}
            <span className="min-w-0 flex-1 truncate text-sm">{getThemeTooltip()}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchPanelOpen(false)
              setActiveView("settings")
            }}
            data-view="settings"
            title={t("novel.nav.settings")}
            aria-current={activeView === "settings" ? "page" : undefined}
            className={`soft-button flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
              activeView === "settings"
                ? "qm-selected"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <Settings className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">{t("novel.nav.settings")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchPanelOpen(false)
              onSwitchProject()
            }}
            title={t("nav.switchProject")}
            className="soft-button flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            <ArrowLeftRight className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">{t("nav.switchProject")}</span>
          </button>
        </div>
      </div>
      {/* F-012: 封面 Prompt 工作台 dialog（纯客户端，不调 streamChat） */}
      <Dialog open={coverWorkbenchOpen} onOpenChange={setCoverWorkbenchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("novel.coverWorkbench.title")}</DialogTitle>
            <DialogDescription>{t("novel.coverWorkbench.dialogHint")}</DialogDescription>
          </DialogHeader>
          <CoverPromptWorkbench />
        </DialogContent>
      </Dialog>
      {/* 65 号 G2: 翻译工作台 dialog（Port 注入由上层组装；此处默认未注入 → 优雅降级） */}
      <Dialog open={translationViewOpen} onOpenChange={setTranslationViewOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("novel.translation.title")}</DialogTitle>
            <DialogDescription>{t("novel.translation.dialogHint")}</DialogDescription>
          </DialogHeader>
          <TranslationWorkbenchView />
        </DialogContent>
      </Dialog>
      {/* 65 号 G2: 同人正典合并 dialog（Draft-first pending 工件） */}
      <FanficMergeDialog open={fanficMergeOpen} onOpenChange={setFanficMergeOpen} />
    </>
  )
}
