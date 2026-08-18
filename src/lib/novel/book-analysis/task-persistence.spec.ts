import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  subscribe: vi.fn<(cb: (s: { tasks: unknown[] }) => void) => () => void>(() => () => {}),
  getState: vi.fn(() => ({ tasks: [] })),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
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
    mocks.writeFile.mockResolvedValue(undefined)

    // Fire a change with a NEW tasks array reference (different from getState()'s snapshot).
    listener({ tasks: [{ ...task, status: "error", error: "中断" }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const args = mocks.writeFile.mock.calls[0]
    expect(args[0]).toContain("book-analysis-tasks.json")
    const written = JSON.parse(args[1] as string) as { status: string }[]
    expect(written[0].status).toBe("error")
    // Volatile fields are not persisted.
    expect(Object.prototype.hasOwnProperty.call(written[0], "characters")).toBe(false)
  })
})
