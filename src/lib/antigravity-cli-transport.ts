/**
 * Legacy Antigravity CLI subprocess transport — RETIRED for Google ToS compliance.
 *
 * Per Google Antigravity Additional Terms of Service (https://antigravity.google/terms)
 * and official FAQ (https://antigravity.google/docs/faq): wrapping `agy -p` or consumer
 * Antigravity OAuth inside a third-party application as an automated LLM backend is not
 * supported under consumer plans and may result in account suspension.
 *
 * Compliant alternatives built into Niko Buddy:
 *  1. Interactive Antigravity ACP Panel (official `agy acp` v1 protocol),
 *  2. External Control (connect official Antigravity App/CLI via MCP Streamable HTTP),
 *  3. Google Gemini API key (`provider: "google"`) for automated writing pipelines.
 *
 * @license MIT © Niko Buddy
 */

import { z } from "zod"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

export const ANTIGRAVITY_CLI_RETIRED_ERROR =
  "Antigravity CLI consumer subscription wrapping has been retired to comply with Google Antigravity Terms of Service. " +
  "Please use the interactive Antigravity Panel (official ACP), connect official Antigravity via External Control (MCP), " +
  "or switch your automated writing model to Google (Gemini API key)."

const cliRecordSchema = z.record(z.string(), z.unknown())

function asCliRecord(value: unknown): Record<string, unknown> | null {
  const parsed = cliRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

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
  const obj = asCliRecord(evt)
  if (!obj) return null

  if (obj.type === "item.completed") {
    const item = asCliRecord(obj.item)
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text
  }
  for (const key of ["text", "content", "delta", "message"] as const) {
    const v = obj[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  const parts = obj.parts ?? asCliRecord(obj.content)?.parts
  if (Array.isArray(parts)) {
    const text = parts
      .map((p) => asCliRecord(p)?.text ?? null)
      .filter((t): t is string => typeof t === "string")
      .join("")
    if (text) return text
  }
  const candidates = obj.candidates
  if (Array.isArray(candidates) && candidates.length > 0) {
    const content = asCliRecord(asCliRecord(candidates[0])?.content)
    const cparts = content?.parts
    if (Array.isArray(cparts)) {
      const text = cparts
        .map((p) => asCliRecord(p)?.text ?? null)
        .filter((t): t is string => typeof t === "string")
        .join("")
      if (text) return text
    }
  }
  return null
}

export function extractAntigravityCliError(rawOutput: string): string {
  let lastError = ""
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = asCliRecord(JSON.parse(trimmed))
      if (!parsed) continue
      const nestedError = asCliRecord(parsed.error)
      const nestedMessage = typeof nestedError?.message === "string" ? nestedError.message : ""
      const message = nestedMessage || (typeof parsed.message === "string" ? parsed.message : "")
      if (parsed.type === "turn.failed" && message) return message
      if (parsed.type === "error" && message) lastError = message
    } catch {
      // keep raw text fallback
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
 * Fail-closed transport stub for legacy saved `antigravity-cli` configurations.
 * Never spawns `agy -p` or touches consumer OAuth credentials.
 */
export async function streamAntigravityCli(
  _config: LlmConfig,
  _messages: ChatMessage[],
  callbacks: StreamCallbacks,
  _signal?: AbortSignal,
  _overrides?: RequestOverrides,
): Promise<void> {
  callbacks.onError(new Error(ANTIGRAVITY_CLI_RETIRED_ERROR))
}
