// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CornerDownLeft, FileText, Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { NAV_ITEMS, SEARCH_NAV_ITEM, type NavItem } from "./nav-items"

/**
 * 命令面板（Ctrl/⌘+K）。
 *
 * 背景（findings-1 F-12 / findings-4 ROI #1，2026-10-16）：导航一栏 15 项 + 底部 6 项，
 * 全部视图与章节只能靠鼠标在侧栏里找；键盘用户没有任何「直接跳转」通道，新用户也不知道
 * 「章节库」叫什么。参考对标（lore-weave ⌘P / ⌘⇧P、novelWriter 的命令面板）一致采用
 * 「一个输入框直达任意目标」。
 *
 * 设计要点：
 * - 键盘优先：↑/↓ 选择、Enter 执行、Esc 关闭（Esc 由共享 Dialog 处理）。
 * - 鼠标可达：标题栏中央有可见入口（标题栏「搜索…」按钮），不只是隐藏快捷键。
 * - 纯展示层：只调用既有的 setActiveView / setSelectedFile，不新增真源、不触碰 Draft-first。
 * - 数据源同侧栏：NAV_ITEMS 与 icon-sidebar 共用（见 ./nav-items.ts），章节来自只读 fileTree。
 */

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PaletteEntry {
  id: string
  label: string
  hint: string
  keywords: string
  run: () => void
}

function isChapterFile(node: FileNode): boolean {
  return !node.is_dir && /\.md$/i.test(node.name) && node.path.replace(/\\/g, "/").includes("/wiki/chapters/")
}

function collectChapterEntries(nodes: FileNode[]): { path: string; title: string }[] {
  const out: { path: string; title: string }[] = []
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        if (node.children) walk(node.children)
        continue
      }
      if (!isChapterFile(node)) continue
      out.push({ path: node.path, title: node.name.replace(/\.md$/i, "") })
    }
  }
  walk(nodes)
  return out
}

/** 归一化匹配：忽略大小写、空白与常见分隔符，让「第12章」也能命中「chapter-012.md」。 */
function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/[\s\-_/\\()[\]，。、]/g, "")
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery("")
    setActiveIndex(0)
  }, [open])

  const entries = useMemo<PaletteEntry[]>(() => {
    const navEntries: PaletteEntry[] = NAV_ITEMS.map((item: NavItem) => ({
      id: `view:${item.view}`,
      label: t(item.labelKey),
      hint: t("commandPalette.kindView", { defaultValue: "视图" }),
      keywords: `${item.view} ${t(item.labelKey)} ${t(item.labelKey, { lng: "en" })}`,
      run: () => setActiveView(item.view),
    }))
    navEntries.push({
      id: `view:${SEARCH_NAV_ITEM.view}`,
      label: t(SEARCH_NAV_ITEM.labelKey),
      hint: t("commandPalette.kindView", { defaultValue: "视图" }),
      keywords: `search ${t(SEARCH_NAV_ITEM.labelKey)}`,
      run: () => setActiveView(SEARCH_NAV_ITEM.view),
    })
    navEntries.push({
      id: "view:settings",
      label: t("novel.nav.settings"),
      hint: t("commandPalette.kindView", { defaultValue: "视图" }),
      keywords: `settings ${t("novel.nav.settings")}`,
      run: () => setActiveView("settings"),
    })
    const chapterEntries: PaletteEntry[] = collectChapterEntries(fileTree ?? []).map((chapter) => ({
      id: `chapter:${chapter.path}`,
      label: chapter.title,
      hint: t("commandPalette.kindChapter", { defaultValue: "章节" }),
      keywords: chapter.path,
      run: () => {
        setActiveView("wiki")
        setSelectedFile(chapter.path)
      },
    }))
    return [...chapterEntries, ...navEntries]
  }, [fileTree, setActiveView, setSelectedFile, t])

  const filtered = useMemo(() => {
    const q = normalizeQuery(query)
    if (!q) return entries.slice(0, 40)
    return entries
      .filter((entry) => normalizeQuery(`${entry.label}${entry.keywords}`).includes(q))
      .slice(0, 40)
  }, [entries, query])

  const runEntry = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return
      entry.run()
      onOpenChange(false)
    },
    [onOpenChange],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((prev) => (filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length))
    } else if (event.key === "Enter") {
      event.preventDefault()
      runEntry(filtered[activeIndex])
    }
  }

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const active = container.querySelector(`[data-index="${activeIndex}"]`)
    active?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        data-testid="command-palette"
        className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">
          {t("commandPalette.title", { defaultValue: "命令面板" })}
        </DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[activeIndex] ? `command-palette-${filtered[activeIndex].id}` : undefined}
            aria-label={t("commandPalette.placeholder", { defaultValue: "搜索章节与功能" })}
            placeholder={t("commandPalette.placeholder", { defaultValue: "搜索章节与功能" })}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label={t("commandPalette.title", { defaultValue: "命令面板" })}
          className="max-h-[22rem] overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("commandPalette.empty", { defaultValue: "没有匹配的章节或功能" })}
            </div>
          ) : (
            filtered.map((entry, index) => (
              <button
                key={entry.id}
                id={`command-palette-${entry.id}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runEntry(entry)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
                }`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{entry.hint}</span>
                {index === activeIndex && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
