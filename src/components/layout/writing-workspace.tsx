// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PreviewPanel, type PreviewPanelAdoptionStart, type PreviewPanelWriteGate } from "./preview-panel"
import { ChapterAdoptionUnavailableError, getChapterWriteCoordinator } from "./preview-panel-helpers"
import { PdfExportDialog } from "@/components/export/PdfExportDialog"
import { BatchReplacePanel } from "@/components/tools/BatchReplacePanel"
import { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { splitChapterHeading } from "@/lib/chapter-selection"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { clampChatHeight, clampChatWidth } from "@/lib/workspace-layout"
import { getFileModifiedTime } from "@/commands/fs"
import { analyzeForeshadowingDebt, acceptDraftAndIngest, createMainControlAcceptSeam, getForeshadowingWatermark, loadForeshadowingTracker } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { shouldShowRightDockChat, shouldShowWritingChat } from "./chat-layout"
import { Flame } from "lucide-react"
import { CampaignDashboardDialog } from "@/components/novel/campaign-dashboard-dialog"
import { buildChapterDraftGoal, setMainControlGoalHandoff, setMainControlTabHandoff } from "@/components/novel/main-control-handoff"
import { DraftsToggleButton, GenerateDraftButton, WorkspaceMoreTools, usePendingDraftCount } from "./writing-workspace-widgets"
import type { ChapterDraftDockAdoptAndIngest } from "./chapter-draft-dock"
import { ResizeSplitter } from "@/components/ui/resize-splitter"

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
  // G2：采纳后按设置回填记忆所需的配置（判定本身归 accept-draft-with-ingest.ts，这里只透传）。
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)

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
    && selectedFile !== null
    && normalizePath(finalChapterSave.filePath) === normalizePath(selectedFile)
    && normalizePath(finalChapterSave.projectPath) === normalizePath(projectPath)
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
  }, [selectedFile, dataVersion])
  // 草稿状态徽标（批次二·6）：待采纳数随 dataVersion 与采纳动作刷新。
  const [draftReloadKey, setDraftReloadKey] = useState(0)
  // G2-NATIVE-F1：采纳专用刷新令牌。采纳把正式正文写回**当前选中的同一个文件**时
  // selectedFile identity 不变，只看选中路径的装载 effect 不会重跑（编辑区留旧正文）。
  // token 与 path 同批更新：path 指认这次采纳写入的正式章，只有它等于当前选中文件才重载。
  const [chapterAdoptionRefresh, setChapterAdoptionRefresh] = useState({ token: 0, path: "" })
  // 编辑区的同文件写入门（由 PreviewPanel 挂载时登记）：正式采纳写入之前先静默它的写盘。
  const previewWriteGateRef = useRef<PreviewPanelWriteGate | null>(null)
  const adoptionOwnerRef = useRef<object>({})
  const adoptionCoordinator = getChapterWriteCoordinator()
  useEffect(() => {
    const owner = adoptionOwnerRef.current
    // 真正离开写作台取消准备态；已经准入的 accept/read 只在实际 I/O 落定后释放。
    return () => { adoptionCoordinator.releaseOwnedAdoptions(owner) }
  }, [adoptionCoordinator])
  const pendingDraftCount = usePendingDraftCount(projectPath, `${dataVersion}:${draftReloadKey}`)
  const openMainControlForDraft = useCallback(() => {
    setMainControlGoalHandoff(buildChapterDraftGoal(selectedFile ? chapterTitle : ""))
    setActiveView("mainControl")
  }, [chapterTitle, selectedFile, setActiveView])
  const openMainControlGateRerun = useCallback(() => {
    setMainControlTabHandoff("live")
    setActiveView("mainControl")
  }, [setActiveView])
  // G2：普通写作台的「采纳即回填」只做装配——accept seam 复用主控同一个装配器
  // （底层仍是 acceptChapterDraft，confirmed 由第二步确认给出），
  // 顺序/降级分类/四态判定全部由组合函数持有，本层不复制业务规则。
  const adoptDraftAndIngest = useCallback<ChapterDraftDockAdoptAndIngest>(
    async (input) =>
      acceptDraftAndIngest({
        projectPath: input.projectPath,
        formalChapterPath: input.formalChapterPath,
        accept: async (formalChapterPath) => {
          // 正式采纳写入之前先静默同一文件上的编辑器写盘：作废待写盘、确认旧输入已关闭、
          // 并等该目标**全部**已准入的真实 I/O 落定（不是单槽最后一笔）。
          // 否则任一旧写盘都可能落在采纳之后，把刚采纳的正文覆盖回去。
          const gate = previewWriteGateRef.current
          const start: PreviewPanelAdoptionStart = gate
            ? await gate.begin(formalChapterPath, adoptionOwnerRef.current)
            : { status: "idle", lease: null }
          if (start.status === "blocked") {
            if (start.reason === "busy") throw new Error("该章节还有一次采纳正在落盘，请稍后重试")
            throw new ChapterAdoptionUnavailableError(start.reason, start.relocation ?? null)
          }
          let lease = start.lease
          // 缺省/旧可选门也沿用同一协调器，不另造一条采纳写路径。
          if (!lease) {
            const begin = adoptionCoordinator.beginAdoption(formalChapterPath, adoptionOwnerRef.current)
            if (!begin.ok) throw new Error("该章节还有一次采纳正在落盘，请稍后重试")
            lease = begin.lease!
            await begin.admittedTail
          }
          try {
            const accepted = adoptionCoordinator.runAdoption(lease, () => createMainControlAcceptSeam({
              projectPath: input.projectPath,
              draftId: input.draftId,
              // 第二步确认：仍转调原 acceptChapterDraft；迁移由 runAdoption 中止，不重定向参数。
              confirmed: true,
              expectedDraftContent: input.expectedDraftContent,
            })(formalChapterPath))
            // 此刻是 writing 态：这里只登记释放意图，真实 accept/read 落定前不能解锁。
            adoptionCoordinator.releaseAdoption(lease)
            await accepted
          } catch (error) {
            gate?.abort(start)
            adoptionCoordinator.releaseAdoption(lease)
            throw error
          }
          // 落盘已确认：立即让编辑区对齐权威正文（不等可能很慢的 ingest/onAdopted）。
          // 刷新放在这一步而不是 onAdopted：回填可能跑很久，那之后用户已经接着写作，
          // 再刷新会冲掉新写的内容。
          setChapterAdoptionRefresh((current) => ({ token: current.token + 1, path: formalChapterPath }))
          // 落盘回执：之后 ingest 抛错不得被当成「采纳失败」。
          input.onAcceptSettled?.()
        },
        novelConfig,
        llmConfig,
      }),
    [novelConfig, llmConfig, adoptionCoordinator],
  )
  const isFinalChapterLoaded = chapterHeader?.status === "final"
  const saveLabel = matchedSave?.saving
    ? t("novel.chapter.savingAsFinal")
    : (matchedSave?.phase === "saved" || matchedSave?.phase === "ingested") && isFinalChapterLoaded
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

  const resolveBottomChatHeight = useCallback(({ clientY }: { clientY: number }) => {
    if (!containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    return clampChatHeight(rect.bottom - clientY)
  }, [])

  const resolveRightChatWidth = useCallback(({ clientX }: { clientX: number }) => {
    if (!containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    return clampChatWidth(rect.right - clientX)
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
        {!focusMode && <><GenerateDraftButton onClick={openMainControlForDraft} />
        <DraftsToggleButton
          pressed={deskTab === "drafts"}
          pendingCount={pendingDraftCount}
          onClick={() => setDeskTab((current) => (current === "drafts" ? null : "drafts"))}
        />
        <button
          type="button"
          data-testid="workspace-desk-outline"
          aria-pressed={deskTab === "outline"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "outline" ? null : "outline"))}
        >
          {t("workspace.tools.outline", { defaultValue: "大纲" })}
        </button>
        <button
          type="button"
          data-testid="workspace-desk-search"
          aria-pressed={deskTab === "search"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "search" ? null : "search"))}
        >
          {t("workspace.tools.search", { defaultValue: "搜索" })}
        </button>
        <button
          type="button"
          data-testid="workspace-desk-foreshadow"
          aria-pressed={deskTab === "foreshadow"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setDeskTab((current) => (current === "foreshadow" ? null : "foreshadow"))}
        >
          {t("workspace.tools.foreshadow", { defaultValue: "本章伏笔" })}
        </button>
        <WorkspaceMoreTools active={toolsPanel !== null}>
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
        <button
          type="button"
          data-testid="workspace-tools-toggle-manuscript"
          aria-pressed={toolsPanel === "manuscript"}
          className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setToolsPanel((current) => (current === "manuscript" ? null : "manuscript"))}
        >
          {t("workspace.tools.exportManuscript", { defaultValue: "导出书稿" })}
        </button>
        <button
          type="button"
          data-testid="workspace-tools-toggle-campaign"
          className="inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent/50"
          onClick={() => setCampaignOpen(true)}
        >
          <Flame className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <span>{t("workspace.tools.campaign", { defaultValue: "长程战役调度" })}</span>
        </button>
        </WorkspaceMoreTools></>}
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
            className="shrink-0 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning-foreground hover:bg-warning/20"
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
      {/* Q14-A：Dock 级连续性呼吸灯 —— 复用 toolsBar 同源 foreshadowOverdue 计数，
          critical 红点脉冲、仅 warning 琥珀常亮；无逾期时整条不渲染（fail-open 不伪造）。 */}
      {foreshadowOverdue && foreshadowOverdue.critical + foreshadowOverdue.warning > 0 ? (
        <div
          className="flex items-center gap-2 border-b px-2 py-1.5 text-xs"
          data-testid="workspace-dock-continuity-dot"
          data-severity={foreshadowOverdue.critical > 0 ? "critical" : "warning"}
        >
          <span
            aria-hidden="true"
            className={
              foreshadowOverdue.critical > 0
                ? "h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive"
                : "h-2 w-2 shrink-0 rounded-full bg-warning"
            }
          />
          <span className="min-w-0 truncate text-muted-foreground">
            {`连续性告警 严重${foreshadowOverdue.critical} · 提示${foreshadowOverdue.warning}`}
          </span>
        </div>
      ) : null}
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
            alerts={foreshadowOverdue}
            onAdopted={(path) => {
              setDraftReloadKey((key) => key + 1)
              setSelectedFile(path)
              setActiveView("wiki")
            }}
            onGenerateDraft={openMainControlForDraft}
            onOpenMemory={() => setActiveView("lint")}
            onOpenGateRerun={openMainControlGateRerun}
            adoptAndIngest={adoptDraftAndIngest}
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

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={focusMode ? "flex min-w-0 flex-1 justify-center overflow-auto bg-muted/20" : "min-w-0 flex-1 overflow-hidden"}>
          <div className={focusMode ? "w-full max-w-4xl px-6 py-4" : "h-full w-full"}>
            <PreviewPanel
              adoptionRefreshToken={chapterAdoptionRefresh.token}
              adoptionRefreshPath={chapterAdoptionRefresh.path}
              writeGateRef={previewWriteGateRef}
            />
          </div>
        </div>
        {chapterDock}
        {showRightChat && (
          <>
            <ResizeSplitter
              orientation="vertical"
              value={chatWidth}
              min={280}
              max={520}
              invertDrag
              ariaLabel={t("workspace.resizeRightChat", { defaultValue: "调整右侧对话栏宽度" })}
              resolveDragValue={resolveRightChatWidth}
              onChange={setChatWidth}
            />
            <div className="h-full min-h-0 shrink-0 overflow-hidden border-l bg-background" style={{ width: chatWidth }}>
              <Suspense
                fallback={
                  <div
                    className="flex h-full items-center justify-center text-sm text-muted-foreground"
                    data-testid="chat-panel-loading"
                  >
                    {t("common.loading", { defaultValue: "加载中..." })}
                  </div>
                }
              >
                <ChatPanel />
              </Suspense>
            </div>
          </>
        )}
      </div>
      {toolsBar}
      {focusStrip}
      {showBottomChat && (
        <>
          <ResizeSplitter
            orientation="horizontal"
            value={chatHeight}
            min={180}
            max={520}
            invertDrag
            ariaLabel={t("workspace.resizeBottomChat", { defaultValue: "调整底部对话区高度" })}
            resolveDragValue={resolveBottomChatHeight}
            onChange={setChatHeight}
          />
          <div className="shrink-0 overflow-hidden border-t bg-background" style={{ height: chatHeight }}>
            <Suspense
              fallback={
                <div
                  className="flex h-full items-center justify-center text-sm text-muted-foreground"
                  data-testid="chat-panel-loading"
                >
                  {t("common.loading", { defaultValue: "加载中..." })}
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
