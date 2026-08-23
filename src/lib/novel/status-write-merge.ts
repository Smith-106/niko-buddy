/**
 * status-write-merge.ts — T34 哨兵硬化：status 写入合并（关高频小写 + flush 语义）。
 *
 * ## 职责（TASK-P6-34 / T34）
 *   深章生成主链对 `.novel/status.json` 的更新存在两类节奏：
 *     - **关键转移**（accept/reject/pause/block/complete 等生命周期迁移）——必须立即落盘；
 *     - **非关键小写**（stage_metrics 追加、进度心跳等高频小负载）——逐次原子写既慢又
 *       放大崩溃窗口。
 *   本模块提供写入合并层：
 *     1. critical → 绕过间隔**立即写**，且保证调用方提交的那份 payload 本身落盘后才 ack；
 *     2. non_critical → 合并（latest-wins 覆盖 pending）+ 最小写间隔（minInterval），
 *        由调用方在节奏点调 drain() 到期刷出；
 *     3. flush() → 强制写出 pending，用于 **accept 与退出前**的最终一致点。
 *
 * ## 契约与护栏（HARD-1 / ADR-16）
 *   - `.novel/status.json` 唯一真源地位不变：本模块不持有状态、不派生第二份会话文件，
 *     只调度「何时把最新 payload 写下去」。真实写入经 deps.write 注入——生产装配为
 *     saveNovelSessionStatus / writeFileAtomic 包装，测试注入 mock。
 *   - **全量快照契约**：调用方必须以完整最新 status 快照字符串提交；本层只做「何时写」
 *     的调度，不做部分字段合并。非关键心跳被关键转移覆盖时，其内容必然已包含在更新
 *     的关键快照中（关键快照在后构建、含全部先前状态）。
 *   - 写串行化：内部 promise 链保证任意时刻至多一个在途写，杜绝乱序回写覆盖。
 *   - 写失败保留 pending：drain/flush 失败后 payload 不丢，后续 flush 可重试。
 *   - critical 不互相合并：连续多次关键转移各自落盘（生命周期状态不可跳过持久化），
 *     但仍串行执行防交错。
 */

/** 非关键写入最小间隔默认值：5s（50ch-telemetry 实测后可校准）。 */
export const DEFAULT_STATUS_WRITE_MIN_INTERVAL_MS = 5_000

/** 写入关键性：critical=立即写；non_critical=合并+最小间隔。 */
export type StatusWriteCriticality = "critical" | "non_critical"

/** 写入依赖注入（真实 fs / 测试 mock）。now 注入保证可测确定性。 */
export interface StatusWriteMergerDeps {
  /** 执行一次持久化写入（序列化后的最新 status payload）。 */
  write: (payload: string) => Promise<void>
  /** 单调时钟（epoch ms）。 */
  now: () => number
}

export interface StatusWriteMergerOptions {
  /** 非关键写入最小间隔 ms；非法（<=0/NaN）回退默认值。 */
  minIntervalMs?: number
}

export interface StatusWriteMergerStats {
  /** critical 路径实际落盘次数。 */
  criticalWrites: number
  /** drain 刷出的落盘次数。 */
  drainedWrites: number
  /** flush 强制落盘次数。 */
  flushedWrites: number
  /** 非关键 schedule 总次数。 */
  nonCriticalSchedules: number
  /**
   * 合并压力计数：提交时已存在未落盘的更早 pending（被本次提交覆盖或随行吸收）。
   * 该值越大说明高频小写越多地被合并层挡在了盘外。
   */
  mergedSubmissions: number
  /** 最近一次实际落盘时刻 epoch ms；从未写过为 null。 */
  lastWriteAtMs: number | null
}

export interface StatusWriteMerger {
  /**
   * 提交一份最新 status 快照 payload。
   *   - critical：返回的 Promise 在**该份 payload**实际落盘后 resolve（失败则 reject）。
   *   - non_critical：立即 resolve（合并进 pending；是否已落盘以 stats/pending 为准）。
   */
  schedule: (payload: string, criticality: StatusWriteCriticality) => Promise<void>
  /**
   * 节奏点驱动：若存在 pending 且距上次实际落盘 ≥ minInterval（或从未写过），写出当前
   * pending。返回本次是否发生了写入。写失败保留 pending 并抛出。
   */
  drain: (now?: number) => Promise<boolean>
  /** 强制写出当前 pending（accept/退出前调用）。无 pending 返回 false。 */
  flush: () => Promise<boolean>
  /** 是否有未落盘 payload。 */
  hasPending: () => boolean
  /** 计数快照（新对象）。 */
  stats: () => StatusWriteMergerStats
}

/**
 * 创建写入合并器。deps 缺失 fail-fast（哨兵组件不接受静默降级配置）。
 */
export function createStatusWriteMerger(
  deps: StatusWriteMergerDeps,
  options: StatusWriteMergerOptions = {},
): StatusWriteMerger {
  if (typeof deps?.write !== "function") {
    throw new TypeError("createStatusWriteMerger: deps.write 必须是函数")
  }
  if (typeof deps?.now !== "function") {
    throw new TypeError("createStatusWriteMerger: deps.now 必须是函数")
  }
  const minIntervalMs =
    typeof options.minIntervalMs === "number"
      && Number.isFinite(options.minIntervalMs)
      && options.minIntervalMs > 0
      ? options.minIntervalMs
      : DEFAULT_STATUS_WRITE_MIN_INTERVAL_MS

  let pendingPayload: string | null = null
  let lastWriteAtMs: number | null = null
  let criticalWrites = 0
  let drainedWrites = 0
  let flushedWrites = 0
  let nonCriticalSchedules = 0
  let mergedSubmissions = 0

  // 写串行化链：任一操作失败不断链（后续操作照常执行）。
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op, op)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 执行一次落盘。target=null → 取当前 pending；显式 target（critical 捕获语义）→
   * 必须写出该份本身。成功后仅当 pending 未被更新的提交改写时才清空（在途写期间到达
   * 的新提交不被误清）。失败保留现场由调用方语义处理。
   */
  const performWrite = async (
    target: string | null,
    bucket: "criticalWrites" | "drainedWrites" | "flushedWrites",
  ): Promise<boolean> => {
    const payload = target ?? pendingPayload
    if (payload === null) return false
    await deps.write(payload)
    if (pendingPayload === payload) pendingPayload = null
    lastWriteAtMs = deps.now()
    if (bucket === "criticalWrites") criticalWrites += 1
    else if (bucket === "drainedWrites") drainedWrites += 1
    else flushedWrites += 1
    return true
  }

  const merger: StatusWriteMerger = {
    schedule(payload, criticality) {
      if (typeof payload !== "string") {
        return Promise.reject(new TypeError("schedule: payload 必须是字符串（序列化后的 status JSON 快照）"))
      }
      if (criticality === "critical") {
        // 关键转移：先接管 pending（若有未落盘旧 payload 则计一次合并压力），
        // 再按捕获语义排队——保证写出的就是本调用方这份 payload。
        if (pendingPayload !== null) mergedSubmissions += 1
        pendingPayload = payload
        return enqueue(() => performWrite(payload, "criticalWrites")).then(() => {})
      }
      nonCriticalSchedules += 1
      if (pendingPayload !== null) mergedSubmissions += 1
      pendingPayload = payload
      return Promise.resolve()
    },

    async drain(now) {
      const t = typeof now === "number" && Number.isFinite(now) ? now : deps.now()
      if (pendingPayload === null) return false
      const elapsedOk = lastWriteAtMs === null || t - lastWriteAtMs >= minIntervalMs
      if (!elapsedOk) return false
      return enqueue(() => performWrite(null, "drainedWrites"))
    },

    async flush() {
      if (pendingPayload === null) return false
      return enqueue(() => performWrite(null, "flushedWrites"))
    },

    hasPending: () => pendingPayload !== null,

    stats: () => ({
      criticalWrites,
      drainedWrites,
      flushedWrites,
      nonCriticalSchedules,
      mergedSubmissions,
      lastWriteAtMs,
    }),
  }
  return merger
}
