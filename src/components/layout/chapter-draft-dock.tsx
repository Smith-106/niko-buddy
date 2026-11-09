import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, CircleX, type LucideIcon } from "lucide-react"
import { fileExists } from "@/commands/fs"
import {
  acceptChapterDraft,
  formalChapterPathForDraft,
  listChapterDrafts,
  type AcceptDraftAndIngestResult,
  type AcceptDraftIngestStatus,
  type ChapterDraft,
} from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

/**
 * 四态 → 文案键（与 accept-draft-with-ingest.ts、main-control-draft-adopt-block.tsx 的
 * 同名映射逐字同构；R-6：改键名必须三处同改）。不新增 i18n 键、不新增第五态。
 */
const INGEST_NOTE_KEYS: Record<AcceptDraftIngestStatus, string> = {
  ok: "mainControl.draftIngestOk",
  "skipped-config": "mainControl.draftIngestSkippedConfig",
  "skipped-no-model": "mainControl.draftIngestSkippedNoModel",
  failed: "mainControl.draftIngestFailed",
}

/**
 * 呈现语气：只决定视觉，不是第五种 ingest 状态（四态枚举不变）。
 * `settled` 只表示「正文已落盘」；回填四态决定语气 —— 只有 ok 才是「成功」，
 * skipped-* 走警示语气、failed 走错误语气，避免把降级/失败渲染成同一个绿色成功块。
 */
type NoteTone = "success" | "warning" | "error"

/** 四态 → 语气：ok 成功 / 两种 skipped 警示 / failed 错误。 */
const INGEST_NOTE_TONES: Record<AcceptDraftIngestStatus, NoteTone> = {
  ok: "success",
  "skipped-config": "warning",
  "skipped-no-model": "warning",
  failed: "error",
}

/** 语气 → 区块样式：只有 ok 挂 draft-celebrate 庆祝动画，降级/失败不庆祝。 */
const NOTE_TONE_CLASS: Record<NoteTone, string> = {
  success: "draft-celebrate border-success/40 bg-success/10 text-success-foreground",
  warning: "border-warning/40 bg-warning/10 text-warning-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
}

/** 语气 → 图标：成功用勾，降级/失败不再用 CheckCircle2。 */
const NOTE_TONE_ICONS: Record<NoteTone, LucideIcon> = {
  success: CheckCircle2,
  warning: CircleAlert,
  error: CircleX,
}

/**
 * 采纳即回填的注入点（G2）：writing-workspace 用 acceptDraftAndIngest + 主控 accept seam 装配。
 * 顺序/降级分类归 accept-draft-with-ingest.ts，本组件只呈现四态。
 */
export interface ChapterDraftDockAdoptAndIngestInput {
  projectPath: string
  draftId: string
  formalChapterPath: string
  /** accept 已落盘的回执：此后即便 ingest 抛错也不能再当「采纳失败」（不掩盖已写正文）。 */
  onAcceptSettled?: () => void
}

export type ChapterDraftDockAdoptAndIngest = (
  input: ChapterDraftDockAdoptAndIngestInput,
) => Promise<AcceptDraftAndIngestResult>

export interface ChapterDraftDockProps {
  readonly projectPath: string
  readonly selectedFile: string | null
  readonly onAdopted?: (formalChapterPath: string) => void
  readonly listDrafts?: typeof listChapterDrafts
  readonly acceptDraft?: typeof acceptChapterDraft
  /**
   * 采纳 + 按设置回填记忆的注入点；缺省时不注入 → 仍走上面的 acceptDraft（只采纳），行为不变。
   */
  readonly adoptAndIngest?: ChapterDraftDockAdoptAndIngest
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
  adoptAndIngest,
  pathExists = fileExists,
}: ChapterDraftDockProps) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [pending, setPending] = useState<PendingAdopt | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // 成功态由显式 state 驱动（不比对文案）：默认路径成功、注入路径 resolve、
  // 以及「已落盘但回填抛错」三条路都置 true，庆祝块与「查看记忆更新」入口才出现。
  const [settled, setSettled] = useState(false)
  // 与 settled 正交：settled 只说「已落盘」，语气由回填四态决定（跳过/失败不得用成功语气）。
  const [noteTone, setNoteTone] = useState<NoteTone>("success")
  const [busy, setBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  /** 四态 → 文案（键映射固定；reason 只在 failed 时非空）。 */
  function ingestNote(status: AcceptDraftIngestStatus, reason?: string): string {
    return t(INGEST_NOTE_KEYS[status], { reason: reason ?? "" })
  }

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
    // 第一步只展开确认面板：不写盘、不 ingest；同时清掉上一轮的庆祝态与语气。
    setSettled(false)
    setNoteTone("success")
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
    /* v8 ignore next -- 台账 chapter-draft-dock.tsx L81：确认块整体在 `{pending ? ...}` 内渲染（L155），`!pending` 不可达；`busy` 由 disabled={busy}（L166）挡住 */
    if (!pending || busy) return
    setBusy(true)
    // 局部回执（不用 ref、不靠 await 后读过期闭包）：区分「采纳没落盘」与「已落盘但回填异常」。
    let acceptSettled = false
    try {
      if (adoptAndIngest) {
        const outcome = await adoptAndIngest({
          projectPath,
          draftId: pending.draft.id,
          formalChapterPath: pending.target,
          onAcceptSettled: () => {
            acceptSettled = true
          },
        })
        setPending(null)
        setSettled(true)
        setNoteTone(INGEST_NOTE_TONES[outcome.ingest])
        setNote(
          `${t("mainControl.draftAcceptDone", { path: outcome.formalChapterPath })} · ${ingestNote(outcome.ingest, outcome.failReason)}`,
        )
        setReloadKey((key) => key + 1)
        onAdopted?.(outcome.formalChapterPath)
      } else {
        const result = await acceptDraft({
          projectPath,
          draftId: pending.draft.id,
          formalChapterPath: pending.target,
          confirmed: true,
        })
        setPending(null)
        setSettled(true)
        setNoteTone("success")
        setNote("已写入正式章。")
        setReloadKey((key) => key + 1)
        onAdopted?.(result.formalChapterPath)
      }
    } catch (error) {
      if (acceptSettled) {
        // 正文已落盘、只是回填抛错：如实呈现「已写入 + 回填失败」，不删除/不重写正式章（零回滚）。
        setPending(null)
        setSettled(true)
        setNoteTone("error")
        setNote(
          `${t("mainControl.draftAcceptDone", { path: pending.target })} · ${ingestNote("failed", toErrorMessage(error))}`,
        )
        setReloadKey((key) => key + 1)
        onAdopted?.(pending.target)
      } else {
        setSettled(false)
        setNote(error instanceof Error ? error.message : "没有写入正式章")
      }
    } finally {
      setBusy(false)
    }
  }

  if (!projectPath) {
    return <p className="p-2 text-xs text-muted-foreground">先打开一本书，才能采纳草稿。</p>
  }

  const NoteToneIcon = NOTE_TONE_ICONS[noteTone]

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
            {draft.partial ? (
              <div
                className="mt-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-1 text-warning-foreground"
                data-testid={`chapter-draft-partial-${draft.id}`}
              >
                截断稿：正文可能不完整，采纳前请先复核。
              </div>
            ) : null}
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
          {pending.draft.partial ? (
            <p className="mt-1 text-warning-foreground" data-testid="chapter-draft-confirm-partial">
              这份草稿是截断稿，正文可能不完整；采纳会把不完整正文写进正式章。
            </p>
          ) : null}
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
        settled ? (
          // ISS-20260709-018：草稿接受轻量庆祝 — 内联成功态，不弹窗、不抢焦点、
          // role=status + aria-live polite 播报，文案语义不变，仅加视觉反馈。
          // 语气按回填四态分层：只有 ingest=ok 用绿色庆祝块；skipped-*/failed 用警示/错误块，
          // 「正文已落盘」的事实仍由文案承载，不因降级而丢失。
          <p
            data-testid="chapter-draft-note"
            data-tone={noteTone}
            role="status"
            aria-live="polite"
            className={`flex items-center gap-1.5 rounded border px-2 py-1.5 ${NOTE_TONE_CLASS[noteTone]}`}
          >
            <NoteToneIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
