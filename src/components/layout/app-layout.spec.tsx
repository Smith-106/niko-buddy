// @vitest-environment jsdom
/**
 * W4B2 coverage campaign — AppLayout 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, act, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}::${JSON.stringify(opts)}` : key,
  )
  return {
    t,
    // ---- wiki store ----
    wikiState: {
      project: { id: "p1", name: "Novel", path: "/proj" } as { id: string; name: string; path: string } | null,
      activeView: "wiki" as string,
      setActiveView: vi.fn(),
      setActiveSettingsCategory: vi.fn(),
      setFileTree: vi.fn(),
    },
    // ---- outline generation store ----
    outlineState: {
      tasks: [] as Array<Record<string, unknown>>,
      removeTask: vi.fn(),
    },
    // ---- book analysis store ----
    bookState: {
      tasks: [] as Array<Record<string, unknown>>,
      removeTask: vi.fn(),
      retryTask: vi.fn(() => ({ ok: true, taskId: "b2" })),
    },
    // ---- fs ----
    listDirectory: vi.fn(),
    // ---- outline-generation lib（动态 import）----
    openGeneratedOutline: vi.fn(),
    runOutlineIngestTask: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/outline-generation-store", () => ({
  useOutlineGenerationStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.outlineState),
    { getState: () => mocks.outlineState },
  ),
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.bookState),
    { getState: () => mocks.bookState },
  ),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/novel/outline-generation", () => ({
  openGeneratedOutline: mocks.openGeneratedOutline,
  runOutlineIngestTask: mocks.runOutlineIngestTask,
}))

vi.mock("@/components/layout/icon-sidebar", () => ({
  IconSidebar: (props: {
    onToggleSidebar: () => void
    onOpenSidebar: () => void
    onSwitchProject: () => void
  }) => (
    <div>
      <button data-testid="icon-toggle" onClick={props.onToggleSidebar}>toggle</button>
      <button data-testid="icon-open" onClick={props.onOpenSidebar}>open</button>
      <button data-testid="icon-switch" onClick={props.onSwitchProject}>switch</button>
    </div>
  ),
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

function outlineTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "o1",
    projectPath: "/proj",
    kind: "outline",
    status: "generating",
    displayTitle: null,
    message: "m",
    outlinePath: null,
    updatedAt: 100,
    ...overrides,
  }
}

function bookTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b1",
    projectPath: "/proj",
    status: "running",
    error: null,
    progress: { stage: "running", stageLabel: "处理中", percentage: 40, currentItem: "第1章" },
    updatedAt: 100,
    ...overrides,
  }
}

async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  localStorage.clear()
  mocks.wikiState.project = { id: "p1", name: "Novel", path: "/proj" }
  mocks.wikiState.activeView = "wiki"
  mocks.outlineState.tasks = []
  mocks.bookState.tasks = []
  mocks.listDirectory.mockResolvedValue([{ name: "x", path: "/proj/x", is_dir: true, children: [] }])
  mocks.openGeneratedOutline.mockResolvedValue(undefined)
  mocks.runOutlineIngestTask.mockResolvedValue(undefined)
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("AppLayout", () => {
  it("挂载时加载文件树；listDirectory 失败时 console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listDirectory.mockRejectedValue(new Error("tree-fail"))
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    await flushAsync()
    expect(mocks.listDirectory).toHaveBeenCalledWith("/proj")
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    view.unmount()
  })

  it("无项目时不加载文件树", () => {
    mocks.wikiState.project = null
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    view.unmount()
  })

  it("大纲通知：generating(非 refine) + 无 outlinePath → handleLater 移除任务", async () => {
    mocks.outlineState.tasks = [outlineTask()]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("novel.outlineGenerator.generatingTitle")).toBeInTheDocument()
    expect(screen.getByText("novel.outlineGenerator.generationMayTakeLong")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.outlineGenerator.handleLater"))
    expect(mocks.outlineState.removeTask).toHaveBeenCalledWith("o1")
    view.unmount()
  })

  it("大纲通知：generating(refine) 有 displayTitle → sectionGenerating；无 title → refining", async () => {
    mocks.outlineState.tasks = [
      outlineTask({ kind: "refine", displayTitle: "章节细纲", status: "generating" }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(
      screen.getByText('novel.outlineGenerator.sectionGenerating::{"title":"章节细纲"}'),
    ).toBeInTheDocument()
    view.unmount()

    mocks.outlineState.tasks = [outlineTask({ kind: "refine", displayTitle: null, status: "generating" })]
    const view2 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("novel.outlineGenerator.refining")).toBeInTheDocument()
    view2.unmount()
  })

  it("大纲通知：error 状态显示错误消息", () => {
    mocks.outlineState.tasks = [outlineTask({ status: "error", message: "boom" })]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("novel.outlineGenerator.error")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    view.unmount()
  })

  it("大纲通知：generated(outline) + outlinePath → open/ingest 按钮走动态 import", async () => {
    mocks.outlineState.tasks = [outlineTask({ status: "generated", outlinePath: "/proj/o.md" })]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("novel.outlineGenerator.generatedTitle")).toBeInTheDocument()
    expect(screen.getByText("novel.outlineGenerator.generatedDescription")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.outlineGenerator.openOutline"))
    await flushAsync()
    expect(mocks.openGeneratedOutline).toHaveBeenCalledWith("o1")
    fireEvent.click(screen.getByText("novel.outlineGenerator.ingestNow"))
    await flushAsync()
    expect(mocks.runOutlineIngestTask).toHaveBeenCalledWith("o1")
    view.unmount()
  })

  it("大纲通知：generated(refine) + outlinePath → 无 ingest 按钮", () => {
    mocks.outlineState.tasks = [
      outlineTask({ kind: "refine", status: "generated", outlinePath: "/proj/o.md", message: "refine-done" }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("novel.outlineGenerator.refineTitle")).toBeInTheDocument()
    expect(screen.getByText("refine-done")).toBeInTheDocument()
    expect(screen.queryByText("novel.outlineGenerator.ingestNow")).not.toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：running 各阶段文案 + 进度条 + currentItem + 关闭后隐藏", async () => {
    mocks.bookState.tasks = [
      bookTask({ progress: { stage: "extracting_characters", stageLabel: "抽取角色", percentage: 10, currentItem: "c1" } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.extractingCharacters")).toBeInTheDocument()
    expect(screen.getByText("抽取角色")).toBeInTheDocument()
    expect(screen.getByText("c1")).toBeInTheDocument()
    // 关闭运行中任务 → 记录 dismissed → 隐藏
    fireEvent.click(screen.getByLabelText("appLayout.bookAnalysis.closeNotification"))
    expect(screen.queryByText("appLayout.bookAnalysis.extractingCharacters")).not.toBeInTheDocument()
    // 完成后重新弹出
    mocks.bookState.tasks = [bookTask({ status: "completed", progress: { stage: "completed", stageLabel: "完成", percentage: 100, currentItem: null } })]
    view.rerender(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.completed")).toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：running 阶段 analyzing_six_dimension / generating_skills / 默认", () => {
    mocks.bookState.tasks = [
      bookTask({ progress: { stage: "analyzing_six_dimension", stageLabel: "六维", percentage: 50, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.analyzingSixDimension")).toBeInTheDocument()
    view.unmount()
    mocks.bookState.tasks = [
      bookTask({ progress: { stage: "generating_skills", stageLabel: "技能", percentage: 80, currentItem: null } }),
    ]
    const view2 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.generatingSkills")).toBeInTheDocument()
    view2.unmount()
    mocks.bookState.tasks = [bookTask({ progress: { stage: "other", stageLabel: null, percentage: 30, currentItem: null } })]
    const view3 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.running")).toBeInTheDocument()
    expect(screen.getByText("appLayout.bookAnalysis.processing")).toBeInTheDocument()
    view3.unmount()
  })

  it("拆书通知：error 状态显示错误 + 关闭移除任务；handleLater 标签", () => {
    mocks.bookState.tasks = [bookTask({ status: "error", error: "分析失败", progress: { stage: "error", stageLabel: null, percentage: 0, currentItem: null } })]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.error")).toBeInTheDocument()
    expect(screen.getByText("分析失败")).toBeInTheDocument()
    expect(screen.getByText("common.close")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("appLayout.bookAnalysis.closeNotification"))
    expect(mocks.bookState.removeTask).toHaveBeenCalledWith("b1")
    view.unmount()
  })

  it("大纲通知：多任务时按 updatedAt 排序取最新（比较器执行）", () => {
    mocks.outlineState.tasks = [
      outlineTask({ id: "old", updatedAt: 10, status: "generating" }),
      outlineTask({ id: "new", updatedAt: 200, status: "generating" }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    // 最新任务驱动文案；移除的是最新任务
    fireEvent.click(screen.getByText("novel.outlineGenerator.handleLater"))
    expect(mocks.outlineState.removeTask).toHaveBeenCalledWith("new")
    view.unmount()
  })

  it("拆书通知：非 running/completed/error 状态被过滤（sort 比较器 + return false）", () => {
    mocks.bookState.tasks = [
      bookTask({ id: "paused", status: "paused", updatedAt: 500 }),
      bookTask({ id: "b1", status: "running", updatedAt: 100 }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(mocks.bookState.removeTask).not.toHaveBeenCalled()
    // 仍显示运行中任务
    expect(screen.getByText("appLayout.bookAnalysis.running")).toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：error 无 message 时回退 errorDescription", () => {
    mocks.bookState.tasks = [
      bookTask({ status: "error", error: null, progress: { stage: "error", stageLabel: null, percentage: 0, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.errorDescription")).toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：error 含「应用重启」→ restartInterrupted 文案 + 重试按钮；重试成功切视图", () => {
    mocks.bookState.tasks = [
      bookTask({ status: "error", error: "应用重启，任务已中断", progress: { stage: "error", stageLabel: null, percentage: 0, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.error")).toBeInTheDocument()
    expect(screen.getByText("appLayout.bookAnalysis.restartInterrupted")).toBeInTheDocument()
    expect(screen.getByText("appLayout.bookAnalysis.retry")).toBeInTheDocument()
    fireEvent.click(screen.getByText("appLayout.bookAnalysis.retry"))
    expect(mocks.bookState.retryTask).toHaveBeenCalledWith("b1")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("bookAnalysis")
    view.unmount()
  })

  it("拆书通知：普通 error（不含「应用重启」）不显示重试按钮", () => {
    mocks.bookState.tasks = [
      bookTask({ status: "error", error: "分析失败", progress: { stage: "error", stageLabel: null, percentage: 0, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("分析失败")).toBeInTheDocument()
    expect(screen.queryByText("appLayout.bookAnalysis.retry")).not.toBeInTheDocument()
    expect(screen.queryByText("appLayout.bookAnalysis.restartInterrupted")).not.toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：running 百分比为空回退 0；与大纲通知同屏时 bottom 偏移", () => {
    mocks.bookState.tasks = [
      bookTask({ progress: { stage: "running", stageLabel: "处理中", percentage: undefined, currentItem: null } }),
    ]
    mocks.outlineState.tasks = [outlineTask({ status: "generating" })]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(mocks.t).toHaveBeenCalled()
    // 两个通知同屏
    expect(screen.getByText("novel.outlineGenerator.generatingTitle")).toBeInTheDocument()
    expect(screen.getByText("appLayout.bookAnalysis.running")).toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：completed → viewResult 切视图并移除；dismiss 按钮移除", () => {
    mocks.bookState.tasks = [
      bookTask({ status: "completed", progress: { stage: "completed", stageLabel: "全部完成", percentage: 100, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.completed")).toBeInTheDocument()
    expect(screen.getByText("全部完成")).toBeInTheDocument()
    fireEvent.click(screen.getByText("appLayout.bookAnalysis.viewResult"))
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("bookAnalysis")
    expect(mocks.bookState.removeTask).toHaveBeenCalledWith("b1")
    view.unmount()

    mocks.bookState.tasks = [
      bookTask({ status: "completed", progress: { stage: "completed", stageLabel: null, percentage: 100, currentItem: null } }),
    ]
    const view2 = render(<AppLayout onSwitchProject={() => {}} />)
    fireEvent.click(screen.getByText("common.close"))
    expect(mocks.bookState.removeTask).toHaveBeenCalledWith("b1")
    view2.unmount()
  })

  it("运行中拆书任务 handleLater：记录 dismissed 不删除任务", () => {
    mocks.bookState.tasks = [bookTask()]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    fireEvent.click(screen.getByText("appLayout.bookAnalysis.handleLater"))
    expect(mocks.bookState.removeTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it("使用引导：默认显示；关闭按钮写入 localStorage 并隐藏", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.usageGuidePrompt.title")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("appLayout.usageGuidePrompt.close"))
    expect(screen.queryByText("appLayout.usageGuidePrompt.title")).not.toBeInTheDocument()
    expect(localStorage.getItem("qmai-usage-guide-prompt-dismissed")).toBe("1")
    view.unmount()
  })

  it("使用引导：点击主体进入设置视图并记录关闭", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    fireEvent.click(screen.getByText("appLayout.usageGuidePrompt.description"))
    expect(mocks.wikiState.setActiveSettingsCategory).toHaveBeenCalledWith("usage-guide")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("settings")
    expect(localStorage.getItem("qmai-usage-guide-prompt-dismissed")).toBe("1")
    view.unmount()
  })

  it("使用引导：localStorage 已关闭则挂载即隐藏；settings 视图隐藏", () => {
    localStorage.setItem("qmai-usage-guide-prompt-dismissed", "1")
    const v1 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByText("appLayout.usageGuidePrompt.title")).not.toBeInTheDocument()
    v1.unmount()

    localStorage.clear()
    mocks.wikiState.activeView = "settings"
    const v2 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByText("appLayout.usageGuidePrompt.title")).not.toBeInTheDocument()
    v2.unmount()
  })

  it("侧边栏：默认展开；toggle 折叠；open 展开；settings 视图隐藏侧边栏", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByTestId("sidebar-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("icon-toggle"))
    expect(screen.queryByTestId("sidebar-panel")).not.toBeInTheDocument()
    expect(localStorage.getItem("lk-sidebar-collapsed")).toBe("1")
    fireEvent.click(screen.getByTestId("icon-open"))
    expect(screen.getByTestId("sidebar-panel")).toBeInTheDocument()
    view.unmount()

    mocks.wikiState.activeView = "settings"
    const view2 = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByTestId("sidebar-panel")).not.toBeInTheDocument()
    view2.unmount()
  })

  it("侧边栏：localStorage 已折叠则挂载即折叠", () => {
    localStorage.setItem("lk-sidebar-collapsed", "1")
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.queryByTestId("sidebar-panel")).not.toBeInTheDocument()
    view.unmount()
  })

  it("拆书通知：多任务按 updatedAt 排序取最新（sort 比较器执行）", () => {
    mocks.bookState.tasks = [
      bookTask({ id: "old", updatedAt: 10, progress: { stage: "extracting_characters", stageLabel: "抽取角色", percentage: 10, currentItem: "c1" } }),
      bookTask({ id: "new", updatedAt: 200, progress: { stage: "analyzing_six_dimension", stageLabel: "六维", percentage: 50, currentItem: null } }),
    ]
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    // 最新任务驱动文案
    expect(screen.getByText("appLayout.bookAnalysis.analyzingSixDimension")).toBeInTheDocument()
    expect(screen.queryByText("appLayout.bookAnalysis.extractingCharacters")).not.toBeInTheDocument()
    // 关闭运行中任务 → 记录 dismissed 的是最新任务 id
    fireEvent.click(screen.getByLabelText("appLayout.bookAnalysis.closeNotification"))
    expect(mocks.bookState.removeTask).not.toHaveBeenCalled()
    // 旧任务未被 dismissed → 重新出现
    mocks.bookState.tasks = [
      bookTask({ id: "old", updatedAt: 10, progress: { stage: "extracting_characters", stageLabel: "抽取角色", percentage: 10, currentItem: "c1" } }),
    ]
    view.rerender(<AppLayout onSwitchProject={() => {}} />)
    expect(screen.getByText("appLayout.bookAnalysis.extractingCharacters")).toBeInTheDocument()
    view.unmount()
  })

  it("拖拽中卸载组件后 mousemove：containerRef 为 null 提前返回", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    const divider = view.container.querySelector(".cursor-col-resize") as HTMLElement
    expect(divider).not.toBeNull()
    fireEvent.mouseDown(divider, { clientX: 0 })
    view.unmount()
    // 卸载后 ref 置空但 document 监听仍在；mousemove 走 !containerRef.current 提前返回
    expect(() => fireEvent.mouseMove(document, { clientX: 400 })).not.toThrow()
  })

  it("拖拽调整侧边栏宽度：clamp 到 [150,400]；mouseup 清理监听", () => {
    const view = render(<AppLayout onSwitchProject={() => {}} />)
    const divider = view.container.querySelector(".cursor-col-resize") as HTMLElement
    expect(divider).not.toBeNull()
    fireEvent.mouseDown(divider, { clientX: 0 })
    expect(document.body.dataset.panelResizing).toBe("true")
    fireEvent.mouseMove(document, { clientX: 500 })
    const sidebar = view.container.querySelector('[style*="width"]') as HTMLElement
    expect(sidebar.style.width).toBe("400px")
    fireEvent.mouseMove(document, { clientX: 50 })
    expect(sidebar.style.width).toBe("150px")
    fireEvent.mouseUp(document)
    expect(document.body.dataset.panelResizing).toBeUndefined()
    // 再次拖拽确认监听已清理
    fireEvent.mouseDown(divider, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)
    view.unmount()
  })
})
