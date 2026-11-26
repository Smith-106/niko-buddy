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
  findChapterFileByNumber,
  importChapterFiles,
  importWholeTxtNovel,
  previewWholeTxtChapters,
  verifyRebuildOutcome,
} from "@/lib/novel"
import type { ImportedChapter, IngestResult } from "@/lib/novel"
// G3（TASK-004）：快照扫库/范围选择/队列的类型只做**类型位**引用（import(...) 类型查询，
// 编译期擦除，不产生静态依赖边）；运行时一律走动态 import（boundaries 门禁：app 层
// 不得静态深导入 novel 内部模块）。
export type BatchExtractDraft = import("@/lib/novel/snapshot-scanner").BatchExtractDraft
export type BatchExtractQueueState = import("@/lib/novel/snapshot-scanner").BatchExtractQueueState
export type BatchAcceptOutcome = import("@/lib/novel/snapshot-scanner").BatchAcceptOutcome
export type BatchBudgetLedger = import("@/lib/novel/snapshot-scanner").BatchBudgetLedger
export type BatchExtractScopeMode = import("@/lib/novel/snapshot-scanner").BatchExtractScopeMode
export type BatchExtractScopeOptions = import("@/lib/novel/snapshot-scanner").BatchExtractScopeOptions
export type BatchExtractScopeSelection = import("@/lib/novel/snapshot-scanner").BatchExtractScopeSelection
export type BatchExtractBudgetPlan = import("@/lib/novel/snapshot-scanner").BatchExtractBudgetPlan
export type SnapshotScanResult = import("@/lib/novel/snapshot-scanner").SnapshotScanResult
import { toErrorMessage } from "@/lib/utils"
import { toast } from "@/lib/toast"
import { useImportProgressStore } from "@/stores/import-progress-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChapterImportDecision, ImportMemoryDecision, ImportMemoryDecisionRequest } from "./sidebar-helpers"

export interface SidebarImportDeps {
  refreshTree: (projectPath: string, selectedPath?: string) => Promise<void>
  onOpenBatchExtract?: (seedChapter: number | null) => void
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
  closeMemoryDecision: (decision: ImportMemoryDecision | ChapterImportDecision) => void
  handleImportChapterFiles: () => Promise<void>
  handleImportChapterFolder: () => Promise<void>
  handleImportWholeTxtNovel: () => Promise<void>
  handleImportOutlineFiles: () => Promise<void>
  handleImportOutlineFolder: () => Promise<void>
}

export function useSidebarImport({ refreshTree, onOpenBatchExtract }: SidebarImportDeps): SidebarImportApi {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const selectedFileRef = useRef<string | null>(selectedFile)
  selectedFileRef.current = selectedFile
  const [outlineImporting, setOutlineImporting] = useState(false)
  const [outlineImportMenuOpen, setOutlineImportMenuOpen] = useState(false)
  const outlineImportMenuRef = useRef<HTMLDivElement | null>(null)
  const [chapterImporting, setChapterImporting] = useState(false)
  const [chapterImportMenuOpen, setChapterImportMenuOpen] = useState(false)
  const [memoryDecisionRequest, setMemoryDecisionRequest] = useState<ImportMemoryDecisionRequest | null>(null)
  const chapterImportMenuRef = useRef<HTMLDivElement | null>(null)
  const memoryDecisionResolveRef = useRef<((decision: ImportMemoryDecision | ChapterImportDecision) => void) | null>(null)

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

  function confirmChapterImportDecision(count: number, sourceSummary?: string): Promise<ChapterImportDecision> {
    return new Promise((resolve) => {
      memoryDecisionResolveRef.current = (decision) => {
        if (
          decision === "draft"
          || decision === "final-only"
          || decision === "final-and-batch-extract"
          || decision === "cancel"
        ) {
          resolve(decision)
        } else {
          resolve("cancel")
        }
      }
      setMemoryDecisionRequest({ kind: "chapter", count, sourceSummary })
    })
  }

  function confirmOutlineMemoryExtraction(count: number): Promise<ImportMemoryDecision> {
    return new Promise((resolve) => {
      memoryDecisionResolveRef.current = (decision) => {
        if (decision === "extract" || decision === "import-only" || decision === "cancel") {
          resolve(decision)
        } else {
          resolve("cancel")
        }
      }
      setMemoryDecisionRequest({ kind: "outline", count })
    })
  }

  function closeMemoryDecision(decision: ImportMemoryDecision | ChapterImportDecision) {
    const resolve = memoryDecisionResolveRef.current
    memoryDecisionResolveRef.current = null
    setMemoryDecisionRequest(null)
    resolve?.(decision)
  }

  async function extractImportedOutlineMemories(projectPath: string, importedPaths: string[]) {
    const abortController = new AbortController()
    const taskId = useImportProgressStore.getState().startTask({
      projectPath,
      kind: "outline",
      abortController,
      total: importedPaths.length,
      currentTitle: getFileName(importedPaths[0] ?? ""),
      message: "正在提取 AI 大纲记忆",
    })

    let succeeded = 0
    let failed = 0
    let cancelled = false
    let finished = false
    let doneMessage = ""
    try {
      for (const outlinePath of importedPaths) {
        if (abortController.signal.aborted) {
          cancelled = true
          break
        }

        useImportProgressStore.getState().updateTask(taskId, {
          completed: succeeded + failed,
          total: importedPaths.length,
          currentTitle: getFileName(outlinePath),
        })
        const outlineTaskId = createOutlineIngestTask(projectPath, outlinePath)
        try {
          const outcome = await runOutlineIngestTask(outlineTaskId, {
            signal: abortController.signal,
            reuseParentTask: true,
          })
          if (outcome?.cancelled || abortController.signal.aborted) {
            cancelled = true
            break
          }
          if (outcome?.ok === false) {
            failed += 1
          } else {
            succeeded += 1
          }
        } catch (error) {
          if (abortController.signal.aborted) {
            cancelled = true
            break
          }
          failed += 1
          console.error("[SidebarPanel] outline memory extraction failed:", outlinePath, toErrorMessage(error))
        }
      }

      cancelled = cancelled || abortController.signal.aborted
      const processed = succeeded + failed
      doneMessage = cancelled
        ? t("novel.outlineImport.extractCancelledToast", {
            completed: succeeded,
            total: importedPaths.length,
            defaultValue: `大纲记忆提取已取消（已完成 ${succeeded}/${importedPaths.length}）`,
          })
        : t("novel.outlineImport.extractSummaryToast", {
            succeeded,
            failed,
            defaultValue: `大纲记忆提取完成：成功 ${succeeded} 份，失败 ${failed} 份`,
          })
      useImportProgressStore.getState().finishTask(taskId, cancelled ? "cancelled" : failed > 0 ? "error" : "done", {
        completed: processed,
        total: importedPaths.length,
        currentTitle: "",
        message: doneMessage,
      })
      finished = true
    } finally {
      if (!finished) {
        useImportProgressStore.getState().finishTask(taskId, abortController.signal.aborted ? "cancelled" : "error", {
          completed: succeeded + failed,
          total: importedPaths.length,
          currentTitle: "",
          message: "大纲记忆提取中断",
        })
      }
    }

    await refreshTree(projectPath)
    if (doneMessage) {
      if (cancelled || failed > 0) toast.info(doneMessage)
      else toast.success(doneMessage)
    }
  }

  async function finishChapterImport(
    projectPath: string,
    importedChapters: ImportedChapter[],
    decision: Exclude<ChapterImportDecision, "cancel">,
    warnings?: readonly string[],
  ) {
    if (importedChapters.length === 0) {
      toast.info(t("sidebar.noImportableChapters", { defaultValue: "没有找到可导入的章节文档。" }))
      return
    }
    await refreshTree(projectPath, selectedFileRef.current ? undefined : importedChapters[0].path)
    if (decision === "final-and-batch-extract") {
      toast.success(
        t("sidebar.importedChaptersOpenBatch", {
          count: importedChapters.length,
          defaultValue: `已导入 ${importedChapters.length} 个已定稿章节，正在打开批量记忆提取向导。`,
        }),
      )
      onOpenBatchExtract?.(importedChapters[0]?.chapterNumber ?? null)
    } else if (decision === "final-only") {
      toast.success(
        t("sidebar.importedChaptersFinalOnly", {
          count: importedChapters.length,
          defaultValue: `已导入 ${importedChapters.length} 个已定稿章节（暂未提取记忆）。`,
        }),
      )
    } else {
      toast.success(
        t("sidebar.importedChaptersDraft", {
          count: importedChapters.length,
          defaultValue: `已作为草稿导入 ${importedChapters.length} 个章节。`,
        }),
      )
    }
    if (warnings && warnings.length > 0) {
      toast.info(warnings[0])
    }
  }

  async function handleImportChapterFiles() {
    if (!project || chapterImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      multiple: true,
      title: t("sidebar.importChapterFilesTitle", { defaultValue: "导入章节文件" }),
      filters: [{ name: t("sidebar.chapterDocumentFilter", { defaultValue: "章节文档" }), extensions: [...CHAPTER_IMPORT_EXTENSIONS] }],
    })
    if (!selected || (Array.isArray(selected) && selected.length === 0)) return
    const sourcePaths = Array.isArray(selected) ? selected : [selected]

    const decision = await confirmChapterImportDecision(sourcePaths.length)
    if (decision === "cancel") return
    const finalForMemoryExtraction = decision !== "draft"
    setChapterImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedChapters = await importChapterFiles(projectPath, sourcePaths, {
        finalForMemoryExtraction,
      })
      invalidateChapterCache(projectPath)
      await finishChapterImport(projectPath, importedChapters, decision)
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
      title: t("sidebar.importChapterFolderTitle", { defaultValue: "导入章节文件夹" }),
    })
    const selectedFolder = Array.isArray(selected) ? selected[0] : selected
    if (!selectedFolder || typeof selectedFolder !== "string") return
    const candidates = await collectChapterImportCandidatesFromFolder(selectedFolder)

    if (candidates.length === 0) {
      toast.info(t("sidebar.noImportableChapters", { defaultValue: "没有找到可导入的章节文档。" }))
      setChapterImportMenuOpen(false)
      return
    }

    const decision = await confirmChapterImportDecision(candidates.length)
    if (decision === "cancel") return
    const finalForMemoryExtraction = decision !== "draft"
    setChapterImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const importedChapters = await importChapterFiles(projectPath, candidates.map((candidate) => candidate.path), {
        finalForMemoryExtraction,
      })
      invalidateChapterCache(projectPath)
      await finishChapterImport(projectPath, importedChapters, decision)
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] chapter folder import failed:", error)
      toast.error(`导入失败：${message}`)
    } finally {
      setChapterImporting(false)
      setChapterImportMenuOpen(false)
    }
  }

  async function handleImportWholeTxtNovel() {
    if (!project || chapterImporting) return

    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      multiple: false,
      title: t("sidebar.importWholeTxtTitle", { defaultValue: "整本 TXT 拆章导入" }),
      filters: [{ name: t("sidebar.txtNovelFilter", { defaultValue: "TXT 文本" }), extensions: ["txt"] }],
    })
    const sourcePath = Array.isArray(selected) ? selected[0] : selected
    if (!sourcePath || typeof sourcePath !== "string") return

    let detectedCount = 1
    let sourceSummary: string | undefined
    try {
      const preview = await previewWholeTxtChapters(sourcePath)
      if (preview.chapters.length === 0) {
        toast.info(t("sidebar.noImportableChapters", { defaultValue: "没有找到可导入的章节文档。" }))
        setChapterImportMenuOpen(false)
        return
      }
      detectedCount = preview.chapters.length
      sourceSummary = t("sidebar.wholeTxtDetectedSummary", {
        fileName: getFileName(sourcePath),
        count: preview.chapters.length,
        words: preview.totalWords,
        defaultValue: `已从「${getFileName(sourcePath)}」识别出 ${preview.chapters.length} 章（约 ${preview.totalWords} 字）。请选择导入后的章节状态与是否打开批量提取向导。`,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] whole txt preview failed:", error)
      toast.error(`导入失败：${message}`)
      setChapterImportMenuOpen(false)
      return
    }

    const decision = await confirmChapterImportDecision(detectedCount, sourceSummary)
    if (decision === "cancel") return
    const finalForMemoryExtraction = decision !== "draft"
    setChapterImporting(true)
    try {
      const projectPath = normalizePath(project.path)
      const result = await importWholeTxtNovel(projectPath, sourcePath, {
        finalForMemoryExtraction,
        conflictStrategy: "auto-offset",
      })
      invalidateChapterCache(projectPath)
      await finishChapterImport(projectPath, result.imported, decision, result.warnings)
    } catch (error) {
      const message = toErrorMessage(error)
      console.error("[SidebarPanel] whole txt import failed:", error)
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
      await refreshTree(projectPath, selectedFileRef.current ? undefined : importedPaths[0])
      toast.success(t("novel.outlineImport.importedToast", {
        count: importedPaths.length,
        defaultValue: `已导入 ${importedPaths.length} 份大纲文件`,
      }))
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
      await refreshTree(projectPath, selectedFileRef.current ? undefined : importedPaths[0])
      toast.success(t("novel.outlineImport.importedToast", {
        count: importedPaths.length,
        defaultValue: `已导入 ${importedPaths.length} 份大纲文件`,
      }))
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
    handleImportChapterFiles,
    handleImportChapterFolder,
    handleImportWholeTxtNovel,
    handleImportOutlineFiles,
    handleImportOutlineFolder,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// G3（TASK-004）：批量提取队列 —— 复用本文件 confirm/extract/abort/进度通道范式
// ──────────────────────────────────────────────────────────────────────────
//
// 与上方导入确认与大纲提取（extractImportedOutlineMemories）同一套进度与取消范式：
//   确认（范围选择弹层）→ 建进度任务（startTask + abortController）→ 逐章提取并
//   updateTask 进度 → finishTask 收尾；取消走既有 abort（进度面板「停止」按钮
//   → useImportProgressStore.cancelTask → abortController.abort → 本模块 signal 短路）。
//
// Draft-first 硬边界（D5）：
//   * 提取阶段只调 `prepareChapterIngest`（纯抽取，零正式写入），结果落在
//     `BatchExtractDraft` 草稿账本里，状态 pending → ready；取消走每任务
//     AbortController（startTask.abortController → cancelTask）。
//   * **不**调 ingestChapter（引擎不动），**不**写 wiki/正式记忆。
//   * 只有 acceptBatchExtractionDrafts（人工 accept）才调 `commitPreparedChapterIngest`
//     回填正式记忆 —— 与 snapshot-viewer 的「草稿快照 → accept 同步记忆」同一出口。

// Batch work shares the application's live model settings; serialize extraction and acceptance across projects.
let activeBatchProject: string | null = null

/** 批量草稿与回执的进程内视图；磁盘保存在草稿工件，不作小说会话真源。 */
const batchDraftLedgers = new Map<string, BatchExtractQueueState>()
const batchDraftArtifactBytes = new Map<string, string | null>()

function batchProjectKey(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/** 批量提取进度回调载荷。 */
export interface BatchExtractionProgress {
  completed: number
  total: number
  currentChapter: number | null
  message?: string
}

/** 批量提取入参。 */
export interface BatchExtractionRunInput {
  projectPath: string
  chapters: readonly number[]
  /** 扫描阶段发现的正式章路径（有则直接用，免二次标题查找）。 */
  paths?: Readonly<Record<number, string>>
  /** LLM 预算上限（章）；缺省 = BATCH_EXTRACT_BUDGET_DEFAULT，超硬顶截断。 */
  budget?: number | null
  signal?: AbortSignal
  onProgress?: (progress: BatchExtractionProgress) => void
}

/** 批量提取结果。 */
export interface BatchExtractionRunResult {
  taskId: string
  admitted: number[]
  skippedByBudget: number[]
  ledger: BatchBudgetLedger
  /** pending/ready 草稿（accept 前不落正式记忆）。 */
  drafts: BatchExtractDraft[]
  completed: number
  failed: number
  cancelled: boolean
  errors: string[]
}

/** 范围预览（弹层用：扫库 → 范围选择 → 预算裁决）。 */
export interface BatchExtractionPreview {
  scan: SnapshotScanResult
  selection: BatchExtractScopeSelection
  plan: BatchExtractBudgetPlan
  ledger: BatchBudgetLedger
}

/** 批量提取默认口径（常量来自 snapshot-scanner，禁止在 UI 侧写副本）。 */
export interface BatchExtractDefaults {
  scope: BatchExtractScopeMode
  skipExisting: boolean
  force: boolean
  budget: number
  budgetMax: number
}

/** 读取批量提取默认口径（单真源 = snapshot-scanner 常量）。 */
export async function loadBatchExtractDefaults(): Promise<BatchExtractDefaults> {
  const scanner = await import("@/lib/novel/snapshot-scanner")
  return {
    scope: scanner.DEFAULT_BATCH_EXTRACT_SCOPE,
    skipExisting: scanner.DEFAULT_BATCH_SKIP_EXISTING,
    force: scanner.DEFAULT_BATCH_FORCE,
    budget: scanner.BATCH_EXTRACT_BUDGET_DEFAULT,
    budgetMax: scanner.BATCH_EXTRACT_BUDGET_MAX,
  }
}

/** 扫库 + 范围选择 + 预算裁决（弹层预览，只读）。 */
export async function previewBatchExtraction(
  projectPath: string,
  options: BatchExtractScopeOptions & { budget?: number | null } = {},
): Promise<BatchExtractionPreview> {
  const scanner = await import("@/lib/novel/snapshot-scanner")
  const scan = await scanner.scanFinalChapterBackfill(normalizePath(projectPath))
  const selection = scanner.resolveBatchExtractScope(scan, options)
  const plan = scanner.applyDesktopBatchExtractBudget(selection.chapters, options.budget)
  return { scan, selection, plan, ledger: scanner.buildBatchBudgetLedger(plan) }
}

/** 当前项目的批量提取草稿账本（无则 null）。 */
export function getBatchExtractQueue(projectPath: string): BatchExtractQueueState | null {
  return batchDraftLedgers.get(batchProjectKey(projectPath)) ?? null
}

export async function restoreBatchExtractQueue(projectPath: string): Promise<BatchExtractQueueState | null> {
  const key = batchProjectKey(projectPath)
  if (activeBatchProject === key) return getBatchExtractQueue(key)
  const before = batchDraftArtifactBytes.get(key)
  const { loadBatchDraftArtifact } = await import("@/lib/novel/snapshot-scanner")
  const persisted = await loadBatchDraftArtifact(key)
  const raw = persisted?.raw ?? null
  if (activeBatchProject !== key && batchDraftArtifactBytes.get(key) === before && raw !== before) {
    batchDraftArtifactBytes.set(key, raw)
    if (persisted) batchDraftLedgers.set(key, persisted.queue)
    else batchDraftLedgers.delete(key)
  }
  return getBatchExtractQueue(key)
}

async function persistBatchExtractQueue(queue: BatchExtractQueueState, publish = true): Promise<void> {
  const { saveBatchDraftArtifact } = await import("@/lib/novel/snapshot-scanner")
  const key = queue.projectPath
  const expected = batchDraftArtifactBytes.get(key)
  if (expected === undefined) throw new Error("Batch extraction draft artifact was not read")
  const raw = await saveBatchDraftArtifact(queue, expected)
  batchDraftArtifactBytes.set(key, raw)
  if (publish) batchDraftLedgers.set(key, queue)
}

export async function setAsideUncertainBatchDrafts(projectPath: string, expected: BatchExtractQueueState): Promise<boolean> {
  const key = batchProjectKey(projectPath)
  const queue = batchDraftLedgers.get(key)
  if (activeBatchProject !== null || queue !== expected || !queue.drafts.some(draft => draft.status === "uncertain")) return false
  activeBatchProject = key
  try {
    const drafts = queue.drafts.map(draft => draft.status === "uncertain" ? { ...draft, status: "cancelled" as const } : draft)
    await persistBatchExtractQueue({ ...queue, drafts })
    return true
  } finally {
    activeBatchProject = null
  }
}

export async function resetCorruptBatchExtractionDrafts(projectPath: string, fingerprint: string): Promise<string> {
  const key = batchProjectKey(projectPath)
  if (activeBatchProject !== null) throw new Error("Batch extraction or acceptance already in progress")
  activeBatchProject = key
  try {
    const { quarantineBatchDraftArtifact } = await import("@/lib/novel/snapshot-scanner")
    const backup = await quarantineBatchDraftArtifact(key, fingerprint)
    batchDraftArtifactBytes.delete(key)
    batchDraftLedgers.delete(key)
    return backup
  } finally {
    activeBatchProject = null
  }
}

export async function discardBatchExtractionDrafts(projectPath: string, expected: BatchExtractQueueState): Promise<boolean> {
  const normalized = batchProjectKey(projectPath)
  const queue = batchDraftLedgers.get(normalized)
  if (activeBatchProject !== null || queue !== expected || !queue.drafts.some(draft => draft.status === "ready")) return false
  const drafts = queue.drafts.map(draft => draft.status === "ready"
    ? { ...draft, status: "cancelled" as const, reason: "discarded", snapshot: undefined, source: undefined }
    : draft)
  activeBatchProject = normalized
  try {
    await persistBatchExtractQueue({ ...queue, drafts, completed: drafts.filter(draft => draft.status === "accepted").length })
    return true
  } finally {
    activeBatchProject = null
  }
}

/**
 * 批量提取（阶段 1：extract → 草稿）。
 *
 * 逐章：定位章节文件 → prepareChapterIngest（纯抽取）→ 草稿置 ready。
 * 超预算章号只记账（skippedByBudget），不发任何 LLM 请求。
 */
export async function runBatchMemoryExtraction(
  input: BatchExtractionRunInput,
): Promise<BatchExtractionRunResult> {
  const projectPath = batchProjectKey(input.projectPath)
  const scanner = await import("@/lib/novel/snapshot-scanner")
  const { prepareChapterIngest } = await import("@/lib/novel/chapter-ingest")
  // 应用级仅允许一个批量提取/接受在途 → 拒绝并发启动（模型设置全局共享）。
  const previous = await restoreBatchExtractQueue(projectPath)
  if (activeBatchProject !== null) {
    throw new Error("Batch extraction or acceptance already in progress; only one project can run a batch at a time")
  }
  if (previous?.drafts.some(draft => draft.status === "ready")) {
    throw new Error("Confirm or discard the pending drafts before starting a new batch")
  }
  if (previous?.drafts.some(draft => draft.status === "uncertain")) {
    throw new Error("Review the interrupted acceptance before starting a new batch")
  }
  const plan = scanner.applyDesktopBatchExtractBudget(input.chapters, input.budget)
  const ledger = scanner.buildBatchBudgetLedger(plan)
  let queue: BatchExtractQueueState = {
    ...scanner.createBatchExtractQueue({ projectPath, plan }),
    previousOutcomes: [
      ...(previous?.previousOutcomes ?? []),
      ...(previous?.drafts.flatMap(draft => draft.outcome ? [draft.outcome] : []) ?? []),
    ],
  }

  const total = plan.admitted.length
  // startTask 先取（其 throw 不得楔死 Map/controller 状态）。
  const abortController = new AbortController()
  const taskId = useImportProgressStore.getState().startTask({
    projectPath,
    kind: "batch_extraction",
    total,
    currentTitle: "",
    message: ledger.exhausted
      ? `正在批量提取章节记忆（预算 ${ledger.budget} 章，超限 ${ledger.skipped} 章已记账跳过）`
      : "正在批量提取章节记忆",
    abortController,
  })
  activeBatchProject = projectPath
  const forwardAbort = () => abortController.abort()
  if (input.signal) {
    if (input.signal.aborted) abortController.abort()
    else input.signal.addEventListener("abort", forwardAbort, { once: true })
  }

  const errors: string[] = []
  let cancelled = false
  let persistenceError: Error | undefined
  const checkpoint = async (next: BatchExtractQueueState) => {
    try {
      await persistBatchExtractQueue(next)
    } catch (error) {
      persistenceError = new Error(`Could not save batch extraction drafts: ${toErrorMessage(error)}`)
      throw persistenceError
    }
  }

  const publish = (currentChapter: number | null, message?: string) => {
    useImportProgressStore.getState().updateTask(taskId, {
      completed: queue.completed + queue.failed,
      total,
      currentTitle: currentChapter === null ? "" : `第 ${currentChapter} 章`,
      message,
    })
    input.onProgress?.({ completed: queue.completed + queue.failed, total, currentChapter, message })
  }

  try {
    await checkpoint(queue)
    for (const chapter of plan.admitted) {
      if (abortController.signal.aborted) {
        cancelled = true
        break
      }
      queue = scanner.startBatchChapter(queue, chapter)
      publish(chapter)
      let next = queue
      try {
        // 扫描发现的正式章路径优先（免 findChapterFileByNumber 的标题二查）；
        // 缺省仍走既有查找（引擎端有 exact chapter/final 校验兜底）。
        const chapterPath = input.paths
          ? input.paths[chapter]
          : await findChapterFileByNumber(projectPath, chapter)
        if (!chapterPath) throw new Error("chapter_file_missing")
        const prepared = await prepareChapterIngest(projectPath, chapterPath, chapter, abortController.signal)
        if (abortController.signal.aborted) {
          cancelled = true
          queue = scanner.cancelBatchExtractQueue(queue)
          break
        }
        // Draft-first：只落 ready 草稿（含源绑定），accept 才回填正式记忆。
        next = scanner.completeBatchChapter(queue, chapter, prepared.snapshot, undefined, prepared.source)
      } catch (error) {
        if (abortController.signal.aborted) {
          cancelled = true
          next = scanner.cancelBatchExtractQueue(queue)
          break
        }
        errors.push(`第 ${chapter} 章：${toErrorMessage(error)}`)
        next = scanner.failBatchChapter(queue, chapter, toErrorMessage(error))
      }
      await checkpoint(next)
      queue = next
      publish(chapter)
    }
  } catch (error) {
    // 观察者/意外错误：未处理 pending 一律 failed（abort 时留给 cancel 通道），不假报成功。
    const reason = toErrorMessage(error)
    errors.push(reason)
    if (!abortController.signal.aborted) {
      for (const draft of queue.drafts) {
        if (draft.status === "pending") queue = scanner.failBatchChapter(queue, draft.chapter, reason)
      }
    }
  } finally {
    if (abortController.signal.aborted) cancelled = true
    queue = cancelled ? scanner.cancelBatchExtractQueue(queue) : scanner.finishBatchExtractQueue(queue)
    if (!persistenceError) {
      try {
        await checkpoint(queue)
      } catch (error) {
        errors.push(toErrorMessage(error))
      }
    }
    if (persistenceError) {
      const last = batchDraftLedgers.get(projectPath)
      if (last?.status === "running" || last?.status === "idle") {
        batchDraftLedgers.set(projectPath, scanner.cancelBatchExtractQueue(last))
      }
    }
    if (input.signal) input.signal.removeEventListener("abort", forwardAbort)
    activeBatchProject = null
  }

  if (persistenceError) {
    useImportProgressStore.getState().finishTask(taskId, "error", { message: persistenceError.message })
    throw persistenceError
  }

  const { completed, failed } = queue
  const doneMessage = cancelled
    ? `已取消批量提取，已完成 ${completed}/${total} 章（草稿待 accept）。`
    : ledger.exhausted
      ? `批量提取完成：成功 ${completed} 章，失败 ${failed} 章；预算 ${ledger.budget} 章，超限 ${ledger.skipped} 章已记账跳过。`
      : `批量提取完成：成功 ${completed} 章，失败 ${failed} 章（草稿待 accept）。`
  useImportProgressStore.getState().finishTask(taskId, cancelled ? "cancelled" : failed > 0 ? "error" : "done", {
    completed: queue.completed + queue.failed,
    total,
    currentTitle: "",
    message: doneMessage,
  })
  input.onProgress?.({ completed: queue.completed + queue.failed, total, currentChapter: null, message: doneMessage })

  return {
    taskId,
    admitted: plan.admitted,
    skippedByBudget: plan.skippedByBudget,
    ledger,
    drafts: queue.drafts,
    completed,
    failed,
    cancelled,
    errors,
  }
}

/**
 * accept 回填（阶段 2：草稿 → 正式记忆）。
 *
 * 只处理 `ready` 草稿；逐章 `commitPreparedChapterIngest`（正式回填出口，引擎既有函数），
 * 仅回读并保存凭证后标为 accepted；正式写入之前的异常保留草稿，中断不自动重放。
 */
export async function acceptBatchExtractionDrafts(input: {
  projectPath: string
  chapters?: readonly number[]
  expectedQueue?: BatchExtractQueueState
}): Promise<{ accepted: number[]; failed: Array<{ chapter: number; error: string }>; outcomes: BatchAcceptOutcome[] }> {
  const projectPath = batchProjectKey(input.projectPath)
  const scanner = await import("@/lib/novel/snapshot-scanner")
  const accepted: number[] = []
  const failed: Array<{ chapter: number; error: string }> = []
  const outcomes: BatchAcceptOutcome[] = []
  let queue = await restoreBatchExtractQueue(projectPath)
  if (activeBatchProject !== null) {
    throw new Error("Batch extraction or acceptance already in progress; only one project can run a batch at a time")
  }
  if (input.expectedQueue && input.expectedQueue !== queue) throw new Error("The batch changed; review the current drafts before accepting")
  if (!queue) return { accepted, failed, outcomes }
  const ready = queue.drafts.filter(draft => draft.status === "ready" && (!input.chapters || input.chapters.includes(draft.chapter)))
  if (!ready.length) return { accepted, failed, outcomes }
  activeBatchProject = projectPath
  try {
    const { commitPreparedChapterIngest } = await import("@/lib/novel/chapter-ingest")
    for (const draft of ready) {
      const chapter = draft.chapter
      const path = draft.source?.readPath ?? ""
      const previous = queue
      let reservation: BatchExtractQueueState | undefined
      let next: BatchExtractQueueState
      let ingest: IngestResult | undefined
      try {
        if (!draft.snapshot || !draft.source) throw new Error("Draft has no source binding; extract it again")
        ingest = await commitPreparedChapterIngest(projectPath, { source: draft.source, snapshot: draft.snapshot }, async () => {
          const interrupted = {
            path, chapterNumber: chapter, status: "uncertain" as const,
            reason: "Acceptance interrupted; inspect the chapter's current snapshot and memory before continuing",
          }
          const reserved = scanner.recordBatchAcceptIssue(previous, chapter, interrupted, "uncertain")
          // 只在磁盘先记中断边界；进行中不向界面显示终态。
          await persistBatchExtractQueue(reserved, false)
          reservation = reserved
        })
        if (!ingest.snapshot) throw new Error(ingest.failReason ?? "empty_ingest_result")
        const evidence = await verifyRebuildOutcome(projectPath, { path, chapterNumber: chapter }, ingest)
        const outcome = { path, chapterNumber: chapter, status: "verified" as const, ...evidence }
        next = scanner.acceptBatchDraft(queue, chapter, undefined, outcome)
        accepted.push(chapter)
        outcomes.push(outcome)
      } catch (err) {
        const reason = toErrorMessage(err)
        const status = !ingest && reservation ? "uncertain"
          : ingest?.snapshot || !draft.source || !draft.snapshot || ingest?.failReason === "source_changed"
            || ingest?.failReason === "not_final" || ingest?.failReason === "not_chapter" || ingest?.failReason === "invalid_chapter_number"
            ? "failed" : "ready"
        const outcome: BatchAcceptOutcome = status === "uncertain"
          ? { path, chapterNumber: chapter, status, reason }
          : { path, chapterNumber: chapter, status: "failed", reason, ...(ingest?.receipt && { receipt: ingest.receipt }), ...(ingest?.projectionReceipt && { projectionReceipt: ingest.projectionReceipt }) }
        next = scanner.recordBatchAcceptIssue(queue, chapter, outcome, status)
        failed.push({ chapter, error: reason })
        outcomes.push(outcome)
      }
      try {
        await persistBatchExtractQueue(next)
      } catch (error) {
        if (reservation) batchDraftLedgers.set(projectPath, reservation)
        throw new Error(`Acceptance outcome could not be saved; check the persisted chapter state: ${toErrorMessage(error)}`)
      }
      queue = next
    }
    return { accepted, failed, outcomes }
  } finally {
    activeBatchProject = null
  }
}
