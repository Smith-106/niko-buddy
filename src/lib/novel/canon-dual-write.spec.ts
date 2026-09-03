/**
 * canon-dual-write.spec.ts — T15 影子双写编排收敛测试（目标覆盖率 100%）。
 *
 * 覆盖：双写并行 + 对账 + 持久待写队列（digest 幂等 + 退避封顶）+ 按序重放 + T+5 退役。
 * 不依赖 Tauri 运行时：mock `@tauri-apps/api/core` 与 `@/commands/fs`。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  canonPendingQueuePath,
  computeBackoffMs,
  parentDir,
  canonStoreWriter,
  snapshotLegacyWriter,
  defaultCanonDualWriteDeps,
  attemptDualWrite,
  reconcileCanon,
  reconcileOutcomes,
  loadPendingQueue,
  savePendingQueue,
  mergePending,
  buildPendingRecord,
  reschedule,
  shadowWriteCanon,
  replayPendingQueue,
  retireAfterT5,
  type CanonCanonPayload,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonPendingRecord,
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

function okOutcome(): WriteOutcome {
  return { ok: true }
}
function failOutcome(msg: string): WriteOutcome {
  return { ok: false, error: msg }
}

function legacyWriter(payload: WriteOutcome): CanonDualWriteDeps["writeLegacy"] {
  return async () => payload
}
function canonWriter(payload: WriteOutcome): CanonDualWriteDeps["writeCanon"] {
  return async (_p, _c) => payload
}

function episodePayload(): CanonCanonPayload {
  return { kind: "episode", episode: { id: "ep", chapter_number: 1, entity_id: "a", digest: "d", narrative_stage: "setup", reference_time: 1, archived: false } }
}
function supersedePayload(): CanonCanonPayload {
  return { kind: "supersede", request: { old_edge_ids: ["o1"], cap_chapter: 5, new_edges: [] } }
}

function depsWith(writeLegacy: WriteOutcome, writeCanon: WriteOutcome): CanonDualWriteDeps {
  return {
    writeLegacy: legacyWriter(writeLegacy),
    writeCanon: canonWriter(writeCanon),
    queueRead: async () => "",
    queueWrite: async () => {},
  }
}

function pendingRec(over: Partial<CanonPendingRecord> = {}): CanonPendingRecord {
  return {
    digest: "dig",
    createdAt: 1000,
    attempts: 1,
    nextRetryAt: 2000,
    lastError: "canon:boom",
    legacyPayload: { kind: "noop" },
    canonPayload: episodePayload(),
    ...over,
  }
}

/** 构造带指定 episode digest 的待写记录（replay 测试按 digest 区分成功/失败）。 */
function epRec(digest: string, nextRetryAt: number, attempts = 1): CanonPendingRecord {
  return pendingRec({
    digest,
    nextRetryAt,
    attempts,
    canonPayload: {
      kind: "episode",
      episode: { id: "e", chapter_number: 1, entity_id: "a", digest, narrative_stage: "setup", reference_time: 1, archived: false },
    },
  })
}

// ──────────────────────────────────────────────────────────────────────────
// 退避
// ──────────────────────────────────────────────────────────────────────────

describe("computeBackoffMs（指数退避 + 封顶）", () => {
  it("attempts<=1 → BASE", () => {
    expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS)
    expect(computeBackoffMs(0)).toBe(BACKOFF_BASE_MS)
    expect(computeBackoffMs(-5)).toBe(BACKOFF_BASE_MS)
  })
  it("attempts=2 → BASE*FACTOR", () => {
    expect(computeBackoffMs(2)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR)
  })
  it("attempts 足够大 → 封顶 BACKOFF_MAX_MS", () => {
    expect(computeBackoffMs(100)).toBe(BACKOFF_MAX_MS)
    // 验证 2^(a-1)*BASE 在某处越过封顶
    expect(BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, 9)).toBeGreaterThan(BACKOFF_MAX_MS)
    expect(computeBackoffMs(10)).toBe(BACKOFF_MAX_MS)
  })
})

describe("parentDir（队列父目录）", () => {
  it("含 '/' → 截到父目录", () => {
    expect(parentDir("a/b/c.jsonl")).toBe("a/b")
  })
  it("含 '\\' → 截到父目录", () => {
    expect(parentDir("a\\b\\c.jsonl")).toBe("a\\b")
  })
  it("无分隔符 → '.'", () => {
    expect(parentDir("file.jsonl")).toBe(".")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 路径
// ──────────────────────────────────────────────────────────────────────────

describe("canonPendingQueuePath（ADR-16 运行期 .novel/ 路径）", () => {
  it("落在 {project}/.novel/canon-pending.jsonl", () => {
    expect(canonPendingQueuePath("E:/Novel")).toBe("E:/Novel/.novel/canon-pending.jsonl")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 写适配器
// ──────────────────────────────────────────────────────────────────────────

describe("canonStoreWriter（默认 canon 写，IPC 分发）", () => {
  it("episode → canon_ingest_episode，返回 revision", async () => {
    invokeMock.mockResolvedValue({ inserted: true, max_revision: 7 })
    const res = await canonStoreWriter("P", episodePayload())
    expect(invokeMock).toHaveBeenCalledWith("canon_ingest_episode", { projectId: "P", episode: expect.any(Object) })
    expect(res).toEqual({ ok: true, revision: 7 })
  })
  it("supersede → canon_supersede_edges，返回 revision", async () => {
    invokeMock.mockResolvedValue({ result: {}, max_revision: 3 })
    const res = await canonStoreWriter("P", supersedePayload())
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", { projectId: "P", request: expect.any(Object) })
    expect(res).toEqual({ ok: true, revision: 3 })
  })
  it("53 P1-2: 写前 gate WARN (含 block 降级) 不丢写——继续 invoke 且带 gate 标记", async () => {
    // 同端点同 predicate 异值重叠 → gate WARN (默认 warn-only); 写必须继续
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return { edges: [{ id: "e1", source_id: "A", target_id: "C", predicate: "capital_of", valid_at: 1 }] }
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 7 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [{ id: "n1", source_id: "A", target_id: "B", predicate: "capital_of", valid_at: 2 }],
      },
    })
    expect(res).toEqual({ ok: true, revision: 7, gate: "pre_write_warn" })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })
  it("invoke 抛错 → ok:false + error", async () => {
    invokeMock.mockRejectedValue(new Error("db down"))
    const res = await canonStoreWriter("P", episodePayload())
    expect(res).toEqual({ ok: false, error: "db down" })
  })
  it("invoke 拒绝非 Error → ok:false + String(err) 兜底", async () => {
    invokeMock.mockRejectedValue("string boom")
    const res = await canonStoreWriter("P", episodePayload())
    expect(res).toEqual({ ok: false, error: "string boom" })
  })
  it("supersede_by_digest → canon_supersede_edges 带 caused_by=backfill-by-digest", async () => {
    // canon_query 返回匹配 digest 的旧边
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return { edges: [{ id: "old1" }] }
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 4 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede_by_digest",
      request: { oldDigest: "d1", capChapter: 5, newDigest: "d2" },
    })
    expect(invokeMock).toHaveBeenCalledWith("canon_query", {
      projectId: "P",
      filter: { digest: ["d1"] },
    })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", {
      projectId: "P",
      request: {
        old_edge_ids: ["old1"],
        cap_chapter: 5,
        new_edges: [],
        caused_by: "backfill-by-digest",
      },
    })
    expect(res).toEqual({ ok: true, revision: 4 })
  })
})

describe("snapshotLegacyWriter（真实 snapshot-derived 投影写入器，DEBT-20260820-15 偿还）", () => {
  it("snapshot_fact 负载 → 写入 canon-legacy.jsonl，返回 ok", async () => {
    createDirectoryMock.mockResolvedValue(undefined)
    readFileMock.mockRejectedValue(new Error("ENOENT")) // 文件不存在→新建
    writeFileAtomicMock.mockResolvedValue(undefined)

    const res = await snapshotLegacyWriter("P", {
      kind: "snapshot_fact",
      chapterNumber: 5,
      fact: "Alice 在第三章发现了钥匙",
    })
    expect(res).toEqual({ ok: true })
    expect(createDirectoryMock).toHaveBeenCalledWith("P/.novel/canon-legacy")
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    const [path, content] = writeFileAtomicMock.mock.calls[0]!
    expect(path).toContain("canon-legacy.jsonl")
    expect(content).toContain("Alice 在第三章发现了钥匙")
    expect(content).toContain('"chapterNumber":5')
  })
  it("非 snapshot_fact 负载 → 无操作（ok:true）", async () => {
    const res = await snapshotLegacyWriter("P", {
      kind: "noop",
    })
    expect(res).toEqual({ ok: true })
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })
  it("写失败 → 返回 ok:false + error", async () => {
    createDirectoryMock.mockRejectedValue(new Error("perm denied"))
    const res = await snapshotLegacyWriter("P", {
      kind: "snapshot_fact",
      chapterNumber: 1,
      fact: "test",
    })
    expect(res).toEqual({ ok: false, error: "perm denied" })
  })
})

describe("defaultCanonDualWriteDeps（真实 fs/invoke 默认）", () => {
  it("loadPendingQueue 不存在文件 → 空队列（走默认 queueRead catch）", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"))
    const deps = defaultCanonDualWriteDeps()
    const queue = await loadPendingQueue(deps, "E:/Novel/.novel/canon-pending.jsonl")
    expect(queue).toEqual([])
  })
  it("shadowWriteCanon 失败路径经默认 deps 落盘队列（createDirectory + writeFileAtomic）", async () => {
    invokeMock.mockRejectedValue(new Error("canon boom"))
    const deps = defaultCanonDualWriteDeps()
    const report = await shadowWriteCanon(
      deps,
      "E:/Novel",
      [{ digest: "x1", legacyPayload: {}, canonPayload: episodePayload() }],
      1000,
    )
    expect(report.queued).toBe(1)
    expect(createDirectoryMock).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    const written = writeFileAtomicMock.mock.calls[0]![1]
    expect(written).toContain("x1")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// attemptDualWrite
// ──────────────────────────────────────────────────────────────────────────

describe("attemptDualWrite（并行双写 + digest 派生）", () => {
  it("预置 digest + 两侧成功 → consistent", async () => {
    const out = await attemptDualWrite(depsWith(okOutcome(), okOutcome()), "P", {
      digest: "d1",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out).toEqual({ digest: "d1", legacy: { ok: true }, canon: { ok: true }, consistent: true })
  })
  it("digest 省略 → 按 canonPayload 派生（SHA-256）", async () => {
    const out = await attemptDualWrite(depsWith(okOutcome(), okOutcome()), "P", {
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(out.consistent).toBe(true)
  })
  it("旧 view 失败 → inconsistent", async () => {
    const out = await attemptDualWrite(depsWith(failOutcome("legacy err"), okOutcome()), "P", {
      digest: "d2",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.consistent).toBe(false)
    expect(out.legacy).toEqual({ ok: false, error: "legacy err" })
  })
  it("canon 失败 → inconsistent", async () => {
    const out = await attemptDualWrite(depsWith(okOutcome(), failOutcome("canon err")), "P", {
      digest: "d3",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.consistent).toBe(false)
    expect(out.canon).toEqual({ ok: false, error: "canon err" })
  })
  it("两侧都失败 → inconsistent", async () => {
    const out = await attemptDualWrite(depsWith(failOutcome("L"), failOutcome("C")), "P", {
      digest: "d4",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.consistent).toBe(false)
  })
  it("旧 view 适配器抛错 → safeWrite 转换为 ok:false（不中断编排）", async () => {
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => {
        throw new Error("legacy threw")
      },
      writeCanon: canonWriter(okOutcome()),
      queueRead: async () => "",
      queueWrite: async () => {},
    }
    const out = await attemptDualWrite(deps, "P", {
      digest: "d5",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.legacy).toEqual({ ok: false, error: "legacy threw" })
    expect(out.consistent).toBe(false)
  })
  it("canon 适配器抛错 → safeWrite 转换为 ok:false", async () => {
    const deps: CanonDualWriteDeps = {
      writeLegacy: legacyWriter(okOutcome()),
      writeCanon: async () => {
        throw new Error("canon threw")
      },
      queueRead: async () => "",
      queueWrite: async () => {},
    }
    const out = await attemptDualWrite(deps, "P", {
      digest: "d6",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.canon).toEqual({ ok: false, error: "canon threw" })
    expect(out.consistent).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// reconcile
// ──────────────────────────────────────────────────────────────────────────

describe("reconcileCanon（单对对账）", () => {
  it("两侧成功 → consistent", () => {
    expect(reconcileCanon(okOutcome(), okOutcome())).toEqual({ consistent: true, divergences: [] })
  })
  it("旧 view 失败 → 含 legacy_write_failed", () => {
    expect(reconcileCanon(failOutcome("L"), okOutcome())).toEqual({
      consistent: false,
      divergences: ["legacy_write_failed:L"],
    })
  })
  it("canon 失败 → 含 canon_write_failed", () => {
    expect(reconcileCanon(okOutcome(), failOutcome("C"))).toEqual({
      consistent: false,
      divergences: ["canon_write_failed:C"],
    })
  })
})

describe("reconcileOutcomes（批量对账）", () => {
  it("全一致 → 空 divergences", () => {
    const r = reconcileOutcomes([
      { digest: "a", legacy: okOutcome(), canon: okOutcome(), consistent: true },
      { digest: "b", legacy: okOutcome(), canon: okOutcome(), consistent: true },
    ])
    expect(r).toEqual({ consistent: true, divergences: [] })
  })
  it("混合型 → 仅列不一致项与原因（canon / legacy / 两者）", () => {
    const r = reconcileOutcomes([
      { digest: "a", legacy: okOutcome(), canon: okOutcome(), consistent: true },
      { digest: "b", legacy: failOutcome("L"), canon: okOutcome(), consistent: false },
      { digest: "c", legacy: okOutcome(), canon: failOutcome("C"), consistent: false },
      { digest: "d", legacy: failOutcome("L"), canon: failOutcome("C"), consistent: false },
    ])
    expect(r.consistent).toBe(false)
    expect(r.divergences).toEqual([
      { digest: "b", reasons: ["legacy:L"] },
      { digest: "c", reasons: ["canon:C"] },
      { digest: "d", reasons: ["legacy:L", "canon:C"] },
    ])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 队列 IO
// ──────────────────────────────────────────────────────────────────────────

describe("loadPendingQueue（JSONL 容错解析）", () => {
  it("queueRead 抛错 → 空队列", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => {
      throw new Error("perm")
    }
    expect(await loadPendingQueue(deps, "p")).toEqual([])
  })
  it("空文本 → 空队列", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => ""
    expect(await loadPendingQueue(deps, "p")).toEqual([])
  })
  it("有效行解析；空行跳过", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => '\n  \n{"digest":"a","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}\n'
    const q = await loadPendingQueue(deps, "p")
    expect(q).toHaveLength(1)
    expect(q[0]!.digest).toBe("a")
  })
  it("畸形行跳过（容错，不阻断）", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => 'not-json\n{"digest":"a","createdAt":1,"attempts":1,"nextRetryAt":2,"legacyPayload":{},"canonPayload":{"kind":"episode","episode":{}}}'
    const q = await loadPendingQueue(deps, "p")
    expect(q).toHaveLength(1)
  })
  it("缺 digest 字段的行跳过", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => '{"createdAt":1,"attempts":1,"nextRetryAt":2}'
    expect(await loadPendingQueue(deps, "p")).toEqual([])
  })
  it("读真实 fixture 文件 → 2 条记录", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    const real = await import("node:fs/promises")
    const content = await real.readFile(
      new URL("./canon-pending.jsonl", import.meta.url),
      "utf-8",
    )
    deps.queueRead = async () => content
    const q = await loadPendingQueue(deps, "p")
    expect(q).toHaveLength(2)
    expect(q.map((r) => r.digest).sort()).toEqual(["abc123", "def456"])
  })
})

describe("savePendingQueue（JSONL 写入）", () => {
  it("空记录 → 写空串", async () => {
    const written: string[] = []
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueWrite = async (_p, c) => {
      written.push(c)
    }
    await savePendingQueue(deps, "p", [])
    expect(written).toEqual([""])
  })
  it("多记录 → 换行连接 + 末尾换行", async () => {
    const written: string[] = []
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueWrite = async (_p, c) => {
      written.push(c)
    }
    await savePendingQueue(deps, "p", [pendingRec({ digest: "a" }), pendingRec({ digest: "b" })])
    expect(written[0]).toBe(
      JSON.stringify(pendingRec({ digest: "a" })) + "\n" + JSON.stringify(pendingRec({ digest: "b" })) + "\n",
    )
  })
})

describe("mergePending（digest 幂等合并）", () => {
  it("existing 空 + incoming → 原样", () => {
    const merged = mergePending([], [pendingRec({ digest: "a" })])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.digest).toBe("a")
  })
  it("同 digest 已存在 → 保留退避调度，刷新负载 + 错误", () => {
    const existing = pendingRec({ digest: "a", attempts: 4, nextRetryAt: 9999, lastError: "old" })
    const incoming = pendingRec({ digest: "a", attempts: 1, nextRetryAt: 2000, lastError: "new", legacyPayload: { kind: "x" } })
    const merged = mergePending([existing], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ digest: "a", attempts: 4, nextRetryAt: 9999, lastError: "new", legacyPayload: { kind: "x" } })
  })
  it("新 digest → 追加，保留顺序", () => {
    const merged = mergePending([pendingRec({ digest: "a" })], [pendingRec({ digest: "b" })])
    expect(merged.map((r) => r.digest)).toEqual(["a", "b"])
  })
})

describe("buildPendingRecord / reschedule（退避调度）", () => {
  const op: CanonDualWriteOp = { digest: "d", legacyPayload: {}, canonPayload: episodePayload() }
  it("buildPendingRecord：仅 canon 失败 → 原因含 canon 不含 legacy", () => {
    const rec = buildPendingRecord({ digest: "d", legacy: okOutcome(), canon: failOutcome("C"), consistent: false }, op, 1000)
    expect(rec).toMatchObject({ digest: "d", attempts: 1, createdAt: 1000, nextRetryAt: 1000 + BACKOFF_BASE_MS, lastError: "canon:C" })
  })
  it("buildPendingRecord：仅 legacy 失败", () => {
    const rec = buildPendingRecord({ digest: "d", legacy: failOutcome("L"), canon: okOutcome(), consistent: false }, op, 500)
    expect(rec.lastError).toBe("legacy:L")
  })
  it("buildPendingRecord：两侧均失败 → 两原因以 '; ' 连接", () => {
    const rec = buildPendingRecord({ digest: "d", legacy: failOutcome("L"), canon: failOutcome("C"), consistent: false }, op, 500)
    expect(rec.lastError).toBe("legacy:L; canon:C")
  })
  it("reschedule：attempts+1，未封顶时 nextRetryAt=now+BASE*2^attempts", () => {
    const rec = pendingRec({ digest: "d", attempts: 1, nextRetryAt: 2000 })
    const r = reschedule(rec, 10000)
    expect(r.attempts).toBe(2)
    expect(r.nextRetryAt).toBe(10000 + BACKOFF_BASE_MS * BACKOFF_FACTOR)
  })
  it("reschedule：高 attempts 触发封顶", () => {
    const rec = pendingRec({ digest: "d", attempts: 50, nextRetryAt: 0 })
    const r = reschedule(rec, 10000)
    expect(r.attempts).toBe(51)
    expect(r.nextRetryAt).toBe(10000 + BACKOFF_MAX_MS)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// shadowWriteCanon
// ──────────────────────────────────────────────────────────────────────────

describe("shadowWriteCanon（影子双写编排）", () => {
  it("全部成功 → 不入队，written=ops.length，对账一致", async () => {
    const saved: string[] = []
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueWrite = async (_p, c) => {
      saved.push(c)
    }
    const report = await shadowWriteCanon(
      deps,
      "P",
      [
        { digest: "a", legacyPayload: {}, canonPayload: episodePayload() },
        { digest: "b", legacyPayload: {}, canonPayload: supersedePayload() },
      ],
      1000,
    )
    expect(report.written).toBe(2)
    expect(report.queued).toBe(0)
    expect(report.reconcile.consistent).toBe(true)
    expect(saved).toEqual([]) // 无失败 → 不写队列
  })
  it("空 ops → 零结果，对账一致", async () => {
    const report = await shadowWriteCanon(depsWith(okOutcome(), okOutcome()), "P", [], 1000)
    expect(report.written).toBe(0)
    expect(report.queued).toBe(0)
    expect(report.results).toEqual([])
    expect(report.reconcile.consistent).toBe(true)
  })
  it("部分失败 → 失败项并入队列持久化（digest 去重）", async () => {
    let saved = ""
    const deps: CanonDualWriteDeps = {
      writeLegacy: legacyWriter(okOutcome()),
      writeCanon: async (_p, c) => (c.kind === "episode" ? okOutcome() : failOutcome("canon boom")),
      queueRead: async () =>
        // 既有队列已含同 digest "a" → 合并保留既有退避
        JSON.stringify(pendingRec({ digest: "a", attempts: 3, nextRetryAt: 999 })) + "\n",
      queueWrite: async (_p, c) => {
        saved = c
      },
    }
    const report = await shadowWriteCanon(
      deps,
      "P",
      [
        { digest: "a", legacyPayload: {}, canonPayload: supersedePayload() }, // canon 失败 → 入队
        { digest: "b", legacyPayload: {}, canonPayload: episodePayload() }, // 成功 → 不入队
      ],
      1000,
    )
    expect(report.written).toBe(1)
    expect(report.queued).toBe(1)
    expect(report.reconcile.divergences).toEqual([{ digest: "a", reasons: ["canon:canon boom"] }])
    // 合并后 "a" 保留既有 attempts=3 / nextRetryAt=999（"b" 成功不进队列）
    const lines = saved.split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    const a = JSON.parse(lines.find((l) => l.includes("\"a\""))!)
    expect(a.attempts).toBe(3)
    expect(a.nextRetryAt).toBe(999)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// replayPendingQueue
// ──────────────────────────────────────────────────────────────────────────

describe("replayPendingQueue（按序重放）", () => {
  it("空队列 → 全 0", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    const r = await replayPendingQueue(deps, "P", 1000)
    expect(r).toEqual({ total: 0, succeeded: 0, rescheduled: 0, skipped: 0, remaining: 0 })
  })
  it("未到期项 → 跳过保留；到期成功项 → 出队；到期失败项 → 重新退避保留", async () => {
    const saved: string[] = []
    const deps: CanonDualWriteDeps = {
      writeLegacy: legacyWriter(okOutcome()),
      // 按 episode.digest 区分：ok1 成功，其余失败
      writeCanon: async (_p, c) =>
        c.kind === "episode" && (c.episode as Record<string, unknown>).digest === "ok1"
          ? okOutcome()
          : failOutcome("still failing"),
      queueRead: async () =>
        [
          epRec("ok1", 500), // 到期，应成功出队
          epRec("bad1", 500), // 到期，应失败重排
          epRec("late", 9999), // 未到期，跳过
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      queueWrite: async (_p, c) => {
        saved.push(c)
      },
    }
    const r = await replayPendingQueue(deps, "P", 1000)
    expect(r).toEqual({ total: 3, succeeded: 1, rescheduled: 1, skipped: 1, remaining: 2 })
    // 剩余 = bad1（重排）+ late（未到期），保序
    const lines = saved[0]!.split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).digest).toBe("bad1")
    expect(JSON.parse(lines[0]!).attempts).toBe(2)
    expect(JSON.parse(lines[1]!).digest).toBe("late")
  })
  it("全部到期成功 → 清空队列", async () => {
    const saved: string[] = []
    const deps: CanonDualWriteDeps = {
      writeLegacy: legacyWriter(okOutcome()),
      writeCanon: canonWriter(okOutcome()),
      queueRead: async () =>
        [pendingRec({ digest: "a", nextRetryAt: 1 }), pendingRec({ digest: "b", nextRetryAt: 1 })]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      queueWrite: async (_p, c) => {
        saved.push(c)
      },
    }
    const r = await replayPendingQueue(deps, "P", 1000)
    expect(r).toEqual({ total: 2, succeeded: 2, rescheduled: 0, skipped: 0, remaining: 0 })
    expect(saved[0]).toBe("")
  })
  it("全部到期失败 → 全部重新退避保留", async () => {
    const saved: string[] = []
    const deps: CanonDualWriteDeps = {
      writeLegacy: legacyWriter(okOutcome()),
      writeCanon: canonWriter(failOutcome("boom")),
      queueRead: async () =>
        [pendingRec({ digest: "a", nextRetryAt: 1, attempts: 2 }), pendingRec({ digest: "b", nextRetryAt: 1, attempts: 2 })]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      queueWrite: async (_p, c) => {
        saved.push(c)
      },
    }
    const r = await replayPendingQueue(deps, "P", 1000)
    expect(r).toEqual({ total: 2, succeeded: 0, rescheduled: 2, skipped: 0, remaining: 2 })
    const lines = saved[0]!.split("\n").filter(Boolean)
    expect(JSON.parse(lines[0]!).attempts).toBe(3)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// retireAfterT5（T+5 退役检查）
// ──────────────────────────────────────────────────────────────────────────

describe("retireAfterT5（ADR-26 退役判定）", () => {
  it("T18 未过（t18PassedAt=null）→ 维持双写对账态（false）", () => {
    expect(retireAfterT5({ t18PassedAt: null, baselineChapter: 10, currentChapter: 20 })).toBe(false)
  })
  it("T18 已过但当前章未达 T+5 → false", () => {
    expect(retireAfterT5({ t18PassedAt: 1, baselineChapter: 10, currentChapter: 14 })).toBe(false)
  })
  it("T18 已过且当前章达 T+5 → true", () => {
    expect(retireAfterT5({ t18PassedAt: 1, baselineChapter: 10, currentChapter: 15 })).toBe(true)
  })
  it("自定义 tPlusChapters", () => {
    const st = { t18PassedAt: 1, baselineChapter: 10, currentChapter: 13, tPlusChapters: 3 }
    expect(retireAfterT5(st)).toBe(true)
    expect(retireAfterT5({ ...st, currentChapter: 12 })).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 分支补全（?? 兜底 / 非 Error 抛错 / content 派生 digest）
// ──────────────────────────────────────────────────────────────────────────

describe("branch completeness（兜底分支覆盖）", () => {
  it("reconcileCanon：失败但 error 缺省 → ?? 'unknown' 兜底", () => {
    expect(reconcileCanon({ ok: false }, okOutcome())).toEqual({
      consistent: false,
      divergences: ["legacy_write_failed:unknown"],
    })
    expect(reconcileCanon(okOutcome(), { ok: false })).toEqual({
      consistent: false,
      divergences: ["canon_write_failed:unknown"],
    })
  })
  it("reconcileOutcomes：不一致项 error 缺省 → ?? 'unknown' 兜底", () => {
    const r = reconcileOutcomes([
      { digest: "x", legacy: { ok: false }, canon: { ok: false }, consistent: false },
    ])
    expect(r.divergences).toEqual([{ digest: "x", reasons: ["legacy:unknown", "canon:unknown"] }])
  })
  it("buildPendingRecord：失败但 error 缺省 → ?? 'unknown' 兜底", () => {
    const op2: CanonDualWriteOp = { digest: "d", legacyPayload: {}, canonPayload: episodePayload() }
    const rec = buildPendingRecord({ digest: "d", legacy: { ok: false }, canon: { ok: false }, consistent: false }, op2, 500)
    expect(rec.lastError).toBe("legacy:unknown; canon:unknown")
  })
  it("attemptDualWrite：适配器抛非 Error → safeWrite 经 String(err) 兜底", async () => {
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => {
        throw "legacy string boom"
      },
      writeCanon: canonWriter(okOutcome()),
      queueRead: async () => "",
      queueWrite: async () => {},
    }
    const out = await attemptDualWrite(deps, "P", {
      digest: "d7",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.legacy).toEqual({ ok: false, error: "legacy string boom" })
  })
  it("attemptDualWrite：digest 省略且提供 content → 按 content 派生 digest（?? 左分支）", async () => {
    const out = await attemptDualWrite(depsWith(okOutcome(), okOutcome()), "P", {
      content: "canonical-content-v1",
      legacyPayload: {},
      canonPayload: episodePayload(),
    })
    expect(out.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(out.consistent).toBe(true)
  })
})
