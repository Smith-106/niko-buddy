// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  createOutlineIngestTask,
  runOutlineIngestTask,
  invalidateChapterCache,
  OUTLINE_IMPORT_EXTENSIONS,
  collectOutlineImportCandidatesFromFolder,
  importOutlineCandidates,
  importOutlineFiles,
  CHAPTER_IMPORT_EXTENSIONS,
  collectChapterImportCandidatesFromFolder,
  importChapterFiles,
  runImportedChapterMemoryExtraction,
} from "@/lib/novel"
import type { ImportedChapter } from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"
import { toast } from "@/lib/toast"
import { useImportProgressStore } from "@/stores/import-progress-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ImportMemoryDecision, ImportMemoryDecisionRequest } from "./sidebar-helpers"

export interface SidebarImportDeps {
  refreshTree: (projectPath: string, selectedPath?: string) => Promise<void>
}

export interface SidebarImportApi {
  outlineImporting: boolean
  outlineImportMenuOpen: boolean
  setOutlineImportMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  outlineImportMenuRef: React.RefObject<HTMLDivElement | null>
  chapterImporting: boolean
  chapterImportMenuOpen: boolean
  setChapterImportMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  chapterImportMenuRef: React.RefObject<HTMLDivElement | null>
  memoryDecisionRequest: ImportMemoryDecisionRequest | null
  closeMemoryDecision: (decision: ImportMemoryDecision) => void
  handleCancelImportMemoryExtraction: () => void
  handleImportChapterFiles: () => Promise<void>
  handleImportChapterFolder: () => Promise<void>
  handleImportOutlineFiles: () => Promise<void>
  handleImportOutlineFolder: () => Promise<void>
}

export function useSidebarImport({ refreshTree }: SidebarImportDeps): SidebarImportApi {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [outlineImporting, setOutlineImporting] = useState(false)
  const [outlineImportMenuOpen, setOutlineImportMenuOpen] = useState(false)
  const outlineImportMenuRef = useRef<HTMLDivElement | null>(null)
  const [chapterImporting, setChapterImporting] = useState(false)
  const [chapterImportMenuOpen, setChapterImportMenuOpen] = useState(false)
  const [memoryDecisionRequest, setMemoryDecisionRequest] = useState<ImportMemoryDecisionRequest | null>(null)
  const chapterImportMenuRef = useRef<HTMLDivElement | null>(null)
  const chapterImportAbortRef = useRef<AbortController | null>(null)
  const activeImportTaskIdRef = useRef<string | null>(null)
  const outlineImportCancelledRef = useRef(false)
  const memoryDecisionResolveRef = useRef<((decision: ImportMemoryDecision) => void) | null>(null)

  useEffect(() => {
    if (!outlineImportMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (outlineImportMenuRef.current?.contains(target)) return
      setOutlineImportMenuOpen(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOutlineImportMenuOpen(false)
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [outlineImportMenuOpen])

  useEffect(() => {
    if (!chapterImportMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (chapterImportMenuRef.current?.contains(target)) return
      setChapterImportMenuOpen(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChapterImportMenuOpen(false)
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [chapterImportMenuOpen])

  function confirmImportMemoryExtraction(kind: "chapter" | "outline", count: number): Promise<ImportMemoryDecision> {
    return new Promise((resolve) => {
      memoryDecisionResolveRef.current = resolve
      setMemoryDecisionRequest({ kind, count })
    })
  }

  function confirmChapterMemoryExtraction(count: number): Promise<ImportMemoryDecision> {
    return confirmImportMemoryExtraction("chapter", count)
  }

  function confirmOutlineMemoryExtraction(count: number): Promise<ImportMemoryDecision> {
    return confirmImportMemoryExtraction("outline", count)
  }

  function closeMemoryDecision(decision: ImportMemoryDecision) {
    const resolve = memoryDecisionResolveRef.current
    memoryDecisionResolveRef.current = null
    setMemoryDecisionRequest(null)
    resolve?.(decision)
  }

  function handleCancelImportMemoryExtraction() {
    const taskId = activeImportTaskIdRef.current
    if (taskId) useImportProgressStore.getState().markCancelling(taskId)
    outlineImportCancelledRef.current = true
    chapterImportAbortRef.current?.abort()
  }

  async function extractImportedChapterMemories(projectPath: string, importedChapters: ImportedChapter[]) {
    const abortController = new AbortController()
    chapterImportAbortRef.current = abortController
    const titleByPath = new Map(importedChapters.map((chapter) => [chapter.path, chapter.title]))
    const taskId = useImportProgressStore.getState().startTask({
      projectPath,
      kind: "chapter",
      total: importedChapters.length,
      currentTitle: importedChapters[0]?.title ?? "",
      message: "正在提取章节记忆",
    })
    activeImportTaskIdRef.current = taskId

    const { ingestChapter } = await import("@/lib/novel/chapter-ingest")
    const result = await runImportedChapterMemoryExtraction({
      projectPath,
      chapterPaths: importedChapters.map((chapter) => chapter.path),
      signal: abortController.signal,
      reviewModel: undefined,
      ingestChapter,
      onProgress: (progress) => {
        useImportProgressStore.getState().updateTask(taskId, {
          completed: progress.completed,
          total: progress.total,
          currentTitle: progress.currentPath ? titleByPath.get(progress.currentPath) ?? progress.currentPath : "",
        })
      },
    })

    const doneMessage = result.cancelled
      ? `已取消记忆提取，已完成 ${result.completed}/${importedChapters.length} 个章节。`
      : result.failed > 0
        ? `记忆提取完成：成功 ${result.completed} 个，失败 ${result.failed} 个。`
        : `记忆提取完成：成功 ${result.completed} 个章节。`
    useImportProgressStore.getState().finishTask(taskId, result.cancelled ? "cancelled" : "done", {
      completed: result.completed,
      total: importedChapters.length,
      currentTitle: "",
      message: doneMessage,
    })
    chapterImportAbortRef.current = null
    activeImportTaskIdRef.current = null
    await refreshTree(projectPath, importedChapters[0]?.path)
  }

  async function extractImportedOutlineMemories(projectPath: string, importedPaths: string[]) {
    outlineImportCancelledRef.current = false
    const taskId = useImportProgressStore.getState().startTask({
      projectPath,
      kind: "outline",
      total: importedPaths.length,
      currentTitle: getFileName(importedPaths[0] ?? ""),
      message: "正在提取 AI 大纲记忆",
    })
    activeImportTaskIdRef.current = taskId

    let completed = 0
    let failed = 0
    for (const outlinePath of importedPaths) {
      if (outlineImportCancelledRef.current) {
        useImportProgressStore.getState().finishTask(taskId, "cancelled", {
          completed,
          currentTitle: "",
          message: `已取消大纲记忆提取，已完成 ${completed}/${importedPaths.length} 个大纲。`,
        })
        activeImportTaskIdRef.current = null
        return
      }

      useImportProgressStore.getState().updateTask(taskId, {
        completed,
        total: importedPaths.length,
        currentTitle: getFileName(outlinePath),
      })
      const outlineTaskId = createOutlineIngestTask(projectPath, outlinePath)
      await runOutlineIngestTask(outlineTaskId)
      completed += 1
    }

    useImportProgressStore.getState().finishTask(taskId, failed > 0 ? "error" : "done", {
      completed,
      total: importedPaths.length,
      currentTitle: "",
      message: failed > 0
        ? `大纲记忆提取完成：成功 ${completed - failed} 个，失败 ${failed} 个。`
        : `大纲记忆提取完成：成功 ${completed} 个大纲。`,
    })
    activeImportTaskIdRef.current = null
    await refreshTree(projectPath, importedPaths[0])
  }

  async function finishChapterImport(projectPath: string, importedChapters: ImportedChapter[], extractMemory: boolean) {
    if (importedChapters.length === 0) {
      toast.info("没有找到可导入的章节文档。")
      return
    }
    await refreshTree(projectPath, importedChapters[0].path)
    if (extractMemory) {
      await extractImportedChapterMemories(projectPath, importedChapters)
    }
  }

  async function handleImportChapterFiles() {
    if (!project || chapterImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      multiple: true,
      title: "导入章节文件",
      filters: [{ name: "章节文档", extensions: [...CHAPTER_IMPORT_EXTENSIONS] }],
    })
    if (!selected || (Array.isArray(selected) && selected.length === 0)) return
    const sourcePaths = Array.isArray(selected) ? selected : [selected]

    const memoryDecision = await confirmChapterMemoryExtraction(sourcePaths.length)
    if (memoryDecision === "cancel") return
    const extractMemory = memoryDecision === "extract"
    setChapterImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedChapters = await importChapterFiles(projectPath, sourcePaths, {
        finalForMemoryExtraction: extractMemory,
      })
      await finishChapterImport(projectPath, importedChapters, extractMemory)
      invalidateChapterCache(projectPath)
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] chapter file import failed:", error)
      toast.error(`导入失败：${message}`)
    } finally {
      setChapterImporting(false)
      setChapterImportMenuOpen(false)
    }
  }

  async function handleImportChapterFolder() {
    if (!project || chapterImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: true,
      title: "导入章节文件夹",
    })
    const selectedFolder = Array.isArray(selected) ? selected[0] : selected
    if (!selectedFolder || typeof selectedFolder !== "string") return
    const candidates = await collectChapterImportCandidatesFromFolder(selectedFolder)

    if (candidates.length === 0) {
      toast.info("没有找到可导入的章节文档。")
      setChapterImportMenuOpen(false)
      return
    }

    const memoryDecision = await confirmChapterMemoryExtraction(candidates.length)
    if (memoryDecision === "cancel") return
    const extractMemory = memoryDecision === "extract"
    setChapterImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedChapters = await importChapterFiles(projectPath, candidates.map((candidate) => candidate.path), {
        finalForMemoryExtraction: extractMemory,
      })
      await finishChapterImport(projectPath, importedChapters, extractMemory)
      invalidateChapterCache(projectPath)
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] chapter folder import failed:", error)
      toast.error(`导入失败：${message}`)
    } finally {
      setChapterImporting(false)
      setChapterImportMenuOpen(false)
    }
  }

  async function handleImportOutlineFiles() {
    if (!project || outlineImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      multiple: true,
      title: t("novel.outlineImport.importFilesTitle", { defaultValue: "导入大纲文件" }),
      filters: [
        {
          name: t("novel.outlineImport.documentFilter", { defaultValue: "文档" }),
          extensions: [...OUTLINE_IMPORT_EXTENSIONS],
        },
      ],
    })
    if (!selected || (Array.isArray(selected) && selected.length === 0)) return
    const sourcePaths = Array.isArray(selected) ? selected : [selected]

    setOutlineImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedPaths = await importOutlineFiles(projectPath, sourcePaths)
      if (importedPaths.length === 0) {
        toast.info(t("novel.outlineImport.emptyResult", { defaultValue: "没有找到可导入的大纲文档。" }))
        return
      }
      await refreshTree(projectPath, importedPaths[0])
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] outline file import failed:", error)
      toast.error(t("novel.outlineImport.importFailed", {
        message,
        defaultValue: `导入失败：${message}`,
      }))
    } finally {
      setOutlineImporting(false)
      setOutlineImportMenuOpen(false)
    }
  }

  async function handleImportOutlineFolder() {
    if (!project || outlineImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: true,
      title: t("novel.outlineImport.importFolderTitle", { defaultValue: "导入大纲文件夹" }),
    })
    if (!selected || typeof selected !== "string") return
    const candidates = await collectOutlineImportCandidatesFromFolder(selected)

    if (candidates.length === 0) {
      toast.info(t("novel.outlineImport.emptyResult", { defaultValue: "没有找到可导入的大纲文档。" }))
      setOutlineImportMenuOpen(false)
      return
    }

    const memoryDecision = await confirmOutlineMemoryExtraction(candidates.length)
    if (memoryDecision === "cancel") return
    const extractMemory = memoryDecision === "extract"
    setOutlineImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedPaths = await importOutlineCandidates(projectPath, candidates)
      if (importedPaths.length === 0) {
        toast.info(t("novel.outlineImport.emptyResult", { defaultValue: "没有找到可导入的大纲文档。" }))
        return
      }
      await refreshTree(projectPath, importedPaths[0])
      if (extractMemory) {
        await extractImportedOutlineMemories(projectPath, importedPaths)
      }
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] outline folder import failed:", error)
      toast.error(t("novel.outlineImport.importFailed", {
        message,
        defaultValue: `导入失败：${message}`,
      }))
    } finally {
      setOutlineImporting(false)
      setOutlineImportMenuOpen(false)
    }
  }

  return {
    outlineImporting,
    outlineImportMenuOpen,
    setOutlineImportMenuOpen,
    outlineImportMenuRef,
    chapterImporting,
    chapterImportMenuOpen,
    setChapterImportMenuOpen,
    chapterImportMenuRef,
    memoryDecisionRequest,
    closeMemoryDecision,
    handleCancelImportMemoryExtraction,
    handleImportChapterFiles,
    handleImportChapterFolder,
    handleImportOutlineFiles,
    handleImportOutlineFolder,
  }
}
