// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react"
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
  getNextChapterNumber,
  type CampaignChapterResult,
  type CampaignReport,
  type BatchAcceptResult,
} from "@/lib/novel"

interface CampaignDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CampaignDashboardDialog({
  open,
  onOpenChange,
}: CampaignDashboardDialogProps) {
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const [startChapter, setStartChapter] = useState(1)
  const [chapterCount, setChapterCount] = useState(3)
  const [autoIngest, setAutoIngest] = useState(true)
  const [cruiseMode, setCruiseMode] = useState(false)

  const [isRunning, setIsRunning] = useState(false)
  const [progressMessage, setProgressMessage] = useState("")
  const [activeChapterIndex, setActiveChapterIndex] = useState(0)
  const [chapterResults, setChapterResults] = useState<CampaignChapterResult[]>([])
  const [expandedChapter, setExpandedChapter] = useState<number | null>(null)
  const [campaignReport, setCampaignReport] = useState<CampaignReport | null>(null)

  const [isAccepting, setIsAccepting] = useState(false)
  const [acceptResult, setAcceptResult] = useState<BatchAcceptResult | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  // 当弹窗打开时，自动探测下一章节号
  useEffect(() => {
    if (open && project) {
      void getNextChapterNumber(project.path)
        .then((nextNum) => {
          if (nextNum > 0) {
            setStartChapter(nextNum)
          }
        })
        .catch(() => {})
    }
  }, [open, project])

  async function handleStartCampaign() {
    if (!project || isRunning) return

    const controller = new AbortController()
    abortRef.current = controller

    setIsRunning(true)
    setChapterResults([])
    setCampaignReport(null)
    setAcceptResult(null)
    setProgressMessage(`正在准备调度第 ${startChapter} 至 ${startChapter + chapterCount - 1} 章...`)

    try {
      const report = await runAutonomousDraftCampaign({
        projectPath: project.path,
        startChapter,
        chapterCount,
        llmConfig,
        novelConfig,
        cruiseMode,
        onChapterStart: (chapterNumber, current, total) => {
          setActiveChapterIndex(current)
          setProgressMessage(`正在生成第 ${chapterNumber} 章 (${current}/${total})...`)
        },
        onChapterComplete: (chapterNumber, result) => {
          setChapterResults((prev) => {
            const next = [...prev]
            const existingIdx = next.findIndex((item) => item.chapterNumber === chapterNumber)
            if (existingIdx >= 0) {
              next[existingIdx] = result
            } else {
              next.push(result)
            }
            return next
          })
        },
        onProgress: (info) => {
          setProgressMessage(info.message)
        },
        signal: controller.signal,
      })

      setCampaignReport(report)
      const autoCount = report.results.filter((r) => r.autoAccepted).length
      if (autoCount > 0) {
        try {
          const tree = await listDirectory(normalizePath(project.path))
          setFileTree(tree)
        } catch (e) {
          console.warn("巡航落盘后刷新文件树异常:", e)
        }
      }

      toast.success(
        cruiseMode && autoCount > 0
          ? `全自动巡航完成！自动落盘并摄取 ${autoCount} 章`
          : `批量战役完成！共生成 ${report.completedChapters} 章，准备就绪 ${report.summary.readyCount} 章`,
      )
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info("战役推进已被用户终止")
      } else {
        toast.error(`战役运行异常：${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }

  function handleCancelCampaign() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsRunning(false)
  }

  async function handleBatchAccept() {
    if (!project || isAccepting) return
    const resultsToAccept = campaignReport?.results ?? chapterResults
    const readyItems = resultsToAccept.filter((r) => r.status === "ready")
    if (readyItems.length === 0) {
      toast.info("没有可验收落盘的就绪章节")
      return
    }

    setIsAccepting(true)
    try {
      const res = await batchAcceptCampaignDrafts(project.path, resultsToAccept, {
        autoIngest,
        llmConfig,
        onProgress: (current, total, path) => {
          setProgressMessage(`正在落盘: 第 ${current}/${total} 篇 (${path.split("/").pop()})`)
        },
      })

      setAcceptResult(res)

      // 刷新文件树
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch (e) {
        console.warn("刷新文件树失败:", e)
      }

      toast.success(
        `批量验收完成！成功落盘 ${res.acceptedCount} 个章节${
          res.ingestedCount > 0 ? `，事实库摄取 ${res.ingestedCount} 章` : ""
        }`,
      )
    } catch (err) {
      toast.error(`批量验收失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsAccepting(false)
    }
  }

  const readyCount = chapterResults.filter((r) => r.status === "ready").length
  const totalWords = chapterResults.reduce((acc, r) => acc + r.wordCount, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Flame className="h-5 w-5 text-orange-500" />
            <DialogTitle>长程战役调度工作台 (Autonomous Campaign Runner)</DialogTitle>
          </div>
          <DialogDescription>
            自动跨章连续推演与撰写，在沙箱中动态传递前情因果，坚守 Draft-first 安全红线。
          </DialogDescription>
        </DialogHeader>

        {/* 顶部参数配置区 */}
        <div className="grid grid-cols-2 gap-3 p-3 rounded-lg border bg-muted/20 text-xs">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">起始章节</Label>
            <Input
              type="number"
              min={1}
              value={startChapter}
              disabled={isRunning}
              onChange={(e) => setStartChapter(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">连写章数</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={chapterCount}
              disabled={isRunning}
              onChange={(e) => setChapterCount(Math.max(1, Math.min(20, Number.parseInt(e.target.value, 10) || 1)))}
              className="h-8 text-xs"
            />
          </div>
          <div className="col-span-2 flex items-center justify-between pt-1 border-t border-border/40">
            <label className="flex items-center gap-1.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={cruiseMode}
                disabled={isRunning}
                onChange={(e) => setCruiseMode(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary"
              />
              <span className="font-semibold text-primary">开启全自动巡航推进（门控全绿自动晋升正式章节并双写事实库）</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoIngest}
                disabled={isRunning}
                onChange={(e) => setAutoIngest(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary"
              />
              <span>批量验收摄取事实库</span>
            </label>
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
                {activeChapterIndex} / {chapterCount} 章
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
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium border border-primary/20">
                          <CheckCheck className="h-3 w-3" /> 巡航落盘
                        </span>
                      ) : result.status === "ready" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 text-[11px] font-medium border border-emerald-500/20">
                          <Check className="h-3 w-3" /> 就绪
                        </span>
                      ) : null}
                      {result.status === "blocked" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[11px] font-medium border border-amber-500/20">
                          <AlertTriangle className="h-3 w-3" /> 阻断转人工
                        </span>
                      )}
                      {result.status === "failed" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 px-2 py-0.5 text-[11px] font-medium border border-rose-500/20">
                          <XCircle className="h-3 w-3" /> 失败
                        </span>
                      )}

                      <button
                        type="button"
                        aria-label={isExpanded ? `收起第 ${result.chapterNumber} 章详情` : `展开第 ${result.chapterNumber} 章详情`}
                        aria-expanded={isExpanded}
                        onClick={() => setExpandedChapter(isExpanded ? null : result.chapterNumber)}
                        className="p-1 text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* 展开查看正文选段 */}
                  {isExpanded && (
                    <div className="mt-1 p-2.5 rounded bg-muted/40 border text-xs text-muted-foreground font-sans whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
                      {result.content ? result.content.slice(0, 500) + (result.content.length > 500 ? "..." : "") : "（空正文）"}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 批量验收结果横幅 */}
        {acceptResult && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded border border-emerald-500/20">
            <CheckCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              已成功验收落盘 {acceptResult.acceptedCount} 章节{acceptResult.ingestedCount > 0 ? `，事实库自动摄取 ${acceptResult.ingestedCount} 章` : ""}。
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
              可晋升草稿：<strong className="text-emerald-600 dark:text-emerald-400">{readyCount}</strong> 章
            </span>
          </div>
        )}

        {/* 底部操作栏 */}
        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-between w-full">
          <div>
            {isRunning ? (
              <Button variant="destructive" size="sm" onClick={handleCancelCampaign} className="gap-1.5">
                <Square className="h-4 w-4 shrink-0" />
                终止战役
              </Button>
            ) : (
              <Button
                variant="default"
                size="sm"
                onClick={handleStartCampaign}
                className="gap-1.5 bg-orange-600 hover:bg-orange-700 text-white"
              >
                <Flame className="h-4 w-4 shrink-0" />
                启动战役
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isRunning}>
              关闭
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleBatchAccept}
              disabled={readyCount === 0 || isRunning || isAccepting}
              className="gap-1.5"
            >
              {isAccepting ? (
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              ) : (
                <CheckCheck className="h-4 w-4 shrink-0" />
              )}
              {isAccepting ? "正在原子落盘..." : `批量验收并落盘 (${readyCount})`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
