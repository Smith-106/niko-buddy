/**
 * novel-locks.ts — Phase4 锁族（A8 补遗）：TS 侧 per-key 异步互斥。
 *
 * ── 单一实现（锁族合并，保守档不删文件）────────────────────────────
 * 本模块是进程内 TS 锁的【唯一真源】。历史遗留的同名实现
 * `src/lib/project-mutex.ts`（裸 path 键、无等待超时）已改为 re-export
 * 兼容层，不再持有第二张锁表——此前两族各自 Map 导致「同一 project 的
 * 两把锁互不可见」（跨族互斥失效），且键拼写差异（normalizePath）可绕过。
 *
 * ── 设计 ──────────────────────────────────────────────────────────────
 * 零第三方依赖：Promise 链实现 FIFO 互斥（每个 key 一条等待链，先入先得）。
 * 用于保护 TS 侧「读-改-写」临界区——RMW 并发（community rebuild fire-and-forget
 * 与章节摄取并行）会丢写（见 chapter-ingest.ts communitySummaryAsync 分支）。
 *
 * ── 键统一（同一键空间）──────────────────────────────────────────────
 * 所有键入表前经 canonicalLockKey 归一：
 *   1) `normalizePath`：`\` → `/`（Windows/Unix 拼写统一，差异不再绕过互斥）；
 *   2) 目录式尾斜杠删除（行尾 `…/`，以及复合键 `…/::suffix` 的空尾段）。
 * 裸 path 键（ingest / persist 族）与命名空间键（ledger: / page: /
 * session-status: / run-events:）共用同一张锁表：同一逻辑键无论从哪族 API、
 * 哪种路径拼写取锁，都命中同一把锁；命名空间前缀原样保留，互不混同。
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
import { normalizePath } from "@/lib/path-utils"

/** 默认锁等待超时（ms）——超过视为死锁/饥饿，熔断。 */
export const LOCK_WAIT_TIMEOUT_MS = 10_000

interface LockEntry {
  /** 链尾 promise：后到者等待前者的释放。 */
  tail: Promise<void>
}

const lockChains = new Map<string, LockEntry>()

/**
 * 锁键归一（键统一，幂等）：`normalizePath`（`\` → `/`）+ 目录式尾斜杠删除。
 *
 *   - `C:\a\b` ≡ `C:/a/b`（反斜杠拼写不再绕过互斥）；
 *   - `C:/a/b/` ≡ `C:/a/b`（尾斜杠拼写不再绕过互斥）；
 *   - `C:/a/b/::chat-persist` ≡ `C:/a/b::chat-persist`（复合键空尾段归一）；
 *   - `ledger:C:/a` / `page:C:/a` 命名空间前缀原样保留（不同锁域不混同）。
 */
export function canonicalLockKey(key: string): string {
  const slashed = normalizePath(key)
  // 仅删目录式尾斜杠：行尾，或复合/命名空间分隔符前（`ns:/path/`、`path/::suffix` 的尾段）。
  const canonical = slashed.replace(/\/+(?=$|:)/g, "")
  // 全分隔符键（如 "/" / "//"）保留原样，避免坍缩为空键。
  return canonical.length > 0 ? canonical : slashed
}

/**
 * 在 `key` 的互斥区内执行 `fn`（FIFO，等待超时熔断）。
 *
 * 键统一：内部先按 canonicalLockKey 归一，再落入本模块唯一的锁表——
 * 两族 API（本模块与 re-export 兼容层 `@/lib/project-mutex`）共享同一把锁。
 *
 * 用法：
 *   await withProjectLock(projectPath, async () => { /* RMW *\/ })
 */
export async function withProjectLock<T>(
  key: string,
  fn: () => Promise<T>,
  timeoutMs: number = LOCK_WAIT_TIMEOUT_MS,
): Promise<T> {
  const lockKey = canonicalLockKey(key)
  const prev = lockChains.get(lockKey)
  let release!: () => void
  // 当前任务在链尾排队；prev 释放后进入临界区。
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const myTurn = prev ? prev.tail.then(() => {}) : Promise.resolve()
  const tail = myTurn.then(() => gate)
  lockChains.set(lockKey, { tail })

  try {
    await withTimeout(myTurn, timeoutMs, lockKey)
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
    const entry = lockChains.get(lockKey)
    if (entry && entry.tail === tail) {
      lockChains.delete(lockKey)
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
