// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
// M11-1 增量切片：从 knowledge-tree.tsx 剥离树节点渲染层（纯组件）。
// knowledge-tree.tsx 保留数据 hook / 变异回调 / 菜单浮层，仅透传 props。

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react"
import { ChevronDown, ChevronRight, FileText, Folder, Globe } from "lucide-react"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  chapterStatusDotClass,
  countMarkdownDescendants,
  sortFileNodes,
  DeleteButton,
  type WikiPageInfo,
} from "./knowledge-tree-helpers"

export interface KnowledgeTreeNodesProps {
  nodes: FileNode[]
  depth?: number
  filterType: "chapter" | "outline"
  pageInfoByPath: Map<string, WikiPageInfo>
  sortedChapterPages: WikiPageInfo[]
  collapsedFolders: Record<string, boolean>
  selectedFile: string | null
  armedPath: string | null
  deletingPath: string | null
  renamingPath: string | null
  renameValue: string
  renamingBusy: boolean
  dragSource: string | null
  dragInsertIndex: number | null
  isDragging: boolean
  onToggleFolder: (folderPath: string) => void
  onOpenCreateMenu: (event: ReactMouseEvent, parentDir?: string, targetFolderName?: string) => void
  onPageClick: (pagePath: string) => void
  onPageContextMenu: (event: ReactMouseEvent, pagePath: string) => void
  onItemPointerDown: (event: ReactPointerEvent, pagePath: string) => void
  onDeleteClick: (pagePath: string) => void
  onRenameValueChange: (value: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
}

interface FolderRowProps {
  node: FileNode
  normalizedPath: string
  depth: number
  isCollapsed: boolean
  onToggleFolder: (folderPath: string) => void
  onOpenCreateMenu: (event: ReactMouseEvent, parentDir?: string, targetFolderName?: string) => void
}

function FolderRow({
  node,
  normalizedPath,
  depth,
  isCollapsed,
  onToggleFolder,
  onOpenCreateMenu,
}: FolderRowProps) {
  return (
    <div
      data-knowledge-interactive="true"
      className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground qm-hover"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onContextMenu={(event) => onOpenCreateMenu(event, normalizedPath, node.name)}
    >
      <button
        type="button"
        onClick={() => onToggleFolder(normalizedPath)}
        className="flex flex-1 items-center gap-1.5 text-left"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-warning" />
        <span className="truncate font-medium">{node.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">{countMarkdownDescendants(node)}</span>
      </button>
    </div>
  )
}

interface PageRowProps {
  normalizedPath: string
  page: WikiPageInfo
  depth: number
  filterType: "chapter" | "outline"
  isSelected: boolean
  isArmed: boolean
  isDeleting: boolean
  isDragSource: boolean
  isInsertTarget: boolean
  renamingPath: string | null
  renameValue: string
  renamingBusy: boolean
  onPageClick: (pagePath: string) => void
  onPageContextMenu: (event: ReactMouseEvent, pagePath: string) => void
  onItemPointerDown: (event: ReactPointerEvent, pagePath: string) => void
  onDeleteClick: (pagePath: string) => void
  onRenameValueChange: (value: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
}

function PageRow({
  normalizedPath,
  page,
  depth,
  filterType,
  isSelected,
  isArmed,
  isDeleting,
  isDragSource,
  isInsertTarget,
  renamingPath,
  renameValue,
  renamingBusy,
  onPageClick,
  onPageContextMenu,
  onItemPointerDown,
  onDeleteClick,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
}: PageRowProps) {
  return (
    <div
      data-knowledge-interactive="true"
      data-page-path={normalizedPath}
      className={`group flex items-center gap-1 rounded-md ${isSelected ? "qm-selected" : "qm-hover"} ${isDragSource ? "ring-2 ring-primary/50" : ""} ${isInsertTarget ? "border-t-[3px] border-primary/70" : ""}`}
      onContextMenu={(event) => onPageContextMenu(event, normalizedPath)}
      onPointerDown={(event) => onItemPointerDown(event, normalizedPath)}
      style={{
        marginLeft: `${depth * 16}px`,
        userSelect: filterType === "chapter" ? "none" : undefined,
        WebkitUserSelect: filterType === "chapter" ? "none" : undefined,
        WebkitTouchCallout: filterType === "chapter" ? "none" : undefined,
      }}
    >
      <button
        type="button"
        onClick={() => onPageClick(normalizedPath)}
        disabled={renamingPath === normalizedPath}
        className={`flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1 text-left text-sm ${
          isSelected ? "qm-selected-muted" : "text-muted-foreground group-hover:text-foreground"
        }`}
        title={normalizedPath}
      >
        {page.origin === "web-clip" ? <Globe className="h-3 w-3 shrink-0 text-info" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {renamingPath === normalizedPath ? (
          <input
            type="text"
            value={renameValue}
            onChange={(event) => onRenameValueChange(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onFocus={(event) => event.stopPropagation()}
            onBlur={() => onSubmitRename()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") {
                event.preventDefault()
                onSubmitRename()
              } else if (event.key === "Escape") {
                event.preventDefault()
                onCancelRename()
              }
            }}
            className="w-full rounded border bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            autoFocus
            disabled={renamingBusy}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{page.title}</span>
            {page.type === "chapter" && page.statusLabel && (
              <span
                data-chapter-status={page.status}
                title={page.statusLabel}
                aria-label={page.statusLabel}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${chapterStatusDotClass(page.status)}`}
              />
            )}
            {page.type === "chapter" && page.wordCountLabel && (
              <span className={`shrink-0 text-right text-xs ${isSelected ? "qm-selected-muted" : "text-muted-foreground"}`}>
                {page.wordCountLabel}
              </span>
            )}
          </>
        )}
      </button>
      <DeleteButton
        armed={isArmed}
        deleting={isDeleting}
        className={`mr-1 transition-opacity ${isArmed || isDeleting ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:opacity-100"}`}
        onClick={() => onDeleteClick(normalizedPath)}
        name={page.title}
      />
    </div>
  )
}

/**
 * 知识树节点渲染层（纯组件，无 store / FS 副作用）。
 * 与 knowledge-tree.tsx 的 renderNodes 逐行同构：目录行 + 文件行 + 拖拽高亮 + 重命名输入。
 */
export function KnowledgeTreeNodes({
  nodes,
  depth = 0,
  filterType,
  pageInfoByPath,
  sortedChapterPages,
  collapsedFolders,
  selectedFile,
  armedPath,
  deletingPath,
  renamingPath,
  renameValue,
  renamingBusy,
  dragSource,
  dragInsertIndex,
  isDragging,
  onToggleFolder,
  onOpenCreateMenu,
  onPageClick,
  onPageContextMenu,
  onItemPointerDown,
  onDeleteClick,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
}: KnowledgeTreeNodesProps) {
  const chapterIndexMap = new Map<string, number>()
  sortedChapterPages.forEach((page, index) => chapterIndexMap.set(page.path, index))

  return (
    <>
      {sortFileNodes(nodes, pageInfoByPath, filterType).flatMap((node) => {
        const normalizedPath = normalizePath(node.path)
        if (node.is_dir) {
          const isCollapsed = collapsedFolders[normalizedPath] ?? false
          return [
            <div key={normalizedPath}>
              <FolderRow
                node={node}
                normalizedPath={normalizedPath}
                depth={depth}
                isCollapsed={isCollapsed}
                onToggleFolder={onToggleFolder}
                onOpenCreateMenu={onOpenCreateMenu}
              />
              {!isCollapsed && node.children && (
                <KnowledgeTreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  filterType={filterType}
                  pageInfoByPath={pageInfoByPath}
                  sortedChapterPages={sortedChapterPages}
                  collapsedFolders={collapsedFolders}
                  selectedFile={selectedFile}
                  armedPath={armedPath}
                  deletingPath={deletingPath}
                  renamingPath={renamingPath}
                  renameValue={renameValue}
                  renamingBusy={renamingBusy}
                  dragSource={dragSource}
                  dragInsertIndex={dragInsertIndex}
                  isDragging={isDragging}
                  onToggleFolder={onToggleFolder}
                  onOpenCreateMenu={onOpenCreateMenu}
                  onPageClick={onPageClick}
                  onPageContextMenu={onPageContextMenu}
                  onItemPointerDown={onItemPointerDown}
                  onDeleteClick={onDeleteClick}
                  onRenameValueChange={onRenameValueChange}
                  onSubmitRename={onSubmitRename}
                  onCancelRename={onCancelRename}
                />
              )}
            </div>,
          ]
        }

        if (!node.name.endsWith(".md")) return []
        const page = pageInfoByPath.get(normalizedPath) ?? {
          path: normalizedPath,
          title: node.name.replace(/\.md$/, "").replace(/-/g, " "),
          type: filterType,
          tags: [],
        }
        const isSelected = selectedFile === normalizedPath
        const isArmed = armedPath === normalizedPath
        const isDeleting = deletingPath === normalizedPath
        const isDragSource = dragSource === normalizedPath
        const chapterIndex = chapterIndexMap.get(normalizedPath)
        const isInsertTarget = isDragging && dragInsertIndex !== null && chapterIndex !== undefined && chapterIndex === dragInsertIndex && !isDragSource
        return [
          <PageRow
            key={normalizedPath}
            normalizedPath={normalizedPath}
            page={page}
            depth={depth}
            filterType={filterType}
            isSelected={isSelected}
            isArmed={isArmed}
            isDeleting={isDeleting}
            isDragSource={isDragSource}
            isInsertTarget={isInsertTarget}
            renamingPath={renamingPath}
            renameValue={renameValue}
            renamingBusy={renamingBusy}
            onPageClick={onPageClick}
            onPageContextMenu={onPageContextMenu}
            onItemPointerDown={onItemPointerDown}
            onDeleteClick={onDeleteClick}
            onRenameValueChange={onRenameValueChange}
            onSubmitRename={onSubmitRename}
            onCancelRename={onCancelRename}
          />,
        ]
      })}
    </>
  )
}
