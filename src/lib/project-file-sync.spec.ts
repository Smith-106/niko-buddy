import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import type { SourceWatchConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  startProjectFileWatcher: vi.fn(),
  stopProjectFileWatcher: vi.fn(),
  rescanProjectFiles: vi.fn(),
  fsyncGetState: vi.fn(),
  wikiGetState: vi.fn(),
  resolveDefaultModel: vi.fn(),
  cleanupDeletedWikiPages: vi.fn(),
  deleteSourceFiles: vi.fn(),
  enqueueSourceIngest: vi.fn(),
  isIngestableSourcePath: vi.fn(),
  isPathAllowedBySourceWatch: vi.fn(),
  normalizeSourceWatchConfig: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/commands/file-sync", () => ({
  startProjectFileWatcher: mocks.startProjectFileWatcher,
  stopProjectFileWatcher: mocks.stopProjectFileWatcher,
  rescanProjectFiles: mocks.rescanProjectFiles,
}))

vi.mock("@/stores/file-sync-store", () => ({
  useFileSyncStore: { getState: mocks.fsyncGetState },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.wikiGetState },
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: mocks.resolveDefaultModel,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  cleanupDeletedWikiPages: mocks.cleanupDeletedWikiPages,
  deleteSourceFiles: mocks.deleteSourceFiles,
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  isIngestableSourcePath: mocks.isIngestableSourcePath,
}))

vi.mock("@/lib/source-watch-config", () => ({
  isPathAllowedBySourceWatch: mocks.isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig: mocks.normalizeSourceWatchConfig,
}))

import {
  rescanProjectFileSync,
  startProjectFileSync,
  stopProjectFileSync,
} from "./project-file-sync"

const project: WikiProject = { id: "pid", name: "Proj", path: "/proj" }

const DEFAULT_WATCH: SourceWatchConfig = {
  enabled: true,
  autoIngest: true,
  includeExtensions: ["pdf", "md"],
  excludeExtensions: [],
  excludeDirs: [],
  excludeGlobs: [],
  maxFileSizeMb: 100,
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    projectId: "pid",
    path: "raw/sources/a.pdf",
    kind: "created",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    retryCount: 0,
    needsRerun: false,
    ...overrides,
  }
}

/** Map of event channel → handler captured by the mocked tauri listen(). */
const handlers: Record<string, (event: { payload: unknown }) => void> = {}
const unlistenFn = vi.fn()

function emit(channel: string, projectId: string, tasks: unknown[]) {
  handlers[channel]?.({ payload: { projectId, tasks } })
}

function fsyncState() {
  return {
    setRunning: vi.fn(),
    setLastError: vi.fn(),
    setTasks: vi.fn(),
    clear: vi.fn(),
  }
}

let fsyncStore: ReturnType<typeof fsyncState>
let wikiStore: {
  project: WikiProject | null
  sourceWatchConfig: SourceWatchConfig
  llmConfig: Record<string, unknown>
  setFileTree: ReturnType<typeof vi.fn>
  bumpDataVersion: ReturnType<typeof vi.fn>
  selectedFile: string | null
  fileContent: string
  setFileContent: ReturnType<typeof vi.fn>
  setSelectedFile: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  vi.clearAllMocks()
  Object.keys(handlers).forEach((k) => delete handlers[k])
  mocks.listen.mockImplementation(async (channel: string, handler: (e: unknown) => void) => {
    handlers[channel] = handler
    return unlistenFn
  })
  mocks.normalizeSourceWatchConfig.mockImplementation(
    (c?: Partial<SourceWatchConfig> | null) => ({ ...DEFAULT_WATCH, ...(c ?? {}) }),
  )
  mocks.isIngestableSourcePath.mockReturnValue(true)
  mocks.isPathAllowedBySourceWatch.mockReturnValue(true)
  mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
  mocks.startProjectFileWatcher.mockResolvedValue({ version: 1, tasks: [] })
  mocks.stopProjectFileWatcher.mockResolvedValue(undefined)
  mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: [] }, changedTasks: [] })
  mocks.listDirectory.mockResolvedValue([])
  mocks.readFile.mockResolvedValue("file content")
  mocks.deleteSourceFiles.mockResolvedValue({ deletedWikiPaths: [], rewrittenSourcePages: 0, skippedPages: 0 })
  mocks.cleanupDeletedWikiPages.mockResolvedValue(undefined)
  mocks.enqueueSourceIngest.mockResolvedValue([])

  fsyncStore = fsyncState()
  mocks.fsyncGetState.mockReturnValue(fsyncStore)
  wikiStore = {
    project,
    sourceWatchConfig: DEFAULT_WATCH,
    llmConfig: { provider: "custom" },
    setFileTree: vi.fn(),
    bumpDataVersion: vi.fn(),
    selectedFile: null,
    fileContent: "",
    setFileContent: vi.fn(),
    setSelectedFile: vi.fn(),
  }
  mocks.wikiGetState.mockReturnValue(wikiStore)

  // Reset module-level watcher/timer state between tests.
  await stopProjectFileSync()
  // stopProjectFileSync unlistens the previous test's stale listeners; clear
  // that bookkeeping so per-test assertions see only their own calls.
  unlistenFn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── startProjectFileSync ─────────────────────────────────────────────────────

describe("startProjectFileSync", () => {
  it("starts the watcher and mirrors its tasks into the store", async () => {
    const queue = { version: 2, tasks: [task()] }
    mocks.startProjectFileWatcher.mockResolvedValue(queue)
    await startProjectFileSync(project, DEFAULT_WATCH)
    expect(mocks.startProjectFileWatcher).toHaveBeenCalledWith("pid", "/proj", DEFAULT_WATCH)
    expect(fsyncStore.setRunning).toHaveBeenCalledWith(true)
    expect(fsyncStore.setLastError).toHaveBeenCalledWith(null)
    expect(fsyncStore.setTasks).toHaveBeenCalledWith(queue.tasks)
    // finally: running flag cleared
    expect(fsyncStore.setRunning).toHaveBeenLastCalledWith(false)
  })

  it("propagates a watcher failure after cleaning up listeners", async () => {
    mocks.startProjectFileWatcher.mockRejectedValue(new Error("watcher down"))
    await expect(startProjectFileSync(project)).rejects.toThrow("watcher down")
    expect(unlistenFn).toHaveBeenCalledTimes(2)
    expect(fsyncStore.setLastError).toHaveBeenCalledWith("Error: watcher down")
    expect(fsyncStore.setRunning).toHaveBeenLastCalledWith(false)
  })

  it("bails out when a newer start supersedes this one mid-flight", async () => {
    const gate = deferred<{ version: number; tasks: unknown[] }>()
    mocks.startProjectFileWatcher.mockReturnValueOnce(gate.promise)
    const first = startProjectFileSync(project)
    // second start increments startSeq and completes immediately
    await startProjectFileSync(project)
    gate.resolve({ version: 1, tasks: [task({ id: "stale" })] })
    await first
    // stale queue never lands in the store
    expect(fsyncStore.setTasks).toHaveBeenLastCalledWith([])
  })

  it("bails out when the active project changes while the watcher starts", async () => {
    const gate = deferred<{ version: number; tasks: unknown[] }>()
    mocks.startProjectFileWatcher.mockReturnValueOnce(gate.promise)
    const starting = startProjectFileSync(project)
    wikiStore.project = { id: "other", name: "O", path: "/other" }
    gate.resolve({ version: 1, tasks: [task()] })
    await starting
    expect(fsyncStore.setTasks).not.toHaveBeenCalled()
  })

  it("forwards matching queue-updated events to the store", async () => {
    await startProjectFileSync(project)
    emit("file-sync://queue-updated", "pid", [task({ id: "q1" })])
    expect(fsyncStore.setTasks).toHaveBeenCalledWith([expect.objectContaining({ id: "q1" })])
    // non-matching project payloads are ignored
    emit("file-sync://queue-updated", "other", [task({ id: "q2" })])
    expect(fsyncStore.setTasks).not.toHaveBeenCalledWith([expect.objectContaining({ id: "q2" })])
  })

  it("ignores changed events for other projects or when no project is open", async () => {
    await startProjectFileSync(project)
    emit("file-sync://changed", "other", [task()])
    wikiStore.project = null
    emit("file-sync://changed", "pid", [task()])
    await vi.waitFor(() => expect(fsyncStore.setTasks).toHaveBeenCalledTimes(1))
  })
})

// ── stopProjectFileSync ──────────────────────────────────────────────────────

describe("stopProjectFileSync", () => {
  it("unregisters listeners, clears the store, and stops the watcher", async () => {
    await startProjectFileSync(project)
    await stopProjectFileSync()
    expect(unlistenFn).toHaveBeenCalledTimes(2)
    expect(fsyncStore.clear).toHaveBeenCalled()
    expect(mocks.stopProjectFileWatcher).toHaveBeenCalled()
  })

  it("swallows a stale-watcher stop failure", async () => {
    await startProjectFileSync(project)
    mocks.stopProjectFileWatcher.mockRejectedValue(new Error("stale"))
    await expect(stopProjectFileSync()).resolves.toBeUndefined()
  })

  it("cancels a pending refresh before it fires", async () => {
    await startProjectFileSync(project)
    emit("file-sync://changed", "pid", [task()])
    await stopProjectFileSync()
    await new Promise((r) => setTimeout(r, 300))
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })
})

// ── rescanProjectFileSync ────────────────────────────────────────────────────

describe("rescanProjectFileSync", () => {
  it("uses the store's source watch config when none is passed", async () => {
    wikiStore.sourceWatchConfig = { ...DEFAULT_WATCH, enabled: false }
    await rescanProjectFileSync(project)
    expect(mocks.rescanProjectFiles).toHaveBeenCalledWith("pid", "/proj", {
      ...DEFAULT_WATCH,
      enabled: false,
    })
  })

  it("mirrors the queue and processes changed tasks", async () => {
    const changed = [task({ id: "c1", path: "raw/sources/a.pdf", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 3, tasks: [changed[0]] },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project, DEFAULT_WATCH)
    expect(fsyncStore.setTasks).toHaveBeenCalledWith([changed[0]])
    // processBatch ran for the changed path
    expect(mocks.deleteSourceFiles).not.toHaveBeenCalled() // not deleted
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["raw/sources/a.pdf"],
      { provider: "custom" },
    )
  })

  it("refreshes the tree when there are no changed tasks", async () => {
    await rescanProjectFileSync(project)
    expect(fsyncStore.setTasks).toHaveBeenCalledWith([])
    expect(mocks.listDirectory).toHaveBeenCalledWith("/proj")
    expect(wikiStore.bumpDataVersion).toHaveBeenCalled()
  })

  it("returns before touching the store when the project switched mid-rescan", async () => {
    mocks.rescanProjectFiles.mockImplementation(async () => {
      wikiStore.project = { id: "other", name: "O", path: "/other" }
      return { queue: { version: 1, tasks: [task()] }, changedTasks: [] }
    })
    await rescanProjectFileSync(project)
    expect(fsyncStore.setTasks).not.toHaveBeenCalled()
  })

  it("bails at the second guard when the project changes right after setTasks", async () => {
    // Line 92 passes with the original project; line 95 then sees a switched
    // project and returns before processing any changed tasks.
    const switched = { ...wikiStore, project: { id: "other", name: "O", path: "/other" } }
    // call 1 = sourceWatchConfig lookup, call 2 = first guard, call 3+ = switched
    mocks.wikiGetState
      .mockReturnValueOnce(wikiStore)
      .mockReturnValueOnce(wikiStore)
      .mockReturnValue(switched)
    const changed = [task({ id: "c1", path: "raw/sources/a.pdf", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project)
    expect(fsyncStore.setTasks).toHaveBeenCalledWith(changed)
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })
})

// ── scheduleRefresh batching ─────────────────────────────────────────────────

describe("scheduleRefresh batching", () => {
  it("coalesces multiple changed events into one batch", async () => {
    vi.useFakeTimers()
    await startProjectFileSync(project)
    emit("file-sync://changed", "pid", [task({ id: "a", path: "raw/sources/a.pdf" })])
    emit("file-sync://changed", "pid", [task({ id: "b", path: "raw/sources/b.docx" })])
    await vi.advanceTimersByTimeAsync(250)
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledTimes(1)
    const [, paths] = mocks.enqueueSourceIngest.mock.calls[0]
    expect(paths).toEqual(expect.arrayContaining(["raw/sources/a.pdf", "raw/sources/b.docx"]))
  })

  it("drops pending work when the project is closed before the timer fires", async () => {
    vi.useFakeTimers()
    await startProjectFileSync(project)
    emit("file-sync://changed", "pid", [task()])
    wikiStore.project = null
    await vi.advanceTimersByTimeAsync(250)
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })
})

// ── refreshTree ──────────────────────────────────────────────────────────────

describe("refreshTree", () => {
  it("refreshes the file tree, bumps the version, and stops when nothing is selected", async () => {
    await rescanProjectFileSync(project)
    expect(wikiStore.setFileTree).toHaveBeenCalledWith([])
    expect(wikiStore.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("warns when the tree listing fails but still bumps the version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await rescanProjectFileSync(project)
    expect(warn).toHaveBeenCalledWith("[file-sync] failed to refresh file tree:", expect.any(Error))
    expect(wikiStore.bumpDataVersion).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("reloads the selected file when it is inside the changed set", async () => {
    wikiStore.selectedFile = "/proj/wiki/selected.md"
    wikiStore.fileContent = "old content"
    mocks.readFile.mockResolvedValue("old content")
    const changed = [task({ id: "c1", path: "wiki/selected.md", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project)
    expect(mocks.readFile).toHaveBeenCalledWith("/proj/wiki/selected.md")
    expect(wikiStore.setFileContent).toHaveBeenCalledWith("old content")
  })

  it("skips the reload when the editor holds unsaved changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    wikiStore.selectedFile = "/proj/wiki/selected.md"
    wikiStore.fileContent = "unsaved edits"
    mocks.readFile.mockResolvedValue("content on disk")
    const changed = [task({ id: "c1", path: "wiki/selected.md", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project)
    expect(wikiStore.setFileContent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("未保存内容"), "/proj/wiki/selected.md")
    warn.mockRestore()
  })

  it("clears the selection when the selected file can no longer be read", async () => {
    wikiStore.selectedFile = "/proj/wiki/gone.md"
    const changed = [task({ id: "c1", path: "wiki/gone.md", kind: "deleted" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await rescanProjectFileSync(project)
    expect(wikiStore.setSelectedFile).toHaveBeenCalledWith(null)
    expect(wikiStore.setFileContent).toHaveBeenCalledWith("")
  })

  it("ignores a changed file that is not the selected one", async () => {
    wikiStore.selectedFile = "/proj/wiki/selected.md"
    const changed = [task({ id: "c1", path: "raw/sources/a.pdf", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project)
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("reloads a selected file whose path sits outside the project root", async () => {
    wikiStore.selectedFile = "/elsewhere/selected.md"
    const changed = [task({ id: "c1", path: "/elsewhere/selected.md", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({
      queue: { version: 1, tasks: changed },
      changedTasks: changed,
    })
    await rescanProjectFileSync(project)
    expect(mocks.readFile).toHaveBeenCalledWith("/elsewhere/selected.md")
  })
})

// ── enqueueRawChanges gating ─────────────────────────────────────────────────

describe("enqueueRawChanges gating", () => {
  it("does nothing when source watching is disabled", async () => {
    wikiStore.sourceWatchConfig = { ...DEFAULT_WATCH, enabled: false }
    const changed = [task({ kind: "created" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project, { ...DEFAULT_WATCH, enabled: false })
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("does nothing when auto-ingest is off", async () => {
    const changed = [task({ kind: "created" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project, { ...DEFAULT_WATCH, autoIngest: false })
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("skips deleted tasks and non-raw paths", async () => {
    const changed = [
      task({ id: "d", path: "raw/sources/d.pdf", kind: "deleted" }),
      task({ id: "n", path: "wiki/not-a-source.md", kind: "created" }),
    ]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("filters out paths that are not ingestable source files", async () => {
    mocks.isIngestableSourcePath.mockReturnValue(false)
    const changed = [task({ id: "c", path: "raw/sources/a.pdf", kind: "created" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("filters out paths rejected by the source-watch allowlist", async () => {
    mocks.isPathAllowedBySourceWatch.mockReturnValue(false)
    const changed = [task({ id: "c", path: "raw/sources/a.pdf", kind: "created" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("logs when the ingest enqueue fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.enqueueSourceIngest.mockRejectedValue(new Error("queue down"))
    const changed = [task({ id: "c", path: "raw/sources/a.pdf", kind: "modified" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(error).toHaveBeenCalledWith(
      "[file-sync] failed to enqueue raw source ingest:",
      expect.any(Error),
    )
    error.mockRestore()
  })
})

// ── cleanupDeleted ───────────────────────────────────────────────────────────

describe("cleanupDeleted", () => {
  it("does nothing when no tasks are deletions", async () => {
    const changed = [task({ kind: "created" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.deleteSourceFiles).not.toHaveBeenCalled()
    expect(mocks.cleanupDeletedWikiPages).not.toHaveBeenCalled()
  })

  it("cascades deleted raw sources and skips matching wiki pages", async () => {
    mocks.deleteSourceFiles.mockResolvedValue({
      deletedWikiPaths: ["wiki/sources/paper.md"],
      rewrittenSourcePages: 0,
      skippedPages: 0,
    })
    const changed = [
      task({ id: "d1", path: "raw/sources/paper.pdf", kind: "deleted" }),
      task({ id: "d2", path: "wiki/sources/paper.md", kind: "deleted" }),
      task({ id: "d3", path: "raw/sources/other.docx", kind: "deleted" }),
    ]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.deleteSourceFiles).toHaveBeenCalledWith(
      "/proj",
      ["raw/sources/paper.pdf", "raw/sources/other.docx"],
      {
        fileAlreadyDeleted: true,
        logReason: "external batch delete",
      },
    )
    // wiki/sources/paper.md stem matches a deleted raw source → skipped
    expect(mocks.cleanupDeletedWikiPages).not.toHaveBeenCalled()
  })

  it("cleans non-matching deleted wiki pages", async () => {
    const changed = [task({ id: "d1", path: "wiki/notes/story.md", kind: "deleted" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.deleteSourceFiles).not.toHaveBeenCalled()
    expect(mocks.cleanupDeletedWikiPages).toHaveBeenCalledWith("/proj", ["wiki/notes/story.md"])
  })

  it("uses the single-delete log reason for one raw source", async () => {
    const changed = [task({ id: "d1", path: "raw/sources/solo.pdf", kind: "deleted" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.deleteSourceFiles).toHaveBeenCalledWith(
      "/proj",
      ["raw/sources/solo.pdf"],
      { fileAlreadyDeleted: true, logReason: "external delete" },
    )
  })

  it("logs a raw-source cascade failure but still cleans wiki pages", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.deleteSourceFiles.mockRejectedValue(new Error("lancedb down"))
    const changed = [
      task({ id: "d1", path: "raw/sources/paper.pdf", kind: "deleted" }),
      task({ id: "d2", path: "wiki/notes/story.md", kind: "deleted" }),
    ]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(error).toHaveBeenCalledWith("[file-sync] failed to clean deleted raw sources:", expect.any(Error))
    expect(mocks.cleanupDeletedWikiPages).toHaveBeenCalledWith("/proj", ["wiki/notes/story.md"])
    error.mockRestore()
  })

  it("logs a wiki-cascade failure without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.cleanupDeletedWikiPages.mockRejectedValue(new Error("boom"))
    const changed = [task({ id: "d1", path: "wiki/notes/story.md", kind: "deleted" })]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await expect(rescanProjectFileSync(project)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith("[file-sync] failed to clean deleted wiki pages:", expect.any(Error))
    error.mockRestore()
  })

  it("excludes cache paths and dotfiles from the raw-source cascade", async () => {
    const changed = [
      task({ id: "d1", path: "raw/sources/.cache/paper.txt", kind: "deleted" }),
      task({ id: "d2", path: "raw/sources/.hidden", kind: "deleted" }),
    ]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.deleteSourceFiles).not.toHaveBeenCalled()
  })

  it("excludes structural and media wiki pages from the cascade", async () => {
    const changed = [
      task({ id: "d1", path: "wiki/index.md", kind: "deleted" }),
      task({ id: "d2", path: "wiki/log.md", kind: "deleted" }),
      task({ id: "d3", path: "wiki/overview.md", kind: "deleted" }),
      task({ id: "d4", path: "wiki/media/pic.png", kind: "deleted" }),
      task({ id: "d5", path: "wiki/notes.txt", kind: "deleted" }),
      task({ id: "d6", path: "WIKI/UPPER.MD", kind: "deleted" }),
    ]
    mocks.rescanProjectFiles.mockResolvedValue({ queue: { version: 1, tasks: changed }, changedTasks: changed })
    await rescanProjectFileSync(project)
    expect(mocks.cleanupDeletedWikiPages).toHaveBeenCalledWith("/proj", ["WIKI/UPPER.MD"])
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
