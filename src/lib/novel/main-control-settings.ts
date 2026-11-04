// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 主控运行设置视图模型（W2 / G1）
 *
 * 纯函数：不读 store、不写盘、不做 i18n，只做「字段投影 + 归一」，
 * 让「空串=跟随会话模型」「缺省=warn」「越界钳制」这类显示语义收在一处，
 * 组件只负责交互与写回（写回一律经 persistNovelConfigPatch）。
 *
 * D2=C：写作模型字段已从设置面移除（model-resolver 不再有写作角色），本视图模型**不含**该字段。
 */

import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import { resolveAiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { NovelConfig } from "@/stores/wiki-store"

export type MainControlPreWriteGateMode = "warn" | "block"

export interface MainControlSettingsView {
  chapterTargetChars: number
  preWriteGateMode: MainControlPreWriteGateMode
  /** 空串 = 跟随会话模型（与设置页同一语义）。 */
  reviewModel: string
  sceneBreakdownEnabled: boolean
  literaryPolishAfterGate: boolean
  aiWorkflowMode: AiWorkflowMode
}

/** 与设置页 NovelNumberField 的 min/max 保持一致（novel-base-settings-section.tsx）。 */
export const MAIN_CONTROL_CHAPTER_TARGET_MIN = 500
export const MAIN_CONTROL_CHAPTER_TARGET_MAX = 20000
/** 非法输入的回退值（= DEFAULT_NOVEL_CONFIG.chapterTargetChars）。 */
export const MAIN_CONTROL_CHAPTER_TARGET_FALLBACK = 3000

/** 目标字数钳制：非有限数或 <=0 回退默认值，其余夹到 [MIN, MAX] 并取整。 */
export function clampChapterTargetChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MAIN_CONTROL_CHAPTER_TARGET_FALLBACK
  return Math.min(MAIN_CONTROL_CHAPTER_TARGET_MAX, Math.max(MAIN_CONTROL_CHAPTER_TARGET_MIN, Math.round(value)))
}

/**
 * 把 novelConfig + 全局 aiWorkflowMode 投影成主控设置块的显示模型。
 *
 * preWriteGateMode 缺省按 warn（与 DEFAULT_NOVEL_CONFIG.preWriteGateMode 一致）——
 * 注意该门控只在正式库写入（canon 双写 / 批量替换）时执法，主控草稿阶段不拦（D3=A）。
 */
export function projectMainControlSettings(
  novelConfig: NovelConfig,
  aiWorkflowMode: AiWorkflowMode,
): MainControlSettingsView {
  return {
    chapterTargetChars: clampChapterTargetChars(novelConfig.chapterTargetChars),
    preWriteGateMode: novelConfig.preWriteGateMode === "block" ? "block" : "warn",
    reviewModel: novelConfig.reviewModel ?? "",
    sceneBreakdownEnabled: novelConfig.sceneBreakdownEnabled === true,
    literaryPolishAfterGate: !!novelConfig.literaryPolishAfterGate,
    aiWorkflowMode: resolveAiWorkflowMode(aiWorkflowMode),
  }
}
