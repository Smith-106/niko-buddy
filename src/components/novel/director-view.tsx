import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DirectorPanel } from "@/components/novel/director-panel"
import {
  tryAdvanceDirector,
  retryDirector,
  type DirectorSnapshot,
} from "@/lib/novel/director-orchestrator"
import {
  hasPersistedDirectorState,
  loadDirectorPersisted,
  saveDirectorPersisted,
  saveDirectorIdeaInput,
  type DirectorIdeaInput,
  type DirectorPersistedFile,
} from "@/lib/novel/director-pipeline-store"
import { createDirectorPipeline } from "@/lib/novel/director-pipeline"
import { useWikiStore } from "@/stores/wiki-store"
import { Play, Rocket } from "lucide-react"

export interface DirectorViewProps {
  projectId: string
}

function gatherSnapshot(
  ideaInput: DirectorIdeaInput,
  marked: { worldComplete: boolean; protagonistNamed: boolean; antagonistNamed: boolean; frameworkChosen: boolean; volumesPlanned: boolean },
): DirectorSnapshot {
  return {
    idea: ideaInput,
    worldComplete: marked.worldComplete,
    protagonistNamed: marked.protagonistNamed,
    antagonistNamed: marked.antagonistNamed,
    frameworkChosen: marked.frameworkChosen,
    volumesPlanned: marked.volumesPlanned,
    firstChapterReady: false,
  }
}

/**
 * 60 号设计：开书导演主视图（C-glm 共识）— 显式启动门（D3）+ ideaInput 落盘（D4）
 * + 阶段手动标记（world/character/outline 门输入）+ 完成横幅跳转审查中心。
 */
export function DirectorView({ projectId }: DirectorViewProps) {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [persisted, setPersisted] = useState<DirectorPersistedFile | null>(null)
  const [started, setStarted] = useState(false)
  const [gap, setGap] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [marks, setMarks] = useState({
    worldComplete: false,
    protagonistNamed: false,
    antagonistNamed: false,
    frameworkChosen: false,
    volumesPlanned: false,
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const has = await hasPersistedDirectorState(projectId)
      if (cancelled) return
      if (has) {
        const file = await loadDirectorPersisted(projectId)
        if (cancelled) return
        setPersisted(file)
      }
      setStarted(has)
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const ideaInput = persisted?.ideaInput ?? { title: "", genre: "", coreConflict: "" }

  const updateIdea = (patch: Partial<DirectorIdeaInput>) => {
    if (!persisted) return
    const next = { ...persisted.ideaInput, ...patch }
    const file = { ...persisted, ideaInput: next }
    setPersisted(file)
    void saveDirectorIdeaInput(projectId, next).catch(() => {})
    setGap(null)
  }

  const handleStart = useCallback(async () => {
    setBusy(true)
    try {
      const file: DirectorPersistedFile = {
        fileVersion: 1,
        state: createDirectorPipeline(),
        ideaInput: { title: "", genre: "", coreConflict: "" },
      }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
      setStarted(true)
      setGap(null)
    } finally {
      setBusy(false)
    }
  }, [projectId])

  const handleAdvance = useCallback(async () => {
    if (!persisted) return
    setBusy(true)
    setGap(null)
    try {
      const snapshot = gatherSnapshot(persisted.ideaInput, marks)
      const outcome = tryAdvanceDirector(persisted.state, snapshot)
      const file = { ...persisted, state: outcome.state }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
      if (!outcome.advanced) {
        setGap(outcome.gap ?? outcome.blockedReason ?? null)
      }
    } finally {
      setBusy(false)
    }
  }, [persisted, marks, projectId])

  const handleRetry = useCallback(async () => {
    if (!persisted) return
    setBusy(true)
    setGap(null)
    try {
      const file = { ...persisted, state: retryDirector(persisted.state) }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
    } finally {
      setBusy(false)
    }
  }, [persisted, projectId])

  const mark = (key: keyof typeof marks) => {
    setMarks((m) => ({ ...m, [key]: !m[key] }))
    setGap(null)
  }

  if (!started || !persisted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Rocket className="h-10 w-10 text-accent" />
        <h2 className="text-lg font-semibold">{t("directorPanel.heroTitle")}</h2>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t("directorPanel.heroDesc")}
        </p>
        <Button onClick={() => void handleStart()} disabled={busy} data-testid="director-start">
          <Play className="mr-1 h-4 w-4" />
          {t("directorPanel.start")}
        </Button>
      </div>
    )
  }

  const ideaComplete =
    ideaInput.title.trim() !== "" && ideaInput.genre.trim() !== "" && ideaInput.coreConflict.trim() !== ""

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 className="text-sm font-semibold">{t("directorPanel.ideaTitle")}</h3>
          <label className="text-xs text-muted-foreground">{t("directorPanel.ideaTitleField")}</label>
          <Input
            value={ideaInput.title}
            onChange={(e) => updateIdea({ title: e.target.value })}
            data-testid="director-idea-title"
            placeholder={t("directorPanel.ideaTitlePlaceholder")}
          />
          <label className="text-xs text-muted-foreground">{t("directorPanel.ideaGenreField")}</label>
          <Input
            value={ideaInput.genre}
            onChange={(e) => updateIdea({ genre: e.target.value })}
            data-testid="director-idea-genre"
            placeholder={t("directorPanel.ideaGenrePlaceholder")}
          />
          <label className="text-xs text-muted-foreground">{t("directorPanel.ideaConflictField")}</label>
          <Textarea
            value={ideaInput.coreConflict}
            onChange={(e) => updateIdea({ coreConflict: e.target.value })}
            data-testid="director-idea-conflict"
            placeholder={t("directorPanel.ideaConflictPlaceholder")}
            rows={3}
          />
          {!ideaComplete ? (
            <p className="text-xs text-warning" data-testid="director-idea-hint">
              {t("directorPanel.ideaHint")}
            </p>
          ) : null}
        </div>

        <DirectorPanel
          state={persisted.state}
          gap={gap}
          busy={busy}
          onAdvance={() => void handleAdvance()}
          onRetry={() => void handleRetry()}
        />

        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 className="text-sm font-semibold">{t("directorPanel.marksTitle")}</h3>
          {(
            [
              ["worldComplete", "directorPanel.markWorld"],
              ["protagonistNamed", "directorPanel.markProtagonist"],
              ["antagonistNamed", "directorPanel.markAntagonist"],
              ["frameworkChosen", "directorPanel.markFramework"],
              ["volumesPlanned", "directorPanel.markVolumes"],
            ] as const
          ).map(([key, labelKey]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={marks[key]}
                onChange={() => mark(key)}
                data-testid={`director-mark-${key}`}
              />
              {t(labelKey)}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <span className="text-xs text-muted-foreground">{t("directorPanel.nextStep")}</span>
        <Button
          size="sm"
          variant="outline"
          data-testid="director-goto-review"
          onClick={() => setActiveView("reviewCenter")}
        >
          {t("directorPanel.gotoReview")}
        </Button>
      </div>
    </div>
  )
}
