/**
 * Wave 4 (v2.5.0): 批量去AI味 — 并发原语。
 *
 * 风险裁决（路线图 §1.4）：裸 Promise.all 并发 LLM 调用会触发
 * rate-limit/上下文爆炸 → 自研信号量 + 退避重试 + 失败隔离。
 * runBatch 采用「N 个 worker 循环消费共享队列」形态：并发数被
 * concurrency 上限锁死（默认 3、可配 1-5），队列长度不参与并发放大。
 */

import {
  DE_AI_BATCH_BACKOFF_BASE_MS,
  DE_AI_BATCH_BACKOFF_CAP_MS,
  DE_AI_BATCH_JITTER,
  DE_AI_BATCH_MAX_RETRIES,
} from "./types"

/** 信号量原语：acquire/release/tryAcquire。 */
export interface Semaphore {
  acquire(): Promise<void>
  release(): void
  tryAcquire(): boolean
  readonly available: number
}

export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit))
  let available = max
  const waiters: Array<() => void> = []
  return {
    get available() {
      return available
    },
    async acquire(): Promise<void> {
      if (available > 0) {
        available -= 1
        return
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },
    release(): void {
      const next = waiters.shift()
      if (next) {
        next()
        return
      }
      available = Math.min(max, available + 1)
    },
    tryAcquire(): boolean {
      if (available <= 0) return false
      available -= 1
      return true
    },
  }
}

/** 瞬时错误判定：429 / 5xx / 网络 / 超时 / 传输停滞。 */
export function isTransientLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /429|5\d\d|rate\s*limit|too many requests|timeout|timed\s*out|network|econnreset|socket|transport inactivity|produced no (meaningful )?stream output/i.test(
    message,
  )
}

export interface BackoffOptions {
  maxRetries?: number
  baseMs?: number
  capMs?: number
  jitter?: number
  shouldRetry?: (error: unknown) => boolean
  /** 可注入时钟/随机源以便测试确定性。 */
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 指数退避 + ±jitter 抖动（防并发 worker 退避同步共振）。 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number = DE_AI_BATCH_BACKOFF_BASE_MS,
  capMs: number = DE_AI_BATCH_BACKOFF_CAP_MS,
  jitter: number = DE_AI_BATCH_JITTER,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt)
  const jitterAmount = exponential * jitter
  return Math.max(0, Math.round(exponential - jitterAmount + random() * 2 * jitterAmount))
}

/**
 * 带退避重试执行任务。仅瞬时错误重试（shouldRetry 默认 isTransientLlmError）；
 * 业务性失败（空章节/解析失败等）不重试直接抛出。
 */
export async function runWithBackoff<T>(
  task: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DE_AI_BATCH_MAX_RETRIES
  const baseMs = options.baseMs ?? DE_AI_BATCH_BACKOFF_BASE_MS
  const capMs = options.capMs ?? DE_AI_BATCH_BACKOFF_CAP_MS
  const jitter = options.jitter ?? DE_AI_BATCH_JITTER
  const shouldRetry = options.shouldRetry ?? isTransientLlmError
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) throw error
      const delay = backoffDelayMs(attempt, baseMs, capMs, jitter, random)
      await sleep(delay)
    }
  }
  /* v8 ignore next -- 循环内所有路径均 return/throw，不可达 */
  throw new Error("runWithBackoff: unreachable")
}

export interface RunBatchOptions {
  concurrency: number
  signal?: AbortSignal
}

/**
 * 固定并发槽数的 worker-pool 循环调度（非 Promise.all 一次性全投）。
 * 每项失败被隔离（worker 内部已记录失败详情），单章失败不炸整批。
 * 中止后 worker 不再取新项，in-flight 项自然完成。
 */
export async function runBatch<T>(
  queue: readonly T[],
  worker: (item: T) => Promise<void>,
  options: RunBatchOptions,
): Promise<void> {
  const items = [...queue]
  const workerCount = Math.max(1, Math.min(Math.floor(options.concurrency), items.length))
  let cursor = 0
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (options.signal?.aborted) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      try {
        await worker(item)
      } catch {
        // 失败隔离：worker 内部已记录失败详情；此处兜底防止单章异常炸掉整批
      }
    }
  })
  // 仅 join 有界 worker 池（数量 ≤ concurrency），队列长度不参与并发放大
  await Promise.all(workers)
}
