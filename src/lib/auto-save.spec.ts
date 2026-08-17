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
  }
})

vi.mock("@/stores/review-store", () => ({
  useReviewStore: { subscribe: mocks.subscribeReview },
}))
vi.mock("@/stores/chat-store", () => ({
  useChatStore: {
    subscribe: mocks.subscribeChat,
    getState: () => ({ maxHistoryMessages: 50 }),
  },
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ project: mocks.getProject() }) },
}))
vi.mock("./persist", () => ({
  saveReviewItems: mocks.saveReviewItems,
  saveChatHistory: mocks.saveChatHistory,
}))
vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }))

import { setupAutoSave } from "./auto-save"

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.setReviewListener(null)
  mocks.setChatListener(null)
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
