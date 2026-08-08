/**
 * YAML frontmatter parsing and manipulation for Markdown/wiki files.
 *
 * Features:
 * - Strict top-of-file detection with fallback scanning for LLM-corrupted pages
 * - Automatic repair of wikilink list syntax (`related: [[a]], [[b]]` → valid YAML)
 * - Frontmatter preservation during body edits
 * - Robust handling of edge cases (code fence wrappers, nested structures)
 *
 * @license MIT © QMAI
 */

import yaml from "js-yaml"

export type FrontmatterValue = string | string[]

export interface FrontmatterParseResult {
  frontmatter: Record<string, FrontmatterValue> | null
  body: string
  /**
   * The literal frontmatter block (opening `---`, YAML payload,
   * closing `---`, plus newlines separating it from body) as it appears in input.
   * Empty string when no frontmatter exists.
   * Callers editing only the body write back `rawBlock + body` to preserve
   * user-managed YAML untouched.
   */
  rawBlock: string
}

// Strict, anchored detector. Both fence lines must be on their own line.
const FM_BLOCK_STRICT_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/

// Unanchored version used when strict matching fails.
// Handles LLM-generated pages that prepend stray lines before real frontmatter.
const FM_BLOCK_ANYWHERE_RE = /---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
const MAX_PREFIX_LINES_BEFORE_FRONTMATTER = 6

/**
 * Parse a Markdown file's YAML frontmatter block.
 * Returns parsed key-value pairs, body content, and raw block for round-trip preservation.
 * Implements two-pass YAML parsing with wikilink list repair.
 */
export function parseFrontmatter(content: string): FrontmatterParseResult {
  const located = locateFrontmatterBlock(content)
  if (!located) return { frontmatter: null, body: content, rawBlock: "" }

  const { yamlPayload, rawBlock, body } = located

  // Two-pass YAML parse: try raw payload first, then apply wikilink repair
  let parsed: unknown
  try {
    parsed = yaml.load(yamlPayload, { schema: yaml.JSON_SCHEMA })
  } catch {
    try {
      parsed = yaml.load(repairWikilinkLists(yamlPayload), { schema: yaml.JSON_SCHEMA })
    } catch {
      return { frontmatter: null, body, rawBlock }
    }
  }

  return {
    frontmatter: normalize(parsed),
    body,
    rawBlock,
  }
}

/**
 * Locate the first `---…---` frontmatter block in content.
 * 
 * Strategy:
 * 1. Try strict top-of-file match first
 * 2. If fails, scan small window for unanchored block (handles LLM corruption)
 * 3. Return null if neither finds plausible frontmatter
 * 
 * Key insight: opening fence must be within first few lines to exclude
 * section-divider HRs deep in body, but frontmatter itself can be arbitrarily long.
 */
function locateFrontmatterBlock(
  content: string,
): { yamlPayload: string; rawBlock: string; body: string } | null {
  const strict = content.match(FM_BLOCK_STRICT_RE)
  if (strict) {
    return {
      yamlPayload: strict[1],
      rawBlock: strict[0],
      body: content.slice(strict[0].length),
    }
  }

  // Fallback: scan entire content but guard against false positives
  const fallback = content.match(FM_BLOCK_ANYWHERE_RE)
  if (!fallback || fallback.index === undefined) return null

  const openIdx = fallback.index + 1 // Skip leading `\n`
  if (lineNumberAt(content, openIdx) > MAX_PREFIX_LINES_BEFORE_FRONTMATTER) {
    return null
  }

  const rawBlock = content.slice(openIdx, openIdx + fallback[0].length - 1)
  const bodyAfterFm = content.slice(openIdx + rawBlock.length)

  // Handle code fence wrapper cleanup (LLM artifact)
  const prefix = content.slice(0, openIdx)
  const prefixIsYamlFence = /^\s*```(?:yaml|yml)?\s*\r?\n$/i.test(prefix)
  if (prefixIsYamlFence) {
    const stripped = bodyAfterFm.replace(/^\s*```\s*(?:\r?\n|$)/, "")
    return {
      yamlPayload: fallback[1],
      rawBlock,
      body: stripped,
    }
  }

  return {
    yamlPayload: fallback[1],
    rawBlock,
    body: bodyAfterFm,
  }
}

/** Calculate 1-based line number for a given character index. */
function lineNumberAt(s: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < s.length; i++) {
    if (s.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Repair YAML payloads with invalid wikilink list syntax.
 * 
 * Converts patterns like:
 *   related: [[a]], [[b]], [[c]]
 * 
 * To valid YAML:
 *   related: ["[[a]]", "[[b]]", "[[c]]"]
 * 
 * Only touches lines matching exact pattern to avoid mangling legitimate
 * nested-array values like `tags: [[red, blue], [green]]`.
 */
function repairWikilinkLists(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/)
      if (!m) return line
      const prefix = m[1]
      const items = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `"${s}"`)
        .join(", ")
      return `${prefix}[${items}]`
    })
    .join("\n")
}

/**
 * Coerce js-yaml output into format consumed by FrontmatterPanel.
 * 
 * Transformations:
 * - Nested objects/stringified
 * - Non-string scalars stringified
 * - Arrays mapped to string arrays
 * - Null/undefined → empty string
 * 
 * Ensures all YAML data surfaces in UI rather than silently disappearing.
 */
function normalize(parsed: unknown): Record<string, FrontmatterValue> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const out: Record<string, FrontmatterValue> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.map((v) => stringifyScalar(v))
      continue
    }
    out[key] = stringifyScalar(value)
  }
  return out
}

function stringifyScalar(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  // Objects/nested arrays → JSON string to preserve visibility
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
