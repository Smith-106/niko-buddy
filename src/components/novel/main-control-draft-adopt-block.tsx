import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import { fileExists } from "@/commands/fs"
import {
  adoptMainControlDraft,
  buildIngestActivity,
  listChapterDrafts,
  resolveMainControlDraftTarget,
  type AcceptDraftIngestStatus,
  type ChapterDraft,
} from "@/lib/novel"
import type { AgentActivityEvent } from "@/lib/agent/types"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * 主控 drafts 页签的「采纳」区块（F1a）。
 *
 * 两步确认原样保留（与 ChapterDraftDock 同一语义）：
 * 1. 点「采纳」只解析目标路径 + 探占用，展开确认面板——**不写盘**；
 * 2. 点「确认采纳」才调 `adoptMainControlDraft({ confirmed: true })`，
 *    accept 通道仍是 draft-manager 的 `acceptChapterDraft`（内部 `!confirmed` 抛错不动）。
 *
 * 采纳之后按设置回填记忆（顺序/降级分类归 accept-draft-with-ingest.ts），
 * 本组件只把 ingest 结果映射成文案（R-04：文案留在调用方）。
 */
const INGEST_NOTE_KEYS: Record<AcceptDraftIngestStatus, string> = {
  ok: "mainControl.draftIngestOk",
  "skipped-config": "mainControl.draftIngestSkippedConfig",
  "skipped-no-model": "mainControl.draftIngestSkippedNoModel",
  failed: "mainControl.draftIngestFailed",
}

interface PendingAdopt {
  draft: ChapterDraft
  target: string
  occupied: boolean
}

export interface MainControlDraftAdoptBlockProps {
  readonly projectPath: string
  /** 当前选中的文件（同书同名草稿复用该路径，与 ChapterDraftDock 一致）。 */
  readonly selectedFile?: string | null
  /**
   * 记忆回填结果上报（RV-002 ②）：转成一条 `AgentActivityEvent` 交给主控面板，
   * 与深章阶段产出/共识轨迹同一条 activities 通道展示与落快照。
   */
  readonly onActivityEvent?: (event: AgentActivityEvent) => void
}

export function MainControlDraftAdoptBlock({ projectPath, selectedFile = null, onActivityEvent }: MainControlDraftAdoptBlockProps) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [pending, setPending] = useState<PendingAdopt | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [projectPath, reloadKey])

  async function askAdopt(draft: ChapterDraft): Promise<void> {
    if (!projectPath) return
    let target = ""
    try {
      target = resolveMainControlDraftTarget(projectPath, draft.chapterName, selectedFile)
    } catch (error) {
      setNote(t("mainControl.draftAcceptFailed", { message: toErrorMessage(error) }))
      return
    }
    const occupied = await fileExists(target).catch(() => true)
    setPending({ draft, target, occupied })
    setNote(null)
  }

  async function confirmAdopt(): Promise<void> {
    if (!pending || busy) return
    setBusy(true)
    try {
      const outcome = await adoptMainControlDraft({
        projectPath,
        draftId: pending.draft.id,
        chapterName: pending.draft.chapterName,
        // 第二步确认：用户在确认面板里点了「确认采纳」。
        confirmed: true,
        novelConfig,
        llmConfig,
        selectedFile,
      })
      const done = t("mainControl.draftAcceptDone", { path: outcome.formalChapterPath })
      const ingest = t(INGEST_NOTE_KEYS[outcome.ingest], { reason: outcome.failReason ?? "" })
      setPending(null)
      setNote(`${done} · ${ingest}`)
      // RV-002 ②：ingest 结果不只停在一句文案——同时进主控阶段观测通道。
      onActivityEvent?.(buildIngestActivity(outcome))
      setReloadKey((key) => key + 1)
    } catch (error) {
      setNote(t("mainControl.draftAcceptFailed", { message: toErrorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border p-2" data-testid="main-control-draft-adopt">
      {drafts.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="main-control-draft-adopt-empty">
          {t("mainControl.draftAdoptEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {drafts.map((draft) => (
            <li key={draft.id} className="flex items-center gap-2 text-xs" data-testid={`main-control-draft-row-${draft.id}`}>
              <span className="text-primary">{draft.chapterName}</span>
              <code className="truncate text-xs text-muted-foreground">{draft.id}</code>
              {draft.status === "saved" ? (
                <span className="flex items-center gap-1 text-success" data-testid={`main-control-draft-saved-${draft.id}`}>
                  <CheckCircle2 className="h-3 w-3" />
                  {t("mainControl.draftSavedAlready")}
                </span>
              ) : (
                <button
                  type="button"
                  className="ml-auto h-7 rounded-md border px-2 text-xs"
                  data-testid={`main-control-draft-adopt-${draft.id}`}
                  onClick={() => void askAdopt(draft)}
                >
                  {t("mainControl.draftAccept")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <div
          className="mt-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
          data-testid="main-control-draft-adopt-confirm"
        >
          <p className="font-medium">{t("mainControl.draftAcceptTitle")}</p>
          <p className="text-muted-foreground">{t("mainControl.draftAcceptPath", { path: pending.target })}</p>
          <p className="text-muted-foreground">
            {pending.occupied ? t("mainControl.draftAcceptOccupied") : t("mainControl.draftAcceptHint")}
          </p>
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              className="h-7 rounded-md border border-primary bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
              data-testid="main-control-draft-adopt-confirm-accept"
              disabled={busy}
              onClick={() => void confirmAdopt()}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t("mainControl.draftAcceptConfirm")}
            </button>
            <button
              type="button"
              className="h-7 rounded-md border px-2 text-xs"
              data-testid="main-control-draft-adopt-confirm-cancel"
              onClick={() => setPending(null)}
            >
              {t("mainControl.draftAcceptCancel")}
            </button>
          </div>
        </div>
      ) : null}

      {note ? (
        <p
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="main-control-draft-adopt-note"
          role="status"
          aria-live="polite"
        >
          <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {note}
        </p>
      ) : null}
    </div>
  )
}
