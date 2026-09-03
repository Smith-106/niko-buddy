// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface ProjectLike {
  id: string
  name: string
  path: string
}

interface WikiState {
  project: ProjectLike | null
  setProject: ReturnType<typeof vi.fn>
  setFileTree: ReturnType<typeof vi.fn>
  setSelectedFile: ReturnType<typeof vi.fn>
  uiFontSizeScale: number
  communitySummaryError: string | null
  setCommunitySummaryError: ReturnType<typeof vi.fn>
  theme: string
  scheduledImportConfig: { enabled: boolean; intervalMs: number }
}

const mocks = vi.hoisted(() => {
  const state: WikiState = {
    project: null,
    setProject: vi.fn(),
    setFileTree: vi.fn(),
    setSelectedFile: vi.fn(),
    uiFontSizeScale: 1,
    communitySummaryError: null,
    setCommunitySummaryError: vi.fn(),
    theme: "light",
    scheduledImportConfig: { enabled: false, intervalMs: 30000 },
  }
  const getStateSnapshot: { project: ProjectLike | null; scheduledImportConfig: { enabled: boolean; intervalMs: number } } = {
    project: null,
    scheduledImportConfig: { enabled: false, intervalMs: 30000 },
  }
  return {
    state,
    getStateSnapshot,
    openProject: vi.fn(),
    isTauri: vi.fn(() => false),
    pickDirectory: vi.fn(async () => null),
    saveScheduledImportConfig: vi.fn(async () => {}),
    setupAutoSave: vi.fn(),
    initializeApp: vi.fn(async () => {}),
    hydrateProjectOnOpen: vi.fn(async () => {}),
    formatAppTitle: vi.fn((name: string | null | undefined) => (name ? `Niko - ${name}` : "Niko")),
    resetProjectState: vi.fn(async () => {}),
    toastError: vi.fn(),
    applyTheme: vi.fn(),
    watchSystemTheme: vi.fn(() => () => {}),
    stopScheduledImport: vi.fn(),
    getCurrentWindow: vi.fn(() => ({ setTitle: vi.fn() })),
    // project-owner 锁 (54 号设计隐患 1): 打开项目时读/写 .qmai/owner.json
    readFile: vi.fn(async () => {
      throw new Error("ENOENT: no owner.json")
    }),
    writeFileAtomic: vi.fn(async () => {}),
    t: vi.fn((key: string, opts?: { message?: string }) => `${key}::${opts?.message ?? ""}`),
  }
})

vi.mock("@/i18n", () => ({
  default: { t: mocks.t },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiState) => unknown) => selector(mocks.state),
    { getState: () => mocks.getStateSnapshot },
  ),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
  pickDirectory: mocks.pickDirectory,
}))

vi.mock("@/commands/fs", () => ({
  openProject: mocks.openProject,
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/lib/project-store", () => ({
  saveScheduledImportConfig: mocks.saveScheduledImportConfig,
}))

vi.mock("@/lib/auto-save", () => ({
  setupAutoSave: mocks.setupAutoSave,
}))

vi.mock("@/lib/composition-root", () => ({
  initializeApp: mocks.initializeApp,
  hydrateProjectOnOpen: mocks.hydrateProjectOnOpen,
}))

vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: (props: { onSwitchProject: () => void }) => (
    <div>
      <span>app-layout</span>
      <button data-testid="layout-switch" onClick={props.onSwitchProject}>
        switch
      </button>
    </div>
  ),
}))

vi.mock("@/components/project/welcome-screen", () => ({
  WelcomeScreen: (props: {
    onCreateProject: () => void
    onOpenProject: () => void
    onSelectProject: (p: ProjectLike) => void
  }) => (
    <div>
      <span>welcome-screen</span>
      <button data-testid="welcome-create" onClick={props.onCreateProject}>
        create
      </button>
      <button data-testid="welcome-open" onClick={props.onOpenProject}>
        open
      </button>
      <button data-testid="welcome-recent" onClick={() => props.onSelectProject({ id: "recent-1", name: "Recent", path: "/p/recent" })}>
        recent
      </button>
    </div>
  ),
}))

vi.mock("@/components/project/create-project-dialog", () => ({
  CreateProjectDialog: (props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreated: (p: ProjectLike) => void
  }) => (
    <div>
      <span>{`dialog-open:${String(props.open)}`}</span>
      <button data-testid="dialog-created" onClick={() => props.onCreated({ id: "new-1", name: "New", path: "/p/new" })}>
        created
      </button>
      <button data-testid="dialog-close" onClick={() => props.onOpenChange(false)}>
        close
      </button>
    </div>
  ),
}))

vi.mock("@/lib/app-title", () => ({
  formatAppTitle: mocks.formatAppTitle,
}))

vi.mock("@/lib/reset-project-state", () => ({
  resetProjectState: mocks.resetProjectState,
}))

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError },
}))

vi.mock("@/lib/theme-utils", () => ({
  applyTheme: mocks.applyTheme,
  watchSystemTheme: mocks.watchSystemTheme,
}))

vi.mock("@/lib/scheduled-import", () => ({
  stopScheduledImport: mocks.stopScheduledImport,
}))

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}))

const DEFAULT_PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function renderApp(): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<App />)
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

function clickAndFlush(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  act(() => {
    ;(element as HTMLElement).click()
  })
  return flushAsync()
}

describe("App 组件树渲染与初始化流程", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = null
    mocks.state.uiFontSizeScale = 1
    mocks.state.communitySummaryError = null
    mocks.state.theme = "light"
    mocks.state.scheduledImportConfig = { enabled: false, intervalMs: 30000 }
    mocks.getStateSnapshot.project = null
    mocks.getStateSnapshot.scheduledImportConfig = { enabled: false, intervalMs: 30000 }
    mocks.openProject.mockResolvedValue({ id: "opened-1", name: "Opened", path: "/p/opened" })
    mocks.isTauri.mockReturnValue(false)
    mocks.pickDirectory.mockResolvedValue(null)
    mocks.initializeApp.mockResolvedValue(undefined)
    mocks.saveScheduledImportConfig.mockResolvedValue(undefined)
    mocks.stopScheduledImport.mockImplementation(() => {})
    mocks.getCurrentWindow.mockImplementation(() => ({ setTitle: vi.fn() }))
    document.documentElement.style.fontSize = ""
    document.title = ""
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("initializeApp 挂起期间显示 Loading 并只挂载一次 auto-save", () => {
    mocks.initializeApp.mockReturnValue(new Promise(() => {}))
    const { container, cleanup } = renderApp()

    expect(container.textContent).toContain("Loading...")
    expect(mocks.setupAutoSave).toHaveBeenCalledTimes(1)
    expect(mocks.initializeApp).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("无项目时渲染欢迎页 + 关闭状态的创建对话框", async () => {
    const { container, cleanup } = renderApp()
    await flushAsync()

    expect(container.textContent).toContain("welcome-screen")
    expect(container.textContent).toContain("dialog-open:false")
    expect(mocks.initializeApp).toHaveBeenCalled()
    expect(mocks.setupAutoSave).toHaveBeenCalled()
    expect(mocks.state.setProject).not.toHaveBeenCalled()
    cleanup()
  })

  it("有项目时渲染 AppLayout + 创建对话框，并设置文档标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const { container, cleanup } = renderApp()
    await flushAsync()

    expect(container.textContent).toContain("app-layout")
    expect(container.textContent).toContain("dialog-open:false")
    expect(mocks.formatAppTitle).toHaveBeenCalledWith("MyBook")
    expect(document.title).toBe("Niko - MyBook")
    cleanup()
  })

  it("按 uiFontSizeScale 设置根字体大小", () => {
    mocks.state.uiFontSizeScale = 1.25
    const { cleanup } = renderApp()

    expect(document.documentElement.style.fontSize).toBe("125%")
    cleanup()
  })

  it("communitySummaryError 存在时 toast 提示并清空", async () => {
    mocks.state.communitySummaryError = "boom"
    const { cleanup } = renderApp()
    await flushAsync()

    expect(mocks.toastError).toHaveBeenCalledWith("novel.settings.communitySummaryFailed::boom")
    expect(mocks.state.setCommunitySummaryError).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("theme=system 时应用系统主题并挂接主题监听", async () => {
    mocks.state.theme = "system"
    mocks.watchSystemTheme.mockReturnValue(() => {})
    const { cleanup } = renderApp()
    await flushAsync()

    expect(mocks.applyTheme).toHaveBeenCalledWith("system")
    expect(mocks.watchSystemTheme).toHaveBeenCalledTimes(1)
    const onChange = mocks.watchSystemTheme.mock.calls[0]?.[0]
    expect(onChange).toBeTypeOf("function")
    ;(onChange as () => void)()
    expect(mocks.applyTheme).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it("theme 非 system 时直接应用指定主题", async () => {
    mocks.state.theme = "dark"
    const { cleanup } = renderApp()
    await flushAsync()

    expect(mocks.applyTheme).toHaveBeenCalledWith("dark")
    expect(mocks.watchSystemTheme).not.toHaveBeenCalled()
    cleanup()
  })

  it("目录选择取消时 openProject 不被调用", async () => {
    mocks.pickDirectory.mockResolvedValue(null)
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-open"]'))
    expect(mocks.openProject).not.toHaveBeenCalled()
    cleanup()
  })

  it("打开目录成功时 openProject + hydrateProjectOnOpen 走完整链路", async () => {
    mocks.pickDirectory.mockResolvedValue("/p/opened")
    const opened: ProjectLike = { id: "opened-1", name: "Opened", path: "/p/opened" }
    mocks.openProject.mockResolvedValue(opened)
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-open"]'))
    expect(mocks.openProject).toHaveBeenCalledWith("/p/opened")
    expect(mocks.hydrateProjectOnOpen).toHaveBeenCalledWith(opened)
    cleanup()
  })

  it("打开目录失败时 alert 提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.pickDirectory.mockResolvedValue("/p/opened")
    mocks.openProject.mockRejectedValue(new Error("bad"))
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-open"]'))
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("打开项目失败"))
    cleanup()
  })

  it("选择最近项目成功时 hydrate 该项目", async () => {
    mocks.openProject.mockResolvedValue({ id: "recent-1", name: "Recent", path: "/p/recent" })
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-recent"]'))
    expect(mocks.openProject).toHaveBeenCalledWith("/p/recent")
    expect(mocks.hydrateProjectOnOpen).toHaveBeenCalledWith({ id: "recent-1", name: "Recent", path: "/p/recent" })
    cleanup()
  })

  it("选择最近项目失败时 alert 提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.openProject.mockRejectedValue(new Error("bad-recent"))
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-recent"]'))
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("打开项目失败"))
    cleanup()
  })

  it("创建对话框 open/close 切换", async () => {
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-create"]'))
    expect(container.textContent).toContain("dialog-open:true")

    await clickAndFlush(container.querySelector('[data-testid="dialog-close"]'))
    expect(container.textContent).toContain("dialog-open:false")
    cleanup()
  })

  it("创建对话框 onCreated 触发 hydrateProjectOnOpen", async () => {
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-create"]'))
    await clickAndFlush(container.querySelector('[data-testid="dialog-created"]'))
    expect(mocks.hydrateProjectOnOpen).toHaveBeenCalledWith({ id: "new-1", name: "New", path: "/p/new" })
    cleanup()
  })

  it("项目视图中创建对话框的 onCreated 同样触发 hydrateProjectOnOpen", async () => {
    // 先挂载欢迎页并打开对话框（showCreateDialog=true），再把项目注入 store，
    // 点击欢迎页 create 触发重渲染 → 切到项目分支，此时 dialog-created 绑定的是
    // 项目分支 CreateProjectDialog 的 onCreated（App.tsx 147 行）。
    const { container, cleanup } = renderApp()
    await flushAsync()

    mocks.state.project = DEFAULT_PROJECT
    await clickAndFlush(container.querySelector('[data-testid="welcome-create"]'))
    expect(container.textContent).toContain("app-layout")
    expect(container.textContent).toContain("dialog-open:true")

    await clickAndFlush(container.querySelector('[data-testid="dialog-created"]'))
    expect(mocks.hydrateProjectOnOpen).toHaveBeenCalledWith({ id: "new-1", name: "New", path: "/p/new" })
    cleanup()
  })

  it("创建对话框 onCreated hydrate 失败时弹窗提示（与打开路径一致）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.hydrateProjectOnOpen.mockRejectedValueOnce(new Error("hydrate-boom"))
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="welcome-create"]'))
    await clickAndFlush(container.querySelector('[data-testid="dialog-created"]'))
    expect(mocks.hydrateProjectOnOpen).toHaveBeenCalledWith({ id: "new-1", name: "New", path: "/p/new" })
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("项目创建后初始化失败"))
    alertSpy.mockRestore()
    cleanup()
  })

  it("切换项目：停止定时导入、保存配置、重置状态并清空项目", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getStateSnapshot.project = DEFAULT_PROJECT
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="layout-switch"]'))
    expect(mocks.stopScheduledImport).toHaveBeenCalledTimes(1)
    expect(mocks.saveScheduledImportConfig).toHaveBeenCalledWith("/p/mybook", mocks.state.scheduledImportConfig)
    expect(mocks.resetProjectState).toHaveBeenCalledTimes(1)
    expect(mocks.state.setProject).toHaveBeenCalledWith(null)
    expect(mocks.state.setFileTree).toHaveBeenCalledWith([])
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("切换项目时无当前项目则跳过配置保存", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getStateSnapshot.project = null
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="layout-switch"]'))
    expect(mocks.saveScheduledImportConfig).not.toHaveBeenCalled()
    expect(mocks.resetProjectState).toHaveBeenCalled()
    cleanup()
  })

  it("切换项目时 stopScheduledImport 抛错被吞掉", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getStateSnapshot.project = DEFAULT_PROJECT
    mocks.stopScheduledImport.mockImplementation(() => {
      throw new Error("stop-fail")
    })
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="layout-switch"]'))
    expect(mocks.resetProjectState).toHaveBeenCalled()
    cleanup()
  })

  it("切换项目时保存配置失败被吞掉", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getStateSnapshot.project = DEFAULT_PROJECT
    mocks.saveScheduledImportConfig.mockRejectedValue(new Error("cfg-fail"))
    const { container, cleanup } = renderApp()
    await flushAsync()

    await clickAndFlush(container.querySelector('[data-testid="layout-switch"]'))
    expect(mocks.resetProjectState).toHaveBeenCalled()
    cleanup()
  })

  it("Tauri 环境设置窗口标题", async () => {
    mocks.isTauri.mockReturnValue(true)
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    mocks.state.project = DEFAULT_PROJECT
    const setTitle = vi.fn()
    mocks.getCurrentWindow.mockReturnValue({ setTitle })
    const { cleanup } = renderApp()
    await flushAsync()

    expect(mocks.getCurrentWindow).toHaveBeenCalledTimes(1)
    expect(setTitle).toHaveBeenCalledWith("Niko - MyBook")
    expect(document.title).toBe("Niko - MyBook")
    cleanup()
  })

  it("Tauri 窗口标题设置失败被吞掉", async () => {
    mocks.isTauri.mockReturnValue(true)
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    mocks.state.project = DEFAULT_PROJECT
    mocks.getCurrentWindow.mockImplementation(() => {
      throw new Error("window-fail")
    })
    const { cleanup } = renderApp()
    await flushAsync()

    expect(document.title).toBe("Niko - MyBook")
    cleanup()
  })

  it("非 Tauri 环境不调用窗口模块", async () => {
    mocks.isTauri.mockReturnValue(false)
    mocks.state.project = DEFAULT_PROJECT
    const { cleanup } = renderApp()
    await flushAsync()

    expect(mocks.getCurrentWindow).not.toHaveBeenCalled()
    expect(document.title).toBe("Niko - MyBook")
    cleanup()
  })
})
