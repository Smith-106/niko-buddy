import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

// ── mocks ────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const fsReadFile = vi.fn()
  const fsWriteFileAtomic = vi.fn()
  const getHttpFetch = vi.fn()
  const isFetchNetworkError = vi.fn()
  const streamClaudeCodeCli = vi.fn()
  const streamCodexCli = vi.fn()
  const resolveRuntimeLocalCliConfig = vi.fn()
  const probeEndpointReachability = vi.fn()
  const detectLocalCliConfig = vi.fn()
  return {
    fsReadFile,
    fsWriteFileAtomic,
    getHttpFetch,
    isFetchNetworkError,
    streamClaudeCodeCli,
    streamCodexCli,
    resolveRuntimeLocalCliConfig,
    probeEndpointReachability,
    detectLocalCliConfig,
    globalFetch: vi.fn(),
  }
})

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: (...a: unknown[]) => mocks.getHttpFetch(...a),
  isFetchNetworkError: (e: unknown) => mocks.isFetchNetworkError(e),
}))

vi.mock("./endpoint-probe", () => ({
  probeEndpointReachability: (...a: unknown[]) => mocks.probeEndpointReachability(...a),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...a: unknown[]) => mocks.fsReadFile(...a),
  writeFileAtomic: (...a: unknown[]) => mocks.fsWriteFileAtomic(...a),
}))

vi.mock("./claude-cli-transport", () => ({
  streamClaudeCodeCli: (...a: unknown[]) => mocks.streamClaudeCodeCli(...a),
}))

vi.mock("./codex-cli-transport", () => ({
  streamCodexCli: (...a: unknown[]) => mocks.streamCodexCli(...a),
}))

vi.mock("./local-cli-config", () => ({
  resolveRuntimeLocalCliConfig: (c: LlmConfig) => mocks.resolveRuntimeLocalCliConfig(c),
  detectLocalCliConfig: (...a: unknown[]) => mocks.detectLocalCliConfig(...a),
}))

import {
  __clearContinuityMetricsBufferForTest,
  __clearMetricsBufferForTest,
  collectContinuityMetric,
  collectLLMMetric,
  combineAbortSignals,
  defaultLlmCall,
  EndpointUnreachableError,
  extractJsonArraySpan,
  flushContinuityMetrics,
  flushMetrics,
  isRequestCancelledError,
  isTransportInactivityError,
  setContinuityMetricsFilePath,
  setMetricsFilePath,
  setMetricsTraceId,
  shouldRetryWithBrowserFetch,
  streamChat,
  streamChatWithFailover,
  stripCodeFence,
} from "./llm-client"

// ── helpers ───────────────────────────────────────────────────────────────

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "auto" },
    ...overrides,
  }
}

function sseLines(...lines: string[]): string {
  return lines.map((l) => `${l}\n\n`).join("")
}

function streamResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status, statusText: status === 200 ? "OK" : "ERROR" })
}

function netError(message = "Load failed"): Error {
  const e = new TypeError(message)
  ;(e as Error & { __network?: boolean }).__network = true
  return e
}

function makeCallbacks() {
  return {
    onToken: vi.fn(),
    onReasoningToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onStatus: vi.fn(),
  }
}

/** fetch mock that keeps the request signal wired to rejection. */
function abortAwareFetch(resolveWith: () => Promise<Response>): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"))
      return
    }
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"))
    })
    void resolveWith().then(resolve, reject)
  })) as typeof fetch
}

function setupHttpFetch(mockFetch: typeof fetch): void {
  mocks.getHttpFetch.mockResolvedValue(mockFetch as never)
}

const openAiToken = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`
const openAiReasoning = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: content } }] })}`
const openAiUsage = (input: number, output: number) =>
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })}`

beforeEach(() => {
  __clearMetricsBufferForTest()
  __clearContinuityMetricsBufferForTest()
  setMetricsFilePath("")
  setContinuityMetricsFilePath("")
  mocks.fsReadFile.mockReset()
  mocks.fsWriteFileAtomic.mockReset()
  mocks.getHttpFetch.mockReset()
  mocks.isFetchNetworkError.mockReset()
  mocks.streamClaudeCodeCli.mockReset()
  mocks.streamCodexCli.mockReset()
  mocks.resolveRuntimeLocalCliConfig.mockReset()
  mocks.resolveRuntimeLocalCliConfig.mockImplementation(async (c: LlmConfig) => c)
  mocks.probeEndpointReachability.mockReset()
  mocks.probeEndpointReachability.mockResolvedValue({ reachable: true, latencyMs: 1 })
  mocks.detectLocalCliConfig.mockReset()
  mocks.detectLocalCliConfig.mockResolvedValue({
    installed: true,
    version: "1.0.0",
    path: "claude",
    model: null,
    error: null,
  })
  mocks.isFetchNetworkError.mockImplementation((e: unknown) =>
    (e as Error & { __network?: boolean })?.__network === true,
  )
})

afterEach(() => {
  vi.useRealTimers()
  mocks.globalFetch.mockReset()
})

// ── metrics ───────────────────────────────────────────────────────────────

describe("LLM metrics buffer + flush", () => {
  it("collectLLMMetric buffers and applies the default trace id", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    setMetricsTraceId("trace-1")
    collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: 1, success: true })
    setMetricsTraceId("trace-2")
    collectLLMMetric({ ts: "t2", model: "m", provider: "openai", durationMs: 2, success: true, traceId: "explicit" })

    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    const n = await flushMetrics()
    expect(n).toBe(2)
    expect(mocks.fsWriteFileAtomic).toHaveBeenCalledTimes(1)
    const [path, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(path).toBe("/tmp/metrics.jsonl")
    expect(content).toContain('"traceId":"trace-1"')
    expect(content).toContain('"traceId":"explicit"')
  })

  it("flushMetrics: no path or empty buffer returns 0", async () => {
    expect(await flushMetrics()).toBe(0)
    setMetricsFilePath("/tmp/metrics.jsonl")
    expect(await flushMetrics()).toBe(0)
  })

  it("flushMetrics: appends to existing content with a trailing newline", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: 1, success: true })
    mocks.fsReadFile.mockResolvedValue("{\"old\":true}")
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushMetrics()).toBe(1)
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content.startsWith("{\"old\":true}\n")).toBe(true)
  })

  it("flushMetrics: on failure restores the buffer and returns 0", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: 1, success: false, errorKind: "timeout" })
    mocks.fsReadFile.mockRejectedValue(new Error("boom"))
    mocks.fsWriteFileAtomic.mockRejectedValue(new Error("disk full"))
    expect(await flushMetrics()).toBe(0)
    // buffer restored → next flush succeeds
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushMetrics()).toBe(1)
  })

  it("auto-flushes when the buffer reaches 500", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    for (let i = 0; i < 500; i++) {
      collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: i, success: true })
    }
    await vi.waitFor(() => {
      expect(mocks.fsWriteFileAtomic).toHaveBeenCalled()
    })
  })

  it("continuity metrics: collect, flush with existing content, restore on failure", async () => {
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    const metric = {
      execution_ms: 1,
      critical_count: 0,
      high_count: 0,
      warning_count: 0,
      data_gap_count: 0,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 0,
      gate: "consistency" as const,
      timestamp: "t",
    }
    collectContinuityMetric(metric)
    mocks.fsReadFile.mockRejectedValue(new Error("disk full"))
    mocks.fsWriteFileAtomic.mockRejectedValue(new Error("disk full"))
    expect(await flushContinuityMetrics()).toBe(0)
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushContinuityMetrics()).toBe(1)
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content).toContain('"gate":"consistency"')
    expect(await flushContinuityMetrics()).toBe(0) // buffer drained
  })

  it("auto-flushes the continuity buffer at 500 entries", async () => {
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    const base = {
      critical_count: 0, high_count: 0, warning_count: 0, data_gap_count: 0,
      overrides_hit: 0, short_circuit_hits: 0, engine_error_count: 0,
    }
    for (let i = 0; i < 500; i++) {
      collectContinuityMetric({ ...base, execution_ms: i, gate: "consistency" as const, timestamp: "t" })
    }
    await vi.waitFor(() => {
      expect(mocks.fsWriteFileAtomic).toHaveBeenCalled()
    })
  })

  it("flush failure with a non-Error reason logs the stringified reason", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: 1, success: true })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.fsReadFile.mockResolvedValue("")
      mocks.fsWriteFileAtomic.mockRejectedValue("boom-string")
      expect(await flushMetrics()).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith("[metrics] flush failed:", "boom-string")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("does not restore the metrics buffer when new entries arrive during the failed flush", async () => {
    // collect the in-flight entries with the path unset so no auto-flush drains them
    for (let i = 0; i < 1000; i++) {
      collectLLMMetric({ ts: "t", model: "m", provider: "openai", durationMs: i, success: true })
    }
    setMetricsFilePath("/tmp/metrics.jsonl")
    let rejectRead!: (e: unknown) => void
    mocks.fsReadFile.mockImplementation(() => new Promise((_res, rej) => { rejectRead = rej }))
    mocks.fsWriteFileAtomic.mockRejectedValue(new Error("disk full"))
    const flushing = flushMetrics()
    await vi.waitFor(() => expect(mocks.fsReadFile).toHaveBeenCalled())
    setMetricsFilePath("") // disable auto-flush while the flush is in flight
    for (let i = 0; i < 1000; i++) {
      collectLLMMetric({ ts: "t2", model: "m", provider: "openai", durationMs: i, success: true })
    }
    rejectRead(new Error("disk full"))
    expect(await flushing).toBe(0)
    // buffer was NOT restored (≥1000 in-flight entries) → the fresh 1000 survive
    setMetricsFilePath("/tmp/metrics.jsonl")
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushMetrics()).toBe(1000)
  })

  it("continuity: non-Error flush failure logs the stringified reason", async () => {
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    collectContinuityMetric({
      execution_ms: 1, critical_count: 0, high_count: 0, warning_count: 0, data_gap_count: 0,
      overrides_hit: 0, short_circuit_hits: 0, engine_error_count: 0, gate: "consistency", timestamp: "t",
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.fsReadFile.mockResolvedValue("")
      mocks.fsWriteFileAtomic.mockRejectedValue("cont-boom")
      expect(await flushContinuityMetrics()).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith("[continuity-metrics] flush failed:", "cont-boom")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("continuity: skips buffer restore when new entries arrive during the failed flush", async () => {
    const base = {
      critical_count: 0, high_count: 0, warning_count: 0, data_gap_count: 0,
      overrides_hit: 0, short_circuit_hits: 0, engine_error_count: 0, gate: "anti_ai" as const,
    }
    for (let i = 0; i < 1000; i++) {
      collectContinuityMetric({ ...base, execution_ms: i, timestamp: "t" })
    }
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    let rejectRead!: (e: unknown) => void
    mocks.fsReadFile.mockImplementation(() => new Promise((_res, rej) => { rejectRead = rej }))
    mocks.fsWriteFileAtomic.mockRejectedValue(new Error("disk full"))
    const flushing = flushContinuityMetrics()
    await vi.waitFor(() => expect(mocks.fsReadFile).toHaveBeenCalled())
    setContinuityMetricsFilePath("")
    for (let i = 0; i < 1000; i++) {
      collectContinuityMetric({ ...base, execution_ms: i, timestamp: "t2" })
    }
    rejectRead(new Error("disk full"))
    expect(await flushing).toBe(0)
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushContinuityMetrics()).toBe(1000)
  })

  it("continuity metrics: appends to existing content", async () => {
    setContinuityMetricsFilePath("/tmp/continuity.jsonl")
    collectContinuityMetric({
      execution_ms: 2, critical_count: 0, high_count: 0, warning_count: 0,
      data_gap_count: 0, overrides_hit: 0, short_circuit_hits: 0, engine_error_count: 0,
      gate: "quality", timestamp: "t",
    })
    mocks.fsReadFile.mockResolvedValue("{}")
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    expect(await flushContinuityMetrics()).toBe(1)
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content).toBe("{}\n{\"execution_ms\":2,\"critical_count\":0,\"high_count\":0,\"warning_count\":0,\"data_gap_count\":0,\"overrides_hit\":0,\"short_circuit_hits\":0,\"engine_error_count\":0,\"gate\":\"quality\",\"timestamp\":\"t\"}\n")
  })
})

// ── pure helpers ──────────────────────────────────────────────────────────

describe("streaming helpers", () => {
  it("combineAbortSignals: no signals / single signal pass-through", () => {
    expect(combineAbortSignals()).toBeUndefined()
    const c = new AbortController()
    expect(combineAbortSignals(c.signal)).toBe(c.signal)
  })

  it("combineAbortSignals: propagates abort across signals", () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)
    expect(combined).toBeDefined()
    b.abort()
    expect(combined!.aborted).toBe(true)
  })

  it("combineAbortSignals: already-aborted signal aborts the combo immediately", () => {
    const a = new AbortController()
    a.abort()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)
    expect(combined!.aborted).toBe(true)
  })

  it("stripCodeFence: strips json fences, trims otherwise", () => {
    expect(stripCodeFence("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}")
    expect(stripCodeFence("  hello  ")).toBe("hello")
  })

  it("extractJsonArraySpan: nested arrays, greedy fallback, no match", () => {
    expect(extractJsonArraySpan("prefix [1, [2, 3]] suffix")).toBe("[1, [2, 3]]")
    expect(extractJsonArraySpan("no brackets here")).toBeNull()
    expect(extractJsonArraySpan("text [inner] trailing ]")).toBe("[inner] trailing ]")
    expect(extractJsonArraySpan("[a] [b]")).toBe("[b]")
    expect(extractJsonArraySpan("stray ] without opener")).toBeNull()
  })

  it("shouldRetryWithBrowserFetch: only the tauri-plugin-http + client-not-allowed combo", () => {
    expect(shouldRetryWithBrowserFetch("HTTP 403: client not allowed by CORS policy (tauri-plugin-http)")).toBe(true)
    expect(shouldRetryWithBrowserFetch("HTTP 403: client not allowed")).toBe(false)
    expect(shouldRetryWithBrowserFetch("tauri-plugin-http error")).toBe(false)
  })

  it("isRequestCancelledError matches cancel/abort messages", () => {
    expect(isRequestCancelledError(new Error("request cancelled"))).toBe(true)
    expect(isRequestCancelledError(new Error("Request canceled"))).toBe(true)
    expect(isRequestCancelledError(new Error("aborted"))).toBe(true)
    expect(isRequestCancelledError(new Error("AbortError"))).toBe(true)
    expect(isRequestCancelledError(new Error("other"))).toBe(false)
  })

  it("isTransportInactivityError matches stall messages", () => {
    expect(isTransportInactivityError(new Error("produced no meaningful stream output within 90 seconds"))).toBe(true)
    expect(isTransportInactivityError(new Error("produced no additional stream output within 30 seconds"))).toBe(true)
    expect(isTransportInactivityError(new Error("never produced assistant text or StructuredOutput before stalling"))).toBe(true)
    expect(isTransportInactivityError(new Error("kept emitting progress heartbeats"))).toBe(true)
    expect(isTransportInactivityError(new Error("plain error"))).toBe(false)
  })

  it("defaultLlmCall always throws in this context", async () => {
    await expect(defaultLlmCall("prompt")).rejects.toThrow("not implemented")
  })
})

// ── CLI transport paths ───────────────────────────────────────────────────

describe("streamChat CLI transports", () => {
  it("routes claude-code through streamClaudeCodeCli and records a success metric", async () => {
    mocks.streamClaudeCodeCli.mockImplementation(async (_c, _m, cb: { onDone: () => void }) => {
      cb.onDone()
    })
    const callbacks = makeCallbacks()
    await streamChat(
      llmConfig({ provider: "claude-code", apiKey: "" }),
      [{ role: "user", content: "hi" }],
      callbacks,
    )
    expect(mocks.streamClaudeCodeCli).toHaveBeenCalledTimes(1)
    const [runtimeConfig] = mocks.streamClaudeCodeCli.mock.calls[0] as [LlmConfig]
    expect(runtimeConfig.provider).toBe("claude-code")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("claude-code: a CLI-reported error is classified and routed through onError", async () => {
    mocks.streamClaudeCodeCli.mockImplementation(async (_c, _m, cb: { onError: (e: Error) => void }) => {
      cb.onError(new Error("timed out waiting for response"))
    })
    const callbacks = makeCallbacks()
    await streamChat(
      llmConfig({ provider: "claude-code", apiKey: "" }),
      [{ role: "user", content: "hi" }],
      callbacks,
    )
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "timed out waiting for response" }))
  })

  it("routes codex-cli through streamCodexCli with overrides and signal", async () => {
    mocks.streamCodexCli.mockImplementation(async (_c, _m, cb: { onToken: (t: string) => void; onDone: () => void }, _s, _o) => {
      cb.onToken("part")
      cb.onDone()
    })
    const callbacks = makeCallbacks()
    const controller = new AbortController()
    await streamChat(
      llmConfig({ provider: "codex-cli", apiKey: "" }),
      [{ role: "user", content: "hi" }],
      callbacks,
      controller.signal,
      { temperature: 0.2 },
    )
    expect(mocks.streamCodexCli).toHaveBeenCalledTimes(1)
    const [runtimeConfig, , , signal, overrides] = mocks.streamCodexCli.mock.calls[0] as unknown as [LlmConfig, unknown, unknown, AbortSignal, unknown]
    expect(runtimeConfig.provider).toBe("codex-cli")
    expect(signal).toBe(controller.signal)
    expect(overrides).toEqual({ temperature: 0.2 })
    expect(callbacks.onToken).toHaveBeenCalledWith("part")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("claude-code with an API key reroutes to the anthropic HTTP path", async () => {
    const response = streamResponse(sseLines(
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}`,
      "data: [DONE]",
    ))
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    await streamChat(
      llmConfig({ provider: "claude-code", apiKey: "sk-anthropic" }),
      [{ role: "user", content: "hi" }],
      callbacks,
    )
    expect(callbacks.onToken).toHaveBeenCalledWith("hi")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(mocks.streamClaudeCodeCli).not.toHaveBeenCalled()
  })
})

// ── HTTP happy path ───────────────────────────────────────────────────────

describe("streamChat HTTP path", () => {
  it("streams tokens, reasoning, and usage, then calls onDone", async () => {
    const chunks = [
      sseLines(openAiToken("Hello")),
      sseLines(openAiReasoning("let me think about this for a while")),
      sseLines(openAiToken(" world")),
      sseLines(openAiUsage(12, 4), "data: [DONE]"),
    ]
    const response = streamResponse(chunks.join(""))
    setupHttpFetch(abortAwareFetch(async () => response))

    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)

    expect(callbacks.onToken.mock.calls.map((c) => c[0])).toEqual(["Hello", " world"])
    expect(callbacks.onReasoningToken).toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("handles chunk boundaries mid-line via the line buffer", async () => {
    const response = streamResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\nda`)
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    // "da" stays in the buffer; on done the buffered fragment is processed
    expect(callbacks.onToken).toHaveBeenCalledWith("hel")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("works without an onReasoningToken callback", async () => {
    const response = streamResponse(sseLines(
      openAiReasoning("thinking"),
      openAiToken("ok"),
      "data: [DONE]",
    ))
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    delete (callbacks as { onReasoningToken?: unknown }).onReasoningToken
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onToken).toHaveBeenCalledWith("ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("retries transient network errors and succeeds", async () => {
    vi.useFakeTimers()
    const response = streamResponse(sseLines(openAiToken("retried"), "data: [DONE]"))
    let attempts = 0
    const mockFetch = ((() => {
      attempts++
      if (attempts === 1) return Promise.reject(netError("Failed to fetch"))
      return Promise.resolve(response)
    }) as unknown) as typeof fetch
    setupHttpFetch(mockFetch)

    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(30_000)
    await p
    expect(attempts).toBe(2)
    expect(callbacks.onToken).toHaveBeenCalledWith("retried")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("gives up after exhausting all network retry delays", async () => {
    vi.useFakeTimers()
    setupHttpFetch((async () => { throw netError("Failed to fetch") }) as typeof fetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 90_000 + 120_000)
    await p
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("无法连接到模型接口")
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("aborts the retry wait when the caller signal fires", async () => {
    const controller = new AbortController()
    const mockFetch = (() => Promise.reject(netError("Failed to fetch"))) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await p
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("classifies HTTP and parse errors into metric error kinds", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    setupHttpFetch((async () => { throw new Error("HTTP 429: rate limited") }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    await flushMetrics()
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content).toContain('"errorKind":"http"')
    expect(content).toContain('"success":false')
  })

  it("classifies parse errors into the metric error kind", async () => {
    setMetricsFilePath("/tmp/metrics.jsonl")
    setupHttpFetch((async () => { throw new Error("Failed to parse JSON response") }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Failed to parse JSON response" }))
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    await flushMetrics()
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content).toContain('"errorKind":"parse"')
  })

  it("a non-Error fetch rejection surfaces as a wrapped Error", async () => {
    setupHttpFetch((async () => { throw "string-boom" }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "string-boom" }))
  })

  it("a direct AbortError rejection (no signal) ends with onDone", async () => {
    setupHttpFetch((async () => { throw new DOMException("aborted", "AbortError") }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("a pre-header hang fast-fails via the header deadline + retry ladder well before the 30-min budget", async () => {
    vi.useFakeTimers()
    // fetch stays pending until the signal aborts, then fails with a NETWORK error
    const mockFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(netError("Load failed")))
    })) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    // 4 attempts × 20s header deadline + 2/5/10s backoff waits ≈ 97s — far below
    // the 30-min total budget, which no longer governs pre-header hangs.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await p
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("已自动快速重试约 20 秒")
  })

  it("retry waits abort with onDone when the caller aborts mid-wait", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    setupHttpFetch((async () => { throw netError("Failed to fetch") }) as typeof fetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await p
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("non-network fetch errors surface immediately without retry", async () => {
    setupHttpFetch((async () => { throw new Error("boom") }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))
  })

  it("the retained 30-min total budget caps a never-ending flowing stream", async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    // Headers arrive immediately; chunks keep flowing every 60s (resetting the
    // 90s idle watchdog) and never end — only the 30-min total budget can stop it.
    const mockFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let i = 0
          const interval = setInterval(() => {
            i += 1
            controller.enqueue(encoder.encode(sseLines(openAiToken(`chunk-${i}`))))
          }, 60_000)
          init?.signal?.addEventListener("abort", () => {
            clearInterval(interval)
            controller.error(new DOMException("aborted", "AbortError"))
          })
        },
      })
      resolve(new Response(stream, { status: 200 }))
    })) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1)
    await p
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("Request timed out after 30 min")
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("external abort before a response resolves calls onDone", async () => {
    const controller = new AbortController()
    setupHttpFetch(abortAwareFetch(() => new Promise<Response>(() => {})))
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks, controller.signal)
    await Promise.resolve()
    controller.abort()
    await p
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("still streams when AbortSignal.timeout is unavailable (no timeout controller)", async () => {
    const original = AbortSignal.timeout
    ;(AbortSignal as unknown as { timeout?: unknown }).timeout = undefined
    try {
      const response = streamResponse(sseLines(openAiToken("no-timeout"), "data: [DONE]"))
      setupHttpFetch(abortAwareFetch(async () => response))
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onToken).toHaveBeenCalledWith("no-timeout")
      expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    } finally {
      ;(AbortSignal as unknown as { timeout?: unknown }).timeout = original
    }
  })
})

// ── HTTP error paths ──────────────────────────────────────────────────────

describe("streamChat HTTP error handling", () => {
  function errorResponse(status: number, statusText: string, bodyText: string): Response {
    return new Response(bodyText, { status, statusText })
  }

  it("input-length 400 retries with a trimmed body and succeeds", async () => {
    const longSystem = "x".repeat(20_000)
    const messages = [
      { role: "system" as const, content: longSystem },
      { role: "user" as const, content: "summarize" },
    ]
    let calls = 0
    const mockFetch = (async () => {
      calls++
      if (calls === 1) {
        return errorResponse(400, "Bad Request", "input length 12345 exceeds maximum length 10000")
      }
      return streamResponse(sseLines(openAiToken("trimmed-ok"), "data: [DONE]"))
    }) as typeof fetch
    setupHttpFetch(mockFetch)

    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), messages, callbacks)
    expect(calls).toBe(2)
    expect(callbacks.onToken).toHaveBeenCalledWith("trimmed-ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("input-length error with an unchanged body reports the length hint", async () => {
    setupHttpFetch(async () => errorResponse(400, "Bad Request", "input length 123 exceeds max 456"))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "short" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("输入内容过长")
  })

  it("input-length retry whose request fails surfaces the transport error (AbortError classified as abort)", async () => {
    const messages = [
      { role: "system" as const, content: "s".repeat(20_000) },
      { role: "user" as const, content: "u" },
    ]
    let calls = 0
    const mockFetch = (async (): Promise<Response> => {
      calls++
      if (calls === 1) {
        return errorResponse(400, "Bad Request", "input length 12345 exceeds maximum length 10000")
      }
      throw new DOMException("aborted", "AbortError")
    }) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), messages, callbacks)
    expect(calls).toBe(2)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }))
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("input-length retry with an empty error body falls back to the original limit", async () => {
    const messages = [
      { role: "system" as const, content: "s".repeat(20_000) },
      { role: "user" as const, content: "u" },
    ]
    let calls = 0
    setupHttpFetch((async () => {
      calls++
      if (calls === 1) {
        return errorResponse(400, "Bad Request", "input length 12345 exceeds maximum length 10000")
      }
      return errorResponse(400, "Bad Request", "")
    }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), messages, callbacks)
    expect(calls).toBe(2)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("输入内容过长")
  })

  it("non-numeric input-length error is not treated as an input limit", async () => {
    setupHttpFetch(async () => errorResponse(400, "Bad Request", "input length abc exceeds maximum length xyz"))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("HTTP 400")
    expect(callbacks.onError.mock.calls[0][0].message).toContain("input length abc")
  })

  it("overflowing input-length numbers are treated as a plain HTTP error", async () => {
    setupHttpFetch(async () =>
      errorResponse(400, "Bad Request", `input length ${'9'.repeat(400)} exceeds maximum length 10000`),
    )
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("HTTP 400")
    expect(callbacks.onError.mock.calls[0][0].message).not.toContain("输入内容过长")
  })

  it("browser-fetch fallback that rejects surfaces the fetch error", async () => {
    mocks.globalFetch.mockRejectedValue(new Error("browser fetch exploded"))
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = mocks.globalFetch
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "browser fetch exploded" }))
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("browser-fetch fallback rejecting with a non-Error wraps it", async () => {
    mocks.globalFetch.mockRejectedValue("plain-string")
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = mocks.globalFetch
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "plain-string" }))
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("browser-fetch fallback with an empty error body reports just the status line", async () => {
    mocks.globalFetch.mockResolvedValue(errorResponse(403, "Forbidden", ""))
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = mocks.globalFetch
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onError).toHaveBeenCalledTimes(1)
      expect(callbacks.onError.mock.calls[0][0].message).toBe("HTTP 403: Forbidden")
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("input-length retry rejecting with a non-Error wraps it", async () => {
    const messages = [
      { role: "system" as const, content: "s".repeat(20_000) },
      { role: "user" as const, content: "u" },
    ]
    let calls = 0
    setupHttpFetch((async () => {
      calls++
      if (calls === 1) {
        return errorResponse(400, "Bad Request", "input length 12345 exceeds maximum length 10000")
      }
      throw "retry-string-boom"
    }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), messages, callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "retry-string-boom" }))
  })

  it("input-length retry that still fails reports the retry detail", async () => {
    const mockFetch = (async () => {
      return errorResponse(400, "Bad Request", "input length 12345 exceeds the maximum length 10000")
    }) as typeof fetch
    setupHttpFetch(mockFetch)
    const longUser = { role: "user" as const, content: "y".repeat(30_000) }
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [longUser], callbacks)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("输入内容过长")
  })

  it("azure 404 surfaces the deployment-name hint", async () => {
    setupHttpFetch(async () => errorResponse(404, "Not Found", "deployment not found"))
    const callbacks = makeCallbacks()
    await streamChat(
      llmConfig({ provider: "azure", apiKey: "k", model: "gpt-4o", customEndpoint: "https://r.openai.azure.com" }),
      [{ role: "user", content: "hi" }],
      callbacks,
    )
    expect(callbacks.onError.mock.calls[0][0].message).toContain("Azure deployment name")
  })

  it("custom provider on an azure endpoint also gets the 404 hint", async () => {
    setupHttpFetch(async () => errorResponse(404, "Not Found", ""))
    const callbacks = makeCallbacks()
    await streamChat(
      llmConfig({ provider: "custom", customEndpoint: "https://r.openai.azure.com", model: "gpt-4o" }),
      [{ role: "user", content: "hi" }],
      callbacks,
    )
    expect(callbacks.onError.mock.calls[0][0].message).toContain("Azure deployment name")
  })

  it("falls back to globalThis.fetch when the plugin reports client-not-allowed", async () => {
    mocks.globalFetch.mockResolvedValue(
      streamResponse(sseLines(openAiToken("browser-fetch-ok"), "data: [DONE]")),
    )
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = mocks.globalFetch
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(mocks.globalFetch).toHaveBeenCalledTimes(1)
      expect(callbacks.onToken).toHaveBeenCalledWith("browser-fetch-ok")
      expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("browser-fetch fallback failure reports the retry detail", async () => {
    mocks.globalFetch.mockResolvedValue(errorResponse(403, "Forbidden", "proxy said no"))
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = mocks.globalFetch
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onError).toHaveBeenCalledTimes(1)
      expect(callbacks.onError.mock.calls[0][0].message).toContain("HTTP 403")
      expect(callbacks.onError.mock.calls[0][0].message).toContain("proxy said no")
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("skips the browser-fetch fallback when globalThis.fetch is absent", async () => {
    const original = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = undefined
    try {
      setupHttpFetch(async () =>
        errorResponse(403, "Forbidden", "client not allowed by CORS policy via tauri-plugin-http"),
      )
      const callbacks = makeCallbacks()
      await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
      expect(callbacks.onError.mock.calls[0][0].message).toContain("HTTP 403")
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  it("plain non-retryable HTTP errors report the detail", async () => {
    setupHttpFetch(async () => errorResponse(500, "Internal Server Error", "upstream exploded"))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("HTTP 500")
    expect(callbacks.onError.mock.calls[0][0].message).toContain("upstream exploded")
  })

  it("null response body reports an error", async () => {
    setupHttpFetch(async () => new Response(null, { status: 200 }))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Response body is null" }))
  })

  it("reasoning-only output triggers the diagnostic error", async () => {
    const bigReasoning = "r".repeat(250)
    const response = streamResponse(sseLines(openAiReasoning(bigReasoning)))
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("只输出了")
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("abort during stream reading calls onDone", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"}}]}`))
        controller.error(new DOMException("aborted", "AbortError"))
      },
    })
    setupHttpFetch(abortAwareFetch(async () => new Response(stream, { status: 200 })))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("network failure mid-stream reports the connection-lost error", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"}}]}`))
        controller.error(netError("Load failed"))
      },
    })
    setupHttpFetch(abortAwareFetch(async () => new Response(stream, { status: 200 })))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("Connection lost during streaming")
  })

  it("a complete final line without a trailing newline is parsed on done", async () => {
    const response = streamResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`)
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onToken).toHaveBeenCalledWith("tail")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("usage with zero counts leaves the token metrics untouched", async () => {
    const response = streamResponse(sseLines(
      openAiToken("zero"),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } })}`,
      "data: [DONE]",
    ))
    setupHttpFetch(abortAwareFetch(async () => response))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onToken).toHaveBeenCalledWith("zero")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("generic failure mid-stream surfaces the original error", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"}}]}`))
        controller.error(new Error("stream exploded"))
      },
    })
    setupHttpFetch(abortAwareFetch(async () => new Response(stream, { status: 200 })))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toBe("stream exploded")
  })

  it("a non-Error failure mid-stream surfaces as a wrapped Error", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"}}]}`))
        controller.error("string-stream-boom")
      },
    })
    setupHttpFetch(abortAwareFetch(async () => new Response(stream, { status: 200 })))
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "string-stream-boom" }))
  })

  it("input-length parse errors on a failed retry fall back to the original limit", async () => {
    // second response body is NOT parseable → uses the first parsed limit
    const mockFetch = (async (): Promise<Response> => {
      return errorResponse(400, "Bad Request", "input length 99 exceeds maximum length 500")
    }) as typeof fetch
    setupHttpFetch(mockFetch)
    const messages = [
      { role: "system" as const, content: "s".repeat(10_000) },
      { role: "user" as const, content: "u" },
    ]
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), messages, callbacks)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("输入内容过长")
  })
})

// ── staged HTTP timeouts (connect / header deadline / stream idle) ────────

describe("streamChat HTTP staged timeouts", () => {
  it("aborts a hung connection at the header deadline, retries with short backoff, then reports a proxy-suspect error", async () => {
    vi.useFakeTimers()
    setupHttpFetch(abortAwareFetch(() => new Promise<Response>(() => {})))
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    // 4 attempts x 20s header deadline + 2/5/10s backoff waits
    await vi.advanceTimersByTimeAsync(20_000 + 2_000 + 20_000 + 5_000 + 20_000 + 10_000 + 20_000)
    await p
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const message = callbacks.onError.mock.calls[0][0].message as string
    expect(message).toContain("无响应")
    expect(message).toContain("代理")
    expect(mocks.probeEndpointReachability).toHaveBeenCalledTimes(1)
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("short-circuits retries with a terminal endpoint-unreachable error when the probe fails", async () => {
    vi.useFakeTimers()
    setMetricsFilePath("/tmp/metrics.jsonl")
    let fetchCalls = 0
    setupHttpFetch((async () => {
      fetchCalls += 1
      throw netError("Failed to fetch")
    }) as typeof fetch)
    mocks.probeEndpointReachability.mockResolvedValue({ reachable: false, latencyMs: 5, errorKind: "network" })
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(1_000)
    await p
    expect(fetchCalls).toBe(1)
    expect(mocks.probeEndpointReachability).toHaveBeenCalledTimes(1)
    expect(mocks.probeEndpointReachability).toHaveBeenCalledWith(expect.stringContaining("https://"))
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("不可达")
    expect(callbacks.onDone).not.toHaveBeenCalled()
    mocks.fsReadFile.mockRejectedValue(new Error("no file"))
    mocks.fsWriteFileAtomic.mockResolvedValue(undefined)
    await flushMetrics()
    const [, content] = mocks.fsWriteFileAtomic.mock.calls[0] as [string, string]
    expect(content).toContain('"errorKind":"endpoint_unreachable"')
  })

  it("does not probe when a non-network error occurs", async () => {
    setupHttpFetch((async () => { throw new Error("boom") }) as typeof fetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(mocks.probeEndpointReachability).not.toHaveBeenCalled()
  })

  it("stream idle watchdog aborts a stalled stream after 90 seconds", async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    const mockFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseLines(openAiToken("first"))))
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"))
          })
        },
      })
      resolve(new Response(stream, { status: 200 }))
    })) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(90_000)
    await p
    expect(callbacks.onToken).toHaveBeenCalledWith("first")
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("停滞")
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("a slow but flowing stream (60s gaps) is not cut off by the idle watchdog", async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    const mockFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let i = 0
          const interval = setInterval(() => {
            i += 1
            controller.enqueue(encoder.encode(sseLines(openAiToken(`chunk-${i}`))))
            if (i >= 3) {
              clearInterval(interval)
              controller.close()
            }
          }, 60_000)
          init?.signal?.addEventListener("abort", () => {
            clearInterval(interval)
            controller.error(new DOMException("aborted", "AbortError"))
          })
        },
      })
      resolve(new Response(stream, { status: 200 }))
    })) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(200_000)
    await p
    expect(callbacks.onToken.mock.calls.map((c) => c[0])).toEqual(["chunk-1", "chunk-2", "chunk-3"])
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("exhausts the retry ladder in ~17s (short backoff) and reports the fast-fail message", async () => {
    vi.useFakeTimers()
    let fetchCalls = 0
    setupHttpFetch((async () => {
      fetchCalls += 1
      throw netError("Failed to fetch")
    }) as typeof fetch)
    const callbacks = makeCallbacks()
    const p = streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    await vi.advanceTimersByTimeAsync(17_000 + 5_000)
    await p
    expect(fetchCalls).toBe(4)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const message = callbacks.onError.mock.calls[0][0].message as string
    expect(message).toContain("无法连接到模型接口")
    expect(message).toContain("约 20 秒")
  })

  it("passes the probe-derived connectTimeout to the transport init", async () => {
    const seenInits: Array<RequestInit | undefined> = []
    const mockFetch = ((_url: unknown, init?: RequestInit) => {
      seenInits.push(init)
      return Promise.resolve(streamResponse(sseLines(openAiToken("ok"), "data: [DONE]")))
    }) as typeof fetch
    setupHttpFetch(mockFetch)
    const callbacks = makeCallbacks()
    await streamChat(llmConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(seenInits[0] && (seenInits[0] as RequestInit & { connectTimeout?: number }).connectTimeout).toBe(10_000)
  })
})

// ── streamChatWithFailover ────────────────────────────────────────────────

describe("streamChatWithFailover", () => {
  const failoverConfig = () =>
    llmConfig({ provider: "custom", customEndpoint: "https://integrate.api.nvidia.com/v1", apiKey: "" })

  function setupUnreachableEndpoint(): void {
    setupHttpFetch((async () => { throw netError("Failed to fetch") }) as typeof fetch)
    mocks.probeEndpointReachability.mockResolvedValue({ reachable: false, latencyMs: 5, errorKind: "network" })
  }

  it("forwards the unreachable error unchanged when failover is disabled (default)", async () => {
    setupUnreachableEndpoint()
    const callbacks = makeCallbacks()
    await streamChatWithFailover(failoverConfig(), [{ role: "user", content: "hi" }], callbacks)
    expect(mocks.detectLocalCliConfig).not.toHaveBeenCalled()
    expect(mocks.streamClaudeCodeCli).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("不可达")
  })

  it("switches to the claude-code transport once when failover is enabled and the CLI is detected", async () => {
    setupUnreachableEndpoint()
    mocks.streamClaudeCodeCli.mockImplementation(async (_c, _m, cb: { onDone: () => void }) => {
      cb.onDone()
    })
    const callbacks = makeCallbacks()
    await streamChatWithFailover(
      failoverConfig(),
      [{ role: "user", content: "hi" }],
      callbacks,
      undefined,
      undefined,
      { failoverEnabled: true },
    )
    expect(mocks.detectLocalCliConfig).toHaveBeenCalledWith("claude-code")
    expect(mocks.streamClaudeCodeCli).toHaveBeenCalledTimes(1)
    const [failoverUsedConfig] = mocks.streamClaudeCodeCli.mock.calls[0] as [LlmConfig]
    expect(failoverUsedConfig.provider).toBe("claude-code")
    expect(callbacks.onStatus).toHaveBeenCalledWith("主接口不可达，已自动切换到 Claude 主模型重试")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("reports a detection-failure hint when failover is enabled but no claude CLI is available", async () => {
    setupUnreachableEndpoint()
    mocks.detectLocalCliConfig.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      error: "not found",
    })
    const callbacks = makeCallbacks()
    await streamChatWithFailover(
      failoverConfig(),
      [{ role: "user", content: "hi" }],
      callbacks,
      undefined,
      undefined,
      { failoverEnabled: true },
    )
    expect(mocks.streamClaudeCodeCli).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const message = callbacks.onError.mock.calls[0][0].message as string
    expect(message).toContain("不可达")
    expect(message).toContain("claude 命令行")
  })

  it("does not trigger failover for non-unreachable errors (HTTP 400)", async () => {
    setupHttpFetch(async () => new Response("bad", { status: 400, statusText: "Bad Request" }))
    const callbacks = makeCallbacks()
    await streamChatWithFailover(
      failoverConfig(),
      [{ role: "user", content: "hi" }],
      callbacks,
      undefined,
      undefined,
      { failoverEnabled: true },
    )
    expect(mocks.detectLocalCliConfig).not.toHaveBeenCalled()
    expect(mocks.streamClaudeCodeCli).not.toHaveBeenCalled()
    // The transport appends the response body to the HTTP error detail
    // (` — ${body}`) — assert the full message to lock that contract in.
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 400: Bad Request — bad" }))
  })

  it("wraps the failover-side error with the original unreachable context", async () => {
    setupUnreachableEndpoint()
    mocks.streamClaudeCodeCli.mockImplementation(
      async (_c, _m, cb: { onError: (e: Error) => void }) => {
        cb.onError(new Error("claude cli exploded"))
      },
    )
    const callbacks = makeCallbacks()
    await streamChatWithFailover(
      failoverConfig(),
      [{ role: "user", content: "hi" }],
      callbacks,
      undefined,
      undefined,
      { failoverEnabled: true },
    )
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const message = callbacks.onError.mock.calls[0][0].message as string
    expect(message).toContain("claude cli exploded")
    expect(message).toContain("不可达")
    expect(callbacks.onStatus).toHaveBeenCalledTimes(1)
  })

  it("skips failover when the provider is already claude-code", async () => {
    // With a claude-code config the FIRST pass already routes through the CLI
    // transport, so the mock must surface the unreachable error itself.
    mocks.streamClaudeCodeCli.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onError: (e: Error) => void }) => {
        cb.onError(new EndpointUnreachableError("claude 通道报告接口不可达"))
      },
    )
    const callbacks = makeCallbacks()
    await streamChatWithFailover(
      llmConfig({ provider: "claude-code", apiKey: "" }),
      [{ role: "user", content: "hi" }],
      callbacks,
      undefined,
      undefined,
      { failoverEnabled: true },
    )
    expect(mocks.detectLocalCliConfig).not.toHaveBeenCalled()
    // Exactly one call: the original transport pass — no failover re-attempt.
    expect(mocks.streamClaudeCodeCli).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0].message).toContain("不可达")
  })
})
