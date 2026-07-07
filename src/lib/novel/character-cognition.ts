import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { ChapterSnapshot } from "./chapter-ingest"
import { matchesAnyAlias } from "./book-analysis/alias-resolver"
import type { NameAliasMap } from "./book-analysis/types"

export interface CharacterCognition {
  character: string
  knows: string[]
  doesNotKnow: string[]
}

export interface CognitionState {
  characters: CharacterCognition[]
  readerKnows: string[]
  lastUpdatedChapter: number
}

const COGNITION_DIR = ".novel"
const COGNITION_FILENAME = "cognition-state.json"

const NOT_KNOW_RE = /^(.+?)不知道(.+)$/
const READER_KNOW_RE = /^读者知道[了了]?(.+)$/
const KNOW_RE = /^(.+?)知道[了了]?(.+)$/
const EXTRA_KNOW_RES = [/^(.+?)得知[了了]?(.+)$/, /^(.+?)察觉到?(.+)$/, /^(.+?)意识到(.+)$/]

/**
 * F-003 (identity-resolution): NFKC normalize + strip Japanese nakaguro (・)
 * so "菜月昴" / "菜月・昴" collapse to the same canonical key even when no
 * alias map is available. Backwards-compatible fallback — callers that pass
 * an aliasMap get matchesAnyAlias first; this only runs when aliasMap is
 * absent or does not match.
 */
function nfkcCanonical(name: string): string {
  return name.normalize("NFKC").replace(/・/g, "")
}

/**
 * Resolve a raw character name to its canonical form.
 *
 * (1) If aliasMap is provided and matchesAnyAlias hits, use aliasMap.canonical.
 * (2) Otherwise fall back to NFKC + nakaguro-strip so mid-dot variants of the
 *     same name fold together. Returns the trimmed original when no map hits.
 */
export function resolveCanonicalName(name: string, aliasMap?: NameAliasMap): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  if (aliasMap && matchesAnyAlias(trimmed, aliasMap)) {
    return aliasMap.canonical
  }
  return nfkcCanonical(trimmed)
}

/**
 * Given a list of per-character alias maps, find the one whose canonical or
 * alias entries contain `name`. Returns undefined when no map matches — the
 * caller then falls back to resolveCanonicalName's NFKC path.
 */
export function resolveMatchingMap(name: string, aliasMaps?: readonly NameAliasMap[]): NameAliasMap | undefined {
  if (!aliasMaps || aliasMaps.length === 0) return undefined
  const trimmed = name.trim()
  if (!trimmed) return undefined
  for (const map of aliasMaps) {
    if (matchesAnyAlias(trimmed, map)) return map
  }
  return undefined
}

export function emptyCognitionState(): CognitionState {
  return {
    characters: [],
    readerKnows: [],
    lastUpdatedChapter: 0,
  }
}

export function mergeCognitionFromSnapshot(
  current: CognitionState,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): CognitionState {
  const next: CognitionState = {
    characters: current.characters.map(c => ({ ...c, knows: [...c.knows], doesNotKnow: [...c.doesNotKnow] })),
    readerKnows: [...current.readerKnows],
    lastUpdatedChapter: Math.max(current.lastUpdatedChapter, snapshot.chapterNumber),
  }

  for (const change of snapshot.knowledgeChanges) {
    const trimmed = change.trim()
    if (!trimmed) continue

    const notKnowMatch = trimmed.match(NOT_KNOW_RE)
    if (notKnowMatch) {
      const charName = notKnowMatch[1].trim()
      const info = notKnowMatch[2].trim()
      const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
      if (!entry.doesNotKnow.includes(info)) {
        entry.doesNotKnow.push(info)
      }
      continue
    }

    const readerMatch = trimmed.match(READER_KNOW_RE)
    if (readerMatch) {
      const info = readerMatch[1].trim()
      if (!next.readerKnows.includes(info)) {
        next.readerKnows.push(info)
      }
      continue
    }

    const knowMatch = trimmed.match(KNOW_RE)
    if (knowMatch) {
      const charName = knowMatch[1].trim()
      const info = knowMatch[2].trim()
      const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
      if (!entry.knows.includes(info)) {
        entry.knows.push(info)
      }
      entry.doesNotKnow = entry.doesNotKnow.filter(i => i !== info)
      continue
    }

    for (const pattern of EXTRA_KNOW_RES) {
      const extraMatch = trimmed.match(pattern)
      if (extraMatch) {
        const charName = extraMatch[1].trim()
        const info = extraMatch[2].trim()
        const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
        if (!entry.knows.includes(info)) {
          entry.knows.push(info)
        }
        entry.doesNotKnow = entry.doesNotKnow.filter(i => i !== info)
        break
      }
    }
  }

  return next
}

export async function saveCognitionState(projectPath: string, state: CognitionState): Promise<void> {
  const pp = normalizePath(projectPath)
  const dir = `${pp}/${COGNITION_DIR}`
  const filePath = `${dir}/${COGNITION_FILENAME}`
  await createDirectory(dir)
  await writeFileAtomic(filePath, JSON.stringify(state, null, 2))
}

export async function loadCognitionState(projectPath: string): Promise<CognitionState | null> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/${COGNITION_DIR}/${COGNITION_FILENAME}`
  const exists = await fileExists(filePath)
  if (!exists) return null
  try {
    const raw = await readFile(filePath)
    return JSON.parse(raw) as CognitionState
  } catch {
    return null
  }
}

export function cognitionToContextText(state: CognitionState): string {
  if (state.characters.length === 0 && state.readerKnows.length === 0) return ""

  const lines: string[] = []

  for (const char of state.characters) {
    if (char.knows.length > 0) {
      lines.push(`${char.character}知道：${char.knows.join("、")}`)
    }
    if (char.doesNotKnow.length > 0) {
      lines.push(`${char.character}不知道：${char.doesNotKnow.join("、")}`)
    }
  }

  if (state.readerKnows.length > 0) {
    lines.push(`读者知道：${state.readerKnows.join("、")}`)
  }

  return lines.join("\n")
}

function ensureCharacter(state: CognitionState, name: string, aliasMap?: NameAliasMap): CharacterCognition {
  const canonical = resolveCanonicalName(name, aliasMap)
  let entry = state.characters.find(c => c.character === canonical)
  if (!entry) {
    entry = { character: canonical, knows: [], doesNotKnow: [] }
    state.characters.push(entry)
  }
  return entry
}
