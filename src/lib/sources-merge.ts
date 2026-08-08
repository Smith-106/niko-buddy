/**
 * @license MIT © QMAI
 *
 * Frontmatter array-field parsing, writing, and union-merging.
 *
 * Handles the `sources`, `tags`, `related` and any other YAML
 * frontmatter array field.  Two representation forms are accepted
 * on read (inline `[a, b]` and block `- a\n- b`) and a single
 * canonical inline form is always written back.
 */

// ── Generic helpers ────────────────────────────────────────────────

/**
 * Parse a named array field from YAML frontmatter.
 *
 * Supports both inline (`field: ["a","b"]`) and block
 * (`field:\n  - a\n  - b`) representations.  Returns an empty
 * array when the field is absent or the content lacks valid
 * frontmatter.
 */
export function parseFrontmatterArray(content: string, fieldName: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return []
  const body = fmMatch[1]

  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  // Try block form first: field:\n  - item\n  - item
  const blockRe = new RegExp(`^${escaped}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m")
  const blockHit = body.match(blockRe)
  if (blockHit) {
    const items: string[] = []
    for (const line of blockHit[1].split("\n")) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m?.[1]) items.push(m[1].trim())
    }
    return items
  }

  // Inline form: field: ["a", "b"] or field: [a, b]
  const inlineRe = new RegExp(`^${escaped}:\\s*\\[([^\\]]*)\\]`, "m")
  const inlineHit = body.match(inlineRe)
  if (!inlineHit) return []
  const raw = inlineHit[1].trim()
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
}

/**
 * Write (or insert) a named array field into YAML frontmatter.
 *
 * Always emits the inline form `field: ["a", "b"]`.  When the field
 * already exists (inline or block), it is replaced in-place preserving
 * surrounding field order.  When absent the field is appended at the
 * end of the frontmatter block.
 *
 * Returns content unchanged if no frontmatter delimiter is found.
 */
export function writeFrontmatterArray(
  content: string,
  fieldName: string,
  values: string[],
): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!fmMatch) return content

  const [, open, body, close] = fmMatch
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const serialised = values.map((v) => `"${v}"`).join(", ")
  const newLine = `${fieldName}: [${serialised}]`

  // Replace existing inline form
  const inlineRe = new RegExp(`^${escaped}:\\s*\\[[^\\]]*\\]`, "m")
  if (inlineRe.test(body)) {
    return `${open}${body.replace(inlineRe, newLine)}${close}${content.slice(fmMatch[0].length)}`
  }

  // Replace existing block form, normalising to inline
  const blockRe = new RegExp(`^${escaped}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m")
  if (blockRe.test(body)) {
    return `${open}${body.replace(blockRe, newLine)}${close}${content.slice(fmMatch[0].length)}`
  }

  // Field absent — append
  return `${open}${body}\n${newLine}${close}${content.slice(fmMatch[0].length)}`
}

// ── List merging ───────────────────────────────────────────────────

/**
 * Union two string arrays with case-insensitive deduplication.
 * First-seen casing is preserved.
 */
function unionLists(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const s of [...existing, ...incoming]) {
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged
}

// ── Multi-field merge ──────────────────────────────────────────────

/**
 * Union-merge several frontmatter array fields between an existing
 * on-disk document and newly generated content.
 *
 * For each requested field the old and new values are merged and the
 * result is written back.  Returns `newContent` unchanged when no
 * field actually changed (stable reference for cache-key invariance).
 */
export function mergeArrayFieldsIntoContent(
  newContent: string,
  existingContent: string | null,
  fields: readonly string[],
): string {
  if (!existingContent) return newContent
  if (!/^---\n/.test(existingContent)) return newContent

  let output = newContent
  let mutated = false

  for (const field of fields) {
    const oldValues = parseFrontmatterArray(existingContent, field)
    if (oldValues.length === 0) continue
    const newValues = parseFrontmatterArray(output, field)
    const merged = unionLists(oldValues, newValues)
    if (merged.length === newValues.length && merged.every((v, i) => v === newValues[i])) continue
    output = writeFrontmatterArray(output, field, merged)
    mutated = true
  }

  return mutated ? output : newContent
}

// ── Single-field convenience wrappers ──────────────────────────────

/** Extract the `sources` array from frontmatter. */
export function parseSources(content: string): string[] {
  return parseFrontmatterArray(content, "sources")
}

/** Rewrite the `sources` field in frontmatter. */
export function writeSources(content: string, sources: string[]): string {
  return writeFrontmatterArray(content, "sources", sources)
}

/** Case-insensitive union of two source lists. */
export function mergeSourcesLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return unionLists(existing, incoming)
}

/** Convenience wrapper: merge only the `sources` field into content. */
export function mergeSourcesIntoContent(
  newContent: string,
  existingContent: string | null,
): string {
  return mergeArrayFieldsIntoContent(newContent, existingContent, ["sources"])
}
