import type { ReactNode, RefObject } from "react"
import { useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, MoreHorizontal, X } from "lucide-react"
import { InspectorPanel } from "@/components/inspector/inspector-panel"
import type { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

// M5-2：从 preview-panel.tsx 剥出的章节工具栏头（标题输入 + 紧凑/展开操作组 +
// saveStatus 行 + Inspector 行）。纯展示组件：全部状态与副作用留在 PreviewPanel，
// 本文件只做 props 透传渲染；DOM 结构与原内联 JSX 逐行一致。

export interface ChapterToolbarHeaderProps {
  toolbarRef: RefObject<HTMLDivElement | null>
  titleMeasureRef: RefObject<HTMLSpanElement | null>
  chapterHeader: ReturnType<typeof buildChapterEditorHeader> | null
  chapterTitleDraft: string
  chapterDisplayTitle: string
  chapterTitleMeasureText: string
  chapterTitleWidthPx: number
  chapterToolbarCompact: boolean
  chapterMeta: ReactNode
  hasChapterToolbarActions: boolean
  chapterToolbarMoreOpen: boolean
  onToggleMoreOpen: () => void
  onCloseMoreMenu: () => void
  chatExpanded: boolean
  onToggleChat: () => void
  deAiProcessing: boolean
  onDeAiProcess: () => void
  hasProject: boolean
  batchRunning: boolean
  onDeAiBatchStart: () => void
  canIngestOutline: boolean
  onIngestOutline: () => void
  isOutlineIngesting: boolean
  outlineIngested: boolean
  onOpenUnpackOutline: () => void
  outlineSnapshotNumber: number | null
  onShowOutlineSnapshot: () => void
  canSaveAsFinal: boolean
  alreadyFinal: boolean
  onSaveAsFinal: () => void
  onReingest: () => void
  isFinalChapterSaving: boolean
  canFormatWriting: boolean
  onFormatWriting: () => void
  canViewSnapshot: boolean
  onShowSnapshot: () => void
  novelMode: boolean
  onShowCognition: () => void
  onShowPersona: () => void
  onClosePreview: () => void
  onTitleFocus: () => void
  onTitleChange: (value: string) => void
  onTitleCommit: () => void
  onTitleCancel: () => void
  visibleSaveStatus: string
  onCopyReingestReceipt?: () => void
  selectionActionPending: boolean
  onCancelSelectionAction: () => void
  showInspector: boolean
  inspectorProjectPath: string
  inspectorChapterId: string
  inspectorRefreshKey: string
}

export function ChapterToolbarHeader({
  toolbarRef,
  titleMeasureRef,
  chapterHeader,
  chapterTitleDraft,
  chapterDisplayTitle,
  chapterTitleMeasureText,
  chapterTitleWidthPx,
  chapterToolbarCompact,
  chapterMeta,
  hasChapterToolbarActions,
  chapterToolbarMoreOpen,
  onToggleMoreOpen,
  onCloseMoreMenu,
  chatExpanded,
  onToggleChat,
  deAiProcessing,
  onDeAiProcess,
  hasProject,
  batchRunning,
  onDeAiBatchStart,
  canIngestOutline,
  onIngestOutline,
  isOutlineIngesting,
  outlineIngested,
  onOpenUnpackOutline,
  outlineSnapshotNumber,
  onShowOutlineSnapshot,
  canSaveAsFinal,
  alreadyFinal,
  onSaveAsFinal,
  onReingest,
  isFinalChapterSaving,
  canFormatWriting,
  onFormatWriting,
  canViewSnapshot,
  onShowSnapshot,
  novelMode,
  onShowCognition,
  onShowPersona,
  onClosePreview,
  onTitleFocus,
  onTitleChange,
  onTitleCommit,
  onTitleCancel,
  visibleSaveStatus,
  onCopyReingestReceipt,
  selectionActionPending,
  onCancelSelectionAction,
  showInspector,
  inspectorProjectPath,
  inspectorChapterId,
  inspectorRefreshKey,
}: ChapterToolbarHeaderProps) {
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const skipNextBlurCommitRef = useRef(false)
  const moreActionsId = useId()
  const closeMoreAndRestoreFocus = () => { onCloseMoreMenu(); moreButtonRef.current?.focus() }
  const { t } = useTranslation()
  // BLOCKING-8：直接订阅 store，零修改 ChapterToolbarHeaderProps 接口
  const finalChapterSave = useWikiStore((s) => s.finalChapterSave)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const isBlockedByReview = Boolean(
    finalChapterSave?.phase === "blocked_by_review" &&
      selectedFile &&
      normalizePath(finalChapterSave.filePath) === normalizePath(selectedFile),
  )
  return (
      <div className="border-b px-3 py-1.5">
        <div ref={toolbarRef} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {/* ui-audit-20261016：标题组旧下限 9rem 太窄——实测标题输入框 inline 宽度
              148px 被 flex shrink 压到 98px（章节名显示为 “chapt…”），而右侧 12 个次级按钮
              占满整行。下限提到 16rem 并让输入框不自缩，空间不够时工具条换行（容器已 flex-wrap）。 */}
          <div className="relative flex min-w-[16rem] max-w-full flex-1 items-center gap-1 overflow-hidden">
            {chapterHeader ? (
              <>
                <span
                  ref={titleMeasureRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-0 whitespace-pre border-0 p-0 text-2xl font-bold leading-10 opacity-0"
                  style={{ fontFamily: "inherit" }}
                >
                  {chapterTitleMeasureText}
                </span>
                <input
                  type="text"
                  aria-label={t("preview.chapterTitle")}
                  value={chapterTitleDraft}
                  onFocus={() => {
                    skipNextBlurCommitRef.current = false
                    onTitleFocus()
                  }}
                  onChange={(e) => onTitleChange(e.target.value)}
                  onBlur={() => {
                    if (skipNextBlurCommitRef.current) {
                      skipNextBlurCommitRef.current = false
                      return
                    }
                    onTitleCommit()
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Enter") {
                      e.preventDefault()
                      skipNextBlurCommitRef.current = true
                      onTitleCommit()
                      e.currentTarget.blur()
                      return
                    }
                    if (e.key === "Escape") {
                      e.preventDefault()
                      skipNextBlurCommitRef.current = true
                      onTitleCancel()
                      e.currentTarget.blur()
                    }
                  }}
                  className="min-w-[4rem] shrink-0 truncate border-0 bg-transparent p-0 text-2xl font-bold leading-10 text-foreground outline-none"
                  style={{
                    width: `${chapterTitleWidthPx}px`,
                    maxWidth: chapterToolbarCompact ? "12rem" : "min(28rem, 100%)",
                    fontFamily: "inherit",
                  }}
                  title={chapterDisplayTitle}
                  spellCheck={false}
                />
                {chapterMeta}
              </>
            ) : null}
          </div>
          <div className="relative ml-auto flex shrink-0 items-center justify-end gap-1">
          {chapterToolbarCompact && hasChapterToolbarActions ? (
            <div className="relative shrink-0"
              onKeyDown={event => {
                if (event.key === "Escape" && chapterToolbarMoreOpen) {
                  event.preventDefault()
                  event.stopPropagation()
                  closeMoreAndRestoreFocus()
                }
              }}
              onBlur={event => {
                if (chapterToolbarMoreOpen && !event.currentTarget.contains(event.relatedTarget)) onCloseMoreMenu()
              }}
            >
              <button
                type="button"
                onClick={onToggleMoreOpen}
                ref={moreButtonRef}
                className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t("preview.moreActions")}
                aria-label={t("preview.moreActions")}
                aria-expanded={chapterToolbarMoreOpen}
                aria-controls={moreActionsId}
              >
                <MoreHorizontal className="h-3.5 w-3.5 shrink-0" />
              </button>
              {chapterToolbarMoreOpen ? (
                <div id={moreActionsId} role="group" aria-label={t("preview.moreActions")} className="absolute right-0 top-8 z-30 w-40 max-h-[min(60vh,24rem)] overflow-y-auto rounded-md border bg-popover p-1 text-xs text-popover-foreground elevation-3">
                  {chapterHeader ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onToggleChat()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {chatExpanded ? t("preview.closeChatSession", { defaultValue: "关闭会话栏" }) : t("preview.openChatSession", { defaultValue: "打开会话栏" })}
                    </button>
                  ) : null}
                  {chapterHeader ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onDeAiProcess()
                      }}
                      disabled={deAiProcessing}
                      aria-label={deAiProcessing ? t("preview.deAiProcessing") : t("preview.deAi")}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deAiProcessing ? t("preview.deAiProcessing") : t("preview.deAi")}
                    </button>
                  ) : null}
                  {hasProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onDeAiBatchStart()
                      }}
                      disabled={batchRunning || deAiProcessing}
                      aria-label={batchRunning ? t("preview.deAiBatchRunning") : t("preview.deAiBatch")}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {batchRunning ? t("preview.deAiBatchRunning") : t("preview.deAiBatch")}
                    </button>
                  ) : null}
                  {canIngestOutline ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onIngestOutline()
                      }}
                      disabled={isOutlineIngesting}
                      aria-label={isOutlineIngesting ? t("novel.outlineGenerator.ingesting") : outlineIngested ? t("preview.deAiIngested") : t("novel.outlineGenerator.ingest")}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isOutlineIngesting ? t("novel.outlineGenerator.ingesting") : outlineIngested ? t("preview.deAiIngested") : t("novel.outlineGenerator.ingest")}
                    </button>
                  ) : null}
                  {canIngestOutline ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onOpenUnpackOutline()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("preview.unpackOutline")}
                    </button>
                  ) : null}
                  {canIngestOutline && outlineIngested && outlineSnapshotNumber !== null ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onShowOutlineSnapshot()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("novel.snapshot.viewButton")}
                    </button>
                  ) : null}
                  {canSaveAsFinal && !alreadyFinal ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onSaveAsFinal()
                      }}
                      disabled={isFinalChapterSaving}
                      aria-label={isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.saveAsCanon")}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.saveAsCanon")}
                    </button>
                  ) : null}
                  {canSaveAsFinal && alreadyFinal ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onReingest()
                      }}
                      disabled={isFinalChapterSaving}
                      aria-label={isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.reingestButton")}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.reingestButton")}
                    </button>
                  ) : null}
                  {canFormatWriting ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onFormatWriting()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("preview.formatWriting", { defaultValue: "一键排版" })}
                    </button>
                  ) : null}
                  {canViewSnapshot ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onShowSnapshot()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("novel.snapshot.viewButton")}
                    </button>
                  ) : null}
                  {novelMode && hasProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onShowCognition()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("novel.cognition.title")}
                    </button>
                  ) : null}
                  {novelMode && hasProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMoreAndRestoreFocus()
                        onShowPersona()
                      }}
                      className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {t("novel.persona.title")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!chapterToolbarCompact && chapterHeader ? (
            <button
              type="button"
              onClick={onToggleChat}
              className={`shrink-0 rounded border border-border px-2 py-1 text-xs hover:bg-accent ${
                chatExpanded ? "bg-accent text-foreground" : "text-foreground"
              }`}
              title={chatExpanded ? t("preview.closeChatSession", { defaultValue: "关闭会话栏" }) : t("preview.openChatSession", { defaultValue: "打开会话栏" })}
            >
              {t("preview.chatSession", { defaultValue: "AI会话" })}
            </button>
          ) : null}
          {!chapterToolbarCompact && chapterHeader ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={onDeAiProcess}
                disabled={deAiProcessing}
                aria-label={deAiProcessing ? t("preview.deAiProcessing") : t("preview.deAi")}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deAiProcessing ? t("preview.deAiProcessing") : t("preview.deAi")}
              </button>
            </div>
          ) : null}
          {!chapterToolbarCompact && hasProject ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={onDeAiBatchStart}
                disabled={batchRunning || deAiProcessing}
                aria-label={batchRunning ? t("preview.deAiBatchRunning") : t("preview.deAiBatch")}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {batchRunning ? t("preview.deAiBatchRunning") : t("preview.deAiBatch")}
              </button>
            </div>
          ) : null}
          {!chapterToolbarCompact && canIngestOutline ? (
            <button
              type="button"
              onClick={onIngestOutline}
              disabled={isOutlineIngesting}
              className={`shrink-0 rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                outlineIngested
                  ? "border-success/50 text-success-foreground hover:bg-success dark:text-success-foreground dark:hover:bg-success/30"
                  : "border-border text-foreground hover:bg-accent"
              }`}
              title={outlineIngested ? t("preview.reingestTitleTip") : t("novel.outlineGenerator.ingest")}
            >
              {isOutlineIngesting ? t("novel.outlineGenerator.ingesting") : outlineIngested ? t("preview.deAiIngested") : t("novel.outlineGenerator.ingest")}
            </button>
          ) : null}
          {!chapterToolbarCompact && canIngestOutline ? (
            <button
              type="button"
              onClick={onOpenUnpackOutline}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("preview.unpackOutlineTip")}
            >
              {t("preview.unpackOutline")}
            </button>
          ) : null}
          {!chapterToolbarCompact && canIngestOutline && outlineIngested && outlineSnapshotNumber !== null ? (
            <button
              type="button"
              onClick={onShowOutlineSnapshot}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("preview.viewSnapshotDetail")}
            >
              {t("novel.snapshot.viewButton")}
            </button>
          ) : null}
          {!chapterToolbarCompact && canSaveAsFinal && !alreadyFinal ? (
            <button
              type="button"
              onClick={onSaveAsFinal}
              disabled={isFinalChapterSaving}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              title={t("novel.chapter.saveAsCanon")}
            >
              {isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.saveAsCanon")}
            </button>
          ) : null}
          {!chapterToolbarCompact && canSaveAsFinal && alreadyFinal ? (
            <button
              type="button"
              onClick={onReingest}
              disabled={isFinalChapterSaving}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              title={t("preview.reingestTitle")}
            >
              {isFinalChapterSaving ? t("novel.chapter.savingAsFinal") : t("novel.chapter.reingestButton")}
            </button>
          ) : null}
          {!chapterToolbarCompact && canFormatWriting ? (
            <button
              type="button"
              onClick={onFormatWriting}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("preview.formatWritingTitle", { defaultValue: "自动整理正文段落格式，并为段落添加首行缩进" })}
            >
              {t("preview.formatWriting", { defaultValue: "一键排版" })}
            </button>
          ) : null}
          {!chapterToolbarCompact && canViewSnapshot ? (
            <button
              type="button"
              onClick={onShowSnapshot}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("preview.snapshotTitle")}
            >
              {t("novel.snapshot.viewButton")}
            </button>
          ) : null}
          {!chapterToolbarCompact && novelMode && hasProject ? (
            <button
              type="button"
              onClick={onShowCognition}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("preview.cognitionTitle")}
            >
              {t("novel.cognition.title")}
            </button>
          ) : null}
          {!chapterToolbarCompact && novelMode && hasProject ? (
            <button
              type="button"
              onClick={onShowPersona}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              title={t("novel.persona.title")}
            >
              {t("novel.persona.title")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("novel.preview.closePreview")}
            onClick={onClosePreview}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5 shrink-0" />
          </button>
          </div>
        </div>
        {visibleSaveStatus || selectionActionPending || onCopyReingestReceipt ? (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-right min-w-0">
            {selectionActionPending ? (
              <button
                type="button"
                onClick={onCancelSelectionAction}
                className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t("preview.cancel")}
              </button>
            ) : null}
            <span role="status" aria-atomic="true" className="min-w-0 break-words text-xs text-muted-foreground">
              {visibleSaveStatus}
            </span>
            {onCopyReingestReceipt ? (
              <button
                type="button"
                onClick={onCopyReingestReceipt}
                className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t("novel.chapter.copyReingestReceipt")}
              </button>
            ) : null}
          </div>
        ) : null}
        {isBlockedByReview ? (
          <div
            role="alert"
            data-testid="chapter-review-blocked-banner"
            className="mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t("novel.chapter.reviewBlockedBannerTitle")}
            </span>
            <button
              type="button"
              data-testid="chapter-go-review-center"
              onClick={() => setActiveView?.("reviewCenter")}
              className="shrink-0 rounded border border-destructive/50 bg-background px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10"
            >
              {t("novel.chapter.goReviewCenter")}
            </button>
          </div>
        ) : null}
        {showInspector ? (
          <InspectorPanel projectPath={inspectorProjectPath} chapterId={inspectorChapterId} refreshKey={inspectorRefreshKey} />
        ) : null}
      </div>
  )
}
