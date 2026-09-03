// Copyright (c) 2024 Niko-hub contributors. MIT License.

import type { LlmConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"
import { type RequestOverrides } from "./llm-providers"
import { defaultRegistry } from "./llm/provider-registry"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"
import { probeEndpointReachability } from "./endpoint-probe"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"
import { isReasoningDisabled, isReasoningOnlyResponseError, withReasoningDisabled } from "./reasoning-retry"
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
  /** Optional agent extensions (port of v3 agent chain). */
  onToolCallDelta?: (delta: { index: number; type?: string; id?: string; name?: string; arguments?: string }) => void
  onFinishReason?: (reason: string) => void
  onUsage?: (usage: { input: number; output: number }) => void
  onUserMemoryDecision?: (decision: { memoryKey: string; action: "accept" | "reject" }) => void
  /** Optional transport status updates (e.g. failover switch notices). */
  onStatus?: (status: string) => void
}

export function isOutputTruncatedError(error: unknown): boolean {
  return error instanceof Error && /truncated|max_tokens|output token limit/i.test(error.message)
}

export interface LlmMetric {
  ts: string
  model: string
  provider: string
  durationMs: number
  success: boolean
  errorKind?: string
  traceId?: string
  inputTokens?: number
  outputTokens?: number
}

let metricsFilePath = ""
let metricsTraceId = ""
const metricsBuffer: LlmMetric[] = []

export function setMetricsFilePath(path: string): void {
  metricsFilePath = path
}

export function setMetricsTraceId(id: string): void {
  metricsTraceId = id
}

/**
 * Transport-stage error names. They ride on `Error#name` (not message
 * matching) so classification stays stable across locale/refactors.
 */
const ENDPOINT_UNREACHABLE_ERROR_NAME = "EndpointUnreachableError"
const HEADER_TIMEOUT_ERROR_NAME = "HeaderTimeoutError"
const STREAM_IDLE_ERROR_NAME = "StreamIdleTimeoutError"

/** Thrown when the endpoint probe confirms the target host is unreachable — terminal, do not retry. */
export class EndpointUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = ENDPOINT_UNREACHABLE_ERROR_NAME
  }
}

export function isEndpointUnreachableError(error: unknown): boolean {
  return error instanceof Error && error.name === ENDPOINT_UNREACHABLE_ERROR_NAME
}

function makeNamedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function classifyLlmError(err: unknown): string {
  /* v8 ignore next */
  if (err instanceof Error) {
    if (err.name === "AbortError") return "abort"
    if (err.name === ENDPOINT_UNREACHABLE_ERROR_NAME) return "endpoint_unreachable"
    if (err.name === HEADER_TIMEOUT_ERROR_NAME) return "header_timeout"
    if (err.name === STREAM_IDLE_ERROR_NAME) return "stream_idle"
    const msg = err.message
    if (/timed out|timeout/i.test(msg)) return "timeout"
    if (/网络连接|Connection lost|connection/i.test(msg)) return "network"
    if (/HTTP \d{3}/.test(msg)) return "http"
    if (/JSON|parse|解析/i.test(msg)) return "parse"
  }
  return "unknown"
}

export function collectLLMMetric(metric: LlmMetric): void {
  metricsBuffer.push({ ...metric, traceId: metric.traceId ?? metricsTraceId })
  if (metricsBuffer.length >= 500 && metricsFilePath) {
    void flushMetrics()
  }
}

export function __clearMetricsBufferForTest(): void {
  metricsBuffer.length = 0
}

export async function flushMetrics(): Promise<number> {
  if (!metricsFilePath || metricsBuffer.length === 0) return 0
  const toFlush = metricsBuffer.splice(0, metricsBuffer.length)
  try {
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    let existing = ""
    try {
      existing = await readFile(metricsFilePath)
    } catch {
      existing = ""
    }
    const lines = toFlush.map(m => JSON.stringify(m)).join("\n")
    const next = existing ? existing.replace(/\n?$/, "\n") + lines + "\n" : lines + "\n"
    await writeFileAtomic(metricsFilePath, next)
    return toFlush.length
  } catch (e) {
    console.error("[metrics] flush failed:", e instanceof Error ? e.message : String(e))
    if (metricsBuffer.length < 1000) metricsBuffer.unshift(...toFlush)
    return 0
  }
}

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

export function setContinuityMetricsFilePath(path: string): void {
  continuityMetricsFilePath = path
}

export function __clearContinuityMetricsBufferForTest(): void {
  continuityMetricBuffer.length = 0
}

export function collectContinuityMetric(metric: ContinuityMetric): void {
  continuityMetricBuffer.push(metric)
  if (continuityMetricBuffer.length >= 500 && continuityMetricsFilePath) {
    void flushContinuityMetrics()
  }
}

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
    console.error(
      "[continuity-metrics] flush failed:",
      e instanceof Error ? e.message : String(e),
    )
    if (continuityMetricBuffer.length < 1000) continuityMetricBuffer.unshift(...toFlush)
    return 0
  }
}

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

/**
 * Fast-fail retry backoff for the HTTP transport. Replaces the old linear
 * 30/60/90/120s ladder (~5 min of silent waiting on a dead endpoint): a
 * deterministic outage now terminates in ~17s of waiting plus one endpoint
 * probe (see probeEndpointReachability).
 */
const NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Staged HTTP timeouts (mirrors the claude-cli transport's phased watchdog):
 *  - connect: reqwest-level connection establishment (incl. proxy tunnel);
 *  - header : per-attempt deadline until response headers arrive (TS side,
 *             catches proxy black holes the connect timeout can miss);
 *  - idle   : max gap between stream chunks once streaming has started
 *             (long generations are NOT cut off — only true stalls are).
 * The 30-min DEFAULT_LLM_REQUEST_TIMEOUT_MS remains the total upper bound.
 */
export const DEFAULT_HTTP_CONNECT_TIMEOUT_MS = 10_000
export const DEFAULT_HTTP_HEADER_TIMEOUT_MS = 20_000
export const DEFAULT_HTTP_STREAM_IDLE_MS = 90_000

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

export function stripCodeFence(text: string): string {
  const fenceMatch = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/)
  return fenceMatch ? fenceMatch[1].trim() : text.trim()
}

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
  const greedy = cleaned.match(/\[[\s\S]*\]/)
  return greedy ? greedy[0] : null
}

export function shouldRetryWithBrowserFetch(errorDetail: string): boolean {
  return /client not allowed/i.test(errorDetail) && /tauri-plugin-http/i.test(errorDetail)
}

export function isRequestCancelledError(error: Error): boolean {
  return /request cancelled|request canceled|aborted|aborterror/i.test(error.message)
}

export function isTransportInactivityError(error: Error): boolean {
  return /produced no meaningful stream output within \d+ seconds|produced no additional stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|kept emitting progress heartbeats/i.test(
    error.message,
  )
}

export async function defaultLlmCall(_prompt: string): Promise<string> {
  throw new Error("defaultLlmCall not implemented in this context")
}

function parseLines(chunk: Uint8Array, buffer: string, decoder: TextDecoder): [string[], string] {
  const text = buffer + decoder.decode(chunk, { stream: true })
  const lines = text.split("\n")
  /* v8 ignore next */
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  /* v8 ignore next */
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
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const { withWritingWakeLock } = await import("./writing-wake-lock")
  return withWritingWakeLock(true, () =>
    streamChatWithReasoningFallback(config, messages, callbacks, signal, requestOverrides),
  )
}

/**
 * 53 号报告 P1-3 延伸（生成失败修复）: reasoning-only 自动降级重试。
 * 思考模型（deepseek 等）思考内容吃满 max_tokens 时只输出思考无正文——
 * 检测到该错误且思考未禁用时，自动以 reasoning off 重试一次（additive，
 * 与 agent runner 既有降级语义一致；onStatus 提示不静默）。
 */
export function shouldRetryWithoutReasoning(
  error: Error,
  config: Pick<LlmConfig, "reasoning">,
  requestOverrides?: RequestOverrides,
): boolean {
  return (
    isReasoningOnlyResponseError(error) &&
    !isReasoningDisabled(config, requestOverrides)
  )
}

async function streamChatWithReasoningFallback(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const capturedReasoningOnly: Error[] = []
  const firstPassCallbacks: StreamCallbacks = {
    ...callbacks,
    onError: (error) => {
      // 拦截 reasoning-only 错误供降级决策；其余错误立即转发。
      if (shouldRetryWithoutReasoning(error, config, requestOverrides) && capturedReasoningOnly.length === 0) {
        capturedReasoningOnly.push(error)
        return
      }
      callbacks.onError(error)
    },
  }
  await streamChatHeld(config, messages, firstPassCallbacks, signal, requestOverrides)

  if (capturedReasoningOnly.length === 0) return

  callbacks.onStatus?.("模型仅输出思考内容未生成正文，已自动关闭思考重试一次")
  const retryErrors: Error[] = []
  let retryContentChars = 0
  let retryDoneFired = false
  try {
    await streamChatHeld(
      config,
      messages,
      {
        ...callbacks,
        onToken: (token) => { retryContentChars += token.length; callbacks.onToken(token) },
        onError: (error) => { retryErrors.push(error) },
        onDone: () => { retryDoneFired = true },
      },
      signal,
      withReasoningDisabled(requestOverrides),
    )
  } catch (err) {
    retryErrors.push(err instanceof Error ? err : new Error(String(err)))
  }
  const retryError = retryErrors[0]
  if (retryError) {
    callbacks.onError(
      new Error(`${retryError.message}（注：已自动关闭思考重试一次仍失败。）`),
    )
  } else if (retryContentChars > 0 && retryDoneFired) {
    // 重试成功产出正文——透传 onDone（onToken 已实时转发）。
    callbacks.onDone()
  } else {
    // 重试未报错但也没有产出正文（空流/静默失败）——转发原始错误，
    // 避免用户看到“成功”却无内容。
    callbacks.onError(capturedReasoningOnly[0])
  }
}

export interface StreamChatFailoverOptions {
  /**
   * When the HTTP endpoint probe confirms the endpoint is unreachable,
   * retry once via the Claude Code CLI transport. Off by default: switching
   * models changes cost/output and must be user-opt-in.
   */
  failoverEnabled?: boolean
}

/**
 * streamChat with an opt-in single-shot failover to the Claude Code CLI when
 * the primary HTTP endpoint is confirmed unreachable by the transport probe.
 *
 * Signature is a drop-in superset of {@link streamChat}: callers can switch
 * to this helper without changing any argument. Without `failoverEnabled`
 * (the default) it behaves exactly like streamChat.
 *
 * Failover requires: the error is an endpoint-unreachable terminal error,
 * the current provider is not already claude-code, and the local
 * `claude` CLI is detected. The switch is announced via
 * `callbacks.onStatus` so the UI can surface it — never silent.
 */
export async function streamChatWithFailover(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
  options?: StreamChatFailoverOptions,
): Promise<void> {
  const failoverEnabled = options?.failoverEnabled ?? false
  // Captured in an array: TS flow analysis ignores closure assignments to
  // let bindings, which would wrongly narrow them to null at the read site.
  const capturedUnreachable: Error[] = []
  const firstPassCallbacks: StreamCallbacks = {
    ...callbacks,
    onError: (error) => {
      // Hold endpoint-unreachable errors instead of forwarding: the failover
      // decision below needs them. Everything else forwards immediately.
      if (isEndpointUnreachableError(error) && capturedUnreachable.length === 0) {
        capturedUnreachable.push(error)
        return
      }
      callbacks.onError(error)
    },
  }
  await streamChat(config, messages, firstPassCallbacks, signal, requestOverrides)

  const unreachableError = capturedUnreachable[0]
  if (!unreachableError) return

  if (!failoverEnabled || config.provider === "claude-code") {
    callbacks.onError(unreachableError)
    return
  }

  const { detectLocalCliConfig } = await import("./local-cli-config")
  let detected: Awaited<ReturnType<typeof detectLocalCliConfig>> = null
  try {
    detected = await detectLocalCliConfig("claude-code")
  } catch {
    detected = null
  }
  if (!detected?.installed) {
    callbacks.onError(
      new Error(
        `${unreachableError.message}（已开启"自动切换 Claude 重试"，但未检测到可用的 claude 命令行。` +
        `请在设置中确认 claude 命令已安装后重试，或直接切换模型。）`,
      ),
    )
    return
  }

  callbacks.onStatus?.("主接口不可达，已自动切换到 Claude 主模型重试")
  const capturedFailover: Error[] = []
  try {
    await streamChat(
      { ...config, provider: "claude-code" },
      messages,
      { ...callbacks, onError: (error) => { capturedFailover.push(error) } },
      signal,
      requestOverrides,
    )
  } catch (err) {
    capturedFailover.push(err instanceof Error ? err : new Error(String(err)))
  }
  const failoverError = capturedFailover[0]
  if (failoverError) {
    callbacks.onError(
      new Error(`${failoverError.message}（注：主接口已探测确认不可达，以上为切换 Claude 主模型重试后的结果。）`),
    )
  }
}

async function streamChatHeld(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const resolvedLocal = await resolveRuntimeLocalCliConfig(config)
  const metricsStart = Date.now()
  let metricsErrorKind: string | undefined
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

  const effectiveProvider = resolveProviderOverride(resolvedLocal)
  const runtimeConfig: LlmConfig = effectiveProvider === resolvedLocal.provider
    ? resolvedLocal
    : { ...resolvedLocal, provider: effectiveProvider }

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

  let mutableRuntimeConfig = runtimeConfig
  if (mutableRuntimeConfig.provider === "cursor-cli") {
    const mod = await import("./cursor-cli-proxy")
    const endpoint = await mod.ensureCursorProxyRunning(mutableRuntimeConfig)
    mutableRuntimeConfig = mod.withCursorProxyEndpoint(mutableRuntimeConfig, endpoint)
  }
  const providerConfig = defaultRegistry.getProviderConfig(mutableRuntimeConfig)

  // Stream-idle watchdog shared by every attempt of this request: armed once
  // headers arrive, reset on each chunk, aborts the body read on a stall.
  let streamIdleFired = false
  const streamIdleController = new AbortController()
  const armStreamIdleTimer = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      streamIdleFired = true
      streamIdleController.abort()
    }, DEFAULT_HTTP_STREAM_IDLE_MS)
  let streamIdleTimer: ReturnType<typeof setTimeout> | undefined

  const timeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false
  let onSignalAbort: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      onSignalAbort = () => {
        /* v8 ignore next */
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        timeoutController?.abort()
      }
      if (signal.aborted) {
        onSignalAbort()
      } else {
        signal.addEventListener("abort", onSignalAbort)
      }
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
      let probeSettled = false
      while (true) {
        // Per-attempt header deadline: aborts the in-flight request when no
        // response headers arrive in time (proxy black hole / hung gateway).
        const headerDeadlineController = new AbortController()
        let headerTimeoutFired = false
        const headerTimer = setTimeout(() => {
          headerTimeoutFired = true
          headerDeadlineController.abort()
        }, DEFAULT_HTTP_HEADER_TIMEOUT_MS)
        const attemptSignal = combineAbortSignals(
          signal,
          combinedSignal,
          headerDeadlineController.signal,
          streamIdleController.signal,
        )
        const attemptInit = {
          ...requestInit,
          signal: attemptSignal,
          connectTimeout: DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
        } as RequestInit
        try {
          return await httpFetch(providerConfig.url, attemptInit)
        } catch (err) {
          if (signal?.aborted || combinedSignal?.aborted) throw err
          /* v8 ignore next */
          if (timeoutFired) throw err
          const headerTimedOut = headerTimeoutFired && !isFetchNetworkError(err)
          if (!isFetchNetworkError(err) && !headerTimedOut) throw err
          // First failure: probe the endpoint once. Confirmed-unreachable →
          // terminal error immediately (no pointless retry waiting); reachable
          // → keep the short backoff (genuine flaps still recover).
          if (!probeSettled) {
            probeSettled = true
            const probe = await probeEndpointReachability(providerConfig.url)
            if (!probe.reachable) {
              throw new EndpointUnreachableError(
                `无法连接到模型接口：端点探测确认接口当前不可达（连接失败或探测超时）。` +
                `常见原因是代理服务未运行、代理地址配置错误，或接口地址本身无法访问。` +
                `请检查网络、代理地址与接口地址后再重试。接口地址：${providerConfig.url}`,
              )
            }
          }
          const retryDelay = NETWORK_RETRY_DELAYS_MS[attempt]
          if (retryDelay === undefined) {
            throw headerTimedOut
              ? makeNamedError(
                  HEADER_TIMEOUT_ERROR_NAME,
                  `连接模型接口超过 ${Math.round(DEFAULT_HTTP_HEADER_TIMEOUT_MS / 1000)} 秒仍无响应，快速重试约 20 秒仍未成功。` +
                  `这种情况常见于代理服务挂起或网络黑洞（TCP 已连通但数据无响应）。` +
                  `请检查代理服务是否正常运行、代理地址是否正确，或尝试切换直连后重试。接口地址：${providerConfig.url}`,
                )
              : new Error(
                  `无法连接到模型接口：已自动快速重试约 20 秒，但仍然连接失败。` +
                  `常见原因是网络不稳定、代理不可用、接口地址无法访问、服务商网关暂时中断，或本机网络环境阻断了访问。` +
                  `请检查网络、代理和接口地址后再重试。接口地址：${providerConfig.url}`,
                )
          }
          attempt += 1
          const shouldContinue = await waitForRetry(retryDelay, combinedSignal)
          if (!shouldContinue) throw err
        } finally {
          clearTimeout(headerTimer)
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
        if (timeoutFired) {
          onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
          return
        }
        onDone()
        return
      }
      if (isFetchNetworkError(err)) {
        /* v8 ignore start */
        if (timeoutFired) {
          onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
          return
        }
        onError(new Error(`网络连接中断，请检查网络、代理或接口地址后重试。接口地址：${providerConfig.url}`))
        return
        /* v8 ignore stop */
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

    // Arm the stream-idle watchdog: any gap > DEFAULT_HTTP_STREAM_IDLE_MS
    // between chunks aborts the read (stall detection). Reset per chunk.
    streamIdleTimer = armStreamIdleTimer()
    const resetStreamIdleTimer = () => {
      if (streamIdleTimer !== undefined) clearTimeout(streamIdleTimer)
      streamIdleTimer = armStreamIdleTimer()
    }

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
    const recordUsage = (line: string) => {
      const usage = providerConfig.extractUsage?.(line)
      if (!usage) return
      if (usage.input > 0) metricsInputTokens = usage.input
      if (usage.output > 0) metricsOutputTokens = usage.output
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        resetStreamIdleTimer()

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
      if (streamIdleFired) {
        onError(
          makeNamedError(
            STREAM_IDLE_ERROR_NAME,
            `模型输出停滞超过 ${Math.round(DEFAULT_HTTP_STREAM_IDLE_MS / 1000)} 秒，已中止本次请求。` +
            `请重试；若反复出现，请检查代理稳定性或更换更快的模型/接口。`,
          ),
        )
        return
      }
      // The retained 30-min total budget fires during streaming (headers long
      // since arrived, chunks kept resetting the idle watchdog): report the
      // timeout instead of silently treating the abort as a normal end.
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      if (err instanceof Error && (err.name === "AbortError" || (signal?.aborted))) {
        onDone()
        return
      }
      if (isFetchNetworkError(err)) {
        onError(new Error("Connection lost during streaming. Try again."))
        return
      }
      onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (streamIdleTimer !== undefined) clearTimeout(streamIdleTimer)
      reader.releaseLock()
    }
  } finally {
    if (streamIdleTimer !== undefined) clearTimeout(streamIdleTimer)
    if (onSignalAbort && signal) {
      signal.removeEventListener("abort", onSignalAbort)
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    recordMetric()
  }
}
