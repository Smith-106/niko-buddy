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
  pickStagedEvent,
  generateDynamicEventPool,
  type EventStage,
} from "./story-simulation/event-pool-generator"
import { readSoulDoc } from "./soul-doc"
import { loadWorldBlueprint } from "./world-blueprint"
import type { LlmConfig } from "@/stores/wiki-store"

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
  /** F2 视点约束段（空串时装配自动跳过） */
  pov?: string
  /** F2 人物访谈锚点段（空串时装配自动跳过） */
  interview?: string
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
 * F2 视点约束（纯函数，零成本）：
 * povName 为空（null/空串/空白）→ 空串；否则输出
 * `【视点约束】本章视点人物：X。`，others 非空时追加
 * `；不得描写以下人物的内心活动：A、B。`（others 清洗去重并排除视点本人）。
 */
export function buildPovConstraint(povName: string | null, others: string[]): string {
  const pov = typeof povName === "string" ? povName.trim() : ""
  if (pov.length === 0) return ""
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const name of others) {
    const n = name.trim()
    if (n.length === 0 || n === pov || seen.has(n)) continue
    seen.add(n)
    cleaned.push(n)
  }
  if (cleaned.length === 0) return `【视点约束】本章视点人物：${pov}。`
  return `【视点约束】本章视点人物：${pov}；不得描写以下人物的内心活动：${cleaned.join("、")}。`
}

/**
 * F2 人物访谈锚点（纯函数，零成本）：
 * 空（空数组/全空白）→ 空串；否则取最近 3 条（数组末尾 3 条），以 `· ` 为前缀、
 * `\n` 连接并冠以 `【人物访谈锚点】` 头行；超长单条截断至 200 字。
 */
export function buildInterviewAnchor(snippets: string[]): string {
  const cleaned = snippets.map((s) => s.trim()).filter((s) => s.length > 0)
  if (cleaned.length === 0) return ""
  const recent = cleaned.slice(-3).map((s) => (s.length > 200 ? s.slice(0, 200) : s))
  return `【人物访谈锚点】\n${recent.map((s) => `· ${s}`).join("\n")}`
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

/** 按 base → character → pov → interview → stage → carryover 顺序，非空段以 \n\n 连接 */
export function assembleChapterRequest(parts: ChapterRequestParts): string {
  const segments: (string | undefined)[] = [
    parts.base,
    parts.character,
    parts.pov,
    parts.interview,
    parts.stage,
    parts.carryover,
  ]
  return segments
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n")
}

/**
 * 事件池动态注入（E2）：按世界观 + 角色生成事件池，按本章节拍取 1 条候选注入。
 * 失败安全：任何异常（读不到设定/LLM 抛错/超时）一律原串直通，保证巡航不断。
 * 成本闸：调用方显式开启（enableEventPool）才调 LLM；默认关闭零成本。
 */
export interface EventPoolEnrichInput {
  request: string
  projectPath: string
  llmConfig: LlmConfig
  characters: string[]
  /** 本章 1-based 章号 */
  chapterNumber: number
  /** 全书/战役总章数 */
  totalChapters: number
}

export function formatEventCandidate(text: string): string {
  const t = text.trim()
  if (t.length === 0) return ""
  return `【本章事件候选】${t}（可选用，不必强塞）。`
}

export async function enrichWithEventPool(input: EventPoolEnrichInput): Promise<string> {
  const { request, projectPath, llmConfig, characters, chapterNumber, totalChapters } = input
  try {
    const [soulDoc, blueprint] = await Promise.all([
      readSoulDoc(projectPath).catch(() => ""),
      loadWorldBlueprint(projectPath).catch(() => null),
    ])
    const worldRules = [soulDoc.slice(0, 800), blueprint ? JSON.stringify(blueprint).slice(0, 800) : ""]
      .filter((s) => s.trim().length > 0)
      .join("\n")
    if (worldRules.trim().length === 0) return request
    const pool = await generateDynamicEventPool({ llmConfig, worldRules, characters })
    const total = Number.isFinite(totalChapters) ? Math.max(1, Math.floor(totalChapters)) : 1
    const idx = Number.isFinite(chapterNumber)
      ? Math.min(Math.max(0, Math.floor(chapterNumber) - 1), Math.max(0, total - 1))
      : 0
    const picked = pickStagedEvent(pool, new Set<string>(), idx, total)
    if (!picked) return request
    const candidate = formatEventCandidate(picked.text)
    if (candidate.length === 0) return request
    return `${request}\n\n${candidate}`
  } catch {
    return request
  }
}
