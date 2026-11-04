import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Flame, Loader2, Play, Square, Sparkles, Wand2 } from "lucide-react"
import { fileExists } from "@/commands/fs"
import { WikiReader } from "@/components/editor/wiki-reader"
import {
  buildStageJournalRuntime,
  buildTraceEntries,
  buildTraceSnapshot,
  createMainControlQualityDeps,
  loadTraceSnapshot,
  resolveDeepChapterRunner,
  resolveWikiPath,
  runMainControlAgent,
  saveTraceSnapshot,
  type DeepChapterGateVerdict,
  type DeepChapterGenerationResult,
  type MainControlResult,
  type MainControlStep,
  type TraceEntry,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveAiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { AgentActivityEvent, AgentActivityKind } from "@/lib/agent/types"
import { cn, toErrorMessage } from "@/lib/utils"
import { ChapterDirectory } from "./chapter-directory"
import { MainControlDraftAdoptBlock } from "./main-control-draft-adopt-block"
import { MainControlGateRerunBlock } from "./main-control-gate-rerun-block"
import { MainControlSettingsBlock } from "./main-control-settings-block"
import { PipelineMotionView } from "./pipeline-motion-view"
import { ForeshadowingPanel } from "./foreshadowing-panel"
import { WorkHeatmapPanel } from "./work-heatmap-panel"
import { LiveExecutionView } from "./live-execution-view"
import { clearMainControlGoalHandoff, peekMainControlGoalHandoff } from "./main-control-handoff"

export interface MainControlViewProps {
  /** 项目 id（与其它视图签名一致；路径取 store 里的 project.path）。 */
  projectId?: string
}

function upsertStep(prev: MainControlStep[], next: MainControlStep): MainControlStep[] {
  const index = prev.findIndex((step) => step.callId === next.callId)
  if (index < 0) return [...prev, next]
  const copy = [...prev]
  copy[index] = { ...copy[index], ...next }
  return copy
}

/**
 * 「第N章」严格解析（只认带「第…章/节/回」的写法）。
 *
 * 不复用 `extractChapterNumber`：它兜底取文本里任意数字，会把「目标 3000 字」
 * 解析成第 3000 章。章号进生成链是硬输入，宁可认不出（undefined）也不能认错。
 */
function parseChapterNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  const match = text.match(/第\s*(\d+)\s*[章节回]/)
  if (!match?.[1]) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 深章门控总体结论 → 文案键。
 *
 * 复用门控重跑块同一组 verdict 措辞（不另造第二套「通过/警告/…」说法）；
 * 结论本身来自 `buildDecisionGates`（门控单一真源），这里只搬运展示。
 */
const DEEP_GATE_VERDICT_KEYS: Record<DeepChapterGateVerdict, string> = {
  pass: "mainControl.draftGatePass",
  warning: "mainControl.draftGateWarning",
  fail: "mainControl.draftGateFail",
  manual_review: "mainControl.draftGateManual",
  pending: "mainControl.draftGatePending",
}

/**
 * 阶段事件类别 → 文案键（固定映射表）。
 * 不用模板字面量拼 key（避免把 kind 插进 key 里）：未命中的 kind 会渲染出原始 key，
 * 且 i18n 前缀校验无法覆盖。
 */
const ACTIVITY_KIND_LABEL_KEYS: Partial<Record<AgentActivityKind, string>> = {
  stage_started: "mainControl.activityKindStageStarted",
  stage_output: "mainControl.activityKindStageOutput",
  analysis: "mainControl.activityKindAnalysis",
  extract_result: "mainControl.activityKindExtractResult",
  error: "mainControl.activityKindError",
}

/**
 * 主控 Agent 面板（阶段 1）：一句话目标 → 只读工具收集上下文 → 产出草稿。
 *
 * 正式正文不会被直写：写工具走 draftMode，草稿仍需在草稿区确认后才进正式库。
 * 运行轨迹同时进入热力图 session log（`recordModuleHit`）。
 */
export function MainControlView(_props: MainControlViewProps = {}) {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path ?? "")
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const novelMode = useWikiStore((s) => s.novelMode)
  // F16：采纳块要拿到「当前打开的文件」，否则「同书同名复用当前章」分支恒不可达
  // （与 writing-workspace.tsx → chapter-draft-dock.tsx 同一数据源，语义对齐）。
  const selectedFile = useWikiStore((s) => s.selectedFile)
  // 工作流强度：全局单键（D1=A），由 composition-root 在打开项目时载入 store；
  // R-02：绝不硬编码默认档，否则设置改了主控仍跑 standard。
  const aiWorkflowMode = useWikiStore((s) => s.aiWorkflowMode)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  // 章节页「生成本章草稿」交接的目标只预填，不自动执行（批次二·8）。
  const [goal, setGoal] = useState(() => peekMainControlGoalHandoff() ?? "")
  useEffect(() => {
    clearMainControlGoalHandoff()
  }, [])
  const [steps, setSteps] = useState<MainControlStep[]>([])
  const [result, setResult] = useState<MainControlResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelledAt, setCancelledAt] = useState<number | null>(null)
  // R03=a（TASK-008）：显式「跑深章」入口的独立运行态与产出（与主控 Agent 运行互不覆盖）。
  const [deepRunning, setDeepRunning] = useState(false)
  const [deepOutput, setDeepOutput] = useState<DeepChapterGenerationResult | null>(null)
  // 页内分层（IA：跑流程 / 收草稿 / 本章上下文分开，不再上下堆一屏；只切换展示，不碰执行语义）。
  // 批次三·12：AI 实况并入主控，作为第四个页签（独立页路由保留给旧深链）。
  const [tab, setTab] = useState<"run" | "drafts" | "context" | "live">("run")
  // 管线动态：默认展开实况拓扑，开始运行自动展开，无需等磁盘轮询。
  const [motionOpen, setMotionOpen] = useState(true)
  // PAT-U5（ISS-20260712-006 batch-2）：折叠触发点补 aria-controls + region。
  const motionPanelId = useId()
  // 运行起点（已运行秒数展示用；10s 心跳 tick 驱动重渲染，无假进度条）。
  const [runStartAt, setRunStartAt] = useState<number | null>(null)
  // 心跳 tick：运行时每 10 秒重渲染一次，用于卡住/超时提示（不碰主链计时）。
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((v) => v + 1), 10_000)
    return () => clearInterval(timer)
  }, [running])
  const [trace, setTrace] = useState<TraceEntry[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const [replaySavedAt, setReplaySavedAt] = useState<number | null>(null)
  // RV-002 ②：运行结束后才发生的观测（记忆回填）也要进同一个 activities 列表。
  const [extraActivities, setExtraActivities] = useState<AgentActivityEvent[]>([])
  const abortRef = useRef<AbortController | null>(null)
  // 深章入口自己的中止句柄（与主控 Agent 的 abortRef 分开，两条运行互不顶掉）。
  const deepAbortRef = useRef<AbortController | null>(null)

  /**
   * 当前章节：优先「已打开的文件」（与采纳块同一数据源 selectedFile），
   * 否则从目标文本里认「第N章」。认不出就不传（章号是可选输入，不猜）。
   */
  const currentChapterNumber = useMemo(
    () =>
      parseChapterNumber(selectedFile?.split(/[\\/]/).pop() ?? "") ?? parseChapterNumber(goal),
    [selectedFile, goal],
  )

  // 运行中实况轨迹：steps 派生（无需等磁盘轮询）；空闲时沿用磁盘快照。
  const liveTrace = useMemo(() => buildTraceEntries(steps), [steps])
  // D5=A：阶段过程事件独立通道（缺失即空数组，不伪造）。
  const runActivities = useMemo(() => result?.activities ?? [], [result])
  // 同一条通道的两个来源：本次运行（stage_output / consensus） + 采纳后回填（ingest）。
  const activities = useMemo(
    () => (extraActivities.length > 0 ? [...runActivities, ...extraActivities] : runActivities),
    [runActivities, extraActivities],
  )

  /** 落轨迹快照（单一出口）：activities 由调用方给，保证本次运行与采纳后回填同源。 */
  const persistSnapshot = useCallback(
    (input: {
      goal: string
      ok: boolean
      stopReason?: string
      roundsUsed: number
      finalText: string
      steps: readonly MainControlStep[]
      activities: readonly AgentActivityEvent[]
    }) => {
      if (!projectPath) return
      void saveTraceSnapshot(
        projectPath,
        buildTraceSnapshot({
          goal: input.goal,
          ok: input.ok,
          stopReason: input.stopReason,
          roundsUsed: input.roundsUsed,
          finalText: input.finalText,
          steps: input.steps,
          activities: input.activities,
          now: Date.now(),
        }),
      )
    },
    [projectPath],
  )

  // RV-002 ②：运行结束后才发生的观测（记忆回填）也要重落快照，否则回放里看不到。
  useEffect(() => {
    if (!result || extraActivities.length === 0) return
    persistSnapshot({
      goal,
      ok: result.ok,
      stopReason: result.error,
      roundsUsed: result.roundsUsed,
      finalText: result.finalText,
      steps: result.steps,
      activities,
    })
  }, [activities, extraActivities, goal, persistSnapshot, result])
  // 回放：进面板时载入上一次运行的轨迹快照（缺失即空）。
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void loadTraceSnapshot(projectPath).then((snapshot) => {
      if (cancelled || !snapshot) return
      setTrace(snapshot.entries)
      setReplaySavedAt(snapshot.savedAt)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const start = async () => {
    const trimmed = goal.trim()
    if (!trimmed || running || deepRunning) return
    if (!projectPath) {
      setError(t("mainControl.noProject"))
      return
    }
    setError(null)
    setResult(null)
    setSteps([])
    setTrace([])
    setReplaySavedAt(null)
    setExtraActivities([])
    setMotionOpen(true)
    setRunStartAt(Date.now())
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const wikiPath = await resolveWikiPath(projectPath, fileExists)
      // 真实依赖装配：六维评分/定向重写走当前 review 模型；深章流水线只在小说模式开启时接线。
      const quality = createMainControlQualityDeps({
        projectPath,
        llmConfig,
        signal: controller.signal,
      })
      const runDeepChapterGeneration = novelMode ? await resolveDeepChapterRunner(novelConfig) : undefined
      // G3：阶段日志装配收敛到共享 helper（与 chat 侧同一语义；关闭时返回 undefined）。
      const stageJournal = buildStageJournalRuntime(
        projectPath,
        novelConfig.stageJournalEnabled,
        novelConfig.journalTtlMs,
      )
      const out = await runMainControlAgent({
        projectPath,
        wikiPath,
        goal: trimmed,
        llmConfig,
        quality,
        runDeepChapterGeneration,
        aiWorkflowMode: resolveAiWorkflowMode(aiWorkflowMode),
        stageJournal,
        signal: controller.signal,
        onStep: (step) => setSteps((prev) => upsertStep(prev, step)),
      })
      setSteps(out.steps)
      setResult(out)
      setTrace(buildTraceEntries(out.steps))
      setReplaySavedAt(null)
      // RV-002：快照消费同一条 activities 通道（本次运行的 stage_output/consensus；
      // 运行后才发生的 ingest 由下方 effect 追加并重落）。
      persistSnapshot({
        goal: trimmed,
        ok: out.ok,
        stopReason: out.error,
        roundsUsed: out.roundsUsed,
        finalText: out.finalText,
        steps: out.steps,
        activities: out.activities ?? [],
      })
      if (out.error) {
        // 用户亲手点的中止走成功分支回来（runner resolve + error)：以 signal 为准判取消，不进红字失败。
        if (controller.signal.aborted) {
          setCancelledAt(Date.now())
        } else {
          setError(out.error)
        }
      }
    } catch (err) {
      // 用户亲手点的中止不算失败：已取消态单独展示不进红字错误。
      if (controller.signal.aborted) {
        setCancelledAt(Date.now())
      } else {
        setError(toErrorMessage(err))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    // 深章入口与主控 Agent 共用同一个「中止」出口（两条都在跑时一起停）。
    deepAbortRef.current?.abort()
    setRunning(false)
    setDeepRunning(false)
    setCancelledAt(Date.now())
  }

  /**
   * R03=a（TASK-008）：显式「跑深章」入口。
   *
   * 为什么不是「拼一句目标再跑 Agent」：主控里的 `run_chapter_workflow` 是模型自觉调用的工具，
   * 没有任何确定性保证（F23：正文生成无独立入口）。这里直接走 `start()` 用的同一条两步路径——
   * `resolveDeepChapterRunner(novelConfig)` → `runDeepChapterGeneration`——把「跑不跑深章」
   * 从模型判断变成用户点击；共识/单模型入口选择仍归 `resolveDeepChapterRunner`，
   * 门控仍归 `buildDecisionGates`（不另开生成路径、不另立门控）。
   *
   * 硬边界：产物只进面板展示，**点击路径零写盘**（无 writeFile/writeDraft/accept 调用）；
   * 采纳仍是草稿区的两步确认，`draft-manager` 的 `if (!input.confirmed) throw` 原样生效。
   */
  const startDeepChapter = async () => {
    // 防重入：状态位 + 按钮 disabled 双保险（深章跑一次可能几十分钟，重入会双跑同一章）。
    if (deepRunning || running) return
    if (!projectPath) {
      setError(t("mainControl.noProject"))
      return
    }
    // 目标空也允许跑：以「当前章节 + 当前目标字数」为输入，userRequest 用中性兜底文案。
    const userRequest = goal.trim() || t("mainControl.deepChapterGoalFallback")
    setError(null)
    setCancelledAt(null)
    setDeepOutput(null)
    setDeepRunning(true)
    const controller = new AbortController()
    deepAbortRef.current = controller
    try {
      // 与 start() 同一行代码语义：按开关取入口（共识版/单模型版），再跑深章流水线。
      const runDeepChapterGeneration = await resolveDeepChapterRunner(novelConfig)
      // G3：阶段日志装配与主控 Agent 共用同一 helper（同一开关与 TTL 语义）。
      const stageJournal = buildStageJournalRuntime(
        projectPath,
        novelConfig.stageJournalEnabled,
        novelConfig.journalTtlMs,
      )
      const out = await runDeepChapterGeneration(
        {
          projectPath,
          userRequest,
          chapterNumber: currentChapterNumber,
          llmConfig,
          novelConfig,
          // 54⑧ 题材透传（undefined → 生成链零行为变更，与 run_chapter_workflow 同口径）。
          genre: novelConfig.genre,
          ...(stageJournal ? { stageJournal } : {}),
        },
        {
          // 阶段产出进主控同一条 activities 通道（与 run_chapter_workflow 的 onThinking 同口径）。
          onThinking: (content) => {
            const body = content.trim()
            if (!body) return
            const timestamp = Date.now()
            setExtraActivities((prev) => [
              ...prev,
              {
                id: `main_control_deep_chapter:thinking:${timestamp}`,
                stageId: "main_control_deep_chapter",
                kind: "stage_output",
                title: t("mainControl.deepChapterActivityTitle"),
                content: body.length > 240 ? `${body.slice(0, 240)}…` : body,
                timestamp,
              },
            ])
          },
        },
        undefined,
        controller.signal,
        // 共识轨迹同一条通道（单模型 runner 忽略第 5 参，与工具路径一致）。
        (trace) => {
          const timestamp = Date.now()
          const parts = [
            `${t("mainControl.consensusSeatCount")}: ${trace.seatCount}`,
            `${t("mainControl.consensusDebateRounds")}: ${trace.debateRounds}`,
            `${t("mainControl.consensusWinner")}: ${trace.winner}`,
          ]
          setExtraActivities((prev) => [
            ...prev,
            {
              id: `consensus_writing:${timestamp}`,
              stageId: "consensus_writing",
              kind: "analysis",
              title: t("mainControl.consensusTitle"),
              content: parts.join(" · "),
              timestamp,
            },
          ])
        },
      )
      setDeepOutput(out)
    } catch (err) {
      // 用户亲手中止不算失败（与主控 Agent 同一判定：以 signal 为准）。
      if (controller.signal.aborted) {
        setCancelledAt(Date.now())
      } else {
        setError(t("mainControl.deepChapterFailed", { message: toErrorMessage(err) }))
      }
    } finally {
      setDeepRunning(false)
      deepAbortRef.current = null
    }
  }

  // 卡住/超时：正在跑的那一步 90 秒无返回提示卡住5 分钟建议中止（只读判断不动执行）。
  void tick
  const stuckStep = running
    ? steps.find((s) => s.status === "running" && Date.now() - s.at > 90_000)
    : undefined
  const stuckSecs = stuckStep ? Math.floor((Date.now() - stuckStep.at) / 1000) : 0
  const stuckTimeout = stuckSecs >= 300
  // 运行摘要（诚实反馈：已运行秒 + 当前步骤 + 完成计数，无百分比假进度）。
  const runningStep = running ? [...steps].reverse().find((s) => s.status === "running") : undefined
  const doneCount = steps.filter((s) => s.status !== "running").length
  const elapsedSecs = running && runStartAt ? Math.max(Math.floor((Date.now() - runStartAt) / 1000), 0) : 0

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" data-testid="main-control-view">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold">{t("mainControl.title")}</h2>
        <span className="text-xs text-muted-foreground">{t("mainControl.subtitle")}</span>
      </div>

      <div className="flex items-center gap-1" role="tablist" aria-label={t("mainControl.tabsLabel")} data-testid="main-control-tabs">
        {(
          [
            { key: "run", labelKey: "mainControl.tabRun" },
            { key: "drafts", labelKey: "mainControl.tabDrafts" },
            { key: "context", labelKey: "mainControl.tabContext" },
            { key: "live", labelKey: "mainControl.tabLive" },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            data-testid={`main-control-tab-${item.key}`}
            onClick={() => setTab(item.key)}
            className={cn(
              "h-7 rounded-md border px-2 text-xs",
              tab === item.key
                ? "border-primary bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {tab === "run" && (
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="main-control-goal">
          {t("mainControl.goalLabel")}
        </label>
        <textarea
          id="main-control-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t("mainControl.goalPlaceholder")}
          data-testid="main-control-goal"
          rows={3}
          className="resize-y rounded-md border bg-transparent px-2 py-1 text-sm"
        />
        <div className="flex items-center gap-2">
          {running || deepRunning ? (
            <button
              type="button"
              onClick={stop}
              data-testid="main-control-stop"
              className="flex h-7 items-center gap-1 rounded-md border px-2 text-xs"
            >
              <Square className="h-3 w-3" />
              {t("mainControl.stop")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              data-testid="main-control-run"
              className={cn(
                "flex h-7 items-center gap-1 rounded-md border px-2 text-xs",
                goal.trim()
                  ? "border-primary bg-primary font-medium text-primary-foreground hover:bg-primary/90"
                  : "text-muted-foreground",
              )}
            >
              <Play className="h-3 w-3" />
              {t("mainControl.run")}
            </button>
          )}
          {/* R03=a（TASK-008）：显式「跑深章」入口。主控管跑（DEC-01=A），不依赖模型自觉调用工具。 */}
          {novelMode ? (
            <button
              type="button"
              onClick={() => void startDeepChapter()}
              disabled={deepRunning || running}
              title={t("mainControl.deepChapterHint", { chars: novelConfig.chapterTargetChars })}
              data-testid="main-control-deep-run"
              className={cn(
                "flex h-7 items-center gap-1 rounded-md border px-2 text-xs",
                deepRunning || running
                  ? "text-muted-foreground opacity-60 disabled:cursor-not-allowed"
                  : "border-primary/60 text-primary hover:bg-accent",
              )}
            >
              {deepRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
              {deepRunning ? t("mainControl.deepChapterRunning") : t("mainControl.deepChapterRun")}
            </button>
          ) : null}
          {running ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("mainControl.running")}
            </span>
          ) : null}
          {running && runStartAt ? (
            <span className="text-xs text-muted-foreground tabular-nums" data-testid="main-control-elapsed">
              {t("mainControl.elapsed", { secs: elapsedSecs })}
              {runningStep ? ` · ${runningStep.name}` : ""}
              {steps.length > 0 ? ` · ${doneCount}/${steps.length}` : ""}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setActiveView("moduleHeatmap")}
            data-testid="main-control-heatmap"
            className="ml-auto flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground"
          >
            <Flame className="h-3 w-3" />
            {t("mainControl.viewHeatmap")}
          </button>
        </div>
        {error ? (
          <p className="flex items-center gap-1 text-xs text-destructive" data-testid="main-control-error">
            <CircleAlert className="h-3 w-3" />
            {error}
          </p>
        ) : null}
        {!running && cancelledAt && !error ? (
          <p className="flex items-center gap-1 text-xs text-warning-foreground" data-testid="main-control-cancelled">
            <Square className="h-3 w-3" />
            {t("mainControl.cancelled", {
              time: new Date(cancelledAt).toLocaleTimeString("zh-CN", { hour12: false }),
            })}
          </p>
        ) : null}
        {stuckStep ? (
          <p className="flex items-center gap-1 text-xs text-warning-foreground" data-testid="main-control-stuck">
            <CircleAlert className="h-3 w-3" />
            {stuckTimeout
              ? t("mainControl.timeoutHint", { step: stuckStep.name })
              : t("mainControl.stuckHint", { step: stuckStep.name, secs: stuckSecs })}
          </p>
        ) : null}
      </div>
      )}

      {tab === "run" && <MainControlSettingsBlock />}

      {/* R03=a：深章产出只在这里展示——不写盘、不进草稿区，采纳仍需草稿区的两步确认。 */}
      {tab === "run" && deepOutput ? (
        <div className="rounded-lg border p-2" data-testid="main-control-deep-output">
          <h3 className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold">
            {t("mainControl.deepChapterOutputTitle")}
            <span
              className="rounded border px-1 text-xs font-normal text-muted-foreground"
              data-testid="main-control-deep-verdict"
            >
              {t(DEEP_GATE_VERDICT_KEYS[deepOutput.decisionGates.overall])}
            </span>
            {currentChapterNumber ? (
              <span className="text-xs font-normal text-muted-foreground" data-testid="main-control-deep-chapter">
                {t("mainControl.deepChapterChapterLabel", { chapter: currentChapterNumber })}
              </span>
            ) : null}
          </h3>
          {deepOutput.partial ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-deep-partial">
              {t("mainControl.deepChapterPartial", { reason: deepOutput.partialReason ?? "" })}
            </p>
          ) : null}
          {deepOutput.manualReviewRequired ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-deep-manual-review">
              {t("mainControl.deepChapterManualReview")}
            </p>
          ) : null}
          <WikiReader body={deepOutput.finalContent} />
          <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-deep-output-hint">
            {t("mainControl.deepChapterOutputHint")}
          </p>
        </div>
      ) : null}

      {tab === "run" && (
      <div className="rounded-lg border p-2" data-testid="main-control-steps">
        <h3 className="mb-1 text-xs font-semibold">
          {t("mainControl.stepsTitle", { count: steps.length })}
        </h3>
        {steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("mainControl.stepsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {steps.map((step) => (
              <li key={step.callId} className="flex flex-col gap-0.5" data-testid={`main-control-step-${step.name}`}>
                <span className="flex items-center gap-1 text-xs">
                  {step.status === "running" ? (
                    <Loader2 className="h-3 w-3 animate-spin text-primary" />
                  ) : step.status === "error" ? (
                    <CircleAlert className="h-3 w-3 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3 text-success" />
                  )}
                  <code className="text-xs">{step.name}</code>
                  <span className="truncate text-muted-foreground">
                    {Object.keys(step.params).length > 0 ? JSON.stringify(step.params).slice(0, 120) : ""}
                  </span>
                </span>
                {step.result || step.error ? (
                  <p className="ml-4 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {(step.error ?? step.result ?? "").slice(0, 400)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      )}

      {tab === "run" && (
      <div className="rounded-lg border p-2" data-testid="main-control-motion">
        <button
          type="button"
          onClick={() => setMotionOpen((v) => !v)}
          data-testid="main-control-motion-toggle"
          aria-expanded={motionOpen}
          aria-controls={motionPanelId}
          className="flex w-full items-center gap-2 text-left text-xs font-semibold"
        >
          <span>{motionOpen ? "▾" : "▸"}</span>
          {t("mainControl.motionTitle", "管线动态（实况拓扑）")}
        </button>
        {motionOpen && projectPath ? (
          <div id={motionPanelId} role="region" aria-label={t("mainControl.motionTitle", "管线动态（实况拓扑）")} className="mt-2">
            <PipelineMotionView
              projectPath={projectPath}
              traceEntries={(steps.length > 0 ? liveTrace : trace).length > 0 ? (steps.length > 0 ? liveTrace : trace) : undefined}
            />
          </div>
        ) : null}
      </div>
      )}

      {tab === "run" && (
      <div className="rounded-lg border p-2" data-testid="main-control-activities">
        <h3 className="mb-1 text-xs font-semibold">
          {t("mainControl.activitiesTitle", { count: activities.length })}
        </h3>
        {novelConfig.stageJournalEnabled === false ? (
          <p className="text-xs text-muted-foreground" data-testid="main-control-stage-journal-off">
            {t("mainControl.stageJournalOff")}
          </p>
        ) : null}
        {activities.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("mainControl.activitiesEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {activities.map((activity) => (
              <li key={activity.id} className="text-xs" data-testid={`main-control-activity-${activity.kind}`}>
                <span className="mr-1 font-medium">
                  {ACTIVITY_KIND_LABEL_KEYS[activity.kind]
                    ? t(ACTIVITY_KIND_LABEL_KEYS[activity.kind] as string)
                    : activity.kind}
                </span>
                <span className="text-muted-foreground">{activity.title}</span>
                {activity.content ? (
                  <span className="ml-1 text-muted-foreground">
                    {activity.content.length > 240 ? `${activity.content.slice(0, 240)}…` : activity.content}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      )}

      {tab === "run" && (
      <div className="rounded-lg border p-2" data-testid="main-control-trace">
        <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold">
          {t("mainControl.traceTitle", { count: trace.length })}
          {replaySavedAt ? (
            <span className="text-xs font-normal text-muted-foreground" data-testid="main-control-trace-replay">
              {t("mainControl.traceReplay")}
            </span>
          ) : null}
        </h3>
        {trace.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("mainControl.traceEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {trace.map((entry) => {
              const open = expanded.includes(entry.callId)
              return (
                <li
                  key={entry.callId}
                  className="rounded-md border border-border/60 p-1.5"
                  data-testid={`main-control-trace-entry-${entry.name}`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) =>
                        prev.includes(entry.callId)
                          ? prev.filter((id) => id !== entry.callId)
                          : [...prev, entry.callId],
                      )
                    }
                    data-testid={`main-control-trace-toggle-${entry.name}`}
                    className="flex w-full flex-wrap items-center gap-1.5 text-left text-xs"
                  >
                    {entry.status === "error" ? (
                      <CircleAlert className="h-3 w-3 text-destructive" />
                    ) : entry.status === "running" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    )}
                    <span className="font-medium">{entry.title}</span>
                    <code className="text-xs text-muted-foreground">{entry.name}</code>
                    {entry.durationMs !== undefined ? (
                      <span className="text-xs text-muted-foreground">
                        {t("mainControl.traceDuration", { ms: entry.durationMs })}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-primary">
                      {open ? t("mainControl.traceHideRaw") : t("mainControl.traceShowRaw")}
                    </span>
                  </button>
                  <p className="mt-0.5 text-xs text-muted-foreground">{entry.summary}</p>
                  <p className="text-xs text-muted-foreground" data-testid={`main-control-trace-input-${entry.name}`}>
                    {t("mainControl.traceInput", { input: entry.input })}
                  </p>
                  {entry.error ? (
                    <p className="text-xs text-destructive">
                      {t("mainControl.traceFailure", { reason: entry.error })}
                    </p>
                  ) : null}
                  {entry.details.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {entry.details.map((detail, index) => (
                        <li key={`${detail.label}-${index}`} className="text-xs text-muted-foreground">
                          {detail.label}：{detail.value}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {open ? (
                    <pre
                      className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-xs"
                      data-testid={`main-control-trace-raw-${entry.name}`}
                    >
                      {(entry.error ?? entry.result ?? t("mainControl.traceNoResult")).slice(0, 4000)}
                    </pre>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      )}

      {tab === "drafts" && (
      <div className="rounded-lg border p-2" data-testid="main-control-drafts">
        <h3 className="mb-1 text-xs font-semibold">{t("mainControl.draftsTitle")}</h3>
        {!result || result.drafts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("mainControl.draftHint")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {result.drafts.map((draft) => (
              <li key={draft.id} className="flex items-center gap-2 text-xs">
                <span className="text-primary">{draft.chapterName || draft.id}</span>
                {draft.words ? (
                  <span className="text-muted-foreground">
                    {t("mainControl.draftWords", { count: draft.words })}
                  </span>
                ) : null}
                <code className="truncate text-xs text-muted-foreground">{draft.id}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-draft-hint">
          {t("mainControl.draftAcceptHint")}
        </p>
        {/* F1a：采纳不再只是提示——走 adoptMainControlDraft（accept seam = acceptChapterDraft），
            两步确认原样保留：先展开确认面板，第二步才写盘。 */}
        {projectPath ? (
          <MainControlDraftAdoptBlock
            projectPath={projectPath}
            selectedFile={selectedFile}
            onActivityEvent={(event) => setExtraActivities((prev) => [...prev, event])}
          />
        ) : null}
      </div>
      )}

      {tab === "context" && (
        <div className="rounded-lg border p-2" data-testid="main-control-chapter-directory">
        <ChapterDirectory />
      </div>
      )}

      {tab === "context" && (
      <div className="rounded-lg border p-2" data-testid="main-control-foreshadowing">
        <ForeshadowingPanel />
      </div>
      )}

      {tab === "context" && (
      <div className="rounded-lg border p-2" data-testid="main-control-work-heatmap">
        {/* 动态工作热力图：实时看「跑到哪个阶段 / 卡在哪 / 每阶段烧了多少」，真源是 status.json 的 stage_metrics；不再多开一页。 */}
        <WorkHeatmapPanel />
      </div>
      )}

      {tab === "live" && projectPath ? (
        <div className="flex flex-col gap-2">
          {/* F1b：门控重跑（判定唯一真源 buildDecisionGates；未评估落 skipped 不落 pass）。 */}
          <MainControlGateRerunBlock projectPath={projectPath} />
          <div className="rounded-lg border p-2" data-testid="main-control-live">
            <LiveExecutionView projectPath={projectPath} />
          </div>
        </div>
      ) : null}

      {tab === "run" && result?.finalText ? (
      <div className="rounded-lg border p-2" data-testid="main-control-final">
          <h3 className="mb-1 text-xs font-semibold">{t("mainControl.finalTitle")}</h3>
          <WikiReader body={result.finalText} />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("mainControl.roundsUsed", { count: result.roundsUsed })}
          </p>
        </div>
      ) : null}
    </div>
  )
}
