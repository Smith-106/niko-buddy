// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BookOpen, ChevronDown, ChevronRight, Clock, Loader2, MinusCircle, Check, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { deleteFile, fileExists, listDirectory, readFile, writeFileAtomic, openFileLocation, copyFile } from "@/commands/fs"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { getNextChapterNumber, invalidateChapterCache } from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"
import { moveFileToTrash } from "@/lib/trash"
import { makeChapterFileName, makeDefaultChapterTitle, makeSafeFileSlug } from "@/lib/wiki-filename"
import {
  extractPageOrderFromTitle, extractChapterNumberFromContent, getDirName,
  getUniquePagePath, flattenMdFiles, flattenAllFiles, cleanupDeletedSourceMemory, parsePageInfo,
  findNodeByPath, coordinateChapterRelocation, coordinateChapterReorder, coordinateChapterDelete,
  getChapterWriteCoordinator, isChapterPath, updatePageTitleContent,
  type WikiPageInfo, type KnowledgeTreeProps, type CreateMenuState,
} from "./knowledge-tree-helpers"
import { KnowledgeTreeNodes } from "./knowledge-tree-nodes"
import { BatchDuplicateConflictCard, CreateContextMenu, PageContextMenu } from "./knowledge-tree-menus"
import { useImportProgressStore } from "@/stores/import-progress-store"
import { toast } from "@/lib/toast"
import { discardBatchExtractionDrafts, getBatchExtractQueue, resetCorruptBatchExtractionDrafts, restoreBatchExtractQueue, setAsideUncertainBatchDrafts } from "./sidebar-panel-import"
import type { BatchExtractQueueState } from "@/lib/novel/snapshot-scanner"


export interface KnowledgeCreateRequest {
  kind: "chapter" | "outline" | "volume" | "folder"
  parentDir?: string
}



export function KnowledgeTree({
  filterType,
  refreshKey,
  pendingPages = [],
  onRemovePendingPage,
  onRequestCreate,
  batchExtractTrigger,
}: KnowledgeTreeProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [armedPath, setArmedPath] = useState<string | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null)
  const [pageMenu, setPageMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [moveMenuTarget, setMoveMenuTarget] = useState<string | null>(null)
  // G3（TASK-004 D3）：知识树右键或工具栏「批量提取记忆」→ 先弹范围选择（D2）再进队列。
  const [batchScope, setBatchScope] = useState<{ chapter: number | null } | null>(null)
  const lastBatchTriggerKeyRef = useRef<number | null>(null)
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const [dragSource, setDragSource] = useState<string | null>(null)
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragSourceRef = useRef<string | null>(null)
  const dragInsertIndexRef = useRef<number | null>(null)
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const pendingPointerPositionRef = useRef<{ x: number; y: number } | null>(null)
  const lastPointerTypeRef = useRef<string>("mouse")
  const removeGlobalPointerListenersRef = useRef<(() => void) | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!batchExtractTrigger) return
    if (lastBatchTriggerKeyRef.current === batchExtractTrigger.key) return
    lastBatchTriggerKeyRef.current = batchExtractTrigger.key
    setBatchScope({ chapter: batchExtractTrigger.seedChapter })
  }, [batchExtractTrigger])

  useEffect(() => { dragSourceRef.current = dragSource }, [dragSource])
  useEffect(() => { dragInsertIndexRef.current = dragInsertIndex }, [dragInsertIndex])

  const loadPages = useCallback(async () => {
    if (!project) return
    const projectPath = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${projectPath}/wiki`)
      // PAT-IM: 独立项并行 —— 并发 readFile（Promise.all 保序回填），再按过滤后原序串行解析/push。
      const pageFiles = flattenMdFiles(wikiTree).filter(
        (file) => file.name !== "index.md" && file.name !== "log.md",
      )
      const pageContents = await Promise.all(
        pageFiles.map((file) => readFile(file.path).then(
          (content) => ({ ok: true as const, content }),
          () => ({ ok: false as const, content: "" }),
        )),
      )
      const nextPages: WikiPageInfo[] = []
      for (let pageIndex = 0; pageIndex < pageFiles.length; pageIndex += 1) {
        const file = pageFiles[pageIndex]
        const read = pageContents[pageIndex]
        if (!read.ok) continue
        try {
          const info = parsePageInfo(file.path, file.name, read.content)
          if (info) nextPages.push(info)
        } catch {
          // Ignore unreadable pages in the navigator.
        }
      }
      setPages(nextPages)
    } catch (error) {
      console.error("[KnowledgeTree] loadPages failed:", error)
      setPages([])
    }
  }, [project])

  useEffect(() => {
    void loadPages()
  }, [loadPages, fileTree, dataVersion, refreshKey])

  useEffect(() => {
    if (!armedPath) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (containerRef.current?.contains(target)) return
      setArmedPath(null)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArmedPath(null)
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [armedPath])

  const closeMenus = useCallback((restoreFocus = false) => {
    setCreateMenu(null)
    setPageMenu(null)
    setMoveMenuTarget(null)
    if (restoreFocus) {
      menuTriggerRef.current?.focus()
      menuTriggerRef.current = null
    }
  }, [])

  useEffect(() => {
    const handleMouseDown = () => {
      closeMenus(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus(true)
    }
    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [closeMenus])

  const pageInfoByPath = useMemo(() => {
    const map = new Map<string, WikiPageInfo>()
    for (const page of pages) {
      if (page.type === filterType) map.set(page.path, page)
    }
    for (const page of pendingPages) {
      if (page.type === filterType) map.set(normalizePath(page.path), page)
    }
    return map
  }, [filterType, pages, pendingPages])

  const effectivePages = useMemo(() => [...pageInfoByPath.values()], [pageInfoByPath])

  const sortedChapterPages = useMemo(() => {
    return effectivePages
      .filter((page): page is WikiPageInfo & { type: "chapter" } => page.type === "chapter")
      .sort((left, right) => {
        const leftOrder = left.chapterNumber ?? extractPageOrderFromTitle(left.title)
        const rightOrder = right.chapterNumber ?? extractPageOrderFromTitle(right.title)
        if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder
        if (leftOrder !== null && rightOrder === null) return -1
        if (leftOrder === null && rightOrder !== null) return 1
        return left.title.localeCompare(right.title, "zh-CN")
      })
  }, [effectivePages])

  const sectionRootPath = useMemo(() => {
    if (!project) return null
    return `${normalizePath(project.path)}/wiki/${filterType === "chapter" ? "chapters" : "outlines"}`
  }, [filterType, project])

  const sectionNodes = useMemo(() => {
    if (!sectionRootPath) return []
    const sectionNode = findNodeByPath(fileTree, sectionRootPath)
    return sectionNode?.children ?? []
  }, [fileTree, sectionRootPath])

  const volumeFolders = useMemo(() => {
    return sectionNodes.filter((node) => node.is_dir).map((node) => ({
      name: node.name,
      path: normalizePath(node.path),
    }))
  }, [sectionNodes])

  const handleMoveToVolume = useCallback(async (sourcePath: string, targetVolumePath: string) => {
    /* v8 ignore next */
    if (!project) return
    const normalizedSource = normalizePath(sourcePath)
    const fileName = normalizedSource.split("/").pop()
    /* v8 ignore next */
    if (!fileName) return

    const destPath = normalizePath(`${normalizePath(targetVolumePath)}/${fileName}`)
    /* v8 ignore next */
    if (normalizedSource === destPath) return

    const moveIntent = isChapterPath(normalizedSource)
      ? getChapterWriteCoordinator().captureIntent("tree-move", normalizedSource)
      : undefined

    if (await fileExists(destPath)) {
      toast.error(t("knowledgeTree.moveTargetExists"))
      return
    }

    try {
      if (isChapterPath(normalizedSource)) {
        const outcome = await coordinateChapterRelocation({
          kind: "tree-move",
          fromPath: normalizedSource,
          toPath: destPath,
          intent: moveIntent,
          run: async ({ markRelocated }) => {
            await copyFile(normalizedSource, destPath)
            await deleteFile(normalizedSource)
            markRelocated()
            const currentSelected = useWikiStore.getState().selectedFile
            if (currentSelected !== null && normalizePath(currentSelected) === normalizedSource) {
              setSelectedFile(destPath)
            }
          },
        })
        if (outcome.status !== "committed") {
          toast.error(
            outcome.status === "relocated"
              ? "该章节已发生重命名或移动，请刷新后重试"
              : "该章节正在被保存或采纳，请稍后重试",
          )
          return
        }
      } else {
        await copyFile(normalizedSource, destPath)
        await deleteFile(normalizedSource)
        const currentSelected = useWikiStore.getState().selectedFile
        if (currentSelected !== null && normalizePath(currentSelected) === normalizedSource) {
          setSelectedFile(destPath)
        }
      }

      await loadPages()
      const tree = await listDirectory(normalizePath(project.path))
      setFileTree(tree)
      bumpDataVersion()
    } catch (error) {
      console.error("[KnowledgeTree] move to volume failed:", error)
    } finally {
      setMoveMenuTarget(null)
      setPageMenu(null)
    }
  }, [project, t, loadPages, setFileTree, bumpDataVersion, setSelectedFile])

  const handleDeleteClick = useCallback(async (pagePath: string) => {
    /* v8 ignore next */
    if (!project) return
    if (armedPath !== pagePath) {
      setArmedPath(pagePath)
      return
    }

    setArmedPath(null)
    setDeletingPath(pagePath)
    try {
      const projectPath = normalizePath(project.path)
      const normalizedPagePath = normalizePath(pagePath)
      const deleteTargetFile = async (markDeleted?: () => void) => {
        let contentBeforeDelete: string | undefined
        if (filterType === "chapter") {
          try {
            contentBeforeDelete = await readFile(pagePath)
          } catch (readError) {
            console.warn("[KnowledgeTree] read before delete failed:", pagePath, toErrorMessage(readError))
          }
        }
        await moveFileToTrash(projectPath, pagePath, filterType)
        markDeleted?.()
        const storeState = useWikiStore.getState()
        storeState.clearFinalChapterSaveForPath?.(pagePath)
        const currentSelected = "selectedFile" in storeState ? storeState.selectedFile : selectedFile
        if (currentSelected !== null && normalizePath(currentSelected) === normalizedPagePath) {
          setSelectedFile(null)
        }
        return contentBeforeDelete
      }

      let sourceContent: string | undefined
      if (isChapterPath(normalizedPagePath)) {
        const outcome = await coordinateChapterDelete({
          path: normalizedPagePath,
          run: async ({ markDeleted }) => deleteTargetFile(markDeleted),
        })
        if (outcome.status !== "committed") {
          toast.error(
            outcome.status === "relocated"
              ? "该章节已发生重命名或移动，请刷新后重试"
              : "该章节正在被保存或采纳，请稍后重试",
          )
          return
        }
        sourceContent = outcome.value
      } else {
        sourceContent = await deleteTargetFile()
      }

      try {
        await cleanupDeletedSourceMemory(projectPath, {
          kind: filterType,
          pagePath,
          content: sourceContent,
        })
      } catch (e) {
        // 记忆清理失败不影响文件删除本身
        console.warn("[KnowledgeTree] 清理关联记忆失败:", e)
      }
      await loadPages()
      onRemovePendingPage?.(pagePath)
      const tree = await listDirectory(projectPath)
      setFileTree(tree)
      bumpDataVersion()
    } catch (error) {
      console.error("[KnowledgeTree] delete failed:", error)
    } finally {
      setDeletingPath(null)
    }
  }, [project, armedPath, filterType, loadPages, onRemovePendingPage, setFileTree, bumpDataVersion, selectedFile, setSelectedFile])

  const handleDeleteFolder = useCallback(async (folderPath: string) => {
    /* v8 ignore next */
    if (!project) return

    const normalizedFolderPath = normalizePath(folderPath)
    const folderNode = findNodeByPath(sectionNodes, normalizedFolderPath)
    if (!folderNode?.is_dir) return

    const mdFiles = flattenMdFiles([folderNode]).map((file) => normalizePath(file.path))
    const folderName = folderNode.name
    const fileKind = filterType === "chapter" ? "chapter" : "outline"
    const confirmed = window.confirm(
      mdFiles.length > 0
        ? t("knowledgeTree.deleteFolderConfirm", { name: folderName, count: mdFiles.length })
        : t("knowledgeTree.deleteEmptyFolderConfirm", { name: folderName }),
    )
    if (!confirmed) return

    setArmedPath(null)
    setDeletingPath(normalizedFolderPath)
    try {
      const projectPath = normalizePath(project.path)
      let blockedCount = 0
      const deletedPaths = new Set<string>()
      for (const filePath of mdFiles) {
        try {
          if (isChapterPath(filePath)) {
            const outcome = await coordinateChapterDelete({
              path: filePath,
              run: async ({ markDeleted }) => {
                await moveFileToTrash(projectPath, filePath, fileKind)
                markDeleted()
                useWikiStore.getState().clearFinalChapterSaveForPath?.(filePath)
              },
            })
            if (outcome.status !== "committed") {
              blockedCount += 1
              continue
            }
          } else {
            await moveFileToTrash(projectPath, filePath, fileKind)
          }
          deletedPaths.add(filePath)
          await cleanupDeletedSourceMemory(projectPath, {
            kind: fileKind,
            pagePath: filePath,
          })
        } catch (e) {
          // 单个文件删除失败不影响整体流程（如文件已不存在的幽灵条目）
          console.warn("[KnowledgeTree] 删除文件失败，继续处理下一个:", filePath, e)
        }
        onRemovePendingPage?.(filePath)
      }

      if (blockedCount > 0) {
        toast.error("部分章节正在被保存或采纳，未能删除整个目录，请稍后重试")
      } else {
        // 尝试删除文件夹：如果目录不存在或已空，直接删除；
        // 这样能清理掉那些文件已丢失、只剩空壳目录的幽灵条目
        try {
          const remainingNodes = await listDirectory(normalizedFolderPath).catch(() => [])
          if (flattenAllFiles(remainingNodes).length === 0) {
            await deleteFile(normalizedFolderPath)
          } else {
            toast.error(t("knowledgeTree.deleteFolderBlocked", { name: folderName }))
          }
        } catch (dirError) {
          // 目录可能已经不存在了，记诊断后视为删除成功
          console.warn("[KnowledgeTree] delete folder cleanup warning:", normalizedFolderPath, toErrorMessage(dirError))
        }
      }

      await loadPages()
      const tree = await listDirectory(projectPath)
      setFileTree(tree)
      bumpDataVersion()
      const storeState = useWikiStore.getState()
      const currentSelected = "selectedFile" in storeState ? storeState.selectedFile : selectedFile
      if (currentSelected) {
        const normalizedSelected = normalizePath(currentSelected)
        if (normalizedSelected.startsWith(`${normalizedFolderPath}/`) && (blockedCount === 0 || deletedPaths.has(normalizedSelected))) {
          setSelectedFile(null)
        }
      }
    } catch (error) {
      console.error("[KnowledgeTree] folder delete failed:", error)
    } finally {
      setDeletingPath(null)
    }
  }, [project, filterType, sectionNodes, t, loadPages, setFileTree, bumpDataVersion, selectedFile, setSelectedFile, onRemovePendingPage])

  const updateChapterNumberContent = useCallback((content: string, newChapterNumber: number) => {
    /* v8 ignore next */
    if (!Number.isFinite(newChapterNumber) || newChapterNumber <= 0) return content

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!frontmatterMatch) {
      return `---\nchapter_number: ${newChapterNumber}\n---\n${content}`
    }

    let frontmatterBody = frontmatterMatch[1]
    if (/^chapter_number:\s*.*$/m.test(frontmatterBody)) {
      frontmatterBody = frontmatterBody.replace(/^chapter_number:\s*.*$/m, `chapter_number: ${newChapterNumber}`)
    } else {
      frontmatterBody = `${frontmatterBody}\nchapter_number: ${newChapterNumber}`
    }

    return content.replace(/^---[\s\S]*?---/, `---
${frontmatterBody}
---`)
  }, [])

  const startRenamePage = useCallback((page: WikiPageInfo) => {
    setPageMenu(null)
    setMoveMenuTarget(null)
    setIsDragging(false)
    setDragSource(null)
    setDragInsertIndex(null)
    dragSourceRef.current = null
    dragInsertIndexRef.current = null
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current)
      dragTimerRef.current = null
    }
    removeGlobalPointerListenersRef.current?.()
    removeGlobalPointerListenersRef.current = null
    activePointerIdRef.current = null
    pendingPointerPositionRef.current = null
    setRenamingPath(page.path)
    setRenameValue(page.title)
    setRenameError(null)
  }, [])

  const handleRenameValueChange = useCallback((value: string) => {
    setRenameValue(value)
    setRenameError(null)
  }, [])

  const submitRenamePage = useCallback(async () => {
    if (!renamingPath || renamingBusy) return
    const newTitle = renameValue.trim()
    if (!newTitle) {
      setRenamingPath(null)
      setRenameValue("")
      setRenameError(null)
      return
    }

    const current = effectivePages.find((page) => page.path === renamingPath)
    if (!current || current.title === newTitle) {
      setRenamingPath(null)
      setRenameValue("")
      setRenameError(null)
      return
    }

    let keepOpenOnError = false
    setRenameError(null)
    setRenamingBusy(true)
    try {
      const duplicate = effectivePages.find(
        (page) => page.path !== renamingPath && page.type === current.type && page.title.trim() === newTitle,
      )
      if (duplicate) {
        const msg = current.type === "chapter"
          ? t("knowledgeTree.renameDuplicateChapterTitle", {
              title: newTitle,
              defaultValue: `已存在同名章节「${newTitle}」`,
            })
          : t("knowledgeTree.renameDuplicateOutlineTitle", {
              title: newTitle,
              defaultValue: `已存在同名大纲「${newTitle}」`,
            })
        keepOpenOnError = true
        setRenameError(msg)
        toast.error(msg)
        return
      }

      const normalizedRenamingPath = normalizePath(renamingPath)
      const renameIntent = current.type === "chapter"
        ? getChapterWriteCoordinator().captureIntent("tree-rename", normalizedRenamingPath)
        : undefined

      const content = await readFile(renamingPath)
      const oldChapterNumber = extractChapterNumberFromContent(content) ?? extractPageOrderFromTitle(current.title)
      const userChapterNumber = extractPageOrderFromTitle(newTitle)
      const chapterNumber = (current.type === "chapter" && userChapterNumber !== null) ? userChapterNumber : oldChapterNumber
      const conflictPage = current.type === "chapter" && typeof chapterNumber === "number"
        ? effectivePages.find((page) => (
            page.path !== renamingPath
            && page.type === "chapter"
            && page.chapterNumber === chapterNumber
          ))
        : undefined
      if (conflictPage && typeof chapterNumber === "number") {
        const msg = t("knowledgeTree.renameChapterNumberConflict", {
          chapter: chapterNumber,
          title: conflictPage.title,
          defaultValue: `第 ${chapterNumber} 章已被「${conflictPage.title}」占用`,
        })
        keepOpenOnError = true
        setRenameError(msg)
        toast.error(msg)
        return
      }
      const normalizedTitle = current.type === "chapter" && chapterNumber
        ? makeDefaultChapterTitle(chapterNumber, newTitle)
        : newTitle
      const nextContent = updatePageTitleContent(content, normalizedTitle, current.type === "chapter" ? chapterNumber : null)
      const targetFileName = current.type === "chapter"
        ? makeChapterFileName(normalizedTitle, chapterNumber)
        : `${makeSafeFileSlug(newTitle)}.md`
      const targetPath = normalizePath(await getUniquePagePath(getDirName(renamingPath), targetFileName, normalizedRenamingPath))

      if (current.type === "chapter") {
        const outcome = await coordinateChapterRelocation({
          kind: "tree-rename",
          fromPath: normalizedRenamingPath,
          toPath: targetPath,
          intent: renameIntent,
          run: async ({ markRelocated }) => {
            // 在前驱写盘全部落定后重读最新磁盘正文，避免覆盖编辑区刚落盘的正文或终稿状态
            const latestContent = await readFile(renamingPath)
            const latestNextContent = updatePageTitleContent(latestContent, normalizedTitle, chapterNumber)
            await writeFileAtomic(targetPath, latestNextContent)
            if (targetPath !== normalizedRenamingPath) {
              await deleteFile(renamingPath)
              markRelocated()
              const currentSelected = useWikiStore.getState().selectedFile
              if (currentSelected !== null && normalizePath(currentSelected) === normalizedRenamingPath) {
                setSelectedFile(targetPath)
              }
              onRemovePendingPage?.(renamingPath)
            }
          },
        })
        if (outcome.status !== "committed") {
          toast.error(
            outcome.status === "relocated"
              ? "该章节已发生重命名或移动，请刷新后重试"
              : "该章节正在被保存或采纳，请稍后重试",
          )
          return
        }
      } else {
        await writeFileAtomic(targetPath, nextContent)
        if (targetPath !== normalizedRenamingPath) {
          await deleteFile(renamingPath)
          const currentSelected = useWikiStore.getState().selectedFile
          if (currentSelected !== null && normalizePath(currentSelected) === normalizedRenamingPath) {
            setSelectedFile(targetPath)
          }
          onRemovePendingPage?.(renamingPath)
        }
      }

      await loadPages()
      /* v8 ignore next */
      if (project) {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      }
      bumpDataVersion()
    } catch (error) {
      console.error("[KnowledgeTree] rename failed:", error)
      const msg = t("knowledgeTree.renameFailed", {
        message: toErrorMessage(error),
        defaultValue: `重命名失败：${toErrorMessage(error)}`,
      })
      keepOpenOnError = true
      setRenameError(msg)
      toast.error(msg)
    } finally {
      setRenamingBusy(false)
      if (!keepOpenOnError) {
        setRenamingPath(null)
        setRenameValue("")
        setRenameError(null)
      }
    }
  }, [renamingPath, renamingBusy, renameValue, effectivePages, t, setSelectedFile, onRemovePendingPage, loadPages, project, setFileTree, bumpDataVersion])

  const cancelRenamePage = useCallback(() => {
    if (renamingBusy) return
    setRenamingPath(null)
    setRenameValue("")
    setRenameError(null)
  }, [renamingBusy])

  const executeChapterReorder = useCallback(async (sourcePath: string, targetIndex: number) => {
    /* v8 ignore next */
    if (!project) return

    const sourceIndex = sortedChapterPages.findIndex((page) => page.path === sourcePath)
    if (sourceIndex < 0) return

    const effectiveTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    if (sourceIndex === effectiveTarget) return

    const reordered = [...sortedChapterPages]
    const [moved] = reordered.splice(sourceIndex, 1)
    reordered.splice(effectiveTarget, 0, moved)

    try {
      const affectedItems: { path: string; nextNumber: number }[] = []
      for (let i = 0; i < reordered.length; i += 1) {
        const page = reordered[i]
        const nextNumber = i + 1
        const currentNumber = page.chapterNumber ?? extractPageOrderFromTitle(page.title)
        if (currentNumber === nextNumber) continue
        affectedItems.push({ path: page.path, nextNumber })
      }

      /* v8 ignore next */
      if (affectedItems.length === 0) return

      const outcome = await coordinateChapterReorder({
        paths: affectedItems.map((item) => item.path),
        run: async () => {
          // 在协调器临界区内重读最新磁盘正文，避免覆盖编辑区刚刚落盘的修改
          const writes: { path: string; content: string; nextNumber: number }[] = []
          for (const item of affectedItems) {
            const content = await readFile(item.path)
            writes.push({ path: item.path, content, nextNumber: item.nextNumber })
          }

          const appliedWrites: { path: string; content: string }[] = []
          try {
            for (const item of writes) {
              await writeFileAtomic(item.path, updateChapterNumberContent(item.content, item.nextNumber))
              appliedWrites.push({ path: item.path, content: item.content })
            }
          } catch (error) {
            for (const item of appliedWrites.reverse()) {
              try {
                await writeFileAtomic(item.path, item.content)
              } catch (rollbackError) {
                console.warn("[KnowledgeTree] chapter reorder rollback failed:", item.path, toErrorMessage(rollbackError))
              }
            }
            throw error
          }
        },
      })
      if (outcome.status !== "committed") {
        toast.error(
          outcome.status === "relocated"
            ? "部分章节已发生重命名或移动，请刷新后重试"
            : "部分章节正在被保存或采纳，请稍后重试",
        )
        return
      }

      await loadPages()
      const tree = await listDirectory(normalizePath(project.path))
      setFileTree(tree)
      bumpDataVersion()
    } catch (error) {
      console.error("[KnowledgeTree] chapter reorder failed:", error)
    }
  }, [project, sortedChapterPages, updateChapterNumberContent, loadPages, setFileTree, bumpDataVersion])

  const finishDragInteraction = useCallback(() => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current)
      dragTimerRef.current = null
    }

    const sourcePath = dragSourceRef.current
    const targetIndex = dragInsertIndexRef.current

    removeGlobalPointerListenersRef.current?.()
    removeGlobalPointerListenersRef.current = null
    activePointerIdRef.current = null
    pendingPointerPositionRef.current = null
    dragSourceRef.current = null
    dragInsertIndexRef.current = null
    setIsDragging(false)
    setDragSource(null)
    setDragInsertIndex(null)

    if (sourcePath && targetIndex !== null) {
      void executeChapterReorder(sourcePath, targetIndex)
    }
  }, [executeChapterReorder])

  const updateDragInsertFromPoint = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY)
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-page-path]") : null
    if (!row) return

    const pagePath = row.dataset.pagePath
    if (!pagePath) return

    const rowIndex = sortedChapterPages.findIndex((page) => page.path === pagePath)
    if (rowIndex < 0) return

    const rect = row.getBoundingClientRect()
    const isBottomHalf = (clientY - rect.top) >= rect.height / 2
    const insertIndex = isBottomHalf ? rowIndex + 1 : rowIndex

    dragInsertIndexRef.current = insertIndex
    setDragInsertIndex(insertIndex)
  }, [sortedChapterPages])

  const handleContainerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return

    pendingPointerPositionRef.current = { x: event.clientX, y: event.clientY }
    if (!dragSourceRef.current) return

    updateDragInsertFromPoint(event.clientX, event.clientY)
  }, [updateDragInsertFromPoint])

  const handleItemPointerDown = useCallback((event: React.PointerEvent, pagePath: string) => {
    if (filterType !== "chapter" || renamingPath) return

    lastPointerTypeRef.current = event.pointerType || "mouse"
    if (event.pointerType !== "mouse") {
      event.preventDefault()
      return
    }

    if (event.button !== 0 || selectedFile !== pagePath || isDragging) return

    event.preventDefault()
    dragTimerRef.current && clearTimeout(dragTimerRef.current)
    activePointerIdRef.current = event.pointerId
    pendingPointerPositionRef.current = { x: event.clientX, y: event.clientY }

    removeGlobalPointerListenersRef.current?.()
    const handlePointerFinish = (pointerEvent: PointerEvent) => {
      if (activePointerIdRef.current !== pointerEvent.pointerId) return
      pendingPointerPositionRef.current = { x: pointerEvent.clientX, y: pointerEvent.clientY }
      finishDragInteraction()
    }
    const handleGlobalPointerMove = (pointerEvent: PointerEvent) => {
      if (activePointerIdRef.current !== pointerEvent.pointerId) return
      pendingPointerPositionRef.current = { x: pointerEvent.clientX, y: pointerEvent.clientY }
      if (!dragSourceRef.current) return
      updateDragInsertFromPoint(pointerEvent.clientX, pointerEvent.clientY)
      pointerEvent.preventDefault()
    }
    window.addEventListener("pointerup", handlePointerFinish)
    window.addEventListener("pointercancel", handlePointerFinish)
    window.addEventListener("pointermove", handleGlobalPointerMove)
    removeGlobalPointerListenersRef.current = () => {
      window.removeEventListener("pointerup", handlePointerFinish)
      window.removeEventListener("pointercancel", handlePointerFinish)
      window.removeEventListener("pointermove", handleGlobalPointerMove)
    }

    dragTimerRef.current = setTimeout(() => {
      dragTimerRef.current = null
      dragSourceRef.current = pagePath
      setDragSource(pagePath)
      setIsDragging(true)

      const pointerPosition = pendingPointerPositionRef.current
      /* v8 ignore next */
      if (pointerPosition) {
        updateDragInsertFromPoint(pointerPosition.x, pointerPosition.y)
      }
    }, 300)
  }, [filterType, renamingPath, selectedFile, isDragging, finishDragInteraction, updateDragInsertFromPoint])

  const handlePageClick = useCallback((pagePath: string) => {
    setArmedPath(null)
    /* v8 ignore next */
    if (renamingPath === pagePath) return
    setSelectedFile(pagePath)
  }, [renamingPath, setSelectedFile])

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((previous) => ({ ...previous, [folderPath]: !previous[folderPath] }))
  }, [])

  const openCreateMenu = useCallback((event: React.MouseEvent, parentDir?: string, targetFolderName?: string) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target instanceof HTMLElement ? event.target : null
    menuTriggerRef.current = target?.closest<HTMLElement>("button, [tabindex]") ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
    const rect = containerRef.current?.getBoundingClientRect()
    setCreateMenu({
      parentDir,
      targetFolderName,
      targetFolderPath: parentDir,
      x: rect ? event.clientX - rect.left : event.clientX, /* v8 ignore start */ /* v8 ignore stop */
      y: rect ? event.clientY - rect.top : event.clientY, /* v8 ignore start */ /* v8 ignore stop */
    })
    setPageMenu(null)
    setMoveMenuTarget(null)
  }, [])

  const openPageMenu = useCallback((event: React.MouseEvent, pagePath: string) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target instanceof HTMLElement ? event.target : null
    menuTriggerRef.current = target?.closest<HTMLElement>("button, [tabindex]") ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
    const rect = containerRef.current?.getBoundingClientRect()
    setPageMenu({
      path: pagePath,
      x: rect ? event.clientX - rect.left : event.clientX, /* v8 ignore start */ /* v8 ignore stop */
      y: rect ? event.clientY - rect.top : event.clientY, /* v8 ignore start */ /* v8 ignore stop */
    })
    setCreateMenu(null)
    setMoveMenuTarget(null)
  }, [])

  const handlePageContextMenu = useCallback((event: React.MouseEvent, pagePath: string) => {
    if (filterType === "chapter" && lastPointerTypeRef.current !== "mouse") {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    openPageMenu(event, pagePath)
  }, [filterType, openPageMenu])

  const handleBlankContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    /* v8 ignore next */
    if (!(target instanceof HTMLElement)) return
    /* v8 ignore next */
    if (target.closest("[data-knowledge-interactive='true']")) return
    openCreateMenu(event)
  }, [openCreateMenu])

  useEffect(() => {
    const container = containerRef.current
    if (!container || filterType !== "chapter") return

    const handleSelectStart = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.closest("[data-page-path]")) return
      event.preventDefault()
    }

    container.addEventListener("selectstart", handleSelectStart)
    return () => {
      container.removeEventListener("selectstart", handleSelectStart)
    }
  }, [filterType])

  useEffect(() => {
    return () => {
      if (dragTimerRef.current) {
        clearTimeout(dragTimerRef.current)
        dragTimerRef.current = null
      }
      removeGlobalPointerListenersRef.current?.()
      removeGlobalPointerListenersRef.current = null
      activePointerIdRef.current = null
      pendingPointerPositionRef.current = null
    }
  }, [])

  const rootLabel = filterType === "chapter" ? t("sidebar.knowledge") : t("sidebar.files")
  const emptyLabel = filterType === "chapter"
    ? t("knowledgeTree.emptyFiltered", { label: t("trash.kindChapter") })
    : t("knowledgeTree.emptyFiltered", { label: t("trash.kindOutline") })

  // M11-1: 节点渲染已剥离至 ./knowledge-tree-nodes (KnowledgeTreeNodes 纯组件)

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("knowledgeTree.noProject")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div
        ref={containerRef}
        className="relative flex min-h-full flex-col p-2 select-none"
        style={{
          userSelect: filterType === "chapter" ? "none" : undefined,
          WebkitUserSelect: filterType === "chapter" ? "none" : undefined,
          WebkitTouchCallout: filterType === "chapter" ? "none" : undefined,
        }}
        onClick={() => {
          setCreateMenu(null)
          setPageMenu(null)
        }}
        onContextMenu={handleBlankContextMenu}
        onPointerMove={handleContainerPointerMove}
      >
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">{rootLabel}</div>
        {sectionNodes.length === 0 && pendingPages.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</div>
        ) : (
          <KnowledgeTreeNodes
            nodes={sectionNodes}
            filterType={filterType}
            pageInfoByPath={pageInfoByPath}
            sortedChapterPages={sortedChapterPages}
            collapsedFolders={collapsedFolders}
            selectedFile={selectedFile}
            armedPath={armedPath}
            deletingPath={deletingPath}
            renamingPath={renamingPath}
            renameValue={renameValue}
            renameError={renameError}
            renamingBusy={renamingBusy}
            dragSource={dragSource}
            dragInsertIndex={dragInsertIndex}
            isDragging={isDragging}
            onToggleFolder={toggleFolder}
            onOpenCreateMenu={openCreateMenu}
            onPageClick={handlePageClick}
            onPageContextMenu={handlePageContextMenu}
            onItemPointerDown={handleItemPointerDown}
            onDeleteClick={(pagePath) => void handleDeleteClick(pagePath)}
            onRenameValueChange={handleRenameValueChange}
            onSubmitRename={() => void submitRenamePage()}
            onCancelRename={cancelRenamePage}
          />
        )}

        {createMenu && (
          <CreateContextMenu
            menu={createMenu}
            filterType={filterType}
            onRequestCreate={onRequestCreate}
            onDeleteFolder={(targetFolderPath) => void handleDeleteFolder(targetFolderPath)}
            onOpenBatchExtract={() => setBatchScope({ chapter: null })}
            onClose={closeMenus}
          />
        )}

        {pageMenu && (
          <PageContextMenu
            menu={pageMenu}
            filterType={filterType}
            targetPage={pageInfoByPath.get(pageMenu.path)}
            volumeFolders={volumeFolders}
            moveMenuOpen={moveMenuTarget === pageMenu.path}
            onToggleMoveMenu={() => setMoveMenuTarget(moveMenuTarget === pageMenu.path ? null : pageMenu.path)}
            onRequestCreate={onRequestCreate}
            onStartRename={startRenamePage}
            onOpenBatchExtract={(chapter) => setBatchScope({ chapter })}
            onMoveToVolume={(pagePath, volumePath) => void handleMoveToVolume(pagePath, volumePath)}
            onOpenFileLocation={(pagePath) => {
              openFileLocation(pagePath).catch((err) => console.error("打开文件位置失败:", err))
            }}
            onClose={closeMenus}
          />
        )}

        {/* G3（TASK-004 D2/D3）：右键 → 先弹范围选择，确认后才进批量队列。 */}
        {batchScope && project && (
          <BatchExtractScopeDialog
            key={normalizePath(project.path)}
            open
            projectPath={normalizePath(project.path)}
            seedChapter={batchScope.chapter}
            onClose={() => setBatchScope(null)}
          />
        )}
      </div>
    </ScrollArea>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// G3（TASK-004 D2/D4/D5）：批量提取范围选择弹层
// ──────────────────────────────────────────────────────────────────────────

type SnapshotScannerModule = typeof import("@/lib/novel/snapshot-scanner")
type SnapshotScanResult = import("@/lib/novel/snapshot-scanner").SnapshotScanResult
type BatchExtractScopeMode = import("@/lib/novel/snapshot-scanner").BatchExtractScopeMode
type BatchExtractBudgetPlan = import("@/lib/novel/snapshot-scanner").BatchExtractBudgetPlan
type BatchBudgetLedger = import("@/lib/novel/snapshot-scanner").BatchBudgetLedger

export interface BatchExtractScopeDialogProps {
  open: boolean
  projectPath: string
  /** 右键命中的章号（仅作提示，不改变范围语义）。 */
  seedChapter?: number | null
  onClose: () => void
}

/**
 * 范围选择弹层（默认「仅未提取」）：全部 vs 仅未提取 + skipExisting/force 开关
 * + LLM 预算上限（默认值取自 snapshot-scanner 常量，与 G4 harness 同口径）。
 *
 * Draft-first：本弹层只建队列、显示 pending/ready 草稿与 accept 入口；
 * 正式记忆回填只能经 accept（acceptBatchExtractionDrafts → syncSnapshotToMemory）。
 */
function parseOptionalChapterBound(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.floor(parsed)
}

export function BatchExtractScopeDialog({
  open,
  projectPath,
  seedChapter,
  onClose,
}: BatchExtractScopeDialogProps) {
  const { t } = useTranslation()
  const scannerRef = useRef<SnapshotScannerModule | null>(null)
  const scanScope = useRef({ open, projectPath })
  const [scan, setScan] = useState<SnapshotScanResult | null>(null)
  const [mode, setMode] = useState<BatchExtractScopeMode | null>(null)
  const [skipExisting, setSkipExisting] = useState(true)
  const [force, setForce] = useState(false)
  const [startChapterInput, setStartChapterInput] = useState("")
  const [endChapterInput, setEndChapterInput] = useState("")
  const [budget, setBudget] = useState(0)
  const [budgetMax, setBudgetMax] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null)
  const [running, setRunning] = useState<"extract" | "accept" | "discard" | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<"discard" | "resetCorrupt" | "setAside" | null>(null)
  const [corruptFingerprint, setCorruptFingerprint] = useState<string | null>(null)
  const [scanGeneration, setScanGeneration] = useState(0)
  const [queue, setQueue] = useState<BatchExtractQueueState | null>(null)
  const [statusMessage, setStatusMessage] = useState("")
  const [scanError, setScanError] = useState<string | null>(null)

  useEffect(() => {
    scanScope.current = { open, projectPath }
    return () => { scanScope.current = { open: false, projectPath } }
  }, [open, projectPath])

  useEffect(() => {
    if (!open) return
    setStartChapterInput("")
    setEndChapterInput("")
  }, [open, projectPath])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRunning(null)
    setPendingConfirm(null)
    setQueue(null)
    setScanning(true)
    setStatusMessage("")
    setScanError(null)
    setScan(null)
    setCorruptFingerprint(null)
    void (async () => {
      let scanner: typeof import("@/lib/novel/snapshot-scanner") | undefined
      try {
        scanner = await import("@/lib/novel/snapshot-scanner")
        const restored = await restoreBatchExtractQueue(projectPath)
        if (cancelled) return
        setQueue(restored)
        scannerRef.current = scanner
        setMode(scanner.DEFAULT_BATCH_EXTRACT_SCOPE)
        setSkipExisting(scanner.DEFAULT_BATCH_SKIP_EXISTING)
        setForce(scanner.DEFAULT_BATCH_FORCE)
        setBudget(scanner.BATCH_EXTRACT_BUDGET_DEFAULT)
        setBudgetMax(scanner.BATCH_EXTRACT_BUDGET_MAX)
        const result = await scanner.scanFinalChapterBackfill(projectPath)
        /* v8 ignore next */
        if (cancelled) return
        setScan(result)
      } catch (err) {
        if (!cancelled) {
          setScanError(toErrorMessage(err))
          if (scanner && err instanceof scanner.CorruptBatchDraftArtifactError) setCorruptFingerprint(err.fingerprint)
        }
      } finally {
        /* v8 ignore next */
        if (!cancelled) setScanning(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, projectPath, scanGeneration])

  const batchTask = useImportProgressStore(s => s.tasks.find(task => task.kind === "batch_extraction" && task.projectPath === projectPath))
  useEffect(() => {
    if (open && batchTask) setQueue(getBatchExtractQueue(projectPath))
  }, [open, projectPath, batchTask])

  const startChapter = parseOptionalChapterBound(startChapterInput)
  const endChapter = parseOptionalChapterBound(endChapterInput)
  const rangeInvalid = startChapter !== null && endChapter !== null && startChapter > endChapter

  const preview = useMemo<{ plan: BatchExtractBudgetPlan; ledger: BatchBudgetLedger; chapters: number[] } | null>(() => {
    const scanner = scannerRef.current
    if (!scanner || !scan || mode === null) return null
    const selection = scanner.resolveBatchExtractScope(scan, {
      mode,
      skipExisting,
      force,
      startChapter,
      endChapter,
    })
    const plan = scanner.applyDesktopBatchExtractBudget(selection.chapters, budget)
    return { plan, ledger: scanner.buildBatchBudgetLedger(plan), chapters: selection.chapters }
  }, [scan, mode, skipExisting, force, startChapter, endChapter, budget])

  const drafts = queue?.drafts ?? []
  const readyCount = drafts.filter((draft) => draft.status === "ready").length
  const uncertainCount = drafts.filter((draft) => draft.status === "uncertain").length
  const outcomes = [
    ...(queue?.previousOutcomes ?? []),
    ...drafts.flatMap((draft) => (draft.outcome ? [draft.outcome] : [])),
  ]
  const busy = running !== null || relocatingPath !== null || batchTask?.status === "running"

  const handleLocateDuplicate = (filePath: string) => {
    useWikiStore.getState().setSelectedFile?.(normalizePath(filePath))
    onClose()
  }

  const handleRelocateDuplicate = async (filePath: string, currentChapter: number) => {
    if (busy || scanning) return
    const scopeAtStart = scanScope.current
    const normalizedFrom = normalizePath(filePath)
    setRelocatingPath(normalizedFrom)
    setStatusMessage("")
    try {
      const renameIntent = getChapterWriteCoordinator().captureIntent("tree-rename", normalizedFrom)
      let nextFromDisk = 1
      try {
        nextFromDisk = await getNextChapterNumber(projectPath)
      } catch (err) {
        console.warn("[BatchExtractScopeDialog] getNextChapterNumber fallback:", toErrorMessage(err))
      }
      const maxKnown = Math.max(
        0,
        currentChapter,
        ...(scan?.chapters ?? []),
        ...(scan?.excluded?.duplicateChapters ?? []),
      )
      const nextChapterNumber = Math.max(nextFromDisk, maxKnown + 1)
      const rawContent = await readFile(normalizedFrom)
      const parsed = parsePageInfo(normalizedFrom, getFileName(normalizedFrom), rawContent)
      const nextTitle = makeDefaultChapterTitle(nextChapterNumber, parsed?.title ?? "")
      const targetFileName = makeChapterFileName(nextTitle, nextChapterNumber)
      const targetPath = normalizePath(
        await getUniquePagePath(getDirName(normalizedFrom), targetFileName, normalizedFrom),
      )

      const outcome = await coordinateChapterRelocation({
        kind: "tree-rename",
        fromPath: normalizedFrom,
        toPath: targetPath,
        intent: renameIntent,
        run: async ({ markRelocated }) => {
          const latestContent = await readFile(normalizedFrom)
          const updatedContent = updatePageTitleContent(latestContent, nextTitle, nextChapterNumber)
          await writeFileAtomic(targetPath, updatedContent)
          if (targetPath !== normalizedFrom) {
            await deleteFile(normalizedFrom)
            markRelocated()
            const storeState = useWikiStore.getState()
            if (storeState.selectedFile && normalizePath(storeState.selectedFile) === normalizedFrom) {
              storeState.setSelectedFile?.(targetPath)
            }
          }
        },
      })

      if (scopeAtStart !== scanScope.current) return
      if (outcome.status !== "committed") {
        toast.error(
          outcome.status === "relocated"
            ? "该章节已发生重命名或移动，请刷新后重试"
            : "该章节正在被保存或采纳，请稍后重试",
        )
        return
      }

      invalidateChapterCache(projectPath)
      try {
        const tree = await listDirectory(normalizePath(projectPath))
        useWikiStore.getState().setFileTree?.(tree)
      } catch (treeErr) {
        console.warn("[BatchExtractScopeDialog] refresh tree warning:", toErrorMessage(treeErr))
      }
      useWikiStore.getState().bumpDataVersion?.()
      const msg = t("extract.batchDuplicateRelocated", {
        from: currentChapter,
        to: nextChapterNumber,
        defaultValue: `已将第 ${currentChapter} 章副本顺延为第 ${nextChapterNumber} 章，正在重新扫描…`,
      })
      setStatusMessage(msg)
      toast.success(msg)
      setScanGeneration((generation) => generation + 1)
    } catch (error) {
      if (scopeAtStart === scanScope.current) {
        const msg = t("extract.batchDuplicateRelocateFailed", {
          message: toErrorMessage(error),
          defaultValue: `顺延章号失败：${toErrorMessage(error)}`,
        })
        setStatusMessage(msg)
        toast.error(msg)
      }
    } finally {
      if (scopeAtStart === scanScope.current) setRelocatingPath(null)
    }
  }

  const handleStart = async () => {
    if (!preview || busy || readyCount > 0 || uncertainCount > 0 || preview.plan.admitted.length === 0) return
    setPendingConfirm(null)
    setStatusMessage("")
    setRunning("extract")
    const scopeAtStart = scanScope.current
    try {
      const { runBatchMemoryExtraction } = await import("./sidebar-panel-import")
      const result = await runBatchMemoryExtraction({
        projectPath,
        chapters: preview.chapters,
        budget,
        paths: scan?.paths,
      })
      if (scopeAtStart !== scanScope.current) return
      setQueue(getBatchExtractQueue(projectPath))
      const message = result.cancelled
        ? t("extract.batchCancelled", { completed: result.completed, total: result.admitted.length })
        : t("extract.batchDone", { completed: result.completed, failed: result.failed })
      setStatusMessage(message)
      if (result.cancelled || result.failed > 0) toast.info(message)
      else toast.success(message)
    } catch (err) {
      if (scopeAtStart !== scanScope.current) return
      const message = t("extract.batchFailed", { message: toErrorMessage(err) })
      setStatusMessage(message)
      toast.error(message)
      setQueue(getBatchExtractQueue(projectPath))
    } finally {
      if (scopeAtStart === scanScope.current) setRunning(null)
    }
  }

  const handleAccept = async () => {
    if (busy || scanning || !queue || readyCount === 0) return
    const scopeAtStart = scanScope.current
    setPendingConfirm(null)
    setStatusMessage("")
    setRunning("accept")
    try {
      const { acceptBatchExtractionDrafts } = await import("./sidebar-panel-import")
      const result = await acceptBatchExtractionDrafts({ projectPath, expectedQueue: queue })
      if (scopeAtStart !== scanScope.current) return
      setQueue(getBatchExtractQueue(projectPath))
      const message = result.failed.length
        ? t("extract.batchAcceptIncomplete", { accepted: result.accepted.length, failed: result.failed.length })
        : t("extract.batchAccepted", { count: result.accepted.length })
      setStatusMessage(message)
      if (result.accepted.length > 0 && result.failed.length === 0) toast.success(message)
      else toast.info(message)
    } catch (err) {
      if (scopeAtStart !== scanScope.current) return
      const message = t("extract.batchFailed", { message: toErrorMessage(err) })
      setStatusMessage(message)
      toast.error(message)
      setQueue(getBatchExtractQueue(projectPath))
    } finally {
      if (scopeAtStart === scanScope.current) {
        const scanner = scannerRef.current
        setScan(null)
        setScanError(null)
        if (scanner) {
          setScanning(true)
          try {
            const next = await scanner.scanFinalChapterBackfill(projectPath)
            if (scopeAtStart === scanScope.current) setScan(next)
          } catch (error) {
            if (scopeAtStart === scanScope.current) setScanError(toErrorMessage(error))
          }
        }
        if (scopeAtStart === scanScope.current) {
          setScanning(false)
          setRunning(null)
        }
      }
    }
  }

  const handleDiscard = async () => {
    if (busy || scanning || !queue || readyCount === 0) return
    setPendingConfirm(null)
    const scopeAtStart = scanScope.current
    setRunning("discard")
    try {
      const discarded = await discardBatchExtractionDrafts(projectPath, queue)
      if (scopeAtStart !== scanScope.current) return
      setQueue(getBatchExtractQueue(projectPath))
      setStatusMessage(t(discarded ? "extract.batchDiscarded" : "extract.batchQueueChanged"))
    } catch (err) {
      if (scopeAtStart === scanScope.current) setStatusMessage(t("extract.batchFailed", { message: toErrorMessage(err) }))
    } finally {
      if (scopeAtStart === scanScope.current) setRunning(null)
    }
  }

  const handleResetCorruptArtifact = async () => {
    if (busy || scanning || !corruptFingerprint) return
    setPendingConfirm(null)
    const scopeAtStart = scanScope.current
    setRunning("discard")
    try {
      const backup = await resetCorruptBatchExtractionDrafts(projectPath, corruptFingerprint)
      if (scopeAtStart !== scanScope.current) return
      toast.success(t("extract.batchResetCorruptDone", { path: backup }))
      setScanGeneration(generation => generation + 1)
    } catch (err) {
      if (scopeAtStart === scanScope.current) setScanError(toErrorMessage(err))
    } finally {
      if (scopeAtStart === scanScope.current) setRunning(null)
    }
  }

  const handleSetAside = async () => {
    if (busy || scanning || !queue || uncertainCount === 0) return
    setPendingConfirm(null)
    const scopeAtStart = scanScope.current
    setRunning("discard")
    try {
      const updated = await setAsideUncertainBatchDrafts(projectPath, queue)
      if (scopeAtStart !== scanScope.current) return
      setQueue(getBatchExtractQueue(projectPath))
      setStatusMessage(t(updated ? "extract.batchSetAsideDone" : "extract.batchQueueChanged"))
    } catch (err) {
      if (scopeAtStart === scanScope.current) setStatusMessage(t("extract.batchFailed", { message: toErrorMessage(err) }))
    } finally {
      if (scopeAtStart === scanScope.current) setRunning(null)
    }
  }

  const handleCopyReceipts = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(outcomes, null, 2))
      setStatusMessage(t("extract.batchReceiptsCopied"))
    } catch (err) {
      setStatusMessage(t("extract.batchFailed", { message: toErrorMessage(err) }))
    }
  }

  const outcomeKeyCounts = new Map<string, number>()
  const outcomeText = (outcome: (typeof outcomes)[number]): string => {
    if (outcome.status === "uncertain") return t("extract.batchReceiptUncertain", { chapter: outcome.chapterNumber, reason: outcome.reason })
    if (outcome.status === "verified") return t("extract.batchReceiptVerified", { chapter: outcome.chapterNumber })
    if ("receipt" in outcome && outcome.receipt) return t("extract.batchReceiptPartial", { chapter: outcome.chapterNumber })
    const base = t("extract.batchReceiptFailed", { chapter: outcome.chapterNumber })
    return "reason" in outcome && outcome.reason ? `${base}（${outcome.reason}）` : base
  }

  const activeConfirm =
    pendingConfirm === "discard" && readyCount > 0
      ? "discard"
      : pendingConfirm === "resetCorrupt" && Boolean(corruptFingerprint)
        ? "resetCorrupt"
        : pendingConfirm === "setAside" && uncertainCount > 0
          ? "setAside"
          : null
  const activeConfirmText =
    activeConfirm === "discard"
      ? t("extract.batchDiscardConfirm")
      : activeConfirm === "resetCorrupt"
        ? t("extract.batchResetCorruptConfirm")
        : activeConfirm === "setAside"
          ? t("extract.batchSetAsideConfirm")
          : ""

  const showBatchProgress = batchTask?.status === "running" || running === "extract"
  const progressTotal = batchTask?.total ?? preview?.plan.admitted.length ?? 0
  const progressCompleted = batchTask?.completed ?? 0
  const progressFailed = queue?.failed ?? 0
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100)) : 0
  const cancelling = Boolean(batchTask?.cancelling)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent
        data-testid="batch-extract-scope-dialog"
        className="max-h-[85vh] w-[calc(100%-2rem)] max-w-[26rem] overflow-y-auto p-4 text-sm sm:max-w-[26rem]"
        closeLabel={t("common.close")}
        showCloseButton={!busy}
      >
        <DialogTitle className="pr-7 text-sm">{t("extract.batchTitle")}</DialogTitle>
        <DialogDescription>{t("extract.batchDraftFirst")}</DialogDescription>

        {scanError ? (
          <p role="alert" className="text-xs text-destructive">{scanError}</p>
        ) : null}
        {corruptFingerprint ? (
          <Button type="button" size="sm" variant="outline" disabled={busy || scanning} onClick={() => setPendingConfirm("resetCorrupt")}>
            {t("extract.batchResetCorrupt")}
          </Button>
        ) : null}

        {scanning ? (
          <div className="flex items-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("extract.batchScanning")}
          </div>
        ) : preview ? (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {t("extract.batchPendingCount", { count: scan?.pending.length ?? 0 })}
              {scan?.excluded && (scan.excluded.invalid + scan.excluded.nonFinal + scan.excluded.unreadable + scan.excluded.duplicateChapters.length > 0)
                ? ` · ${t("extract.batchScanExcluded", {
                    invalid: scan.excluded.invalid,
                    nonFinal: scan.excluded.nonFinal,
                    unreadable: scan.excluded.unreadable,
                    duplicates: scan.excluded.duplicateChapters.length,
                  })}`
                : null}
              {typeof seedChapter === "number" && preview.chapters.includes(seedChapter) ? ` · ${t("extract.batchSeedHint", { chapter: seedChapter })}` : null}
            </div>

            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="batch-extract-scope"
                checked={mode === "missing"}
                onChange={() => setMode("missing")}
              />
              {t("extract.batchScopeMissing")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="batch-extract-scope"
                checked={mode === "all"}
                onChange={() => setMode("all")}
              />
              {t("extract.batchScopeAll")}
            </label>

            <label className={`flex items-center gap-2 ${mode === "missing" ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                checked={skipExisting}
                disabled={mode === "missing"}
                onChange={(event) => setSkipExisting(event.target.checked)}
              />
              {t("extract.batchSkipExisting")}
            </label>
            <label className={`flex items-center gap-2 ${mode === "missing" ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                checked={force}
                disabled={mode === "missing"}
                onChange={(event) => setForce(event.target.checked)}
              />
              {t("extract.batchForce")}
            </label>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-foreground">
                {t("extract.batchRangeLabel", { defaultValue: "章节范围（可选，留空表示不限）" })}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("extract.batchRangeStart", { defaultValue: "起始章" })}</span>
                  <input
                    type="number"
                    data-testid="batch-range-start"
                    aria-label={t("extract.batchRangeStart", { defaultValue: "起始章" })}
                    min={1}
                    placeholder={t("extract.batchRangePlaceholder", { defaultValue: "不限" })}
                    className="w-20 rounded border bg-background px-2 py-1 text-xs text-foreground"
                    value={startChapterInput}
                    disabled={busy}
                    onChange={(event) => setStartChapterInput(event.target.value)}
                  />
                </label>
                <span className="text-xs text-muted-foreground">—</span>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("extract.batchRangeEnd", { defaultValue: "结束章" })}</span>
                  <input
                    type="number"
                    data-testid="batch-range-end"
                    aria-label={t("extract.batchRangeEnd", { defaultValue: "结束章" })}
                    min={1}
                    placeholder={t("extract.batchRangePlaceholder", { defaultValue: "不限" })}
                    className="w-20 rounded border bg-background px-2 py-1 text-xs text-foreground"
                    value={endChapterInput}
                    disabled={busy}
                    onChange={(event) => setEndChapterInput(event.target.value)}
                  />
                </label>
              </div>
              {rangeInvalid ? (
                <p role="alert" className="text-xs text-destructive">
                  {t("extract.batchRangeInvalid", { defaultValue: "起始章号不能大于结束章号" })}
                </p>
              ) : null}
            </div>

            <label className="flex items-center gap-2">
              {t("extract.batchBudget")}
              <input
                type="number"
                data-testid="batch-budget-input"
                aria-label={t("extract.batchBudget")}
                className="w-20 rounded border bg-background px-2 py-1 text-xs"
                min={1}
                max={Math.max(1, budgetMax)}
                value={budget}
                onChange={(event) => {
                  const raw = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value)
                  if (!Number.isFinite(raw)) return
                  const maxBudget = Math.max(1, budgetMax)
                  setBudget(Math.min(maxBudget, Math.max(1, Math.trunc(raw))))
                }}
              />
            </label>

            <div className="rounded bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
              {t("extract.batchSummary", {
                count: preview.plan.admitted.length,
                skipped: preview.ledger.skipped,
              })}
              {preview.ledger.exhausted ? ` · ${t("extract.batchBudgetExceeded", { budget: preview.ledger.budget })}` : null}
            </div>

            {scan?.excluded && scan.excluded.duplicateChapters.length > 0 ? (
              <BatchDuplicateConflictCard
                duplicateChapters={scan.excluded.duplicateChapters}
                duplicateChapterPaths={scan.excluded.duplicateChapterPaths}
                busy={busy || scanning}
                relocatingPath={relocatingPath}
                onLocateFile={handleLocateDuplicate}
                onRelocateDuplicate={(filePath, ch) => void handleRelocateDuplicate(filePath, ch)}
              />
            ) : null}

            {scan && scan.errors.length > 0 ? (
              <ul className="max-h-20 space-y-0.5 overflow-y-auto text-xs text-destructive">
                {[...new Set(scan.errors)].map(error => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}

          </div>
        ) : null}

        {readyCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded border border-dashed px-2 py-1.5 text-xs">
            <span>{t("extract.batchDraftPending", { count: readyCount })}</span>
            <span className="text-muted-foreground">{t("extract.batchReadyBlock")}</span>
            <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy || scanning} onClick={() => void handleAccept()}>
              {running === "accept" ? t("extract.batchAcceptWorking") : t("extract.batchAccept")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy || scanning} onClick={() => setPendingConfirm("discard")}>
              {t("extract.batchDiscard")}
            </Button>
          </div>
        ) : null}

        {uncertainCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded border border-dashed px-2 py-1.5 text-xs">
            <span>{t("extract.batchReviewInterrupted", { count: uncertainCount })}</span>
            <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy || scanning} onClick={() => setPendingConfirm("setAside")}>
              {t("extract.batchSetAside")}
            </Button>
          </div>
        ) : null}

        {activeConfirm ? (
          <div
            data-testid="batch-extract-inline-confirm"
            role="alertdialog"
            aria-label={activeConfirmText}
            className="space-y-2 rounded border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs"
          >
            <p className="text-foreground">{activeConfirmText}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                disabled={busy}
                onClick={() => setPendingConfirm(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs"
                disabled={busy || scanning}
                onClick={() => {
                  if (activeConfirm === "discard") void handleDiscard()
                  else if (activeConfirm === "resetCorrupt") void handleResetCorruptArtifact()
                  else void handleSetAside()
                }}
              >
                {t("common.confirm")}
              </Button>
            </div>
          </div>
        ) : null}

        {outcomes.length > 0 ? (
          <div className="space-y-1">
            <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs">
              {outcomes.map(outcome => {
                const identity = JSON.stringify([outcome.path, outcome.chapterNumber, outcome.status, outcome.projectionReceipt?.extractionHistoryPath, "reason" in outcome ? outcome.reason : undefined])
                const occurrence = outcomeKeyCounts.get(identity) ?? 0
                outcomeKeyCounts.set(identity, occurrence + 1)
                return <li key={JSON.stringify([identity, occurrence])}>{outcomeText(outcome)}</li>
              })}
            </ul>
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void handleCopyReceipts()}>
              {t("extract.batchCopyReceipts")}
            </Button>
          </div>
        ) : null}

        {showBatchProgress ? (
          <div
            data-testid="batch-extract-progress"
            className="space-y-1.5 rounded border bg-muted/40 px-2.5 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground">
                {t("extract.batchProgressStatus", {
                  completed: progressCompleted,
                  total: progressTotal,
                  failed: progressFailed,
                  defaultValue: `正在提取 ${progressCompleted}/${progressTotal}（失败 ${progressFailed}）`,
                })}
                {batchTask?.currentTitle ? ` · ${batchTask.currentTitle}` : ""}
              </span>
              {batchTask?.status === "running" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="batch-extract-cancel"
                  className="h-6 shrink-0 px-2 text-xs"
                  disabled={cancelling}
                  onClick={() => useImportProgressStore.getState().cancelTask(batchTask.id)}
                >
                  {cancelling
                    ? t("extract.batchCancelling", { defaultValue: "正在取消…" })
                    : t("extract.batchCancel", { defaultValue: "取消" })}
                </Button>
              ) : null}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, progressTotal)}
              aria-valuenow={progressCompleted}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <p role="status" aria-atomic="true" className="min-h-4 text-xs text-muted-foreground">{statusMessage}</p>

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || readyCount > 0 || uncertainCount > 0 || scanning || !preview || preview.plan.admitted.length === 0}
            onClick={() => void handleStart()}
          >
            {running === "extract" ? t("extract.batchRunningShort") : t("extract.batchStart")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
export function RawSourcesSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const tasks = useImportProgressStore((s) => s.tasks)
  const [expanded, setExpanded] = useState(false)

  const projectTasks = useMemo(() => {
    if (!project) return []
    const projectPath = normalizePath(project.path)
    return tasks
      .filter((task) => task.projectPath === projectPath)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [project, tasks])

  const runningTasks = projectTasks.filter((t) => t.status === "running")
  const hasRunning = runningTasks.length > 0
  const hasAnyTask = projectTasks.length > 0

  useEffect(() => {
    if (hasRunning) setExpanded(true)
  }, [hasRunning])

  return (
    <div className="shrink-0 border-t bg-background/95 p-2 backdrop-blur">
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm qm-hover"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="flex-1 text-left font-medium text-muted-foreground">{t("knowledgeTree.extracting")}</span>
        {hasRunning ? (
          <span className="text-xs text-primary">{runningTasks.length} 个任务运行中</span>
        ) : null}
      </button>
      {expanded && (
        <div className="ml-3 space-y-2 pr-1 text-xs text-muted-foreground">
          {hasAnyTask ? (
            projectTasks.slice(0, 20).map((task) => {
              const kindLabel =
              task.kind === "batch_extraction" ? t("extract.batchProgressLabel") :
              task.kind === "outline" ? "AI 大纲" :
                task.kind === "outline_generation" ? "生成大纲" :
                  task.kind === "outline_refinement" ? "细化生成" :
                    "章节"
              const progressPercent = task.total > 0
                ? Math.round((task.completed / task.total) * 100)
                : 0
              const isRunning = task.status === "running"
              const statusText = isRunning
                ? task.cancelling
                  ? `正在取消${kindLabel}提取...`
                  : task.currentTitle || `${kindLabel}提取中`
                : task.status === "done"
                  ? `${kindLabel}提取完成`
                  : task.status === "error"
                    ? task.message || `${kindLabel}提取失败`
                    : task.status === "cancelled"
                      ? `${kindLabel}提取已取消`
                      : task.status === "pending"
                        ? task.message || `${kindLabel}待处理`
                        : task.status === "skipped"
                          ? task.message || `${kindLabel}已跳过`
                          : task.message ?? ""
              return (
                <div key={task.id} className="space-y-1 rounded-md bg-muted/30 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate flex items-center gap-1" title={statusText}>
                      {isRunning ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                      ) : task.status === "done" ? (
                        <Check className="h-3 w-3 shrink-0 text-success" />
                      ) : task.status === "error" ? (
                        <X className="h-3 w-3 shrink-0 text-destructive" />
                      ) : task.status === "cancelled" ? (
                        <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : task.status === "pending" ? (
                        <Clock className="h-3 w-3 shrink-0 text-warning" />
                      ) : task.status === "skipped" ? (
                        <MinusCircle className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className={isRunning ? "text-foreground font-medium" : ""}>
                        {statusText}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {isRunning && (
                        <>
                          <span className="text-muted-foreground">{progressPercent}%</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-5 px-1.5 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                            onClick={() => {
                              useImportProgressStore.getState().cancelTask(task.id)
                            }}
                            disabled={task.cancelling}
                          >
                            停止
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  {isRunning && (
                    <div className="h-1 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  )}
                  {isRunning && task.completed > 0 && (
                    <span className="text-muted-foreground">
                      {task.completed}/{task.total} · {kindLabel}
                    </span>
                  )}
                </div>
              )
            })
          ) : (
            <div className="rounded-md bg-muted/40 px-2 py-2">{t("knowledgeTree.noTasks")}</div>
          )}
        </div>
      )}
    </div>
  )
}
