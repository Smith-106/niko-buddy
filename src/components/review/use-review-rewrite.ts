import { useCallback, useState } from "react"
import type { useTranslation } from "react-i18next"
import { formatOperationError } from "@/lib/format-operation-error"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveDefaultModel } from "@/lib/novel"
import { readFile, writeFileAtomic } from "@/commands/fs"
import {
  restoreDashboardRewriteInMarkdown,
  type DashboardIssueState,
} from "@/lib/dashboard-issue-actions"
import type { NovelReviewActionItem } from "@/lib/novel-review-action-items"
import {
  applyReviewRewriteEditsToMarkdown,
  generateReviewRewriteEdits,
  type ReviewRewriteEdit,
  type ReviewRewriteIssue,
} from "@/lib/review-rewrite-plan"
import type { ReviewRewriteEditState } from "./review-cards"
import { useWikiStore, type WikiState } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

export interface ReviewRewriteDialogState {
  item: NovelReviewActionItem
  targetPath: string
  chapterContent: string
  edits: ReviewRewriteEditState[]
}

type TranslateFn = ReturnType<typeof useTranslation>["t"]

export interface UseReviewRewriteOptions {
  project: WikiState["project"]
  issueState: DashboardIssueState
  persistIssueState: (nextState: DashboardIssueState) => Promise<void>
  showAiRewriteAlert: (message: string) => void
  t: TranslateFn
  bumpDataVersion: WikiState["bumpDataVersion"]
  selectedFile: WikiState["selectedFile"]
  setFileContent: WikiState["setFileContent"]
  setPendingEditorHighlight: WikiState["setPendingEditorHighlight"]
  setSelectedFile: WikiState["setSelectedFile"]
  setActiveView: WikiState["setActiveView"]
}

/**
 * AI 改写垂直簇（M6-3 自 review-view.tsx 剥离）：
 * rewrite dialog state ×3 + 改写引擎回调 ×7 + edit-state 回调 ×4。
 * 调用方解构同名符号，消费点（action bar / preview dialog）零改动。
 */
export function useReviewRewrite({
  project,
  issueState,
  persistIssueState,
  showAiRewriteAlert,
  t,
  bumpDataVersion,
  selectedFile,
  setFileContent,
  setPendingEditorHighlight,
  setSelectedFile,
  setActiveView,
}: UseReviewRewriteOptions) {
  const [rewriteDialog, setRewriteDialog] = useState<ReviewRewriteDialogState | null>(null)
  const [rewriteBusyId, setRewriteBusyId] = useState<string | null>(null)
  const [rewriteError, setRewriteError] = useState<string | null>(null)

  const generateNovelReviewRewriteEdits = useCallback(async (
    item: NovelReviewActionItem,
    chapterContent: string,
    targetOriginalText?: string,
  ): Promise<ReviewRewriteEdit[]> => {
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    const issue: ReviewRewriteIssue = {
      message: item.message,
      suggestion: item.suggestion,
      evidence: item.evidence,
      secondaryEvidence: item.secondaryEvidence,
      chapterContent,
    }
    return generateReviewRewriteEdits(issue, chapterContent, llmConfig, {
      targetOriginalText,
    })
  }, [])

  const runNovelReviewAiRewrite = useCallback(async (item: NovelReviewActionItem) => {
    if (!project) {
      showAiRewriteAlert(t("review.rewrite.alertNoProject"))
      return
    }
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      showAiRewriteAlert(t("review.rewrite.alertNoModel"))
      return
    }

    const chapterContent = await readFile(item.targetPath).catch(() => "")
    if (!chapterContent) {
      showAiRewriteAlert(t("review.rewrite.alertNoChapter"))
      return
    }

    setRewriteBusyId(item.id)
    setRewriteError(null)
    setRewriteDialog({
      item,
      targetPath: item.targetPath,
      chapterContent,
      edits: [],
    })

    try {
      const edits = await generateNovelReviewRewriteEdits(item, chapterContent)
      if (edits.length === 0) {
        setRewriteError(t("review.rewrite.errorNoEdits"))
        return
      }
      setRewriteDialog((current) => {
        if (!current || current.item.id !== item.id) return current
        return {
          ...current,
          edits: edits.map((edit, index) => ({
            ...edit,
            id: `${item.id}:edit-${index + 1}`,
            status: "pending",
            editing: false,
          })),
        }
      })
    } catch (error) {
      // F-16 (CWE-532 / PAT-DC1-MSG-UI): err.message from the LLM transport may
      // carry provider endpoint URL / auth header — strip before surfacing in
      // the rewriteError banner. Raw message logged to console only.
      // (Twin of dashboard-view.tsx rewrite catch + ingest.ts activity sites.)
      const raw = toErrorMessage(error)
      console.error("[ReviewView] AI review rewrite failed:", raw)
      const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
      setRewriteError(safe || t("review.rewrite.errorRegenerate"))
    } finally {
      setRewriteBusyId(null)
    }
  }, [generateNovelReviewRewriteEdits, project, showAiRewriteAlert])

  const handleApplyRewrite = useCallback(async () => {
    /* v8 ignore next */
    if (!rewriteDialog) return
    /* v8 ignore next */
    if (rewriteBusyId === rewriteDialog.item.id) return
    if (rewriteError) return
    const activeEdits = rewriteDialog.edits
      .filter((edit) => edit.status !== "ignored" && edit.replacementText.trim())
      .map((edit) => ({
        id: edit.id,
        originalText: edit.originalText,
        replacementText: edit.replacementText,
        note: edit.note,
      }))
    /* v8 ignore next */
    if (activeEdits.length === 0) {
      setRewriteError(t("review.rewrite.errorNoActiveEdits"))
      return
    }

    const latestMarkdown = await readFile(rewriteDialog.targetPath).catch(() => "")
    if (!latestMarkdown) return

    const applyResult = applyReviewRewriteEditsToMarkdown(latestMarkdown, activeEdits)
    if (!applyResult.ok) {
      setRewriteError(t("review.rewrite.errorAnchorFailed", { count: applyResult.failed.length }))
      return
    }

    try {
      await writeFileAtomic(rewriteDialog.targetPath, applyResult.markdown)
    } catch (err) {
      setRewriteError(formatOperationError(t, err))
      return
    }
    bumpDataVersion()
    if (selectedFile === rewriteDialog.targetPath) {
      setFileContent(applyResult.markdown)
      setPendingEditorHighlight({
        path: rewriteDialog.targetPath,
        text: activeEdits[0]?.replacementText ?? "", /* v8 ignore start */ /* v8 ignore stop */
        nonce: Date.now(),
      })
    }

    const nextRewrites = { ...issueState.rewrites }
    for (const applied of applyResult.applied) {
      nextRewrites[applied.edit.id] = {
        ...applied.backup,
        itemId: applied.edit.id,
        targetPath: rewriteDialog.targetPath,
      }
    }

    await persistIssueState({
      ...issueState,
      rewrites: nextRewrites,
    })
    setRewriteError(null)
    setRewriteDialog(null)
  }, [bumpDataVersion, issueState, persistIssueState, rewriteBusyId, rewriteDialog, rewriteError, selectedFile, setFileContent, setPendingEditorHighlight])

  const handleRegenerateAllRewrite = useCallback(async () => {
    /* v8 ignore next */
    if (!rewriteDialog) return
    setRewriteError(null)
    await runNovelReviewAiRewrite(rewriteDialog.item)
  }, [rewriteDialog, runNovelReviewAiRewrite])

  const handleRegenerateOneRewrite = useCallback(async (editId: string) => {
    /* v8 ignore next */
    if (!rewriteDialog) return
    const edit = rewriteDialog.edits.find((item) => item.id === editId)
    /* v8 ignore next */
    if (!edit) return

    setRewriteBusyId(editId)
    setRewriteError(null)
    try {
      const latestMarkdown = await readFile(rewriteDialog.targetPath).catch(() => rewriteDialog.chapterContent)
      const edits = await generateNovelReviewRewriteEdits(rewriteDialog.item, latestMarkdown, edit.originalText)
      const nextEdit = edits[0]
      if (!nextEdit) {
        setRewriteError(t("review.rewrite.errorSingleNoResult"))
        return
      }
      setRewriteDialog((current) => {
        /* v8 ignore next */
        if (!current || current.item.id !== rewriteDialog.item.id) return current
        return {
          ...current,
          edits: current.edits.map((row) => row.id === editId
            ? {
              ...row,
              replacementText: nextEdit.replacementText,
              note: nextEdit.note,
              status: "pending",
            }
            : row),
        }
      })
    } catch (error) {
      // F-16 (CWE-532 / PAT-DC1-MSG-UI): catch-path twin of the generate-rewrite
      // catch above. err.message may carry provider URL/auth — strip before UI.
      const raw = toErrorMessage(error)
      console.error("[ReviewView] rewrite apply failed:", raw)
      const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
      setRewriteError(safe || t("review.rewrite.errorRegenerate"))
    } finally {
      setRewriteBusyId(null)
    }
  }, [generateNovelReviewRewriteEdits, rewriteDialog])

  const handleRestoreRewrite = useCallback(async (item: NovelReviewActionItem) => {
    const backupEntries = Object.entries(issueState.rewrites)
      .filter(([key]) => key === item.id || key.startsWith(`${item.id}:`))
      .reverse()
    /* v8 ignore next */
    if (backupEntries.length === 0) return

    const firstBackup = backupEntries[0][1]
    const latestMarkdown = await readFile(firstBackup.targetPath).catch(() => "")
    if (!latestMarkdown) return

    let restoredMarkdown = latestMarkdown
    for (const [, backup] of backupEntries) {
      const nextMarkdown = restoreDashboardRewriteInMarkdown(restoredMarkdown, backup)
      if (nextMarkdown) restoredMarkdown = nextMarkdown
    }

    await writeFileAtomic(firstBackup.targetPath, restoredMarkdown)
    bumpDataVersion()
    if (selectedFile === firstBackup.targetPath) {
      setFileContent(restoredMarkdown)
      setPendingEditorHighlight({
        path: firstBackup.targetPath,
        text: firstBackup.originalText,
        nonce: Date.now(),
      })
    }

    const rest = { ...issueState.rewrites }
    for (const [key] of backupEntries) {
      delete rest[key]
    }
    await persistIssueState({
      ...issueState,
      rewrites: rest,
    })
  }, [bumpDataVersion, issueState, persistIssueState, selectedFile, setFileContent, setPendingEditorHighlight])

  const handleViewRewrite = useCallback(async (item: NovelReviewActionItem) => {
    const backupEntries = Object.entries(issueState.rewrites)
      .filter(([key]) => key === item.id || key.startsWith(`${item.id}:`))
      .map(([, backup]) => backup)
    const firstBackup = backupEntries[0]
    /* v8 ignore next */
    if (!firstBackup) return
    const latestMarkdown = await readFile(firstBackup.targetPath).catch(() => "")
    if (!latestMarkdown) return

    const highlightText = backupEntries
      .map((backup) => backup.replacementText)
      .find((text) => text && latestMarkdown.includes(text))
      || firstBackup.replacementText

    setSelectedFile(firstBackup.targetPath)
    setFileContent(latestMarkdown)
    setActiveView("wiki")
    setPendingEditorHighlight({
      path: firstBackup.targetPath,
      text: highlightText,
      nonce: Date.now(),
    })
  }, [issueState.rewrites, setActiveView, setFileContent, setPendingEditorHighlight, setSelectedFile])

  const handleRewriteEditReplacementChange = useCallback((editId: string, replacementText: string) => {
    /* v8 ignore next */
    setRewriteDialog((current) => current
      ? {
        ...current,
        edits: current.edits.map((edit) => edit.id === editId
          ? { ...edit, replacementText, status: "pending" }
          : edit),
      }
      : current)
  }, [])

  const handleRewriteEditIgnoredChange = useCallback((editId: string, ignored: boolean) => {
    /* v8 ignore next */
    setRewriteDialog((current) => current
      ? {
        ...current,
        edits: current.edits.map((edit) => edit.id === editId
          ? { ...edit, status: ignored ? "ignored" : "pending" }
          : edit),
      }
      : current)
  }, [])

  const handleIgnoreAllRewriteEdits = useCallback(() => {
    /* v8 ignore next */
    setRewriteDialog((current) => current
      ? {
        ...current,
        edits: current.edits.map((edit) => ({ ...edit, status: "ignored" })),
      }
      : current)
  }, [])

  const handleEditAllRewriteEdits = useCallback(() => {
    /* v8 ignore next */
    setRewriteDialog((current) => current
      ? {
        ...current,
        edits: current.edits.map((edit) => ({ ...edit, status: "pending", editing: true })),
      }
      : current)
  }, [])

  return {
    rewriteDialog,
    setRewriteDialog,
    rewriteBusyId,
    rewriteError,
    setRewriteError,
    generateNovelReviewRewriteEdits,
    runNovelReviewAiRewrite,
    handleApplyRewrite,
    handleRegenerateAllRewrite,
    handleRegenerateOneRewrite,
    handleRestoreRewrite,
    handleViewRewrite,
    handleRewriteEditReplacementChange,
    handleRewriteEditIgnoredChange,
    handleIgnoreAllRewriteEdits,
    handleEditAllRewriteEdits,
  }
}
