// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { BookOpen, FileText, PlusCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

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
  const hasRecent = recentChapters.length > 0

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
            {t("preview.emptyState.title")}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("preview.emptyState.hint")}
          </p>
        </div>

        {hasRecent ? (
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
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <PlusCircle className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t("preview.emptyState.noChapterHint")}
            </span>
          </div>
        )}

        <div className="text-[0.6875rem] text-muted-foreground/80">
          {t("preview.emptyState.commandHint")}
        </div>
      </div>
    </div>
  )
}
