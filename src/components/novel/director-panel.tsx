import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { DIRECTOR_PHASES, summarizeStageArtifacts } from "@/lib/novel"
import type { DirectorPhase, DirectorPipelineState, DirectorDraftReceipt, DirectorStageArtifacts } from "@/lib/novel"
import { cn } from "@/lib/utils"
import { CircleCheck, Circle, Loader2, RotateCcw, CircleX, Play, PartyPopper } from "lucide-react"

const PHASE_LABEL_KEYS: Record<DirectorPhase, string> = {
  idea: "directorPanel.phaseIdea",
  world: "directorPanel.phaseWorld",
  character: "directorPanel.phaseCharacter",
  outline: "directorPanel.phaseOutline",
  chapters: "directorPanel.phaseChapters",
}

/** 当前阶段的生成/校验进度（B 范围：推进＝生成→出口门→推进）。 */
export type DirectorPhaseProgressStatus = "idle" | "generating" | "gating" | "advanced" | "failed"

export interface DirectorPanelProgress {
  status: DirectorPhaseProgressStatus
  /** 生成/校验失败的原始原因（成功推进后清空）。 */
  error?: string | null
  /** 本次生成的阶段产物（按阶段展示摘要）。 */
  artifacts?: DirectorStageArtifacts | null
  /** 首章草稿回执（chapters 阶段）。 */
  drafts?: DirectorDraftReceipt[] | null
}

const PROGRESS_LABEL_KEYS: Record<DirectorPhaseProgressStatus, string> = {
  idle: "directorPanel.statusIdle",
  generating: "directorPanel.statusGenerating",
  gating: "directorPanel.statusGating",
  advanced: "directorPanel.statusAdvanced",
  failed: "directorPanel.statusFailed",
}

interface DirectorPanelProps {
  state: DirectorPipelineState
  /** 未过门时的缺口提示（advance 返回的 gap）。 */
  gap?: string | null
  busy?: boolean
  /** 当前阶段的生成/校验进度与产物摘要（缺省只显示状态与缺口提示）。 */
  progress?: DirectorPanelProgress
  onAdvance: () => void
  onRetry: () => void
  /** 在途推进存在时传入 → 面板渲染终止按钮（真中断 advance 的 AbortSignal）。 */
  onTerminate?: () => void
}

/**
 * 60 号设计：开书导演面板 — 可视化 director-pipeline 5 阶段推进。
 * 对齐 ANWA director 的进度展示（projections/ 收缩态）：每阶段状态
 * （pending/running/done/failed）+ 推进/重试操作 + 缺口提示。
 */
export function DirectorPanel({ state, gap, busy = false, progress, onAdvance, onRetry, onTerminate }: DirectorPanelProps) {
  const { t } = useTranslation()
  const currentFailed = state.statuses[state.currentPhase] === "failed"
  const allDone = DIRECTOR_PHASES.every((p) => state.statuses[p] === "done")
  const progressStatus: DirectorPhaseProgressStatus = progress?.status ?? "idle"
  const summaries = summarizeStageArtifacts(progress?.artifacts)

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" data-testid="director-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("directorPanel.title")}</h3>
        <span className="text-xs text-muted-foreground">{t("directorPanel.subtitle")}</span>
      </div>

      <ol className="flex flex-col gap-2" data-testid="director-phases">
        {DIRECTOR_PHASES.map((phase) => {
          const status = state.statuses[phase]
          const isCurrent = phase === state.currentPhase
          return (
            <li
              key={phase}
              data-testid={`director-phase-${phase}`}
              data-status={status}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                isCurrent && "bg-muted",
              )}
            >
              {status === "done" ? (
                <CircleCheck className="h-4 w-4 text-success" data-testid={`phase-icon-${phase}`} />
              ) : status === "failed" ? (
                <CircleX className="h-4 w-4 text-destructive" data-testid={`phase-icon-${phase}`} />
              ) : status === "running" ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-primary"
                  data-testid={`phase-icon-${phase}`}
                />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground" data-testid={`phase-icon-${phase}`} />
              )}
              <span>{t(PHASE_LABEL_KEYS[phase])}</span>
              {state.retryCount[phase] ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("directorPanel.retryCount", { count: state.retryCount[phase] })}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      {(
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
            progressStatus === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
          )}
          data-testid="director-phase-status"
          data-status={progressStatus}
        >
          {progressStatus === "generating" || progressStatus === "gating" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" data-testid="director-phase-status-icon" />
          ) : null}
          <span>{busy ? t("directorPanel.statusGenerating", { phase: t(PHASE_LABEL_KEYS[state.currentPhase]) }) : t(PROGRESS_LABEL_KEYS[progressStatus], { phase: t(PHASE_LABEL_KEYS[state.currentPhase]) })}</span>
        </div>
      )}

      {progress?.error ? (
        <p className="text-xs text-destructive" data-testid="director-last-error">
          {t("directorPanel.lastError", { error: progress.error })}
        </p>
      ) : null}

      <div className="flex flex-col gap-1" data-testid="director-artifacts">
        <span className="text-xs font-medium text-muted-foreground">{t("directorPanel.artifactsTitle")}</span>
        {summaries.length === 0 ? (
          <span className="text-xs text-muted-foreground" data-testid="director-artifacts-empty">
            {t("directorPanel.artifactsEmpty")}
          </span>
        ) : (
          summaries.map((summary) => (
            <span
              key={summary.stage}
              className="text-xs text-muted-foreground"
              data-testid={`director-artifact-${summary.stage}`}
            >
              {t(summary.key, summary.params)}
            </span>
          ))
        )}
        {(progress?.drafts ?? []).map((draft) => (
          <span key={draft.id} className="text-xs text-primary" data-testid="director-draft-receipt">
            {t("directorPanel.draftReceipt", { id: draft.id, chars: draft.chars })}
          </span>
        ))}
      </div>

      {gap ? (
        <p className="text-xs text-warning-foreground" data-testid="director-gap">
          {gap}
        </p>
      ) : null}

      {allDone ? (
        <div
          className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm"
          data-testid="director-completed"
        >
          <PartyPopper className="h-4 w-4 text-success" />
          <span>{t("directorPanel.completed")}</span>
        </div>
      ) : (
        <div className="flex gap-2">
          {currentFailed ? (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy} data-testid="director-retry">
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              {t("directorPanel.retry")}
            </Button>
          ) : null}
          <Button size="sm" onClick={onAdvance} disabled={busy} data-testid="director-advance">
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1 h-3.5 w-3.5" />
            )}
            {busy ? t("directorPanel.advancing", { defaultValue: "推进中…" }) : t("directorPanel.advance")}
          </Button>
          {onTerminate ? (
            <Button size="sm" variant="destructive" onClick={onTerminate} data-testid="director-terminate">
              <CircleX className="mr-1 h-3.5 w-3.5" />
              {t("directorPanel.terminate", { defaultValue: "终止推演" })}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
