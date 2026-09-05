import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { hasPersistedDirectorState, loadDirectorPersisted } from "@/lib/novel/director-pipeline-store"
import { DIRECTOR_PHASES } from "@/lib/novel/director-pipeline"
import { useWikiStore } from "@/stores/wiki-store"
import { Clapperboard } from "lucide-react"

const PHASE_LABEL_KEYS: Record<string, string> = {
  idea: "directorPanel.phaseIdea",
  world: "directorPanel.phaseWorld",
  character: "directorPanel.phaseCharacter",
  outline: "directorPanel.phaseOutline",
  chapters: "directorPanel.phaseChapters",
}

/** 60 号设计：开书导演侧栏紧凑只读摘要（C-glm 共识）。 */
export function DirectorSidebarPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [statuses, setStatuses] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!project?.path) return
      const has = await hasPersistedDirectorState(project.path)
      if (cancelled) return
      if (has) {
        const file = await loadDirectorPersisted(project.path)
        if (cancelled) return
        setStatuses(file.state.statuses)
      } else {
        setStatuses(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project?.path])

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="director-sidebar">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Clapperboard className="h-4 w-4" />
        {t("directorPanel.title")}
      </div>
      {statuses ? (
        <ol className="flex flex-col gap-1.5">
          {DIRECTOR_PHASES.map((phase) => (
            <li key={phase} className="flex items-center gap-2 text-xs" data-testid={`director-sidebar-${phase}`}>
              <span
                className={
                  statuses[phase] === "done"
                    ? "text-success"
                    : statuses[phase] === "failed"
                      ? "text-destructive"
                      : statuses[phase] === "running"
                        ? "text-accent"
                        : "text-muted-foreground"
                }
              >
                {statuses[phase] === "done" ? "●" : statuses[phase] === "failed" ? "✗" : statuses[phase] === "running" ? "◐" : "○"}
              </span>
              {t(PHASE_LABEL_KEYS[phase])}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="director-sidebar-empty">
          {t("directorPanel.heroDesc")}
        </p>
      )}
    </div>
  )
}
