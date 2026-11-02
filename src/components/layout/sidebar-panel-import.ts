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
  parseChapterMeta,
  runImportedChapterMemoryExtraction,
  resolveNovelModel,
} from "@/lib/novel"
import type { ImportedChapter } from "@/lib/novel"
// G3（TASK-004）：快照扫库/范围选择/队列的类型只做**类型位**引用（import(...) 类型查询，
// 编译期擦除，不产生静态依赖边）；运行时一律走动态 import（boundaries 门禁：app 层
// 不得静态深导入 novel 内部模块）。
export type BatchExtractDraft = import("@/lib/novel/snapshot-scanner").BatchExtractDraft
export type BatchExtractQueueState = import("@/lib/novel/snapshot-scanner").BatchExtractQueueState
export type BatchBudgetLedger = import("@/lib/novel/snapshot-scanner").BatchBudgetLedger
export type BatchExtractScopeMode = import("@/lib/novel/snapshot-scanner").BatchExtractScopeMode
export type BatchExtractScopeOptions = import("@/lib/novel/snapshot-scanner").BatchExtractScopeOptions
export type BatchExtractScopeSelection = import("@/lib/novel/snapshot-scanner").BatchExtractScopeSelection
export type BatchExtractBudgetPlan = import("@/lib/novel/snapshot-scanner").BatchExtractBudgetPlan
export type SnapshotScanResult = import("@/lib/novel/snapshot-scanner").SnapshotScanResult
import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
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
    // G3：批量提取复用同一 abort 通道（停止按钮 / 进度面板取消 → 同一出口）。
    cancelBatchMemoryExtraction()
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

// ──────────────────────────────────────────────────────────────────────────
// G3（TASK-004）：批量提取队列 —— 复用本文件 confirm/extract/abort/进度通道范式
// ──────────────────────────────────────────────────────────────────────────
//
// 与 confirmImportMemoryExtraction / handleCancelImportMemoryExtraction /
// extractImportedChapterMemories 同一套范式（本文件上方三个函数）：
//   确认（范围选择弹层）→ 建进度任务（startTask + abortController）→ 逐章提取并
//   updateTask 进度 → finishTask 收尾；取消走既有 abort（进度面板「停止」按钮
//   → useImportProgressStore.cancelTask → abortController.abort → 本模块 signal 短路）。
//
// Draft-first 硬边界（D5）：
//   * 提取阶段只调 `extractSnapshotWithLLM`（纯抽取，零正式写入），结果落在
//     `BatchExtractDraft` 草稿账本里，状态 pending → ready。
//   * **不**调 ingestChapter（引擎不动），**不**写 wiki/正式记忆。
//   * 只有 acceptBatchExtractionDrafts（人工 accept）才调 `syncSnapshotToMemory`
//     回填正式记忆 —— 与 snapshot-viewer 的「草稿快照 → accept 同步记忆」同一出口。

/** 批量提取在途 abort 控制器（模块级：弹层关闭后进度面板仍能取消）。 */
let activeBatchAbortController: AbortController | null = null

/** 批量提取草稿账本（按项目路径；accept 前只存在于内存，不进正式记忆）。 */
const batchDraftLedgers = new Map<string, BatchExtractQueueState>()

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
  const scan = await scanner.scanSnapshotBackfill(normalizePath(projectPath))
  const selection = scanner.resolveBatchExtractScope(scan, options)
  const plan = scanner.applyBatchExtractBudget(selection.chapters, options.budget)
  return { scan, selection, plan, ledger: scanner.buildBatchBudgetLedger(plan) }
}

/** 当前项目的批量提取草稿账本（无则 null）。 */
export function getBatchExtractQueue(projectPath: string): BatchExtractQueueState | null {
  return batchDraftLedgers.get(normalizePath(projectPath)) ?? null
}

/** 取消在途批量提取（走既有 abort 通道；已 ready 草稿保留可 accept）。 */
export function cancelBatchMemoryExtraction(): void {
  activeBatchAbortController?.abort()
  activeBatchAbortController = null
}

/**
 * 批量提取（阶段 1：extract → 草稿）。
 *
 * 逐章：定位章节文件 → extractSnapshotWithLLM（纯抽取）→ 草稿置 ready。
 * 超预算章号只记账（skippedByBudget），不发任何 LLM 请求。
 */
export async function runBatchMemoryExtraction(
  input: BatchExtractionRunInput,
): Promise<BatchExtractionRunResult> {
  const projectPath = normalizePath(input.projectPath)
  const scanner = await import("@/lib/novel/snapshot-scanner")
  const plan = scanner.applyBatchExtractBudget(input.chapters, input.budget)
  const ledger = scanner.buildBatchBudgetLedger(plan)
  let queue = scanner.createBatchExtractQueue({ projectPath, plan })
  batchDraftLedgers.set(projectPath, queue)

  const abortController = new AbortController()
  activeBatchAbortController = abortController
  if (input.signal) {
    if (input.signal.aborted) abortController.abort()
    else input.signal.addEventListener("abort", () => abortController.abort(), { once: true })
  }

  const total = plan.admitted.length
  const taskId = useImportProgressStore.getState().startTask({
    projectPath,
    kind: "chapter",
    total,
    currentTitle: "",
    message: ledger.exhausted
      ? `正在批量提取章节记忆（预算 ${ledger.budget} 章，超限 ${ledger.skipped} 章已记账跳过）`
      : "正在批量提取章节记忆",
    abortController,
  })

  const errors: string[] = []
  let completed = 0
  let failed = 0
  let cancelled = false

  const publish = (currentChapter: number | null, message?: string) => {
    useImportProgressStore.getState().updateTask(taskId, {
      completed: completed + failed,
      total,
      currentTitle: currentChapter === null ? "" : `第 ${currentChapter} 章`,
      message,
    })
    input.onProgress?.({ completed: completed + failed, total, currentChapter, message })
  }

  try {
    // 纯抽取（零正式写入）：只经受控延迟叶子 chapter-ingest 取 extractSnapshotWithLLM；
    // resolveNovelModel 走 barrel 静态公开面（已静态导入）。
    const { extractSnapshotWithLLM } = await import("@/lib/novel/chapter-ingest")
    const store = useWikiStore.getState()
    const llmConfig = resolveNovelModel(store.llmConfig, store.novelConfig, "extract")

    for (const chapter of plan.admitted) {
      if (abortController.signal.aborted) {
        cancelled = true
        break
      }
      publish(chapter)
      queue = scanner.startBatchChapter(queue, chapter)
      try {
        const chapterPath = await findChapterFileByNumber(projectPath, chapter)
        if (!chapterPath) {
          failed += 1
          errors.push(`第 ${chapter} 章：未找到章节文件`)
          queue = scanner.failBatchChapter(queue, chapter, "chapter_file_missing")
          continue
        }
        const content = await readFile(chapterPath)
        const { frontmatter, body } = parseFrontmatter(content)
        const chapterNumber = parseChapterMeta(frontmatter ?? {})?.chapterNumber ?? chapter
        if (!body.trim()) {
          failed += 1
          errors.push(`第 ${chapter} 章：正文为空`)
          queue = scanner.failBatchChapter(queue, chapter, "empty_chapter_body")
          continue
        }
        const snapshot = await extractSnapshotWithLLM(
          chapterNumber,
          body,
          llmConfig,
          abortController.signal,
        )
        if (!snapshot) {
          failed += 1
          errors.push(`第 ${chapter} 章：提取失败`)
          queue = scanner.failBatchChapter(queue, chapter, "extract_failed")
          continue
        }
        completed += 1
        // Draft-first：只落 ready 草稿，accept 才回填正式记忆。
        queue = scanner.completeBatchChapter(queue, chapter, snapshot)
        publish(chapter)
      } catch (error) {
        if (abortController.signal.aborted) {
          cancelled = true
          queue = scanner.cancelBatchExtractQueue(queue)
          break
        }
        failed += 1
        errors.push(`第 ${chapter} 章：${toErrorMessage(error)}`)
        queue = scanner.failBatchChapter(queue, chapter, toErrorMessage(error))
      }
    }
  } catch (error) {
    errors.push(toErrorMessage(error))
  } finally {
    if (abortController.signal.aborted) cancelled = true
    queue = cancelled ? scanner.cancelBatchExtractQueue(queue) : scanner.finishBatchExtractQueue(queue)
    batchDraftLedgers.set(projectPath, queue)
    activeBatchAbortController = null
  }

  const doneMessage = cancelled
    ? `已取消批量提取，已完成 ${completed}/${total} 章（草稿待 accept）。`
    : ledger.exhausted
      ? `批量提取完成：成功 ${completed} 章，失败 ${failed} 章；预算 ${ledger.budget} 章，超限 ${ledger.skipped} 章已记账跳过。`
      : `批量提取完成：成功 ${completed} 章，失败 ${failed} 章（草稿待 accept）。`
  useImportProgressStore.getState().finishTask(taskId, cancelled ? "cancelled" : failed > 0 ? "error" : "done", {
    completed: completed + failed,
    total,
    currentTitle: "",
    message: doneMessage,
  })
  input.onProgress?.({ completed: completed + failed, total, currentChapter: null, message: doneMessage })

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
 * 只处理 `ready` 草稿；逐章 `syncSnapshotToMemory`（正式回填出口，引擎既有函数），
 * 成功后才把草稿记账为 `accepted`。失败保留 ready 以便重试。
 */
export async function acceptBatchExtractionDrafts(input: {
  projectPath: string
  chapters?: readonly number[]
}): Promise<{ accepted: number[]; failed: Array<{ chapter: number; error: string }> }> {
  const projectPath = normalizePath(input.projectPath)
  const scanner = await import("@/lib/novel/snapshot-scanner")
  let queue = batchDraftLedgers.get(projectPath)
  if (!queue) return { accepted: [], failed: [] }

  const targets = input.chapters
    ? queue.drafts.filter((draft) => input.chapters?.includes(draft.chapter))
    : queue.drafts
  const ready = targets.filter((draft) => draft.status === "ready" && draft.snapshot)
  if (ready.length === 0) return { accepted: [], failed: [] }

  const { syncSnapshotToMemory } = await import("@/lib/novel/chapter-ingest")
  const accepted: number[] = []
  const failed: Array<{ chapter: number; error: string }> = []

  for (const draft of ready) {
    /* v8 ignore next -- ready 过滤已保证 snapshot 非空 */
    if (!draft.snapshot) continue
    try {
      await syncSnapshotToMemory(projectPath, draft.snapshot)
      queue = scanner.acceptBatchDraft(queue, draft.chapter)
      accepted.push(draft.chapter)
    } catch (error) {
      failed.push({ chapter: draft.chapter, error: toErrorMessage(error) })
    }
  }

  batchDraftLedgers.set(projectPath, queue)
  return { accepted, failed }
}
