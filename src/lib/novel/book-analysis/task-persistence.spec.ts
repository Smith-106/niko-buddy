import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  subscribe: vi.fn<(cb: (s: { tasks: unknown[] }) => void) => () => void>(() => () => {}),
  getState: vi.fn<() => { tasks: BookAnalysisTask[] }>(() => ({ tasks: [] })),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: {
    subscribe: mocks.subscribe,
    getState: mocks.getState,
  },
}))

import { loadTaskSummaries, attachTaskPersistence } from "./task-persistence"
import type { BookAnalysisTask } from "./types"

const task = {
  id: "t1",
  projectPath: "C:/p",
  bookId: "b1",
  bookPath: "C:/p/book.txt",
  config: {} as never,
  metadata: {} as never,
  progress: {} as never,
  status: "running" as const,
  error: undefined,
  startedAt: 1,
  updatedAt: 2,
} as unknown as BookAnalysisTask

describe("loadTaskSummaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns [] when readFile throws (file absent)", async () => {
    mocks.readFile.mockRejectedValue(new Error("not found"))
    await expect(loadTaskSummaries("C:/p")).resolves.toEqual([])
  })

  it("parses persisted task summaries", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([task]))
    const out = await loadTaskSummaries("C:/p")
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("t1")
  })
})

describe("attachTaskPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it("subscribes to the store and returns an unsubscribe function", () => {
    mocks.subscribe.mockReturnValue(() => {})
    const detach = attachTaskPersistence("C:/p")
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(typeof detach).toBe("function")
    detach()
  })

  it("writes summaries (debounced) when the task list reference changes", async () => {
    let listener: ((s: { tasks: unknown[] }) => void) = () => {}
    mocks.subscribe.mockImplementation((cb: (s: { tasks: unknown[] }) => void) => {
      listener = cb
      return () => {}
    })
    mocks.getState.mockReturnValue({ tasks: [task] })
    attachTaskPersistence("C:/p")
    mocks.writeFileAtomic.mockResolvedValue(undefined)

    // Fire a change with a NEW tasks array reference (different from getState()'s snapshot).
    listener({ tasks: [{ ...task, status: "error", error: "中断" }] })
    await vi.advanceTimersByTimeAsync(500)
    // 原子写：writeFileAtomic 被调用，普通 writeFile 不参与
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    const args = mocks.writeFileAtomic.mock.calls[0]
    expect(args[0]).toContain("book-analysis-tasks.json")
    const written = JSON.parse(args[1] as string) as { status: string }[]
    expect(written[0].status).toBe("error")
    // Volatile fields are not persisted.
    expect(Object.prototype.hasOwnProperty.call(written[0], "characters")).toBe(false)
  })

  it("same tasks reference → 不写盘（early return）", async () => {
    let listener: ((s: { tasks: unknown[] }) => void) = () => {}
    mocks.subscribe.mockImplementation((cb: (s: { tasks: unknown[] }) => void) => {
      listener = cb
      return () => {}
    })
    const same = { tasks: [task] }
    mocks.getState.mockReturnValue(same)
    attachTaskPersistence("C:/p")
    mocks.writeFileAtomic.mockResolvedValue(undefined)

    // 相同引用（如无关字段更新）→ 不触发写盘
    listener(same)
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("500ms 内多次变更 → 防抖只写一次（timer 清理分支）", async () => {
    let listener: ((s: { tasks: unknown[] }) => void) = () => {}
    mocks.subscribe.mockImplementation((cb: (s: { tasks: unknown[] }) => void) => {
      listener = cb
      return () => {}
    })
    mocks.getState.mockReturnValue({ tasks: [task] })
    attachTaskPersistence("C:/p")
    mocks.writeFileAtomic.mockResolvedValue(undefined)

    listener({ tasks: [{ ...task, status: "running" }] })
    await vi.advanceTimersByTimeAsync(200)
    listener({ tasks: [{ ...task, status: "error", error: "中断" }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const written = JSON.parse(mocks.writeFileAtomic.mock.calls[0][1] as string) as { status: string }[]
    expect(written[0].status).toBe("error")
  })

  it("detach 时清掉挂起 timer（cleanup 分支）", async () => {
    let listener: ((s: { tasks: unknown[] }) => void) = () => {}
    mocks.subscribe.mockImplementation((cb: (s: { tasks: unknown[] }) => void) => {
      listener = cb
      return () => {}
    })
    mocks.getState.mockReturnValue({ tasks: [task] })
    const detach = attachTaskPersistence("C:/p")
    mocks.writeFileAtomic.mockResolvedValue(undefined)

    listener({ tasks: [{ ...task, status: "error" }] })
    detach()
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("写盘失败 → best-effort 静默（catch 分支）", async () => {
    let listener: ((s: { tasks: unknown[] }) => void) = () => {}
    mocks.subscribe.mockImplementation((cb: (s: { tasks: unknown[] }) => void) => {
      listener = cb
      return () => {}
    })
    mocks.getState.mockReturnValue({ tasks: [task] })
    attachTaskPersistence("C:/p")
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))

    listener({ tasks: [{ ...task, status: "error" }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })
})
