import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  cancelAllTasks,
  cancelTask,
  cleanupWrittenFiles,
  clearCompletedTasks,
  clearQueueState,
  enqueueBatch,
  enqueueIngest,
  getQueue,
  getQueueSummary,
  pauseQueue,
  restoreQueue,
  retryTask,
} from "./ingest-queue"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  autoIngest: vi.fn(),
  wikiGetState: vi.fn(),
  getProjectPathById: vi.fn(),
  hasUsableLlm: vi.fn(),
  resolveDefaultModel: vi.fn(),
  cascadeDeleteWikiPage: vi.fn(),
  sweepResolvedReviews: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("./ingest", () => ({
  autoIngest: mocks.autoIngest,
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

vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPage: mocks.cascadeDeleteWikiPage,
}))

vi.mock("@/lib/sweep-reviews", () => ({
  sweepResolvedReviews: mocks.sweepResolvedReviews,
}))

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
    sourcePath: "raw/sources/a.pdf",
    folderContext: "",
    status: "pending",
    addedAt: 1,
    error: null,
    retryCount: 0,
    ...partial,
  }
}

const llmConfig = { provider: "custom", model: "m" }

beforeEach(() => {
  clearQueueState()
  vi.clearAllMocks()
  mocks.getProjectPathById.mockResolvedValue("/proj")
  mocks.wikiGetState.mockReturnValue({ llmConfig })
  mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.autoIngest.mockResolvedValue(["wiki/a.md"])
  mocks.sweepResolvedReviews.mockResolvedValue(undefined)
  mocks.cascadeDeleteWikiPage.mockResolvedValue(undefined)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.readFile.mockRejectedValue(new Error("no queue file"))
})

// ── cleanupWrittenFiles ──────────────────────────────────────────────────────

describe("cleanupWrittenFiles", () => {
  it("cascades relative and absolute paths, normalizing each", async () => {
    await cleanupWrittenFiles("/proj", ["wiki/a.md", "/abs/wiki/b.md", "wiki\\c.md"])
    expect(mocks.cascadeDeleteWikiPage).toHaveBeenNthCalledWith(1, "/proj", "/proj/wiki/a.md")
    expect(mocks.cascadeDeleteWikiPage).toHaveBeenNthCalledWith(2, "/proj", "/abs/wiki/b.md")
    expect(mocks.cascadeDeleteWikiPage).toHaveBeenNthCalledWith(3, "/proj", "/proj/wiki\\c.md")
  })

  it("swallows per-file errors so one failure does not abort the batch", async () => {
    mocks.cascadeDeleteWikiPage
      .mockRejectedValueOnce(new Error("file missing"))
      .mockResolvedValueOnce(undefined)
    await expect(cleanupWrittenFiles("/proj", ["wiki/a.md", "wiki/b.md"])).resolves.toBeUndefined()
    expect(mocks.cascadeDeleteWikiPage).toHaveBeenCalledTimes(2)
  })
})

// ── enqueueIngest ────────────────────────────────────────────────────────────

describe("enqueueIngest", () => {
  it("throws when no project is active", async () => {
    await expect(enqueueIngest("pid", "raw/sources/a.pdf")).rejects.toThrow(
      /project pid is not the active project \(current: <none>\)/,
    )
  })

  it("throws when a different project is active", async () => {
    await restoreQueue("other", "/other")
    await expect(enqueueIngest("pid", "raw/sources/a.pdf")).rejects.toThrow(/not the active project/)
  })

  it("enqueues, processes to completion, and drains into the sweep", async () => {
    await restoreQueue("pid", "/proj")
    const id = await enqueueIngest("pid", "raw/sources/a.pdf", "papers > 2026")
    expect(id).toMatch(/^ingest-/)
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/.qmai/ingest-queue.json",
      expect.stringContaining("raw/sources/a.pdf"),
    )
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledWith(
      "/proj",
      "/proj/raw/sources/a.pdf",
      llmConfig,
      expect.any(AbortSignal),
      "papers > 2026",
    )
    // task removed from queue → drain → sweep runs because something was processed
    expect(mocks.sweepResolvedReviews).toHaveBeenCalledWith("/proj", expect.any(AbortSignal))
  })

  it("queues a new task when the same path is already processing", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    const id1 = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    // a pending task with a DIFFERENT path sits behind the processing one
    await enqueueIngest("pid", "raw/sources/b.docx", "docs")
    const id3 = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    expect(id3).not.toBe(id1)
    expect(getQueue()).toHaveLength(3)
    expect(getQueueSummary()).toEqual({ pending: 2, processing: 1, failed: 0, total: 3 })
    gate.resolve(["wiki/a.md"])
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(3)
  })

  it("dedupes a rerun of a pending path behind a processing task to the existing id", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    // a.pdf is now pending behind the in-flight copy
    const pendingId = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    // Enqueueing the same path again must return the existing pending id
    const rerunId = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    expect(rerunId).toBe(pendingId)
    expect(getQueue()).toHaveLength(2)
    gate.resolve(["wiki/a.md"])
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("dedupes an identical pending source path to the same task id", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const id1 = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    const id2 = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    expect(id2).toBe(id1)
    expect(getQueue()).toHaveLength(1)
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("keeps the existing folderContext when a duplicate supplies an empty one", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const id1 = await enqueueIngest("pid", "raw/sources/a.pdf", "papers")
    const id2 = await enqueueIngest("pid", "raw/sources/a.pdf", "")
    expect(id2).toBe(id1)
    expect(getQueue()[0]?.folderContext).toBe("papers")
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("updates the folderContext when a duplicate supplies a new one", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf", "papers")
    await enqueueIngest("pid", "raw/sources/a.pdf", "papers > 2026")
    expect(getQueue()[0]?.folderContext).toBe("papers > 2026")
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("re-activates a failed duplicate: resets status, error, and retry count", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "boom", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf", "ctx")
    expect(id).toBe("t1")
    expect(getQueue()[0]?.status).toBe("pending")
    expect(getQueue()[0]?.error).toBeNull()
    expect(getQueue()[0]?.retryCount).toBe(0)
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("strips the active project path prefix from absolute source paths", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "/proj/raw/sources/a.pdf", "ctx")
    expect(getQueue()[0]?.sourcePath).toBe("raw/sources/a.pdf")
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("keeps an absolute source path outside the project as-is", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "/elsewhere/sources/a.pdf", "ctx")
    expect(getQueue()[0]?.sourcePath).toBe("/elsewhere/sources/a.pdf")
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    // absolute path goes straight to autoIngest without project prefix
    expect(mocks.autoIngest).toHaveBeenCalledWith(
      "/proj",
      "/elsewhere/sources/a.pdf",
      llmConfig,
      expect.any(AbortSignal),
      "ctx",
    )
  })

  it("survives a failed queue save (non-critical)", async () => {
    await restoreQueue("pid", "/proj")
    mocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    expect(id).toMatch(/^ingest-/)
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })
})

// ── enqueueBatch ─────────────────────────────────────────────────────────────

describe("enqueueBatch", () => {
  it("throws when the project is not active", async () => {
    await expect(
      enqueueBatch("pid", [{ sourcePath: "raw/sources/a.pdf", folderContext: "" }]),
    ).rejects.toThrow(/not the active project/)
  })

  it("enqueues multiple files, logs, and returns an id per unique path", async () => {
    await restoreQueue("pid", "/proj")
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const ids = await enqueueBatch("pid", [
      { sourcePath: "raw/sources/a.pdf", folderContext: "papers" },
      { sourcePath: "raw/sources/b.docx", folderContext: "docs" },
    ])
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(log).toHaveBeenCalledWith("[Ingest Queue] Enqueued 2 files")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it("dedupes paths repeated inside the same batch", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const ids = await enqueueBatch("pid", [
      { sourcePath: "raw/sources/a.pdf", folderContext: "x" },
      { sourcePath: "raw/sources/a.pdf", folderContext: "y" },
    ])
    expect(ids[0]).toBe(ids[1])
    expect(getQueue()).toHaveLength(1)
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })
})

// ── retryTask ────────────────────────────────────────────────────────────────

describe("retryTask", () => {
  it("is a no-op for an unknown id", async () => {
    await restoreQueue("pid", "/proj")
    await retryTask("missing")
    expect(getQueue()).toHaveLength(0)
  })

  it("is a no-op when the task belongs to a different project", async () => {
    await restoreQueue("pid", "/proj")
    const q = getQueue() as unknown as Array<Record<string, unknown>>
    q.push(task({ id: "xt", projectId: "other" }))
    await retryTask("xt")
    expect(getQueue().map((t) => t.id)).toEqual(["xt"])
    expect(mocks.autoIngest).not.toHaveBeenCalled()
  })

  it("resets a failed task to pending and reprocesses it", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "boom", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    await retryTask("t1")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(1)
  })
})

// ── cancelTask ───────────────────────────────────────────────────────────────

describe("cancelTask", () => {
  it("is a no-op for an unknown id", async () => {
    await restoreQueue("pid", "/proj")
    await cancelTask("missing")
    expect(getQueue()).toHaveLength(0)
  })

  it("is a no-op when the task belongs to a different project", async () => {
    await restoreQueue("pid", "/proj")
    const q = getQueue() as unknown as Array<Record<string, unknown>>
    q.push(task({ id: "xt", projectId: "other" }))
    await cancelTask("xt")
    expect(getQueue().map((t) => t.id)).toEqual(["xt"])
  })

  it("removes a pending task", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([task({ id: "t1" })]))
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await cancelTask("t1")
    expect(getQueue()).toHaveLength(0)
    expect(log).toHaveBeenCalledWith("[Ingest Queue] Cancelled: raw/sources/a.pdf")
    log.mockRestore()
    gate.resolve("/proj")
    await flush()
  })

  it("removes a failed task", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "x", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    await cancelTask("t1")
    expect(getQueue()).toHaveLength(0)
  })

  it("aborts an in-flight processing task and removes it", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    expect(getQueue()[0]?.status).toBe("processing")
    await cancelTask(id)
    expect(getQueue()).toHaveLength(0)
    expect(mocks.autoIngest.mock.calls[0][3].aborted).toBe(true)
    gate.reject(new Error("aborted"))
    await flush()
  })
})

// ── clearCompletedTasks ──────────────────────────────────────────────────────

describe("clearCompletedTasks", () => {
  it("keeps pending and processing, drops done and failed", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", status: "processing" }),
        task({ id: "t3", status: "done" }),
        task({ id: "t4", status: "failed", error: "x" }),
      ]),
    )
    // gate the registry lookup BEFORE restore so processNext cannot pick up t1
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await restoreQueue("pid", "/proj")
    await clearCompletedTasks()
    expect(getQueue().map((t) => t.id)).toEqual(["t1", "t2"])
    gate.resolve("/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })
})

// ── cancelAllTasks ───────────────────────────────────────────────────────────

describe("cancelAllTasks", () => {
  it("returns 0 when there is nothing to cancel", async () => {
    await restoreQueue("pid", "/proj")
    expect(await cancelAllTasks()).toBe(0)
  })

  it("aborts processing, keeps failed tasks, and returns the removed count", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", status: "failed", error: "x", retryCount: 3 }),
      ]),
    )
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    expect(await cancelAllTasks()).toBe(1)
    expect(getQueue().map((t) => t.id)).toEqual(["t2"])
    gate.resolve("/proj")
    await flush()
  })

  it("aborts the in-flight processing task's signal", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    expect(await cancelAllTasks()).toBe(1)
    expect(mocks.autoIngest.mock.calls[0][3].aborted).toBe(true)
    gate.reject(new Error("aborted"))
    await flush()
  })
})

// ── getQueue / getQueueSummary / clearQueueState ─────────────────────────────

describe("queue introspection", () => {
  it("reports a summary of pending/processing/failed/total", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", status: "processing" }),
        task({ id: "t3", status: "failed", error: "x" }),
        task({ id: "t4", status: "done" }),
      ]),
    )
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"])
    expect(getQueueSummary()).toEqual({ pending: 1, processing: 1, failed: 1, total: 4 })
  })

  it("clearQueueState aborts an in-flight ingest", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    clearQueueState()
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().total).toBe(0)
    expect(mocks.autoIngest.mock.calls[0][3].aborted).toBe(true)
    gate.reject(new Error("aborted"))
    await flush()
  })
})

// ── pauseQueue ───────────────────────────────────────────────────────────────

describe("pauseQueue", () => {
  it("is a no-op without an active project", async () => {
    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
  })

  it("reverts an in-flight task to pending, persists it, and clears memory", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
    expect(mocks.autoIngest.mock.calls[0][3].aborted).toBe(true)
    const saved = JSON.parse(mocks.writeFileAtomic.mock.calls[mocks.writeFileAtomic.mock.calls.length - 1]![1] as string)
    expect(saved[0].status).toBe("pending")
    gate.reject(new Error("aborted"))
    await flush()
  })

  it("aborts a gated review sweep controller", async () => {
    await restoreQueue("pid", "/proj")
    const sweepGate = deferred<void>()
    mocks.sweepResolvedReviews.mockReturnValue(sweepGate.promise)
    const ingestGate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(ingestGate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    ingestGate.resolve(["wiki/a.md"])
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    await pauseQueue()
    sweepGate.resolve()
    await flush()
  })
})

// ── restoreQueue ─────────────────────────────────────────────────────────────

describe("restoreQueue", () => {
  it("registers the project when the saved queue is empty", async () => {
    mocks.readFile.mockResolvedValue("[]")
    await restoreQueue("pid", "/proj")
    expect(mocks.readFile).toHaveBeenCalledWith("/proj/.qmai/ingest-queue.json")
    expect(getQueue()).toHaveLength(0)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    expect(id).toMatch(/^ingest-/)
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
    mocks.readFile.mockResolvedValue(JSON.stringify([task({ id: "t1", status: "processing" })]))
    await restoreQueue("pid", "/proj")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(1)
  })

  it("drops cross-project tasks and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", projectId: "other", status: "pending" }),
      ]),
    )
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropped 1 cross-project tasks"))
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    warn.mockRestore()
  })

  it("backfills projectId on tasks persisted before the field existed", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "t1", sourcePath: "raw/sources/a.pdf", folderContext: "", status: "pending", addedAt: 1, error: null, retryCount: 0 },
      ]),
    )
    await restoreQueue("pid", "/proj")
    expect(getQueue()[0]?.projectId).toBe("pid")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
  })

  it("keeps done tasks in memory but filters them out of the persisted queue", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([task({ id: "t1", status: "done" })]))
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    const saved = JSON.parse(mocks.writeFileAtomic.mock.calls[mocks.writeFileAtomic.mock.calls.length - 1]![1] as string)
    expect(saved).toEqual([])
  })

  it("does not resume processing when only failed tasks are restored", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify([task({ id: "t1", status: "failed", error: "x", retryCount: 3 })]),
    )
    await restoreQueue("pid", "/proj")
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    expect(mocks.autoIngest).not.toHaveBeenCalled()
  })

  it("logs the restore summary when pending tasks are resumed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        task({ id: "t1", status: "pending" }),
        task({ id: "t2", status: "processing" }),
        task({ id: "t3", status: "failed", error: "x" }),
      ]),
    )
    await restoreQueue("pid", "/proj")
    expect(log).toHaveBeenCalledWith(
      "[Ingest Queue] Restored: 2 pending, 1 failed, 1 resumed from interrupted",
    )
    await vi.waitFor(() => expect(getQueue().length).toBe(1))
    expect(getQueue()[0]?.id).toBe("t3")
    log.mockRestore()
  })
})

// ── processNext: failure paths ───────────────────────────────────────────────

describe("processNext failure paths", () => {
  it("marks the task failed when the project is not in the registry", async () => {
    await restoreQueue("pid", "/proj")
    mocks.getProjectPathById.mockResolvedValue(null)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.id).toBe(id)
    expect(getQueue()[0]?.error).toContain("Project not found in registry")
    expect(mocks.autoIngest).not.toHaveBeenCalled()
  })

  it("marks the task failed when the LLM is not configured", async () => {
    await restoreQueue("pid", "/proj")
    mocks.hasUsableLlm.mockReturnValue(false)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.error).toContain("LLM not configured")
    expect(getQueue()[0]?.id).toBe(id)
    expect(mocks.autoIngest).not.toHaveBeenCalled()
  })

  it("retries after an empty autoIngest result (no output files)", async () => {
    await restoreQueue("pid", "/proj")
    mocks.autoIngest
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.id).toBe(id)
    expect(getQueue()[0]?.error).toBe("Ingest produced no output files")
    expect(getQueue()[0]?.retryCount).toBe(3)
    expect(mocks.autoIngest).toHaveBeenCalledTimes(3)
  })

  it("retries a throwing ingest and fails after MAX_RETRIES with the message", async () => {
    await restoreQueue("pid", "/proj")
    mocks.autoIngest.mockRejectedValue(new Error("llm flake"))
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.error).toBe("llm flake")
    expect(getQueue()[0]?.retryCount).toBe(3)
    expect(getQueue()[0]?.id).toBe(id)
    expect(mocks.autoIngest).toHaveBeenCalledTimes(3)
  })

  it("records a non-Error rejection as its string message", async () => {
    await restoreQueue("pid", "/proj")
    mocks.autoIngest.mockRejectedValue("plain boom")
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
    expect(getQueue()[0]?.error).toBe("plain boom")
  })

  it("recovers after a transient failure and completes on the next attempt", async () => {
    await restoreQueue("pid", "/proj")
    mocks.autoIngest
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["wiki/a.md"])
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(2)
  })

  it("processes a second task queued while the first is still running", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(["wiki/b.md"])
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalledTimes(1))
    await enqueueIngest("pid", "raw/sources/b.docx", "docs")
    expect(getQueue()).toHaveLength(2)
    expect(getQueueSummary()).toEqual({ pending: 1, processing: 1, failed: 0, total: 2 })
    gate.resolve(["wiki/a.md"])
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(mocks.autoIngest).toHaveBeenCalledTimes(2)
  })
})

// ── processNext: stale-context guards ────────────────────────────────────────

describe("processNext stale-context guards", () => {
  it("returns early when the project switches while resolving the registry", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    expect(getQueue()[0]?.status).toBe("pending")
    await pauseQueue()
    gate.resolve("/proj")
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("returns early when the project switches during the processing save", async () => {
    await restoreQueue("pid", "/proj")
    const saveGate = deferred<void>()
    let wc = 0
    mocks.writeFileAtomic.mockImplementation(async () => {
      wc++
      if (wc === 2) return saveGate.promise
      return undefined
    })
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("processing"))
    await pauseQueue()
    saveGate.resolve()
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("returns early when the project switches during the LLM ingest", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    await pauseQueue()
    gate.resolve(["wiki/a.md"])
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("returns early when the project switches while the ingest is failing", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string[]>()
    mocks.autoIngest.mockReturnValue(gate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.autoIngest).toHaveBeenCalled())
    await pauseQueue()
    gate.reject(new Error("boom"))
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("bails at the top of processNext when restore resumes into a switched project", async () => {
    // restoreQueue sets currentProjectId, then awaits loadQueue. If the user
    // pauses (switches away) during that await, the resumed processNext call
    // must bail via the stale-context guard.
    const loadGate = deferred<string>()
    mocks.readFile.mockReturnValue(loadGate.promise)
    const restoring = restoreQueue("pid", "/proj")
    await flush()
    await pauseQueue()
    loadGate.resolve(JSON.stringify([task({ id: "t1", status: "pending" })]))
    await restoring
    // the orphaned processNext bails at the top guard → t1 stays pending, unprocessed
    expect(getQueue().map((t) => t.id)).toEqual(["t1"])
    expect(mocks.autoIngest).not.toHaveBeenCalled()
  })
})

// ── drain sweep ──────────────────────────────────────────────────────────────

describe("drain sweep", () => {
  it("skips the sweep when nothing was processed since the last drain", async () => {
    await restoreQueue("pid", "/proj")
    const gate = deferred<string | null>()
    mocks.getProjectPathById.mockReturnValue(gate.promise)
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await cancelTask(id)
    expect(mocks.sweepResolvedReviews).not.toHaveBeenCalled()
    gate.resolve("/proj")
    await flush()
  })

  it("logs a sweep failure without crashing the queue", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await restoreQueue("pid", "/proj")
    mocks.sweepResolvedReviews.mockRejectedValue(new Error("sweep down"))
    const id = await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    expect(error).toHaveBeenCalledWith(
      "[Ingest Queue] Failed to load sweep-reviews:",
      "sweep down",
    )
    expect(getQueue()).toHaveLength(0)
    expect(id).toMatch(/^ingest-/)
    error.mockRestore()
  })

  it("stringifies a non-Error sweep rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await restoreQueue("pid", "/proj")
    mocks.sweepResolvedReviews.mockRejectedValue("plain sweep failure")
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    expect(error).toHaveBeenCalledWith(
      "[Ingest Queue] Failed to load sweep-reviews:",
      "plain sweep failure",
    )
    error.mockRestore()
  })

  it("clears the sweep controller in the finally when it still matches", async () => {
    await restoreQueue("pid", "/proj")
    const sweepGate = deferred<void>()
    mocks.sweepResolvedReviews.mockReturnValue(sweepGate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    sweepGate.resolve()
    await flush()
    expect(getQueue()).toHaveLength(0)
  })

  it("leaves the sweep controller alone when pauseQueue already cleared it", async () => {
    await restoreQueue("pid", "/proj")
    const sweepGate = deferred<void>()
    mocks.sweepResolvedReviews.mockReturnValue(sweepGate.promise)
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    await pauseQueue()
    sweepGate.resolve()
    await flush()
  })

  it("propagates a sweep-handler crash to the queue-level catch with an Error", async () => {
    // onQueueDrained swallows sweep failures internally; it can only reject if
    // its own catch handler throws (mocked console.error here). The rejection
    // then lands in processNext's .catch callback.
    const error = vi
      .spyOn(console, "error")
      .mockImplementationOnce(() => {
        throw new Error("console boom")
      })
      .mockImplementationOnce(() => {})
    await restoreQueue("pid", "/proj")
    mocks.sweepResolvedReviews.mockRejectedValue(new Error("sweep down"))
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    await flush()
    expect(error).toHaveBeenLastCalledWith("[Ingest Queue] sweep failed:", "console boom")
    expect(getQueue()).toHaveLength(0)
    error.mockRestore()
  })

  it("propagates a sweep-handler crash to the queue-level catch with a plain value", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementationOnce(() => {
        throw "console boom string"
      })
      .mockImplementationOnce(() => {})
    await restoreQueue("pid", "/proj")
    mocks.sweepResolvedReviews.mockRejectedValue(new Error("sweep down"))
    await enqueueIngest("pid", "raw/sources/a.pdf")
    await vi.waitFor(() => expect(mocks.sweepResolvedReviews).toHaveBeenCalled())
    await flush()
    expect(error).toHaveBeenLastCalledWith("[Ingest Queue] sweep failed:", "console boom string")
    error.mockRestore()
  })
})
