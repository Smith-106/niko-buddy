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
import { assessLlmHealth } from "@/lib/llm-health"
import { writeFile, createDirectory, fileExists } from "@/commands/fs"
import { Play, Rocket, PenLine, Settings as SettingsIcon } from "lucide-react"

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
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  // J05-02/F-010：Director 接入六态模型健康，LLM 不可用时 CTA 禁用+本地写作分流
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const project = useWikiStore((s) => s.project)
  const llmHealth = assessLlmHealth(llmConfig)
  const llmBlocked = !llmHealth.canWrite
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
  // J05-03：点击必须有反馈——骨架为空时明确告知原因，禁止静默零反应。
  const handleGenerateBlueprint = useCallback(async () => {
    setBusy(true)
    setGap(null)
    try {
      const bp = await deriveAndSaveWorldBlueprint(projectId)
      await refreshSnapshot()
      const total = Object.values(bp.layers).reduce((n, arr) => n + (arr?.length ?? 0), 0)
      if (total === 0) {
        setGap(t("directorPanel.blueprintEmpty", { defaultValue: "未检测到项目实体——世界骨架暂为空。请先写作或建立角色/地点/组织等实体后再生成。" }))
      } else {
        setGap(t("directorPanel.blueprintDone", { defaultValue: "已根据实体生成世界骨架草稿。" }))
      }
    } finally {
      setBusy(false)
    }
  }, [projectId, refreshSnapshot, t])

  // J05-04/F-010：跳过 LLM 的本地写作路径——建空白第一章 → 写作工作区编辑器。
  // 兑现建项流程「跳过=仅本地编辑可用」的承诺。不依赖任何 LLM/Provider。
  const handleLocalWrite = useCallback(async () => {
    if (!project) return
    setBusy(true)
    try {
      const pp = project.path.replace(/\\/g, "/").replace(/\/+$/, "")
      // 项目知识根是 QM/（LEGACY=wiki）；章节物理落 QM/chapters/ 才与 fileTree/编辑器对齐
      const chaptersDir = `${pp}/QM/chapters`
      await createDirectory(chaptersDir)
      // 若已有章节则追加下一章号，不覆盖已有正文
      let num = 1
      let chapterPath = `${chaptersDir}/chapter-001.md`
      while ((await fileExists(chapterPath)) && num < 999) {
        num += 1
        chapterPath = `${chaptersDir}/chapter-${String(num).padStart(3, "0")}.md`
      }
      const title = ideaInput.title.trim() || `第${num}章`
      // frontmatter 标记章节 + 标题占位——Draft-first 本地正文，不走 LLM
      const content = `---\nkind: chapter\nchapter: ${num}\ntitle: ${title}\nstatus: draft\n---\n\n# ${title}\n\n`
      await writeFile(chapterPath, content)
      setSelectedFile(chapterPath)
      setActiveView("wiki")
    } finally {
      setBusy(false)
    }
  }, [project, ideaInput.title, setSelectedFile, setActiveView])

  if (!started || !persisted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Rocket className="h-10 w-10 text-accent" />
        <h2 className="text-lg font-semibold">{t("directorPanel.heroTitle")}</h2>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t("directorPanel.heroDesc")}
        </p>
        {/* J05-04/F-010：LLM 不可用时，开书管线 CTA 禁用 + 本地写作分流 */}
        {llmBlocked ? (
          <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" data-testid="director-llm-blocked">
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
              {llmHealth.label}
            </p>
            <p className="text-center text-xs text-muted-foreground">
              {t("directorPanel.llmBlockedHint", { defaultValue: "AI 开书管线需要模型服务。你仍然可以跳过 AI、直接创建第一章手工写作。" })}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="default"
                data-testid="director-local-write"
                disabled={busy}
                onClick={() => void handleLocalWrite()}
              >
                <PenLine className="mr-1 h-4 w-4" />
                {t("directorPanel.localWrite", { defaultValue: "继续本地写作" })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="director-configure-llm"
                onClick={() => setActiveView("settings")}
              >
                <SettingsIcon className="mr-1 h-4 w-4" />
                {t("directorPanel.configureLlm", { defaultValue: "立即配置模型" })}
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => void handleStart()} disabled={busy} data-testid="director-start">
            <Play className="mr-1 h-4 w-4" />
            {t("directorPanel.start")}
          </Button>
        )}
      </div>
    )
  }

  const ideaComplete =
    ideaInput.title.trim() !== "" && ideaInput.genre.trim() !== "" && ideaInput.coreConflict.trim() !== ""

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {/* J05-04/F-010：LLM 不可用时顶部横幅——承诺兑现：本地写作可继续，AI 管线受限 */}
      {llmBlocked && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="director-llm-blocked-banner">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-amber-600 dark:text-amber-400">●</span>
            <span className="font-medium">{llmHealth.label}</span>
            <span className="text-xs text-muted-foreground">
              {t("directorPanel.llmBlockedBanner", { defaultValue: "AI 开书与章节生成受限，本地写作仍可用" })}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              data-testid="director-local-write-banner"
              disabled={busy}
              onClick={() => void handleLocalWrite()}
            >
              <PenLine className="mr-1 h-3.5 w-3.5" />
              {t("directorPanel.localWrite", { defaultValue: "继续本地写作" })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="director-configure-llm-banner"
              onClick={() => setActiveView("settings")}
            >
              <SettingsIcon className="mr-1 h-3.5 w-3.5" />
              {t("directorPanel.configureLlm", { defaultValue: "立即配置模型" })}
            </Button>
          </div>
        </div>
      )}
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
