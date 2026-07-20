import type { LlmConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"
import { getProviderConfig, type RequestOverrides } from "./llm-providers"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"
import { resolveRuntimeLocalCliConfig } from "./local-cli-config"
import { trimChatMessagesToBudget } from "./chat-request-budget"
import { resolveProviderOverride } from "@/components/settings/preset-resolver"

export type { ChatMessage, RequestOverrides } from "./llm-providers"
export { isFetchNetworkError } from "./tauri-fetch"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onReasoningToken?: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

/**
 * ISS-20260709-020: LLM call metrics collection.
 *
 * Buffers one metric record per LLM call in memory; flushMetrics() persists
 * the buffer to .novel/metrics.jsonl via read-modify-write_atomic (desktop
 * single-user ⇒ no concurrent writers). This is derived observability —
 * NOT a second truth source (status.json remains the only runtime session
 * truth). Enables post-hoc diagnosis of slow/failed model patterns ("which
 * model times out most?", "is the failure rate spiking?") without re-running.
 *
 * collectLLMMetric is synchronous (pushes to an in-memory array) so it is
 * safe to call from streamChat's finally block. flushMetrics is async
 * (Tauri IPC invoke) and called at run-end by the orchestrator.
 *
 * PAT-DC1 (CWE-532): errorKind is a short classification string
 * ("abort" | "timeout" | "network" | "http" | "parse" | "unknown"), NEVER the
 * raw error message — provider request details must not reach the metrics
 * file. Tokens are not collected here (streamChat does not hold a token
 * count; add a separate projection if token accounting is needed later).
 */
export interface LlmMetric {
  ts: string
  model: string
  provider: string
  durationMs: number
  success: boolean
  errorKind?: string
  traceId?: string
  /**
   * ISS-20260719-002: token accounting for option-A upgrade decision data.
   * Optional — undefined when the provider's transport does not surface
   * usage (e.g. CLI subprocess transports, or HTTP providers whose SSE
   * stream omits usage). When present, lets a future plan session compute
   * "what fraction of total LLM tokens did the 6-dim continuity dimension
   * consume" — the missing input to the priorReviewResults short-circuit
   * (option A vs B) tradeoff. Cross-referenced with runFullReviewWithSixDim's
   * continuity-repeat warn (deep-chapter-generation.ts:898-913) by run
   * timestamp, not by an inline dimension label (streamChat is the generic
   * entry point; dimension tagging would touch 31 call sites).
   */
  inputTokens?: number
  outputTokens?: number
}

let metricsFilePath = ""
let metricsTraceId = ""
const metricsBuffer: LlmMetric[] = []

/** Configure the metrics sink (.novel/metrics.jsonl). Call once at run start. */
export function setMetricsFilePath(path: string): void {
  metricsFilePath = path
}

/** Set the trace-id stamped on every subsequent LLM metric (e.g. run id). */
export function setMetricsTraceId(id: string): void {
  metricsTraceId = id
}

/**
 * Classify an error for the metric record (short string, no PII).
 * Mirrors the branches streamChat's error paths already distinguish.
 */
function classifyLlmError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "abort"
    const msg = err.message
    if (/timed out|timeout/i.test(msg)) return "timeout"
    if (/网络连接|Connection lost|connection/i.test(msg)) return "network"
    if (/HTTP \d{3}/.test(msg)) return "http"
    if (/JSON|parse|解析/i.test(msg)) return "parse"
  }
  return "unknown"
}

/**
 * Buffer a metric record (synchronous — safe from finally blocks).
 * No-op effect beyond buffering until flushMetrics() is called.
 */
export function collectLLMMetric(metric: LlmMetric): void {
  metricsBuffer.push({ ...metric, traceId: metric.traceId ?? metricsTraceId })
  // Auto-flush safety valve: if the buffer grows large without an explicit
  // flushMetrics() call from the run lifecycle (e.g. a long session where the
  // orchestrator's finally hook was not wired), self-flush at 500 records so
  // metrics are not lost to unbounded memory growth. Fire-and-forget — the
  // caller (streamChat finally) never awaits this. A concurrent explicit
  // flushMetrics is safe: splice is atomic, the loser gets an empty buffer.
  if (metricsBuffer.length >= 500 && metricsFilePath) {
    void flushMetrics()
  }
}

/** Test-only: clear the in-memory metrics buffer. */
export function __clearMetricsBufferForTest(): void {
  metricsBuffer.length = 0
}

/**
 * Persist the buffered metrics to .novel/metrics.jsonl via read-modify-write
 * (atomic). Best-effort: a write failure is logged to console and swallowed
 * (metrics must never break the LLM call path). Returns the count flushed.
 */
export async function flushMetrics(): Promise<number> {
  if (!metricsFilePath || metricsBuffer.length === 0) return 0
  const toFlush = metricsBuffer.splice(0, metricsBuffer.length)
  try {
    // Read-modify-write: append buffer to existing metrics file. Single-user
    // desktop ⇒ no concurrent writers; atomic write guarantees no truncated
    // file on crash. Lazy-load fs to keep the invoke out of non-metrics paths.
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    let existing = ""
    try {
      existing = await readFile(metricsFilePath)
    } catch {
      // File does not exist yet — first metrics write for this project.
      existing = ""
    }
    const lines = toFlush.map(m => JSON.stringify(m)).join("\n")
    const next = existing ? existing.replace(/\n?$/, "\n") + lines + "\n" : lines + "\n"
    await writeFileAtomic(metricsFilePath, next)
    return toFlush.length
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[metrics] flush failed:", e instanceof Error ? e.message : String(e))
    // Re-buffer so a later flush can retry (cap to avoid unbounded growth).
    if (metricsBuffer.length < 1000) metricsBuffer.unshift(...toFlush)
    return 0
  }
}

/**
 * TASK-010: Deterministic continuity engine metrics collection.
 *
 * Mirrors the LlmMetric pattern (ISS-20260709-020): buffer in memory,
 * flushContinuityMetrics persists to a SEPARATE file
 * (.novel/continuity-metrics.jsonl) so the continuity engine's observability
 * stream does not pollute the LLM metrics stream (Decision 7.2 — independent
 * metric file). The continuity engine is a mechanical pre-check layer, not an
 * LLM call; its metrics are counts (findings by severity, overrides,
 * short-circuits, data gaps, engine errors) plus execution_ms and a gate
 * classification — no narrative content, no override bodies.
 *
 * PAT-DC1 (CWE-532): only counts + timing + gate enum are recorded. The
 * finding.ref / override text / chapter content never reach the metrics file.
 *
 * The engine + thin-wrapper integration (summarizeContinuityFindings helper
 * and the collectContinuityMetric call site in the wrapper layer) are owned by
 * TASK-007/TASK-008 agents; this file only owns the metric definition +
 * buffer + flush infrastructure, reusing the flushMetrics atomic
 * read-modify-write pattern verbatim.
 */
export interface ContinuityMetric {
  execution_ms: number
  critical_count: number
  high_count: number
  warning_count: number
  data_gap_count: number
  overrides_hit: number
  short_circuit_hits: number
  engine_error_count: number
  gate: "consistency" | "quality" | "anti_ai"
  timestamp: string
}

let continuityMetricsFilePath = ""
const continuityMetricBuffer: ContinuityMetric[] = []

/** Configure the continuity metrics sink (.novel/continuity-metrics.jsonl). */
export function setContinuityMetricsFilePath(path: string): void {
  continuityMetricsFilePath = path
}

/** Test-only: clear the in-memory continuity metrics buffer. */
export function __clearContinuityMetricsBufferForTest(): void {
  continuityMetricBuffer.length = 0
}

/**
 * Buffer a continuity metric record (synchronous — safe from the engine's
 * finally / warn path). No-op beyond buffering until flushContinuityMetrics.
 * Reuses the same auto-flush safety valve pattern as collectLLMMetric
 * (buffer>=500 → fire-and-forget flush) so a long session without an explicit
 * run-end flush does not lose metrics to unbounded memory growth.
 */
export function collectContinuityMetric(metric: ContinuityMetric): void {
  continuityMetricBuffer.push(metric)
  if (continuityMetricBuffer.length >= 500 && continuityMetricsFilePath) {
    void flushContinuityMetrics()
  }
}

/**
 * Persist buffered continuity metrics to .novel/continuity-metrics.jsonl via
 * read-modify-write (atomic). Reuses the flushMetrics pattern verbatim
 * (splice-then-write, lazy fs import, re-buffer on failure with cap). Best
 * effort: a write failure is logged and swallowed — continuity metrics must
 * never break the generation/review path. Returns the count flushed.
 *
 * CWE-22: continuityMetricsFilePath is set from a literal
 * `{projectPath}/.novel/continuity-metrics.jsonl` at run start (non-user-input
 * path, same form as setMetricsFilePath); no dynamic path components reach
 * this sink.
 */
export async function flushContinuityMetrics(): Promise<number> {
  if (!continuityMetricsFilePath || continuityMetricBuffer.length === 0) return 0
  const toFlush = continuityMetricBuffer.splice(0, continuityMetricBuffer.length)
  try {
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    let existing = ""
    try {
      existing = await readFile(continuityMetricsFilePath)
    } catch {
      existing = ""
    }
    const lines = toFlush.map(m => JSON.stringify(m)).join("\n")
    const next = existing ? existing.replace(/\n?$/, "\n") + lines + "\n" : lines + "\n"
    await writeFileAtomic(continuityMetricsFilePath, next)
    return toFlush.length
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[continuity-metrics] flush failed:",
      e instanceof Error ? e.message : String(e),
    )
    if (continuityMetricBuffer.length < 1000) continuityMetricBuffer.unshift(...toFlush)
    return 0
  }
}

// Lazy import keeps the Tauri event/invoke bindings out of bundles that
// never touch the subprocess provider (e.g. vitest with a fetch mock).
async function streamViaClaudeCodeCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./claude-cli-transport")
  return mod.streamClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
}

async function streamViaCodexCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./codex-cli-transport")
  return mod.streamCodexCli(config, messages, callbacks, signal, requestOverrides)
}

const NETWORK_RETRY_DELAYS_MS = [30_000, 60_000, 90_000, 120_000]
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Combine multiple AbortSignals (e.g. caller-supplied cancel signal + timeout)
 * so the combined signal aborts when ANY input aborts. Undefined inputs are
 * ignored. Returns undefined if no active signals remain.
 *
 * Mirrors the prior local helpers in deep-chapter-generation.ts and
 * scene-breakdown.ts (consolidated here to avoid PAT-G2 same-name duplication).
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const activeSignals = signals.filter(Boolean) as AbortSignal[]
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const s of activeSignals) {
    if (s.aborted) {
      controller.abort()
      break
    }
    s.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

/**
 * Strip a leading ```json / ``` fence if the model wrapped its output.
 * Returns the inner content (trimmed), or the original text if no fence.
 */
export function stripCodeFence(text: string): string {
  const fenceMatch = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/)
  return fenceMatch ? fenceMatch[1].trim() : text.trim()
}

/**
 * Extract the raw JSON array span (including the enclosing `[` ... `]`) from
 * LLM output that may prepend analysis prose. Uses a bracket-balancing scan
 * from the LAST `]` backward to find its matching `[` — greedily matching the
 * first `[` to the last `]` would swallow prose brackets. Falls back to a
 * greedy `[\s\S]*` match if balancing fails. Returns null if no balanced
 * span exists.
 *
 * Callers own JSON.parse + error routing (throw / null / []) — this helper
 * only isolates the span so the extraction logic is shared once. Consolidated
 * from three same-shape local helpers in review-adapter /
 * character-llm-recognizer / scene-breakdown (PAT-G2 same-name dedup,
 * odyssey-improve novel-mainchain 2026-07-12).
 */
export function extractJsonArraySpan(text: string): string | null {
  const cleaned = stripCodeFence(text)
  const end = cleaned.lastIndexOf("]")
  if (end === -1) return null
  let depth = 0
  for (let i = end; i >= 0; i -= 1) {
    const ch = cleaned[i]
    if (ch === "]") depth += 1
    else if (ch === "[") {
      depth -= 1
      if (depth === 0) return cleaned.slice(i, end + 1)
    }
  }
  // Fallback: balancing failed, try greedy match.
  const greedy = cleaned.match(/\[[\s\S]*\]/)
  return greedy ? greedy[0] : null
}

export function shouldRetryWithBrowserFetch(errorDetail: string): boolean {
  return /client not allowed/i.test(errorDetail) && /tauri-plugin-http/i.test(errorDetail)
}

/**
 * True for client-cancelled LLM requests (AbortError / "request cancelled").
 * Used by deep-chapter-generation + scene-breakdown partial-preserve paths to
 * distinguish user-intent cancel from transport failure (formerly twin-mirror
 * in both files, consolidated ISS-20260712-MAINT-3).
 */
export function isRequestCancelledError(error: Error): boolean {
  return /request cancelled|request canceled|aborted|aborterror/i.test(error.message)
}

/**
 * True for Claude Code CLI transport timeouts where the subprocess stayed
 * alive but stalled before/after producing output. These are recoverable when
 * partial content exists: a fresh subprocess on `continue-unfinished` can
 * complete the draft. Distinct from cancellation (client intent) and from
 * deterministic auth/config errors (retrying won't help).
 */
export function isTransportInactivityError(error: Error): boolean {
  return /produced no meaningful stream output within \d+ seconds|produced no additional stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|kept emitting progress heartbeats/i.test(
    error.message,
  )
}

/**
 * 占位 LLM 调用 fallback：实际项目里应调真实 LLM endpoint。
 * 抛错让回退逻辑生效。错误字符串 "defaultLlmCall not implemented in this context"
 * 被 character-extraction-engine.spec.ts 字面断言,迁移时保持字节不变。
 */
export async function defaultLlmCall(_prompt: string): Promise<string> {
  throw new Error("defaultLlmCall not implemented in this context")
}

function parseLines(chunk: Uint8Array, buffer: string, decoder: TextDecoder): [string[], string] {
  const text = buffer + decoder.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeoutId)
      resolve(false)
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function parseInputLengthLimit(errorDetail: string): { inputLength: number; maxLength: number } | null {
  const match = /input length\s*([\d,]+)\s*exceeds(?:\s+the)?\s+maximum length\s*([\d,]+)/i.exec(errorDetail)
    ?? /input length\s*([\d,]+)\s*exceeds(?:\s+the)?\s+max(?:imum)?\s*([\d,]+)/i.exec(errorDetail)
  if (!match) return null
  const inputLength = Number(match[1]?.replace(/,/g, ""))
  const maxLength = Number(match[2]?.replace(/,/g, ""))
  if (!Number.isFinite(inputLength) || !Number.isFinite(maxLength) || maxLength <= 0) return null
  return { inputLength, maxLength }
}

function inputLengthLimitMessage(limit: { inputLength: number; maxLength: number }): string {
  return `输入内容过长：本次请求约 ${limit.inputLength} 字符，接口最大允许 ${limit.maxLength} 字符。请减少历史上下文、缩短章节正文，或确认当前接口是否真的支持所选模型的上下文长度。`
}

export async function streamChat(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  /**
   * Wire-agnostic sampling knobs. The provider's buildBody() translates
   * these into its native schema — OpenAI-style wires accept them at
   * the top level ({temperature: 0.1}), Gemini nests them under
   * generationConfig with renamed keys ({generationConfig: {temperature: 0.1}}).
   * Previously we spread them onto the body here, which broke Gemini
   * with "Unknown name 'temperature': Cannot find field." HTTP 400.
   */
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const resolvedLocal = await resolveRuntimeLocalCliConfig(config)
  // ISS-20260709-020: per-call metrics. metricsStart stamps the entry;
  // metricsErrorKind is set by the wrapped onError (covers all error paths —
  // HTTP + CLI branches both funnel errors through callbacks.onError).
  // collectLLMMetric is called at every exit (2 CLI returns + the HTTP
  // finally) so no LLM call goes unrecorded. Synchronous buffer push — safe
  // from finally; flushMetrics() persists at run-end.
  const metricsStart = Date.now()
  let metricsErrorKind: string | undefined
  // ISS-20260719-002: accumulate token usage surfaced by the provider's SSE
  // stream (best-effort — stays 0 when the transport/lines carry no usage,
  // e.g. CLI subprocess path or providers that omit usage). Captured by the
  // closure below so every recordMetric exit (CLI returns + HTTP finally)
  // stamps the same accumulated counts. Anthropic splits input (message_start)
  // / output (message_delta) across two events; OpenAI surfaces both in the
  // final chunk; Google in the final usageMetadata. Last-write-wins per axis
  // within a single stream (each provider emits each axis at most once, so
  // accumulation == assignment in practice; we sum defensively regardless).
  let metricsInputTokens = 0
  let metricsOutputTokens = 0
  const recordMetric = () => {
    collectLLMMetric({
      ts: new Date().toISOString(),
      model: resolvedLocal.model,
      provider: resolvedLocal.provider,
      durationMs: Date.now() - metricsStart,
      success: metricsErrorKind === undefined,
      errorKind: metricsErrorKind,
      ...(metricsInputTokens > 0 || metricsOutputTokens > 0
        ? { inputTokens: metricsInputTokens, outputTokens: metricsOutputTokens }
        : {}),
    })
  }
  const { onToken, onDone } = callbacks
  const onError = (error: Error) => {
    metricsErrorKind = classifyLlmError(error)
    callbacks.onError(error)
  }
  const decoder = new TextDecoder()

  // F-004 (ANL-010 f004_correction): NEW routing logic. BS-003 framed this
  // as "zero new code"; verified INACCURATE — no default-routing existed
  // (preset.provider was 1:1). An API-key user on the `claude-code` default
  // (subprocess/OAuth) who did NOT explicitly select it is rerouted to the
  // sanctioned `anthropic` HTTP case (llm-providers.ts:709-720, REUSED
  // UNCHANGED) using their OWN apiKey. Explicit selection precedence is
  // preserved (resolveProviderOverride returns the provider unchanged when
  // `explicitProviderSelection === true`). This is also the SA-02 fallback
  // target hook point: TASK-001's SessionTransportFallback reroutes a
  // stalled CLI stream here on a 2nd stall. Boundary (ANL-009 NO-GO) intact:
  // no direct-API call, no OAuth-credential reuse.
  const effectiveProvider = resolveProviderOverride(resolvedLocal)
  const runtimeConfig: LlmConfig = effectiveProvider === resolvedLocal.provider
    ? resolvedLocal
    : { ...resolvedLocal, provider: effectiveProvider }

  // Claude Code CLI uses a subprocess transport (stdin/stdout), not
  // HTTP. Dispatch before getProviderConfig — that function throws for
  // this provider because it has no URL/headers.
  if (runtimeConfig.provider === "claude-code") {
    const wrappedCallbacks = { ...callbacks, onError }
    try {
      return await streamViaClaudeCodeCli(runtimeConfig, messages, wrappedCallbacks, signal, requestOverrides)
    } finally {
      recordMetric()
    }
  }

  if (runtimeConfig.provider === "codex-cli") {
    const wrappedCallbacks = { ...callbacks, onError }
    try {
      return await streamViaCodexCli(runtimeConfig, messages, wrappedCallbacks, signal, requestOverrides)
    } finally {
      recordMetric()
    }
  }

  const providerConfig = getProviderConfig(runtimeConfig)

  // Combined abort: (a) user cancel, (b) our long-horizon timeout.
  // The long timeout is a backstop for truly stuck requests; it's NOT
  // what fires when a user sees "Timeout" after 2 seconds — that is
  // almost always a fast network failure (DNS, TLS, 404, refused) that
  // WebKit surfaces as a generic "Load failed". We track whether the
  // backstop actually fired so we can tell the two apart in the error.
  const timeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS // 30 min — generous backstop for huge-context reasoning models
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false
  let onSignalAbort: (() => void) | undefined
  // ISS-004: hoisted to the outer scope so the `finally` block can clear it on
  // EVERY exit path (success return included). Previously the timer was only
  // cleared on the user-abort path (`onSignalAbort`), leaking one 30-min timer
  // per successful LLM request. clearTimeout is idempotent, so the abort path's
  // clear and the finally clear coexist safely.
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      onSignalAbort = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        timeoutController?.abort()
      }
      signal.addEventListener("abort", onSignalAbort)
    }
    combinedSignal = timeoutController.signal
  }

  try {
    const buildRequestInit = (nextMessages: import("./llm-providers").ChatMessage[]): RequestInit => ({
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(providerConfig.buildBody(nextMessages, requestOverrides)),
      signal: combinedSignal,
    })

    const sendRequest = async (requestInit: RequestInit): Promise<Response> => {
      const httpFetch = await getHttpFetch()
      let attempt = 0
      while (true) {
        try {
          return await httpFetch(providerConfig.url, requestInit)
        } catch (err) {
          if (signal?.aborted || combinedSignal?.aborted) throw err
          if (!isFetchNetworkError(err)) throw err
          if (timeoutFired) throw err
          const retryDelay = NETWORK_RETRY_DELAYS_MS[attempt]
          if (retryDelay === undefined) {
            throw new Error(
              `无法连接到模型接口：软件已自动等待并重试约 5 分钟，但仍然连接失败。` +
              `常见原因是网络不稳定、代理不可用、接口地址无法访问、服务商网关暂时中断，或本机网络环境阻断了访问。` +
              `请检查网络、代理和接口地址后再重试。接口地址：${providerConfig.url}`,
            )
          }
          attempt += 1
          const shouldContinue = await waitForRetry(retryDelay, combinedSignal)
          if (!shouldContinue) throw err
        }
      }
    }

    let requestInit = buildRequestInit(messages)
    let response: Response
    try {
      response = await sendRequest(requestInit)
    } catch (err) {
      if (signal?.aborted || (combinedSignal?.aborted && !timeoutFired)) {
        onDone()
        return
      }
      if (err instanceof Error && err.name === "AbortError") {
        // Backstop timeout aborted the request (we tracked this via
        // timeoutFired); treat it as a real timeout rather than a cancel.
        if (timeoutFired) {
          onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
          return
        }
        onDone()
        return
      }
      if (isFetchNetworkError(err)) {
        if (timeoutFired) {
          onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
          return
        }
        // Fast fetch failure: DNS, TLS handshake, connection refused,
        // wrong endpoint, CORS preflight rejection, etc. All webviews
        // collapse this class of failure into an opaque error — point
        // users at the likely cause (endpoint / key / connectivity).
        onError(new Error(`网络连接中断，请检查网络、代理或接口地址后重试。接口地址：${providerConfig.url}`))
        return
      }
      onError(err instanceof Error ? err : new Error(String(err)))
      return
    }

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}: ${response.statusText}`
      try {
        const body = await response.text()
        if (body) errorDetail += ` — ${body}`
      } catch {
        // ignore body read failure
      }
      let inputLimitRetrySucceeded = false
      const inputLimit = parseInputLengthLimit(errorDetail)
      if (inputLimit) {
        const retryRequestInit = buildRequestInit(
          trimChatMessagesToBudget(messages, Math.floor(inputLimit.maxLength * 0.85)),
        )
        if (retryRequestInit.body === requestInit.body) {
          onError(new Error(inputLengthLimitMessage(inputLimit)))
          return
        }
        requestInit = retryRequestInit
        try {
          response = await sendRequest(requestInit)
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)))
          return
        }
        if (response.ok) {
          inputLimitRetrySucceeded = true
        } else {
          let retryErrorDetail = `HTTP ${response.status}: ${response.statusText}`
          try {
            const retryBody = await response.text()
            if (retryBody) retryErrorDetail += ` — ${retryBody}`
          } catch {
            // ignore body read failure
          }
          onError(new Error(inputLengthLimitMessage(parseInputLengthLimit(retryErrorDetail) ?? inputLimit)))
          return
        }
      }
      if (
        !inputLimitRetrySucceeded &&
        response.status === 404 &&
        (runtimeConfig.provider === "azure" ||
          (runtimeConfig.provider === "custom" && isAzureOpenAiEndpoint(runtimeConfig.customEndpoint)))
      ) {
        onError(
          new Error(
            `${errorDetail}。Azure OpenAI 返回 404 通常表示部署名称不正确。请确认模型栏填写的是 Azure deployment name，而不是模型 SKU；接口地址填写 https://<resource>.openai.azure.com 或包含 /openai/deployments/<deployment-name> 的地址。`,
          ),
        )
        return
      }
      if (!inputLimitRetrySucceeded && shouldRetryWithBrowserFetch(errorDetail) && typeof globalThis.fetch === "function") {
        try {
          response = await globalThis.fetch(providerConfig.url, requestInit)
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)))
          return
        }

        if (!response.ok) {
          let retryErrorDetail = `HTTP ${response.status}: ${response.statusText}`
          try {
            const retryBody = await response.text()
            if (retryBody) retryErrorDetail += ` — ${retryBody}`
          } catch {
            // ignore body read failure
          }
          onError(new Error(retryErrorDetail))
          return
        }
      } else if (!inputLimitRetrySucceeded) {
        onError(new Error(errorDetail))
        return
      }
    }

    if (!response.body) {
      onError(new Error("Response body is null"))
      return
    }

    const reader = response.body.getReader()
    let lineBuffer = ""

    // Diagnostic counters. Some OpenAI-compatible endpoints stream
    // chain-of-thought through a `reasoning_content` (DeepSeek-R1,
    // Kimi K2.x) or `reasoning` (Qwen-flavored deployments) field
    // and only put the actual answer in `delta.content` after
    // thinking ends. Misbehaving endpoints sometimes emit kilobytes
    // of reasoning and end the stream with no content at all,
    // leaving the user with a silent empty analysis. We track the
    // two channels separately so the stream-end path can tell the
    // difference between "model said nothing" and "model thought
    // out loud but never produced an answer". See reasoning-
    // detector.ts.
    let contentCharsEmitted = 0
    let reasoningCharsObserved = 0
    const recordToken = (text: string) => {
      contentCharsEmitted += text.length
      onToken(text)
    }
    const recordReasoning = (line: string) => {
      const reasoningParts = extractReasoningTextFromLine(line)
      for (const part of reasoningParts) {
        callbacks.onReasoningToken?.(part)
      }
    }
    // ISS-20260719-002: best-effort token usage capture. Each provider
    // surfaces usage in 1-2 specific SSE event types (or not at all);
    // extractUsage returns null for the common no-usage line, so this is a
    // cheap JSON probe gated behind a startsWith check inside extractUsage.
    // Never throws into the call path (try/catch inside extractUsage).
    const recordUsage = (line: string) => {
      const usage = providerConfig.extractUsage?.(line)
      if (!usage) return
      if (usage.input > 0) metricsInputTokens = usage.input
      if (usage.output > 0) metricsOutputTokens = usage.output
    }

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          if (lineBuffer.trim()) {
            const trimmed = lineBuffer.trim()
            reasoningCharsObserved += countReasoningCharsInLine(trimmed)
            recordReasoning(trimmed)
            const token = providerConfig.parseStream(trimmed)
            if (token !== null) recordToken(token)
            recordUsage(trimmed)
          }
          break
        }

        const [lines, remaining] = parseLines(value, lineBuffer, decoder)
        lineBuffer = remaining

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          reasoningCharsObserved += countReasoningCharsInLine(trimmed)
          recordReasoning(trimmed)
          const token = providerConfig.parseStream(trimmed)
          if (token !== null) recordToken(token)
          recordUsage(trimmed)
        }
      }

      // Stream ended cleanly. If the model produced thinking tokens
      // but no actual answer, surface that as a clear diagnostic
      // instead of letting the caller silently see "" (which usually
      // surfaces several layers up as "analysis not available" with
      // no clue why). Threshold guards against single-stray-byte
      // false positives from spurious empty `reasoning:""` deltas.
      const REASONING_DIAGNOSTIC_THRESHOLD = 200
      if (
        contentCharsEmitted === 0 &&
        reasoningCharsObserved >= REASONING_DIAGNOSTIC_THRESHOLD
      ) {
        onError(
          new Error(
            `模型只输出了 ${reasoningCharsObserved.toLocaleString()} 字符的思考内容，但没有输出正文。` +
            `这通常表示接口触发了思考 token 上限、模型没有从思考阶段切换到正式回答，或当前兼容接口的流式输出不完整。` +
            `请缩短输入、提高 max_tokens，或在设置里切换其他模型后重试。`,
          ),
        )
        return
      }

      onDone()
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || (signal?.aborted))) {
        onDone()
        return
      }
      if (isFetchNetworkError(err)) {
        // Stream reader threw a network error mid-response (connection
        // dropped, server closed early, network blip). Same message
        // regardless of whether the webview is WebKit or Chromium.
        onError(new Error("Connection lost during streaming. Try again."))
        return
      }
      onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      reader.releaseLock()
    }
  } finally {
    if (onSignalAbort && signal) {
      signal.removeEventListener("abort", onSignalAbort)
    }
    // ISS-004: clear the long-horizon backstop timer on every exit path. On
    // success the timer was previously left to run its full 30-min window,
    // leaking one Node.js timer handle per LLM request. Idempotent: if the
    // user-abort path already cleared it, this is a no-op. Mirrors the
    // waitForRetry clear pattern (llm-client.ts:65) for consistency.
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    // ISS-20260709-020: record the LLM metric for this HTTP-path call.
    // Covers success (metricsErrorKind undefined → success=true), onError
    // paths (errorKind set by wrapped onError), and throws (errorKind stays
    // undefined but the finally still records — a thrown transport error
    // surfaces as success=false only if onError fired first; a raw throw
    // before onError is a success=true false negative, acceptable for a
    // best-effort metric).
    recordMetric()
  }
}
