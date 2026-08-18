// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { applyTheme, getSystemTheme, isSystemDark, watchSystemTheme } from "./theme-utils"

function installMatchMedia(matches: boolean, legacy: boolean) {
  const listeners = new Set<() => void>()
  const mq = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: legacy
      ? undefined
      : (_: string, cb: () => void) => {
          listeners.add(cb)
        },
    removeEventListener: legacy
      ? undefined
      : (_: string, cb: () => void) => {
          listeners.delete(cb)
        },
    addListener: legacy ? (cb: () => void) => listeners.add(cb) : undefined,
    removeListener: legacy ? (cb: () => void) => listeners.delete(cb) : undefined,
    trigger: () => listeners.forEach((cb) => cb()),
  }
  vi.stubGlobal("matchMedia", vi.fn(() => mq))
  return mq as typeof mq & { trigger: () => void }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.className = ""
})

describe("isSystemDark / getSystemTheme", () => {
  it("reports the system preference", () => {
    installMatchMedia(true, false)
    expect(isSystemDark()).toBe(true)
    expect(getSystemTheme()).toBe("dark")
  })

  it("reports light when the media query does not match", () => {
    installMatchMedia(false, false)
    expect(isSystemDark()).toBe(false)
    expect(getSystemTheme()).toBe("light")
  })

  it("degrades gracefully when window is unavailable", () => {
    const win = globalThis.window
    // @ts-expect-error deleting the global to simulate a non-DOM environment
    delete globalThis.window
    expect(isSystemDark()).toBe(false)
    expect(getSystemTheme()).toBe("light")
    const stop = watchSystemTheme(() => {})
    expect(typeof stop).toBe("function")
    stop() // execute the no-op cleanup closure
    globalThis.window = win
  })
})

describe("applyTheme", () => {
  it("adds the dark class for dark themes", () => {
    installMatchMedia(false, false)
    applyTheme("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.classList.contains("deep-blue")).toBe(false)
  })

  it("adds the deep-blue class for deep-blue themes", () => {
    installMatchMedia(false, false)
    applyTheme("deep-blue")
    expect(document.documentElement.classList.contains("deep-blue")).toBe(true)
  })

  it("clears both classes for light themes", () => {
    installMatchMedia(false, false)
    applyTheme("dark")
    applyTheme("light")
    expect(document.documentElement.className).toBe("")
  })

  it("resolves the system theme when mode is system", () => {
    installMatchMedia(true, false)
    applyTheme("system")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("no-ops when document is unavailable", () => {
    const doc = globalThis.document
    // @ts-expect-error deleting the global to simulate a non-DOM environment
    delete globalThis.document
    expect(() => applyTheme("dark")).not.toThrow()
    globalThis.document = doc
  })
})

describe("watchSystemTheme", () => {
  it("listens with addEventListener and stops on cleanup", () => {
    const mq = installMatchMedia(false, false)
    const onChange = vi.fn()
    const stop = watchSystemTheme(onChange)
    expect(onChange).not.toHaveBeenCalled()
    mq.trigger()
    expect(onChange).toHaveBeenCalledTimes(1)
    stop()
    mq.trigger()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("falls back to the legacy addListener API", () => {
    const mq = installMatchMedia(false, true)
    const onChange = vi.fn()
    const stop = watchSystemTheme(onChange)
    mq.trigger()
    expect(onChange).toHaveBeenCalledTimes(1)
    stop()
    mq.trigger()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
