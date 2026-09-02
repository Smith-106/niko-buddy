import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── mocks ────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getHttpFetch: vi.fn(),
  proxyConfig: { enabled: false, url: "" },
}))

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: (...a: unknown[]) => mocks.getHttpFetch(...a),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ proxyConfig: mocks.proxyConfig }),
  },
}))

import {
  DEFAULT_ENDPOINT_PROBE_CONNECT_TIMEOUT_MS,
  DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS,
  clearEndpointProbeCacheForTests,
  deriveProbeUrl,
  probeEndpointReachability,
} from "./endpoint-probe"

// ── helpers ───────────────────────────────────────────────────────────────

function okFetch(status = 200): typeof fetch {
  return (async () => new Response("[]", { status })) as typeof fetch
}

function failFetch(err: unknown): typeof fetch {
  return (async () => {
    throw err
  }) as typeof fetch
}

function hangFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"))
      })
    })) as typeof fetch
}

function setupFetch(mock: typeof fetch): void {
  mocks.getHttpFetch.mockResolvedValue(mock as never)
}

const URL_CHAT = "https://integrate.api.nvidia.com/v1/chat/completions"
const URL_MODELS = "https://integrate.api.nvidia.com/v1/models"

beforeEach(() => {
  clearEndpointProbeCacheForTests()
  mocks.getHttpFetch.mockReset()
  setupFetch(okFetch())
  mocks.proxyConfig.enabled = false
  mocks.proxyConfig.url = ""
})

afterEach(() => {
  vi.useRealTimers()
})

// ── deriveProbeUrl ────────────────────────────────────────────────────────

describe("deriveProbeUrl", () => {
  it("strips chat-request tails and appends /models", () => {
    expect(deriveProbeUrl(URL_CHAT)).toBe(URL_MODELS)
    expect(deriveProbeUrl("https://host/v1/responses")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/v1/messages")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/v1/embeddings")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/openai/deployments/x/chat/completions")).toBe(
      "https://host/openai/deployments/x/models",
    )
  })

  it("normalizes trailing slashes and never doubles /models", () => {
    expect(deriveProbeUrl("https://host/v1/")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/v1/chat/completions/")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/v1/models")).toBe("https://host/v1/models")
    expect(deriveProbeUrl("https://host/v1/models/")).toBe("https://host/v1/models")
  })

  it("rejects non-http(s) and malformed URLs", () => {
    expect(deriveProbeUrl("ftp://host/v1/chat/completions")).toBeNull()
    expect(deriveProbeUrl("not a url")).toBeNull()
    expect(deriveProbeUrl("")).toBeNull()
  })
})

// ── probeEndpointReachability ─────────────────────────────────────────────

describe("probeEndpointReachability", () => {
  it("treats any HTTP status (401 included) as reachable and sends GET /models with connectTimeout", async () => {
    const fetchSpy = vi.fn(okFetch(401)) as unknown as ReturnType<typeof vi.fn>
    setupFetch(fetchFetchSpy(fetchSpy))
    const result = await probeEndpointReachability(URL_CHAT)
    expect(result.reachable).toBe(true)
    expect(result.status).toBe(401)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = (fetchSpy.mock.calls[0] ?? []) as [string, RequestInit]
    expect(calledUrl).toBe(URL_MODELS)
    expect(calledInit.method).toBe("GET")
    expect((calledInit as RequestInit & { connectTimeout?: number }).connectTimeout).toBe(
      DEFAULT_ENDPOINT_PROBE_CONNECT_TIMEOUT_MS,
    )
  })

  it("reports unreachable with errorKind network on transport failure", async () => {
    setupFetch(failFetch(new TypeError("Failed to fetch")))
    const result = await probeEndpointReachability(URL_CHAT)
    expect(result.reachable).toBe(false)
    expect(result.errorKind).toBe("network")
    expect(result.status).toBeUndefined()
  })

  it("reports unreachable with errorKind deadline when the probe hangs past the deadline", async () => {
    vi.useFakeTimers()
    setupFetch(hangFetch())
    const promise = probeEndpointReachability(URL_CHAT)
    await vi.advanceTimersByTimeAsync(DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS + 1)
    const result = await promise
    expect(result.reachable).toBe(false)
    expect(result.errorKind).toBe("deadline")
  })

  it("caches results per url+proxy state for 5 minutes", async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(okFetch()) as unknown as ReturnType<typeof vi.fn>
    setupFetch(fetchFetchSpy(fetchSpy))
    await probeEndpointReachability(URL_CHAT)
    await probeEndpointReachability(URL_CHAT)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // different proxy state → different cache key → re-probe
    mocks.proxyConfig = { enabled: true, url: "http://127.0.0.1:8756" }
    await probeEndpointReachability(URL_CHAT)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // after TTL expiry → re-probe
    mocks.proxyConfig = { enabled: false, url: "" }
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await probeEndpointReachability(URL_CHAT)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("dedupes concurrent probes for the same key into one request", async () => {
    const fetchSpy = vi.fn(okFetch()) as unknown as ReturnType<typeof vi.fn>
    setupFetch(fetchFetchSpy(fetchSpy))
    const [a, b] = await Promise.all([
      probeEndpointReachability(URL_CHAT),
      probeEndpointReachability(URL_CHAT),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a.reachable).toBe(true)
    expect(b.reachable).toBe(true)
  })

  it("returns unreachable without any request for unusable URLs", async () => {
    const fetchSpy = vi.fn(okFetch()) as unknown as ReturnType<typeof vi.fn>
    setupFetch(fetchFetchSpy(fetchSpy))
    const result = await probeEndpointReachability("not a url")
    expect(result.reachable).toBe(false)
    expect(result.errorKind).toBe("network")
    expect(result.latencyMs).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("honors explicit timeout overrides", async () => {
    vi.useFakeTimers()
    setupFetch(hangFetch())
    const promise = probeEndpointReachability(URL_CHAT, { timeoutMs: 1_500 })
    await vi.advanceTimersByTimeAsync(1_501)
    const result = await promise
    expect(result.reachable).toBe(false)
    expect(result.errorKind).toBe("deadline")
  })
})

/** Adapter: the mocked getHttpFetch resolves to the spy itself. */
function fetchFetchSpy(spy: unknown): typeof fetch {
  return spy as unknown as typeof fetch
}
