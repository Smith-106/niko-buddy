/**
 * Prepares outline drafts for saving: extracts a title from the
 * outline body, sanitizes it, and ensures uniqueness against
 * existing titles in the outline library.
 * MIT License — independently implemented.
 */

import { parseFrontmatter } from "./frontmatter"

/** A draft ready to be persisted as an outline document. */
export interface OutlineSaveDraft {
  title: string
  content: string
}

const TITLE_PREFIX = "AI大纲"

/**
 * Build a save-ready draft from raw outline content.
 * Strips frontmatter, derives a clean title from the body, and
 * resolves collisions against existing outline titles.
 */
export function prepareOutlineSaveDraft(content: string, existingTitles: string[]): OutlineSaveDraft {
  const parsed = parseFrontmatter(content)
  const body = parsed.body.trim()
  const raw = pickTitleFromContent(body)
  const clean = sanitizeTitle(raw)
  const title = ensureUniqueTitle(clean, existingTitles)
  return { title, content: body }
}

/**
 * Scan the first few lines for a heading or short standalone line
 * to use as the outline title. Falls back to a date-stamped prefix.
 */
function pickTitleFromContent(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean)
  for (const line of lines.slice(0, 8)) {
    const heading = line.match(/^#+\s+(.+)/)
    if (heading) return heading[1].trim()
    if (line.length > 2 && line.length < 40 && !line.startsWith("-") && !line.startsWith("*") && !line.includes(":")) {
      return line
    }
  }
  return `${TITLE_PREFIX}-${new Date().toISOString().slice(0, 10)}`
}

/** Remove unsafe filename characters and cap length. */
function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
  return cleaned || `${TITLE_PREFIX}-${new Date().toISOString().slice(0, 10)}`
}

/** Append suffixes until the title is not in the existing set. */
function ensureUniqueTyped(title: string, existing: Set<string>): string {
  if (!existing.has(title)) return title
  const suffixed = `${title}-AI生成`
  if (!existing.has(suffixed)) return suffixed
  for (let n = 2; n <= 99; n++) {
    const candidate = `${suffixed}-${n}`
    if (!existing.has(candidate)) return candidate
  }
  return `${suffixed}-${Date.now()}`
}

function ensureUniqueTitle(title: string, existingTitles: string[]): string {
  const existing = new Set(existingTitles.map((t) => t.trim()).filter(Boolean))
  return ensureUniqueTyped(title, existing)
}
