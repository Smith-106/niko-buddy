// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  BookText,
  Brain,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  GitBranchPlus,
  Plus,
  RefreshCw,
  Sparkles,
  Users,
  Wand2,
} from "lucide-react"
import { countMemoryFileEntries, getExistingChapterTitles, getUniqueWikiPagePath, MEMORY_LABEL_KEYS, resolveSidebarMode, type PendingPageInfo } from "./sidebar-helpers"
import { MemoryCenterListButton, SearchHistoryPanel } from "./sidebar-panels"
import { KnowledgeTree, RawSourcesSection, type KnowledgeCreateRequest } from "./knowledge-tree"
import { TrashPanel } from "./trash-panel"
import { GraphSidebarPanel } from "./graph-sidebar-panel"
import { SoulSidebarPanel } from "./soul-sidebar-panel"
import { DirectorSidebarPanel } from "./director-sidebar-panel"
import { UnifiedSkillLibrarySidebarPanel } from "@/components/skill-library/unified-skill-library-view"
import { ReviewCenterSidebarPanel } from "./review-center-sidebar-panel"
import { BookAnalysisSidebarPanel } from "./book-analysis-sidebar-panel"
import { AutonomousIncubatorDialog } from "@/components/novel/autonomous-incubator-dialog"

import { useWikiStore } from "@/stores/wiki-store"
import { flattenMdFiles, getNextChapterNumber, invalidateChapterCache } from "@/lib/novel"
import type { MemoryCenterData } from "@/lib/novel"
import { createDirectory, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { countChapterBodyWords } from "@/lib/chapter-word-count"
import { buildChapterTotalWordCountLabel } from "@/lib/chapter-display"
import { normalizePath } from "@/lib/path-utils"
import { Button } from "@/components/ui/button"
import { PanelHeaderWithHelp } from "@/components/layout/panel-header-with-help"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { makeChapterFileName, makeDefaultChapterTitle, makeSafeFileSlug } from "@/lib/wiki-filename"
import { useSidebarImport } from "./sidebar-panel-import"
import { openExternalUrl } from "@/lib/open-external-url"
import { toErrorMessage } from "@/lib/utils"

const USAGE_GUIDE_URL = "https://tcnk9ik08e1c.feishu.cn/wiki/FWiSwYQKoifpwBk6mSRcSlB8nrh?from=from_copylink"



const MEMORY_ICONS: Record<string, typeof Users> = {
  snapshots: FileText,
  "character-states": Users,
  "character-cognition": Brain,
  "foreshadowing-tracker": Sparkles,
  timeline: Clock3,
  "canon-facts": BookText,
  conflicts: GitBranchPlus,
}



export function SidebarPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const novelMode = useWikiStore((s) => s.novelMode)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const selectedMemoryCenterEntry = useWikiStore((s) => s.selectedMemoryCenterEntry)
  const setSelectedMemoryCenterEntry = useWikiStore((s) => s.setSelectedMemoryCenterEntry)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const chapterCreateNonce = useWikiStore((s) => s.chapterCreateNonce)
  const chapterCreateSeen = useRef<number | null>(null)
  const [mode, setMode] = useState<"knowledge" | "files">("knowledge")
  const [refreshKey, setRefreshKey] = useState(0)
  const [pendingCreate, setPendingCreate] = useState<KnowledgeCreateRequest | null>(null)
  const [inputTitle, setInputTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [pendingPages, setPendingPages] = useState<PendingPageInfo[]>([])
  const [memoryData, setMemoryData] = useState<MemoryCenterData | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [sidebarTotalWordCount, setSidebarTotalWordCount] = useState<number | null>(null)
  const [sidebarWordCountFailed, setSidebarWordCountFailed] = useState(0)
  const [incubatorOpen, setIncubatorOpen] = useState(false)

  const loadMemoryCenter = useCallback(async (projectPath: string) => {
    const { loadMemoryCenterData } = await import("@/lib/novel/memory-center")
    return loadMemoryCenterData(projectPath)
  }, [])

  function cancelPendingCreate() {
    setPendingCreate(null)
    setInputTitle("")
  }

  useEffect(() => {
    const next = resolveSidebarMode(activeView, selectedFile)
    if (next) setMode(next)
  }, [activeView, selectedFile])

  const isChapter = mode === "knowledge"

  useEffect(() => {
    if (!project || !isChapter) {
      setSidebarTotalWordCount(null)
      setSidebarWordCountFailed(0)
      return
    }

    let cancelled = false

    const loadSidebarTotalWordCount = async () => {
      try {
        const chapterNodes = await listDirectory(`${normalizePath(project.path)}/wiki/chapters`)
        const files = flattenMdFiles(chapterNodes)
        const contents = await Promise.all(files.map((file) => readFile(file.path).catch(() => null)))
        const failed = contents.filter((c) => c === null).length
        const total = contents.reduce((sum, markdown) => sum + countChapterBodyWords(markdown ?? ""), 0)
        if (!cancelled) {
          setSidebarTotalWordCount(total)
          setSidebarWordCountFailed(failed)
        }
      } catch {
        if (!cancelled) {
          setSidebarTotalWordCount(null)
          setSidebarWordCountFailed(0)
        }
      }
    }

    void loadSidebarTotalWordCount()

    return () => {
      cancelled = true
    }
  }, [dataVersion, isChapter, project])

  useEffect(() => {
    if (!pendingCreate?.kind) return
    if (isChapter && (pendingCreate.kind === "outline" || pendingCreate.kind === "folder")) {
      cancelPendingCreate()
    }
    if (!isChapter && pendingCreate.kind === "volume") {
      cancelPendingCreate()
    }
  }, [isChapter, pendingCreate?.kind])

  const handleRemovePendingPage = (pagePath: string) => {
    setPendingPages((prev) => prev.filter((page) => page.path !== pagePath))
  }

  async function refreshTree(projectPath: string, selectedPath?: string) {
    const tree = await listDirectory(projectPath)
    setFileTree(tree)
    useWikiStore.getState().bumpDataVersion()
    setRefreshKey((current) => current + 1)
    if (selectedPath) setSelectedFile(selectedPath)
  }

  const {
    outlineImporting,
    outlineImportMenuOpen,
    setOutlineImportMenuOpen,
    outlineImportMenuRef,
    chapterImporting,
    chapterImportMenuOpen,
    setChapterImportMenuOpen,
    chapterImportMenuRef,
    memoryDecisionRequest,
    closeMemoryDecision,
    handleCancelImportMemoryExtraction,
    handleImportChapterFiles,
    handleImportChapterFolder,
    handleImportOutlineFiles,
    handleImportOutlineFolder,
  } = useSidebarImport({ refreshTree })

  useEffect(() => {
    if (isChapter) {
      setOutlineImportMenuOpen(false)
    } else {
      setChapterImportMenuOpen(false)
    }
  }, [isChapter, setOutlineImportMenuOpen, setChapterImportMenuOpen])

  async function handleCreateNextChapter(parentDir?: string) {
    if (!project) return
    setCreating(true)
    try {
      const projectPath = normalizePath(project.path)
      const chaptersRoot = `${projectPath}/wiki/chapters`
      const targetDir = parentDir ?? chaptersRoot
      await createDirectory(chaptersRoot).catch((err) => { console.warn("[sidebar] ignored error:", err) })
      await createDirectory(targetDir).catch((err) => { console.warn("[sidebar] ignored error:", err) })

      const existingTitles = await getExistingChapterTitles(projectPath)
      let nextNumber = await getNextChapterNumber(projectPath)
      while (existingTitles.has(makeDefaultChapterTitle(nextNumber))) {
        nextNumber += 1
      }

      const title = makeDefaultChapterTitle(nextNumber)
      const filePath = await getUniqueWikiPagePath(targetDir, makeChapterFileName(title, nextNumber))
      const content = [
        "---",
        "type: chapter",
        `title: "${title}"`,
        `chapter_number: ${nextNumber}`,
        "chapter_status: draft",
        "---",
        "",
        `# ${title}`,
        "",
      ].join("\n")

      await writeFileAtomic(filePath, content)
      invalidateChapterCache(projectPath)
      setPendingPages((prev) => [
        { path: filePath, title, type: "chapter", tags: [] },
        ...prev.filter((page) => page.path !== filePath),
      ])
      await refreshTree(projectPath, filePath)
    } catch (error) {
      console.error("[SidebarPanel] auto chapter create failed:", error)
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateFromInput() {
    if (!project || !pendingCreate || !inputTitle.trim()) return
    setCreating(true)
    try {
      const projectPath = normalizePath(project.path)
      const title = inputTitle.trim()

      if (pendingCreate.kind === "outline") {
        const outlinesRoot = `${projectPath}/wiki/outlines`
        const targetDir = pendingCreate.parentDir ?? outlinesRoot
        await createDirectory(outlinesRoot).catch((err) => { console.warn("[sidebar] ignored error:", err) })
        await createDirectory(targetDir).catch((err) => { console.warn("[sidebar] ignored error:", err) })
        const filePath = await getUniqueWikiPagePath(targetDir, `${makeSafeFileSlug(title)}.md`)
        const content = [
          "---",
          "type: outline",
          `title: "${title.replace(/"/g, '\\"')}"`,
          "---",
          "",
          `# ${title}`,
          "",
        ].join("\n")
        await writeFileAtomic(filePath, content)
        setPendingPages((prev) => [
          { path: filePath, title, type: "outline", tags: [] },
          ...prev.filter((page) => page.path !== filePath),
        ])
        await refreshTree(projectPath, filePath)
      } else {
        const baseDir = pendingCreate.parentDir
          ?? `${projectPath}/wiki/${pendingCreate.kind === "volume" ? "chapters" : "outlines"}`
        await createDirectory(baseDir).catch((err) => { console.warn("[sidebar] ignored error:", err) })
        const folderPath = `${baseDir}/${makeSafeFileSlug(title)}`
        await createDirectory(folderPath)
        await refreshTree(projectPath)
      }

      setPendingCreate(null)
      setInputTitle("")
    } catch (error) {
      console.error("[SidebarPanel] create failed:", error)
    } finally {
      setCreating(false)
    }
  }

  function beginCreate(request: KnowledgeCreateRequest) {
    if (request.kind === "chapter") {
      void handleCreateNextChapter(request.parentDir)
      return
    }
    setPendingCreate(request)
    setInputTitle("")
  }

  // 空态「新建章节」跨面板触发：nonce +1 即复用已有创建链路（含编号/落盘/选中）。
  useEffect(() => {
    if (chapterCreateSeen.current === chapterCreateNonce) return
    const firstMount = chapterCreateSeen.current === null
    chapterCreateSeen.current = chapterCreateNonce
    if (!project) return
    if (firstMount && chapterCreateNonce === 0) return
    void handleCreateNextChapter()
  }, [chapterCreateNonce, project])

  const inputPlaceholder = pendingCreate?.kind === "outline"
    ? t("sidebar.newOutlinePrompt")
    : pendingCreate?.kind === "volume"
      ? t("sidebar.newVolumePrompt")
      : pendingCreate?.kind === "folder"
        ? t("sidebar.newFolderPrompt")
        : ""

  useEffect(() => {
    if (!(activeView === "lint" && novelMode)) return
    setSelectedMemoryCenterEntry(null)
  }, [activeView, novelMode, setSelectedMemoryCenterEntry])

  useEffect(() => {
    if (!(activeView === "lint" && novelMode)) return
    if (selectedMemoryCenterEntry !== "dismantling-library") return
    setSelectedMemoryCenterEntry(null)
  }, [activeView, novelMode, selectedMemoryCenterEntry, setSelectedMemoryCenterEntry])

  useEffect(() => {
    if (!(activeView === "lint" && novelMode) || !project?.path) {
      setMemoryData(null)
      setMemoryError(null)
      setMemoryLoading(false)
      return
    }

    let cancelled = false
    setMemoryLoading(true)
    setMemoryError(null)

    void loadMemoryCenter(project.path)
      .then((nextData) => {
        if (cancelled) return
        setMemoryData(nextData)
      })
      .catch((err) => {
        if (cancelled) return
        const message = toErrorMessage(err)
        setMemoryError(message)
      })
      .finally(() => {
        if (cancelled) return
        setMemoryLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeView, loadMemoryCenter, novelMode, project?.path])

  if (activeView === "graph") {
    return <GraphSidebarPanel />
  }

  if (activeView === "director") {
    return <DirectorSidebarPanel />
  }

  if (activeView === "soul") {
    return <SoulSidebarPanel />
  }

  if (activeView === "skillLibrary" || activeView === "writingSkillLibrary" || activeView === "skillFavorites") {
    return <UnifiedSkillLibrarySidebarPanel />
  }

  if (activeView === "reviewCenter") {
    return <ReviewCenterSidebarPanel />
  }

  if (activeView === "bookAnalysis") {
    return <BookAnalysisSidebarPanel />
  }

  if (activeView === "search") {
    return <SearchHistoryPanel />
  }

  if (activeView === "trash") {
    return <TrashPanel />
  }

  if (activeView === "lint" && novelMode) {
    const fileMap = new Map(memoryData?.files.map((file) => [file.key, file]) ?? [])
    const entries = Object.keys(MEMORY_LABEL_KEYS).filter((key) => key !== "dismantling-library").map((key) => {
      if (key === "snapshots") {
        return {
          key,
          label: t(MEMORY_LABEL_KEYS[key]),
          count: memoryData?.stats.snapshotCount ?? 0,
          icon: MEMORY_ICONS[key] ?? FileText, /* v8 ignore start */ /* v8 ignore stop */
          disabled: (memoryData?.snapshots.length ?? 0) === 0,
        }
      }

      const file = fileMap.get(key)
      return {
        key,
        label: t(MEMORY_LABEL_KEYS[key]),
        count: countMemoryFileEntries(file),
        icon: MEMORY_ICONS[key] ?? FileText, /* v8 ignore start */ /* v8 ignore stop */
        disabled: !file,
      }
    })

    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
          <PanelHeaderWithHelp title={t("novel.memoryCenter.title")} helpKey="memory" />
        </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => {
              if (!project?.path) return
              setMemoryLoading(true)
              setMemoryError(null)
              void loadMemoryCenter(project.path)
                .then((nextData) => setMemoryData(nextData))
                .catch((err) => {
                  const message = toErrorMessage(err)
                  setMemoryError(message)
                })
                .finally(() => setMemoryLoading(false))
            }}
            disabled={memoryLoading}
            title={t("novel.memoryCenter.refresh")}
          >
            <RefreshCw className={`h-4 w-4 ${memoryLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-3">
          {memoryError ? (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {memoryError}
            </div>
          ) : null}

          {memoryLoading && !memoryData ? (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t("novel.memoryCenter.loading")}
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <MemoryCenterListButton
                  key={entry.key}
                  label={entry.label}
                  count={entry.count}
                  selected={selectedMemoryCenterEntry === entry.key}
                  icon={entry.icon}
                  disabled={entry.disabled}
                  onClick={() => setSelectedMemoryCenterEntry(entry.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 面板头（ui-audit-20261016 P1）：旧版是「标题+总字数 | 孵化+导入+新建」的单行
          布局，左栏默认宽 220px 时容不下（标题「章节」竖排换行、总字数逐字折行）。
          改为两行：第一行标题+字数（标题 truncate、字数 nowrap），第二行动作右对齐可换行。 */}
      <div className="flex shrink-0 flex-col border-b px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold whitespace-nowrap">
            <PanelHeaderWithHelp
              title={isChapter ? t("sidebar.knowledge") : t("sidebar.files")}
              helpKey={isChapter ? "chapter" : "outline"}
              helpTitle={isChapter ? "章节功能使用说明" : "大纲功能使用说明"}
            />
          </div>
          {isChapter && sidebarTotalWordCount !== null ? (
            <div className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {buildChapterTotalWordCountLabel(sidebarTotalWordCount)}
              {sidebarWordCountFailed > 0 ? <span role="note">（{sidebarWordCountFailed}章读取失败，未计入）</span> : null}
            </div>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1">
          {isChapter ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs gap-1 text-kind-purple dark:text-kind-purple border-kind-purple/30 hover:bg-kind-purple/10"
                onClick={() => setIncubatorOpen(true)}
                title="全自动小说冷启动孵化器"
                aria-label="全自动小说冷启动孵化器"
              >
                <Wand2 className="h-3.5 w-3.5" />
                <span>孵化</span>
              </Button>
              <div ref={chapterImportMenuRef} className="relative">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setChapterImportMenuOpen((prev) => !prev)}
                disabled={chapterImporting}
              >
                {chapterImporting ? "导入中..." : "导入"}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
              {chapterImportMenuOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md border bg-popover py-1 text-xs text-popover-foreground elevation-3">
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                    onClick={() => void handleImportChapterFiles()}
                  >
                    导入文件
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                    onClick={() => void handleImportChapterFolder()}
                  >
                    导入文件夹
                  </button>
                </div>
              ) : null}
            </div>
            </>
          ) : (
            <div ref={outlineImportMenuRef} className="relative">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setOutlineImportMenuOpen((prev) => !prev)}
                disabled={outlineImporting}
              >
                {outlineImporting ? t("sources.importing") : t("sources.import")}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
              {outlineImportMenuOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md border bg-popover py-1 text-xs text-popover-foreground elevation-3">
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                    onClick={() => void handleImportOutlineFiles()}
                  >
                    {t("sources.importFiles")}
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                    onClick={() => void handleImportOutlineFolder()}
                  >
                    {t("sources.importFolder")}
                  </button>
                </div>
              ) : null}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (isChapter) {
                void handleCreateNextChapter()
                return
              }
              beginCreate({ kind: "outline" })
            }}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={isChapter ? t("sidebar.newChapter") : t("sidebar.newOutline")}
            disabled={creating || outlineImporting || chapterImporting}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {pendingCreate && (
        <div className="flex items-center gap-1 border-b px-2 py-1">
          <input
            type="text"
            value={inputTitle}
            onChange={(event) => setInputTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && inputTitle.trim()) {
                void handleCreateFromInput()
              } else if (event.key === "Escape") {
                cancelPendingCreate()
              }
            }}
            placeholder={inputPlaceholder}
            className="flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            autoFocus
            disabled={creating}
          />
          <button
            type="button"
            onClick={() => void handleCreateFromInput()}
            disabled={!inputTitle.trim() || creating}
            className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {creating ? "..." : "创建"}
          </button>
          <button
            type="button"
            onClick={() => {
              cancelPendingCreate()
            }}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <KnowledgeTree
          filterType={isChapter ? "chapter" : "outline"}
          refreshKey={refreshKey}
          pendingPages={pendingPages.filter((page) => page.type === (isChapter ? "chapter" : "outline"))}
          onRemovePendingPage={handleRemovePendingPage}
          onRequestCreate={beginCreate}
        />
      </div>
      <div className="border-t px-3 py-2">
        <button
          type="button"
          onClick={() => {
            void openExternalUrl(USAGE_GUIDE_URL)
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CircleHelp className="h-4 w-4 shrink-0" />
          <span>{t("iconSidebar.usageGuide")}</span>
        </button>
      </div>
      <RawSourcesSection onCancelExtraction={handleCancelImportMemoryExtraction} />
      <Dialog
        open={Boolean(memoryDecisionRequest)}
        onOpenChange={(open) => {
          if (!open) closeMemoryDecision("cancel")
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("novel.outlineImport.extractMemory")}</DialogTitle>
            <DialogDescription>
              {memoryDecisionRequest?.kind === "outline"
                ? `本次将导入 ${memoryDecisionRequest.count} 个 AI 大纲文档。提取记忆会增加 token 消耗，速度也会比较慢，请耐心等待。`
                : `本次将导入 ${memoryDecisionRequest?.count ?? 0} 个章节文档。提取记忆会增加 token 消耗，速度也会比较慢，请耐心等待。`}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            点击“提取记忆”会在导入后逐个提取并同步到记忆库；点击“只导入”不会提取记忆；点击“取消导入”或关闭弹窗将取消本次导入。
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeMemoryDecision("cancel")}>
              取消导入
            </Button>
            <Button type="button" variant="secondary" onClick={() => closeMemoryDecision("import-only")}>
              只导入
            </Button>
            <Button type="button" onClick={() => closeMemoryDecision("extract")}>
              提取记忆
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AutonomousIncubatorDialog
        open={incubatorOpen}
        onOpenChange={setIncubatorOpen}
      />
    </div>
  )
}