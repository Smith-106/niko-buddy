/**
 * Generic HTTP endpoint reachability probe with a short-TTL cache.
 *
 * Used to (a) gate network-error retries — a confirmed-unreachable endpoint
 * fails immediately instead of burning through the retry ladder — and
 * (b) power fast diagnostics (e.g. pre-flight checks before full connection
 * tests).
 *
 * Any HTTP response (including 401/403/404) proves the host is reachable;
 * only transport-level failures (connection refused / DNS / deadline) mean
 * "unreachable". The probe reuses getHttpFetch() so it travels the exact
 * same Tauri plugin-http + proxy path as real LLM traffic.
 *
 * MIT License — independently implemented.
 */

import { getHttpFetch } from "./tauri-fetch"

export interface EndpointProbeOptions {
  /** Overall deadline for the probe request. Default 8s. */
  timeoutMs?: number
  /** Connection-establishment timeout passed to the transport (plugin-http). Default 4s. */
  connectTimeoutMs?: number
}

export interface EndpointProbeResult {
  reachable: boolean
  /** HTTP status when a response arrived (any status ⇒ reachable). */
  status?: number
  latencyMs: number
  /** Why the probe failed: transport-level error vs overall deadline abort. */
  errorKind?: "network" | "deadline"
}

export const DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS = 8_000
export const DEFAULT_ENDPOINT_PROBE_CONNECT_TIMEOUT_MS = 4_000

/** Probe results stay fresh for 5 minutes (keyed by probe URL + proxy state). */
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000

interface ProbeCacheEntry {
  result: EndpointProbeResult
  expiresAt: number
}

const probeCache = new Map<string, ProbeCacheEntry>()
const inFlightProbes = new Map<string, Promise<EndpointProbeResult>>()

/** Test helper: drop all cached probe results and in-flight dedupe entries. */
export function clearEndpointProbeCacheForTests(): void {
  probeCache.clear()
  inFlightProbes.clear()
}

/**
 * Derive the `GET /models` probe URL from a chat-request URL
 * (e.g. `https://host/v1/chat/completions` → `https://host/v1/models`).
 * Returns null when the input is not a usable http(s) URL.
 */
export function deriveProbeUrl(requestUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
  let path = parsed.pathname.replace(/\/+$/, "")
  path = path.replace(/\/+(chat\/completions|responses|messages|embeddings|completions)$/i, "")
  if (/\/models$/i.test(path)) return `${parsed.origin}${path}`
  return `${parsed.origin}${path}/models`
}

/**
 * Best-effort proxy fingerprint for the cache key: probes must be
 * re-evaluated when the outbound proxy changes, since reachability is
 * proxy-dependent. Reads the live wiki store dynamically to avoid
 * load-order import cycles; falls back to "direct" when unavailable.
 */
async function resolveProxyState(): Promise<string> {
  try {
    const mod = (await import("@/stores/wiki-store")) as {
      useWikiStore?: { getState?: () => { proxyConfig?: { enabled?: boolean; url?: string } } }
    }
    const proxy = mod.useWikiStore?.getState?.().proxyConfig
    if (proxy?.enabled && proxy.url) return `proxy:${proxy.url}`
  } catch {
    // Store unavailable (tests / non-app runtime) — treat as direct.
  }
  return "direct"
}

async function performProbe(
  probeUrl: string,
  cacheKey: string,
  timeoutMs: number,
  connectTimeoutMs: number,
): Promise<EndpointProbeResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const httpFetch = await getHttpFetch()
    // Any HTTP status (401/403/404 included) proves network reachability.
    const response = await httpFetch(probeUrl, {
      method: "GET",
      signal: controller.signal,
      connectTimeout: connectTimeoutMs,
    } as RequestInit)
    const result: EndpointProbeResult = {
      reachable: true,
      status: response.status,
      latencyMs: Date.now() - startedAt,
    }
    probeCache.set(cacheKey, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS })
    return result
  } catch {
    const result: EndpointProbeResult = {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      errorKind: controller.signal.aborted ? "deadline" : "network",
    }
    probeCache.set(cacheKey, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS })
    return result
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/**
 * Probe whether an OpenAI/Anthropic-compatible HTTP endpoint is reachable.
 * Results are cached for 5 minutes per (URL, proxy state); concurrent calls
 * for the same key share one in-flight request. Never throws.
 */
export async function probeEndpointReachability(
  requestUrl: string,
  opts?: EndpointProbeOptions,
): Promise<EndpointProbeResult> {
  const probeUrl = deriveProbeUrl(requestUrl)
  if (!probeUrl) {
    return { reachable: false, latencyMs: 0, errorKind: "network" }
  }
  const proxyState = await resolveProxyState()
  const cacheKey = `${probeUrl}|${proxyState}`
  const cached = probeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result }
  const inFlight = inFlightProbes.get(cacheKey)
  if (inFlight) return inFlight
  const probe = performProbe(
    probeUrl,
    cacheKey,
    opts?.timeoutMs ?? DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS,
    opts?.connectTimeoutMs ?? DEFAULT_ENDPOINT_PROBE_CONNECT_TIMEOUT_MS,
  )
  inFlightProbes.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    inFlightProbes.delete(cacheKey)
  }
}
