import { useState, useMemo, useCallback, useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveDefaultModel } from "@/lib/novel/model-resolver"
import { readFile, writeFile } from "@/commands/fs"
import {
  AlertTriangle,
  AlertOctagon,
  Info,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { LintResult } from "@/lib/lint"
import { searchWiki } from "@/lib/search"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { runFactCheck, type FactCheckResult, type FactCheckReport } from "@/lib/novel/fact-snapshot"
import { analyzeForeshadowingDebt, type ForeshadowingDebtReport } from "@/lib/novel/foreshadowing-debt"
import { loadSnapshot, listSnapshots, type ChapterSnapshot } from "@/lib/novel/chapter-ingest"
import { loadForeshadowingTracker } from "@/lib/novel/foreshadowing-tracker"
import { loadNovelSessionStatus, subscribeStatusJson, type ChaseDebt, type ChaseDebtEvent } from "@/lib/novel/novel-session-status"
import { getTopEmotionalDebt, loadEmotionLedger, type EmotionLedgerEntry } from "@/lib/novel/emotion-ledger"
import { DebtBoardView } from "./debt-board-view"
import { TextTransformPreviewDialog } from "@/components/novel/text-transform-preview-dialog"
import { streamChat } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import {
  applyDashboardRewriteToMarkdown,
  buildFactCheckInsertMessages,
  buildDashboardRewriteMessages,
  buildDashboardIssueId,
  createEmptyDashboardIssueState,
  findChapterSelectionByEvidence,
  loadDashboardIssueState,
  parseFactCheckInsertPlan,
  restoreDashboardRewriteInMarkdown,
  saveDashboardIssueState,
  type DashboardIssueAnchor,
  type DashboardIssueRewriteBackup,
  type DashboardIssueState,
} from "@/lib/dashboard-issue-actions"

type DashSeverity = "blocking" | "high" | "medium" | "low"

interface DashItem {
  id: string
  severity: DashSeverity
  source: "review" | "lint" | "factcheck"
  message: string
  detail: string
  evidence?: string
  secondaryEvidence?: string
  suggestion?: string
  targetPath?: string | null
  targetChapterNumber?: number
}

interface RewriteDialogState {
  mode: "replace" | "insert_before"
  item: DashItem
  targetPath: string
  anchor: DashboardIssueAnchor | null
  sourceContent: string
  candidateContent: string
}

const SEVERITY_CONFIG: Record<DashSeverity, { icon: typeof AlertTriangle; labelKey: string; color: string; bgColor: string; dotClass: string }> = {
  blocking: { icon: AlertOctagon, labelKey: "dashboard.severity.blocking", color: "text-destructive", bgColor: "border-destructive/30 bg-destructive/5", dotClass: "bg-destructive" },
  high: { icon: ShieldAlert, labelKey: "dashboard.severity.high", color: "text-warning", bgColor: "border-warning/30 bg-warning/5", dotClass: "bg-warning" },
  medium: { icon: AlertTriangle, labelKey: "dashboard.severity.medium", color: "text-warning", bgColor: "border-warning/20 bg-warning/5", dotClass: "bg-warning" },
  low: { icon: Info, labelKey: "dashboard.severity.low", color: "text-muted-foreground", bgColor: "border-border bg-muted/30", dotClass: "bg-muted-foreground" },
}

const FACT_CHECK_TYPE_LABEL_KEYS: Record<FactCheckResult["type"], string> = {
  character_jump: "dashboard.factCheckType.character_jump",
  location_conflict: "dashboard.factCheckType.location_conflict",
  item_holder_change: "dashboard.factCheckType.item_holder_change",
  org_flip: "dashboard.factCheckType.org_flip",
  timeline_conflict: "dashboard.factCheckType.timeline_conflict",
  setting_conflict: "dashboard.factCheckType.setting_conflict",
  relationship_reversal: "dashboard.factCheckType.relationship_reversal",
  causality_break: "dashboard.factCheckType.causality_break",
}

const DEBT_LEVEL_LABEL_KEYS: Record<"critical" | "warning", string> = {
  critical: "dashboard.debtLevel.critical",
  warning: "dashboard.debtLevel.warning",
}

function mapReviewSeverity(severity: NovelReviewResult["severity"]): DashSeverity {
  switch (severity) {
    case "error": return "high"
    case "warning": return "medium"
    case "info": return "low"
    default: return "medium"
  }
}

function mapLintSeverity(severity: LintResult["severity"]): DashSeverity {
  switch (severity) {
    case "warning": return "medium"
    case "info": return "low"
    default: return "medium"
  }
}

function mapFactCheckSeverity(severity: FactCheckResult["severity"]): DashSeverity {
  switch (severity) {
    case "blocking": return "blocking"
    case "high": return "high"
    case "medium": return "medium"
    case "low": return "low"
    default: return "medium"
  }
}

function extractChapterNumberFromTargetPath(targetPath: string | null | undefined): number | null {
  /* v8 ignore next */
  if (!targetPath) return null
  const stem = getFileStem(targetPath)
  const match = stem.match(/^(\d{1,4})(?:\D|$)/)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function formatDashItemDetail(item: DashItem): string {
  if (item.source === "factcheck" && item.detail in FACT_CHECK_TYPE_LABEL_KEYS) {
    return FACT_CHECK_TYPE_LABEL_KEYS[item.detail as FactCheckResult["type"]]
  }
  return item.detail
}

interface DashboardViewProps {
  headerActions?: ReactNode
}

export function DashboardView({ headerActions }: DashboardViewProps = {}) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const reviewRun = useWikiStore((s) => s.reviewRun)
  const lintRun = useWikiStore((s) => s.lintRun)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setPendingEditorHighlight = useWikiStore((s) => s.setPendingEditorHighlight)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    blocking: false,
    high: false,
    medium: false,
    low: true,
  })
  const [factReport, setFactReport] = useState<FactCheckReport | null>(null)
  const [debtReport, setDebtReport] = useState<ForeshadowingDebtReport | null>(null)
  const [chapterCount, setChapterCount] = useState(1)
  const [chaseDebts, setChaseDebts] = useState<ChaseDebt[]>([])
  const [chaseDebtEvents, setChaseDebtEvents] = useState<ChaseDebtEvent[]>([])
  const [emotionDebts, setEmotionDebts] = useState<EmotionLedgerEntry[]>([])
  const [extrasLoading, setExtrasLoading] = useState(false)
  const [issueState, setIssueState] = useState<DashboardIssueState>(createEmptyDashboardIssueState())
  const [rewriteDialog, setRewriteDialog] = useState<RewriteDialogState | null>(null)
  const [rewriteBusyId, setRewriteBusyId] = useState<string | null>(null)
  const [rewriteError, setRewriteError] = useState<string | null>(null)
  const [alertMessage, setAlertMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!project?.path) {
      setIssueState(createEmptyDashboardIssueState())
      return
    }
    let cancelled = false
    loadDashboardIssueState(project.path)
      .then((state) => {
        if (!cancelled) setIssueState(state)
      })
      .catch(() => {
        if (!cancelled) setIssueState(createEmptyDashboardIssueState())
      })
    return () => { cancelled = true }
  }, [project?.path])

  useEffect(() => {
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath) return

    let cancelled = false
    setExtrasLoading(true)

    ;(async () => {
      try {
        const snapshots: ChapterSnapshot[] = []
        const snapshotFiles = await listSnapshots(projectPath)
        for (const file of snapshotFiles) {
          const snap = await loadSnapshot(projectPath, file)
          if (snap) snapshots.push(snap)
        }
        if (cancelled) return
        setChapterCount(snapshots.length || 1)

        const fact = await runFactCheck(snapshots)
        if (!cancelled) setFactReport(fact)

        const store = await loadForeshadowingTracker(projectPath)
        const debt = analyzeForeshadowingDebt(store, snapshots.length || 1)
        if (!cancelled) setDebtReport(debt)

        // TASK-302: chase_debt 为 additive-optional 字段，旧 status.json 无此字段时容忍缺失。
        const status = await loadNovelSessionStatus(projectPath)
        if (!cancelled) {
          setChaseDebts(status?.chase_debt?.debts ?? [])
          setChaseDebtEvents(status?.chase_debt?.debt_events ?? [])
        }

        const ledger = await loadEmotionLedger(projectPath)
        if (!cancelled) setEmotionDebts(getTopEmotionalDebt(ledger, 5))
      } catch (err) {
        console.error("[Dashboard] Failed to load extras:", err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setExtrasLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [project?.path, dataVersion])

  // 架构-1（30 号审计）：status.json 真源跨进程监听（novel-status-changed），
  // 打开项目后注册；事件触发时重读 status.json 增量刷新状态派生数据
  // （chase_debt 台账），无需整页重载或重开项目。
  useEffect(() => {
    const pp = project?.path ? normalizePath(project.path) : null
    if (!pp) return
    // 防御：旧测试/mock 未提供新导出时降级为不订阅（导出兼容护栏）
    if (typeof subscribeStatusJson !== "function") return
    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeStatusJson(pp, (status) => {
      if (disposed) return
      setChaseDebts(status?.chase_debt?.debts ?? [])
      setChaseDebtEvents(status?.chase_debt?.debt_events ?? [])
    }).then((un) => {
      if (disposed) un?.()
      else unlisten = un
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [project?.path])

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const persistIssueState = useCallback(async (nextState: DashboardIssueState) => {
    setIssueState(nextState)
    if (project?.path) {
      await saveDashboardIssueState(project.path, nextState)
    }
  }, [project?.path])

  const showAiRewriteAlert = useCallback((message: string) => {
    setAlertMessage(message)
  }, [])

  const resolveDashboardItemTarget = useCallback(async (item: DashItem) => {
    if (!project) return null

    const pp = normalizePath(project.path)
    const candidates: string[] = []
    if (item.targetPath) {
      const targetPath = normalizePath(item.targetPath)
      if (targetPath.includes("/wiki/")) {
        candidates.push(targetPath)
      } else {
        candidates.push(`${pp}/wiki/${targetPath}`)
        if (!targetPath.endsWith(".md")) {
          candidates.push(`${pp}/wiki/${targetPath}.md`)
        }
      }
    } else if (item.targetChapterNumber) {
      const results = await searchWiki(pp, `chapter_number:${item.targetChapterNumber}`).catch(() => [])
      candidates.push(...results.map((result) => normalizePath(result.path)))
    }

    if (item.targetPath) {
      const chapterNumber = extractChapterNumberFromTargetPath(item.targetPath)
      if (chapterNumber !== null) {
        const results = await searchWiki(pp, `chapter_number:${chapterNumber}`).catch(() => [])
        candidates.push(...results.map((result) => normalizePath(result.path)))
      }

      const stem = getFileStem(item.targetPath).trim()
      if (stem) {
        const results = await searchWiki(pp, stem).catch(() => [])
        candidates.push(...results.map((result) => normalizePath(result.path)))
      }
    }

    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate)
        return { path: candidate, content }
      } catch {
      }
    }
    return null
  }, [project])

  const openDashboardItem = useCallback(async (item: DashItem, highlight = false) => {
    const resolved = await resolveDashboardItemTarget(item)
    if (!resolved) return null
    setSelectedFile(resolved.path)
    setFileContent(resolved.content)
    setActiveView("wiki")
    if (highlight) {
      const anchor = findChapterSelectionByEvidence(resolved.content, [item.evidence, item.secondaryEvidence])
      if (anchor) {
        setPendingEditorHighlight({
          path: resolved.path,
          text: anchor.selection.text,
          nonce: Date.now(),
        })
      }
    }
    return resolved
  }, [resolveDashboardItemTarget, setActiveView, setFileContent, setPendingEditorHighlight, setSelectedFile])

  const handleOpenDashItem = useCallback(async (item: DashItem) => {
    await openDashboardItem(item, false)
  }, [openDashboardItem])

  const handleEditDashItem = useCallback(async (item: DashItem) => {
    await openDashboardItem(item, true)
  }, [openDashboardItem])

  const handleIgnoreDashItem = useCallback(async (item: DashItem) => {
    /* v8 ignore next */
    if (issueState.ignored[item.id]) return
    await persistIssueState({
      ...issueState,
      ignored: {
        ...issueState.ignored,
        [item.id]: true,
      },
    })
  }, [issueState, persistIssueState])

  const runAiRewrite = useCallback(async (item: DashItem) => {
    if (!project) {
      showAiRewriteAlert(t("dashboard.rewrite.alertNoProject"))
      return
    }
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    if (!hasUsableLlm(llmConfig)) {
      showAiRewriteAlert(t("dashboard.rewrite.alertNoModel"))
      return
    }

    const resolved = await resolveDashboardItemTarget(item)
    if (!resolved) {
      showAiRewriteAlert(t("dashboard.rewrite.alertNoChapter"))
      return
    }

    const initialDialog: RewriteDialogState = item.source === "factcheck"
      ? {
        mode: "insert_before",
        item,
        targetPath: resolved.path,
        anchor: null,
        sourceContent: t("dashboard.rewrite.factCheckPlaceholder"),
        candidateContent: "",
      }
      : (() => {
        const anchor = findChapterSelectionByEvidence(resolved.content, [item.evidence, item.secondaryEvidence])
        if (!anchor) {
          return {
            mode: "replace" as const,
            item,
            targetPath: resolved.path,
            anchor: null,
            sourceContent: "",
            candidateContent: "",
          }
        }
        return {
          mode: "replace" as const,
          item,
          targetPath: resolved.path,
          anchor,
          sourceContent: anchor.selection.text,
          candidateContent: "",
        }
      })()

    if (item.source !== "factcheck" && !initialDialog.anchor) {
      showAiRewriteAlert(t("dashboard.rewrite.alertNoAnchor"))
      return
    }

    setRewriteBusyId(item.id)
    setRewriteError(null)
    setRewriteDialog(initialDialog)
    let rawResponse = ""

    try {
      await streamChat(
        llmConfig,
        item.source === "factcheck"
          ? buildFactCheckInsertMessages(
            item.detail,
            item.message,
            item.suggestion,
            item.secondaryEvidence,
            item.evidence,
            resolved.content,
          )
          : buildDashboardRewriteMessages(item.message, item.suggestion, initialDialog.sourceContent),
        {
          onToken: (token) => {
            rawResponse += token
            if (item.source === "factcheck") return
            setRewriteDialog((current) => {
              if (!current || current.item.id !== item.id) return current
              return {
                ...current,
                candidateContent: current.candidateContent + token,
              }
            })
          },
          onDone: () => {
            setRewriteDialog((current) => {
              if (!current || current.item.id !== item.id) return current
              if (item.source === "factcheck") {
                const plan = parseFactCheckInsertPlan(rawResponse)
                if (!plan) {
                  setRewriteError(t("dashboard.rewrite.errorParsePlan"))
                  return current
                }
                const anchor = findChapterSelectionByEvidence(resolved.content, [plan.anchorText])
                if (!anchor) {
                  setRewriteError(t("dashboard.rewrite.errorNoInsertAnchor"))
                  return current
                }
                return {
                  ...current,
                  anchor,
                  sourceContent: anchor.selection.text,
                  candidateContent: `${plan.insertText.trim()}\n${anchor.selection.text}`,
                }
              }

              const nextContent = current.candidateContent.trim()
              if (nextContent.length === 0) {
                setRewriteError(t("dashboard.rewrite.errorEmptyCandidate"))
                return current
              }
              return {
                ...current,
                candidateContent: nextContent,
              }
            })
            setRewriteBusyId(null)
          },
          onError: (error) => {
            // F-16 (CWE-532 / PAT-DC1-MSG-UI): err.message from the LLM transport may
            // carry provider endpoint URL / auth header — strip before surfacing in
            // the rewriteError banner. Raw message logged to console only.
            // (Twin of ingest.ts activity sites; PAT-G2 console-sanitized but UI-twin
            // missed — both onError and catch paths now strip.)
            const raw = error instanceof Error ? error.message : String(error)
            console.error("[Dashboard] rewrite failed:", raw)
            const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
            setRewriteError(safe || t("dashboard.rewrite.errorFallback"))
            setRewriteBusyId(null)
          },
        },
      )
    } catch (err) {
      // F-16 (CWE-532 / PAT-DC1-MSG-UI): catch-path twin of onError above.
      const raw = err instanceof Error ? err.message : String(err)
      console.error("[Dashboard] rewrite failed:", raw)
      const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
      setRewriteError(safe || t("dashboard.rewrite.errorFallback"))
      setRewriteBusyId(null)
    }
  }, [project, resolveDashboardItemTarget, showAiRewriteAlert, t])

  const handleApplyRewrite = useCallback(async () => {
    /* v8 ignore next */
    if (!rewriteDialog) return
    /* v8 ignore next */
    if (rewriteBusyId === rewriteDialog.item.id) return
    /* v8 ignore next */
    if (rewriteError || !rewriteDialog.candidateContent.trim() || !rewriteDialog.anchor) return
    const latestMarkdown = await readFile(rewriteDialog.targetPath).catch(() => "")
    if (!latestMarkdown) return

    let nextMarkdown = applyDashboardRewriteToMarkdown(
      latestMarkdown,
      rewriteDialog.anchor,
      rewriteDialog.candidateContent,
    )
    if (!nextMarkdown) {
      const refreshedAnchor = findChapterSelectionByEvidence(
        latestMarkdown,
        [rewriteDialog.sourceContent, rewriteDialog.anchor.evidence],
      )
      if (!refreshedAnchor) return
      nextMarkdown = applyDashboardRewriteToMarkdown(
        latestMarkdown,
        refreshedAnchor,
        rewriteDialog.candidateContent,
      )
      if (!nextMarkdown) return
    }

    await writeFile(rewriteDialog.targetPath, nextMarkdown)
    bumpDataVersion()
    if (selectedFile === rewriteDialog.targetPath) {
      setFileContent(nextMarkdown)
      setPendingEditorHighlight({
        path: rewriteDialog.targetPath,
        text: rewriteDialog.candidateContent,
        nonce: Date.now(),
      })
    }

    const backup: DashboardIssueRewriteBackup = {
      itemId: rewriteDialog.item.id,
      targetPath: rewriteDialog.targetPath,
      evidence: rewriteDialog.anchor.evidence,
      originalText: rewriteDialog.sourceContent,
      replacementText: rewriteDialog.candidateContent,
      updatedAt: new Date().toISOString(),
    }

    await persistIssueState({
      ...issueState,
      rewrites: {
        ...issueState.rewrites,
        [rewriteDialog.item.id]: backup,
      },
    })
    setRewriteError(null)
    setRewriteDialog(null)
  }, [bumpDataVersion, issueState, persistIssueState, rewriteBusyId, rewriteDialog, rewriteError, selectedFile, setFileContent, setPendingEditorHighlight])
  const handleRegenerateRewrite = useCallback(async () => {
    /* v8 ignore next */
    if (!rewriteDialog) return
    setRewriteError(null)
    await runAiRewrite(rewriteDialog.item)
  }, [rewriteDialog, runAiRewrite])

  const handleRestoreRewrite = useCallback(async (item: DashItem) => {
    const backup = issueState.rewrites[item.id]
    /* v8 ignore next */
    if (!backup) return
    const latestMarkdown = await readFile(backup.targetPath).catch(() => "")
    if (!latestMarkdown) return
    const restoredMarkdown = restoreDashboardRewriteInMarkdown(latestMarkdown, backup)
    if (!restoredMarkdown) return

    await writeFile(backup.targetPath, restoredMarkdown)
    bumpDataVersion()
    if (selectedFile === backup.targetPath) {
      setFileContent(restoredMarkdown)
      setPendingEditorHighlight({
        path: backup.targetPath,
        text: backup.originalText,
        nonce: Date.now(),
      })
    }

    const { [item.id]: _removed, ...rest } = issueState.rewrites
    await persistIssueState({
      ...issueState,
      rewrites: rest,
    })
  }, [bumpDataVersion, issueState, persistIssueState, selectedFile, setFileContent, setPendingEditorHighlight])

  const handleViewRewrite = useCallback(async (item: DashItem) => {
    const backup = issueState.rewrites[item.id]
    /* v8 ignore next */
    if (!backup) return
    const latestMarkdown = await readFile(backup.targetPath).catch(() => "")
    if (!latestMarkdown) return

    setSelectedFile(backup.targetPath)
    setFileContent(latestMarkdown)
    setActiveView("wiki")
    setPendingEditorHighlight({
      path: backup.targetPath,
      text: backup.replacementText,
      nonce: Date.now(),
    })
  }, [issueState.rewrites, setActiveView, setFileContent, setPendingEditorHighlight, setSelectedFile])

  const items = useMemo((): DashItem[] => {
    const dashItems: DashItem[] = []

    if (reviewRun?.results) {
      for (const r of reviewRun.results) {
        dashItems.push({
          id: buildDashboardIssueId(["review", reviewRun.filePath, r.type, r.message, r.evidence]),
          severity: mapReviewSeverity(r.severity),
          source: "review",
          message: r.message,
          detail: r.type,
          evidence: r.evidence,
          suggestion: r.suggestion,
          targetPath: reviewRun.filePath,
        })
      }
    }

    if (lintRun?.results) {
      for (const r of lintRun.results) {
        dashItems.push({
          id: buildDashboardIssueId(["lint", r.page, r.type, r.detail]),
          severity: mapLintSeverity(r.severity),
          source: "lint",
          message: r.detail,
          detail: r.page,
          suggestion: r.detail,
          targetPath: r.page,
        })
      }
    }

    if (factReport?.results) {
      for (const r of factReport.results) {
        dashItems.push({
          id: buildDashboardIssueId(["factcheck", r.type, r.chapters[0], r.chapters[1], r.evidenceA, r.evidenceB]),
          severity: mapFactCheckSeverity(r.severity),
          source: "factcheck",
          message: r.message,
          detail: r.type,
          evidence: r.evidenceB,
          secondaryEvidence: r.evidenceA,
          suggestion: r.suggestion,
          targetChapterNumber: r.chapters[1],
        })
      }
    }

    return dashItems
      .filter((item) => !issueState.ignored[item.id])
      .sort((a, b) => {
        const order: Record<string, number> = { blocking: 0, high: 1, medium: 2, low: 3 }
        return order[a.severity] - order[b.severity]
      })
  }, [factReport?.results, issueState.ignored, lintRun?.results, reviewRun?.filePath, reviewRun?.results])

  const grouped = useMemo(() => {
    const groups: Record<DashSeverity, DashItem[]> = {
      blocking: [],
      high: [],
      medium: [],
      low: [],
    }
    for (const item of items) {
      groups[item.severity].push(item)
    }
    return groups
  }, [items])

  const visibleFactItems = useMemo(
    () => items.filter((item) => item.source === "factcheck"),
    [items],
  )

  const noIssues = items.length === 0 && !reviewRun?.running && !lintRun?.running

  const renderActionBar = useCallback((item: DashItem) => {
    const hasBackup = Boolean(issueState.rewrites[item.id])
    const isRewriting = rewriteBusyId === item.id
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            void runAiRewrite(item)
          }}
          disabled={isRewriting}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRewriting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          {isRewriting ? t("dashboard.actions.rewriting") : t("dashboard.actions.aiRewrite")}
        </button>
        {hasBackup ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              void handleViewRewrite(item)
            }}
            className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("dashboard.actions.viewRewrite")}
          </button>
        ) : null}
        {hasBackup ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              void handleRestoreRewrite(item)
            }}
            className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("dashboard.actions.restore")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            void handleIgnoreDashItem(item)
          }}
          className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("dashboard.actions.ignore")}
        </button>
      </div>
    )
  }, [handleIgnoreDashItem, handleRestoreRewrite, handleViewRewrite, issueState.rewrites, rewriteBusyId, runAiRewrite, t])

  const renderDashCard = useCallback((item: DashItem, config: (typeof SEVERITY_CONFIG)[DashSeverity], key: string) => (
    <div
      key={key}
      role="button"
      tabIndex={0}
      onClick={() => void handleOpenDashItem(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          void handleOpenDashItem(item)
        }
      }}
      className={`group cursor-pointer rounded-lg border p-2 text-sm transition-all duration-150 hover:border-primary/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${config.bgColor}`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.dotClass}`} aria-hidden="true" />
        <span className="text-xs text-muted-foreground">
          [{item.source === "review" ? t("dashboard.source.review") : item.source === "lint" ? t("dashboard.source.lint") : t("dashboard.section.factCheck")}]
        </span>
        <span className="truncate text-xs text-muted-foreground">{t(formatDashItemDetail(item), item.detail)}</span>
      </div>
      <p className="mt-1 text-xs">{item.message}</p>
      {item.evidence && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            void handleEditDashItem(item)
          }}
          className="mt-1 text-left text-xs italic text-muted-foreground underline-offset-2 hover:underline"
        >
          {String.fromCharCode(0x300C)}{item.evidence}{String.fromCharCode(0x300D)}
        </button>
      )}
      {item.secondaryEvidence && (
        <p className="mt-1 text-xs text-muted-foreground">
          {String.fromCharCode(0x300C)}{item.secondaryEvidence}{String.fromCharCode(0x300D)}
        </p>
      )}
      {item.suggestion && (
        <p className="mt-1 text-xs text-success">{item.suggestion}</p>
      )}
      {renderActionBar(item)}
    </div>
  ), [handleEditDashItem, handleOpenDashItem, renderActionBar, t])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("dashboard.title")}</h2>
        <div className="flex items-center gap-3">
          {items.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />{grouped.blocking.length} {t("dashboard.severity.blocking")}</span>
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />{grouped.high.length} {t("dashboard.severity.high")}</span>
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />{grouped.medium.length} {t("dashboard.severity.medium")}</span>
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />{grouped.low.length} {t("dashboard.severity.low")}</span>
            </div>
          )}
          {headerActions}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-fade-y">
        {noIssues ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Info className="h-8 w-8 text-success/50" />
            <p>{t("dashboard.noIssues")}</p>
            <p className="text-xs italic">{t("dashboard.noIssuesHint")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-3">
            {(["blocking", "high", "medium", "low"] as DashSeverity[]).map((severity) => {
              const group = grouped[severity]
              if (group.length === 0) return null
              const config = SEVERITY_CONFIG[severity]
              const Icon = config.icon
              const isCollapsed = collapsed[severity]
              const panelId = `dash-panel-${severity}`
              return (
                <div key={severity} className="mb-2">
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${config.color}`}
                    onClick={() => toggleCollapse(severity)}
                    aria-expanded={!isCollapsed}
                    aria-controls={panelId}
                  >
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <Icon className="h-4 w-4" />
                    <span>{t(config.labelKey)}</span>
                    <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs">{group.length}</span>
                  </button>
                  <div id={panelId} role="region" aria-label={t(config.labelKey)} className="collapsible-panel mt-1" data-open={!isCollapsed}>
                    <div>
                      <div className="space-y-1 pl-8 pt-1">
                        {group.map((item) => renderDashCard(item, config, item.id))}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {factReport && visibleFactItems.length > 0 && (
          <div className="border-t p-3">
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t("dashboard.section.factCheck")}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {factReport.checkedChapterCount} {t("dashboard.section.chapters")}
              </span>
            </div>
            <div className="space-y-1">
              {visibleFactItems.map((item) => renderDashCard(item, SEVERITY_CONFIG[item.severity], `fact-${item.id}`))}
            </div>
          </div>
        )}

        {debtReport && debtReport.totalUnresolved > 0 && (
          <div className="border-t p-3">
            <div className="mb-2 flex items-center gap-2">
              <AlertOctagon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t("dashboard.section.foreshadowingDebt")}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {t("dashboard.section.debtScore")}: {debtReport.debtScore}/100
              </span>
            </div>
            <div className="mb-2 flex gap-2 text-xs">
              <span className="flex items-center gap-1 text-destructive"><span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />{debtReport.criticalCount} {t(DEBT_LEVEL_LABEL_KEYS.critical)}</span>
              <span className="flex items-center gap-1 text-warning"><span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />{debtReport.warningCount} {t(DEBT_LEVEL_LABEL_KEYS.warning)}</span>
            </div>
            {debtReport.items.filter((item) => item.debtLevel !== "normal").map((item) => (
              <div key={item.name} className="mb-1 rounded-md border bg-muted/30 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={item.debtLevel === "critical" ? "text-destructive" : "text-warning"}>
                    [{item.debtLevel === "critical" ? t(DEBT_LEVEL_LABEL_KEYS.critical) : t(DEBT_LEVEL_LABEL_KEYS.warning)}]
                  </span>
                  <span>{item.name}</span>
                </div>
                <p className="text-muted-foreground">
                  {item.status === "planted"
                    ? `埋设于第${item.plantedChapter}章，已过${item.chaptersSincePlanted}章未推进`
                    : `上次推进于第${item.lastAdvancedChapter}章，已过${item.chaptersSinceAdvanced}章未回收`}
                </p>
                <p className="text-muted-foreground italic">{item.description}</p>
              </div>
            ))}
          </div>
        )}

        <DebtBoardView
          chaseDebts={chaseDebts}
          chaseDebtEvents={chaseDebtEvents}
          currentChapter={chapterCount}
          debtReport={debtReport}
          emotionDebts={emotionDebts}
        />

        {extrasLoading && (
          <div className="border-t p-3">
            <div className="space-y-2" role="status" aria-label={t("dashboard.section.loadingExtras")}>
              <div className="skeleton-bar h-4 w-3/4" />
              <div className="skeleton-bar h-4 w-1/2" />
              <div className="skeleton-bar h-4 w-2/3" />
            </div>
          </div>
        )}
      </div>

      {alertMessage && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {t("dashboard.rewriteAlertPrefix")}: {alertMessage}
          <button
            type="button"
            className="ml-2 underline-offset-2 hover:underline"
            onClick={() => setAlertMessage(null)}
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}

      <TextTransformPreviewDialog
        open={Boolean(rewriteDialog)}
        title={t("dashboard.rewriteDialog.title")}
        description={rewriteError || (rewriteBusyId === rewriteDialog?.item.id
          ? "正在生成修改内容，请稍候…"
          : rewriteDialog?.mode === "insert_before"
            ? "右侧会包含补写内容和原文位置，确认后会覆盖左侧原文位置。"
            : t("dashboard.rewriteDialog.description"))}
        sourceLabel={rewriteDialog?.mode === "insert_before" ? "原文位置" : t("dashboard.rewriteDialog.sourceLabel")}
        candidateLabel={rewriteDialog?.mode === "insert_before" ? "修改后内容" : t("dashboard.rewriteDialog.candidateLabel")}
        sourceContent={rewriteDialog?.sourceContent || ""}
        candidateContent={rewriteDialog?.candidateContent || (rewriteBusyId === rewriteDialog?.item.id ? "正在生成修改内容，请稍候…" : "")}
        applyLabel={t("dashboard.rewriteDialog.apply")}
        secondaryActionLabel={t("dashboard.rewriteDialog.regenerate")}
        applyDisabled={
          Boolean(rewriteError)
          || rewriteBusyId === rewriteDialog?.item.id
          || !(rewriteDialog?.candidateContent.trim())
          || (rewriteDialog?.mode === "insert_before" && !rewriteDialog.anchor)
        }
        secondaryActionDisabled={rewriteBusyId === rewriteDialog?.item.id}
        onApply={() => void handleApplyRewrite()}
        onSecondaryAction={() => void handleRegenerateRewrite()}
        onCandidateContentChange={!rewriteError && rewriteBusyId !== rewriteDialog?.item.id
          ? (content) => {
            /* v8 ignore next */
            setRewriteDialog((current) => current ? { ...current, candidateContent: content } : current)
          }
          : undefined}
        onClose={() => {
          if (rewriteBusyId === rewriteDialog?.item.id) return
          setRewriteError(null)
          setRewriteDialog(null)
        }}
      />
    </div>
  )
}
