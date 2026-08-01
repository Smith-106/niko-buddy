/**
 * Model list fetching for the settings panel.
 * Supports LLM, embedding, and rerank model discovery across
 * OpenAI-compatible, Google, Azure, and local CLI providers.
 * MIT License — independently implemented.
 */

import { getProviderConfig, withCustomOriginHeader } from "@/lib/llm-providers"
import { detectLocalCliConfig } from "@/lib/local-cli-config"
import { isDirectRerankEndpoint } from "@/lib/rerank-api"
import { getHttpFetch } from "@/lib/tauri-fetch"
import type { EmbeddingConfig, LlmConfig, RerankConfig } from "@/stores/wiki-store"

export interface LlmModelListResult {
  models: string[]
}

/** Browser-compatible headers added when the initial request gets a 403. */
const COMPAT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QMaiWrite",
}

/** Deduplicate, trim, and sort model names alphabetically. */
function dedupeAndSort(models: string[]): string[] {
  return Array.from(new Set(models.map((m) => m.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
}

/**
 * Extract model names from a JSON API response.
 * Supports `{ data: [...] }`, `{ models: [...] }` shapes,
 * and items with `id`, `name`, or `model` fields.
 */
function parseModelList(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return []
  const items = Array.isArray((raw as { data?: unknown }).data)
    ? (raw as { data: unknown[] }).data
    : Array.isArray((raw as { models?: unknown }).models)
      ? (raw as { models: unknown[] }).models
      : []

  return items.map((item) => {
    if (typeof item === "string") return item
    if (item && typeof item === "object") {
      const record = item as { id?: unknown; name?: unknown; model?: unknown }
      const id = record.id ?? record.name ?? record.model
      return typeof id === "string" ? id : ""
    }
    return ""
  })
}

/** Remove Google API key query parameter from a URL. */
function stripGoogleApiKey(url: string): string {
  if (!url.includes("?")) return url
  try {
    const u = new URL(url)
    u.searchParams.delete("key")
    return u.toString()
  } catch {
    return url.replace(/([?&])key=[^&]*&?/i, (_, prefix: string) => (prefix === "?" ? "?" : "&"))
      .replace(/[?&]$/, "")
      .replace("?&", "?")
  }
}

/**
 * Build the `/models` endpoint URL from a raw endpoint string.
 * Handles Google, OpenAI-compatible, and various path suffixes.
 */
function buildEndpointModelsUrl(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new Error("请先填写接口地址后再拉取模型列表。")
  }

  if (trimmed.includes("generativelanguage.googleapis.com") || /:embedcontent(\?|$)/i.test(trimmed)) {
    const base = stripGoogleApiKey(trimmed)
      .replace(/\/+$/, "")
      .replace(/\/models\/[^/?]+:(?:embedContent|batchEmbedContents)(?:\?.*)?$/i, "")
      .replace(/\/models\/[^/?]+(?:\?.*)?$/i, "")
      .replace(/\/models(?:\?.*)?$/i, "")
    return `${base}/models`
  }

  // Replace known request-path suffixes with /models.
  const suffixes = [/\/embeddings(?:\?.*)?$/i, /\/chat\/completions(?:\?.*)?$/i, /\/responses(?:\?.*)?$/i, /\/messages(?:\?.*)?$/i, /\/rerank(?:\?.*)?$/i]
  for (const suffix of suffixes) {
    if (suffix.test(trimmed)) return trimmed.replace(suffix, "/models")
  }
  if (/\/models(?:\?.*)?$/i.test(trimmed)) return trimmed
  return `${trimmed.replace(/\/+$/, "")}/models`
}

function toResult(models: string[]): LlmModelListResult {
  return { models: dedupeAndSort(models) }
}

/** Build the models URL and headers for a given LLM config. */
function buildModelsRequest(config: LlmConfig): { url: string; headers: Record<string, string> } {
  if (config.provider === "google") {
    const base = stripGoogleApiKey(config.customEndpoint.trim() || "https://generativelanguage.googleapis.com/v1beta")
      .replace(/\/+$/, "")
      .replace(/\/models(?:\/[^/?]+(?::(?:embedContent|batchEmbedContents))?)?$/i, "")
    return {
      url: `${base}/models`,
      headers: config.apiKey ? { "x-goog-api-key": config.apiKey } : {},
    }
  }

  if (config.provider === "claude-code" || config.provider === "codex-cli") {
    return { url: "", headers: {} }
  }

  const providerConfig = getProviderConfig(config)
  const url = providerConfig.url
  let modelsUrl: string

  const suffixes = [/\/chat\/completions(?:\?.*)?$/i, /\/responses(?:\?.*)?$/i, /\/messages(?:\?.*)?$/i, /\/rerank(?:\?.*)?$/i]
  let matched = false
  for (const suffix of suffixes) {
    if (suffix.test(url)) {
      modelsUrl = url.replace(suffix, "/models")
      matched = true
      break
    }
  }
  if (!matched) {
    modelsUrl = `${url.replace(/\/+$/, "")}/models`
  }

  const headers = config.provider === "custom"
    ? withCustomOriginHeader(providerConfig.headers, modelsUrl!)
    : providerConfig.headers
  const { "Content-Type": _ct, ...cleanHeaders } = headers
  return { url: modelsUrl!, headers: cleanHeaders }
}

/** Fetch models from a URL, with a 403 compatibility retry. */
async function fetchModelsFromUrl(url: string, headers: Record<string, string>, _currentModel: string): Promise<LlmModelListResult> {
  const httpFetch = await getHttpFetch()
  let response = await httpFetch(url, { method: "GET", headers })
  let original403Text: string | null = null

  if (response.status === 403) {
    original403Text = await response.text().catch(() => "")
    try {
      response = await httpFetch(url, {
        method: "GET",
        headers: { ...headers, ...COMPAT_HEADERS },
      })
      original403Text = null
    } catch {
      throw new Error(`模型列表拉取失败：HTTP 403${original403Text ? ` ${original403Text.slice(0, 200)}` : ""}`)
    }
  }

  if (!response.ok) {
    const text = original403Text ?? await response.text().catch(() => "")
    throw new Error(`模型列表拉取失败：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`)
  }

  return toResult(parseModelList(await response.json()))
}

/** Fetch models for a local CLI provider (claude-code / codex-cli). */
async function fetchLocalCliModels(config: LlmConfig): Promise<LlmModelListResult> {
  const explicit = config.model.trim()
  if (explicit) return { models: [explicit] }

  const detect = await detectLocalCliConfig(config.provider)
  const localModel = detect?.model?.trim() ?? ""
  if (!localModel) {
    throw new Error("当前本地 CLI 未配置默认模型，请先在本地 CLI 中设置模型，或在软件里手动填写模型。")
  }
  return { models: [localModel] }
}

/**
 * Fetch the available LLM model list for the given configuration.
 * Handles provider-specific URL construction and Google model name prefix stripping.
 */
export async function fetchLlmModelList(config: LlmConfig): Promise<LlmModelListResult> {
  if (config.provider === "claude-code" || config.provider === "codex-cli") {
    return fetchLocalCliModels(config)
  }

  const { url, headers } = buildModelsRequest(config)
  const result = await fetchModelsFromUrl(url, headers, config.model)
  if (config.provider === "google") {
    return toResult(result.models.map((m) => m.replace(/^models\//, "")))
  }
  return result
}

/**
 * Fetch the available embedding model list for the given configuration.
 */
export async function fetchEmbeddingModelList(config: EmbeddingConfig): Promise<LlmModelListResult> {
  const url = buildEndpointModelsUrl(config.endpoint)
  const isGoogle = url.includes("generativelanguage.googleapis.com")
  const headers: Record<string, string> = {}

  if (config.apiKey.trim()) {
    if (isGoogle) {
      headers["x-goog-api-key"] = config.apiKey.trim()
    } else {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`
    }
  }

  const result = await fetchModelsFromUrl(url, headers, config.model)
  if (isGoogle) {
    return toResult(result.models.map((m) => m.replace(/^models\//, "")))
  }
  return result
}

/**
 * Fetch the available rerank model list. Delegates to the main LLM
 * model list when `useMainLlm` is true, or fetches independently.
 */
export async function fetchRerankModelList(
  llmConfig: LlmConfig,
  rerankConfig: RerankConfig,
): Promise<LlmModelListResult> {
  if (rerankConfig.useMainLlm) {
    return fetchLlmModelList(llmConfig)
  }

  if (isDirectRerankEndpoint({ provider: rerankConfig.provider, customEndpoint: rerankConfig.customEndpoint })) {
    return fetchModelsFromUrl(
      buildEndpointModelsUrl(rerankConfig.customEndpoint),
      rerankConfig.apiKey.trim() ? { Authorization: `Bearer ${rerankConfig.apiKey.trim()}` } : {},
      rerankConfig.model,
    )
  }

  return fetchLlmModelList({
    provider: rerankConfig.provider,
    apiKey: rerankConfig.apiKey,
    model: rerankConfig.model,
    ollamaUrl: rerankConfig.ollamaUrl,
    customEndpoint: rerankConfig.customEndpoint,
    apiMode: rerankConfig.provider === "custom" ? rerankConfig.apiMode : undefined,
    maxContextSize: Math.min(llmConfig.maxContextSize ?? 65_536, 65_536),
    reasoning: { mode: "off" },
  })
}
