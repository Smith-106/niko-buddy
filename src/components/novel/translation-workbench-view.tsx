import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Languages, Play, Plus, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"
import {
  createEmptyTranslationGlossary,
  createEmptyTranslationProgress,
  loadTranslationGlossary,
  runTranslationProject,
  saveTranslationDraft,
  saveTranslationGlossary,
  translationProgressSummary,
  upsertGlossaryEntry,
  type TranslationLlmPort,
  type TranslationProgress,
} from "@/lib/novel/translation-workbench"
import { createBudgetRun, advanceBudgetBatch } from "@/lib/novel/budget-resume"
import { saveGenerationHistoryEntry } from "@/lib/novel/generation-history"
import { normalizePath } from "@/lib/path-utils"

/**
 * TranslationWorkbenchView — 翻译工作台（65 号共识 G2 挂载：形态轴 F4 消费侧）。
 *
 * 边界：LLM 经 `TranslationLlmPort` props 注入（生产适配器由调用方组装，
 * 本组件零 import llm-client）；Draft-first——译文只落 `.novel/translation-drafts/`
 * pending 区；M4 生产接线——「连写 N 章」预扣 `advanceBudgetBatch` 驱动预算机；
 * M3 生产接线——完成后记 `snapshot-translation` run。
 */
export interface TranslationWorkbenchViewProps {
  port?: TranslationLlmPort
  chapterNumbers?: number[]
}

export function TranslationWorkbenchView({ port, chapterNumbers = [1, 2, 3, 4, 5] }: TranslationWorkbenchViewProps) {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [source, setSource] = useState("")
  const [target, setTarget] = useState("")
  const [entries, setEntries] = useState(() => createEmptyTranslationGlossary())
  const [progress, setProgress] = useState<TranslationProgress | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // 加载既有术语表（缺失时空表优雅降级）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!projectPath) return
      const stored = await loadTranslationGlossary(projectPath)
      if (!cancelled) setEntries(stored)
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const addEntry = useCallback(async () => {
    if (!source.trim() || !target.trim()) {
      setNotice(t("novel.translation.emptyEntry") ?? "术语原文与译文不能为空")
      return
    }
    const next = upsertGlossaryEntry(entries, {
      kind: "term",
      source: source.trim(),
      target: target.trim(),
      note: "",
    })
    setEntries(next)
    if (projectPath) {
      await saveTranslationGlossary(projectPath, next)
      setNotice(t("novel.translation.glossarySaved") ?? "术语表已保存")
    }
    setSource("")
    setTarget("")
  }, [source, target, entries, projectPath, t])

  const run = useCallback(
    async (count: number) => {
      if (!projectPath || !port) return
      setRunning(true)
      setNotice(null)
      try {
        // M4 生产接线：advanceBudgetBatch 预扣 N 章预算（stoppedBy 三态：budget/exhausted/suspended）
        const tasks = chapterNumbers.map((c) => ({ taskId: `translate-${c}`, cost: 1 }))
        const budget = createBudgetRun("translation-run", tasks, count * 10)
        const batch = advanceBudgetBatch(budget, count)
        if (batch.stoppedBy !== "exhausted" && batch.state.completedTaskIds.length === 0) {
          setNotice(t("novel.translation.budgetBlocked") ?? `预算预扣被拦截（${batch.stoppedBy}）`)
          return
        }
        const project = {
          version: 1 as const,
          sourceLang: "zh",
          targetLang: "en",
          chapterNumbers,
          glossary: entries,
          progress: progress ?? createEmptyTranslationProgress(),
          budgetRunId: budget.runId,
        }
        const result = await runTranslationProject(
          port,
          project,
          async (chapter) => `第 ${chapter} 章原文（示例加载器；生产由调用方注入 loadSource）`,
          batch.state,
        )
        // Draft-first：译文仅落 .novel/translation-drafts/
        for (const artifact of result.artifacts) {
          await saveTranslationDraft(projectPath, artifact)
        }
        setProgress(result.project.progress)
        // M3 生产接线：snapshot-translation run
        await saveGenerationHistoryEntry(normalizePath(projectPath), {
          kind: "snapshot-translation",
          title: "translation-workbench-run",
          results: [],
          snapshotMeta: {
            shape: "translation",
            artifactRef: ".novel/translation-drafts",
            summary: `${result.artifacts.length} drafts, stopped=${result.stopped}`,
          },
        })
        // 术语一致性核查由 runTranslationProject 逐段机械判定（artifacts[].violations）
        const violations = result.artifacts.flatMap((a) => a.violations)
        setNotice(
          violations.length > 0
            ? t("novel.translation.glossaryWarn") ?? `术语一致性警告 ${violations.length} 条`
            : t("novel.translation.done") ??
                `完成 ${result.artifacts.length} 段（stopped=${result.stopped}，预算剩余 ${result.budget.remainingBudget}）`,
        )
      } catch (err) {
        setNotice(`${t("novel.translation.failed") ?? "翻译运行失败"}：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setRunning(false)
      }
    },
    [projectPath, port, chapterNumbers, entries, progress, t],
  )

  const summary = useMemo(() => {
    if (!progress) return null
    const counts = translationProgressSummary(progress)
    return { ...counts, total: counts.pending + counts.drafted + counts.reviewed + counts.finalized }
  }, [progress])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 translation-workbench-view" data-testid="translation-workbench-view">
      <div className="flex items-center gap-2 text-sm font-semibold">
          <Languages className="h-4 w-4" />
          {t("novel.translation.title")}
      </div>
      <div className="space-y-4 pt-2">
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        {!port && <p className="text-xs text-amber-500">{t("novel.translation.noPort") ?? "未注入翻译端口——接入 LLM 适配器后可用"}</p>}
        {summary && (
          <p className="text-xs text-muted-foreground">
            {summary.drafted}/{summary.total} drafted · {summary.reviewed} reviewed · {summary.finalized} finalized
          </p>
        )}
        <div className="flex gap-2">
          <Input
            placeholder={t("novel.translation.sourcePh") ?? "术语原文"}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="max-w-[160px]"
          />
          <Input
            placeholder={t("novel.translation.targetPh") ?? "术语译文"}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="max-w-[160px]"
          />
          <Button size="sm" variant="outline" onClick={addEntry}>
            <Plus className="mr-1 h-3 w-3" />
            {t("novel.translation.addEntry")}
          </Button>
          {projectPath && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await saveTranslationGlossary(projectPath, entries)
                setNotice(t("novel.translation.glossarySaved") ?? "术语表已保存")
              }}
            >
              <Save className="mr-1 h-3 w-3" />
              {t("novel.translation.saveGlossary")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {[1, 3, 5].map((n) => (
            <Button key={n} size="sm" onClick={() => run(n)} disabled={running || !port || !projectPath}>
              <Play className="mr-1 h-3 w-3" />
              {t("novel.translation.runCount", { count: n })}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

