// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 战役前情记忆组装 (Campaign Carryover Memory)
 *
 * 批量自主战役跨章推进时，为第 M+1 章构造结构化的前章记忆包，替代
 * 盲截断（`content.slice(-2000)`）式的"只取尾部若干字"做法：
 *   1. 【承接章号】明确告知模型上一章的编号，避免章号漂移；
 *   2. 【前章收束(末 800 字)】保住结尾钩子、悬念与待接续的即时动作；
 *   3. 【前章开端锚点(首 400 字)】保住章首的时空、视角与人物入场设定；
 *   4. 【任务简报】可选携带上一章的任务要点，防止承接方向漂移。
 *
 * 输出整体封顶 CARRYOVER_CONTEXT_MAX_CHARS（1500 字），与调用侧
 * campaign-runner 的 dismantlingDirective 注入上限保持一致，防止提示词膨胀。
 */

/** 前情上下文最终注入文本的硬上限（字符数） */
export const CARRYOVER_CONTEXT_MAX_CHARS = 1500
/** 前章收束（末段）保留字符数 */
export const CARRYOVER_TAIL_CHARS = 800
/** 前章开端锚点（首段）保留字符数 */
export const CARRYOVER_HEAD_CHARS = 400
/** 任务简报保留字符数 */
export const CARRYOVER_BRIEF_CHARS = 200
/** 远期段摘要保留字符数（B2 滚动最小版：最新段摘要拼入预算） */
export const CARRYOVER_SEGMENT_CHARS = 300

export interface CarryoverSource {
  /** 前序章节号（1-based） */
  chapterNumber: number
  /** 前序章节正文（通常为沙箱草稿的 finalContent） */
  content: string
  /** 前序章节任务简报（可选；非空时截断至 CARRYOVER_BRIEF_CHARS） */
  taskBrief?: string
}

/**
 * 组装结构化前情承接上下文。
 *
 * 语义契约：
 * - `content` 为空串或全空白 → 返回 ""（调用侧据此跳过注入）；
 * - 否则返回三段式结构（承接章号 / 前章收束 / 前章开端锚点），
 *   任务简报非空时紧随章号行输出；
 * - 返回值长度恒 <= CARRYOVER_CONTEXT_MAX_CHARS；
 * - 纯函数：不读取外部状态、不产生副作用。
 *
 * 说明：空判定使用 trim，但首/末段取字严格按原始 `content` 切分，
 * 保证输出始终原样包含前章正文的头尾片段。
 */
export function buildCarryoverContext(prev: CarryoverSource): string {
  const content = prev.content
  if (content.trim().length === 0) return ""

  const lines: string[] = [`【承接章号】第${prev.chapterNumber}章`]

  const brief = (prev.taskBrief ?? "").trim()
  if (brief.length > 0) {
    lines.push(`【任务简报】${brief.slice(0, CARRYOVER_BRIEF_CHARS)}`)
  }

  lines.push(`【前章收束(末${CARRYOVER_TAIL_CHARS}字)】`)
  lines.push(content.slice(-CARRYOVER_TAIL_CHARS))
  lines.push(`【前章开端锚点(首${CARRYOVER_HEAD_CHARS}字)】`)
  lines.push(content.slice(0, CARRYOVER_HEAD_CHARS))

  return lines.join("\n").slice(0, CARRYOVER_CONTEXT_MAX_CHARS)
}
