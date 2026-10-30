import { useEffect, useState } from "react"
import { CheckCircle2 } from "lucide-react"
import { fileExists } from "@/commands/fs"
import {
  acceptChapterDraft,
  formalChapterPathForDraft,
  listChapterDrafts,
  type ChapterDraft,
} from "@/lib/novel"

export interface ChapterDraftDockProps {
  readonly projectPath: string
  readonly selectedFile: string | null
  readonly onAdopted?: (formalChapterPath: string) => void
  readonly listDrafts?: typeof listChapterDrafts
  readonly acceptDraft?: typeof acceptChapterDraft
  readonly pathExists?: (path: string) => Promise<boolean>
  /**
   * Q14-B：连续性告警计数（与 toolsBar / Dock 呼吸灯同源 foreshadowOverdue）。
   * null/undefined 或两项均 0 时不渲染告警条（fail-open，不伪造告警）。
   */
  readonly alerts?: { critical: number; warning: number } | null
  /** 空态「去主控生成」：只跳转并预填目标，不直接调模型。缺省不渲染按钮。 */
  readonly onGenerateDraft?: () => void
  /** 采纳成功后「查看记忆更新」：跳到记忆中心。缺省不渲染链接。 */
  readonly onOpenMemory?: () => void
}

interface PendingAdopt {
  draft: ChapterDraft
  target: string
  occupied: boolean
}

export function ChapterDraftDock({
  projectPath,
  selectedFile,
  onAdopted,
  alerts,
  onGenerateDraft,
  onOpenMemory,
  listDrafts = listChapterDrafts,
  acceptDraft = acceptChapterDraft,
  pathExists = fileExists,
}: ChapterDraftDockProps) {
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [pending, setPending] = useState<PendingAdopt | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void listDrafts(projectPath)
      .then((rows) => {
        if (!cancelled) setDrafts(rows)
      })
      .catch(() => {
        if (!cancelled) setNote("草稿读不出来。")
      })
    return () => {
      cancelled = true
    }
  }, [listDrafts, projectPath, reloadKey])

  async function askAdopt(draft: ChapterDraft): Promise<void> {
    let target = ""
    try {
      target = formalChapterPathForDraft(projectPath, draft.chapterName, selectedFile)
    } catch (error) {
      setNote(error instanceof Error ? error.message : "不能确定正式章位置")
      return
    }
    const occupied = await pathExists(target).catch(() => true)
    setPending({ draft, target, occupied })
    setNote(null)
  }

  async function confirmAdopt(): Promise<void> {
    if (!pending || busy) return
    setBusy(true)
    try {
      const result = await acceptDraft({
        projectPath,
        draftId: pending.draft.id,
        formalChapterPath: pending.target,
        confirmed: true,
      })
      setPending(null)
      setNote("已写入正式章。")
      setReloadKey((key) => key + 1)
      onAdopted?.(result.formalChapterPath)
    } catch (error) {
      setNote(error instanceof Error ? error.message : "没有写入正式章")
    } finally {
      setBusy(false)
    }
  }

  if (!projectPath) {
    return <p className="p-2 text-xs text-muted-foreground">先打开一本书，才能采纳草稿。</p>
  }

  return (
    <div className="space-y-2 p-2 text-xs" data-testid="chapter-draft-dock">
      {/* Q14-B：草稿 dock 内连续性告警条（与 Dock 呼吸灯同源；无告警不渲染）。 */}
      {alerts && alerts.critical + alerts.warning > 0 ? (
        <p
          className={
            alerts.critical > 0
              ? "rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive"
              : "rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning-foreground"
          }
          data-testid="chapter-draft-continuity-alert"
        >
          {`连续性告警 严重${alerts.critical} · 提示${alerts.warning}`}
        </p>
      ) : null}
      <p className="font-medium">本章草稿</p>
      {drafts.length === 0 ? (
        <div className="space-y-1.5 rounded border border-dashed px-2 py-2 text-muted-foreground" data-testid="chapter-draft-empty">
          <p>没有待采纳的章节草稿。</p>
          <p>AI 写的章节会先放在这里，你点「采纳」后才写入正文并更新记忆。可以在主控或 AI 会话里让它写一章。</p>
          {onGenerateDraft ? (
            <button
              type="button"
              className="rounded bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="chapter-draft-empty-generate"
              onClick={onGenerateDraft}
            >
              去主控生成
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="space-y-1.5">
        {drafts.map((draft) => (
          <li key={draft.id} className="rounded border px-2 py-1.5" data-testid={`chapter-draft-${draft.id}`}>
            <div className="font-medium">{draft.chapterName}</div>
            <div className="text-muted-foreground">{draft.status === "saved" ? "已写入正式章" : "尚未写入正式章"}</div>
            {draft.status !== "saved" ? (
              <button
                type="button"
                className="mt-1 rounded border px-2 py-1"
                data-testid={`chapter-draft-adopt-${draft.id}`}
                onClick={() => void askAdopt(draft)}
              >
                采纳
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="rounded border border-warning/40 bg-warning/10 p-2" data-testid="chapter-draft-confirm">
          <p>
            确认后才把「{pending.draft.chapterName}」写入 {pending.target}。
            {pending.occupied ? "这个文件已存在，会覆盖。" : "确认前不会写入。"}
          </p>
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              className="rounded border px-2 py-1 disabled:opacity-40"
              data-testid="chapter-draft-confirm-accept"
              disabled={busy}
              onClick={() => void confirmAdopt()}
            >
              确认采纳
            </button>
            <button
              type="button"
              className="rounded border px-2 py-1"
              data-testid="chapter-draft-confirm-cancel"
              onClick={() => setPending(null)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        note === "已写入正式章。" ? (
          // ISS-20260709-018：草稿接受轻量庆祝 — 内联成功态，不弹窗、不抢焦点、
          // role=status + aria-live polite 播报，文案语义不变，仅加视觉反馈。
          <p
            data-testid="chapter-draft-note"
            role="status"
            aria-live="polite"
            className="draft-celebrate flex items-center gap-1.5 rounded border border-success/40 bg-success/10 px-2 py-1.5 text-success-foreground"
          >
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{note}</span>
            {onOpenMemory ? (
              <button
                type="button"
                className="ml-auto shrink-0 underline underline-offset-2 hover:no-underline"
                data-testid="chapter-draft-open-memory"
                onClick={onOpenMemory}
              >
                查看记忆更新
              </button>
            ) : null}
          </p>
        ) : (
          <p data-testid="chapter-draft-note">{note}</p>
        )
      ) : null}
    </div>
  )
}
