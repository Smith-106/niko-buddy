/**
 * chapter-ingest (A) 波拆分第 3 步：投影落盘与社区摘要重建。
 *
 * 承载 `ingestChapter` 的 **project 段**（commit-then-project 的 project 部分）：
 * 向量嵌入 / graph 实体页 / wiki-patch 字段 / 注册表 fold 投影 / 结构化记忆
 * 导出 / syncSnapshotToMemory / 社区摘要定期重建，以及贯穿全程的
 * ProjectionStatusLedger 记账与审计。
 *
 * 设计约束（只搬不改）：
 *   - `runProjection` 失败**不中断循环**：单个投影失败只记 ledger `failed` +
 *     审计，随后继续下一个投影。这是 F-002 的核心可恢复性契约。
 *   - `runProjection` 仍**遍历 PROJECTION_REGISTRY**（不内联硬编码 9 段），
 *     ingest / rebuild / drift / sync 四路径同源的结构保证不破。
 *   - 非 `Error` 抛错经 `toErrorMessage` 归一后记账本，语义零变化。
 *   - ledger 增量合并在 `finally`（含 1 次重试），两次均失败只置
 *     `ledgerSaveFailed=true`，永不阻断主链。
 *
 * `syncSnapshotToMemory` / `exportStructuredMemoryToWiki` 由调用方注入
 * （它们定义在母模块，直接 import 会造成运行时循环依赖）。
 */
import { readFile } from "@/commands/fs"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import { writePatchFieldsToWiki, writeSnapshotToWiki } from "./graph-adapter"
import { buildAliasMapsFromSnapshot } from "./chapter-snapshot-normalize"
import { shouldRebuildCommunitySummaries, generateCommunitySummaries } from "./community-summary"
import {
  appendProjectionAuditEntry,
  emptyLedger,
  recordProjectionStatus,
  resettleInterruptedCommunitySummaries,
  PROJECTION_REGISTRY,
  type ProjectionAuditEntry,
  type ProjectionAuditStatus,
  type ProjectionFoldContext,
  type ProjectionStatusLedger,
  withProjectionStoreWriteLock,
} from "./projection-status-ledger"
import { canonicalLockKey } from "./novel-locks"
import type { EmbeddingConfig, LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { ChapterSnapshot, IngestProjectionError, IngestProjectionReceipt, SyncSnapshotToMemoryResult } from "./chapter-ingest"

const activeCommunitySummaryAttempts = new Set<string>()

const communitySummaryTails = new Map<string, Promise<void>>()

async function enqueueCommunitySummary(projectPath: string, run: () => Promise<void>): Promise<void> {
  const key = canonicalLockKey(projectPath)
  // Only the queue tail absorbs errors; the caller still sees its own job outcome.
  const result = (communitySummaryTails.get(key) ?? Promise.resolve()).then(run)
  const tail = result.then(() => undefined, () => undefined)
  communitySummaryTails.set(key, tail)
  try {
    await result
  } finally {
    if (communitySummaryTails.get(key) === tail) communitySummaryTails.delete(key)
  }
}

/** 下一次有效摄取归结无人持有的 pending；不重放社区摘要模型。 */
export async function recoverInterruptedCommunitySummaryAttempts(pp: string): Promise<void> {
  await resettleInterruptedCommunitySummaries(pp, activeCommunitySummaryAttempts)
}

export interface RunIngestProjectionsParams {
  pp: string
  chapterPath: string
  /** 章号（frontmatter 已校验 > 0；不取 snapshot?.chapterNumber，见 CORR-111）。 */
  chapterNo: number
  /** 章节原始全文（向量嵌入源）。 */
  content: string
  fm: Record<string, unknown>
  snapshot: ChapterSnapshot | null
  embCfg: EmbeddingConfig
  llmConfig: LlmConfig
  novelConfig: NovelConfig
  options: {
    now?: string
    onCommunitySummaryError?: (message: string) => void
    /** 传入 true 时同步等待社区摘要（批处理回读验证用）；普通 ingest 不传。 */
    awaitCommunitySummary?: boolean
  }
  /** 结构化记忆导出（母模块函数，注入避免循环依赖）。 */
  exportStructuredMemoryToWiki: (projectPath: string, snapshot: ChapterSnapshot) => Promise<string[]>
  /** 快照→记忆同步（母模块函数，注入避免循环依赖）。 */
  syncSnapshotToMemory: (
    projectPath: string,
    snapshot: ChapterSnapshot,
  ) => Promise<SyncSnapshotToMemoryResult>
  /** 账本增量合并（含恰好 1 次重试；母模块函数，注入避免循环依赖）。 */
  saveProjectionLedgerWithSingleRetry: (
    projectPath: string,
    ledger: ProjectionStatusLedger,
    expected?: ProjectionStatusLedger["chapters"],
  ) => Promise<boolean | "superseded">
}

export interface RunIngestProjectionsResult {
  /** syncSnapshotToMemory 返回的记忆同步时间（未跑到则 undefined）。 */
  memorySyncedAt: string | undefined
  /** finally 落盘（含 1 次重试）的已知结果；包装层异常时未知。 */
  ledgerSaveFailed?: boolean
  /** 包装层失败不冒充某个投影 id 落盘失败。 */
  projectionError?: IngestProjectionError
  /** 本次投影落盘失败的投影 id（runProjection catch + sync 内层失败 + 叶子部分失败上报）。 */
  failedProjections: string[]
  /** 本次实际 committed 的投影 id（recordProjectionStatus 成功记 committed 时列入）。 */
  committedProjections: string[]
  /** deferred（异步）已调度但本次未验证结果的投影 id；不并入 failed。 */
  pendingProjections: string[]
  /** sync 持久化链 receipt（本次 sync 有持久化链时携带）。 */
  projectionReceipt?: IngestProjectionReceipt
  /**
   * 锁外等待社区摘要完成回调（内部编排用：`awaitCommunitySummary: true` 时在锁内
   * 落盘 durable pending cell 后释放章锁，由调用方于锁外 await 完成终态落账）。
   */
  finalizeAwaitedCommunitySummary?: () => Promise<RunIngestProjectionsResult>
}

/**
 * 执行全部派生投影并落账本：单投影失败记 ledger 后继续（异常不外溢到
 * 调用方）；ledger 落盘失败只置标志。
 */
export async function runIngestProjections(
  params: RunIngestProjectionsParams,
): Promise<RunIngestProjectionsResult> {
  const {
    pp, chapterPath, chapterNo, content, fm, snapshot, embCfg,
    llmConfig, novelConfig, options,
    exportStructuredMemoryToWiki, syncSnapshotToMemory, saveProjectionLedgerWithSingleRetry,
  } = params

  let projectionDelta = recordProjectionStatus(emptyLedger(), chapterNo, "chapter_ingest_output", "committed")

  // CORR-007: captured from inside runProjection('sync_snapshot_to_memory')
  // so the return value can carry memorySyncedAt (runProjection returns void).
  let memorySyncedAt: string | undefined
  // R4（方案 a）：finally 落盘（含 1 次重试）最终失败标记（成功路径经 return 携带）。
  let ledgerSaveFailed: boolean | undefined
  const failedProjections = new Set<string>()
  let projectionReceipt: IngestProjectionReceipt | undefined
  // deferred（异步）社区摘要尚未验证结果——单列上报 pendingProjections，区别于同步失败。
  const pendingProjections: string[] = []
  const committedProjections: string[] = ["chapter_ingest_output"]
  // 社区摘要锁外调度器：defer / awaitCommunitySummary 均先记 pending，
  // finally 账本落盘后分别后台执行或返回回调由调用方释放章锁后 await。
  let postLockCommunitySummary: {
    mode: "defer" | "await"
    attemptId: string
    run: () => Promise<{
      result: { startedAt: number; status: "committed" } | { startedAt: number; status: "failed"; message: string }
      persisted: boolean | "superseded"
    }>
  } | undefined

  // F-005：每条审计立即追加，保留中途崩溃前的事件；循环内追加失败的事件
  // 才随本次增量在 finally 补写，审计失败不中断投影。
  const recordProjectionAuditEvent = async (
    projection: string,
    status: ProjectionAuditStatus,
    durationMs: number,
    error?: string,
  ): Promise<void> => {
    const entry: ProjectionAuditEntry = {
      projection,
      chapter: chapterNo,
      status,
      durationMs,
      ...(error !== undefined ? { error } : {}),
      timestamp: new Date().toISOString(),
    }
    try {
      await appendProjectionAuditEntry(pp, entry)
    } catch (err) {
      projectionDelta = { ...projectionDelta, auditTrail: [...(projectionDelta.auditTrail ?? []), entry] }
      logger.warn("Chapter Ingest", "Projection audit append failed (non-fatal)", {
        error: toErrorMessage(err),
      })
    }
  }

  const runProjection = async (
    projection: string,
    fn: (reportFailure: (cause: unknown) => void) => Promise<void>,
  ): Promise<void> => {
    // F-005: time the full projection body for the audit entry.
    const startedAt = Date.now()
    try {
      // best-effort 叶子经 reportFailure 上报部分失败——首个 cause 即判本投影失败。
      let failure: { cause: unknown } | undefined
      await fn(cause => { failure ??= { cause } })
      if (failure) throw failure.cause
      projectionDelta = recordProjectionStatus(projectionDelta, chapterNo, projection, "committed")
      committedProjections.push(projection)
      await recordProjectionAuditEvent(projection, "committed", Date.now() - startedAt)
    } catch (err) {
      const message = toErrorMessage(err)
      logger.warn("Chapter Ingest", `Projection "${projection}" failed`, { error: message })
      failedProjections.add(projection)
      projectionDelta = recordProjectionStatus(projectionDelta, chapterNo, projection, "failed", message)
      await recordProjectionAuditEvent(projection, "failed", Date.now() - startedAt, message)
    }
  }

  try {
    // single_snapshot_idempotent: vector embedding.
    if (embCfg.enabled && embCfg.model) {
      await runProjection("vector", async reportFailure => {
        const { embedPage } = await import("@/lib/embedding")
        /* v8 ignore next */
        const pageId = chapterPath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? ""
        if (pageId) {
          const title = typeof fm?.title === "string" ? fm.title : pageId
          await embedPage(pp, pageId, title, content, embCfg, reportFailure)
        }
      })
    }

    /* v8 ignore next */
    if (snapshot) {
      // PERF-NEW-05: compute alias maps once for this snapshot and reuse across
      // all projection closures (was recomputed 4x — character/cognition/
      // emotional-arc/resource-ledger — for the same snapshot).
      const aliasMaps = buildAliasMapsFromSnapshot(snapshot)
      // E-03 (run-execute-1): fold 纯性 — 入口取一次显式时间戳, 全链下传
      // (fold 函数体内禁止隐式时钟; 传入固定 now 时 ingest 全链确定性可测)。
      // P2-IMP-14: aliasMaps 随注册表 fold 上下文下传（PERF-NEW-05 复用保留）。
      const foldCtx: ProjectionFoldContext = {
        now: options.now ?? new Date().toISOString(),
        aliasMaps,
      }
      // mutates_existing_non_rebuildable: graph entity pages (writeSnapshotToWiki).
      await runProjection("graph_entity_pages", async reportFailure => {
        await writeSnapshotToWiki(pp, snapshot, reportFailure)
      })

      // mutates_existing_non_rebuildable: graph wiki-patch fields.
      // CORR-009 fix: distinct ledger key from the snapshot-write above so the
      // ledger can independently track each path's commit/fail status (the
      // prior shared 'graph_entity_pages' key masked partial failures).
      await runProjection("graph_entity_patch_fields", async reportFailure => {
        const patchPath = `${pp}/.novel/chapter-ingest-output/${String(snapshot.chapterNumber).padStart(3, "0")}.wiki-patch.json`
        const patchJson = await readFile(patchPath)
        const patch = JSON.parse(patchJson)
        await writePatchFieldsToWiki(pp, patch, reportFailure)
      })

      // P2-IMP-14: 9 个 store-backed fold_rebuildable 投影经注册表同源遍历
      // （ingest 增量路径）——与 rebuild / drift 重放 / sync 路径共用同一
      // applyToStore fold（新增投影只改注册表一处，四路径自动覆盖，F5 类
      // 「某路径漏投影」缺陷结构上绝迹）。shouldApply 保留既有条件接线语义
      // （cognition/character/foreshadow 仅在有变更时记账）。
      for (const [projection, entry] of Object.entries(PROJECTION_REGISTRY)) {
        const { load, createEmpty, applyToStore, save } = entry
        if (!load || !createEmpty || !applyToStore || !save) continue
        if (entry.shouldApply && !entry.shouldApply(snapshot)) continue
        await runProjection(projection, async () => {
          await withProjectionStoreWriteLock(pp, async () => {
            const loaded = await load(pp)
            const base = loaded ?? createEmpty(foldCtx)
            await save(pp, applyToStore(base, snapshot, foldCtx))
          })
        })
      }

      // fold_rebuildable: summary_structured_memory.
      await runProjection("summary_structured_memory", async () => {
        const memoryPaths = await exportStructuredMemoryToWiki(pp, snapshot)
        /* v8 ignore next */
        if (memoryPaths.length > 0) {
        }
      })
    }

    // CORR-007 fix: syncSnapshotToMemory runs inside the projection ledger
    // (was outside the try/finally, exempt from the F-002 recoverable-failure
    // contract — a sync failure threw unhandled while the ledger already
    // claimed success). Tracked as fold_rebuildable.
    // M2-07: 上方注册表遍历已完成全部 9 类 store 增量 fold 与记账，调用方注入的
    // syncSnapshotToMemory 传入 skipDirectStoreFolds: true，避免对 3 类直写 store
    // 重复 fold 与写盘。
    /* v8 ignore next */
    if (snapshot) {
      await runProjection("sync_snapshot_to_memory", async reportFailure => {
        const res = await syncSnapshotToMemory(pp, snapshot)
        memorySyncedAt = res.memorySyncedAt
        projectionReceipt = res.projectionReceipt
        for (const id of res.failedProjections) failedProjections.add(id)
        if (res.failedProjections.length || res.driftSuspected.length) {
          reportFailure(new Error("Snapshot memory projections did not all complete."))
        }
      })
    }

    // 社区摘要定期重建
    const deferCommunitySummary = novelConfig.communitySummaryAsync && !options.awaitCommunitySummary
    const awaitOutsideLock = Boolean(options.awaitCommunitySummary)
    if (snapshot && shouldRebuildCommunitySummaries(snapshot.chapterNumber, novelConfig)) {
      const projection = "community_summary"
      // Serialize jobs through publication so concurrent runs cannot stage into the same vector slot.
      const apply = async () => {
        const startedAt = Date.now()
        try {
          await enqueueCommunitySummary(pp, async () => {
            let failure: { cause: unknown } | undefined
            await generateCommunitySummaries(pp, llmConfig, novelConfig, embCfg, cause => { failure ??= { cause } })
            if (failure) throw failure.cause
          })
          return { startedAt, status: "committed" as const }
        } catch (error) {
          return { startedAt, status: "failed" as const, message: toErrorMessage(error) }
        }
      }
      const notify = (message: string) => {
        logger.warn("Chapter Ingest", "社区摘要生成失败", { error: message })
        const onErr = options.onCommunitySummaryError ?? ((msg: string) => useWikiStore.getState().setCommunitySummaryError(msg))
        onErr(message)
      }
      if (deferCommunitySummary || awaitOutsideLock) {
        // This opaque attempt id distinguishes two pending runs even in the same millisecond.
        const attemptId = crypto.randomUUID()
        const pending = recordProjectionStatus(emptyLedger(), chapterNo, projection, "pending")
        pending.chapters[String(chapterNo)][projection].attemptId = attemptId
        projectionDelta = { ...projectionDelta, chapters: { ...projectionDelta.chapters, [String(chapterNo)]: { ...projectionDelta.chapters[String(chapterNo)], ...pending.chapters[String(chapterNo)] } } }
        pendingProjections.push(projection)
        // Deferred / post-lock awaited completion writes its own immutable delta (pending -> terminal).
        const run = async () => {
          const result = await apply()
          const message = result.status === "failed" ? result.message : undefined
          const delta = recordProjectionStatus(emptyLedger(), chapterNo, projection, result.status, message)
          const audit: ProjectionAuditEntry = {
            projection, chapter: chapterNo, status: result.status === "failed" ? "failed" : "rebuild",
            durationMs: Date.now() - result.startedAt,
            ...(message !== undefined ? { error: message } : {}),
            timestamp: delta.chapters[String(chapterNo)][projection].updated_at,
          }
          const persisted = await saveProjectionLedgerWithSingleRetry(pp, { ...delta, auditTrail: [audit] }, pending.chapters)
          if (persisted === false) notify("Community summary finished but its final status could not be saved.")
          else if (persisted === true && message !== undefined) notify(message)
          return { result, persisted }
        }
        postLockCommunitySummary = { mode: awaitOutsideLock ? "await" : "defer", attemptId, run }
      } else {
        // Ordinary synchronous ingest writes the community-summary result.
        const result = await apply()
        const message = result.status === "failed" ? result.message : undefined
        projectionDelta = recordProjectionStatus(projectionDelta, chapterNo, projection, result.status, message)
        if (result.status === "committed") committedProjections.push(projection)
        else failedProjections.add(projection)
        await recordProjectionAuditEvent(projection, result.status === "committed" ? "rebuild" : "failed", Date.now() - result.startedAt, message)
        if (message !== undefined) notify(message)
      }
    }

  } finally {
    // 即使循环中断，也将本次已执行投影的状态合并到最新账本，供下一次自愈。
    // R4（方案 a）：经 saveProjectionLedgerWithSingleRetry 合并（含恰好 1 次重试）；
    // 两次均失败仅记 ledgerSaveFailed=true（成功路径返回携带），永不阻断主链。
    // pending 对其他摄取可见前就登记为活跃；未得到持久化凭证则撤销登记。
    const attemptId = postLockCommunitySummary?.attemptId
    if (attemptId) activeCommunitySummaryAttempts.add(attemptId)
    try {
      ledgerSaveFailed = (await saveProjectionLedgerWithSingleRetry(pp, projectionDelta)) === false
    } finally {
      if (attemptId && ledgerSaveFailed !== false) activeCommunitySummaryAttempts.delete(attemptId)
    }
  }

  let finalizeAwaitedCommunitySummary: (() => Promise<RunIngestProjectionsResult>) | undefined
  if (postLockCommunitySummary) {
    const { mode, attemptId, run } = postLockCommunitySummary
    if (ledgerSaveFailed !== false) {
      // Bad ledger was refused, not reset: no durable pending cell means the
      // deferred/awaited run would look like a false commit. Do not start paid work.
      pendingProjections.length = 0
      failedProjections.add("community_summary")
    } else if (mode === "defer") {
      void run()
        .catch(err => logger.warn("Chapter Ingest", "Deferred community summary failed", { error: toErrorMessage(err) }))
        .finally(() => activeCommunitySummaryAttempts.delete(attemptId))
    } else {
      finalizeAwaitedCommunitySummary = async (): Promise<RunIngestProjectionsResult> => {
        try {
          const { result, persisted } = await run()
          const finalFailed = new Set(failedProjections)
          const finalCommitted = [...committedProjections]
          const finalPending: string[] = []
          let finalLedgerSaveFailed: boolean = ledgerSaveFailed
          if (persisted === false) {
            finalLedgerSaveFailed = true
            finalFailed.add("community_summary")
          } else if (persisted === "superseded") {
            if (result.status === "failed") finalFailed.add("community_summary")
            else finalPending.push("community_summary")
          } else if (result.status === "committed") {
            finalCommitted.push("community_summary")
          } else {
            finalFailed.add("community_summary")
          }
          return {
            memorySyncedAt,
            ledgerSaveFailed: finalLedgerSaveFailed,
            failedProjections: [...finalFailed],
            committedProjections: finalCommitted,
            pendingProjections: finalPending,
            ...(projectionReceipt ? { projectionReceipt } : {}),
          }
        } finally {
          activeCommunitySummaryAttempts.delete(attemptId)
        }
      }
    }
  }

  return {
    memorySyncedAt,
    ledgerSaveFailed,
    failedProjections: [...failedProjections],
    committedProjections,
    pendingProjections,
    ...(projectionReceipt ? { projectionReceipt } : {}),
    ...(finalizeAwaitedCommunitySummary ? { finalizeAwaitedCommunitySummary } : {}),
  }
}
