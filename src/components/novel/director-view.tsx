import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DirectorPanel } from "@/components/novel/director-panel"
import { EvidenceDashboardSection } from "@/components/novel/evidence-dashboard-section"
import { SubgateAlertsSection } from "@/components/novel/subgate-alerts-section"
import { tryAdvanceDirectorFromProject, collectProjectSnapshot, retryDirector, hasPersistedDirectorState, loadDirectorPersisted, saveDirectorPersisted, saveDirectorIdeaInput, createDirectorPipeline, deriveAndSaveWorldBlueprint } from "@/lib/novel"
import type { DirectorSnapshot, DirectorIdeaInput, DirectorPersistedFile } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { Play, Rocket } from "lucide-react"

export interface DirectorViewProps {
  projectId: string
}

/**
 * 60 号设计：开书导演主视图（C-glm 共识）— 显式启动门（D3）+ ideaInput 落盘（D4）。
 * MIG-001：阶段门输入改为从项目真实产物自动采集（world-blueprint store /
 * entities characters / wiki-outlines / snapshots），不再依赖手动 checkbox。
 */
export function DirectorView({ projectId }: DirectorViewProps) {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [persisted, setPersisted] = useState<DirectorPersistedFile | null>(null)
  const [started, setStarted] = useState(false)
  const [gap, setGap] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null)

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

  const refreshSnapshot = useCallback(async () => {
    if (!persisted) return
    const snap = await collectProjectSnapshot(projectId, persisted.ideaInput)
    setSnapshot(snap)
  }, [persisted, projectId])

  useEffect(() => {
    if (!persisted) return
    void refreshSnapshot()
  }, [persisted, refreshSnapshot])

  const handleAdvance = useCallback(async () => {
    if (!persisted) return
    setBusy(true)
    setGap(null)
    try {
      const outcome = await tryAdvanceDirectorFromProject(projectId, persisted.state, persisted.ideaInput)
      const file = { ...persisted, state: outcome.state }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
      if (!outcome.advanced) {
        setGap(outcome.gap ?? outcome.blockedReason ?? null)
      }
    } finally {
      setBusy(false)
    }
  }, [persisted, projectId])

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

  // MIG-002：世界骨架生成 — 从项目实体推导骨架落盘 .novel/world-blueprint.json，
  // 让 worldComplete 能真正判真（不再靠手动 checkbox / 死数据）。
  const handleGenerateBlueprint = useCallback(async () => {
    setBusy(true)
    try {
      await deriveAndSaveWorldBlueprint(projectId)
      await refreshSnapshot()
    } finally {
      setBusy(false)
    }
  }, [projectId, refreshSnapshot])

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
          <p className="text-xs text-muted-foreground">{t("directorPanel.autoCollectHint")}</p>
          {(
            [
              ["worldComplete", "directorPanel.markWorld"],
              ["protagonistNamed", "directorPanel.markProtagonist"],
              ["antagonistNamed", "directorPanel.markAntagonist"],
              ["frameworkChosen", "directorPanel.markFramework"],
              ["volumesPlanned", "directorPanel.markVolumes"],
            ] as const
          ).map(([key, labelKey]) => {
            const ok = snapshot ? Boolean(snapshot[key]) : false
            return (
              <div key={key} className="flex items-center gap-2 text-sm" data-testid={`director-auto-${key}`}>
                <span className={ok ? "text-success" : "text-muted-foreground"}>{ok ? "✓" : "○"}</span>
                {t(labelKey)}
              </div>
            )
          })}
          <Button
            size="sm"
            variant="outline"
            data-testid="director-generate-blueprint"
            disabled={busy}
            onClick={() => void handleGenerateBlueprint()}
          >
            {t("directorPanel.generateBlueprint")}
          </Button>
        </div>
      </div>

      <EvidenceDashboardSection projectId={projectId} />
      <SubgateAlertsSection projectId={projectId} />

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
