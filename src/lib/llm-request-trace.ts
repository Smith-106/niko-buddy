import { estimateChatMessagesTokens } from "@/lib/chat-request-budget"
import { sha256Text } from "@/lib/context-hub/fingerprint"
import type { ChatMessage, RequestOverrides } from "@/lib/llm-providers"
import type { LlmUsage } from "@/lib/llm-usage"
import type { LlmConfig } from "@/stores/wiki-store"

export const MAX_LLM_REQUEST_CACHE_TRACES = 32
const LLM_REQUEST_TRACE_PROVIDERS = new Set<LlmConfig["provider"]>([
  "openai",
  "anthropic",
  "google",
  "azure",
  "ollama",
  "custom",
  "minimax",
  "claude-code",
  "codex-cli",
  "cursor-cli",
])

export type LlmRequestTraceStatus = "success" | "error" | "cancelled" | "network_error"

/**
 * G4b: 稳定前缀（TASK-005 的 stable-prefix.ts）落到 trace 的三个既有占位值。
 *
 * 由 `buildStablePrefixTraceFields(prefix)`（异步哈希）产出 fingerprint/tokens，
 * 版本号取 `prefix.version`。装配点（chat-panel-context-assembly）把这三个值
 * 一并交给 `buildLlmRequestCacheTrace`，于是命中统计能按「前缀版本」分组：
 * 版本没 bump 却出现指纹抖动 = 有动态内容漏进了缓存段（R4 的直接症状）。
 */
export interface LlmStablePrefixTraceInput {
  /** stable-prefix.ts 的 STABLE_PREFIX_VERSION。 */
  version: number
  /** 版本 + 稳定字段的 SHA-256（64 hex）。 */
  prefixFingerprint: string
  /** 稳定段的 token 估算。 */
  prefixEstimatedTokens: number
}

export interface LlmRequestCacheTrace {
  provider: LlmConfig["provider"]
  model: string
  apiMode: string
  prefixFingerprint?: string
  prefixEstimatedTokens?: number
  /** G4b: 稳定前缀版本（TASK-005 占位）。版本已折进指纹，这里显式落盘便于按版本统计。 */
  stablePrefixVersion?: number
  /**
   * G4b: 本次请求是否命中前缀缓存（上游回了 cachedInputTokens > 0）。
   * 只有拿到 usage 时才有值；请求失败（无 usage）时留空，避免把「未知」记成「未命中」。
   */
  cacheHit?: boolean
  /**
   * G4b: 命中缓存节省的全价输入 token 数（= cacheReadTokens）。
   * 这些 token 按缓存读价计费（Anthropic 约为输入价的 1/10），所以它们不再
   * 以全价计入成本 —— 命中率 harness 用它折算节省量，不另造数字。
   */
  savedTokens?: number
  startedAt: number
  finishedAt: number
  durationMs: number
  firstResponseMs?: number
  startGapMs?: number
  idleGapMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  status: LlmRequestTraceStatus
}

function resolveLlmRequestApiMode(config: LlmConfig): string {
  if (config.provider === "custom") return config.apiMode ?? "chat_completions"
  if (config.provider === "anthropic" || config.provider === "minimax") return "anthropic_messages"
  if (config.provider === "google") return "gemini_generate_content"
  if (config.provider === "azure") return "azure_chat_completions"
  if (config.provider === "claude-code") return "claude_code_cli"
  if (config.provider === "codex-cli") return "codex_cli"
  return "chat_completions"
}

interface LlmRequestTraceSnapshot {
  requests: LlmRequestCacheTrace[]
  omittedRequestCount: number
}

function textBlocksThroughLastBreakpoint(messages: ChatMessage[]): ChatMessage[] | null {
  let lastMessageIndex = -1
  let lastBlockIndex = -1
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === "text" && block.cacheControl) {
        lastMessageIndex = messageIndex
        lastBlockIndex = blockIndex
      }
    }
  }
  if (lastMessageIndex < 0) return null

  return messages.slice(0, lastMessageIndex + 1).map((message, messageIndex) => {
    if (messageIndex !== lastMessageIndex || !Array.isArray(message.content)) {
      return message
    }
    return {
      ...message,
      content: message.content.slice(0, lastBlockIndex + 1),
    }
  })
}

function canonicalMessage(message: ChatMessage): unknown {
  return {
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text, cacheControl: Boolean(block.cacheControl) }
        : { type: "image", mediaType: block.mediaType, dataBase64: block.dataBase64 }),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
  }
}

/**
 * 请求消息的规范化字节序列（与 `buildLlmRequestPrefixDescriptor` 内部同源）。
 *
 * 命中率 harness 直接拿它做「上一轮请求 vs 本轮请求」的**字节级**最长公共前缀
 * 比较 —— 上游前缀缓存（OpenAI 隐式 / Anthropic 显式 ephemeral）认的就是字节，
 * 不是「语义相同」，所以不能用「消息条数相同」之类的近似。
 */
export function serializeLlmRequestPayload(messages: ChatMessage[]): string {
  return JSON.stringify(messages.map(canonicalMessage))
}

export async function buildLlmRequestPrefixDescriptor(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Promise<{ prefixFingerprint?: string; prefixEstimatedTokens?: number }> {
  const prefixMessages = textBlocksThroughLastBreakpoint(messages)
  if (!prefixMessages) return {}

  const canonical = JSON.stringify({
    provider: config.provider,
    model: config.model,
    apiMode: resolveLlmRequestApiMode(config),
    tools: overrides?.tools ?? [],
    toolChoice: overrides?.toolChoice,
    reasoning: overrides?.reasoning ?? config.reasoning ?? { mode: "auto" },
    messages: prefixMessages.map(canonicalMessage),
  })
  return {
    prefixFingerprint: await sha256Text(canonical),
    prefixEstimatedTokens: estimateChatMessagesTokens(prefixMessages),
  }
}

export function buildLlmRequestCacheTrace(input: {
  config: LlmConfig
  prefixFingerprint?: string
  prefixEstimatedTokens?: number
  /** G4b: TASK-005 稳定前缀占位（版本 + 哈希 + token 估算）。 */
  stablePrefix?: LlmStablePrefixTraceInput
  startedAt: number
  finishedAt: number
  firstResponseAt?: number
  usage?: LlmUsage
  status: LlmRequestTraceStatus
}): LlmRequestCacheTrace {
  // 稳定前缀占位优先用显式传入的 fingerprint/tokens（装配点自己算过就用自己的），
  // 否则回落到 stablePrefix 里的同名值 —— 两条路径写的是同一组字段，不产生双轨。
  const prefixFingerprint = input.prefixFingerprint ?? input.stablePrefix?.prefixFingerprint
  const prefixEstimatedTokens = input.prefixEstimatedTokens
    ?? input.stablePrefix?.prefixEstimatedTokens
  const cachedInputTokens = input.usage?.cachedInputTokens
  return {
    provider: input.config.provider,
    model: input.config.model,
    apiMode: resolveLlmRequestApiMode(input.config),
    ...(prefixFingerprint ? { prefixFingerprint } : {}),
    ...(prefixEstimatedTokens !== undefined ? { prefixEstimatedTokens } : {}),
    ...(input.stablePrefix ? { stablePrefixVersion: input.stablePrefix.version } : {}),
    ...(cachedInputTokens !== undefined
      ? { cacheHit: cachedInputTokens > 0, savedTokens: cachedInputTokens }
      : {}),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    ...(input.firstResponseAt !== undefined
      ? { firstResponseMs: Math.max(0, input.firstResponseAt - input.startedAt) }
      : {}),
    ...(input.usage?.inputTokens !== undefined ? { inputTokens: input.usage.inputTokens } : {}),
    ...(input.usage?.outputTokens !== undefined ? { outputTokens: input.usage.outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cacheReadTokens: cachedInputTokens } : {}),
    ...(input.usage?.cacheWriteInputTokens !== undefined
      ? { cacheWriteTokens: input.usage.cacheWriteInputTokens }
      : {}),
    status: input.status,
  }
}

function requestKey(trace: LlmRequestCacheTrace): string | null {
  if (!trace.prefixFingerprint) return null
  return [trace.provider, trace.model, trace.apiMode, trace.prefixFingerprint].join("\u0000")
}

export class LlmRequestTraceCollector {
  private traces: LlmRequestCacheTrace[] = []
  private omitted = 0

  /**
   * 记录一次请求，返回带 startGapMs / idleGapMs 的那条。
   *
   * 返回而不是让调用方事后 snapshot() 回读：gap 依赖「同前缀的上一次请求」，
   * 只有 collector 内部知道。旧写法要求调用方 record → snapshot → 反查刚写入
   * 的那条（按 startedAt 匹配，同毫秒并发会取错），既 O(n) 又依赖顺序。
   */
  record = (trace: LlmRequestCacheTrace): LlmRequestCacheTrace => {
    const previous = this.findPreviousByKey(trace)
    const stored = copyLlmRequestCacheTrace(trace)
    if (previous) {
      stored.startGapMs = Math.max(0, trace.startedAt - previous.startedAt)
      stored.idleGapMs = Math.max(0, trace.startedAt - previous.finishedAt)
    }
    this.traces.push(stored)
    this.traces.sort((left, right) => left.startedAt - right.startedAt)
    if (this.traces.length > MAX_LLM_REQUEST_CACHE_TRACES) {
      const overflow = this.traces.length - MAX_LLM_REQUEST_CACHE_TRACES
      this.traces.splice(0, overflow)
      this.omitted += overflow
    }
    return copyLlmRequestCacheTrace(stored)
  }

  /**
   * 同前缀且 startedAt 严格更早的最后一条。
   *
   * 必须按 startedAt 比较而非「缓冲里的最后一条」：并发请求可能乱序完成，
   * 后完成的请求 startedAt 反而更早，直接用队尾会把 gap 算成 0。
   */
  private findPreviousByKey(trace: LlmRequestCacheTrace): LlmRequestCacheTrace | undefined {
    const key = requestKey(trace)
    if (!key) return undefined
    let best: LlmRequestCacheTrace | undefined
    for (const candidate of this.traces) {
      if (candidate.startedAt > trace.startedAt) continue
      if (requestKey(candidate) !== key) continue
      if (!best || candidate.startedAt > best.startedAt) best = candidate
    }
    return best
  }

  /** 纯读：gap 已在 record 时写入，这里不再就地修改。 */
  snapshot(): LlmRequestTraceSnapshot {
    return {
      requests: this.traces.map((trace) => copyLlmRequestCacheTrace(trace)),
      omittedRequestCount: this.omitted,
    }
  }

  /** 清空缓冲。测试隔离用：模块级单例会让前一个用例的 trace 污染后一个。 */
  reset(): void {
    this.traces = []
    this.omitted = 0
  }
}

export function copyLlmRequestCacheTrace(trace: LlmRequestCacheTrace): LlmRequestCacheTrace {
  return {
    provider: trace.provider,
    model: trace.model,
    apiMode: trace.apiMode,
    ...(trace.prefixFingerprint !== undefined ? { prefixFingerprint: trace.prefixFingerprint } : {}),
    ...(trace.prefixEstimatedTokens !== undefined ? { prefixEstimatedTokens: trace.prefixEstimatedTokens } : {}),
    ...(trace.stablePrefixVersion !== undefined ? { stablePrefixVersion: trace.stablePrefixVersion } : {}),
    ...(trace.cacheHit !== undefined ? { cacheHit: trace.cacheHit } : {}),
    ...(trace.savedTokens !== undefined ? { savedTokens: trace.savedTokens } : {}),
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    durationMs: trace.durationMs,
    ...(trace.firstResponseMs !== undefined ? { firstResponseMs: trace.firstResponseMs } : {}),
    ...(trace.startGapMs !== undefined ? { startGapMs: trace.startGapMs } : {}),
    ...(trace.idleGapMs !== undefined ? { idleGapMs: trace.idleGapMs } : {}),
    ...(trace.inputTokens !== undefined ? { inputTokens: trace.inputTokens } : {}),
    ...(trace.outputTokens !== undefined ? { outputTokens: trace.outputTokens } : {}),
    ...(trace.cacheReadTokens !== undefined ? { cacheReadTokens: trace.cacheReadTokens } : {}),
    ...(trace.cacheWriteTokens !== undefined ? { cacheWriteTokens: trace.cacheWriteTokens } : {}),
    status: trace.status,
  }
}

export function isLlmRequestCacheTrace(value: unknown): value is LlmRequestCacheTrace {
  if (!value || typeof value !== "object") return false
  const source = value as Record<string, unknown>
  const optionalNumber = (key: string) => source[key] === undefined
    || (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0)
  return typeof source.provider === "string"
    && LLM_REQUEST_TRACE_PROVIDERS.has(source.provider as LlmConfig["provider"])
    && typeof source.model === "string"
    && typeof source.apiMode === "string"
    && source.apiMode.length > 0
    && (source.prefixFingerprint === undefined
      || (typeof source.prefixFingerprint === "string" && /^[a-f0-9]{64}$/.test(source.prefixFingerprint)))
    && typeof source.startedAt === "number"
    && Number.isFinite(source.startedAt)
    && source.startedAt >= 0
    && typeof source.finishedAt === "number"
    && Number.isFinite(source.finishedAt)
    && source.finishedAt >= source.startedAt
    && typeof source.durationMs === "number"
    && Number.isFinite(source.durationMs)
    && source.durationMs >= 0
    && optionalNumber("prefixEstimatedTokens")
    && optionalNumber("stablePrefixVersion")
    && optionalNumber("savedTokens")
    && (source.cacheHit === undefined || typeof source.cacheHit === "boolean")
    && optionalNumber("firstResponseMs")
    && optionalNumber("startGapMs")
    && optionalNumber("idleGapMs")
    && optionalNumber("inputTokens")
    && optionalNumber("outputTokens")
    && optionalNumber("cacheReadTokens")
    && optionalNumber("cacheWriteTokens")
    && (source.status === "success"
      || source.status === "error"
      || source.status === "cancelled"
      || source.status === "network_error")
}

/** G4b: 命中统计的汇总口径（单一口径，harness 与界面共用）。 */
export interface LlmCacheHitStats {
  /** 有命中判定的请求数（拿到 usage 的那些）。 */
  requests: number
  hits: number
  misses: number
  /** hits / requests × 100（requests = 0 时为 0）。 */
  hitRatePct: number
  /** 全部请求的输入 token 之和（含未命中请求）。 */
  inputTokens: number
  /** 命中缓存被复用的输入 token 之和。 */
  cachedInputTokens: number
  /** 命中缓存节省的全价输入 token（= cachedInputTokens）。 */
  savedTokens: number
  /** savedTokens / inputTokens × 100。 */
  savedInputPct: number
}

function emptyCacheHitStats(): LlmCacheHitStats {
  return {
    requests: 0,
    hits: 0,
    misses: 0,
    hitRatePct: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    savedTokens: 0,
    savedInputPct: 0,
  }
}

function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return (part / whole) * 100
}

/**
 * 把一串 trace 汇总成命中统计。
 *
 * 只统计**有命中判定**的请求（cacheHit !== undefined）：失败的请求没有 usage，
 * 把它们算成「未命中」会把命中率压低成一个假数字 —— 那是采样缺失，不是缓存失效。
 */
export function summarizeLlmCacheHits(traces: LlmRequestCacheTrace[]): LlmCacheHitStats {
  const stats = emptyCacheHitStats()
  for (const trace of traces) {
    stats.inputTokens += trace.inputTokens ?? 0
    if (trace.cacheHit === undefined) continue
    stats.requests += 1
    if (trace.cacheHit) stats.hits += 1
    else stats.misses += 1
    const cached = trace.savedTokens ?? trace.cacheReadTokens ?? 0
    stats.cachedInputTokens += cached
    stats.savedTokens += cached
  }
  stats.hitRatePct = percent(stats.hits, stats.requests)
  stats.savedInputPct = percent(stats.savedTokens, stats.inputTokens)
  return stats
}

/** 按 provider 分组汇总（同一前缀在不同通道的命中语义不同，不能混算）。 */
export function summarizeLlmCacheHitsByProvider(
  traces: LlmRequestCacheTrace[],
): Record<string, LlmCacheHitStats> {
  const grouped: Record<string, LlmRequestCacheTrace[]> = {}
  for (const trace of traces) {
    const bucket = (grouped[trace.provider] ??= [])
    bucket.push(trace)
  }
  const result: Record<string, LlmCacheHitStats> = {}
  for (const [provider, providerTraces] of Object.entries(grouped)) {
    result[provider] = summarizeLlmCacheHits(providerTraces)
  }
  return result
}
