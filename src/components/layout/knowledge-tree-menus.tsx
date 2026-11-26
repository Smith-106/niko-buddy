// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
// F12 拆分边界：从 knowledge-tree.tsx 下沉右键菜单（WAI-ARIA role="menu" 键盘导航）与批量提取同号冲突排查卡。

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { getDirName, type CreateMenuState, type WikiPageInfo } from "./knowledge-tree-helpers"
import type { KnowledgeCreateRequest } from "./knowledge-tree"

function getEnabledMenuItems(container: HTMLDivElement | null): HTMLButtonElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(
    (item) => !item.disabled,
  )
}

function useMenuKeyboardNav(
  menuRef: React.RefObject<HTMLDivElement | null>,
  onClose: (restoreFocus?: boolean) => void,
) {
  useEffect(() => {
    const items = getEnabledMenuItems(menuRef.current)
    items[0]?.focus()
  }, [menuRef])

  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
      return
    }
    const items = getEnabledMenuItems(menuRef.current)
    if (items.length === 0) return

    const currentIndex = items.findIndex((item) => item === document.activeElement)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
      items[nextIndex]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      const nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
      items[nextIndex]?.focus()
    } else if (event.key === "Home") {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === "End") {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }
}

export interface CreateContextMenuProps {
  menu: CreateMenuState
  filterType: "chapter" | "outline"
  onRequestCreate?: (request: KnowledgeCreateRequest) => void
  onDeleteFolder: (folderPath: string) => void
  onOpenBatchExtract: () => void
  onClose: (restoreFocus?: boolean) => void
}

export function CreateContextMenu({
  menu,
  filterType,
  onRequestCreate,
  onDeleteFolder,
  onOpenBatchExtract,
  onClose,
}: CreateContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const handleKeyDown = useMenuKeyboardNav(menuRef, onClose)

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("knowledgeTree.createMenuLabel")}
      className="absolute z-20 w-40 rounded-md border bg-background py-1 text-xs elevation-3"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        aria-label={filterType === "chapter" ? t("sidebar.newChapter") : t("sidebar.newOutline")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => {
          onRequestCreate?.({ kind: filterType, parentDir: menu.parentDir })
          onClose(false)
        }}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        {filterType === "chapter" ? t("sidebar.newChapter") : t("sidebar.newOutline")}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={filterType === "chapter" ? t("sidebar.newVolume") : t("sidebar.newFolder")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => {
          onRequestCreate?.({ kind: filterType === "chapter" ? "volume" : "folder", parentDir: menu.parentDir })
          onClose(false)
        }}
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        {filterType === "chapter" ? t("sidebar.newVolume") : t("sidebar.newFolder")}
      </button>
      {menu.targetFolderPath ? (
        <button
          type="button"
          role="menuitem"
          aria-label={filterType === "chapter" ? t("knowledgeTree.deleteVolume") : t("knowledgeTree.deleteFolder")}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-destructive hover:bg-accent focus:bg-accent focus:outline-none"
          onClick={() => {
            const targetFolderPath = menu.targetFolderPath
            onClose(false)
            /* v8 ignore next */
            if (targetFolderPath) {
              onDeleteFolder(targetFolderPath)
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          {filterType === "chapter" ? t("knowledgeTree.deleteVolume") : t("knowledgeTree.deleteFolder")}
        </button>
      ) : null}
      {filterType === "chapter" && (
        <button
          type="button"
          role="menuitem"
          data-testid="knowledge-tree-batch-extract"
          className="flex w-full items-center gap-2 border-t px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
          onClick={() => {
            onOpenBatchExtract()
            onClose(false)
          }}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          {t("extract.batchEntry")}
        </button>
      )}
    </div>
  )
}

export interface PageContextMenuProps {
  menu: { path: string; x: number; y: number }
  filterType: "chapter" | "outline"
  targetPage: WikiPageInfo | undefined
  volumeFolders: ReadonlyArray<{ name: string; path: string }>
  moveMenuOpen: boolean
  onToggleMoveMenu: () => void
  onRequestCreate?: (request: KnowledgeCreateRequest) => void
  onStartRename: (page: WikiPageInfo) => void
  onOpenBatchExtract: (chapter: number | null) => void
  onMoveToVolume: (pagePath: string, volumePath: string) => void
  onOpenFileLocation: (pagePath: string) => void
  onClose: (restoreFocus?: boolean) => void
}

export function PageContextMenu({
  menu,
  filterType,
  targetPage,
  volumeFolders,
  moveMenuOpen,
  onToggleMoveMenu,
  onRequestCreate,
  onStartRename,
  onOpenBatchExtract,
  onMoveToVolume,
  onOpenFileLocation,
  onClose,
}: PageContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const handleKeyDown = useMenuKeyboardNav(menuRef, onClose)

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("knowledgeTree.pageMenuLabel")}
      className="absolute z-20 w-40 rounded-md border bg-background py-1 text-xs elevation-3"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        aria-label={filterType === "chapter" ? t("sidebar.newChapter") : t("sidebar.newOutline")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => {
          onRequestCreate?.({ kind: filterType, parentDir: targetPage ? getDirName(targetPage.path) : undefined })
          onClose(false)
        }}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        {filterType === "chapter" ? t("sidebar.newChapter") : t("sidebar.newOutline")}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={filterType === "chapter" ? t("sidebar.newVolume") : t("sidebar.newFolder")}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => {
          onRequestCreate?.({
            kind: filterType === "chapter" ? "volume" : "folder",
            parentDir: targetPage ? getDirName(targetPage.path) : undefined,
          })
          onClose(false)
        }}
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        {filterType === "chapter" ? t("sidebar.newVolume") : t("sidebar.newFolder")}
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => {
          if (targetPage) onStartRename(targetPage)
        }}
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" />
        {t("knowledgeTree.rename")}
      </button>
      {/* G3（TASK-004 D3）：单章重提语义不变（本项只是新增入口，不改既有项）。 */}
      {filterType === "chapter" && (
        <button
          type="button"
          role="menuitem"
          data-testid="knowledge-tree-batch-extract"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
          onClick={() => {
            onOpenBatchExtract(targetPage?.chapterNumber ?? null)
            onClose(false)
          }}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          {t("extract.batchEntry")}
        </button>
      )}
      {filterType === "chapter" && volumeFolders.length > 0 && (
        <div>
          <button
            type="button"
            role="menuitem"
            aria-expanded={moveMenuOpen}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
            onClick={onToggleMoveMenu}
          >
            <FolderInput className="h-3.5 w-3.5 shrink-0" />
            {t("knowledgeTree.moveToVolume")}
            <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
          </button>
          {moveMenuOpen && (
            <div className="max-h-48 overflow-y-auto border-t bg-background py-1 text-xs">
              {volumeFolders.map((vol) => {
                const sourceDir = getDirName(menu.path)
                const isCurrentVolume = sourceDir === vol.path
                return (
                  <button
                    key={vol.path}
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none ${isCurrentVolume ? "cursor-not-allowed opacity-50" : ""}`}
                    disabled={isCurrentVolume}
                    onClick={() => {
                      /* v8 ignore next */
                      if (!isCurrentVolume) {
                        onMoveToVolume(menu.path, vol.path)
                      }
                    }}
                  >
                    <Folder className="h-3 w-3 shrink-0 text-warning" />
                    <span className="truncate">{vol.name}</span>
                    {isCurrentVolume && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t("knowledgeTree.currentVolume")}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onOpenFileLocation(menu.path)}
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        {t("knowledgeTree.openFileLocation")}
      </button>
    </div>
  )
}

export interface BatchDuplicateConflictCardProps {
  duplicateChapters: readonly number[]
  duplicateChapterPaths?: Readonly<Record<number, readonly string[]>>
  busy?: boolean
  relocatingPath?: string | null
  onLocateFile: (path: string) => void
  onRelocateDuplicate: (path: string, chapterNumber: number) => void
}

/**
 * 批量提取同号正式章冲突排查卡（P1-03）：
 * 消费 SnapshotScanResult["excluded"] 的 duplicateChapters 与 duplicateChapterPaths，
 * 为每个冲突文件提供「打开定位」，并为重复副本提供「一键顺延章号」。
 */
export function BatchDuplicateConflictCard({
  duplicateChapters,
  duplicateChapterPaths,
  busy = false,
  relocatingPath = null,
  onLocateFile,
  onRelocateDuplicate,
}: BatchDuplicateConflictCardProps) {
  const { t } = useTranslation()
  if (duplicateChapters.length === 0) return null

  return (
    <div
      data-testid="batch-duplicate-conflict-card"
      role="region"
      aria-label={t("extract.batchDuplicateTitle", { defaultValue: "同号正式章冲突排查" })}
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs"
    >
      <div className="flex items-start gap-1.5 text-warning-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div className="space-y-0.5">
          <div className="font-medium">
            {t("extract.batchDuplicateHeading", {
              count: duplicateChapters.length,
              defaultValue: `发现 ${duplicateChapters.length} 组同号正式章冲突（已自动跳过）`,
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("extract.batchDuplicateHint", {
              defaultValue: "可点击定位检查正文，或将副本一键顺延到末尾新章号后自动重新扫描。",
            })}
          </p>
        </div>
      </div>

      <div className="max-h-36 space-y-2 overflow-y-auto">
        {duplicateChapters.map((chapterNumber) => {
          const paths = duplicateChapterPaths?.[chapterNumber] ?? []
          return (
            <div key={chapterNumber} className="space-y-1 rounded border border-border/60 bg-background/80 p-2">
              <div className="font-medium text-foreground">
                {t("extract.batchDuplicateChapterLabel", {
                  chapter: chapterNumber,
                  count: paths.length,
                  defaultValue: paths.length > 0 ? `第 ${chapterNumber} 章（${paths.length} 个正式章文件）` : `第 ${chapterNumber} 章`,
                })}
              </div>
              {paths.length > 0 ? (
                <ul className="space-y-1">
                  {paths.map((filePath, index) => {
                    const isRelocating = relocatingPath === normalizePath(filePath)
                    const actionDisabled = busy || Boolean(relocatingPath)
                    return (
                      <li key={filePath} className="flex items-center justify-between gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={filePath}>
                          {getFileName(filePath)}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[11px]"
                            disabled={actionDisabled}
                            onClick={() => onLocateFile(filePath)}
                          >
                            <ExternalLink className="mr-0.5 h-3 w-3" />
                            {t("extract.batchDuplicateLocate", { defaultValue: "打开定位" })}
                          </Button>
                          {index > 0 ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              data-testid="batch-relocate-duplicate"
                              className="h-6 px-1.5 text-[11px]"
                              disabled={actionDisabled}
                              onClick={() => onRelocateDuplicate(filePath, chapterNumber)}
                            >
                              <ArrowRight className="mr-0.5 h-3 w-3" />
                              {isRelocating
                                ? t("extract.batchDuplicateRelocating", { defaultValue: "顺延中…" })
                                : t("extract.batchDuplicateRelocate", { defaultValue: "一键顺延章号" })}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {t("extract.batchDuplicateMissingPaths", {
                    defaultValue: "请在左侧章节列表中检查同号章节文件并调整章号。",
                  })}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
