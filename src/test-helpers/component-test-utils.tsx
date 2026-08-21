// @vitest-environment jsdom
/**
 * Component-test utilities (W4 / P10).
 *
 * Central place for the shared setup of React component specs:
 * - IS_REACT_ACT_ENVIRONMENT flag
 * - render + screen + act + fireEvent re-exported from @testing-library/react
 * - a jsdom globals installer (IntersectionObserver / ResizeObserver /
 *   matchMedia / scrollTo stubs commonly needed by dashboard/editor components)
 *
 * Usage (each component spec):
 *   // @vitest-environment jsdom
 *   import { render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface DomGlobalsOptions {
  matchMedia?: boolean
  intersectionObserver?: boolean
  resizeObserver?: boolean
  scrollTo?: boolean
  getComputedStyle?: boolean
}

/**
 * Install non-critical jsdom globals that browser components may touch.
 * Each stub is a vi.fn, idempotent (no double-install), and removable via
 * cleanupDomGlobals(). Call inside beforeEach of component specs.
 */
export function setupDomGlobals(options: DomGlobalsOptions = {}): void {
  const o = {
    matchMedia: true,
    intersectionObserver: true,
    resizeObserver: true,
    scrollTo: true,
    getComputedStyle: false,
    ...options,
  }
  const w = globalThis as unknown as Record<string, unknown>
  if (o.matchMedia && typeof w.matchMedia !== "function") {
    w.matchMedia = vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
  if (o.intersectionObserver && typeof w.IntersectionObserver !== "function") {
    w.IntersectionObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = ""
      thresholds = []
    }
  }
  if (o.resizeObserver && typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  }
  if (o.scrollTo && typeof w.Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = vi.fn() as never
  }
  if (o.getComputedStyle && typeof w.getComputedStyle !== "function") {
    w.getComputedStyle = vi.fn(() => ({})) as never
  }
}

/** Remove stubs installed by setupDomGlobals (call in afterEach if needed). */
export function cleanupDomGlobals(): void {
  const w = globalThis as unknown as Record<string, unknown>
  delete w.matchMedia
  delete w.IntersectionObserver
  delete w.ResizeObserver
  delete w.getComputedStyle
}

export { act, fireEvent, render, screen, waitFor, within }
export { default as userEvent } from "@testing-library/user-event"
