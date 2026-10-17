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

// ---------------------------------------------------------------------------
// SEC-02 (ISS-20260724-006): URL validation guard for outbound HTTP requests.
// Prevents SSRF / local-network probing by rejecting:
//   - non-HTTP(S) protocols (file://, ftp://, etc.)
//   - public plain-HTTP (http://) traffic; http:// is allowed only for
//     explicit local endpoints (LL-1): loopback, RFC 1918 private networks
//     and mDNS *.local hosts used by Ollama / LM Studio / cursor-cli proxy
//   - private / link-local / reserved addresses over https://
// The Tauri capability URL scope (src-tauri/capabilities/default.json) is
// kept in sync as a second lock; this runtime guard is the primary boundary.
// ---------------------------------------------------------------------------

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^\[::1\]/,
  /^0\./,
  /\.local$/i,
  /\.internal$/i,
]

/**
 * Loopback + RFC 1918 + mDNS hosts that may be used as explicit local
 * plain-http endpoints (LL-1). Public http:// must stay blocked.
 * Kept in sync with the http:default URL scope in
 * src-tauri/capabilities/default.json.
 */
const LOCAL_HTTP_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^\[::1\]$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /\.local$/i,
]

function isLocalHttpHostname(hostname: string): boolean {
  return LOCAL_HTTP_HOST_PATTERNS.some((pattern) => pattern.test(hostname))
}

/**
 * Legacy test escape hatch (vitest integration helpers).
 *
 * @deprecated Since LL-1 local http endpoints (loopback / RFC 1918 / *.local)
 * pass unconditionally, so this toggle no longer changes guard behavior. It is
 * retained as a no-op so existing suites (e.g. j06-j09-real-transport.spec.ts)
 * keep importing it without edits.
 */
export function setAllowHttpLoopbackForTests(_enabled: boolean): void {
  void _enabled
}

/**
 * Validate an outbound URL before allowing the fetch to proceed.
 * Throws a descriptive Error if the URL is unsafe.
 */
function assertSafeUrl(raw: string | URL | Request): void {
  let url: URL
  try {
    url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url)
  } catch {
    throw new Error(`[SEC-02] Invalid URL: ${String(raw).slice(0, 120)}`)
  }

  const hostname = url.hostname

  // LL-1: explicit local endpoints may use plain http:// (Ollama, LM Studio,
  // cursor-cli proxy, LAN gateways). Public http:// remains blocked below.
  if (url.protocol === "http:" && isLocalHttpHostname(hostname)) {
    return
  }

  // Everything else must be HTTPS (rejects public http://, file://, ftp://, …)
  if (url.protocol !== "https:") {
    throw new Error(
      `[SEC-02] Blocked non-HTTPS request to ${url.protocol}//${url.host}. `
      + "Only https: is allowed (http: is permitted only for loopback/private-network endpoints).",
    )
  }

  // Reject private / loopback / link-local / metadata addresses
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(
        `[SEC-02] Blocked request to private/reserved address: ${hostname}. SSRF prevention.`,
      )
    }
  }
}

/**
 * Wrap a fetch implementation with the SEC-02 URL validation guard.
 * Every outbound request is checked before being forwarded.
 */
function withUrlGuard(innerFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    assertSafeUrl(input as string | URL | Request)
    return innerFetch(input, init)
  }) as typeof globalThis.fetch
}

/**
 * Obtain a `fetch` function that routes through Tauri's HTTP plugin
 * when available, falling back to the platform's native fetch.
 *
 * The dynamic import is cached so repeated calls don't re-resolve
 * the plugin module.
 *
 * All outbound requests are guarded by SEC-02 URL validation
 * (public traffic HTTPS-only + private address rejection; explicit local
 * loopback/RFC 1918 http endpoints allowed per LL-1) to prevent SSRF.
 *
 * @example
 *   const httpFetch = await getHttpFetch()
 *   const res = await httpFetch(url, opts)
 */
export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!cachedFetchPromise) {
    if (isNodeRuntime || !hasTauriBridge()) {
      cachedFetchPromise = Promise.resolve(withUrlGuard(globalThis.fetch.bind(globalThis)))
    } else {
      cachedFetchPromise = import("@tauri-apps/plugin-http")
        .then((m) => withUrlGuard(m.fetch as unknown as typeof globalThis.fetch))
        .catch(() => withUrlGuard(globalThis.fetch.bind(globalThis)))
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
