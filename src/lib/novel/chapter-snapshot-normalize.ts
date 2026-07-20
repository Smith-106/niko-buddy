/**
 * ISS-20260712-ARCH-1 (Wave 1, 第 4 文件): 章节快照规范化叶子层。
 *
 * 从 chapter-ingest.ts 抽出——该集群是纯规范化叶子辅助群 (原始 LLM JSON →
 * 规范化 ChapterSnapshot 结构 + identity 字段推导), 零 LLM/FS 依赖, 零 spec
 * 正则锁定 (3 个 chapter-ingest spec 锁的是 extractSnapshotWithLLM/
 * rebuildFromCommittedSnapshot/parseCharacterStateChange 等, 不锁这 12 个
 * normalize* 叶子)。守 S-20260720-86pp (SRP 巨文件拆分按抽象层分文件) +
 * S-20260720-lndq (零 spec 锁故无需同步 spec 正则)。
 *
 * 类型 (ChapterSnapshot/ValidationWarning/CharacterDetail 等) 留 chapter-ingest.ts
 * (被 ingestChapter 等大量用), 本文件 import type——TS import type 编译时擦除,
 * 不构成运行时循环依赖。chapter-ingest re-export normalizeChapterSnapshot 等
 * 保持向后兼容 (ingestChapter/extractSnapshotWithLLM/ingestOutline 调用点 import
 * 路径不变)。
 */
import { parseChapterNumber } from "./chapter-meta"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { NameAliasMap } from "./book-analysis/types"
import type {
  ChapterSnapshot,
  ValidationWarning,
  CharacterDetail,
  LocationDetail,
  OrganizationDetail,
  ItemDetail,
  EventDetail,
} from "./chapter-ingest"

export function normalizeSnapshotText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = parseChapterNumber(value)
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

export function normalizeSnapshotList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeSnapshotText(item).trim())
      .filter(Boolean)
  }

  const single = normalizeSnapshotText(value).trim()
  return single ? [single] : []
}

export function normalizeSnapshotAliasRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined

  const aliases = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, rawAliases]) => [name.trim(), normalizeSnapshotList(rawAliases)] as const)
      .filter(([name, names]) => name.length > 0 && names.length > 0),
  )

  return Object.keys(aliases).length > 0 ? aliases : undefined
}

/**
 * F-003 (identity-resolution): build per-character NameAliasMap[] from the
 * snapshot's own characterAliases record. Each entry {canonical, aliases} is
 * fed to alias-resolver.matchesAnyAlias so cognition / character-state folds
 * collapse "菜月昴" / "菜月・昴" / "昴" onto one CharacterCognition entry
 * instead of accumulating three. Empty/absent alias records return undefined
 * so callers fall back to the NFKC path in resolveCanonicalName.
 */
export function buildAliasMapsFromSnapshot(snapshot: ChapterSnapshot): NameAliasMap[] | undefined {
  if (!snapshot.characterAliases) return undefined
  const maps: NameAliasMap[] = []
  for (const [canonical, aliases] of Object.entries(snapshot.characterAliases)) {
    if (!canonical.trim()) continue
    maps.push(buildNameAliasMap(canonical, aliases ?? []))
  }
  return maps.length > 0 ? maps : undefined
}

export function normalizeEntityFlags(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, flag]) => [key, Boolean(flag)]),
  )
}

export function normalizeValidationWarnings(value: unknown): ValidationWarning[] | undefined {
  if (!Array.isArray(value)) return undefined
  const warnings = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const rawType = (item as { type?: unknown }).type
    const message = normalizeSnapshotText((item as { message?: unknown }).message).trim()
    if (!message) return []
    if (rawType === "entity_new" || rawType === "canon_conflict") {
      return [{ type: rawType as ValidationWarning["type"], message }]
    }
    return []
  })
  return warnings.length > 0 ? warnings : undefined
}

export function normalizeSnapshotDetailRecord<T extends object>(value: unknown): Record<string, T> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, T>
}

export function normalizeChapterSnapshot(
  value: unknown,
  fallback: Partial<Pick<ChapterSnapshot, "chapterId" | "chapterNumber">> = {},
): ChapterSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const raw = value as Record<string, unknown>
  const chapterNumber = parseChapterNumber(raw.chapterNumber) ?? fallback.chapterNumber ?? 0
  const normalizedChapterId = normalizeSnapshotText(raw.chapterId).trim()
  const chapterId = normalizedChapterId || fallback.chapterId || `chapter-${chapterNumber}`

  return {
    chapterId,
    chapterNumber,
    chapterTitle: normalizeSnapshotText(raw.chapterTitle) || undefined,
    summary: normalizeSnapshotText(raw.summary),
    characters: normalizeSnapshotList(raw.characters),
    characterAliases: normalizeSnapshotAliasRecord(raw.characterAliases),
    locations: normalizeSnapshotList(raw.locations),
    organizations: normalizeSnapshotList(raw.organizations),
    items: normalizeSnapshotList(raw.items),
    events: normalizeSnapshotList(raw.events),
    characterStateChanges: normalizeSnapshotList(raw.characterStateChanges),
    relationshipChanges: normalizeSnapshotList(raw.relationshipChanges),
    knowledgeChanges: normalizeSnapshotList(raw.knowledgeChanges),
    foreshadowingChanges: normalizeSnapshotList(raw.foreshadowingChanges),
    newCanonFacts: normalizeSnapshotList(raw.newCanonFacts),
    timelineEvents: normalizeSnapshotList(raw.timelineEvents),
    conflicts: normalizeSnapshotList(raw.conflicts),
    endingHook: normalizeSnapshotText(raw.endingHook),
    graphNodes: normalizeSnapshotList(raw.graphNodes),
    graphEdges: normalizeSnapshotList(raw.graphEdges),
    sourceType: raw.sourceType === "chapter" || raw.sourceType === "outline" ? raw.sourceType : undefined,
    sourceSequence: normalizePositiveInteger(raw.sourceSequence),
    revision: normalizePositiveInteger(raw.revision),
    snapshotId: normalizeSnapshotText(raw.snapshotId) || undefined,
    supersedes: normalizeSnapshotText(raw.supersedes) || undefined,
    isHistorical: typeof raw.isHistorical === "boolean" ? raw.isHistorical : undefined,
    entityIsNew: normalizeEntityFlags(raw.entityIsNew),
    validationWarnings: normalizeValidationWarnings(raw.validationWarnings),
    memorySyncedAt: normalizeSnapshotText(raw.memorySyncedAt) || undefined,
    characterDetails: normalizeSnapshotDetailRecord<CharacterDetail>(raw.characterDetails),
    locationDetails: normalizeSnapshotDetailRecord<LocationDetail>(raw.locationDetails),
    organizationDetails: normalizeSnapshotDetailRecord<OrganizationDetail>(raw.organizationDetails),
    itemDetails: normalizeSnapshotDetailRecord<ItemDetail>(raw.itemDetails),
    eventDetails: normalizeSnapshotDetailRecord<EventDetail>(raw.eventDetails),
  }
}

export function inferSnapshotSourceType(snapshot: Pick<ChapterSnapshot, "chapterNumber">): "chapter" | "outline" {
  return snapshot.chapterNumber < 0 ? "outline" : "chapter"
}

export function inferSnapshotSourceSequence(snapshot: Pick<ChapterSnapshot, "chapterNumber">): number {
  return Math.abs(snapshot.chapterNumber)
}

export function buildSnapshotRevisionId(snapshot: Pick<ChapterSnapshot, "chapterId">, revision: number): string {
  return `${snapshot.chapterId}-r${revision}`
}

export function ensureSnapshotIdentity(
  snapshot: ChapterSnapshot,
  overrides: Partial<Pick<ChapterSnapshot, "sourceType" | "sourceSequence" | "revision" | "snapshotId" | "supersedes" | "isHistorical">> = {},
): ChapterSnapshot {
  const sourceType = overrides.sourceType ?? snapshot.sourceType ?? inferSnapshotSourceType(snapshot)
  const sourceSequence = overrides.sourceSequence ?? snapshot.sourceSequence ?? inferSnapshotSourceSequence(snapshot)
  const revision = overrides.revision ?? snapshot.revision ?? 1
  const snapshotId = overrides.snapshotId ?? snapshot.snapshotId ?? buildSnapshotRevisionId(snapshot, revision)

  return {
    ...snapshot,
    sourceType,
    sourceSequence,
    revision,
    snapshotId,
    supersedes: overrides.supersedes ?? snapshot.supersedes,
    isHistorical: overrides.isHistorical ?? snapshot.isHistorical ?? false,
  }
}
