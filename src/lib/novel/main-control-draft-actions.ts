// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 主控 drafts 页签的「采纳」动作（F1a）：采纳 seam 的唯一装配点。
 *
 * ## 为什么单独一层
 * 主控不是 agent 工具（`MAIN_CONTROL_TOOLS` 白名单不变），采纳是 UI 动作；但 UI
 * 不能自己再写一份「读草稿 → 写正式章 → 回填记忆」的逻辑——那会变成与
 * `chapter-draft-dock.tsx` 并行的第二套实现，两边语义迟早漂移。
 *
 * 因此这里只做两件事：
 * 1. 把 `draft-manager.acceptChapterDraft`（`ChapterDraftDock` 用的同一实现）适配成
 *    `acceptDraftAndIngest` 需要的 `(formalChapterPath) => Promise<void>` seam；
 * 2. 把 seam + 目标路径 + 记忆回填串成一次调用（顺序/降级分类仍归
 *    `accept-draft-with-ingest.ts`，本模块不复制）。
 *
 * ## 两步确认不被压缩
 * `confirmed` 由调用方显式传入，且**只允许在用户第二步确认之后传 true**：
 * 第一步（点「采纳」）只展开确认面板，不调用本模块；`acceptChapterDraft` 内部的
 * `if (!input.confirmed) throw` 保持原样生效（draft-manager.ts:153）。本模块不提供
 * 任何「自动确认」开关。
 */

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { acceptDraftAndIngest, type AcceptDraftAndIngestResult } from "./accept-draft-with-ingest"
import { acceptChapterDraft, formalChapterPathForDraft, resolveChapterDraftAdoptionTarget } from "./draft-manager"
import type { DraftAdoptionGate } from "./lifecycle-types"

/**
 * 主控采纳 seam：转调 `acceptChapterDraft`（与 ChapterDraftDock 同一实现）。
 *
 * `confirmed` 原样透传，本函数不做任何确认判定——未确认时由 draft-manager 抛错，
 * 正式正文一个字节都不会写。
 */
export function createMainControlAcceptSeam(input: {
  projectPath: string
  draftId: string
  /** 用户第二步确认的结果（第一步只展开面板，不得直接传 true）。 */
  confirmed: boolean
  /** 测试注入点；生产恒为 `acceptChapterDraft`。 */
  acceptDraft?: typeof acceptChapterDraft
  /** A01 绑定草稿复核期正文：不一致则 draft-manager 拒绝写入。 */
  expectedDraftContent?: string
}): (formalChapterPath: string) => Promise<void> {
  const acceptDraft = input.acceptDraft ?? acceptChapterDraft
  return async (formalChapterPath: string) => {
    await acceptDraft({
      projectPath: input.projectPath,
      draftId: input.draftId,
      formalChapterPath,
      confirmed: input.confirmed,
      ...(input.expectedDraftContent !== undefined ? { expectedDraftContent: input.expectedDraftContent } : {}),
    })
  }
}

/** 采纳目标路径（同步解析，与 ChapterDraftDock 同源；gated 时走规范章节文件解析）。 */
export function resolveMainControlDraftTarget(
  projectPath: string,
  chapterName: string,
  selectedFile: string | null = null,
  gated = false,
): string {
  return formalChapterPathForDraft(projectPath, chapterName, selectedFile, gated)
}

export interface MainControlAdoptDraftInput {
  projectPath: string
  draftId: string
  chapterName: string
  /** 用户第二步确认的结果；false 时 accept 通道必然抛错、不写正式正文。 */
  confirmed: boolean
  novelConfig: NovelConfig
  llmConfig: LlmConfig
  selectedFile?: string | null
  signal?: AbortSignal
  /** A01 绑定草稿复核期正文：不一致则 accept 通道拒绝写入。 */
  expectedDraftContent?: string
  /** 确认面板已展示的落点；给了就用它，不按当前 selectedFile 重算。 */
  formalChapterPath?: string
  /** R2-W01：门控草稿元数据；未显式传 formalChapterPath 时经 resolveChapterDraftAdoptionTarget 消除 gated 路径分叉。 */
  adoptionGate?: DraftAdoptionGate
}

export interface MainControlAdoptDraftDeps {
  /** 测试注入点；生产恒为 `acceptChapterDraft`。 */
  acceptDraft?: typeof acceptChapterDraft
  /** 测试注入点；生产恒为 `acceptDraftAndIngest`。 */
  adoptAndIngest?: typeof acceptDraftAndIngest
  /** 测试注入点；生产恒为 `resolveChapterDraftAdoptionTarget`。 */
  resolveTarget?: typeof resolveChapterDraftAdoptionTarget
}

/**
 * 采纳主控草稿并（按设置）回填记忆。
 *
 * accept 抛错原样上抛（调用方按「采纳失败」呈现，不得降级成「回填失败」）。
 */
export async function adoptMainControlDraft(
  input: MainControlAdoptDraftInput,
  deps: MainControlAdoptDraftDeps = {},
): Promise<AcceptDraftAndIngestResult> {
  const adoptAndIngest = deps.adoptAndIngest ?? acceptDraftAndIngest
  const resolveTarget = deps.resolveTarget ?? resolveChapterDraftAdoptionTarget
  const formalChapterPath = input.formalChapterPath ?? await resolveTarget(
    input.projectPath,
    { chapterName: input.chapterName, adoptionGate: input.adoptionGate },
    input.selectedFile ?? null,
  )
  return adoptAndIngest({
    projectPath: input.projectPath,
    formalChapterPath,
    accept: createMainControlAcceptSeam({
      projectPath: input.projectPath,
      draftId: input.draftId,
      confirmed: input.confirmed,
      acceptDraft: deps.acceptDraft,
      ...(input.expectedDraftContent !== undefined ? { expectedDraftContent: input.expectedDraftContent } : {}),
    }),
    novelConfig: input.novelConfig,
    llmConfig: input.llmConfig,
    signal: input.signal,
  })
}
