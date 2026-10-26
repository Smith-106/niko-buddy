import { Suspense, lazy, useEffect, useCallback, useRef, useMemo, useState, useLayoutEffect } from "react"
import { useTranslation } from "react-i18next"
import { Check } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveDefaultModel, isChapterPage, isFinalChapter, parseChapterMeta, updateChapterStatus, resolveReviewModel, buildDeAiRewriteMessages, acceptAllDeAiBatchDrafts, acceptDeAiBatchDraft, loadDeAiBatchState, rejectDeAiBatchDraft, runDeAiBatch, startOutlineIngestTask } from "@/lib/novel"
import type { DeAiBatchProgress, DeAiBatchSummary } from "@/lib/novel"
import type { FinalChapterSavePhase } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { deleteFile, fileExists, readFile, writeFileAtomic, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { restoreTrashItem } from "@/lib/trash"
import { formatOperationError } from "@/lib/format-operation-error"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { TrashPreview } from "@/components/layout/trash-preview"
import { parseFrontmatter } from "@/lib/frontmatter"
import { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { CognitionPanel } from "@/components/novel/cognition-panel"
import { PersonaCritiquePanel } from "@/components/novel/persona-critique-panel"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import {
  inferEditorMode, selectionTimeoutMessage, isChapterPath, isOutlinePath,
  getCanonicalChapterPath, extractChapterNumberFromMarkdown,
  normalizeChapterWriting, updateChapterHeading,
  getChapterTitleFromPath,
  collectRecentChapterFiles, DE_AI_SELECTION_TIMEOUT_MS, CHAPTER_TITLE_MIN_WIDTH_PX,
  CHAPTER_TITLE_RESTING_EXTRA_WIDTH_PX, CHAPTER_TITLE_EDITING_EXTRA_WIDTH_PX,
} from "./preview-panel-helpers"
import { getNextChatExpanded } from "./chat-layout"
import { DeAiPreviewDialog } from "@/components/novel/de-ai-preview-dialog"
import { DeAiBatchDialog } from "@/components/novel/de-ai-batch-dialog"
import { UnpackOutlineDialog } from "@/components/novel/unpack-outline-dialog"
import { TextTransformPreviewDialog } from "@/components/novel/text-transform-preview-dialog"
import { streamChat } from "@/lib/llm-client"
import { makeDefaultChapterTitle } from "@/lib/wiki-filename"
import { getPreviewContentContainerClass, shouldUseCompactChapterToolbar } from "@/lib/workspace-layout"
import { useOutlineGenerationStore, type OutlineGenerationTask } from "@/stores/outline-generation-store"
import { useImportProgressStore } from "@/stores/import-progress-store"
import {
  buildPolishSelectionMessages,
  rebuildChapterBody,
  replaceChapterBodySelection,
  replaceWholeChapterBody,
  splitChapterHeading,
  type ChapterBodySelection,
  type ChapterSelectionAction,
} from "@/lib/chapter-selection"
import { ChapterEmptyState } from "./chapter-empty-state"
import { ChapterToolbarHeader } from "./preview-chapter-toolbar"
import { toErrorMessage } from "@/lib/utils"

const SnapshotViewer = lazy(async () => {
  const mod = await import("@/components/novel/snapshot-viewer")
  return { default: mod.SnapshotViewer }
})


export function PreviewPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const selectedTrashItem = useWikiStore((s) => s.selectedTrashItem)
  const setSelectedTrashItem = useWikiStore((s) => s.setSelectedTrashItem)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const fileContent = useWikiStore((s) => s.fileContent)
  const novelMode = useWikiStore((s) => s.novelMode)
  const chatExpanded = useWikiStore((s) => s.chatExpanded)
  const setChatExpanded = useWikiStore((s) => s.setChatExpanded)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const pendingEditorHighlight = useWikiStore((s) => s.pendingEditorHighlight)
  const setPendingEditorHighlight = useWikiStore((s) => s.setPendingEditorHighlight)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const finalChapterSave = useWikiStore((s) => s.finalChapterSave)
  const setFinalChapterSave = useWikiStore((s) => s.setFinalChapterSave)
  const outlineTasks = useOutlineGenerationStore((s) => s.tasks)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isSavingFinal, setIsSavingFinal] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string>("")
  const [restoringTrash, setRestoringTrash] = useState(false)
  const [showSnapshot, setShowSnapshot] = useState(false)
  const [showOutlineSnapshot, setShowOutlineSnapshot] = useState(false)
  const [outlineSnapshotNumber, setOutlineSnapshotNumber] = useState<number | null>(null)
  const [outlineIngested, setOutlineIngested] = useState(false)
  const [showCognition, setShowCognition] = useState(false)
  const [showPersona, setShowPersona] = useState(false)
  const [deAiProcessing, setDeAiProcessing] = useState(false)
  const [deAiPreviewOpen, setDeAiPreviewOpen] = useState(false)
  // 选中文本去AI味/AI润色入口：防重入护栏 + deadline 控制器 + 取消（perf-fix-ds 前端侧）
  const [selectionActionPending, setSelectionActionPending] = useState(false)
  const selectionActionInFlightRef = useRef(false)
  const selectionActionAbortRef = useRef<AbortController | null>(null)
  const selectionActionTimedOutRef = useRef(false)
  const selectionActionFirstTokenRef = useRef(false)
  // Wave 4 (v2.5.0): 批量去AI味状态（进度 + 结果 + 中止引用）
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState<DeAiBatchProgress | null>(null)
  const [batchSummary, setBatchSummary] = useState<DeAiBatchSummary | null>(null)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [showUnpackOutlineDialog, setShowUnpackOutlineDialog] = useState(false)
  const [batchChapters, setBatchChapters] = useState<Array<{ chapterNumber: number; status: string; lastError?: string; selfCheckSummary?: string }>>([])
  const batchAbortRef = useRef<AbortController | null>(null)
  const [deAiSourceContent, setDeAiSourceContent] = useState("")
  const [deAiCandidateContent, setDeAiCandidateContent] = useState("")
  const [selectionTransformOpen, setSelectionTransformOpen] = useState(false)
  const [selectionTransformAction, setSelectionTransformAction] = useState<ChapterSelectionAction | null>(null)
  const [selectionTransformSelection, setSelectionTransformSelection] = useState<ChapterBodySelection | null>(null)
  const [selectionTransformSourceContent, setSelectionTransformSourceContent] = useState("")
  const [selectionTransformCandidateContent, setSelectionTransformCandidateContent] = useState("")
  const [chapterTitleDraft, setChapterTitleDraft] = useState("")
  const [chapterTitleEditing, setChapterTitleEditing] = useState(false)
  const [chapterTitleWidthPx, setChapterTitleWidthPx] = useState(CHAPTER_TITLE_MIN_WIDTH_PX)
  const [chapterToolbarCompact, setChapterToolbarCompact] = useState(true)
  const [chapterToolbarMoreOpen, setChapterToolbarMoreOpen] = useState(false)
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null)
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")
  const fileContentRef = useRef(fileContent)
  const selectedFileRef = useRef<string | null>(selectedFile)
  const chapterToolbarRef = useRef<HTMLDivElement | null>(null)
  const titleMeasureRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    fileContentRef.current = fileContent
  }, [fileContent])

  const syncChapterToCanonicalPath = useCallback(async (path: string, markdown: string) => {
    const normalized = normalizeChapterWriting(markdown)
    const chapterNumber = extractChapterNumberFromMarkdown(normalized)
    const targetPath = await getCanonicalChapterPath(path, normalized, chapterNumber)

    await writeFileAtomic(targetPath, normalized)
    if (targetPath !== path) {
      await deleteFile(path)
      if (project) {
        try {
          const tree = await listDirectory(normalizePath(project.path))
          setFileTree(tree)
        } catch {
          // non-critical tree refresh
        }
      }
      if (useWikiStore.getState().selectedFile === path) {
        selectedFileRef.current = targetPath
        useWikiStore.getState().setSelectedFile(targetPath)
      }
    }

    if (useWikiStore.getState().selectedFile === targetPath) {
      setFileContent(normalized)
      fileContentRef.current = normalized
      lastLoadedRef.current = normalized
    }

    bumpDataVersion()
    return { targetPath, markdown: normalized }
  }, [project, setFileContent, setFileTree, bumpDataVersion])

  const flushChapterBeforeLeave = useCallback(async (path: string | null, markdown: string) => {
    /* v8 ignore next */
    if (!path || !isChapterPath(path)) return
    if (finalChapterSave?.saving && finalChapterSave.filePath === path) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (markdown === lastLoadedRef.current) return
    try {
      await syncChapterToCanonicalPath(path, markdown)
    } catch (err) {
      console.error("切换章节前同步文件失败:", err)
    }
  }, [syncChapterToCanonicalPath, finalChapterSave])

  // ui-audit-20261016 P1-02（W-02）：角色认知 / 多视角点评是 absolute inset-0 的
  // 全屏遮罩，旧版除了面板自己的关闭钮没有任何退路（无 Esc、无遮罩点击）。
  // 这里统一接管 Esc：先关上层（人格点评），再关认知面板。
  useEffect(() => {
    if (!showCognition && !showPersona) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      if (showPersona) {
        setShowPersona(false)
        return
      }
      setShowCognition(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [showCognition, showPersona])

  useEffect(() => {
    let cancelled = false
    const previousFile = selectedFileRef.current
    const previousContent = fileContentRef.current
    if (previousFile && previousFile !== selectedFile && isChapterPath(previousFile)) {
      void flushChapterBeforeLeave(previousFile, previousContent)
    }
    selectedFileRef.current = selectedFile
    setSelectionTransformOpen(false)
    setDeAiPreviewOpen(false)
    setLoadedFilePath(null)

    if (!selectedFile) {
      setFileContent("")
      fileContentRef.current = ""
      lastLoadedRef.current = ""
      setSaveStatus("")
      return () => {
        cancelled = true
      }
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category)) {
      setFileContent("")
      fileContentRef.current = ""
      lastLoadedRef.current = ""
      setSaveStatus("")
      setLoadedFilePath(selectedFile)
      return () => {
        cancelled = true
      }
    }

    setFileContent("")
    fileContentRef.current = ""
    lastLoadedRef.current = ""
    setSaveStatus("")

    readFile(selectedFile)
      .then((content) => {
        if (cancelled || useWikiStore.getState().selectedFile !== selectedFile) return
        lastLoadedRef.current = content
        setFileContent(content)
        setSaveStatus("")
        setLoadedFilePath(selectedFile)
      })
      .catch((err) => {
        if (cancelled || useWikiStore.getState().selectedFile !== selectedFile) return
        lastLoadedRef.current = ""
        // R4 共识（deepseek+glm high；glm+qwen critical）: 原先把错误文本写进 fileContent，
        // 编辑器再 emit → 1s 防抖自动保存会把 “Error loading file: …” 回写覆盖原文件（数据丢失）。
        // 正确做法：内容置空（与 lastLoadedRef 一致 ⇒ 不触发保存）+ 失败如实上报。
        setFileContent("")
        setSaveStatus(formatOperationError(t, err))
        setLoadedFilePath(selectedFile)
      })
    return () => {
      cancelled = true
    }
  }, [selectedFile, setFileContent, flushChapterBeforeLeave])

  useEffect(() => {
    return () => {
      const currentFile = selectedFileRef.current
      if (currentFile && isChapterPath(currentFile)) {
        void flushChapterBeforeLeave(currentFile, fileContentRef.current)
      }
    }
  }, [flushChapterBeforeLeave])

  // S4-R2：标签页隐藏/窗口关闭前刷出待保存的章节（防 1s 防抖窗口内丢稿）。
  // kill-9 级崩溃仍由 writeFileAtomic 的 temp+fsync+rename 原子性兜底。
  useEffect(() => {
    const flush = () => {
      const currentFile = selectedFileRef.current
      if (currentFile && isChapterPath(currentFile)) {
        void flushChapterBeforeLeave(currentFile, fileContentRef.current)
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [flushChapterBeforeLeave])

  const handleSave = useCallback(
    (markdown: string) => {
      /* v8 ignore next */
      if (!selectedFile) return
      const persistedMarkdown = isChapterPath(selectedFile)
        ? normalizeChapterWriting(markdown)
        : markdown
      setFileContent(markdown)
      fileContentRef.current = markdown
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (persistedMarkdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        writeFileAtomic(selectedFile, persistedMarkdown)
          .then(() => {
            // Our own write becomes the new "last loaded" — subsequent
            // re-emits from Milkdown that match this content must not
            // trigger another save.
            lastLoadedRef.current = persistedMarkdown
            bumpDataVersion()
          })
          .catch((err) => {
            // R4 共识（deepseek+glm；glm+qwen）: 写盘失败原先仅 console.error，用户以为已保存。
            setSaveStatus(formatOperationError(t, err))
          })
      }, 1000)
    },
    [selectedFile, setFileContent, bumpDataVersion]
  )

  const chapterFrontmatter = useMemo(() => {
    if (!selectedFile || getFileCategory(selectedFile) !== "markdown") return null
    const parsed = parseFrontmatter(fileContent)
    const fm = parsed.frontmatter as Record<string, unknown> | null
    if (!fm || !isChapterPage(fm)) return null
    return fm
  }, [fileContent, selectedFile])

  const canSaveAsFinal = Boolean(novelMode && project && selectedFile && chapterFrontmatter)
  const alreadyFinal = chapterFrontmatter ? isFinalChapter(chapterFrontmatter) : false
  const canFormatWriting = Boolean(selectedFile && getFileCategory(selectedFile) === "markdown" && isChapterPath(selectedFile))
  const canIngestOutline = Boolean(novelMode && project && selectedFile && getFileCategory(selectedFile) === "markdown" && isOutlinePath(selectedFile))
  const currentOutlineTask = useMemo(() => {
    if (!project || !selectedFile || !canIngestOutline) return null
    const normalizedSelectedFile = normalizePath(selectedFile)
    return outlineTasks
      .filter((task: OutlineGenerationTask) => (
        task.projectPath === project.path &&
        normalizePath(task.outlinePath ?? "") === normalizedSelectedFile &&
        (task.status === "ingesting" || task.status === "done" || task.status === "error")
      ))
      .sort((a: OutlineGenerationTask, b: OutlineGenerationTask) => b.updatedAt - a.updatedAt)[0] ?? null
  }, [canIngestOutline, outlineTasks, project, selectedFile])

  // 检测大纲是否已经提取过初始记忆（持久化状态）
  useEffect(() => {
    if (!canIngestOutline || !project || !selectedFile) {
      setOutlineIngested(false)
      setOutlineSnapshotNumber(null)
      return
    }
    const normalizedOutlinePath = normalizePath(selectedFile)
    /* v8 ignore next */
    const fileName = normalizedOutlinePath.split("/").pop() ?? "outline"
    const outlineName = fileName.replace(/\.\w+$/, "")
    let hash = 0
    for (let i = 0; i < outlineName.length; i++) {
      hash = ((hash << 5) - hash + outlineName.charCodeAt(i)) | 0
    }
    const outlineNum = -(Math.abs(hash % 999) + 1)
    setOutlineSnapshotNumber(outlineNum)
    const prefix = `outline-${String(Math.abs(outlineNum)).padStart(3, "0")}`
    const jsonPath = `${normalizePath(project.path)}/.novel/snapshots/${prefix}.snapshot.json`
    fileExists(jsonPath).then((exists) => setOutlineIngested(exists)).catch(() => setOutlineIngested(false))
  }, [canIngestOutline, project, selectedFile])
  useEffect(() => {
    if (!canIngestOutline) return
    if (!currentOutlineTask?.message) return
    setSaveStatus(currentOutlineTask.message)
  }, [canIngestOutline, currentOutlineTask])
  const chapterNumber = useMemo(() => {
    if (!chapterFrontmatter) return null
    const meta = parseChapterMeta(chapterFrontmatter)
    return meta?.chapterNumber ?? null
  }, [chapterFrontmatter])
  const canViewSnapshot = Boolean(novelMode && project && chapterNumber !== null)
  const currentFinalChapterSave = finalChapterSave != null && finalChapterSave.projectPath === project?.path && finalChapterSave.filePath === selectedFile ? finalChapterSave : null
  const isFinalChapterSaving = currentFinalChapterSave?.saving ?? isSavingFinal
  const isOutlineIngesting = currentOutlineTask?.status === "ingesting"

  // R4 共识（deepseek+glm）: 原 map 存的是**译文**，visibleSaveStatus 又对译文调 t(label, params)
  // ⇒ 二次翻译且 params 永远无法插值。改为存**键**，统一在 visibleSaveStatus 解析一次。
  // （末尾三条无对应键，保持硬编码中文；t(原文) 在键缺失时原样返回，行为不变。）
  const phaseLabelMap: Record<FinalChapterSavePhase, string> = {
    saving: "novel.chapter.savingAsFinal",
    reviewing: "novel.chapter.reviewInProgress",
    saved: "novel.chapter.savedAsFinal",
    reingesting: "novel.chapter.savingAsFinal",
    ingested: "novel.chapter.ingestSuccess",
    blocked_by_review: "novel.chapter.reviewBlockedWithErrors",
    ingest_failed: "novel.chapter.ingestFailedRetry",
    ingest_no_llm: "novel.chapter.ingestNoLlmKey",
    ingest_no_chapter_number: "章节已保存为正式章节，但快照生成失败：章节编号无效。请在章节2栏中重命名章节以修正编号。",
    ingest_not_final: "章节已保存为正式章节，但快照生成失败：章节状态异常，请检查章节是否正确标记为终稿。",
    ingest_extract_failed: "章节已保存为正式章节，但快照生成失败：LLM 生成超时或返回格式错误，请重试。",
    review_warnings: "novel.chapter.reviewWarningsButProceeding",
    review_failed_proceed: "novel.chapter.reviewFailedProceeding",
  }

  const visibleSaveStatus = (() => {
    if (!currentFinalChapterSave?.phase) return saveStatus
    const label = phaseLabelMap[currentFinalChapterSave.phase]
    const params = currentFinalChapterSave.params
    const result = t(label, (params ?? {}) as never)
    return typeof result === "string" ? result : saveStatus
  })()
  const chapterHeader = useMemo(() => {
    if (!selectedFile || !isChapterPath(selectedFile) || getFileCategory(selectedFile) !== "markdown") return null
    return buildChapterEditorHeader(fileContent)
  }, [fileContent, selectedFile])
  // 空态快捷入口：文件树投影，不触发新 IO
  const recentChapterFiles = useMemo(() => collectRecentChapterFiles(fileTree ?? []), [fileTree])
  const chapterDisplayTitle = chapterHeader
    ? chapterHeader.heading || (selectedFile ? getChapterTitleFromPath(selectedFile) : "") /* v8 ignore start */ /* v8 ignore stop */
    : ""
  const chapterTitleMeasureText = (() => {
    const text = chapterTitleEditing ? chapterTitleDraft : chapterDisplayTitle
    return text || chapterDisplayTitle || chapterTitleDraft || "\u00A0"
  })()
  const chapterStatusTitle = chapterHeader
    ? chapterHeader.status === "final"
      ? t("preview.canonStatusTitle")
      : chapterHeader.status === "revised"
        ? t("preview.revisedStatusTitle")
        : chapterHeader.status === "archived"
          ? t("preview.archivedStatusTitle")
          : t("preview.draftStatusTitle")
    : undefined
  const chapterStatusMeta = chapterHeader ? (
    chapterHeader.status === "final" ? (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/35 bg-success/10 px-2 py-0.5 text-xs font-medium leading-5 text-success"
        title={chapterStatusTitle}
      >
        <Check className="h-3 w-3 shrink-0" />
        <span>{chapterHeader.statusLabel}</span>
      </span>
    ) : chapterHeader.status === "draft" ? (
      <span
        className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-xs font-medium leading-5 text-muted-foreground"
        title={chapterStatusTitle}
      >
        {chapterHeader.statusLabel}
      </span>
    ) : (
      <span className="shrink-0 text-sm leading-5 text-muted-foreground" title={chapterStatusTitle}>
        {chapterHeader.statusLabel}
      </span>
    )
  ) : null
  const chapterWordCountMeta = chapterHeader ? (
    <span className="shrink-0 text-sm leading-5 text-muted-foreground">
      {chapterHeader.wordCountLabel}
    </span>
  ) : null
  const chapterMeta = chapterHeader ? (
    <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {chapterStatusMeta}
      {chapterWordCountMeta}
    </div>
  ) : null

  useEffect(() => {
    if (!chapterHeader) {
      setChapterTitleDraft("")
      setChapterTitleEditing(false)
      setChapterTitleWidthPx(CHAPTER_TITLE_MIN_WIDTH_PX)
      return
    }
    if (!chapterTitleEditing) {
      setChapterTitleDraft(chapterDisplayTitle)
    }
  }, [chapterDisplayTitle, chapterHeader, chapterTitleEditing])

  useLayoutEffect(() => {
    if (!chapterHeader) return
    const measure = titleMeasureRef.current
    if (!measure) return
    const measuredWidth = Math.ceil(measure.getBoundingClientRect().width)
    const extraWidth = chapterTitleEditing ? CHAPTER_TITLE_EDITING_EXTRA_WIDTH_PX : CHAPTER_TITLE_RESTING_EXTRA_WIDTH_PX
    const nextWidth = Math.max(measuredWidth + extraWidth, CHAPTER_TITLE_MIN_WIDTH_PX)
    setChapterTitleWidthPx((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth)
  }, [chapterHeader, chapterTitleEditing, chapterTitleMeasureText])

  useLayoutEffect(() => {
    const element = chapterToolbarRef.current
    if (!element) return

    const update = () => {
      setChapterToolbarCompact(shouldUseCompactChapterToolbar(element.getBoundingClientRect().width))
    }

    update()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update)
      return () => window.removeEventListener("resize", update)
    }

    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [chapterHeader, loadedFilePath, selectedFile])

  useEffect(() => {
    if (!chapterToolbarCompact) {
      setChapterToolbarMoreOpen(false)
    }
  }, [chapterToolbarCompact])

  const normalizeChapterTitleInput = useCallback((title: string) => {
    const trimmed = title.trim()
    if (chapterNumber !== null) {
      return makeDefaultChapterTitle(chapterNumber, trimmed)
    }
    return trimmed
  }, [chapterNumber])

  const commitChapterTitleDraft = useCallback(async () => {
    /* v8 ignore next */
    if (!selectedFile || !isChapterPath(selectedFile) || !chapterHeader) return
    const normalizedTitle = normalizeChapterTitleInput(chapterTitleDraft)
    const fallbackTitle = chapterDisplayTitle || (chapterNumber !== null ? makeDefaultChapterTitle(chapterNumber) : "")
    const nextTitle = normalizedTitle || fallbackTitle
    setChapterTitleDraft(nextTitle)
    setChapterTitleEditing(false)
    if (nextTitle === chapterDisplayTitle) return
    try {
      await syncChapterToCanonicalPath(selectedFile, updateChapterHeading(fileContent, nextTitle))
    } catch (error) {
      console.error("章节标题同步失败:", error)
    }
  }, [
    chapterHeader,
    chapterNumber,
    chapterDisplayTitle,
    chapterTitleDraft,
    fileContent,
    normalizeChapterTitleInput,
    selectedFile,
    syncChapterToCanonicalPath,
  ])

  const cancelChapterTitleEditing = useCallback(() => {
    setChapterTitleDraft(chapterDisplayTitle)
    setChapterTitleEditing(false)
  }, [chapterDisplayTitle])

  const handleSaveAsFinal = useCallback(async () => {
    /* v8 ignore next */
    if (!project || !selectedFile || !chapterFrontmatter) return

    let savePath = selectedFile
    const projectPath = project.path
    const updatePhase = (saving: boolean, phase: FinalChapterSavePhase | null, params?: Record<string, string | number>) => {
      /* v8 ignore next */
      setFinalChapterSave({ projectPath, filePath: savePath, saving, phase: phase ?? null, params })
    }

    setIsSavingFinal(true)
    updatePhase(true, "saving")

    const novelConfig = useWikiStore.getState().novelConfig

    if (novelConfig.reviewBeforeSave) {
      updatePhase(true, "reviewing")
      try {
        const chapterNumber = chapterFrontmatter.chapterNumber as number | undefined
        const { reviewChapter } = await import("@/lib/novel/review-adapter")
        const results = await reviewChapter(project.path, fileContent, chapterNumber)
        if (results.length > 0) {
          const reviewStore = useReviewStore.getState()
          reviewStore.addNovelReviewEntry({
            id: `chapter-${chapterNumber}-${Date.now()}`,
            chapterNumber: chapterNumber ?? 0,
            results,
            createdAt: new Date().toISOString(),
            resolved: false,
          })
        }
        const errors = results.filter(r => r.severity === "error")
        const warnings = results.filter(r => r.severity === "warning")

        if (errors.length > 0) {
          // 文案键 novel.chapter.reviewBlockedWithErrors 声明了 {{details}}，但此前唯一调用点
          // 只传 {count, warnings} → 具体问题清单永不出现，作者只看到一行 11px 灰字
          // （findings-2 W-08）。这里补上前 3 条可操作信息。
          const details = errors.slice(0, 3).map((r) => r.message).join("；")
          updatePhase(false, "blocked_by_review", { count: errors.length, warnings: warnings.length, details })
          setIsSavingFinal(false)
          return
        }

        if (warnings.length > 0) {
          updatePhase(true, "review_warnings", { count: warnings.length })
        }
      } catch {
        updatePhase(true, "review_failed_proceed")
      }
    }

    try {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      const updatedMarkdown = updateChapterStatus(fileContent, "final")
      const syncResult = await syncChapterToCanonicalPath(selectedFile, updatedMarkdown)
      const targetPath = syncResult.targetPath
      savePath = targetPath
      lastLoadedRef.current = syncResult.markdown
      setFileContent(syncResult.markdown)

      if (novelConfig.autoIngestOnSave) {
        const llmConfig = useWikiStore.getState().llmConfig
        if (!hasUsableLlm(llmConfig)) {
          updatePhase(false, "ingest_no_llm")
        } else {
          const verifyContent = await readFile(targetPath)
          const verifyParsed = parseFrontmatter(verifyContent)
          const verifyFm = verifyParsed.frontmatter as Record<string, unknown> | null
          if (!verifyFm || !isFinalChapter(verifyFm)) {
            await writeFileAtomic(targetPath, syncResult.markdown)
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          const chapterTitle = chapterFrontmatter?.title || `第${chapterFrontmatter?.chapterNumber || '?'}章`
          const ingestAbortController = new AbortController()
          const ingestTaskId = useImportProgressStore.getState().startTask({
            projectPath: project.path,
            kind: "chapter",
            total: 1,
            currentTitle: String(chapterTitle),
            message: "正在提取章节记忆",
            abortController: ingestAbortController,
          })
          const [{ ingestChapter }, { defaultCanonDualWriteDeps }] = await Promise.all([
            import("@/lib/novel/chapter-ingest"),
            import("@/lib/novel/canon-dual-write"),
          ])
          const result = await ingestChapter(project.path, targetPath, resolveReviewModel(), ingestAbortController.signal, {
            canonDualWriteDeps: defaultCanonDualWriteDeps(),
          })
          useImportProgressStore.getState().finishTask(ingestTaskId, result.snapshot ? "done" : "error", {
            completed: result.snapshot ? 1 : 0,
            total: 1,
            currentTitle: "",
            message: result.snapshot ? `${chapterTitle} 提取完成` : `${chapterTitle} 提取失败`,
          })
          if (result.snapshot) {
            updatePhase(false, "ingested", { chapter: result.snapshot.chapterNumber })
          } else if (result.failReason === "invalid_chapter_number") {
            updatePhase(false, "ingest_no_chapter_number")
          } else if (result.failReason === "not_final") {
            updatePhase(false, "ingest_not_final")
          } else if (result.failReason === "extract_failed") {
            updatePhase(false, "ingest_extract_failed")
          } else {
            updatePhase(false, "ingest_failed")
          }
        }
      } else {
        updatePhase(false, "saved")
      }
    } catch (error) {
      const message = toErrorMessage(error)
      updatePhase(false, "ingest_failed", { message: `快照提取异常: ${message.slice(0, 100)}` })
      console.error("[preview-panel] ingest failed:", toErrorMessage(error))
    } finally {
      setIsSavingFinal(false)
    }
  }, [chapterFrontmatter, fileContent, project, selectedFile, setFileContent, setFinalChapterSave, t, syncChapterToCanonicalPath])

  const handleReingest = useCallback(async () => {
    /* v8 ignore next */
    if (!project || !selectedFile || !chapterFrontmatter) return
    if (!isFinalChapter(chapterFrontmatter)) {
      setSaveStatus(t("novel.chapter.reingestNotFinal"))
      return
    }
    const projectPath = project.path
    const filePath = selectedFile
    const updatePhase = (saving: boolean, phase: FinalChapterSavePhase | null, params?: Record<string, string | number>) => {
      /* v8 ignore next */
      setFinalChapterSave({ projectPath, filePath, saving, phase: phase ?? null, params })
    }

    setIsSavingFinal(true)
    updatePhase(true, "reingesting")
    setSaveStatus("")
    const chapterTitle = chapterFrontmatter?.title || `第${chapterFrontmatter?.chapterNumber || '?'}章`
    const ingestAbortController = new AbortController()
    const ingestTaskId = useImportProgressStore.getState().startTask({
      projectPath: projectPath,
      kind: "chapter",
      total: 1,
      currentTitle: String(chapterTitle),
      message: "正在重新提取章节记忆",
      abortController: ingestAbortController,
    })
    try {
      const [{ ingestChapter }, { defaultCanonDualWriteDeps }] = await Promise.all([
        import("@/lib/novel/chapter-ingest"),
        import("@/lib/novel/canon-dual-write"),
      ])
      const result = await ingestChapter(projectPath, filePath, resolveReviewModel(), ingestAbortController.signal, {
        canonDualWriteDeps: defaultCanonDualWriteDeps(),
      })
      useImportProgressStore.getState().finishTask(ingestTaskId, result.snapshot ? "done" : "error", {
        completed: result.snapshot ? 1 : 0,
        total: 1,
        currentTitle: "",
        message: result.snapshot ? `${chapterTitle} 提取完成` : `${chapterTitle} 提取失败`,
      })
      if (result.snapshot) {
        updatePhase(false, "ingested", { chapter: result.snapshot.chapterNumber })
      } else if (result.failReason === "invalid_chapter_number") {
        updatePhase(false, "ingest_no_chapter_number")
      } else {
        updatePhase(false, "ingest_failed")
      }
    } catch (error) {
      const message = toErrorMessage(error)
      useImportProgressStore.getState().finishTask(ingestTaskId, "error", {
        completed: 0,
        total: 1,
        currentTitle: "",
        message: `${chapterTitle} 提取失败`,
      })
      updatePhase(false, "ingest_failed", { message: message.slice(0, 100) })
    } finally {
      setIsSavingFinal(false)
    }
  }, [chapterFrontmatter, project, selectedFile, setFinalChapterSave, t])

  const handleFormatWriting = useCallback(async () => {
    /* v8 ignore next */
    if (!selectedFile || !canFormatWriting) return
    const formatted = normalizeChapterWriting(fileContent)
    setFileContent(formatted)
    lastLoadedRef.current = formatted
    try {
      await writeFileAtomic(selectedFile, formatted)
      bumpDataVersion()
    } catch (err) {
      console.error("格式化写作内容失败:", err)
    }
  }, [canFormatWriting, fileContent, selectedFile, setFileContent, bumpDataVersion])

  const handleIngestOutline = useCallback(() => {
    /* v8 ignore next */
    if (!project || !selectedFile || !canIngestOutline || isOutlineIngesting) return
    setSaveStatus("")
    startOutlineIngestTask(project.path, selectedFile)
  }, [canIngestOutline, isOutlineIngesting, project, selectedFile])

  const handleDeAiProcess = useCallback(async () => {
    if (!fileContent.trim()) return
    setDeAiProcessing(true)
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      setDeAiProcessing(false)
      return
    }
    const { loadSmartDeAiSkill } = await import("@/lib/novel/de-ai-adapter")
    let customDeAiSkill: string | null = null
    try {
      customDeAiSkill = await loadSmartDeAiSkill(project?.path ?? null, "去AI味润色", undefined)
    } catch (err) {
      // R4 共识（deepseek+glm high）: 原 await 在 try 外 ⇒ 失败后 deAiProcessing 永久为 true
      //（按钮卡在“处理中”）且形成未处理 rejection。
      setSaveStatus(formatOperationError(t, err))
      setDeAiProcessing(false)
      return
    }
    const source = fileContent
    const sourceFile = selectedFileRef.current
    let result = ""
    try {
      await streamChat(
        llmConfig,
        buildDeAiRewriteMessages(source, customDeAiSkill || undefined),
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => {
            // R4 共识（deepseek+qwen high）: 缺文件切换守卫 ⇒ 切章后旧流仍会打开预览对话框。
            if (selectedFileRef.current !== sourceFile) {
              setDeAiProcessing(false)
              return
            }
            setDeAiSourceContent(source)
            setDeAiCandidateContent(result)
            setDeAiPreviewOpen(true)
            setDeAiProcessing(false)
          },
          onError: (error) => {
            console.error("去AI味处理失败:", toErrorMessage(error))
            setDeAiProcessing(false)
          },
        },
      )
    } catch (err) {
      console.error("去AI味处理失败:", toErrorMessage(err))
      setDeAiProcessing(false)
    }
  }, [fileContent])

  // Wave 4 (v2.5.0): 批量去AI味 — 一键全书 + 进度 + 结果回填（lib API 纯薄壳）
  const refreshBatchChapters = useCallback(async () => {
    if (!project) return
    const state = await loadDeAiBatchState(project.path)
    if (!state) return
    setBatchChapters(
      Object.entries(state.perChapter).map(([key, chapter]) => ({
        chapterNumber: Number(key),
        status: chapter.status,
        lastError: chapter.lastError,
        selfCheckSummary: chapter.selfCheckSummary,
      })),
    )
  }, [project])

  const handleDeAiBatchStart = useCallback(async () => {
    if (!project) return
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      setSaveStatus("未配置可用的 AI 模型，无法批量去AI味")
      return
    }
    const controller = new AbortController()
    batchAbortRef.current = controller
    setBatchRunning(true)
    setBatchProgress(null)
    setBatchSummary(null)
    setBatchDialogOpen(true)
    setSaveStatus("批量去AI味处理中...")
    try {
      const summary = await runDeAiBatch(project.path, {
        llmConfig,
        onProgress: (progress) => setBatchProgress(progress),
        signal: controller.signal,
      })
      setBatchSummary(summary)
      await refreshBatchChapters()
      setSaveStatus(
        summary.phase === "paused"
          ? `批量去AI味已中止（完成 ${summary.processed} 章）`
          : `批量去AI味完成：${summary.processed} 章成功，${summary.failed.length} 章失败，${summary.skipped} 章跳过`,
      )
    } catch (error) {
      setSaveStatus(formatOperationError(t, error))
    } finally {
      setBatchRunning(false)
      batchAbortRef.current = null
    }
  }, [project, refreshBatchChapters, t])

  const handleDeAiBatchCancel = useCallback(() => {
    batchAbortRef.current?.abort()
  }, [])

  const handleDeAiBatchAcceptAll = useCallback(async () => {
    if (!project) return
    // R4 共识（deepseek+glm；glm+qwen）: 原无 try/catch 且调用方以 void 丢弃 ⇒ 未处理 rejection、
    // 失败时用户看不到任何反馈。
    try {
      const result = await acceptAllDeAiBatchDrafts(project.path)
      setSaveStatus(`批量回填完成：${result.accepted} 章已写回，${result.skipped} 章跳过`)
      await refreshBatchChapters()
      bumpDataVersion()
    } catch (err) {
      setSaveStatus(formatOperationError(t, err))
    }
  }, [project, refreshBatchChapters, bumpDataVersion, t])

  const handleDeAiBatchAcceptChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    const ok = await acceptDeAiBatchDraft(project.path, chapterNumber)
    setSaveStatus(ok ? `第 ${chapterNumber} 章已回填` : `第 ${chapterNumber} 章回填失败`)
    await refreshBatchChapters()
    bumpDataVersion()
  }, [project, refreshBatchChapters, bumpDataVersion])

  const handleDeAiBatchRejectChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    const ok = await rejectDeAiBatchDraft(project.path, chapterNumber)
    setSaveStatus(ok ? `第 ${chapterNumber} 章已拒绝` : `第 ${chapterNumber} 章拒绝失败`)
    await refreshBatchChapters()
  }, [project, refreshBatchChapters])

  const handleDeAiBatchClose = useCallback(() => {
    setBatchDialogOpen(false)
  }, [])

  const handleDeAiApply = useCallback(() => {
    setDeAiPreviewOpen(false)
    handleSave(replaceWholeChapterBody(fileContent, deAiCandidateContent))
  }, [deAiCandidateContent, fileContent, handleSave])

  const handleDeAiSaveDraft = useCallback(async () => {
    if (!selectedFile || !project) return
    const normalizedPath = selectedFile.replace(/\\/g, "/")
    const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/") + 1)
    const fileName = normalizedPath.split("/").pop() || "file" /* v8 ignore start */ /* v8 ignore stop */
    const baseName = fileName.replace(/\.md$/, "")
    const draftPath = normalizePath(`${dir}${baseName}-去AI味稿.md`)
    try {
      await writeFileAtomic(draftPath, deAiCandidateContent)
      const tree = await listDirectory(normalizePath(project.path))
      setFileTree(tree)
      bumpDataVersion()
      setDeAiPreviewOpen(false)
    } catch (err) {
      console.error("另存去AI味草稿失败:", err)
    }
  }, [selectedFile, project, deAiCandidateContent, setFileTree, bumpDataVersion])

  const handleDeAiClose = useCallback(() => {
    setDeAiPreviewOpen(false)
  }, [])

  const handleSelectionActionCancel = useCallback(() => {
    selectionActionAbortRef.current?.abort()
  }, [])

  const handleSelectionAction = useCallback(async (action: ChapterSelectionAction, selection: ChapterBodySelection) => {
    if (!selection.text.trim()) return
    // 防重入：处理中直接忽略二次触发（浮动工具栏按钮 disabled 为 UX 强化）
    if (selectionActionInFlightRef.current) return
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      setSaveStatus("未配置可用的 AI 模型，无法处理选中文本")
      return
    }

    const actionFile = selectedFileRef.current
    const actionLabel = action === "polish" ? "AI润色" : "去AI味"

    selectionActionInFlightRef.current = true
    setSelectionActionPending(true)
    setSaveStatus(`正在调用模型，${actionLabel}中…`)

    const { loadSmartDeAiSkill } = await import("@/lib/novel/de-ai-adapter")
    let customDeAiSkill: string | null = null
    try {
      customDeAiSkill = await loadSmartDeAiSkill(
        project?.path ?? null,
        action === "de-ai" ? "去AI味" : "润色",
        undefined
      )
    } catch (err) {
      // R4 共识（deepseek+glm high）: 原 await 在 try 外 ⇒ selectionActionPending 卡死 +
      // 未处理 rejection。
      setSaveStatus(formatOperationError(t, err))
      selectionActionInFlightRef.current = false
      setSelectionActionPending(false)
      return
    }

    const controller = new AbortController()
    selectionActionAbortRef.current = controller
    selectionActionTimedOutRef.current = false
    selectionActionFirstTokenRef.current = false
    const deadline = setTimeout(() => {
      selectionActionTimedOutRef.current = true
      controller.abort()
    }, DE_AI_SELECTION_TIMEOUT_MS)

    let result = ""
    try {
      await streamChat(
        llmConfig,
        action === "polish"
          ? buildPolishSelectionMessages(selection.text)
          : buildDeAiRewriteMessages(selection.text, customDeAiSkill || undefined),
        {
          onToken: (token) => {
            result += token
            if (!selectionActionFirstTokenRef.current) {
              selectionActionFirstTokenRef.current = true
              setSaveStatus(`正在生成${actionLabel}结果…`)
            }
          },
          onDone: () => {
            clearTimeout(deadline)
            if (selectedFileRef.current !== actionFile) return
            if (controller.signal.aborted) {
              setSaveStatus(
                selectionActionTimedOutRef.current
                  ? selectionTimeoutMessage(actionLabel, selectionActionFirstTokenRef.current)
                  : `${actionLabel}已取消`,
              )
              return
            }
            setSelectionTransformAction(action)
            setSelectionTransformSelection(selection)
            setSelectionTransformSourceContent(selection.text)
            setSelectionTransformCandidateContent(result)
            setSelectionTransformOpen(true)
            setSaveStatus("")
          },
          onError: (error) => {
            clearTimeout(deadline)
            if (selectedFileRef.current !== actionFile) return
            // F-16 (CWE-532 / PAT-DC1-MSG-UI): err.message from the LLM transport may
            // carry provider endpoint URL / auth header — strip before surfacing in
            // the saveStatus UI. Raw message logged to console only.
            // (Twin of ingest.ts activity sites; PAT-G2 console-sanitized but UI-twin
            // missed — both onError and catch paths now strip.)
            const raw = toErrorMessage(error)
            console.error(`${actionLabel}失败:`, raw)
            const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
            setSaveStatus(`${actionLabel}失败：${safe}`)
          },
        },
        controller.signal,
      )
    } catch (err) {
      // F-16 (CWE-532 / PAT-DC1-MSG-UI): catch-path twin of onError above.
      clearTimeout(deadline)
      const message = toErrorMessage(err)
      const safe = message.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
      if (selectedFileRef.current !== actionFile) return
      console.error(`${actionLabel}失败:`, message)
      setSaveStatus(`${actionLabel}失败：${safe}`)
    } finally {
      clearTimeout(deadline)
      selectionActionAbortRef.current = null
      selectionActionInFlightRef.current = false
      setSelectionActionPending(false)
    }
  }, [project])

  const handleApplySelectionTransform = useCallback(() => {
    if (!selectionTransformSelection || !selectionTransformCandidateContent) return

    const { rawBlock, body } = parseFrontmatter(fileContent)
    const { heading, body: currentBody } = splitChapterHeading(body)
    const replaced = replaceChapterBodySelection(
      currentBody,
      selectionTransformSelection,
      selectionTransformCandidateContent,
    )

    if (!replaced.ok) {
      setSelectionTransformOpen(false)
      setSaveStatus("正文内容已变化，请重新选中文本后再试")
      return
    }

    handleSave(rawBlock + rebuildChapterBody(heading, replaced.body))
    setSelectionTransformOpen(false)
    setSelectionTransformAction(null)
    setSelectionTransformSelection(null)
    setSelectionTransformSourceContent("")
    setSelectionTransformCandidateContent("")
    setSaveStatus("")
  }, [fileContent, handleSave, selectionTransformCandidateContent, selectionTransformSelection])

  const handleCloseSelectionTransform = useCallback(() => {
    setSelectionTransformOpen(false)
    setSelectionTransformAction(null)
    setSelectionTransformSelection(null)
    setSelectionTransformSourceContent("")
    setSelectionTransformCandidateContent("")
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  async function handleRestoreTrash() {
    if (!project || !selectedTrashItem || restoringTrash) return
    setRestoringTrash(true)
    try {
      const pp = normalizePath(project.path)
      const result = await restoreTrashItem(pp, selectedTrashItem.id)
      try {
        setFileTree(await listDirectory(pp))
      } catch {
        // 目录刷新失败不阻断已完成的恢复
      }
      bumpDataVersion()
      setSelectedTrashItem(null)
      if (result.item.kind !== "history") {
        setActiveView("wiki")
        setSelectedFile(result.restoredPath)
      }
    } catch (err) {
      console.error("[PreviewPanel] restore failed:", err)
    } finally {
      setRestoringTrash(false)
    }
  }

  // Check if we're showing a trash item
  if (selectedTrashItem) {
    const category = getFileCategory(selectedTrashItem.originalPath)
    const trashPreviewBody = category === "markdown"
      ? parseFrontmatter(fileContent).body
      : fileContent
    return (
      <TrashPreview
        item={selectedTrashItem}
        body={trashPreviewBody}
        fileContent={fileContent}
        category={category}
        restoring={restoringTrash}
        canRestore={Boolean(project)}
        onRestore={() => void handleRestoreTrash()}
        onClose={() => setSelectedTrashItem(null)}
        t={t}
      />
    )
  }

  if (!selectedFile) {
    return (
      <ChapterEmptyState
        recentChapters={recentChapterFiles}
        onSelectChapter={(path) => setSelectedFile(path)}
      />
    )
  }

  const category = getFileCategory(selectedFile)
  const isSelectedChapter = isChapterPath(selectedFile)
  const activeHighlightRequest = pendingEditorHighlight?.path === selectedFile ? pendingEditorHighlight : null
  const hasChapterToolbarActions = Boolean(
    chapterHeader ||
    canIngestOutline ||
    canSaveAsFinal ||
    canFormatWriting ||
    canViewSnapshot ||
    (novelMode && project)
  )

  if (loadedFilePath !== selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("preview.loading", { defaultValue: "正在加载..." })}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ChapterToolbarHeader
        toolbarRef={chapterToolbarRef}
        titleMeasureRef={titleMeasureRef}
        chapterHeader={chapterHeader}
        chapterTitleDraft={chapterTitleDraft}
        chapterDisplayTitle={chapterDisplayTitle}
        chapterTitleMeasureText={chapterTitleMeasureText}
        chapterTitleWidthPx={chapterTitleWidthPx}
        chapterToolbarCompact={chapterToolbarCompact}
        chapterMeta={chapterMeta}
        hasChapterToolbarActions={hasChapterToolbarActions}
        chapterToolbarMoreOpen={chapterToolbarMoreOpen}
        onToggleMoreOpen={() => setChapterToolbarMoreOpen((open) => !open)}
        onCloseMoreMenu={() => setChapterToolbarMoreOpen(false)}
        chatExpanded={chatExpanded}
        onToggleChat={() => setChatExpanded(getNextChatExpanded(chatExpanded))}
        deAiProcessing={deAiProcessing}
        onDeAiProcess={() => void handleDeAiProcess()}
        hasProject={Boolean(project)}
        batchRunning={batchRunning}
        onDeAiBatchStart={() => void handleDeAiBatchStart()}
        canIngestOutline={canIngestOutline}
        onIngestOutline={() => handleIngestOutline()}
        isOutlineIngesting={isOutlineIngesting}
        outlineIngested={outlineIngested}
        onOpenUnpackOutline={() => setShowUnpackOutlineDialog(true)}
        outlineSnapshotNumber={outlineSnapshotNumber}
        onShowOutlineSnapshot={() => setShowOutlineSnapshot(true)}
        canSaveAsFinal={canSaveAsFinal}
        alreadyFinal={alreadyFinal}
        onSaveAsFinal={() => void handleSaveAsFinal()}
        onReingest={() => void handleReingest()}
        isFinalChapterSaving={isFinalChapterSaving}
        canFormatWriting={canFormatWriting}
        onFormatWriting={() => void handleFormatWriting()}
        canViewSnapshot={canViewSnapshot}
        onShowSnapshot={() => setShowSnapshot(true)}
        novelMode={novelMode}
        onShowCognition={() => setShowCognition(true)}
        onShowPersona={() => setShowPersona(true)}
        onClosePreview={() => setSelectedFile(null)}
        onTitleFocus={() => {
          setChapterTitleEditing(true)
          setChapterTitleDraft(chapterDisplayTitle)
        }}
        onTitleChange={(value) => setChapterTitleDraft(value)}
        onTitleCommit={() => void commitChapterTitleDraft()}
        onTitleCancel={() => cancelChapterTitleEditing()}
        visibleSaveStatus={visibleSaveStatus}
        selectionActionPending={selectionActionPending}
        onCancelSelectionAction={handleSelectionActionCancel}
        showInspector={Boolean(isSelectedChapter && project)}
        inspectorProjectPath={project?.path ?? ""}
        inspectorChapterId={selectedFile ?? ""}
        inspectorRefreshKey={fileContent}
      />
      <div className={getPreviewContentContainerClass(isSelectedChapter)}>
        {category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
            defaultMode={inferEditorMode(selectedFile)}
            immersiveWriting={isChapterPath(selectedFile)}
            onSelectionAction={isChapterPath(selectedFile) ? handleSelectionAction : undefined}
            selectionActionDisabled={selectionActionPending}
            highlightRequest={activeHighlightRequest}
            onHighlightHandled={() => {
              if (activeHighlightRequest) setPendingEditorHighlight(null)
            }}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
      {showSnapshot && project && chapterNumber !== null ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("common.loading")}</div>}>
          <SnapshotViewer
            projectPath={project.path}
            chapterNumber={chapterNumber}
            onClose={() => setShowSnapshot(false)}
          />
        </Suspense>
      ) : null}
      {showOutlineSnapshot && project && outlineSnapshotNumber !== null ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("common.loading")}</div>}>
          <SnapshotViewer
            projectPath={project.path}
            chapterNumber={outlineSnapshotNumber}
            onClose={() => setShowOutlineSnapshot(false)}
          />
        </Suspense>
      ) : null}
      {showCognition && project ? (
        <div className="absolute inset-0 z-20 bg-background" role="dialog" aria-modal="true" aria-label={t("preview.cognitionTitle")}>
          <CognitionPanel
            projectPath={project.path}
            onClose={() => setShowCognition(false)}
          />
        </div>
      ) : null}
      {showPersona && project ? (
        <div className="absolute inset-0 z-20 bg-background" role="dialog" aria-modal="true" aria-label={t("novel.persona.title")}>
          <PersonaCritiquePanel
            projectPath={project.path}
            onClose={() => setShowPersona(false)}
          />
        </div>
      ) : null}
      <DeAiPreviewDialog
        open={deAiPreviewOpen}
        sourceContent={deAiSourceContent}
        candidateContent={deAiCandidateContent}
        onApply={handleDeAiApply}
        onSaveDraft={() => void handleDeAiSaveDraft()}
        onClose={handleDeAiClose}
      />
      <DeAiBatchDialog
        open={batchDialogOpen}
        running={batchRunning}
        progress={batchProgress}
        summary={batchSummary}
        chapters={batchChapters}
        onCancel={handleDeAiBatchCancel}
        onAcceptAll={() => void handleDeAiBatchAcceptAll()}
        onAcceptChapter={(n) => void handleDeAiBatchAcceptChapter(n)}
        onRejectChapter={(n) => void handleDeAiBatchRejectChapter(n)}
        onClose={handleDeAiBatchClose}
      />
      <TextTransformPreviewDialog
        open={selectionTransformOpen}
        title={selectionTransformAction === "polish" ? t("preview.aiPolishPreview") : t("preview.deAiPreview")}
        description={t("preview.transformDesc")}
        sourceLabel={t("preview.sourceFragment")}
        candidateLabel={selectionTransformAction === "polish" ? t("preview.polishResult") : t("preview.deAiResult")}
        sourceContent={selectionTransformSourceContent}
        candidateContent={selectionTransformCandidateContent}
        applyLabel={t("preview.replaceSelection")}
        onApply={handleApplySelectionTransform}
        onClose={handleCloseSelectionTransform}
      />
      <UnpackOutlineDialog
        open={showUnpackOutlineDialog}
        onOpenChange={setShowUnpackOutlineDialog}
        outlineContent={fileContent}
      />
    </div>
  )
}
