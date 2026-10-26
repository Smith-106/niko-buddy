import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  let reviewListener: ((state: { items: unknown[] }) => void) | null = null
  let chatListener: ((state: {
    streamingContents: Record<string, string>
    conversations: unknown[]
    messages: unknown[]
  }) => void) | null = null
  return {
    reviewListener: () => reviewListener,
    chatListener: () => chatListener,
    setReviewListener: (fn: typeof reviewListener) => {
      reviewListener = fn
    },
    setChatListener: (fn: typeof chatListener) => {
      chatListener = fn
    },
    subscribeReview: vi.fn(),
    subscribeChat: vi.fn(),
    getProject: vi.fn(),
    isTauri: vi.fn(),
    saveReviewItems: vi.fn(),
    saveChatHistory: vi.fn(),
    reviewItems: [] as unknown[],
    chatConvs: [] as unknown[],
    chatMsgs: [] as unknown[],
    chatStreaming: {} as Record<string, string>,
  }
})

vi.mock("@/stores/review-store", () => ({
  useReviewStore: {
    subscribe: mocks.subscribeReview,
    getState: () => ({ items: mocks.reviewItems }),
  },
}))
vi.mock("@/stores/chat-store", () => ({
  useChatStore: {
    subscribe: mocks.subscribeChat,
    getState: () => ({
      maxHistoryMessages: 50,
      conversations: mocks.chatConvs,
      messages: mocks.chatMsgs,
      streamingContents: mocks.chatStreaming,
    }),
  },
}))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: { getState: () => ({ project: mocks.getProject() }) },

  }
})
vi.mock("./persist", () => ({
  saveReviewItems: mocks.saveReviewItems,
  saveChatHistory: mocks.saveChatHistory,
}))
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual, isTauri: () => mocks.isTauri()
  }
})

import { flushAutoSave, setupAutoSave } from "./auto-save"

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.setReviewListener(null)
  mocks.setChatListener(null)
  mocks.reviewItems = []
  mocks.chatConvs = []
  mocks.chatMsgs = []
  mocks.chatStreaming = {}
  mocks.subscribeReview.mockImplementation((fn: (state: { items: unknown[] }) => void) => {
    mocks.setReviewListener(fn)
  })
  mocks.subscribeChat.mockImplementation(
    (fn: (state: {
      streamingContents: Record<string, string>
      conversations: unknown[]
      messages: unknown[]
    }) => void) => {
      mocks.setChatListener(fn)
    },
  )
  mocks.getProject.mockReturnValue(null)
  mocks.isTauri.mockReturnValue(true)
  mocks.saveReviewItems.mockResolvedValue(undefined)
  mocks.saveChatHistory.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("setupAutoSave", () => {
  it("subscribes to both review and chat stores", () => {
    setupAutoSave()
    expect(mocks.subscribeReview).toHaveBeenCalledTimes(1)
    expect(mocks.subscribeChat).toHaveBeenCalledTimes(1)
  })

  it("saves review items after the debounce when a project exists in Tauri", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    setupAutoSave()

    mocks.reviewListener()?.({ items: [{ id: "1" }] })
    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.saveReviewItems).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(mocks.saveReviewItems).toHaveBeenCalledWith("E:/Novel", [{ id: "1" }])
  })

  it("skips saving review items without a project", async () => {
    setupAutoSave()
    mocks.reviewListener()?.({ items: [{ id: "1" }] })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(mocks.saveReviewItems).not.toHaveBeenCalled()
  })

  it("skips saving review items outside Tauri", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.isTauri.mockReturnValue(false)
    setupAutoSave()

    mocks.reviewListener()?.({ items: [{ id: "1" }] })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(mocks.saveReviewItems).not.toHaveBeenCalled()
  })

  it("logs save failures for review items", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.saveReviewItems.mockRejectedValue(new Error("disk full"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    setupAutoSave()

    mocks.reviewListener()?.({ items: [] })
    await vi.advanceTimersByTimeAsync(1_100)
    await Promise.resolve()
    expect(errorSpy).toHaveBeenCalledWith("自动保存失败:", expect.any(Error))
    errorSpy.mockRestore()
  })

  it("debounces repeated review updates into one save", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    setupAutoSave()

    mocks.reviewListener()?.({ items: [{ id: "1" }] })
    await vi.advanceTimersByTimeAsync(500)
    mocks.reviewListener()?.({ items: [{ id: "2" }] })
    await vi.advanceTimersByTimeAsync(1_100)

    expect(mocks.saveReviewItems).toHaveBeenCalledTimes(1)
    expect(mocks.saveReviewItems).toHaveBeenCalledWith("E:/Novel", [{ id: "2" }])
  })

  it("skips chat saves while streaming is active", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    setupAutoSave()

    mocks.chatListener()?.({ streamingContents: { c1: "partial" }, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("saves chat history after the debounce with the max-messages setting", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    setupAutoSave()

    mocks.chatListener()?.({
      streamingContents: {},
      conversations: [{ id: "c1" }],
      messages: [{ id: "m1" }],
    })
    await vi.advanceTimersByTimeAsync(2_001)
    expect(mocks.saveChatHistory).toHaveBeenCalledWith(
      "E:/Novel",
      [{ id: "c1" }],
      [{ id: "m1" }],
      50,
    )
  })

  it("skips chat saves without a project", async () => {
    setupAutoSave()
    mocks.chatListener()?.({ streamingContents: {}, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("skips chat saves outside Tauri", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.isTauri.mockReturnValue(false)
    setupAutoSave()

    mocks.chatListener()?.({ streamingContents: {}, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("logs chat save failures", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.saveChatHistory.mockRejectedValue(new Error("write failed"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    setupAutoSave()

    mocks.chatListener()?.({ streamingContents: {}, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(2_100)
    await Promise.resolve()
    expect(errorSpy).toHaveBeenCalledWith("自动保存失败:", expect.any(Error))
    errorSpy.mockRestore()
  })

  it("debounces repeated chat updates into one save", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    setupAutoSave()

    mocks.chatListener()?.({ streamingContents: {}, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(1_000)
    mocks.chatListener()?.({ streamingContents: {}, conversations: [], messages: [] })
    await vi.advanceTimersByTimeAsync(2_100)

    expect(mocks.saveChatHistory).toHaveBeenCalledTimes(1)
  })
})

describe("flushAutoSave / pagehide 兜底", () => {
  function ensureWindowStub(): void {
    const g = globalThis as unknown as {
      window?: {
        addEventListener: typeof EventTarget.prototype.addEventListener
        removeEventListener: typeof EventTarget.prototype.removeEventListener
        dispatchEvent: typeof EventTarget.prototype.dispatchEvent
      }
    }
    if (
      !g.window ||
      typeof g.window.addEventListener !== "function" ||
      typeof g.window.dispatchEvent !== "function"
    ) {
      const target = new EventTarget()
      g.window = {
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
      }
    }
  }

  it("flush立即落盘无需推进定时器", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.reviewItems = [{ id: "r-flush" }]
    mocks.chatConvs = [{ id: "c1" }]
    mocks.chatMsgs = [{ id: "m1" }]
    mocks.chatStreaming = {}
    setupAutoSave()

    await flushAutoSave()

    expect(mocks.saveReviewItems).toHaveBeenCalledWith("E:/Novel", [{ id: "r-flush" }])
    expect(mocks.saveChatHistory).toHaveBeenCalledWith("E:/Novel", [{ id: "c1" }], [{ id: "m1" }], 50)
  })

  it("pagehide触发flush保存", async () => {
    ensureWindowStub()
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.reviewItems = [{ id: "r-pagehide" }]
    mocks.chatConvs = [{ id: "c1" }]
    mocks.chatMsgs = [{ id: "m1" }]
    mocks.chatStreaming = {}
    setupAutoSave()

    window.dispatchEvent(new Event("pagehide"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.saveReviewItems).toHaveBeenCalledWith("E:/Novel", [{ id: "r-pagehide" }])
    expect(mocks.saveChatHistory).toHaveBeenCalledWith("E:/Novel", [{ id: "c1" }], [{ id: "m1" }], 50)
  })

  it("streaming非空时chat跳过但review仍保存", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.reviewItems = [{ id: "r1" }]
    mocks.chatConvs = [{ id: "c1" }]
    mocks.chatMsgs = [{ id: "m1" }]
    mocks.chatStreaming = { c1: "partial" }

    await flushAutoSave()

    expect(mocks.saveReviewItems).toHaveBeenCalledWith("E:/Novel", [{ id: "r1" }])
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("无项目路径时flush无保存", async () => {
    mocks.reviewItems = [{ id: "r1" }]
    mocks.chatConvs = [{ id: "c1" }]
    mocks.chatMsgs = [{ id: "m1" }]
    mocks.chatStreaming = {}

    await flushAutoSave()

    expect(mocks.saveReviewItems).not.toHaveBeenCalled()
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()
  })

  it("kill窗口语义：防抖未满即丢、flush兜底可救", async () => {
    mocks.getProject.mockReturnValue({ path: "E:/Novel" })
    mocks.chatConvs = [{ id: "c1" }]
    mocks.chatMsgs = [{ id: "m1" }]
    mocks.chatStreaming = {}
    mocks.reviewItems = [{ id: "r1" }]
    setupAutoSave()

    mocks.chatListener()?.({ streamingContents: {}, conversations: [{ id: "c1" }], messages: [{ id: "m1" }] })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(mocks.saveChatHistory).not.toHaveBeenCalled()

    await flushAutoSave()
    expect(mocks.saveChatHistory).toHaveBeenCalledWith("E:/Novel", [{ id: "c1" }], [{ id: "m1" }], 50)
  })
})
