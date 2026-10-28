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
 *   - ledger 落盘在 `finally`（含 1 次重试），两次均失败只置
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
  backupCommunitySummariesLastGood,
  restoreCommunitySummariesLastGood,
} from "./community-summary-recovery"
import {
  appendProjectionAuditEntry,
  emptyLedger,
  loadProjectionStatusLedger,
  recordProjectionAudit,
  recordProjectionStatus,
  PROJECTION_REGISTRY,
  type ProjectionAuditEntry,
  type ProjectionAuditStatus,
  type ProjectionFoldContext,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import type { EmbeddingConfig, LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { ChapterSnapshot } from "./chapter-ingest"

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
  }
  /** 结构化记忆导出（母模块函数，注入避免循环依赖）。 */
  exportStructuredMemoryToWiki: (projectPath: string, snapshot: ChapterSnapshot) => Promise<string[]>
  /** 快照→记忆同步（母模块函数，注入避免循环依赖）。 */
  syncSnapshotToMemory: (
    projectPath: string,
    snapshot: ChapterSnapshot,
  ) => Promise<{ memorySyncedAt: string }>
  /** 账本落盘（含恰好 1 次重试；母模块函数，注入避免循环依赖）。 */
  saveProjectionLedgerWithSingleRetry: (
    projectPath: string,
    ledger: ProjectionStatusLedger,
  ) => Promise<boolean>
}

export interface RunIngestProjectionsResult {
  /** syncSnapshotToMemory 返回的记忆同步时间（未跑到则 undefined）。 */
  memorySyncedAt: string | undefined
  /** finally 落盘（含 1 次重试）是否最终失败。 */
  ledgerSaveFailed: boolean
}

/**
 * 执行全部派生投影并落账本。**永不抛错**：投影失败记 ledger 后继续；
 * ledger 落盘失败只置标志。
 */
export async function runIngestProjections(
  params: RunIngestProjectionsParams,
): Promise<RunIngestProjectionsResult> {
  const {
    pp, chapterPath, chapterNo, content, fm, snapshot, embCfg,
    llmConfig, novelConfig, options,
    exportStructuredMemoryToWiki, syncSnapshotToMemory, saveProjectionLedgerWithSingleRetry,
  } = params

  let projectionLedger: ProjectionStatusLedger
  try {
    projectionLedger = await loadProjectionStatusLedger(pp)
  } /* v8 ignore start */ catch {
    // #4（账本 v2）：load 抛错（损坏/缺失）→ 空账本必须带 schemaVersion，否则违反接口契约。
    // 用 emptyLedger() 保持与其余路径同构（schemaVersion/projections/chapters/auditTrail）。
    projectionLedger = emptyLedger()
  } /* v8 ignore stop */

  // CORR-007: captured from inside runProjection('sync_snapshot_to_memory')
  // so the return value can carry memorySyncedAt (runProjection returns void).
  let memorySyncedAt: string | undefined
  // R4（方案 a）：finally 落盘（含 1 次重试）最终失败标记（成功路径经 return 携带）。
  let ledgerSaveFailed = false

  // F-005 (v2.6 Tier2): single audit choke-point for projection events.
  // Keeps the in-memory ledger's auditTrail in sync (so the end-of-loop
  // saveProjectionStatusLedger cannot clobber per-event durable flushes back
  // off disk) AND durably appends each event to projection-status.json so a
  // hard crash mid-ingest still leaves the emitted events on disk. Strictly
  // additive — never throws into the projection loop.
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
    projectionLedger = recordProjectionAudit(projectionLedger, entry)
    try {
      await appendProjectionAuditEntry(pp, entry)
    } catch (err) {
      logger.warn("Chapter Ingest", "Projection audit append failed (non-fatal)", {
        error: toErrorMessage(err),
      })
    }
  }

  const runProjection = async (
    projection: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    // F-005: time the full projection body for the audit entry.
    const startedAt = Date.now()
    try {
      await fn()
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "committed")
      await recordProjectionAuditEvent(projection, "committed", Date.now() - startedAt)
    } catch (err) {
      const message = toErrorMessage(err)
      logger.warn("Chapter Ingest", `Projection "${projection}" failed`, { error: message })
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "failed", message)
      await recordProjectionAuditEvent(projection, "failed", Date.now() - startedAt, message)
    }
  }

  try {
    // single_snapshot_idempotent: vector embedding.
    if (embCfg.enabled && embCfg.model) {
      await runProjection("vector", async () => {
        const { embedPage } = await import("@/lib/embedding")
        /* v8 ignore next */
        const pageId = chapterPath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? ""
        if (pageId) {
          const title = typeof fm?.title === "string" ? fm.title : pageId
          await embedPage(pp, pageId, title, content, embCfg)
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
      await runProjection("graph_entity_pages", async () => {
        const writtenPaths = await writeSnapshotToWiki(pp, snapshot)
        if (writtenPaths.length > 0) {
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
        }
      })

      // P2-IMP-14: 9 个 store-backed fold_rebuildable 投影经注册表同源遍历
      // （ingest 增量路径）——与 rebuild / drift 重放 / sync 路径共用同一
      // applyToStore fold（新增投影只改注册表一处，四路径自动覆盖，F5 类
      // 「某路径漏投影」缺陷结构上绝迹）。shouldApply 保留既有条件接线语义
      // （cognition/character/foreshadow 仅在有变更时记账）。
      for (const [projection, entry] of Object.entries(PROJECTION_REGISTRY)) {
        if (!entry.applyToStore || !entry.load || !entry.save || !entry.createEmpty) continue
        if (entry.shouldApply && !entry.shouldApply(snapshot)) continue
        await runProjection(projection, async () => {
          const loaded = await entry.load!(pp)
          const base = loaded ?? entry.createEmpty!(foldCtx)
          await entry.save!(pp, entry.applyToStore!(base, snapshot, foldCtx))
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
    /* v8 ignore next */
    if (snapshot) {
      await runProjection("sync_snapshot_to_memory", async () => {
        const res = await syncSnapshotToMemory(pp, snapshot)
        memorySyncedAt = res.memorySyncedAt
      })
    }
  } finally {
    // Persist the ledger regardless of whether the loop threw — a partially-
    // updated ledger still tells the next ingest which projections need rebuild.
    // R4（方案 a）：经 saveProjectionLedgerWithSingleRetry 落盘（含恰好 1 次重试）；
    // 两次均失败仅记 ledgerSaveFailed=true（成功路径返回携带），永不阻断主链。
    ledgerSaveFailed = !(await saveProjectionLedgerWithSingleRetry(pp, projectionLedger))
  }

  // 社区摘要定期重建
  if (snapshot && shouldRebuildCommunitySummaries(snapshot.chapterNumber, novelConfig)) {
    const rebuildCommunitySummaries = async () => {
      // F-005: the scheduled community-summary rebuild is audited with the
      // dedicated "rebuild" status on success; failures are audited as
      // "failed" + error alongside the existing non-fatal warn/UI path.
      // recordProjectionAuditEvent cannot reject (internal non-fatal catch),
      // and audit calls stay OUTSIDE the summary try/catch so an audit hiccup
      // could never be misreported as a summary failure.
      const rebuildStartedAt = Date.now()
      await backupCommunitySummariesLastGood(pp)
      try {
        await generateCommunitySummaries(pp, llmConfig, novelConfig)
      } catch (err) {
        const message = toErrorMessage(err)
        logger.warn("Chapter Ingest", "社区摘要生成失败", { error: message })
        await restoreCommunitySummariesLastGood(pp)
        await recordProjectionAuditEvent("community_summary", "failed", Date.now() - rebuildStartedAt, message)
        // 弹窗提示（通过 store 触发 UI 通知）
        // ISS-20260709-023 (DC-7) 渐进式 DI: 注入 callback 优先, 缺省回退 store。
        const onErr = options.onCommunitySummaryError ?? ((msg: string) => useWikiStore.getState().setCommunitySummaryError(msg))
        onErr(message)
        return
      }
      await recordProjectionAuditEvent("community_summary", "rebuild", Date.now() - rebuildStartedAt)
    }

    if (novelConfig.communitySummaryAsync) {
      // 后台异步执行，不阻塞章节摄取
      void rebuildCommunitySummaries()
    } else {
      // 同步等待
      await rebuildCommunitySummaries()
    }
  }

  return { memorySyncedAt, ledgerSaveFailed }
}
