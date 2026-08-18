import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SearchApiConfig } from "@/stores/wiki-store"

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: vi.fn(),
  isFetchNetworkError: vi.fn(),
}))

import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import {
  SEARXNG_CATEGORY_OPTIONS,
  SERPAPI_ENGINE_OPTIONS,
  resolveSearchConfig,
  webSearch,
} from "./web-search"

const mockedGetHttpFetch = vi.mocked(getHttpFetch)
const mockedIsFetchNetworkError = vi.mocked(isFetchNetworkError)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response
}

function baseConfig(overrides: Partial<SearchApiConfig> = {}): SearchApiConfig {
  return {
    provider: "tavily",
    apiKey: "key",
    serpApiEngine: "google",
    searXngUrl: "",
    searXngCategories: ["general"],
    ...overrides,
  } as SearchApiConfig
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetHttpFetch.mockResolvedValue(vi.fn() as unknown as typeof fetch)
})

describe("provider option lists", () => {
  it("exposes SerpApi engine options", () => {
    expect(SERPAPI_ENGINE_OPTIONS.map((o) => o.value)).toContain("google")
    expect(SERPAPI_ENGINE_OPTIONS.length).toBeGreaterThan(3)
  })

  it("exposes SearXNG category options", () => {
    expect(SEARXNG_CATEGORY_OPTIONS.map((o) => o.value)).toContain("general")
    expect(SEARXNG_CATEGORY_OPTIONS.length).toBeGreaterThan(3)
  })
})

describe("resolveSearchConfig", () => {
  it("merges top-level defaults into a per-provider config when providerConfigs is absent", () => {
    const resolved = resolveSearchConfig(baseConfig({ provider: "serpapi", apiKey: "k2" }))
    expect(resolved.apiKey).toBe("k2")
    expect(resolved.providerConfigs).toBeDefined()
    expect(resolved.providerConfigs!.serpapi?.apiKey).toBe("k2")
  })

  it("builds a searxng provider config when provider is searxng", () => {
    const resolved = resolveSearchConfig(
      baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com", searXngCategories: ["news"] }),
    )
    expect(resolved.providerConfigs?.searxng?.searXngUrl).toBe("https://search.example.com")
    expect(resolved.searXngUrl).toBe("https://search.example.com")
  })

  it("returns a neutral config for provider none", () => {
    const resolved = resolveSearchConfig(baseConfig({ provider: "none", apiKey: "k" }))
    expect(resolved.provider).toBe("none")
    expect(resolved.apiKey).toBe("")
  })

  it("applies provider defaults when everything is undefined in the none branch", () => {
    const resolved = resolveSearchConfig({
      provider: "none",
      apiKey: "",
    } as SearchApiConfig)
    expect(resolved.serpApiEngine).toBe("google")
    expect(resolved.searXngUrl).toBe("")
    expect(resolved.searXngCategories).toEqual(["general"])
  })

  it("prefers provider-specific overrides for the active provider", () => {
    const resolved = resolveSearchConfig({
      provider: "serpapi",
      apiKey: "top",
      serpApiEngine: "bing",
      providerConfigs: {
        serpapi: { apiKey: "per-provider", serpApiEngine: "google_scholar" },
      },
    } as SearchApiConfig)
    expect(resolved.apiKey).toBe("per-provider")
    expect(resolved.serpApiEngine).toBe("google_scholar")
  })

  it("falls back to top-level values when the override is partial", () => {
    const resolved = resolveSearchConfig({
      provider: "serpapi",
      apiKey: "top",
      serpApiEngine: "bing",
      providerConfigs: {
        serpapi: { apiKey: "per-provider" },
      },
    } as SearchApiConfig)
    expect(resolved.apiKey).toBe("per-provider")
    expect(resolved.serpApiEngine).toBe("bing")
  })

  it("handles providerConfigs with no matching entry", () => {
    const resolved = resolveSearchConfig({
      provider: "tavily",
      apiKey: "top",
      providerConfigs: {},
    } as SearchApiConfig)
    expect(resolved.apiKey).toBe("top")
  })

  it("defaults apiKey to empty when override and top-level are both missing", () => {
    const resolved = resolveSearchConfig({
      provider: "tavily",
      providerConfigs: {},
    } as SearchApiConfig)
    expect(resolved.apiKey).toBe("")
  })
})

describe("webSearch", () => {
  it("throws when no provider is configured", async () => {
    await expect(webSearch("q", baseConfig({ provider: "none" }))).rejects.toThrow("Web search not configured")
  })

  it("throws when a keyed provider has no api key", async () => {
    await expect(webSearch("q", baseConfig({ provider: "tavily", apiKey: "" }))).rejects.toThrow("Add a Tavily and SerpApi API key")
    await expect(webSearch("q", baseConfig({ provider: "serpapi", apiKey: "" }))).rejects.toThrow("Add a Tavily and SerpApi API key")
  })

  it("throws when searxng has no instance url", async () => {
    await expect(webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "  " }))).rejects.toThrow("Add a SearXNG instance URL")
  })

  it("throws for an unknown provider", async () => {
    await expect(webSearch("q", baseConfig({ provider: "unknown" as never }))).rejects.toThrow("Unknown search provider")
  })

  it("runs a Tavily search and maps results", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        results: [
          { title: "T1", url: "https://tavily.com/a", content: "content a" },
          { title: "", url: "", content: "" },
        ],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const results = await webSearch("query", baseConfig(), 5)
    expect(results).toEqual([
      { title: "T1", url: "https://tavily.com/a", snippet: "content a", source: "tavily.com" },
      { title: "", url: "", snippet: "", source: "" },
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("api.tavily.com/search")
    expect(JSON.parse(String(init?.body))).toMatchObject({ api_key: "key", query: "query", max_results: 5 })
  })

  it("propagates non-network errors from SerpApi", async () => {
    mockedIsFetchNetworkError.mockReturnValue(false)
    const fetchMock = vi.fn(async () => {
      throw new Error("serp boom")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig({ provider: "serpapi" }))).rejects.toThrow("serp boom")
  })

  it("maps Tavily results with undefined fields to defaults", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: "https://x.com/1" }] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig(), 10)
    expect(results[0]).toMatchObject({ title: "Untitled", snippet: "", source: "x.com" })
  })

  it("defaults Tavily url and snippet when fields are undefined", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ title: "no-url" }] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig(), 10)
    expect(results[0]).toMatchObject({ title: "no-url", url: "", snippet: "", source: "" })
  })

  it("defaults Tavily title and content when undefined", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: "https://tavily.com/u" }] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig(), 10)
    expect(results[0]).toMatchObject({ title: "Untitled", snippet: "", source: "tavily.com" })
  })

  it("handles a missing results array for Tavily", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    expect(await webSearch("q", baseConfig(), 10)).toEqual([])
  })

  it("throws a friendly network error for Tavily", async () => {
    mockedIsFetchNetworkError.mockReturnValue(true)
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig())).rejects.toThrow("Network error reaching api.tavily.com")
  })

  it("propagates non-network errors from Tavily", async () => {
    mockedIsFetchNetworkError.mockReturnValue(false)
    const fetchMock = vi.fn(async () => {
      throw new Error("boom")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig())).rejects.toThrow("boom")
  })

  it("throws on non-ok Tavily responses with error text", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("bad key", false, 401))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig())).rejects.toThrow("Tavily search failed (401): bad key")
  })

  it("runs a SerpApi search with engine params", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        organic_results: [{ title: "S1", link: "https://serp.com/1", snippet: "snip" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const results = await webSearch("q", baseConfig({ provider: "serpapi", serpApiEngine: "bing" }), 3)
    expect(results[0]).toMatchObject({ title: "S1", url: "https://serp.com/1", snippet: "snip", source: "serp.com" })
    expect(String(fetchMock.mock.calls[0][0])).toContain("serpapi.com/search")
    expect(String(fetchMock.mock.calls[0][0])).toContain("engine=bing")
    expect(String(fetchMock.mock.calls[0][0])).toContain("num=3")
  })

  it("throws a friendly network error for SerpApi", async () => {
    mockedIsFetchNetworkError.mockReturnValue(true)
    const fetchMock = vi.fn(async () => {
      throw new TypeError("x")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig({ provider: "serpapi" }))).rejects.toThrow("Network error reaching serpapi.com")
  })

  it("throws on SerpApi API-level errors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "rate limited" }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig({ provider: "serpapi" }))).rejects.toThrow("SerpApi search failed: rate limited")
  })

  it("normalizes SerpApi news/images/video/shopping result shapes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        news_results: [{ title: "N", link: "https://n.com/1", summary: "sum" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const news = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(news[0]).toMatchObject({ title: "N", snippet: "sum" })

    const fetchMock2 = vi.fn(async () =>
      jsonResponse({
        images_results: [{ title: "I", original: "https://i.com/1" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock2 as unknown as typeof fetch)
    const images = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(images[0]?.url).toBe("https://i.com/1")

    const fetchMock3 = vi.fn(async () =>
      jsonResponse({
        video_results: [{ title: "V", link: "https://v.com/1", description: "d" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock3 as unknown as typeof fetch)
    const videos = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(videos[0]?.url).toBe("https://v.com/1")

    const fetchMock4 = vi.fn(async () =>
      jsonResponse({
        videos_results: [{ title: "V2", link: "https://v.com/2", description: "d2" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock4 as unknown as typeof fetch)
    const videos2 = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(videos2[0]?.url).toBe("https://v.com/2")

    const fetchMock5 = vi.fn(async () =>
      jsonResponse({
        shopping_results: [{ title: "SH", link: "https://s.com/1", snippet: "s" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock5 as unknown as typeof fetch)
    const shopping = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(shopping[0]?.url).toBe("https://s.com/1")

    const fetchMock6 = vi.fn(async () => jsonResponse({}))
    mockedGetHttpFetch.mockResolvedValue(fetchMock6 as unknown as typeof fetch)
    const none = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(none).toEqual([])
  })

  it("walks the SerpApi url fallback chain to thumbnail", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        organic_results: [{ title: "T", thumbnail: "https://thumb.example.com/t.png" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(results[0]?.url).toBe("https://thumb.example.com/t.png")
    expect(results[0]?.source).toBe("thumb.example.com")
  })

  it("uses empty defaults when SerpApi item has no url fields at all", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        organic_results: [{ snippet: "only snippet" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(results[0]).toMatchObject({ title: "Untitled", url: "", snippet: "only snippet", source: "" })
  })

  it("falls back to r.source when the SerpApi url has no hostname", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        organic_results: [{ link: "http://", source: "custom-source" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(results[0]?.source).toBe("custom-source")
  })

  it("falls back to displayed_link when both hostname and source are empty", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        organic_results: [{ link: "http://", source: "", displayed_link: "shown.example" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "serpapi" }), 10)
    expect(results[0]?.source).toBe("shown.example")
  })

  it("uses the general category when searxng categories is empty", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ results: [] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://s.example.com", searXngCategories: [] }), 10)
    expect(String(fetchMock.mock.calls[0][0])).toContain("categories=general")
  })

  it("runs a SearXNG search with category params", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        results: [
          { title: "X1", url: "https://x.com/1", content: "c", engine: "google", category: "general" },
          { title: "X2", url: "https://x.com/2" },
          { url: "https://x.com/3", title: "X3" },
        ],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const results = await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }), 10)
    expect(results).toHaveLength(3)
    expect(results[0].source).toBe("x.com")
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("search.example.com/search")
    expect(String(url)).toContain("format=json")
    expect(String(url)).toContain("categories=general")
  })

  it("falls back to engine/category in SearXNG source", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [{ title: "Y", url: "http://", engine: "brave", category: "it" }],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }), 10)
    expect(results[0].source).toBe("brave")
  })

  it("appends /search to a bare searxng instance url", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ results: [] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "search.example.com" }), 10)
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://search.example.com/search")
  })

  it("keeps an existing /search path", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ results: [] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com/search" }), 10)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/search\?/)
  })

  it("throws a friendly error for invalid searxng urls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(
      webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "::not a url::" }), 10),
    ).rejects.toThrow("Invalid SearXNG instance URL")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws a friendly network error for SearXNG", async () => {
    mockedIsFetchNetworkError.mockReturnValue(true)
    const fetchMock = vi.fn(async () => {
      throw new TypeError("x")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }))).rejects.toThrow(
      "Network error reaching the SearXNG instance",
    )
  })

  it("propagates non-network errors from SearXNG", async () => {
    mockedIsFetchNetworkError.mockReturnValue(false)
    const fetchMock = vi.fn(async () => {
      throw new Error("boom")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }))).rejects.toThrow("boom")
  })

  it("throws on non-ok SearXNG responses", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("no json", false, 500))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(
      webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" })),
    ).rejects.toThrow("SearXNG search failed (500): no json")
  })

  it("falls back to 'Unknown error' when a failing response has no body", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error("body read failed")
      },
    }) as unknown as Response)
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    await expect(
      webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" })),
    ).rejects.toThrow("SearXNG search failed (503): Unknown error")
    await expect(webSearch("q", baseConfig())).rejects.toThrow("Tavily search failed (503): Unknown error")
    await expect(webSearch("q", baseConfig({ provider: "serpapi" }))).rejects.toThrow("SerpApi search failed (503): Unknown error")
  })

  it("normalizes SearXNG results with empty url filtering", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: "keep", url: "https://k.com/1" },
          { title: "drop", url: "" },
        ],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }), 10)
    expect(results).toHaveLength(1)
  })

  it("falls back to Untitled and drops items without a url", async () => {
    // Result 1 has a url but no title (r.title ?? "Untitled"); result 2 has a
    // title but no url (r.url ?? "" → filtered out by the url-length guard).
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { url: "https://u.com/1" },
          { title: "no-url" },
        ],
      }),
    )
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }), 10)
    expect(results).toEqual([{ title: "Untitled", url: "https://u.com/1", snippet: "", source: "u.com" }])
  })

  it("handles a missing results array for SearXNG", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)
    const results = await webSearch("q", baseConfig({ provider: "searxng", searXngUrl: "https://search.example.com" }), 10)
    expect(results).toEqual([])
  })
})
