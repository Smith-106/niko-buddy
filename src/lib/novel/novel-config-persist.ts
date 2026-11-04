// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 小说配置共享落盘（设置页与主控运行设置块共用）
 *
 * 单一写入语义：patch → store 内存态 → saveNovelConfig 落盘 → 失败时**逐键**回滚。
 *
 * 逐键回滚是硬约束（R-03）：失败时只撤销本次 patch 涉及的键，
 * 期间其它并行写入（可能已成功落盘）的键不得被冲掉——因此 rollback 只遍历
 * `Object.keys(input.patch)`，绝不整体回滚 `input.prev`。
 *
 * 本模块不 toast、不吞错：错误一律以 NovelConfigPersistError 抛出（携带 rollback
 * 载荷），由调用方决定 UI 反馈，保证 toast 文案仍是原始错误消息。
 */

import type { NovelConfig } from "@/stores/wiki-store"
import { saveNovelConfig } from "@/lib/project-store"
import { toErrorMessage } from "@/lib/utils"

export interface PersistNovelConfigPatchInput {
  /** 本次要写入的键（只允许 patch 中出现的键被回滚） */
  patch: Partial<NovelConfig>
  /** 写入前的完整配置（用于合并出 next 与提供回滚原值） */
  prev: NovelConfig
  projectId?: string
  projectPath?: string
  /** 内存态写入（通常为 wiki-store 的 setNovelConfig）；失败回滚时以 rollback 再调用一次 */
  apply: (patch: Partial<NovelConfig>) => void
}

export class NovelConfigPersistError extends Error {
  readonly rollback: Partial<NovelConfig>
  /** 原始错误（tsconfig lib 为 ES2020，Error options.cause 不可用，故手动挂载）。 */
  readonly cause?: unknown

  constructor(message: string, rollback: Partial<NovelConfig>, options?: { cause?: unknown }) {
    super(message)
    this.name = "NovelConfigPersistError"
    this.rollback = rollback
    this.cause = options?.cause
  }
}

/**
 * 把一份配置 patch 写入 store 与落盘权威（saveNovelConfig，project-store.ts:482）。
 *
 * 成功返回合并后的完整配置；失败时已把 patch 内每个键回滚到 prev 值并抛出
 * NovelConfigPersistError（`rollback` 即被回滚的键值对）。
 */
export async function persistNovelConfigPatch(
  input: PersistNovelConfigPatchInput,
): Promise<{ next: NovelConfig }> {
  const next = { ...input.prev, ...input.patch }
  input.apply(input.patch)
  try {
    await saveNovelConfig(next, input.projectId, input.projectPath)
  } catch (err) {
    const rollback: Partial<NovelConfig> = {}
    for (const key of Object.keys(input.patch) as (keyof NovelConfig)[]) {
      ;(rollback as Record<string, unknown>)[key] = input.prev[key]
    }
    input.apply(rollback)
    throw new NovelConfigPersistError(toErrorMessage(err), rollback, { cause: err })
  }
  return { next }
}
