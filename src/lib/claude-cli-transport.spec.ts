import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}))

import { buildExitError, createClaudeCodeStreamParser, shouldRetryClaudeCliError, streamClaudeCodeCli } from "./claude-cli-transport"

function claudeCliConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "claude-code",
    apiKey: "",
    model: "claude-opus-4-1",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function resolveWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ])
}

const noopUnlisten = () => {}

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(invoke).mockReset()
  vi.mocked(listen).mockReset()
})

describe("createClaudeCodeStreamParser", () => {
  it("treats reasoning heartbeat events as progress while ignoring init/result lifecycle noise", () => {
    const parse = createClaudeCodeStreamParser()

    expect(parse('{"type":"system","subtype":"init","cwd":"D:/QMaiWrite"}')).toEqual({ kind: "ignore" })
    expect(parse('{"type":"system","subtype":"thinking_tokens","estimated_tokens":42}')).toEqual({ kind: "heartbeat" })
    expect(parse('{"type":"result","subtype":"success"}')).toEqual({ kind: "ignore" })
  })

  it("extracts structured stdout diagnostics from error events", () => {
    const parse = createClaudeCodeStreamParser()

    expect(parse('{"type":"error","message":"Connection closed mid-response"}')).toEqual({
      kind: "diagnostic",
      text: "Connection closed mid-response",
    })
  })

  it("treats synthetic stderr relay events as progress diagnostics", () => {
    const parse = createClaudeCodeStreamParser()

    expect(parse('{"type":"stderr","text":"Bootstrapping MCP runtime"}')).toEqual({
      kind: "stderr",
      text: "Bootstrapping MCP runtime",
    })
  })

  it("diffs assistant snapshots when token deltas are unavailable", () => {
    const parse = createClaudeCodeStreamParser()

    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')).toEqual({
      kind: "token",
      text: "hello",
    })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}')).toEqual({
      kind: "token",
      text: " world",
    })
  })

  it("prefers stream deltas over repeated assistant snapshots", () => {
    const parse = createClaudeCodeStreamParser()

    expect(
      parse('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}'),
    ).toEqual({
      kind: "token",
      text: "hello",
    })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')).toEqual({
      kind: "ignore",
    })
  })

  it("extracts StructuredOutput tool payloads as structured data", () => {
    const parse = createClaudeCodeStreamParser()

    expect(
      parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"chapterId":"chapter-6","chapterNumber":6}}]}}'),
    ).toEqual({
      kind: "structured",
      data: { chapterId: "chapter-6", chapterNumber: 6 },
    })
  })

  it("treats assistant thinking snapshots as heartbeat until text arrives", () => {
    const parse = createClaudeCodeStreamParser()

    expect(
      parse('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"working","signature":""}]}}'),
    ).toEqual({
      kind: "heartbeat",
    })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}')).toEqual({
      kind: "token",
      text: "done",
    })
  })
})

describe("buildExitError", () => {
  it("prefers structured stdout diagnostics over generic unparsed fallback text", () => {
    const message = buildExitError(
      1,
      "",
      '{"type":"error","message":"Connection closed mid-response"}',
      "Connection closed mid-response",
    )

    expect(message).toContain("Connection closed mid-response")
    expect(message).not.toContain("couldn't parse")
  })

  it("treats stdout authentication failures the same as stderr authentication failures", () => {
    const message = buildExitError(1, "", "", "Unauthenticated: please log in")

    expect(message).toContain("not authenticated")
    expect(message).toContain("run `claude`")
  })

  it("maps modern not-logged-in stdout diagnostics to the same authentication hint", () => {
    const message = buildExitError(1, "", "", "Not logged in · Please run /login")

    expect(message).toContain("not authenticated")
    expect(message).toContain("run `claude`")
  })
})

describe("shouldRetryClaudeCliError", () => {
  it("retries temporary upstream availability failures", () => {
    expect(
      shouldRetryClaudeCliError(
        "claude CLI exited with code 1: API Error: 503 Service temporarily unavailable. Try again in a moment.",
      ),
    ).toBe(true)
    expect(
      shouldRetryClaudeCliError(
        "claude CLI exited with code 1: API Error: 429 overloaded_error",
      ),
    ).toBe(true)
    expect(
      shouldRetryClaudeCliError(
        "Connection closed mid-response",
      ),
    ).toBe(true)
    expect(
      shouldRetryClaudeCliError(
        "Failed to flush claude stdin: 管道已结束。 (os error 109)",
      ),
    ).toBe(true)
  })

  it("does not retry deterministic local configuration failures", () => {
    expect(
      shouldRetryClaudeCliError(
        "Claude Code CLI is not authenticated. Please open a terminal and run `claude` to complete the OAuth login.",
      ),
    ).toBe(false)
    expect(
      shouldRetryClaudeCliError(
        "claude CLI exited with code 1: Unknown model 'foo-bar'",
      ),
    ).toBe(false)
  })
})

describe("streamClaudeCodeCli", () => {
  it("retries a transient claude stdin pipe-closed startup failure and succeeds on the next spawn", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string | { code: number | null; stderr: string } }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string | { code: number | null; stderr: string } }) => void)
      return noopUnlisten
    })

    let spawnAttempts = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") {
        spawnAttempts += 1
        if (spawnAttempts === 1) {
          throw new Error("Failed to flush claude stdin: 管道已结束。 (os error 109)")
        }
        return undefined
      }
      if (command === "claude_cli_kill") return undefined
      return undefined
    })

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "retry startup pipe close" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(spawnAttempts).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnAttempts).toBe(2)

    const eventNames = [...listeners.keys()]
    const dataEventName = [...eventNames].reverse().find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...eventNames].reverse().find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners after retry")
    }

    const dataListener = listeners.get(dataEventName) as ((event: { payload: string }) => void) | undefined
    const doneListener = listeners.get(doneEventName) as ((event: { payload: { code: number | null; stderr: string } }) => void) | undefined

    dataListener?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"retry ok"}]}}',
    })
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledWith("retry ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("automatically retries with local CLI isolation after a no-meaningful-output timeout and succeeds", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string | { code: number | null; stderr: string } }) => void>()
    const spawnPayloads: Array<{ isolateLocalConfig?: boolean }> = []
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string | { code: number | null; stderr: string } }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === "claude_cli_spawn") {
        spawnPayloads.push((payload ?? {}) as { isolateLocalConfig?: boolean })
        return undefined
      }
      if (command === "claude_cli_kill") return undefined
      return undefined
    })

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "retry with isolation after no meaningful output" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(spawnPayloads).toHaveLength(1)
    expect(spawnPayloads[0]?.isolateLocalConfig).toBe(false)

    await vi.advanceTimersByTimeAsync(90_001)
    await Promise.resolve()
    await Promise.resolve()

    expect(spawnPayloads).toHaveLength(2)
    expect(spawnPayloads[1]?.isolateLocalConfig).toBe(true)

    const eventNames = [...listeners.keys()]
    const dataEventName = [...eventNames].reverse().find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...eventNames].reverse().find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners after isolation retry")
    }

    const dataListener = listeners.get(dataEventName) as ((event: { payload: string }) => void) | undefined
    const doneListener = listeners.get(doneEventName) as ((event: { payload: { code: number | null; stderr: string } }) => void) | undefined

    dataListener?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"isolation retry ok"}]}}',
    })
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledWith("isolation retry ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("automatically retries with local CLI isolation after a startup pipe-closed error and succeeds", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string | { code: number | null; stderr: string } }) => void>()
    const spawnPayloads: Array<{ isolateLocalConfig?: boolean }> = []
    let spawnAttempts = 0
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string | { code: number | null; stderr: string } }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === "claude_cli_spawn") {
        spawnAttempts += 1
        spawnPayloads.push((payload ?? {}) as { isolateLocalConfig?: boolean })
        if (spawnAttempts === 1) {
          throw new Error("Failed to flush claude stdin: 绠￠亾宸茬粨鏉熴€?(os error 109)")
        }
        return undefined
      }
      if (command === "claude_cli_kill") return undefined
      return undefined
    })

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "retry with isolation after pipe close" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(spawnPayloads).toHaveLength(1)
    expect(spawnPayloads[0]?.isolateLocalConfig).toBe(false)

    await vi.waitFor(() => {
      expect(spawnPayloads).toHaveLength(2)
      expect(spawnPayloads[1]?.isolateLocalConfig).toBe(true)
    })

    const eventNames = [...listeners.keys()]
    const dataEventName = [...eventNames].reverse().find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...eventNames].reverse().find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners after isolation retry")
    }

    const dataListener = listeners.get(dataEventName) as ((event: { payload: string }) => void) | undefined
    const doneListener = listeners.get(doneEventName) as ((event: { payload: { code: number | null; stderr: string } }) => void) | undefined

    dataListener?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"pipe isolation retry ok"}]}}',
    })
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledWith("pipe isolation retry ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("resolves immediately on abort even if the CLI never emits a done event", async () => {
    vi.mocked(listen).mockImplementation(async () => noopUnlisten)
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "test abort" }],
      callbacks,
      controller.signal,
    )

    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(
      "claude_cli_kill",
      expect.objectContaining({ streamId: expect.any(String) }),
    )
  })

  it("does not continue wiring listeners or spawn after an aborted setup", async () => {
    const firstListen = deferred<() => void>()

    vi.mocked(listen).mockImplementation(async () => firstListen.promise)
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "test early abort" }],
      callbacks,
      controller.signal,
    )

    controller.abort()
    firstListen.resolve(noopUnlisten)
    await Promise.resolve()
    await Promise.resolve()

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(listen).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "claude_cli_spawn"),
    ).toBe(false)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("waits longer for the first meaningful output before timing out", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "test inactivity timeout" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    if (!dataEventName) {
      throw new Error("expected a claude-cli data listener")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"init","cwd":"D:/QMaiWrite"}',
    })

    await vi.advanceTimersByTimeAsync(30_001)
    expect(callbacks.onError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    // C-101 (GRL-008): with localCliIsolation:true, isolation retry is skipped,
    // so the 90s first-token stall now enters backoff retry (5/15/30s delays,
    // each attempt re-hitting the 90s timeout). No data is ever delivered, so
    // all 3 retries exhaust before the final error surfaces. Advance through
    // the full retry chain: 3×(delay + 90s timeout).
    await vi.advanceTimersByTimeAsync((5_000 + 90_000) + (15_000 + 90_000) + (30_000 + 90_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]?.message).toContain("no meaningful stream output")
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "claude_cli_kill")).toBe(true)
  })

  it("falls back to the shorter inactivity timeout after meaningful output begins", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "test inactivity after token" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    if (!dataEventName) {
      throw new Error("expected a claude-cli data listener")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}',
    })

    expect(callbacks.onToken).toHaveBeenCalledWith("hello")

    await vi.advanceTimersByTimeAsync(30_001)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]?.message).toContain("no additional stream output")
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "claude_cli_kill")).toBe(true)
  })

  it("allows heartbeat-only progress before the first token as long as the first meaningful output arrives within 90 seconds", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "test heartbeat before token" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...listeners.keys()].find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"thinking_tokens","estimated_tokens":12}',
    })

    await vi.advanceTimersByTimeAsync(25_000)
    expect(callbacks.onError).not.toHaveBeenCalled()

    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"working","signature":""}]}}',
    })

    await vi.advanceTimersByTimeAsync(25_000)
    expect(callbacks.onError).not.toHaveBeenCalled()

    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"thinking_tokens","estimated_tokens":24}',
    })

    await vi.advanceTimersByTimeAsync(25_000)
    expect(callbacks.onError).not.toHaveBeenCalled()

    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    })
    const doneListener = listeners.get(doneEventName) as unknown as
      | ((event: { payload: { code: number | null; stderr: string } }) => void)
      | undefined
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith("hello")
  })

  it("keeps long-running reasoning alive when heartbeat progress continues past 90 seconds", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "test long reasoning heartbeat" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...listeners.keys()].find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"thinking_tokens","estimated_tokens":12}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"still working","signature":""}]}}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"thinking_tokens","estimated_tokens":28}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"almost there","signature":""}]}}',
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(callbacks.onError).not.toHaveBeenCalled()

    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    })
    const doneListener = listeners.get(doneEventName) as unknown as
      | ((event: { payload: { code: number | null; stderr: string } }) => void)
      | undefined
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith("hello")
  })

  it("uses relayed stderr progress to avoid a false 90-second startup timeout before the first token", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "test stderr heartbeat before token" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    if (!dataEventName) {
      throw new Error("expected a claude-cli data listener")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"stderr","text":"Bootstrapping MCP runtime"}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"stderr","text":"Waiting for upstream provider"}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"stderr","text":"Still starting..."}',
    })
    await vi.advanceTimersByTimeAsync(25_000)

    expect(callbacks.onError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_001)
    // C-101 (GRL-008): localCliIsolation:true skips isolation retry, so the
    // heartbeat-stall error now enters backoff retry. No further heartbeats are
    // delivered on retry attempts, so all 3 retries exhaust before the final
    // error. Advance through the full retry chain.
    await vi.advanceTimersByTimeAsync((5_000 + 90_000) + (15_000 + 90_000) + (30_000 + 90_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    // C-101 (GRL-008): the first attempt's error would be "progress heartbeats",
    // but after backoff retry exhaustion the final error comes from a retry
    // attempt that received no heartbeats, so it reads "no meaningful stream
    // output". Accept either stall-message variant.
    expect(callbacks.onError.mock.calls[0]?.[0]?.message).toMatch(/progress heartbeats|no meaningful stream output/)
  })

  it("uses heartbeat events to refresh liveness, but still times out after inactivity before the first token", async () => {
    vi.useFakeTimers()

    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "test endless heartbeat before token" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    if (!dataEventName) {
      throw new Error("expected a claude-cli data listener")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"system","subtype":"init","cwd":"D:/QMaiWrite"}',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"working","signature":""}]}}',
    })
    await vi.advanceTimersByTimeAsync(30_001)

    // C-101 (GRL-008): localCliIsolation:true skips isolation retry, so the
    // heartbeat-stall error now enters backoff retry. No further heartbeats on
    // retry attempts, so all 3 retries exhaust before the final error.
    await vi.advanceTimersByTimeAsync((5_000 + 90_000) + (15_000 + 90_000) + (30_000 + 90_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()
    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    // C-101 (GRL-008): first attempt error = "progress heartbeats"; after
    // backoff retry the final error comes from a no-heartbeat retry attempt.
    expect(callbacks.onError.mock.calls[0]?.[0]?.message).toMatch(/progress heartbeats|no meaningful stream output/)
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "claude_cli_kill")).toBe(true)
  })

  it("treats StructuredOutput payloads as meaningful output", async () => {
    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") return undefined
      if (command === "claude_cli_kill") return undefined
      return undefined
    })

    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "structured output" }],
      callbacks,
    )

    await Promise.resolve()
    await Promise.resolve()

    const dataEventName = [...listeners.keys()].find((name) =>
      name.startsWith("claude-cli:") && !name.endsWith(":done"),
    )
    const doneEventName = [...listeners.keys()].find((name) => name.endsWith(":done"))
    if (!dataEventName || !doneEventName) {
      throw new Error("expected claude-cli listeners")
    }

    listeners.get(dataEventName)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"chapterId":"chapter-6","chapterNumber":6}}]}}',
    })
    const doneListener = listeners.get(doneEventName) as unknown as
      | ((event: { payload: { code: number | null; stderr: string } }) => void)
      | undefined
    doneListener?.({ payload: { code: 0, stderr: "" } })

    await expect(resolveWithin(streamPromise, 100)).resolves.toBeUndefined()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith(JSON.stringify({ chapterId: "chapter-6", chapterNumber: 6 }))
  })
})
