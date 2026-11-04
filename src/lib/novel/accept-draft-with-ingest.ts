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
 * 4. 摄取完成但 snapshot 为空 → failed（携带 failReason）。
 *
 * 采纳实现由调用方以 `accept` seam 注入——chat 用 commitAcceptedDeepChapterDraft
 * （含 emotion-ledger / promotion / 覆盖回滚），主控 drafts 页签经
 * `main-control-draft-actions.ts` 注入 `acceptChapterDraft`（与 ChapterDraftDock 同一实现）；
 * 本模块因此不会改写任何一条路径已验证的采纳语义。
 *
 * 本模块不产出任何用户文案（R-04）：文案映射留在各调用方。
 */

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { AgentActivityEvent, AgentActivityKind } from "@/lib/agent/types"
import i18n from "@/i18n"
import type { IngestFailReason, IngestResult } from "./chapter-ingest"
import { ingestChapter } from "./chapter-ingest"
import { defaultCanonDualWriteDeps } from "./canon-dual-write"
import { resolveNovelModel } from "./model-resolver"
import { resolveReviewModel } from "./review-model"
import { hasUsableLlm } from "@/lib/has-usable-llm"

export type AcceptDraftIngestStatus = "ok" | "skipped-config" | "skipped-no-model" | "failed"

export interface AcceptDraftAndIngestInput {
  projectPath: string
  /** 采纳后的正式章路径（ingest 读它，所以 accept 必须先完成落盘）。 */
  formalChapterPath: string
  /** 采纳实现（由调用方注入：chat = commitAcceptedDeepChapterDraft，主控 = main-control-draft-actions.ts 装配的 acceptChapterDraft seam）。 */
  accept: (formalChapterPath: string) => Promise<void>
  novelConfig: NovelConfig
  llmConfig: LlmConfig
  signal?: AbortSignal
}

export interface AcceptDraftAndIngestResult {
  formalChapterPath: string
  ingest: AcceptDraftIngestStatus
  failReason?: IngestFailReason
  selfHeal?: IngestResult["selfHeal"]
  ledgerSaveFailed?: boolean
}

/** 摄取状态 → 事件文案键（固定映射，不用模板字面量拼 key）。 */
const INGEST_ACTIVITY_STATUS_KEYS: Record<AcceptDraftIngestStatus, string> = {
  ok: "mainControl.draftIngestOk",
  "skipped-config": "mainControl.draftIngestSkippedConfig",
  "skipped-no-model": "mainControl.draftIngestSkippedNoModel",
  failed: "mainControl.draftIngestFailed",
}

/** 摄取状态 → 事件类别（ok 是抽取结果；failed 是错误；两种 skip 是说明）。 */
const INGEST_ACTIVITY_KINDS: Record<AcceptDraftIngestStatus, AgentActivityKind> = {
  ok: "extract_result",
  "skipped-config": "analysis",
  "skipped-no-model": "analysis",
  failed: "error",
}

/**
 * 摄取结果 → 阶段事件（RV-002 ②，与深章阶段产出走同一条 activities 通道）。
 *
 * 纯映射：不改 ingest 语义（顺序/降级分类仍由 acceptDraftAndIngest 决定），只把已有结果
 * 转成一条可展示事件。标题与状态文案全部走 i18n 键，不硬编码中文。
 */
export function buildIngestActivity(
  result: Pick<AcceptDraftAndIngestResult, "formalChapterPath" | "ingest" | "failReason">,
  timestamp: number = Date.now(),
): AgentActivityEvent {
  const status = i18n.t(INGEST_ACTIVITY_STATUS_KEYS[result.ingest], { reason: result.failReason ?? "" })
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

  if (input.novelConfig.autoIngestOnSave !== true) {
    return { formalChapterPath: input.formalChapterPath, ingest: "skipped-config" }
  }

  const extract = resolveNovelModel(input.llmConfig, input.novelConfig, "extract")
  if (!hasUsableLlm(extract)) {
    return { formalChapterPath: input.formalChapterPath, ingest: "skipped-no-model" }
  }

  const result = await ingestChapter(input.projectPath, input.formalChapterPath, resolveReviewModel(), input.signal, {
    canonDualWriteDeps: defaultCanonDualWriteDeps(),
  })
  if (result.snapshot) {
    return {
      formalChapterPath: input.formalChapterPath,
      ingest: "ok",
      selfHeal: result.selfHeal,
      ledgerSaveFailed: result.ledgerSaveFailed,
    }
  }
  return {
    formalChapterPath: input.formalChapterPath,
    ingest: "failed",
    failReason: result.failReason,
  }
}
