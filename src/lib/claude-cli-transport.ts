// Copyright (c) 2024 Niko-hub contributors. MIT License.

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
const DEFAULT_CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS = 90_000
const DEFAULT_CLAUDE_CLI_INACTIVITY_TIMEOUT_MS = 30_000
const DEFAULT_CLAUDE_CLI_MID_CONVERSATION_HEARTBEAT_MS = 60_000
const DEFAULT_CLAUDE_CLI_SIGTERM_GRACE_MS = 4_000
const STORE_KEY_FIRST_MEANINGFUL_TIMEOUT_MS = "claudeCli.firstMeaningfulOutputTimeoutMs"
const STORE_KEY_INACTIVITY_TIMEOUT_MS = "claudeCli.inactivityTimeoutMs"
const STORE_KEY_MID_CONVERSATION_HEARTBEAT_MS = "claudeCli.midConversationHeartbeatMs"
const STORE_KEY_SIGTERM_GRACE_MS = "claudeCli.sigtermGraceMs"

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

async function spoolStalledStreamToDisk(
  streamId: string,
  attempt: number,
  message: string,
): Promise<void> {
  try {
    const { getStore } = await import("./web-store")
    const store = await getStore()
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
    if (prior.length > 64) prior.splice(0, prior.length - 64)
    await store.set(key, prior)
  } catch {
    // Store unavailable — best-effort diagnostic
  }
}

export async function gracefulAbortStream(streamId: string, graceMs: number): Promise<void> {
  try {
    await invoke("claude_cli_terminate", { streamId })
  } catch {
    // Rust command may be absent on older builds
  }
  if (graceMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs))
  }
  try {
    await invoke("claude_cli_kill", { streamId })
  } catch {
    // Already exited or command absent
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

export function createClaudeCodeStreamParser() {
  let sawDelta = false
  let emittedFromAssistant = ""

  type ParseCtx = { obj: Record<string, unknown> }
  const dispatch: Record<string, (ctx: ParseCtx) => ClaudeCodeStreamParseResult> = {
    stderr: ({ obj }) => {
      const text = extractDiagnosticText(obj.text)
      return text ? { kind: "stderr", text } : { kind: "heartbeat" }
    },
    stream_event: ({ obj }) => {
      const event = obj.event as Record<string, unknown> | undefined
      const eventType = event?.type as string | undefined
      if (eventType === "content_block_delta") {
        const delta = event?.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true
          return { kind: "token", text: delta.text }
        }
      }
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
      return obj.subtype === "thinking_tokens" ? { kind: "heartbeat" } : { kind: "ignore" }
    },
    result: () => ({ kind: "ignore" }),
    user: () => ({ kind: "ignore" }),
    stop_reason: () => ({ kind: "heartbeat" }),
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

export function shouldRetryClaudeCliError(message: string): boolean {
  const text = message?.trim() ?? ""
  if (!text) return false
  return classifyTransportError({ message }).retryable
}

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
      void gracefulAbortStream(activeStreamId, sigtermGraceMs)
    }
    abortActiveAttempt?.()
  }
  if (aborted) {
    onDone()
    return
  }
  signal?.addEventListener("abort", abortListener)

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
        void spoolStalledStreamToDisk(streamId, transportRetryAttempt, attemptResult.message)
        if (transportRetryAttempt >= 2 && isStallError) {
          if (hasAnthropicApiKey(config)) {
            const fallbackNote = "[SessionTransportFallback] Claude Code CLI stalled twice; rerouting to the Anthropic API (HTTP) using your saved API key. The CLI transport will retry on the next request."
            try {
              onToken(fallbackNote + "\n\n")
            } catch {
              // best-effort diagnostic
            }
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
