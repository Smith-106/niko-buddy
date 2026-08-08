/**
 * Utility functions for detecting and extracting reasoning content from AI model responses.
 * Some models stream chain-of-thought separately from final answers.
 * MIT licensed implementation.
 */

/**
 * Regular expression to match reasoning fields in JSON lines.
 * Matches both "reasoning" and "reasoning_content" field names.
 */
const REASONING_FIELD_RE = /"reasoning(?:_content)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/**
 * Counts the character length of reasoning text in an SSE data line.
 * Measures the JSON-escaped form length (e.g., "\n" counts as 2 chars).
 * Useful for distinguishing between empty responses and responses with only thinking content.
 * @param rawLine - A single line from an SSE stream
 * @returns Total character count across all reasoning fields found
 */
export function countReasoningCharsInLine(rawLine: string): number {
  const extracted = extractReasoningTextFromLine(rawLine)
  if (extracted.length > 0) {
    return extracted.reduce((total, part) => total + part.length, 0)
  }

  let total = 0
  for (const match of rawLine.matchAll(REASONING_FIELD_RE)) {
    total += match[1].length
  }
  return total
}

/**
 * Extracts reasoning text content from a single SSE data line.
 * Handles multiple model conventions: DeepSeek/Kimi (reasoning_content),
 * OpenAI-style (thinking_delta), Google-like (candidates with thought flags).
 * @param rawLine - A raw SSE line (should start with "data: ")
 * @returns Array of extracted reasoning text parts
 */
export function extractReasoningTextFromLine(rawLine: string): string[] {
  const line = rawLine.trim()
  if (!line.startsWith("data: ")) return []
  const data = line.slice(6).trim()
  if (!data || data === "[DONE]") return []

  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          reasoning_content?: string
          reasoning?: string
        }
      }>
      type?: string
      delta?: string | { type?: string; text?: string; thinking?: string }
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      }>
    }

    const out: string[] = []
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta
      if (typeof delta?.reasoning_content === "string") out.push(delta.reasoning_content)
      if (typeof delta?.reasoning === "string") out.push(delta.reasoning)
    }

    if (
      (
        parsed.type === "response.reasoning_summary_text.delta" ||
        parsed.type === "response.reasoning_text.delta"
      ) &&
      typeof parsed.delta === "string"
    ) {
      out.push(parsed.delta)
    }

    if (typeof parsed.delta === "object" && parsed.delta?.type === "thinking_delta") {
      if (typeof parsed.delta.thinking === "string") out.push(parsed.delta.thinking)
      if (typeof parsed.delta.text === "string") out.push(parsed.delta.text)
    }

    for (const candidate of parsed.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought && typeof part.text === "string") out.push(part.text)
      }
    }

    return out
  } catch {
    return []
  }
}
