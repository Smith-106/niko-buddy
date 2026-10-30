import { useCallback, useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DirectorPanel, type DirectorPanelProgress } from "@/components/novel/director-panel"
import { EvidenceDashboardSection } from "@/components/novel/evidence-dashboard-section"
import { SubgateAlertsSection } from "@/components/novel/subgate-alerts-section"
import { advanceDirectorAutomatically, buildStageJournalRuntime, collectProjectSnapshot, retryDirector, hasPersistedDirectorState, loadDirectorPersisted, saveDirectorPersisted, saveDirectorIdeaInput, createDirectorPipeline, deriveAndSaveWorldBlueprint, loadStageArtifacts } from "@/lib/novel"
import type { DirectorSnapshot, DirectorIdeaInput, DirectorPersistedFile, DirectorStageArtifacts } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { assessLlmHealth } from "@/lib/llm-health"
import { writeFileAtomic, createDirectory, fileExists } from "@/commands/fs"
import { Play, Rocket, PenLine, Settings as SettingsIcon } from "lucide-react"
import { missingIdeaFields } from "./director-view-helpers"

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
  // B 范围：推进＝生成→出口门→推进，面板要看得见「现在在做什么」与「生成了什么」。
  const [progress, setProgress] = useState<DirectorPanelProgress>({ status: "idle", artifacts: null })
  const [artifacts, setArtifacts] = useState<DirectorStageArtifacts>({})
  // 终止推演：在途推进的 AbortController（仅 advance 接 signal，长 LLM 可真中断）。
  const [advanceCtl, setAdvanceCtl] = useState<AbortController | null>(null)
  // 调度运行记录：本视图真实推进事件（开始/成功/失败/终止/重试/骨架），级别+折叠。
  const [runLog, setRunLog] = useState<Array<{ t: number; level: "info" | "success" | "error"; text: string }>>([])
  const [logOpen, setLogOpen] = useState(false)
  // PAT-U5（ISS-20260712-006 batch-2）：折叠触发点补 aria-controls + region。
  const runlogPanelId = useId()
  const [logLevel, setLogLevel] = useState<"all" | "info" | "success" | "error">("all")
  const appendLog = useCallback((level: "info" | "success" | "error", text: string) => {
    setRunLog((prev) => [...prev.slice(-29), { t: Date.now(), level, text }])
  }, [])
  const filteredLog = runLog.filter((e) => logLevel === "all" || e.level === logLevel)

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

  const refreshArtifacts = useCallback(async () => {
    const stages = await loadStageArtifacts(projectId).catch(() => ({}) as DirectorStageArtifacts)
    setArtifacts(stages)
    return stages
  }, [projectId])

  useEffect(() => {
    if (!persisted) return
    void refreshSnapshot()
    void refreshArtifacts()
  }, [persisted, refreshSnapshot, refreshArtifacts])

  const handleAdvance = useCallback(async () => {
    if (!persisted) return
    // 批次二·9：立意阶段必填项缺失时直接告诉作者缺什么，不去跑管线换回「未检测到项目实体」这类误导报错。
    if (persisted.state.currentPhase === "idea") {
      const missing = missingIdeaFields(persisted.ideaInput, t)
      if (missing.length > 0) {
        const msg = t("directorPanel.ideaMissing", {
          defaultValue: "请先填写：{{fields}}",
          fields: missing.join("、"),
        })
        appendLog("info", msg)
        setGap(msg)
        return
      }
    }
    const ctl = new AbortController()
    setAdvanceCtl(ctl)
    setBusy(true)
    setGap(null)
    setProgress({ status: "generating", artifacts: artifacts, error: null })
    appendLog("info", "开始推进当前阶段")
    try {
      const journal = buildStageJournalRuntime(projectId, true)
      // 门校验阶段先亮出来（生成结束后由 outcome 覆盖）——长任务也要有可见进度。
      const outcome = await advanceDirectorAutomatically(projectId, persisted.state, persisted.ideaInput, {
        llmConfig,
        journal,
        signal: ctl.signal,
      })
      const file = { ...persisted, state: outcome.state }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
      const stages = await refreshArtifacts()
      await refreshSnapshot()
      setProgress({
        status: outcome.advanced ? "advanced" : outcome.error ? "failed" : "gating",
        artifacts: stages,
        error: outcome.error ?? null,
        ...(outcome.drafts ? { drafts: outcome.drafts } : {}),
      })
      if (outcome.advanced) {
        appendLog("success", "推进成功，进入下一阶段")
      } else {
        const reason = outcome.error ?? outcome.blockedReason ?? outcome.gap ?? null
        appendLog(outcome.error ? "error" : "info", outcome.error ? `推进失败：${reason}` : `未过门：${reason ?? "原因未知"}`)
        setGap(reason)
      }
    } catch (e) {
      if (ctl.signal.aborted) {
        appendLog("info", "已终止本次推进")
        setGap(t("directorPanel.terminated", { defaultValue: "已终止本次推进，管线状态保持不变。" }))
        setProgress({ status: "idle", artifacts: artifacts, error: null })
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        appendLog("error", `推进异常：${msg}`)
        setGap(msg)
        setProgress({ status: "failed", artifacts: artifacts, error: msg })
      }
    } finally {
      setAdvanceCtl(null)
      setBusy(false)
    }
  }, [artifacts, llmConfig, persisted, projectId, refreshArtifacts, refreshSnapshot, appendLog, t])

  const handleTerminate = useCallback(() => {
    advanceCtl?.abort()
  }, [advanceCtl])

  const handleRetry = useCallback(async () => {
    if (!persisted) return
    setBusy(true)
    setGap(null)
    appendLog("info", "重试当前阶段")
    try {
      const file = { ...persisted, state: retryDirector(persisted.state) }
      await saveDirectorPersisted(projectId, file)
      setPersisted(file)
      setProgress({ status: "idle", artifacts: artifacts, error: null })
    } finally {
      setBusy(false)
    }
  }, [artifacts, persisted, projectId, appendLog])

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
        appendLog("info", "世界骨架为空：未检测到项目实体")
        setGap(t("directorPanel.blueprintEmpty", { defaultValue: "未检测到项目实体——世界骨架暂为空。请先写作或建立角色/地点/组织等实体后再生成。" }))
      } else {
        appendLog("success", "已根据实体生成世界骨架草稿")
        setGap(t("directorPanel.blueprintDone", { defaultValue: "已根据实体生成世界骨架草稿。" }))
      }
    } finally {
      setBusy(false)
    }
  }, [projectId, refreshSnapshot, t, appendLog])

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
      await writeFileAtomic(chapterPath, content)
      setSelectedFile(chapterPath)
      setActiveView("wiki")
    } finally {
      setBusy(false)
    }
  }, [project, ideaInput.title, setSelectedFile, setActiveView])

  if (!started || !persisted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Rocket className="h-10 w-10 text-primary" />
        <h2 className="text-lg font-semibold">{t("directorPanel.heroTitle")}</h2>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t("directorPanel.heroDesc")}
        </p>
        {/* J05-04/F-010：LLM 不可用时，开书管线 CTA 禁用 + 本地写作分流 */}
        {llmBlocked ? (
          <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4" data-testid="director-llm-blocked">
            <p className="text-sm font-medium text-warning-foreground">
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3" data-testid="director-llm-blocked-banner">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-warning-foreground">●</span>
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
            <p className="text-xs text-warning-foreground" data-testid="director-idea-hint">
              {t("directorPanel.ideaHint")}
            </p>
          ) : null}
        </div>

        <DirectorPanel
          state={persisted.state}
          gap={gap}
          busy={busy}
          progress={{ ...progress, artifacts: progress.artifacts ?? artifacts }}
          onAdvance={() => void handleAdvance()}
          onRetry={() => void handleRetry()}
          onTerminate={advanceCtl ? handleTerminate : undefined}
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
                <span className={ok ? "text-success-foreground" : "text-muted-foreground"}>{ok ? "✓" : "○"}</span>
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

      {/* 调度运行记录：本视图真实推进事件，级别筛选+折叠（默认收起）。 */}
      <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid="director-runlog">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="director-runlog-toggle"
            aria-expanded={logOpen}
            aria-controls={runlogPanelId}
            onClick={() => setLogOpen((v) => !v)}
            className="text-sm font-semibold"
          >
            {logOpen ? "▾" : "▸"} {t("directorPanel.runlogTitle", { defaultValue: "调度运行记录" })}
          </button>
          {logOpen && (
            <div className="ml-auto flex items-center gap-1" role="group" aria-label="级别筛选">
              {(["all", "info", "success", "error"] as const).map((lv) => (
                <button
                  key={lv}
                  type="button"
                  data-testid={`director-runlog-filter-${lv}`}
                  aria-pressed={logLevel === lv}
                  onClick={() => setLogLevel(lv)}
                  className={logLevel === lv ? "rounded border border-primary px-2 py-0.5 text-xs font-medium" : "rounded border px-2 py-0.5 text-xs text-muted-foreground"}
                >
                  {lv === "all" ? "全部" : lv === "info" ? "信息" : lv === "success" ? "成功" : "失败"}
                </button>
              ))}
            </div>
          )}
        </div>
        {logOpen && (<div id={runlogPanelId} role="region" aria-label={t("directorPanel.runlogTitle", { defaultValue: "调度运行记录" })}>
        {filteredLog.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="director-runlog-empty">暂无运行记录</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {filteredLog.map((entry, idx) => (
              <li
                key={`${entry.t}-${idx}`}
                data-testid="director-runlog-item"
                data-level={entry.level}
                className="flex items-center gap-2 text-xs"
              >
                <span className="text-muted-foreground">[{new Date(entry.t).toLocaleTimeString()}]</span>
                <span className={entry.level === "error" ? "text-destructive" : entry.level === "success" ? "text-success-foreground" : "text-foreground"}>{entry.text}</span>
              </li>
            ))}
          </ol>
        )}
        </div>)}
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
