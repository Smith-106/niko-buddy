import type { LlmConfig } from "@/stores/wiki-store"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"

export interface DirectRerankResultItem {
  index: number
  relevanceScore: number
}

interface DirectRerankResponse {
  results?: Array<{
    index?: number
    relevance_score?: number
  }>
}

export function isDirectRerankEndpoint(config: Pick<LlmConfig, "provider" | "customEndpoint">): boolean {
  return config.provider === "custom" && /\/rerank\/?$/i.test(config.customEndpoint.trim())
}

/**
 * Resolve the final POST URL for a direct rerank endpoint.
 * Accepts either a full `…/rerank` URL or a bare OpenAI-style base
 * (`https://api.siliconflow.cn/v1`); a base URL is auto-suffixed with
 * `/rerank` so users can paste the provider base instead of the exact
 * rerank path. Request-path tails for chat (`/chat/completions`,
 * `/responses`, `/messages`) are never treated as rerank endpoints.
 */
export function resolveDirectRerankUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "")
  if (/\/rerank$/i.test(trimmed)) return trimmed
  return `${trimmed}/rerank`
}

/**
 * True when the custom endpoint is rerank-capable: either an explicit
 * `…/rerank` URL or a bare base URL that will be auto-suffixed. Explicit
 * chat-path tails (`/chat/completions`, `/responses`, `/messages`) are
 * excluded — those are chat endpoints, not rerank.
 */
export function isRerankCapableEndpoint(config: Pick<LlmConfig, "provider" | "customEndpoint">): boolean {
  if (config.provider !== "custom") return false
  const trimmed = config.customEndpoint.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  if (/\/(chat\/completions|responses|messages)\/?$/i.test(trimmed)) return false
  return true
}

export async function requestDirectRerank(
  config: Pick<LlmConfig, "provider" | "customEndpoint" | "apiKey" | "model">,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<DirectRerankResultItem[]> {
  const endpoint = config.customEndpoint.trim()
  if (!isRerankCapableEndpoint(config)) {
    throw new Error("当前配置不是直连重排接口。")
  }
  /* v8 ignore next */
  if (!endpoint) {
    throw new Error("请先填写重排接口地址后再测试。")
  }
  if (!config.model.trim()) {
    throw new Error("请先填写重排模型名称后再测试。")
  }
  if (documents.length === 0) {
    return []
  }

  try {
    const httpFetch = await getHttpFetch()
    const response = await httpFetch(resolveDirectRerankUrl(endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model.trim(),
        query,
        documents,
        top_n: documents.length,
        return_documents: false,
      }),
      signal,
    })

    if (!response.ok) {
      let bodyText = ""
      try {
        bodyText = await response.text()
      } catch {
        // Ignore empty error bodies.
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}${bodyText ? ` - ${bodyText.slice(0, 200)}` : ""}`)
    }

    const data = await response.json() as DirectRerankResponse
    const results = data.results
      ?.filter((item): item is { index: number; relevance_score?: number } => typeof item?.index === "number")
      .map((item) => ({
        index: item.index,
        relevanceScore: typeof item.relevance_score === "number" ? item.relevance_score : 0,
      }))

    if (!results || results.length === 0) {
      throw new Error("重排接口已连通，但没有返回有效的 results 结果。")
    }

    return results
  } catch (error) {
    if (isFetchNetworkError(error)) {
      throw new Error(`无法连接到重排接口：${endpoint}`)
    }
    throw error
  }
}
