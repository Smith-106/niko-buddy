// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Human-in-the-loop interactive chapter snapshot ingest dialog for Zero-API-Key
 * / Pure Subscription Antigravity workflows (and manual commits in Golden Hybrid).
 *
 * Strict Google Antigravity ToS & Draft-first safety boundaries:
 * 1. Zero silent background LLM calls and zero extra IPC calls on mount.
 * 2. Step 1 ONLY pre-fills a read-only extraction prompt (`chapter.read` only)
 *    into the ACP composer — never auto-sends.
 * 3. Step 2 runs strictly read-only validation & preview (`prepareInteractiveChapterSnapshot`).
 * 4. Step 3 commits to formal memory ONLY on explicit user click (`confirmed: true`)
 *    when the preview matches the current chapter selection and JSON text verbatim.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileJson,
  Loader2,
  Sparkles,
  X,
} from "lucide-react"
import {
  buildInteractiveIngestPrompt,
  commitInteractiveChapterSnapshot,
  isDraftChapterFile,
  parseChapterOrdinal,
  prepareInteractiveChapterSnapshot,
  type CommitInteractiveSnapshotResult,
  type PreparedInteractiveChapterSnapshot,
} from "@/lib/novel"
import type { FileNode } from "@/types/wiki"

export interface FormalChapterCandidate {
  chapterNumber: number
  path: string
  title: string
}

export interface AntigravitySnapshotIngestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  fileTree: FileNode[]
  defaultChapterPath?: string | null
  /** Optional pre-filled ChapterSnapshot JSON text (e.g. from an ACP assistant message). */
  initialRawJson?: string | null
  /** Optional positive integer chapter number used to pre-select the matching formal chapter. */
  initialChapterNumber?: number | null
  /** When true and `initialRawJson` is provided, automatically runs read-only Step 2 preview ONCE per open cycle (never auto-commits Step 3). */
  autoPreview?: boolean
  onPrefillPrompt: (prompt: string) => void
  onCommitted?: (result: CommitInteractiveSnapshotResult) => void
}

interface ValidatedSnapshotState {
  validationId: number
  rawJson: string
  chapterPath: string
  chapterNumber: number
  prepared: PreparedInteractiveChapterSnapshot
}

const CHAPTER_FILE_RE = /(?:^|\/)(?:wiki\/)?chapters\/([^/]+)\.md$/i
const FALLBACK_CHAPTER_PATTERNS: readonly RegExp[] = [
  /^(?:chapter|ch|c)[_\-\s]*0*(\d+)(?:$|[_\-\s.])/i,
  /^0*(\d+)(?:$|[_\-\s.])/,
]

function normalizeSlashes(rawPath: string): string {
  return rawPath.replace(/\\/g, "/")
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

function parseCandidateChapterNumber(stem: string): number | null {
  const ordinal = parseChapterOrdinal(stem)
  if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal >= 1) {
    return ordinal
  }
  for (const re of FALLBACK_CHAPTER_PATTERNS) {
    const match = stem.match(re)
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10)
      if (Number.isSafeInteger(parsed) && parsed >= 1) {
        return parsed
      }
    }
  }
  return null
}

/**
 * Pure in-memory collector that walks `wiki/chapters/` (or `chapters/`) in `fileTree`,
 * filters out draft files via `isDraftChapterFile`, parses chapter ordinals, and sorts
 * ascending by chapter number. Zero filesystem or Tauri IPC calls.
 */
export function collectFormalChapterCandidates(
  fileTree: FileNode[],
): FormalChapterCandidate[] {
  const candidates: FormalChapterCandidate[] = []
  const seenNormalizedPaths = new Set<string>()

  const walk = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children && node.children.length > 0) {
          walk(node.children)
        }
        continue
      }
      const normalized = normalizeSlashes(node.path)
      const match = normalized.match(CHAPTER_FILE_RE)
      if (!match) continue

      const stem = match[1]?.trim() ?? ""
      if (!stem) continue

      const filename = `${stem}.md`
      if (isDraftChapterFile(node.name) || isDraftChapterFile(filename)) {
        continue
      }

      const chapterNumber = parseCandidateChapterNumber(stem)
      if (chapterNumber === null) continue

      if (seenNormalizedPaths.has(normalized)) continue
      seenNormalizedPaths.add(normalized)

      candidates.push({
        chapterNumber,
        path: node.path,
        title: stem,
      })
    }
  }

  walk(fileTree)

  candidates.sort((a, b) =>
    a.chapterNumber !== b.chapterNumber
      ? a.chapterNumber - b.chapterNumber
      : normalizeSlashes(a.path).localeCompare(normalizeSlashes(b.path)),
  )

  return candidates
}

const KNOWN_FAIL_REASONS = new Set([
  "source_changed",
  "source_unavailable",
  "not_final",
  "duplicate_chapter_number",
  "not_chapter",
  "invalid_chapter_number",
  "cancelled",
])

function resolveInitialCandidatePath(
  candidates: FormalChapterCandidate[],
  initialChapterNumber: number | null | undefined,
  defaultChapterPath: string | null | undefined,
  currentSelectedPath: string,
): string {
  if (candidates.length === 0) return ""
  if (
    typeof initialChapterNumber === "number" &&
    Number.isSafeInteger(initialChapterNumber) &&
    initialChapterNumber >= 1
  ) {
    const matchedByNumber = candidates.find(
      (c) => c.chapterNumber === initialChapterNumber,
    )
    if (matchedByNumber) return matchedByNumber.path
  }
  if (currentSelectedPath && candidates.some((c) => c.path === currentSelectedPath)) {
    return currentSelectedPath
  }
  if (defaultChapterPath) {
    const normalizedDefault = normalizeSlashes(defaultChapterPath)
    const matchedDefault = candidates.find(
      (c) => normalizeSlashes(c.path) === normalizedDefault,
    )
    if (matchedDefault) return matchedDefault.path
  }
  return candidates[candidates.length - 1]!.path
}

export function AntigravitySnapshotIngestDialog({
  open,
  onOpenChange,
  projectPath,
  fileTree,
  defaultChapterPath = null,
  initialRawJson,
  initialChapterNumber = null,
  autoPreview = false,
  onPrefillPrompt,
  onCommitted,
}: AntigravitySnapshotIngestDialogProps) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const descId = useId()
  const chapterSelectId = useId()
  const jsonInputId = useId()

  const candidates = useMemo(
    () => collectFormalChapterCandidates(fileTree),
    [fileTree],
  )

  const [selectedPath, setSelectedPath] = useState<string>(() =>
    resolveInitialCandidatePath(candidates, initialChapterNumber, defaultChapterPath, ""),
  )
  const [rawJsonText, setRawJsonText] = useState<string>("")
  const [validating, setValidating] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [preparedState, setPreparedState] = useState<ValidatedSnapshotState | null>(null)
  const [committedValidationId, setCommittedValidationId] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [commitResult, setCommitResult] = useState<CommitInteractiveSnapshotResult | null>(null)

  const mountedRef = useRef(true)
  const opGenRef = useRef(0)
  const committingRef = useRef(false)
  const committedValidationIdRef = useRef<number | null>(null)
  const selectedPathRef = useRef<string>(selectedPath)
  selectedPathRef.current = selectedPath
  const openCycleRef = useRef(0)
  const autoPreviewedOpenCycleRef = useRef(0)
  const hadPresetOpenRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const suppressFocusRestoreRef = useRef(false)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      opGenRef.current += 1
      committingRef.current = false
    }
  }, [])

  // Step 2 core: Strictly read-only validate & preview with mountedRef + opGenRef race guard.
  // NEVER invokes commitInteractiveChapterSnapshot.
  const runReadOnlyValidation = useCallback(
    async (targetCandidate: FormalChapterCandidate, jsonSnapshot: string) => {
      if (!projectPath.trim() || !jsonSnapshot.trim() || committingRef.current) {
        return
      }
      const gen = ++opGenRef.current
      const targetPath = targetCandidate.path
      const targetChapter = targetCandidate.chapterNumber

      committedValidationIdRef.current = null
      setCommittedValidationId(null)
      setValidating(true)
      setErrorMsg(null)
      setCommitResult(null)
      try {
        const res = await prepareInteractiveChapterSnapshot(
          projectPath,
          targetPath,
          targetChapter,
          jsonSnapshot,
        )
        if (!mountedRef.current || gen !== opGenRef.current) return
        if (res.ok) {
          setPreparedState({
            validationId: gen,
            rawJson: jsonSnapshot,
            chapterPath: targetPath,
            chapterNumber: targetChapter,
            prepared: res.prepared,
          })
        } else {
          setPreparedState(null)
          setErrorMsg(res.error)
        }
      } catch (err) {
        if (!mountedRef.current || gen !== opGenRef.current) return
        setPreparedState(null)
        setErrorMsg(formatErrorMessage(err))
      } finally {
        if (mountedRef.current && gen === opGenRef.current) {
          setValidating(false)
        }
      }
    },
    [projectPath],
  )

  // Keep selectedPath aligned with available formal chapters when candidates or defaultChapterPath change.
  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedPath("")
      return
    }
    setSelectedPath((prev) =>
      resolveInitialCandidatePath(candidates, null, defaultChapterPath, prev),
    )
  }, [candidates, defaultChapterPath])

  // Manage WCAG dialog focus lifecycle, optional message preset prefill/autoPreview (read-only),
  // and discard in-flight operations when closing.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const currentCycle = ++openCycleRef.current
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      suppressFocusRestoreRef.current = false
      setErrorMsg(null)
      setCommitResult(null)
      // 若上次关闭前当前预览已提交，重新打开时清除该预览并重置已提交标记，避免重复提交旧预览
      const prevCommittedId = committedValidationIdRef.current
      if (prevCommittedId !== null) {
        setPreparedState((prev) =>
          prev && prev.validationId === prevCommittedId ? null : prev,
        )
      }
      committedValidationIdRef.current = null
      setCommittedValidationId(null)

      const hasInitialJson =
        typeof initialRawJson === "string" && initialRawJson.trim().length > 0
      const resolvedPath = resolveInitialCandidatePath(
        candidates,
        initialChapterNumber,
        defaultChapterPath,
        selectedPathRef.current,
      )
      if (resolvedPath !== selectedPathRef.current) {
        selectedPathRef.current = resolvedPath
        setSelectedPath(resolvedPath)
      }

      if (hasInitialJson) {
        hadPresetOpenRef.current = true
        setRawJsonText(initialRawJson)
        setPreparedState(null)
        const targetCandidate = candidates.find((c) => c.path === resolvedPath) ?? null
        if (
          autoPreview &&
          targetCandidate &&
          projectPath.trim() &&
          autoPreviewedOpenCycleRef.current !== currentCycle
        ) {
          autoPreviewedOpenCycleRef.current = currentCycle
          void runReadOnlyValidation(targetCandidate, initialRawJson)
        }
      } else if (initialRawJson === null && hadPresetOpenRef.current) {
        hadPresetOpenRef.current = false
        setRawJsonText("")
        setPreparedState(null)
      }

      dialogRef.current?.focus()
    } else if (!open && wasOpenRef.current) {
      opGenRef.current += 1
      committingRef.current = false
      setValidating(false)
      setCommitting(false)
      if (!suppressFocusRestoreRef.current) {
        const prevEl = previousFocusRef.current
        if (prevEl && prevEl.isConnected) {
          prevEl.focus()
        }
      }
      suppressFocusRestoreRef.current = false
      previousFocusRef.current = null
    }
    wasOpenRef.current = open
  }, [
    autoPreview,
    candidates,
    defaultChapterPath,
    initialChapterNumber,
    initialRawJson,
    open,
    projectPath,
    runReadOnlyValidation,
  ])

  // Close on Escape unless a commit is actively in flight.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (!committing) {
          onOpenChange(false)
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [committing, onOpenChange, open])

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.path === selectedPath) ?? null,
    [candidates, selectedPath],
  )

  const isPreviewFresh = Boolean(
    preparedState &&
      selectedCandidate &&
      preparedState.rawJson === rawJsonText &&
      preparedState.chapterPath === selectedCandidate.path &&
      preparedState.chapterNumber === selectedCandidate.chapterNumber,
  )

  const isPreviewStale = Boolean(preparedState && !isPreviewFresh)

  // 防止同一份已校验预览被误点两次重复提交（仅在重新校验新预览后解除）
  const hasCommittedCurrentPreview = Boolean(
    isPreviewFresh &&
      preparedState &&
      committedValidationId !== null &&
      committedValidationId === preparedState.validationId,
  )

  const handleClose = useCallback(() => {
    if (committing) return
    onOpenChange(false)
  }, [committing, onOpenChange])

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !committing) {
        onOpenChange(false)
      }
    },
    [committing, onOpenChange],
  )

  // Step 1: Pre-fill read-only extraction prompt into ACP composer (never auto-sends).
  const handlePrefillPrompt = useCallback(() => {
    if (!selectedCandidate || committing) return
    const prompt = buildInteractiveIngestPrompt({
      chapterNumber: selectedCandidate.chapterNumber,
      chapterPath: selectedCandidate.path,
      chapterTitle: selectedCandidate.title,
      lang: i18n.language || "zh",
    })
    suppressFocusRestoreRef.current = true
    onPrefillPrompt(prompt)
    onOpenChange(false)
  }, [committing, i18n.language, onOpenChange, onPrefillPrompt, selectedCandidate])

  // Step 2: Manual trigger delegating to the shared read-only validation runner.
  const handleValidate = useCallback(async () => {
    if (!selectedCandidate || !projectPath.trim() || !rawJsonText.trim() || validating || committing) {
      return
    }
    await runReadOnlyValidation(selectedCandidate, rawJsonText)
  }, [committing, projectPath, rawJsonText, runReadOnlyValidation, selectedCandidate, validating])

  // Step 3: Explicit human-confirmed commit to formal memory.
  const handleCommit = useCallback(async () => {
    if (
      !isPreviewFresh ||
      !preparedState ||
      hasCommittedCurrentPreview ||
      committedValidationIdRef.current === preparedState.validationId ||
      !projectPath.trim() ||
      validating ||
      committing ||
      committingRef.current
    ) {
      return
    }
    const gen = ++opGenRef.current
    const targetValidationId = preparedState.validationId
    committingRef.current = true
    setCommitting(true)
    setErrorMsg(null)
    setCommitResult(null)
    try {
      const result = await commitInteractiveChapterSnapshot(
        projectPath,
        preparedState.prepared,
        { confirmed: true },
      )
      if (!mountedRef.current || gen !== opGenRef.current) return

      const ingest = result.ingestResult
      if (ingest.snapshot === null) {
        const reason = ingest.failReason ?? "unknown"
        const mappedError = KNOWN_FAIL_REASONS.has(reason)
          ? t(`antigravityAcp.snapshotIngest.failReasons.${reason}`)
          : t("antigravityAcp.snapshotIngest.failReasons.unknown", { reason })
        if (reason === "source_changed" || reason === "source_unavailable") {
          setPreparedState(null)
        }
        setErrorMsg(mappedError)
        return
      }

      committedValidationIdRef.current = targetValidationId
      setCommittedValidationId(targetValidationId)
      setCommitResult(result)
      onCommitted?.(result)
    } catch (err) {
      if (!mountedRef.current || gen !== opGenRef.current) return
      setErrorMsg(formatErrorMessage(err))
    } finally {
      if (gen === opGenRef.current) {
        committingRef.current = false
      }
      if (mountedRef.current && gen === opGenRef.current) {
        setCommitting(false)
      }
    }
  }, [
    committing,
    hasCommittedCurrentPreview,
    isPreviewFresh,
    onCommitted,
    preparedState,
    projectPath,
    t,
    validating,
  ])

  if (!open) return null

  const previewSnapshot = preparedState?.prepared.snapshot ?? null
  const previewValidationWarnings = preparedState?.prepared.validationWarnings ?? []
  const previewDegradedNotices = preparedState?.prepared.warnings ?? []

  const committedIngest =
    commitResult && commitResult.ingestResult.snapshot !== null
      ? commitResult.ingestResult
      : null
  const committedMemoryStatus = committedIngest && commitResult ? commitResult.memoryStatus : null

  const effectiveCanonOutcome =
    committedIngest?.canonOutcome ?? committedMemoryStatus?.canonOutcome
  const canonOutcomeStatus = effectiveCanonOutcome?.status ?? "unknown"
  const canonOutcomeLabel =
    canonOutcomeStatus === "completed" ||
    canonOutcomeStatus === "skipped" ||
    canonOutcomeStatus === "failed"
      ? t(`antigravityAcp.snapshotIngest.result.canonOutcomes.${canonOutcomeStatus}`)
      : t("antigravityAcp.snapshotIngest.result.canonOutcomes.unknown")
  const canonOutcomeDetail =
    effectiveCanonOutcome &&
    (effectiveCanonOutcome.status === "failed" ||
      effectiveCanonOutcome.status === "skipped")
      ? effectiveCanonOutcome.reason
      : null

  // 完整收集所有部分失败/延迟/未对账信号，防止 memoryStatus.ingest !== "ok" 伪装成纯绿成功
  const partialDetails: string[] = []
  if (committedIngest && committedMemoryStatus) {
    const factsStoreFailed = Boolean(
      committedIngest.factsStoreFailed || committedMemoryStatus.factsStoreFailed,
    )
    const ledgerSaveFailed = Boolean(
      committedIngest.ledgerSaveFailed || committedMemoryStatus.ledgerSaveFailed,
    )
    const failedProjections = Array.from(
      new Set([
        ...(committedIngest.failedProjections ?? []),
        ...(committedMemoryStatus.failedProjections ?? []),
      ]),
    )
    const pendingProjections = Array.from(
      new Set([
        ...(committedIngest.pendingProjections ?? []),
        ...(committedMemoryStatus.pendingProjections ?? []),
      ]),
    )
    const canonFailed = effectiveCanonOutcome?.status === "failed"
    const canonUnreconciled = Boolean(
      effectiveCanonOutcome?.status === "completed" &&
        ((effectiveCanonOutcome.report?.queued ?? 0) > 0 ||
          effectiveCanonOutcome.report?.reconcile?.consistent === false),
    )

    if (factsStoreFailed) {
      partialDetails.push(t("antigravityAcp.snapshotIngest.result.factsStoreFailed"))
    }
    if (ledgerSaveFailed) {
      partialDetails.push(t("mainControl.draftIngestLedgerFailed"))
    }
    if (failedProjections.length > 0) {
      partialDetails.push(
        t("antigravityAcp.snapshotIngest.result.failedProjections", {
          list: failedProjections.join(", "),
        }),
      )
    }
    if (pendingProjections.length > 0) {
      partialDetails.push(
        t("mainControl.draftIngestPending", {
          projections: pendingProjections.join(", "),
        }),
      )
    }
    if (committedIngest.projectionError) {
      partialDetails.push(
        t("antigravityAcp.snapshotIngest.result.projectionError", {
          stage: committedIngest.projectionError.stage,
          message: committedIngest.projectionError.message,
        }),
      )
    }
    if (canonFailed) {
      const reason = effectiveCanonOutcome.reason?.trim()
      partialDetails.push(
        reason
          ? `${t("mainControl.draftIngestCanonFailed")} (${reason})`
          : t("mainControl.draftIngestCanonFailed"),
      )
    }
    if (canonUnreconciled && effectiveCanonOutcome?.status === "completed") {
      partialDetails.push(
        t("mainControl.draftIngestCanonUnreconciled", {
          queued: effectiveCanonOutcome.report?.queued ?? 0,
        }),
      )
    }
    if (committedMemoryStatus.ingest !== "ok" && partialDetails.length === 0) {
      if (committedMemoryStatus.failReason === "ingest_error") {
        partialDetails.push(t("mainControl.draftIngestUnexpectedError"))
      } else if (committedMemoryStatus.ingest === "failed") {
        const reason =
          !committedMemoryStatus.failReason ||
          committedMemoryStatus.failReason === "memory_incomplete"
            ? t("mainControl.draftIngestMissingEvidence")
            : committedMemoryStatus.failReason
        partialDetails.push(t("mainControl.draftIngestFailed", { reason }))
      } else {
        const reason =
          !committedMemoryStatus.failReason ||
          committedMemoryStatus.failReason === "memory_incomplete"
            ? `${t("mainControl.draftIngestMissingEvidence")} (${committedMemoryStatus.ingest})`
            : `${committedMemoryStatus.failReason} (${committedMemoryStatus.ingest})`
        partialDetails.push(t("mainControl.draftIngestIncomplete", { reason }))
      }
    }
  }

  const hasPartialCommitWarnings = Boolean(
    committedIngest &&
      committedMemoryStatus &&
      (partialDetails.length > 0 || committedMemoryStatus.ingest !== "ok"),
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[1px]"
      onMouseDown={handleBackdropClick}
      data-testid="acp-snapshot-ingest-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        data-testid="acp-snapshot-ingest-dialog"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl outline-none"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" aria-hidden="true" />
              <h2 id={titleId} className="text-base font-semibold">
                {t("antigravityAcp.snapshotIngest.title")}
              </h2>
            </div>
            <p id={descId} className="text-xs text-muted-foreground">
              {t("antigravityAcp.snapshotIngest.description")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={committing}
            aria-label={t("antigravityAcp.snapshotIngest.close")}
            data-testid="snapshot-ingest-close-btn"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {/* Step 1: Select formal chapter & pre-fill prompt */}
          <section className="space-y-2 rounded-md border border-border/60 bg-muted/15 p-3">
            <div className="font-medium text-foreground">
              {t("antigravityAcp.snapshotIngest.step1Title")}
            </div>

            {candidates.length === 0 ? (
              <p
                role="status"
                data-testid="snapshot-ingest-no-chapters"
                className="rounded border border-dashed border-border/70 px-3 py-2 text-muted-foreground"
              >
                {t("antigravityAcp.snapshotIngest.noChapters")}
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={chapterSelectId} className="font-medium text-muted-foreground">
                    {t("antigravityAcp.snapshotIngest.chapterLabel")}
                  </label>
                  <select
                    id={chapterSelectId}
                    value={selectedPath}
                    disabled={validating || committing}
                    onChange={(e) => {
                      setSelectedPath(e.target.value)
                      setErrorMsg(null)
                      setCommitResult(null)
                    }}
                    data-testid="snapshot-ingest-chapter-select"
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                  >
                    {candidates.map((cand) => (
                      <option key={cand.path} value={cand.path}>
                        {t("antigravityAcp.snapshotIngest.chapterOption", {
                          chapter: cand.chapterNumber,
                          title: cand.title,
                        })}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!selectedCandidate || committing}
                    onClick={handlePrefillPrompt}
                    data-testid="snapshot-ingest-prefill-btn"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t("antigravityAcp.snapshotIngest.prefillBtn")}</span>
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.prefillHint")}
                </p>
              </div>
            )}
          </section>

          {/* Step 2: Paste JSON & Read-Only Validate */}
          <section className="space-y-2 rounded-md border border-border/60 bg-muted/15 p-3">
            <div className="font-medium text-foreground">
              {t("antigravityAcp.snapshotIngest.step2Title")}
            </div>
            <label htmlFor={jsonInputId} className="block text-[11px] text-muted-foreground">
              {t("antigravityAcp.snapshotIngest.jsonLabel")}
            </label>
            <textarea
              id={jsonInputId}
              rows={6}
              value={rawJsonText}
              disabled={committing}
              onChange={(e) => {
                setRawJsonText(e.target.value)
                setErrorMsg(null)
                setCommitResult(null)
              }}
              placeholder={t("antigravityAcp.snapshotIngest.jsonPlaceholder")}
              data-testid="snapshot-ingest-json-input"
              className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                disabled={
                  !projectPath.trim() ||
                  !selectedCandidate ||
                  !rawJsonText.trim() ||
                  validating ||
                  committing
                }
                aria-busy={validating}
                onClick={() => void handleValidate()}
                data-testid="snapshot-ingest-validate-btn"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50"
              >
                {validating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>
                  {validating
                    ? t("antigravityAcp.snapshotIngest.validating")
                    : t("antigravityAcp.snapshotIngest.validateBtn")}
                </span>
              </button>
            </div>
          </section>

          {/* Stale preview notice when JSON or chapter changed after last validation */}
          {isPreviewStale && (
            <div
              role="status"
              aria-live="polite"
              data-testid="snapshot-ingest-stale-notice"
              className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/15 px-3 py-2 text-xs text-warning-foreground"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t("antigravityAcp.snapshotIngest.staleNotice")}</span>
            </div>
          )}

          {/* Error alert */}
          {errorMsg && (
            <div
              role="alert"
              data-testid="snapshot-ingest-error"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="break-words">{errorMsg}</span>
            </div>
          )}

          {/* Structured Read-Only Preview Card (ZERO dangerouslySetInnerHTML) */}
          {previewSnapshot && preparedState && (
            <section
              data-testid="snapshot-ingest-preview"
              className="space-y-2.5 rounded-md border border-border bg-card p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
                <span className="font-semibold text-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.heading", {
                    chapter: preparedState.chapterNumber,
                  })}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {preparedState.chapterPath}
                </span>
              </div>

              <div>
                <div className="font-medium text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.summaryLabel")}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                  {previewSnapshot.summary.trim() ||
                    t("antigravityAcp.snapshotIngest.preview.emptyValue")}
                </p>
              </div>

              <div>
                <div className="font-medium text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.charactersLabel", {
                    count: previewSnapshot.characters.length,
                  })}
                </div>
                {previewSnapshot.characters.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {previewSnapshot.characters.map((name, idx) => (
                      <span
                        key={`${name}-${idx}`}
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-0.5 text-muted-foreground">
                    {t("antigravityAcp.snapshotIngest.preview.emptyValue")}
                  </p>
                )}
              </div>

              <div>
                <div className="font-medium text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.canonFactsLabel", {
                    count: previewSnapshot.newCanonFacts.length,
                  })}
                </div>
                {previewSnapshot.newCanonFacts.length > 0 ? (
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-foreground">
                    {previewSnapshot.newCanonFacts.map((fact, idx) => (
                      <li key={`canon-${idx}`} className="break-words">
                        {fact}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-muted-foreground">
                    {t("antigravityAcp.snapshotIngest.preview.emptyValue")}
                  </p>
                )}
              </div>

              <div>
                <div className="font-medium text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.foreshadowingLabel", {
                    count: previewSnapshot.foreshadowingChanges.length,
                  })}
                </div>
                {previewSnapshot.foreshadowingChanges.length > 0 ? (
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-foreground">
                    {previewSnapshot.foreshadowingChanges.map((item, idx) => (
                      <li key={`foreshadow-${idx}`} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-muted-foreground">
                    {t("antigravityAcp.snapshotIngest.preview.emptyValue")}
                  </p>
                )}
              </div>

              <div>
                <div className="font-medium text-muted-foreground">
                  {t("antigravityAcp.snapshotIngest.preview.timelineLabel", {
                    count: previewSnapshot.timelineEvents.length,
                  })}
                </div>
                {previewSnapshot.timelineEvents.length > 0 ? (
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-foreground">
                    {previewSnapshot.timelineEvents.map((ev, idx) => (
                      <li key={`timeline-${idx}`} className="break-words">
                        {ev}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-muted-foreground">
                    {t("antigravityAcp.snapshotIngest.preview.emptyValue")}
                  </p>
                )}
              </div>

              {previewValidationWarnings.length > 0 && (
                <div className="rounded border border-warning/40 bg-warning/10 p-2 text-warning-foreground">
                  <div className="font-medium">
                    {t("antigravityAcp.snapshotIngest.preview.warningsLabel", {
                      count: previewValidationWarnings.length,
                    })}
                  </div>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {previewValidationWarnings.map((warn, idx) => (
                      <li key={`warn-${idx}`} className="break-words">
                        [{warn.type}] {warn.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {previewDegradedNotices.length > 0 && (
                <div className="rounded border border-border/60 bg-muted/30 p-2 text-muted-foreground">
                  <div className="font-medium">
                    {t("antigravityAcp.snapshotIngest.preview.degradedNoticesLabel", {
                      count: previewDegradedNotices.length,
                    })}
                  </div>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {previewDegradedNotices.map((msg, idx) => (
                      <li key={`notice-${idx}`} className="break-words">
                        {msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Commit Receipt (clean success vs. partial/warning outcome) */}
          {committedIngest && committedIngest.snapshot && committedMemoryStatus && (
            <div
              role="status"
              aria-live="polite"
              data-testid="snapshot-ingest-result"
              data-ingest-status={committedMemoryStatus.ingest}
              data-partial-warnings={hasPartialCommitWarnings ? "true" : "false"}
              className={
                hasPartialCommitWarnings
                  ? "space-y-1.5 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-xs text-warning-foreground"
                  : "space-y-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-xs text-success-foreground"
              }
            >
              <div className="flex items-center gap-1.5 font-semibold">
                {hasPartialCommitWarnings ? (
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {t("antigravityAcp.snapshotIngest.result.committedTitle", {
                    chapter: committedIngest.snapshot.chapterNumber,
                  })}
                </span>
              </div>
              <div>
                {t("antigravityAcp.snapshotIngest.result.canonOutcome", {
                  outcome: canonOutcomeDetail
                    ? `${canonOutcomeLabel} (${canonOutcomeDetail})`
                    : canonOutcomeLabel,
                })}
              </div>
              {hasPartialCommitWarnings && (
                <div
                  data-testid="snapshot-ingest-partial-warnings"
                  className="mt-1 space-y-0.5 rounded border border-warning/40 bg-warning/15 px-2.5 py-1.5 text-warning-foreground"
                >
                  <div className="font-medium">
                    {t("antigravityAcp.snapshotIngest.result.partialWarningsTitle")}
                  </div>
                  {partialDetails.map((detail, idx) => (
                    <div key={`partial-${idx}`} className="break-words">
                      {detail}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — Step 3 Confirm & Commit */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-muted/10 px-5 py-3 text-xs">
          <span className="text-[11px] text-muted-foreground">
            {t("antigravityAcp.snapshotIngest.step3Title")}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={committing}
              className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              {t("antigravityAcp.snapshotIngest.close")}
            </button>
            <button
              type="button"
              disabled={
                !isPreviewFresh ||
                hasCommittedCurrentPreview ||
                validating ||
                committing ||
                !projectPath.trim()
              }
              aria-busy={committing}
              onClick={() => void handleCommit()}
              data-testid="snapshot-ingest-commit-btn"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {committing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {committing
                  ? t("antigravityAcp.snapshotIngest.committing")
                  : t("antigravityAcp.snapshotIngest.commitBtn")}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
