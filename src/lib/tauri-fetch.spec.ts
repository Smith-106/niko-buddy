import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getHttpFetch,
  isFetchNetworkError,
  resetHttpFetchForTests,
  setAllowHttpLoopbackForTests,
} from "./tauri-fetch"

/**
 * SEC-02 / ISS-20260724-006 coverage for the outbound HTTP helper.
 *
 * In the vitest node environment `isNodeRuntime` is true, so the module takes
 * the platform-fetch path; the Tauri-bridge path is exercised by re-importing
 * the module with a stubbed `window` (vi.resetModules) in the dedicated
 * describe block below.
 */

const pluginFetchMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: pluginFetchMock,
}))

const nativeFetch = globalThis.fetch

beforeEach(() => {
  resetHttpFetchForTests()
  setAllowHttpLoopbackForTests(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetHttpFetchForTests()
  setAllowHttpLoopbackForTests(false)
  vi.clearAllMocks()
  // Restore the original fetch so later module instances see the real one.
  globalThis.fetch = nativeFetch
})

describe("getHttpFetch (node runtime)", () => {
  it("wraps platform fetch and passes safe HTTPS requests through with init", async () => {
    const fetchStub = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()
    const res = await httpFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" })

    expect(res).toBeInstanceOf(Response)
    expect(fetchStub).toHaveBeenCalledWith("https://api.example.com/v1/chat", { method: "POST", body: "{}" })
  })

  it("accepts URL and Request inputs in addition to plain strings", async () => {
    const fetchStub = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()
    await httpFetch(new URL("https://api.example.com/a"))
    await httpFetch(new Request("https://api.example.com/b", { method: "GET" }))

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(fetchStub.mock.calls[0]?.[0]?.toString()).toBe("https://api.example.com/a")
  })

  it("caches the fetch promise so repeated calls do not rebuild the wrapper", async () => {
    const p1 = getHttpFetch()
    const p2 = getHttpFetch()
    expect(p1).toBe(p2)
    await p1

    resetHttpFetchForTests()
    const p3 = getHttpFetch()
    expect(p3).not.toBe(p1)
  })

  it("rejects non-HTTPS protocols", async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()
    expect(() => httpFetch("http://example.com/data")).toThrow(/non-HTTPS/)
    expect(() => httpFetch("file:///etc/passwd")).toThrow(/non-HTTPS/)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("rejects private, loopback, link-local and reserved hostnames over HTTPS", async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()
    const bad = [
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.1.2.3/x",
      "https://172.16.0.1/x",
      "https://172.31.255.1/x",
      "https://192.168.1.10/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://0.0.0.0/x",
      "https://intranet.local/x",
      "https://db.internal/x",
    ]
    for (const url of bad) {
      expect(() => httpFetch(url)).toThrow(/private|reserved|SSRF/)
    }
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("throws a descriptive error for unparseable URLs", async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()
    expect(() => httpFetch("not a url" as unknown as RequestInfo)).toThrow(/\[SEC-02\] Invalid URL/)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("allows http loopback only when the test bypass is explicitly enabled", async () => {
    const fetchStub = vi.fn(async () => new Response("mock"))
    vi.stubGlobal("fetch", fetchStub)

    const httpFetch = await getHttpFetch()

    // Disabled by default — blocked.
    expect(() => httpFetch("http://127.0.0.1:11434/v1/embeddings")).toThrow(/non-HTTPS/)

    // Enabled — local mock servers pass through.
    setAllowHttpLoopbackForTests(true)
    await httpFetch("http://127.0.0.1:11434/v1/embeddings", { method: "GET" })
    await httpFetch("http://localhost:11434/v1/embeddings")
    expect(fetchStub).toHaveBeenCalledTimes(2)

    // Re-enabled off blocks again.
    setAllowHttpLoopbackForTests(false)
    expect(() => httpFetch("http://127.0.0.1:11434/")).toThrow(/non-HTTPS/)
  })

  it("keeps non-loopback http blocked even with the test bypass enabled", async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal("fetch", fetchStub)
    setAllowHttpLoopbackForTests(true)

    const httpFetch = await getHttpFetch()
    expect(() => httpFetch("http://example.com/data")).toThrow(/non-HTTPS/)
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

describe("getHttpFetch (Tauri bridge present)", () => {
  it("routes through the Tauri HTTP plugin when __TAURI_INTERNALS__ exists", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    vi.resetModules()
    pluginFetchMock.mockResolvedValue(new Response("plugin"))

    const mod = await import("./tauri-fetch")
    mod.resetHttpFetchForTests()
    const httpFetch = await mod.getHttpFetch()
    const res = await httpFetch("https://api.example.com/x")

    expect(res).toBeInstanceOf(Response)
    expect(pluginFetchMock).toHaveBeenCalledWith("https://api.example.com/x", undefined)
  })

  it("falls back to the platform fetch when the plugin import fails", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    vi.resetModules()
    vi.doMock("@tauri-apps/plugin-http", () => {
      throw new Error("plugin module load failed")
    })
    const fetchStub = vi.fn(async () => new Response("native"))
    vi.stubGlobal("fetch", fetchStub)

    const mod = await import("./tauri-fetch")
    mod.resetHttpFetchForTests()
    const httpFetch = await mod.getHttpFetch()
    const res = await httpFetch("https://api.example.com/x")

    expect(res).toBeInstanceOf(Response)
    expect(fetchStub).toHaveBeenCalledWith("https://api.example.com/x", undefined)
  })
})

describe("isFetchNetworkError", () => {
  it("returns false for non-Error values and AbortErrors", () => {
    expect(isFetchNetworkError("some string")).toBe(false)
    expect(isFetchNetworkError(null)).toBe(false)
    expect(isFetchNetworkError(new DOMException("aborted", "AbortError"))).toBe(false)
    const abortError = new Error("aborted")
    abortError.name = "AbortError"
    expect(isFetchNetworkError(abortError)).toBe(false)
  })

  it("detects Chromium TypeError / failed-to-fetch failures", () => {
    expect(isFetchNetworkError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isFetchNetworkError(new Error("Failed to fetch"))).toBe(true)
  })

  it("detects WebKit 'Load failed' and Tauri/Rust send-stage failures", () => {
    expect(isFetchNetworkError(new Error("Load failed"))).toBe(true)
    expect(isFetchNetworkError(new Error("error sending request for url (http://localhost:11434/v1)"))).toBe(true)
    expect(isFetchNetworkError(new Error("a network error occurred while talking to the upstream"))).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(isFetchNetworkError(new Error("HTTP 500 Internal Server Error"))).toBe(false)
    expect(isFetchNetworkError(new Error("Request failed with status code 429"))).toBe(false)
  })
})
