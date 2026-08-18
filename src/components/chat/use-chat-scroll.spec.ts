// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatAutoScroll } from "./use-chat-scroll"

type Params = {
  activeMessages: unknown[]
  streamingContent: string
  isStreaming: boolean
  activeConversationId: string | null
}

const baseDeps: Params = {
  activeMessages: [],
  streamingContent: "",
  isStreaming: false,
  activeConversationId: null,
}

/** Build a container with jsdom-overridable scroll metrics. */
function makeContainer(scrollTop = 0, scrollHeight = 500, clientHeight = 100): HTMLDivElement {
  const el = document.createElement("div")
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight })
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight })
  el.scrollTop = scrollTop
  return el
}

function scrollTo(el: HTMLDivElement, top: number): void {
  el.scrollTop = top
  act(() => {
    el.dispatchEvent(new Event("scroll"))
  })
}

describe("useChatAutoScroll", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("无容器时所有 effect 提前返回，状态保持默认", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    expect(result.current.scrollContainerRef.current).toBeNull()
    expect(result.current.bottomRef.current).toBeNull()
    expect(result.current.showScrollToBottom).toBe(false)

    // 触发依赖变化：activeMessages / activeConversationId / isStreaming 三个 effect 重跑
    rerender({ ...baseDeps, activeMessages: ["m1"] })
    rerender({ ...baseDeps, activeConversationId: "c1" })
    rerender({ ...baseDeps, isStreaming: true })
    expect(result.current.showScrollToBottom).toBe(false)
  })

  it("新消息到达且未手动上滑时自动滚动到底部", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    const container = makeContainer(0, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    rerender({ ...baseDeps, activeMessages: ["m1"] })
    expect(container.scrollTop).toBe(500)
  })

  it("手动上滑后停止自动滚动；回到底部后恢复", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    // scrollTop=490 必须在监听器挂载前设置：effect 快照 lastScrollTop=490
    const container = makeContainer(490, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    rerender({ ...baseDeps, activeConversationId: "c1" })
    // 上滑到 10：10 < 490-1 → userScrolledUp=true
    scrollTo(container, 10)
    expect(result.current.showScrollToBottom).toBe(true)

    // 已上滑：新消息不自动滚动
    rerender({ ...baseDeps, activeConversationId: "c1", activeMessages: ["m1"] })
    expect(container.scrollTop).toBe(10)

    // 回到底部（490：500-490-100 = -90 < 50）→ 恢复自动滚动
    scrollTo(container, 490)
    expect(result.current.showScrollToBottom).toBe(false)
    rerender({ ...baseDeps, activeConversationId: "c1", activeMessages: ["m1", "m2"] })
    expect(container.scrollTop).toBe(500)
  })

  it("滚动到中部（非上滑、非底部）时保持当前滚动锁状态", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    const container = makeContainer(400, 1000, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    rerender({ ...baseDeps, activeConversationId: "c1" })
    // 先上滑锁定：10 < 400-1
    scrollTo(container, 10)
    expect(result.current.showScrollToBottom).toBe(true)
    // 中部：400 >= 10-1 且 1000-400-100=500 >= 50 → 两个条件都不成立，保持锁定
    scrollTo(container, 400)
    expect(result.current.showScrollToBottom).toBe(true)
  })

  it("streaming 结束后重置滚动锁并隐藏 FAB", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    const container = makeContainer(490, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    rerender({ ...baseDeps, activeConversationId: "c1" })
    scrollTo(container, 10)
    expect(result.current.showScrollToBottom).toBe(true)

    // streaming 进行中（不重置）
    rerender({ ...baseDeps, activeConversationId: "c1", isStreaming: true })
    expect(result.current.showScrollToBottom).toBe(true)
    // 结束 → 重置
    rerender({ ...baseDeps, activeConversationId: "c1", isStreaming: false })
    expect(result.current.showScrollToBottom).toBe(false)
  })

  it("会话切换时重置滚动锁", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    const container = makeContainer(490, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    rerender({ ...baseDeps, activeConversationId: "c1" })
    scrollTo(container, 10)
    expect(result.current.showScrollToBottom).toBe(true)
    rerender({ ...baseDeps, activeConversationId: "c2" })
    expect(result.current.showScrollToBottom).toBe(false)
  })

  it("会话切换时旧 scroll 监听被移除（cleanup）", () => {
    const { result, rerender, unmount } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    const container = makeContainer(0, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    const removeSpy = vi.fn(container.removeEventListener.bind(container))
    container.removeEventListener = removeSpy as typeof container.removeEventListener
    rerender({ ...baseDeps, activeConversationId: "c1" })
    expect(removeSpy).not.toHaveBeenCalled()
    rerender({ ...baseDeps, activeConversationId: "c2" })
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function))
  })

  it("scrollToBottom：无容器安全返回；有容器滚动到底并解锁", () => {
    const { result, rerender } = renderHook((p: Params) => useChatAutoScroll(p), {
      initialProps: baseDeps,
    })
    // 无容器 → 提前返回
    act(() => {
      result.current.scrollToBottom()
    })

    const container = makeContainer(10, 500, 100)
    act(() => {
      result.current.scrollContainerRef.current = container
    })
    act(() => {
      result.current.scrollToBottom()
    })
    expect(container.scrollTop).toBe(500)
    expect(result.current.showScrollToBottom).toBe(false)

    // 上滑锁定后手动回底 → 解锁
    rerender({ ...baseDeps, activeConversationId: "c1" })
    scrollTo(container, 10)
    expect(result.current.showScrollToBottom).toBe(true)
    act(() => {
      result.current.scrollToBottom()
    })
    expect(container.scrollTop).toBe(500)
    expect(result.current.showScrollToBottom).toBe(false)
  })
})
