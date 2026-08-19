// @vitest-environment jsdom
/**
 * useGraphLayout — Sigma remount / 面板拖拽 resize 生命周期全分支覆盖（W4E4）。
 * - vi.hoisted 可写 store state（selectedFile）
 * - 真实 jsdom MutationObserver 驱动 body[data-panel-resizing] 变更
 * - 断言对照 use-graph-layout.ts 源码实现
 */
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setupDomGlobals } from "@/test-helpers/component-test-utils"
import { useGraphLayout } from "./use-graph-layout"

interface WikiLike {
  selectedFile: string | null
}

const mocks = vi.hoisted(() => {
  const state: WikiLike = { selectedFile: null }
  return { state }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: WikiLike) => unknown) => selector(mocks.state),
}))

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

describe("useGraphLayout", () => {
  let observeSpy: ReturnType<typeof vi.spyOn>
  let disconnectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    setupDomGlobals()
    mocks.state.selectedFile = null
    document.body.removeAttribute("data-panel-resizing")
    observeSpy = vi.spyOn(MutationObserver.prototype, "observe")
    disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("初始渲染：layoutKey 未变 → 不 remount；observer 观察 body 的 data-panel-resizing", async () => {
    const { result, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
      initialProps: { show: false },
    })
    await flush(10)
    expect(result.current.sigmaKey).toBe(0)
    expect(result.current.isResizing).toBe(false)
    expect(observeSpy).toHaveBeenCalledWith(document.body, {
      attributes: true,
      attributeFilter: ["data-panel-resizing"],
    })
    unmount()
    expect(disconnectSpy).toHaveBeenCalled()
  })

  it("showInsights 变化 → isResizing 置真，100ms 后 sigmaKey+1 并回落", async () => {
    // 只劫持 setTimeout：jsdom MutationObserver 内部依赖 setImmediate/微任务，
    // 全量 fake 会延迟 observer 回调投递（负载下偶发 flake）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const { result, rerender, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
        initialProps: { show: false },
      })
      await act(async () => {})
      rerender({ show: true })
      await act(async () => {})
      expect(result.current.isResizing).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(result.current.sigmaKey).toBe(1)
      expect(result.current.isResizing).toBe(false)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("selectedFile 变化同样触发 remount 计时", async () => {
    // 只劫持 setTimeout：jsdom MutationObserver 内部依赖 setImmediate/微任务，
    // 全量 fake 会延迟 observer 回调投递（负载下偶发 flake）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const { result, rerender, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
        initialProps: { show: false },
      })
      await act(async () => {})
      mocks.state.selectedFile = "/p/wiki/甲.md"
      rerender({ show: false })
      await act(async () => {})
      expect(result.current.isResizing).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(result.current.sigmaKey).toBe(1)
      expect(result.current.isResizing).toBe(false)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("拖拽开始：body 标记 true → dragging && !isResizing 置 isResizing=true", async () => {
    const { result, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
      initialProps: { show: false },
    })
    await flush(10)
    await act(async () => {
      document.body.setAttribute("data-panel-resizing", "true")
    })
    await flush(10)
    expect(result.current.isResizing).toBe(true)
    expect(result.current.sigmaKey).toBe(0)
    unmount()
  })

  it("拖拽结束：body 移除标记 → 50ms 后 sigmaKey+1 并回落", async () => {
    // 只劫持 setTimeout：jsdom MutationObserver 内部依赖 setImmediate/微任务，
    // 全量 fake 会延迟 observer 回调投递（负载下偶发 flake）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const { result, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
        initialProps: { show: false },
      })
      await act(async () => {})
      await act(async () => {
        document.body.setAttribute("data-panel-resizing", "true")
      })
      await act(async () => {
        document.body.removeAttribute("data-panel-resizing")
      })
      await act(async () => {
        vi.advanceTimersByTime(10)
      })
      expect(result.current.isResizing).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(80)
      })
      expect(result.current.sigmaKey).toBe(1)
      expect(result.current.isResizing).toBe(false)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("拖拽中再次触发拖拽标记（dragging && isResizing）→ 两个 if 均走 false 分支", async () => {
    // 只劫持 setTimeout：jsdom MutationObserver 内部依赖 setImmediate/微任务，
    // 全量 fake 会延迟 observer 回调投递（负载下偶发 flake）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const { result, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
        initialProps: { show: false },
      })
      await act(async () => {})
      // 开始拖拽 → isResizing=true
      await act(async () => {
        document.body.setAttribute("data-panel-resizing", "true")
      })
      // 结束拖拽：排入 50ms remount timer（isResizing 仍为 true）
      await act(async () => {
        document.body.setAttribute("data-panel-resizing", "false")
      })
      await act(async () => {
        vi.advanceTimersByTime(5)
      })
      // timer 未完成时再次开始拖拽 → dragging=true && isResizing=true（两个 if 的 false 侧）
      await act(async () => {
        document.body.setAttribute("data-panel-resizing", "true")
      })
      expect(result.current.isResizing).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(80)
      })
      expect(result.current.sigmaKey).toBe(1)
      expect(result.current.isResizing).toBe(false)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("非拖拽标记变更（dragging=false 且 isResizing=false）→ 无副作用", async () => {
    const { result, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
      initialProps: { show: false },
    })
    await flush(10)
    await act(async () => {
      document.body.setAttribute("data-panel-resizing", "false")
    })
    await flush(10)
    await act(async () => {
      document.body.setAttribute("data-panel-resizing", "other")
    })
    await flush(10)
    expect(result.current.sigmaKey).toBe(0)
    expect(result.current.isResizing).toBe(false)
    unmount()
  })

  it("remount 计时未完成即卸载 → clearTimeout 清理", async () => {
    const { rerender, unmount } = renderHook(({ show }: { show: boolean }) => useGraphLayout(show), {
      initialProps: { show: false },
    })
    await flush(10)
    rerender({ show: true })
    await flush(5)
    unmount()
    await flush(150)
  })
})
