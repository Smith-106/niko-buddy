import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DIRECTOR_PHASES,
  type DirectorPhase,
  type DirectorPipelineState,
} from "@/lib/novel/director-pipeline"
import { cn } from "@/lib/utils"
import { CircleCheck, Circle, Loader2, RotateCcw, CircleX, Play, PartyPopper } from "lucide-react"

const PHASE_LABEL_KEYS: Record<DirectorPhase, string> = {
  idea: "directorPanel.phaseIdea",
  world: "directorPanel.phaseWorld",
  character: "directorPanel.phaseCharacter",
  outline: "directorPanel.phaseOutline",
  chapters: "directorPanel.phaseChapters",
}

interface DirectorPanelProps {
  state: DirectorPipelineState
  /** 未过门时的缺口提示（advance 返回的 gap）。 */
  gap?: string | null
  busy?: boolean
  onAdvance: () => void
  onRetry: () => void
}

/**
 * 60 号设计：开书导演面板 — 可视化 director-pipeline 5 阶段推进。
 * 对齐 ANWA director 的进度展示（projections/ 收缩态）：每阶段状态
 * （pending/running/done/failed）+ 推进/重试操作 + 缺口提示。
 */
export function DirectorPanel({ state, gap, busy = false, onAdvance, onRetry }: DirectorPanelProps) {
  const { t } = useTranslation()
  const currentFailed = state.statuses[state.currentPhase] === "failed"
  const allDone = DIRECTOR_PHASES.every((p) => state.statuses[p] === "done")

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
                  className="h-4 w-4 animate-spin text-accent"
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

      {gap ? (
        <p className="text-xs text-warning" data-testid="director-gap">
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
            {t("directorPanel.advance")}
          </Button>
        </div>
      )}
    </div>
  )
}
