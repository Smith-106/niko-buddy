// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"
import { Sun, Moon, Monitor, ArrowLeftRight, Minus, Square, X, Type } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { saveTheme } from "@/lib/project-store"
import { applyTheme, type ThemeMode } from "@/lib/theme-utils"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/platform"

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark", "deep-blue"]

/**
 * 应用顶栏：logo+项目名（左）· 主题/字号快捷入口（中）· 窗口控制（右，仅 Tauri）。
 * 收纳 icon-sidebar 底部操作组的高频项，缓解窄栏拥挤；原底部按钮保留（不删入口）。
 */
export function TitleBar() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const theme = useWikiStore((s) => s.theme)
  const setTheme = useWikiStore((s) => s.setTheme)
  const uiFontSizeScale = useWikiStore((s) => s.uiFontSizeScale)
  const setUiFontSizeScale = useWikiStore((s) => s.setUiFontSizeScale)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
    setTheme(next)
    saveTheme(next)
    applyTheme(next)
  }

  const themeIcon = () => {
    switch (theme) {
      case "light": return <Sun className="h-4 w-4" />
      case "dark": return <Moon className="h-4 w-4" />
      case "deep-blue": return <Monitor className="h-4 w-4" />
      default: return <ArrowLeftRight className="h-4 w-4" />
    }
  }

  const bumpFont = (delta: number) => {
    const next = Math.round((uiFontSizeScale + delta) * 100) / 100
    setUiFontSizeScale(next)
  }

  const win = async (op: "min" | "max" | "close") => {
    if (!isTauri()) return
    try {
      const w = getCurrentWindow()
      if (op === "min") await w.minimize()
      else if (op === "max") await w.toggleMaximize()
      else await w.close()
    } catch {
      /* 窗口控制失败静默：不阻塞顶栏其余功能 */
    }
  }

  return (
    <header
      data-testid="title-bar"
      className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/40 px-3"
    >
      {/* 左：应用名 + 项目名 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-sm font-semibold">Niko Buddy</span>
        {project && (
          <span className="truncate text-xs text-muted-foreground" title={project.name}>
            · {project.name}
          </span>
        )}
      </div>
      <div className="flex-1" />
      {/* 中：主题 / 字号快捷入口 */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={cycleTheme}
          className="soft-button flex h-7 w-7 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title={t("theme.switch")}
          aria-label={t("theme.switch")}
        >
          {themeIcon()}
        </button>
        <button
          type="button"
          onClick={() => bumpFont(-0.05)}
          disabled={uiFontSizeScale <= 0.85}
          className="soft-button flex h-7 w-7 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title="减小字号"
          aria-label="减小字号"
        >
          <Type className="h-3.5 w-3.5" />
          <span className="text-[0.625rem]">−</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveSettingsCategory("interface")
            setActiveView("settings")
          }}
          className="soft-button flex h-7 items-center rounded-xl px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title={t("settings.sections.interface.fontSize")}
        >
          {Math.round(uiFontSizeScale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => bumpFont(0.05)}
          disabled={uiFontSizeScale >= 1.3}
          className="soft-button flex h-7 w-7 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title="增大字号"
          aria-label="增大字号"
        >
          <Type className="h-3.5 w-3.5" />
          <span className="text-[0.625rem]">＋</span>
        </button>
      </div>
      {/* 右：窗口控制（仅桌面端） */}
      {isTauri() && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => win("min")}
            className="soft-button flex h-7 w-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="最小化"
            aria-label="最小化"
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => win("max")}
            className="soft-button flex h-7 w-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="最大化/还原"
            aria-label="最大化/还原"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => win("close")}
            className="soft-button flex h-7 w-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-destructive/80 hover:text-destructive-foreground"
            title="关闭"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </header>
  )
}
