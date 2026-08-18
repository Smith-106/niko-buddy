// @vitest-environment jsdom
/**
 * W4B2 coverage campaign — ActivityPanel 全口径 100%。
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
      sourceWatchConfig: { enabled: true },
      setSelectedFile: vi.fn(),
    },
    // ---- activity store ----
    activityState: {
      items: [] as Array<{
        id: string
        type: string
        title: string
        status: "running" | "done" | "error"
        detail: string
        filesWritten: string[]
        createdAt: number
      }>,
      clearDone: vi.fn(),
    },
    // ---- file sync store ----
    fileSyncState: {
      tasks: [] as Array<Record<string, unknown>>,
      lastError: null as string | null,
      setTasks: vi.fn(),
      setLastError: vi.fn(),
    },
    // ---- ingest queue ----
    getQueue: vi.fn(() => [] as unknown[]),
    getQueueSummary: vi.fn(() => ({ pending: 0, processing: 0, failed: 0, total: 0 })),
    retryTask: vi.fn(),
    cancelTask: vi.fn(),
    cancelAllTasks: vi.fn(),
    // ---- file sync commands ----
    rescanProjectFiles: vi.fn(),
    retryFileChangeTask: vi.fn(),
    ignoreFileChangeTask: vi.fn(),
    confirm: vi.fn(() => true),
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

vi.mock("@/stores/activity-store", () => ({
  useActivityStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.activityState),
    { getState: () => mocks.activityState },
  ),
}))

vi.mock("@/stores/file-sync-store", () => ({
  useFileSyncStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.fileSyncState),
    { getState: () => mocks.fileSyncState },
  ),
}))

vi.mock("@/lib/ingest-queue", () => ({
  getQueue: mocks.getQueue,
  getQueueSummary: mocks.getQueueSummary,
  retryTask: mocks.retryTask,
  cancelTask: mocks.cancelTask,
  cancelAllTasks: mocks.cancelAllTasks,
}))

vi.mock("@/commands/file-sync", () => ({
  rescanProjectFiles: mocks.rescanProjectFiles,
  retryFileChangeTask: mocks.retryFileChangeTask,
  ignoreFileChangeTask: mocks.ignoreFileChangeTask,
}))

import { ActivityPanel } from "./activity-panel"

function makeItem(overrides: Record<string, unknown> = {}): (typeof mocks.activityState.items)[number] {
  return {
    id: "act-1",
    type: "ingest",
    title: "任务一",
    status: "done",
    detail: "细节",
    filesWritten: [],
    createdAt: 1,
    ...overrides,
  }
}

function makeQueueTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    sourcePath: "/proj/raw/文件.pdf",
    status: "processing",
    folderContext: "ctx",
    error: null,
    ...overrides,
  }
}

function makeFileSyncTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "fs-1",
    path: "/proj/wiki/chapters/1.md",
    kind: "created",
    status: "pending",
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.wikiState.project = { id: "p1", name: "Novel", path: "/proj" }
  mocks.activityState.items = []
  mocks.fileSyncState.tasks = []
  mocks.fileSyncState.lastError = null
  mocks.getQueue.mockReturnValue([])
  mocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 0, failed: 0, total: 0 })
  mocks.rescanProjectFiles.mockResolvedValue({ queue: { tasks: [] } })
  mocks.retryFileChangeTask.mockResolvedValue({ tasks: [] })
  mocks.ignoreFileChangeTask.mockResolvedValue({ tasks: [] })
  mocks.confirm.mockReturnValue(true)
  vi.spyOn(window, "confirm").mockImplementation(mocks.confirm as never)
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("ActivityPanel", () => {
  it("无 items / 无队列 / 无文件同步时不渲染", () => {
    const view = render(<ActivityPanel />)
    expect(view.container.innerHTML).toBe("")
    view.unmount()
  })

  it("队列有任务：状态文本 + 进度条 + cancelAll + QueueRow 各状态分支", () => {
    vi.useFakeTimers()
    mocks.getQueueSummary.mockReturnValue({ pending: 1, processing: 1, failed: 1, total: 3 })
    mocks.getQueue.mockReturnValue([
      makeQueueTask({ id: "q1", sourcePath: "/proj/raw/a.pdf", status: "processing", folderContext: "folderA" }),
      makeQueueTask({ id: "q2", sourcePath: "/proj/raw/b.pdf", status: "pending", folderContext: "folderB" }),
      makeQueueTask({ id: "q3", sourcePath: "/proj/raw/c.pdf", status: "failed", error: "解析失败" }),
    ])
    const view = render(<ActivityPanel />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(mocks.t).toHaveBeenCalledWith("activity.queueStatus", { done: 1, total: 3 })
    expect(mocks.t).toHaveBeenCalledWith("activity.failedSuffix", { count: 1 })
    expect(screen.getByText("activity.ingestQueue")).toBeInTheDocument()
    expect(screen.getByText("activity.completedProgress", { exact: false })).toBeInTheDocument()
    // QueueRow 图标/文案
    expect(screen.getByText("a.pdf")).toBeInTheDocument()
    expect(screen.getByText("folderA")).toBeInTheDocument()
    expect(screen.getByText("解析失败")).toBeInTheDocument()
    // cancelAll 按钮（pending+processing >= 2）
    const cancelAll = screen.getByTitle("activity.cancelAllTitle")
    fireEvent.click(cancelAll)
    expect(mocks.cancelAllTasks).toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledWith("activity.cancelAllConfirm::{\"count\":2}")
    // QueueRow retry / cancel
    fireEvent.click(screen.getAllByTitle("activity.retry")[0])
    expect(mocks.retryTask).toHaveBeenCalledWith("q3")
    // processing(q1) 在前，pending(q2) 在后
    fireEvent.click(screen.getAllByTitle("activity.cancel")[1])
    expect(mocks.cancelTask).toHaveBeenCalledWith("q2")
    // 进度条宽度
    expect(view.container.querySelector(".bg-primary")).not.toBeNull()
    vi.useRealTimers()
    view.unmount()
  })

  it("队列失败任务取消确认被拒绝时不调用 cancelAllTasks", () => {
    vi.useFakeTimers()
    mocks.getQueueSummary.mockReturnValue({ pending: 1, processing: 1, failed: 0, total: 2 })
    mocks.getQueue.mockReturnValue([
      makeQueueTask({ id: "q1", sourcePath: "/proj/raw/a.pdf", status: "processing" }),
      makeQueueTask({ id: "q2", sourcePath: "/proj/raw/b.pdf", status: "pending" }),
    ])
    mocks.confirm.mockReturnValue(false)
    const view = render(<ActivityPanel />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    fireEvent.click(screen.getByTitle("activity.cancelAllTitle"))
    expect(mocks.cancelAllTasks).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("仅失败队列：taskFailed 状态 + 无进度条", () => {
    vi.useFakeTimers()
    mocks.getQueueSummary.mockReturnValue({ pending: 0, processing: 0, failed: 2, total: 2 })
    mocks.getQueue.mockReturnValue([
      makeQueueTask({ id: "q3", sourcePath: "/proj/raw/c.pdf", status: "failed", error: "err" }),
    ])
    const view = render(<ActivityPanel />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(mocks.t).toHaveBeenCalledWith("activity.taskFailed", { count: 2 })
    expect(screen.queryByText("activity.ingestQueue")).not.toBeInTheDocument()
    expect(screen.getByText("err")).toBeInTheDocument()
    vi.useRealTimers()
    view.unmount()
  })

  it("running 活动：processing 状态 + 自动展开 + 匹配队列任务显示取消按钮", () => {
    vi.useFakeTimers()
    mocks.activityState.items = [
      makeItem({ id: "act-1", title: "目标文件.pdf", status: "running", detail: "进行中" }),
    ]
    mocks.getQueue.mockReturnValue([
      makeQueueTask({ id: "q1", sourcePath: "/proj/raw/目标文件.pdf", status: "processing" }),
      makeQueueTask({ id: "q2", sourcePath: "/proj/raw/别的.pdf", status: "processing" }),
    ])
    const view = render(<ActivityPanel />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(mocks.t).toHaveBeenCalledWith("activity.processing", { title: "目标文件.pdf" })
    // 匹配的 running 活动显示取消按钮：队列 q1/q2 + 活动行 = 3 个
    const cancelButtons = screen.getAllByTitle("activity.cancel")
    expect(cancelButtons).toHaveLength(3)
    // 点击活动行自身的取消按钮 → handleIngestCancel(matchingTask.id)=q1
    fireEvent.click(cancelButtons[2])
    expect(mocks.cancelTask).toHaveBeenCalledWith("q1")
    vi.useRealTimers()
    view.unmount()
  })

  it("running 活动无匹配队列任务时不显示取消按钮；全部 running 时无清空按钮", () => {
    mocks.activityState.items = [
      makeItem({ id: "act-1", title: "无匹配.pdf", status: "running", detail: "x" }),
    ]
    const view = render(<ActivityPanel />)
    expect(screen.queryByTitle("activity.cancel")).not.toBeInTheDocument()
    expect(screen.queryByText("activity.clearCompleted")).not.toBeInTheDocument()
    view.unmount()
  })

  it("done 活动 + filesWritten 全类型图标 + 文件点击跳转 + 相对路径拼接 + 清空完成按钮", () => {
    mocks.activityState.items = [
      makeItem({
        id: "act-done",
        title: "完成的任务",
        status: "done",
        detail: "OK",
        filesWritten: [
          "wiki/sources/rel-s.md",
          "/proj/wiki/entities/e.md",
          "/proj/wiki/concepts/c.md",
          "/proj/wiki/queries/q.md",
          "/proj/wiki/synthesis/sy.md",
          "/proj/wiki/comparisons/cm.md",
          "/proj/index.md",
          "/proj/log.md",
          "/proj/other.md",
          "C:\\abs\\win.md",
        ],
      }),
    ]
    const view = render(<ActivityPanel />)
    // 无队列/无文件同步时不自动展开，需点击头部展开
    fireEvent.click(screen.getByRole("button", { name: /activity\.done/ }))
    expect(screen.getByText("来源")).toBeInTheDocument()
    expect(screen.getByText("实体")).toBeInTheDocument()
    expect(screen.getByText("概念")).toBeInTheDocument()
    expect(screen.getByText("查询")).toBeInTheDocument()
    expect(screen.getByText("综合")).toBeInTheDocument()
    expect(screen.getByText("对比")).toBeInTheDocument()
    expect(screen.getByText("索引")).toBeInTheDocument()
    expect(screen.getByText("日志")).toBeInTheDocument()
    expect(screen.getAllByText("文件")).toHaveLength(2)
    // 相对路径 → project path 拼接
    fireEvent.click(screen.getByText("rel-s.md"))
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/sources/rel-s.md")
    // 绝对路径 → normalizePath 转正斜杠
    fireEvent.click(screen.getByText("win.md"))
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("C:/abs/win.md")
    // 清空完成按钮
    fireEvent.click(screen.getByText("activity.clearCompleted"))
    expect(mocks.activityState.clearDone).toHaveBeenCalled()
    view.unmount()
  })

  it("error 活动 + filesWritten 为空不渲染文件列表 + 无项目时点击不跳转", () => {
    mocks.activityState.items = [
      makeItem({ id: "act-err", title: "失败", status: "error", detail: "boom", filesWritten: ["/proj/a.md"] }),
    ]
    mocks.wikiState.project = null
    const view = render(<ActivityPanel />)
    // 无自动展开，需点击头部展开后才渲染 ActivityRow
    fireEvent.click(screen.getByRole("button", { name: /activity\.done/ }))
    expect(screen.getByText("失败")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.queryByText("文件")).not.toBeInTheDocument()
    expect(screen.queryByText("a.md")).not.toBeInTheDocument()
    view.unmount()
  })

  it("文件同步：pending/processing/failed 行 + 错误文本 + retry/ignore + rescan", async () => {
    mocks.fileSyncState.tasks = [
      makeFileSyncTask({ id: "fs1", path: "/proj/wiki/chapters/1.md", kind: "created", status: "pending" }),
      makeFileSyncTask({ id: "fs2", path: "/proj/wiki/chapters/2.md", kind: "modified", status: "processing" }),
      makeFileSyncTask({ id: "fs3", path: "/proj/wiki/chapters/3.md", kind: "deleted", status: "failed", error: "同步失败" }),
    ]
    mocks.fileSyncState.lastError = "目录扫描出错"
    const view = render(<ActivityPanel />)

    expect(mocks.t).toHaveBeenCalledWith("activity.fileSyncPendingStatus", { count: 2 })
    expect(screen.getByText("目录扫描出错")).toBeInTheDocument()
    expect(screen.getByText("同步失败")).toBeInTheDocument()
    expect(screen.getByText("Created - /proj/wiki/chapters/1.md")).toBeInTheDocument()
    expect(screen.getByText("Modified - /proj/wiki/chapters/2.md")).toBeInTheDocument()
    expect(screen.getByText("Deleted - /proj/wiki/chapters/3.md")).toBeInTheDocument()
    // rescan（异步 promise 需冲刷）
    fireEvent.click(screen.getByText("activity.rescan"))
    await act(async () => {})
    expect(mocks.rescanProjectFiles).toHaveBeenCalledWith("p1", "/proj", { enabled: true })
    expect(mocks.fileSyncState.setTasks).toHaveBeenCalledWith([])
    expect(mocks.fileSyncState.setLastError).toHaveBeenCalledWith(null)
    // retry / ignore
    fireEvent.click(screen.getAllByTitle("activity.retry")[0])
    await act(async () => {})
    expect(mocks.retryFileChangeTask).toHaveBeenCalledWith("p1", "/proj", "fs3")
    fireEvent.click(screen.getAllByTitle("activity.ignore")[0])
    await act(async () => {})
    expect(mocks.ignoreFileChangeTask).toHaveBeenCalledWith("p1", "/proj", "fs3")
    view.unmount()
  })

  it("文件同步：rescan/retry/ignore 失败时写入 lastError（String(err) 含 Error: 前缀）", async () => {
    mocks.rescanProjectFiles.mockRejectedValue(new Error("rescan-err"))
    mocks.retryFileChangeTask.mockRejectedValue(new Error("retry-err"))
    mocks.ignoreFileChangeTask.mockRejectedValue(new Error("ignore-err"))
    mocks.fileSyncState.tasks = [
      makeFileSyncTask({ id: "fs3", path: "/p/3.md", kind: "created", status: "failed", error: "x" }),
    ]
    const view = render(<ActivityPanel />)
    fireEvent.click(screen.getByText("activity.rescan"))
    await act(async () => {})
    expect(mocks.fileSyncState.setLastError).toHaveBeenCalledWith("Error: rescan-err")
    fireEvent.click(screen.getAllByTitle("activity.retry")[0])
    await act(async () => {})
    expect(mocks.fileSyncState.setLastError).toHaveBeenCalledWith("Error: retry-err")
    fireEvent.click(screen.getAllByTitle("activity.ignore")[0])
    await act(async () => {})
    expect(mocks.fileSyncState.setLastError).toHaveBeenCalledWith("Error: ignore-err")
    expect(mocks.ignoreFileChangeTask).toHaveBeenCalled()
    view.unmount()
  })

  it("文件同步失败计数状态：fileSyncFailedStatus", () => {
    mocks.fileSyncState.tasks = [
      makeFileSyncTask({ id: "fs1", path: "/p/1.md", kind: "created", status: "failed", error: "e" }),
    ]
    render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.fileSyncFailedStatus", { count: 1 })
  })

  it("仅 fileSyncError：fileSyncFailed 状态", () => {
    mocks.fileSyncState.lastError = "sync-error"
    render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.fileSyncFailed")
  })

  it("仅 pending 文件同步任务（无 processing）→ fileSyncPendingStatus 右操作数分支", () => {
    mocks.fileSyncState.tasks = [
      makeFileSyncTask({ id: "fs-p", path: "/p/1.md", kind: "created", status: "pending" }),
    ]
    render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.fileSyncPendingStatus", { count: 1 })
  })

  it("running 活动无标题 → processing 状态使用省略号回退", () => {
    mocks.activityState.items = [
      makeItem({ id: "act-r", title: undefined, status: "running" }),
    ]
    render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.processing", { title: "..." })
  })

  it("done 状态：有 item 显示标题，仅 done 文件同步任务时显示 allTasksDone 回退", () => {
    mocks.activityState.items = [makeItem({ title: "已完成任务" })]
    const v1 = render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.done", { title: "已完成任务" })
    v1.unmount()

    mocks.activityState.items = []
    mocks.fileSyncState.tasks = [makeFileSyncTask({ id: "fs-done", path: "/p/1.md", kind: "created", status: "done" })]
    const v2 = render(<ActivityPanel />)
    expect(mocks.t).toHaveBeenCalledWith("activity.done", {
      title: "activity.allTasksDone",
    })
    v2.unmount()
  })

  it("展开/折叠切换（无队列自动展开干扰）+ 无项目时队列按钮守卫", () => {
    mocks.activityState.items = [makeItem({ title: "t1" })]
    mocks.wikiState.project = null
    const view = render(<ActivityPanel />)
    // 有 item 但无队列/文件同步 → 初始折叠
    expect(screen.queryByText("activity.clearCompleted")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /activity\.done/ }))
    expect(screen.getByText("activity.clearCompleted")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /activity\.done/ }))
    expect(screen.queryByText("activity.clearCompleted")).not.toBeInTheDocument()
    view.unmount()
  })

  it("无项目时队列 retry/cancel/cancelAll 守卫：不调用底层函数", () => {
    vi.useFakeTimers()
    mocks.wikiState.project = null
    mocks.getQueueSummary.mockReturnValue({ pending: 2, processing: 0, failed: 1, total: 3 })
    mocks.getQueue.mockReturnValue([
      makeQueueTask({ id: "q1", sourcePath: "/p/a.pdf", status: "pending" }),
      makeQueueTask({ id: "q2", sourcePath: "/p/b.pdf", status: "pending" }),
      makeQueueTask({ id: "q3", sourcePath: "/p/c.pdf", status: "failed", error: "e" }),
    ])
    const view = render(<ActivityPanel />)
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.click(screen.getByTitle("activity.cancelAllTitle"))
    fireEvent.click(screen.getAllByTitle("activity.cancel")[0])
    fireEvent.click(screen.getAllByTitle("activity.retry")[0])
    expect(mocks.cancelAllTasks).not.toHaveBeenCalled()
    expect(mocks.cancelTask).not.toHaveBeenCalled()
    expect(mocks.retryTask).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("无项目时文件同步 rescan/retry/ignore 守卫：不调用底层函数", () => {
    mocks.wikiState.project = null
    mocks.fileSyncState.tasks = [
      makeFileSyncTask({ id: "fs1", path: "/p/1.md", kind: "created", status: "failed", error: "e" }),
    ]
    const view = render(<ActivityPanel />)
    fireEvent.click(screen.getByText("activity.rescan"))
    fireEvent.click(screen.getAllByTitle("activity.retry")[0])
    fireEvent.click(screen.getAllByTitle("activity.ignore")[0])
    expect(mocks.rescanProjectFiles).not.toHaveBeenCalled()
    expect(mocks.retryFileChangeTask).not.toHaveBeenCalled()
    expect(mocks.ignoreFileChangeTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it("ActivityRow：无项目时文件点击守卫 + 相对路径拼接", () => {
    mocks.wikiState.project = null
    mocks.activityState.items = [
      makeItem({ id: "act-x", title: "t", status: "done", filesWritten: ["wiki/sources/rel.md"] }),
    ]
    const view = render(<ActivityPanel />)
    fireEvent.click(screen.getByRole("button", { name: /activity\.done/ }))
    fireEvent.click(screen.getByText("rel.md"))
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("项目存在时队列 retry/cancel 走 store 调用；runingCount 持续 >0 不重复展开", () => {
    mocks.activityState.items = [makeItem({ title: "t1", status: "running" })]
    const view = render(<ActivityPanel />)
    // 第二次渲染：runningCount 仍 >0，prevRunningRef 非 0 → 不自动展开（但已展开保持）
    view.rerender(<ActivityPanel />)
    expect(view.container.querySelector(".border-t")).not.toBeNull()
    view.unmount()
  })
})
