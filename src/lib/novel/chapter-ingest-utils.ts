/**
 * chapter-ingest-utils — 章节摄入轻量工具（arch-risk W4 god-object 拆分）。
 *
 * 从 chapter-ingest.ts 抽出的轻量工具：事实主语解析/canon 双写资格/
 * frontmatter 字段提取。主文件只做编排——这些工具独立可测可复用。
 * extractFrontmatter* 顺带收敛 canonical parseFrontmatter（arch-risk W3）。
 */

import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileSize } from "@/commands/fs"
import { toErrorMessage } from "@/lib/utils"
import type { RawCanonEdge } from "./canon-graph-client"

/** 事实陈述 → 主语（：/:/是/属于/为 谓词前缀，无谓词回退前20字）。 */
export function parseFactsSubject(rawFact: string): string {
  const subjectMatch = rawFact.match(/^(.+?)(：|:|是|属于|(?<![名称作因])为)/)
  return subjectMatch ? subjectMatch[1]!.trim() : rawFact.slice(0, 20).trim()
}

/** frontmatter 是否 canon 双写资格（chapter_status final/accepted）。 */
export function isCanonDualWriteEligible(fm: Record<string, unknown>): boolean {
  const status = fm.chapter_status
  return status === "final" || status === "accepted"
}

/** frontmatter 字段 → string（canonical parseFrontmatter）。 */
export function extractFrontmatterString(content: string, key: string): string | null {
  const { frontmatter } = parseFrontmatter(content)
  const v = frontmatter?.[key]
  if (typeof v === "string") return v.trim() || null
  if (v === null || v === undefined) return null
  return String(v).trim() || null
}

/** frontmatter 字段 → number（canonical，可转 number 的 string 也算）。 */
export function extractFrontmatterNumber(content: string, key: string): number | null {
  const { frontmatter } = parseFrontmatter(content)
  const v = frontmatter?.[key]
  /* v8 ignore next -- 台账 chapter-ingest-utils.ts L36：parseFrontmatter 的 normalize 用 stringifyScalar 把所有标量转成 string（frontmatter.ts L174-190），v 恒为 string */
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function isNotFoundError(err: unknown): boolean {
  const message = toErrorMessage(err)
  return /not found|no such file|does not exist|cannot find the (file|path)/i.test(message)
}

/** 原生读取可能把权限错误报为缺失；写路径须用元数据复核。 */
export async function isMissingFile(path: string, err: unknown): Promise<boolean> {
  const message = toErrorMessage(err)
  if (/^(?:File|Path) does not exist:/.test(message)) {
    try {
      await getFileSize(path)
    } catch (metaErr) {
      if (/\bENOENT\b|no such file|\bos error [23]\b|cannot find the (file|path)/i.test(toErrorMessage(metaErr))) {
        return true
      }
      throw metaErr
    }
    return false
  }
  if (/^(?:INVALID_UTF8:|Failed to read exact UTF-8 from )/.test(message)) return false
  return /\bENOENT\b/i.test(message) || isNotFoundError(err)
}

export interface SnapshotKnownByLike {
  povCharacter?: string | null
  presentCharacters?: readonly string[] | null
  characters?: readonly string[] | null
}

export interface CanonFactTriple {
  sourceId: string
  predicate: string
  targetId: string
}

/**
 * 收集快照中知晓事实的角色句柄集合（去重、trim、保序，忽略空串）。
 * 合并顺序：extraHolders → povCharacter → presentCharacters → characters。
 * 供 `chapter-ingest.ts` 与 `canon-backfill.ts` 共用，零 IO、零循环依赖。
 */
export function collectSnapshotKnownBy(
  snapshotLike: SnapshotKnownByLike | null | undefined,
  extraHolders?: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const push = (raw: string | null | undefined): void => {
    if (typeof raw !== "string") return
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    result.push(trimmed)
  }
  if (extraHolders) {
    for (const h of extraHolders) push(h)
  }
  if (snapshotLike) {
    push(snapshotLike.povCharacter)
    if (Array.isArray(snapshotLike.presentCharacters)) {
      for (const c of snapshotLike.presentCharacters) push(c)
    }
    if (Array.isArray(snapshotLike.characters)) {
      for (const c of snapshotLike.characters) push(c)
    }
  }
  return result
}

const COLON_LEADING_VERB_RE =
  /^(已改为|已变为|已成为|名为|改为|变为|被称为|称为|成为|已是|仍是|位于|身处|居住于|属于|持有|拥有|失去|担任|是|为)(.+)$/
const COLON_ATTR_VERB_RE =
  /^(.+?)(已改为|已变为|已成为|名为|改为|变为|称为|成为|已是|仍是|位于|身处|居住于|属于|持有|拥有|失去|担任|是|(?<![名称作因])为)(.+)$/
const POSSESSIVE_ATTR_VERB_RE =
  /^([^的：:]+?)的([^的：:]+?)(已改为|已变为|已成为|名为|改为|变为|称为|成为|已是|仍是|是|(?<![名称作因])为)(.+)$/
const INLINE_VERB_RE =
  /^(.+?)(已改为|已变为|已成为|名为|改为|变为|被称为|称为|成为|位于|身处|居住于|属于|持有|拥有|失去|担任|已是|仍是|是|(?<![名称作因])为)(.+)$/

/**
 * 确定性抽取中文正史事实三元组 `{ sourceId, predicate, targetId }`：
 *   1. `subject：attr：val` / `subject：<verb><val>` / `subject：<attr><verb><val>`
 *   2. `subject的attr是|为|名为|改为|变为val`
 *   3. `<subject><verb><val>`
 *   4. 回退 `parseFactsSubject` + `world_fact`
 *
 * 使同一角色的不同属性边拥有不同谓词而不互撞，同时让跨章同一 `(sourceId, predicate)`
 * 的属性更新自然匹配并触发真实 supersede。供 `chapter-ingest.ts` 与 `canon-backfill.ts` 共用。
 */
export function parseCanonFactTriple(
  rawFact: string,
  fallbackSourceId?: string | null,
): CanonFactTriple {
  const trimmed = rawFact.trim()
  const safeFallback =
    (typeof fallbackSourceId === "string" ? fallbackSourceId.trim() : "") || "unknown"
  if (!trimmed) {
    return { sourceId: safeFallback, predicate: "world_fact", targetId: "" }
  }

  const firstColonIdx = trimmed.search(/[：:]/)
  if (firstColonIdx > 0) {
    const subject = trimmed.slice(0, firstColonIdx).trim()
    const rest = trimmed.slice(firstColonIdx + 1).trim()
    if (subject && rest) {
      const secondColonIdx = rest.search(/[：:]/)
      if (secondColonIdx > 0) {
        const attr = rest.slice(0, secondColonIdx).trim()
        const val = rest.slice(secondColonIdx + 1).trim()
        if (attr && val) {
          return { sourceId: subject, predicate: attr, targetId: val }
        }
      }
      const leadingVerbMatch = rest.match(COLON_LEADING_VERB_RE)
      if (leadingVerbMatch) {
        const predicate = leadingVerbMatch[1]!.trim()
        const targetId = leadingVerbMatch[2]!.trim()
        if (predicate && targetId) {
          return { sourceId: subject, predicate, targetId }
        }
      }
      const attrVerbMatch = rest.match(COLON_ATTR_VERB_RE)
      if (attrVerbMatch) {
        const attr = attrVerbMatch[1]!.trim()
        const val = attrVerbMatch[3]!.trim()
        if (attr && val) {
          return { sourceId: subject, predicate: attr, targetId: val }
        }
      }
    }
  }

  const possessiveMatch = trimmed.match(POSSESSIVE_ATTR_VERB_RE)
  if (possessiveMatch) {
    const sourceId = possessiveMatch[1]!.trim()
    const predicate = possessiveMatch[2]!.trim()
    const targetId = possessiveMatch[4]!.trim()
    if (sourceId && predicate && targetId) {
      return { sourceId, predicate, targetId }
    }
  }

  const inlineVerbMatch = trimmed.match(INLINE_VERB_RE)
  if (inlineVerbMatch) {
    const sourceId = inlineVerbMatch[1]!.trim()
    const predicate = inlineVerbMatch[2]!.trim()
    const targetId = inlineVerbMatch[3]!.trim()
    if (sourceId && predicate && targetId) {
      return { sourceId, predicate, targetId }
    }
  }

  const fallbackSubject = parseFactsSubject(trimmed)
  return {
    sourceId: fallbackSubject || safeFallback,
    predicate: "world_fact",
    targetId: trimmed,
  }
}

export interface MatchPriorEdgeTarget {
  id: string
  source_id: string
  target_id: string
  predicate: string
  edge_kind: string
  modality: string
}

export interface FindMatchingPriorEdgeIdsOptions {
  /**
   * 是否允许将同章既有活跃冲突边（`valid_at === chapterNumber`）纳入待封顶 `old_edge_ids`。
   * 默认 `false`（仅匹配严格早章 `valid_at == null || valid_at < chapterNumber`）。
   * 开启时应配合 `excludeEdgeIds` 传入当前快照待写入的新边 ID，避免同章多条事实互相封顶。
   */
  includeSameChapterConflict?: boolean
  /**
   * 可选：当前快照本轮待写入的新边 ID 集合；命中该集合的边绝不纳入 `old_edge_ids`。
   */
  excludeEdgeIds?: ReadonlySet<string>
}

/**
 * 从先序边集中筛选应被 `newEdge` 封顶（supersede）的活跃同模态冲突边 ID（去重保序）。
 * 供 `chapter-ingest.ts` 与 `canon-backfill.ts` 共用，纯函数、零 IO、零循环依赖。
 */
export function findMatchingPriorEdgeIds(
  priorEdges: readonly RawCanonEdge[],
  chapterNumber: number,
  newEdge: MatchPriorEdgeTarget,
  options?: FindMatchingPriorEdgeIdsOptions,
): string[] {
  if (priorEdges.length === 0) return []
  const includeSameChapter = options?.includeSameChapterConflict === true
  const excludeIds = options?.excludeEdgeIds
  const matched = new Set<string>()
  for (const e of priorEdges) {
    if (!e.id || e.id === newEdge.id) continue
    if (excludeIds?.has(e.id)) continue
    if (e.archived === true) continue
    if (e.invalid_at != null) continue
    if (e.valid_at != null) {
      if (includeSameChapter) {
        if (e.valid_at > chapterNumber) continue
      } else {
        if (e.valid_at >= chapterNumber) continue
      }
    }
    if ((e.edge_kind ?? "world_fact") !== newEdge.edge_kind) continue
    const existingModality = e.modality && e.modality.length > 0 ? e.modality : "assertive"
    if (existingModality !== newEdge.modality) continue
    if (e.source_id !== newEdge.source_id) continue
    if (e.predicate !== newEdge.predicate) continue
    if (e.target_id === newEdge.target_id) continue
    matched.add(e.id)
  }
  return [...matched]
}
