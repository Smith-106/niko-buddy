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

/**
 * 四-16：垫片全局表的唯一类型边界。原来 `globalThis as unknown as Record<…>`
 * 散落在各处——现在收敛到这一个声明，后续新增垫片只改这里。
 */
interface TestDomGlobals {
  IS_REACT_ACT_ENVIRONMENT: boolean
  matchMedia?: typeof window.matchMedia
  IntersectionObserver?: typeof IntersectionObserver
  ResizeObserver?: typeof ResizeObserver
  getComputedStyle?: typeof window.getComputedStyle
}

const testGlobals = globalThis as unknown as TestDomGlobals

testGlobals.IS_REACT_ACT_ENVIRONMENT = true

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
  const w: TestDomGlobals = testGlobals
  if (o.matchMedia && typeof w.matchMedia !== "function") {
    w.matchMedia = vi.fn<typeof window.matchMedia>((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia
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
  if (o.scrollTo && typeof Element.prototype.scrollTo !== "function") {
    // 重载签名导致 Mock<T> 不能直赋：此处是唯一的 shim 边界断言（测试替身）。
    Element.prototype.scrollTo = vi.fn((): void => {}) as typeof Element.prototype.scrollTo
  }
  if (o.getComputedStyle && typeof w.getComputedStyle !== "function") {
    w.getComputedStyle = vi.fn<typeof window.getComputedStyle>(() => ({}) as CSSStyleDeclaration)
  }
}

/** Remove stubs installed by setupDomGlobals (call in afterEach if needed). */
export function cleanupDomGlobals(): void {
  const w: TestDomGlobals = testGlobals
  delete w.matchMedia
  delete w.IntersectionObserver
  delete w.ResizeObserver
  delete w.getComputedStyle
}

export { act, fireEvent, render, screen, waitFor, within }
export { default as userEvent } from "@testing-library/user-event"
