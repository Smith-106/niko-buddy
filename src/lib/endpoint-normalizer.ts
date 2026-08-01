/**
 * Clean up user-entered LLM endpoint URLs.
 *
 * Catches two common mistakes:
 *   1. Pasting the full request path (e.g. `…/v1/chat/completions`) —
 *      the dispatch layer appends the request path again, producing a 404.
 *   2. Omitting the version segment (e.g. `https://host.com` with no `/v1`).
 *      We flag it as a hint but never block saving.
 *
 * Auto-fixes are deterministic; warnings explain what changed.
 *
 * MIT License — independently implemented.
 */

export type EndpointMode = "chat_completions" | "responses" | "anthropic_messages" | "azure"

export interface NormalizedEndpoint {
  /** The cleaned-up URL to store. Empty string for empty input. */
  normalized: string
  /** True if normalization changed the input (show a "will use" hint). */
  changed: boolean
  /** Human-readable hint / warning. Undefined when the input is fine. */
  warning?: string
}

/**
 * Path tails that are always wrong as a base URL — they belong on the
 * request, not on the configured endpoint.
 */
const REQUEST_PATH_TAILS = /\/+(chat\/completions|responses|embeddings)\/?$/i

/**
 * `/messages` is ambiguous: in anthropic_messages mode the dispatch
 * uses it verbatim, so we must preserve it. Only strip in
 * chat_completions mode.
 */
const MESSAGES_PATH_TAIL = /\/+messages\/?$/i

import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"

/**
 * Normalize a raw endpoint URL entered by the user.
 *
 * @param raw   The user-entered URL (may include trailing paths/slashes).
 * @param mode  The API mode that determines which tails to strip.
 * @returns     Cleaned URL with change flag and optional warning.
 */
export function normalizeEndpoint(raw: string, mode: EndpointMode): NormalizedEndpoint {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { normalized: "", changed: false }

  // Flag missing protocol — never auto-prepend https://.
  if (!/^https?:\/\//i.test(trimmed)) {
    const stripped = trimmed.replace(/\/+$/, "")
    return {
      normalized: stripped,
      changed: stripped !== trimmed,
      warning: "接口地址需要以 http:// 或 https:// 开头。",
    }
  }

  let url = trimmed
  const notes: string[] = []

  // Validate the URL can be parsed at all.
  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    const stripped = trimmed.replace(/\/+$/, "")
    return {
      normalized: stripped,
      changed: stripped !== trimmed,
      warning: "接口地址格式不正确，请检查域名、端口或路径是否填写错误。",
    }
  }

  // Catch IPv4-shaped hostnames with invalid octet counts/ranges.
  const host = parsed.hostname
  if (/^\d+(?:\.\d+)+$/.test(host)) {
    const octets = host.split(".")
    const validIpv4 =
      octets.length === 4 &&
      octets.every((o) => {
        const n = Number(o)
        return Number.isInteger(n) && n >= 0 && n <= 255
      })
    if (!validIpv4) {
      notes.push(
        `主机地址 "${host}" 看起来像 IPv4，但包含 ${octets.length} 段；正确 IPv4 应为 4 段，且每段在 0-255 之间。`,
      )
    }
  }

  // Strip trailing slashes (always safe).
  url = url.replace(/\/+$/, "")

  // Azure mode: keep deployment paths but strip request suffixes.
  if (mode === "azure" || isAzureOpenAiEndpoint(url)) {
    try {
      const u = new URL(url)
      let pathname = u.pathname.replace(/\/+$/, "")
      if (/\/chat\/completions\/?$/i.test(pathname)) {
        pathname = pathname.replace(/\/chat\/completions\/?$/i, "")
        notes.push("已移除末尾的 chat/completions；Azure 请求时会自动添加。")
      }
      url = `${u.origin}${pathname}`
      if (u.search) notes.push("已移除查询参数；api-version 会使用单独的设置。")
    } catch {
      if (/\/chat\/completions\/?($|\?)/i.test(url)) {
        url = url.replace(/\/chat\/completions\/?(?=$|\?)/i, "")
        notes.push("已移除末尾的 chat/completions；Azure 请求时会自动添加。")
      }
    }
    return {
      normalized: url,
      changed: url !== trimmed,
      warning: notes.length ? notes.join(" ") : undefined,
    }
  }

  // Strip request-path tails users commonly paste by accident.
  if (REQUEST_PATH_TAILS.test(url)) {
    const match = url.match(REQUEST_PATH_TAILS)
    url = url.replace(REQUEST_PATH_TAILS, "")
    if (match) notes.push(`已移除末尾的 "${match[0].replace(/^\/+/, "").replace(/\/+$/, "")}"；这部分会在请求时自动追加，不需要写在基础地址里。`)
  } else if (mode === "chat_completions" && MESSAGES_PATH_TAIL.test(url)) {
    const match = url.match(MESSAGES_PATH_TAIL)
    url = url.replace(MESSAGES_PATH_TAIL, "")
    if (match) notes.push(`已移除末尾的 "${match[0].replace(/^\/+/, "").replace(/\/+$/, "")}"；这是 Anthropic 兼容路径，不是 OpenAI 兼容基础地址。`)
  }

  // Flag missing version segment for OpenAI-compatible modes.
  if (mode === "chat_completions" || mode === "responses") {
    try {
      const u = new URL(url)
      const pathname = u.pathname.replace(/\/+$/, "")
      const hasVersion = /\/(v\d+|paas\/v\d+|openai\/v\d+|api\/v\d+)$/i.test(pathname)
      if (!hasVersion && !notes.length) {
        notes.push("接口地址缺少版本路径，例如 /v1。请根据服务商文档确认正确的接口地址。")
      }
    } catch {
      // Malformed — leave as-is, fetch will fail at request time.
    }
  }

  const changed = url !== trimmed
  return {
    normalized: url,
    changed,
    warning: notes.length ? notes.join(" ") : undefined,
  }
}
