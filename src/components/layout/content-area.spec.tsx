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
  return { state }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { activeView: string; novelMode: boolean }) => unknown) => selector(mocks.state),
}))

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
})
