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
// F-001 (ANL-010): stub the F-004 fallback target so SessionTransportFallback
// tests can assert the reroute happens without pulling the real HTTP path.
vi.mock("./llm-client", () => ({
  streamChat: vi.fn().mockResolvedValue(undefined),
}))

import {
  createClaudeCodeStreamParser,
  gracefulAbortStream,
  streamClaudeCodeCli,
} from "./claude-cli-transport"
import { streamChat } from "./llm-client"

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

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(invoke).mockReset()
  vi.mocked(listen).mockReset()
  vi.mocked(streamChat).mockReset()
})

/**
 * F-001 (ANL-010) — CLI transport hardening. 8 tests covering the 5 root-cause
 * fixes: (1) SIGTERM grace, (2) bounded stdout [Rust, covered by cargo build],
 * (3) 3rd mid-conversation heartbeat watchdog, (4) dispatch table refactor,
 * (5) backpressure spool + SessionTransportFallback.
 */
describe("F-001 dispatch table — new stream-event subtypes", () => {
  it("rate_limit_event surfaces as a diagnostic (Fix 4 + backpressure signal)", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"stream_event","event":{"type":"rate_limit_event","message":"slow_down"}}')
    expect(res.kind).toBe("diagnostic")
    if (res.kind === "diagnostic") {
      expect(res.text).toMatch(/rate/i)
    }
  })

  it("assistant.error events surface as diagnostics (Fix 4)", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"assistant","subtype":"error","message":"upstream 500"}')
    expect(res.kind).toBe("diagnostic")
  })

  it("stop_reason events are heartbeats, not unknown (Fix 4)", () => {
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"stop_reason","stop_reason":"end_turn"}')
    expect(res).toEqual({ kind: "heartbeat" })
  })

  it("stdout-buffer-overflow marker surfaces as a diagnostic (Fix 2 + Fix 4)", () => {
    // Emitted by the Rust bounded-buffer guard (claude_cli.rs
    // CLAUDE_STDOUT_LIMIT_BYTES) when stdout crosses the 64MB cap. The
    // transport must recognize it so SessionTransportFallback can fire.
    const parse = createClaudeCodeStreamParser()
    const res = parse('{"type":"stdout-buffer-overflow"}')
    expect(res.kind).toBe("diagnostic")
    if (res.kind === "diagnostic") {
      expect(res.text).toContain("stdout-buffer-overflow")
    }
  })
})

describe("F-001 SIGTERM grace (Fix 1)", () => {
  it("gracefulAbortStream calls terminate THEN kill after the grace window", async () => {
    vi.useFakeTimers()
    vi.mocked(invoke).mockResolvedValue(undefined)

    // Don't await the full promise yet — it resolves after the grace setTimeout.
    const p = gracefulAbortStream("stream-1", 4_000)

    // Synchronous microtasks: terminate should have been called immediately.
    await Promise.resolve()
    await Promise.resolve()
    const callsSoFar = vi.mocked(invoke).mock.calls.map(([c]) => c as string)
    expect(callsSoFar).toContain("claude_cli_terminate")
    // Kill has NOT happened yet — we're still in the grace window.
    expect(callsSoFar).not.toContain("claude_cli_kill")

    // Advance past the grace window → kill fires.
    await vi.advanceTimersByTimeAsync(4_001)
    await p
    const allCalls = vi.mocked(invoke).mock.calls.map(([c]) => c as string)
    expect(allCalls).toContain("claude_cli_kill")
    // Order: terminate before kill (grace, not hard-first).
    const termIdx = allCalls.indexOf("claude_cli_terminate")
    const killIdx = allCalls.indexOf("claude_cli_kill")
    expect(killIdx).toBeGreaterThan(termIdx)
  })

  it("gracefulAbortStream swallows Rust errors (best-effort, never throws)", async () => {
    vi.useFakeTimers()
    vi.mocked(invoke).mockRejectedValue(new Error("command absent on old build"))
    // Must not reject — the transport's recovery path must never block on a
    // Rust-side failure.
    await expect(gracefulAbortStream("stream-2", 0)).resolves.toBeUndefined()
  })
})

describe("F-001 3rd watchdog — mid-conversation heartbeat (Fix 3)", () => {
  it("does NOT arm before the first meaningful token (cold-start exempt)", async () => {
    // The mid-conversation watchdog only arms after sawMeaningfulOutput. A
    // pre-first-token stall must trip the FIRST_MEANINGFUL watchdog, not the
    // mid-conv one. We verify by feeding only heartbeats and asserting the
    // error message names the first-token timeout, not mid-conversation.
    vi.useFakeTimers()
    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "cold start stall" }],
      callbacks,
    )
    await Promise.resolve()
    await Promise.resolve()

    const dataName = [...listeners.keys()].find((n) => n.startsWith("claude-cli:") && !n.endsWith(":done"))!
    // Pure heartbeats — no token. sawMeaningfulOutput stays false.
    listeners.get(dataName)!({ payload: '{"type":"system","subtype":"thinking_tokens","estimated_tokens":42}' })

    // Advance past the 90s first-token timeout + full retry chain.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync((5_000 + 90_000) + (15_000 + 90_000) + (30_000 + 90_000) + 1_000)
    await expect(streamPromise).resolves.toBeUndefined()

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    // The first-token watchdog fired, NOT mid-conversation.
    expect(callbacks.onError.mock.calls[0]?.[0]?.message).toContain("no meaningful stream output")
  })

  it("CORR-001: does NOT trip mid-conversation watchdog when tokens flow steadily (<60s apart)", async () => {
    // Regression: the mid-conversation watchdog was armed only on the FIRST
    // token and never rearmed, so any stream longer than 60s with spaced
    // tokens false-stalled. After the fix, every token rearms the watchdog,
    // so a steady 1-token-per-30s stream must run indefinitely without
    // tripping the 60s mid-conversation watchdog.
    vi.useFakeTimers()
    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ localCliIsolation: true }),
      [{ role: "user", content: "long steady stream" }],
      callbacks,
    )
    await Promise.resolve()
    await Promise.resolve()

    const dataName = [...listeners.keys()].find((n) => n.startsWith("claude-cli:") && !n.endsWith(":done"))!
    // First token — arms the mid-conversation watchdog.
    listeners.get(dataName)!({ payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}' })
    expect(callbacks.onToken).toHaveBeenCalledWith("hello")

    // Emit a token every 20s for 4 minutes. Each token resets BOTH the 30s
    // inactivity timer AND the 60s mid-conversation watchdog, so neither
    // trips. Pre-fix the mid-conv watchdog was armed once at the first token
    // and never rearmed, so it would have false-stalled at t=60s even though
    // tokens kept flowing. (20s < 30s inactivity, so the inactivity timer
    // also stays reset.)
    for (let t = 0; t < 12; t++) {
      await vi.advanceTimersByTimeAsync(20_000)
      listeners.get(dataName)!({ payload: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}' })
    }
    // 4 minutes of steady tokens — no error, no kill, stream still alive.
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    // 13 tokens total (1 initial + 12 in the loop).
    expect(callbacks.onToken).toHaveBeenCalledTimes(13)

    // Complete the stream cleanly so the promise resolves (no dangling async).
    const doneName = [...listeners.keys()].find((n) => n.endsWith(":done"))!
    listeners.get(doneName)!({ payload: JSON.stringify({ code: 0, stderr: "" }) })
    await expect(streamPromise).resolves.toBeUndefined()
  })
})

/**
 * TS-02: stall-detection reproducing the S2 Chapter-12 deterministic failure
 * loop and verifying SessionTransportFallback reroutes to the F-004 anthropic
 * HTTP path on the 2nd stall when an API key is present.
 */
describe("F-001 SessionTransportFallback (Fix 5) — TS-02 Chapter-12 recovery", () => {
  it("reroutes to the anthropic HTTP path on the 2nd stall when an API key is present", async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, (event: { payload: string }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    vi.mocked(streamChat).mockResolvedValue(undefined)

    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    // API-key user on the claude-code default (NOT explicitly selected) —
    // exactly the F-004 reroute target profile.
    const streamPromise = streamClaudeCodeCli(
      claudeCliConfig({ apiKey: "sk-ant-key", localCliIsolation: true }),
      [{ role: "user", content: "chapter 12 stall reproduction" }],
      callbacks,
    )
    await Promise.resolve()
    await Promise.resolve()

    // No data events ever — the CLI stalls before the first token on every
    // attempt (the Chapter-12 deterministic failure). Advance through:
    // 1st stall (90s) → 5s backoff → 2nd stall (90s) → fallback fires.
    await vi.advanceTimersByTimeAsync(90_001)
    await vi.advanceTimersByTimeAsync(5_001)
    // 2nd attempt stalls again — at transportRetryAttempt==2 the fallback
    // condition trips. Advance past the 2nd 90s timeout.
    await vi.advanceTimersByTimeAsync(90_001)

    // Let the dynamic import + streamChat microtasks settle.
    await vi.runAllTimersAsync()
    await expect(streamPromise).resolves.toBeUndefined()

    // The fallback rerouted to the anthropic HTTP path (F-004) with the
    // user's OWN apiKey — breaking the spawn→stall→retry→same-stall→surface
    // loop. ANL-009 NO-GO intact: no OAuth-credential reuse, the rerouted
    // config carries the user's own apiKey.
    expect(streamChat).toHaveBeenCalledTimes(1)
    const fallbackConfig = vi.mocked(streamChat).mock.calls[0]?.[0] as LlmConfig
    expect(fallbackConfig.provider).toBe("anthropic")
    expect(fallbackConfig.apiKey).toBe("sk-ant-key")
    // A diagnostic was spooled so the UI explains the reroute.
    expect(callbacks.onToken).toHaveBeenCalled()
    const spooled = callbacks.onToken.mock.calls.map((c) => String(c[0])).join("")
    expect(spooled).toContain("SessionTransportFallback")
  })
})
