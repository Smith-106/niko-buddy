import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Flame, Loader2, Play, Square, Sparkles } from "lucide-react"
import { fileExists } from "@/commands/fs"
import { WikiReader } from "@/components/editor/wiki-reader"
import {
  buildTraceEntries,
  buildTraceSnapshot,
  createMainControlQualityDeps,
  loadTraceSnapshot,
  resolveDeepChapterRunner,
  resolveWikiPath,
  runMainControlAgent,
  saveTraceSnapshot,
  type MainControlResult,
  type MainControlStep,
  type TraceEntry,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { DEFAULT_AI_WORKFLOW_MODE } from "@/lib/agent/workflow-mode"
import { cn, toErrorMessage } from "@/lib/utils"
import { ChapterDirectory } from "./chapter-directory"
import { ForeshadowingPanel } from "./foreshadowing-panel"
import { WorkHeatmapPanel } from "./work-heatmap-panel"

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
  // 工作流模式目前没有全局设置项，深章工具注册用默认档（与 resolveAiWorkflowMode 一致）。
  const aiWorkflowMode = DEFAULT_AI_WORKFLOW_MODE
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [goal, setGoal] = useState("")
  const [steps, setSteps] = useState<MainControlStep[]>([])
  const [result, setResult] = useState<MainControlResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelledAt, setCancelledAt] = useState<number | null>(null)
  // 页内分层（IA：跑流程 / 收草稿 / 本章上下文分开，不再上下堆一屏；只切换展示，不碰执行语义）。
  const [tab, setTab] = useState<"run" | "drafts" | "context">("run")
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
  const abortRef = useRef<AbortController | null>(null)

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
    if (!trimmed || running) return
    if (!projectPath) {
      setError(t("mainControl.noProject"))
      return
    }
    setError(null)
    setResult(null)
    setSteps([])
    setCancelledAt(null)
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
      const out = await runMainControlAgent({
        projectPath,
        wikiPath,
        goal: trimmed,
        llmConfig,
        quality,
        runDeepChapterGeneration,
        aiWorkflowMode,
        signal: controller.signal,
        onStep: (step) => setSteps((prev) => upsertStep(prev, step)),
      })
      setSteps(out.steps)
      setResult(out)
      setTrace(buildTraceEntries(out.steps))
      setReplaySavedAt(null)
      const snapshot = buildTraceSnapshot({
        goal: trimmed,
        ok: out.ok,
        stopReason: out.error,
        roundsUsed: out.roundsUsed,
        finalText: out.finalText,
        steps: out.steps,
        now: Date.now(),
      })
      void saveTraceSnapshot(projectPath, snapshot)
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
    setRunning(false)
    setCancelledAt(Date.now())
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
        <Sparkles className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold">{t("mainControl.title")}</h2>
        <span className="text-xs text-muted-foreground">{t("mainControl.subtitle")}</span>
      </div>

      <div className="flex items-center gap-1" role="tablist" aria-label={t("mainControl.tabsLabel")} data-testid="main-control-tabs">
        {(
          [
            { key: "run", labelKey: "mainControl.tabRun" },
            { key: "drafts", labelKey: "mainControl.tabDrafts" },
            { key: "context", labelKey: "mainControl.tabContext" },
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
              tab === item.key ? "text-accent" : "text-muted-foreground",
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
          {running ? (
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
                goal.trim() ? "text-accent" : "text-muted-foreground",
              )}
            >
              <Play className="h-3 w-3" />
              {t("mainControl.run")}
            </button>
          )}
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
          <p className="flex items-center gap-1 text-xs text-warning" data-testid="main-control-cancelled">
            <Square className="h-3 w-3" />
            {t("mainControl.cancelled", {
              time: new Date(cancelledAt).toLocaleTimeString("zh-CN", { hour12: false }),
            })}
          </p>
        ) : null}
        {stuckStep ? (
          <p className="flex items-center gap-1 text-xs text-warning" data-testid="main-control-stuck">
            <CircleAlert className="h-3 w-3" />
            {stuckTimeout
              ? t("mainControl.timeoutHint", { step: stuckStep.name })
              : t("mainControl.stuckHint", { step: stuckStep.name, secs: stuckSecs })}
          </p>
        ) : null}
      </div>
      )}

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
                    <Loader2 className="h-3 w-3 animate-spin text-accent" />
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
                      <Loader2 className="h-3 w-3 animate-spin text-accent" />
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
                    <span className="ml-auto text-xs text-accent">
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
                <span className="text-accent">{draft.chapterName || draft.id}</span>
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
