/**
 * novel-locks.ts — Phase4 锁族（A8 补遗）：TS 侧 per-key 异步互斥。
 *
 * ── 设计 ──────────────────────────────────────────────────────────────
 * 零第三方依赖：Promise 链实现 FIFO 互斥（每个 key 一条等待链，先入先得）。
 * 用于保护 TS 侧「读-改-写」临界区——RMW 并发（community rebuild fire-and-forget
 * 与章节摄取并行）会丢写（见 chapter-ingest.ts communitySummaryAsync 分支）。
 *
 * ── 锁序约定（roadmap Phase4「防锁序死锁」）────────────────────────
 *   TS 锁在外 → Rust 命令在内（单向嵌套）：
 *   本模块的锁只包住【TS 层 RMW 段】，锁内调用的 Rust 命令（write_file_atomic
 *   / read_file / delete_file 等）内部另有各自锁（canon 双锁区、OP_LOCK、
 *   QUEUE_LOCKS）且均为叶子层短持有、不反向等待 TS 锁——不存在回环。
 *   禁止在持锁回调内再获取另一把 TS 锁（单锁单临界区原则）。
 *
 * ── 看门狗 ────────────────────────────────────────────────────────
 * 每把锁有等待超时（默认 10s）：超时即熔断返回错误，避免死锁/长饥饿
 * 挂死写入主链。锁内执行本身不设超时（读-改-写为短临界区）。
 */

/** 默认锁等待超时（ms）——超过视为死锁/饥饿，熔断。 */
export const LOCK_WAIT_TIMEOUT_MS = 10_000

interface LockEntry {
  /** 链尾 promise：后到者等待前者的释放。 */
  tail: Promise<void>
}

const lockChains = new Map<string, LockEntry>()

/**
 * 在 `key` 的互斥区内执行 `fn`（FIFO，等待超时熔断）。
 *
 * 用法：
 *   await withProjectLock(projectPath, async () => { /* RMW *\/ })
 */
export async function withProjectLock<T>(
  key: string,
  fn: () => Promise<T>,
  timeoutMs: number = LOCK_WAIT_TIMEOUT_MS,
): Promise<T> {
  const prev = lockChains.get(key)
  let release!: () => void
  // 当前任务在链尾排队；prev 释放后进入临界区。
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const myTurn = prev ? prev.tail.then(() => {}) : Promise.resolve()
  const tail = myTurn.then(() => gate)
  lockChains.set(key, { tail })

  try {
    await withTimeout(myTurn, timeoutMs, key)
  } catch (err) {
    // 熔断：本任务放弃临界区，但必须释放 gate 让链上后续排队者继续前进。
    release()
    throw err
  }
  try {
    return await fn()
  } finally {
    release()
    // 链空时清理，避免 key 无限累积（tail 未被后续排队者替换才删）。
    const entry = lockChains.get(key)
    if (entry && entry.tail === tail) {
      lockChains.delete(key)
    }
  }
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[novel-locks] lock wait timeout (${timeoutMs}ms) on key '${key}'`)),
      timeoutMs,
    )
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 仅测试用：清空所有锁链。 */
export function __resetLocksForTest(): void {
  lockChains.clear()
}
