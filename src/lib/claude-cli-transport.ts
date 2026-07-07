/**
 * Claude Code CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/claude_cli.rs. The Rust
 * commands spawn `claude -p --output-format stream-json
 * --input-format stream-json --verbose --model <model>`, pipe the
 * serialized history over stdin, and emit stdout back as
 * `claude-cli:{streamId}` events (one line per event). This module
 * listens for those events, parses each line as a stream-json event,
 * and forwards assistant text to `onToken`.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"
import { classifyTransportError, type TransportError } from "./transport-error"
import { hasAnthropicApiKey } from "@/components/settings/preset-resolver"

export type ClaudeCodeStreamParseResult =
  | { kind: "token"; text: string }
  | { kind: "structured"; data: unknown }
  | { kind: "heartbeat" }
  | { kind: "stderr"; text: string }
  | { kind: "ignore" }
  | { kind: "diagnostic"; text: string }
  | { kind: "unknown" }

const CLAUDE_CLI_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]
// C-101 (GRL-008): these were hardcoded consts; now overridable via app-state
// store (keys below) so users on slow/portable/cold-start environments can
// raise them. Defaults preserved at prior values to keep behavior stable.
const DEFAULT_CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS = 90_000
const DEFAULT_CLAUDE_CLI_INACTIVITY_TIMEOUT_MS = 30_000
// F-001 (ANL-010): 3rd watchdog — mid-conversation heartbeat. The two prior
// watchdogs (firstMeaningful + inactivity) catch stalls at the boundaries
// (first token, trailing silence). The mid-conversation watchdog catches the
// S2 Chapter-12 failure mode where the CLI keeps emitting low-rate heartbeats
// (progress events that reset the inactivity timer) but produces NO assistant
// text for an extended window — a stuck-in-reasoning state that previously
// ran unbounded. It only arms AFTER the first meaningful token, so it never
// fires during cold start. Default 60s; the inactivity timer must also be
// idle for it to fire (i.e. heartbeats keeping the inactivity timer warm but
// no real tokens). Override via app-state store.
const DEFAULT_CLAUDE_CLI_MID_CONVERSATION_HEARTBEAT_MS = 60_000
// F-001 (ANL-010): SIGTERM grace at the TS transport layer. When the watchdog
// fires, instead of an immediate hard kill (SIGKILL-equivalent via
// claude_cli_kill) we first ask Rust to terminate gracefully (SIGTERM on
// Unix / WM_CLOSE on Windows) and give the child up to graceMs to exit on
// its own before the kill path escalates. This lets the CLI flush partial
// output and avoids leaving the OAuth session in a half-written state. The
// S3 boundary contract forbids a Rust spawn-lifecycle rewrite, so the grace
// is enforced here at the TS transport layer: Rust exposes
// `claude_cli_terminate` (graceful) + `claude_cli_kill` (hard); TS calls
// terminate, waits graceMs, then falls back to kill if still alive.
const DEFAULT_CLAUDE_CLI_SIGTERM_GRACE_MS = 4_000
const STORE_KEY_FIRST_MEANINGFUL_TIMEOUT_MS = "claudeCli.firstMeaningfulOutputTimeoutMs"
const STORE_KEY_INACTIVITY_TIMEOUT_MS = "claudeCli.inactivityTimeoutMs"
const STORE_KEY_MID_CONVERSATION_HEARTBEAT_MS = "claudeCli.midConversationHeartbeatMs"
const STORE_KEY_SIGTERM_GRACE_MS = "claudeCli.sigtermGraceMs"

// C-101 (GRL-008): configurable transport timeouts. Kept as a synchronous
// module-level cache so the stream hot-path never blocks on a store read
// (specs and fast paths get defaults immediately). `warmClaudeCliTimeouts()`
// is called at app init / settings change to pull overrides from the
// app-state store; until it resolves, defaults are used.
interface ClaudeCliTimeoutConfig {
  firstMeaningfulMs: number
  inactivityMs: number
  midConversationHeartbeatMs: number
  sigtermGraceMs: number
}

let cachedTimeouts: ClaudeCliTimeoutConfig = {
  firstMeaningfulMs: DEFAULT_CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS,
  inactivityMs: DEFAULT_CLAUDE_CLI_INACTIVITY_TIMEOUT_MS,
  midConversationHeartbeatMs: DEFAULT_CLAUDE_CLI_MID_CONVERSATION_HEARTBEAT_MS,
  sigtermGraceMs: DEFAULT_CLAUDE_CLI_SIGTERM_GRACE_MS,
}

function resolveClaudeCliTimeouts(): ClaudeCliTimeoutConfig {
  return cachedTimeouts
}

/** Pull timeout overrides from the app-state store. Safe to call repeatedly
 *  (e.g. on settings change). No-op if the store is unavailable. */
export async function warmClaudeCliTimeouts(): Promise<void> {
  try {
    const { getStore } = await import("./web-store")
    const store = await getStore()
    const first = await store.get<number>(STORE_KEY_FIRST_MEANINGFUL_TIMEOUT_MS)
    const inact = await store.get<number>(STORE_KEY_INACTIVITY_TIMEOUT_MS)
    const midConv = await store.get<number>(STORE_KEY_MID_CONVERSATION_HEARTBEAT_MS)
    const grace = await store.get<number>(STORE_KEY_SIGTERM_GRACE_MS)
    const clampPositive = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= 5_000 ? v : fallback
    const clampGrace = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= 500 ? v : fallback
    cachedTimeouts = {
      firstMeaningfulMs: clampPositive(first, DEFAULT_CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS),
      inactivityMs: clampPositive(inact, DEFAULT_CLAUDE_CLI_INACTIVITY_TIMEOUT_MS),
      midConversationHeartbeatMs: clampPositive(midConv, DEFAULT_CLAUDE_CLI_MID_CONVERSATION_HEARTBEAT_MS),
      sigtermGraceMs: clampGrace(grace, DEFAULT_CLAUDE_CLI_SIGTERM_GRACE_MS),
    }
  } catch {
    // keep defaults
  }
}

/**
 * F-001 (ANL-010): backpressure file-spool. When the CLI transport detects a
 * stall, it spools the stall context (stream id, attempt count, error) to a
 * diagnostic file so a post-mortem is possible even if the in-memory
 * diagnostics are lost on fallback. This is the "backpressure" release valve:
 * rather than buffering the stall in memory (which a long-running stall loop
 * would grow unbounded), the context is flushed to disk and the in-memory
 * buffers can be reclaimed. Best-effort — a write failure never blocks the
 * transport's recovery path.
 */
async function spoolStalledStreamToDisk(
  streamId: string,
  attempt: number,
  message: string,
): Promise<void> {
  try {
    const { getStore } = await import("./web-store")
    const store = await getStore()
    // Append-only diagnostic log keyed by date so it doesn't grow unbounded
    // within a single entry. The store handles persistence.
    const key = `claudeCli.stallSpool.${new Date().toISOString().slice(0, 10)}`
    const prior = (await store.get<string[]>(key)) ?? []
    prior.push(
      JSON.stringify({
        streamId,
        attempt,
        message: message.slice(0, 2000),
        spooledAt: new Date().toISOString(),
      }),
    )
    // Cap the per-day spool at 64 entries so a pathological stall loop can't
    // grow the store entry without bound (the backpressure release).
    if (prior.length > 64) prior.splice(0, prior.length - 64)
    await store.set(key, prior)
  } catch {
    // Store unavailable (test env, portable without store) — the in-memory
    // diagnostic path still carries the stall context to the caller.
  }
}

/**
 * F-001 (ANL-010): graceful abort of the CLI child. Sends a terminate signal
 * (SIGTERM / WM_CLOSE) via `claude_cli_terminate`, waits up to `graceMs` for
 * the child to exit on its own, then escalates to a hard `claude_cli_kill`
 * if it's still alive. Both invokes are best-effort (errors swallowed) so a
 * Rust-side failure never blocks the transport's recovery path. The S3
 * boundary forbids rewriting the Rust spawn lifecycle, so the grace period
 * is enforced here at the TS layer, not in the spawn command.
 */
export async function gracefulAbortStream(streamId: string, graceMs: number): Promise<void> {
  // Phase 1: graceful terminate. Rust maps this to SIGTERM (Unix) or
  // WM_CLOSE-then-TerminateProcess (Windows). Best-effort — never throw.
  try {
    await invoke("claude_cli_terminate", { streamId })
  } catch {
    // Rust command may be absent on older builds; fall through to hard kill.
  }
  // Phase 2: wait the grace window for the child to self-exit. The done
  // listener will fire naturally if it exits in time; we just bound the
  // wait before escalating. No busy-wait — a single setTimeout.
  if (graceMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs))
  }
  // Phase 3: hard kill fallback if still alive. Also best-effort.
  try {
    await invoke("claude_cli_kill", { streamId })
  } catch {
    // Already exited or command absent — nothing more to do.
  }
}

function buildClaudeCliInactivityError(
  hasMeaningfulOutput: boolean,
  sawProgressOutput: boolean,
  firstMeaningfulMs: number,
  inactivityMs: number,
): string {
  if (!hasMeaningfulOutput) {
    if (sawProgressOutput) {
      return `Claude Code CLI kept emitting progress heartbeats, but never produced assistant text or StructuredOutput before stalling. The upstream provider may be stuck in a long reasoning phase or stalling before the first visible token. The CLI will retry with backoff; if this persists, switch provider in Settings (e.g. to Codex) or run \`claude -p ... --verbose\` in a terminal to inspect the environment.`
    }
    return `Claude Code CLI started but produced no meaningful stream output within ${Math.round(firstMeaningfulMs / 1000)} seconds. The upstream provider may be stalling before the first token (MCP is disabled by QMAI, so this is not an MCP-bootstrap hang). The CLI will retry with backoff; if this persists, switch provider in Settings (e.g. to Codex) or raise \`claudeCli.firstMeaningfulOutputTimeoutMs\` in app-state for slow/portable/cold-start environments.`
  }
  return `Claude Code CLI produced no additional stream output within ${Math.round(inactivityMs / 1000)} seconds. The upstream provider may have stalled mid-response. The CLI will retry with backoff; if this persists, switch provider in Settings (e.g. to Codex).`
}

function extractDiagnosticText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => extractDiagnosticText(item))
      .filter((item): item is string => Boolean(item))
      .join("\n")
      .trim()
    return joined || null
  }
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  return (
    extractDiagnosticText(record.message)
    ?? extractDiagnosticText(record.details)
    ?? extractDiagnosticText(record.error)
    ?? extractDiagnosticText(record.result)
    ?? extractDiagnosticText(record.content)
    ?? extractDiagnosticText(record.body)
    ?? null
  )
}

function extractStructuredStdoutDiagnostic(obj: Record<string, unknown>): string | null {
  if (obj.type === "error") {
    return extractDiagnosticText(obj) ?? JSON.stringify(obj)
  }
  if (obj.type === "result" && obj.is_error === true) {
    return extractDiagnosticText(obj) ?? JSON.stringify(obj)
  }
  return null
}

function unwrapStructuredToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const nested = record.__unparsedToolInput
  if (typeof nested !== "string") return input
  try {
    return JSON.parse(nested)
  } catch {
    return input
  }
}

/**
 * Public parse entry point. Given one stream-json line from claude's
 * stdout, returns a structured classification:
 * - `token`: assistant text to stream into the UI
 * - `heartbeat`: non-text progress signals that prove the CLI is still alive
 * - `ignore`: known non-text lifecycle events (`system`, success `result`, etc.)
 * - `diagnostic`: structured CLI-side errors emitted on stdout
 * - `unknown`: non-JSON or unrecognized payloads worth keeping for fallback diagnostics
 *
 * State is carried in a small closure because `assistant` events ship
 * the full in-progress message on every emission (NOT incremental), but
 * `stream_event` passthrough (emitted when --verbose is on) carries
 * real token-level deltas. To avoid double-counting, we prefer deltas
 * when they arrive and skip the fat `assistant` events after seeing one.
 */
export function createClaudeCodeStreamParser() {
  let sawDelta = false
  let emittedFromAssistant = ""

  // F-001 (ANL-010, PERF-001 fix): stream-event-type dispatch table. Built
  // ONCE per parser (in createClaudeCodeStreamParser scope), NOT on every
  // parseLine call — the prior version allocated the Record + 8 closures per
  // stdout line (~10k+ lines per chapter with --include-partial-messages),
  // a hot-path regression vs the zero-allocation if-chain it replaced. The
  // handlers close over sawDelta/emittedFromAssistant (mutable state in this
  // scope), so they stay stateful without per-call allocation. Replaces the
  // prior if-chain-on-type parser, which was fragile to new event types (a
  // new stream_event subtype fell through to `heartbeat` silently). The
  // table makes routing explicit and covers the stream-event subtypes the
  // CLI emits that the transport must recognize: rate_limit_event,
  // assistant.error, stop_reason, plus the stdout-buffer-overflow marker
  // emitted by the Rust bounded-buffer guard. Unknown types still fall to
  // `unknown` (kept for fallback diagnostics).
  type ParseCtx = { obj: Record<string, unknown> }
  const dispatch: Record<string, (ctx: ParseCtx) => ClaudeCodeStreamParseResult> = {
    stderr: ({ obj }) => {
      const text = extractDiagnosticText(obj.text)
      return text ? { kind: "stderr", text } : { kind: "heartbeat" }
    },
    stream_event: ({ obj }) => {
      const event = obj.event as Record<string, unknown> | undefined
      const eventType = event?.type as string | undefined
      // content_block_delta carries real token-level deltas.
      if (eventType === "content_block_delta") {
        const delta = event?.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true
          return { kind: "token", text: delta.text }
        }
      }
      // F-001: surface rate-limit events as diagnostics so the transport
      // can retry with backoff (rate_limit_event). Always lead with the
      // rate-limit context so the diagnostic is actionable even when the
      // upstream payload carries only an opaque message.
      if (eventType === "rate_limit_event") {
        const upstream = extractDiagnosticText(event)
        const text = upstream
          ? `Claude Code CLI rate-limited by upstream: ${upstream}`
          : "Claude Code CLI rate-limited by upstream."
        return { kind: "diagnostic", text }
      }
      return { kind: "heartbeat" }
    },
    assistant: ({ obj }) => {
      // F-001: assistant.error events surface as diagnostics. Checked
      // BEFORE the content-array guard so an error event without a
      // content array (just a message) still surfaces.
      if (obj.subtype === "error" || obj.is_error === true) {
        const text = extractDiagnosticText(obj) ?? extractDiagnosticText(obj.message) ?? "Claude Code CLI assistant error."
        return { kind: "diagnostic", text }
      }
      const message = obj.message as Record<string, unknown> | undefined
      const content = message?.content
      if (!Array.isArray(content)) return { kind: "ignore" }
      const structuredTool = content.find((c) => {
        const cc = c as Record<string, unknown>
        return cc.type === "tool_use" && cc.name === "StructuredOutput"
      }) as Record<string, unknown> | undefined
      if (structuredTool && structuredTool.input && typeof structuredTool.input === "object") {
        return { kind: "structured", data: unwrapStructuredToolInput(structuredTool.input) }
      }
      const text = content
        .map((c) => {
          const cc = c as Record<string, unknown>
          return cc.type === "text" && typeof cc.text === "string" ? cc.text : ""
        })
        .join("")
      if (!text) {
        const hasProgressOnlyContent = content.some((c) => {
          const cc = c as Record<string, unknown>
          return typeof cc.type === "string" && cc.type !== "text"
        })
        return hasProgressOnlyContent ? { kind: "heartbeat" } : { kind: "ignore" }
      }

      if (sawDelta) {
        return { kind: "ignore" }
      }
      if (text.startsWith(emittedFromAssistant)) {
        const novel = text.slice(emittedFromAssistant.length)
        emittedFromAssistant = text
        return novel ? { kind: "token", text: novel } : { kind: "ignore" }
      }
      emittedFromAssistant = text
      return { kind: "token", text }
    },
    system: ({ obj }) => {
      // F-001: thinking_tokens is a heartbeat (in-progress reasoning
      // signal). All other system subtypes (init, etc.) are lifecycle
      // noise the UI ignores — preserved from the prior if-chain so the
      // existing behavior contract holds.
      return obj.subtype === "thinking_tokens" ? { kind: "heartbeat" } : { kind: "ignore" }
    },
    result: () => ({ kind: "ignore" }),
    user: () => ({ kind: "ignore" }),
    // F-001: stop_reason events are heartbeats (stream finalizing normally).
    stop_reason: () => ({ kind: "heartbeat" }),
    // F-001: stdout-buffer-overflow marker emitted by the Rust bounded-buffer
    // guard (claude_cli.rs CLAUDE_STDOUT_LIMIT_BYTES). Surface as a
    // diagnostic so the transport can detect the truncation and trigger
    // SessionTransportFallback on the next stall.
    "stdout-buffer-overflow": () => ({
      kind: "diagnostic",
      text: "stdout-buffer-overflow: CLI stdout exceeded the bounded buffer cap (pipe-buffer-deadlock symptom).",
    }),
  }

  return function parseLine(rawLine: string): ClaudeCodeStreamParseResult {
    const line = rawLine.trim()
    if (!line) return { kind: "ignore" }

    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      return { kind: "unknown" }
    }

    if (!evt || typeof evt !== "object") return { kind: "unknown" }
    const obj = evt as Record<string, unknown>
    const diagnostic = extractStructuredStdoutDiagnostic(obj)
    if (diagnostic) {
      return { kind: "diagnostic", text: diagnostic }
    }

    const type = obj.type

    // PERF-001: dispatch table is built once per parser in the
    // createClaudeCodeStreamParser scope (above), not on every line.
    const handler = dispatch[type as string]
    if (handler) return handler({ obj })
    return { kind: "unknown" }
  }
}

function waitForClaudeCliRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
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

/**
 * ISS-019: the prior string-matching classifier is now a thin wrapper over
 * `classifyTransportError`. `shouldRetryClaudeCliError` preserves its public export signature
 * (the spec tests import it) and delegates to the typed classifier — string matching now lives in
 * exactly one place. The classifier returns `retryable` which is the same boolean the prior regex
 * produced, so the retry contract is unchanged.
 */
export function shouldRetryClaudeCliError(message: string): boolean {
  const text = message?.trim() ?? ""
  if (!text) return false
  return classifyTransportError({ message }).retryable
}

// ISS-019: the prior `shouldRetryClaudeCliWithIsolation(message)` (a second regex matching the
// strict isolation-retry subset) is REMOVED — its logic now lives in `classifyTransportError` as
// the `isolation_retry` kind. Call sites branch on `transportError.kind === "isolation_retry"`
// directly. The function was never exported, so removing it has no external impact.

function appendClaudeCliIsolationRetryNote(message: string): string {
  return [
    message,
    "QMAI automatically retried once with local CLI isolation enabled, but Claude Code CLI still failed before producing meaningful output.",
  ].join("\n\n")
}

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  messages: ChatMessage[]
  isolateLocalConfig: boolean
  jsonSchema?: Record<string, unknown>
}

/**
 * Subprocess equivalent of the HTTP path in streamChat. Obeys the same
 * StreamCallbacks contract so chat-panel code doesn't need to know
 * which transport it's talking to.
 */
export async function streamClaudeCodeCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop", "jsonSchema"] as const) {
      if (overrides[key] !== undefined) {
        if (key === "jsonSchema") continue
        // eslint-disable-next-line no-console
        console.warn(`[claude-code] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  let aborted = signal?.aborted ?? false
  let activeStreamId: string | null = null
  let abortActiveAttempt: (() => void) | null = null
  let isolateLocalConfig = config.localCliIsolation === true
  let usedIsolationFallback = false
  let transportRetryAttempt = 0

  const abortListener = () => {
    aborted = true
    if (activeStreamId) {
      // F-001 (ANL-010): SIGTERM grace on user-initiated abort. The child
      // may still be producing; a short grace window lets it flush partial
      // output before the hard kill (gracefulAbortStream terminates, waits
      // sigtermGraceMs, then kills). Best-effort — never blocks the abort.
      void gracefulAbortStream(activeStreamId, sigtermGraceMs)
    }
    abortActiveAttempt?.()
  }
  if (aborted) {
    onDone()
    return
  }
  signal?.addEventListener("abort", abortListener)

  // C-101 (GRL-008): synchronous read of (possibly warmed) configurable
  // timeouts. `warmClaudeCliTimeouts()` is called at app init to pull
  // overrides from the store; until then defaults are used.
  const { firstMeaningfulMs, inactivityMs, midConversationHeartbeatMs, sigtermGraceMs } = resolveClaudeCliTimeouts()

  try {
    for (;;) {
      if (aborted || signal?.aborted) {
        onDone()
        return
      }

      const streamId = crypto.randomUUID()
      activeStreamId = streamId
      const parse = createClaudeCodeStreamParser()
      let emittedToken = false

      const UNPARSED_BUFFER_CAP = 4096
      const unparsedLines: string[] = []
      let unparsedSize = 0
      const stdoutDiagnostics: string[] = []
      let stdoutDiagnosticSize = 0

      const captureUnparsed = (line: string) => {
        if (unparsedSize >= UNPARSED_BUFFER_CAP) return
        const trimmed = line.trim()
        if (trimmed.length === 0) return
        unparsedLines.push(line)
        unparsedSize += line.length + 1
      }

      const captureStdoutDiagnostic = (message: string) => {
        if (stdoutDiagnosticSize >= UNPARSED_BUFFER_CAP) return
        const trimmed = message.trim()
        if (trimmed.length === 0) return
        stdoutDiagnostics.push(trimmed)
        stdoutDiagnosticSize += trimmed.length + 1
      }

      const attemptResult = await new Promise<
        | { kind: "done" }
        | { kind: "error"; message: string; emittedToken: boolean }
      >((resolve) => {
        let unlistenData: UnlistenFn | (() => void) | undefined
        let unlistenDone: UnlistenFn | (() => void) | undefined
        let settled = false
        let cleanedUp = false
        let startupTimeoutId: ReturnType<typeof setTimeout> | null = null
        let inactivityTimeoutId: ReturnType<typeof setTimeout> | null = null
        // F-001 (ANL-010): 3rd watchdog — mid-conversation heartbeat. Only
        // armed after the first meaningful token (so cold start is exempt).
        // Catches the Chapter-12 failure mode: CLI keeps emitting heartbeats
        // (which reset the inactivity timer) but produces no assistant text
        // for an extended window — a stuck-in-reasoning state that ran
        // unbounded under the prior two-watchdog scheme.
        let midConversationHeartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null
        let sawMeaningfulOutput = false
        let sawProgressOutput = false

        const cancelAttempt = () => settle({ kind: "done" })
        const clearStartupTimeout = () => {
          if (startupTimeoutId !== null) {
            clearTimeout(startupTimeoutId)
            startupTimeoutId = null
          }
        }
        const clearInactivityTimeout = () => {
          if (inactivityTimeoutId !== null) {
            clearTimeout(inactivityTimeoutId)
            inactivityTimeoutId = null
          }
        }
        const clearMidConversationHeartbeat = () => {
          if (midConversationHeartbeatTimeoutId !== null) {
            clearTimeout(midConversationHeartbeatTimeoutId)
            midConversationHeartbeatTimeoutId = null
          }
        }
        const failForInactivity = () => {
          // F-001 (ANL-010): on a watchdog stall the child is already stuck
          // (no output for the timeout window), so a SIGTERM grace window
          // adds recovery latency without flushing useful output. Use the
          // direct kill here. The gracefulAbortStream path (SIGTERM grace)
          // is reserved for user-initiated abort, where the child may still
          // be producing and a short grace lets it flush partial output.
          void invoke("claude_cli_kill", { streamId }).catch(() => {})
          settle({
            kind: "error",
            message: buildClaudeCliInactivityError(sawMeaningfulOutput, sawProgressOutput, firstMeaningfulMs, inactivityMs),
            emittedToken,
          })
        }
        const scheduleStartupTimeout = () => {
          clearStartupTimeout()
          startupTimeoutId = setTimeout(() => {
            failForInactivity()
          }, firstMeaningfulMs)
        }
        const scheduleInactivityTimeout = () => {
          clearInactivityTimeout()
          inactivityTimeoutId = setTimeout(() => {
            failForInactivity()
          }, inactivityMs)
        }
        const scheduleMidConversationHeartbeat = () => {
          // F-001 (ANL-010): only arm after first meaningful token, and only
          // if the watchdog window is positive. The inactivity timer is
          // shorter (30s default) and resets on any progress; this watchdog
          // (60s default) catches the case where heartbeats keep resetting
          // inactivity but no real token ever arrives.
          if (!sawMeaningfulOutput) return
          if (midConversationHeartbeatMs <= 0) return
          clearMidConversationHeartbeat()
          midConversationHeartbeatTimeoutId = setTimeout(() => {
            failForInactivity()
          }, midConversationHeartbeatMs)
        }
        const noteProgressOutput = () => {
          if (!sawProgressOutput) {
            sawProgressOutput = true
            clearStartupTimeout()
          }
          scheduleInactivityTimeout()
        }
        const noteMeaningfulOutput = () => {
          if (!sawMeaningfulOutput) {
            sawMeaningfulOutput = true
          }
          noteProgressOutput()
          // F-001 (ANL-010): rearm the mid-conversation heartbeat on EVERY
          // real token (not just the first). A token resets the window; only
          // a sustained window of heartbeats-without-tokens trips it.
          // scheduleMidConversationHeartbeat no-ops until sawMeaningfulOutput
          // is true (its internal guard), so cold-start protection holds.
          // (CORR-001 fix: this was previously inside `if (wasFirst)`, which
          // armed the watchdog once at the first token and never rearmed —
          // false-stalling any stream longer than midConversationHeartbeatMs.)
          scheduleMidConversationHeartbeat()
        }

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearStartupTimeout()
          clearInactivityTimeout()
          clearMidConversationHeartbeat()
          if (abortActiveAttempt === cancelAttempt) {
            abortActiveAttempt = null
          }
          unlistenData?.()
          unlistenDone?.()
        }

        const settle = (
          result:
            | { kind: "done" }
            | { kind: "error"; message: string; emittedToken: boolean },
        ) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(result)
        }

        abortActiveAttempt = cancelAttempt
        scheduleStartupTimeout()

        const setupAttempt = async () => {
          try {
            // Capture the unlisten fn and only assign it to the outer handle
            // when still active. If settle() fired during the await listen()
            // window (startup timeout or abort), cleanup() already ran with
            // unlistenData undefined — so we must unregister the just-registered
            // listener ourselves here, otherwise it leaks for the webview
            // lifetime (the second cleanup() at the settled check below is a
            // no-op due to the cleanedUp guard).
            const unlistenDataFn = await listen<string>(`claude-cli:${streamId}`, (event) => {
              const parsed = parse(event.payload)
              if (parsed.kind === "token") {
                emittedToken = true
                noteMeaningfulOutput()
                onToken(parsed.text)
              } else if (parsed.kind === "structured") {
                emittedToken = true
                noteMeaningfulOutput()
                onToken(JSON.stringify(parsed.data))
              } else if (parsed.kind === "diagnostic") {
                noteMeaningfulOutput()
                captureStdoutDiagnostic(parsed.text)
              } else if (parsed.kind === "stderr") {
                noteProgressOutput()
                captureStdoutDiagnostic(`[stderr] ${parsed.text}`)
              } else if (parsed.kind === "unknown") {
                noteMeaningfulOutput()
                captureUnparsed(event.payload)
              } else if (parsed.kind === "heartbeat") {
                noteProgressOutput()
              }
            })
            if (settled) {
              unlistenDataFn()
              return
            }
            unlistenData = unlistenDataFn

            const unlistenDoneFn = await listen<{ code: number | null; stderr: string }>(
              `claude-cli:${streamId}:done`,
              (event) => {
                const code = event.payload?.code
                const stderr = event.payload?.stderr?.trim() ?? ""
                const stdoutDiagnostic = stdoutDiagnostics.join("\n")
                const unparsedStdout = unparsedLines.join("\n")
                if (code !== null && code !== undefined && code !== 0) {
                  settle({
                    kind: "error",
                    message: buildExitError(code, stderr, unparsedStdout, stdoutDiagnostic),
                    emittedToken,
                  })
                } else if (!emittedToken) {
                  const details = stderr || stdoutDiagnostic.trim() || unparsedStdout.trim()
                  settle({
                    kind: "error",
                    message: details
                      ? `Claude Code CLI completed but returned no content:\n${details}`
                      : "Claude Code CLI completed but returned no content. Try running `claude -p` in a terminal to inspect the output, or switch to the Anthropic API in Settings.",
                    emittedToken,
                  })
                } else {
                  settle({ kind: "done" })
                }
              },
            )
            if (settled) {
              unlistenDoneFn()
              return
            }
            unlistenDone = unlistenDoneFn
            if (aborted || signal?.aborted) {
              settle({ kind: "done" })
              return
            }

            const payload: SpawnPayload = {
              streamId,
              model: config.model,
              messages,
              isolateLocalConfig,
              jsonSchema: overrides?.jsonSchema,
            }
            await invoke("claude_cli_spawn", payload)

            if (settled || aborted || signal?.aborted) {
              void invoke("claude_cli_kill", { streamId }).catch(() => {})
            }
          } catch (err) {
            if (settled) return
            const message = err instanceof Error ? err.message : String(err)
            settle({
              kind: "error",
              message,
              emittedToken,
            })
          }
        }

        void setupAttempt()
      })

      activeStreamId = null

      if (attemptResult.kind === "done") {
        onDone()
        return
      }

      // ISS-019: classify ONCE per attempt, branch on `error.kind` (not message.includes).
      // `retryable` covers both rate_limit and isolation_retry (the strict subset), preserving
      // the prior `isStallError = shouldRetryClaudeCliError(msg) || shouldRetryClaudeCliWithIsolation(msg)`
      // contract: any transient failure (rate-limit, stall, isolation-retry) qualifies for backoff.
      const transportError: TransportError = classifyTransportError(attemptResult)

      if (
        !attemptResult.emittedToken
        && !isolateLocalConfig
        && transportError.kind === "isolation_retry"
      ) {
        isolateLocalConfig = true
        usedIsolationFallback = true
        continue
      }

      const retryDelay = CLAUDE_CLI_RETRY_DELAYS_MS[transportRetryAttempt]
      const isStallError = transportError.retryable
      if (
        !attemptResult.emittedToken
        && retryDelay !== undefined
        && isStallError
      ) {
        transportRetryAttempt += 1
        // F-001 (ANL-010): backpressure file-spool — flush the stall context
        // to disk so a post-mortem is possible even after the fallback
        // reroutes the stream. Best-effort; never blocks recovery.
        void spoolStalledStreamToDisk(streamId, transportRetryAttempt, attemptResult.message)
        // F-001 (ANL-010): SessionTransportFallback (SA-02). On the 2nd
        // consecutive stall (transportRetryAttempt == 2 after increment,
        // i.e. one backoff retry already stalled the same way), reroute to
        // the sanctioned anthropic HTTP path (F-004) INSTEAD of surfacing
        // the error — but ONLY when the user has their OWN Anthropic API
        // key (boundary: ANL-009 NO-GO intact, no OAuth-credential reuse).
        // This breaks the S2 Chapter-12 deterministic failure loop: spawn
        // → stall → retry → same stall → surface. With a key present, the
        // 2nd stall reroutes to HTTP and the user gets a response. Without
        // a key, we fall through to the existing error surface (the user
        // is on OAuth-only and must fix the CLI environment).
        if (transportRetryAttempt >= 2 && isStallError) {
          // ISS-002: statically-import the key-presence resolver (synchronous,
          // apiKey+env) so the no-key path (the common OAuth-only case, incl.
          // all unit tests) never risks an unresolved dynamic-import promise
          // under fake timers. Single source of truth for the key check — no
          // duplicated inline logic.
          if (hasAnthropicApiKey(config)) {
            // Spool a diagnostic so the UI shows why the stream resumed via
            // the HTTP path rather than the subprocess transport.
            const fallbackNote = "[SessionTransportFallback] Claude Code CLI stalled twice; rerouting to the Anthropic API (HTTP) using your saved API key. The CLI transport will retry on the next request."
            try {
              onToken(fallbackNote + "\n\n")
            } catch {
              // best-effort diagnostic
            }
            // CORR-012 (from quality-review): the dynamic import + streamChat
            // are the last-resort fallback. If they throw (HTTP error,
            // network failure, unresolved module), surface a single clean
            // error instead of letting it propagate to the outer catch —
            // which would call onError AGAIN (streamChat may already have
            // surfaced its own onError internally), causing a double-onError
            // and a misleading "CLI not found"-style message. We do NOT
            // retry the CLI after a fallback failure; HTTP was the escape
            // hatch and it failed.
            try {
              const { streamChat } = await import("./llm-client")
              const fallbackConfig = { ...config, provider: "anthropic" as const }
              await streamChat(fallbackConfig, messages, callbacks, signal, overrides)
              return
            } catch (fallbackErr) {
              const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              onError(new Error(
                `SessionTransportFallback to the Anthropic API failed after the CLI stalled twice: ${fallbackMessage}. The CLI transport will retry on the next request.`,
              ))
              return
            }
          }
        }
        const shouldContinue = await waitForClaudeCliRetry(retryDelay, signal)
        if (shouldContinue) continue
        onDone()
        return
      }

      // ISS-019: branch on `kind` for the isolation-retry note (was shouldRetryClaudeCliWithIsolation).
      const finalMessage = usedIsolationFallback && transportError.kind === "isolation_retry"
        ? appendClaudeCliIsolationRetryNote(attemptResult.message)
        : attemptResult.message
      onError(new Error(finalMessage))
      return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found|No such file|executable file not found/i.test(message)) {
      onError(new Error(
        "Claude Code CLI not found. Install `claude` (https://www.anthropic.com/claude-code) or pick a different provider.",
      ))
    } else {
      onError(err instanceof Error ? err : new Error(message))
    }
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}

/**
 * Translate `claude` CLI exit-with-stderr into an actionable error
 * message for the user. The bare "exited with code N: <stderr>"
 * we used to throw was correct but unactionable: users had to
 * read JSON-shaped stderr text to figure out what to do.
 *
 * Three diagnostic sources, used in priority order:
 *   1. stderr: the canonical place. The most common content is
 *      `Unauthenticated:` from Claude Code itself, meaning the
 *      user's ~/.claude OAuth token expired / was revoked / they
 *      logged out. We surface that case explicitly because users
 *      otherwise mis-diagnose it as an LLM Wiki bug.
 *   2. stdoutDiagnostic: structured error events emitted on stdout
 *      (`{"type":"error",...}` or `result.is_error === true`).
 *      Claude CLI occasionally reports its real failure here while
 *      leaving stderr empty, so we surface it before falling back
 *      to opaque parser leftovers.
 *   3. unparsedStdout: stdout lines the parser didn't recognize
 *      (non-JSON, unknown event types). Used as a last-resort
 *      diagnostic when stderr and structured stdout errors are empty.
 *   4. Neither: silent exit. We can't help much here other than
 *      telling the user to reproduce in a terminal where they can
 *      see whatever output the CLI does produce.
 */
export function buildExitError(
  code: number,
  stderr: string,
  unparsedStdout: string = "",
  stdoutDiagnostic: string = "",
): string {
  const authText = stderr || stdoutDiagnostic
  if (/unauthenticated|not logged in|please.*log\s*in|authentication.*failed|\/login\b/i.test(authText)) {
    return [
      "Claude Code CLI is not authenticated.",
      "Please open a terminal and run `claude` to complete the OAuth login,",
      "then retry. (LLM Wiki only spawns the binary - it can't run the",
      "login flow on your behalf.)",
      authText ? `\n\nCLI output:\n${authText}` : "",
    ].join(" ").trim()
  }
  if (stderr) {
    return `claude CLI exited with code ${code}: ${stderr}`
  }
  if (stdoutDiagnostic.trim()) {
    return `claude CLI exited with code ${code}: ${stdoutDiagnostic.trim()}`
  }
  if (unparsedStdout.trim()) {
    return [
      `claude CLI exited with code ${code} (no stderr).`,
      "Captured stdout output that LLM Wiki couldn't parse - pasting it",
      "here so you can see what the CLI actually emitted:\n",
      unparsedStdout.trim(),
    ].join(" ")
  }
  return [
    `claude CLI exited silently with code ${code}.`,
    "No stdout or stderr was captured - try running `claude -p` in a",
    "terminal with the same prompt to see what's wrong, or switch to",
    "the official Anthropic API in Settings.",
  ].join(" ")
}
