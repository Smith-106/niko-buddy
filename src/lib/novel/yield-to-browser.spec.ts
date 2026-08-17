import { describe, expect, it, vi, afterEach } from "vitest"
import { yieldToBrowserFrame } from "./yield-to-browser"

describe("yield-to-browser yieldToBrowserFrame", () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window
    } else {
      ;(globalThis as Record<string, unknown>).window = originalWindow
    }
    vi.restoreAllMocks()
  })

  it("resolves via requestAnimationFrame when window available", async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    const winSetTimeout = vi.fn((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    ;(globalThis as Record<string, unknown>).window = {
      requestAnimationFrame: raf,
      setTimeout: winSetTimeout,
    } as Window & typeof globalThis
    await yieldToBrowserFrame()
    expect(raf).toHaveBeenCalledTimes(1)
    expect(winSetTimeout).toHaveBeenCalledTimes(1)
  })

  it("falls back to plain setTimeout when no window", async () => {
    delete (globalThis as Record<string, unknown>).window
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    await yieldToBrowserFrame()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  it("falls back to setTimeout when requestAnimationFrame missing", async () => {
    ;(globalThis as Record<string, unknown>).window = {} as Window & typeof globalThis
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    await yieldToBrowserFrame()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
  })
})
