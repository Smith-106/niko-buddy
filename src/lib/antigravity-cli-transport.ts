/**
 * Antigravity CLI subprocess transport for streaming chat completions.
 *
 * 与 codex-cli-transport 同型：经 Rust `antigravity_cli_spawn` spawn 本地
 * `antigravity`（或 gemini fallback）headless，stdout JSONL → onToken。
 * 本地 Google 账号订阅，不走 API key。
 *
 * 输出协议：Antigravity/Gemini stream-json 的 agent 文本行解析
 * （parseAntigravityCliLine）容错多种事件形态；未识别行缓存用于错误报告。
 *
 * @license MIT © Niko Buddy
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

/**
 * 从一条 stream-json 行提取 agent 文本。容错 Gemini/Antigravity 多种事件形态：
 * - {type:"item.completed", item:{type:"agent_message", text}}（codex 风）
 * - {type:"message"/"content"/"text", content|text|delta}
 * - {role:"assistant"/"model", content|parts}
 * - {candidates:[{content:{parts:[{text}]}}]}（Gemini generateContent 风）
 */
export function parseAntigravityCliLine(rawLine: string): string | null {
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

  // codex 风
  if (obj.type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text
  }
  // 直出 text/content/delta
  for (const key of ["text", "content", "delta", "message"] as const) {
    const v = obj[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  // parts 数组
  const parts = obj.parts ?? (obj.content as Record<string, unknown> | undefined)?.parts
  if (Array.isArray(parts)) {
    const text = parts
      .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === "string")
      .join("")
    if (text) return text
  }
  // Gemini candidates
  const candidates = obj.candidates
  if (Array.isArray(candidates) && candidates.length > 0) {
    const content = (candidates[0] as Record<string, unknown>)?.content as
      | Record<string, unknown>
      | undefined
    const cparts = content?.parts
    if (Array.isArray(cparts)) {
      const text = cparts
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : null))
        .filter((t): t is string => typeof t === "string")
        .join("")
      if (text) return text
    }
  }
  return null
}

/** 提取错误信息：优先结构化 error/message，回退原文。 */
export function extractAntigravityCliError(rawOutput: string): string {
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
      if (parsed.type === "error" && message) lastError = message
    } catch {
      // 保留原文作回退
    }
  }
  return lastError || rawOutput.trim()
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => (block.type === "text" ? block.text : `[Image omitted: ${block.mediaType}]`))
    .join("\n")
}

function escapePromptContent(text: string): string {
  return text.replace(/<\/?[A-Z_][A-Z0-9_]*>/gi, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
}

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase()
      return `<${role}>\n${escapePromptContent(contentToText(message.content))}\n</${role}>`
    })
    .join("\n\n")
}

/**
 * Stream chat completions via Antigravity CLI subprocess.
 * Workflow 同 codex-cli：streamId → listen data/done → spawn → onToken/onDone/onError。
 */
export async function streamAntigravityCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        console.warn(`[antigravity-cli] ignoring unsupported override "${key}": CLI has no equivalent flag`)
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

  const unparsedLines: string[] = []
  let unparsedSize = 0
  const captureUnparsed = (line: string) => {
    if (unparsedSize >= 4096) return
    const trimmed = line.trim()
    if (!trimmed) return
    unparsedLines.push(line)
    unparsedSize += line.length + 1
  }

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }
  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }
  const replayFromStdout = (stdout: string | undefined) => {
    if (!stdout) return
    for (const line of stdout.split(/\r?\n/)) {
      const token = parseAntigravityCliLine(line)
      if (token !== null) {
        emittedAgentMessage = true
        onToken(token)
      }
    }
  }

  const abortListener = () => {
    aborted = true
    void invoke("antigravity_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    unlistenData = await listen<string>(`antigravity-cli:${streamId}`, (event) => {
      const token = parseAntigravityCliLine(event.payload)
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

    unlistenDone = await listen<{ code: number | null; stderr: string; stdout?: string }>(
      `antigravity-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        if (!emittedAgentMessage) replayFromStdout(event.payload?.stdout)
        if (code === 0) {
          finishWith(onDone)
        } else {
          const detail = stderr || extractAntigravityCliError(event.payload?.stdout ?? "") || "unknown error"
          finishWith(() =>
            onError(new Error(`Antigravity CLI exited with code ${code}: ${detail}`)),
          )
        }
      },
    )

    const prompt = buildPrompt(messages)
    await invoke("antigravity_cli_spawn", {
      streamId,
      model: config.model,
      prompt,
      timeoutMinutes: null,
    })
    await completion
  } catch (e) {
    signal?.removeEventListener("abort", abortListener)
    finishWith(() => onError(e instanceof Error ? e : new Error(String(e))))
  }
}
