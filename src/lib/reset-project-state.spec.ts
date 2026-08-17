import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  chatSetState: vi.fn(),
  reviewSetState: vi.fn(),
  activitySetState: vi.fn(),
  pauseIngestQueue: vi.fn(),
  dedupPauseQueue: vi.fn(),
  clearGraphCache: vi.fn(),
  stopProjectFileSync: vi.fn(),
  stopScheduledImport: vi.fn(),
  clearTemporalFactsCache: vi.fn(),
}))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: { setState: mocks.chatSetState },
}))
vi.mock("@/stores/review-store", () => ({
  useReviewStore: { setState: mocks.reviewSetState },
}))
vi.mock("@/stores/activity-store", () => ({
  useActivityStore: { setState: mocks.activitySetState },
}))
vi.mock("@/lib/ingest-queue", () => ({
  pauseQueue: mocks.pauseIngestQueue,
}))
vi.mock("@/lib/novel/context-engine", () => ({
  clearTemporalFactsCache: mocks.clearTemporalFactsCache,
}))

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

const DYNAMIC_MODULES = [
  "@/lib/dedup-queue",
  "@/lib/graph-relevance",
  "@/lib/project-file-sync",
  "@/lib/scheduled-import",
]

beforeEach(async () => {
  vi.clearAllMocks()
  for (const mod of DYNAMIC_MODULES) {
    vi.doUnmock(mod)
  }
  vi.resetModules()
  mocks.pauseIngestQueue.mockResolvedValue(undefined)
  mocks.dedupPauseQueue.mockResolvedValue(undefined)
  mocks.stopProjectFileSync.mockResolvedValue(undefined)
  mocks.stopScheduledImport.mockImplementation(() => undefined)
  mocks.clearGraphCache.mockImplementation(() => undefined)
  mocks.clearTemporalFactsCache.mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockClear()
})

function registerWorkingModules() {
  vi.doMock("@/lib/dedup-queue", () => ({ pauseQueue: mocks.dedupPauseQueue }))
  vi.doMock("@/lib/graph-relevance", () => ({ clearGraphCache: mocks.clearGraphCache }))
  vi.doMock("@/lib/project-file-sync", () => ({ stopProjectFileSync: mocks.stopProjectFileSync }))
  vi.doMock("@/lib/scheduled-import", () => ({ stopScheduledImport: mocks.stopScheduledImport }))
}

describe("resetProjectStores", () => {
  it("clears chat, review and activity stores", async () => {
    registerWorkingModules()
    const { resetProjectStores } = await import("./reset-project-state")
    resetProjectStores()

    expect(mocks.chatSetState).toHaveBeenCalledWith({
      conversations: [],
      messages: [],
      activeConversationId: null,
      mode: "chat",
      ingestSource: null,
      streamingContents: {},
    })
    expect(mocks.reviewSetState).toHaveBeenCalledWith({ items: [] })
    expect(mocks.activitySetState).toHaveBeenCalledWith({ items: [] })
  })
})

describe("resetProjectState", () => {
  it("resets stores and stops every background subsystem on the happy path", async () => {
    registerWorkingModules()
    const { resetProjectState } = await import("./reset-project-state")
    await resetProjectState()

    expect(mocks.chatSetState).toHaveBeenCalled()
    expect(mocks.stopScheduledImport).toHaveBeenCalledTimes(1)
    expect(mocks.pauseIngestQueue).toHaveBeenCalledTimes(1)
    expect(mocks.dedupPauseQueue).toHaveBeenCalledTimes(1)
    expect(mocks.clearGraphCache).toHaveBeenCalledTimes(1)
    expect(mocks.clearTemporalFactsCache).toHaveBeenCalledTimes(1)
    expect(mocks.stopProjectFileSync).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("warns when a background subsystem function throws", async () => {
    registerWorkingModules()
    mocks.stopScheduledImport.mockImplementation(() => {
      throw new Error("scheduled broke")
    })
    mocks.pauseIngestQueue.mockRejectedValue(new Error("ingest broke"))
    mocks.dedupPauseQueue.mockRejectedValue(new Error("dedup broke"))
    mocks.clearGraphCache.mockImplementation(() => {
      throw new Error("graph broke")
    })
    mocks.clearTemporalFactsCache.mockImplementation(() => {
      throw new Error("facts broke")
    })
    mocks.stopProjectFileSync.mockRejectedValue(new Error("sync broke"))

    const { resetProjectState } = await import("./reset-project-state")
    await resetProjectState()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("stopScheduledImport failed:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("pauseQueue failed:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dedup pauseQueue failed:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clearGraphCache failed:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clearTemporalFactsCache failed:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("stopProjectFileSync failed:"),
      expect.any(Error),
    )
  })

  it("warns when background modules fail to load", async () => {
    vi.doMock("@/lib/dedup-queue", () => {
      throw new Error("dedup-queue load failed")
    })
    vi.doMock("@/lib/graph-relevance", () => {
      throw new Error("graph-relevance load failed")
    })
    vi.doMock("@/lib/project-file-sync", () => {
      throw new Error("project-file-sync load failed")
    })
    vi.doMock("@/lib/scheduled-import", () => {
      throw new Error("scheduled-import load failed")
    })

    const { resetProjectState } = await import("./reset-project-state")
    await resetProjectState()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load scheduled-import:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load dedup-queue:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load graph-relevance:"),
      expect.any(Error),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load project-file-sync:"),
      expect.any(Error),
    )
  })
})
