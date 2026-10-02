// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useRef, useState } from "react"
import {
  Wand2,
  Sparkles,
  Loader2,
  CheckCircle2,
  BookOpen,
  Users,
  Compass,
  Layers,
  Flame,
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
import { Textarea } from "@/components/ui/textarea"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { toast } from "@/lib/toast"
import {
  runEndToEndAutonomousNovelProduction,
  type NovelIncubatorResult,
  type CampaignReport,
} from "@/lib/novel"

interface AutonomousIncubatorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (result: { incubation: NovelIncubatorResult; campaign?: CampaignReport }) => void
}

const STAGES = [
  { key: "soul-doc", label: "故事灵魂设定（核心创意+基调）", icon: BookOpen },
  { key: "world-blueprint", label: "世界观设定（五层蓝图）", icon: Compass },
  { key: "characters", label: "核心角色档案", icon: Users },
  { key: "outline", label: "大纲多智能体推演", icon: Sparkles },
  { key: "unpack-chapters", label: "章节骨架自动铺排", icon: Layers },
  { key: "framework-binding", label: "起承转合框架绑定", icon: Compass },
]

export function AutonomousIncubatorDialog({
  open,
  onOpenChange,
  onSuccess,
}: AutonomousIncubatorDialogProps) {
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const [idea, setIdea] = useState("")
  const [title, setTitle] = useState("")
  const [genre, setGenre] = useState("")
  const [targetChapters, setTargetChapters] = useState(10)
  const [autoCruise, setAutoCruise] = useState(false)
  const [cruiseCount, setCruiseCount] = useState(3)

  const [isRunning, setIsRunning] = useState(false)
  const [currentStage, setCurrentStage] = useState<string>("")
  const [progressMessage, setProgressMessage] = useState("")
  const [result, setResult] = useState<{ incubation: NovelIncubatorResult; campaign?: CampaignReport } | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  async function handleStart() {
    if (!project || !idea.trim() || isRunning) return

    const controller = new AbortController()
    abortRef.current = controller

    setIsRunning(true)
    setResult(null)
    setCurrentStage("soul-doc")
    setProgressMessage("正在启动全自动孵化引擎...")

    try {
      const res = await runEndToEndAutonomousNovelProduction({
        projectPath: project.path,
        idea: idea.trim(),
        title: title.trim() || undefined,
        genre: genre.trim() || undefined,
        targetChapters,
        llmConfig,
        novelConfig,
        autoStartCruise: autoCruise,
        cruiseChapterCount: cruiseCount,
        onProgress: (info) => {
          setCurrentStage(info.stage)
          setProgressMessage(info.message)
        },
        signal: controller.signal,
      })

      setResult(res)
      onSuccess?.(res)

      // 刷新项目文件树
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch (e) {
        console.warn("孵化后刷新文件树失败:", e)
      }

      toast.success(
        autoCruise && res.campaign
          ? `全自动孵化与巡航完成！《${res.incubation.title}》已生成骨架并巡航完成 ${res.campaign.completedChapters} 章！`
          : `《${res.incubation.title}》全自动孵化完成！设定、角色与 ${res.incubation.unpackedSkeletons.createdCount} 个章节骨架已全部就绪。`,
      )
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info("全自动孵化已被中止")
      } else {
        toast.error(`全自动孵化失败：${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }

  function handleCancel() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsRunning(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-purple-500" />
            <DialogTitle>全自动小说冷启动孵化器 (Autonomous Novel Incubator)</DialogTitle>
          </div>
          <DialogDescription>
            只需一句构思灵感，全自动链式推演灵魂文档、世界观蓝图、角色档案、大纲细纲骨架与起承转合框架。
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="flex flex-col gap-4 py-2 overflow-y-auto">
            {/* 核心灵感输入 */}
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold">
                核心创意 / 灵感点子 <span className="text-rose-500">*</span>
              </Label>
              <Textarea
                rows={3}
                disabled={isRunning}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="例如：赛博朋克都市中一名被遗忘的机械记忆修复师，在一次日常维修中意外唤醒了来自旧纪元的神明源代码，从此被巨企神权追杀..."
                className="text-xs resize-none"
              />
            </div>

            {/* 可选参数网格 */}
            <div className="grid grid-cols-3 gap-3 p-3 rounded-lg border bg-muted/20 text-xs">
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">作品书名 (可选)</Label>
                <Input
                  disabled={isRunning}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="未填写则自动推导"
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">题材流派 (可选)</Label>
                <Input
                  disabled={isRunning}
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  placeholder="科幻 / 玄幻 / 悬疑等"
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">目标篇幅 (章)</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  disabled={isRunning}
                  value={targetChapters}
                  onChange={(e) => setTargetChapters(Math.max(1, Number.parseInt(e.target.value, 10) || 10))}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            {/* 联动巡航选项 */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/10 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCruise}
                  disabled={isRunning}
                  onChange={(e) => setAutoCruise(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  孵化后直接启动全自动巡航推进（连写正文）
                </span>
              </label>

              {autoCruise && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">连写</span>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    disabled={isRunning}
                    value={cruiseCount}
                    onChange={(e) => setCruiseCount(Math.max(1, Number.parseInt(e.target.value, 10) || 3))}
                    className="w-16 h-7 text-xs"
                  />
                  <span className="text-muted-foreground">章</span>
                </div>
              )}
            </div>

            {/* 进度显示区 */}
            {isRunning && (
              <div className="flex flex-col gap-2 p-3 rounded-lg border bg-purple-500/5 border-purple-500/20">
                <div className="flex items-center justify-between text-xs text-purple-600 dark:text-purple-400 font-medium">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{progressMessage}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-1">
                  {STAGES.map((st, i) => {
                    const isDone = STAGES.findIndex((s) => s.key === currentStage) > i || currentStage === "complete"
                    const isCurrent = currentStage === st.key
                    const Icon = st.icon
                    return (
                      <div
                        key={st.key}
                        className={`flex items-center gap-2 p-1.5 rounded text-[11px] border ${
                          isDone
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                            : isCurrent
                              ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30 animate-pulse"
                              : "bg-muted/30 text-muted-foreground border-border/40"
                        }`}
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        ) : (
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate">{st.label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* 孵化成果报告卡片 */
          <div className="flex flex-col gap-3 py-2 overflow-y-auto text-xs">
            <div className="flex items-center gap-2 p-3 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded border border-emerald-500/20">
              <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
              <div>
                <p className="font-semibold text-sm">《{result.incubation.title}》全自动孵化大获成功！</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  全书基底已完全构建，章节骨架与故事模拟推演已实时注入系统。
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded border bg-card flex flex-col gap-1.5">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Compass className="h-4 w-4 text-primary" /> 世界观与题材
                </span>
                <p className="text-muted-foreground">题材：{result.incubation.genre}</p>
                <p className="text-muted-foreground">公理法则与分层：5 大必填层 100% 完备通过</p>
              </div>

              <div className="p-3 rounded border bg-card flex flex-col gap-1.5">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Users className="h-4 w-4 text-primary" /> 核心角色卡片
                </span>
                <p className="text-muted-foreground">
                  已塑造 {result.incubation.characters.length} 位角色：{result.incubation.characters.map((c) => c.name).join("、")}
                </p>
                <p className="text-muted-foreground">人设卡片已归档至 wiki/characters/</p>
              </div>

              <div className="p-3 rounded border bg-card flex flex-col gap-1.5">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-primary" /> 章节骨架铺排
                </span>
                <p className="text-muted-foreground">
                  已自动铺排 {result.incubation.unpackedSkeletons.createdCount} 个章节预定文件
                </p>
                <p className="text-muted-foreground">规范状态：planned，后续起草自动提取细纲</p>
              </div>

              <div className="p-3 rounded border bg-card flex flex-col gap-1.5">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-primary" /> 故事模拟起承转合
                </span>
                <p className="text-muted-foreground">已提取 4 阶段节拍并全局激活绑定</p>
                <p className="text-muted-foreground">正文生成上下文已自动挂接推演指引</p>
              </div>
            </div>

            {result.campaign && (
              <div className="p-3 rounded border bg-orange-500/10 border-orange-500/20 text-orange-700 dark:text-orange-300 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-orange-500" />
                  <span>战役全自动巡航已完成第 1 至 {result.campaign.completedChapters} 章正文起草与事实库双写</span>
                </div>
                <span className="font-mono font-semibold">{result.campaign.totalWords.toLocaleString()} 字</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 pt-2 border-t">
          {!result ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isRunning) handleCancel()
                  else onOpenChange(false)
                }}
              >
                {isRunning ? "中止孵化" : "取消"}
              </Button>
              <Button
                size="sm"
                disabled={isRunning || !idea.trim()}
                onClick={handleStart}
                className="gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在链式自主孵化...
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" />
                    一键启动全自动孵化
                  </>
                )}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false)
                setResult(null)
              }}
              className="ml-auto"
            >
              完成并开启创作
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
