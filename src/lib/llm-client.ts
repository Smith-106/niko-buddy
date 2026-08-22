// Copyright (c) 2024 Niko-hub contributors. MIT License.

import type { LlmConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"
import type { RequestOverrides } from "./llm-providers"
import { defaultRegistry } from "./llm/provider-registry"
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

function classifyLlmError(err: unknown): string {
  /* v8 ignore next */
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

const NETWORK_RETRY_DELAYS_MS = [30_000, 60_000, 90_000, 120_000]
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30 * 60 * 1000

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
  return `输入内容过长：本次请求约 ${limit.inputLength} 字符，接口最大允�?${limit.maxLength} 字符。请减少历史上下文、缩短章节正文，或确认当前接口是否真的支持所选模型的上下文长度。`
}

export async function streamChat(
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

  const providerConfig = defaultRegistry.getProviderConfig(runtimeConfig)

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
          /* v8 ignore next */
          if (timeoutFired) throw err
          const retryDelay = NETWORK_RETRY_DELAYS_MS[attempt]
          if (retryDelay === undefined) {
            throw new Error(
              `无法连接到模型接口：软件已自动等待并重试�?5 分钟，但仍然连接失败。` +
              `常见原因是网络不稳定、代理不可用、接口地址无法访问、服务商网关暂时中断，或本机网络环境阻断了访问。` +
              `请检查网络、代理和接口地址后再重试。接口地址�?{providerConfig.url}`,
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
        onError(new Error(`网络连接中断，请检查网络、代理或接口地址后重试。接口地址�?{providerConfig.url}`))
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
        if (body) errorDetail += ` �?${body}`
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
            if (retryBody) retryErrorDetail += ` �?${retryBody}`
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
            `${errorDetail}。Azure OpenAI 返回 404 通常表示部署名称不正确。请确认模型栏填写的�?Azure deployment name，而不是模�?SKU；接口地址填写 https://<resource>.openai.azure.com 或包�?/openai/deployments/<deployment-name> 的地址。`,
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
            if (retryBody) retryErrorDetail += ` �?${retryBody}`
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
            `这通常表示接口触发了思�?token 上限、模型没有从思考阶段切换到正式回答，或当前兼容接口的流式输出不完整。` +
            `请缩短输入、提�?max_tokens，或在设置里切换其他模型后重试。`,
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
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    recordMetric()
  }
}
