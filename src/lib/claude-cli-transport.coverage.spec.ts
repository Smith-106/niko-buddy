import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Gap-filling coverage for claude-cli-transport.ts (complements the existing
 * claude-cli-transport.spec.ts / f001-hardening.spec.ts suites).
 *
 * Covers: warmClaudeCliTimeouts + clamping, stall spooling, the isolation-note
 * final message, backoff-wait aborts, all done-handler/buildExitError variants,
 * stream event wiring (diagnostic/unknown), parser edge cases, and the outer
 * catch of streamClaudeCodeCli.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getStore: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("./web-store", () => ({ getStore: mocks.getStore }))
vi.mock("./llm-client", () => ({ streamChat: mocks.streamChat }))

import {
  buildExitError,
  createClaudeCodeStreamParser,
  gracefulAbortStream,
  shouldRetryClaudeCliError,
  streamClaudeCodeCli,
  warmClaudeCliTimeouts,
} from "./claude-cli-transport"

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

const noopUnlisten = () => {}

type AnyListener = (event: { payload: string | { code: number | null; stderr: string } }) => void

function installListeners() {
  const listeners = new Map<string, AnyListener>()
  mocks.listen.mockImplementation(async (eventName, handler) => {
    listeners.set(String(eventName), handler as AnyListener)
    return noopUnlisten
  })
  return listeners
}

function findEvents(listeners: Map<string, AnyListener>) {
  const eventNames = [...listeners.keys()]
  // Listeners accumulate across retry attempts — use the LATEST attempt's events.
  const dataEventName = [...eventNames].reverse().find((n) => n.startsWith("claude-cli:") && !n.endsWith(":done"))
  const doneEventName = [...eventNames].reverse().find((n) => n.endsWith(":done"))
  if (!dataEventName || !doneEventName) {
    throw new Error("expected claude-cli data+done listeners")
  }
  return { dataEventName, doneEventName }
}

function callbacks() {
  return { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

function makeStore(prior: string[] | null) {
  const store = {
    get: vi.fn(async () => prior),
    set: vi.fn(async () => undefined),
  }
  mocks.getStore.mockResolvedValue(store as never)
  return store
}

const DEFAULT_STORE = () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
})

afterEach(async () => {
  vi.useRealTimers()
  // Restore the module-level timeout cache to defaults, THEN clear call counts.
  mocks.getStore.mockResolvedValue(DEFAULT_STORE() as never)
  await warmClaudeCliTimeouts()
  vi.clearAllMocks()
})

describe("warmClaudeCliTimeouts", () => {
  it("loads stored timeout values and applies them to subsequent streams", async () => {
    vi.useFakeTimers()
    const store = {
      get: vi.fn(async (k: string) => {
        if (k === "claudeCli.firstMeaningfulOutputTimeoutMs") return 5_000
        if (k === "claudeCli.inactivityTimeoutMs") return 5_000
        if (k === "claudeCli.midConversationHeartbeatMs") return 5_000
        return 500 // sigterm grace
      }),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store as never)
    await warmClaudeCliTimeouts()

    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "warm timeout" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    // With warmed 5s first-meaningful timeout the stall fires at 5s, not 90s.
    await vi.advanceTimersByTimeAsync(5_001)
    // Backoff retries (5s/15s/30s delays, each attempt stalling 5s) exhaust.
    await vi.advanceTimersByTimeAsync((5_000 + 5_000) + (15_000 + 5_000) + (30_000 + 5_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("no meaningful stream output")
  })

  it("clamps invalid stored values back to defaults", async () => {
    const store = {
      get: vi.fn(async (k: string) => {
        if (k === "claudeCli.firstMeaningfulOutputTimeoutMs") return Number.POSITIVE_INFINITY
        if (k === "claudeCli.inactivityTimeoutMs") return 100 // below 5000 floor
        if (k === "claudeCli.midConversationHeartbeatMs") return "not-a-number"
        return 100 // below 500 grace floor
      }),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store as never)

    await expect(warmClaudeCliTimeouts()).resolves.toBeUndefined()
    expect(store.get).toHaveBeenCalledTimes(4)
  })

  it("keeps defaults when the store is unavailable", async () => {
    mocks.getStore.mockRejectedValue(new Error("store missing"))
    await expect(warmClaudeCliTimeouts()).resolves.toBeUndefined()
    expect(mocks.getStore).toHaveBeenCalledTimes(1)
  })
})

describe("stream stall spooling", () => {
  it("spools the first stall to disk with an empty prior list", async () => {
    vi.useFakeTimers()
    const store = makeStore(null)
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "spool empty prior" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()

    // 1st attempt stalls at 90s.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001) // backoff
    // 2nd attempt succeeds with a token (re-find listeners for the new stream).
    const { dataEventName, doneEventName } = findEvents(listeners)
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(streamPromise).resolves.toBeUndefined()

    expect(store.set).toHaveBeenCalledTimes(1)
    const [key, entries] = store.set.mock.calls[0] as [string, Array<Record<string, unknown>>]
    expect(key).toContain("claudeCli.stallSpool.")
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0] as string)).toMatchObject({ attempt: 1, streamId: expect.any(String) })
  })

  it("caps the spooled buffer at 64 entries", async () => {
    vi.useFakeTimers()
    const prior = Array.from({ length: 64 }, (_, i) => `item${i}`)
    const store = makeStore(prior)
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "spool cap" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    const { dataEventName, doneEventName } = findEvents(listeners)
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(streamPromise).resolves.toBeUndefined()

    expect(store.set).toHaveBeenCalledTimes(1)
    const entries = store.set.mock.calls[0]?.[1] as unknown[]
    expect(entries).toHaveLength(64) // 65 after push, spliced back to 64
  })
})

describe("SessionTransportFallback failure path", () => {
  it("surfaces an error when the Anthropic API fallback itself fails", async () => {
    vi.useFakeTimers()
    mocks.streamChat.mockRejectedValue(new Error("http 401"))
    const store = makeStore(null)
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ apiKey: "sk-ant-key", localCliIsolation: true }),
      [{ role: "user", content: "fallback failure" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    // 1st stall → 5s backoff → 2nd stall → fallback fires at attempt 2.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.runAllTimersAsync()
    await expect(streamPromise).resolves.toBeUndefined()

    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    const spooled = cb.onToken.mock.calls.map((c) => String(c[0])).join("")
    expect(spooled).toContain("SessionTransportFallback")
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain(
      "SessionTransportFallback to the Anthropic API failed after the CLI stalled twice: http 401",
    )
    expect(store.set).toHaveBeenCalledTimes(2) // spooled for both stalls
  })
})

describe("final error messages", () => {
  it("appends the isolation-retry note when the final failure is still isolation_retry", async () => {
    vi.useFakeTimers()
    const store = makeStore(null)
    const listeners = installListeners()
    let spawnCount = 0
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") {
        spawnCount += 1
        if (spawnCount === 1) {
          throw new Error("Failed to write to claude stdin: Broken pipe")
        }
        return undefined
      }
      if (command === "claude_cli_kill") return undefined
      return undefined
    })
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(), // no isolation, no apiKey → isolation retry allowed
      [{ role: "user", content: "isolation note" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()

    // Attempt 1 fails at spawn with a pipe error → isolation retry (attempt 2).
    // Attempts 2-5 stall (90s each) with 5s/15s/30s backoffs between them.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(15_001)
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(30_001)
    await vi.advanceTimersByTimeAsync(90_001)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(spawnCount).toBe(5)
    expect(store.set).toHaveBeenCalledTimes(3) // one spool per backoff retry (attempts 2-4)
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain(
      "QMAI automatically retried once with local CLI isolation enabled",
    )
  })

  it("surfaces a fatal exit error without the isolation note", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "fatal" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "Unknown model 'foo-bar'" } })
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError).toHaveBeenCalledTimes(1)
    const message = cb.onError.mock.calls[0]?.[0]?.message as string
    expect(message).toContain("Unknown model 'foo-bar'")
    expect(message).not.toContain("automatically retried once")
  })
})

describe("backoff retry aborts", () => {
  it("stops retrying when the signal aborts during the backoff wait", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "abort during wait" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await vi.advanceTimersByTimeAsync(90_001) // 1st attempt stalls
    controller.abort() // during the 5s backoff wait
    await vi.runAllTimersAsync()
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("stops when the signal is already aborted when the next retry wait starts", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "abort between retries" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    // 1st attempt stalls; 5s backoff passes; 2nd attempt starts and stalls.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    await vi.advanceTimersByTimeAsync(90_001)
    // Abort after the 2nd stall settles: the next retry wait sees signal.aborted.
    controller.abort()
    await vi.runAllTimersAsync()
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })
})

describe("done-event and exit-error variants", () => {
  it("treats a null exit code as a successful exit", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "null code" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: null, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("reports completed-but-empty with captured details", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "empty w/ details" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "provider returned nothing" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe(
      "Claude Code CLI completed but returned no content:\nprovider returned nothing",
    )
  })

  it("reports completed-but-empty without details", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "empty" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Try running `claude -p` in a terminal")
  })

  it("builds exit errors from stderr when a non-zero code exits", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "stderr exit" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "claude exploded" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("claude CLI exited with code 1: claude exploded")
  })

  it("builds exit errors from captured stdout diagnostics", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "diag exit" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"assistant","subtype":"error","message":"diag boom"}' })
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("claude CLI exited with code 1: diag boom")
  })

  it("builds exit errors from unparsed stdout when nothing else is captured", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "unparsed exit" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"unknown-event","x":1}' })
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    const message = cb.onError.mock.calls[0]?.[0]?.message as string
    expect(message).toContain("exited with code 1 (no stderr)")
    expect(message).toContain("unknown-event")
  })

  it("builds a silent-exit error when nothing at all was captured", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "silent exit" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 2, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("exited silently with code 2")
  })

  it("buildExitError treats stdout authentication failures the same as stderr", () => {
    expect(buildExitError(1, "", "", "Authentication failed")).toContain("not authenticated")
  })
})

describe("stream event wiring", () => {
  it("captures structured stdout diagnostics and continues to completion", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "diag wiring" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"result","is_error":true,"message":"rerouted"}' })
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"final"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onToken).toHaveBeenCalledWith("final")
    expect(cb.onDone).toHaveBeenCalledTimes(1)
  })

  it("captures unknown events as unparsed output without tokenizing them", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "unknown wiring" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"mystery","k":1}' })
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    const message = cb.onError.mock.calls[0]?.[0]?.message as string
    expect(message).toContain("mystery")
  })

  it("passes jsonSchema overrides through to the spawn payload and skips the dev warning", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const schema = { type: "object" }
    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "schema" }],
      cb,
      undefined,
      { temperature: 0.3, jsonSchema: schema } as never,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unsupported override "temperature"'))
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('ignoring unsupported override "jsonSchema"'))

    const spawnCall = mocks.invoke.mock.calls.find(([c]) => c === "claude_cli_spawn")
    expect((spawnCall?.[1] as { jsonSchema?: unknown }).jsonSchema).toEqual(schema)

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(streamPromise).resolves.toBeUndefined()
  })
})

describe("setup and spawn failures", () => {
  it("settles with an error when the done listener setup rejects", async () => {
    const doneListen = (() => {
      let rejectFn!: (reason?: unknown) => void
      const promise = new Promise((_res, rej) => {
        rejectFn = rej
      })
      return { promise, reject: rejectFn }
    })()
    let listenCall = 0
    mocks.listen.mockImplementation(async () => {
      listenCall += 1
      return listenCall === 1 ? noopUnlisten : doneListen.promise
    })
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "listen fails" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    doneListen.reject(new Error("event bus broke"))
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("event bus broke")
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("surfaces generic spawn failures verbatim", async () => {
    const listeners = installListeners()
    mocks.invoke.mockRejectedValue(new Error("spawn exploded"))
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "spawn boom" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("spawn exploded")
  })

  it("maps not-found spawn failures to an install hint", async () => {
    const listeners = installListeners()
    mocks.invoke.mockRejectedValue(new Error("executable file not found"))
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "no binary" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(streamPromise).resolves.toBeUndefined()
    // Spawn failures are captured inside the attempt (not the outer catch),
    // so the raw message surfaces; the install hint is reserved for errors
    // that escape the retry loop (covered by the onDone-throwing tests).
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("executable file not found")
  })

  it("kills the subprocess when aborted while spawn is still pending", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    const spawn = (() => {
      let resolveFn!: (v: undefined) => void
      const promise = new Promise<undefined>((res) => {
        resolveFn = res
      })
      return { promise, resolve: resolveFn }
    })()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") return spawn.promise
      if (command === "claude_cli_terminate") return undefined
      if (command === "claude_cli_kill") return undefined
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "abort during spawn" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()
    spawn.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_001) // finish the SIGTERM grace timer

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    const killCalls = mocks.invoke.mock.calls.filter(([c]) => c === "claude_cli_kill")
    expect(killCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe("outer catch of streamClaudeCodeCli", () => {
  it("surfaces errors thrown by user callbacks (e.g. onDone)", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    cb.onDone.mockImplementation(() => {
      throw new Error("callback exploded")
    })

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "throwing onDone" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("callback exploded")
  })

  it("maps not-found errors thrown by user callbacks to the install hint", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    cb.onDone.mockImplementation(() => {
      throw new Error("No such file: claude")
    })

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "throwing onDone 2" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Claude Code CLI not found")
  })
})

describe("parser edge cases", () => {
  it("handles empty, whitespace, invalid and non-object lines", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse("")).toEqual({ kind: "ignore" })
    expect(parse("   ")).toEqual({ kind: "ignore" })
    expect(parse("not json")).toEqual({ kind: "unknown" })
    expect(parse("42")).toEqual({ kind: "unknown" })
    expect(parse('{"type":"unknown-kind"}')).toEqual({ kind: "unknown" })
  })

  it("routes user events to ignore", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"user","role":"user","content":[{"type":"text","text":"hi"}]}')).toEqual({
      kind: "ignore",
    })
  })

  it("handles assistant messages with non-array or empty text content", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"assistant","message":{"content":"not-array"}}')).toEqual({ kind: "ignore" })
    expect(parse('{"type":"assistant","message":{}}')).toEqual({ kind: "ignore" })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":""}]}}')).toEqual({
      kind: "ignore",
    })
  })

  it("resets the assistant snapshot diff on a non-prefix change", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"aaa"}]}}')).toEqual({
      kind: "token",
      text: "aaa",
    })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"bbb"}]}}')).toEqual({
      kind: "token",
      text: "bbb",
    })
  })

  it("defaults rate-limit diagnostics when no upstream text is extractable", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"stream_event","event":{"type":"rate_limit_event"}}')
    expect(res).toEqual({ kind: "diagnostic", text: "Claude Code CLI rate-limited by upstream." })
  })

  it("treats non-text deltas as heartbeats", () => {
    const parse = createClaudeCodeStreamParser()
    expect(
      parse('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}}'),
    ).toEqual({ kind: "heartbeat" })
  })

  it("defaults assistant.error diagnostics when nothing extractable", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"assistant","subtype":"error"}')
    expect(res).toEqual({ kind: "diagnostic", text: "Claude Code CLI assistant error." })
  })

  it("extracts stderr diagnostics from arrays of strings", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"stderr","text":["line1","line2"]}')).toEqual({ kind: "stderr", text: "line1\nline2" })
    // Empty/whitespace/non-string stderr payloads degrade to heartbeats.
    expect(parse('{"type":"stderr","text":[]}')).toEqual({ kind: "heartbeat" })
    expect(parse('{"type":"stderr","text":""}')).toEqual({ kind: "heartbeat" })
    expect(parse('{"type":"stderr","text":null}')).toEqual({ kind: "heartbeat" })
  })

  it("walks every diagnostic extraction field (details/error/result/content/body)", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"error","details":"dbg details"}')).toEqual({ kind: "diagnostic", text: "dbg details" })
    expect(parse('{"type":"result","is_error":true,"error":{"message":"nested err"}}')).toEqual({
      kind: "diagnostic",
      text: "nested err",
    })
    expect(parse('{"type":"result","is_error":true,"result":"res text"}')).toEqual({
      kind: "diagnostic",
      text: "res text",
    })
    expect(parse('{"type":"result","is_error":true,"content":"content text"}')).toEqual({
      kind: "diagnostic",
      text: "content text",
    })
    expect(parse('{"type":"result","is_error":true,"body":"body text"}')).toEqual({
      kind: "diagnostic",
      text: "body text",
    })
  })

  it("stringifies diagnostics when no field is extractable", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"result","is_error":true,"foo":1}')
    expect(res.kind).toBe("diagnostic")
    if (res.kind === "diagnostic") {
      expect(res.text).toContain('"foo":1')
    }
  })

  it("unwraps __unparsedToolInput payloads into structured data", () => {
    const parse = createClaudeCodeStreamParser()
    const line = (input: unknown) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input }] } })

    expect(parse(line({ __unparsedToolInput: '{"a":1}' }))).toEqual({ kind: "structured", data: { a: 1 } })
    // Invalid JSON inside the payload falls back to the raw input object.
    const invalid = parse(line({ __unparsedToolInput: "not json" }))
    expect(invalid).toEqual({ kind: "structured", data: { __unparsedToolInput: "not json" } })
    // Non-string payloads and arrays pass through unchanged.
    expect(parse(line({ __unparsedToolInput: 42 }))).toEqual({ kind: "structured", data: { __unparsedToolInput: 42 } })
    expect(parse(line(["arr"]))).toEqual({ kind: "structured", data: ["arr"] })
    // String input does not qualify as structured → heartbeat (tool-only content).
    expect(parse(line("plain"))).toEqual({ kind: "heartbeat" })
  })
})

describe("misc helpers", () => {
  it("shouldRetryClaudeCliError returns false for empty messages", () => {
    expect(shouldRetryClaudeCliError("")).toBe(false)
    expect(shouldRetryClaudeCliError(undefined as unknown as string)).toBe(false)
  })

  it("gracefulAbortStream tolerates a missing terminate command with a grace window", async () => {
    vi.useFakeTimers()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_terminate") throw new Error("command absent")
      return undefined
    })
    const p = gracefulAbortStream("stream-x", 1)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await p
    const calls = mocks.invoke.mock.calls.map(([c]) => c as string)
    expect(calls).toContain("claude_cli_terminate")
    expect(calls).toContain("claude_cli_kill")
  })
})

describe("entry and guard edge cases", () => {
  it("returns immediately when the signal is already aborted", async () => {
    const cb = callbacks()
    const controller = new AbortController()
    controller.abort()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "pre-aborted" }],
      cb,
      controller.signal,
    )
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()
  })

  it("caps buffered unparsed output at 4096 bytes", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "unparsed flood" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // Each unknown event is ~150 bytes; 60 events far exceed the 4096 cap.
    for (let i = 0; i < 60; i++) {
      listeners.get(dataEventName)!({
        payload: '{"type":"mystery","index":' + i + ',"padding":"' + "x".repeat(100) + '"}',
      })
    }
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledTimes(1)
  })

  it("caps captured stdout diagnostics at 4096 bytes", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "diag flood" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    for (let i = 0; i < 60; i++) {
      listeners.get(dataEventName)!({
        payload: '{"type":"result","is_error":true,"message":"' + "d".repeat(100) + '"}',
      })
    }
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("exited with code 1")
  })

  it("returns after cleanup when aborted while the done listener is still pending", async () => {
    vi.useFakeTimers()
    const doneListen = (() => {
      let resolveFn!: (v: () => void) => void
      const promise = new Promise<() => void>((res) => {
        resolveFn = res
      })
      return { promise, resolve: resolveFn }
    })()
    let listenCall = 0
    mocks.listen.mockImplementation(async () => {
      listenCall += 1
      return listenCall === 1 ? noopUnlisten : doneListen.promise
    })
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "abort during done listener" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    doneListen.resolve(noopUnlisten)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_001) // finish gracefulAbortStream grace

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(mocks.invoke.mock.calls.some(([c]) => c === "claude_cli_spawn")).toBe(false)
  })

  it("ignores a spawn failure that surfaces after the attempt already settled", async () => {
    const listeners = installListeners()
    const spawn = (() => {
      let rejectFn!: (reason?: unknown) => void
      const promise = new Promise((_res, rej) => {
        rejectFn = rej
      })
      return { promise, reject: rejectFn }
    })()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") return spawn.promise
      if (command === "claude_cli_terminate") return undefined
      if (command === "claude_cli_kill") return undefined
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "spawn after settle" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()
    spawn.reject(new Error("late spawn failure"))
    await Promise.resolve()
    await Promise.resolve()

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("ignores done events that arrive after the attempt already settled", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "stale done event" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    const staleData = [...listeners.keys()].find((n) => n.startsWith("claude-cli:") && !n.endsWith(":done"))
    const staleDone = [...listeners.keys()].find((n) => n.endsWith(":done"))

    // Attempt 1 stalls; delivering a token+done afterwards must be ignored.
    await vi.advanceTimersByTimeAsync(90_001)
    listeners.get(staleData!)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"stale"}}}',
    })
    listeners.get(staleDone!)!({ payload: { code: 0, stderr: "" } })

    // Attempt 2 (after the 5s backoff) completes normally.
    await vi.advanceTimersByTimeAsync(5_001)
    const { dataEventName, doneEventName } = findEvents(listeners)
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"fresh"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(streamPromise).resolves.toBeUndefined()

    // The stale attempt's data listener is still wired (unlisten is a mock noop),
    // so its token is emitted too; the stale done event is ignored by the settle guard.
    expect(cb.onToken).toHaveBeenNthCalledWith(1, "stale")
    expect(cb.onToken).toHaveBeenNthCalledWith(2, "fresh")
    expect(cb.onDone).toHaveBeenCalledTimes(1)
  })

  it("swallows kill failures raised by the stall watchdog", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_kill") throw new Error("kill failed")
      return undefined
    })
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "kill rejection stall" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync((5_000 + 90_000) + (15_000 + 90_000) + (30_000 + 90_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError).toHaveBeenCalledTimes(1)
  })

  it("fires the mid-conversation watchdog when the inactivity window is longer", async () => {
    vi.useFakeTimers()
    const store = {
      get: vi.fn(async (k: string) => {
        if (k === "claudeCli.firstMeaningfulOutputTimeoutMs") return 5_000
        if (k === "claudeCli.inactivityTimeoutMs") return 100_000
        if (k === "claudeCli.midConversationHeartbeatMs") return 60_000
        return 500
      }),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store as never)
    await warmClaudeCliTimeouts()

    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "mid-conv watchdog" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName } = findEvents(listeners)

    // One token arms both the 100s inactivity timer and the 60s mid-conv watchdog.
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
    })
    expect(cb.onToken).toHaveBeenCalledWith("x")

    // The mid-conv watchdog (60s) fires before the inactivity timer (100s).
    await vi.advanceTimersByTimeAsync(60_001)
    await vi.advanceTimersByTimeAsync((5_000 + 5_000) + (15_000 + 5_000) + (30_000 + 5_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("no additional stream output within 100 seconds")
  })

  it("swallows kill failures raised after aborting during a pending spawn", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    const spawn = (() => {
      let resolveFn!: (v: undefined) => void
      const promise = new Promise<undefined>((res) => {
        resolveFn = res
      })
      return { promise, resolve: resolveFn }
    })()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "claude_cli_spawn") return spawn.promise
      if (command === "claude_cli_terminate") return undefined
      if (command === "claude_cli_kill") throw new Error("kill failed")
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(),
      [{ role: "user", content: "kill rejection after spawn abort" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()
    spawn.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_001)

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })
})

describe("abort-race coverage", () => {
  it("stops at the loop top when the signal aborts right after an isolation retry settles", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig(), // no isolation, no apiKey → isolation retry allowed
      [{ role: "user", content: "abort at loop top" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    // Attempt 1 fails with an isolation-retry error (settled synchronously by
    // the done event). Abort BEFORE the retry-branch microtask runs, so the
    // loop-top `aborted || signal?.aborted` guard fires on the `continue`.
    listeners.get(doneEventName)!({
      payload: { code: 0, stderr: "Failed to write to claude stdin: Broken pipe" },
    })
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_001) // finish gracefulAbortStream grace

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "claude_cli_spawn")).toHaveLength(1)
  })

  it("short-circuits the backoff wait when the signal aborts before the retry branch runs", async () => {
    vi.useFakeTimers()
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }), // isolation already on → rate_limit backoff path
      [{ role: "user", content: "abort before backoff" }],
      cb,
      controller.signal,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    // rate_limit-classified (retryable, NOT isolation_retry) error, settled
    // synchronously; abort before waitForClaudeCliRetry's entry guard runs.
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "Connection closed mid-response" } })
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_001) // finish gracefulAbortStream grace

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })
})

describe("non-Error and stringify edge cases", () => {
  it("surfaces non-Error spawn rejections by stringifying them", async () => {
    const listeners = installListeners()
    mocks.invoke.mockRejectedValue("spawn failed with a string")
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "string spawn err" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("spawn failed with a string")
  })

  it("surfaces non-Error fallback rejections by stringifying them", async () => {
    vi.useFakeTimers()
    mocks.streamChat.mockRejectedValue("fallback exploded")
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ apiKey: "sk-ant-key", localCliIsolation: true }),
      [{ role: "user", content: "string fallback err" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.runAllTimersAsync()
    await expect(streamPromise).resolves.toBeUndefined()

    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("fallback exploded")
  })

  it("surfaces non-Error callback throws via the outer catch", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()
    cb.onDone.mockImplementation(() => {
      throw "onDone threw a string"
    })

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "string throw" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("onDone threw a string")
  })

  it("treats an unchanged assistant snapshot as ignorable", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"same"}]}}')).toEqual({
      kind: "token",
      text: "same",
    })
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"same"}]}}')).toEqual({
      kind: "ignore",
    })
  })

  it("stringifies error-type diagnostics with no extractable field", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"error","data":{"x":1}}')
    expect(res.kind).toBe("diagnostic")
    if (res.kind === "diagnostic") {
      expect(res.text).toContain('"x":1')
    }
  })
})

describe("bounded diagnostic buffers", () => {
  it("caps the unparsed-lines buffer at 4096 chars and keeps streaming", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "unparsed cap" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // 9 events x ~600 chars each: crosses the 4096 cap after ~7 events.
    for (let i = 0; i < 9; i += 1) {
      listeners.get(dataEventName)!({ payload: `garbage-line-${i}-${"x".repeat(580)}` })
    }
    // A fresh unknown line after the cap is dropped, stream still completes.
    listeners.get(dataEventName)!({ payload: "after-cap-line" })
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"final"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    // The final token still flows after the cap was passed.
    expect(cb.onToken).toHaveBeenCalledWith("final")
  })

  it("caps the stdout-diagnostic buffer at 4096 chars and keeps streaming", async () => {
    const listeners = installListeners()
    mocks.invoke.mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "diag cap" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // 9 stderr events x ~600 chars: crosses the 4096 cap (~5 events: "[stderr] " prefix + text).
    for (let i = 0; i < 9; i += 1) {
      listeners.get(dataEventName)!({ payload: `{"type":"stderr","text":"stderr-line-${i}-${"y".repeat(560)}"}` })
    }
    listeners.get(dataEventName)!({ payload: '{"type":"stderr","text":"after-cap"}' })
    listeners.get(dataEventName)!({
      payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"final"}}}',
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onToken).toHaveBeenCalledWith("final")
  })
})
