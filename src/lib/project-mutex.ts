/**
 * project-mutex.ts — 兼容层（锁族合并后仅 re-export，不再持有锁状态）。
 *
 * 历史问题（审计）：本模块曾自带一份裸 path 键、【无等待超时】的
 * promise-chain 互斥，与 `@/lib/novel/novel-locks` 的同名实现各自维护
 * 独立 Map：
 *   - 跨族互斥失效：同一 project 用两族 API 取锁时互不可见；
 *   - 键拼写差异（normalizePath：`\` vs `/`、尾斜杠）可绕过互斥。
 *
 * 合并（保守档，不删文件）：唯一实现位于 `@/lib/novel/novel-locks`
 * （FIFO + 10s 等待熔断 + canonicalLockKey 键统一，两族共享同一锁表），
 * 本模块保留全部原导出名做 re-export，既有调用面（ingest / persist /
 * 测试 helper）无需改动。
 *
 * 语义变化仅一处且更严：等待现在有 10s 看门狗（超时熔断抛错），不再
 * 可能无限期等锁；互斥范围只增不减（键归一使更多等价拼写命中同一把锁）。
 */
export {
  LOCK_WAIT_TIMEOUT_MS,
  canonicalLockKey,
  withProjectLock,
  __resetLocksForTest as __resetProjectLocksForTesting,
} from "@/lib/novel/novel-locks"
