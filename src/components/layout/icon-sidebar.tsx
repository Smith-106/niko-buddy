// Copyright © 2024-2099 QAHUI (https://qmai.qimai-im.com/)
// SPDX-License-Identifier: MIT

import { useState } from "react"
import {
  FileText, FolderOpen, Search, Network, Brain, Settings, ArrowLeftRight, Sun, Moon, Monitor, Trash2, Sparkles, LayoutDashboard, BookOpen, Image,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CoverPromptWorkbench } from "@/components/novel/cover-prompt-workbench"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useTranslation } from "react-i18next"
import logoImg from "@/assets/QM-LOGO.png"
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
  { view: "wiki", icon: FileText, labelKey: "novel.nav.wiki" },
  { view: "sources", icon: FolderOpen, labelKey: "novel.nav.sources" },
  { view: "graph", icon: Network, labelKey: "novel.nav.graph" },
  { view: "lint", icon: Brain, labelKey: "novel.nav.lint" },
  { view: "soul", icon: Sparkles, labelKey: "novel.nav.soul" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "novel.nav.dismantling" },
  { view: "reviewCenter", icon: LayoutDashboard, labelKey: "novel.nav.reviewCenter" },
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
      case "light": return <Sun className="h-5 w-5" />
      case "dark": return <Moon className="h-5 w-5" />
      case "deep-blue": return <Monitor className="h-5 w-5" />
      case "system": return <ArrowLeftRight className="h-5 w-5" />
      default: return <Sun className="h-5 w-5" />
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
    <TooltipProvider delay={300}>
      <div className="flex h-full w-12 flex-col items-center border-r bg-muted/50 py-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="mb-2 flex items-center justify-center rounded-md p-0.5 transition-colors hover:bg-accent/50"
          title={t("iconSidebar.toggleSidebar")}
        >
          <img
            src={logoImg}
            alt={t("iconSidebar.logoAlt")}
            className="h-6 w-6 rounded-[22%]"
          />
        </button>
        {/* Top: main nav items */}
        <div className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map(({ view, icon: Icon, labelKey }) => (
            <Tooltip key={view}>
              <TooltipTrigger
                onClick={() => handleNavClick(view)}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                  activeView === view
                    ? "qm-selected"
                    : "text-muted-foreground qm-hover"
                }`}
              >
                <Icon className="h-5 w-5" />
                {view === "reviewCenter" && pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">
                {t(labelKey)}
                {view === "reviewCenter" && pendingCount > 0 && ` (${pendingCount})`}
              </TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger
              onClick={handleSearchClick}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "search"
                  ? "qm-selected"
                  : "text-muted-foreground qm-hover"
              }`}
            >
              <Search className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">
              {t(SEARCH_NAV_ITEM.labelKey)}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => {
                setSearchPanelOpen(false)
                setActiveView("trash")
                onOpenSidebar?.()
              }}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "trash"
                  ? "qm-selected"
                  : "text-muted-foreground qm-hover"
              }`}
            >
              <Trash2 className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.trash")}</TooltipContent>
          </Tooltip>
        </div>
        {/* Bottom: cover workbench + daemon status + theme toggle + settings + switch project */}
        <div className="flex flex-col items-center gap-1 pb-1">
          {/* F-012: 封面 Prompt 工作台（独立 dialog） */}
          <Tooltip>
            <TooltipTrigger
              onClick={() => setCoverWorkbenchOpen(true)}
              data-cover-workbench-entry="true"
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <Image className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("novel.nav.coverWorkbench")}</TooltipContent>
          </Tooltip>
          {/* Theme toggle */}
          <Tooltip>
            <TooltipTrigger
              onClick={handleCycleTheme}
              className="relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              {getThemeIcon()}
            </TooltipTrigger>
            <TooltipContent side="right">
              {getThemeTooltip()}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => {
                setSearchPanelOpen(false)
                setActiveView("settings")
              }}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "settings"
                  ? "qm-selected"
                  : "text-muted-foreground qm-hover"
              }`}
            >
              <Settings className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("novel.nav.settings")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => {
                setSearchPanelOpen(false)
                onSwitchProject()
              }}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <ArrowLeftRight className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.switchProject")}</TooltipContent>
          </Tooltip>
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
    </TooltipProvider>
  )
}
