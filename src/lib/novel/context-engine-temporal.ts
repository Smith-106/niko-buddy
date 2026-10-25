/**
 * context-engine-temporal.ts — 时序事实派生视图 memo（纯搬迁，零逻辑变更）
 *
 * 从 context-engine.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 边界：derived-view memo（ANL-013 C4），非持久层；ledger 仍是唯一真源。
 */
import {
  type ChapterSnapshot,
  listSnapshots,
  loadSnapshot,
} from "./chapter-ingest"
import {
  loadProjectionStatusLedger,
} from "./projection-status-ledger"
import {
  factsFromCommittedSnapshots,
  factsFromFactsFile,
} from "./temporal-memory"
import type {
  TemporalFact,
} from "./temporal-memory"
import {
  getFileModifiedTime,
  listDirectory,
  readFile,
} from "@/commands/fs"
import {
  normalizePath,
} from "@/lib/path-utils"
import {
} from "@/types/wiki"

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
export const temporalFactsCache = new Map<string, { latestRevision: string; facts: TemporalFact[] }>()

// PERF/ARCH (odyssey-review): bound the cache to avoid unbounded growth when
// the user opens many projects. Map preserves insertion order, so on a set
// beyond the cap we evict the oldest entry (LRU-ish; access does not promote,
// but projects are rarely revisited after switching away). 16 comfortably
// exceeds the "~10 projects" assumption while still capping worst case.
export const TEMPORAL_FACTS_CACHE_MAX = 16

/** Set a cache entry, evicting the oldest (first-inserted) entry when over cap. */
export function setTemporalFactsCache(pp: string, entry: { latestRevision: string; facts: TemporalFact[] }): void {
  // delete first so re-setting an existing key moves it to the end of insertion order (most-recent).
  temporalFactsCache.delete(pp)
  temporalFactsCache.set(pp, entry)
  while (temporalFactsCache.size > TEMPORAL_FACTS_CACHE_MAX) {
    const oldest = temporalFactsCache.keys().next().value
    /* v8 ignore next */
    if (oldest === undefined) break
    temporalFactsCache.delete(oldest)
  }
}

/**
 * ISS-20260709-030 (F-004): singleflight for cold-cache builds.
 * Concurrent loadTemporalFactsCached calls for the same project on a cold
 * cache would each miss and each reload + refold the full snapshot chain
 * (N x loadSnapshot + fold). The map holds the in-progress build promise per
 * project; concurrent callers share it, so a cold-cache stampede builds once.
 * Entries are deleted on settle.
 */
const temporalFactsInFlight = new Map<string, Promise<TemporalFact[]>>()

export function __getTemporalFactsInFlightSizeForTests(): number {
  return temporalFactsInFlight.size
}

/**
 * List snapshot files directly (mirrors chapter-ingest.listSnapshots naming)
 * while also collecting each file's mtime(ms) in the same readdir pass. The
 * mtime is fetched per-file via getFileModifiedTime because the listDirectory
 * FileNode shape ({name,path,is_dir}) does not carry mtime. Returns the parsed
 * chapter numbers paired with their mtimes; empty on failure (backward
 * compatible).
 */
export async function listSnapshotEntriesWithMtime(
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
    // ISS-20260709-026: merge duplicate key computation. Multiple entries
    // can reference the same absolute file path (duplicate readdir rows /
    // case-alias twins); fetching mtime per entry would issue N getters for
    // the same key. Dedupe by file.path → one getFileModifiedTime per unique
    // key, then backfill by index so result order matches input order.
    const uniquePaths: string[] = []
    const seenPaths = new Set<string>()
    for (const e of entries) {
      if (!seenPaths.has(e.file.path)) {
        seenPaths.add(e.file.path)
        uniquePaths.push(e.file.path)
      }
    }
    const mtimeByPath = new Map<string, number>()
    await Promise.all(
      uniquePaths.map(async (filePath) => {
        const mtime = await getFileModifiedTime(filePath).catch(() => 0)
        mtimeByPath.set(filePath, mtime)
      }),
    )
    return entries.map((e) => ({
      number: e.num,
      snapshotMtime: mtimeByPath.get(e.file.path) ?? 0,
    }))
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
export function loadTemporalFactsCached(projectPath: string): Promise<TemporalFact[]> {
  const pp = normalizePath(projectPath)
  // ISS-20260709-030: singleflight — a cold-cache stampede (two builds
  // racing before the first populates the cache) shares one build promise
  // instead of loading + folding twice. Synchronous map check before the
  // first await guarantees the second concurrent caller observes it.
  const inFlight = temporalFactsInFlight.get(pp)
  if (inFlight !== undefined) return inFlight
  const build = loadTemporalFactsCachedInner(pp).finally(() => {
    if (temporalFactsInFlight.get(pp) === build) temporalFactsInFlight.delete(pp)
  })
  temporalFactsInFlight.set(pp, build)
  return build
}

async function loadTemporalFactsCachedInner(pp: string): Promise<TemporalFact[]> {
  const entries = await listSnapshotEntriesWithMtime(pp)
  if (entries.length === 0) {
    // No snapshots → nothing to fold. Still cache the empty result so
    // repeated builds don't re-readdir, but use a stable revision token.
    // COR (odyssey-review): match the 4-segment shape of latestRevision
    // (`max:max:count:sum`) so a future field addition caught by the PAT-G2
    // twin-scan doesn't miss the empty path. Empty = all zeros.
    const emptyRevision = "0:0:0:0"
    const cached = temporalFactsCache.get(pp)
    if (cached && cached.latestRevision === emptyRevision) return cached.facts
    // 54 ③ 读侧：无 snapshots 但 facts.json 存在（如快照被清理）→ 仍投影事实表
    const factsPath = `${pp}/.novel/facts.json`
    const factsRaw =
      typeof readFile === "function" ? await Promise.resolve(readFile(factsPath)).catch(() => null) : null
    let facts: TemporalFact[] = []
    if (factsRaw != null && factsRaw.trim().length > 0) {
      try {
        const { loadFactsFile } = await import("./facts-store")
        facts = factsFromFactsFile(loadFactsFile(factsRaw))
      } catch {
        facts = []
      }
    }
    setTemporalFactsCache(pp, { latestRevision: emptyRevision, facts })
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
  // 54 号设计 ③ 读侧接线：facts.json（ADR-26 真源）存在 → 优先投影；
  // ENOENT（legacy 项目 / 尚未 ingest）→ 回退 snapshot 折叠（零行为变更）。
  const factsPath = `${pp}/.novel/facts.json`
  let facts: TemporalFact[]
  // perf/mock 环境可能未注入 readFile → 防御式降级到 snapshot 折叠
  const factsRaw =
      typeof readFile === "function" ? await Promise.resolve(readFile(factsPath)).catch(() => null) : null
  if (factsRaw != null && factsRaw.trim().length > 0) {
    try {
      const { loadFactsFile } = await import("./facts-store")
      facts = factsFromFactsFile(loadFactsFile(factsRaw))
    } catch {
      // 解析失败/损坏 → 回退 snapshot 折叠（additive 安全，不因坏表阻断）
      facts = factsFromCommittedSnapshots(await loadAllSnapshots(pp), await loadProjectionStatusLedger(pp))
    }
  } else {
    const snapshots = await loadAllSnapshots(pp)
    const ledger = await loadProjectionStatusLedger(pp)
    facts = factsFromCommittedSnapshots(snapshots, ledger)
  }
  setTemporalFactsCache(pp, { latestRevision, facts })
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
    temporalFactsInFlight.clear()
    return
  }
  const pp = normalizePath(projectPath)
  temporalFactsCache.delete(pp)
  temporalFactsInFlight.delete(pp)
}

/**
 * Test-only: clear the temporal-facts cache. Lets tests assert cold-cache
 * behavior without leaking state across cases. Not for production use.
 */
export function __resetTemporalFactsCacheForTests(): void {
  clearTemporalFactsCache()
  temporalFactsInFlight.clear()
}

/**
 * TASK-004: load every committed snapshot for the temporal-memory fold.
 * Uses listSnapshots + loadSnapshot (already imported). Returns an empty
 * array on failure so the temporal block is skipped (backward compatible).
 */
export async function loadAllSnapshots(projectPath: string): Promise<ChapterSnapshot[]> {
  const pp = normalizePath(projectPath)
  const numbers = await listSnapshots(pp)
  const loaded = await Promise.all(numbers.map((n) => loadSnapshot(pp, n)))
  return loaded.filter((s): s is ChapterSnapshot => Boolean(s))
}
