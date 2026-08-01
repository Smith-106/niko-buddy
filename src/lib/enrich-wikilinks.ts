/**
 * Lightweight post-save enrichment: ask LLM to add [[wikilinks]] to wiki pages.
 *
 * Design philosophy (v2):
 * - Old approach: LLM returns complete rewritten page → models tend to expand/modify content
 * - New approach: LLM only returns JSON list of {term, target} mappings
 * - Code performs precise string replacement for first occurrence per term
 *
 * Benefits:
 * - Content is byte-identical outside inserted [[ ]] brackets
 * - Frontmatter remains untouched
 * - Length increases by exactly 4 × number_of_links
 * - Prevents catastrophic LLM output from corrupting user content
 *
 * @license MIT © QMAI
 */

import { readFile, writeFile } from "@/commands/fs"
import { streamChat } from "./llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildLanguageDirective } from "./output-language"
import { normalizePath } from "@/lib/path-utils"

/**
 * Enrich a wiki page with wikilinks by asking LLM to identify linkable terms.
 * @param projectPath Normalized path to project root
 * @param filePath Normalized path to the wiki file to enrich
 * @param llmConfig Language model configuration
 */
export async function enrichWithWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const fp = normalizePath(filePath)
  const [content, index] = await Promise.all([
    readFile(fp),
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
  ])

  if (!content || !index) return

  // Ask LLM to return JSON list of {term, target} substitutions
  let raw = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: [
          "You identify which terms in a wiki page should become [[wikilinks]] pointing to existing wiki pages.",
          "",
          buildLanguageDirective(content),
          "",
          "You will receive:",
          "  - a wiki index listing existing pages (each line roughly like `- pagename`)",
          "  - the content of ONE wiki page",
          "",
          "Return a JSON object listing which terms in the page content should be linked to which index entries.",
          "",
          "Response format (EXACTLY this JSON shape, nothing else):",
          "{",
          "  \"links\": [",
          "    { \"term\": \"exact text appearing in the content\", \"target\": \"index page name\" }",
          "  ]",
          "}",
          "",
          "Rules:",
          '- Each "term" MUST be a literal substring present in the page content (case-sensitive).',
          '- Each "target" MUST be a page listed in the wiki index.',
          "- Include at most one entry per target (first mention).",
          '- Only include clearly-matching terms (e.g. if content mentions \'Transformer\' and index has \'transformer\', target=\'transformer\' is correct).',
          '- If no terms should be linked, return `{"links": []}`.',
          "- Do NOT output preamble, explanations, or markdown fences — ONLY the JSON object.",
          "",
          `## Wiki Index\n${index}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: `Page content:\n\n${content}`,
      },
    ],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: () => {},
    },
  )

  // Parse the LLM response (tolerate fences/prose wrappers)
  const links = parseLinkResponse(raw)
  if (links.length === 0) return // Nothing to do

  // Apply substitutions to the ORIGINAL content for minimal diff
  const enriched = applyLinks(content, links)
  if (enriched === content) return

  await writeFile(fp, enriched)
  useWikiStore.getState().bumpDataVersion()
}

interface LinkEntry {
  term: string
  target: string
}

/**
 * Parse LLM response into list of link entries.
 * Extracts first balanced {...} block, handles markdown fences.
 * Returns empty array if parsing fails or no valid links found.
 */
function parseLinkResponse(raw: string): LinkEntry[] {
  if (!raw.trim()) return []
  
  // Remove markdown code fences if present
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i)
  
  const start = text.indexOf("{")
  if (start === -1) return []

  // Find matching closing brace with nested structure awareness
  let depth = 0
  let inStr = false
  let escape = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { 
      escape = false
      continue 
    }
    if (ch === "\\" && inStr) { 
      escape = true
      continue 
    }
    if (ch === '"') { 
      inStr = !inStr
      continue 
    }
    if (inStr) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) { 
        end = i
        break 
      }
    }
  }
  if (end === -1) return []

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { links?: unknown }
    if (!parsed || !Array.isArray(parsed.links)) return []
    
    const result: LinkEntry[] = []
    for (const item of parsed.links) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as LinkEntry).term === "string" &&
        typeof (item as LinkEntry).target === "string" &&
        (item as LinkEntry).term.length > 0 &&
        (item as LinkEntry).target.length > 0
      ) {
        result.push({
          term: (item as LinkEntry).term,
          target: (item as LinkEntry).target,
        })
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * For each {term, target}, replace the FIRST literal occurrence of `term`
 * in content (outside frontmatter and existing [[...]]) with `[[target|term]]`
 * if displayed text differs from target, or `[[target]]` if they match case-insensitively.
 * 
 * Skips:
 * - Terms not found as literal substrings
 * - Terms already inside existing wikilinks
 * - Duplicate target assignments (only first term gets linked)
 */
function applyLinks(content: string, links: LinkEntry[]): string {
  // Split off YAML frontmatter so we don't modify it
  const fmEnd = content.startsWith("---\n") ? content.indexOf("\n---\n", 3) : -1
  const frontmatter = fmEnd > 0 ? content.slice(0, fmEnd + 5) : ""
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content

  // Track linked targets to avoid double-linking
  const linkedTargets = new Set<string>()

  for (const { term, target } of links) {
    if (linkedTargets.has(target.toLowerCase())) continue
    if (!term || !target) continue

    // Find first literal occurrence not already inside [[...]] block
    const idx = findUnlinkedOccurrence(body, term)
    if (idx === -1) continue

    const displayEqualsTarget = term.toLowerCase() === target.toLowerCase()
    const replacement = displayEqualsTarget
      ? `[[${term}]]`
      : `[[${target}|${term}]]`
    
    body = body.slice(0, idx) + replacement + body.slice(idx + term.length)
    linkedTargets.add(target.toLowerCase())
  }

  return frontmatter + body
}

/**
 * Find the first occurrence of `term` in text that isn't already wrapped in [[...]].
 * Checks preceding context for existing wikilink markers.
 */
function findUnlinkedOccurrence(text: string, term: string): number {
  let searchFrom = 0
  while (searchFrom < text.length) {
    const idx = text.indexOf(term, searchFrom)
    if (idx === -1) return -1
    
    // Check small window before for [[ (existing wikilink open)
    const windowStart = Math.max(0, idx - 2)
    const window = text.slice(windowStart, idx)
    if (window.endsWith("[[")) {
      searchFrom = idx + term.length
      continue
    }
    return idx
  }
  return -1
}
