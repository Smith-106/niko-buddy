// Copyright © 2024-2099 QAHUI (https://qmai.qimai-im.com/)
// SPDX-License-Identifier: MIT

import { Suspense, lazy } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { WritingWorkspace } from "./writing-workspace"
import { SearchView } from "@/components/search/search-view"

const ChatPanel = lazy(async () => {
  const mod = await import("@/components/chat/chat-panel")
  return { default: mod.ChatPanel }
})

const SettingsView = lazy(async () => {
  const mod = await import("@/components/settings/settings-view")
  return { default: mod.SettingsView }
})

const SourcesView = lazy(async () => {
  const mod = await import("@/components/sources/sources-view")
  return { default: mod.SourcesView }
})

const LintView = lazy(async () => {
  const mod = await import("@/components/lint/lint-view")
  return { default: mod.LintView }
})

const MemoryCenterView = lazy(async () => {
  const mod = await import("@/components/novel/memory-center-view")
  return { default: mod.MemoryCenterView }
})

const GraphView = lazy(async () => {
  const mod = await import("@/components/graph/graph-view")
  return { default: mod.GraphView }
})

const StorySimulationView = lazy(() => import("@/components/novel/story-simulation/story-simulation-view").then((m) => ({ default: m.StorySimulationView })))
const UnifiedSkillLibraryView = lazy(() => import("@/components/skill-library/unified-skill-library-view").then((m) => ({ default: m.UnifiedSkillLibraryView })))
const SoulView = lazy(async () => {
  const mod = await import("@/components/novel/soul-view")
  return { default: mod.SoulView }
})

const ReviewCenterView = lazy(async () => {
  const mod = await import("@/components/review/review-center-view")
  return { default: mod.ReviewCenterView }
})

const BookAnalysisView = lazy(async () => {
  const mod = await import("@/components/novel/book-analysis-view")
  return { default: mod.BookAnalysisView }
})

const BackupExportView = lazy(async () => {
  const mod = await import("@/components/novel/backup-export-view")
  return { default: mod.BackupExportView }
})

const CanonEditor = lazy(async () => {
  const mod = await import("@/components/canon-editor/canon-editor")
  return { default: mod.CanonEditor }
})

const DirectorView = lazy(async () => {
  const mod = await import("@/components/novel/director-view")
  return { default: mod.DirectorView }
})

function LoadingView() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <span>加载中...</span>
    </div>
  )
}

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)
  const novelMode = useWikiStore((s) => s.novelMode)
  const projectId = useWikiStore((s) => s.project?.id ?? "")
  const projectPath = useWikiStore((s) => s.project?.path ?? "")
  const showWritingWorkspace = activeView === "wiki" || activeView === "trash"

  let content: React.ReactNode = null
  
  if (showWritingWorkspace) {
    content = <WritingWorkspace />
  } else {
    switch (activeView) {
      case "settings":
        content = (
          <Suspense fallback={<LoadingView />}>
            <SettingsView />
          </Suspense>
        )
        break
      case "sources":
        content = (
          <Suspense fallback={<LoadingView />}>
            <SourcesView />
          </Suspense>
        )
        break
      case "search":
        content = <SearchView />
        break
      case "soul":
        content = (
          <Suspense fallback={<LoadingView />}>
            <SoulView />
          </Suspense>
        )
        break
      case "storySimulation":
        content = (
          <Suspense fallback={<LoadingView />}>
            <StorySimulationView />
          </Suspense>
        )
        break
      case "skillLibrary":
      case "writingSkillLibrary":
      case "skillFavorites":
        content = (
          <Suspense fallback={<LoadingView />}>
            <UnifiedSkillLibraryView />
          </Suspense>
        )
        break
      case "lint":
        content = (
          <Suspense fallback={<LoadingView />}>
            {novelMode ? <MemoryCenterView /> : <LintView />}
          </Suspense>
        )
        break
      case "graph":
        content = (
          <Suspense fallback={<LoadingView />}>
            <GraphView />
          </Suspense>
        )
        break
      case "reviewCenter":
        content = (
          <Suspense fallback={<LoadingView />}>
            <ReviewCenterView />
          </Suspense>
        )
        break
      case "bookAnalysis":
        content = (
          <Suspense fallback={<LoadingView />}>
            <BookAnalysisView />
          </Suspense>
        )
        break
      case "backupExport":
        content = (
          <Suspense fallback={<LoadingView />}>
            <BackupExportView />
          </Suspense>
        )
        break
      case "canonEditor":
        content = (
          <Suspense fallback={<LoadingView />}>
            <CanonEditor projectId={projectId} />
          </Suspense>
        )
        break
      case "director":
        content = (
          <Suspense fallback={<LoadingView />}>
            <DirectorView projectId={projectPath} />
          </Suspense>
        )
        break
      default:
        content = (
          <Suspense fallback={<LoadingView />}>
            <ChatPanel />
          </Suspense>
        )
        break
    }
  }

  return <div className="h-full">{content}</div>
}
