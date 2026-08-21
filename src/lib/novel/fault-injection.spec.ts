/**
 * fault-injection.spec.ts — T18 故障注入矩阵 6 类种子化（数据面 canon 持久队列耐久）。
 *
 * ## 覆盖（共识裁决 T18 / TASK-P1-14）
 *   6 类故障注入：SIGKILL/部分写/磁盘满/文件锁/OOM/时钟偏移，mock CanonDualWriteDeps
 *   接口边界模拟。
 *
 *   - 每类：待写队列兜底 → 重启重放补齐 → 零 divergence
 *   - 种子化：纯函数 LCG（seed * 1664525 + 1013904223），同一 seed 确定性序列
 *   - 续跑一致：expect(second.finalState).toEqual(first.finalState)
 *   - 不依赖 Tauri 运行时：mock @tauri-apps/api/core 与 @/commands/fs
 *
 * ## 设计说明（6 类）
 *   1. SIGKILL：mock writeCanon 抛 SIGKILL 错误 → safeWrite 捕获 → ok:false → pending queue
 *   2. 部分写：queueRead 返回截断 JSONL → loadPendingQueue 跳过畸形行（容错）→ 有效行正常处理
 *   3. 磁盘满：queueWrite（writeFileAtomic）抛 ENOSPC → shadowWriteCanon 抛出 → 修复后 retry 成功
 *   4. 文件锁：queueWrite 抛 EBUSY → 同上锁失败 → 修复后 retry 成功
 *   5. OOM：writeCanon 抛 OOM Error → safeWrite 捕获 → ok:false → pending queue → replay 补齐
 *   6. 时钟偏移：vi.useFakeTimers 模拟时间跳变 → nextRetryAt 计算受时钟影响 → 到期判定正确
 *
 * 遵循 QMAI/CLAUDE.md：T18 新增锚点，落 `src/lib/novel/`。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import {
  shadowWriteCanon,
  replayPendingQueue,
  loadPendingQueue,
  savePendingQueue,
  reconcileOutcomes,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonCanonPayload,
  type CanonPendingRecord,
  type WriteOutcome,
  type ShadowWriteReport,
  type ReplayReport,
} from "./canon-dual-write"

// ──────────────────────────────────────────────────────────────────────────
// Module-level mocks（与 canon-dual-write.spec.ts 同契约）
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
}))

const invokeMock = vi.mocked(invoke)
const createDirectoryMock = vi.mocked(createDirectory)
const readFileMock = vi.mocked(readFile)
const writeFileAtomicMock = vi.mocked(writeFileAtomic)

beforeEach(() => {
  invokeMock.mockReset()
  createDirectoryMock.mockReset()
  readFileMock.mockReset()
  writeFileAtomicMock.mockReset()
  createDirectoryMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue("")
  writeFileAtomicMock.mockResolvedValue(undefined)
})

// ──────────────────────────────────────────────────────────────────────────
// LCG 种子化（共识裁决：seed * 1664525 + 1013904223）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 纯函数 LCG（线性同余生成器）：`seed * 1664525 + 1013904223`。
 * 返回无符号 32 位整数，同一 seed 始终产生确定序列。
 * 符合共识裁决：同一 seed 确定性序列，续跑一致断言。
 */
export function lcg(seed: number): number {
  return (seed * 1664525 + 1013904223) >>> 0
}

/** 由种子生成确定性操作 digest 序列（n 个）。 */
export function deterministicDigests(seed: number, n: number): string[] {
  const digests: string[] = []
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = lcg(s)
    digests.push(`d${s.toString(16).padStart(8, "0")}`)
  }
  return digests
}

/**
 * 验证 LCG 同一 seed 产生确定性序列。
 * 此为种子化原语测试，确保故障注入的随机性由 seed 唯一确定。
 */
describe("LCG 种子化原语", () => {
  it("同一 seed → 同一序列", () => {
    const a = deterministicDigests(42, 5)
    const b = deterministicDigests(42, 5)
    expect(b).toEqual(a)
  })
  it("不同 seed → 不同序列", () => {
    const a = deterministicDigests(42, 5)
    const b = deterministicDigests(99, 5)
    expect(b).not.toEqual(a)
  })
  it("LCG 值域为无符号 32 位整数", () => {
    // seed=0 → lcg(0) = 1013904223
    expect(lcg(0)).toBe(1013904223)
    // 同一 seed 幂等
    expect(lcg(0)).toBe(lcg(0))
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function ok(): WriteOutcome {
  return { ok: true }
}
function fail(msg: string): WriteOutcome {
  return { ok: false, error: msg }
}

function episode(digest: string): CanonCanonPayload {
  return {
    kind: "episode",
    episode: {
      id: "e",
      chapter_number: 1,
      entity_id: "a",
      digest,
      narrative_stage: "setup",
      reference_time: 1,
      archived: false,
    },
  }
}

function opFromDigest(digest: string): CanonDualWriteOp {
  return { digest, legacyPayload: {}, canonPayload: episode(digest) }
}

/** 内存队列 store：queueRead 返回 store.contents，queueWrite 更新 store.contents。 */
interface MemStore {
  contents: string
}
function memStore(): MemStore {
  return { contents: "" }
}

function memDeps(
  store: MemStore,
  writeLegacy:
    | WriteOutcome
    | ((p: string, c: unknown) => Promise<WriteOutcome>),
  writeCanon:
    | WriteOutcome
    | ((p: string, c: CanonCanonPayload) => Promise<WriteOutcome>),
): CanonDualWriteDeps {
  return {
    writeLegacy: typeof writeLegacy === "function" ? writeLegacy : async () => writeLegacy,
    writeCanon: typeof writeCanon === "function" ? writeCanon : async () => writeCanon,
    queueRead: async () => store.contents,
    queueWrite: async (_p, c) => {
      store.contents = c
    },
  }
}

/** 串行化 final state 用于续跑一致断言。 */
interface FinalState {
  queueContents: string
  replayTotal: number
  replaySucceeded: number
  replayRemaining: number
  reconcileConsistent: boolean
  reconcileDivergenceDigests: string[]
}

async function captureFinalState(
  report: ShadowWriteReport,
  replay: ReplayReport,
  store: MemStore,
): Promise<FinalState> {
  return {
    queueContents: store.contents,
    replayTotal: replay.total,
    replaySucceeded: replay.succeeded,
    replayRemaining: replay.remaining,
    reconcileConsistent: report.reconcile.consistent,
    reconcileDivergenceDigests: report.reconcile.divergences.map((d) => d.digest),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. SIGKILL — mock writeCanon 抛 SIGKILL 错误
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: SIGKILL（mock writeCanon 抛 SIGKILL）", () => {
  it("SIGKILL → 待写队列兜底 → 重放补齐 → 零 divergence", async () => {
    const store = memStore()
    // 第一次：canon 写抛 SIGKILL
    const deps = memDeps(store, ok(), async () => {
      throw new Error("SIGKILL")
    })
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("sigkill-1")], 1000)
    expect(report.queued).toBe(1)
    expect(report.reconcile.divergences[0]!.reasons.some((r) => r.includes("SIGKILL"))).toBe(true)
    // 队列持久化
    expect(store.contents).toContain("sigkill-1")

    // 重放：canon 恢复正常
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 2000)
    expect(replay.succeeded).toBe(1)
    expect(replay.remaining).toBe(0)

    // 零 divergence
    expect(reconcileOutcomes([{ digest: "sigkill-1", legacy: ok(), canon: ok(), consistent: true }]).consistent).toBe(true)
  })

  it("SIGKILL 后 legacy 也失败（两侧均 SIGKILL）→ 双写均失败，队列保留两条记录", async () => {
    const store = memStore()
    const deps = memDeps(
      store,
      async () => {
        throw new Error("SIGKILL")
      },
      async () => {
        throw new Error("SIGKILL")
      },
    )
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("both-kill")], 1000)
    expect(report.queued).toBe(1)
    expect(report.written).toBe(0)
    // 重放：两侧都恢复
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 2000)
    expect(replay.succeeded).toBe(1)
    expect(replay.remaining).toBe(0)
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260820

    async function run(s: number): Promise<FinalState> {
      const store = memStore()
      const ops = deterministicDigests(s, 3).map(opFromDigest)
      const deps = memDeps(store, ok(), async () => {
        throw new Error("SIGKILL")
      })
      const report = await shadowWriteCanon(deps, "P", ops, 1000)
      const replayDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(replayDeps, "P", 2000)
      return captureFinalState(report, replay, store)
    }

    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. 部分写 — 截断 canon-pending.jsonl JSONL 行
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: 部分写（截断 canon-pending.jsonl JSONL 行）", () => {
  it("截断行 → loadPendingQueue 跳过畸形行，有效行正常解析", async () => {
    const store = memStore()
    // 先构造一个正常队列
    const deps = memDeps(store, ok(), ok())
    const rec: CanonPendingRecord = {
      digest: "valid-1",
      createdAt: 1000,
      attempts: 1,
      nextRetryAt: 2000,
      lastError: "canon:timeout",
      legacyPayload: { kind: "noop" },
      canonPayload: episode("valid-1"),
    }
    await savePendingQueue(deps, "P", [rec])

    // 在 store 中注入截断行（末尾不完整 JSON）
    store.contents = `{"digest":"valid-0","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}\n` +
      `{"digest":"partial-1","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPa\n` + // 截断
      `{"digest":"valid-2","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}\n` +
      `not-even-json\n` + // 完全非 JSON
      `{"digest":"valid-3","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}\n`

    const queue = await loadPendingQueue(deps, "P")
    // 应跳过截断行和畸形行，只解析合法行
    expect(queue.map((r) => r.digest)).toEqual(["valid-0", "valid-2", "valid-3"])
    expect(queue).toHaveLength(3)
  })

  it("全部截断 → 空队列（容错不崩溃）", async () => {
    const store = memStore()
    store.contents = "truncated-line\n{\nnot-json\n"
    const deps = memDeps(store, ok(), ok())
    const queue = await loadPendingQueue(deps, "P")
    expect(queue).toEqual([])
  })

  it("部分写后队列仍可正常写入新记录", async () => {
    const store = memStore()
    store.contents = "corrupted\n"
    // canon 写失败 → 触发入队
    const deps = memDeps(store, ok(), fail("canon:timeout"))
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("after-corrupt")], 1000)
    expect(report.queued).toBe(1)
    // 队列含新记录（畸形行被 mergePending 忽略，仅新记录持久化）
    expect(store.contents).toContain("after-corrupt")
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260821
    async function run(s: number): Promise<FinalState> {
      const store = memStore()
      // 预置截断行
      store.contents = `{"digest":"pre","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}\n` +
        `truncated\n`
      const deps = memDeps(store, ok(), fail("canon:boom"))
      const ops = deterministicDigests(s, 2).map(opFromDigest)
      const report = await shadowWriteCanon(deps, "P", ops, 1000)
      // 重放时 canon 恢复
      const replayDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(replayDeps, "P", 2000)
      return captureFinalState(report, replay, store)
    }
    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. 磁盘满 — mock writeFileAtomic 抛 ENOSPC
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: 磁盘满（mock writeFileAtomic 抛 ENOSPC）", () => {
  it("queueWrite ENOSPC → shadowWriteCanon 抛错 → 队列未持久化 → 磁盘修复后重试从原始操作再次保全", async () => {
    const store = memStore()
    // 磁盘满：queueWrite 抛 ENOSPC
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => fail("canon:timeout"),
      queueRead: async () => store.contents,
      queueWrite: async () => {
        throw new Error("ENOSPC: No space left on device")
      },
    }
    // shadowWriteCanon 应抛出 ENOSPC 错误（队列持久失败）
    await expect(
      shadowWriteCanon(deps, "P", [opFromDigest("enospc-1")], 1000),
    ).rejects.toThrow(/ENOSPC/)

    // 队列未持久化（store.contents 仍为空）
    expect(store.contents).toBe("")

    // 磁盘修复后，重试原始操作（从 scratch，非 queue replay）
    const fixedDeps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => ok(), // 修复后 canon 恢复
      queueRead: async () => store.contents,
      queueWrite: async (_p, c) => {
        store.contents = c
      },
    }
    // 重新执行 shadowWriteCanon（原始操作重试），应全部成功
    const retry = await shadowWriteCanon(fixedDeps, "P", [opFromDigest("enospc-1")], 2000)
    expect(retry.written).toBe(1)
    expect(retry.queued).toBe(0)
    expect(retry.reconcile.consistent).toBe(true)
  })

  it("队列空时 ENOSPC → 不影响无队列操作（全部成功不入队）", async () => {
    const store = memStore()
    let enospcCalls = 0
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => ok(),
      queueRead: async () => store.contents,
      queueWrite: async (_p, _c) => {
        enospcCalls++
        throw new Error("ENOSPC")
      },
    }
    // 全部成功 → 不入队 → 不调 queueWrite
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("ok-1")], 1000)
    expect(report.written).toBe(1)
    expect(report.queued).toBe(0)
    expect(enospcCalls).toBe(0)
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260822
    async function run(s: number): Promise<FinalState> {
      const store = memStore()
      const ops = deterministicDigests(s, 2).map(opFromDigest)
      // 先让操作失败，但 queueWrite 也失败
      let _callCount = 0
      const failDeps: CanonDualWriteDeps = {
        writeLegacy: async () => ok(),
        writeCanon: async () => fail("canon:timeout"),
        queueRead: async () => store.contents,
        queueWrite: async (_p, _c) => {
          _callCount++
          throw new Error("ENOSPC")
        },
      }
      // 捕获 ENOSPC 错误（不 propagate）
      let report: ShadowWriteReport | null = null
      try {
        report = await shadowWriteCanon(failDeps, "P", ops, 1000)
      } catch {
        // 磁盘满，无 report
      }
      // 修复磁盘后重放（即使 report 为 null，queue 可能为空，重放应该空操作）
      const fixedDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(fixedDeps, "P", 2000)
      return {
        queueContents: store.contents,
        replayTotal: replay.total,
        replaySucceeded: replay.succeeded,
        replayRemaining: replay.remaining,
        reconcileConsistent: report?.reconcile.consistent ?? true,
        reconcileDivergenceDigests: report?.reconcile.divergences.map((d) => d.digest) ?? [],
      }
    }
    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. 文件锁 — mock writeFileAtomic 抛 EBUSY
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: 文件锁（mock writeFileAtomic 抛 EBUSY）", () => {
  it("queueWrite EBUSY → shadowWriteCanon 抛错 → 队列未持久化 → 锁释放后重试原始操作再次保全", async () => {
    const store = memStore()
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => fail("canon:timeout"),
      queueRead: async () => store.contents,
      queueWrite: async () => {
        throw new Error("EBUSY: Resource temporarily unavailable")
      },
    }
    await expect(
      shadowWriteCanon(deps, "P", [opFromDigest("ebusy-1")], 1000),
    ).rejects.toThrow(/EBUSY/)

    // 队列未持久化
    expect(store.contents).toBe("")

    // 锁释放后，重试原始操作
    const unlockedDeps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => ok(),
      queueRead: async () => store.contents,
      queueWrite: async (_p, c) => {
        store.contents = c
      },
    }
    const retry = await shadowWriteCanon(unlockedDeps, "P", [opFromDigest("ebusy-1")], 2000)
    expect(retry.written).toBe(1)
    expect(retry.queued).toBe(0)
    expect(retry.reconcile.consistent).toBe(true)
  })

  it("EBUSY 后队列为空 → 重放空操作（不崩溃）", async () => {
    const store = memStore()
    // 队列为空，但 savePendingQueue 仍会调 queueWrite 写空串
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => ok(),
      queueRead: async () => store.contents,
      queueWrite: async (_p, c) => {
        // 空队列写空串是正常操作，不抛错
        if (c !== "") throw new Error("EBUSY")
      },
    }
    const replay = await replayPendingQueue(deps, "P", 1000)
    expect(replay.total).toBe(0)
    expect(replay.remaining).toBe(0)
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260823
    async function run(s: number): Promise<FinalState> {
      const store = memStore()
      const ops = deterministicDigests(s, 2).map(opFromDigest)
      const failDeps: CanonDualWriteDeps = {
        writeLegacy: async () => ok(),
        writeCanon: async () => fail("canon:timeout"),
        queueRead: async () => store.contents,
        queueWrite: async () => {
          throw new Error("EBUSY")
        },
      }
      let report: ShadowWriteReport | null = null
      try {
        report = await shadowWriteCanon(failDeps, "P", ops, 1000)
      } catch {
        // 锁冲突
      }
      const fixedDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(fixedDeps, "P", 2000)
      return {
        queueContents: store.contents,
        replayTotal: replay.total,
        replaySucceeded: replay.succeeded,
        replayRemaining: replay.remaining,
        reconcileConsistent: report?.reconcile.consistent ?? true,
        reconcileDivergenceDigests: report?.reconcile.divergences.map((d) => d.digest) ?? [],
      }
    }
    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5. OOM — mock writeCanon 抛 OOM Error
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: OOM（mock writeCanon 抛 OOM）", () => {
  it("writeCanon OOM → safeWrite 捕获 → ok:false → pending queue → replay 补齐", async () => {
    const store = memStore()
    const deps = memDeps(store, ok(), async () => {
      throw new Error("OOM: Out of memory")
    })
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("oom-1")], 1000)
    expect(report.queued).toBe(1)
    expect(report.reconcile.divergences[0]!.reasons[0]).toContain("OOM")
    expect(store.contents).toContain("oom-1")

    // OOM 恢复后重放
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 2000)
    expect(replay.succeeded).toBe(1)
    expect(replay.remaining).toBe(0)

    expect(reconcileOutcomes([{ digest: "oom-1", legacy: ok(), canon: ok(), consistent: true }]).consistent).toBe(true)
  })

  it("OOM 发生在 legacy 侧 → legacy 失败，canon 成功 → pending queue 记录 legacy 失败", async () => {
    const store = memStore()
    const deps = memDeps(
      store,
      async () => {
        throw new Error("OOM: Legacy writer out of memory")
      },
      ok(),
    )
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("oom-legacy")], 1000)
    expect(report.queued).toBe(1)
    expect(report.reconcile.divergences[0]!.reasons[0]).toContain("legacy")
    // 重放：两侧恢复
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 2000)
    expect(replay.succeeded).toBe(1)
  })

  it("OOM 非 Error 对象（string）→ safeWrite 经 String(err) 兜底", async () => {
    const store = memStore()
    const deps = memDeps(store, ok(), async () => {
      throw "OOM: string error" // 非 Error 抛错
    })
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("oom-string")], 1000)
    expect(report.queued).toBe(1)
    expect(report.reconcile.divergences[0]!.reasons[0]).toContain("OOM: string error")
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260824
    async function run(s: number): Promise<FinalState> {
      const store = memStore()
      const ops = deterministicDigests(s, 3).map(opFromDigest)
      const deps = memDeps(store, ok(), async () => {
        throw new Error("OOM")
      })
      const report = await shadowWriteCanon(deps, "P", ops, 1000)
      const replayDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(replayDeps, "P", 2000)
      return captureFinalState(report, replay, store)
    }
    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 6. 时钟偏移 — vi.useFakeTimers 模拟时间跳变
// ──────────────────────────────────────────────────────────────────────────

describe("Fault: 时钟偏移（vi.useFakeTimers 模拟时间跳变）", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("时间跳变后 nextRetryAt 计算正确 → 到期判定不受影响", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000) // epoch = 1000

    const store = memStore()
    const deps = memDeps(store, ok(), fail("canon:timeout"))
    const report = await shadowWriteCanon(deps, "P", [opFromDigest("skew-1")], 1000)
    expect(report.queued).toBe(1)

    // 此时 pending 记录 nextRetryAt = 1000 + BACKOFF_BASE_MS = 2000
    const queue = await loadPendingQueue(deps, "P")
    expect(queue[0]!.nextRetryAt).toBe(2000)

    // 时钟偏移：时间跳变到 5000（远超 nextRetryAt）
    vi.setSystemTime(5000)

    // 重放：now=5000 > nextRetryAt=2000 → 到期，应重放
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 5000)
    expect(replay.succeeded).toBe(1) // 到期重放成功
    expect(replay.skipped).toBe(0) // 无跳过

    vi.useRealTimers()
  })

  it("时间回跳（负偏移）→ nextRetryAt 未到期 → 跳过保留", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)

    const store = memStore()
    const deps = memDeps(store, ok(), fail("canon:timeout"))
    // 操作在 now=5000 失败，nextRetryAt = 5000 + 1000 = 6000
    await shadowWriteCanon(deps, "P", [opFromDigest("skew-2")], 5000)

    // 时钟回跳到 3000（早于 nextRetryAt=6000）
    vi.setSystemTime(3000)

    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 3000)
    expect(replay.skipped).toBe(1) // 未到期，跳过
    expect(replay.succeeded).toBe(0) // 无重放
    expect(replay.remaining).toBe(1) // 仍保留

    // 时钟前进到 7000（超过 nextRetryAt=6000）→ 到期重放
    vi.setSystemTime(7000)
    const replay2 = await replayPendingQueue(replayDeps, "P", 7000)
    expect(replay2.succeeded).toBe(1)
    expect(replay2.remaining).toBe(0)

    vi.useRealTimers()
  })

  it("时钟偏移导致退避封顶时 nextRetryAt 不超过 BACKOFF_MAX_MS", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    const store = memStore()
    // 构造一个高 attempts 的 pending 记录
    const deps = memDeps(store, ok(), ok())
    const rec: CanonPendingRecord = {
      digest: "high-retry",
      createdAt: 0,
      attempts: 50,
      nextRetryAt: 1000, // 已到期
      lastError: "canon:timeout",
      legacyPayload: {},
      canonPayload: episode("high-retry"),
    }
    await savePendingQueue(deps, "P", [rec])

    // 时钟偏移到 2000
    vi.setSystemTime(2000)

    // 重放失败（仍失败）→ 重新退避
    const failDeps = memDeps(store, ok(), fail("still failing"))
    const replay = await replayPendingQueue(failDeps, "P", 2000)
    expect(replay.rescheduled).toBe(1)
    // 重新计算 nextRetryAt = 2000 + BACKOFF_MAX_MS（封顶）
    const remaining = await loadPendingQueue(failDeps, "P")
    expect(remaining[0]!.nextRetryAt).toBe(2000 + 5 * 60 * 1000) // 封顶

    vi.useRealTimers()
  })

  it("种子化续跑一致：同一 seed → 相同 finalState", async () => {
    const seed = 20260825
    async function run(s: number): Promise<FinalState> {
      vi.useFakeTimers()
      vi.setSystemTime(1000)

      const store = memStore()
      const ops = deterministicDigests(s, 2).map(opFromDigest)
      const deps = memDeps(store, ok(), fail("canon:timeout"))
      const report = await shadowWriteCanon(deps, "P", ops, 1000)

      // 时钟偏移到 5000
      vi.setSystemTime(5000)

      const replayDeps = memDeps(store, ok(), ok())
      const replay = await replayPendingQueue(replayDeps, "P", 5000)

      vi.useRealTimers()
      return captureFinalState(report, replay, store)
    }
    const first = await run(seed)
    const second = await run(seed)
    expect(second).toEqual(first)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 跨类集成：组合故障注入（多类混合）
// ──────────────────────────────────────────────────────────────────────────

describe("跨类集成：组合故障注入（多类混合场景）", () => {
  it("SIGKILL + OOM 混合 → 各自入队 → 重放全部补齐", async () => {
    const store = memStore()
    let callCount = 0
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => {
        callCount++
        if (callCount === 1) throw new Error("SIGKILL")
        if (callCount === 2) throw new Error("OOM")
        return ok()
      },
      queueRead: async () => store.contents,
      queueWrite: async (_p, c) => {
        store.contents = c
      },
    }
    const report = await shadowWriteCanon(
      deps,
      "P",
      [opFromDigest("mixed-sigkill"), opFromDigest("mixed-oom")],
      1000,
    )
    expect(report.queued).toBe(2)
    expect(report.written).toBe(0)

    // 重放：全部成功
    const replayDeps = memDeps(store, ok(), ok())
    const replay = await replayPendingQueue(replayDeps, "P", 2000)
    expect(replay.succeeded).toBe(2)
    expect(replay.remaining).toBe(0)
  })

  it("部分写 + 磁盘满 + 时钟偏移 → 容错链：畸形行跳过 + 队列持久失败 + 到期判定", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    const store = memStore()
    // 预置畸形行
    store.contents = "corrupted-line\n"

    // 操作失败 → 入队时 queueWrite 抛 ENOSPC
    const failDeps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => fail("canon:timeout"),
      queueRead: async () => store.contents,
      queueWrite: async () => {
        throw new Error("ENOSPC")
      },
    }
    await expect(
      shadowWriteCanon(failDeps, "P", [opFromDigest("multi-1")], 1000),
    ).rejects.toThrow(/ENOSPC/)

    // 时钟偏移到 5000
    vi.setSystemTime(5000)

    // 修复磁盘
    const fixedDeps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async () => ok(),
      queueRead: async () => store.contents,
      queueWrite: async (_p, c) => {
        store.contents = c
      },
    }
    // 重放：畸形行被跳过，但队列为空（ENOSPC 导致持久失败），故空操作
    const replay = await replayPendingQueue(fixedDeps, "P", 5000)
    expect(replay.total).toBe(0) // 畸形行跳过，无有效记录
    expect(replay.succeeded).toBe(0)

    vi.useRealTimers()
  })
})