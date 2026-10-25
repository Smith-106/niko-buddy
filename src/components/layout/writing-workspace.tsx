// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PreviewPanel } from "./preview-panel"
import { PdfExportDialog } from "@/components/export/PdfExportDialog"
import { BatchReplacePanel } from "@/components/tools/BatchReplacePanel"
import { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { splitChapterHeading } from "@/lib/chapter-selection"
import { getFileName, getRelativePath } from "@/lib/path-utils"
import { clampChatHeight, clampChatWidth } from "@/lib/workspace-layout"
import { getFileModifiedTime } from "@/commands/fs"
import { analyzeForeshadowingDebt, getForeshadowingWatermark, loadForeshadowingTracker } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { shouldShowRightDockChat, shouldShowWritingChat } from "./chat-layout"
import { Flame } from "lucide-react"
import { CampaignDashboardDialog } from "@/components/novel/campaign-dashboard-dialog"

const ExportCenterView = lazy(async () => {
  const mod = await import("@/components/novel/export-center-view")
  return { default: mod.ExportCenterView }
})
const ForeshadowingPanel = lazy(async () => {
  const mod = await import("@/components/novel/foreshadowing-panel")
  return { default: mod.ForeshadowingPanel }
})
const SourcesView = lazy(async () => {
  const mod = await import("@/components/sources/sources-view")
  return { default: mod.SourcesView }
})
const SearchView = lazy(async () => {
  const mod = await import("@/components/search/search-view")
  return { default: mod.SearchView }
})
const ChapterDraftDock = lazy(async () => {
  const mod = await import("./chapter-draft-dock")
  return { default: mod.ChapterDraftDock }
})

const ChatPanel = lazy(async () => {
  const mod = await import("@/components/chat/chat-panel")
  return { default: mod.ChatPanel }
})

export function WritingWorkspace() {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const horizontalResizingRef = useRef(false)
  const { t } = useTranslation()
  const chatExpanded = useWikiStore((s) => s.chatExpanded)
  const chatDockPosition = useWikiStore((s) => s.chatDockPosition)
  const focusMode = useWikiStore((s) => s.focusMode)
  const setFocusMode = useWikiStore((s) => s.setFocusMode)
  const [focusAiOpen, setFocusAiOpen] = useState(false)
  const projectPath = useWikiStore((s) => s.project)?.path ?? ""
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const [chatHeight, setChatHeight] = useState(260)
  const [chatWidth, setChatWidth] = useState(360)
  // 写作工具抽屉：只为「导出 PDF / 批量替换」提供壳层入口，展开不触发任何 IPC
  // （两个面板都只在自己按钮被点时调用命令；批量替换仍走预览 → 写前门 → 人工确认）。
  const [toolsPanel, setToolsPanel] = useState<"pdf" | "batch" | "manuscript" | null>(null)
  const [deskTab, setDeskTab] = useState<"outline" | "search" | "foreshadow" | "drafts" | null>(null)
  const [campaignOpen, setCampaignOpen] = useState(false)

  useEffect(() => {
    if (!focusMode) setFocusAiOpen(false)
  }, [focusMode])
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const finalChapterSave = useWikiStore((s) => s.finalChapterSave)

  const chapter = useMemo(() => splitChapterHeading(fileContent), [fileContent])
  const paragraphs = useMemo(
    () =>
      chapter.body
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    [chapter.body],
  )
  const fileName = selectedFile ? getFileName(selectedFile) : ""
  const chapterTitle = chapter.heading.trim() || fileName.replace(/\.md$/i, "") || t("workspace.tools.untitled")
  const chapterHeader = useMemo(
    () => (selectedFile && fileContent ? buildChapterEditorHeader(fileContent) : null),
    [fileContent, selectedFile],
  )
  const matchedSave = finalChapterSave
    && finalChapterSave.filePath === selectedFile
    && finalChapterSave.projectPath === projectPath
    ? finalChapterSave
    : null
  // 伏笔逾期注入通道（foreshadowingAlert coreIssues）：读 tracker 真源 →
  // 水位（panel 甘特同口径）→ debt 分析取 critical/warning 计数；fail-open 无徽标。
  const [foreshadowOverdue, setForeshadowOverdue] = useState<{ critical: number; warning: number } | null>(null)
  useEffect(() => {
    if (!projectPath) {
      setForeshadowOverdue(null)
      return
    }
    let cancelled = false
    void loadForeshadowingTracker(projectPath).then(
      (storeData) => {
        if (cancelled) return
        const watermark = getForeshadowingWatermark(storeData.items)
        const report = analyzeForeshadowingDebt(storeData, watermark)
        setForeshadowOverdue({ critical: report.criticalCount, warning: report.warningCount })
      },
      () => {
        if (!cancelled) setForeshadowOverdue(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectPath, dataVersion])
  // 本地时间机器指示：所选文件的真实 mtime（fail-open：读不到就不显示，不伪造）。
  const [snapshotMtime, setSnapshotMtime] = useState<number | null>(null)
  useEffect(() => {
    if (!selectedFile) {
      setSnapshotMtime(null)
      return
    }
    let cancelled = false
    void getFileModifiedTime(selectedFile).then(
      (ms) => {
        if (!cancelled) setSnapshotMtime(Number.isFinite(ms) ? ms : null)
      },
      () => {
        if (!cancelled) setSnapshotMtime(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [selectedFile])
  const saveLabel = matchedSave?.saving
    ? t("novel.chapter.savingAsFinal")
    : matchedSave?.phase === "saved" || matchedSave?.phase === "ingested"
      ? t("novel.chapter.savedAsFinal")
      : chapterHeader?.statusLabel
  // PDF 确认门与批量替换共用同一相对化契约：导出前按该相对路径读回章节磁盘内容断言 final（门禁 1）。
  // BatchReplacePanel 的契约是**项目相对路径**：复用既有 getRelativePath（已含尾斜杠/分隔符处理）。
  const batchTargets = useMemo(
    () => (selectedFile ? [getRelativePath(selectedFile, projectPath)] : []),
    [selectedFile, projectPath],
  )

  useEffect(() => {
    const saved = Number(localStorage.getItem("lk-chat-height") ?? "260")
    if (Number.isFinite(saved) && saved > 0) {
      setChatHeight(clampChatHeight(saved))
    }
    const savedWidth = Number(localStorage.getItem("lk-chat-right-width") ?? "360")
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      setChatWidth(clampChatWidth(savedWidth))
    }
  }, [])

  useEffect(() => {
    localStorage.setItem("lk-chat-height", String(chatHeight))
  }, [chatHeight])

  useEffect(() => {
    localStorage.setItem("lk-chat-right-width", String(chatWidth))
  }, [chatWidth])

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizingRef.current = true
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    document.body.dataset.panelResizing = "true"

    const handleMouseMove = (nextEvent: MouseEvent) => {
      if (!resizingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const nextHeight = rect.bottom - nextEvent.clientY
      setChatHeight(clampChatHeight(nextHeight))
    }

    const handleMouseUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      delete document.body.dataset.panelResizing
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
  }, [])

  const startHorizontalResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    horizontalResizingRef.current = true
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.body.dataset.panelResizing = "true"

    const handleMouseMove = (nextEvent: MouseEvent) => {
      if (!horizontalResizingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const nextWidth = rect.right - nextEvent.clientX
      setChatWidth(clampChatWidth(nextWidth))
    }

    const handleMouseUp = () => {
      horizontalResizingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      delete document.body.dataset.panelResizing
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
  }, [])

  const toolsBar = projectPath ? (
    <div className="relative shrink-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80" data-testid="workspace-tools-bar">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-1.5 px-3 py-1.5">
        <button
          type="button"
          data-testid="workspace-zen-toggle"
          aria-pressed={focusMode}
          title={t("layout.focusMode.label", { defaultValue: "专注模式 (Zen)" })}
          className="rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-accent/60"
          onClick={() => setFocusMode?.(!focusMode)}
        >
          {focusMode ? t("layout.focusMode.exit", { defaultValue: "退出专注" }) : t("layout.focusMode.enter", { defaultValue: "专注" })}
        </button>
        {!focusMode && <><button
          type="button"
          data-testid="workspace-tools-toggle-pdf"
          aria-pressed={toolsPanel === "pdf"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setToolsPanel((current) => (current === "pdf" ? null : "pdf"))}
        >
          {t("workspace.tools.exportPdf")}
        </button>
        <button
          type="button"
          data-testid="workspace-tools-toggle-batch"
          aria-pressed={toolsPanel === "batch"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setToolsPanel((current) => (current === "batch" ? null : "batch"))}
        >
          {t("workspace.tools.batchReplace")}
        </button>
        <button
          type="button"
          data-testid="workspace-tools-toggle-campaign"
          className="inline-flex items-center gap-1.5 rounded border border-orange-500/30 bg-orange-500/10 px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-500/20 dark:text-orange-400"
          onClick={() => setCampaignOpen(true)}
        >
          <Flame className="h-3 w-3 text-orange-500" />
          <span>长程战役调度</span>
        </button>
        <button
          type="button"
          data-testid="workspace-tools-toggle-manuscript"
          aria-pressed={toolsPanel === "manuscript"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setToolsPanel((current) => (current === "manuscript" ? null : "manuscript"))}
        >
          导出书稿
        </button>
        <button
          type="button"
          data-testid="workspace-desk-outline"
          aria-pressed={deskTab === "outline"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "outline" ? null : "outline"))}
        >
          大纲
        </button>
        <button
          type="button"
          data-testid="workspace-desk-search"
          aria-pressed={deskTab === "search"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "search" ? null : "search"))}
        >
          搜索
        </button>
        <button
          type="button"
          data-testid="workspace-desk-foreshadow"
          aria-pressed={deskTab === "foreshadow"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "foreshadow" ? null : "foreshadow"))}
        >
          本章伏笔
        </button>
        <button
          type="button"
          data-testid="workspace-desk-drafts"
          aria-pressed={deskTab === "drafts"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "drafts" ? null : "drafts"))}
        >
          本章草稿
        </button></>}
        <span className="truncate text-xs text-muted-foreground" data-testid="workspace-tools-target">
          {selectedFile
            ? `${chapterTitle} · ${fileName}${chapterHeader ? ` · ${chapterHeader.wordCountLabel}` : ""}${saveLabel ? ` · ${saveLabel}` : ""}${snapshotMtime ? ` · 本地快照 ${new Date(snapshotMtime).toLocaleString()}` : ""}`
            : t("workspace.tools.noFile")}
        </span>
        {foreshadowOverdue && foreshadowOverdue.critical + foreshadowOverdue.warning > 0 ? (
          <button
            type="button"
            data-testid="workspace-foreshadow-alert"
            title="打开伏笔面板查看逾期明细"
            onClick={() => setDeskTab("foreshadow")}
            className="shrink-0 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning hover:bg-warning/20"
          >
            {`伏笔逾期 ${foreshadowOverdue.critical + foreshadowOverdue.warning}（严重${foreshadowOverdue.critical}）`}
          </button>
        ) : null}
      </div>
      {!focusMode && toolsPanel === "pdf" ? (
        <div
          className="max-h-[40%] overflow-auto border-t"
          data-testid="pdf-export-section"
        >
          <PdfExportDialog projectPath={projectPath} title={chapterTitle} paragraphs={paragraphs} chapterPath={selectedFile ? getRelativePath(selectedFile, projectPath) : undefined} />
        </div>
      ) : null}
      {!focusMode && toolsPanel === "batch" ? (
        <div
          className="max-h-[40%] overflow-auto border-t"
          data-testid="batch-replace-section"
        >
          <BatchReplacePanel projectPath={projectPath} targets={batchTargets} />
        </div>
      ) : null}
      {!focusMode && toolsPanel === "manuscript" ? (
        <div className="max-h-[40%] overflow-auto border-t" data-testid="manuscript-export-section">
          <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">加载中...</div>}>
            <ExportCenterView projectPath={projectPath} />
          </Suspense>
        </div>
      ) : null}
    </div>
  ) : null

  const chapterDock = !focusMode && deskTab ? (
    <aside className="h-full w-80 shrink-0 overflow-auto border-l bg-background" data-testid="workspace-chapter-dock">
      <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">加载中...</div>}>
        {deskTab === "outline" ? <SourcesView /> : null}
        {deskTab === "search" ? (
          <SearchView
            onClose={() => setDeskTab(null)}
            onOpenFile={(payload) => {
              setSelectedFile(payload.path)
              setActiveView("wiki")
            }}
          />
        ) : null}
        {deskTab === "foreshadow" ? <ForeshadowingPanel /> : null}
        {deskTab === "drafts" ? (
          <ChapterDraftDock
            projectPath={projectPath}
            selectedFile={selectedFile}
            onAdopted={(path) => {
              setSelectedFile(path)
              setActiveView("wiki")
            }}
          />
        ) : null}
      </Suspense>
    </aside>
  ) : null

  const focusStrip = focusMode ? (
    <div
      data-testid="focus-ai-strip"
      className="flex h-8 shrink-0 items-center justify-between gap-2 border-t px-3 text-xs"
    >
      <span className="truncate text-muted-foreground">
        {t("layout.focusMode.status", { defaultValue: "专注中，侧栏与工具已收起" })}
        {selectedFile ? ` · ${chapterTitle}` : ""}
      </span>
      <button
        type="button"
        data-testid="focus-ai-toggle"
        className="shrink-0 rounded px-2 py-0.5 text-foreground hover:bg-accent"
        aria-pressed={focusAiOpen}
        onClick={() => setFocusAiOpen((open) => !open)}
      >
        {t(focusAiOpen ? "layout.focusMode.hideAi" : "layout.focusMode.showAi", {
          defaultValue: focusAiOpen ? "收起 AI" : "AI 上下文",
        })}
      </button>
    </div>
  ) : null
  const showBottomChat = focusMode ? focusAiOpen : shouldShowWritingChat(chatExpanded, chatDockPosition)
  const showRightChat = !focusMode && shouldShowRightDockChat(chatExpanded, chatDockPosition)

  if (showRightChat) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <PreviewPanel />
          </div>
          {chapterDock}
          <div
            className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
            onMouseDown={startHorizontalResize}
          />
          <div className="h-full min-h-0 shrink-0 overflow-hidden border-l bg-background" style={{ width: chatWidth }}>
            <Suspense
              fallback={
                <div
                  className="flex h-full items-center justify-center text-sm text-muted-foreground"
                  data-testid="chat-panel-loading"
                >
                  加载中...
                </div>
              }
            >
              <ChatPanel />
            </Suspense>
          </div>
        </div>
        {toolsBar}
        <CampaignDashboardDialog open={campaignOpen} onOpenChange={setCampaignOpen} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={focusMode ? "flex min-w-0 flex-1 justify-center overflow-auto bg-muted/20" : "min-w-0 flex-1 overflow-hidden"}>
          <div className={focusMode ? "w-full max-w-4xl px-6 py-4" : "h-full w-full"}>
            <PreviewPanel />
          </div>
        </div>
        {chapterDock}
      </div>
      {toolsBar}
      {focusStrip}
      {showBottomChat && (
        <>
          <div
            className="h-1.5 shrink-0 cursor-row-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
            onMouseDown={startResize}
          />
          <div className="shrink-0 overflow-hidden border-t bg-background" style={{ height: chatHeight }}>
            <Suspense
              fallback={
                <div
                  className="flex h-full items-center justify-center text-sm text-muted-foreground"
                  data-testid="chat-panel-loading"
                >
                  加载中...
                </div>
              }
            >
              <ChatPanel />
            </Suspense>
          </div>
        </>
      )}
      <CampaignDashboardDialog open={campaignOpen} onOpenChange={setCampaignOpen} />
    </div>
  )
}
