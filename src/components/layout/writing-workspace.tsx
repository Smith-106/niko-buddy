// Copyright © 2024-2099 QAHUI (https://qmai.qimai-im.com/)
// SPDX-License-Identifier: MIT

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PreviewPanel } from "./preview-panel"
import { PdfExportDialog } from "@/components/export/PdfExportDialog"
import { BatchReplacePanel } from "@/components/tools/BatchReplacePanel"
import { splitChapterHeading } from "@/lib/chapter-selection"
import { getFileName, getRelativePath } from "@/lib/path-utils"
import { clampChatHeight, clampChatWidth } from "@/lib/workspace-layout"
import { useWikiStore } from "@/stores/wiki-store"
import { shouldShowRightDockChat, shouldShowWritingChat } from "./chat-layout"

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
  const projectPath = useWikiStore((s) => s.project)?.path ?? ""
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const [chatHeight, setChatHeight] = useState(260)
  const [chatWidth, setChatWidth] = useState(360)
  // 写作工具抽屉：只为「导出 PDF / 批量替换」提供壳层入口，展开不触发任何 IPC
  // （两个面板都只在自己按钮被点时调用命令；批量替换仍走预览 → 写前门 → 人工确认）。
  const [toolsPanel, setToolsPanel] = useState<"pdf" | "batch" | null>(null)

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
    <div className="shrink-0 border-t bg-background" data-testid="workspace-tools-bar">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <button
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
        <span className="truncate text-xs text-muted-foreground" data-testid="workspace-tools-target">
          {selectedFile ? `${chapterTitle} · ${fileName}` : t("workspace.tools.noFile")}
        </span>
      </div>
      {toolsPanel === "pdf" ? (
        <div
          className="max-h-[45vh] overflow-auto border-t"
          data-testid="pdf-export-section"
        >
          <PdfExportDialog projectPath={projectPath} title={chapterTitle} paragraphs={paragraphs} />
        </div>
      ) : null}
      {toolsPanel === "batch" ? (
        <div
          className="max-h-[45vh] overflow-auto border-t"
          data-testid="batch-replace-section"
        >
          <BatchReplacePanel projectPath={projectPath} targets={batchTargets} />
        </div>
      ) : null}
    </div>
  ) : null

  if (shouldShowRightDockChat(chatExpanded, chatDockPosition)) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <PreviewPanel />
          </div>
          <div
            className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
            onMouseDown={startHorizontalResize}
          />
          <div className="h-full min-h-0 shrink-0 overflow-hidden border-l bg-background" style={{ width: chatWidth }}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载中...</div>}>
              <ChatPanel />
            </Suspense>
          </div>
        </div>
        {toolsBar}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-hidden">
        <PreviewPanel />
      </div>
      {shouldShowWritingChat(chatExpanded, chatDockPosition) && (
        <>
          <div
            className="h-1.5 shrink-0 cursor-row-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
            onMouseDown={startResize}
          />
          <div className="shrink-0 overflow-hidden border-t bg-background" style={{ height: chatHeight }}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载中...</div>}>
              <ChatPanel />
            </Suspense>
          </div>
        </>
      )}
      {toolsBar}
    </div>
  )
}
