// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useState, useMemo } from "react"
import { Users, GitMerge, ShieldAlert, Sparkles, Copy, Check, EyeOff, BookOpen, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import type { NovelAgent, TimelineEvent } from "@/lib/novel"
import {
  createMultiPovMesh,
  detectPovIntersections,
  generateConvergencePack,
  sliceContextForPov,
  type MultiPovMesh,
  type PovThread,
  type UpcomingSceneDescriptor,
  type PovIntersection,
} from "@/lib/novel/story-simulation/multi-pov-mesh"
import { verifyPovEpistemicIntegrityWithSlm } from "@/lib/novel/ollama-slm-adapter"

interface MultiPovMeshPanelProps {
  agents: Map<string, NovelAgent>
  events: TimelineEvent[]
  className?: string
}

export function MultiPovMeshPanel({ agents, events, className = "" }: MultiPovMeshPanelProps) {
  const [selectedPovId, setSelectedPovId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [testDraft, setTestDraft] = useState("")
  const [slmChecking, setSlmChecking] = useState(false)
  const [slmResult, setSlmResult] = useState<{ passed: boolean; message: string } | null>(null)

  const agentList = useMemo(() => Array.from(agents.values()), [agents])

  // 初始化或派生当前多主角织网
  const mesh: MultiPovMesh = useMemo(() => {
    const characters = agentList.map((a) => ({
      id: a.characterId,
      name: a.name,
      role: a.profile || "主角",
      arcTheme: `${a.name}的破局叙事线`,
      knows: a.cognition?.knows ? [...a.cognition.knows] : (a.knownFacts ? Array.from(a.knownFacts) : []),
      doesNotKnow: a.cognition?.doesNotKnow ? [...a.cognition.doesNotKnow] : [],
    }))

    const initialMesh = createMultiPovMesh({
      title: "当前推演多视点并行织网",
      characters,
    })

    // 从 timeline 事件中提取可能的计划/演进场景用于交汇检测
    const plannedScenes: UpcomingSceneDescriptor[] = events.map((e) => {
      const isLocationTarget = e.targetName?.startsWith("地点:")
      return {
        chapterNumber: e.nodeIndex + 1,
        povId: `pov-${e.actorId}`,
        location: isLocationTarget ? e.targetName?.slice(3) : undefined,
        targetItemOrGoal: isLocationTarget ? undefined : e.targetName,
        eventSummary: e.content,
      }
    })

    detectPovIntersections(initialMesh, plannedScenes)
    return initialMesh
  }, [agentList, events])

  // 当前选中主角的独立切片信息
  const activeThread = useMemo(() => {
    if (!selectedPovId && mesh.threads.length > 0) return mesh.threads[0]
    return mesh.threads.find((t) => t.id === selectedPovId) || null
  }, [mesh, selectedPovId])

  const sliceDirective = useMemo(() => {
    if (!activeThread) return ""
    return sliceContextForPov(mesh, activeThread.id, 999, []).directive
  }, [mesh, activeThread])

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    toast.success("已复制到剪贴板")
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleSlmTest = async (thread: PovThread) => {
    if (!testDraft.trim()) return
    setSlmChecking(true)
    setSlmResult(null)

    try {
      const res = await verifyPovEpistemicIntegrityWithSlm({
        draftText: testDraft,
        characterName: thread.characterName,
        doesNotKnowFacts: thread.epistemicScope.doesNotKnow,
      })

      if (res.passed) {
        setSlmResult({
          passed: true,
          message: `【${res.checkedBy.toUpperCase()} 审查通过】：未发现全知穿帮，符合 ${thread.characterName} 的认知视窗。`,
        })
      } else {
        setSlmResult({
          passed: false,
          message: `【${res.checkedBy.toUpperCase()} 拦截到穿帮】：${res.leakedFacts.join("；")}`,
        })
      }
    } catch (e) {
      setSlmResult({
        passed: false,
        message: `自检异常：${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      setSlmChecking(false)
    }
  }

  return (
    <div className={`flex h-full flex-col overflow-hidden bg-background text-foreground ${className}`}>
      {/* 顶部标题区 */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold">多主角并行织网视图 (Multi-POV Mesh)</h2>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {mesh.threads.length} 视点 / {mesh.intersections.length} 交汇点
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          独立前情切片 · 认知边界硬隔离 · 时空交汇探测
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-0 overflow-hidden">
        {/* 左侧：视点角色导航 */}
        <div className="col-span-3 flex flex-col border-r bg-muted/20">
          <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
            视点角色列表 (POV Threads)
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {mesh.threads.map((t) => {
              const isSelected = activeThread?.id === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedPovId(t.id)}
                  className={`w-full rounded-md p-2.5 text-left transition-all ${
                    isSelected
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{t.characterName}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isSelected ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {t.role}
                    </span>
                  </div>
                  <div className={`mt-1 line-clamp-1 text-xs ${isSelected ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                    {t.arcTheme}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[10px]">
                    <span className="flex items-center gap-0.5">
                      <BookOpen className="h-3 w-3" />
                      知晓 {t.epistemicScope.knows.length}
                    </span>
                    <span className="flex items-center gap-0.5 text-rose-500">
                      <EyeOff className="h-3 w-3" />
                      隐秘 {t.epistemicScope.doesNotKnow.length}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* 中间：独立前情切片与视点硬约束 */}
        <div className="col-span-5 flex flex-col border-r overflow-y-auto p-4 space-y-4">
          {activeThread ? (
            <>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5">
                    <Users className="h-4 w-4 text-primary" />
                    当前视点：{activeThread.characterName} 的独立切片视窗
                  </h3>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => handleCopy(sliceDirective, "directive")}
                  >
                    {copiedId === "directive" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    复制 Prompt 承接包
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  已实施物理隔离：杜绝其他角色隐私剧情泄露，强制注入【禁止描写】认知铁律。
                </p>
              </div>

              {/* 认知盲区提示 */}
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="h-4 w-4" />
                  防穿帮铁律 (Epistemic Constraints)
                </div>
                {activeThread.epistemicScope.doesNotKnow.length > 0 ? (
                  <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                    {activeThread.epistemicScope.doesNotKnow.map((fact, idx) => (
                      <li key={idx}>
                        【禁止描写】：{activeThread.characterName}此时绝对不知晓【{fact}】
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted-foreground">暂无显式被隐瞒的情报，视点全知本线既有事件。</div>
                )}
              </div>

              {/* Prompt 指令包预览 */}
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">生成的视点注入指令包：</div>
                <pre className="max-h-60 overflow-y-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                  {sliceDirective}
                </pre>
              </div>

              {/* 端侧 SLM 穿帮快速自检互动区 */}
              <div className="rounded-lg border p-3 bg-muted/10 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold flex items-center gap-1">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    本地小模型 (SLM) 穿帮极速初筛
                  </span>
                  <Button
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => handleSlmTest(activeThread)}
                    disabled={slmChecking}
                  >
                    {slmChecking ? "检测中..." : "极速自检"}
                  </Button>
                </div>
                <textarea
                  value={testDraft}
                  onChange={(e) => setTestDraft(e.target.value)}
                  placeholder={`输入测试段落，检测是否让 ${activeThread.characterName} 违规获知了其不知晓的事实...`}
                  className="w-full h-20 text-xs rounded-md border p-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {slmResult && (
                  <div
                    className={`rounded p-2 text-xs ${
                      slmResult.passed
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                    }`}
                  >
                    {slmResult.message}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              请从左侧选择一个视点角色
            </div>
          )}
        </div>

        {/* 右侧：交汇检测看板 (Intersections) */}
        <div className="col-span-4 flex flex-col overflow-y-auto p-4 space-y-3 bg-muted/10">
          <div className="flex items-center justify-between border-b pb-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <GitMerge className="h-4 w-4 text-primary" />
              支线交汇检测看板 ({mesh.intersections.length})
            </h3>
          </div>

          {mesh.intersections.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground text-center py-12">
              暂未探测到支线交汇点。<br />
              当多个主角在同一章节同场景出现、争夺同一关键物或相近章节经过同一地点时，系统将自动对撞并生成对齐包。
            </div>
          ) : (
            mesh.intersections.map((inter: PovIntersection) => {
              const packText = generateConvergencePack(mesh, inter)
              return (
                <div key={inter.id} className="rounded-lg border bg-background p-3 shadow-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[11px] font-semibold">
                      第 {inter.chapterNumber} 章交汇
                    </span>
                    <span className="text-[10px] text-muted-foreground uppercase">{inter.intersectionType}</span>
                  </div>
                  <div className="text-xs text-foreground font-medium">{inter.description}</div>
                  <div className="text-[11px] text-muted-foreground">
                    发生地点：{inter.location || "剧情场景"} | 目标：{inter.targetItemOrGoal || "剧情推进"}
                  </div>
                  <div className="flex justify-end pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] gap-1"
                      onClick={() => handleCopy(packText, inter.id)}
                    >
                      {copiedId === inter.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      复制对齐约束包
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
