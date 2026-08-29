/**
 * writing-wake-lock.ts — 写正文/审查期间防止系统休眠的 TS 封装。
 * MIT licensed implementation.
 *
 * 调用 Rust 的 `acquire_wake_lock` / `release_wake_lock` 命令
 * (SetThreadExecutionState)。Windows-only；非 Windows 目标命令返回
 * `false`（惰性 no-op），调用方可忽略返回值。
 *
 * 用法：长任务开始时 `await acquireWakeLock()`，结束时 `await releaseWakeLock()`。
 * 建议在 try/finally 中成对调用，避免异常路径忘记释放。
 */

import { invoke } from "@tauri-apps/api/core"

/**
 * 阻止系统进入休眠状态（线程级，通过 SetThreadExecutionState）。
 * @returns Windows 上 true；非 Windows 目标 false（no-op）
 */
export async function acquireWakeLock(): Promise<boolean> {
  return invoke<boolean>("acquire_wake_lock")
}

/**
 * 释放 wake lock，恢复系统休眠策略。必须与 acquireWakeLock 成对调用。
 * @returns Windows 上 true；非 Windows 目标 false（no-op）
 */
export async function releaseWakeLock(): Promise<boolean> {
  return invoke<boolean>("release_wake_lock")
}

/**
 * 用 Promise 包装一个长任务，在其运行期间持有 wake lock，结束后自动释放。
 * 即使任务抛错也会释放（try/finally），是最安全的调用方式。
 *
 * @example
 * const result = await withWakeLock(generateChapter(chapterNum))
 */
export async function withWakeLock<T>(task: Promise<T>): Promise<T> {
  await acquireWakeLock()
  try {
    return await task
  } finally {
    await releaseWakeLock()
  }
}

/**
 * 引用计数版本地持锁：嵌套调用只 acquire 一次、全部结束后才 release。
 * 用于 streamChat 包装（所有生成/审查/对话自动覆盖），避免并发请求相互释放。
 */
let holdCount = 0
let active = false
let settle: Promise<void> = Promise.resolve()

function queue<T>(task: () => Promise<T>): Promise<T> {
  const run = settle.then(task, task)
  settle = run.then(() => undefined, () => undefined)
  return run
}

export async function withWritingWakeLock<T>(
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return operation()
  }
  const { isTauri } = await import("@/lib/platform")
  if (!isTauri()) {
    return operation()
  }
  return queue(async () => {
    holdCount += 1
    if (holdCount === 1 && !active) {
      active = true
      await acquireWakeLock()
    }
    try {
      return await operation()
    } finally {
      holdCount = Math.max(0, holdCount - 1)
      if (holdCount === 0 && active) {
        active = false
        await releaseWakeLock()
      }
    }
  })
}
