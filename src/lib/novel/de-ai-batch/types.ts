/**
 * Wave 4 (v2.5.0): 批量去AI味 — 共享类型与常量。
 *
 * 契约要点（wave4-adjudication-20260819）：
 * - 状态/指针落 status.json 新增 additive 字段 de_ai_batch（唯一真源）；
 * - 草稿内容落 .novel/de-ai-batch-drafts/ 工件（与既有 .novel/drafts/ 同构）；
 * - 计数一律派生（ADR-31 twin-path 教训：双份数组落盘必然漂移）。
 */

import type { LlmConfig } from "@/stores/wiki-store"

export const DE_AI_BATCH_SCHEMA = "de-ai-batch/1.0" as const

/** 默认并发上限（验收标准 1-5 章并发控制）。 */
export const DE_AI_BATCH_DEFAULT_CONCURRENCY = 3
export const DE_AI_BATCH_MIN_CONCURRENCY = 1
export const DE_AI_BATCH_MAX_CONCURRENCY = 5

/** 退避重试：最大重试 2 次（共 3 次尝试），基数 1s、指数 2、上限 10s、±20% 抖动。 */
export const DE_AI_BATCH_MAX_RETRIES = 2
export const DE_AI_BATCH_BACKOFF_BASE_MS = 1000
export const DE_AI_BATCH_BACKOFF_CAP_MS = 10000
export const DE_AI_BATCH_JITTER = 0.2

export type DeAiBatchPhase = "idle" | "running" | "paused" | "completed" | "failed"

export type DeAiChapterStatus =
  | "pending"
  | "running"
  | "ready"
  | "accepted"
  | "rejected"
  | "failed"
  | "skipped"

export interface DeAiChapterState {
  status: DeAiChapterStatus
  /** 已尝试次数（含重试）。 */
  attempts: number
  lastError?: string
  /** runDeAiDualPass combinedScore（诊断用，非门）。 */
  dualPassScore?: number
  /** 草稿工件相对路径（.novel/de-ai-batch-drafts/{n}.json）。 */
  draftPath?: string
  updatedAt?: string
}

/**
 * status.json 的 de_ai_batch additive 字段形状。
 * queue 只存剩余顺序；perChapter 是逐章唯一真源；汇总计数一律派生。
 */
export interface DeAiBatchState {
  schemaVersion: typeof DE_AI_BATCH_SCHEMA
  /** 一次性批次身份。 */
  batchId: string
  phase: DeAiBatchPhase
  /** 当时并发上限（复跑一致）。 */
  concurrency: number
  genre?: string
  startedAt?: string
  updatedAt: string
  /** 剩余待处理章节号（顺序固定）。 */
  queue: number[]
  perChapter: Record<number, DeAiChapterState>
}

export interface DeAiBatchProgress {
  phase: DeAiBatchPhase
  done: number
  total: number
  processed: number
  failed: number
  skipped: number
  current: { chapterNumber: number; status: DeAiChapterStatus } | null
  updatedAt: string
}

export interface ChapterFailure {
  chapterNumber: number
  error: string
  retries: number
  lastAttemptAt: string
}

export interface DeAiBatchSummary {
  schemaVersion: typeof DE_AI_BATCH_SCHEMA
  batchId: string
  phase: DeAiBatchPhase
  total: number
  processed: number
  failed: ChapterFailure[]
  skipped: number
  durationMs: number
  startedAt: string
  finishedAt: string
}

export interface DeAiBatchOptions {
  /** 并发上限，默认 3，可配 1-5。 */
  concurrency?: number
  /** 流派基线；缺省从 .novel/project-meta.json 解析。 */
  genre?: string
  /** LLM 配置（streamChat 传输）。 */
  llmConfig: LlmConfig
  /** 自定义去AI味 skill 文本；缺省用内置 QM-QUAI skill。 */
  customSkill?: string
  /** 用户个性化 prompt（buildUserAwareDeAiPrompt 产物）；缺省由 lib 从用户记忆构建。 */
  userPrompt?: string
  /** 用户避用词；缺省由 lib 从用户记忆聚合。 */
  avoidWords?: readonly string[]
  /** 机械干净章节自动跳过 LLM 改写（opt-in，默认 false）。 */
  skipCleanChapters?: boolean
  /** 章节子集；缺省 = 全书章节。 */
  chapterNumbers?: number[]
  /** 每章 settle 与 phase 迁移时回调（fire-and-forget）。 */
  onProgress?: (progress: DeAiBatchProgress) => void
  /** 外部中止（触发 phase → paused）。 */
  signal?: AbortSignal
}

/** 草稿工件内容（.novel/de-ai-batch-drafts/{chapterNumber}.json）。 */
export interface DeAiBatchDraftArtifact {
  schemaVersion: typeof DE_AI_BATCH_SCHEMA
  batchId: string
  chapterNumber: number
  sourcePath: string
  originalContent: string
  candidateContent: string
  dualPassScore: number
  avoidWordsHits: Array<{ word: string; count: number }>
  /** P2-1: 本次改写使用的 skill 版本（provenance 追踪，可选）。 */
  skillVersion?: string
  /** P2-1: 介入分级 triage 结果（可选，Track B soft）。 */
  interventionTier?: "light" | "medium" | "rewrite"
  createdAt: string
  updatedAt: string
}
