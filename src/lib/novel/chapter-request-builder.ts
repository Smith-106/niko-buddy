// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * S2 章节请求构建器 (Chapter Request Builder)
 *
 * 纯函数装配章节 userRequest：基础指令 + 人物约束 + 节拍提示 + 前情承接。
 * 节拍阶段复用 story-simulation/event-pool-generator 的 getNodeStage。
 */

import {
  getNodeStage,
  type EventStage,
} from "./story-simulation/event-pool-generator"

/** 四阶段中文映射：起/承/转/合 + 各段文案 */
const STAGE_HINT_MAP: Record<EventStage, { short: string; desc: string }> = {
  setup: { short: "起", desc: "开端铺垫" },
  rising: { short: "承", desc: "矛盾升级" },
  climax: { short: "转", desc: "冲突爆发" },
  resolution: { short: "合", desc: "收束余韵" },
}

export interface ChapterRequestParts {
  base: string
  character?: string
  stage?: string
  carryover?: string
}

/** 基础写作指令 */
export function buildBaseRequest(chapterNumber: number): string {
  return `请撰写第 ${chapterNumber} 章正文。`
}

/** 出场人物约束：空数组返回空串，否则顿号连接 */
export function buildCharacterConstraint(names: string[]): string {
  const cleaned = names.map((n) => n.trim()).filter((n) => n.length > 0)
  if (cleaned.length === 0) return ""
  return `【出场人物约束】本章允许出场：${cleaned.join("、")}；其余人物不得擅自登场。`
}

/**
 * 节拍提示：chapterNumber 为 1-based，内部转 0-based 后复用
 * getNodeStage(nodeIndex 0-based, totalNodes)。
 */
export function buildStageHint(chapterNumber: number, totalChapters: number): string {
  const total = Number.isFinite(totalChapters) ? Math.max(1, Math.floor(totalChapters)) : 1
  const idx = Number.isFinite(chapterNumber)
    ? Math.min(Math.max(0, Math.floor(chapterNumber) - 1), Math.max(0, total - 1))
    : 0
  const stage = getNodeStage(idx, total)
  const hint = STAGE_HINT_MAP[stage]
  return `【节拍提示】本章处于「${hint.short}」段：${hint.desc}`
}

/** 按 base → character → stage → carryover 顺序，非空段以 \n\n 连接 */
export function assembleChapterRequest(parts: ChapterRequestParts): string {
  const segments: (string | undefined)[] = [
    parts.base,
    parts.character,
    parts.stage,
    parts.carryover,
  ]
  return segments
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n")
}

/**
 * 事件池增强预留位：当前直接返回原串。
 * TODO: 待接入 story-simulation/event-pool-generator 的 generateDynamicEventPool，
 * 按世界观 + 角色动态生成事件池后注入 request，不改变现有同步装配链。
 */
export async function enrichWithEventPool(request: string): Promise<string> {
  return request
}
