/**
 * chapter-ingest 拆分 W3：fold 注册表与派生重建。
 *
 * 承载 PROJECTION_REGISTRY 的 fold 机制（`storeEntry` 工厂 / 别名表解析 /
 * rebuild / failed 自愈 / 重放）与 fold 落盘辅助（结构化记忆文档写入、
 * superseded 实体清理）。
 *
 * ## 不可破的结构约束
 *
 * `storeEntry()` 把 `foldFromSnapshot`（全量重放）定义为
 * `createEmpty + 逐快照 applyToStore`（增量 fold）的 reduce —— 即 ingest 增量 /
 * rebuild 重放 / drift 比对重放三条路径用的是**同一个 `applyToStore` 函数引用**，
 * F5 类「某路径 fold 实现分叉」缺陷结构上不可能发生。本模块搬迁严格只搬不改，
 * 该 reduce 语义与注册表条目一字未动。
 *
 * ## 为何 `registerProjections({...})` 调用留在母文件
 *
 * 注册调用是**模块顶层副作用**，其执行时机决定注册表何时可用。搬到本模块会改变
 * 模块初始化顺序（母文件其它顶层代码可能在注册前读取注册表）。因此只搬 helper
 * 与 rebuild 函数，注册调用仍在母文件、仍用本模块导出的 `storeEntry` /
 * `registryAliasMaps` 构造条目。
 *
 * ## 为何 `cleanupSupersededEntityFiles` 在此
 *
 * 它是 `storeEntry` fold 落盘后的实体页收尾（`shouldDeleteSupersededProjectionContent`
 * 判定 superseded），与 fold 同簇；`rebuildFromCommittedSnapshot` 直接调用它。
 */
import { createDirectory, deleteFile, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"
import { listEntityFiles } from "./entity-subdir-resolver"
import { writeSnapshotToWiki } from "./graph-adapter"
import { buildAliasMapsFromSnapshot, ensureSnapshotIdentity } from "./chapter-snapshot-normalize"
import { buildStructuredMemoryDocuments } from "./memory-rebuild"
import { extractFrontmatterNumber, extractFrontmatterString } from "./chapter-ingest-utils"
import {
  hasSnapshotSourceReference,
  isOnlyCurrentChapterSource,
  snapshotSourceFileNameCandidates,
} from "./snapshot-paths"
import {
  appendProjectionAuditEntry,
  isAutoRebuildableProjection,
  loadProjectionStatusLedger,
  recordProjectionAudit,
  recordProjectionStatus,
  saveProjectionStatusLedger,
  syncDirectWriteProjectionIds,
  PROJECTION_CATEGORIES,
  PROJECTION_REGISTRY,
  type ProjectionAuditEntry,
  type ProjectionFoldContext,
  type ProjectionRegistryEntry,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import { mayEnterFoldReplay } from "./projection-self-heal"
import { loadValidMemorySnapshots } from "./chapter-ingest-history"
import type { ChapterSnapshot } from "./chapter-ingest"

// ── writeStructuredMemoryDocuments ──
export async function writeStructuredMemoryDocuments(projectPath: string, snapshots: ChapterSnapshot[]): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const memoryDir = `${pp}/wiki/memory`
  const memoryDocuments = buildStructuredMemoryDocuments(snapshots)

  await createDirectory(memoryDir)
  // PAT-IM1: 独立路径并行写（不同 fileName 互异），Promise.all 并发，writtenPaths 按 entries 原序回填保序。
  const memoryEntries = Object.entries(memoryDocuments)
  await Promise.all(
    memoryEntries.map(([fileName, content]) => writeFileAtomic(`${memoryDir}/${fileName}`, content)),
  )
  const writtenPaths: string[] = memoryEntries.map(([fileName]) => `${memoryDir}/${fileName}`)
  return writtenPaths
}

// ── syncFoldProjectionIds ──
export function syncFoldProjectionIds(): readonly string[] {
  return syncDirectWriteProjectionIds()
}

// ── unfoldedDriftClasses ──
export function unfoldedDriftClasses(): Set<string> {
  return new Set(
    Object.entries(PROJECTION_REGISTRY)
      .filter(([id, entry]) => entry.file !== null && !syncFoldProjectionIds().includes(id))
      .map(([, entry]) => entry.file as string),
  )
}

// ── shouldDeleteSupersededProjectionContent ──
export function shouldDeleteSupersededProjectionContent(content: string, snapshot: ChapterSnapshot): boolean {
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
    && sourceRevision < (currentSnapshot.revision /* v8 ignore start */ /* v8 ignore stop */ ?? 1)
  ) {
    return true
  }

  return false
}

// ── cleanupSupersededEntityFiles ──
export async function cleanupSupersededEntityFiles(
  projectPath: string,
  snapshot: ChapterSnapshot,
  writtenEntityPaths: string[],
): Promise<void> {
  const entitiesDir = `${projectPath}/wiki/entities`
  /* v8 ignore next */
  const writtenFileNames = new Set(writtenEntityPaths.map((path) => path.split("/").pop() ?? ""))
  const snapshotSourceFiles = new Set(snapshotSourceFileNameCandidates(snapshot.chapterNumber))

  let oldEntityFiles: string[] = []
  try {
    // listEntityFiles 递归聚合 entities/ 子目录+顶层散装（双态兼容物理分层）。
    oldEntityFiles = (await listEntityFiles(projectPath)).map((f) => `${f.name}.md`)
  } catch (err) {
    // ISS-20260712-REL-1: 空 catch 收敛 — 记诊断，控制流不变（列目录失败即跳过清理）。
    logger.warn("Chapter Ingest", "list entities failed, skip superseded cleanup (non-fatal)", { error: toErrorMessage(err) })
    return
  }

  // PERF-NEW-08 (odyssey-improve DC-4): parallelize the per-file readFile probe.
  // Previously a serial `for (oldFile) await readFile + await deleteFile` —
  // N entity files of serial IPC on the syncSnapshotToMemory/cleanup hot path
  // (entities dir can reach hundreds of files in long novels). Now read all
  // candidate files concurrently, classify in memory, then delete the
  // superseded set in parallel. Reads are independent (no cross-file
  // dependency); deletes target distinct files (safe to parallelize).
  const candidateFiles = oldEntityFiles
    .filter((oldFile) => !writtenFileNames.has(oldFile))
    .map((oldFile) => ({ oldFile, filePath: `${entitiesDir}/${oldFile}` }))

  const readResults = await Promise.all(
    candidateFiles.map(async (entry) => {
      try {
        const content = await readFile(entry.filePath)
        return { entry, content, ok: true }
      } catch (err) {
        // ISS-20260709-025 PAT-IM2: 逐文件探针失败记诊断，控制流不变（ok:false 跳过）。
        logger.warn("Chapter Ingest", "entity probe read failed, skip file (non-fatal)", { path: entry.filePath, error: toErrorMessage(err) })
        return { entry, content: null, ok: false }
      }
    }),
  )

  const toDelete: string[] = []
  for (const { entry, content, ok } of readResults) {
    if (!ok || content === null) continue
    if (shouldDeleteSupersededProjectionContent(content, snapshot)) {
      toDelete.push(entry.filePath)
      continue
    }
    // ISS-20260712-MAINT-4: exact token 匹配（防跨章节子串误伤）。
    // 旧 `content.includes(候选)` 会把 "3.snapshot.json" 误判进
    // "13.snapshot.json"；现经 has/isOnly* exact Set 口径：仅当内容引用的
    // 全部 snapshot token 均属于当前章节候选时才删（混引永不删）。行为等价
    // （孤儿判定语义不变），仅消除子串假阳性。
    if (hasSnapshotSourceReference(content, snapshotSourceFiles)) {
      if (isOnlyCurrentChapterSource(content, snapshotSourceFiles)) {
        toDelete.push(entry.filePath)
      }
    }
  }

  await Promise.all(
    toDelete.map(async (filePath) => {
      try {
        await deleteFile(filePath)
      } catch (err) {
        // ISS-20260712-REL-1: 空 catch 收敛 — 记诊断不改控制流（清理失败不阻断）。
        logger.warn("Chapter Ingest", "cleanup superseded entity failed (non-fatal)", { path: filePath, error: toErrorMessage(err) })
      }
    }),
  )
}

// ── registryAliasMaps ──
export function registryAliasMaps(ctx: ProjectionFoldContext, snapshot: ChapterSnapshot) {
  return ctx.aliasMaps ?? buildAliasMapsFromSnapshot(snapshot)
}

// ── storeEntry ──
export function storeEntry<S>(
  file: string,
  impl: {
    load: (projectPath: string) => Promise<S | null>
    createEmpty: (ctx: ProjectionFoldContext) => S
    applyToStore: (store: S, snapshot: ChapterSnapshot, ctx: ProjectionFoldContext) => S
    save: (projectPath: string, store: S) => Promise<void>
    shouldApply?: (snapshot: ChapterSnapshot) => boolean
    /** sync 直写标记（P2-IMP-14）：注册表派生 sync 直写子集的唯一真源。 */
    syncDirectWrite?: boolean
  },
): ProjectionRegistryEntry {
  return {
    category: "fold_rebuildable",
    rebuildable: true,
    file,
    load: (projectPath) => impl.load(projectPath),
    createEmpty: (ctx) => impl.createEmpty(ctx),
    applyToStore: (store, snapshot, ctx) => impl.applyToStore(store as S, snapshot, ctx),
    foldFromSnapshot: (snapshots, ctx) =>
      snapshots.reduce((acc, snapshot) => impl.applyToStore(acc, snapshot, ctx), impl.createEmpty(ctx)),
    save: (projectPath, store) => impl.save(projectPath, store as S),
    ...(impl.shouldApply ? { shouldApply: impl.shouldApply } : {}),
    ...(impl.syncDirectWrite ? { syncDirectWrite: true as const } : {}),
  }
}

// ── rebuildRegistryProjections ──
export async function rebuildRegistryProjections(
  projectPath: string,
  snapshots: ChapterSnapshot[],
  ctx: ProjectionFoldContext = { now: "" },
  onlyIds?: ReadonlySet<string>,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const rebuilt: string[] = []
  for (const [id, entry] of Object.entries(PROJECTION_REGISTRY)) {
    if (!entry.rebuildable) continue
    if (onlyIds && !onlyIds.has(id)) continue
    if (entry.foldFromSnapshot && entry.save) {
      await entry.save(pp, entry.foldFromSnapshot(snapshots, ctx))
    } else if (entry.rebuildFromSnapshots) {
      await entry.rebuildFromSnapshots(pp, snapshots, ctx)
    } else {
      /* v8 ignore next */ continue
    }
    rebuilt.push(id)
  }
  return rebuilt
}

// ── rebuildFromCommittedSnapshot ──
export async function rebuildFromCommittedSnapshot(projectPath: string, latestSnapshot?: ChapterSnapshot, options: { embeddingConfig?: EmbeddingConfig; now?: string } = {}): Promise<void> {
  const snapshots = await loadValidMemorySnapshots(projectPath, latestSnapshot)
  // E-03 (C-3): rebuild 也是 fold 路径 — 入口取一次显式时间戳全链下传,
  // 缺省 "" (不引入隐式时钟; drift 检查传固定值保证可重放)。
  const foldCtx: ProjectionFoldContext = { now: options.now ?? "" }

  // P2-IMP-14: rebuild 全量重放路径经注册表同源遍历——foldFromSnapshot 由
  // createEmpty + 逐快照 applyToStore 派生（与 ingest 增量路径同一 fold 函数
  // 引用），summary_structured_memory 经 rebuildFromSnapshots 钩子重建结构化
  // 记忆文档（原 9 段硬编码 + writeStructuredMemoryDocuments 直调收敛于此）。
  // 新增 fold_rebuildable 投影只需入表，rebuild 自动覆盖（F5 绝迹）。
  await rebuildRegistryProjections(projectPath, snapshots, foldCtx)

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
      logger.warn("Chapter Ingest", "Graph projection rebuild failed for chapter", { chapter: snapshot.chapterNumber, error: toErrorMessage(err) })
    }
  }

  // single_snapshot_idempotent: vector — re-embed each chapter from its
  // snapshot summary. Idempotent: re-embedding the same content is safe.
  // (Snapshots carry `summary` + structured fields, not raw chapter content;
  // the summary is the canonical re-embeddable text — P1-IMP-12 契约常量
  // REBUILD_REEMBED_SOURCE.)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
  const embCfg = options.embeddingConfig ?? useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      let skippedNoSummary = 0
      for (const snapshot of snapshots) {
        if (!snapshot.summary || snapshot.summary.trim() === "") {
          // P1-IMP-12: summary 缺失 → 告警 + 跳过计数（不伪造嵌入源）
          skippedNoSummary++
          continue
        }
        const pageId = String(snapshot.chapterNumber).padStart(3, "0")
        const title = snapshot.chapterTitle || pageId
        // Re-embed from the snapshot's summary (idempotent rebuild).
        await embedPage(projectPath, pageId, title, snapshot.summary ?? "", embCfg)
      }
      if (skippedNoSummary > 0) {
        logger.warn("Chapter Ingest", `rebuild: ${skippedNoSummary} snapshot(s) skipped (summary empty — REBUILD_REEMBED_SOURCE unavailable)`, { skipped: skippedNoSummary })
      }
    } catch (err) {
      logger.warn("Chapter Ingest", "Vector projection rebuild failed", { error: toErrorMessage(err) })
    }
  }
}

// ── rebuildDerivedMemoryFromSnapshots ──
export async function rebuildDerivedMemoryFromSnapshots(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
  options: { embeddingConfig?: EmbeddingConfig } = {},
): Promise<void> {
  return rebuildFromCommittedSnapshot(projectPath, latestSnapshot, options)
}

/**
 * P2-IMP-14: failed 自愈（ingest 入口）——账本 failed && fold_rebuildable &&
 * 注册表 rebuildable → 经注册表从 committed 快照序列确定性重建。
 */
export interface ProjectionSelfHealResult {
  /** 是否实际尝试了重建（false = 账本无可自愈的 failed 投影，误报护栏零动作）。 */
  attempted: boolean
  /** 自愈成功重建的投影 id（账本对应 cell 已改记 committed + rebuild 审计）。 */
  healed: string[]
  /** 自愈重建失败时的错误信息（failed 状态在账本保留可见，不静默降级）。 */
  error?: string
}

// ── selfHealFailedProjections ──
export async function selfHealFailedProjections(
  projectPath: string,
  options: { now?: string } = {},
): Promise<ProjectionSelfHealResult> {
  const pp = normalizePath(projectPath)
  let ledger: ProjectionStatusLedger = await loadProjectionStatusLedger(pp)
  const failed: Array<{ chapter: number; projection: string }> = []
  for (const [chapterKey, entries] of Object.entries(ledger.chapters)) {
    for (const [projection, entry] of Object.entries(entries)) {
      if (entry.status !== "failed") continue
      if (PROJECTION_CATEGORIES[projection] !== "fold_rebuildable") continue
      // B2（派生接线）：优先走 projection-self-heal 唯一事实源的门槛；
      // 若其返回 false 则不再做第二次判定（不放宽、不二次准入）。
      if (!mayEnterFoldReplay(projection, isAutoRebuildableProjection(projection))) continue
      failed.push({ chapter: Number(chapterKey), projection })
    }
  }
  if (failed.length === 0) return { attempted: false, healed: [] }
  const startedAt = Date.now()
  try {
    const snapshots = await loadValidMemorySnapshots(pp)
    const only = new Set(failed.map((f) => f.projection))
    const rebuilt = await rebuildRegistryProjections(pp, snapshots, { now: options.now ?? "" }, only)
    const healed = failed.filter((f) => rebuilt.includes(f.projection))
    for (const f of healed) {
      ledger = recordProjectionStatus(ledger, f.chapter, f.projection, "committed")
      // F-005 纪律：先追加持久审计，再同步内存 trail（末尾 save 不会把
      // 已落盘事件覆盖回去）；审计失败非致命，不阻断自愈。
      const auditEntry: ProjectionAuditEntry = {
        projection: f.projection,
        chapter: f.chapter,
        status: "rebuild",
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }
      ledger = recordProjectionAudit(ledger, auditEntry)
      try {
        await appendProjectionAuditEntry(pp, auditEntry)
      } catch (auditErr) {
        /* 审计追加非致命（audit 永不阻断主链） */
        // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
        logger.warn("Chapter Ingest", "self-heal audit append failed (non-fatal)", { error: toErrorMessage(auditErr) })
      }
    }
    await saveProjectionStatusLedger(pp, ledger)
    return { attempted: true, healed: healed.map((f) => f.projection) }
  } catch (err) {
    const message = toErrorMessage(err)
    logger.warn("Chapter Ingest", "failed 投影自愈失败（非致命，账本保留 failed 状态）", { error: message })
    return { attempted: true, healed: [], error: message }
  }
}

// ── replayFailedProjectionsFromLedger ──
export async function replayFailedProjectionsFromLedger(
  projectPath: string,
  options: { now?: string } = {},
): Promise<ProjectionSelfHealResult> {
  return selfHealFailedProjections(projectPath, options)
}
