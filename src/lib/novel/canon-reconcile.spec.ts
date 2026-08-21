/**
 * canon-reconcile.spec.ts — T17 两阶段重放对账收敛测试（目标覆盖率 100%）。
 *
 * 覆盖（蓝图 §6 T17 / F-14 / A-05.4）：
 *   - **两阶段重放**：初始对账不一致 → 按 digest 重放补齐 → 仍不一致才告警；
 *     重放事件**全程留痕**，绝不静默吞差异。
 *   - **fast-diff 差异度量**（Myers O(ND) 替代 LCS）：编辑脚本 + 编辑距离。
 *   - **fast-check 幂等属性**：reconcile/diffMetric/twoPhaseReconcile 的确定性、
 *     对称性、幂等性属性测试。
 *
 * 不依赖 Tauri 运行时：mock `@tauri-apps/api/core` 与 `@/commands/fs`。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import fc from "fast-check"
import { diffMetric, divergenceMetric, twoPhaseReconcile } from "./canon-reconcile"
import {
  attemptDualWrite,
  buildPendingRecord,
  savePendingQueue,
  type CanonCanonPayload,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonPendingRecord,
  type CanonWriteOutcome,
  type WriteOutcome,
} from "./canon-dual-write"

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

// ── helpers ──

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

function outcome(digest: string, legacy: WriteOutcome, canon: WriteOutcome): CanonWriteOutcome {
  return { digest, legacy, canon, consistent: legacy.ok && canon.ok }
}

/** 构造内存队列 deps：queueRead 返回 `store` 当前内容，queueWrite 更新 `store`。 */
function memQueueDeps(
  store: { contents: string },
  writeLegacy: WriteOutcome,
  writeCanon: WriteOutcome,
): CanonDualWriteDeps {
  return {
    writeLegacy: async () => writeLegacy,
    writeCanon: async () => writeCanon,
    queueRead: async () => store.contents,
    queueWrite: async (_p, c) => {
      store.contents = c
    },
  }
}

/** 由失败结果 + op 构造 pending 记录并塞入内存队列（now=0 → nextRetryAt=BASE=1000，于 now=1000 到期可重放）。 */
async function seedPending(
  deps: CanonDualWriteDeps,
  queuePath: string,
  entries: { digest: string; op: CanonDualWriteOp; legacy: WriteOutcome; canon: WriteOutcome }[],
): Promise<CanonPendingRecord[]> {
  const recs: CanonPendingRecord[] = []
  for (const e of entries) {
    const o = outcome(e.digest, e.legacy, e.canon)
    recs.push(buildPendingRecord(o, e.op, 0))
  }
  await savePendingQueue(deps, queuePath, recs)
  return recs
}

const QPATH = "P/.novel/canon-pending.jsonl"

// ──────────────────────────────────────────────────────────────────────────
// fast-diff 差异度量（Myers O(ND)）
// ──────────────────────────────────────────────────────────────────────────

describe("diffMetric（Myers O(ND) 差异度量）", () => {
  it("相同文本 → distance 0，单一 equal 段", () => {
    const m = diffMetric("hello", "hello")
    expect(m.distance).toBe(0)
    expect(m.insertions).toBe(0)
    expect(m.deletions).toBe(0)
    expect(m.edits).toEqual([{ type: "equal", text: "hello" }])
  })
  it("纯插入 → insertions 计入 distance", () => {
    const m = diffMetric("ab", "abc")
    expect(m.insertions).toBe(1)
    expect(m.deletions).toBe(0)
    expect(m.distance).toBe(1)
    expect(m.edits.some((e) => e.type === "insert" && e.text === "c")).toBe(true)
  })
  it("纯删除 → deletions 计入 distance", () => {
    const m = diffMetric("abc", "ab")
    expect(m.deletions).toBe(1)
    expect(m.insertions).toBe(0)
    expect(m.distance).toBe(1)
  })
  it("替换 → 删除+插入（编辑距离 = 删除长 + 插入长）", () => {
    const m = diffMetric("x", "y")
    expect(m.deletions + m.insertions).toBe(2)
    expect(m.distance).toBe(2)
  })
  it("两端均空 → distance 0，无编辑段", () => {
    const m = diffMetric("", "")
    expect(m.distance).toBe(0)
    expect(m.edits).toEqual([])
  })
  it("一端空 → 全删/全插", () => {
    expect(diffMetric("", "abc").insertions).toBe(3)
    expect(diffMetric("abc", "").deletions).toBe(3)
  })
  it("编辑脚本可还原 b（应用 insert/delete 到 a）", () => {
    const a = "the quick brown fox"
    const b = "the slow brown cat"
    const m = diffMetric(a, b)
    let rebuilt = ""
    for (const e of m.edits) {
      if (e.type === "equal" || e.type === "insert") rebuilt += e.text
    }
    expect(rebuilt).toBe(b)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// divergenceMetric（pending 记录的 legacy vs canon 序列化差异）
// ──────────────────────────────────────────────────────────────────────────

describe("divergenceMetric（pending 记录差异度量）", () => {
  it("legacy 与 canon 负载结构不同 → distance > 0", () => {
    const rec: CanonPendingRecord = {
      digest: "d",
      createdAt: 1,
      attempts: 1,
      nextRetryAt: 2,
      legacyPayload: { a: 1 },
      canonPayload: episode("d"),
    }
    expect(divergenceMetric(rec).distance).toBeGreaterThan(0)
  })
  it("相同序列化负载 → distance 0", () => {
    const payload = { x: 1 }
    const rec: CanonPendingRecord = {
      digest: "d",
      createdAt: 1,
      attempts: 1,
      nextRetryAt: 2,
      legacyPayload: payload,
      canonPayload: payload as unknown as CanonCanonPayload,
    }
    expect(divergenceMetric(rec).distance).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// twoPhaseReconcile —— 初始一致分支（无需重放）
// ──────────────────────────────────────────────────────────────────────────

describe("twoPhaseReconcile（初始一致 → 无需重放，不告警）", () => {
  it("全部一致 → finalConsistent=true，alerted=false，replayReport=null，trace 含 noop", async () => {
    const store = { contents: "" }
    const deps = memQueueDeps(store, ok(), ok())
    const results = [outcome("a", ok(), ok()), outcome("b", ok(), ok())]
    const report = await twoPhaseReconcile(deps, "P", results, 1000)
    expect(report.initialConsistent).toBe(true)
    expect(report.finalConsistent).toBe(true)
    expect(report.alerted).toBe(false)
    expect(report.replayReport).toBeNull()
    expect(report.pendingDigests).toEqual([])
    expect(report.replayedDigests).toEqual([])
    expect(report.trace.some((e) => e.phase === "noop")).toBe(true)
    expect(report.trace.some((e) => e.phase === "alert")).toBe(false)
  })
  it("空结果 → 一致，noop trace", async () => {
    const store = { contents: "" }
    const deps = memQueueDeps(store, ok(), ok())
    const report = await twoPhaseReconcile(deps, "P", [], 1000)
    expect(report.initialConsistent).toBe(true)
    expect(report.trace.find((e) => e.phase === "noop")?.message).toBe("no replay needed")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// twoPhaseReconcile —— 阶段 1：按 digest 重放补齐差异
// ──────────────────────────────────────────────────────────────────────────

describe("twoPhaseReconcile（阶段 1：按 digest 重放补齐差异）", () => {
  it("重放成功补齐 → finalConsistent=true，alerted=false，但 trace 留痕（不静默吞差异）", async () => {
    const store = { contents: "" }
    const seedDeps = memQueueDeps(store, ok(), ok())
    const op: CanonDualWriteOp = { digest: "a", legacyPayload: {}, canonPayload: episode("a") }
    await seedPending(seedDeps, QPATH, [{ digest: "a", op, legacy: ok(), canon: fail("boom") }])
    // 重放时 writeCanon 改为成功
    const replayDeps = memQueueDeps(store, ok(), ok())
    const results = [outcome("a", ok(), fail("boom"))]
    const report = await twoPhaseReconcile(replayDeps, "P", results, 1000)

    expect(report.initialConsistent).toBe(false)
    expect(report.initialDivergences).toEqual([{ digest: "a", reasons: ["canon:boom"] }])
    expect(report.replayReport).not.toBeNull()
    expect(report.replayReport!.succeeded).toBe(1)
    expect(report.replayedDigests).toEqual(["a"])
    expect(report.finalConsistent).toBe(true)
    expect(report.finalDivergences).toEqual([])
    expect(report.alerted).toBe(false)
    // 留痕：即便补齐，trace 含 reconcile-initial（不一致）+ replay gap filled + reconcile-final
    expect(report.trace.some((e) => e.phase === "reconcile-initial")).toBe(true)
    expect(report.trace.some((e) => e.phase === "replay" && e.digest === "a" && e.message === "gap filled by replay")).toBe(true)
    expect(report.trace.some((e) => e.phase === "reconcile-final")).toBe(true)
    // 不静默吞差异：trace 不含 alert（因已补齐），但保留了"曾不一致"的证据
    expect(report.trace.some((e) => e.phase === "alert")).toBe(false)
  })

  it("多条 pending 部分补齐：成功 digest 出队，失败 digest 仍在最终差异", async () => {
    const store = { contents: "" }
    const seedDeps = memQueueDeps(store, ok(), ok())
    const opA: CanonDualWriteOp = { digest: "a", legacyPayload: {}, canonPayload: episode("a") }
    const opB: CanonDualWriteOp = { digest: "b", legacyPayload: {}, canonPayload: episode("b") }
    await seedPending(seedDeps, QPATH, [
      { digest: "a", op: opA, legacy: ok(), canon: fail("boom-a") },
      { digest: "b", op: opB, legacy: ok(), canon: fail("boom-b") },
    ])
    // 重放：a 成功，b 仍失败
    const replayDeps: CanonDualWriteDeps = {
      writeLegacy: async () => ok(),
      writeCanon: async (_p, c) =>
        c.kind === "episode" && (c.episode as Record<string, unknown>).digest === "a" ? ok() : fail("still-b"),
      queueRead: async () => store.contents,
      queueWrite: async (_p, cc) => {
        store.contents = cc
      },
    }
    const results = [outcome("a", ok(), fail("boom-a")), outcome("b", ok(), fail("boom-b"))]
    const report = await twoPhaseReconcile(replayDeps, "P", results, 1000)

    expect(report.replayedDigests).toEqual(["a"])
    expect(report.finalDivergences.map((d) => d.digest)).toEqual(["b"])
    expect(report.finalDivergences[0]!.reasons).toEqual(["canon:boom-b"])
    expect(report.finalConsistent).toBe(false)
    expect(report.alerted).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// twoPhaseReconcile —— 阶段 2：仍不一致才告警
// ──────────────────────────────────────────────────────────────────────────

describe("twoPhaseReconcile（阶段 2：重放后仍不一致才告警）", () => {
  it("重放全部失败 → alerted=true，trace 含 alert，差异带 fast-diff 度量", async () => {
    const store = { contents: "" }
    const seedDeps = memQueueDeps(store, ok(), ok())
    const op: CanonDualWriteOp = { digest: "x", legacyPayload: { legacy: true }, canonPayload: episode("x") }
    await seedPending(seedDeps, QPATH, [{ digest: "x", op, legacy: ok(), canon: fail("perm") }])
    // 重放仍失败
    const replayDeps = memQueueDeps(store, ok(), fail("perm"))
    const results = [outcome("x", ok(), fail("perm"))]
    const report = await twoPhaseReconcile(replayDeps, "P", results, 1000)

    expect(report.finalConsistent).toBe(false)
    expect(report.alerted).toBe(true)
    expect(report.finalDivergences).toHaveLength(1)
    expect(report.finalDivergences[0]!.metric.distance).toBeGreaterThan(0)
    const alert = report.trace.find((e) => e.phase === "alert")
    expect(alert).toBeDefined()
    expect(alert!.message).toContain("did NOT silently swallow")
  })

  it("差异 digest 不在重放后的队列中（未落队列的极端情形）→ 仍按初始差异告警兜底", async () => {
    const store = { contents: "" }
    const deps = memQueueDeps(store, ok(), fail("boom"))
    const results = [outcome("orphan", ok(), fail("boom"))]
    const report = await twoPhaseReconcile(deps, "P", results, 1000)
    expect(report.pendingDigests).toEqual([])
    expect(report.replayedDigests).toEqual([])
    expect(report.finalDivergences.map((d) => d.digest)).toEqual(["orphan"])
    expect(report.alerted).toBe(true)
    // 度量兜底：digest 不在队列 → 用 reasons 字符串做 diff（空串对照）
    expect(report.finalDivergences[0]!.metric).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// twoPhaseReconcile —— 留痕不静默
// ──────────────────────────────────────────────────────────────────────────

describe("twoPhaseReconcile（重放事件全程留痕，不静默吞差异）", () => {
  it("即便重放完全补齐，trace 也保留 initial divergence + replay 记录", async () => {
    const store = { contents: "" }
    const seedDeps = memQueueDeps(store, ok(), ok())
    const op: CanonDualWriteOp = { digest: "z", legacyPayload: {}, canonPayload: episode("z") }
    await seedPending(seedDeps, QPATH, [{ digest: "z", op, legacy: ok(), canon: fail("transient") }])
    const replayDeps = memQueueDeps(store, ok(), ok())
    const report = await twoPhaseReconcile(replayDeps, "P", [outcome("z", ok(), fail("transient"))], 1000)
    const phases = report.trace.map((e) => e.phase)
    expect(phases).toContain("reconcile-initial")
    expect(phases).toContain("replay")
    expect(phases).toContain("reconcile-final")
    expect(report.trace.find((e) => e.phase === "reconcile-initial")?.message).toContain("divergence")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// fast-check 属性：diffMetric（Myers 差异度量数学属性）
// ──────────────────────────────────────────────────────────────────────────

describe("fast-check 属性：diffMetric（Myers 差异度量数学属性）", () => {
  it("identity：diffMetric(a,a).distance === 0", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (s) => {
        expect(diffMetric(s, s).distance).toBe(0)
      }),
    )
  })
  it("symmetry：distance(a,b) === distance(b,a)（Myers 编辑距离对称）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        expect(diffMetric(a, b).distance).toBe(diffMetric(b, a).distance)
      }),
    )
  })
  it("non-negative：distance/insertions/deletions >= 0", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        const m = diffMetric(a, b)
        expect(m.distance).toBeGreaterThanOrEqual(0)
        expect(m.insertions).toBeGreaterThanOrEqual(0)
        expect(m.deletions).toBeGreaterThanOrEqual(0)
      }),
    )
  })
  it("triangle inequality：distance(a,c) <= distance(a,b) + distance(b,c)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (a, b, c) => {
          const dac = diffMetric(a, c).distance
          const dab = diffMetric(a, b).distance
          const dbc = diffMetric(b, c).distance
          expect(dac).toBeLessThanOrEqual(dab + dbc)
        },
      ),
    )
  })
  it("idempotent application：编辑脚本可重建 b（应用 equal+insert）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        const m = diffMetric(a, b)
        let rebuilt = ""
        for (const e of m.edits) {
          if (e.type === "equal" || e.type === "insert") rebuilt += e.text
        }
        expect(rebuilt).toBe(b)
      }),
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// fast-check 属性：twoPhaseReconcile 幂等性与不静默不变式
// ──────────────────────────────────────────────────────────────────────────

describe("fast-check 属性：twoPhaseReconcile 幂等性与不静默不变式", () => {
  // 去重 + 限定为 ASCII 标识符 digest，避免 JSONL 边界与重复 digest 干扰幂等语义
  const digestArb = fc
    .string({ minLength: 1, maxLength: 8 })
    .map((s) => "d" + s.replace(/[^a-zA-Z0-9]/g, "x"))
  const digestsArb = fc.uniqueArray(digestArb, { maxLength: 6 })

  /** 用同一批（results + 队列种子 + deps）跑一次 twoPhaseReconcile 的工厂。 */
  async function runOnce(digests: string[], writeCanonOutcome: WriteOutcome, now: number) {
    const store = { contents: "" }
    const seedDeps = memQueueDeps(store, ok(), ok())
    const ops: CanonDualWriteOp[] = []
    const results: CanonWriteOutcome[] = []
    for (const d of digests) {
      const op: CanonDualWriteOp = { digest: d, legacyPayload: {}, canonPayload: episode(d) }
      ops.push(op)
      results.push(outcome(d, ok(), fail("init-boom")))
    }
    if (ops.length > 0) {
      await seedPending(seedDeps, QPATH, ops.map((op) => ({ digest: op.digest!, op, legacy: ok(), canon: fail("init-boom") })))
    }
    const deps = memQueueDeps(store, ok(), writeCanonOutcome)
    const report = await twoPhaseReconcile(deps, "P", results, now)
    return { report, store }
  }

  it("队列状态幂等：重放成功后，第二次调用执行零次重放且队列保持空（不动已收敛状态）", async () => {
    await fc.assert(
      fc.asyncProperty(digestsArb, async (digests) => {
        // 第一次：重放全部成功 → 队列应清空
        const first = await runOnce(digests, ok(), 1000)
        if (digests.length > 0) {
          expect(first.report.finalConsistent).toBe(true)
          expect(first.report.alerted).toBe(false)
          expect(first.store.contents).toBe("")
        }
        // 第二次：同一 store（已空）+ 同一 results 再跑 → 队列已空，无 pending 可重放
        const deps2 = memQueueDeps(first.store, ok(), ok())
        const results2: CanonWriteOutcome[] = digests.map((d) => outcome(d, ok(), fail("init-boom")))
        const second = await twoPhaseReconcile(deps2, "P", results2, 2000)
        // 幂等：第二次不执行任何重放（队列已空）
        expect(second.pendingDigests).toEqual([])
        expect(second.replayedDigests).toEqual([])
        if (digests.length > 0) {
          // 陈旧 results 仍不一致 → 进入重放分支但队列已空 → succeeded=0
          expect(second.replayReport).not.toBeNull()
          expect(second.replayReport!.succeeded).toBe(0)
        }
        // 队列状态不变（保持空）
        expect(first.store.contents).toBe("")
        // 不静默不变式：第二次如实记录陈旧 results 仍不一致 → 告警（不谎报一致）
        if (digests.length > 0) {
          expect(second.finalConsistent).toBe(false)
          expect(second.alerted).toBe(true)
          expect(second.trace.some((e) => e.phase === "alert")).toBe(true)
        }
      }),
      { numRuns: 25 },
    )
  })

  it("确定性：相同输入（results + 队列 + deps）→ 相同 finalConsistent/alerted/finalDivergences/trace 阶段", async () => {
    await fc.assert(
      fc.asyncProperty(digestsArb, async (digests) => {
        const a = await runOnce(digests, fail("persistent"), 1000)
        const b = await runOnce(digests, fail("persistent"), 1000)
        expect(b.report.finalConsistent).toBe(a.report.finalConsistent)
        expect(b.report.alerted).toBe(a.report.alerted)
        expect(b.report.finalDivergences.map((d) => d.digest)).toEqual(a.report.finalDivergences.map((d) => d.digest))
        expect(b.report.trace.map((e) => e.phase)).toEqual(a.report.trace.map((e) => e.phase))
      }),
      { numRuns: 20 },
    )
  })

  it("不静默不变式：alerted <=> finalDivergences 非空；初始不一致必有 replay trace；最终不一致必有 alert trace", async () => {
    await fc.assert(
      fc.asyncProperty(digestsArb, async (digests) => {
        const { report } = await runOnce(digests, fail("persist"), 1000)
        // alerted <=> finalDivergences 非空
        expect(report.alerted).toBe(report.finalDivergences.length > 0)
        expect(report.finalConsistent).toBe(report.finalDivergences.length === 0)
        if (report.initialConsistent) {
          expect(report.trace.some((e) => e.phase === "replay")).toBe(false)
        } else {
          // 初始不一致 → 必有重放阶段留痕（不静默吞差异）
          expect(report.trace.some((e) => e.phase === "replay")).toBe(true)
        }
        if (!report.finalConsistent) {
          expect(report.trace.some((e) => e.phase === "alert")).toBe(true)
        }
      }),
      { numRuns: 20 },
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 集成：与 T15 attemptDualWrite 联动（真实 digest 派生）
// ──────────────────────────────────────────────────────────────────────────

describe("twoPhaseReconcile × attemptDualWrite（真实 digest 派生联动）", () => {
  it("attemptDualWrite 失败结果传入 twoPhaseReconcile → 按 digest 对账一致", async () => {
    const store = { contents: "" }
    // 第一次双写：canon 失败
    const failDeps = memQueueDeps(store, ok(), fail("net"))
    const op: CanonDualWriteOp = { legacyPayload: {}, canonPayload: episode("real-d") }
    const o = await attemptDualWrite(failDeps, "P", op)
    expect(o.consistent).toBe(false)

    // 种入 pending（digest 来自 attemptDualWrite）
    const seedDeps = memQueueDeps(store, ok(), ok())
    await seedPending(seedDeps, QPATH, [{ digest: o.digest, op: { ...op, digest: o.digest }, legacy: ok(), canon: fail("net") }])

    // 重放成功
    const okDeps = memQueueDeps(store, ok(), ok())
    const report = await twoPhaseReconcile(okDeps, "P", [o], 1000)
    expect(report.initialDivergences[0]!.digest).toBe(o.digest)
    expect(report.replayedDigests).toEqual([o.digest])
    expect(report.finalConsistent).toBe(true)
    expect(report.alerted).toBe(false)
  })
})
