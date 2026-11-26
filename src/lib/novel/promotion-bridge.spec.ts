/**
 * E-05 (run-execute-1, 双库架构蓝图) — 晋升桥凭证层 spec。
 *
 * 共识 C-1..C-14 落点验证：
 *   - C-2/C-3 幂等复合键（replayKey）与 ingest 内容哈希显式区分
 *   - C-4 record 原子提交点（写失败旧文件完好 = 结构上无半成品）
 *   - C-5 append-only 事件日志（promotion-events.jsonl）
 *   - C-8 状态机迁移表（非法迁移 throw）
 *   - C-9 fold-conflicts.jsonl 冲突仲裁日志
 *   - C-10 零向量化回归 + import 边界断言（promotion-bridge 不 import vector 模块）
 *   - C-11 门控代数（歧义 → BLOCK，绝不默认放行）
 *   - C-12 promotion-retry.jsonl 独立重放队列
 *   - C-14 finalSnapshot 只存引用 + digest 前缀，不存全文
 *   - 验收 3/4/7：幂等重放 / 原子性 / 重建演练（sink reset+重放×3 → hash 恒定）
 */
import { describe, it, expect, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (...args: unknown[]) => fsMocks.readFile(...args),
      writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
      createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
    
  }
})

import {
  computePromotionReplayKey,
  transitionPromotionState,
  PROMOTION_TRANSITIONS,
  evaluateGate,
  PROMOTION_GATE_ALGEBRA,
  promote,
  promotionAudit,
  promotionReplaySuccessRate,
  appendFoldConflictLog,
  enqueuePromotionRetry,
  replayPromotionRetryQueue,
  resolveNextPromotionRevision,
  promotionEventsPath,
  foldConflictsPath,
  promotionRetryPath,
  type CapabilitySink,
  type PromotionRecord,
} from "./promotion-bridge"

const PROJECT = "/tmp/proj"

/** 状态化 fs mock：writeFileAtomic 落盘 → readFile 读回（模拟真实原子存储）。 */
function installStatefulFs() {
  fsMocks.readFile.mockClear()
  fsMocks.writeFileAtomic.mockClear()
  fsMocks.createDirectory.mockClear()
  const disk = new Map<string, string>()
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const key = String(path)
    if (!disk.has(key)) throw new Error(`ENOENT: ${key}`)
    return disk.get(key)
  })
  fsMocks.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
    disk.set(String(path), String(content))
  })
  fsMocks.createDirectory.mockResolvedValue(undefined)
  return disk
}

function mockStore(records: Record<string, PromotionRecord> = {}) {
  fsMocks.readFile.mockResolvedValue(JSON.stringify({ records }))
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockResolvedValue(undefined)
}

function makeInput(overrides: Partial<Parameters<typeof promote>[0]> = {}) {
  return {
    channel: "formal-writeback" as const,
    projectPath: PROJECT,
    chapterId: "chapter-3",
    chapterNumber: 3,
    revision: 2,
    entity: "chapter-3",
    acceptTimestamp: "2026-09-04T08:00:00.000Z",
    gateContext: { draftStatus: "accepted", decisionGatesPass: true },
    contentDigestPrefix: "a1b2c3d4e5f6a1b2",
    ...overrides,
  }
}

/** 重建演练 sink：内存条目集合 + 确定性指纹（reset+重放×3 → hash 恒定）。 */
function makeDrillSink() {
  const entries = new Map<string, string>()
  const sink: CapabilitySink = {
    async write(_pp, record) {
      const entryId = record.targetRef.entryId ?? `prom-${record.replayKey}`
      entries.set(entryId, record.replayKey)
      return { entryId, hash: `sha256:${entryId}` }
    },
    async reset() {
      entries.clear()
    },
    async fingerprint() {
      return [...entries.keys()].sort().join("|")
    },
  }
  return { sink, entries }
}

describe("E-05 状态机（C-8：表驱动迁移，非法迁移 throw）", () => {
  it("合法迁移：draft→accepted→promoted→refined/superseded；draft/accepted→discarded", () => {
    expect(transitionPromotionState("draft", "accepted")).toBe("accepted")
    expect(transitionPromotionState("accepted", "promoted")).toBe("promoted")
    expect(transitionPromotionState("promoted", "refined")).toBe("refined")
    expect(transitionPromotionState("promoted", "superseded")).toBe("superseded")
    expect(transitionPromotionState("draft", "discarded")).toBe("discarded")
    expect(transitionPromotionState("accepted", "discarded")).toBe("discarded")
  })

  it("非法迁移 throw（单向门不可误开）", () => {
    expect(() => transitionPromotionState("draft", "promoted")).toThrow(/Illegal promotion state transition/)
    expect(() => transitionPromotionState("accepted", "accepted")).toThrow()
    expect(() => transitionPromotionState("promoted", "draft")).toThrow()
    expect(() => transitionPromotionState("discarded", "accepted")).toThrow()
  })

  it("迁移表覆盖全部 6 态且无自环", () => {
    const states = Object.keys(PROMOTION_TRANSITIONS)
    expect(states.sort()).toEqual(["accepted", "discarded", "draft", "promoted", "refined", "superseded"])
    for (const [from, tos] of Object.entries(PROMOTION_TRANSITIONS)) {
      expect(tos).not.toContain(from)
    }
  })
})

describe("E-05 门控代数（C-11：歧义 → BLOCK，绝不默认放行）", () => {
  it("formal-writeback：accepted+acceptTimestamp+决策门通过 → PASS", () => {
    expect(
      evaluateGate("formal-writeback", {
        channel: "formal-writeback",
        draftStatus: "accepted",
        acceptTimestamp: "2026-09-04T08:00:00.000Z",
        decisionGatesPass: true,
      }).verdict,
    ).toBe("PASS")
  })

  it("formal-writeback：acceptTimestamp 缺失 → BLOCK（无人工门凭证）", () => {
    const v = evaluateGate("formal-writeback", { channel: "formal-writeback", draftStatus: "accepted" })
    expect(v.verdict).toBe("BLOCK")
    expect(v.reason).toMatch(/acceptTimestamp 缺失/)
  })

  it("formal-writeback：rejected∧final 歧义信号 → BLOCK（BND-PRM-10）", () => {
    const v = evaluateGate("formal-writeback", {
      channel: "formal-writeback",
      draftStatus: "rejected",
      acceptTimestamp: "2026-09-04T08:00:00.000Z",
      ambiguous: true,
    })
    expect(v.verdict).toBe("BLOCK")
    expect(v.reason).toMatch(/gate-ambiguous/)
  })

  it("canon-dual-write：final+双写一致 → PASS；非 final → BLOCK", () => {
    expect(
      evaluateGate("canon-dual-write", {
        channel: "canon-dual-write",
        isFinalChapter: true,
        dualWriteConsistent: true,
      }).verdict,
    ).toBe("PASS")
    const v = evaluateGate("canon-dual-write", {
      channel: "canon-dual-write",
      isFinalChapter: false,
      dualWriteConsistent: true,
    })
    expect(v.verdict).toBe("BLOCK")
  })

  it("canon-backfill：rangeValid+snapshotReadable → PASS；显式 false → BLOCK", () => {
    expect(
      evaluateGate("canon-backfill", { channel: "canon-backfill", rangeValid: true, snapshotReadable: true }).verdict,
    ).toBe("PASS")
    expect(evaluateGate("canon-backfill", { channel: "canon-backfill", rangeValid: false }).verdict).toBe("BLOCK")
    expect(evaluateGate("canon-backfill", { channel: "canon-backfill", snapshotReadable: false }).verdict).toBe("BLOCK")
  })

  it("未知通道 → BLOCK（gate-ambiguous）", () => {
    const v = evaluateGate("unknown" as never, { channel: "unknown" as never })
    expect(v.verdict).toBe("BLOCK")
    expect(v.reason).toMatch(/未知通道/)
  })

  it("门控代数四元组齐全（condition/action/sideEffect/rollback）", () => {
    for (const channel of ["formal-writeback", "canon-dual-write", "canon-backfill"] as const) {
      const t = PROMOTION_GATE_ALGEBRA[channel]
      expect(typeof t.condition).toBe("function")
      expect(t.action.length).toBeGreaterThan(0)
      expect(t.sideEffect.length).toBeGreaterThan(0)
      expect(t.rollback.length).toBeGreaterThan(0)
    }
  })
})

describe("E-05 幂等复合键（C-2/C-3：可重放语义，与 ingest 内容哈希区分）", () => {
  it("replayKey = channel:chapterId:entity:revision", () => {
    expect(computePromotionReplayKey("formal-writeback", "chapter-3", "chapter-3", 2)).toBe(
      "formal-writeback:chapter-3:chapter-3:2",
    )
  })

  it("同 replayKey 重放 → 同一 record（replayed=true，不新增行）", async () => {
    installStatefulFs()
    const first = await promote(makeInput())
    expect(first.replayed).toBe(false)
    expect(first.record.replayKey).toBe("formal-writeback:chapter-3:chapter-3:2")
    // 第二次 promote：store 已含该 record → 幂等返回
    const second = await promote(makeInput())
    expect(second.replayed).toBe(true)
    expect(second.record.replayKey).toBe(first.record.replayKey)
    // 事件日志含 promote_replayed
    const events = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes("promote_replayed"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("revision 推进 → 新 replayKey（终稿版本是幂等键第三分量）", () => {
    const a = computePromotionReplayKey("formal-writeback", "chapter-3", "chapter-3", 2)
    const b = computePromotionReplayKey("formal-writeback", "chapter-3", "chapter-3", 3)
    expect(a).not.toBe(b)
  })
})

describe("E-05 原子提交点（C-4：写失败旧文件完好 = 结构上无半成品）", () => {
  it("promotions.json 原子写失败 → promote 抛错 + promote_failed 事件 + 入重试队列", async () => {
    installStatefulFs()
    fsMocks.writeFileAtomic.mockImplementation(async (path: string) => {
      if (String(path).endsWith("promotions.json")) throw new Error("disk full")
      return undefined
    })
    await expect(promote(makeInput())).rejects.toThrow(/disk full/)
    const events = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes("promote_failed"))
    expect(events.length).toBeGreaterThan(0)
    const retry = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.includes("promotion-retry"))
    expect(retry.length).toBeGreaterThan(0)
  })

  it("门控 BLOCK → 零 record + ambiguity_block 事件 + 严禁入重试队列（R3-M01 策略阻断绝不重试）", async () => {
    installStatefulFs()
    const result = await promote(makeInput({ gateContext: { draftStatus: "rejected", ambiguous: true } }))
    expect(result.blocked).toBeTruthy()
    expect(result.blocked?.reason).toMatch(/gate-ambiguous/)
    const events = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes("ambiguity_block"))
    expect(events.length).toBeGreaterThan(0)
    const retry = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.includes("promotion-retry"))
    expect(retry).toHaveLength(0)
  })
})

describe("R3-M01 晋升桥 fail-closed、并发三段短锁、补写 sink 与重放闭环", () => {
  it("promotions.json 损坏时 onCorrupt=throw fail-closed，绝不静默清空覆写", async () => {
    const disk = installStatefulFs()
    disk.set(`${PROJECT}/.novel/promotions.json`, "{corrupt-json")
    await expect(promote(makeInput())).rejects.toThrow(/Failed to parse promotions\.json/)
    expect(disk.get(`${PROJECT}/.novel/promotions.json`)).toBe("{corrupt-json")
  })

  it("appendJsonl 遇 EACCES fail-closed：不以空串覆写既有 JSONL 文件", async () => {
    const disk = installStatefulFs()
    const retryPath = promotionRetryPath(PROJECT)
    disk.set(retryPath, '{"replayKey":"existing"}\n')
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (String(p) === retryPath) throw new Error("EACCES: permission denied")
      const content = disk.get(String(p))
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    })
    await enqueuePromotionRetry(PROJECT, makeInput(), "transient-error")
    // EACCES 阻止覆盖原文件（原内容保持不变）
    expect(disk.get(retryPath)).toBe('{"replayKey":"existing"}\n')
  })

  it("并发 promote 三段短锁：两个不同 replayKey 在慢 sink 期间并发写入互不覆盖", async () => {
    const disk = installStatefulFs()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve
    })

    const slowSink: CapabilitySink = {
      async write(_pp, record) {
        if (record.sourceRef.chapterNumber === 1) {
          firstEntered()
          await firstGate
        }
        return { entryId: `entry-${record.replayKey}`, hash: "h" }
      },
      async reset() {},
      async fingerprint() {
        return ""
      },
    }

    const p1 = promote(makeInput({ chapterId: "chapter-1", chapterNumber: 1, entity: "ep-1" }), slowSink)
    await firstStarted
    const p2 = promote(makeInput({ chapterId: "chapter-2", chapterNumber: 2, entity: "ep-2" }), slowSink)
    const r2 = await p2
    expect(r2.record.targetRef.entryId).toBe("entry-formal-writeback:chapter-2:ep-2:2")

    releaseFirst()
    const r1 = await p1
    expect(r1.record.targetRef.entryId).toBe("entry-formal-writeback:chapter-1:ep-1:2")

    const stored = JSON.parse(disk.get(`${PROJECT}/.novel/promotions.json`)!) as { records: Record<string, PromotionRecord> }
    expect(Object.keys(stored.records)).toHaveLength(2)
    expect(stored.records["formal-writeback:chapter-1:ep-1:2"]?.targetRef.entryId).toBe("entry-formal-writeback:chapter-1:ep-1:2")
    expect(stored.records["formal-writeback:chapter-2:ep-2:2"]?.targetRef.entryId).toBe("entry-formal-writeback:chapter-2:ep-2:2")
  })

  it("既有 record 缺 targetRef.entryId 时再次 promote 补写 sink 并恢复 promotionAudit 一致", async () => {
    installStatefulFs()
    const failingSink: CapabilitySink = {
      async write() {
        throw new Error("sink temp down")
      },
      async reset() {},
      async fingerprint() {
        return ""
      },
    }
    const { sink: healthySink } = makeDrillSink()

    const first = await promote(makeInput(), failingSink)
    expect(first.record.targetRef.entryId).toBeUndefined()
    expect((await promotionAudit(PROJECT)).consistent).toBe(false)

    // 再次 promote：检测到缺 entryId → 补写 sink
    const second = await promote(makeInput(), healthySink)
    expect(second.replayed).toBe(true)
    expect(second.record.targetRef.entryId).toBe("prom-formal-writeback:chapter-3:chapter-3:2")
    expect((await promotionAudit(PROJECT)).consistent).toBe(true)
  })

  it("replayPromotionRetryQueue：重放到期项出队、保留未到期项、超 maxAttempts 转死信", async () => {
    const disk = installStatefulFs()
    const failingSink: CapabilitySink = {
      async write() {
        throw new Error("sink offline")
      },
      async reset() {},
      async fingerprint() {
        return ""
      },
    }
    const { sink: healthySink } = makeDrillSink()

    // 空队列（文件缺失）→ 空报告
    expect(await replayPromotionRetryQueue(PROJECT, healthySink)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      deadLettered: 0,
      remaining: 0,
    })

    // 首次 sink 失败入队（完整 PromoteInput 持久化）
    await promote(makeInput({ chapterId: "chapter-10", chapterNumber: 10, entity: "chapter-10" }), failingSink)
    const rawRetry = disk.get(promotionRetryPath(PROJECT)) ?? ""
    expect(rawRetry).toContain("acceptTimestamp")

    // 未到 nextRetryAt → 延迟保留
    const early = await replayPromotionRetryQueue(PROJECT, healthySink, { now: 1 })
    expect(early).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 1,
      deadLettered: 0,
      remaining: 1,
    })

    // 到期后重放成功 → 补齐 entryId 并出队
    const dueNow = Date.now() + 120_000
    const healed = await replayPromotionRetryQueue(PROJECT, healthySink, { now: dueNow })
    expect(healed).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      deferred: 0,
      deadLettered: 0,
      remaining: 0,
    })
    expect((await promotionAudit(PROJECT)).consistent).toBe(true)

    // 持续失败触发 maxAttempts=2 → 首次失败 attempts=1，重放失败 attempts=2 → deadLettered 出队
    await promote(makeInput({ chapterId: "chapter-11", chapterNumber: 11, entity: "chapter-11" }), failingSink)
    const dead = await replayPromotionRetryQueue(PROJECT, failingSink, {
      now: Date.now() + 120_000,
      maxAttempts: 2,
    })
    expect(dead).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      deferred: 0,
      deadLettered: 1,
      remaining: 0,
    })
  })

  it("resolveNextPromotionRevision：同内容幂等复用 revision，内容变更单调 +1", async () => {
    installStatefulFs()
    expect(
      await resolveNextPromotionRevision(PROJECT, "formal-writeback", "chapter-3", "chapter-3", "digest-v1"),
    ).toBe(1)

    await promote(makeInput({ revision: 1, contentDigestPrefix: "digest-v1" }))
    // 同内容 → 复用 revision 1
    expect(
      await resolveNextPromotionRevision(PROJECT, "formal-writeback", "chapter-3", "chapter-3", "digest-v1"),
    ).toBe(1)
    // 内容变更 → 推进到 revision 2
    expect(
      await resolveNextPromotionRevision(PROJECT, "formal-writeback", "chapter-3", "chapter-3", "digest-v2"),
    ).toBe(2)
  })
})

describe("E-05 finalSnapshot 引用级（C-14：不存终稿全文）", () => {
  it("record 只存 contentDigestPrefix，无正文全文字段", async () => {
    mockStore()
    const { record } = await promote(makeInput())
    expect(record.finalSnapshot.contentDigestPrefix).toBe("a1b2c3d4e5f6a1b2")
    expect(record.finalSnapshot.contentDigestPrefix.length).toBeLessThanOrEqual(16)
    // 类型层缺回写字段：无 writebackRef / reverseTarget / draftPatch / processStatus
    const rec = record as unknown as Record<string, unknown>
    expect(rec.writebackRef).toBeUndefined()
    expect(rec.reverseTarget).toBeUndefined()
    expect(rec.draftPatch).toBeUndefined()
    expect(rec.processStatus).toBeUndefined()
    expect(rec.finalSnapshot).not.toHaveProperty("content")
  })
})

describe("E-05 对账与指标（BND-CON-03 / 验收 3）", () => {
  it("promotionAudit：sink 写失败（凭证先行）→ 有凭证无条目 → inconsistent + recordWithoutEntry", async () => {
    installStatefulFs()
    const failingSink: CapabilitySink = {
      async write() {
        throw new Error("sink unavailable")
      },
      async reset() {},
      async fingerprint() {
        return ""
      },
    }
    await promote(makeInput(), failingSink)
    const audit = await promotionAudit(PROJECT, failingSink)
    expect(audit.consistent).toBe(false)
    expect(audit.recordWithoutEntry).toContain("formal-writeback:chapter-3:chapter-3:2")
  })

  it("promotionAudit：默认内存 sink 写成功 → 凭证与条目一致", async () => {
    installStatefulFs()
    await promote(makeInput())
    const audit = await promotionAudit(PROJECT)
    expect(audit.consistent).toBe(true)
  })

  it("promotionReplaySuccessRate：promoted 记录计数", async () => {
    installStatefulFs()
    await promote(makeInput())
    const rate = await promotionReplaySuccessRate(PROJECT)
    expect(rate.total).toBe(1)
    expect(rate.success).toBe(1)
    expect(rate.rate).toBe(1)
  })
})

describe("E-05 冲突仲裁日志（C-9：报告工件非真相文件）", () => {
  it("appendFoldConflictLog 落 .novel/fold-conflicts.jsonl（actual-first 决议）", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.createDirectory.mockResolvedValue(undefined)
    await appendFoldConflictLog(PROJECT, {
      ts: "2026-09-04T08:00:00.000Z",
      source: "pre-write-gate",
      chapter: "3",
      subject: "edge-1",
      shouldSide: "canon 写前门 WARN",
      actualSide: "actual-first",
      resolution: "actual-first",
    })
    const writes = fsMocks.writeFileAtomic.mock.calls.map((c) => String(c[0]))
    expect(writes.some((p) => p.endsWith("fold-conflicts.jsonl"))).toBe(true)
    const content = fsMocks.writeFileAtomic.mock.calls
      .map((c) => String(c[1]))
      .find((s) => s.includes("actual-first"))
    expect(content).toContain("actual-first")
  })

  it("路径契约：promotion-events / fold-conflicts / promotion-retry 三文件独立", () => {
    expect(promotionEventsPath(PROJECT)).toBe(`${PROJECT}/.novel/promotion-events.jsonl`)
    expect(foldConflictsPath(PROJECT)).toBe(`${PROJECT}/.novel/fold-conflicts.jsonl`)
    expect(promotionRetryPath(PROJECT)).toBe(`${PROJECT}/.novel/promotion-retry.jsonl`)
  })
})

describe("E-05 重建演练（验收 7：sink reset+重放×3 → hash 恒定）", () => {
  it("reset → 重放×3 → fingerprint 恒定 + record 幂等", async () => {
    const { sink } = makeDrillSink()
    const run = async () => {
      await sink.reset(PROJECT)
      installStatefulFs()
      const results: string[] = []
      for (let i = 0; i < 3; i++) {
        const r = await promote(
          makeInput({ chapterId: `chapter-${i + 1}`, chapterNumber: i + 1, entity: `chapter-${i + 1}` }),
          sink,
        )
        results.push(r.record.replayKey)
      }
      return sink.fingerprint(PROJECT)
    }
    const h1 = await run()
    const h2 = await run()
    expect(h1).toBe(h2)
    expect(h1.split("|").length).toBe(3)
  })
})

describe("E-05 import 边界（C-10：promotion-bridge 不 import vector/embedding 模块）", () => {
  it("promotion-bridge.ts 源码不 import embedding/vector 模块（防未来漂移）", async () => {
    const src = await import("./promotion-bridge?raw")
    const text = (src as unknown as { default: string }).default
    // 只断言 import 语句（注释提及 LanceDB 属文档说明，非依赖）
    expect(text).not.toMatch(/import[^;]*@\/lib\/embedding/)
    expect(text).not.toMatch(/import[^;]*vector-store/)
    expect(text).not.toMatch(/import[^;]*lancedb/i)
  })
})
