import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import { useImportProgressStore } from "./import-progress-store"

describe("import progress store", () => {
  beforeEach(() => {
    useImportProgressStore.setState({ tasks: [] })
  })

  it("keeps chapter memory extraction progress outside the sidebar component", () => {
    const id = useImportProgressStore.getState().startTask({
      projectPath: "E:/Novel",
      kind: "chapter",
      total: 6,
      currentTitle: "第1章",
    })

    useImportProgressStore.getState().updateTask(id, {
      completed: 2,
      currentTitle: "第3章",
    })

    const task = useImportProgressStore.getState().getLatestTask("E:/Novel")
    expect(task?.kind).toBe("chapter")
    expect(task?.status).toBe("running")
    expect(task?.completed).toBe(2)
    expect(task?.total).toBe(6)
    expect(task?.currentTitle).toBe("第3章")
  })
})

describe("import progress store 全路径", () => {
  beforeEach(() => {
    useImportProgressStore.setState({ tasks: [] })
  })

  it("startTask 缺省字段：无 currentTitle 时为空字符串、无 abortController 为 undefined", () => {
    const id = useImportProgressStore.getState().startTask({
      projectPath: "E:\\Novel",
      kind: "outline",
      total: 3,
    })
    const task = useImportProgressStore.getState().getLatestTask("E:/Novel")!
    expect(task.id).toBe(id)
    expect(task.currentTitle).toBe("")
    expect(task.message).toBeUndefined()
    expect(task.abortController).toBeUndefined()
    expect(task.status).toBe("running")
    expect(task.completed).toBe(0)
    expect(task.cancelling).toBe(false)
    expect(task.createdAt).toBeGreaterThan(0)
  })

  it("startTask 携带 message / abortController / currentTitle", () => {
    const ac = new AbortController()
    const id = useImportProgressStore.getState().startTask({
      projectPath: "E:/Novel",
      kind: "outline_generation",
      total: 5,
      currentTitle: "生成中",
      message: "开始生成",
      abortController: ac,
    })
    const task = useImportProgressStore.getState().tasks.find((t) => t.id === id)!
    expect(task.currentTitle).toBe("生成中")
    expect(task.message).toBe("开始生成")
    expect(task.abortController).toBe(ac)
  })

  it("新任务置顶，支持多项目并发", () => {
    const a = useImportProgressStore.getState().startTask({ projectPath: "E:/A", kind: "chapter", total: 1 })
    const b = useImportProgressStore.getState().startTask({ projectPath: "E:/B", kind: "chapter", total: 1 })
    const tasks = useImportProgressStore.getState().tasks
    expect(tasks[0]!.id).toBe(b)
    expect(tasks[1]!.id).toBe(a)
  })

  it("updateTask 未命中时保持任务不变（map else 分支）", () => {
    const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    useImportProgressStore.getState().updateTask("missing", { completed: 99 })
    const task = useImportProgressStore.getState().tasks[0]!
    expect(task.id).toBe(id)
    expect(task.completed).toBe(0)
  })

  it("finishTask 写入终态并清除 cancelling，patch 可附带错误信息", () => {
    const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 10 })
    useImportProgressStore.getState().finishTask(id, "done", { completed: 10, currentTitle: "完成" })
    const task = useImportProgressStore.getState().tasks[0]!
    expect(task.status).toBe("done")
    expect(task.completed).toBe(10)
    expect(task.currentTitle).toBe("完成")
    expect(task.cancelling).toBe(false)

    const errId = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "outline", total: 1 })
    useImportProgressStore.getState().finishTask(errId, "error", { error: "失败原因" })
    const errTask = useImportProgressStore.getState().tasks[0]!
    expect(errTask.status).toBe("error")
    expect(errTask.error).toBe("失败原因")
  })

  it("finishTask 不传 patch 时仅改状态（默认 {}）", () => {
    const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "outline_refinement", total: 2 })
    useImportProgressStore.getState().finishTask(id, "cancelled")
    expect(useImportProgressStore.getState().tasks[0]!.status).toBe("cancelled")
  })

  it("markCancelling 标记 cancelling=true", () => {
    const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    useImportProgressStore.getState().markCancelling(id)
    expect(useImportProgressStore.getState().tasks[0]!.cancelling).toBe(true)
  })

  it("cancelTask 中止控制器、置 cancelled，并在 3s 后自动 clearTask", () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const abortSpy = vi.spyOn(ac, "abort")
      const id = useImportProgressStore.getState().startTask({
        projectPath: "E:/Novel",
        kind: "chapter",
        total: 1,
        abortController: ac,
      })
      useImportProgressStore.getState().cancelTask(id)
      expect(abortSpy).toHaveBeenCalledTimes(1)
      const task = useImportProgressStore.getState().tasks[0]!
      expect(task.status).toBe("cancelled")
      expect(task.cancelling).toBe(false)
      // 3 秒延迟后从列表移除
      vi.advanceTimersByTime(2999)
      expect(useImportProgressStore.getState().tasks).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(useImportProgressStore.getState().tasks).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancelTask 无 abortController 的任务不抛错仍置 cancelled", () => {
    vi.useFakeTimers()
    try {
      const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
      expect(() => useImportProgressStore.getState().cancelTask(id)).not.toThrow()
      expect(useImportProgressStore.getState().tasks[0]!.status).toBe("cancelled")
      vi.advanceTimersByTime(3000)
      expect(useImportProgressStore.getState().tasks).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancelTask 未命中任务时直接返回", () => {
    useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    useImportProgressStore.getState().cancelTask("missing")
    expect(useImportProgressStore.getState().tasks).toHaveLength(1) // 不变
  })

  it("clearTask 直接移除指定任务", () => {
    const id = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "outline", total: 1 })
    useImportProgressStore.getState().clearTask(id)
    const tasks = useImportProgressStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).not.toBe(id)
  })

  it("getLatestTask 支持 kind 过滤：命中、未命中、无任务三种情况", () => {
    useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    expect(useImportProgressStore.getState().getLatestTask("E:/Novel", "chapter")?.kind).toBe("chapter")
    expect(useImportProgressStore.getState().getLatestTask("E:/Novel", "outline")).toBeNull()
    expect(useImportProgressStore.getState().getLatestTask("E:/Other")).toBeNull()
  })

  it("getLatestTask 同项目多任务按 updatedAt 降序返回", async () => {
    const first = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    const second = useImportProgressStore.getState().startTask({ projectPath: "E:/Novel", kind: "chapter", total: 1 })
    await new Promise((r) => setTimeout(r, 2))
    useImportProgressStore.getState().updateTask(first, { completed: 1 })
    const latest = useImportProgressStore.getState().getLatestTask("E:/Novel", "chapter")
    expect(latest?.id).toBe(first) // first 被 updateTask 刷新了 updatedAt
    expect(latest?.completed).toBe(1)
    expect(second).toBeTruthy()
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
