// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { Suspense, lazy } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { ErrorBoundary } from "@/components/error-boundary"
import { WritingWorkspace } from "./writing-workspace"
import { SearchView } from "@/components/search/search-view"
import { PlannedView } from "./planned-view"
import { isPlannedView } from "./planned-views"

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
const DataManagerView = lazy(() => import("@/components/novel/data-manager-view").then((m) => ({ default: m.DataManagerView })))
const AssetLibraryView = lazy(() => import("@/components/novel/asset-library-view").then((m) => ({ default: m.AssetLibraryView })))
const WorldLibraryView = lazy(() => import("@/components/novel/world-library-view").then((m) => ({ default: m.WorldLibraryView })))
const WorkbenchView = lazy(() => import("./workbench-view").then((m) => ({ default: m.WorkbenchView })))
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

const DiagnosticsCenterView = lazy(async () => {
  const mod = await import("@/components/novel/diagnostics-center")
  return { default: mod.DiagnosticsCenterView }
})

const CanonEditor = lazy(async () => {
  const mod = await import("@/components/canon-editor/canon-editor")
  return { default: mod.CanonEditor }
})

const DirectorView = lazy(async () => {
  const mod = await import("@/components/novel/director-view")
  return { default: mod.DirectorView }
})

const ModuleHeatmapView = lazy(async () => {
  const mod = await import("@/components/novel/module-heatmap-view")
  return { default: mod.ModuleHeatmapView }
})

const PipelineMotionView = lazy(async () => {
  const mod = await import("@/components/novel/pipeline-motion-view")
  return { default: mod.PipelineMotionView }
})

const MainControlView = lazy(async () => {
  const mod = await import("@/components/novel/main-control-view")
  return { default: mod.MainControlView }
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
  // 计划态视图：已进 union（可被赋值/深链）但功能未实现，渲染如实占位的
  // PlannedView，而不是落到 default 的聊天面板（语义错误的页面）。
  const showPlannedView = !showWritingWorkspace && isPlannedView(activeView)

  let content: React.ReactNode = null
  
  if (showWritingWorkspace) {
    content = <WritingWorkspace />
  } else if (showPlannedView) {
    content = <PlannedView view={activeView} />
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
      case "diagnosticsCenter":
        content = (
          <Suspense fallback={<LoadingView />}>
            <DiagnosticsCenterView />
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
      case "moduleHeatmap":
        content = (
          <Suspense fallback={<LoadingView />}>
            <ModuleHeatmapView projectId={projectId} />
          </Suspense>
        )
        break
      case "pipelineMotion":
        content = (
          <Suspense fallback={<LoadingView />}>
            <PipelineMotionView projectId={projectId} />
          </Suspense>
        )
        break
      case "mainControl":
        content = (
          <Suspense fallback={<LoadingView />}>
            <MainControlView projectId={projectId} />
          </Suspense>
        )
        break
      case "dataManager":
        content = (
          <Suspense fallback={<LoadingView />}>
            <DataManagerView />
          </Suspense>
        )
        break
      case "worldLibrary":
        // 世界构建只读视图（Wave 2）：数据源 .novel 世界蓝图 + 既有校验器，
        // 零新真源、不提供修改入口（写回仍延后）。
        content = (
          <Suspense fallback={<LoadingView />}>
            <WorldLibraryView />
          </Suspense>
        )
        break
      case "knowledgeLibrary":
        // 资产库可视化（全部库 · 守恒/健康）：数据源 .novel/asset-library/<库>.json，
        // 零新真源；装载只读，唯一写操作是用户显式点击的关系库迁移；未生成显式空态（不造条目）。
        content = (
          <Suspense fallback={<LoadingView />}>
            <AssetLibraryView projectPath={projectPath} />
          </Suspense>
        )
        break
      case "workbench":
        content = (
          <Suspense fallback={<LoadingView />}>
            <WorkbenchView />
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

  // F1（Round-1 评估）：内容区单点 ErrorBoundary——任一视图（写作台/设置/图谱/评审/
  // 故事模拟/预览等）渲染崩溃时只降级内容区，不白屏整个应用；key 随视图切换重置。
  return (
    <div className="h-full">
      <ErrorBoundary key={showWritingWorkspace ? "writing" : activeView}>
        {content}
      </ErrorBoundary>
    </div>
  )
}
