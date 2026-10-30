// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { BookOpen, FileText, Network, PlusCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"

export interface RecentChapterFile {
  path: string
  label: string
}

interface ChapterEmptyStateProps {
  /** 按章号倒序的最近章节（最多 6 条），来自文件树的只读投影。 */
  recentChapters: RecentChapterFile[]
  onSelectChapter: (path: string) => void
}

/**
 * 写作区空态（未选章节）。
 *
 * 背景（多专家 UI 审计 P0，2026-10-16）：主写作区未选章时只渲染一行
 * `preview.empty`（"选择文件以预览"），在 1440x900 下是一整屏空白 + 一句无动作指令，
 * 新手卡在「我该点哪里」。这里把空态改成可操作的下一步：
 *   ① 一句「去哪点」的指引；② 最近章节快捷入口（点击即打开，复用 setSelectedFile）；
 *   ③ 键盘入口提示（Ctrl/⌘+K 命令面板）。
 *
 * 纯展示层：不新增写路径、不触碰 Draft-first 门控，章节列表数据来自 store 的 fileTree。
 */
export function ChapterEmptyState({ recentChapters, onSelectChapter }: ChapterEmptyStateProps) {
  const { t } = useTranslation()
  // 空态直达新建：经 store nonce 复用 sidebar 已有创建链路（编号/落盘/选中），不经 Props 回调。
  const requestChapterCreate = useWikiStore((s) => s.requestChapterCreate)
  // 无项目时新建链路静默无操作（sidebar 守卫 + App 层 WelcomeScreen 拦截），此时只给图谱跳转。
  const project = useWikiStore((s) => s.project)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const activeView = useWikiStore((s) => s.activeView)
  const hasRecent = recentChapters.length > 0
  // 大纲库 / 回收站复用同一预览区：空态文案按所在视图说清「这里该点什么」，不再一律提示章节。
  const variant = activeView === "sources" ? "outline" : activeView === "trash" ? "trash" : "chapter"
  const title = variant === "outline"
    ? t("preview.emptyState.outlineTitle", { defaultValue: "还没有打开大纲" })
    : variant === "trash"
      ? t("preview.emptyState.trashTitle", { defaultValue: "还没有选中回收站里的内容" })
      : t("preview.emptyState.title")
  const hint = variant === "outline"
    ? t("preview.emptyState.outlineHint", { defaultValue: "在左侧「大纲」面板点一份大纲查看；也可以点上方「生成大纲」让 AI 起草。" })
    : variant === "trash"
      ? t("preview.emptyState.trashHint", { defaultValue: "在左侧回收站列表点一项即可预览，确认后再恢复或彻底删除。" })
      : t("preview.emptyState.hint")

  return (
    <div
      className="flex h-full items-center justify-center overflow-auto px-6 py-10"
      data-testid="preview-empty-state"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <BookOpen className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {hint}
          </p>
        </div>

        {hasRecent && variant === "chapter" ? (
          <div className="w-full space-y-2" data-testid="preview-empty-recent">
            <div className="text-xs font-medium text-muted-foreground">
              {t("preview.emptyState.recentTitle")}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {recentChapters.map((chapter) => (
                <button
                  key={chapter.path}
                  type="button"
                  onClick={() => onSelectChapter(chapter.path)}
                  title={chapter.path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{chapter.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {project && variant === "chapter" ? (
            <button
              type="button"
              onClick={requestChapterCreate}
              data-testid="preview-empty-create"
              className="inline-flex items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <PlusCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{t("sidebar.newChapter")}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setActiveView("graph")}
            data-testid="preview-empty-graph"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Network className="h-3.5 w-3.5 shrink-0" />
            <span>{t("preview.emptyState.viewGraph", { defaultValue: "去看看图谱" })}</span>
          </button>
        </div>

        {!project ? (
          <div className="text-xs text-muted-foreground">
            {t("preview.emptyState.noProjectHint", { defaultValue: "还没有打开项目，可以先看看图谱了解结构" })}
          </div>
        ) : null}

        <div className="text-xs text-muted-foreground">
          {t("preview.emptyState.commandHint")}
        </div>
      </div>
    </div>
  )
}
