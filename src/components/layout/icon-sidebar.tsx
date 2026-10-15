// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useState } from "react"
import {
  FileText, FolderOpen, Search, Network, Brain, Settings, ArrowLeftRight, Sun, Moon, Monitor, Trash2, Sparkles, LayoutDashboard, BookOpen, Image, ArchiveRestore, ScrollText, Clapperboard, Languages, GitMerge, Database, Stethoscope,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CoverPromptWorkbench } from "@/components/novel/cover-prompt-workbench"
import { TranslationWorkbenchView } from "@/components/novel/translation-workbench-view"
import { FanficMergeDialog } from "@/components/novel/fanfic-merge-dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useTranslation } from "react-i18next"
import logoImg from "@/assets/niko-buddy-logo.png"
import type { WikiState } from "@/stores/wiki-store"
import { saveTheme } from "@/lib/project-store"
import { applyTheme } from "@/lib/theme-utils"

type NavView = WikiState["activeView"]

const SEARCH_NAV_ITEM: { view: NavView; icon: typeof FileText; labelKey: string } = {
  view: "search",
  icon: Search,
  labelKey: "novel.nav.search",
}

const NAV_ITEMS: { view: NavView; icon: typeof FileText; labelKey: string }[] = [
  { view: "workbench", icon: LayoutDashboard, labelKey: "novel.nav.workbench" },
  { view: "wiki", icon: FileText, labelKey: "novel.nav.wiki" },
  { view: "director", icon: Clapperboard, labelKey: "novel.nav.director" },
  { view: "sources", icon: FolderOpen, labelKey: "novel.nav.sources" },
  { view: "graph", icon: Network, labelKey: "novel.nav.graph" },
  { view: "lint", icon: Brain, labelKey: "novel.nav.lint" },
  { view: "soul", icon: Sparkles, labelKey: "novel.nav.soul" },
  { view: "skillLibrary", icon: Sparkles, labelKey: "novel.nav.skillLibrary" },
  { view: "storySimulation", icon: Sparkles, labelKey: "novel.nav.storySimulation" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "novel.nav.dismantling" },
  { view: "canonEditor", icon: ScrollText, labelKey: "novel.nav.canonEditor" },
  { view: "backupExport", icon: ArchiveRestore, labelKey: "novel.nav.backupExport" },
  { view: "diagnosticsCenter", icon: Stethoscope, labelKey: "novel.nav.diagnosticsCenter" },
  { view: "reviewCenter", icon: LayoutDashboard, labelKey: "novel.nav.reviewCenter" },
  { view: "dataManager", icon: Database, labelKey: "novel.nav.dataManager" },
]

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
  const pendingCount = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  // F-012: 封面 Prompt 工作台入口（独立 dialog，不新增 activeView，不进主链热路径）
  const [coverWorkbenchOpen, setCoverWorkbenchOpen] = useState(false)
  const [translationViewOpen, setTranslationViewOpen] = useState(false)
  const [fanficMergeOpen, setFanficMergeOpen] = useState(false)

  const handleCycleTheme = () => {
    const themes: ("light" | "dark" | "deep-blue" | "system")[] = ["system", "light", "dark", "deep-blue"]
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
      case "system": return <ArrowLeftRight className="h-5 w-5 shrink-0" />
      default: return <Sun className="h-5 w-5 shrink-0" />
    }
  }

  const getThemeTooltip = () => {
    switch (theme) {
      case "system": return t("theme.toLight")
      case "light": return t("theme.toDark")
      case "dark": return t("theme.toDeepBlue")
      case "deep-blue": return t("theme.toSystem")
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
          <span className="truncate text-[0.8125rem] font-semibold">Niko Buddy</span>
        </button>
        {/* Top: main nav items —— 本栏唯一可滚动组。14 个导航项在 720px 视口下就已
            超出 w-12 窄栏高度，而 flex 项的 min-height:auto 会阻止收缩，溢出将逃出
            本栏并撑高 document（整页可滚 = 底部按钮被推到视口外）。这里显式 min-h-0 +
            overflow-y-auto 把溢出收进本栏，底部操作组保持 shrink-0 永不被挤走。 */}
        <div className="nav-rail-scroll flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto px-2">
          {NAV_ITEMS.map(({ view, icon: Icon, labelKey }) => (
            <button
              key={view}
              type="button"
              onClick={() => handleNavClick(view)}
              data-view={view}
              title={t(labelKey)}
              className={`soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
                activeView === view
                  ? "qm-selected"
                  : "text-muted-foreground qm-hover"
              }`}
            >
              <Icon className="h-[1.125rem] w-[1.125rem] shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t(labelKey)}</span>
              {view === "reviewCenter" && pendingCount > 0 && (
                <span data-testid="nav-badge" className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-bold text-primary-foreground">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={handleSearchClick}
            data-view="search"
            title={t(SEARCH_NAV_ITEM.labelKey)}
            className={`soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
              activeView === "search"
                ? "qm-selected"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <Search className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t(SEARCH_NAV_ITEM.labelKey)}</span>
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
            className={`soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
              activeView === "trash"
                ? "qm-selected"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <Trash2 className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("nav.trash")}</span>
          </button>
        </div>
        {/* Bottom: cover workbench + daemon status + theme toggle + settings + switch project */}
        <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
          {/* F-012: 封面 Prompt 工作台（独立 dialog） */}
          <button
            type="button"
            onClick={() => setCoverWorkbenchOpen(true)}
            data-cover-workbench-entry="true"
            title={t("novel.nav.coverWorkbench")}
            className="soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            <Image className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("novel.nav.coverWorkbench")}</span>
          </button>
          {/* 65 号 G2: 翻译工作台入口（独立 dialog，零 activeView） */}
          <button
            type="button"
            onClick={() => setTranslationViewOpen(true)}
            data-translation-workbench-entry="true"
            title={t("novel.nav.translationWorkbench")}
            className="soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            <Languages className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("novel.nav.translationWorkbench")}</span>
          </button>
          {/* 65 号 G2: 同人正典合并入口（Draft-first pending） */}
          <button
            type="button"
            onClick={() => setFanficMergeOpen(true)}
            data-fanfic-merge-entry="true"
            title={t("novel.nav.fanficMerge")}
            className="soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            <GitMerge className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("novel.nav.fanficMerge")}</span>
          </button>
          {/* Theme toggle */}
          <button
            type="button"
            onClick={handleCycleTheme}
            title={getThemeTooltip()}
            className="soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            {getThemeIcon()}
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{getThemeTooltip()}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchPanelOpen(false)
              setActiveView("settings")
            }}
            data-view="settings"
            title={t("novel.nav.settings")}
            className={`soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors ${
              activeView === "settings"
                ? "qm-selected"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <Settings className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("novel.nav.settings")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchPanelOpen(false)
              onSwitchProject()
            }}
            title={t("nav.switchProject")}
            className="soft-button flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          >
            <ArrowLeftRight className="h-[1.125rem] w-[1.125rem] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{t("nav.switchProject")}</span>
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
