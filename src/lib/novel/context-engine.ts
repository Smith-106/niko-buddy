import { listDirectory, readFile, getFileModifiedTime } from "@/commands/fs"
import i18n from "@/i18n"
import { searchWiki, tokenizeQuery } from "@/lib/search"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { listSnapshots, loadSnapshot, type ChapterSnapshot } from "./chapter-ingest"
import { buildRevisionDirectives } from "./revision-feedback"
import { loadEmotionalArcs, emotionalArcsToContextText } from "./emotional-arcs"
import { loadSubplotBoard, subplotBoardToContextText } from "./subplot-board"
import { loadResourceLedger, resourceLedgerToContextText } from "./resource-ledger"
import {
  factsFromCommittedSnapshots,
  renderTemporalCanonBlock,
  type TemporalFact,
} from "./temporal-memory"
import { loadProjectionStatusLedger } from "./projection-status-ledger"
import { buildCharacterAuraContext } from "./character-aura"
import { isAuthoritativeGenerationPath, isHistoricalProjectionSnippet, novelMixedSearch } from "./search-adapter"
import { rerankCandidates } from "@/lib/rerank"
import type { FileNode } from "@/types/wiki"
import { DataSourceRegistry, type ContextLoadContext, type ContextGapReason } from "./context-data-source"
import { getAllDataSources } from "./context-data-sources"
import { computeContextBudget, type ContextBudget } from "@/lib/context-budget"

const SECTION_PRIORITY: Record<string, number> = {
  "当前任务": 1,
  "当前章节目标": 2,
  "项目灵魂": 3,
  "大纲要求": 4,
  "禁止违背": 5,
  "最近剧情摘要": 6,
  "上一章结尾": 7,
  "当前人物状态": 8,
  "角色灵魂": 9,
  "当前伏笔状态": 10,
  "时间线": 11,
  "角色认知状态": 12,
  "相关地点/组织/物品": 13,
  "相关记忆检索": 14,
  "修改反馈": 15,
  "下一章推进建议": 16,
  "写作风格": 17,
}

/**
 * Tier caps (TASK-003 protected/compressible layering).
 *
 * Protected sources carry load-bearing constraints for the current chapter
 * and get a generous cap — they SHOULD survive whole into the prompt.
 * Canon rules in particular are never compressed, only truncated as a last
 * resort with a `budget_exceeded` gap.
 *
 * Compressible sources are budget-elastic; they're truncated under pressure
 * with a `tier_compressible` gap and are candidates for community-summary
 * compression (TASK-003 subtask 3) before injection.
 */
const CHAPTER_OUTLINE_PROTECTED_CAP = 6000

/**
 * ANL-013 S4 (TASK-003): protected/compressible context tiering.
 *
 * Context sources are classified into two tiers:
 *   - `protected`: canon facts / character cognition (knows + doesNotKnow) /
 *     current chapter outline / active foreshadowing. These MUST NOT be
 *     silently compressed — they carry load-bearing constraints. Truncation
 *     (only when a single source file vastly exceeds the cap) is recorded
 *     as a gap with reason `budget_exceeded`.
 *   - `compressible`: historical chapter summaries / community summaries /
 *     older snapshots / derived fallback state. These are budget-elastic —
 *     truncated under budget pressure and the compression is recorded as a
 *     gap with reason `tier_compressible`.
 *
 * `gaps[]` is the IC-02 contract: every compression / truncation MUST be
 * surfaced explicitly, never silently degraded. Callers (and tests) can
 * inspect `pack.gaps` to verify no source was silently dropped.
 */
export type SourceTier = "protected" | "compressible"

export interface ContextGap {
  type: "compressed" | "truncated" | "load_failed"
  ref: string
  reason: ContextGapReason
  originalLength: number
  retainedLength: number
}

/**
 * Module-level gap recorder.
 *
 * The per-source data sources in `context-data-sources.ts` record gaps when
 * they compress/truncate their payload (tieredSlice reports into this
 * buffer). `buildContextPack` resets the buffer before loading data sources
 * and collects the recorded gaps after. The lifecycle is exactly one
 * `buildContextPack` call — the buffer is per-build, not global-persistent.
 *
 * DC-8 (odyssey-improve): `recordDatasourceLoadFailure` is exported so data
 * sources can record a `load_failed` gap when their load throws (previously
 * the `catch {}` swallowed the error silently, violating the IC-02 contract
 * that every context truncation/omission be visible in pack.gaps). The
 * helper is guarded by `contextGapsActive` so it is a no-op outside a build.
 */
const contextGaps: ContextGap[] = []
let contextGapsActive = false

function resetContextGaps(): void {
  contextGaps.length = 0
  contextGapsActive = true
}

function collectContextGaps(): ContextGap[] {
  contextGapsActive = false
  return [...contextGaps]
}

/**
 * DC-8 (odyssey-improve): record a `load_failed` gap for a data source whose
 * `load()` threw. Exposed to buildContextPack via the `recordGap` callback on
 * ContextLoadContext (injected into the context object), so data sources in
 * context-data-sources.ts can record failures without importing context-engine
 * (avoids the circular dependency). No-op outside an active build.
 */
function recordDatasourceLoadFailure(ref: string, reason: ContextGapReason = "datasource_error"): void {
  if (!contextGapsActive) return
  contextGaps.push({
    type: "load_failed",
    ref,
    reason,
    originalLength: 0,
    retainedLength: 0,
  })
}

/**
 * PERF-011 (TASK-007): module-level build-scoped budget.
 *
 * The `chapterOutlineDataSource` runs during `registry.loadAll` — BEFORE
 * `buildContextPackFromRawData`. So the tieredSlice caps in
 * `readChapterOutlineContent` / `pickChapterOutlineByNumber` can't read the
 * budget off `context` directly (the budget is computed in `buildContextPack`,
 * not threaded through the DataSource load contract). We mirror the existing
 * `contextGaps` module-level pattern: `buildContextPack` populates this before
 * loading data sources and clears it after; the tieredSlice call sites read it
 * to drive adaptive caps. Lifecycle is exactly one `buildContextPack` call,
 * matching `contextGaps` — never global-persistent.
 *
 * `null` (outside a build, or when `computeContextBudget` wasn't called)
 * falls back to the legacy `CHAPTER_OUTLINE_PROTECTED_CAP` constant so every
 * existing caller that doesn't go through `buildContextPack` (tests, direct
 * `readChapterOutlineContent` invocations) keeps the original static behavior.
 */
let currentBuildBudget: ContextBudget | null = null

/**
 * Tier-aware slice. Replaces the bare `content.slice(0, N)` calls that
 * previously truncated sources indiscriminately.
 *
 * - `protected` tier: cap is generous (the source SHOULD survive whole).
 *   If the source still exceeds the cap, record a `truncated` gap with
 *   reason `budget_exceeded` and return the prefix. We never route
 *   protected sources through community-summary compression.
 * - `compressible` tier: cap is tighter; when the source exceeds it,
 *   record a `truncated` gap with reason `tier_compressible`. The
 *   community-summary integration (TASK-003 subtask 3) consumes
 *   compressible-tier sources for summarization before injection.
 */
function tieredSlice(
  content: string,
  tier: SourceTier,
  cap: number,
  ref: string,
): string {
  if (!content) return ""
  const originalLength = content.length
  if (originalLength <= cap) return content
  const retained = content.slice(0, cap)
  if (contextGapsActive) {
    contextGaps.push({
      type: "truncated",
      ref,
      reason: tier === "protected" ? "budget_exceeded" : "tier_compressible",
      originalLength,
      retainedLength: retained.length,
    })
  }
  return retained
}

export interface ContextPack {
  task: string
  chapterGoal: string
  outline: string
  recentChapterContents?: string[]
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  soulDoc: string
  characterAuras: string
  cognitionStates: string
  foreshadowingStates: string
  timeline: string
  relatedSettings: string
  canonRules: string
  writingStyle: string
  searchResults: string
  graphSearchResults: string
  mustDo: string
  mustAvoid: string
  nextChapterAdvice: string
  revisionDirectives: string
  /**
   * IC-02 contract: explicit record of every compressed / truncated
   * source during assembly. Never silently degrade — callers inspect
   * this to know which sources were budget-capped.
   *
   * Optional for backward compatibility: legacy ContextPack constructors
   * (safeBuildChapterContextPack fallback, outline-generation, test
   * fixtures) that don't run through buildContextPack leave this
   * undefined; buildContextPack always populates it.
   */
  gaps?: ContextGap[]
}

export async function buildContextPack(
  projectPath: string,
  task: string,
  chapterNumber?: number,
): Promise<ContextPack> {
  const pp = normalizePath(projectPath)
  const novelMode = useWikiStore.getState().novelMode
  if (!novelMode) {
    return emptyPack(task)
  }

  // 构建加载上下文
  const context = buildLoadContext(pp, task, chapterNumber)

  // 重置 gap recorder — 生命周期为本次 buildContextPack 调用
  resetContextGaps()

  // PERF-011 (TASK-007): compute the adaptive budget BEFORE loading data
  // sources so the tieredSlice call sites in readChapterOutlineContent /
  // pickChapterOutlineByNumber (invoked via chapterOutlineDataSource during
  // registry.loadAll) can drive the protected-tier cap from
  // computeContextBudget's chapterAdaptiveScale instead of the static
  // CHAPTER_OUTLINE_PROTECTED_CAP. Cleared after the build so direct
  // callers (tests / non-build invocations) fall back to the legacy cap.
  currentBuildBudget = computeContextBudget(context.maxContextSize, context.chapterNumber)

  // PAT-M2 (odyssey sibling): currentBuildBudget is a module-level flag. If
  // loadAll / buildContextPackFromRawData throw, the flag would leak into the
  // next build (stale budget). Wrap the build body in try/finally so the
  // flag is always cleared — same shape as the partialReason clear-on-recover
  // fix (CORR-107).
  try {
    // 创建数据源注册器并加载所有数据
    const registry = createDataSourceRegistry()
    const rawData = await registry.loadAll(context)

    // 从原始数据构建上下文包
    const pack = await buildContextPackFromRawData(rawData, context)
    pack.gaps = collectContextGaps()
    return pack
  } finally {
    // PERF-011 / DC-6 (odyssey-improve): clear BOTH module-level build flags.
    // `collectContextGaps()` (normal path above) sets contextGapsActive=false,
    // but if `buildContextPackFromRawData` throws, collectContextGaps never
    // runs and contextGapsActive stays true — leaving tieredSlice (line ~153)
    // recording gaps into a stale buffer that the next build's reset would
    // clear only at its start. Clear both flags here so the post-build window
    // (between an aborted build and the next reset) is not vulnerable to
    // stray gap recording, and contextGaps array doesn't accumulate across a
    // failed build. Idempotent on the normal path (collect already set false).
    currentBuildBudget = null
    contextGapsActive = false
    contextGaps.length = 0
  }
}

/**
 * 构建加载上下文配置
 */
function buildLoadContext(
  projectPath: string,
  task: string,
  chapterNumber?: number,
): ContextLoadContext {
  const novelConfig = useWikiStore.getState().novelConfig
  const revisionFeedbackWindowConfig = useWikiStore.getState().revisionFeedbackWindowConfig
  // PERF-011 (TASK-007): wire llmConfig.maxContextSize through so
  // computeContextBudget's chapterAdaptiveScale is live on the read path
  // (was dead code — no read-path caller). Optional field: absent →
  // computeContextBudget falls back to DEFAULT_MAX_CTX (backward compatible).
  const llmConfig = useWikiStore.getState().llmConfig

  return {
    projectPath,
    task,
    chapterNumber: chapterNumber ?? extractChapterNumberFromTask(task),
    maxContextSize: llmConfig.maxContextSize,
    config: {
      recentSummaryWindow: novelConfig.recentSummaryWindow > 0 ? novelConfig.recentSummaryWindow : 8,
      searchTopK: novelConfig.searchTopK > 0 ? novelConfig.searchTopK : 5,
      snapshotLookback: 3,
      revisionFeedbackWindowConfig,
    },
    // DC-8 (odyssey-improve): inject the gap recorder so data sources can
    // surface load failures into pack.gaps (IC-02) without importing
    // context-engine (avoids circular dependency). No-op outside a build
    // (guarded by contextGapsActive inside recordDatasourceLoadFailure).
    recordGap: recordDatasourceLoadFailure,
  }
}

/**
 * 创建并配置数据源注册器
 */
function createDataSourceRegistry(): DataSourceRegistry {
  const registry = new DataSourceRegistry()
  registry.registerAll(getAllDataSources())
  
  return registry
}

/**
 * 从原始数据构建上下文包
 */
async function buildContextPackFromRawData(
  rawData: Record<string, any>,
  context: ContextLoadContext,
): Promise<ContextPack> {
  // PERF-011 (TASK-007): the adaptive budget for this build was already
  // computed in `buildContextPack` (stored as `currentBuildBudget`) before
  // the data-source load, so the tieredSlice call sites in
  // readChapterOutlineContent / pickChapterOutlineByNumber drive their caps
  // from `currentBuildBudget.maxPageSize` (which supersedes the static
  // CHAPTER_OUTLINE_PROTECTED_CAP) instead of the legacy hardcoded constant.
  // No recompute here — single source of truth via the module-level budget.

  // 合并快照数据和降级数据
  const snapshotRecentSummaries = Array.isArray(rawData.snapshots?.recentSummaries)
    ? rawData.snapshots.recentSummaries
    : []
  const recentSummaries = snapshotRecentSummaries.length > 0 
    ? snapshotRecentSummaries 
    : rawData.fallbackRecentSummaries
  const recentChapterContents = Array.isArray(rawData.recentChapterContents)
    ? rawData.recentChapterContents
    : []
  
  const previousChapterEnding = rawData.snapshots.previousChapterEnding 
    || rawData.fallbackPreviousEnding
  
  // PERF-NEW-04: pre-fetch the three projection-store texts in parallel
  // before joinNonEmpty (was 3 serial readFile IPC round-trips inside the
  // array literal). The stores are independent.
  const [emotionalText, subplotText, resourceText] = await Promise.all([
    readEmotionalArcsText(context.projectPath),
    readSubplotBoardText(context.projectPath),
    readResourceLedgerText(context.projectPath),
  ])
  const characterStates = joinNonEmpty([
    rawData.snapshots.characterStates,
    rawData.fallbackCharacterStates,
    // R4 (S4 / ANL-013): emotional-arcs projection injected as protected-tier
    // canon — character emotion is part of character state. Loaded directly
    // from the .novel/emotional-arcs.json store (same pattern as
    // readCognitionStates). Empty when no arcs recorded (backward compatible).
    emotionalText,
    // MAINT-002 (TASK-008): subplot-board + resource-ledger projections
    // injected as protected-tier canon alongside emotional-arcs — active
    // subplots and current item holders are load-bearing for the current
    // chapter (renderer docstrings: subplot-board.ts:70, resource-ledger.ts:78
    // say 'protected-tier context'). Empty stores render '' (backward
    // compatible — no injection when unwired).
    subplotText,
    resourceText,
  ], "\n\n")
  
  const timeline = joinNonEmpty([
    rawData.snapshots.timeline, 
    rawData.fallbackTimeline
  ], "\n\n")
  
  const snapshotForeshadowingSignals = Array.isArray(rawData.snapshots?.foreshadowingSignals)
    ? rawData.snapshots.foreshadowingSignals
    : []
  const foreshadowingStates = mergeForeshadowingSignals(
    snapshotForeshadowingSignals.length > 0 
      ? snapshotForeshadowingSignals 
      : [rawData.fallbackForeshadowingStates].filter(Boolean),
    rawData.searchResults,
  )
  
  // 构建章节目标
  const chapterGoal = buildChapterGoal(
    rawData.outline, 
    rawData.chapterOutline, 
    context.chapterNumber
  )
  
  // 合并大纲信息
  const mergedOutline = joinNonEmpty([
    rawData.outline,
    rawData.volumeContext,
    rawData.chapterOutline
  ], "\n\n")
  
  // 构建修订指令
  const revisionDirectives = buildRevisionDirectives(rawData.revisionFeedback)
  
  // 构建角色氛围上下文（依赖其他数据）
  const characterAuras = await buildCharacterAuraContext(context.projectPath, context.task, {
    matchingText: joinNonEmpty([
      chapterGoal,
      rawData.chapterOutline,
      rawData.fallbackCharacterStates,
      rawData.snapshots.characterStates,
      rawData.cognitionText,
    ], "\n\n"),
  })

  // TASK-004: temporal memory — derive the time-ordered fact view from the
  // committed snapshot chain + ledger and inject as a protected-tier canon
  // block. getFactsAt (via renderTemporalCanonBlock) yields only facts
  // authoritative at the current chapter, so superseded / negated facts are
  // automatically excluded. Failure to load is non-fatal: canonRules falls
  // back to the raw canon rules (backward compatible).
  const targetChapter = context.chapterNumber ?? 0
  let canonRules = rawData.canonRules
  if (targetChapter > 0) {
    try {
      // PERF-001 (ISS-010): dedupe snapshot load for the temporal fold. The
      // snapshot chain is loaded once per project-revision and memoized in
      // `temporalFactsCache`; subsequent builds within the same revision
      // (e.g. multiple chapter generations, review runs) reuse the folded
      // TemporalFact[] without re-reading every snapshot file. The cache key
      // is `${maxSnapshotNumber}:${maxSnapshotMtime}` — mtime disambiguates a
      // same-numbered re-ingest (snapshot file rewritten → mtime changes →
      // cache miss → no stale projection). This stays ENTIRELY within
      // context-engine.ts (in-memory derived-view memo, no disk persistence,
      // no chapter-ingest coordination) per ANL-013 C4 no-dual-truth-source.
      const temporalFacts = await loadTemporalFactsCached(context.projectPath)
      const temporalBlock = renderTemporalCanonBlock(targetChapter, temporalFacts)
      if (temporalBlock) {
        canonRules = joinNonEmpty([canonRules, temporalBlock], "\n\n")
      }
    } catch (error) {
      console.warn("[ContextEngine] temporal-memory load failed, falling back to raw canonRules:", error)
    }
  }

  return {
    task: context.task,
    chapterGoal,
    outline: mergedOutline,
    recentChapterContents,
    recentSummaries,
    previousChapterEnding,
    characterStates,
    soulDoc: rawData.soulDoc,
    characterAuras,
    cognitionStates: rawData.cognitionText,
    foreshadowingStates,
    timeline,
    relatedSettings: rawData.relatedSettings,
    canonRules,
    writingStyle: rawData.writingStyle,
    searchResults: rawData.searchResults,
    graphSearchResults: rawData.graphSearchResults,
    mustDo: buildMustDo(chapterGoal, previousChapterEnding, foreshadowingStates),
    mustAvoid: buildMustAvoid(canonRules, timeline, characterStates),
    nextChapterAdvice: buildNextChapterAdvice({
      chapterGoal,
      recentSummaries,
      previousChapterEnding,
      foreshadowingStates,
      timeline,
      searchResults: rawData.searchResults,
    }),
    revisionDirectives,
    gaps: [],
  }
}

/**
 * TASK-004: load every committed snapshot for the temporal-memory fold.
 * Uses listSnapshots + loadSnapshot (already imported). Returns an empty
 * array on failure so the temporal block is skipped (backward compatible).
 */
async function loadAllSnapshots(projectPath: string): Promise<ChapterSnapshot[]> {
  const pp = normalizePath(projectPath)
  const numbers = await listSnapshots(pp)
  const loaded = await Promise.all(numbers.map((n) => loadSnapshot(pp, n)))
  return loaded.filter((s): s is ChapterSnapshot => Boolean(s))
}

/**
 * PERF-001 (ISS-010): in-memory memo for the temporal-facts fold.
 *
 * Keyed by projectPath, the value records the `latestRevision` string the
 * cache was built against (`${maxSnapshotNumber}:${maxSnapshotMtime}`) plus
 * the folded `TemporalFact[]`. A cache hit skips reloading every snapshot
 * file; a miss reloads + re-folds. The cache is additive — on any miss the
 * original loadAllSnapshots + factsFromCommittedSnapshots path runs, so
 * behavior is identical to the uncached path (backward compatible).
 *
 * Boundary: this is a derived-view memo (ANL-013 C4), NOT a persistence
 * layer — nothing is written to disk, the ledger remains the single source
 * of truth for projection commit state. Single-user desktop rarely exceeds
 * ~10 projects, so unbounded growth is acceptable for this patch.
 */
const temporalFactsCache = new Map<string, { latestRevision: string; facts: TemporalFact[] }>()

/**
 * List snapshot files directly (mirrors chapter-ingest.listSnapshots naming)
 * while also collecting each file's mtime(ms) in the same readdir pass. The
 * mtime is fetched per-file via getFileModifiedTime because the listDirectory
 * FileNode shape ({name,path,is_dir}) does not carry mtime. Returns the parsed
 * chapter numbers paired with their mtimes; empty on failure (backward
 * compatible).
 */
async function listSnapshotEntriesWithMtime(
  projectPath: string,
): Promise<{ number: number; snapshotMtime: number }[]> {
  const pp = normalizePath(projectPath)
  const snapshotDir = `${pp}/.novel/snapshots`
  try {
    const tree = await listDirectory(snapshotDir)
    const entries = tree
      .filter((f) => f.name.endsWith(".snapshot.json"))
      .map((f) => {
        const stem = f.name.split(".")[0]
        const outlineMatch = stem.match(/^outline-(\d+)$/)
        const num = outlineMatch ? -parseInt(outlineMatch[1], 10) : parseInt(stem, 10)
        return { file: f, num }
      })
      .filter((e) => !isNaN(e.num))
    const withMtimes = await Promise.all(
      entries.map(async (e) => ({
        number: e.num,
        snapshotMtime: await getFileModifiedTime(e.file.path).catch(() => 0),
      })),
    )
    return withMtimes
  } catch {
    return []
  }
}

/**
 * PERF-001 (ISS-010): load + fold the temporal facts for `projectPath`,
 * memoized per project-revision. Cache key combines the highest snapshot
 * number, the latest mtime among snapshot files, the snapshot COUNT, and the
 * SUM of all snapshot mtimes — so any single-file rewrite (including a
 * NON-max snapshot, e.g. rewriting chapter 5 in a 100-chapter project)
 * invalidates the cache (DC-6, REG-001 同形 fix). On cache miss the full
 * snapshot chain is loaded and folded via factsFromCommittedSnapshots; the
 * result is cached and returned. On failure returns [] (backward compatible).
 *
 * Exported for test instrumentation (cache-hit / mtime-invalidation tests).
 */
export async function loadTemporalFactsCached(projectPath: string): Promise<TemporalFact[]> {
  const pp = normalizePath(projectPath)
  const entries = await listSnapshotEntriesWithMtime(pp)
  if (entries.length === 0) {
    // No snapshots → nothing to fold. Still cache the empty result so
    // repeated builds don't re-readdir, but use a stable revision token.
    const emptyRevision = "0:0"
    const cached = temporalFactsCache.get(pp)
    if (cached && cached.latestRevision === emptyRevision) return cached.facts
    const facts: TemporalFact[] = []
    temporalFactsCache.set(pp, { latestRevision: emptyRevision, facts })
    return facts
  }
  const maxSnapshotNumber = entries.reduce((m, e) => Math.max(m, e.number), -Infinity)
  const maxSnapshotMtime = entries.reduce((m, e) => Math.max(m, e.snapshotMtime), 0)
  // DC-6 (odyssey-improve, REG-001 同形): the previous max-only key
  // (`maxSnapshotNumber:maxSnapshotMtime`) failed to invalidate when a NON-max
  // snapshot was rewritten — rewriting chapter 5 in a 100-chapter project left
  // both max fields unchanged, so the cache returned stale temporal facts that
  // missed chapter 5's new content. Augment the key with snapshot COUNT and the
  // SUM of all snapshot mtimes: any single-file rewrite bumps its mtime → sum
  // changes → key changes → cache invalidates, regardless of which chapter was
  // rewritten. The explicit clearTemporalFactsCache calls on saveEditedSnapshot
  // / restoreSnapshotHistory / syncSnapshotToMemory remain as belt-and-suspenders;
  // this hardens the key itself so any FUTURE rewrite path that forgets to call
  // clear no longer silently serves stale facts. O(n) over entries (mtimes
  // already fetched above), no crypto needed.
  const snapshotCount = entries.length
  const sumSnapshotMtime = entries.reduce((s, e) => s + e.snapshotMtime, 0)
  const latestRevision = `${maxSnapshotNumber}:${maxSnapshotMtime}:${snapshotCount}:${sumSnapshotMtime}`
  const cached = temporalFactsCache.get(pp)
  if (cached && cached.latestRevision === latestRevision) {
    return cached.facts
  }
  const snapshots = await loadAllSnapshots(pp)
  const ledger = await loadProjectionStatusLedger(pp)
  const facts = factsFromCommittedSnapshots(snapshots, ledger)
  temporalFactsCache.set(pp, { latestRevision, facts })
  return facts
}

/**
 * Clear the temporal-facts cache. Pass projectPath to clear a single project's
 * entry; omit it to clear the whole cache. Production callers (e.g.
 * deleteChapterSnapshots) MUST clear after deleting a non-max snapshot — the
 * cache key `${maxSnapshotNumber}:${maxSnapshotMtime}` is unchanged by such a
 * delete, so a stale hit would inject deleted-chapter canon facts into the
 * next context build.
 */
export function clearTemporalFactsCache(projectPath?: string): void {
  if (projectPath === undefined) {
    temporalFactsCache.clear()
    return
  }
  temporalFactsCache.delete(normalizePath(projectPath))
}

/**
 * Test-only: clear the temporal-facts cache. Lets tests assert cold-cache
 * behavior without leaking state across cases. Not for production use.
 */
export function __resetTemporalFactsCacheForTests(): void {
  clearTemporalFactsCache()
}

export function extractChapterNumberFromTask(task: string): number | undefined {
  const patterns = [
    /\u7b2c\s*(\d+)\s*\u7ae0/i,
    /chapter\s*(\d+)/i,
    /ch\.?\s*(\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = task.match(pattern)
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return undefined
}

export function selectLookbackChapterNumbers(chapterNumber: number, lookback: number): number[] {
  const result: number[] = []
  for (let current = chapterNumber - 1; current >= 1 && result.length < lookback; current -= 1) {
    result.push(current)
  }
  return result
}

export function mergeForeshadowingSignals(signals: string[], searchResults: string): string {
  const normalized = signals
    .map((signal) => signal.trim())
    .filter(Boolean)

  if (normalized.length === 0 && !searchResults.trim()) return ""

  const unresolved = normalized.filter(signal => /未回收|未解决|新增伏笔/i.test(signal))
  const repeated = unresolved.filter(signal => {
    const keyword = signal.split(/[：:]/)[0]?.trim()
    return keyword && searchResults.includes(keyword)
  })

  const sections = [normalized.join("\n")]
  if (repeated.length > 0) {
    const names = repeated
      .map(signal => signal.split(/[：:]/)[0]?.trim())
      .filter(Boolean)
    sections.push(`以下伏笔近期反复出现，但尚未明显推进，需注意是否在本章继续铺设或回收：${Array.from(new Set(names)).join("、")}`)
  }
  return sections.filter(Boolean).join("\n\n")
}

export function buildChapterGoal(outline: string, chapterOutline: string, chapterNumber?: number): string {
  const parts: string[] = []
  const fromOutline = extractChapterGoal(outline, chapterNumber)
  const fromChapterOutline = extractChapterGoal(chapterOutline, chapterNumber)
  if (fromOutline) parts.push(fromOutline)
  if (fromChapterOutline && !parts.includes(fromChapterOutline)) parts.push(fromChapterOutline)
  return parts.join("\n")
}

export function buildMustDo(chapterGoal: string, previousChapterEnding: string, foreshadowingStates: string): string {
  const items: string[] = []
  chapterGoal.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => items.push(`- ${line}`))
  if (previousChapterEnding.trim()) {
    items.push(i18n.t("novel.contextPack.mustDo.previousChapterEnding", { value: previousChapterEnding.trim() }))
  }
  if (foreshadowingStates.trim()) {
    const firstForeshadowing = foreshadowingStates.split("\n").find(Boolean)
    if (firstForeshadowing) {
      items.push(i18n.t("novel.contextPack.mustDo.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  return items.join("\n")
}

export function buildMustAvoid(canonRules: string, timeline: string, characterStates: string): string {
  const items: string[] = []
  if (canonRules.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.canonRules", { value: canonRules.trim() }))
  if (timeline.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.timeline", { value: timeline.trim() }))
  if (characterStates.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.characterStates", { value: characterStates.trim() }))
  return items.join("\n")
}

export function buildNextChapterAdvice(input: {
  chapterGoal: string
  recentSummaries: string[]
  previousChapterEnding: string
  foreshadowingStates: string
  timeline: string
  searchResults: string
}): string {
  const advice: string[] = []
  if (input.previousChapterEnding.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.previousChapterEnding", { value: input.previousChapterEnding.trim() }))
  }
  if (input.chapterGoal.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.chapterGoal", { value: input.chapterGoal.trim() }))
  }
  if (input.foreshadowingStates.trim()) {
    const firstForeshadowing = input.foreshadowingStates.split("\n").find(Boolean)
    if (firstForeshadowing) {
      advice.push(i18n.t("novel.contextPack.nextChapterAdvice.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  if (input.timeline.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.timeline", { value: input.timeline.trim() }))
  }
  if (input.searchResults.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.searchResults", { value: input.searchResults.trim() }))
  }
  if (input.recentSummaries.length > 0) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.recentSummaries", { value: input.recentSummaries.slice(-2).join("；") }))
  }
  return advice.join("\n")
}

export function joinNonEmpty(parts: string[], separator: string): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(separator)
}

function emptyPack(task: string): ContextPack {
  return {
    task,
    chapterGoal: "",
    outline: "",
    recentChapterContents: [],
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    gaps: [],
  }
}

export async function readOutlineContent(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "outline type:outline")
    if (results.length > 0) {
      const contents = await Promise.all(
        results.map(async (result) => {
          try {
            return await readFile(result.path)
          } catch {
            return ""
          }
        }),
      )
      return joinNonEmpty(contents, "\n\n---\n\n")
    }
  } catch {}
  return ""
}

function flattenOutlineMarkdownFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) files.push(...flattenOutlineMarkdownFiles(node.children))
      continue
    }
    if (node.name.toLowerCase().endsWith(".md")) files.push(node)
  }
  return files
}

function readFrontmatterChapterNumber(content: string): number | undefined {
  const raw = parseFrontmatter(content).frontmatter?.chapter_number
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function numberToChineseChapter(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (value <= 10) {
    if (value === 10) return "十"
    return digits[value] ?? String(value)
  }
  if (value < 20) return `十${digits[value - 10]}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${digits[tens]}十${ones === 0 ? "" : digits[ones]}`
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    if (rest === 0) return `${digits[hundreds]}百`
    if (rest < 10) return `${digits[hundreds]}百零${digits[rest]}`
    return `${digits[hundreds]}百${numberToChineseChapter(rest)}`
  }
  return String(value)
}

function chapterLabels(chapterNumber: number): string[] {
  return [`第${chapterNumber}章`, `第${numberToChineseChapter(chapterNumber)}章`]
}

function includesChapterMarker(text: string, chapterNumber: number): boolean {
  const compact = text.replace(/\s+/g, "")
  return chapterLabels(chapterNumber).some((label) => compact.includes(label)) ||
    new RegExp(`chapter\\s*${chapterNumber}\\b`, "i").test(text)
}

/**
 * PERF-011 (TASK-007): resolve the protected-tier cap for chapter-outline
 * truncation. When invoked inside a `buildContextPack` call, the
 * module-level `currentBuildBudget` carries `computeContextBudget`'s
 * adaptive `maxPageSize` (driven by chapterAdaptiveScale + maxContextSize)
 * — chapter 500 gets a tighter cap than chapter 5, reflecting the larger
 * wiki at that point. Outside a build (direct `readChapterOutlineContent`
 * calls in tests / non-build paths), `currentBuildBudget` is null and we
 * fall back to the legacy static `CHAPTER_OUTLINE_PROTECTED_CAP` so
 * backward compatibility holds for every existing caller.
 */
function resolveChapterOutlineProtectedCap(): number {
  const budget = currentBuildBudget
  if (budget) return budget.maxPageSize
  return CHAPTER_OUTLINE_PROTECTED_CAP
}

export function pickChapterOutlineByNumber(
  candidates: Array<{ path: string; content: string }>,
  chapterNumber: number,
): string {
  const frontmatterMatch = candidates.find((candidate) => readFrontmatterChapterNumber(candidate.content) === chapterNumber)
  if (frontmatterMatch) return tieredSlice(frontmatterMatch.content, "protected", resolveChapterOutlineProtectedCap(), `chapter-outline:${chapterNumber}:frontmatter`)

  const headingMatch = candidates.find((candidate) =>
    includesChapterMarker(candidate.content, chapterNumber) || includesChapterMarker(candidate.path, chapterNumber),
  )
  if (headingMatch) return tieredSlice(headingMatch.content, "protected", resolveChapterOutlineProtectedCap(), `chapter-outline:${chapterNumber}:heading`)

  return ""
}

async function readChapterOutlineDirect(pp: string, chapterNumber: number): Promise<string> {
  try {
    const tree = await listDirectory(`${pp}/wiki/outlines`)
    const files = flattenOutlineMarkdownFiles(tree)
    const candidates = await Promise.all(
      files.slice(0, 80).map(async (file) => ({
        path: file.path,
        content: await readFile(file.path).catch(() => ""),
      })),
    )
    return pickChapterOutlineByNumber(
      candidates.filter((candidate) => candidate.content.trim()),
      chapterNumber,
    )
  } catch {
    return ""
  }
}

export async function readChapterOutlineContent(pp: string, chapterNumber?: number): Promise<string> {
  if (!chapterNumber) return ""
  const direct = await readChapterOutlineDirect(pp, chapterNumber)
  if (direct.trim()) return direct
  const queries = [
    `第${chapterNumber}章细纲 outline`,
    `chapter ${chapterNumber} outline`,
    `chapter_number:${chapterNumber} outline_type:chapter-outline`,
  ]
  for (const query of queries) {
    try {
      const results = await searchWiki(pp, query)
      if (results.length > 0) {
        const content = await readFile(results[0].path)
        return tieredSlice(content, "protected", resolveChapterOutlineProtectedCap(), `chapter-outline:${chapterNumber}:search`)
      }
    } catch {}
  }
  return ""
}

/**
 * R4 (S4 / ANL-013): load the emotional-arcs projection store and render its
 * protected-tier context text. Returns "" when the store is empty or absent
 * (backward compatible — no arcs recorded = no injection). Failures are
 * swallowed (non-fatal) to match the readCognitionStates contract; the
 * projection's own commit/fail status is tracked by the
 * ProjectionStatusLedger, not here.
 */
async function readEmotionalArcsText(pp: string): Promise<string> {
  try {
    const store = await loadEmotionalArcs(pp)
    return emotionalArcsToContextText(store)
  } catch {}
  return ""
}

/**
 * MAINT-002 (TASK-008): read subplot-board store and render as protected-tier
 * context text. Returns "" when the store is empty/absent (backward
 * compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
async function readSubplotBoardText(pp: string): Promise<string> {
  try {
    const store = await loadSubplotBoard(pp)
    return subplotBoardToContextText(store)
  } catch {}
  return ""
}

/**
 * MAINT-002 (TASK-008): read resource-ledger store and render as
 * protected-tier context text. Returns "" when the store is empty/absent
 * (backward compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
async function readResourceLedgerText(pp: string): Promise<string> {
  try {
    const store = await loadResourceLedger(pp)
    return resourceLedgerToContextText(store)
  } catch {}
  return ""
}

export async function searchRelevantContent(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
): Promise<string> {
  const tokens = tokenizeQuery(task)
  const entityHints = tokens.filter(t => t.length >= 2).slice(0, 5)
  const queryParts = [task]
  if (chapterNumber) {
    queryParts.push(`第${chapterNumber}章`)
  }
  if (entityHints.length > 0) {
    queryParts.push(entityHints.join(" "), "伏笔", "人物", "设定", "时间线")
  } else {
    queryParts.push("伏笔", "人物", "设定")
  }
  const query = queryParts.join(" ")

  const [keywordResults, indexResults, vectorResults] = await Promise.all([
    searchWiki(pp, query).catch(() => []),
    searchWiki(pp, `关键词索引 向量索引 ${task}`).catch(() => []),
    runVectorSearchForContext(pp, query, limit).catch(() => []),
  ])

  const seen = new Set<string>()
  const merged: string[] = []

  const add = (title: string, snippet: string) => {
    const key = `${title}|${snippet.slice(0, 50)}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(`- ${title}: ${snippet}`)
    }
  }

  for (const r of keywordResults.slice(0, limit)) {
    add(r.title, r.snippet ?? "")
  }
  for (const r of indexResults.slice(0, limit)) {
    add(r.title, r.snippet ?? "")
  }
  for (const r of vectorResults.slice(0, limit)) {
    add(r.title, r.snippet)
  }

  return merged.slice(0, Math.max(limit, limit * 2)).join("\n")
}

export async function searchRelevantContentUnified(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
): Promise<string> {
  const tokens = tokenizeQuery(task)
  const entityHints = tokens.filter((t) => t.length >= 2).slice(0, 5)
  const queryParts = [task]
  if (chapterNumber) {
    queryParts.push(`chapter ${chapterNumber}`)
  }
  if (entityHints.length > 0) {
    queryParts.push(entityHints.join(" "), "伏笔", "人物", "设定", "时间线")
  } else {
    queryParts.push("伏笔", "人物", "设定")
  }
  const query = queryParts.join(" ")

  const [semanticResults, indexResults, vectorResults] = await Promise.all([
    novelMixedSearch({
      projectPath: pp,
      query,
      chapterNumber,
      topK: Math.max(limit * 2, 6),
      authoritativeOnly: true,
      includeKeyword: true,
      includeVector: true,
      includeGraph: true,
      includeRecentChapters: true,
      includeCanon: true,
    }).catch(() => []),
    searchWiki(pp, `关键词索引 向量索引 ${task}`, {
      rerank: true,
      topK: Math.max(limit, 4),
      rerankPurpose: "用于补充剧情上下文中的索引和记忆条目。",
    }).catch(() => []),
    runVectorSearchForContext(pp, query, limit).catch(() => []),
  ])

  const candidates = [
    ...semanticResults.map((result) => ({
      id: `${result.type}:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: result.type,
    })),
    ...indexResults.map((result) => ({
      id: `index:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: "index",
    })),
    ...vectorResults.map((result, index) => ({
      id: `vector-context:${index}:${result.title}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet,
      source: "vector_context",
    })),
  ].filter((item) => {
    const path = typeof (item as { path?: unknown }).path === "string"
      ? (item as { path?: string }).path ?? ""
      : ""
    const snippet = item.snippet ?? ""
    if (!path || isHistoricalProjectionSnippet(path, snippet)) return false
    return isAuthoritativeGenerationPath(path)
  })

  const reranked = await rerankCandidates(query, candidates, {
    topK: Math.max(limit * 2, limit),
    purpose: "用于构建小说写作上下文，优先保留最能支撑当前章节任务的记忆、设定、伏笔和正史约束。",
  }).catch(() => candidates)

  const merged: string[] = []
  const seen = new Set<string>()
  for (const result of reranked) {
    const key = `${result.title}|${result.snippet.slice(0, 50)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(`- ${result.title}: ${result.snippet}`)
  }

  return merged.slice(0, Math.max(limit * 2, limit)).join("\n")
}

async function runVectorSearchForContext(
  pp: string,
  query: string,
  limit: number,
): Promise<{ title: string; snippet: string; path: string }[]> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return []

  try {
    const { searchByEmbedding } = await import("@/lib/embedding")
    const vectorResults = await searchByEmbedding(pp, query, embCfg, Math.max(limit * 2, 10))
    if (vectorResults.length === 0) return []

    const items: { title: string; snippet: string; path: string }[] = []
    const dirs = ["entities", "concepts", "sources", "synthesis", "comparison", "queries"]

    // PERF-NEW-06 (odyssey-improve DC-4): parallelize the per-vr path probe.
    // Previously this was a serial `for (dir of dirs) await readFile(...)` —
    // up to 6 serial IPC round-trips per vector result (N×M = limit×7 worst
    // case), all on the searchRelevantContentUnified hot path. Now each vr
    // probes all 7 candidate paths (6 dirs + 1 root) concurrently via
    // Promise.allSettled, preserving first-success semantics (dirs order
    // wins over root) by scanning settled results in priority order.
    //
    // F-002 (odyssey-review): probePath takes an explicit `vrId` param rather
    // than closing over the loop variable `vr`. Defining probePath outside the
    // `for (const vr ...)` loop (for object reuse) while reading `vr.id` via
    // closure is a scope error (TS2304) and a contract smell (signature
    // implies only tryPath matters, but vr.id decided the title fallback).
    // Passing vrId explicitly fixes both.
    const probePath = async (
      tryPath: string,
      vrId: string,
    ): Promise<{ title: string; snippet: string; path: string } | null> => {
      try {
        const content = await readFile(tryPath)
        const title = content.match(/^#\s+(.+)/m)?.[1]?.trim()
          ?? content.match(/^---\ntitle:\s*(.+)/m)?.[1]?.trim()
          ?? vrId
        return { title, snippet: content.slice(0, 300).replace(/\n/g, " "), path: tryPath }
      } catch {
        return null
      }
    }

    for (const vr of vectorResults.slice(0, limit)) {
      const candidatePaths = [
        ...dirs.map((dir) => `${pp}/wiki/${dir}/${vr.id}.md`),
        `${pp}/wiki/${vr.id}.md`,
      ]
      const settled = await Promise.allSettled(candidatePaths.map((p) => probePath(p, vr.id)))
      // Priority order: dirs first (in declared order), then root fallback.
      const hit = settled
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .find((v): v is { title: string; snippet: string; path: string } => v !== null)
      if (hit) items.push(hit)
    }
    return items
  } catch {
    return []
  }
}

export async function searchGraphRelevantContent(
  pp: string,
  task: string,
  _chapterNumber: number | undefined,
): Promise<string> {
  try {
    const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
    const graph = await buildRetrievalGraph(pp)
    if (graph.nodes.size === 0) return ""

    const tokens = tokenizeQuery(task)
    // PERF-004 (ISS-011): two-phase candidate collection — Phase 1 seeds
    // from query tokens, Phase 2 expands by scanning graph nodes ONCE into
    // a SEPARATE `nextNames` Set (do NOT mutate candidateNames during
    // iteration — Set mutation during for...of is a correctness hazard and
    // can skip nodes depending on insertion order).
    const candidateNames = new Set<string>()
    for (const token of tokens) {
      if (token.length >= 2) candidateNames.add(token)
    }

    const nextNames = new Set<string>()
    // Snapshot the seed set so expansion never reads a mutating collection.
    const seedNames = Array.from(candidateNames)
    for (const [, node] of graph.nodes) {
      // CORR-110: guard against empty/short titles polluting the candidate set.
      // `task.includes('')` is ALWAYS true (empty string is a substring of every
      // string), so a malformed entity page with an empty title would match
      // every task and pull in every empty-titled node. Apply the same
      // `length >= 2` minimum the token-seed path (line ~1083) uses.
      if (node.title.length >= 2 && task.includes(node.title)) {
        nextNames.add(node.title)
        nextNames.add(node.id)
      } else if (node.id.length >= 2 && task.includes(node.id)) {
        nextNames.add(node.title)
        nextNames.add(node.id)
      }
      for (let i = 0; i < seedNames.length; i++) {
        const name = seedNames[i]
        if (node.title.includes(name) || node.id.includes(name)) {
          nextNames.add(node.title)
          nextNames.add(node.id)
          break
        }
      }
    }
    const allNames = [...candidateNames, ...nextNames]

    // PERF-004 (ISS-011): SINGLE-PASS match collection — iterate graph.nodes
    // once, matching against ALL candidate names, dedup by node id. Replaces
    // the per-name full-graph rescan (was O(names × nodes), now O(nodes)).
    const seenIds = new Set<string>()
    const scoredNodes: { title: string; snippet: string; relevance: number }[] = []
    const matchedNodes = []
    for (const [, node] of graph.nodes) {
      if (allNames.some((name) => node.title.includes(name) || node.id.includes(name))) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id)
          matchedNodes.push(node)
        }
      }
    }

    // PERF-NEW-02: collect all unseen related-node reads first (dedup against
    // seenIds), then read them in parallel. The prior nested for...of awaited
    // readFile serially (up to M×5 sequential IPC round-trips). Each matched
    // node's related set is independent, so the reads parallelize cleanly.
    type PendingRead = { title: string; path: string; relevance: number }
    const pendingReads: PendingRead[] = []
    for (const matchedNode of matchedNodes) {
      const related = getRelatedNodes(matchedNode.id, graph, 5)
      for (const { node, relevance } of related) {
        if (seenIds.has(node.id)) continue
        seenIds.add(node.id)
        pendingReads.push({ title: node.title, path: node.path, relevance })
      }
    }
    const readResults = await Promise.all(
      pendingReads.map(async (entry) => {
        try {
          const content = await readFile(entry.path)
          return {
            title: entry.title,
            snippet: content.slice(0, 300).replace(/\n/g, " "),
            relevance: Math.round(entry.relevance * 100) / 100,
          }
        } catch {
          return null
        }
      }),
    )
    for (const r of readResults) {
      if (r) scoredNodes.push(r)
    }

    scoredNodes.sort((a, b) => b.relevance - a.relevance)
    const topNodes = await rerankCandidates(
      task,
      scoredNodes.slice(0, 10).map((node, index) => ({
        id: `graph:${index}:${node.title}`,
        title: node.title,
        snippet: node.snippet,
        source: "graph_context",
        relevance: node.relevance,
      })),
      {
        topK: 10,
        purpose: "用于补充图谱关联上下文，优先保留和当前任务最直接相关的关联节点。",
      },
    ).catch(() => scoredNodes.slice(0, 10))

    const nodeResults = topNodes.length > 0
      ? topNodes.map(
          n => `- 【${n.title}】(关联度 ${n.relevance}): ${n.snippet}`,
        ).join("\n")
      : ""

    // 追加社区摘要向量检索
    let communityResults = ""
    try {
      const { searchCommunitySummaries } = await import("./community-summary")
      communityResults = await searchCommunitySummaries(pp, task, 3)
    } catch {
      // 社区摘要检索失败不影响主流程
    }

    return [nodeResults, communityResults].filter(Boolean).join("\n")
  } catch {
    return ""
  }
}

export function extractChapterGoal(outline: string, chapterNumber?: number): string {
  if (!chapterNumber || !outline) return ""
  const cleaned = outline.replace(/^---[\s\S]*?---\s*/m, "").trim()
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const compact = trimmed.replace(/\s+/g, "")
    for (const label of chapterLabels(chapterNumber)) {
      if (compact.includes(label)) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const rest = trimmed.replace(new RegExp(`^#*\\s*${escapedLabel}[：:、\\s-]*`), "").trim()
        return (rest || cleaned).slice(0, 2500)
      }
    }
    const englishMatch = trimmed.match(new RegExp(`^#*\\s*Chapter\\s*${chapterNumber}[：:\\s-]*(.+)?$`, "i"))
    if (englishMatch) {
      return ((englishMatch[1] ?? "").trim() || cleaned).slice(0, 2500)
    }
  }
  if (includesChapterMarker(cleaned, chapterNumber)) return cleaned.slice(0, 2500)
  return ""
}

interface FieldConfig {
  titleKey: string
  fieldKey: keyof ContextPack
}

const FIELD_CONFIGS: FieldConfig[] = [
  { titleKey: "novel.contextPack.currentChapterGoal", fieldKey: "chapterGoal" },
  { titleKey: "novel.contextPack.mustDo.title", fieldKey: "mustDo" },
  { titleKey: "novel.contextPack.mustAvoid.title", fieldKey: "mustAvoid" },
  { titleKey: "novel.contextPack.nextChapterAdvice.title", fieldKey: "nextChapterAdvice" },
  { titleKey: "novel.contextPack.soulDoc", fieldKey: "soulDoc" },
  { titleKey: "novel.contextPack.recentRevisionDirectives", fieldKey: "revisionDirectives" },
  { titleKey: "novel.contextPack.requiredOutline", fieldKey: "outline" },
  { titleKey: "novel.contextPack.recentChapterContents", fieldKey: "recentChapterContents" },
  { titleKey: "novel.contextPack.recentPlotSummaries", fieldKey: "recentSummaries" },
  { titleKey: "novel.contextPack.previousChapterEnding", fieldKey: "previousChapterEnding" },
  { titleKey: "novel.contextPack.characterStates", fieldKey: "characterStates" },
  { titleKey: "novel.contextPack.characterAuras", fieldKey: "characterAuras" },
  { titleKey: "novel.contextPack.cognitionStates", fieldKey: "cognitionStates" },
  { titleKey: "novel.contextPack.foreshadowingStates", fieldKey: "foreshadowingStates" },
  { titleKey: "novel.contextPack.timeline", fieldKey: "timeline" },
  { titleKey: "novel.contextPack.relatedSettings", fieldKey: "relatedSettings" },
  { titleKey: "novel.contextPack.canonRules", fieldKey: "canonRules" },
  { titleKey: "novel.contextPack.writingStyle", fieldKey: "writingStyle" },
  { titleKey: "novel.contextPack.searchResults", fieldKey: "searchResults" },
  { titleKey: "novel.contextPack.graphSearchResults", fieldKey: "graphSearchResults" },
]

export function contextPackToPrompt(pack: ContextPack, tokenBudget?: number, options?: { excludeOutline?: boolean }): string {
  const sections: string[] = []

  sections.push(i18n.t("novel.contextPack.title"))
  sections.push("")
  sections.push(i18n.t("novel.contextPack.currentTask"))
  sections.push(pack.task)
  sections.push("")

  const fieldSections: { title: string; content: string | string[] }[] = []
  for (const config of FIELD_CONFIGS) {
    // 如果设置了 excludeOutline，跳过大纲字段
    if (options?.excludeOutline && config.fieldKey === "outline") {
      continue
    }

    const content = pack[config.fieldKey] as string | string[]
    const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content)
    if (!hasContent) continue
    fieldSections.push({ title: i18n.t(config.titleKey), content })
  }

  fieldSections.sort((a, b) => {
    const keyA = a.title.replace(/^##\s*/, "")
    const keyB = b.title.replace(/^##\s*/, "")
    const priorityA = SECTION_PRIORITY[keyA] ?? 999
    const priorityB = SECTION_PRIORITY[keyB] ?? 999
    return priorityA - priorityB
  })

  for (const { title, content } of fieldSections) {
    sections.push(title)
    if (Array.isArray(content)) {
      content.forEach(item => sections.push(item))
    } else {
      sections.push(content)
    }
    sections.push("")
  }

  const fullPrompt = sections.join("\n")

  if (tokenBudget && tokenBudget > 0 && fullPrompt.length > tokenBudget) {
    const estimatedTokens = Math.ceil(fullPrompt.length / 4)
    if (estimatedTokens <= tokenBudget) return fullPrompt
    const targetChars = tokenBudget * 4
    const headChars = Math.floor(targetChars * 0.4)
    const tailChars = targetChars - headChars
    return fullPrompt.slice(0, headChars) + "\n\n[...上下文已按Token预算裁剪...]\n\n" + fullPrompt.slice(-tailChars)
  }

  return fullPrompt
}
