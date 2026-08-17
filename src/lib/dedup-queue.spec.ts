import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  cancelTask,
  clearQueueState,
  enqueueMerge,
  getQueue,
  getQueueSummary,
  groupKey,
  pauseQueue,
  restoreQueue,
  retryTask,
} from "./dedup-queue"
import type { DuplicateGroup } from "./dedup"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  wikiGetState: vi.fn(),
  getProjectPathById: vi.fn(),
  hasUsableLlm: vi.fn(),
  resolveDefaultModel: vi.fn(),
  executeMerge: vi.fn(),
  bumpDataVersion: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.wikiGetState },
}))

vi.mock("@/lib/project-identity", () => ({
  getProjectPathById: mocks.getProjectPathById,
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: mocks.hasUsableLlm,
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: mocks.resolveDefaultModel,
}))

vi.mock("@/lib/dedup-runner", () => ({
  executeMerge: mocks.executeMerge,
}))

const group: DuplicateGroup = { slugs: ["dpao", "dpaos"], reason: "同一实体", confidence: "high" }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function task(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "t1",
    projectId: "pid",
    group,
    canonicalSlug: "dpao",
    status: "pending",
    addedAt: 1,
    error: null,
    retryCount: 0,
    ...partial,
  }
}

describe("groupKey", () => {
  it("joins lowercased slugs in sorted order regardless of input order", () => {
    expect(groupKey(["B", "a"])).toBe("a,b")
    expect(groupKey(["a", "b"])).toBe("a,b")
  })
})

describe("enqueueMerge", () => {
  beforeEach(() => {
    clearQueueState()
    vi.clearAllMocks()
    mocks.getProjectPathById.mockResolvedValue("/proj")
    mocks.wikiGetState.mockReturnValue({
      llmConfig: { provider: "custom" },
      bumpDataVersion: mocks.bumpDataVersion,
    })
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.executeMerge.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.readFile.mockRejectedValue(new Error("no queue file"))
  })

  it("throws when the project is not active", async () => {
    await expect(enqueueMerge("pid", group, "dpao")).rejects.toThrow(/not the active project/)
  })

  it("enqueues a task and processes it to completion", async () => {
    await restoreQueue("pid", "/proj")
    const id = await enqueueMerge("pid", group, "dpao")
    expect(id).toMatch(/^dedup-/)
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.executeMerge).toHaveBeenCalledWith(
      "/proj",
      group,
      "dpao",
      { provider: "custom" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.bumpDataVersion).toHaveBeenCalled()
  })

  it("is idempotent while a matching task is processing", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    const id1 = await enqueueMerge("pid", group, "dpao")
    const id2 = await enqueueMerge("pid", group, "dpao")
    expect(id2).toBe(id1)
    expect(getQueue()).toHaveLength(1)
    expect(getQueueSummary()).toEqual({ pending: 0, processing: 1, failed: 0, total: 1 })
    gate.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("survives a failed saveQueue write", async () => {
    await restoreQueue("pid", "/proj")
    mocks.writeFile.mockRejectedValueOnce(new Error("disk full"))
    const id = await enqueueMerge("pid", group, "dpao")
    expect(id).toMatch(/^dedup-/)
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("returns the existing task id for an already-failed matching task", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "x", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    const id = await enqueueMerge("pid", group, "dpao")
    expect(id).toBe("t1")
    expect(getQueue()).toHaveLength(1)
  })

  it("marks a task failed when the registry has no project path", async () => {
    await restoreQueue("pid", "/proj")
    mocks.getProjectPathById.mockResolvedValue(null)
    const id = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.error).toContain("Project not found")
    expect(id).toBe(getQueue()[0]?.id)
  })

  it("marks a task failed when the LLM is not usable", async () => {
    await restoreQueue("pid", "/proj")
    mocks.hasUsableLlm.mockReturnValue(false)
    const id = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.error).toContain("LLM not configured")
    expect(getQueue()[0]?.id).toBe(id)
    expect(mocks.executeMerge).not.toHaveBeenCalled()
  })
})

describe("retry / cancel / pause / clear", () => {
  beforeEach(() => {
    clearQueueState()
    vi.clearAllMocks()
    mocks.getProjectPathById.mockResolvedValue("/proj")
    mocks.wikiGetState.mockReturnValue({
      llmConfig: { provider: "custom" },
      bumpDataVersion: mocks.bumpDataVersion,
    })
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.executeMerge.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.readFile.mockRejectedValue(new Error("no queue file"))
  })

  it("retryTask resets a failed task and re-runs it", async () => {
    await restoreQueue("pid", "/proj")
    mocks.executeMerge.mockRejectedValue(new Error("llm flake"))
    const id = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.retryCount).toBe(3)
    expect(getQueue()[0]?.error).toBe("llm flake")
    expect(getQueueSummary()).toEqual({ pending: 0, processing: 0, failed: 1, total: 1 })

    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await retryTask(id)
    // retryTask resets the task, then processNext immediately picks it up again
    expect(getQueue()[0]?.status).toBe("processing")
    expect(getQueue()[0]?.retryCount).toBe(0)
    expect(getQueue()[0]?.error).toBeNull()
    gate.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("retryTask is a no-op for unknown ids", async () => {
    await restoreQueue("pid", "/proj")
    await retryTask("missing")
    expect(getQueue()).toHaveLength(0)
  })

  it("retries a non-Error rejection with its string message", async () => {
    await restoreQueue("pid", "/proj")
    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    mocks.executeMerge.mockReturnValueOnce(gate1.promise).mockReturnValueOnce(gate2.promise)
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalledTimes(1))
    gate1.reject("plain boom")
    await vi.waitFor(() => expect(getQueue()[0]?.retryCount).toBe(1))
    expect(getQueue()[0]?.error).toBe("plain boom")
    expect(getQueue()[0]?.status).toBe("processing") // retry re-picked by processNext
    gate2.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("cancelTask aborts a processing task and removes it", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    const id = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalled())
    await cancelTask(id)
    expect(getQueue()).toHaveLength(0)
    expect(mocks.executeMerge.mock.calls[0][4].signal.aborted).toBe(true)
    gate.reject(new Error("aborted"))
    await flush()
  })

  it("cancelTask removes a failed task without touching the abort path", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "x", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    await cancelTask("t1")
    expect(getQueue()).toHaveLength(0)
  })

  it("cancelTask is a no-op for unknown ids", async () => {
    await restoreQueue("pid", "/proj")
    await cancelTask("missing")
    expect(getQueue()).toHaveLength(0)
  })

  it("pauseQueue is a no-op without an active project", async () => {
    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
  })

  it("pauseQueue reverts an in-flight task to pending and persists it", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalled())
    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().total).toBe(0)
    expect(mocks.executeMerge.mock.calls[0][4].signal.aborted).toBe(true)
    const saved = JSON.parse(mocks.writeFile.mock.calls.at(-1)![1] as string)
    expect(saved[0].status).toBe("pending")
    gate.reject(new Error("aborted"))
    await flush()
  })

  it("clearQueueState aborts an in-flight merge", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalled())
    clearQueueState()
    expect(getQueue()).toHaveLength(0)
    expect(mocks.executeMerge.mock.calls[0][4].signal.aborted).toBe(true)
    gate.reject(new Error("aborted"))
    await flush()
  })
})

describe("restoreQueue", () => {
  beforeEach(() => {
    clearQueueState()
    vi.clearAllMocks()
    mocks.getProjectPathById.mockResolvedValue("/proj")
    mocks.wikiGetState.mockReturnValue({
      llmConfig: { provider: "custom" },
      bumpDataVersion: mocks.bumpDataVersion,
    })
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.executeMerge.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.readFile.mockRejectedValue(new Error("no queue file"))
  })

  it("registers the project when the saved queue is empty", async () => {
    mocks.readFile.mockResolvedValue("[]")
    await restoreQueue("pid", "/proj")
    expect(mocks.readFile).toHaveBeenCalledWith("/proj/.qmai/dedup-queue.json")
    expect(getQueue()).toHaveLength(0)
    // project is now active → enqueue works
    const id = await enqueueMerge("pid", group, "dpao")
    expect(id).toMatch(/^dedup-/)
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("treats a missing or corrupted queue file as empty", async () => {
    await restoreQueue("pid", "/proj")
    expect(getQueue()).toHaveLength(0)
    mocks.readFile.mockResolvedValue("not json at all")
    await restoreQueue("pid2", "/proj2")
    expect(getQueue()).toHaveLength(0)
  })

  it("reverts interrupted processing tasks and resumes them", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "processing" })]),
    )
    await restoreQueue("pid", "/proj")
    // reverted to pending and processed automatically
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.executeMerge).toHaveBeenCalledTimes(1)
  })

  it("drops cross-project tasks and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", projectId: "other", status: "pending" }),
      ]),
    )
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropped 1 cross-project tasks"))
    gate.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    warn.mockRestore()
  })

  it("keeps a done task in memory but filters it out of the persisted queue", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "done" })]),
    )
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    const saved = JSON.parse(mocks.writeFile.mock.calls.at(-1)![1] as string)
    expect(saved).toEqual([])
  })

  it("backfills projectId on tasks loaded without one", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([{ id: "t1", group, canonicalSlug: "dpao", status: "pending", addedAt: 1, error: null, retryCount: 0 }]),
    )
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await restoreQueue("pid", "/proj")
    expect(getQueue()[0]?.projectId).toBe("pid")
    gate.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })
})

describe("processNext mid-flight project switches", () => {
  beforeEach(() => {
    clearQueueState()
    vi.clearAllMocks()
    mocks.getProjectPathById.mockResolvedValue("/proj")
    mocks.wikiGetState.mockReturnValue({
      llmConfig: { provider: "custom" },
      bumpDataVersion: mocks.bumpDataVersion,
    })
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.executeMerge.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.readFile.mockRejectedValue(new Error("no queue file"))
  })

  it("returns early when the project switches while resolving the registry", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await enqueueMerge("pid", group, "dpao")
    expect(getQueue()[0]?.status).toBe("pending")
    await pauseQueue()
    gate.resolve("/proj")
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("queues a second task while the first is still processing", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    const id1 = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalled())
    const other: DuplicateGroup = { slugs: ["x", "y"], reason: "r", confidence: "low" }
    const id2 = await enqueueMerge("pid", other, "x")
    expect(id2).not.toBe(id1)
    expect(getQueue()).toHaveLength(2)
    expect(getQueueSummary()).toEqual({ pending: 1, processing: 1, failed: 0, total: 2 })
    gate.resolve()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("returns early when the project switches during the processing save", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    let wc = 0
    mocks.writeFile.mockImplementation(async () => {
      wc++
      if (wc === 2) return gate.promise
      return undefined
    })
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    await pauseQueue()
    gate.resolve()
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("returns early when the project switches during a successful merge", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    await pauseQueue()
    gate.resolve()
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("returns early when the project switches during a failed merge", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    await pauseQueue()
    gate.reject(new Error("boom"))
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("retryTask is a no-op when the task belongs to a different project", async () => {
    await restoreQueue("pid", "/proj")
    const q = getQueue() as unknown as Array<Record<string, unknown>>
    q.push(task({ id: "xt", projectId: "other" }))
    await retryTask("xt")
    expect(getQueue().map((t) => t.id)).toEqual(["xt"])
    expect(mocks.executeMerge).not.toHaveBeenCalled()
  })

  it("cancelTask is a no-op when the task belongs to a different project", async () => {
    await restoreQueue("pid", "/proj")
    const q = getQueue() as unknown as Array<Record<string, unknown>>
    q.push(task({ id: "xt", projectId: "other" }))
    await cancelTask("xt")
    expect(getQueue().map((t) => t.id)).toEqual(["xt"])
    expect(mocks.executeMerge).not.toHaveBeenCalled()
  })

  it("bails at the top of processNext when restore resumes into a switched project", async () => {
    // restoreQueue sets currentProjectId, then awaits loadQueue. If the user
    // pauses (switches away) during that await, the resumed processNext call
    // must bail via the stale-context guard at the top of processNext.
    const loadGate = deferred<string>()
    mocks.readFile.mockReturnValue(loadGate.promise)
    const restoring = restoreQueue("pid", "/proj")
    await flush()
    await pauseQueue()
    loadGate.resolve(JSON.stringify([task({ id: "t1", status: "pending" })]))
    await restoring
    // the orphaned processNext bails at the top guard → t1 stays pending, unprocessed
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    expect(mocks.executeMerge).not.toHaveBeenCalled()
  })

  it("cancelTask during the pre-merge save skips the abort path", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<void>()
    const saveGate = deferred<void>()
    mocks.executeMerge.mockReturnValue(gate.promise)
    let wc = 0
    mocks.writeFile.mockImplementation(async () => {
      wc++
      if (wc === 2) return saveGate.promise
      return undefined
    })
    const id = await enqueueMerge("pid", group, "dpao")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    await cancelTask(id) // task is processing but the abort controller does not exist yet
    expect(getQueue()).toHaveLength(0)
    saveGate.resolve()
    await vi.waitFor(() => expect(mocks.executeMerge).toHaveBeenCalled())
    gate.resolve()
    await vi.waitFor(() => expect(mocks.bumpDataVersion).toHaveBeenCalled())
  })
})
