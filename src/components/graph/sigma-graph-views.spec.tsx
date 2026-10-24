// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { SigmaResizeRefresher } from "./sigma-graph-views"

const mocks = vi.hoisted(() => ({
  getContainer: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("@react-sigma/core", () => ({
  useSigma: () => ({ getContainer: mocks.getContainer, refresh: mocks.refresh }),
}))

type ROCallback = () => void

interface SeenObserver {
  callback: ROCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

function installResizeObserver(): SeenObserver[] {
  const seen: SeenObserver[] = []
  class FakeResizeObserver {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ROCallback) {
      seen.push({ callback, observe: this.observe, disconnect: this.disconnect })
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  return seen
}

describe("SigmaResizeRefresher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getContainer.mockReturnValue(document.createElement("div"))
    mocks.refresh.mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("缺 ResizeObserver 时静默跳过", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    render(<SigmaResizeRefresher />)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("非 Element 容器（测试替身）时不监听不崩", () => {
    installResizeObserver()
    mocks.getContainer.mockReturnValue({ style: {} })
    render(<SigmaResizeRefresher />)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("getContainer 抛错时静默跳过", () => {
    installResizeObserver()
    mocks.getContainer.mockImplementation(() => {
      throw new Error("no sigma")
    })
    expect(() => render(<SigmaResizeRefresher />)).not.toThrow()
  })

  it("高频 resize 收敛为一次 refresh（防抖）", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      render(<SigmaResizeRefresher debounceMs={50} />)
      expect(seen).toHaveLength(1)
      expect(seen[0].observe).toHaveBeenCalledTimes(1)
      const fire = seen[0].callback
      await act(async () => {
        fire()
        fire()
        fire()
      })
      expect(mocks.refresh).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(mocks.refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("refresh 抛错时吞掉不崩", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      mocks.refresh.mockImplementation(() => {
        throw new Error("not ready")
      })
      render(<SigmaResizeRefresher debounceMs={50} />)
      await act(async () => {
        seen[0].callback()
      })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(mocks.refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("卸载时清理 timer 与 observer", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      let unmount!: () => void
      await act(async () => {
        ;({ unmount } = render(<SigmaResizeRefresher debounceMs={50} />))
      })
      await act(async () => {
        seen[0].callback()
      })
      await act(async () => {
        unmount()
      })
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(seen[0].disconnect).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
