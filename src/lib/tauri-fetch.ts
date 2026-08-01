/**
 * Shared HTTP helpers routed through Tauri's HTTP plugin.
 *
 * Third-party LLM/search/embedding endpoints often lack browser-friendly
 * CORS headers. Routing requests through Tauri's Rust-backed plugin
 * sidesteps these restrictions on every desktop platform.
 *
 * In non-Tauri environments (vitest, SSR, Storybook) the module falls
 * back to `globalThis.fetch` so imports never crash at load time.
 *
 * MIT License — independently implemented.
 */

let cachedFetchPromise: Promise<typeof globalThis.fetch> | null = null

/** True when no browser `window` is available (Node, vitest, SSR). */
const isNodeRuntime = typeof window === "undefined"

/** True when the Tauri runtime bridge is present in the webview. */
const hasTauriBridge = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

/**
 * Obtain a `fetch` function that routes through Tauri's HTTP plugin
 * when available, falling back to the platform's native fetch.
 *
 * The dynamic import is cached so repeated calls don't re-resolve
 * the plugin module.
 *
 * @example
 *   const httpFetch = await getHttpFetch()
 *   const res = await httpFetch(url, opts)
 */
export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!cachedFetchPromise) {
    if (isNodeRuntime || !hasTauriBridge()) {
      cachedFetchPromise = Promise.resolve(globalThis.fetch.bind(globalThis))
    } else {
      cachedFetchPromise = import("@tauri-apps/plugin-http")
        .then((m) => m.fetch as unknown as typeof globalThis.fetch)
        .catch(() => globalThis.fetch.bind(globalThis))
    }
  }
  return cachedFetchPromise
}

/** Clear the cached fetch promise (test helper). */
export function resetHttpFetchForTests(): void {
  cachedFetchPromise = null
}

/**
 * Detect opaque network-level failures across Tauri's webview backends.
 *
 * Each platform reports the same failure class differently:
 *   - macOS/iOS (WebKit):      `Error`  with message "Load failed"
 *   - Windows (Edge WebView2): `TypeError` with message "Failed to fetch"
 *   - Linux (WebKitGTK):       `Error`  with message "Load failed"
 *
 * All of them collapse DNS/TLS/connection-refused/CORS-preflight into
 * a single opaque error. AbortErrors are explicitly excluded.
 */
export function isFetchNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError") return false
  // Chromium / Edge WebView2
  if (err.name === "TypeError") return true
  // WebKit (macOS / Linux GTK)
  if (err.message === "Load failed") return true
  // Chromium mid-stream drop
  if (err.message === "Failed to fetch") return true
  // Tauri plugin-http / Rust reqwest send-stage failure
  if (/error sending request for url/i.test(err.message)) return true
  if (err.message.includes("network error")) return true
  return false
}
