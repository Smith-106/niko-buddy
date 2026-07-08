import { readFile, writeFileAtomic, listDirectory, fileExists, createDirectory, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, isFinalChapter, parseChapterNumber } from "./chapter-meta"
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import type { LlmConfig } from "@/stores/wiki-store"
import { canonicalizeSnapshotCharacters, writeSnapshotToWiki, writePatchFieldsToWiki, sanitizeEntitySlug } from "./graph-adapter"
import { resolveNovelModel } from "./model-resolver"
import { emptyCognitionState, mergeCognitionFromSnapshot, loadCognitionState, saveCognitionState, resolveCanonicalName, resolveMatchingMap } from "./character-cognition"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { NameAliasMap } from "./book-analysis/types"
import { createEmptyCharacterStateStore, loadCharacterStates, saveCharacterStates, type CharacterStateStore } from "./character-state"
import { createEmptyForeshadowingStore, loadForeshadowingTracker, saveForeshadowingTracker, type Foreshadowing, type ForeshadowingStore } from "./foreshadowing-tracker"
import { createEmptyEmotionalArcStore, loadEmotionalArcs, saveEmotionalArcs, type EmotionalArcStore } from "./emotional-arcs"
import { createEmptySubplotBoardStore, loadSubplotBoard, saveSubplotBoard } from "./subplot-board"
import { createEmptyResourceLedgerStore, loadResourceLedger, saveResourceLedger, type ResourceLedgerStore } from "./resource-ledger"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { shouldRebuildCommunitySummaries, generateCommunitySummaries } from "./community-summary"
import { buildChapterIngestOutput, type ChapterIngestOutput } from "./chapter-ingest-output"
import { createChapterPipeline } from "./chapter-pipeline"
import { mergeSnapshotTimeline } from "./timeline"
import { buildStructuredMemoryDocuments, isValidMemorySnapshot } from "./memory-rebuild"
import { clearGraphCache } from "@/lib/graph-relevance"
import { clearTemporalFactsCache } from "./context-engine"
import {
  loadProjectionStatusLedger,
  recordProjectionStatus,
  saveProjectionStatusLedger,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"

export interface ValidationWarning {
  type: "entity_new" | "canon_conflict"
  message: string
}

export interface CharacterDetail {
  identity: string
  faction: string
  goals: string
  arcChange: string
}

export interface LocationDetail {
  region: string
  type: string
  controller: string
  hiddenInfo: string
}

export interface OrganizationDetail {
  leader: string
  members: string
  goals: string
  resources: string
}

export interface ItemDetail {
  holder: string
  previousHolders: string
  abilities: string
  limitations: string
  origin: string
}

export interface EventDetail {
  cause: string
  process: string
  relatedForeshadowing: string
  relatedConflicts: string
  followUpItems: string
}

export interface ChapterSnapshot {
  chapterId: string
  chapterNumber: number
  chapterTitle?: string
  summary: string
  characters: string[]
  characterAliases?: Record<string, string[]>
  locations: string[]
  organizations: string[]
  items: string[]
  events: string[]
  characterStateChanges: string[]
  relationshipChanges: string[]
  knowledgeChanges: string[]
  foreshadowingChanges: string[]
  newCanonFacts: string[]
  timelineEvents: string[]
  conflicts: string[]
  endingHook: string
  graphNodes: string[]
  graphEdges: string[]
  sourceType?: "chapter" | "outline"
  sourceSequence?: number
  revision?: number
  snapshotId?: string
  supersedes?: string
  isHistorical?: boolean
  entityIsNew?: Record<string, boolean>
  validationWarnings?: ValidationWarning[]
  memorySyncedAt?: string
  characterDetails?: Record<string, CharacterDetail>
  locationDetails?: Record<string, LocationDetail>
  organizationDetails?: Record<string, OrganizationDetail>
  itemDetails?: Record<string, ItemDetail>
  eventDetails?: Record<string, EventDetail>
}

function extractFirstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") {
      depth += 1
      continue
    }
    if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

function extractJsonObjectFromModelText(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  return extractFirstBalancedJsonObject(fenced ?? text)
}

function normalizeSnapshotText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = parseChapterNumber(value)
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function normalizeSnapshotList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeSnapshotText(item).trim())
      .filter(Boolean)
  }

  const single = normalizeSnapshotText(value).trim()
  return single ? [single] : []
}

function normalizeSnapshotAliasRecord(value: unknown): Record<string, string[]> | undefined {
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
function buildAliasMapsFromSnapshot(snapshot: ChapterSnapshot): NameAliasMap[] | undefined {
  if (!snapshot.characterAliases) return undefined
  const maps: NameAliasMap[] = []
  for (const [canonical, aliases] of Object.entries(snapshot.characterAliases)) {
    if (!canonical.trim()) continue
    maps.push(buildNameAliasMap(canonical, aliases ?? []))
  }
  return maps.length > 0 ? maps : undefined
}

function normalizeEntityFlags(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, flag]) => [key, Boolean(flag)]),
  )
}

function normalizeValidationWarnings(value: unknown): ValidationWarning[] | undefined {
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

function normalizeSnapshotDetailRecord<T extends object>(value: unknown): Record<string, T> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, T>
}

function normalizeChapterSnapshot(
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

function inferSnapshotSourceType(snapshot: Pick<ChapterSnapshot, "chapterNumber">): "chapter" | "outline" {
  return snapshot.chapterNumber < 0 ? "outline" : "chapter"
}

function inferSnapshotSourceSequence(snapshot: Pick<ChapterSnapshot, "chapterNumber">): number {
  return Math.abs(snapshot.chapterNumber)
}

function buildSnapshotRevisionId(snapshot: Pick<ChapterSnapshot, "chapterId">, revision: number): string {
  return `${snapshot.chapterId}-r${revision}`
}

function ensureSnapshotIdentity(
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

async function readCurrentSnapshot(projectPath: string, chapterNumber: number): Promise<ChapterSnapshot | null> {
  try {
    const raw = await readFile(snapshotJsonPath(projectPath, chapterNumber))
    const parsed = normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
    return parsed ? ensureSnapshotIdentity(parsed) : null
  } catch {
    return null
  }
}

function materializeNextCurrentSnapshot(snapshot: ChapterSnapshot, currentSnapshot: ChapterSnapshot | null): ChapterSnapshot {
  const existing = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  const nextRevisionBase = Math.max(existing?.revision ?? 0, snapshot.revision ?? 0)
  const nextRevision = nextRevisionBase > 0 ? nextRevisionBase + 1 : 1
  return ensureSnapshotIdentity(snapshot, {
    sourceType: snapshot.sourceType ?? existing?.sourceType ?? inferSnapshotSourceType(snapshot),
    sourceSequence: snapshot.sourceSequence ?? existing?.sourceSequence ?? inferSnapshotSourceSequence(snapshot),
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(snapshot, nextRevision),
    supersedes: existing?.snapshotId ?? snapshot.snapshotId,
    isHistorical: false,
  })
}

function materializeRestoredCurrentSnapshot(
  archivedSnapshot: ChapterSnapshot,
  currentSnapshot: ChapterSnapshot | null,
): ChapterSnapshot {
  const archived = ensureSnapshotIdentity(archivedSnapshot, { isHistorical: true })
  const current = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  const nextRevision = Math.max(archived.revision ?? 1, current?.revision ?? 0) + 1
  return ensureSnapshotIdentity(archived, {
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(archived, nextRevision),
    supersedes: current?.snapshotId ?? archived.snapshotId,
    isHistorical: false,
  })
}

export type IngestFailReason = "no_llm" | "not_chapter" | "not_final" | "invalid_chapter_number" | "extract_failed" | "cancelled"

export interface IngestResult {
  snapshot: ChapterSnapshot | null
  failReason?: IngestFailReason
}

export async function ingestChapter(
  projectPath: string,
  chapterPath: string,
  _reviewModel?: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const pp = normalizePath(projectPath)
  const novelMode = useWikiStore.getState().novelMode
  if (!novelMode) return { snapshot: null }

  const llmConfig = useWikiStore.getState().llmConfig
  const novelConfig = useWikiStore.getState().novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换）
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  if (!hasUsableLlm(runtimeLlmConfig)) return { snapshot: null, failReason: "no_llm" }

  const content = await readFile(chapterPath)
  const parsed = parseFrontmatter(content)
  const fm = parsed.frontmatter as Record<string, unknown> | null
  if (!fm || !isChapterPage(fm)) return { snapshot: null, failReason: "not_chapter" }
  if (!isFinalChapter(fm)) {
    console.warn(`[Chapter Ingest] Chapter status is not final, skipping ingest.`)
    return { snapshot: null, failReason: "not_final" }
  }

  const chapterNumber = parseChapterNumber(fm.chapter_number) ?? 0
  if (chapterNumber <= 0) {
    console.warn("[Chapter Ingest] Invalid chapter number, skipping ingest.")
    return { snapshot: null, failReason: "invalid_chapter_number" }
  }
  const body = parsed.body

  if (signal?.aborted) return { snapshot: null, failReason: "cancelled" }
  const extractedSnapshot = await extractSnapshotWithLLM(chapterNumber, body, runtimeLlmConfig, signal)
  const snapshot = extractedSnapshot ? canonicalizeSnapshotCharacters(extractedSnapshot) : null

  if (!snapshot) {
    return { snapshot: null, failReason: "extract_failed" as IngestFailReason }
  }

  if (snapshot) {
    try {
      const entityWarnings = await validateEntityReferences(pp, snapshot)
      const canonWarnings = await validateCanonConflicts(pp, snapshot)
      snapshot.validationWarnings = [...entityWarnings, ...canonWarnings]
      snapshot.entityIsNew = snapshot.entityIsNew || {}
    } catch (err) {
      console.warn("[Chapter Ingest] Validation failed:", err instanceof Error ? err.message : err)
      snapshot.validationWarnings = []
      snapshot.entityIsNew = {}
    }
    await saveSnapshot(pp, snapshot)
    await saveChapterIngestOutput(pp, snapshot, {
      title: typeof fm.title === "string" ? fm.title : undefined,
    })
  }

  const embCfg = useWikiStore.getState().embeddingConfig

  // F-002 (ANL-010 / C-002): commit-then-project. The commit point above
  // (saveSnapshot + saveChapterIngestOutput, per-file-atomic via
  // writeFileAtomic) is the immutable fact layer. Everything below is a
  // DERIVED projection — each runs independently and is tracked by the
  // ProjectionStatusLedger so a mid-ingest failure is VISIBLE and
  // recoverable instead of silently swallowed (the prior 8-segment
  // error-handlers only console.warn'd, leaving corrupted projections
  // undetectable). On failure: idempotent/fold_rebuildable projections are
  // rebuilt on the next ingest via rebuildFromCommittedSnapshot;
  // mutates_existing_non_rebuildable (graph) triggers delete+re-fold.
  //
  // Single error-handler wraps the whole projection loop (was 7 independent
  // handlers) — a projection's failure is recorded to the ledger and
  // the loop CONTINUES to the next projection, so one bad projection does
  // not skip the rest. The ledger is persisted after the loop.
  let projectionLedger: ProjectionStatusLedger
  try {
    projectionLedger = await loadProjectionStatusLedger(pp)
  } catch {
    projectionLedger = { projections: {}, chapters: {} }
  }
  // CORR-111 fix: derive chapterNo from the frontmatter-validated chapter
  // number (line ~392, available regardless of snapshot extraction outcome),
  // NOT from `snapshot?.chapterNumber ?? 0`. The vector projection below runs
  // OUTSIDE the `if (snapshot)` guard (it uses content/fm, not snapshot), so
  // when extraction fails (snapshot === null) the prior `?? 0` recorded the
  // embedding under chapter 0 — orphaning the ledger entry and risking a
  // duplicate embedding on re-ingest under the real number. Frontmatter
  // validation already guarantees chapterNumber > 0 here (invalid numbers
  // early-return at the parseChapterNumber guard above).
  const chapterNo = chapterNumber
  // CORR-007: captured from inside runProjection('sync_snapshot_to_memory')
  // so the return value can carry memorySyncedAt (runProjection returns void).
  let memorySyncedAt: string | undefined

  const runProjection = async (
    projection: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await fn()
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "committed")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[Chapter Ingest] Projection "${projection}" failed:`, message)
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "failed", message)
    }
  }

  try {
    // single_snapshot_idempotent: vector embedding.
    if (embCfg.enabled && embCfg.model) {
      await runProjection("vector", async () => {
        const { embedPage } = await import("@/lib/embedding")
        const pageId = chapterPath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? ""
        if (pageId) {
          const title = typeof fm?.title === "string" ? fm.title : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        }
      })
    }

    if (snapshot) {
      // mutates_existing_non_rebuildable: graph entity pages (writeSnapshotToWiki).
      await runProjection("graph_entity_pages", async () => {
        const writtenPaths = await writeSnapshotToWiki(pp, snapshot)
        if (writtenPaths.length > 0) {
          console.log(`[Chapter Ingest] Wrote ${writtenPaths.length} entity pages from snapshot`)
        }
      })

      // mutates_existing_non_rebuildable: graph wiki-patch fields.
      // CORR-009 fix: distinct ledger key from the snapshot-write above so the
      // ledger can independently track each path's commit/fail status (the
      // prior shared 'graph_entity_pages' key masked partial failures).
      await runProjection("graph_entity_patch_fields", async () => {
        const patchPath = `${pp}/.novel/chapter-ingest-output/${String(snapshot.chapterNumber).padStart(3, "0")}.wiki-patch.json`
        const patchJson = await readFile(patchPath)
        const patch = JSON.parse(patchJson)
        const patchPaths = await writePatchFieldsToWiki(pp, patch)
        if (patchPaths.length > 0) {
          console.log(`[Chapter Ingest] Wrote ${patchPaths.length} entity pages from wiki patch fields`)
        }
      })

      // fold_rebuildable: cognition state.
      if (snapshot.knowledgeChanges.length > 0) {
        await runProjection("cognition", async () => {
          const existing = await loadCognitionState(pp) ?? emptyCognitionState()
          const updated = mergeCognitionFromSnapshot(existing, snapshot, buildAliasMapsFromSnapshot(snapshot))
          await saveCognitionState(pp, updated)
        })
      }

      // fold_rebuildable: character state.
      if (snapshot.characterStateChanges.length > 0) {
        await runProjection("character", async () => {
          const existingChars = await loadCharacterStates(pp)
          const aliasMaps = buildAliasMapsFromSnapshot(snapshot)
          // CORR-001/002 fix: the live ingest path now calls the same
          // applyCharacterStateChangesToStore helper as rebuildFromCommittedSnapshot
          // (matching the emotional-arcs/resource-ledger pattern at ~611-624),
          // so fullwidth-colon "角色名：状态" lines parse identically on both
          // paths. The shared parseCharacterStateChange helper guarantees the
          // fold_rebuildable contract (ingest == rebuild).
          applyCharacterStateChangesToStore(existingChars, snapshot, aliasMaps)
          await saveCharacterStates(pp, existingChars)
        })
      }

      // fold_rebuildable: foreshadowing.
      if (snapshot.foreshadowingChanges.length > 0) {
        await runProjection("foreshadow", async () => {
          const existingForeshadows = await loadForeshadowingTracker(pp)
          // CORR-001/002 fix: the live ingest path now calls the same
          // applyForeshadowingChangesToStore helper as rebuildFromCommittedSnapshot
          // (matching the emotional-arcs/resource-ledger pattern at ~611-624),
          // so fullwidth-colon "新增：/推进：/回收：" lines parse identically on
          // both paths. The shared parseForeshadowingChange helper guarantees the
          // fold_rebuildable contract (ingest == rebuild). applyForeshadowingChangesToStore
          // takes no aliasMaps param (foreshadow matching is name-substring, not
          // alias-resolved) — signature unchanged.
          applyForeshadowingChangesToStore(existingForeshadows, snapshot)
          await saveForeshadowingTracker(pp, existingForeshadows)
        })
      }

      // R4 (S4 / ANL-013): fold_rebuildable — emotional arcs. Derived from
      // snapshot.characterDetails[name].arcChange. No new LLM extract field
      // (additive only); failure → ledger (IC-02: no silent degrade).
      await runProjection("emotional_arc", async () => {
        const arcStore = await loadEmotionalArcs(pp)
        applyEmotionalArcsToStore(arcStore, snapshot, buildAliasMapsFromSnapshot(snapshot))
        await saveEmotionalArcs(pp, arcStore)
      })

      // R4 (S4 / ANL-013): fold_rebuildable — resource ledger. Derived from
      // snapshot.itemDetails[name].holder + previousHolders. No new LLM
      // extract field (additive only); failure → ledger (IC-02).
      await runProjection("resource_ledger", async () => {
        const ledger = await loadResourceLedger(pp)
        applyResourceLedgerToStore(ledger, snapshot, buildAliasMapsFromSnapshot(snapshot))
        await saveResourceLedger(pp, ledger)
      })

      // R4 (S4 / ANL-013): fold_rebuildable — subplot board. ANL-013 G2
      // audit: QMAI has no支线剧情进度 projection. The snapshot has no
      // dedicated subplot field yet (LLM extract-prompt extension is out of
      // scope for this additive projection-infra task), so this commits an
      // empty store until a snapshot field is added — but the projection is
      // REGISTERED + tracked so future wiring is a one-line change. The
      // projection stays alive (committed-empty, not missing) so the ledger
      // shows it is reachable. Failure → ledger (IC-02).
      await runProjection("subplot_board", async () => {
        const board = await loadSubplotBoard(pp)
        board.lastUpdated = new Date().toISOString()
        await saveSubplotBoard(pp, board)
      })

      // fold_rebuildable: summary_structured_memory.
      await runProjection("summary_structured_memory", async () => {
        const memoryPaths = await exportStructuredMemoryToWiki(pp, snapshot)
        if (memoryPaths.length > 0) {
          console.log(`[Chapter Ingest] Wrote ${memoryPaths.length} structured memory pages`)
        }
      })
    }

    // CORR-007 fix: syncSnapshotToMemory runs inside the projection ledger
    // (was outside the try/finally, exempt from the F-002 recoverable-failure
    // contract — a sync failure threw unhandled while the ledger already
    // claimed success). Tracked as fold_rebuildable.
    if (snapshot) {
      await runProjection("sync_snapshot_to_memory", async () => {
        const res = await syncSnapshotToMemory(pp, snapshot)
        memorySyncedAt = res.memorySyncedAt
      })
    }
  } finally {
    // Persist the ledger regardless of whether the loop threw — a partially-
    // updated ledger still tells the next ingest which projections need rebuild.
    try {
      await saveProjectionStatusLedger(pp, projectionLedger)
    } catch (err) {
      console.warn("[Chapter Ingest] ProjectionStatusLedger save failed:", err instanceof Error ? err.message : err)
    }
  }

  // 社区摘要定期重建
  if (snapshot && shouldRebuildCommunitySummaries(snapshot.chapterNumber, novelConfig)) {
    const rebuildCommunitySummaries = async () => {
      try {
        await generateCommunitySummaries(pp, llmConfig, novelConfig)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn("[Chapter Ingest] 社区摘要生成失败:", message)
        // 弹窗提示（通过 store 触发 UI 通知）
        useWikiStore.getState().setCommunitySummaryError(message)
      }
    }

    if (novelConfig.communitySummaryAsync) {
      // 后台异步执行，不阻塞章节摄取
      void rebuildCommunitySummaries()
    } else {
      // 同步等待
      await rebuildCommunitySummaries()
    }
  }

  return { snapshot: { ...snapshot, memorySyncedAt } }
}

export const ingestChapterPipeline = createChapterPipeline({ ingestChapter })

function normalizeOutlineIngestError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/request cancelled|aborted|cancelled/i.test(message)) {
    return new Error("大纲摄取已中断，请稍后重试")
  }
  return new Error(message)
}

async function extractSnapshotWithLLM(
  chapterNumber: number,
  chapterBody: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<ChapterSnapshot | null> {
  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)

  const systemPrompt = `你是一个专业的小说编辑助手。你的任务是从给定的章节正文中提取结构化信息。
请严格按照 JSON 格式输出，不要输出任何其他内容。
${langReminder}`

  const userPrompt = `请从以下章节中提取结构化信息，输出 JSON：

章节编号：第${chapterNumber}章

章节正文：
${chapterBody.slice(0, 8000)}

请输出以下格式的 JSON：
{
  "chapterId": "chapter-${chapterNumber}",
  "chapterNumber": ${chapterNumber},
  "summary": "章节摘要（200字以内）",
  "characters": ["出场人物列表"],
  "characterAliases": { "人物正式名": ["昵称", "小名", "旧名"] },
  "locations": ["出场地点列表"],
  "organizations": ["出场组织列表"],
  "items": ["出场物品列表"],
  "events": ["关键事件列表"],
  "characterStateChanges": ["人物状态变化描述"],
  "relationshipChanges": ["人物关系变化描述"],
  "knowledgeChanges": ["角色认知变化描述"],
  "foreshadowingChanges": ["伏笔变化描述（新增/推进/回收）"],
  "newCanonFacts": ["新增正史设定"],
  "timelineEvents": ["时间线事件"],
  "conflicts": ["冲突变化描述"],
  "endingHook": "章节结尾钩子描述",
  "graphNodes": ["图谱节点列表"],
  "graphEdges": ["图谱关系边列表，格式：A->关系->B。关系必须是以下之一：出场于|发生于|属于|持有|敌对|合作|怀疑|隐瞒|知道|不知道|推进伏笔|回收伏笔|新增伏笔|导致|揭示|影响|位于"],
  "characterDetails": {
    "人物名": {
      "identity": "身份（具体身份描述）",
      "faction": "阵营（所属势力或立场）",
      "goals": "目标（当前章节中的目标）",
      "arcChange": "弧光变化（本章中该人物的成长或变化）"
    }
  },
  "locationDetails": {
    "地点名": {
      "region": "区域（所属地理区域）",
      "type": "类型（场景类型，如宫殿、森林、密室等）",
      "controller": "控制者（当前控制该地点的势力或人物）",
      "hiddenInfo": "隐藏信息（地点中的秘密或未揭示的设定）"
    }
  },
  "organizationDetails": {
    "组织名": {
      "leader": "领导者",
      "members": "成员（本章出现或提及的成员）",
      "goals": "目标（组织当前的目标）",
      "resources": "资源（组织掌控的资源）"
    }
  },
  "itemDetails": {
    "物品名": {
      "holder": "当前持有者",
      "previousHolders": "前持有者",
      "abilities": "能力（物品的功能或能力）",
      "limitations": "限制（使用限制或副作用）",
      "origin": "来源（物品的来历）"
    }
  },
  "eventDetails": {
    "事件名": {
      "cause": "起因（事件的触发原因）",
      "process": "过程（事件的发展过程）",
      "relatedForeshadowing": "关联伏笔（与此事件相关的伏笔）",
      "relatedConflicts": "关联冲突（与此事件相关的冲突）",
      "followUpItems": "后续事项（事件引发的后续影响或待处理事项）"
    }
  }
}

注意：如果同一个人物在正文里有昵称、小名、旧名或全名，请把正式名放进 characters，把其他称呼放进 characterAliases，不要把同一人物拆成多个 characters。
注意：characterDetails、locationDetails、organizationDetails、itemDetails、eventDetails 仅在章节中确实有相关信息时才填写；如果某个字段没有相关信息，直接省略该字段即可。`

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]
    const snapshotSchema = {
      type: "object",
      properties: {
        chapterId: { type: "string" },
        chapterNumber: { type: "number" },
        summary: { type: "string" },
        characters: { type: "array", items: { type: "string" } },
        characterAliases: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
        },
        locations: { type: "array", items: { type: "string" } },
        organizations: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "string" } },
        events: { type: "array", items: { type: "string" } },
        characterStateChanges: { type: "array", items: { type: "string" } },
        relationshipChanges: { type: "array", items: { type: "string" } },
        knowledgeChanges: { type: "array", items: { type: "string" } },
        foreshadowingChanges: { type: "array", items: { type: "string" } },
        newCanonFacts: { type: "array", items: { type: "string" } },
        timelineEvents: { type: "array", items: { type: "string" } },
        conflicts: { type: "array", items: { type: "string" } },
        endingHook: { type: "string" },
        graphNodes: { type: "array", items: { type: "string" } },
        graphEdges: { type: "array", items: { type: "string" } },
      },
      required: [
        "chapterId",
        "chapterNumber",
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
        "timelineEvents",
        "conflicts",
        "endingHook",
        "graphNodes",
        "graphEdges",
      ],
    } satisfies Record<string, unknown>

    let result = ""
    let streamError: Error | null = null
    const callbacks: StreamCallbacks = {
      onToken: (token: string) => {
        result += token
      },
      onDone: () => {},
      onError: (error: Error) => {
        streamError = error
      },
    }

    await streamChat(llmConfig, messages, callbacks, signal, {
      jsonSchema: snapshotSchema,
    })
    if (streamError) throw streamError

    const jsonText = extractJsonObjectFromModelText(result)
    if (!jsonText) {
      throw new Error("章节快照提取失败：模型没有返回可解析的 JSON")
    }

    const parsed = JSON.parse(jsonText)
    return normalizeChapterSnapshot({
      ...parsed,
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
      entityIsNew: {},
      validationWarnings: [],
      characterDetails: parsed.characterDetails || undefined,
      locationDetails: parsed.locationDetails || undefined,
      organizationDetails: parsed.organizationDetails || undefined,
      itemDetails: parsed.itemDetails || undefined,
      eventDetails: parsed.eventDetails || undefined,
    }, { chapterId: `chapter-${chapterNumber}`, chapterNumber })
  } catch (err) {
    console.error("[Chapter Ingest] Failed to extract snapshot:", err)
    throw err
  }
}

function snapshotToMarkdown(snapshot: ChapterSnapshot): string {
  const md = [
    `# 第${snapshot.chapterNumber}章 快照`,
    "",
    `## 摘要`,
    snapshot.summary,
    "",
    `## 出场人物`,
    ...(snapshot.characters.length > 0 ? snapshot.characters.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 出场地点`,
    ...(snapshot.locations.length > 0 ? snapshot.locations.map(l => `- ${l}`) : ["（无）"]),
    "",
    `## 出场组织`,
    ...(snapshot.organizations.length > 0 ? snapshot.organizations.map(o => `- ${o}`) : ["（无）"]),
    "",
    `## 出场物品`,
    ...(snapshot.items.length > 0 ? snapshot.items.map(i => `- ${i}`) : ["（无）"]),
    "",
    `## 关键事件`,
    ...(snapshot.events.length > 0 ? snapshot.events.map(e => `- ${e}`) : ["（无）"]),
    "",
    `## 人物状态变化`,
    ...(snapshot.characterStateChanges.length > 0 ? snapshot.characterStateChanges.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 人物关系变化`,
    ...(snapshot.relationshipChanges.length > 0 ? snapshot.relationshipChanges.map(r => `- ${r}`) : ["（无）"]),
    "",
    `## 角色认知变化`,
    ...(snapshot.knowledgeChanges.length > 0 ? snapshot.knowledgeChanges.map(k => `- ${k}`) : ["（无）"]),
    "",
    `## 伏笔变化`,
    ...(snapshot.foreshadowingChanges.length > 0 ? snapshot.foreshadowingChanges.map(f => `- ${f}`) : ["（无）"]),
    "",
    `## 新增正史设定`,
    ...(snapshot.newCanonFacts.length > 0 ? snapshot.newCanonFacts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 时间线事件`,
    ...(snapshot.timelineEvents.length > 0 ? snapshot.timelineEvents.map(t => `- ${t}`) : ["（无）"]),
    "",
    `## 冲突变化`,
    ...(snapshot.conflicts.length > 0 ? snapshot.conflicts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 结尾钩子`,
    snapshot.endingHook || "（无）",
    "",
    `## 图谱节点`,
    ...(snapshot.graphNodes.length > 0 ? snapshot.graphNodes.map(g => `- ${g}`) : ["（无）"]),
    "",
    `## 图谱关系边`,
    ...(snapshot.graphEdges.length > 0 ? snapshot.graphEdges.map(g => `- ${g}`) : ["（无）"]),
  ]

  if (snapshot.validationWarnings && snapshot.validationWarnings.length > 0) {
    md.push(
      "",
      `## 校验警告`,
      ...snapshot.validationWarnings.map(w => `- [${w.type}] ${w.message}`),
    )
  }

  return md.join("\n")
}

export interface SnapshotHistoryEntry {
  fileName: string
  path: string
  createdAt: string
}

function snapshotFilePrefix(chapterNumber: number): string {
  if (chapterNumber < 0) return `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
  return String(chapterNumber).padStart(3, "0")
}

function snapshotJsonPath(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.json`
}

function snapshotMarkdownPath(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.md`
}

function snapshotHistoryDir(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/history/${snapshotFilePrefix(chapterNumber)}`
}

function snapshotHistoryFileName(): string {
  return `${new Date().toISOString().replace(/:/g, "-")}.snapshot.json`
}

async function backupSnapshotBeforeOverwrite(projectPath: string, chapterNumber: number): Promise<void> {
  const currentJsonPath = snapshotJsonPath(projectPath, chapterNumber)
  if (!(await fileExists(currentJsonPath))) return
  const currentRaw = await readFile(currentJsonPath)
  const normalizedCurrent = normalizeChapterSnapshot(JSON.parse(currentRaw), {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
  })
  const currentJson = normalizedCurrent
    ? JSON.stringify(ensureSnapshotIdentity(normalizedCurrent, { isHistorical: true }), null, 2)
    : currentRaw
  const historyDir = snapshotHistoryDir(projectPath, chapterNumber)
  await createDirectory(historyDir)
  await writeFileAtomic(`${historyDir}/${snapshotHistoryFileName()}`, currentJson)
}

export async function listSnapshotHistory(projectPath: string, chapterNumber: number): Promise<SnapshotHistoryEntry[]> {
  const pp = normalizePath(projectPath)
  const historyDir = snapshotHistoryDir(pp, chapterNumber)
  try {
    const nodes = await listDirectory(historyDir)
    return nodes
      .filter(node => !node.is_dir && node.name.endsWith(".snapshot.json"))
      .map(node => ({
        fileName: node.name,
        path: node.path,
        createdAt: node.name.replace(/\.snapshot\.json$/, "").replace(/-(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/, ":$1:$2.$3Z"),
      }))
      .sort((a, b) => b.fileName.localeCompare(a.fileName))
  } catch {
    return []
  }
}

export async function restoreSnapshotHistory(
  projectPath: string,
  chapterNumber: number,
  historyFileName: string,
): Promise<ChapterSnapshot> {
  const pp = normalizePath(projectPath)
  const currentSnapshot = await readCurrentSnapshot(pp, chapterNumber)
  await backupSnapshotBeforeOverwrite(pp, chapterNumber)
  // SEC-003: historyFileName is user-supplied (e.g. from the UI snapshot-history
  // picker). Reject path traversal: no separators, no parent-dir, must be a
  // bare `*.snapshot.json` filename so `${dir}/${historyFileName}` cannot
  // escape the chapter's snapshot-history directory.
  const safeName = (historyFileName ?? "").trim()
  if (!safeName || /[\/\\]/.test(safeName) || safeName.includes("..") || !safeName.endsWith(".snapshot.json")) {
    throw new Error("Invalid snapshot history file name.")
  }
  const historyPath = `${snapshotHistoryDir(pp, chapterNumber)}/${safeName}`
  const snapshot = normalizeChapterSnapshot(
    JSON.parse(await readFile(historyPath)),
    { chapterId: `chapter-${chapterNumber}`, chapterNumber },
  )
  if (!snapshot) {
    throw new Error("Invalid snapshot history file.")
  }
  const restoredCurrent = materializeRestoredCurrentSnapshot(snapshot, currentSnapshot)
  await saveSnapshot(pp, restoredCurrent)
  const writtenEntityPaths = await writeSnapshotToWiki(pp, restoredCurrent)
  await cleanupSupersededEntityFiles(pp, restoredCurrent, writtenEntityPaths)
  await rebuildDerivedMemoryFromSnapshots(pp, restoredCurrent)
  // ARCH-006 (REG-001 sibling): restoring a history snapshot replaces the
  // current snapshot content, so the mtime-keyed temporalFactsCache may hold
  // pre-restore facts — clear it for this project (same root cause as the
  // delete path fixed in REG-001; restore was missed).
  clearTemporalFactsCache(pp)
  clearGraphCache()
  useWikiStore.getState().bumpDataVersion()
  return restoredCurrent
}

export async function saveEditedSnapshot(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const pp = normalizePath(projectPath)
  const currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  const normalizedSnapshot = normalizeChapterSnapshot(snapshot, {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  await backupSnapshotBeforeOverwrite(pp, snapshot.chapterNumber)
  await saveSnapshot(pp, materializeNextCurrentSnapshot(normalizedSnapshot, currentSnapshot))
  // ARCH-006 (REG-001 sibling): overwriting the current snapshot changes its
  // content/mtime, so the mtime-keyed temporalFactsCache may hold stale facts
  // from the pre-edit version — clear it for this project (same root cause as
  // delete/restore; saveEdited was missed).
  clearTemporalFactsCache(pp)
}

function appendPreviewSection(lines: string[], title: string, items: string[]): void {
  lines.push(`${title}：`)
  if (items.length === 0) {
    lines.push("- 无")
  } else {
    lines.push(...items.map(item => `- ${item}`))
  }
  lines.push("")
}

export function buildSnapshotMemorySyncPreview(snapshot: ChapterSnapshot): string {
  const graphItems = [
    ...snapshot.characters,
    ...snapshot.locations,
    ...snapshot.organizations,
    ...snapshot.items,
    ...snapshot.events,
  ]
  const uniqueGraphItems = Array.from(new Set(graphItems.filter(Boolean)))
  const lines = ["本次将同步以下内容：", ""]

  appendPreviewSection(lines, "人物状态", snapshot.characterStateChanges)
  appendPreviewSection(lines, "角色认知", snapshot.knowledgeChanges)
  appendPreviewSection(lines, "伏笔追踪", snapshot.foreshadowingChanges)
  appendPreviewSection(lines, "实体页 / 图谱", uniqueGraphItems)
  appendPreviewSection(lines, "RAG 记忆页面", ["章节快照记忆", "角色认知状态", "人物状态记忆", "伏笔追踪记忆"])

  return lines.join("\n").trimEnd()
}

async function listActualChapterNumbers(projectPath: string): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const chaptersDir = `${pp}/wiki/chapters`
  try {
    const nodes = await listDirectory(chaptersDir)
    const chapterNumbers = await Promise.all(
      nodes
        .filter((node) => !node.is_dir && node.name.endsWith(".md"))
        .map(async (node) => {
          try {
            const parsed = parseFrontmatter(await readFile(node.path))
            const frontmatter = parsed.frontmatter as Record<string, unknown> | null
            if (!frontmatter || !isChapterPage(frontmatter)) {
              return null
            }
            return parseChapterNumber(frontmatter.chapter_number)
          } catch {
            return null
          }
        }),
    )
    return chapterNumbers.filter((chapterNumber): chapterNumber is number => Number.isFinite(chapterNumber))
  } catch {
    return []
  }
}

async function loadValidMemorySnapshots(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
): Promise<ChapterSnapshot[]> {
  const pp = normalizePath(projectPath)
  const actualChapterNumbers = await listActualChapterNumbers(pp)
  const snapshotNumbers = await listSnapshots(pp)
  const snapshotMap = new Map<number, ChapterSnapshot>()

  const loadedSnapshots = await Promise.all(snapshotNumbers.map((chapterNumber) => loadSnapshot(pp, chapterNumber)))
  for (const loadedSnapshot of loadedSnapshots) {
    if (isValidMemorySnapshot(loadedSnapshot, actualChapterNumbers)) {
      snapshotMap.set(loadedSnapshot.chapterNumber, loadedSnapshot)
    }
  }

  if (isValidMemorySnapshot(latestSnapshot ?? null, actualChapterNumbers)) {
    snapshotMap.set(latestSnapshot!.chapterNumber, latestSnapshot!)
  }

  return [...snapshotMap.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export async function exportStructuredMemoryToWiki(projectPath: string, snapshot: ChapterSnapshot): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const snapshots = await loadValidMemorySnapshots(pp, snapshot)
  if (snapshots.length === 0) {
    return []
  }
  return writeStructuredMemoryDocuments(pp, snapshots)
}

async function writeStructuredMemoryDocuments(projectPath: string, snapshots: ChapterSnapshot[]): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const memoryDir = `${pp}/wiki/memory`
  const memoryDocuments = buildStructuredMemoryDocuments(snapshots)

  await createDirectory(memoryDir)
  const writtenPaths: string[] = []
  for (const [fileName, content] of Object.entries(memoryDocuments)) {
    const filePath = `${memoryDir}/${fileName}`
    await writeFileAtomic(filePath, content)
    writtenPaths.push(filePath)
  }
  return writtenPaths
}

export interface SyncSnapshotToMemoryResult {
  writtenEntityPaths: string[]
  memoryPagePaths: string[]
  memorySyncedAt: string
}

export async function syncSnapshotToMemory(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<SyncSnapshotToMemoryResult> {
  const pp = normalizePath(projectPath)
  const currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  const memorySyncedAt = new Date().toISOString()
  const normalizedSnapshot = normalizeChapterSnapshot(
    { ...snapshot, memorySyncedAt },
    { chapterId: snapshot.chapterId, chapterNumber: snapshot.chapterNumber },
  )
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const syncedSnapshot = materializeNextCurrentSnapshot(normalizedSnapshot, currentSnapshot)

  // 获取同步前该快照关联的旧实体文件（用于清理）
  const entitiesDir = `${pp}/wiki/entities`
  let oldEntityFiles: string[] = []
  try {
    const tree = await listDirectory(entitiesDir)
    oldEntityFiles = tree.filter(f => f.name.endsWith(".md")).map(f => f.name)
  } catch { /* entities dir may not exist */ }

  const writtenEntityPaths = await writeSnapshotToWiki(pp, syncedSnapshot)
  await cleanupSupersededEntityFiles(pp, syncedSnapshot, writtenEntityPaths)

  // 清理旧实体：如果一个实体文件不在新写入列表中，且其内容引用了当前快照的 source，则删除
  const writtenFileNames = new Set(writtenEntityPaths.map(p => p.split("/").pop() ?? ""))
  const snapshotSourceFiles = new Set(snapshotSourceFileNameCandidates(syncedSnapshot.chapterNumber))

  for (const oldFile of oldEntityFiles) {
    if (writtenFileNames.has(oldFile)) continue // 仍然存在于新快照中，保留
    try {
      const filePath = `${entitiesDir}/${oldFile}`
      const content = await readFile(filePath)
      if (shouldDeleteSupersededProjectionContent(content, syncedSnapshot)) {
        await deleteFile(filePath)
        continue
      }
      // 只删除引用了当前快照 source 的实体文件
      if (Array.from(snapshotSourceFiles).some(sourceFile => content.includes(sourceFile))) {
        // 检查是否还被其他快照引用
        const allSources = content.match(/[A-Za-z0-9_-]+\.snapshot\.json/g) ?? []
        const onlyCurrentSource = allSources.length > 0 && allSources.every(s => snapshotSourceFiles.has(s))
        if (onlyCurrentSource) {
          await deleteFile(filePath)
        }
      }
    } catch { /* skip errors */ }
  }

  if (syncedSnapshot.knowledgeChanges.length > 0) {
    const existing = await loadCognitionState(pp) ?? emptyCognitionState()
    const updated = mergeCognitionFromSnapshot(existing, syncedSnapshot, buildAliasMapsFromSnapshot(syncedSnapshot))
    await saveCognitionState(pp, updated)
  }

  if (syncedSnapshot.characterStateChanges.length > 0) {
    await syncCharacterStateChanges(pp, syncedSnapshot)
  }

  if (syncedSnapshot.foreshadowingChanges.length > 0) {
    await syncForeshadowingChanges(pp, syncedSnapshot)
  }

  await backupSnapshotBeforeOverwrite(pp, syncedSnapshot.chapterNumber)
  await saveSnapshot(pp, syncedSnapshot)
  const memoryPagePaths = await exportStructuredMemoryToWiki(pp, syncedSnapshot)
  // ARCH-005/EG-006 (REG-001 sibling): syncSnapshotToMemory rewrites the
  // current snapshot + entity pages + cognition/character/foreshadow stores,
  // so the mtime-keyed temporalFactsCache may hold pre-sync facts. clearGraphCache
  // alone is insufficient (temporalFactsCache is a separate module-level cache).
  // Note (ARCH-005 SoC, recorded decision): this path still calls sync*Changes
  // helpers directly rather than via runProjection — wrapping it in the
  // ProjectionStatusLedger is a larger SoC refactor tracked separately; the
  // concrete cache-invalidation gap (the REG-001 sibling) is fixed here.
  clearTemporalFactsCache(pp)
  clearGraphCache()
  useWikiStore.getState().bumpDataVersion()

  return { writtenEntityPaths, memoryPagePaths, memorySyncedAt }
}

function snapshotSourceFileNameCandidates(chapterNumber: number): string[] {
  const canonical = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}.snapshot.json`
    : `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  const legacy = `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  return Array.from(new Set([canonical, legacy]))
}

function extractFrontmatterString(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))
  return match?.[1]?.trim() || null
}

function extractFrontmatterNumber(content: string, key: string): number | null {
  const value = extractFrontmatterString(content, key)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function shouldDeleteSupersededProjectionContent(content: string, snapshot: ChapterSnapshot): boolean {
  const currentSnapshot = ensureSnapshotIdentity(snapshot)
  const snapshotId = extractFrontmatterString(content, "snapshot_id")
  if (snapshotId && currentSnapshot.supersedes && snapshotId === currentSnapshot.supersedes) {
    return true
  }

  const sourceType = extractFrontmatterString(content, "source_type")
  const sourceSequence = extractFrontmatterNumber(content, "source_sequence")
  const sourceRevision = extractFrontmatterNumber(content, "source_revision")
  if (
    sourceType
    && sourceSequence
    && sourceRevision
    && sourceType === currentSnapshot.sourceType
    && sourceSequence === currentSnapshot.sourceSequence
    && sourceRevision < (currentSnapshot.revision ?? 1)
  ) {
    return true
  }

  return false
}

async function cleanupSupersededEntityFiles(
  projectPath: string,
  snapshot: ChapterSnapshot,
  writtenEntityPaths: string[],
): Promise<void> {
  const entitiesDir = `${projectPath}/wiki/entities`
  const writtenFileNames = new Set(writtenEntityPaths.map((path) => path.split("/").pop() ?? ""))
  const snapshotSourceFiles = new Set(snapshotSourceFileNameCandidates(snapshot.chapterNumber))

  let oldEntityFiles: string[] = []
  try {
    const tree = await listDirectory(entitiesDir)
    oldEntityFiles = tree.filter((file) => file.name.endsWith(".md")).map((file) => file.name)
  } catch {
    return
  }

  for (const oldFile of oldEntityFiles) {
    if (writtenFileNames.has(oldFile)) continue
    try {
      const filePath = `${entitiesDir}/${oldFile}`
      const content = await readFile(filePath)
      if (shouldDeleteSupersededProjectionContent(content, snapshot)) {
        await deleteFile(filePath)
        continue
      }
      if (Array.from(snapshotSourceFiles).some((sourceFile) => content.includes(sourceFile))) {
        const allSources = content.match(/[A-Za-z0-9_-]+\.snapshot\.json/g) ?? []
        const onlyCurrentSource = allSources.length > 0 && allSources.every((sourceFile) => snapshotSourceFiles.has(sourceFile))
        if (onlyCurrentSource) {
          await deleteFile(filePath)
        }
      }
    } catch {
      // ignore cleanup failures per file
    }
  }
}

/**
 * CORR-001/002 fix: shared colon parser for character-state change lines.
 * Accepts both ASCII ":" and fullwidth "：" (Chinese LLM default). Returns
 * {charName, changeDesc} split at the first colon, or null when the change
 * has no colon (freeform string — handled by the weak includes-fallback in
 * applyCharacterStateChangesToStore). Shared by the live ingest path and
 * applyCharacterStateChangesToStore so the fold is deterministic
 * (fold_rebuildable contract — ingest == rebuild for fullwidth-colon lines).
 */
function parseCharacterStateChange(change: string): { charName: string; changeDesc: string } | null {
  const colonIdx = change.search(/[:：]/)
  if (colonIdx <= 0) return null
  return {
    charName: change.slice(0, colonIdx).trim(),
    changeDesc: change.slice(colonIdx + 1).trim(),
  }
}

/**
 * CORR-001/002 fix: shared colon parser for foreshadowing change lines.
 * Accepts both ASCII ":" and fullwidth "：" (Chinese LLM default). Classifies
 * the line as add/advance/resolve via the /^(新增伏笔|新增|推进伏笔|推进|回收伏笔|回收)[:：]/
 * guards. Shared by the live ingest path and applyForeshadowingChangesToStore
 * so the fold is deterministic (fold_rebuildable contract — ingest == rebuild
 * for fullwidth-colon lines). Returns null for unrecognized lines.
 */
function parseForeshadowingChange(change: string):
  | { kind: "add"; name: string; desc: string }
  | { kind: "advance"; name: string; desc: string }
  | { kind: "resolve"; name: string; desc: string }
  | null {
  const trimmed = change.trim()
  if (/^(新增伏笔|新增)[:：]/.test(trimmed)) {
    const content = trimmed.replace(/^(新增伏笔|新增)[:：]?\s*/, "")
    const dashIdx = content.indexOf("-")
    return {
      kind: "add",
      name: dashIdx > 0 ? content.slice(0, dashIdx).trim() : content.trim(),
      desc: dashIdx > 0 ? content.slice(dashIdx + 1).trim() : "",
    }
  }
  if (/^(推进伏笔|推进)[:：]/.test(trimmed)) {
    return {
      kind: "advance",
      name: trimmed.replace(/^(推进伏笔|推进)[:：]?\s*/, "").trim(),
      desc: "",
    }
  }
  if (/^(回收伏笔|回收)[:：]/.test(trimmed)) {
    return {
      kind: "resolve",
      name: trimmed.replace(/^(回收伏笔|回收)[:：]?\s*/, "").trim(),
      desc: "",
    }
  }
  return null
}

function applyCharacterStateChangesToStore(
  existingChars: CharacterStateStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): CharacterStateStore {
  for (const change of snapshot.characterStateChanges) {
    const parsed = parseCharacterStateChange(change)
    if (parsed) {
      const { charName, changeDesc } = parsed
      const canonical = resolveCanonicalName(charName, resolveMatchingMap(charName, aliasMaps))
      const existing = existingChars.characters.find(c => c.characterName === canonical)
      if (existing) {
        existing.status = changeDesc
        existing.lastUpdatedChapter = snapshot.chapterNumber
        existing.lastUpdatedAt = new Date().toISOString()
      } else {
        existingChars.characters.push({
          characterName: canonical,
          currentLocation: "",
          status: changeDesc,
          equipment: [],
          abilities: [],
          relationships: {},
          lastUpdatedChapter: snapshot.chapterNumber,
          lastUpdatedAt: new Date().toISOString(),
        })
      }
    } else {
      const matched = existingChars.characters.find(c => change.includes(c.characterName))
      if (matched) {
        matched.status = change
        matched.lastUpdatedChapter = snapshot.chapterNumber
        matched.lastUpdatedAt = new Date().toISOString()
      }
    }
  }
  existingChars.lastUpdated = new Date().toISOString()
  return existingChars
}

async function syncCharacterStateChanges(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const existingChars = await loadCharacterStates(projectPath)
  applyCharacterStateChangesToStore(existingChars, snapshot, buildAliasMapsFromSnapshot(snapshot))
  await saveCharacterStates(projectPath, existingChars)
}

function applyForeshadowingChangesToStore(existingForeshadows: ForeshadowingStore, snapshot: ChapterSnapshot): ForeshadowingStore {
  for (const change of snapshot.foreshadowingChanges) {
    const parsed = parseForeshadowingChange(change)
    if (!parsed) continue
    if (parsed.kind === "add") {
      // fold_rebuildable idempotency (CORR-104): an "add" foreshadow is keyed
      // by (plantedChapter, name). Re-ingesting the same snapshot MUST NOT
      // append a duplicate with a fresh length+1 id — otherwise live re-ingest
      // diverges from a clean rebuild (which folds each snapshot exactly once)
      // and ids collide/drift. If an item with the same name was already
      // planted by this chapter, update it in place instead of pushing.
      const existing = existingForeshadows.items.find(
        f => f.name === parsed.name && f.plantedChapter === snapshot.chapterNumber,
      )
      if (existing) {
        existing.description = parsed.desc
      } else {
        const newForeshadow: Foreshadowing = {
          id: `fs-${snapshot.chapterNumber}-${existingForeshadows.items.length + 1}`,
          name: parsed.name,
          description: parsed.desc,
          status: "planted",
          plantedChapter: snapshot.chapterNumber,
          advancedChapters: [],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        }
        existingForeshadows.items.push(newForeshadow)
      }
    } else if (parsed.kind === "advance") {
      const matched = existingForeshadows.items.find(
        f => f.name === parsed.name || parsed.name.includes(f.name) || f.name.includes(parsed.name)
      )
      if (matched) {
        matched.status = "advanced"
        if (!matched.advancedChapters.includes(snapshot.chapterNumber)) {
          matched.advancedChapters.push(snapshot.chapterNumber)
        }
      }
    } else if (parsed.kind === "resolve") {
      const matched = existingForeshadows.items.find(
        f => f.name === parsed.name || parsed.name.includes(f.name) || f.name.includes(parsed.name)
      )
      if (matched) {
        matched.status = "resolved"
        matched.resolvedChapter = snapshot.chapterNumber
      }
    }
  }
  existingForeshadows.lastUpdated = new Date().toISOString()
  return existingForeshadows
}

async function syncForeshadowingChanges(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const existingForeshadows = await loadForeshadowingTracker(projectPath)
  applyForeshadowingChangesToStore(existingForeshadows, snapshot)
  await saveForeshadowingTracker(projectPath, existingForeshadows)
}

/**
 * R4 (S4 / ANL-013): fold emotional-arc beats from a snapshot's
 * characterDetails.arcChange into the store. Shared by ingest + rebuild so
 * the fold is deterministic (fold_rebuildable contract — re-folding the
 * committed snapshot sequence yields the same beats).
 */
function applyEmotionalArcsToStore(
  arcStore: EmotionalArcStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): EmotionalArcStore {
  const details = snapshot.characterDetails ?? {}
  for (const [rawName, detail] of Object.entries(details)) {
    const arcChange = (detail?.arcChange ?? "").trim()
    if (!arcChange) continue
    const canonical = resolveCanonicalName(rawName, resolveMatchingMap(rawName, aliasMaps))
    // fold_rebuildable idempotency (CORR-103): a beat is keyed by
    // (character, chapterNumber). Re-ingesting the same snapshot (or re-running
    // the fold over a store that already holds this chapter's beat) MUST update
    // the existing beat rather than append a duplicate — otherwise live re-ingest
    // diverges from a clean rebuild (which folds each snapshot exactly once).
    const existing = arcStore.beats.find(
      b => b.character === canonical && b.chapterNumber === snapshot.chapterNumber,
    )
    if (existing) {
      existing.emotion = arcChange
    } else {
      arcStore.beats.push({
        character: canonical,
        chapterNumber: snapshot.chapterNumber,
        emotion: arcChange,
        intensity: 0,
        trigger: "",
        notes: "",
      })
    }
  }
  arcStore.lastUpdated = new Date().toISOString()
  return arcStore
}

/**
 * R4 (S4 / ANL-013): fold resource-ledger entries from a snapshot's
 * itemDetails.holder / previousHolders. Shared by ingest + rebuild so the
 * fold is deterministic (fold_rebuildable contract). Each chapter's holder
 * becomes a transfer entry; the first holder seeds acquiredChapter.
 */
function applyResourceLedgerToStore(
  ledger: ResourceLedgerStore,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): ResourceLedgerStore {
  const details = snapshot.itemDetails ?? {}
  for (const [itemName, detail] of Object.entries(details)) {
    const rawHolder = (detail?.holder ?? "").trim()
    if (!itemName) continue
    const entry = ledger.entries.find((e) => e.item === itemName)
    const canonicalHolder = rawHolder
      ? resolveCanonicalName(rawHolder, resolveMatchingMap(rawHolder, aliasMaps))
      : ""
    if (!entry) {
      ledger.entries.push({
        item: itemName,
        currentHolder: canonicalHolder,
        acquiredChapter: snapshot.chapterNumber,
        transferredFrom: (detail?.previousHolders ?? "").trim() || undefined,
        transferHistory: canonicalHolder
          ? [{ fromChapter: snapshot.chapterNumber, fromHolder: "", toHolder: canonicalHolder }]
          : [],
      })
    } else if (canonicalHolder && canonicalHolder !== entry.currentHolder) {
      entry.transferHistory.push({
        fromChapter: snapshot.chapterNumber,
        fromHolder: entry.currentHolder,
        toHolder: canonicalHolder,
      })
      entry.currentHolder = canonicalHolder
    }
  }
  ledger.lastUpdated = new Date().toISOString()
  return ledger
}

/**
 * F-002 (ANL-010 R4 / C-002): rebuild ALL derived projections from the
 * committed snapshot sequence. Previously `rebuildDerivedMemoryFromSnapshots`
 * only re-derived cognition / character / foreshadow / structured-memory
 * (the `fold_rebuildable` ledger category) — vector and graph projections
 * were NOT rebuilt, so a corrupted vector index or stale graph entity page
 * could not be recovered without re-running ingest.
 *
 * This extended rebuild now covers:
 *   - fold_rebuildable: cognition / character / foreshadow / structured-memory
 *     (re-derived by folding the snapshot sequence from empty — unchanged)
 *   - mutates_existing_non_rebuildable: graph entity pages — delete+re-fold
 *     via cleanupSupersededEntityFiles + writeSnapshotToWiki (the delete-first
 *     rebuild path; the supersession model in graph-adapter preserves version
 *     history during normal ingest, but a full rebuild clears stale pages)
 *   - single_snapshot_idempotent (vector): re-embed each chapter from its
 *     snapshot content (idempotent — re-embedding the same content yields the
 *     same vector state; safe to retry)
 *
 * LanceDB has NO transaction API (ANL-010 C4), so this is a per-projection
 * rebuild, not a single atomic transaction — the ProjectionStatusLedger
 * tracks each projection's rebuild status so a mid-rebuild crash leaves a
 * partially-rebuilt but detectable state.
 */
async function rebuildFromCommittedSnapshot(projectPath: string, latestSnapshot?: ChapterSnapshot): Promise<void> {
  const snapshots = await loadValidMemorySnapshots(projectPath, latestSnapshot)

  // fold_rebuildable: cognition / character / foreshadow / structured-memory
  const cognitionState = snapshots.reduce(
    (state, snapshot) => mergeCognitionFromSnapshot(state, snapshot, buildAliasMapsFromSnapshot(snapshot)),
    emptyCognitionState(),
  )
  await saveCognitionState(projectPath, cognitionState)

  const characterStateStore = createEmptyCharacterStateStore()
  for (const snapshot of snapshots) {
    applyCharacterStateChangesToStore(characterStateStore, snapshot, buildAliasMapsFromSnapshot(snapshot))
  }
  await saveCharacterStates(projectPath, characterStateStore)

  const foreshadowingStore = createEmptyForeshadowingStore()
  for (const snapshot of snapshots) {
    applyForeshadowingChangesToStore(foreshadowingStore, snapshot)
  }
  await saveForeshadowingTracker(projectPath, foreshadowingStore)

  // R4 (S4 / ANL-013): fold_rebuildable — emotional arcs / resource ledger /
  // subplot board. Re-folded from the committed snapshot sequence (same
  // shared apply* helpers as ingest → deterministic rebuild). Subplot board
  // has no snapshot field yet → commits empty (projection stays alive).
  const emotionalArcStore = createEmptyEmotionalArcStore()
  const resourceLedger = createEmptyResourceLedgerStore()
  const subplotBoard = createEmptySubplotBoardStore()
  for (const snapshot of snapshots) {
    const aliasMaps = buildAliasMapsFromSnapshot(snapshot)
    applyEmotionalArcsToStore(emotionalArcStore, snapshot, aliasMaps)
    applyResourceLedgerToStore(resourceLedger, snapshot, aliasMaps)
  }
  await saveEmotionalArcs(projectPath, emotionalArcStore)
  await saveResourceLedger(projectPath, resourceLedger)
  subplotBoard.lastUpdated = new Date().toISOString()
  await saveSubplotBoard(projectPath, subplotBoard)

  await writeStructuredMemoryDocuments(projectPath, snapshots)

  // mutates_existing_non_rebuildable: graph entity pages — delete+re-fold.
  // Re-write every snapshot's entity pages from scratch; stale pages not
  // produced by any snapshot are cleaned up by cleanupSupersededEntityFiles.
  for (const snapshot of snapshots) {
    try {
      const writtenPaths = await writeSnapshotToWiki(projectPath, snapshot)
      if (snapshots.length > 0 && snapshot.chapterNumber === snapshots[snapshots.length - 1]?.chapterNumber) {
        await cleanupSupersededEntityFiles(projectPath, snapshot, writtenPaths)
      }
    } catch (err) {
      console.warn("[Chapter Ingest] Graph projection rebuild failed for chapter", snapshot.chapterNumber, err instanceof Error ? err.message : err)
    }
  }

  // single_snapshot_idempotent: vector — re-embed each chapter from its
  // snapshot summary. Idempotent: re-embedding the same content is safe.
  // (Snapshots carry `summary` + structured fields, not raw chapter content;
  // the summary is the canonical re-embeddable text.)
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const snapshot of snapshots) {
        const pageId = String(snapshot.chapterNumber).padStart(3, "0")
        const title = snapshot.chapterTitle || pageId
        // Re-embed from the snapshot's summary (idempotent rebuild).
        await embedPage(projectPath, pageId, title, snapshot.summary ?? "", embCfg)
      }
    } catch (err) {
      console.warn("[Chapter Ingest] Vector projection rebuild failed:", err instanceof Error ? err.message : err)
    }
  }
}

/**
 * F-002: backward-compatible alias. Existing callers (restoreSnapshotHistory,
 * deleteChapterSnapshots) reference rebuildDerivedMemoryFromSnapshots; route
 * them to the extended rebuildFromCommittedSnapshot covering vector+graph.
 */
async function rebuildDerivedMemoryFromSnapshots(projectPath: string, latestSnapshot?: ChapterSnapshot): Promise<void> {
  return rebuildFromCommittedSnapshot(projectPath, latestSnapshot)
}

async function saveSnapshot(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const canonicalSnapshot = ensureSnapshotIdentity(canonicalizeSnapshotCharacters(snapshot))
  const normalizedSnapshot = normalizeChapterSnapshot(canonicalSnapshot, {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const snapshotDir = `${projectPath}/.novel/snapshots`
  const jsonPath = snapshotJsonPath(projectPath, normalizedSnapshot.chapterNumber)
  const mdPath = snapshotMarkdownPath(projectPath, normalizedSnapshot.chapterNumber)

  await createDirectory(snapshotDir)
  await writeFileAtomic(jsonPath, JSON.stringify(normalizedSnapshot, null, 2))
  await writeFileAtomic(mdPath, snapshotToMarkdown(normalizedSnapshot))

  await mergeSnapshotTimeline(projectPath, normalizedSnapshot.chapterNumber, normalizedSnapshot.timelineEvents)
}

async function saveChapterIngestOutput(projectPath: string, snapshot: ChapterSnapshot, options: { title?: string } = {}): Promise<ChapterIngestOutput> {
  const output = buildChapterIngestOutput(snapshot, options)
  const outputDir = `${projectPath}/.novel/chapter-ingest-output`
  const prefix = `${outputDir}/${String(snapshot.chapterNumber).padStart(3, "0")}`

  await createDirectory(outputDir)
  await writeFileAtomic(`${prefix}.output.json`, JSON.stringify(output, null, 2))
  await writeFileAtomic(`${prefix}.wiki-patch.json`, JSON.stringify(output.wikiUpdatePatch, null, 2))
  await writeFileAtomic(`${prefix}.search-index.json`, JSON.stringify(output.searchIndexText, null, 2))
  await writeFileAtomic(`${prefix}.vector-index.json`, JSON.stringify(output.vectorIndexText, null, 2))

  return output
}

async function validateEntityReferences(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []
  const entitiesDir = `${projectPath}/wiki/entities`

  const categories = [
    { key: "characters" as const, label: "人物" },
    { key: "locations" as const, label: "地点" },
    { key: "organizations" as const, label: "组织" },
    { key: "items" as const, label: "物品" },
  ]

  if (!snapshot.entityIsNew) {
    snapshot.entityIsNew = {}
  }

  for (const { key, label } of categories) {
    for (const name of snapshot[key]) {
      try {
        // SEC-002: sanitize the LLM-supplied entity name before interpolating
        // into `${entitiesDir}/${name}.md` (traversal via prompt-injected name).
        // `entityIsNew` is keyed by the original `name` (in-memory lookup key),
        // only the on-disk path uses the sanitized slug.
        const filePath = `${entitiesDir}/${sanitizeEntitySlug(name)}.md`
        const exists = await fileExists(filePath)
        snapshot.entityIsNew[name] = !exists
        if (!exists) {
          warnings.push({
            type: "entity_new",
            message: `新${label}: ${name}`,
          })
        }
      } catch {
        snapshot.entityIsNew[name] = true
        warnings.push({
          type: "entity_new",
          message: `新${label}: ${name}`,
        })
      }
    }
  }

  return warnings
}

async function validateCanonConflicts(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []

  try {
    const canonPath = `${projectPath}/wiki/canon.md`
    try {
      await readFile(canonPath)
    } catch {
      return warnings
    }

    const conflictPatterns: [RegExp, string][] = [
      [/推翻|打破|改写了|不再是/, "设定推翻"],
      [/之前.+错误|误解|记错|搞错/, "历史修正"],
      [/实际上.+不是|真相是|真正.*是/, "真相揭示"],
    ]

    for (const event of snapshot.events) {
      for (const [regex, label] of conflictPatterns) {
        if (regex.test(event)) {
          warnings.push({
            type: "canon_conflict",
            message: `${label}: "${event}" 可能与正史规则存在潜在冲突`,
          })
          break
        }
      }
    }
  } catch {
    // 校验失败不影响主流程
  }

  return warnings
}

export async function loadSnapshot(
  projectPath: string,
  chapterNumber: number,
): Promise<ChapterSnapshot | null> {
  const pp = normalizePath(projectPath)
  const prefix = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
    : String(chapterNumber).padStart(3, "0")
  const jsonPath = `${pp}/.novel/snapshots/${prefix}.snapshot.json`
  try {
    const raw = await readFile(jsonPath)
    return normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
  } catch {
    return null
  }
}

export async function listSnapshots(projectPath: string): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const snapshotDir = `${pp}/.novel/snapshots`
  try {
    const tree = await listDirectory(snapshotDir)
    return tree
      .filter(f => f.name.endsWith(".snapshot.json"))
      .map(f => {
        const stem = f.name.split(".")[0]
        // outline-001 → -1, outline-002 → -2
        const outlineMatch = stem.match(/^outline-(\d+)$/)
        if (outlineMatch) return -parseInt(outlineMatch[1], 10)
        return parseInt(stem, 10)
      })
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

export async function deleteChapterSnapshots(projectPath: string, chapterNumber: number): Promise<void> {
  const pp = normalizePath(projectPath)
  const jsonPath = snapshotJsonPath(pp, chapterNumber)
  const mdPath = snapshotMarkdownPath(pp, chapterNumber)
  const historyDir = snapshotHistoryDir(pp, chapterNumber)
  try { if (await fileExists(jsonPath)) await deleteFile(jsonPath) } catch { /* ignore */ }
  try { if (await fileExists(mdPath)) await deleteFile(mdPath) } catch { /* ignore */ }
  try { if (await fileExists(historyDir)) await deleteFile(historyDir) } catch { /* ignore */ }
  await rebuildDerivedMemoryFromSnapshots(pp)
  clearGraphCache()
  clearTemporalFactsCache(pp)
  useWikiStore.getState().bumpDataVersion()
}

export async function ingestOutline(
  projectPath: string,
  outlinePath: string,
  signal?: AbortSignal,
): Promise<ChapterSnapshot | null> {
  const pp = normalizePath(projectPath)
  const llmConfig = useWikiStore.getState().llmConfig
  const novelConfig = useWikiStore.getState().novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换），与 ingestChapter 保持一致
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  if (!hasUsableLlm(runtimeLlmConfig)) return null

  const content = await readFile(outlinePath)
  const body = content.length > 8000 ? content.slice(0, 8000) : content

  // 从文件路径提取大纲名称作为标题
  const normalizedOutlinePath = normalizePath(outlinePath)
  const fileName = normalizedOutlinePath.split("/").pop() ?? "outline"
  const outlineName = fileName.replace(/\.\w+$/, "") // 去掉扩展名，如 "总大纲"、"人物小传"

  // 根据文件名生成唯一的负数 chapterNumber（不同大纲不会互相覆盖）
  // 使用文件名的简单哈希生成 1-999 范围的数字
  let hash = 0
  for (let i = 0; i < outlineName.length; i++) {
    hash = ((hash << 5) - hash + outlineName.charCodeAt(i)) | 0
  }
  const outlineNumber = -(Math.abs(hash % 999) + 1) // -1 到 -999
  const chapterId = `outline-${outlineName}`

  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)

  const systemPrompt = `你是一个专业的小说编辑助手。请从大纲中提取初始设定信息，输出 JSON。${langReminder}`

  const userPrompt = `请从以下大纲中提取初始设定：

${body}

输出 JSON：
{
  "chapterId": "outline-init",
  "chapterNumber": 0,
  "summary": "大纲摘要",
  "characters": ["初始人物"],
  "locations": ["初始地点"],
  "organizations": ["初始组织/势力"],
  "items": ["关键物品"],
  "events": ["背景事件"],
  "characterStateChanges": ["人物初始状态"],
  "relationshipChanges": ["人物初始关系"],
  "knowledgeChanges": [],
  "foreshadowingChanges": ["初始伏笔"],
  "newCanonFacts": ["世界观正史设定"],
  "timelineEvents": ["时间线背景"],
  "conflicts": ["核心冲突"],
  "endingHook": "",
  "graphNodes": ["图谱节点列表"],
  "graphEdges": ["图谱关系边，格式：A->关系->B。关系必须是以下之一：出场于|发生于|属于|持有|敌对|合作|怀疑|隐瞒|知道|不知道|推进伏笔|回收伏笔|新增伏笔|导致|揭示|影响|位于"]
}`

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]

    let result = ""
    let streamError: Error | null = null
    const callbacks: StreamCallbacks = {
      onToken: (token: string) => { result += token },
      onDone: () => {},
      onError: (error: Error) => { streamError = error },
    }

    await streamChat(runtimeLlmConfig, messages, callbacks, signal)
    if (streamError) throw streamError

    const jsonText = extractJsonObjectFromModelText(result)
    if (!jsonText) {
      throw new Error("大纲摄取失败：模型没有返回可解析的 JSON")
    }

    const parsed = JSON.parse(jsonText)
    const snapshot = normalizeChapterSnapshot({
      ...parsed,
      chapterId,
      chapterNumber: outlineNumber,
      chapterTitle: outlineName,
      entityIsNew: {},
      validationWarnings: [],
    }, { chapterId, chapterNumber: outlineNumber })
    if (!snapshot) {
      throw new Error("Outline snapshot payload is invalid.")
    }

    const syncResult = await syncSnapshotToMemory(pp, snapshot)
    return { ...snapshot, memorySyncedAt: syncResult.memorySyncedAt }
  } catch (err) {
    console.error("[Outline Ingest] Failed:", err)
    throw normalizeOutlineIngestError(err)
  }
}
