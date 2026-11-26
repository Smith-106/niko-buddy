import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import { fileExists, readFile } from "@/commands/fs"
import {
  DRAFTS_DIR,
  adoptMainControlDraft,
  buildIngestActivity,
  discardChapterDraft,
  draftNeedsGateReview,
  getDraftGateStatus,
  listChapterDrafts,
  resolveChapterDraftAdoptionTarget,
  type ChapterDraft,
  type DraftGateStatus,
} from "@/lib/novel"
import { formatMemoryIngest } from "@/lib/novel"
import { getChapterWriteCoordinator } from "@/components/layout/preview-panel-helpers"
import { DraftPreviewDiffDialog } from "@/components/novel/draft-preview-diff-dialog"
import { createDraftDialogGuard } from "@/components/novel/draft-dialog-guard"
import type { AgentActivityEvent } from "@/lib/agent/types"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

const GATE_BADGE_KEYS: Record<DraftGateStatus, string> = {
  passed: "mainControl.draftGateBadgePassed",
  unassessed: "mainControl.draftGateBadgeUnassessed",
  blocked: "mainControl.draftGateBadgeBlocked",
  manual_review: "mainControl.draftGateBadgeManualReview",
  partial: "mainControl.draftGateBadgePartial",
}

const GATE_BADGE_CLASSES: Record<DraftGateStatus, string> = {
  passed: "border-success/40 bg-success/10 text-success-foreground",
  unassessed: "border-border bg-muted/50 text-muted-foreground",
  blocked: "border-destructive/40 bg-destructive/10 text-destructive",
  manual_review: "border-warning/40 bg-warning/10 text-warning-foreground",
  partial: "border-warning/40 bg-warning/15 text-warning-foreground",
}

function formatDraftCreatedAt(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ""
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString("zh-CN", { hour12: false })
}

/**
 * 主控 drafts 页签的「采纳」区块（F1a）。
 *
 * 两步确认原样保留（与 ChapterDraftDock 同一语义）：
 * 1. 点「采纳」只解析目标路径 + 探占用，展开确认面板——**不写盘**；
 * 2. 点「确认采纳」才调 `adoptMainControlDraft({ confirmed: true })`，
 *    accept 通道仍是 draft-manager 的 `acceptChapterDraft`（内部 `!confirmed` 抛错不动）。
 *
 * 采纳之后按设置回填记忆（顺序/降级分类归 accept-draft-with-ingest.ts），
 * 本组件将正文结果与回填结果一并显示。
 */
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
  /** 门控拦截时一键直达「主控 → AI 实况」重跑门控；缺省不渲染按钮。 */
  readonly onOpenGateRerun?: () => void
}

export function MainControlDraftAdoptBlock({ projectPath, selectedFile = null, onActivityEvent, onOpenGateRerun }: MainControlDraftAdoptBlockProps) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [pending, setPending] = useState<PendingAdopt | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [noteIsError, setNoteIsError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [discardingId, setDiscardingId] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [dialogState, setDialogState] = useState<{
    open: boolean
    mode: "preview" | "diff"
    draft: ChapterDraft | null
    targetPath: string | null
    existingContent: string | null
    loading: boolean
    error: string | null
  }>({
    open: false,
    mode: "preview",
    draft: null,
    targetPath: null,
    existingContent: null,
    loading: false,
    error: null,
  })

  const mountedRef = useRef(true)
  const adoptGuardRef = useRef(createDraftDialogGuard())
  const diffGuardRef = useRef(createDraftDialogGuard())

  useEffect(() => {
    mountedRef.current = true
    const adoptGuard = adoptGuardRef.current
    const diffGuard = diffGuardRef.current
    return () => {
      mountedRef.current = false
      adoptGuard.invalidate()
      diffGuard.invalidate()
    }
  }, [])

  useEffect(() => {
    adoptGuardRef.current.invalidate()
    diffGuardRef.current.invalidate()
    setPending(null)
    setDialogState((prev) => (prev.open || prev.loading ? { ...prev, open: false, loading: false } : prev))
  }, [projectPath])

  // R2-U07：与写作台共用同一章节写入协调器，采纳前栅栏化防并发写回竞态
  const adoptionOwnerRef = useRef<object>({})
  const adoptionCoordinator = getChapterWriteCoordinator()
  useEffect(() => {
    const owner = adoptionOwnerRef.current
    return () => {
      adoptionCoordinator.releaseOwnedAdoptions(owner)
    }
  }, [adoptionCoordinator])

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void listChapterDrafts(projectPath)
      .then((rows) => {
        // BLOCKING-3：默认隐藏已丢弃（status === "failed"）草稿
        if (!cancelled) setDrafts(rows.filter((row) => row.status !== "failed"))
      })
      .catch((error) => {
        if (!cancelled) {
          setNoteIsError(true)
          setNote(toErrorMessage(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, reloadKey, dataVersion])

  async function askAdopt(draft: ChapterDraft): Promise<void> {
    if (!projectPath) return
    const token = adoptGuardRef.current.begin()
    diffGuardRef.current.invalidate()
    let target = ""
    try {
      target = await resolveChapterDraftAdoptionTarget(projectPath, draft, selectedFile)
    } catch (error) {
      if (!mountedRef.current || !adoptGuardRef.current.isCurrent(token)) return
      setNoteIsError(true)
      setNote(t("mainControl.draftAcceptFailed", { message: toErrorMessage(error) }))
      return
    }
    if (!mountedRef.current || !adoptGuardRef.current.isCurrent(token)) return
    const occupied = await fileExists(target).catch((err) => {
      void err
      return true
    })
    if (!mountedRef.current || !adoptGuardRef.current.isCurrent(token)) return
    setPending({ draft, target, occupied })
    setNote(null)
    setNoteIsError(false)
  }

  function openPreview(draft: ChapterDraft): void {
    diffGuardRef.current.invalidate()
    setDialogState({
      open: true,
      mode: "preview",
      draft,
      targetPath: null,
      existingContent: null,
      loading: false,
      error: null,
    })
  }

  async function openOverwriteDiff(targetPending: PendingAdopt): Promise<void> {
    const token = diffGuardRef.current.begin()
    if (!targetPending.occupied) {
      setDialogState({
        open: true,
        mode: "diff",
        draft: targetPending.draft,
        targetPath: targetPending.target,
        existingContent: null,
        loading: false,
        error: null,
      })
      return
    }
    setDialogState({
      open: true,
      mode: "diff",
      draft: targetPending.draft,
      targetPath: targetPending.target,
      existingContent: null,
      loading: true,
      error: null,
    })
    try {
      const existing = await readFile(targetPending.target)
      if (!mountedRef.current || !diffGuardRef.current.isCurrent(token)) return
      setDialogState((prev) => ({
        ...prev,
        existingContent: existing,
        loading: false,
      }))
    } catch (err) {
      if (!mountedRef.current || !diffGuardRef.current.isCurrent(token)) return
      setDialogState((prev) => ({
        ...prev,
        loading: false,
        error: t("mainControl.draftDiffLoadFailed", { message: toErrorMessage(err) }),
      }))
    }
  }

  function handleEditDraftInEditor(draft: ChapterDraft): void {
    if (!projectPath) return
    const root = normalizePath(projectPath).replace(/\/+$/, "")
    const draftPath = `${root}/${DRAFTS_DIR}/${draft.id}.md`
    setSelectedFile?.(draftPath)
    setActiveView?.("wiki")
  }

  async function handleDiscardDraft(draft: ChapterDraft): Promise<void> {
    if (!projectPath || discardingId) return
    setDiscardingId(draft.id)
    try {
      // BLOCKING-3：必须经 discardChapterDraft 原子标废，严禁调 deleteFile
      await discardChapterDraft(projectPath, draft.id)
      if (pending?.draft.id === draft.id) setPending(null)
      setNoteIsError(false)
      setNote(t("mainControl.draftDiscarded", { name: draft.chapterName }))
      setReloadKey((key) => key + 1)
      bumpDataVersion?.()
    } catch (error) {
      setNoteIsError(true)
      setNote(t("mainControl.draftDiscardFailed", { message: toErrorMessage(error) }))
    } finally {
      setDiscardingId(null)
    }
  }

  async function confirmAdopt(): Promise<void> {
    /* v8 ignore next -- 台账 main-control-draft-adopt-block.tsx L92：确认块整体在 `{pending ? ...}` 内渲染（L154），`!pending` 不可达；`busy` 由 disabled={busy}（L166）挡住 */
    if (!pending || busy) return
    if (draftNeedsGateReview(pending.draft)) return
    const begin = adoptionCoordinator.beginAdoption(pending.target, adoptionOwnerRef.current)
    if (!begin.ok) {
      setNoteIsError(true)
      setNote(t("mainControl.draftAcceptFailed", { message: t("mainControl.draftAdoptBusy") }))
      return
    }
    const lease = begin.lease
    setBusy(true)
    try {
      await begin.admittedTail
      const runAdopt = () =>
        adoptMainControlDraft({
          projectPath,
          draftId: pending.draft.id,
          chapterName: pending.draft.chapterName,
          // 第二步确认：用户在确认面板里点了「确认采纳」；落点就是确认面板展示的 pending.target，
          // 不从此刻的 selectedFile 重算（面板打开期间用户可能切了选中项）。
          confirmed: true,
          novelConfig,
          llmConfig,
          formalChapterPath: pending.target,
          expectedDraftContent: pending.draft.content,
        })
      const outcomePromise = lease ? adoptionCoordinator.runAdoption(lease, runAdopt) : runAdopt()
      const outcome = await outcomePromise
      const done = t("mainControl.draftAcceptDone", { path: outcome.formalChapterPath })
      const ingest = formatMemoryIngest(t, outcome)
      setPending(null)
      setNoteIsError(false)
      setNote(`${done} · ${ingest}`)
      // RV-002 ②：ingest 结果不只停在一句文案——同时进主控阶段观测通道。
      onActivityEvent?.(buildIngestActivity(outcome))
      setReloadKey((key) => key + 1)
      bumpDataVersion?.()
    } catch (error) {
      setNoteIsError(true)
      setNote(t("mainControl.draftAcceptFailed", { message: toErrorMessage(error) }))
    } finally {
      if (lease) {
        adoptionCoordinator.releaseAdoption(lease)
      }
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
        <ul className="flex flex-col gap-1.5">
          {drafts.map((draft) => {
            const gateStatus = getDraftGateStatus(draft)
            const wordCount = draft.content.replace(/\s/g, "").length
            const createdLabel = formatDraftCreatedAt(draft.createdAt)
            return (
              <li
                key={draft.id}
                className="flex flex-col gap-1 rounded border border-border/60 p-1.5 text-xs"
                data-testid={`main-control-draft-row-${draft.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-primary">{draft.chapterName}</span>
                  <code className="truncate text-xs text-muted-foreground">{draft.id}</code>
                  <span
                    data-testid={`main-control-draft-gate-badge-${draft.id}`}
                    data-gate-status={gateStatus}
                    className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${GATE_BADGE_CLASSES[gateStatus]}`}
                  >
                    {t(GATE_BADGE_KEYS[gateStatus])}
                  </span>
                  <span className="text-muted-foreground" data-testid={`main-control-draft-words-${draft.id}`}>
                    {t("mainControl.draftWords", { count: wordCount })}
                  </span>
                  {createdLabel ? (
                    <span className="text-muted-foreground" data-testid={`main-control-draft-time-${draft.id}`}>
                      {createdLabel}
                    </span>
                  ) : null}
                </div>
                {draft.partial ? (
                  <p
                    className="rounded border border-warning/40 bg-warning/10 px-1.5 py-1 text-warning-foreground"
                    data-testid={`main-control-draft-partial-${draft.id}`}
                  >
                    {t("mainControl.draftPartialHint")}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="h-7 rounded-md border border-border px-2 text-xs hover:bg-accent"
                    data-testid={`main-control-draft-preview-${draft.id}`}
                    onClick={() => openPreview(draft)}
                  >
                    {t("mainControl.draftPreview")}
                  </button>
                  {draft.status === "saved" ? (
                    <span className="ml-auto flex items-center gap-1 text-success" data-testid={`main-control-draft-saved-${draft.id}`}>
                      <CheckCircle2 className="h-3 w-3" />
                      {t("mainControl.draftSavedAlready")}
                    </span>
                  ) : gateStatus === "partial" ? (
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        className="h-7 shrink-0 rounded-md border border-primary/60 px-2 text-xs text-primary hover:bg-accent"
                        data-testid={`main-control-draft-edit-${draft.id}`}
                        onClick={() => handleEditDraftInEditor(draft)}
                      >
                        {t("mainControl.draftEditInEditor")}
                      </button>
                      <button
                        type="button"
                        disabled={discardingId !== null}
                        className="h-7 shrink-0 rounded-md border border-destructive/50 px-2 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        data-testid={`main-control-draft-discard-${draft.id}`}
                        onClick={() => void handleDiscardDraft(draft)}
                      >
                        {t("mainControl.draftDiscard")}
                      </button>
                    </div>
                  ) : draftNeedsGateReview(draft) ? (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground" data-testid={`main-control-draft-gate-${draft.id}`}>
                        {t("mainControl.draftGateRequired")}
                      </span>
                      {onOpenGateRerun ? (
                        <button
                          type="button"
                          className="h-7 shrink-0 rounded-md border border-primary/60 px-2 text-xs text-primary hover:bg-accent"
                          data-testid={`main-control-draft-gate-go-${draft.id}`}
                          onClick={onOpenGateRerun}
                        >
                          {t("mainControl.draftGateGoRerun")}
                        </button>
                      ) : null}
                    </div>
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
                </div>
              </li>
            )
          })}
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
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <button
              type="button"
              className="h-7 rounded-md border border-primary bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
              data-testid="main-control-draft-adopt-confirm-accept"
              disabled={busy || draftNeedsGateReview(pending.draft)}
              onClick={() => void confirmAdopt()}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t("mainControl.draftAcceptConfirm")}
            </button>
            <button
              type="button"
              className="h-7 rounded-md border border-border px-2 text-xs hover:bg-accent"
              data-testid="main-control-draft-adopt-confirm-diff"
              onClick={() => void openOverwriteDiff(pending)}
            >
              {t("mainControl.draftCompareDiff")}
            </button>
            <button
              type="button"
              className="h-7 rounded-md border px-2 text-xs"
              data-testid="main-control-draft-adopt-confirm-cancel"
              onClick={() => {
                adoptGuardRef.current.invalidate()
                diffGuardRef.current.invalidate()
                setPending(null)
              }}
            >
              {t("mainControl.draftAcceptCancel")}
            </button>
          </div>
        </div>
      ) : null}

      {note ? (
        <p
          className={`mt-1 flex items-center gap-1 text-xs ${
            noteIsError ? "text-destructive" : "text-muted-foreground"
          }`}
          data-testid="main-control-draft-adopt-note"
          role={noteIsError ? "alert" : "status"}
          aria-live={noteIsError ? "assertive" : "polite"}
        >
          <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {note}
        </p>
      ) : null}

      <DraftPreviewDiffDialog
        open={dialogState.open}
        onOpenChange={(open) => {
          if (!open) diffGuardRef.current.invalidate()
          setDialogState((prev) => ({ ...prev, open, loading: open ? prev.loading : false }))
        }}
        mode={dialogState.mode}
        draft={dialogState.draft}
        targetPath={dialogState.targetPath}
        existingContent={dialogState.existingContent}
        loading={dialogState.loading}
        error={dialogState.error}
      />
    </div>
  )
}
