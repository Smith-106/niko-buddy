/**
 * @license MIT © QMAI
 *
 * Web search abstraction supporting Tavily, SerpApi, and SearXNG providers.
 */
import type {
  SearchApiConfig,
  SearchProvider,
  SearchProviderConfigs,
  SearXngCategory,
  SerpApiEngine,
} from "@/stores/wiki-store"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

/** Available SerpApi engine options for the settings UI. */
export const SERPAPI_ENGINE_OPTIONS: { value: SerpApiEngine; label: string; hint: string }[] = [
  { value: "google", label: "Google Web", hint: "SerpApi Google Search API organic results" },
  { value: "google_news", label: "Google News", hint: "News-focused results" },
  { value: "google_scholar", label: "Google Scholar", hint: "Academic papers and citations" },
  { value: "google_patents", label: "Google Patents", hint: "Patent search results" },
  { value: "bing", label: "Bing", hint: "Bing organic results" },
  { value: "duckduckgo", label: "DuckDuckGo", hint: "DuckDuckGo organic results" },
  { value: "google_images", label: "Google Images", hint: "Image search results" },
  { value: "google_videos", label: "Google Videos", hint: "Video search results" },
  { value: "youtube", label: "YouTube", hint: "YouTube video results" },
]

/** Available SearXNG category options for the settings UI. */
export const SEARXNG_CATEGORY_OPTIONS: { value: SearXngCategory; label: string; hint: string }[] = [
  { value: "general", label: "General", hint: "Default web results" },
  { value: "news", label: "News", hint: "News engines" },
  { value: "science", label: "Science", hint: "Academic and science-focused engines" },
  { value: "it", label: "IT", hint: "Developer and technology engines" },
  { value: "images", label: "Images", hint: "Image search results" },
  { value: "videos", label: "Videos", hint: "Video search results" },
  { value: "files", label: "Files", hint: "File and document search" },
  { value: "map", label: "Map", hint: "Map and location results" },
  { value: "music", label: "Music", hint: "Music engines" },
  { value: "social media", label: "Social", hint: "Social media engines" },
]

/**
 * Resolve the active search provider configuration, merging per-provider
 * overrides with top-level defaults.
 */
export function resolveSearchConfig(config: SearchApiConfig): SearchApiConfig {
  const providerConfigs: SearchProviderConfigs = config.providerConfigs ?? {
    ...(config.provider !== "none" && config.apiKey
      ? {
          [config.provider]: {
            apiKey: config.apiKey,
            serpApiEngine: config.serpApiEngine,
            searXngUrl: config.searXngUrl,
            searXngCategories: config.searXngCategories,
          },
        }
      : {}),
    ...(config.provider === "searxng" && config.searXngUrl
      ? {
          searxng: {
            searXngUrl: config.searXngUrl,
            searXngCategories: config.searXngCategories,
          },
        }
      : {}),
  }

  const active = config.provider as SearchProvider
  if (active === "none") {
    return {
      ...config,
      provider: "none",
      apiKey: "",
      serpApiEngine: config.serpApiEngine ?? providerConfigs.serpapi?.serpApiEngine ?? "google",
      searXngUrl: config.searXngUrl ?? providerConfigs.searxng?.searXngUrl ?? "",
      searXngCategories: config.searXngCategories ?? providerConfigs.searxng?.searXngCategories ?? ["general"],
      providerConfigs,
    }
  }

  const override = providerConfigs[active]
  return {
    ...config,
    provider: active,
    apiKey: override?.apiKey ?? config.apiKey ?? "",
    serpApiEngine: override?.serpApiEngine ?? config.serpApiEngine ?? "google",
    searXngUrl: override?.searXngUrl ?? config.searXngUrl ?? "",
    searXngCategories: override?.searXngCategories ?? config.searXngCategories ?? ["general"],
    providerConfigs,
  }
}

/**
 * Execute a web search using the configured provider.
 *
 * @throws When no provider is configured or required credentials are missing.
 */
export async function webSearch(
  query: string,
  config: SearchApiConfig,
  maxResults: number = 10,
): Promise<WebSearchResult[]> {
  const resolved = resolveSearchConfig(config)

  if (resolved.provider === "none") {
    throw new Error("Web search not configured. Select a search provider in Settings.")
  }
  if ((resolved.provider === "tavily" || resolved.provider === "serpapi") && !resolved.apiKey) {
    throw new Error("Web search not configured. Add a Tavily and SerpApi API key in Settings.")
  }
  if (resolved.provider === "searxng" && !resolved.searXngUrl?.trim()) {
    throw new Error("Web search not configured. Add a SearXNG instance URL in Settings.")
  }

  switch (resolved.provider) {
    case "tavily":
      return tavilySearch(query, resolved.apiKey, maxResults)
    case "serpapi":
      /* v8 ignore next */
      return serpApiSearch(query, resolved.apiKey, maxResults, resolved.serpApiEngine ?? "google")
    case "searxng":
      /* v8 ignore next */
      return searxngSearch(query, resolved.searXngUrl ?? "", maxResults, resolved.searXngCategories ?? ["general"])
    default:
      throw new Error(`Unknown search provider: ${resolved.provider}`)
  }
}

// ── SearXNG ────────────────────────────────────────────────────────

function buildSearXngEndpoint(instanceUrl: string): URL {
  const trimmed = instanceUrl.trim()
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProto)
  const base = url.pathname.replace(/\/+$/, "")
  url.pathname = base.endsWith("/search") || base === "/search" ? base : `${base}/search`
  url.search = ""
  url.hash = ""
  return url
}

async function searxngSearch(
  query: string,
  instanceUrl: string,
  maxResults: number,
  categories: SearXngCategory[],
): Promise<WebSearchResult[]> {
  let endpoint: URL
  try {
    endpoint = buildSearXngEndpoint(instanceUrl)
  } catch {
    throw new Error("Invalid SearXNG instance URL. Use a valid http(s) URL, for example https://search.example.com.")
  }

  endpoint.searchParams.set("q", query)
  endpoint.searchParams.set("format", "json")
  endpoint.searchParams.set("categories", (categories.length > 0 ? categories : ["general"]).join(","))

  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch(endpoint.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error("Network error reaching the SearXNG instance. Check the instance URL and whether JSON search is enabled.")
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`SearXNG search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  return normaliseSearXngResults(data, maxResults)
}

function normaliseSearXngResults(data: { results?: unknown[] }, limit: number): WebSearchResult[] {
  return (data.results ?? [])
    .slice(0, limit)
    .map((item) => {
      const r = item as { title?: string; url?: string; content?: string; engine?: string; category?: string }
      const url = r.url ?? ""
      return {
        title: r.title ?? "Untitled",
        url,
        snippet: r.content ?? "",
        source: hostname(url) || r.engine || r.category || "",
      }
    })
    .filter((item) => item.url.length > 0)
}

// ── Tavily ─────────────────────────────────────────────────────────

async function tavilySearch(query: string, apiKey: string, maxResults: number): Promise<WebSearchResult[]> {
  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "advanced",
        include_answer: false,
      }),
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error("Network error reaching api.tavily.com. Check your connectivity and whether the Tavily API key is still valid.")
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`Tavily search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  return (data.results ?? []).map((r: { title: string; url: string; content: string }) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.content ?? "",
    source: hostname(r.url ?? ""),
  }))
}

// ── SerpApi ────────────────────────────────────────────────────────

async function serpApiSearch(
  query: string,
  apiKey: string,
  maxResults: number,
  engine: SerpApiEngine,
): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ engine, q: query, api_key: apiKey, num: String(maxResults) })

  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch(`https://serpapi.com/search?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error("Network error reaching serpapi.com. Check your connectivity and whether the SerpApi API key is still valid.")
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`SerpApi search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  if (typeof data.error === "string" && data.error.trim()) {
    throw new Error(`SerpApi search failed: ${data.error}`)
  }

  return normaliseSerpApiResults(data, maxResults)
}

function normaliseSerpApiResults(data: {
  organic_results?: unknown[]
  news_results?: unknown[]
  images_results?: unknown[]
  video_results?: unknown[]
  videos_results?: unknown[]
  shopping_results?: unknown[]
}, limit: number): WebSearchResult[] {
  const raw =
    data.organic_results ??
    data.news_results ??
    data.images_results ??
    data.video_results ??
    data.videos_results ??
    data.shopping_results ??
    []

  return raw.slice(0, limit).map((item) => {
    const r = item as {
      title?: string; link?: string; url?: string; source?: string
      snippet?: string; summary?: string; description?: string
      thumbnail?: string; original?: string; displayed_link?: string
    }
    const url = r.link ?? r.url ?? r.original ?? r.thumbnail ?? ""
    return {
      title: r.title ?? "Untitled",
      url,
      snippet: r.snippet ?? r.summary ?? r.description ?? "",
      source: hostname(url) || r.source || r.displayed_link || "",
    }
  })
}

// ── Utility ────────────────────────────────────────────────────────

function hostname(url: string): string {
  try { return new URL(url).hostname.replace("www.", "") } catch { return "" }
}

export function providerRequiresApiKey(provider: string): boolean {
  return provider !== "none" && provider !== "local"
}
