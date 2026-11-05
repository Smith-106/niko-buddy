// @vitest-environment jsdom
/**
 * ContentArea — 视图路由（wiki/trash → WritingWorkspace，其余 lazy 视图 + Suspense 兜底）全分支覆盖。
 * store 与子组件全部 vi.mock（vi.hoisted 可写 state 模式，参照 src/App.spec.tsx）。
 */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContentArea } from "./content-area"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state: { activeView: string; novelMode: boolean } = { activeView: "wiki", novelMode: true }
  const plannedSet = new Set<string>()
  return { state, plannedSet }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { activeView: string; novelMode: boolean }) => unknown) => selector(mocks.state),
    
  }
})

vi.mock("@/components/layout/writing-workspace", () => ({
  WritingWorkspace: () => <div>mock-writing-workspace</div>,
}))

vi.mock("@/components/search/search-view", () => ({
  SearchView: () => <div>mock-search</div>,
}))

vi.mock("@/components/chat/chat-panel", () => ({
  ChatPanel: () => <div>mock-chat</div>,
}))

vi.mock("@/components/settings/settings-view", async () => {
  // 延迟 module resolve，让 lazy 挂起阶段可见 Suspense fallback
  await new Promise((resolve) => setTimeout(resolve, 60))
  return { SettingsView: () => <div>mock-settings</div> }
})

vi.mock("@/components/sources/sources-view", () => ({
  SourcesView: () => <div>mock-sources</div>,
}))

vi.mock("@/components/lint/lint-view", () => ({
  LintView: () => <div>mock-lint</div>,
}))

vi.mock("@/components/novel/memory-center-view", () => ({
  MemoryCenterView: () => <div>mock-memory-center</div>,
}))

vi.mock("@/components/graph/graph-view", () => ({
  GraphView: () => <div>mock-graph</div>,
}))

vi.mock("@/components/novel/soul-view", () => ({
  SoulView: () => <div>mock-soul</div>,
}))

vi.mock("@/components/review/review-center-view", () => ({
  ReviewCenterView: () => <div>mock-review-center</div>,
}))

vi.mock("@/components/novel/book-analysis-view", () => ({
  BookAnalysisView: () => <div>mock-book-analysis</div>,
}))

vi.mock("./planned-views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./planned-views")>()
  return {
    ...actual,
    isPlannedView: (view: string) => mocks.plannedSet.has(view) || actual.isPlannedView(view),
  }
})

vi.mock("./planned-view", () => ({
  PlannedView: ({ view }: { view: string }) => <div>mock-planned-{view}</div>,
}))

vi.mock("@/components/novel/story-simulation/story-simulation-view", () => ({
  StorySimulationView: () => <div>mock-story-simulation</div>,
}))

vi.mock("@/components/skill-library/unified-skill-library-view", () => ({
  UnifiedSkillLibraryView: () => <div>mock-skill-library</div>,
}))

vi.mock("@/components/novel/status-dashboard-view", () => ({
  StatusDashboardView: () => <div>mock-status-dashboard</div>,
}))

vi.mock("@/components/novel/backup-export-view", () => ({
  BackupExportView: () => <div>mock-backup-export</div>,
}))

vi.mock("@/components/novel/diagnostics-center", () => ({
  DiagnosticsCenterView: () => <div>mock-diagnostics</div>,
}))

vi.mock("@/components/canon-editor/canon-editor", () => ({
  CanonEditor: () => <div>mock-canon-editor</div>,
}))

vi.mock("@/components/novel/director-view", () => ({
  DirectorView: () => <div>mock-director</div>,
}))

vi.mock("@/components/novel/module-heatmap-view", () => ({
  ModuleHeatmapView: () => <div>mock-module-heatmap</div>,
}))

vi.mock("@/components/novel/pipeline-motion-view", () => ({
  PipelineMotionView: () => <div>mock-pipeline-motion</div>,
}))

vi.mock("@/components/novel/live-execution-view", () => ({
  LiveExecutionView: () => <div>mock-live-execution</div>,
}))

vi.mock("@/components/novel/followup-center-view", () => ({
  FollowupCenterView: () => <div>mock-followup-center</div>,
}))

vi.mock("@/components/novel/creative-hub-view", () => ({
  CreativeHubView: () => <div>mock-creative-hub</div>,
}))

vi.mock("@/components/novel/bookshelf-view", () => ({
  BookshelfView: () => <div>mock-bookshelf</div>,
}))

vi.mock("@/components/novel/genre-library-view", () => ({
  GenreLibraryView: () => <div>mock-genre-library</div>,
}))

vi.mock("@/components/novel/story-mode-library-view", () => ({
  StoryModeLibraryView: () => <div>mock-story-mode-library</div>,
}))

vi.mock("@/components/novel/title-studio-view", () => ({
  TitleStudioView: () => <div>mock-title-studio</div>,
}))

vi.mock("@/components/novel/style-engine-view", () => ({
  StyleEngineView: () => <div>mock-style-engine</div>,
}))

vi.mock("@/components/novel/anti-ai-rules-view", () => ({
  AntiAiRulesView: () => <div>mock-anti-ai-rules</div>,
}))

vi.mock("@/components/novel/model-routes-view", () => ({
  ModelRoutesView: () => <div>mock-model-routes</div>,
}))

vi.mock("@/components/novel/mcp-manager-view", () => ({
  McpManagerView: () => <div>mock-mcp-manager</div>,
}))

vi.mock("@/components/novel/workflow-editor-view", () => ({
  WorkflowEditorView: () => <div>mock-workflow-editor</div>,
}))

vi.mock("@/components/novel/market-radar-view", () => ({
  MarketRadarView: () => <div>mock-market-radar</div>,
}))

vi.mock("@/components/novel/help-view", () => ({
  HelpView: () => <div>mock-help</div>,
}))

vi.mock("@/components/novel/export-center-view", () => ({
  ExportCenterView: () => <div>mock-export-center</div>,
}))

vi.mock("@/components/novel/main-control-view", () => ({
  MainControlView: () => <div>mock-main-control</div>,
}))

vi.mock("@/components/novel/data-manager-view", () => ({
  DataManagerView: () => <div>mock-data-manager</div>,
}))

vi.mock("@/components/novel/asset-library-view", () => ({
  AssetLibraryView: () => <div>mock-asset-library</div>,
}))

vi.mock("@/components/novel/world-library-view", () => ({
  WorldLibraryView: () => <div>mock-world-library</div>,
}))

vi.mock("./workbench-view", () => ({
  WorkbenchView: () => <div>mock-workbench</div>,
}))

function renderContentArea(): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ContentArea />)
  })
  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("ContentArea", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeView = "wiki"
    mocks.state.novelMode = true
  })

  afterEach(() => {
    // 清理可能残留的全局渲染容器
    document.body.innerHTML = ""
  })

  it("wiki 视图 → WritingWorkspace", () => {
    const { container, cleanup } = renderContentArea()
    expect(container.textContent).toContain("mock-writing-workspace")
    cleanup()
  })

  it("trash 视图 → WritingWorkspace", () => {
    mocks.state.activeView = "trash"
    const { container, cleanup } = renderContentArea()
    expect(container.textContent).toContain("mock-writing-workspace")
    cleanup()
  })

  it("settings 视图：先渲染 Suspense fallback，再切到 SettingsView", async () => {
    mocks.state.activeView = "settings"
    const { container, cleanup } = renderContentArea()
    // lazy import 尚未 resolve（mock factory 带 60ms 延迟）→ 可见 fallback
    expect(container.textContent).toContain("加载中...")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(container.textContent).toContain("mock-settings")
    cleanup()
  })

  it("sources 视图 → SourcesView", async () => {
    mocks.state.activeView = "sources"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-sources")
    cleanup()
  })

  it("search 视图 → SearchView", () => {
    mocks.state.activeView = "search"
    const { container, cleanup } = renderContentArea()
    expect(container.textContent).toContain("mock-search")
    cleanup()
  })

  it("soul 视图 → SoulView", async () => {
    mocks.state.activeView = "soul"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-soul")
    cleanup()
  })

  it("lint 视图 + novelMode → MemoryCenterView", async () => {
    mocks.state.activeView = "lint"
    mocks.state.novelMode = true
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-memory-center")
    cleanup()
  })

  it("lint 视图 + 非 novelMode → LintView", async () => {
    mocks.state.activeView = "lint"
    mocks.state.novelMode = false
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-lint")
    cleanup()
  })

  it("graph 视图 → GraphView", async () => {
    mocks.state.activeView = "graph"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-graph")
    cleanup()
  })

  it("reviewCenter 视图 → ReviewCenterView", async () => {
    mocks.state.activeView = "reviewCenter"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-review-center")
    cleanup()
  })

  it("bookAnalysis 视图 → BookAnalysisView", async () => {
    mocks.state.activeView = "bookAnalysis"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-book-analysis")
    cleanup()
  })

  it("未知视图（default）→ ChatPanel", async () => {
    mocks.state.activeView = "chat"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-chat")
    cleanup()
  })

  it("F1 (Round-1)：子视图抛错时 ErrorBoundary 降级内容区而非白屏", async () => {
    // 用一个必抛错的视图验证 ErrorBoundary 包裹生效：覆盖默认 fallback 的重试文案
    const { ErrorBoundary } = await import("@/components/error-boundary")
    const { createElement } = await import("react")
    const Thrower = () => {
      throw new Error("boom-f1")
    }
    const c = document.createElement("div")
    document.body.appendChild(c)
    const root = (await import("react-dom/client")).createRoot(c)
    const { act: actFn } = await import("react")
    actFn(() => {
      root.render(createElement(ErrorBoundary, null, createElement(Thrower)))
    })
    expect(c.textContent).toContain("boom-f1")
    root.unmount()
    c.remove()
  })
})

describe("ContentArea — W3 剩余视图全路由", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeView = "wiki"
    mocks.state.novelMode = true
    mocks.plannedSet.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ""
    mocks.plannedSet.clear()
  })

  const cases: Array<[string, string]> = [
    ["storySimulation", "mock-story-simulation"],
    ["skillLibrary", "mock-skill-library"],
    ["writingSkillLibrary", "mock-skill-library"],
    ["skillFavorites", "mock-skill-library"],
    ["statusDashboard", "mock-status-dashboard"],
    ["backupExport", "mock-backup-export"],
    ["diagnosticsCenter", "mock-diagnostics"],
    ["canonEditor", "mock-canon-editor"],
    ["director", "mock-director"],
    ["moduleHeatmap", "mock-module-heatmap"],
    ["pipelineMotion", "mock-pipeline-motion"],
    ["liveExecution", "mock-live-execution"],
    ["followUpCenter", "mock-followup-center"],
    ["creativeHub", "mock-creative-hub"],
    ["bookshelf", "mock-bookshelf"],
    ["genreLibrary", "mock-genre-library"],
    ["storyModeLibrary", "mock-story-mode-library"],
    ["titleStudio", "mock-title-studio"],
    ["styleEngine", "mock-style-engine"],
    ["antiAiRules", "mock-anti-ai-rules"],
    ["modelRoutes", "mock-model-routes"],
    ["mcpManager", "mock-mcp-manager"],
    ["workflowEditor", "mock-workflow-editor"],
    ["marketRadar", "mock-market-radar"],
    ["help", "mock-help"],
    ["exportCenter", "mock-export-center"],
    ["mainControl", "mock-main-control"],
    ["dataManager", "mock-data-manager"],
    ["worldLibrary", "mock-world-library"],
    ["knowledgeLibrary", "mock-asset-library"],
    ["workbench", "mock-workbench"],
  ]

  for (const [view, marker] of cases) {
    it(`${view} → ${marker}`, async () => {
      mocks.state.activeView = view
      const { container, cleanup } = renderContentArea()
      await flushAsync()
      // 语义断言：正确视图挂载（改错分支会渲染别的 mock 而变红）
      expect(container.textContent).toContain(marker)
      cleanup()
    })
  }

  it("计划态视图 → PlannedView（占位而非聊天面板）", async () => {
    mocks.plannedSet.add("fakePlanned")
    mocks.state.activeView = "fakePlanned"
    const { container, cleanup } = renderContentArea()
    await flushAsync()
    expect(container.textContent).toContain("mock-planned-fakePlanned")
    expect(container.textContent).not.toContain("mock-chat")
    cleanup()
  })
})
