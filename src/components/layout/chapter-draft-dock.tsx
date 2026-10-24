import { useEffect, useState } from "react"
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
      <p className="font-medium">本章草稿</p>
      {drafts.length === 0 ? <p className="text-muted-foreground">没有待采纳的章节草稿。</p> : null}
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
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2" data-testid="chapter-draft-confirm">
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
      {note ? <p data-testid="chapter-draft-note">{note}</p> : null}
    </div>
  )
}
