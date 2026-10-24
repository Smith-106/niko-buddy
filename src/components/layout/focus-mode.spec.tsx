// @vitest-environment jsdom
/**
 * Odyssey 专注模式 — 开关切换显隐。
 * TitleBar 真实渲染（开关按钮），IconSidebar/SidebarPanel/ContentArea 打桩；
 * store 用 vi.hoisted 可写 state 模式，断言 focusMode 开/关两侧边栏显隐。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => {
  const wikiState: {
    project: { id: string; name: string; path: string } | null
    activeView: string
    theme: string
    uiFontSizeScale: number
    focusMode: boolean
  } = {
    project: null,
    activeView: "wiki",
    theme: "light",
    uiFontSizeScale: 1,
    focusMode: false,
  }
  return {
    t: vi.fn((key: string) => key),
    wikiState,
    setActiveView: vi.fn(),
    setActiveSettingsCategory: vi.fn(),
    setFileTree: vi.fn(),
    setTheme: vi.fn(),
    setUiFontSizeScale: vi.fn(),
    setFocusMode: vi.fn((v: boolean) => {
      wikiState.focusMode = v
    }),
    outlineState: {
      tasks: [] as Array<Record<string, unknown>>,
      removeTask: vi.fn(),
    },
    bookState: {
      tasks: [] as Array<Record<string, unknown>>,
      removeTask: vi.fn(),
      retryTask: vi.fn(() => ({ ok: true as const, taskId: "b2" })),
    },
    listDirectory: vi.fn(),
    saveTheme: vi.fn(),
    applyTheme: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({
          project: mocks.wikiState.project,
          activeView: mocks.wikiState.activeView,
          theme: mocks.wikiState.theme,
          uiFontSizeScale: mocks.wikiState.uiFontSizeScale,
          focusMode: mocks.wikiState.focusMode,
          setActiveView: mocks.setActiveView,
          setActiveSettingsCategory: mocks.setActiveSettingsCategory,
          setFileTree: mocks.setFileTree,
          setTheme: mocks.setTheme,
          setUiFontSizeScale: mocks.setUiFontSizeScale,
          setFocusMode: mocks.setFocusMode,
        }),
      { getState: () => mocks.wikiState },
    ),
  }
})

vi.mock("@/stores/outline-generation-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/outline-generation-store")>()
  return {
    ...actual,
    useOutlineGenerationStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(mocks.outlineState),
      { getState: () => mocks.outlineState },
    ),
  }
})

vi.mock("@/stores/book-analysis-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/book-analysis-store")>()
  return {
    ...actual,
    useBookAnalysisStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(mocks.bookState),
      { getState: () => mocks.bookState },
    ),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: mocks.listDirectory,
  }
})

vi.mock("@/lib/novel/outline-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/outline-generation")>()
  return {
    ...actual,
    openGeneratedOutline: vi.fn(),
    runOutlineIngestTask: vi.fn(),
  }
})

vi.mock("@/lib/project-store", () => ({ saveTheme: mocks.saveTheme }))
vi.mock("@/lib/theme-utils", () => ({ applyTheme: mocks.applyTheme }))
vi.mock("@/lib/platform", () => ({ isTauri: () => false }))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}))

vi.mock("@/components/layout/icon-sidebar", () => ({
  IconSidebar: () => <div data-testid="icon-sidebar">nav</div>,
}))

vi.mock("@/components/layout/sidebar-panel", () => ({
  SidebarPanel: () => <div data-testid="sidebar-panel">sidebar</div>,
}))

vi.mock("@/components/layout/content-area", () => ({
  ContentArea: () => <div data-testid="content-area">content</div>,
}))

vi.mock("@/components/layout/activity-panel", () => ({
  ActivityPanel: () => <div data-testid="activity-panel">activity</div>,
}))

vi.mock("@/components/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { AppLayout } from "./app-layout"

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  localStorage.clear()
  mocks.wikiState.project = null
  mocks.wikiState.activeView = "wiki"
  mocks.wikiState.focusMode = false
})

afterEach(() => {
  rtlCleanup()
})

describe("专注模式开关切换显隐", () => {
  it("默认关闭：两侧边栏可见，顶栏开关未按下", () => {
    render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByTestId("icon-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-panel")).toBeInTheDocument()
    expect(screen.getByTestId("content-area")).toBeInTheDocument()
    const toggle = screen.getByTestId("focus-mode-toggle")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
  })

  it("点击开关进入专注：两侧边栏隐藏，编辑区保留", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    fireEvent.click(screen.getByTestId("focus-mode-toggle"))
    expect(mocks.setFocusMode).toHaveBeenCalledWith(true)
    view.rerender(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByTestId("icon-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("sidebar-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("content-area")).toBeInTheDocument()
    expect(screen.getByTestId("focus-mode-toggle")).toHaveAttribute("aria-pressed", "true")
  })

  it("Ctrl+\\ 切换专注模式", () => {
    render(<AppLayout onSwitchProject={() => {}} />)
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
    expect(mocks.setFocusMode).toHaveBeenCalledWith(true)
    mocks.wikiState.focusMode = true
    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    expect(mocks.setFocusMode).toHaveBeenCalledWith(false)
  })

  it("专注模式下再次点击退出：侧边栏恢复", () => {
    mocks.wikiState.focusMode = true
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByTestId("icon-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("sidebar-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("focus-mode-toggle"))
    expect(mocks.setFocusMode).toHaveBeenCalledWith(false)
    view.rerender(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByTestId("icon-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-panel")).toBeInTheDocument()
  })
})
