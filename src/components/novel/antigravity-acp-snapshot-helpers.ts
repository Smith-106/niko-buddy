// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Pure read-only helpers for detecting `ChapterSnapshot` JSON payloads inside
 * finalized Antigravity ACP assistant replies.
 *
 * Strictly zero I/O, zero IPC, and zero auto-commit side effects: detected
 * candidates only pre-fill the interactive read-only snapshot preview dialog.
 */

export interface SnapshotJsonCandidate {
  /** Extracted JSON object string ready for `prepareInteractiveChapterSnapshot`. */
  rawJson: string
  /** Positive integer chapter number parsed from `chapterNumber` / `chapter_number`, or null. */
  chapterNumber: number | null
  /** Canonical `ChapterSnapshot` keys present with non-nullish values. */
  detectedFields: string[]
}

const CANONICAL_SNAPSHOT_FIELDS = new Set<string>([
  "chapterId",
  "chapterNumber",
  "chapter_number",
  "chapterTitle",
  "summary",
  "characters",
  "characterAliases",
  "locations",
  "organizations",
  "items",
  "events",
  "characterStateChanges",
  "relationshipChanges",
  "knowledgeChanges",
  "foreshadowingChanges",
  "newCanonFacts",
  "beliefFacts",
  "hypothesisFacts",
  "timelineEvents",
  "conflicts",
  "endingHook",
  "graphNodes",
  "graphEdges",
  "povCharacter",
  "characterDetails",
  "locationDetails",
  "organizationDetails",
  "itemDetails",
  "eventDetails",
])

const PRIMARY_SNAPSHOT_MARKERS = new Set<string>([
  "summary",
  "chapterNumber",
  "chapter_number",
  "characters",
  "events",
  "newCanonFacts",
  "foreshadowingChanges",
  "timelineEvents",
])

const ALLOWED_FENCE_LANGS = new Set<string>(["", "json", "jsonc"])

const FENCED_BLOCK_RE = /```([a-zA-Z0-9_-]*)[ \t]*(?:\r?\n)?([\s\S]*?)```/g

const MAX_UNMATCHED_OPEN_SKIPS = 64

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 ? value : null
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
  }
  return null
}

function canonicalSlotName(key: string): string {
  return key === "chapter_number" ? "chapterNumber" : key
}

function parseSnapshotCandidateFromJson(jsonText: string): SnapshotJsonCandidate | null {
  const trimmed = jsonText.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }

  const record = parsed as Record<string, unknown>
  const detectedFields: string[] = []
  const canonicalSlots = new Set<string>()
  let hasPrimaryMarker = false

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue
    if (!CANONICAL_SNAPSHOT_FIELDS.has(key)) continue
    detectedFields.push(key)
    canonicalSlots.add(canonicalSlotName(key))
    if (PRIMARY_SNAPSHOT_MARKERS.has(key)) {
      hasPrimaryMarker = true
    }
  }

  if (canonicalSlots.size < 2 || !hasPrimaryMarker) {
    return null
  }

  const chapterNumber =
    parsePositiveInteger(record.chapterNumber) ?? parsePositiveInteger(record.chapter_number)

  return {
    rawJson: trimmed,
    chapterNumber,
    detectedFields,
  }
}

function findBalancedClose(
  source: string,
  start: number,
  openChar: "{" | "[",
  closeChar: "}" | "]",
): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let j = start; j < source.length; j++) {
    const ch = source[j]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === openChar) {
      depth += 1
    } else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return -1
}

/**
 * Scan top-level balanced `{ ... }` JSON object slices while respecting string
 * literals, escape sequences, and skipping valid top-level JSON arrays (`[...]`).
 * Bounds unmatched `{` retries for O(N) safety.
 */
function extractBalancedJsonObjects(source: string): string[] {
  const objects: string[] = []
  const len = source.length
  let i = 0
  let unmatchedSkips = 0

  while (i < len) {
    const nextBrace = source.indexOf("{", i)
    if (nextBrace === -1) break

    let skippedArray = false
    let bracketSearch = i
    while (bracketSearch < nextBrace) {
      const nextBracket = source.indexOf("[", bracketSearch)
      if (nextBracket === -1 || nextBracket >= nextBrace) break
      const bracketEnd = findBalancedClose(source, nextBracket, "[", "]")
      if (bracketEnd === -1) {
        bracketSearch = nextBracket + 1
        continue
      }
      if (bracketEnd > nextBrace) {
        const maybeArray = source.slice(nextBracket, bracketEnd + 1)
        try {
          const parsed = JSON.parse(maybeArray)
          if (Array.isArray(parsed)) {
            i = bracketEnd + 1
            skippedArray = true
            break
          }
        } catch {
          // Not a valid JSON array (e.g. prose brackets), continue scanning.
        }
      }
      bracketSearch = bracketEnd + 1
    }
    if (skippedArray) continue

    const end = findBalancedClose(source, nextBrace, "{", "}")
    if (end !== -1) {
      objects.push(source.slice(nextBrace, end + 1))
      i = end + 1
    } else {
      unmatchedSkips += 1
      if (unmatchedSkips > MAX_UNMATCHED_OPEN_SKIPS) break
      i = nextBrace + 1
    }
  }

  return objects
}

/**
 * Detect a `ChapterSnapshot`-shaped JSON payload inside an assistant message.
 *
 * Scans fenced JSON code blocks first (picking the last valid match), then
 * falls back to standalone top-level JSON objects (also picking the last valid
 * match) while ignoring explicitly non-JSON code fences.
 */
export function extractSnapshotJsonCandidate(text: string): SnapshotJsonCandidate | null {
  if (typeof text !== "string" || !text.includes("{")) {
    return null
  }

  let lastFencedMatch: SnapshotJsonCandidate | null = null
  const nonJsonSpans: Array<{ start: number; end: number }> = []

  FENCED_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
    const lang = (match[1] ?? "").trim().toLowerCase()
    const body = match[2] ?? ""
    if (!ALLOWED_FENCE_LANGS.has(lang)) {
      nonJsonSpans.push({ start: match.index, end: match.index + match[0].length })
      continue
    }

    const direct = parseSnapshotCandidateFromJson(body)
    if (direct) {
      lastFencedMatch = direct
      continue
    }

    for (const obj of extractBalancedJsonObjects(body)) {
      const candidate = parseSnapshotCandidateFromJson(obj)
      if (candidate) {
        lastFencedMatch = candidate
      }
    }
  }

  if (lastFencedMatch) {
    return lastFencedMatch
  }

  // Fallback: scan standalone top-level JSON objects outside explicitly non-JSON code fences.
  let scrubbed = text
  if (nonJsonSpans.length > 0) {
    let cursor = 0
    const parts: string[] = []
    for (const span of nonJsonSpans) {
      if (span.start > cursor) {
        parts.push(text.slice(cursor, span.start))
      }
      parts.push(" ")
      cursor = span.end
    }
    if (cursor < text.length) {
      parts.push(text.slice(cursor))
    }
    scrubbed = parts.join("")
  }

  let lastStandaloneMatch: SnapshotJsonCandidate | null = null
  for (const obj of extractBalancedJsonObjects(scrubbed)) {
    const candidate = parseSnapshotCandidateFromJson(obj)
    if (candidate) {
      lastStandaloneMatch = candidate
    }
  }

  return lastStandaloneMatch
}
