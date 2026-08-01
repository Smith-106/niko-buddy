/**
 * Codex CLI subprocess transport for streaming chat completions.
 *
 * Implements a Tauri-based event-driven communication layer that:
 * - Spawns `codex exec --json` subprocess via Rust invoke
 * - Reconstructs multi-turn conversation into single prompt
 * - Listens for streamed agent messages and error events
 * - Handles abort, timeout, and retry scenarios gracefully
 *
 * @license MIT © QMAI
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

/**
 * Parse a single Codex CLI JSONL line and extract agent message text.
 * Returns null if the line is not a valid agent message.
 */
export function parseCodexCliLine(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line) return null

  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch {
    return null
  }

  if (!evt || typeof evt !== "object") return null
  const obj = evt as Record<string, unknown>
  if (obj.type !== "item.completed") return null

  const item = obj.item as Record<string, unknown> | undefined
  if (item?.type !== "agent_message") return null
  return typeof item.text === "string" && item.text.length > 0 ? item.text : null
}

/**
 * Extract error message from Codex CLI output.
 * Prioritizes structured error fields, falls back to raw output.
 */
export function extractCodexCliError(rawOutput: string): string {
  let lastError = ""
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string
        message?: unknown
        error?: { message?: unknown }
      }
      const message = typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : ""
      if (parsed.type === "turn.failed" && message) return message
      if (parsed.type === "error" && message && !/^Reconnecting\.\.\./i.test(message)) {
        lastError = message
      }
    } catch {
      // Keep the original output as fallback below.
    }
  }
  return lastError || rawOutput.trim()
}

/**
 * Convert content block array or string to plain text.
 * Omits non-text media blocks with placeholder markers.
 */
function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (block.type === "text") return block.text
      return `[Image omitted: ${block.mediaType}]`
    })
    .join("\n")
}

/**
 * Escape HTML-like tags in prompt content to prevent confusion
 * with the <ROLE> tags used in prompt reconstruction.
 */
function escapePromptContent(text: string): string {
  return text.replace(/<\/?[A-Z_][A-Z0-9_]*>/gi, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
}

/**
 * Reconstruct multi-turn conversation into a single prompt
 * using <ROLE> tag wrapping.
 */
export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase()
      return `<${role}>\n${escapePromptContent(contentToText(message.content))}\n</${role}>`
    })
    .join("\n\n")
}

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  prompt: string
  isolateLocalConfig: boolean
  timeoutMinutes?: number
}

/**
 * Stream chat completions via Codex CLI subprocess.
 *
 * Workflow:
 * 1. Generate unique stream ID and setup event listeners
 * 2. Invoke Rust backend to spawn codex exec --json
 * 3. Stream agent messages via onToken callback
 * 4. Handle completion/error via onDone/onError callbacks
 * 5. Cleanup listeners on finish/abort
 */
export async function streamCodexCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  // Warn about unsupported overrides in dev mode
  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        console.warn(`[codex-cli] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | (() => void) | undefined
  let unlistenDone: UnlistenFn | (() => void) | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  let emittedAgentMessage = false
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  // Buffer unparsed lines for error reporting
  const unparsedLines: string[] = []
  let unparsedSize = 0
  function captureUnparsed(line: string) {
    if (unparsedSize >= 4096) return
    const trimmed = line.trim()
    if (!trimmed) return
    unparsedLines.push(line)
    unparsedSize += line.length + 1
  }

  // Cleanup helper
  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  // Finish handler with idempotency guard
  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }

  // Replay any agent messages from stdout on completion
  const replayAgentMessagesFromStdout = (stdout: string | undefined) => {
    if (!stdout) return
    for (const line of stdout.split(/\r?\n/)) {
      const token = parseCodexCliLine(line)
      if (token !== null) {
        emittedAgentMessage = true
        onToken(token)
      }
    }
  }

  // Abort handler
  const abortListener = () => {
    aborted = true
    void invoke("codex_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    // Setup data listener for streamed agent messages
    unlistenData = await listen<string>(`codex-cli:${streamId}`, (event) => {
      const token = parseCodexCliLine(event.payload)
      if (token !== null) {
        emittedAgentMessage = true
        onToken(token)
      } else {
        captureUnparsed(event.payload)
      }
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    // Setup done listener for completion/error
    unlistenDone = await listen<{ code: number | null; stderr: string; stdout?: string }>(
      `codex-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        const stdout = event.payload?.stdout ?? ""
        if (code !== null && code !== undefined && code !== 0) {
          const details = stderr || extractCodexCliError(stdout) || extractCodexCliError(unparsedLines.join("\n"))
          finishWith(() =>
            onError(new Error(
              details
                ? `Codex CLI exited with code ${code}:\n${details}`
                : `Codex CLI exited with code ${code}. Run \`codex\` in a terminal to inspect the problem.`,
            )),
          )
        } else {
          if (!emittedAgentMessage) replayAgentMessagesFromStdout(stdout)
          if (!emittedAgentMessage) {
            const details = stdout.trim() || unparsedLines.join("\n").trim()
            finishWith(() =>
              onError(new Error(
                details
                  ? `Codex CLI completed but did not emit an agent_message. Raw output:\n${details}`
                  : "Codex CLI completed but did not emit an agent_message. Run `codex exec --json` in a terminal to inspect the provider output.",
              )),
            )
          } else {
            finishWith(onDone)
          }
        }
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    // Spawn the subprocess
    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      prompt: buildPrompt(messages),
      isolateLocalConfig: config.localCliIsolation === true,
      timeoutMinutes: config.codexCliTimeoutMinutes,
    }
    await invoke("codex_cli_spawn", payload)

    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("codex_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    await completion
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found/i.test(message)) {
        onError(new Error(
          "Codex CLI not found. Install `codex` with `npm install -g @openai/codex` or pick a different provider.",
        ))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
