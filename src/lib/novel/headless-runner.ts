// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * G2 无头驱动器 (Headless Runner)
 *
 * 外部可调用入口：复用 autonomous-incubator 的
 * runEndToEndAutonomousNovelProduction（孵化 + 巡航串联）做薄封装，
 * 仅做参数归一，不新增业务逻辑。
 */

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import {
  runEndToEndAutonomousNovelProduction,
  type NovelIncubatorResult,
} from "./autonomous-incubator"
import type { CampaignReport } from "./campaign-runner"

export interface HeadlessRunOptions {
  projectPath: string
  /** 核心灵感或构思点子 */
  idea: string
  /** 书名（可选，未提供则基于灵感智能提取） */
  title?: string
  /** 流派（可选） */
  genre?: string
  /** 目标章节数（默认 10 章） */
  targetChapters?: number
  /** 孵化后是否立即自动巡航前 N 章正文起草（默认 false） */
  autoStartCruise?: boolean
  /** 巡航章数（默认 min(3, targetChapters)，且截断不超 targetChapters） */
  cruiseChapterCount?: number
  llmConfig: LlmConfig
  novelConfig?: NovelConfig
  /** 巡航每章任务指令生成器（G2 预留透传位） */
  buildChapterRequest?: (chapterNumber: number) => string | Promise<string>
  /** 进度回调 */
  onProgress?: (info: { stage: string; current: number; total: number; message: string }) => void
  signal?: AbortSignal
}

/** 归一化后的无头参数：目标章数 / 巡航开关 / 巡航章数三项恒为确定值 */
export interface NormalizedHeadlessOptions {
  projectPath: string
  idea: string
  title?: string
  genre?: string
  targetChapters: number
  autoStartCruise: boolean
  cruiseChapterCount: number
  llmConfig: LlmConfig
  novelConfig?: NovelConfig
  buildChapterRequest?: (chapterNumber: number) => string | Promise<string>
  onProgress?: (info: { stage: string; current: number; total: number; message: string }) => void
  signal?: AbortSignal
}

export interface HeadlessRunResult {
  incubation: NovelIncubatorResult
  campaign?: CampaignReport
}

const DEFAULT_TARGET_CHAPTERS = 10
const DEFAULT_CRUISE_CHAPTERS = 3

/**
 * 归一化无头参数（纯函数）：
 * targetChapters 缺省取 10；cruiseChapterCount 缺省取 min(3, targetChapters)，
 * 且显式传入超限时截断至不超 targetChapters。
 */
export function normalizeHeadlessOptions(options: HeadlessRunOptions): NormalizedHeadlessOptions {
  const targetChapters = options.targetChapters ?? DEFAULT_TARGET_CHAPTERS
  const requestedCruise =
    options.cruiseChapterCount ?? Math.min(DEFAULT_CRUISE_CHAPTERS, targetChapters)
  return {
    ...options,
    targetChapters,
    autoStartCruise: options.autoStartCruise ?? false,
    cruiseChapterCount: Math.min(requestedCruise, targetChapters),
  }
}

/**
 * 无头一键生产：参数归一后直接委托 runEndToEndAutonomousNovelProduction。
 * 说明：buildChapterRequest 为 G2 预留透传位，上游端到端入口暂未接线，
 * 薄封装零新逻辑约束下仅归一参数并剥离该位后委托。
 */
export function runHeadlessNovelProduction(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const normalized = normalizeHeadlessOptions(options)
  return runEndToEndAutonomousNovelProduction({
    projectPath: normalized.projectPath,
    idea: normalized.idea,
    title: normalized.title,
    genre: normalized.genre,
    targetChapters: normalized.targetChapters,
    autoStartCruise: normalized.autoStartCruise,
    cruiseChapterCount: normalized.cruiseChapterCount,
    llmConfig: normalized.llmConfig,
    novelConfig: normalized.novelConfig,
    onProgress: normalized.onProgress,
    signal: normalized.signal,
  })
}
