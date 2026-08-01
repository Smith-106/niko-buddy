/**
 * Extracts copyable assistant content from chat messages.
 * When the assistant generated chapter edits, returns the cleaned
 * chapter body. Otherwise returns the visible text with thinking
 * blocks and HTML comments stripped.
 * MIT License — independently implemented.
 */

import { parseAgentResponse } from "@/lib/novel/agent-parser"
import { cleanGeneratedChapterContentForSave } from "@/lib/novel/chapter-content-cleanup"

/**
 * Remove hidden assistant metadata from raw text:
 * HTML comments, paired/unclosed `<think>` and `<thinking>` tags,
 * and orphaned closing tags at the start of the content.
 */
function stripHiddenAssistantBlocks(content: string): string {
  let result = content.replace(/<!--.*?-->/gs, "")

  // Remove fully-paired think/thinking blocks (greedy across lines).
  result = result.replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")

  // Remove unclosed opening think blocks (opening tag to end of string).
  result = result.replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")

  // Handle orphaned closing tags: if content starts with text followed
  // by a </think> but no matching opening tag, strip that prefix too.
  const closeIdx = result.search(/<\/think(?:ing)?>/i)
  if (closeIdx >= 0) {
    const prefix = result.slice(0, closeIdx)
    if (!/<think(?:ing)?>/i.test(prefix)) {
      result = result.replace(/^[\s\S]*?<\/think(?:ing)?>\s*/i, "")
    }
  }

  return result.trim()
}

/** True when the file path targets a wiki chapter markdown file. */
function isChapterEditPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
  return normalized.startsWith("wiki/chapters/") && normalized.endsWith(".md")
}

/**
 * Given a raw assistant response, return the content suitable for
 * copying to the clipboard. If the response contains chapter edits,
 * returns the cleaned chapter body; otherwise strips hidden blocks
 * from the plain text portion.
 */
export function getCopyableAssistantContent(content: string): string {
  const parsed = parseAgentResponse(content)
  const chapterBodies = parsed.edits
    .filter((edit) => isChapterEditPath(edit.filePath) && edit.replace.trim())
    .map((edit) => cleanGeneratedChapterContentForSave(edit.replace).trim())
    .filter(Boolean)

  if (chapterBodies.length > 0) {
    return chapterBodies.join("\n\n").trim()
  }

  return stripHiddenAssistantBlocks(parsed.textContent || content)
}
