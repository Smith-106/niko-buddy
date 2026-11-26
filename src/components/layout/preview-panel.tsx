import { Suspense, lazy, useEffect, useCallback, useRef, useMemo, useState, useLayoutEffect } from "react"
import type { MutableRefObject } from "react"
import { useTranslation } from "react-i18next"
import { Check } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveDefaultModel, isChapterPage, isFinalChapter, parseChapterMeta, updateChapterStatus, resolveReviewModel, buildDeAiRewriteMessages, acceptAllDeAiBatchDrafts, acceptDeAiBatchDraft, loadDeAiBatchState, rejectDeAiBatchDraft, runDeAiBatch, startOutlineIngestTask, DRAFT_FILENAME_SUFFIX, DEFAULT_DE_AI_MODE, readBackMemoryIngest, formatMemoryIngest, resolveNovelModel, verifyRebuildOutcome } from "@/lib/novel"
import type { DeAiBatchProgress, DeAiBatchSummary, DeAiMode, DeAiDetectResult, DeAiSpanApplyResult, DeAiEditError, VerifiedRebuildReceipt } from "@/lib/novel"
import type { FinalChapterSavePhase } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { deleteFile, fileExists, readFile, writeFileAtomic, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { toast } from "@/lib/toast"
import { restoreTrashItem } from "@/lib/trash"
import { formatOperationError } from "@/lib/format-operation-error"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { TrashPreview } from "@/components/layout/trash-preview"
import { parseFrontmatter } from "@/lib/frontmatter"
import { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { PreviewCognitionOverlays } from "./preview-cognition-overlays"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import {
  inferEditorMode, selectionTimeoutMessage, isChapterPath, isOutlinePath,
  getCanonicalChapterPath, extractChapterNumberFromMarkdown,
  normalizeChapterWriting, updateChapterHeading,
  getChapterTitleFromPath,
  collectRecentChapterFiles, DE_AI_SELECTION_TIMEOUT_MS, CHAPTER_TITLE_MIN_WIDTH_PX,
  CHAPTER_TITLE_RESTING_EXTRA_WIDTH_PX, CHAPTER_TITLE_EDITING_EXTRA_WIDTH_PX,
  getChapterWriteCoordinator, settleChapterRecoveryBodyWrite, settleChapterAdoptionRecoveryAfterRead, ChapterAdoptionUnavailableError,
  type ChapterAdoptionLease,
  type ChapterWriteFenceRefusal,
  type ChapterWriteIntent,
  type ChapterWriteRecovery,
  type ChapterTargetRelocation,
} from "./preview-panel-helpers"
import { getNextChatExpanded } from "./chat-layout"
import { DeAiPreviewDialog } from "@/components/novel/de-ai-preview-dialog"
import { DeAiBatchDialog } from "@/components/novel/de-ai-batch-dialog"
import { PreviewOutlineOverlays } from "./preview-outline-overlays"
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


export interface PreviewPanelWriteGateSnapshot {
  /** 被静默的编辑区文件（= 本次采纳写入的正式章）。 */
  path: string
  /** 采纳前编辑区里的正文（原样，未归一化），供采纳失败时保留未落盘内容。 */
  buffer: string
  /** 采纳前正在编辑的标题草稿与编辑态（未提交的标题输入不得丢）。 */
  titleDraft: string
  titleEditing: boolean
}

/**
 * `begin` 的受理结果：
 * - `idle`：采纳目标不是本编辑区正在显示的文件，不动编辑区（仍已在协调层登记栅栏）。
 * - `ready`：编辑区已让出旧输入并等完此前准入的真实 I/O，可以落正式采纳写入。
 * - `blocked`：同一目标已有采纳 lease 在途，本次采纳必须如实拒绝（不排队、不静默合并）。
 */
export type PreviewPanelAdoptionStart =
  | { status: "idle"; lease: ChapterAdoptionLease | null }
  | { status: "ready"; lease: ChapterAdoptionLease | null; snapshot: PreviewPanelWriteGateSnapshot }
  | { status: "blocked"; reason: "busy" | "cancelled" | "relocated"; relocation?: ChapterTargetRelocation }

/**
 * 采纳写入前的「同文件静默门」（G2 统一写入协议）。
 *
 * 采纳是盘上正文的权威写入：编辑区在这之前排队的防抖写盘、已经派发的
 * `write_file_atomic` 都必须先落定，否则旧缓冲可能在采纳之后落盘、把刚采纳的正文覆盖回去
 * （`fs.rs` 的临时文件 + fsync + rename 不提供写者之间的次序保证）。
 * 本门只管「同一个路径」这一件事：等的是该目标已准入 mutation 的整条 FIFO 尾链（不是单槽最后一笔），
 * 不做全局写队列、不新增状态权威。
 */
export interface PreviewPanelWriteGate {
  /** 正式采纳写入之前调用：同路径则让出编辑区并等全部在途写盘落定。 */
  begin(targetPath: string, owner?: object): Promise<PreviewPanelAdoptionStart>
  /**
   * 采纳没有确认落盘（accept 抛错等）：按归属释放 lease 并恢复可编辑输入。
   * 不自动把旧缓冲回写正式文件 —— throw 不证明此前零 I/O；新的一次用户保存/编辑意图才恢复写路径。
   */
  abort(start: PreviewPanelAdoptionStart): void
}

export interface PreviewPanelProps {
  /**
   * 采纳专用刷新令牌（G2-NATIVE-F1）。
   *
   * 草稿采纳成功时正式正文会写回**当前选中同一个文件**，此时 `selectedFile` 的
   * identity 不变，光靠「选中路径变化」触发的磁盘装载 effect 不会重跑，编辑区就停在
   * 采纳前的旧正文。令牌只是把这个「同路径、盘上正文已变」的事实显式表达一次：
   * 令牌 +1 且选中路径未变 ⇒ 重新读盘。它不参与任何别的刷新语义（不订阅 dataVersion、
   * 不作废未保存文本、不改变切文件与保存的既有路径）。
   */
  adoptionRefreshToken?: number
  /** 本次令牌指向的正式章路径，与 token 同批更新；不等于当前选中文件的令牌不重载。 */
  adoptionRefreshPath?: string
  /** 写作台注入的采纳写入门（挂载时登记）；缺省不注入，编辑区行为与原来一致。 */
  writeGateRef?: MutableRefObject<PreviewPanelWriteGate | null>
}

export function PreviewPanel({ adoptionRefreshToken = 0, adoptionRefreshPath = "", writeGateRef }: PreviewPanelProps) {
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
  const clearFinalChapterSaveForPath = useWikiStore((s) => s.clearFinalChapterSaveForPath)
  const outlineTasks = useOutlineGenerationStore((s) => s.tasks)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 统一写入协调器（同进程共享）：意图 / 实际 I/O 尾链 / 采纳栅栏 / lease 都在这里，
  // 不持有正文或状态权威。每个挂载实例用 owner 标识自己的采纳 lease。
  const writeCoordinator = getChapterWriteCoordinator()
  const writeOwnerRef = useRef<object>({})
  // 输入观察与已准入 I/O 的寿命分开；A/B 交错时每个 lease 都保留自己的快照归属。
  const mountedRef = useRef(true)
  const adoptionLeaseRef = useRef<ChapterAdoptionLease | null>(null)
  const adoptionStartsRef = useRef(new Map<ChapterAdoptionLease, {
    snapshot: PreviewPanelWriteGateSnapshot | null
    admittedTail: Promise<void>
    handedOff: boolean
  }>())
  const loadGenerationRef = useRef(0)
  const recoveredInputRef = useRef<ChapterWriteRecovery | null>(null)
  // 装载守卫是否已真正提交到 DOM（setter 返回不是证明）。
  const committedInputPathRef = useRef<string | null>(null)
  const loadingGuardWaitersRef = useRef<Array<{ path: string; resolve: () => void }>>([])
  // 采纳刷新令牌的上一次取值：只有令牌真的变化才判为采纳刷新（初始装载不算）。
  const adoptionRefreshTokenRef = useRef(adoptionRefreshToken)
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
  const [deAiMode, setDeAiMode] = useState<DeAiMode>(DEFAULT_DE_AI_MODE)
  const [deAiDetectResult, setDeAiDetectResult] = useState<DeAiDetectResult | null>(null)
  const [deAiEditResult, setDeAiEditResult] = useState<DeAiSpanApplyResult | null>(null)
  // RV-002: edit 模式的「输出不可解析」失败态（区别于锚点冲突 / 0 处修改）
  const [deAiEditError, setDeAiEditError] = useState<DeAiEditError | null>(null)
  // RV-001/RV-004: 单章去AI味流的请求代际 + 取消控制器（对齐 batchAbortRef 模式）。
  // 切模式 / 关对话框 / 切章都会 +1 并 abort，过期的 onDone/onError 一律丢弃。
  const deAiGenerationRef = useRef(0)
  const deAiAbortRef = useRef<AbortController | null>(null)
  // 选中文本去AI味/AI润色入口：防重入护栏 + deadline 控制器 + 取消（perf-fix-ds 前端侧）
  const [selectionActionPending, setSelectionActionPending] = useState(false)
  const selectionActionInFlightRef = useRef(false)
  const selectionActionAbortRef = useRef<AbortController | null>(null)
  const selectionActionTimedOutRef = useRef(false)
  const selectionActionFirstTokenRef = useRef(false)
  // Wave 4 (v2.5.0): 批量去AI味状态（进度 + 结果 + 中止引用）
  const [batchRunning, setBatchRunning] = useState(false)
  const [deAiBatchActionBusy, setDeAiBatchActionBusy] = useState(false)
  const deAiBatchActionBusyRef = useRef(false)
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
  const chapterTitleInputRef = useRef({ path: selectedFile, draft: "", editing: false, dirty: false, revision: 0 })
  const [chapterTitleWidthPx, setChapterTitleWidthPx] = useState(CHAPTER_TITLE_MIN_WIDTH_PX)
  const [chapterToolbarCompact, setChapterToolbarCompact] = useState(true)
  const [chapterToolbarMoreOpen, setChapterToolbarMoreOpen] = useState(false)
  const [loadedFilePath, setLoadedFilePathState] = useState<string | null>(null)
  const loadedFilePathRef = useRef<string | null>(null)
  const loadedPathSeqRef = useRef<{ path: string; seq: number } | null>(null)
  const [recoveryReloadToken, setRecoveryReloadToken] = useState(0)
  const setLoadedFilePath = useCallback((path: string | null) => {
    loadedFilePathRef.current = path
    setLoadedFilePathState(path)
  }, [])
  const observedSeqFor = useCallback((path: string): number | undefined => {
    const snap = loadedPathSeqRef.current
    if (!snap) return undefined
    return normalizePath(snap.path) === normalizePath(path) ? snap.seq : undefined
  }, [])
  useLayoutEffect(() => {
    // 此值描述本次真正提交的渲染分支，而不是刚调用过哪个 state setter。
    const inputPath = !selectedTrashItem && selectedFile !== null && loadedFilePath === selectedFile
      && !writeCoordinator.isFenced(selectedFile) ? selectedFile : null
    committedInputPathRef.current = inputPath
    const pending = loadingGuardWaitersRef.current
    loadingGuardWaitersRef.current = pending.filter((waiter) => waiter.path === inputPath)
    for (const waiter of pending) if (waiter.path !== inputPath) waiter.resolve()
  })
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      committedInputPathRef.current = null
      const waiters = loadingGuardWaitersRef.current
      loadingGuardWaitersRef.current = []
      // 真正卸载结束输入观察；begin 恢复时还必须检查 cancelled，不能再发出 accept。
      for (const waiter of waiters) waiter.resolve()
    }
  }, [])
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

  /** 等装载守卫真正提交到 DOM。已经在加载态/无编辑器 ⇒ 无需等待。 */
  const awaitLoadingGuardCommit = useCallback((expectedPath: string) => {
    if (committedInputPathRef.current !== expectedPath) return Promise.resolve()
    return new Promise<void>((resolve) => {
      loadingGuardWaitersRef.current.push({ path: expectedPath, resolve })
    })
  }, [])

  /** 按归属释放本实例的采纳 lease（旧 cleanup / 旧结果不得释放新 lease）。 */
  const releaseOwnAdoption = useCallback((expectedPath?: string, expectedLease?: ChapterAdoptionLease | null) => {
    const lease = expectedLease ?? (expectedPath === undefined
      ? adoptionLeaseRef.current
      : Array.from(adoptionStartsRef.current.keys()).find((entry) => normalizePath(entry.path) === normalizePath(expectedPath)))
    if (!lease) return false
    if (expectedPath !== undefined && normalizePath(lease.path) !== normalizePath(expectedPath)) return false
    const released = writeCoordinator.releaseAdoption(lease)
    if (released && adoptionLeaseRef.current === lease) adoptionLeaseRef.current = null
    if (released) adoptionStartsRef.current.delete(lease)
    return released
  }, [writeCoordinator])

  const setTitleInput = useCallback((draft: string, editing: boolean, userIntent = false, nextDirty?: boolean) => {
    const path = useWikiStore.getState().selectedFile
    const prev = chapterTitleInputRef.current
    const dirty = editing
      ? (nextDirty ?? (prev.path === path ? prev.dirty : false))
      : false
    chapterTitleInputRef.current = {
      path,
      draft,
      editing,
      dirty,
      revision: prev.revision + (userIntent ? 1 : 0),
    }
    setChapterTitleDraft(draft)
    setChapterTitleEditing(editing)
    if (userIntent && committedInputPathRef.current === path) {
      for (const record of adoptionStartsRef.current.values()) {
        if (record.snapshot?.path === path && !record.handedOff) {
          record.snapshot.titleDraft = draft
          record.snapshot.titleEditing = editing
          const lease = writeCoordinator.leaseOf(path)
          const recovery = lease ? writeCoordinator.recoveryForAdoption(lease) : null
          if (recovery) writeCoordinator.retainRecovery({ ...recovery, titleDraft: draft, titleEditing: editing })
        }
      }
      const recovery = path ? writeCoordinator.peekRecovery(path) : null
      if (path && recovery && !writeCoordinator.isFenced(path)) {
        if (!editing && recovery.buffer === undefined) {
          writeCoordinator.dropRecovery(path)
          recoveredInputRef.current = null
        } else {
          writeCoordinator.retainRecovery({ ...recovery, titleDraft: draft, titleEditing: editing })
        }
      }
    }
  }, [writeCoordinator])

  const restoreRecovery = useCallback((entry: ChapterWriteRecovery) => {
    const current = useWikiStore.getState().selectedFile
    if (!mountedRef.current || current === null || normalizePath(current) !== normalizePath(entry.path)) return
    const buffer = entry.buffer ?? fileContentRef.current
    const restoredHeader = isChapterPath(current) && getFileCategory(current) === "markdown"
      ? buildChapterEditorHeader(buffer)
      : null
    const restoredDisplayTitle = restoredHeader
      ? restoredHeader.heading || getChapterTitleFromPath(current)
      : ""
    // 先同步本路径 refs，再放回真实 UI。恢复仍是 dirty，不伪报 saved；自动 flush 挂起。
    fileContentRef.current = buffer
    recoveredInputRef.current = { ...entry, buffer }
    if (!loadedPathSeqRef.current || normalizePath(loadedPathSeqRef.current.path) !== normalizePath(current)) {
      loadedPathSeqRef.current = { path: current, seq: writeCoordinator.currentSequence() }
    }
    setFileContent(buffer)
    setTitleInput(entry.titleDraft, entry.titleEditing, false, entry.titleEditing && entry.titleDraft !== restoredDisplayTitle)
    setLoadedFilePath(current)
    setSaveStatus(entry.message ?? (entry.adoptionCommitted
      ? "采纳已落盘但读回未完成：已接回未存输入，正文未被自动回写，请检查后重新编辑或保存。"
      : "采纳未确认落盘：已接回未存输入，正文未被自动回写，请检查后重新编辑或保存。"))
  }, [setFileContent, setLoadedFilePath, setTitleInput, writeCoordinator])

  type ChapterCommitOutcome =
    | { status: "committed"; targetPath: string; markdown: string; stillCurrent: boolean }
    | { status: "fenced"; refusals: readonly ChapterWriteFenceRefusal[] }
    | { status: "failed"; error: unknown; recoveryPath: string }

  /**
   * 唯一实际正文写入入口。
   *
   * 1) 先解析受影响路径组（只读解析，不占 I/O 尾链，也不阻断采纳）；
   * 2) 以「同一同步段登记整组前驱 + 同一个新 barrier」的方式准入；
   * 3) write / delete / 重指选中项 与提交后 refs/可见内容同步全在这一个许可内，不再嵌套排自己的尾链。
   * 调用方必须在任何 await 之前用 captureIntent 捕获意图。
   */
  const commitChapter = useCallback(async (
    intent: ChapterWriteIntent,
    path: string,
    markdown: string,
    options?: { verifyAfterWrite?: (targetPath: string, markdown: string) => Promise<void> },
  ): Promise<ChapterCommitOutcome> => {
    if (saveTimerRef.current
      && (selectedFileRef.current === null || normalizePath(selectedFileRef.current) === normalizePath(path))) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const normalized = normalizeChapterWriting(markdown)
    const chapterNumber = extractChapterNumberFromMarkdown(normalized)
    const targetPath = await getCanonicalChapterPath(path, normalized, chapterNumber)
    let deleteIssued = false
    const admission = writeCoordinator.admitMutation(intent, [path, targetPath], async () => {
      await writeFileAtomic(targetPath, normalized)
      // 终稿补偿重写属于同一个有效许可，不能作为绕过协议的第二处直接写。
      if (options?.verifyAfterWrite) await options.verifyAfterWrite(targetPath, normalized)
      const isRelocation = normalizePath(targetPath) !== normalizePath(path)
      if (isRelocation) {
        const deletion = deleteFile(path)
        deleteIssued = true
        // 已验证的新文件 + 旧路径删除真正成功后：才登记迁移事实（仅成功删除使旧路径退役），
        // 不把 confirmed 目标静默改指；deleteIssued 仍负责失败上报。
        await deletion
        writeCoordinator.noteRelocation(intent, path, targetPath)
        const currentSelected = useWikiStore.getState().selectedFile
        if (currentSelected !== null && normalizePath(currentSelected) === normalizePath(path)) {
          selectedFileRef.current = targetPath
          lastLoadedRef.current = normalized
          fileContentRef.current = normalized
          chapterTitleInputRef.current = { ...chapterTitleInputRef.current, path: targetPath }
          loadedPathSeqRef.current = { path: targetPath, seq: writeCoordinator.currentSequence() }
          if (!writeCoordinator.isFenced(path) && !writeCoordinator.isFenced(targetPath)) {
            committedInputPathRef.current = targetPath
            setLoadedFilePath(targetPath)
          }
          setFileContent(normalized)
          useWikiStore.getState().setSelectedFile(targetPath)
        }
        if (project) {
          try {
            const tree = await listDirectory(normalizePath(project.path))
            setFileTree(tree)
          } catch (error) {
            console.warn("章节目录刷新失败:", toErrorMessage(error))
          }
        }
      }

      const latestSelected = useWikiStore.getState().selectedFile
      if (intent.kind !== "final-save") {
        clearFinalChapterSaveForPath?.(path)
        if (isRelocation) clearFinalChapterSaveForPath?.(targetPath)
      }
      if (latestSelected !== null && normalizePath(latestSelected) === normalizePath(targetPath)) {
        // canonical 重指同时迁移输入路径快照；异目标采纳 token 不负责重载它。
        fileContentRef.current = normalized
        lastLoadedRef.current = normalized
        chapterTitleInputRef.current = { ...chapterTitleInputRef.current, path: targetPath }
        loadedPathSeqRef.current = { path: targetPath, seq: writeCoordinator.currentSequence() }
        setFileContent(normalized)
        if (mountedRef.current && intent.kind !== "final-save") setSaveStatus("")
        // 已准入的旧 I/O 可以落定，但不能重开正在等待采纳的旧输入。
        if (!writeCoordinator.isFenced(path) && !writeCoordinator.isFenced(targetPath)) setLoadedFilePath(targetPath)
      }

      settleChapterRecoveryBodyWrite(writeCoordinator, intent, targetPath, normalized)
      bumpDataVersion()
    })
    if (admission.kind === "fenced") return { status: "fenced", refusals: admission.refusals }
    // 新的显式标题/终稿保存已真正准入，才消费恢复输入；迟到的旧意图不能清它。
    if (intent.kind === "title" || intent.kind === "final-save") {
      writeCoordinator.dropRecovery(path)
      if (recoveredInputRef.current?.path === normalizePath(path)) recoveredInputRef.current = null
    }
    try {
      await admission.result
    } catch (error) {
      // barrier 只负责释放继续，业务错误必须如实回到调用方。
      return { status: "failed", error, recoveryPath: deleteIssued ? targetPath : path }
    }
    return { status: "committed", targetPath, markdown: normalized, stillCurrent: admission.isCurrent() }
  }, [bumpDataVersion, clearFinalChapterSaveForPath, project, setFileContent, setFileTree, setLoadedFilePath, writeCoordinator])

  const flushChapterBeforeLeave = useCallback(async (path: string | null, markdown: string) => {
    /* v8 ignore next */
    if (!path || !isChapterPath(path)) return
    // 先处理未派发的 timer：早退分支不得把待写盘留在那里（否则栅栏解除后旧缓冲还会落盘）。
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const observedSeq = observedSeqFor(path)
    if (writeCoordinator.wasRelocatedSince(path, observedSeq)) return
    if (finalChapterSave?.saving && finalChapterSave.filePath === path) return
    // 失败/取消恢复不是新的保存意图；pagehide、切章、卸载都不能自动覆盖盘上事实。
    if (writeCoordinator.peekRecovery(path)
      && (recoveredInputRef.current?.path === normalizePath(path) || loadedFilePathRef.current !== path)) return
    if (markdown === lastLoadedRef.current) return
    // 离开 flush 也是真实写入意图：捕获后才准入；被采纳栅栏拒就静默放弃这份旧缓冲。
    const intent = writeCoordinator.captureIntent("leave-flush", path, observedSeq)
    const outcome = await commitChapter(intent, path, markdown)
    if (outcome.status === "failed") {
      if (outcome.error instanceof ChapterAdoptionUnavailableError && outcome.error.reason === "relocated") return
      console.error("切换章节前同步文件失败:", outcome.error)
    }
  }, [commitChapter, finalChapterSave, observedSeqFor, writeCoordinator])

  // 装载 effect 只用 [选中路径, 采纳令牌] 作为重跑依据：把 flush 放进 ref，避免
  // 「其它状态（如终稿保存阶段）变化 → 重跑 effect → 重读磁盘 → 冲掉未存正文」。
  const flushChapterRef = useRef(flushChapterBeforeLeave)
  useEffect(() => {
    flushChapterRef.current = flushChapterBeforeLeave
  }, [flushChapterBeforeLeave])

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
    if (!selectedFile) return
    // 两个既有挂载点的真正消费者：新实例接手在途 lease，恢复只装回正确路径的 UI。
    return writeCoordinator.subscribe(selectedFile, (event) => {
      if (event === "relocation") {
        if (saveTimerRef.current
          && selectedFileRef.current !== null
          && normalizePath(selectedFileRef.current) === normalizePath(selectedFile)) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        return
      }
      if (!mountedRef.current || useWikiStore.getState().selectedFile !== selectedFile) return
      if (event === "lease") {
        loadGenerationRef.current += 1
        setLoadedFilePath(null)
        return
      }
      if (event === "release") {
        for (const lease of adoptionStartsRef.current.keys()) {
          if (lease.path === normalizePath(selectedFile) && writeCoordinator.leaseOf(selectedFile) !== lease) {
            adoptionStartsRef.current.delete(lease)
            if (adoptionLeaseRef.current === lease) adoptionLeaseRef.current = null
          }
        }
      }
      const recovery = writeCoordinator.peekRecovery(selectedFile)
      if (recovery && !writeCoordinator.isFenced(selectedFile)
        && (event === "release" || committedInputPathRef.current === selectedFile)) {
        if (event === "release" && recovery.adoptionCommitted && loadedFilePathRef.current !== selectedFile) {
          // 成功后移交的观察仍须先读盘，不以旧快照重新开放输入窗口。
          setRecoveryReloadToken((token) => token + 1)
        } else restoreRecovery(recovery)
      } else if (event === "release" && !recovery && loadedFilePathRef.current !== selectedFile) {
        // 没有旧输入的装载也可能被 lease 作废；失败释放后恢复同一条真实读路径。
        setRecoveryReloadToken((token) => token + 1)
      }
    })
  }, [selectedFile, restoreRecovery, setLoadedFilePath, writeCoordinator])

  useEffect(() => {
    let cancelled = false
    let reloadLease: ChapterAdoptionLease | null = null
    const generation = ++loadGenerationRef.current
    const isCurrentRead = () => !cancelled && mountedRef.current && loadGenerationRef.current === generation
      && useWikiStore.getState().selectedFile === selectedFile
    const cancelRead = () => {
      cancelled = true
      // 选章/卸载只结束观察；已发出的读和新观察者的读都落定后才能释放同一 lease。
      if (reloadLease) writeCoordinator.releaseAdoption(reloadLease)
    }
    const previousFile = selectedFileRef.current
    const previousContent = fileContentRef.current
    const prevObserved = previousFile ? observedSeqFor(previousFile) : undefined
    // G2-NATIVE-F1：令牌变化 + 令牌指认当前文件 + 选中路径未变 ⇒ 同一份文件刚被采纳写回
    // （权威正文已落盘）。这时必须重新读盘，且不能把采纳前的旧缓冲 flush 回正式章。
    const adoptionRefreshRequested = adoptionRefreshToken !== adoptionRefreshTokenRef.current
    adoptionRefreshTokenRef.current = adoptionRefreshToken
    const adoptionSameFileRefresh = adoptionRefreshRequested
      && previousFile !== null
      && previousFile === selectedFile
      && normalizePath(adoptionRefreshPath) === normalizePath(selectedFile)
    if (adoptionRefreshRequested && !adoptionSameFileRefresh) {
      // 令牌异目标/选章已变：只终结该目标的观察，当前输入不重载。
      releaseOwnAdoption(adoptionRefreshPath)
      if (previousFile === selectedFile) return cancelRead
    }
    const previousRelocated = Boolean(
      previousFile && isChapterPath(previousFile) && writeCoordinator.wasRelocatedSince(previousFile, prevObserved),
    )
    if (adoptionSameFileRefresh) {
      // 采纳写入是权威：作废本文件排队的旧缓冲防抖写盘，并复用既有装载守卫
      // （loadedFilePath !== selectedFile 只渲染加载态）把旧缓冲区卸载 —— 重载窗口内不存在
      // 可接受输入的旧编辑器，所以不会出现「窗口内补的一笔被静默丢弃」。
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      setLoadedFilePath(null)
    } else if (previousFile && previousFile !== selectedFile && isChapterPath(previousFile)) {
      if (previousRelocated) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
      } else {
        void flushChapterRef.current(previousFile, previousContent)
      }
    }
    selectedFileRef.current = selectedFile
    if (previousFile !== selectedFile) {
      const pendingTitle = chapterTitleInputRef.current
      if (previousFile && isChapterPath(previousFile) && pendingTitle.path === previousFile
        && pendingTitle.editing && pendingTitle.dirty && !previousRelocated
        && !writeCoordinator.peekRecovery(previousFile)) {
        writeCoordinator.retainRecovery({
          path: previousFile,
          buffer: previousContent !== lastLoadedRef.current ? previousContent : undefined,
          titleDraft: pendingTitle.draft,
          titleEditing: true,
          message: "未提交的章节输入已保留，请检查后继续编辑或保存。",
        })
      }
      recoveredInputRef.current = null
      // 旧章输入留在原归属；新章标题不能继承旧章的 editing/draft 状态。
      setTitleInput("", false, false, false)
    }
    setSelectionTransformOpen(false)
    setDeAiPreviewOpen(false)
    // RV-004: 切章同样作废在途单章流（否则旧章的流落定后会重开对话框/覆写候选）
    deAiGenerationRef.current += 1
    deAiAbortRef.current?.abort()
    deAiAbortRef.current = null
    setDeAiProcessing(false)
    if (!adoptionSameFileRefresh) setLoadedFilePath(null)

    if (!selectedFile) {
      loadedPathSeqRef.current = null
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
      loadedPathSeqRef.current = { path: selectedFile, seq: writeCoordinator.currentSequence() }
      setFileContent("")
      fileContentRef.current = ""
      lastLoadedRef.current = ""
      setSaveStatus("")
      setLoadedFilePath(selectedFile)
      return () => {
        cancelled = true
      }
    }

    if (!adoptionSameFileRefresh) {
      setFileContent("")
      fileContentRef.current = ""
      lastLoadedRef.current = ""
      setSaveStatus("")
    }

    const load = async () => {
      const observedLease = writeCoordinator.leaseOf(selectedFile)
      // 新挂载/回到同章先接住真实采纳寿命；普通切章不是迁移，也不取消已准入 accept。
      // 同路径成功令牌本身已确认落盘，兼容未注入写入门的旧调用方。
      if (observedLease && !adoptionSameFileRefresh) await writeCoordinator.adoptionSettled(observedLease)
      await writeCoordinator.tailOf(selectedFile)
      if (!isCurrentRead()) return
      reloadLease = writeCoordinator.leaseOf(selectedFile)
      const install = async () => {
        const readSeq = writeCoordinator.currentSequence()
        let content = ""
        let errorMessage = ""
        try {
          content = await readFile(selectedFile)
        } catch (error) {
          errorMessage = formatOperationError(t, error)
        }
        if (!isCurrentRead()) return
        // 盘上事实先同步 refs/路径快照；恢复输入仍是 dirty，绝不把错误文本当正文。
        fileContentRef.current = content
        lastLoadedRef.current = content
        loadedPathSeqRef.current = { path: selectedFile, seq: readSeq }
        setFileContent(content)
        setSaveStatus(errorMessage)
        setLoadedFilePath(selectedFile)
        // 旧默认门的成功令牌也须消费它自己的快照，不能确认新调用方的 lease。
        if (adoptionSameFileRefresh && reloadLease?.owner === writeOwnerRef.current) {
          writeCoordinator.markAdoptionCommitted(reloadLease)
        }
        if (!errorMessage) {
          settleChapterAdoptionRecoveryAfterRead(writeCoordinator, selectedFile)
          recoveredInputRef.current = null
        }
        const recovery = writeCoordinator.peekRecovery(selectedFile)
        if (recovery) {
          const pending = errorMessage
            ? { ...recovery, message: `${errorMessage}；已保留未存输入，请检查后重新编辑或保存。` }
            : recovery
          // 释放通知/新挂载也要保留本次读失败回执，不能把它覆盖为泛化恢复提示。
          if (errorMessage) writeCoordinator.retainRecovery(pending)
          restoreRecovery(pending)
        }
        if (reloadLease) releaseOwnAdoption(selectedFile, reloadLease)
      }
      if (reloadLease) await writeCoordinator.runAdoptionReload(reloadLease, install)
      else await install()
    }
    void load().catch((error: unknown) => {
      if (isCurrentRead()) setSaveStatus(formatOperationError(t, error))
    })
    return cancelRead
  }, [selectedFile, adoptionRefreshToken, adoptionRefreshPath, recoveryReloadToken, observedSeqFor, setFileContent, setLoadedFilePath, setTitleInput, releaseOwnAdoption, restoreRecovery, writeCoordinator])

  // 真正的卸载清理：依赖必须为空。若挂在 [flushChapterBeforeLeave] 上，任何让该回调换新
  // （例如终稿保存阶段变化）都会把“依赖变化”当成卸载，从而在终稿写入期间意外 flush 脏缓冲。
  useEffect(() => {
    return () => {
      const currentFile = selectedFileRef.current
      if (currentFile && isChapterPath(currentFile)) {
        void flushChapterRef.current(currentFile, fileContentRef.current)
      }
      // 卸载不会再有任何渲染提交：把等待装载守卫的等待者释放掉，避免采纳侧永远挂着。
      const waiters = loadingGuardWaitersRef.current
      loadingGuardWaitersRef.current = []
      for (const waiter of waiters) waiter.resolve()
      // begin 已同步保留快照；不能在成功采纳消费快照后又用旧 cleanup 把旧正文加回来。
      // 先前准入 I/O 落定后才移交/释放准备态 lease；writing/read 则由协调器延后终结。
      for (const [lease, record] of adoptionStartsRef.current) {
        record.handedOff = true
        // 真正确认的调用方拥有 lease；布局卸载只终止本实例的输入观察。
        if (lease.owner === writeOwnerRef.current) {
          void record.admittedTail.then(() => releaseOwnAdoption(undefined, lease))
        }
      }
    }
  }, [releaseOwnAdoption])

  // S4-R2：标签页隐藏/窗口关闭前刷出待保存的章节（防 1s 防抖窗口内丢稿）。
  // kill-9 级崩溃仍由 writeFileAtomic 的 temp+fsync+rename 原子性兜底。
  useEffect(() => {
    const flush = () => {
      const currentFile = selectedFileRef.current
      if (currentFile && isChapterPath(currentFile)) {
        // 经 ref 取最新实现：监听只订阅一次，不随 flush 的依赖变化重建。
        void flushChapterRef.current(currentFile, fileContentRef.current)
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
  }, [])

  /**
   * 1s 防抖写盘：timer 真正准备派发时准入。
   * 被采纳栅栏拒就放弃这份旧缓冲（不写、也不把它标成已加载）；新的用户编辑会产生新意图。
   */
  const scheduleSave = useCallback((path: string, persistedMarkdown: string, observedSeq?: number) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const effectiveObservedSeq = observedSeq ?? observedSeqFor(path)
    if (writeCoordinator.wasRelocatedSince(path, effectiveObservedSeq)) return
    const intent = writeCoordinator.captureIntent("debounce-save", path, effectiveObservedSeq)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      if (writeCoordinator.wasRelocatedSince(path, effectiveObservedSeq)) return
      const admission = writeCoordinator.admitMutation(intent, [path], async () => {
        await writeFileAtomic(path, persistedMarkdown)
        clearFinalChapterSaveForPath?.(path)
        // 只有「仍是当前文件」的写盘才能成为新的已加载快照：另一目标的后台写盘完成
        // 不得改写当前文件的 lastLoaded（否则当前脏输入会被当成已保存）。
        if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(path)) {
          lastLoadedRef.current = persistedMarkdown
          setSaveStatus("")
        }
        settleChapterRecoveryBodyWrite(writeCoordinator, intent, path, persistedMarkdown)
        bumpDataVersion()
      })
      if (admission.kind === "fenced") return
      void admission.result.catch((err) => {
        if (err instanceof ChapterAdoptionUnavailableError && err.reason === "relocated") return
        if (!mountedRef.current || selectedFileRef.current === null || normalizePath(selectedFileRef.current) !== normalizePath(path)) return
        // R4 共识（deepseek+glm；glm+qwen）: 写盘失败原先仅 console.error，用户以为已保存。
        setSaveStatus(formatOperationError(t, err))
      })
    }, 1000)
  }, [bumpDataVersion, clearFinalChapterSaveForPath, observedSeqFor, t, writeCoordinator])

  const handleSave = useCallback(
    (markdown: string, explicitSave = false) => {
      /* v8 ignore next */
      if (!selectedFile || !mountedRef.current || useWikiStore.getState().selectedFile !== selectedFile
        || committedInputPathRef.current !== selectedFile) return
      const observedSeq = observedSeqFor(selectedFile)
      if (writeCoordinator.wasRelocatedSince(selectedFile, observedSeq)) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        return
      }
      const persistedMarkdown = isChapterPath(selectedFile)
        ? normalizeChapterWriting(markdown)
        : markdown
      const recovery = writeCoordinator.peekRecovery(selectedFile)
      const recoveredBuffer = recovery?.buffer ?? recoveredInputRef.current?.buffer
      // 恢复后的初始 markdownUpdated 不是新的保存意图，不能回滚部分 I/O。
      if (recovery && recoveredBuffer !== undefined && !explicitSave
        && persistedMarkdown === normalizeChapterWriting(recoveredBuffer)) return
      setFileContent(markdown)
      fileContentRef.current = markdown
      for (const [lease, record] of adoptionStartsRef.current) {
        if (record.snapshot?.path === selectedFile && !record.handedOff) {
          record.snapshot.buffer = markdown
          const entry = writeCoordinator.recoveryForAdoption(lease)
          if (entry) writeCoordinator.retainRecovery({ ...entry, buffer: markdown })
        }
      }
      if (writeCoordinator.isFenced(selectedFile)) return
      if (persistedMarkdown === lastLoadedRef.current && !explicitSave) return
      if (recovery) {
        // 新用户输入允许正常 timer/leave 写入；未提交标题仍保留在原恢复归属。
        writeCoordinator.retainRecovery({ ...recovery, buffer: markdown, adoptionCommitted: false })
        recoveredInputRef.current = null
      }
      scheduleSave(selectedFile, persistedMarkdown, observedSeq)
    },
    [observedSeqFor, scheduleSave, selectedFile, setFileContent, writeCoordinator]
  )

  const writeGate = useMemo<PreviewPanelWriteGate>(() => ({
    async begin(targetPath, owner = writeOwnerRef.current) {
      const current = selectedFileRef.current
      const isCurrentTarget = current !== null && normalizePath(current) === normalizePath(targetPath)
      // 先保留真实当前输入。旧 I/O 的提交后动作不能替换这份较新的正文/标题。
      const title = chapterTitleInputRef.current
      const snapshot: PreviewPanelWriteGateSnapshot | null = isCurrentTarget && committedInputPathRef.current === current
        ? { path: current, buffer: fileContentRef.current, titleDraft: title.draft, titleEditing: title.editing }
        : null
      const begin = writeCoordinator.beginAdoption(targetPath, owner)
      if (!begin.ok) return { status: "blocked", reason: "busy" }
      const lease = begin.lease!
      const record = { snapshot, admittedTail: begin.admittedTail, handedOff: false }
      adoptionLeaseRef.current = lease
      adoptionStartsRef.current.set(lease, record)
      if (snapshot) writeCoordinator.retainRecovery({ ...snapshot, adoptionId: lease.id })
      if (isCurrentTarget) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        setLoadedFilePath(null)
        await awaitLoadingGuardCommit(current)
      }
      // DOM 关闭之前的真实输入仍可更新快照；关闭后不再接收旧编辑器事件。
      record.handedOff = true
      await begin.admittedTail
      if (writeCoordinator.leaseOf(targetPath) !== lease
        || (owner === writeOwnerRef.current && !mountedRef.current)) {
        return { status: "blocked", reason: "cancelled" }
      }
      return snapshot ? { status: "ready", lease, snapshot } : { status: "idle", lease }
    },
    abort(start) {
      if (start.status === "blocked") return
      const lease = start.lease
      const recovery = lease ? writeCoordinator.recoveryForAdoption(lease) : start.status === "ready" ? start.snapshot : null
      if (lease) releaseOwnAdoption(undefined, lease)
      // begin 已同步保留归属；迁移只搬恢复输入，不把原确认改指向新路径。
      if (recovery) restoreRecovery(recovery)
    },
  }), [awaitLoadingGuardCommit, releaseOwnAdoption, restoreRecovery, setLoadedFilePath, writeCoordinator])

  useEffect(() => {
    if (!writeGateRef) return
    writeGateRef.current = writeGate
    return () => {
      if (writeGateRef.current === writeGate) writeGateRef.current = null
    }
  }, [writeGate, writeGateRef])

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
    let cancelled = false
    const prefix = `outline-${String(Math.abs(outlineNum)).padStart(3, "0")}`
    const jsonPath = `${normalizePath(project.path)}/.novel/snapshots/${prefix}.snapshot.json`
    void fileExists(jsonPath)
      .then((exists) => {
        if (!cancelled) setOutlineIngested(exists)
      })
      .catch((err) => {
        void err
        if (!cancelled) setOutlineIngested(false)
      })
    return () => {
      cancelled = true
    }
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
  const currentFinalChapterSave = finalChapterSave != null
    && project?.path != null
    && selectedFile != null
    && normalizePath(finalChapterSave.projectPath) === normalizePath(project.path)
    && normalizePath(finalChapterSave.filePath) === normalizePath(selectedFile)
    ? finalChapterSave
    : null
  const isFinalChapterSaving = currentFinalChapterSave?.saving ?? isSavingFinal
  const isOutlineIngesting = currentOutlineTask?.status === "ingesting"
  const reingestReceipt = saveStatus ? undefined : currentFinalChapterSave?.reingestReceipt
  const handleCopyReingestReceipt = useCallback(async () => {
    if (!reingestReceipt) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(reingestReceipt, null, 2))
      toast.success(t("novel.chapter.reingestReceiptCopied"))
    } catch {
      toast.error(t("novel.chapter.reingestReceiptCopyFailed"))
    }
  }, [reingestReceipt, t])

  // R4 共识（deepseek+glm）: 原 map 存的是**译文**，visibleSaveStatus 又对译文调 t(label, params)
  // ⇒ 二次翻译且 params 永远无法插值。改为存**键**，统一在 visibleSaveStatus 解析一次。
  const phaseLabelMap: Record<FinalChapterSavePhase, string> = {
    saving: "novel.chapter.savingAsFinal",
    reviewing: "novel.chapter.reviewInProgress",
    saved: "novel.chapter.savedAsFinal",
    reingesting: "novel.chapter.savingAsFinal",
    reingest_verified: "novel.chapter.reingestVerified",
    reingest_unverified: "novel.chapter.reingestUnverified",
    ingested: "novel.chapter.ingestSuccess",
    ingest_incomplete: "novel.chapter.savedWithMemoryStatus",
    blocked_by_review: "novel.chapter.reviewBlockedWithErrors",
    ingest_failed: "novel.chapter.ingestFailedRetry",
    ingest_no_llm: "novel.chapter.ingestNoLlmKey",
    ingest_no_chapter_number: "novel.chapter.ingestNoChapterNumber",
    ingest_not_final: "mainControl.draftIngestSkippedNotFinal",
    ingest_extract_failed: "novel.chapter.ingestExtractFailed",
    review_warnings: "novel.chapter.reviewWarningsButProceeding",
    review_failed_proceed: "novel.chapter.reviewFailedProceeding",
  }

  const visibleSaveStatus = (() => {
    if (saveStatus || !currentFinalChapterSave?.phase) return saveStatus
    const phase = currentFinalChapterSave.phase
    const label = phaseLabelMap[phase]
    const rawParams = currentFinalChapterSave.params
    const params = (phase === "ingest_failed" || phase === "ingest_extract_failed") && !rawParams?.message
      ? { ...rawParams, message: "unknown" }
      : rawParams
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
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/35 bg-success/10 px-2 py-0.5 text-xs font-medium leading-5 text-success-foreground"
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
      setTitleInput("", false)
      setChapterTitleWidthPx(CHAPTER_TITLE_MIN_WIDTH_PX)
      return
    }
    if (!chapterTitleEditing) setTitleInput(chapterDisplayTitle, false)
  }, [chapterDisplayTitle, chapterHeader, chapterTitleEditing, setTitleInput])

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
    const originalInput = { ...chapterTitleInputRef.current }
    if (!originalInput.editing || !originalInput.dirty || originalInput.draft === chapterDisplayTitle) {
      setTitleInput(chapterDisplayTitle, false, false, false)
      return
    }
    const path = selectedFile
    const sourceMarkdown = fileContentRef.current
    // 意图在任何 await（canonical 路径解析 / 写入）之前捕获：晚恢复的标题不得取得旧正文写许可。
    const intent = writeCoordinator.captureIntent("title", path, observedSeqFor(path))
    const normalizedTitle = normalizeChapterTitleInput(originalInput.draft)
    const fallbackTitle = chapterDisplayTitle || (chapterNumber !== null ? makeDefaultChapterTitle(chapterNumber) : "")
    const nextTitle = normalizedTitle || fallbackTitle
    setTitleInput(nextTitle, false, false, false)
    if (nextTitle === chapterDisplayTitle) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const outcome = await commitChapter(intent, path, updateChapterHeading(sourceMarkdown, nextTitle))
    if (outcome.status === "committed") return
    const recoveryPath = outcome.status === "failed" ? outcome.recoveryPath : path
    const existing = writeCoordinator.peekRecovery(recoveryPath)
    const latest = chapterTitleInputRef.current
    const newerInput = latest.path === path && latest.revision > originalInput.revision
    const preservedTitle = newerInput ? { draft: latest.draft, editing: latest.editing }
      : existing?.titleEditing ? { draft: existing.titleDraft, editing: existing.titleEditing }
      : { draft: originalInput.draft, editing: true }
    const detail = outcome.status === "fenced"
      ? "正文在此期间已被采纳或替换"
      : toErrorMessage(outcome.error)
    const recovery: ChapterWriteRecovery = {
      ...existing,
      buffer: existing?.buffer ?? (sourceMarkdown !== lastLoadedRef.current ? sourceMarkdown : undefined),
      path: recoveryPath,
      titleDraft: preservedTitle.draft,
      titleEditing: preservedTitle.editing,
      message: `章节标题未写入：${detail}`,
    }
    writeCoordinator.retainRecovery(recovery)
    // 迟到结果只归原输入；不能覆盖另一章或更新的标题，也不自动重试旧缓冲。
    if (useWikiStore.getState().selectedFile === path && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    restoreRecovery(recovery)
    console.error("章节标题同步失败:", detail)
  }, [
    chapterHeader,
    chapterNumber,
    chapterDisplayTitle,
    chapterTitleDraft,
    commitChapter,
    fileContent,
    normalizeChapterTitleInput,
    observedSeqFor,
    restoreRecovery,
    selectedFile,
    setTitleInput,
    writeCoordinator,
  ])

  const cancelChapterTitleEditing = useCallback(() => {
    setTitleInput(chapterDisplayTitle, false, true, false)
  }, [chapterDisplayTitle, setTitleInput])

  const handleSaveAsFinal = useCallback(async () => {
    /* v8 ignore next */
    if (!project || !selectedFile || !chapterFrontmatter) return

    const formalPath = selectedFile
    // 评审/回填是长 await：返回后必须确认本次终稿意图仍作用在同一份正文上。
    // 取 ref 而不是本次渲染的 prop —— ref 在每次编辑时同步更新，是「当前正文」的真实快照。
    const bodySnapshot = fileContentRef.current
    // 意图在评审/路径解析/写入任何 await 之前捕获。
    const intent = writeCoordinator.captureIntent("final-save", formalPath, observedSeqFor(formalPath))
    let savePath = formalPath
    const projectPath = project.path
    const updatePhase = (saving: boolean, phase: FinalChapterSavePhase | null, params?: Record<string, string | number>) => {
      /* v8 ignore next */
      setFinalChapterSave({ projectPath, filePath: savePath, saving, phase: phase ?? null, params })
    }

    setIsSavingFinal(true)
    setSaveStatus("")
    updatePhase(true, "saving")

    const novelConfig = useWikiStore.getState().novelConfig

    if (novelConfig.reviewBeforeSave) {
      updatePhase(true, "reviewing")
      try {
        const chapterNumber = chapterFrontmatter.chapterNumber as number | undefined
        const { reviewChapter } = await import("@/lib/novel/review-adapter")
        const results = await reviewChapter(project.path, bodySnapshot, chapterNumber)
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

    // 评审返回后：正文/目标已被替换则本次终稿失效 —— 不写、不标 final、不 ingest，busy 如实结束。
    const isStillTargetFile = (target: string) =>
      mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(target)
    const invalidated = selectedFileRef.current !== formalPath || fileContentRef.current !== bodySnapshot
    if (invalidated) {
      updatePhase(false, null)
      if (isStillTargetFile(formalPath)) {
        setSaveStatus("正文已被更新：本次「保存为终稿」未写入，请重新确认后再试。")
      }
      if (mountedRef.current) setIsSavingFinal(false)
      return
    }

    let formalSaved = false
    let ingestTaskId: string | undefined
    try {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      const updatedMarkdown = updateChapterStatus(bodySnapshot, "final")
      const llmConfig = useWikiStore.getState().llmConfig
      const canIngest = novelConfig.autoIngestOnSave && hasUsableLlm(resolveNovelModel(llmConfig, novelConfig, "extract"))
      const outcome = await commitChapter(intent, formalPath, updatedMarkdown, {
        // 终稿回读校验 + 补偿重写属于同一个有效 mutation 许可（不是第二处直接写）。
        verifyAfterWrite: canIngest
          ? async (targetPath, markdown) => {
              const verifyContent = await readFile(targetPath)
              const verifyParsed = parseFrontmatter(verifyContent)
              const verifyFm = verifyParsed.frontmatter as Record<string, unknown> | null
              if (!verifyFm || !isFinalChapter(verifyFm)) {
                await writeFileAtomic(targetPath, markdown)
                await new Promise((resolve) => setTimeout(resolve, 100))
              }
            }
          : undefined,
      })
      if (outcome.status === "fenced") {
        updatePhase(false, null)
        if (isStillTargetFile(formalPath)) {
          setSaveStatus("正文在此期间已被采纳或替换：本次「保存为终稿」未写入。")
        }
        return
      }
      if (outcome.status === "failed") throw outcome.error

      const targetPath = outcome.targetPath
      savePath = targetPath
      if (!outcome.stillCurrent) {
        // 写入后又出现了更新的同目标写入：不冒领 final/ingest。
        updatePhase(false, null)
        if (isStillTargetFile(targetPath)) {
          setSaveStatus("终稿写入已被后续写入取代：本次未标记终稿，也未提取记忆。")
        }
        return
      }
      formalSaved = true

      if (novelConfig.autoIngestOnSave) {
        if (!canIngest) {
          updatePhase(false, "ingest_no_llm")
        } else {
          const chapterTitle = chapterFrontmatter?.title || `第${chapterFrontmatter?.chapterNumber || '?'}章`
          const ingestAbortController = new AbortController()
          ingestTaskId = useImportProgressStore.getState().startTask({
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
            llmConfig,
            novelConfig,
          })
          const memory = await readBackMemoryIngest(project.path, targetPath, result)
          const message = formatMemoryIngest(t, memory)
          const status = memory.ingest === "ok" ? "done"
            : memory.failReason === "memory_pending" ? "pending"
              : memory.ingest === "skipped-no-model" || memory.failReason === "not_final" ? "skipped"
                : memory.failReason === "cancelled" ? "cancelled" : "error"
          useImportProgressStore.getState().finishTask(ingestTaskId, status, {
            completed: status === "done" ? 1 : 0,
            total: 1,
            currentTitle: "",
            message,
          })
          if (memory.ingest === "ok" && result.snapshot) {
            updatePhase(false, "ingested", { chapter: result.snapshot.chapterNumber })
          } else if (result.snapshot) {
            updatePhase(false, "ingest_incomplete", { message })
          } else if (memory.ingest === "skipped-no-model") {
            updatePhase(false, "ingest_no_llm")
          } else if (result.failReason === "invalid_chapter_number") {
            updatePhase(false, "ingest_no_chapter_number")
          } else if (result.failReason === "not_final") {
            updatePhase(false, "ingest_not_final")
          } else if (result.failReason === "extract_failed") {
            updatePhase(false, "ingest_extract_failed", { message: (message || result.failReason || "unknown").slice(0, 100) })
          } else {
            updatePhase(false, "ingest_failed", { message: (message || result.failReason || "unknown").slice(0, 100) })
          }
        }
      } else {
        updatePhase(false, "saved")
      }
    } catch (error) {
      const message = toErrorMessage(error)
      if (formalSaved) {
        const ingestMessage = t("mainControl.draftIngestUnexpectedError")
        if (ingestTaskId) useImportProgressStore.getState().finishTask(ingestTaskId, "error", { message: ingestMessage })
        updatePhase(false, "ingest_incomplete", { message: ingestMessage })
      } else {
        updatePhase(false, null)
        if (isStillTargetFile(savePath)) {
          setSaveStatus(t("chat.saveFailed", { message }))
        }
      }
      console.error("[preview-panel] final save or ingest failed:", message)
    } finally {
      if (mountedRef.current) setIsSavingFinal(false)
    }
  }, [chapterFrontmatter, commitChapter, fileContent, observedSeqFor, project, selectedFile, setFinalChapterSave, t, writeCoordinator])

  const handleReingest = useCallback(async () => {
    /* v8 ignore next */
    if (!project || !selectedFile || !chapterFrontmatter) return
    if (!isFinalChapter(chapterFrontmatter)) {
      setSaveStatus(t("novel.chapter.reingestNotFinal"))
      return
    }
    const projectPath = project.path
    const filePath = selectedFile
    const updatePhase = (saving: boolean, phase: FinalChapterSavePhase | null, params?: Record<string, string | number>, reingestReceipt?: VerifiedRebuildReceipt) => {
      /* v8 ignore next */
      setFinalChapterSave({ projectPath, filePath, saving, phase: phase ?? null, params, ...(reingestReceipt ? { reingestReceipt } : {}) })
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
        awaitCommunitySummary: true,
        requireUniqueFinalChapter: true,
      })
      if (result.snapshot) {
        let receipt: VerifiedRebuildReceipt
        try {
          if (chapterNumber === null) throw new Error("Missing expected chapter number.")
          receipt = await verifyRebuildOutcome(normalizePath(projectPath), { path: filePath, chapterNumber }, result)
        } catch (error) {
          const message = toErrorMessage(error).slice(0, 100)
          useImportProgressStore.getState().finishTask(ingestTaskId, "error", {
            completed: 0, total: 1, currentTitle: "",
            message: t("novel.chapter.reingestUnverified", { message }),
          })
          updatePhase(false, "reingest_unverified", { message })
          return
        }
        const verifiedChapter = receipt.receipt.chapterNumber
        useImportProgressStore.getState().finishTask(ingestTaskId, "done", {
          completed: 1, total: 1, currentTitle: "",
          message: t("novel.chapter.reingestVerified", { chapter: verifiedChapter }),
        })
        updatePhase(false, "reingest_verified", { chapter: verifiedChapter }, receipt)
        return
      }
      useImportProgressStore.getState().finishTask(ingestTaskId, "error", {
        completed: 0,
        total: 1,
        currentTitle: "",
        message: `${chapterTitle} 提取失败`,
      })
      if (result.failReason === "invalid_chapter_number") {
        updatePhase(false, "ingest_no_chapter_number")
      } else {
        updatePhase(false, "ingest_failed", { message: (result.failReason || "unknown").slice(0, 100) })
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
      if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(filePath)) {
        setSaveStatus(formatOperationError(t, error))
      }
    } finally {
      if (mountedRef.current) setIsSavingFinal(false)
    }
  }, [chapterFrontmatter, chapterNumber, project, selectedFile, setFinalChapterSave, t])

  const handleFormatWriting = useCallback(async () => {
    /* v8 ignore next */
    if (!selectedFile || !canFormatWriting) return
    const path = selectedFile
    const source = fileContentRef.current
    // 意图在任何 await 之前捕获；先取得合法许可再改变任何提交状态。
    const intent = writeCoordinator.captureIntent("format", path, observedSeqFor(path))
    const formatted = normalizeChapterWriting(source)
    const admission = writeCoordinator.admitMutation(intent, [path], async () => {
      await writeFileAtomic(path, formatted)
      clearFinalChapterSaveForPath?.(path)
      if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(path)) {
        fileContentRef.current = formatted
        lastLoadedRef.current = formatted
        setSaveStatus("")
      }
      bumpDataVersion()
    })
    if (admission.kind === "fenced") {
      // 不预先标成已保存：保留脏输入，如实提示未写入。
      if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(path)) {
        setSaveStatus("排版未写入：正文正在被采纳或已被替换，请重新确认后再试")
      }
      return
    }
    try {
      await admission.result
    } catch (err) {
      // 写失败：保留脏输入/错误，不把内容标成已保存。
      console.error("格式化写作内容失败:", toErrorMessage(err))
      if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(path)) {
        setSaveStatus(formatOperationError(t, err))
      }
      return
    }
    if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(path)) {
      setFileContent(formatted)
    }
  }, [bumpDataVersion, canFormatWriting, clearFinalChapterSaveForPath, fileContent, observedSeqFor, selectedFile, setFileContent, t, writeCoordinator])

  const handleIngestOutline = useCallback(() => {
    /* v8 ignore next */
    if (!project || !selectedFile || !canIngestOutline || isOutlineIngesting) return
    setSaveStatus("")
    startOutlineIngestTask(project.path, selectedFile)
  }, [canIngestOutline, isOutlineIngesting, project, selectedFile])

  /** RV-001/RV-004: 作废在途的单章去AI味流（切模式 / 关对话框 / 切章调用） */
  const cancelDeAiStream = useCallback(() => {
    deAiGenerationRef.current += 1
    deAiAbortRef.current?.abort()
    deAiAbortRef.current = null
    setDeAiProcessing(false)
  }, [])

  /** 清空上一模式产出的候选正文与校验结果（RV-001：apply 永不可能写回别的模式的内容） */
  const clearDeAiOutput = useCallback(() => {
    setDeAiCandidateContent("")
    setDeAiEditResult(null)
    setDeAiEditError(null)
    setDeAiDetectResult(null)
  }, [])

  /** 脱敏并截断去 AI 味失败摘要，用于 saveStatus 状态栏回显 */
  const formatDeAiFailedStatus = useCallback((error: unknown) => {
    const detail = toErrorMessage(error)
      .replace(/https?:\/\/[^\s"']+/g, "[url]")
      .replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
      .replace(/\s+/g, " ")
      .trim()
    const base = t("preview.deAiFailed")
    return detail ? `${base}（${detail.slice(0, 120)}）` : base
  }, [t])

  const handleDeAiProcess = useCallback(async (targetMode: DeAiMode = DEFAULT_DE_AI_MODE) => {
    if (!fileContent.trim()) {
      setSaveStatus(t("preview.deAiEmpty"))
      return
    }
    const source = fileContent
    const sourceFile = selectedFileRef.current
    // 请求代际：切模式 / 关对话框 / 切章都 +1；过期流的 onDone/onError 一律丢弃。
    const generation = deAiGenerationRef.current + 1
    deAiGenerationRef.current = generation
    const isStale = () => deAiGenerationRef.current !== generation
    clearDeAiOutput()
    setSaveStatus("")
    const failDeAi = (error: unknown) => {
      if (!mountedRef.current || isStale() || selectedFileRef.current !== sourceFile) return
      deAiAbortRef.current = null
      console.error("去AI味处理失败:", toErrorMessage(error))
      setSaveStatus(formatDeAiFailedStatus(error))
      setDeAiProcessing(false)
    }

    if (targetMode === "detect") {
      setDeAiProcessing(false)
      let runDeAiDetection: typeof import("@/lib/novel/de-ai-adapter").runDeAiDetection
      let extractDeAiChapterBody: typeof import("@/lib/novel/de-ai-adapter").extractDeAiChapterBody
      try {
        ;({ runDeAiDetection, extractDeAiChapterBody } = await import("@/lib/novel/de-ai-adapter"))
      } catch (err) {
        failDeAi(err)
        return
      }
      if (isStale() || selectedFileRef.current !== sourceFile) return
      // RV-006: 只看章节正文（frontmatter + 一级标题不计入检测）
      const body = extractDeAiChapterBody(source)
      const detectResult = runDeAiDetection(body)
      setDeAiMode("detect")
      setDeAiSourceContent(body)
      setDeAiCandidateContent(body)
      setDeAiDetectResult(detectResult)
      setDeAiPreviewOpen(true)
      return
    }

    setDeAiProcessing(true)
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      setDeAiProcessing(false)
      setSaveStatus(t("preview.deAiNoModel"))
      return
    }
    let buildDeAiEditMessages: typeof import("@/lib/novel/de-ai-adapter").buildDeAiEditMessages
    let parseDeAiEditPlanChecked: typeof import("@/lib/novel/de-ai-adapter").parseDeAiEditPlanChecked
    let applyDeAiSpanEdits: typeof import("@/lib/novel/de-ai-adapter").applyDeAiSpanEdits
    let extractDeAiChapterBody: typeof import("@/lib/novel/de-ai-adapter").extractDeAiChapterBody
    let customDeAiSkill: string | null = null
    try {
      let loadSmartDeAiSkill: typeof import("@/lib/novel/de-ai-adapter").loadSmartDeAiSkill
      ;({ loadSmartDeAiSkill, buildDeAiEditMessages, parseDeAiEditPlanChecked, applyDeAiSpanEdits, extractDeAiChapterBody } = await import("@/lib/novel/de-ai-adapter"))
      if (isStale() || selectedFileRef.current !== sourceFile) return
      customDeAiSkill = await loadSmartDeAiSkill(project?.path ?? null, "去AI味润色", undefined)
    } catch (err) {
      failDeAi(err)
      return
    }
    if (isStale() || selectedFileRef.current !== sourceFile) return

    // RV-006: edit 模式只对章节正文发请求（frontmatter/H1 排除）；rewrite 模式保持全量内容不变。
    const chapterBody = extractDeAiChapterBody(source)
    const messages = targetMode === "edit"
      ? buildDeAiEditMessages(chapterBody, customDeAiSkill || undefined)
      : buildDeAiRewriteMessages(source, customDeAiSkill || undefined)

    const controller = new AbortController()
    deAiAbortRef.current = controller
    let result = ""
    try {
      await streamChat(
        llmConfig,
        messages,
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => {
            // RV-001/RV-004: 被切模式/关对话框作废的流不得再改任何状态
            if (isStale()) return
            // R4 共识（deepseek+qwen high）: 缺文件切换守卫 ⇒ 切章后旧流仍会打开预览对话框。
            if (selectedFileRef.current !== sourceFile) {
              setDeAiProcessing(false)
              return
            }
            deAiAbortRef.current = null
            setDeAiMode(targetMode)
            setDeAiSourceContent(targetMode === "edit" ? chapterBody : source)
            if (targetMode === "edit") {
              const plan = parseDeAiEditPlanChecked(result)
              if (!plan.ok) {
                // RV-002: 不可解析 ⇒ 错误态 + 禁用写回（绝不把空/垃圾当成 0 处修改）
                setDeAiEditError(plan.reason)
                setDeAiEditResult(null)
                setDeAiCandidateContent("")
              } else {
                const editRes = applyDeAiSpanEdits(chapterBody, [...plan.edits])
                setDeAiEditResult(editRes)
                setDeAiCandidateContent(editRes.markdown)
              }
            } else {
              setDeAiEditResult(null)
              setDeAiCandidateContent(result)
            }
            setDeAiPreviewOpen(true)
            setDeAiProcessing(false)
          },
          onError: failDeAi,
        },
        controller.signal,
      )
    } catch (err) {
      failDeAi(err)
    }
  }, [fileContent, project, t, clearDeAiOutput, formatDeAiFailedStatus])

  const handleDeAiModeChange = useCallback(async (newMode: DeAiMode) => {
    if (newMode === deAiMode) return
    if (newMode === "detect") {
      // RV-001: 切模式先作废在途流，并清空上一模式候选/校验结果
      cancelDeAiStream()
      clearDeAiOutput()
      const sourceFile = selectedFileRef.current
      const generation = deAiGenerationRef.current
      let runDeAiDetection: typeof import("@/lib/novel/de-ai-adapter").runDeAiDetection
      let extractDeAiChapterBody: typeof import("@/lib/novel/de-ai-adapter").extractDeAiChapterBody
      try {
        ;({ runDeAiDetection, extractDeAiChapterBody } = await import("@/lib/novel/de-ai-adapter"))
      } catch (err) {
        if (!mountedRef.current || deAiGenerationRef.current !== generation || selectedFileRef.current !== sourceFile) return
        console.error("去AI味处理失败:", toErrorMessage(err))
        setSaveStatus(formatDeAiFailedStatus(err))
        setDeAiProcessing(false)
        return
      }
      if (!mountedRef.current || deAiGenerationRef.current !== generation || selectedFileRef.current !== sourceFile) return
      const body = extractDeAiChapterBody(deAiSourceContent || fileContent)
      setDeAiMode("detect")
      setDeAiSourceContent(body)
      setDeAiCandidateContent(body)
      setDeAiDetectResult(runDeAiDetection(body))
      return
    }
    // rewrite/edit：由 handleDeAiProcess 统一代际自增 + 清空旧产出
    await handleDeAiProcess(newMode)
  }, [deAiMode, deAiSourceContent, fileContent, handleDeAiProcess, cancelDeAiStream, clearDeAiOutput, formatDeAiFailedStatus])

  // Wave 4 (v2.5.0): 批量去AI味 — 一键全书 + 进度 + 结果回填（lib API 纯薄壳）
  const refreshBatchChapters = useCallback(async () => {
    if (!project) return
    const state = await loadDeAiBatchState(project.path)
    if (!state || !mountedRef.current) return
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
    if (!project || batchRunning || deAiBatchActionBusyRef.current) return
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      setSaveStatus("未配置可用的 AI 模型，无法批量去AI味")
      return
    }
    const sourceFile = selectedFileRef.current
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
        onProgress: (progress) => {
          if (mountedRef.current) setBatchProgress(progress)
        },
        signal: controller.signal,
      })
      if (!mountedRef.current) return
      setBatchSummary(summary)
      await refreshBatchChapters()
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(
          summary.phase === "paused"
            ? `批量去AI味已中止（完成 ${summary.processed} 章）`
            : `批量去AI味完成：${summary.processed} 章成功，${summary.failed.length} 章失败，${summary.skipped} 章跳过`,
        )
      }
    } catch (error) {
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(formatOperationError(t, error))
      }
    } finally {
      if (mountedRef.current) setBatchRunning(false)
      batchAbortRef.current = null
    }
  }, [batchRunning, project, refreshBatchChapters, t])

  const handleDeAiBatchCancel = useCallback(() => {
    batchAbortRef.current?.abort()
  }, [])

  const handleDeAiBatchAcceptAll = useCallback(async () => {
    if (!project || batchRunning || deAiBatchActionBusyRef.current) return
    const sourceFile = selectedFileRef.current
    deAiBatchActionBusyRef.current = true
    setDeAiBatchActionBusy(true)
    // R4 共识（deepseek+glm；glm+qwen）: 原无 try/catch 且调用方以 void 丢弃 ⇒ 未处理 rejection、
    // 失败时用户看不到任何反馈。
    try {
      const result = await acceptAllDeAiBatchDrafts(project.path)
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(`批量回填完成：${result.accepted} 章已写回，${result.skipped} 章跳过`)
      }
      await refreshBatchChapters()
      bumpDataVersion()
    } catch (err) {
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(formatOperationError(t, err))
      }
    } finally {
      deAiBatchActionBusyRef.current = false
      if (mountedRef.current) setDeAiBatchActionBusy(false)
    }
  }, [batchRunning, project, refreshBatchChapters, bumpDataVersion, t])

  const handleDeAiBatchAcceptChapter = useCallback(async (chapterNumber: number) => {
    if (!project || batchRunning || deAiBatchActionBusyRef.current) return
    const sourceFile = selectedFileRef.current
    deAiBatchActionBusyRef.current = true
    setDeAiBatchActionBusy(true)
    try {
      const ok = await acceptDeAiBatchDraft(project.path, chapterNumber)
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(ok ? `第 ${chapterNumber} 章已回填` : `第 ${chapterNumber} 章回填失败`)
      }
      await refreshBatchChapters()
      bumpDataVersion()
    } catch (err) {
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(formatOperationError(t, err))
      }
    } finally {
      deAiBatchActionBusyRef.current = false
      if (mountedRef.current) setDeAiBatchActionBusy(false)
    }
  }, [batchRunning, project, refreshBatchChapters, bumpDataVersion, t])

  const handleDeAiBatchRejectChapter = useCallback(async (chapterNumber: number) => {
    if (!project || batchRunning || deAiBatchActionBusyRef.current) return
    const sourceFile = selectedFileRef.current
    deAiBatchActionBusyRef.current = true
    setDeAiBatchActionBusy(true)
    try {
      const ok = await rejectDeAiBatchDraft(project.path, chapterNumber)
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(ok ? `第 ${chapterNumber} 章已拒绝` : `第 ${chapterNumber} 章拒绝失败`)
      }
      await refreshBatchChapters()
    } catch (err) {
      if (mountedRef.current && selectedFileRef.current === sourceFile) {
        setSaveStatus(formatOperationError(t, err))
      }
    } finally {
      deAiBatchActionBusyRef.current = false
      if (mountedRef.current) setDeAiBatchActionBusy(false)
    }
  }, [batchRunning, project, refreshBatchChapters, t])

  const handleDeAiBatchClose = useCallback(() => {
    if (batchRunning || deAiBatchActionBusyRef.current) return
    setBatchDialogOpen(false)
  }, [batchRunning])

  /**
   * 写回前置条件（RV-001/RV-002）：
   * - 处理中（流未落定）/ 无候选正文 → 一律禁止
   * - detect 模式 → 永不写盘
   * - edit 模式：解析失败 / 锚点冲突 / 0 处应用 → 禁止
   */
  const deAiWriteBlocked = useMemo(() => {
    if (deAiMode === "detect") return true
    if (deAiProcessing) return true
    if (!deAiCandidateContent.trim()) return true
    if (deAiMode !== "edit") return false
    if (deAiEditError) return true
    return !deAiEditResult || !deAiEditResult.ok || deAiEditResult.applied.length === 0
  }, [deAiCandidateContent, deAiEditError, deAiEditResult, deAiMode, deAiProcessing])

  const handleDeAiApply = useCallback(() => {
    if (deAiWriteBlocked) return
    setDeAiPreviewOpen(false)
    handleSave(replaceWholeChapterBody(fileContent, deAiCandidateContent))
  }, [deAiCandidateContent, deAiWriteBlocked, fileContent, handleSave])

  const handleDeAiSaveDraft = useCallback(async () => {
    if (deAiWriteBlocked) return
    if (!selectedFile || !project) return
    const normalizedPath = selectedFile.replace(/\\/g, "/")
    const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/") + 1)
    const fileName = normalizedPath.split("/").pop() || "file" /* v8 ignore start */ /* v8 ignore stop */
    const baseName = fileName.replace(/\.md$/, "")
    const draftPath = normalizePath(`${dir}${baseName}${DRAFT_FILENAME_SUFFIX}`)
    const projectRoot = normalizePath(project.path)
    // 异目标草稿写：按它自己的草稿路径独立准入（不被正式章栅栏全局阻断，也不污染正式状态）。
    const intent = writeCoordinator.captureIntent("de-ai-draft", draftPath)
    const admission = writeCoordinator.admitMutation(intent, [draftPath], async () => {
      // 草稿带原章一级标题，但不带 frontmatter：同目录的草稿若带 chapter_number /
      // chapter_status，会被章节索引（findChapterFileByNumber）与导出（loadFinalChapters）
      // 当作同号正式章节。replaceWholeChapterBody 剥掉候选自带的 frontmatter/标题后套原章标题。
      // 草稿文件名里的章号也会被 extractChapterNumber 取到，故由 chapter-utils 的
      // isDraftChapterFile 统一排除（DRAFT_FILENAME_SUFFIX 与过滤口径同源）。
      const { body: bodyWithHeading } = parseFrontmatter(replaceWholeChapterBody(fileContent, deAiCandidateContent))
      await writeFileAtomic(draftPath, bodyWithHeading)
      // 提交后动作同属这一个许可。
      const tree = await listDirectory(projectRoot)
      setFileTree(tree)
      bumpDataVersion()
      setDeAiPreviewOpen(false)
    })
    if (admission.kind === "fenced") {
      setSaveStatus("去AI味草稿未另存：目标路径正在写入，请稍后重试")
      return
    }
    try {
      await admission.result
    } catch (err) {
      if (mountedRef.current && selectedFileRef.current !== null && normalizePath(selectedFileRef.current) === normalizePath(selectedFile)) {
        setSaveStatus(formatOperationError(t, err))
      }
      console.error("另存去AI味草稿失败:", toErrorMessage(err))
    }
  }, [deAiCandidateContent, deAiWriteBlocked, fileContent, project, selectedFile, setFileTree, bumpDataVersion, t, writeCoordinator])

  const handleDeAiClose = useCallback(() => {
    // RV-004: 关闭对话框即取消/作废在途单章流，onDone 不得再打开对话框或覆写状态
    cancelDeAiStream()
    setDeAiPreviewOpen(false)
  }, [cancelDeAiStream])

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

    let customDeAiSkill: string | null = null
    try {
      const { loadSmartDeAiSkill } = await import("@/lib/novel/de-ai-adapter")
      customDeAiSkill = await loadSmartDeAiSkill(
        project?.path ?? null,
        action === "de-ai" ? "去AI味" : "润色",
        undefined
      )
    } catch (err) {
      // R4 共识（deepseek+glm high）: 原 await 在 try 外 ⇒ selectionActionPending 卡死 +
      // 未处理 rejection。
      if (mountedRef.current && selectedFileRef.current === actionFile) setSaveStatus(formatOperationError(t, err))
      selectionActionInFlightRef.current = false
      if (mountedRef.current) setSelectionActionPending(false)
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
            if (!mountedRef.current || selectedFileRef.current !== actionFile) return
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
            if (!mountedRef.current || selectedFileRef.current !== actionFile) return
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
      if (!mountedRef.current || selectedFileRef.current !== actionFile) return
      console.error(`${actionLabel}失败:`, message)
      setSaveStatus(`${actionLabel}失败：${safe}`)
    } finally {
      clearTimeout(deadline)
      selectionActionAbortRef.current = null
      selectionActionInFlightRef.current = false
      if (mountedRef.current) setSelectionActionPending(false)
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

  if (loadedFilePath !== selectedFile || (selectedFile !== null && writeCoordinator.isFenced(selectedFile))) {
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
          const current = chapterTitleInputRef.current
          if (current.editing) {
            setTitleInput(current.draft, true, false, current.dirty)
          } else {
            setTitleInput(chapterDisplayTitle, true, false, false)
          }
        }}
        onTitleChange={(value) => setTitleInput(value, true, true, value !== chapterDisplayTitle)}
        onTitleCommit={() => void commitChapterTitleDraft()}
        onTitleCancel={() => cancelChapterTitleEditing()}
        visibleSaveStatus={visibleSaveStatus}
        onCopyReingestReceipt={reingestReceipt ? () => void handleCopyReingestReceipt() : undefined}
        selectionActionPending={selectionActionPending}
        onCancelSelectionAction={handleSelectionActionCancel}
        showInspector={Boolean(isSelectedChapter && project)}
        inspectorProjectPath={project?.path ?? ""}
        inspectorChapterId={selectedFile ?? ""}
        inspectorRefreshKey={fileContent}
      />
      <div className={getPreviewContentContainerClass(isSelectedChapter)} onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s"
          && selectedFile && recoveredInputRef.current?.path === normalizePath(selectedFile)) {
          event.preventDefault()
          event.stopPropagation()
          handleSave(fileContentRef.current, true)
        }
      }}>
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
      <PreviewOutlineOverlays
        showOutlineSnapshot={showOutlineSnapshot}
        projectPath={project?.path ?? null}
        outlineSnapshotNumber={outlineSnapshotNumber}
        unpackOpen={showUnpackOutlineDialog}
        onUnpackOpenChange={setShowUnpackOutlineDialog}
        outlineContent={fileContent}
        onCloseOutlineSnapshot={() => setShowOutlineSnapshot(false)}
        t={t}
      />
      <PreviewCognitionOverlays
        showCognition={showCognition}
        showPersona={showPersona}
        projectPath={project?.path ?? null}
        onCloseCognition={() => setShowCognition(false)}
        onClosePersona={() => setShowPersona(false)}
        t={t}
      />
      <DeAiPreviewDialog
        open={deAiPreviewOpen}
        sourceContent={deAiSourceContent}
        candidateContent={deAiCandidateContent}
        mode={deAiMode}
        detectResult={deAiDetectResult}
        editResult={deAiEditResult}
        editError={deAiEditError}
        processing={deAiProcessing}
        onModeChange={(mode) => void handleDeAiModeChange(mode)}
        onApply={handleDeAiApply}
        onSaveDraft={() => void handleDeAiSaveDraft()}
        onClose={handleDeAiClose}
      />
      <DeAiBatchDialog
        open={batchDialogOpen}
        running={batchRunning}
        busy={deAiBatchActionBusy}
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
    </div>
  )
}
