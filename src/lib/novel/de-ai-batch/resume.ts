/**
 * Wave 4 (v2.5.0): 批量去AI味 — status.json de_ai_batch 字段读写与断点恢复。
 *
 * 契约（wave4-adjudication-20260819 Q4）：additive 字段 + buildNextStatus
 * overrides 线穿（ADR-31：不线穿则生命周期函数会静默丢弃该字段）；
 * 计数一律派生（queue 只存顺序、perChapter 只存状态，无双份数组）。
 */

import {
  buildNextStatus,
  loadNovelSessionStatus,
  saveNovelSessionStatus,
} from "../novel-session-status"
import { DE_AI_BATCH_SCHEMA, type DeAiBatchState } from "./types"

export async function loadDeAiBatchState(projectPath: string): Promise<DeAiBatchState | null> {
  const status = await loadNovelSessionStatus(projectPath)
  return status?.de_ai_batch ?? null
}

/**
 * 持久化批次状态（best-effort）：status.json 不存在（如纯导入书）时返回 false，
 * 批次继续在内存运行，仅断点恢复不可用。
 */
export async function saveDeAiBatchState(projectPath: string, state: DeAiBatchState): Promise<boolean> {
  const status = await loadNovelSessionStatus(projectPath)
  if (!status) return false
  const next = buildNextStatus(status, {
    updated_at: state.updatedAt,
    status: status.status,
    de_ai_batch: state,
  })
  await saveNovelSessionStatus(projectPath, next)
  return true
}

export function createDeAiBatchState(input: {
  batchId: string
  queue: number[]
  concurrency: number
  genre?: string
  now?: () => string
}): DeAiBatchState {
  const now = input.now ?? (() => new Date().toISOString())
  const timestamp = now()
  return {
    schemaVersion: DE_AI_BATCH_SCHEMA,
    batchId: input.batchId,
    phase: "running",
    concurrency: input.concurrency,
    genre: input.genre,
    startedAt: timestamp,
    updatedAt: timestamp,
    queue: input.queue,
    perChapter: {},
  }
}

/**
 * 派生剩余队列：pending/failed/running（中断残留）重新入队；
 * ready/accepted/rejected/skipped 跳过。
 */
export function deriveRemainingQueue(state: DeAiBatchState): number[] {
  return state.queue.filter((chapterNumber) => {
    const chapter = state.perChapter[chapterNumber]
    if (!chapter) return true
    return chapter.status === "pending" || chapter.status === "failed" || chapter.status === "running"
  })
}

/** 恢复语义：running（中断残留）→ pending；phase → running。 */
export function resumeDeAiBatchState(
  state: DeAiBatchState,
  now: () => string = () => new Date().toISOString(),
): DeAiBatchState {
  const perChapter: DeAiBatchState["perChapter"] = {}
  for (const [key, chapter] of Object.entries(state.perChapter)) {
    perChapter[Number(key)] = chapter.status === "running"
      ? { ...chapter, status: "pending" }
      : chapter
  }
  return { ...state, phase: "running", perChapter, updatedAt: now() }
}
