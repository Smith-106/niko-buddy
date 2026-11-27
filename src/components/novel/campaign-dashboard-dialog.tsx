// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Flame,
  Square,
  Check,
  CheckCheck,
  Loader2,
  AlertTriangle,
  XCircle,
  Sparkles,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Play,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { toast } from "@/lib/toast"
import {
  runAutonomousDraftCampaign,
  batchAcceptCampaignDrafts,
  filterAcceptableChapters,
  getNextChapterNumber,
  invalidateChapterCache,
  type CampaignChapterResult,
  type CampaignReport,
  type BatchAcceptResult,
  type DeepChapterGateVerdict,
} from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

interface CampaignDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const GATE_VERDICT_LABELS: Record<DeepChapterGateVerdict, string> = {
  pass: "通过",
  warning: "警告",
  fail: "未通过",
  manual_review: "需人工复核",
  pending: "未评估",
}

function mergeChapterResultLists(
  existing: readonly CampaignChapterResult[],
  incoming: readonly CampaignChapterResult[],
): CampaignChapterResult[] {
  const byChapter = new Map<number, CampaignChapterResult>()
  for (const item of existing) {
    byChapter.set(item.chapterNumber, item)
  }
  for (const item of incoming) {
    byChapter.set(item.chapterNumber, item)
  }
  return Array.from(byChapter.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

function mergeCampaignReport(
  previous: CampaignReport | null,
  next: CampaignReport,
  preserveHistory: boolean,
): CampaignReport {
  if (!preserveHistory || !previous) return next
  const mergedResults = mergeChapterResultLists(previous.results, next.results)
  const readyCount = mergedResults.filter((item) => item.status === "ready").length
  const failedCount = mergedResults.filter((item) => item.status === "failed").length
  const totalWords = mergedResults.reduce((acc, item) => acc + item.wordCount, 0)
  const chapterNumbers = mergedResults.map((item) => item.chapterNumber)
  return {
    ...next,
    startChapter: chapterNumbers.length > 0 ? Math.min(...chapterNumbers) : next.startChapter,
    endChapter: chapterNumbers.length > 0 ? Math.max(...chapterNumbers) : next.endChapter,
    totalChapters: mergedResults.length,
    completedChapters: mergedResults.length,
    totalWords,
    results: mergedResults,
    summary: {
      allPassed: mergedResults.every((item) => item.status === "ready"),
      readyCount,
      failedCount,
    },
  }
}

export function CampaignDashboardDialog({
  open,
  onOpenChange,
}: CampaignDashboardDialogProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const [startChapter, setStartChapter] = useState(1)
  const [chapterCount, setChapterCount] = useState(3)
  const [autoIngest, setAutoIngest] = useState(true)
  const [cruiseMode, setCruiseMode] = useState(false)
  const [confirmCruiseAutoAccept, setConfirmCruiseAutoAccept] = useState(false)

  const [isRunning, setIsRunning] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [progressMessage, setProgressMessage] = useState("")
  const [activeChapterIndex, setActiveChapterIndex] = useState(0)
  const [activeRunTotal, setActiveRunTotal] = useState(0)
  const [chapterResults, setChapterResults] = useState<CampaignChapterResult[]>([])
  const [expandedChapter, setExpandedChapter] = useState<number | null>(null)
  const [campaignReport, setCampaignReport] = useState<CampaignReport | null>(null)

  const [isAccepting, setIsAccepting] = useState(false)
  const [acceptResult, setAcceptResult] = useState<BatchAcceptResult | null>(null)
  const readyItems = filterAcceptableChapters(campaignReport?.results ?? chapterResults)
  const isBusy = isRunning || isCancelling || isAccepting

  const abortRef = useRef<AbortController | null>(null)

  // 当弹窗打开时，自动探测下一章节号
  // DEBUG#3：getNextChapterNumber 是跨项目 IPC；project/open 变化时迟到的结果可能把上一项目的章节号写进当前弹窗。
  useEffect(() => {
    if (!open || !project) return
    let cancelled = false
    const path = project.path
    void getNextChapterNumber(path)
      .then((nextNum) => {
        if (cancelled || nextNum <= 0) return
        setStartChapter(nextNum)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("[Campaign] detect next chapter failed:", toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, project])

  useEffect(() => {
    if (!open) {
      setConfirmCruiseAutoAccept(false)
    }
  }, [open])

  async function runCampaignRange(options: {
    runStart: number
    runCount: number
    preserveHistory: boolean
  }) {
    if (!project || isBusy) return

    const controller = new AbortController()
    abortRef.current = controller

    setIsRunning(true)
    setIsCancelling(false)
    setActiveChapterIndex(0)
    setActiveRunTotal(options.runCount)
    if (!options.preserveHistory) {
      setChapterResults([])
      setCampaignReport(null)
      setAcceptResult(null)
    } else {
      setAcceptResult(null)
    }
    const endChapter = options.runStart + options.runCount - 1
    setProgressMessage(
      options.runCount === 1
        ? `正在准备重试第 ${options.runStart} 章...`
        : `正在准备调度第 ${options.runStart} 至 ${endChapter} 章...`,
    )

    const effectiveCruiseAutoAccept = cruiseMode && confirmCruiseAutoAccept

    try {
      const report = await runAutonomousDraftCampaign({
        projectPath: project.path,
        startChapter: options.runStart,
        chapterCount: options.runCount,
        llmConfig,
        novelConfig,
        cruiseMode,
        confirmAutoAccept: effectiveCruiseAutoAccept,
        onChapterStart: (chapterNumber, current, total) => {
          setActiveChapterIndex(current)
          setProgressMessage(`正在生成第 ${chapterNumber} 章 (${current}/${total})...`)
        },
        onChapterComplete: (chapterNumber, result) => {
          setChapterResults((prev) => mergeChapterResultLists(prev, [{ ...result, chapterNumber }]))
        },
        onProgress: (info) => {
          setProgressMessage(info.message)
        },
        signal: controller.signal,
      })

      setCampaignReport((prev) => mergeCampaignReport(prev, report, options.preserveHistory))
      if (options.preserveHistory && report.results.length > 0) {
        setChapterResults((prev) => mergeChapterResultLists(prev, report.results))
      }

      const autoAccepted = report.results.filter((r) => r.autoAccepted === true)
      if (autoAccepted.length > 0) {
        invalidateChapterCache(project.path)
        bumpDataVersion?.()
        try {
          const tree = await listDirectory(normalizePath(project.path))
          setFileTree(tree)
        } catch (e) {
          console.warn("巡航落盘后刷新文件树异常:", e)
        }
      }

      if (effectiveCruiseAutoAccept) {
        const verifiedMemoryCount = autoAccepted.filter((r) => r.autoIngested === true).length
        const message = `全自动巡航${report.summary.allPassed ? "完成" : "暂停"}！自动落盘 ${autoAccepted.length} 章，已验证事实库摄取 ${verifiedMemoryCount} 章`
        if (autoAccepted.length > 0) toast.success(message)
        else toast.info(message)
      } else if (cruiseMode) {
        toast.info(
          `巡航草稿模式完成！共生成 ${report.completedChapters} 章，准备就绪 ${report.summary.readyCount} 章（未勾选二次确认，已保留为待审草稿）`,
        )
      } else {
        toast.success(`批量战役完成！共生成 ${report.completedChapters} 章，准备就绪 ${report.summary.readyCount} 章`)
      }
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info("战役推进已被用户终止")
      } else {
        toast.error(`战役运行异常：${toErrorMessage(err)}`)
      }
    } finally {
      setIsRunning(false)
      setIsCancelling(false)
      abortRef.current = null
    }
  }

  async function handleStartCampaign() {
    await runCampaignRange({
      runStart: startChapter,
      runCount: chapterCount,
      preserveHistory: false,
    })
  }

  async function handleRetrySingleChapter(chapterNumber: number) {
    await runCampaignRange({
      runStart: chapterNumber,
      runCount: 1,
      preserveHistory: true,
    })
  }

  async function handleResumeFromChapter(chapterNumber: number) {
    const plannedEnd = Math.max(
      startChapter + chapterCount - 1,
      ...chapterResults.map((item) => item.chapterNumber),
      chapterNumber,
    )
    const remaining = Math.max(1, plannedEnd - chapterNumber + 1)
    await runCampaignRange({
      runStart: chapterNumber,
      runCount: remaining,
      preserveHistory: true,
    })
  }

  function handleCancelCampaign() {
    if (!isRunning || isCancelling) return
    setIsCancelling(true)
    setProgressMessage("正在终止战役，等待当前步骤安全收尾...")
    abortRef.current?.abort()
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen && isBusy) return
    if (!nextOpen) {
      setConfirmCruiseAutoAccept(false)
    }
    onOpenChange(nextOpen)
  }

  async function handleBatchAccept() {
    if (!project || isAccepting || isRunning || isCancelling) return
    if (readyItems.length === 0) {
      toast.info("没有可验收落盘的就绪章节")
      return
    }

    setIsAccepting(true)
    try {
      const res = await batchAcceptCampaignDrafts(project.path, readyItems, {
        autoIngest,
        llmConfig,
        onProgress: (current, total, path) => {
          setProgressMessage(`正在落盘: 第 ${current}/${total} 篇 (${path.split("/").pop()})`)
        },
      })

      if (res.acceptedCount === 0) {
        setAcceptResult(null)
        toast.info("批量验收未落盘任何章节")
        return
      }
      setAcceptResult(res)
      invalidateChapterCache(project.path)
      bumpDataVersion?.()

      // 刷新文件树
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch (e) {
        console.warn("刷新文件树失败:", e)
      }

      toast.success(
        `批量验收完成！成功落盘 ${res.acceptedCount} 个章节，已验证事实库摄取 ${res.ingestedCount} 章`,
      )
    } catch (err) {
      toast.error(`批量验收失败：${toErrorMessage(err)}`)
    } finally {
      setIsAccepting(false)
    }
  }

  const readyCount = readyItems.length
  const totalWords = chapterResults.reduce((acc, r) => acc + r.wordCount, 0)

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent showCloseButton={!isBusy} className="max-w-2xl max-h-[90vh] flex flex-col p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Flame className="h-5 w-5 text-kind-orange" />
            <DialogTitle>
              {t("campaign.dialog.title", { defaultValue: "长程战役调度工作台" })}
            </DialogTitle>
          </div>
          <DialogDescription>
            {t("campaign.dialog.description", {
              defaultValue: "自动跨章连续推演与起草，新章节先进入草稿箱审阅，确认后才会写入正式正文。",
            })}
          </DialogDescription>
        </DialogHeader>

        {/* 顶部参数配置区 */}
        <div className="grid grid-cols-2 gap-3 p-3 rounded-lg border bg-muted/20 text-xs">
          <div className="flex flex-col gap-1">
            <Label htmlFor="campaign-start-chapter" className="text-xs text-muted-foreground">
              {t("campaign.dialog.startChapter", { defaultValue: "起始章节" })}
            </Label>
            <Input
              id="campaign-start-chapter"
              type="number"
              min={1}
              value={startChapter}
              disabled={isBusy}
              onChange={(e) => setStartChapter(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="campaign-chapter-count" className="text-xs text-muted-foreground">
              {t("campaign.dialog.chapterCount", { defaultValue: "连写章数" })}
            </Label>
            <Input
              id="campaign-chapter-count"
              type="number"
              min={1}
              max={20}
              value={chapterCount}
              disabled={isBusy}
              onChange={(e) => setChapterCount(Math.max(1, Math.min(20, Number.parseInt(e.target.value, 10) || 1)))}
              className="h-8 text-xs"
            />
          </div>
          <div className="col-span-2 flex flex-col gap-2 pt-1 border-t border-border/40">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={cruiseMode}
                  disabled={isBusy}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setCruiseMode(checked)
                    if (!checked) setConfirmCruiseAutoAccept(false)
                  }}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-semibold text-primary">
                  {t("campaign.dialog.cruiseMode", {
                    defaultValue: "开启全自动巡航推进（质检全通过时自动转入正式章节并同步设定记忆）",
                  })}
                </span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoIngest}
                  disabled={isBusy}
                  onChange={(e) => setAutoIngest(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span>{t("campaign.dialog.autoIngest", { defaultValue: "验收后自动同步设定记忆" })}</span>
              </label>
            </div>
            {cruiseMode && (
              <label
                data-testid="campaign-cruise-confirm-auto-accept-label"
                className="flex items-start gap-1.5 cursor-pointer rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
              >
                <input
                  type="checkbox"
                  data-testid="campaign-cruise-confirm-auto-accept"
                  checked={confirmCruiseAutoAccept}
                  disabled={isBusy}
                  onChange={(e) => setConfirmCruiseAutoAccept(e.target.checked)}
                  className="mt-0.5 rounded border-border text-primary focus:ring-primary"
                />
                <span>
                  {t("campaign.dialog.confirmCruiseAutoAccept", {
                    defaultValue:
                      "二次确认：允许巡航在门控全绿后自动写入正式章节与事实库（未勾选时仅生成待审草稿）",
                  })}
                </span>
              </label>
            )}
          </div>
        </div>

        {/* 推进状态条 */}
        {(isRunning || progressMessage) && (
          <div className="flex items-center justify-between text-xs px-1 text-muted-foreground">
            <div className="flex items-center gap-2">
              {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              <span>{progressMessage}</span>
            </div>
            {isRunning && (
              <span className="font-mono">
                {activeChapterIndex} / {activeRunTotal || chapterCount} 章
              </span>
            )}
          </div>
        )}

        {/* 章节生成卡片列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-lg divide-y bg-background/50">
          {chapterResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-10 text-center gap-2 text-muted-foreground">
              <Sparkles className="h-8 w-8 text-primary/40" />
              <p className="text-xs">
                点击下方“启动战役”开始自主连续创作第 {startChapter} 至 {startChapter + chapterCount - 1} 章。
              </p>
            </div>
          ) : (
            chapterResults.map((result) => {
              const isExpanded = expandedChapter === result.chapterNumber
              const chapterDetailPanelId = `campaign-chapter-detail-${result.chapterNumber}`
              return (
                <div key={result.chapterNumber} className="p-3 text-xs flex flex-col gap-2 hover:bg-muted/20">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">
                        第 {result.chapterNumber} 章
                      </span>
                      <span className="text-muted-foreground">
                        {result.title || "正文起草"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground font-mono">
                        {result.wordCount.toLocaleString()} 字
                      </span>

                      {result.autoAccepted ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium border border-primary/20">
                          <CheckCheck className="h-3 w-3" /> 巡航落盘
                        </span>
                      ) : result.status === "ready" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success-foreground px-2 py-0.5 text-xs font-medium border border-success/40">
                          <Check className="h-3 w-3" /> 就绪
                        </span>
                      ) : null}
                      {result.status === "blocked" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning-foreground px-2 py-0.5 text-xs font-medium border border-warning/20">
                          <AlertTriangle className="h-3 w-3" /> 阻断转人工
                        </span>
                      )}
                      {result.status === "partial" && (
                        <span
                          data-testid={`campaign-chapter-badge-partial-${result.chapterNumber}`}
                          className="inline-flex items-center gap-1 rounded-full bg-warning/15 text-warning-foreground px-2 py-0.5 text-xs font-medium border border-warning/30"
                        >
                          <AlertTriangle className="h-3 w-3" /> 截断草稿
                        </span>
                      )}
                      {result.status === "failed" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 text-destructive px-2 py-0.5 text-xs font-medium border border-destructive/20">
                          <XCircle className="h-3 w-3" /> 失败
                        </span>
                      )}

                      {!result.autoAccepted &&
                      (result.status === "failed" ||
                        result.status === "blocked" ||
                        result.status === "partial") ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={isBusy}
                            data-testid={`campaign-retry-chapter-${result.chapterNumber}`}
                            onClick={() => void handleRetrySingleChapter(result.chapterNumber)}
                            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-accent disabled:opacity-40"
                          >
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            重试本章
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            data-testid={`campaign-resume-from-${result.chapterNumber}`}
                            onClick={() => void handleResumeFromChapter(result.chapterNumber)}
                            className="inline-flex items-center gap-1 rounded border border-primary/50 px-1.5 py-0.5 text-[11px] text-primary hover:bg-accent disabled:opacity-40"
                          >
                            <Play className="h-3 w-3" aria-hidden="true" />
                            从此章续跑
                          </button>
                        </div>
                      ) : null}

                      <button
                        type="button"
                        aria-label={isExpanded ? `收起第 ${result.chapterNumber} 章详情` : `展开第 ${result.chapterNumber} 章详情`}
                        aria-expanded={isExpanded}
                        aria-controls={chapterDetailPanelId}
                        onClick={() => setExpandedChapter(isExpanded ? null : result.chapterNumber)}
                        className="p-1 text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* 展开查看错误原因、门控结论、审稿明细与正文选段 */}
                  {isExpanded && (
                    <div id={chapterDetailPanelId} role="region" aria-label={`第 ${result.chapterNumber} 章详情`} className="mt-1 space-y-2 p-2.5 rounded bg-muted/40 border text-xs text-muted-foreground font-sans max-h-60 overflow-y-auto leading-relaxed">
                      {result.error ? (
                        <div
                          role="alert"
                          data-testid={`campaign-chapter-error-${result.chapterNumber}`}
                          className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive"
                        >
                          失败原因：{result.error}
                        </div>
                      ) : null}
                      {result.decisionGates ? (
                        <div
                          data-testid={`campaign-chapter-gates-${result.chapterNumber}`}
                          className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background/70 px-2 py-1"
                        >
                          <span className="font-medium text-foreground">
                            {t("campaign.dialog.gateSummary", {
                              verdict: GATE_VERDICT_LABELS[result.decisionGates.overall],
                              defaultValue: `质检总评：${GATE_VERDICT_LABELS[result.decisionGates.overall]}`,
                            })}
                          </span>
                          <span>
                            {t("campaign.dialog.gateConsistency", {
                              verdict: GATE_VERDICT_LABELS[result.decisionGates.consistency.verdict],
                              count: result.decisionGates.consistency.findings.length,
                              defaultValue: `设定一致性：${GATE_VERDICT_LABELS[result.decisionGates.consistency.verdict]}（${result.decisionGates.consistency.findings.length}）`,
                            })}
                          </span>
                          <span>
                            {t("campaign.dialog.gateAntiAi", {
                              verdict: GATE_VERDICT_LABELS[result.decisionGates.anti_ai.verdict],
                              count: result.decisionGates.anti_ai.findings.length,
                              defaultValue: `自然文风：${GATE_VERDICT_LABELS[result.decisionGates.anti_ai.verdict]}（${result.decisionGates.anti_ai.findings.length}）`,
                            })}
                          </span>
                          <span>
                            {t("campaign.dialog.gateQuality", {
                              verdict: GATE_VERDICT_LABELS[result.decisionGates.quality.verdict],
                              count: result.decisionGates.quality.findings.length,
                              defaultValue: `阅读质量：${GATE_VERDICT_LABELS[result.decisionGates.quality.verdict]}（${result.decisionGates.quality.findings.length}）`,
                            })}
                          </span>
                        </div>
                      ) : null}
                      {result.reviewResults.length > 0 ? (
                        <ul
                          data-testid={`campaign-chapter-findings-${result.chapterNumber}`}
                          className="space-y-1 rounded border border-border/60 bg-background/70 p-2"
                        >
                          {result.reviewResults.map((finding, idx) => (
                            <li key={`${result.chapterNumber}-finding-${idx}`}>
                              <span className="mr-1 font-medium uppercase text-foreground">
                                [{finding.severity}]
                              </span>
                              <span className="text-foreground">{finding.message}</span>
                              {finding.suggestion ? (
                                <span className="ml-1 text-success-foreground">（建议：{finding.suggestion}）</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="whitespace-pre-wrap">
                        {result.content ? result.content.slice(0, 500) + (result.content.length > 500 ? "..." : "") : "（空正文）"}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 批量验收结果横幅 */}
        {acceptResult && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 bg-success/10 text-success-foreground rounded border border-success/40">
            <CheckCheck className="h-4 w-4 shrink-0 text-success" />
            <span>
              {acceptResult.ingestedCount > 0
                ? t("campaign.dialog.acceptSuccessWithMemory", {
                    accepted: acceptResult.acceptedCount,
                    ingested: acceptResult.ingestedCount,
                    defaultValue: `已成功验收写入 ${acceptResult.acceptedCount} 章节，并同步更新设定记忆 ${acceptResult.ingestedCount} 章。`,
                  })
                : t("campaign.dialog.acceptSuccess", {
                    accepted: acceptResult.acceptedCount,
                    defaultValue: `已成功验收写入 ${acceptResult.acceptedCount} 章节。`,
                  })}
            </span>
          </div>
        )}

        {/* 统计状态条 */}
        {chapterResults.length > 0 && (
          <div className="flex items-center justify-between text-xs px-2 py-1 bg-muted/30 rounded border">
            <span className="text-muted-foreground">
              战役统计：共生成 {chapterResults.length} 章 · 合计 {totalWords.toLocaleString()} 字
            </span>
            <span className="font-medium text-foreground">
              可晋升草稿：<strong className="text-success-foreground">{readyCount}</strong> 章
            </span>
          </div>
        )}

        {/* 底部操作栏 */}
        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-between w-full">
          <div>
            {isRunning ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={isCancelling}
                onClick={handleCancelCampaign}
                className="gap-1.5"
              >
                {isCancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                ) : (
                  <Square className="h-4 w-4 shrink-0" />
                )}
                {isCancelling ? "正在终止..." : "终止战役"}
              </Button>
            ) : (
              <Button
                variant="default"
                size="sm"
                disabled={isBusy}
                onClick={handleStartCampaign}
                className="gap-1.5 bg-kind-orange hover:opacity-90 text-white"
              >
                <Flame className="h-4 w-4 shrink-0" />
                启动战役
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => handleDialogOpenChange(false)} disabled={isBusy}>
              {t("common.close", { defaultValue: "关闭" })}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleBatchAccept}
              disabled={readyCount === 0 || isBusy}
              className="gap-1.5"
            >
              {isAccepting ? (
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              ) : (
                <CheckCheck className="h-4 w-4 shrink-0" />
              )}
              {isAccepting
                ? t("campaign.dialog.accepting", { defaultValue: "正在写入正式章节..." })
                : t("campaign.dialog.batchAccept", {
                    count: readyCount,
                    defaultValue: `批量验收并写入正文 (${readyCount})`,
                  })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
