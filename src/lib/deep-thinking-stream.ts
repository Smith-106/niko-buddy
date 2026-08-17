/**
 * Streaming renderer for deep-thinking AI responses.
 * Manages named thinking stages that update in-place and renders them
 * as `<think>` blocks followed by the final response body.
 * MIT License — independently implemented.
 */

/** Public interface for the deep-thinking stream renderer. */
export interface DeepThinkingStreamRenderer {
  /** Replace or insert a thinking stage identified by its heading/first line. */
  updateThinking: (content: string) => string
  /** Append a chunk to the final (non-thinking) response body. */
  appendFinal: (content: string) => string
  /** Re-render and return the current combined output. */
  getContent: () => string
}

interface Stage {
  id: string
  text: string
}

/**
 * Derives a stable identity key for a thinking stage.
 * Uses the first `## Heading` if present, otherwise the first non-empty line.
 */
function stageKey(raw: string): string {
  const heading = raw.match(/^\s*##\s*([^\n]+)/)?.[1]?.trim()
  if (heading) return heading
  /* v8 ignore next */
  return raw.split("\n", 1)[0]?.trim() || raw
}

/**
 * Compose the full output from a list of thinking blocks and a final body.
 * Each block is wrapped in `<think>…</think>` tags; blocks are separated by
 * blank lines, and the final body follows after a blank line.
 */
export function renderDeepThinkingStream(thinkingBlocks: string[], finalContent = ""): string {
  const parts = thinkingBlocks
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => `<think>\n${b}\n</think>`)
    .join("\n\n")

  if (!parts) return finalContent
  if (!finalContent) return parts
  return `${parts}\n\n${finalContent}`
}

/**
 * Create a stateful renderer that tracks thinking stages by identity.
 * Updating a stage with the same key replaces it in-place rather than
 * creating a duplicate block.
 */
export function createDeepThinkingStreamRenderer(): DeepThinkingStreamRenderer {
  const stages: Stage[] = []
  let body = ""

  const render = () => renderDeepThinkingStream(stages.map((s) => s.text), body)

  return {
    updateThinking(content: string) {
      const trimmed = content.trim()
      if (!trimmed) return render()

      const key = stageKey(trimmed)
      const idx = stages.findIndex((s) => s.id === key)
      if (idx >= 0) {
        stages[idx] = { id: key, text: trimmed }
      } else {
        stages.push({ id: key, text: trimmed })
      }
      return render()
    },

    appendFinal(content: string) {
      body += content
      return render()
    },

    getContent() {
      return render()
    },
  }
}
