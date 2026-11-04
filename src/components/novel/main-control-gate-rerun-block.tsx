import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import {
  listChapterDrafts,
  rerunMainControlGates,
  type ChapterDraft,
  type DeepChapterDecisionGateKey,
  type MainControlGateRow,
  type RerunMainControlGatesResult,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * 主控 live 页签的「重跑门控」区块（F1b）。
 *
 * 判定唯一真源是 `buildDecisionGates`，编排唯一入口是 `evaluateChapterGates`——
 * 本组件零判定：只调 `rerunMainControlGates`，再把结果行原样渲染。
 *
 * 未评估一律呈现为「未评估」（`skipped`），绝不呈现为通过：
 * - 门 status=pending → skipped（`mapDecisionGateToRunStatus` 同源）；
 * - 契约维度缺席（taskBrief 无契约段）/ AI 审稿关闭 → 显式提示，不给绿色结论。
 *
 * F17：已落库（status=saved）的草稿不再提供重跑按钮——重跑只会产出与正式正文
 * 不一致的判定。口径与采纳块（main-control-draft-adopt-block.tsx）一致：saved 只
 * 渲染「已写入正式章」徽章。过滤只发生在渲染层，lib 侧 `rerunMainControlGates`
 * 的草稿查表语义保持不变。
 */
const GATE_LABEL_KEYS: Record<DeepChapterDecisionGateKey, string> = {
  consistency: "mainControl.draftGateConsistency",
  anti_ai: "mainControl.draftGateAntiAi",
  quality: "mainControl.draftGateQuality",
}

const GATE_STATUS_LABEL_KEYS: Record<MainControlGateRow["status"], string> = {
  pass: "mainControl.draftGatePass",
  fail: "mainControl.draftGateFail",
  skipped: "mainControl.draftGatePending",
}

const OVERALL_LABEL_KEYS: Record<RerunMainControlGatesResult["overall"], string> = {
  pass: "mainControl.draftGatePass",
  warning: "mainControl.draftGateWarning",
  fail: "mainControl.draftGateFail",
  manual_review: "mainControl.draftGateManual",
  pending: "mainControl.draftGatePending",
}

export interface MainControlGateRerunBlockProps {
  readonly projectPath: string
}

export function MainControlGateRerunBlock({ projectPath }: MainControlGateRerunBlockProps) {
  const { t } = useTranslation()
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [result, setResult] = useState<RerunMainControlGatesResult | null>(null)

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void listChapterDrafts(projectPath)
      .then((rows) => {
        if (!cancelled) setDrafts(rows)
      })
      .catch((error) => {
        if (!cancelled) setNote(toErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  async function rerun(draft: ChapterDraft): Promise<void> {
    if (busyId) return
    setBusyId(draft.id)
    setNote(null)
    setResult(null)
    try {
      const outcome = await rerunMainControlGates({
        projectPath,
        draftId: draft.id,
        goal: draft.chapterName,
        novelConfig,
        llmConfig,
      })
      setResult(outcome)
      setNote(t("mainControl.draftGateRerunDone", { overall: t(OVERALL_LABEL_KEYS[outcome.overall]) }))
    } catch (error) {
      setNote(t("mainControl.draftGateRerunFailed", { message: toErrorMessage(error) }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rounded-lg border p-2" data-testid="main-control-gate-rerun">
      <h3 className="mb-1 text-xs font-semibold">{t("mainControl.draftGateBlockTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("mainControl.draftGateBlockHint")}</p>
      {drafts.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-gate-rerun-empty">
          {t("mainControl.draftAdoptEmpty")}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="flex items-center gap-2 text-xs"
              data-testid={`main-control-gate-rerun-row-${draft.id}`}
            >
              <span className="text-primary">{draft.chapterName}</span>
              {draft.status === "saved" ? (
                <span
                  className="ml-auto flex items-center gap-1 text-success"
                  data-testid={`main-control-gate-rerun-saved-${draft.id}`}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {t("mainControl.draftSavedAlready")}
                </span>
              ) : (
                <button
                  type="button"
                  className="ml-auto flex h-7 items-center gap-1 rounded-md border px-2 text-xs disabled:opacity-40"
                  data-testid={`main-control-gate-rerun-${draft.id}`}
                  disabled={busyId !== null}
                  onClick={() => void rerun(draft)}
                >
                  {busyId === draft.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {t("mainControl.draftGateRerun")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {busyId ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-gate-rerun-running">
          {t("mainControl.draftGateRerunRunning")}
        </p>
      ) : null}
      {note ? (
        <p
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="main-control-gate-rerun-note"
          role="status"
          aria-live="polite"
        >
          <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {note}
        </p>
      ) : null}
      {result ? (
        <div className="mt-1 flex flex-col gap-1" data-testid="main-control-gate-rerun-result">
          <ul className="flex flex-col gap-0.5">
            {result.rows.map((row) => (
              <li key={row.key} className="text-xs" data-testid={`main-control-gate-row-${row.key}`}>
                <span className="mr-1 font-medium">{t(GATE_LABEL_KEYS[row.key])}</span>
                <span className={row.status === "pass" ? "text-success" : row.status === "fail" ? "text-destructive" : "text-muted-foreground"}>
                  {t(GATE_STATUS_LABEL_KEYS[row.status])}
                </span>
                <span className="ml-1 text-muted-foreground">· {row.findings}</span>
              </li>
            ))}
          </ul>
          {!result.llmMediated ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-gate-rerun-no-review">
              {t("mainControl.draftGateRerunNoReview")}
            </p>
          ) : null}
          {!result.contractEvaluated ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-gate-rerun-contract">
              {t("mainControl.draftGateContractUnassessed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
