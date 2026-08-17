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

import {
  buildPrompt,
  extractCodexCliError,
  parseCodexCliLine,
  streamCodexCli,
} from "./codex-cli-transport"

function codexConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "codex-cli",
    apiKey: "",
    model: "gpt-5-codex",
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

type AnyListener = (event: { payload: string | { code: number | null; stderr: string; stdout?: string } }) => void

function installListeners() {
  const listeners = new Map<string, AnyListener>()
  vi.mocked(listen).mockImplementation(async (eventName, handler) => {
    listeners.set(String(eventName), handler as AnyListener)
    return noopUnlisten
  })
  return listeners
}

function findEvents(listeners: Map<string, AnyListener>) {
  const eventNames = [...listeners.keys()]
  const dataEventName = eventNames.find((n) => n.startsWith("codex-cli:") && !n.endsWith(":done"))
  const doneEventName = eventNames.find((n) => n.endsWith(":done"))
  if (!dataEventName || !doneEventName) {
    throw new Error("expected codex-cli data+done listeners")
  }
  return { dataEventName, doneEventName }
}

function callbacks() {
  return { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(invoke).mockReset()
  vi.mocked(listen).mockReset()
})

describe("parseCodexCliLine", () => {
  it("returns null for blank lines", () => {
    expect(parseCodexCliLine("")).toBeNull()
    expect(parseCodexCliLine("   ")).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    expect(parseCodexCliLine("not json")).toBeNull()
    expect(parseCodexCliLine('{"type":')).toBeNull()
  })

  it("returns null for non-object JSON", () => {
    expect(parseCodexCliLine("42")).toBeNull()
    expect(parseCodexCliLine('"str"')).toBeNull()
  })

  it("returns null for non-item.completed events", () => {
    expect(parseCodexCliLine('{"type":"item.created"}')).toBeNull()
  })

  it("returns null when the item is not an agent_message", () => {
    expect(parseCodexCliLine('{"type":"item.completed","item":{"type":"tool_call","text":"hi"}}')).toBeNull()
    expect(parseCodexCliLine('{"type":"item.completed"}')).toBeNull()
  })

  it("returns null for missing, non-string or empty agent text", () => {
    expect(parseCodexCliLine('{"type":"item.completed","item":{"type":"agent_message"}}')).toBeNull()
    expect(parseCodexCliLine('{"type":"item.completed","item":{"type":"agent_message","text":123}}')).toBeNull()
    expect(parseCodexCliLine('{"type":"item.completed","item":{"type":"agent_message","text":""}}')).toBeNull()
  })

  it("extracts the agent message text", () => {
    expect(parseCodexCliLine('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}')).toBe("hello")
    expect(parseCodexCliLine('  {"type":"item.completed","item":{"type":"agent_message","text":"hi"}}  ')).toBe("hi")
  })
})

describe("extractCodexCliError", () => {
  it("returns the message of a turn.failed event immediately", () => {
    const out = extractCodexCliError('{"type":"turn.failed","message":"provider timeout"}')
    expect(out).toBe("provider timeout")
  })

  it("prefers the nested error.message field", () => {
    const out = extractCodexCliError('{"type":"error","error":{"message":"nested boom"}}')
    expect(out).toBe("nested boom")
  })

  it("keeps the last error event message across lines", () => {
    const out = extractCodexCliError(
      '{"type":"error","message":"first"}\n{"type":"error","message":"second"}\n',
    )
    expect(out).toBe("second")
  })

  it("skips Reconnecting noise and falls back to the raw output", () => {
    const out = extractCodexCliError('{"type":"error","message":"Reconnecting..."}')
    expect(out).toBe('{"type":"error","message":"Reconnecting..."}')
  })

  it("ignores non-JSON lines and empty lines", () => {
    const out = extractCodexCliError("plain text\n\n{\"type\":\"error\",\"message\":\"found\"}\n")
    expect(out).toBe("found")
  })

  it("falls back to trimmed raw output when nothing parses", () => {
    expect(extractCodexCliError("  just text  ")).toBe("just text")
    expect(extractCodexCliError("")).toBe("")
  })
})

describe("buildPrompt", () => {
  it("wraps string content in uppercase ROLE tags", () => {
    const prompt = buildPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])
    expect(prompt).toBe("<USER>\nhi\n</USER>\n\n<ASSISTANT>\nyo\n</ASSISTANT>")
  })

  it("joins content blocks and marks non-text blocks as image-omitted", () => {
    const prompt = buildPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "base64" },
        ],
      },
    ])
    expect(prompt).toBe("<USER>\nlook at this\n[Image omitted: image/png]\n</USER>")
  })

  it("escapes role-like tags in prompt content", () => {
    const prompt = buildPrompt([{ role: "user", content: "use <SYSTEM> and </SYSTEM> tags" }])
    expect(prompt).toContain("use &lt;SYSTEM&gt; and &lt;/SYSTEM&gt; tags")
  })
})

describe("streamCodexCli", () => {
  it("streams agent messages and completes on exit code 0", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)

    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"item.completed","item":{"type":"agent_message","text":"one"}}' })
    listeners.get(dataEventName)!({ payload: '{"type":"item.completed","item":{"type":"agent_message","text":" two"}}' })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onToken).toHaveBeenNthCalledWith(1, "one")
    expect(cb.onToken).toHaveBeenNthCalledWith(2, " two")
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("passes model, prompt and isolation flags to the spawn command", async () => {
    const listeners = installListeners()
    const cb = callbacks()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const streamPromise = streamCodexCli(
      codexConfig({ localCliIsolation: true, codexCliTimeoutMinutes: 7 }),
      [{ role: "user", content: "hi" }],
      cb,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    const spawnCall = vi.mocked(invoke).mock.calls.find(([c]) => c === "codex_cli_spawn")
    expect(spawnCall).toBeDefined()
    const payload = spawnCall?.[1] as Record<string, unknown>
    expect(payload).toMatchObject({
      model: "gpt-5-codex",
      prompt: "<USER>\nhi\n</USER>",
      isolateLocalConfig: true,
      timeoutMinutes: 7,
    })
    expect(payload.streamId).toEqual(expect.any(String))

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
  })

  it("replays agent messages from stdout when none were streamed", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({
      payload: {
        code: 0,
        stderr: "",
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"replayed"}}',
      },
    })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onToken).toHaveBeenCalledWith("replayed")
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("errors when the CLI exits 0 but never emitted an agent_message with raw output", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "", stdout: "some unparseable stdout" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("did not emit an agent_message")
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("some unparseable stdout")
  })

  it("errors with the generic hint when stdout is empty too", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "", stdout: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Run `codex exec --json` in a terminal")
  })

  it("reports a non-zero exit with stderr details", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 2, stderr: " boom " } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("Codex CLI exited with code 2:\nboom")
  })

  it("extracts structured errors from stdout when stderr is empty", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({
      payload: { code: 1, stderr: "", stdout: '{"type":"turn.failed","message":"provider exploded"}' },
    })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("provider exploded")
  })

  it("extracts errors from buffered unparsed lines on non-zero exit", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // Unparsable events are buffered for later error reporting.
    listeners.get(dataEventName)!({ payload: '{"type":"garbage","x":1}' })
    listeners.get(dataEventName)!({ payload: '{"type":"error","message":"buffered boom"}' })
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("buffered boom")
  })

  it("skips buffering empty unparsed payloads", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // Empty payloads parse to null and must not be buffered (empty-trim guard).
    listeners.get(dataEventName)!({ payload: "" })
    listeners.get(dataEventName)!({ payload: "   " })
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "", stdout: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Run `codex` in a terminal to inspect the problem")
  })

  it("tolerates a done event without an explicit stderr field", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    listeners.get(dataEventName)!({ payload: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}' })
    listeners.get(doneEventName)!({ payload: { code: 0 } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("reports a bare non-zero exit when nothing is captured", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    listeners.get(doneEventName)!({ payload: { code: 3, stderr: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Run `codex` in a terminal to inspect the problem")
  })

  it("returns immediately when the signal is already aborted", async () => {
    const cb = callbacks()
    const controller = new AbortController()
    controller.abort()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()

    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
    expect(vi.mocked(listen)).not.toHaveBeenCalled()
  })

  it("kills the subprocess and completes when aborted mid-stream", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codex_cli_kill", expect.objectContaining({ streamId: expect.any(String) }))
  })

  it("swallows kill failures during abort (best-effort teardown)", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "codex_cli_spawn") return undefined
      if (command === "codex_cli_kill") throw new Error("stream already gone")
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("kills the subprocess when aborted while spawn is still pending", async () => {
    const listeners = installListeners()
    const spawn = deferred<undefined>()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "codex_cli_spawn") return spawn.promise
      if (command === "codex_cli_kill") return undefined
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()
    spawn.resolve(undefined)

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    const killCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === "codex_cli_kill")
    expect(killCalls.length).toBeGreaterThanOrEqual(1)
  })

  it("swallows kill failures when aborting during a pending spawn", async () => {
    const listeners = installListeners()
    const spawn = deferred<undefined>()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "codex_cli_spawn") return spawn.promise
      if (command === "codex_cli_kill") throw new Error("kill failed")
      return undefined
    })
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    controller.abort()
    spawn.resolve(undefined)

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it("returns after cleanup when aborted during listener setup", async () => {
    const firstListen = deferred<() => void>()
    vi.mocked(listen).mockImplementation(async () => firstListen.promise)
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    controller.abort()
    firstListen.resolve(noopUnlisten)
    await Promise.resolve()
    await Promise.resolve()

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "codex_cli_spawn")).toBe(false)
  })

  it("returns after cleanup when aborted while the done listener is still pending", async () => {
    const doneListen = deferred<() => void>()
    let listenCall = 0
    vi.mocked(listen).mockImplementation(async () => {
      listenCall += 1
      return listenCall === 1 ? noopUnlisten : doneListen.promise
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()
    const controller = new AbortController()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    doneListen.resolve(noopUnlisten)
    await Promise.resolve()
    await Promise.resolve()

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "codex_cli_spawn")).toBe(false)
  })

  it("maps missing-binary spawn failures to an install hint", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockRejectedValue(new Error("spawn codex ENOENT: executable file not found"))
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("Codex CLI not found")
    expect(cb.onError.mock.calls[0]?.[0]?.message).toContain("npm install -g @openai/codex")
  })

  it("surfaces generic spawn failures verbatim", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockRejectedValue(new Error("provider is misconfigured"))
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("provider is misconfigured")
  })

  it("handles non-Error spawn rejections by stringifying them", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockRejectedValue("spawn exploded with a string")
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    findEvents(listeners)

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("spawn exploded with a string")
  })

  it("handles a rejected listener setup as an error", async () => {
    vi.mocked(listen).mockRejectedValue(new Error("tauri event bus down"))
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError.mock.calls[0]?.[0]?.message).toBe("tauri event bus down")
  })

  it("warns about unsupported overrides in dev mode", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const streamPromise = streamCodexCli(
      codexConfig(),
      [{ role: "user", content: "hi" }],
      cb,
      undefined,
      { temperature: 0.5, max_tokens: 100 } as never,
    )
    await Promise.resolve()
    await Promise.resolve()
    const { doneEventName } = findEvents(listeners)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unsupported override "temperature"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unsupported override "max_tokens"'))

    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })
    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
  })

  it("ignores unparsed events after the 4096-byte buffer cap without crashing", async () => {
    const listeners = installListeners()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const cb = callbacks()

    const streamPromise = streamCodexCli(codexConfig(), [{ role: "user", content: "hi" }], cb)
    await Promise.resolve()
    await Promise.resolve()
    const { dataEventName, doneEventName } = findEvents(listeners)

    // ~140 bytes per event; 60 events exceed the 4096 cap.
    for (let i = 0; i < 60; i++) {
      listeners.get(dataEventName)!({ payload: `{"type":"garbage","index":${i},"padding":"${"x".repeat(100)}"}` })
    }
    listeners.get(doneEventName)!({ payload: { code: 1, stderr: "" } })

    await expect(resolveWithin(streamPromise, 200)).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledTimes(1)
  })
})
