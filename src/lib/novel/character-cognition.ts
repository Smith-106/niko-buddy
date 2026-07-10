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

/**
 * EPIC-003 / ADR-32 / TASK-008: 条件路由 ROI 埋点样本。
 *
 * 每次 contextPack 装配后记录一条 A/B 统计样本，用于跨章节验证条件路由
 * （conditionalRoutingEnabled=true）是否降低 contextPack 无关内容占比。
 * G-002/G-003 跨章节数据统计驱动 G-003 长篇规模 ROI 可量化。
 *
 * 写入 cognition-state.json 现有 key（`routingROIBuckets` 字段，additive
 * optional — HARD-1 守恒：不新建第二份真源文件，复用 cognition-state.json）。
 */
export interface RoutingROISample {
  /** A/B 分组：'enabled' = conditionalRoutingEnabled=true，'disabled' = false。 */
  variant: "enabled" | "disabled"
  /** contextPack 内容中与 activeEntities 无关的比例（0~1，启发式标记）。 */
  irrelevantRatio: number
  /** 当前章节号（用于跨章节统计）。 */
  chapterId: string
  /** 采集时间戳 ISO 串。 */
  timestamp: string
}

export interface CognitionState {
  characters: CharacterCognition[]
  readerKnows: string[]
  lastUpdatedChapter: number
  /**
   * EPIC-003 / TASK-008: 条件路由 ROI 埋点样本数组（additive optional）。
   * 跨章节累积，A/B 验证 enabled vs disabled 平均 irrelevantRatio。
   * 缺失时 [] — 向后兼容（pre-TASK-008 cognition-state.json 无此字段）。
   */
  routingROIBuckets?: RoutingROISample[]
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

/**
 * EPIC-003 / ADR-32 / TASK-008: 追加一条条件路由 ROI 埋点样本到 cognition-state.json。
 *
 * 读现有 cognition-state.json → append 样本 → 写回（复用 loadCognitionState +
 * saveCognitionState，HARD-1 守恒：写 cognition-state.json 现有文件非新真源）。
 * 文件不存在时创建最小 CognitionState（空 characters + readerKnows）承载 ROI 样本。
 * 失败非致命（non-fatal）— ROI 采集不影响主链装配。
 *
 * @param projectPath 项目根路径
 * @param sample ROI 样本（variant/irrelevantRatio/chapterId/timestamp）
 */
export async function appendRoutingROISample(
  projectPath: string,
  sample: RoutingROISample,
): Promise<void> {
  const pp = normalizePath(projectPath)
  try {
    const existing = await loadCognitionState(pp)
    const state: CognitionState = existing ?? {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
    }
    const buckets = Array.isArray(state.routingROIBuckets)
      ? state.routingROIBuckets
      : []
    // 上限保护：单项目跨章节累积样本封顶，避免无界增长（LRU-ish 弹最旧）。
    // 1024 条足够 A/B 统计置信度，单条 ~120B → ~120KB 上限可接受。
    const ROI_BUCKETS_MAX = 1024
    const next = [...buckets, sample]
    while (next.length > ROI_BUCKETS_MAX) {
      next.shift()
    }
    state.routingROIBuckets = next
    await saveCognitionState(pp, state)
  } catch {
    // non-fatal — ROI 采集失败不影响主链
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
