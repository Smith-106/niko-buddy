// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 采纳 + 记忆回填组合（chat 面板与主控草稿面板共用）
 *
 * 只负责「顺序 + 降级分类」，不复制任何判定：
 * 1. 先 accept（采纳是唯一不可逆门，失败直接抛，绝不降级成摄取失败）；
 * 2. autoIngestOnSave 未开 → skipped-config（不提示）；
 * 3. 提取模型不可用 → skipped-no-model；
 * 4. 正文落盘后，只有回填链完整才是 ok；部分完成或推迟的步骤单列原因。
 *
 * 采纳实现由调用方以 `accept` seam 注入——chat 用 commitAcceptedDeepChapterDraft
 * （含 emotion-ledger / promotion / 覆盖回滚），主控 drafts 页签经
 * `main-control-draft-actions.ts` 注入 `acceptChapterDraft`（与 ChapterDraftDock 同一实现）；
 * 本模块因此不会改写任何一条路径已验证的采纳语义。
 *
 * 跨入口共用同一份状态文案；各调用方决定如何显示正文采纳结果。
 */

import { verifyRebuildOutcome } from "./rebuild"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { AgentActivityEvent, AgentActivityKind } from "@/lib/agent/types"
import type { TFunction } from "i18next"
import i18n from "@/i18n"
import { readFile } from "@/commands/fs"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import type { IngestFailReason, IngestResult } from "./chapter-ingest"
import { ingestChapter, type IngestProjectionReceipt } from "./chapter-ingest"
import type {
  CanonDualWriteOutcome,
  IngestCommitReceipt,
  IngestSourceBinding,
} from "./chapter-ingest-commit"
import { defaultCanonDualWriteDeps } from "./canon-dual-write"
import { externalDraftTargetKey, readDraftChapterNumber } from "./draft-manager"
import { finalizeAcceptedChapter } from "./formal-writeback"
import { markExternalDraftAcceptedInStatus } from "./novel-session-status"
import { resolveNovelModel } from "./model-resolver"
import { resolveReviewModel } from "./review-model"
import { hasUsableLlm } from "@/lib/has-usable-llm"

export type AcceptDraftIngestStatus = "ok" | "skipped-config" | "skipped-no-model" | "skipped-not-final" | "pending" | "partial" | "failed"
type MemoryIngestReason = IngestFailReason | "memory_incomplete" | "memory_pending" | "ingest_error"

interface MemoryIngestOutcome {
  ingest: AcceptDraftIngestStatus
  failReason?: MemoryIngestReason
  ledgerSaveFailed?: boolean
  factsStoreFailed?: boolean
  failedProjections?: readonly string[]
  committedProjections?: readonly string[]
  pendingProjections?: readonly string[]
  canonOutcome?: CanonDualWriteOutcome
}

export interface AcceptDraftAndIngestInput {
  projectPath: string
  /** 采纳后的正式章路径（ingest 读它，所以 accept 必须先完成落盘）。 */
  formalChapterPath: string
  /** 采纳实现（由调用方注入：chat = commitAcceptedDeepChapterDraft，主控 = main-control-draft-actions.ts 装配的 acceptChapterDraft seam）。 */
  accept: (formalChapterPath: string) => Promise<void>
  novelConfig: NovelConfig
  llmConfig: LlmConfig
  signal?: AbortSignal
  /** 外部草稿（`.qm-drafts/`）ID；提供时采纳后同步 `.novel/status.json` 并执行共享 `finalizeAcceptedChapter` 后处理。 */
  draftId?: string
  /** 目标章号（未传时从 `chapterName` 或正式章文件名推导）。 */
  chapterNumber?: number
  /** 草稿章节名（用于计算持久熔断键与状态描述）。 */
  chapterName?: string
  /** 调用方若已在 `accept` seam 内执行过 `finalizeAcceptedChapter`（如 `commitAcceptedDeepChapterDraft`）可置 true 跳过重复后处理。 */
  skipFinalize?: boolean
}

export interface AcceptDraftAndIngestResult extends MemoryIngestOutcome {
  formalChapterPath: string
  selfHeal?: IngestResult["selfHeal"]
  /**
   * 提取提交后的无正文源绑定；投影失败不抹去提交点证据。
   * 缺失 = 未绑定，不能读作 bound。
   */
  sourceBinding?: IngestSourceBinding
  /** 提取提交点的瞬时 receipt，不证明投影已完成。 */
  receipt?: IngestCommitReceipt
  projectionReceipt?: IngestProjectionReceipt
}

/** 摄取状态 → 事件文案键（固定映射，不用模板字面量拼 key）。 */
const INGEST_ACTIVITY_STATUS_KEYS: Record<AcceptDraftIngestStatus, string> = {
  ok: "mainControl.draftIngestOk",
  "skipped-config": "mainControl.draftIngestSkippedConfig",
  "skipped-no-model": "mainControl.draftIngestSkippedNoModel",
  "skipped-not-final": "mainControl.draftIngestSkippedNotFinal",
  pending: "mainControl.draftIngestPending",
  partial: "mainControl.draftIngestIncomplete",
  failed: "mainControl.draftIngestFailed",
}

/** 摄取状态 → 事件类别（ok 是抽取结果；failed 是错误；两种 skip 是说明）。 */
const INGEST_ACTIVITY_KINDS: Record<AcceptDraftIngestStatus, AgentActivityKind> = {
  ok: "extract_result",
  "skipped-config": "analysis",
  "skipped-no-model": "analysis",
  "skipped-not-final": "analysis",
  pending: "analysis",
  partial: "analysis",
  failed: "error",
}

/** 普通回填按本次实际结果分类；这里不执行重建级的独立磁盘回读。 */
export function classifyMemoryIngest(result: IngestResult): MemoryIngestOutcome {
  const { ledgerSaveFailed, factsStoreFailed, failedProjections, committedProjections, pendingProjections, canonOutcome, receipt, projectionReceipt } = result
  const details = {
    ...(ledgerSaveFailed !== undefined && { ledgerSaveFailed }),
    ...(factsStoreFailed !== undefined && { factsStoreFailed }),
    ...(failedProjections !== undefined && { failedProjections }),
    ...(committedProjections !== undefined && { committedProjections }),
    ...(pendingProjections !== undefined && { pendingProjections }),
    ...(canonOutcome !== undefined && { canonOutcome }),
  }
  if (result.projectionError) return { ingest: "failed", failReason: "memory_incomplete", ...details }
  if (!result.snapshot) {
    return {
      ingest: result.failReason === "no_llm" ? "skipped-no-model" : result.failReason === "not_final" ? "skipped-not-final" : "failed",
      failReason: result.failReason,
    }
  }

  const hasProjectionReceipt = !!receipt && !!projectionReceipt
    && receipt.chapterNumber === result.snapshot.chapterNumber
    && receipt.snapshotRevisionAtExtractionCommit !== null
    && projectionReceipt.revision === receipt.snapshotRevisionAtExtractionCommit + 1
  const canonComplete = canonOutcome?.status === "completed"
    ? canonOutcome.report.queued === 0 && canonOutcome.report.reconcile.consistent
    : canonOutcome?.status === "skipped" && canonOutcome.reason === "no_facts"
  const incomplete = ledgerSaveFailed !== false
    || factsStoreFailed !== false
    || failedProjections?.length !== 0
    || pendingProjections === undefined
    || !committedProjections?.includes("sync_snapshot_to_memory")
    || !canonComplete
    || !hasProjectionReceipt
  if (incomplete) return { ingest: hasProjectionReceipt && committedProjections?.length ? "partial" : "failed", failReason: "memory_incomplete", ...details }
  if (pendingProjections?.length) return { ingest: "pending", failReason: "memory_pending", ...details }
  return { ingest: "ok", ...details }
}

/** Preserve pending and failed outcomes; a reported success requires independent receipt readback. */
export async function readBackMemoryIngest(
  projectPath: string,
  formalChapterPath: string,
  result: IngestResult,
): Promise<MemoryIngestOutcome> {
  const outcome = classifyMemoryIngest(result)
  if (outcome.ingest !== "ok" || !result.snapshot) return outcome
  try {
    await verifyRebuildOutcome(normalizePath(projectPath), {
      path: formalChapterPath,
      chapterNumber: result.snapshot.chapterNumber,
    }, result)
    return outcome
  } catch (error) {
    logger.warn("Chapter Ingest", "Memory receipt readback failed", { error: toErrorMessage(error) })
    return { ...outcome, ingest: "partial", failReason: "memory_incomplete" }
  }
}

export function formatMemoryIngest(t: TFunction, result: MemoryIngestOutcome): string {
  if (result.failReason === "not_final") return t("mainControl.draftIngestSkippedNotFinal")
  const pending = result.pendingProjections?.length
    ? t("mainControl.draftIngestPending", { projections: result.pendingProjections.join(", ") })
    : ""
  if (result.failReason === "memory_pending") return pending
  if (result.failReason === "memory_incomplete") {
    const canon = result.canonOutcome
    const reasons = [
      result.failedProjections?.length
        ? t("mainControl.draftIngestProjectionFailures", { projections: result.failedProjections.join(", ") })
        : "",
      pending,
      result.ledgerSaveFailed ? t("mainControl.draftIngestLedgerFailed") : "",
      result.factsStoreFailed ? t("mainControl.draftIngestFactsFailed") : "",
      canon?.status === "failed" ? t("mainControl.draftIngestCanonFailed") : "",
      canon?.status === "completed" && (canon.report.queued > 0 || !canon.report.reconcile.consistent)
        ? t("mainControl.draftIngestCanonUnreconciled", { queued: canon.report.queued })
        : "",
    ].filter(Boolean)
    return t("mainControl.draftIngestIncomplete", {
      reason: reasons.join(" · ") || t("mainControl.draftIngestMissingEvidence"),
    })
  }
  if (result.failReason === "ingest_error") return t("mainControl.draftIngestUnexpectedError")
  return t(INGEST_ACTIVITY_STATUS_KEYS[result.ingest], { reason: result.failReason ?? "" })
}

/**
 * 摄取结果 → 阶段事件（RV-002 ②，与深章阶段产出走同一条 activities 通道）。
 *
 * 纯映射：不改 ingest 语义（顺序/降级分类仍由 acceptDraftAndIngest 决定），只把已有结果
 * 转成一条可展示事件。标题与状态文案全部走 i18n 键，不硬编码中文。
 */
export function buildIngestActivity(
  result: AcceptDraftAndIngestResult,
  timestamp: number = Date.now(),
): AgentActivityEvent {
  const status = formatMemoryIngest(i18n.t.bind(i18n), result)
  return {
    id: `memory_ingest:${timestamp}`,
    stageId: "memory_ingest",
    kind: INGEST_ACTIVITY_KINDS[result.ingest],
    title: i18n.t("mainControl.activityIngestTitle"),
    content: `${status} · ${result.formalChapterPath}`,
    timestamp,
  }
}

/**
 * 采纳草稿并（按设置）回填记忆。
 *
 * 顺序不可交换：ingest 读的是正式章文件，accept 未落盘就摄取会读到旧内容。
 * accept 抛错原样上抛（调用方按「采纳失败」处理，而不是「摄取失败」）。
 */
export async function acceptDraftAndIngest(
  input: AcceptDraftAndIngestInput,
): Promise<AcceptDraftAndIngestResult> {
  await input.accept(input.formalChapterPath)

  const shouldSyncExternal = Boolean(input.draftId)
  const shouldFinalizeExternal = Boolean(input.draftId) && input.skipFinalize !== true
  let acceptedContent = ""
  if (shouldSyncExternal || shouldFinalizeExternal) {
    try {
      acceptedContent = await readFile(input.formalChapterPath)
    } catch {
      acceptedContent = ""
    }
  }
  const stem = getFileStem(normalizePath(input.formalChapterPath))
  const resolvedChapterNumber =
    input.chapterNumber
    ?? (input.chapterName ? readDraftChapterNumber(input.chapterName) : undefined)
    ?? readDraftChapterNumber(stem)
  const targetKey =
    input.chapterName
      ? externalDraftTargetKey(input.projectPath, input.chapterName)
      : resolvedChapterNumber !== undefined
        ? `chapter:${resolvedChapterNumber}`
        : undefined

  if (shouldSyncExternal) {
    try {
      await markExternalDraftAcceptedInStatus({
        projectPath: input.projectPath,
        draftId: input.draftId,
        formalChapterPath: input.formalChapterPath,
        chapterNumber: resolvedChapterNumber,
        chapterName: input.chapterName,
        targetKey,
        finalChapterContent: acceptedContent,
      })
    } catch (statusError) {
      logger.warn("Novel Session", "External draft accept status sync failed (non-fatal)", {
        error: toErrorMessage(statusError),
      })
    }
  }

  const runFinalizeAfterAccept = async (fallbackChapterNumber?: number): Promise<void> => {
    if (!shouldFinalizeExternal) return
    const chapterNum = resolvedChapterNumber ?? fallbackChapterNumber
    if (chapterNum === undefined || !Number.isInteger(chapterNum) || chapterNum < 1) return
    await finalizeAcceptedChapter({
      projectPath: input.projectPath,
      chapterNumber: chapterNum,
      formalChapterPath: input.formalChapterPath,
      finalChapterContent: acceptedContent,
    })
  }

  if (input.novelConfig.autoIngestOnSave !== true) {
    await runFinalizeAfterAccept()
    return { formalChapterPath: input.formalChapterPath, ingest: "skipped-config" }
  }

  try {
    const extract = resolveNovelModel(input.llmConfig, input.novelConfig, "extract")
    if (!hasUsableLlm(extract)) {
      await runFinalizeAfterAccept()
      return { formalChapterPath: input.formalChapterPath, ingest: "skipped-no-model" }
    }
    const result = await ingestChapter(input.projectPath, input.formalChapterPath, resolveReviewModel(), input.signal, {
      canonDualWriteDeps: defaultCanonDualWriteDeps(),
      novelConfig: input.novelConfig,
      llmConfig: input.llmConfig,
    })
    const memory = await readBackMemoryIngest(input.projectPath, input.formalChapterPath, result)
    await runFinalizeAfterAccept(result.snapshot?.chapterNumber)
    return {
      formalChapterPath: input.formalChapterPath,
      ...memory,
      ...(result.selfHeal ? { selfHeal: result.selfHeal } : {}),
      ...(result.sourceBinding ? { sourceBinding: result.sourceBinding } : {}),
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...(result.projectionReceipt ? { projectionReceipt: result.projectionReceipt } : {}),
    }
  } catch (error) {
    logger.warn("Chapter Ingest", "Automatic memory ingest failed after adoption", { error: toErrorMessage(error) })
    await runFinalizeAfterAccept()
    return { formalChapterPath: input.formalChapterPath, ingest: "failed", failReason: "ingest_error" }
  }
}
