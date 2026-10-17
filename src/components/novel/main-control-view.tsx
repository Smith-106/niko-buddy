import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Flame, Loader2, Play, Square, Sparkles } from "lucide-react"
import { fileExists } from "@/commands/fs"
import {
  buildTraceEntries,
  buildTraceSnapshot,
  loadTraceSnapshot,
  resolveWikiPath,
  runMainControlAgent,
  saveTraceSnapshot,
  type MainControlResult,
  type MainControlStep,
  type TraceEntry,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { cn } from "@/lib/utils"

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
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [goal, setGoal] = useState("")
  const [steps, setSteps] = useState<MainControlStep[]>([])
  const [result, setResult] = useState<MainControlResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const wikiPath = await resolveWikiPath(projectPath, fileExists)
      const out = await runMainControlAgent({
        projectPath,
        wikiPath,
        goal: trimmed,
        llmConfig,
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
      if (out.error) setError(out.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" data-testid="main-control-view">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold">{t("mainControl.title")}</h2>
        <span className="text-xs text-muted-foreground">{t("mainControl.subtitle")}</span>
      </div>

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
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("mainControl.running")}
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
          <p className="flex items-center gap-1 text-[11px] text-destructive" data-testid="main-control-error">
            <CircleAlert className="h-3 w-3" />
            {error}
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border p-2" data-testid="main-control-steps">
        <h3 className="mb-1 text-xs font-semibold">
          {t("mainControl.stepsTitle", { count: steps.length })}
        </h3>
        {steps.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("mainControl.stepsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {steps.map((step) => (
              <li key={step.callId} className="flex flex-col gap-0.5" data-testid={`main-control-step-${step.name}`}>
                <span className="flex items-center gap-1 text-[11px]">
                  {step.status === "running" ? (
                    <Loader2 className="h-3 w-3 animate-spin text-accent" />
                  ) : step.status === "error" ? (
                    <CircleAlert className="h-3 w-3 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3 text-success" />
                  )}
                  <code className="text-[11px]">{step.name}</code>
                  <span className="truncate text-muted-foreground">
                    {Object.keys(step.params).length > 0 ? JSON.stringify(step.params).slice(0, 120) : ""}
                  </span>
                </span>
                {step.result || step.error ? (
                  <p className="ml-4 line-clamp-3 whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {(step.error ?? step.result ?? "").slice(0, 400)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border p-2" data-testid="main-control-trace">
        <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold">
          {t("mainControl.traceTitle", { count: trace.length })}
          {replaySavedAt ? (
            <span className="text-[10px] font-normal text-muted-foreground" data-testid="main-control-trace-replay">
              {t("mainControl.traceReplay")}
            </span>
          ) : null}
        </h3>
        {trace.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("mainControl.traceEmpty")}</p>
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
                    className="flex w-full flex-wrap items-center gap-1.5 text-left text-[11px]"
                  >
                    {entry.status === "error" ? (
                      <CircleAlert className="h-3 w-3 text-destructive" />
                    ) : entry.status === "running" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-accent" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    )}
                    <span className="font-medium">{entry.title}</span>
                    <code className="text-[10px] text-muted-foreground">{entry.name}</code>
                    {entry.durationMs !== undefined ? (
                      <span className="text-[10px] text-muted-foreground">
                        {t("mainControl.traceDuration", { ms: entry.durationMs })}
                      </span>
                    ) : null}
                    <span className="ml-auto text-[10px] text-accent">
                      {open ? t("mainControl.traceHideRaw") : t("mainControl.traceShowRaw")}
                    </span>
                  </button>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.summary}</p>
                  <p className="text-[10px] text-muted-foreground" data-testid={`main-control-trace-input-${entry.name}`}>
                    {t("mainControl.traceInput", { input: entry.input })}
                  </p>
                  {entry.error ? (
                    <p className="text-[10px] text-destructive">
                      {t("mainControl.traceFailure", { reason: entry.error })}
                    </p>
                  ) : null}
                  {entry.details.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {entry.details.map((detail, index) => (
                        <li key={`${detail.label}-${index}`} className="text-[10px] text-muted-foreground">
                          {detail.label}：{detail.value}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {open ? (
                    <pre
                      className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-[10px]"
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

      <div className="rounded-lg border p-2" data-testid="main-control-drafts">
        <h3 className="mb-1 text-xs font-semibold">{t("mainControl.draftsTitle")}</h3>
        {!result || result.drafts.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("mainControl.draftHint")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {result.drafts.map((draft) => (
              <li key={draft.id} className="flex items-center gap-2 text-[11px]">
                <span className="text-accent">{draft.chapterName || draft.id}</span>
                {draft.words ? (
                  <span className="text-muted-foreground">
                    {t("mainControl.draftWords", { count: draft.words })}
                  </span>
                ) : null}
                <code className="truncate text-[10px] text-muted-foreground">{draft.id}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground" data-testid="main-control-draft-hint">
          {t("mainControl.draftAcceptHint")}
        </p>
      </div>

      {result?.finalText ? (
        <div className="rounded-lg border p-2" data-testid="main-control-final">
          <h3 className="mb-1 text-xs font-semibold">{t("mainControl.finalTitle")}</h3>
          <p className="whitespace-pre-wrap text-[11px]">{result.finalText}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("mainControl.roundsUsed", { count: result.roundsUsed })}
          </p>
        </div>
      ) : null}
    </div>
  )
}
