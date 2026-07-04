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

export type ClaudeCodeStreamParseResult =
  | { kind: "token"; text: string }
  | { kind: "structured"; data: unknown }
  | { kind: "heartbeat" }
  | { kind: "stderr"; text: string }
  | { kind: "ignore" }
  | { kind: "diagnostic"; text: string }
  | { kind: "unknown" }

const CLAUDE_CLI_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]
const CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS = 90_000
const CLAUDE_CLI_INACTIVITY_TIMEOUT_MS = 30_000

function buildClaudeCliInactivityError(
  hasMeaningfulOutput: boolean,
  sawProgressOutput: boolean,
): string {
  if (!hasMeaningfulOutput) {
    if (sawProgressOutput) {
      return `Claude Code CLI kept emitting progress heartbeats, but never produced assistant text or StructuredOutput before stalling. The local runtime may still be hanging during a long reasoning phase or the upstream provider may be stuck before the first visible output. Try enabling local CLI isolation, or run \`claude -p ... --verbose\` in a terminal to inspect the environment.`
    }
    return `Claude Code CLI started but produced no meaningful stream output within ${Math.round(CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS / 1000)} seconds. The local runtime may still be hanging during startup or MCP bootstrap, or the upstream provider may be stalling before the first token. Try enabling local CLI isolation, or run \`claude -p ... --verbose\` in a terminal to inspect the environment.`
  }
  return `Claude Code CLI produced no additional stream output within ${Math.round(CLAUDE_CLI_INACTIVITY_TIMEOUT_MS / 1000)} seconds. The local runtime may be hanging during startup or MCP bootstrap. Try enabling local CLI isolation, or run \`claude -p ... --verbose\` in a terminal to inspect the environment.`
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
    if (type === "stderr") {
      const text = extractDiagnosticText(obj.text)
      return text ? { kind: "stderr", text } : { kind: "heartbeat" }
    }

    if (type === "stream_event") {
      const event = obj.event as Record<string, unknown> | undefined
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true
          return { kind: "token", text: delta.text }
        }
      }
      return { kind: "heartbeat" }
    }

    if (type === "assistant") {
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
    }

    if (type === "system") {
      return obj.subtype === "thinking_tokens" ? { kind: "heartbeat" } : { kind: "ignore" }
    }

    if (type === "result" || type === "user") {
      return { kind: "ignore" }
    }

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
  const text = message.trim()
  if (!text) return false
  return /(api error:\s*(429|500|502|503|504)\b|rate limit|overloaded|temporarily unavailable|service unavailable|gateway timeout|connection closed mid-response|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束)/i.test(text)
}

function shouldRetryClaudeCliWithIsolation(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  return /produced no meaningful stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束/i.test(text)
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
      void invoke("claude_cli_kill", { streamId: activeStreamId }).catch(() => {})
    }
    abortActiveAttempt?.()
  }
  if (aborted) {
    onDone()
    return
  }
  signal?.addEventListener("abort", abortListener)

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
        const failForInactivity = () => {
          void invoke("claude_cli_kill", { streamId }).catch(() => {})
          settle({
            kind: "error",
            message: buildClaudeCliInactivityError(sawMeaningfulOutput, sawProgressOutput),
            emittedToken,
          })
        }
        const scheduleStartupTimeout = () => {
          clearStartupTimeout()
          startupTimeoutId = setTimeout(() => {
            failForInactivity()
          }, CLAUDE_CLI_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS)
        }
        const scheduleInactivityTimeout = () => {
          clearInactivityTimeout()
          inactivityTimeoutId = setTimeout(() => {
            failForInactivity()
          }, CLAUDE_CLI_INACTIVITY_TIMEOUT_MS)
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
        }

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearStartupTimeout()
          clearInactivityTimeout()
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
            unlistenData = await listen<string>(`claude-cli:${streamId}`, (event) => {
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
              cleanup()
              return
            }

            unlistenDone = await listen<{ code: number | null; stderr: string }>(
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
              cleanup()
              return
            }
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

      if (
        !attemptResult.emittedToken
        && !isolateLocalConfig
        && shouldRetryClaudeCliWithIsolation(attemptResult.message)
      ) {
        isolateLocalConfig = true
        usedIsolationFallback = true
        continue
      }

      const retryDelay = CLAUDE_CLI_RETRY_DELAYS_MS[transportRetryAttempt]
      if (
        !attemptResult.emittedToken
        && retryDelay !== undefined
        && shouldRetryClaudeCliError(attemptResult.message)
      ) {
        transportRetryAttempt += 1
        const shouldContinue = await waitForClaudeCliRetry(retryDelay, signal)
        if (shouldContinue) continue
        onDone()
        return
      }

      const finalMessage = usedIsolationFallback && shouldRetryClaudeCliWithIsolation(attemptResult.message)
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
