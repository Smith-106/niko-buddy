/**
 * canon-dual-write.spec.ts — T15 影子双写编排收敛测试（目标覆盖率 100%）。
 *
 * 覆盖：双写并行 + 对账 + 持久待写队列（digest 幂等 + 退避封顶）+ 按序重放 + T+5 退役。
 * 不依赖 Tauri 运行时：mock `@tauri-apps/api/core` 与 `@/commands/fs`。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import * as promotionBridge from "./promotion-bridge"
import {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  canonPendingQueuePath,
  computeBackoffMs,
  parentDir,
  canonStoreWriter,
  snapshotLegacyBatchWriter,
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
  getCanonRevision,
  warmCanonCacheFromRevision,
  shadowWriteCanon,
  replayPendingQueue,
  retireAfterT5,
  loadDivergenceTrace,
  resolvePreWriteGateMode,
  type CanonCanonPayload,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonPendingRecord,
  type WriteOutcome,
} from "./canon-dual-write"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      createDirectory: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      writeFileAtomic: vi.fn(async () => {}),
    
  }
})

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
  it("M2-03：readFile 报非缺失权限错误（EACCES）→ fail-closed 返回 ok:false 且不覆写旧文件", async () => {
    createDirectoryMock.mockResolvedValue(undefined)
    readFileMock.mockRejectedValue(new Error("EACCES: permission denied"))
    const res = await snapshotLegacyWriter("P", {
      kind: "snapshot_fact",
      chapterNumber: 2,
      fact: "should not truncate",
    })
    expect(res).toEqual({ ok: false, error: "EACCES: permission denied" })
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })
  it("M2-03：并发写入受 canon-legacy 锁保护，两行均保留不丢写", async () => {
    let legacyContent: string | null = null
    let releaseFirstRead!: () => void
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    let readCount = 0
    readFileMock.mockImplementation(async () => {
      readCount += 1
      if (readCount === 1) {
        await firstReadGate
      }
      if (legacyContent === null) throw new Error("ENOENT: missing")
      return legacyContent
    })
    writeFileAtomicMock.mockImplementation(async (_p: string, content: string) => {
      legacyContent = content
    })

    const p1 = snapshotLegacyWriter("P-lock", { kind: "snapshot_fact", chapterNumber: 1, fact: "fact-1" })
    const p2 = snapshotLegacyWriter("P-lock", { kind: "snapshot_fact", chapterNumber: 2, fact: "fact-2" })
    releaseFirstRead()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
    const lines = (legacyContent ?? "").split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("fact-1")
    expect(lines[1]).toContain("fact-2")
  })
})

describe("v2.35: snapshotLegacyBatchWriter 与定向写前门查询（消除 O(N^2) 与全表扫描）", () => {
  it("shadowWriteCanon 使用 defaultCanonDualWriteDeps()：N 条 snapshot_fact + 若干非 snapshot_fact 仅执行 1 次 readFile 与 1 次 writeFileAtomic", async () => {
    const legacyPath = "E:/Novel/.novel/canon-legacy/canon-legacy.jsonl"
    let legacyDisk = ""
    readFileMock.mockImplementation(async (p: string) => {
      if (p === legacyPath) {
        if (!legacyDisk) throw new Error("ENOENT: missing")
        return legacyDisk
      }
      throw new Error("ENOENT: missing")
    })
    writeFileAtomicMock.mockImplementation(async (p: string, content: string) => {
      if (p === legacyPath) legacyDisk = content
    })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_ingest_episode") return { inserted: true, max_revision: 1 }
      if (cmd === "canon_query") return { edges: [], max_revision: 1 }
      if (cmd === "canon_supersede_edges") return { result: { capped: 0, inserted: 1 }, max_revision: 2 }
      return {}
    })

    const ops: CanonDualWriteOp[] = [
      { digest: "ep-1", legacyPayload: { kind: "snapshot_fact", chapterNumber: 3, fact: "林澈：佩剑名为黑剑" }, canonPayload: episodePayload() },
      { digest: "ep-2", legacyPayload: { kind: "snapshot_fact", chapterNumber: 3, fact: "林澈位于临冬镇" }, canonPayload: episodePayload() },
      { digest: "ep-3", legacyPayload: { kind: "snapshot_fact", chapterNumber: 3, fact: "码头设防" }, canonPayload: episodePayload() },
      {
        digest: "wf-1",
        legacyPayload: { kind: "snapshot_world_fact", chapterNumber: 3, fact: "林澈：佩剑名为黑剑", subject: "林澈", predicate: "佩剑", object: "黑剑" },
        canonPayload: {
          kind: "supersede",
          request: {
            old_edge_ids: [],
            cap_chapter: 3,
            new_edges: [{ id: "e1", source_id: "林澈", target_id: "黑剑", predicate: "佩剑", edge_kind: "world_fact", valid_at: 3 }],
          },
        },
      },
      {
        digest: "mod-1",
        legacyPayload: { kind: "snapshot_modality_fact", chapterNumber: 3, modality: "belief", subject: "林晚", predicate: "认为", object: "沈舟是凶手" },
        canonPayload: {
          kind: "supersede",
          request: {
            old_edge_ids: [],
            cap_chapter: 3,
            new_edges: [{ id: "e2", source_id: "林晚", target_id: "沈舟是凶手", predicate: "认为", edge_kind: "world_fact", valid_at: 3, modality: "belief" }],
          },
        },
      },
    ]

    const report = await shadowWriteCanon(defaultCanonDualWriteDeps(), "E:/Novel", ops, 1000)
    expect(report.written).toBe(5)
    expect(report.queued).toBe(0)

    const legacyReads = readFileMock.mock.calls.filter((c) => c[0] === legacyPath)
    const legacyWrites = writeFileAtomicMock.mock.calls.filter((c) => c[0] === legacyPath)
    expect(legacyReads).toHaveLength(1)
    expect(legacyWrites).toHaveLength(1)

    const writtenLines = legacyDisk.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { chapterNumber: number; fact: string })
    expect(writtenLines).toHaveLength(3)
    expect(writtenLines.map((l) => l.fact)).toEqual(["林澈：佩剑名为黑剑", "林澈位于临冬镇", "码头设防"])
  })

  it("纯非 snapshot_fact 批次（snapshot_world_fact / snapshot_modality_fact）→ 0 次 legacy 磁盘 IO", async () => {
    const outcomes = await snapshotLegacyBatchWriter("E:/Novel", [
      { kind: "snapshot_world_fact", chapterNumber: 1, fact: "a" },
      { kind: "snapshot_modality_fact", chapterNumber: 1, modality: "belief", subject: "x", predicate: "p", object: "y" },
    ])
    expect(outcomes).toEqual([{ ok: true }, { ok: true }])
    expect(createDirectoryMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })

  it("snapshotLegacyBatchWriter 遇 EACCES fail-closed：不覆写旧文件，仅对 snapshot_fact 返回失败", async () => {
    createDirectoryMock.mockResolvedValue(undefined)
    readFileMock.mockRejectedValue(new Error("EACCES: permission denied"))
    const outcomes = await snapshotLegacyBatchWriter("E:/Novel", [
      { kind: "snapshot_fact", chapterNumber: 2, fact: "fact-a" },
      { kind: "snapshot_world_fact", chapterNumber: 2, fact: "fact-a" },
      { kind: "snapshot_fact", chapterNumber: 2, fact: "fact-b" },
    ])
    expect(outcomes).toEqual([
      { ok: false, error: "EACCES: permission denied" },
      { ok: true },
      { ok: false, error: "EACCES: permission denied" },
    ])
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })

  it("replayPendingQueue Phase B 多条到期记录走 writeLegacyBatch 单次批写", async () => {
    const legacyPath = "E:/Novel/.novel/canon-legacy/canon-legacy.jsonl"
    const queuePath = "E:/Novel/.novel/canon-pending.jsonl"
    const disk = new Map<string, string>()
    disk.set(
      queuePath,
      [
        pendingRec({ digest: "r1", nextRetryAt: 1, legacyPayload: { kind: "snapshot_fact", chapterNumber: 4, fact: "f1" } }),
        pendingRec({ digest: "r2", nextRetryAt: 1, legacyPayload: { kind: "snapshot_fact", chapterNumber: 4, fact: "f2" } }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    )
    readFileMock.mockImplementation(async (p: string) => {
      const content = disk.get(p)
      if (content === undefined) throw new Error("ENOENT: missing")
      return content
    })
    writeFileAtomicMock.mockImplementation(async (p: string, content: string) => {
      disk.set(p, content)
    })
    invokeMock.mockResolvedValue({ inserted: true, max_revision: 5 })

    const report = await replayPendingQueue(defaultCanonDualWriteDeps(), "E:/Novel", 1000)
    expect(report).toEqual({ total: 2, succeeded: 2, rescheduled: 0, skipped: 0, remaining: 0 })
    expect(readFileMock.mock.calls.filter((c) => c[0] === legacyPath)).toHaveLength(1)
    expect(writeFileAtomicMock.mock.calls.filter((c) => c[0] === legacyPath)).toHaveLength(1)
    const lines = (disk.get(legacyPath) ?? "").split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)
  })
})

describe("defaultCanonDualWriteDeps（真实 fs/invoke 默认）", () => {
  it("loadPendingQueue 不存在文件 → 空队列（走默认 queueRead catch）", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"))
    const deps = defaultCanonDualWriteDeps()
    const queue = await loadPendingQueue(deps, "E:/Novel/.novel/canon-pending.jsonl")
    expect(queue).toEqual([])
  })
  it("loadPendingQueue 非缺失错误（EACCES）→ fail-closed 原样 rethrow", async () => {
    readFileMock.mockRejectedValue(new Error("EACCES: permission denied"))
    const deps = defaultCanonDualWriteDeps()
    await expect(loadPendingQueue(deps, "E:/Novel/.novel/canon-pending.jsonl")).rejects.toThrow("EACCES")
  })
  it("shadowWriteCanon 失败路径经默认 deps 落盘队列（createDirectory + writeFileAtomic）", async () => {
    const files = new Map<string, string>()
    readFileMock.mockImplementation(async (p: string) => files.get(p) ?? "")
    writeFileAtomicMock.mockImplementation(async (p: string, content: string) => {
      files.set(p, content)
    })
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
    // 54 ⑤: 写后对账重放会再次写队列 (重放失败重新退避保留)——2 次写入
    expect(writeFileAtomicMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const written = writeFileAtomicMock.mock.calls[0]![1]
    expect(written).toContain("x1")
    expect(writeFileAtomicMock.mock.calls[1]![1]).toContain('"attempts":2')
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
  it("queueRead 抛非缺失错误（如 perm）→ fail-closed 原样 rethrow", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => {
      throw new Error("perm")
    }
    await expect(loadPendingQueue(deps, "p")).rejects.toThrow("perm")
  })
  it("queueRead 抛 ENOENT → 视为空队列返回 []", async () => {
    const deps = depsWith(okOutcome(), okOutcome())
    deps.queueRead = async () => {
      throw new Error("ENOENT: no such file")
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
        // 既有队列已含同 digest "a" → 合并保留既有退避 (payload 与本次 supersede 操作一致,
        // 重放时仍失败 → 重新退避保留)
        JSON.stringify(pendingRec({ digest: "a", attempts: 3, nextRetryAt: 999, canonPayload: supersedePayload() })) + "\n",
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
    // 合并后 "a" 保留既有退避 (attempts=3→重放失败→4, nextRetryAt 重新退避); "b" 成功不进队列
    const lines = saved.split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    const a = JSON.parse(lines.find((l) => l.includes("\"a\""))!)
    expect(a.attempts).toBe(4)
    expect(a.nextRetryAt).toBeGreaterThan(1000)
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

describe("loadDivergenceTrace（55 W2-2 读路径 invoke 契约）", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("invoke 名与参数契约: canon_load_divergence_trace + projectId (防空转: 命令名写错即红)", async () => {
    vi.mocked(invoke).mockResolvedValue("{\"consistent\":false}")
    const out = await loadDivergenceTrace("E:/Novel")
    expect(invoke).toHaveBeenCalledWith("canon_load_divergence_trace", { projectId: "E:/Novel" })
    expect(out).toBe("{\"consistent\":false}")
  })

  it("失败 → 返回空串 (non-fatal, 与 save 对称)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("invoke failed"))
    const out = await loadDivergenceTrace("E:/Novel")
    expect(out).toBe("")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B8: preWriteGateMode 真实配置读取（修复「唯一调用点写死 warn, BLOCK 不可达」）
// ──────────────────────────────────────────────────────────────────────────

describe("53 P1-2 / B8: preWriteGateMode 真实配置读取（BLOCK 分支可达可测）", () => {
  const contradictEdges = {
    edges: [{ id: "e1", source_id: "A", target_id: "C", predicate: "capital_of", valid_at: 1 }],
  }
  const conflictingPayload: CanonCanonPayload = {
    kind: "supersede",
    request: {
      old_edge_ids: [],
      cap_chapter: 5,
      new_edges: [{ id: "n1", source_id: "A", target_id: "B", predicate: "capital_of", valid_at: 2 }],
    },
  }

  beforeEach(() => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" })
  })
  afterEach(() => {
    // 还原默认：本文件后续/复跑断言不允许被本 describe 的 block 态污染
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" })
  })

  it("resolvePreWriteGateMode 读真实 store: 默认与非法值一律回退 warn (不误开拦截)", () => {
    expect(resolvePreWriteGateMode()).toBe("warn")
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: undefined })
    expect(resolvePreWriteGateMode()).toBe("warn")
  })

  it("配置为 block → resolvePreWriteGateMode 返回 block", () => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    expect(resolvePreWriteGateMode()).toBe("block")
  })

  it("配置为 block 时 canonStoreWriter 返回 BLOCK 硬拦 (不再 invoke 写入, 分支可达)", async () => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return contradictEdges
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 9 }
      return {}
    })
    const res = await canonStoreWriter("P", conflictingPayload)
    expect(res.ok).toBe(false)
    expect(res.gate).toBe("pre_write_block")
    expect(res.error).toContain("L1 硬冲突")
    // 硬拦 = 冲突写不落地（canon_query 允许, 写入 invoke 必须缺席）
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("模式可逆: 同一冲突在 warn 下继续写 (对照证明差异只来自配置开关)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return contradictEdges
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 9 }
      return {}
    })
    const res = await canonStoreWriter("P", conflictingPayload)
    expect(res).toEqual({ ok: true, revision: 9, gate: "pre_write_warn" })
  })
})


describe("W1 补强：canon revision 预热（getCanonRevision / warmCanonCacheFromRevision）", () => {
  it("invoke 返回 max_revision → 透出；失败 → 0（新库/不可用）", async () => {
    invokeMock.mockResolvedValue({ max_revision: 7 })
    await expect(getCanonRevision("P")).resolves.toBe(7)
    expect(invokeMock).toHaveBeenCalledWith("canon_get_revision", { projectId: "P" })
    invokeMock.mockRejectedValue(new Error("db down"))
    await expect(getCanonRevision("P")).resolves.toBe(0)
  })

  it("warm：rev>0 回调预热；rev=0 不回调（零写入记录）", async () => {
    invokeMock.mockResolvedValue({ max_revision: 5 })
    const cb = vi.fn()
    await warmCanonCacheFromRevision("P", cb)
    expect(cb).toHaveBeenCalledWith(5)
    invokeMock.mockRejectedValue(new Error("db down"))
    const cb2 = vi.fn()
    await warmCanonCacheFromRevision("P", cb2)
    expect(cb2).not.toHaveBeenCalled()
  })
})

describe("W1 补强：resolvePreWriteGateMode store 异常回退", () => {
  it("getState 抛错 → fail-safe 回退 warn（不阻断写可用性）", () => {
    const spy = vi.spyOn(useWikiStore, "getState").mockImplementationOnce(() => {
      throw new Error("store down")
    })
    try {
      expect(resolvePreWriteGateMode()).toBe("warn")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("W1 补强：canonStoreWriter 剩余 IPC 分支", () => {
  it("写前 gate 拉取失败 → 降级空边继续写（queryAllEdges catch）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") throw new Error("query down")
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 3 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [{ id: "n1", source_id: "A", target_id: "B", predicate: "p", valid_at: 1 }],
      },
    })
    expect(res).toEqual({ ok: true, revision: 3 })
  })

  it("digest 重复且区间重叠 → DUPLICATE 幂等跳过（不写库）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") {
        return {
          edges: [
            { id: "e1", source_id: "A", target_id: "B", predicate: "p", digest: "dup1", valid_at: 1, invalid_at: null },
          ],
        }
      }
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 9 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [{ id: "n1", source_id: "A", target_id: "B", predicate: "p", digest: "dup1", valid_at: 2, invalid_at: null }],
      },
    })
    expect(res).toEqual({ ok: true, gate: "pre_write_duplicate" })
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("supersede_by_digest 无匹配旧边 → 幂等跳过 ok:true", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return { edges: [] }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede_by_digest",
      request: { oldDigest: "d1", capChapter: 5, newDigest: "d2" },
    })
    expect(res).toEqual({ ok: true })
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("未知 kind 兜底：直接下发 request → supersede", async () => {
    invokeMock.mockResolvedValue({ result: {}, max_revision: 6 })
    const res = await canonStoreWriter("P", {
      request: { old_edge_ids: [], cap_chapter: 1 },
    } as unknown as CanonCanonPayload)
    expect(res).toEqual({ ok: true, revision: 6 })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", {
      projectId: "P",
      request: { old_edge_ids: [], cap_chapter: 1 },
    })
  })
})

describe("W1 补强：shadowWriteCanon promoteChannel 晋升接线", () => {
  it("一致 episode 逐个晋升：有效章晋升、无 entity_id 回填、非法章跳过、非 episode 跳过", async () => {
    const promoteSpy = vi
      .spyOn(promotionBridge, "promote")
      .mockResolvedValue({ record: {} as never, replayed: false })
    try {
      const report = await shadowWriteCanon(
        depsWith(okOutcome(), okOutcome()),
        "P",
        [
          {
            digest: "ok1",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 3, entity_id: "ch3", id: "e" } },
          },
          {
            digest: "ok2",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 4, id: "e4" } },
          },
          {
            digest: "bad",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 0, entity_id: "z" } },
          },
          { digest: "sup", legacyPayload: {}, canonPayload: supersedePayload() },
        ],
        1000,
        "canon-dual-write",
      )
      expect(report.written).toBe(4)
      expect(report.reconcile.consistent).toBe(true)
      expect(promoteSpy).toHaveBeenCalledTimes(2)
      expect(promoteSpy.mock.calls[0]![0]).toMatchObject({
        channel: "canon-dual-write",
        projectPath: "P",
        chapterId: "ch3",
        chapterNumber: 3,
        revision: 1,
      })
      expect(promoteSpy.mock.calls[1]![0]).toMatchObject({ chapterId: "ch4", chapterNumber: 4 })
    } finally {
      promoteSpy.mockRestore()
    }
  })

  it("promote 抛错 → warn 吞错，双写报告仍一致", async () => {
    const promoteSpy = vi.spyOn(promotionBridge, "promote").mockRejectedValueOnce(new Error("promo down"))
    try {
      const report = await shadowWriteCanon(
        depsWith(okOutcome(), okOutcome()),
        "P",
        [{ digest: "ok1", legacyPayload: {}, canonPayload: episodePayload() }],
        1000,
        "canon-dual-write",
      )
      expect(report.written).toBe(1)
      expect(report.reconcile.consistent).toBe(true)
      expect(promoteSpy).toHaveBeenCalledTimes(1)
    } finally {
      promoteSpy.mockRestore()
    }
  })
})

describe("M2-03 并发队列合并、即时重放一次自愈与 in-flight 去重", () => {
  it("shadowWriteCanon 瞬态故障：首次失败入队后同 now 经 twoPhaseReconcile 立即重放自愈并清空队列", async () => {
    let queueContents = ""
    let canonCalls = 0
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => {
        canonCalls += 1
        return canonCalls === 1 ? failOutcome("transient-net") : okOutcome()
      },
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const report = await shadowWriteCanon(
      deps,
      "P-imm",
      [{ digest: "imm-a", legacyPayload: { kind: "noop" }, canonPayload: episodePayload() }],
      1000,
    )
    expect(canonCalls).toBe(2)
    expect(report.queued).toBe(1)
    expect(report.reconcile.consistent).toBe(true)
    expect(report.reconcile.divergences).toEqual([])
    expect(queueContents).toBe("")
  })

  it("replayPendingQueue immediateDigests 仅豁免 attempts<=1，attempts>=2 未到期时严格退避跳过", async () => {
    let queueContents = [
      epRec("a1", 9999, 1),
      epRec("a2", 9999, 2),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n"
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => okOutcome(),
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const r = await replayPendingQueue(deps, "P-imm-cap", 1000, {
      immediateDigests: new Set(["a1", "a2"]),
    })
    expect(r).toEqual({ total: 2, succeeded: 1, rescheduled: 0, skipped: 1, remaining: 1 })
    expect(queueContents).toContain('"a2"')
    expect(queueContents).not.toContain('"a1"')
  })

  it("并发队列合并（新 digest）：replay Phase B 期间并发 shadowWriteCanon 写入新 digest 不丢失", async () => {
    let queueContents = JSON.stringify(epRec("a", 500, 1)) + "\n"
    let releaseReplayA!: () => void
    const replayAGate = new Promise<void>((resolve) => {
      releaseReplayA = resolve
    })
    let replayAEntered!: () => void
    const replayAStarted = new Promise<void>((resolve) => {
      replayAEntered = resolve
    })

    const replayDeps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => {
        replayAEntered()
        await replayAGate
        return okOutcome()
      },
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const concurrentWriteDeps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => failOutcome("b-down"),
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const replayPromise = replayPendingQueue(replayDeps, "P-conc-new", 1000)
    await replayAStarted

    // 在 Phase B 锁外执行期间，并发 shadowWriteCanon 写入新 digest "b"
    await shadowWriteCanon(
      concurrentWriteDeps,
      "P-conc-new",
      [{ digest: "b", legacyPayload: { tag: "b" }, canonPayload: episodePayload() }],
      1000,
    )
    expect(queueContents).toContain('"b"')

    releaseReplayA()
    const report = await replayPromise
    expect(report).toEqual({ total: 1, succeeded: 1, rescheduled: 0, skipped: 0, remaining: 1 })
    const remaining = await loadPendingQueue(concurrentWriteDeps, "p")
    expect(remaining.map((r) => r.digest)).toEqual(["b"])
  })

  it("并发队列合并（同 digest 新 payload 覆写）：replay Phase B 成功也不删除已被覆写的新 payload", async () => {
    const oldRec = pendingRec({
      digest: "same",
      nextRetryAt: 500,
      attempts: 1,
      legacyPayload: { version: 1 },
      canonPayload: episodePayload(),
    })
    let queueContents = JSON.stringify(oldRec) + "\n"
    let releaseReplay!: () => void
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })

    const replayDeps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => {
        entered()
        await replayGate
        return okOutcome()
      },
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const overwriteDeps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => failOutcome("v2-down"),
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const replayPromise = replayPendingQueue(replayDeps, "P-conc-overwrite", 1000)
    await started

    // 并发以同 digest 写入更新的 payload（version: 2）
    await shadowWriteCanon(
      overwriteDeps,
      "P-conc-overwrite",
      [{ digest: "same", legacyPayload: { version: 2 }, canonPayload: supersedePayload() }],
      1000,
    )

    releaseReplay()
    const report = await replayPromise
    expect(report.succeeded).toBe(1)
    expect(report.remaining).toBe(1)
    const remaining = await loadPendingQueue(overwriteDeps, "p")
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.legacyPayload).toEqual({ version: 2 })
    expect(remaining[0]!.canonPayload.kind).toBe("supersede")
  })

  it("并发 replayPendingQueue 去重：in-flight 中的 digest 仅被执行 1 次，第二个调用跳过", async () => {
    let queueContents = JSON.stringify(epRec("dup", 500, 1)) + "\n"
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let writeCanonCalls = 0
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => {
        writeCanonCalls += 1
        entered()
        await gate
        return okOutcome()
      },
      queueRead: async () => queueContents,
      queueWrite: async (_p, c) => {
        queueContents = c
      },
    }

    const r1Promise = replayPendingQueue(deps, "P-inflight", 1000)
    await started
    const r2 = await replayPendingQueue(deps, "P-inflight", 1000)
    expect(r2).toEqual({ total: 1, succeeded: 0, rescheduled: 0, skipped: 1, remaining: 1 })

    release()
    const r1 = await r1Promise
    expect(r1).toEqual({ total: 1, succeeded: 1, rescheduled: 0, skipped: 0, remaining: 0 })
    expect(writeCanonCalls).toBe(1)
    expect(queueContents).toBe("")
  })
})

describe("R2-M01 / R2-M07 写前门五项修复与 twoPhaseReconcile 自愈补齐 promote", () => {
  beforeEach(() => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" })
    invokeMock.mockReset()
  })
  afterEach(() => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" })
  })

  it("block 模式下 queryAllEdges 读错 fail-closed 返回 ok:false 且不写库", async () => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") throw new Error("lancedb read error")
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 11 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [{ id: "n1", source_id: "A", target_id: "B", predicate: "p", valid_at: 5 }],
      },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("lancedb read error")
    expect(res.gate).toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("虚拟封顶 old_edge_ids 后合法 supersede [1,5) vs [5,+∞) 不再触发 BLOCK", async () => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") {
        return {
          edges: [
            { id: "e-old", source_id: "A", target_id: "C", predicate: "capital_of", valid_at: 1, invalid_at: null },
          ],
        }
      }
      if (cmd === "canon_supersede_edges") return { result: { capped: 1, inserted: 1 }, max_revision: 12 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: ["e-old"],
        cap_chapter: 5,
        new_edges: [{ id: "n-new", source_id: "A", target_id: "B", predicate: "capital_of", valid_at: 5 }],
      },
    })
    expect(res).toEqual({ ok: true, revision: 12, gate: "pre_write_warn" })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("modality 透传：belief 新边或 belief 现存边在 block 模式下不触发 L1 硬冲突", async () => {
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") {
        return {
          edges: [
            { id: "e1", source_id: "A", target_id: "C", predicate: "capital_of", valid_at: 1, modality: "assertive" },
          ],
        }
      }
      if (cmd === "canon_supersede_edges") return { result: {}, max_revision: 13 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 2,
        new_edges: [{ id: "n-mod", source_id: "A", target_id: "B", predicate: "capital_of", valid_at: 2, modality: "belief" }],
      },
    })
    expect(res).toEqual({ ok: true, revision: 13 })
  })

  it("批内部分 DUPLICATE 仅剔除重复边，不丢其余合法新边与 old_edge_ids", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") {
        return {
          edges: [
            { id: "e-dup", source_id: "A", target_id: "B", predicate: "p", digest: "dup-hash", valid_at: 1, invalid_at: null },
          ],
        }
      }
      if (cmd === "canon_supersede_edges") return { result: { capped: 1, inserted: 1 }, max_revision: 14 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: ["e-cap"],
        cap_chapter: 5,
        new_edges: [
          { id: "n-dup", source_id: "A", target_id: "B", predicate: "p", digest: "dup-hash", valid_at: 2 },
          { id: "n-ok", source_id: "X", target_id: "Y", predicate: "q", digest: "fresh-hash", valid_at: 2 },
        ],
      },
    })
    expect(res).toEqual({ ok: true, revision: 14, gate: "pre_write_duplicate" })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", {
      projectId: "P",
      request: {
        old_edge_ids: ["e-cap"],
        cap_chapter: 5,
        new_edges: [
          { id: "n-ok", source_id: "X", target_id: "Y", predicate: "q", digest: "fresh-hash", valid_at: 2 },
        ],
      },
    })
  })

  it("全批 DUPLICATE 但 old_edge_ids 非空时仍下发封顶请求（new_edges=[]）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") {
        return {
          edges: [
            { id: "e-dup", source_id: "A", target_id: "B", predicate: "p", digest: "dup-hash", valid_at: 1, invalid_at: null },
          ],
        }
      }
      if (cmd === "canon_supersede_edges") return { result: { capped: 1, inserted: 0 }, max_revision: 15 }
      return {}
    })
    const res = await canonStoreWriter("P", {
      kind: "supersede",
      request: {
        old_edge_ids: ["e-cap"],
        cap_chapter: 5,
        new_edges: [
          { id: "n-dup", source_id: "A", target_id: "B", predicate: "p", digest: "dup-hash", valid_at: 2 },
        ],
      },
    })
    expect(res).toEqual({ ok: true, revision: 15, gate: "pre_write_duplicate" })
    expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", {
      projectId: "P",
      request: {
        old_edge_ids: ["e-cap"],
        cap_chapter: 5,
        new_edges: [],
      },
    })
  })

  it("shadowWriteCanon 禁止将 gate === 'pre_write_block' 写入 .novel/canon-pending.jsonl", async () => {
    let queueContents = ""
    const queueWrite = vi.fn(async (_p: string, c: string) => {
      queueContents = c
    })
    const deps: CanonDualWriteDeps = {
      writeLegacy: async () => okOutcome(),
      writeCanon: async () => ({
        ok: false,
        gate: "pre_write_block",
        error: "写前一致性门控拦截（L1 硬冲突）",
      }),
      queueRead: async () => queueContents,
      queueWrite,
    }
    const report = await shadowWriteCanon(
      deps,
      "P-block-no-queue",
      [{ digest: "blk-1", legacyPayload: {}, canonPayload: supersedePayload() }],
      1000,
    )
    expect(report.queued).toBe(0)
    expect(report.reconcile.consistent).toBe(false)
    expect(queueContents).toBe("")
    expect(queueWrite).not.toHaveBeenCalled()
  })

  it("R2-M07 twoPhaseReconcile 自愈成功后对 replayedDigests 补齐 promote", async () => {
    const promoteSpy = vi
      .spyOn(promotionBridge, "promote")
      .mockResolvedValue({ record: {} as never, replayed: false })
    try {
      let queueContents = ""
      let canonCalls = 0
      const deps: CanonDualWriteDeps = {
        writeLegacy: async () => okOutcome(),
        writeCanon: async () => {
          canonCalls += 1
          return canonCalls === 1 ? failOutcome("transient-boom") : okOutcome()
        },
        queueRead: async () => queueContents,
        queueWrite: async (_p, c) => {
          queueContents = c
        },
      }
      const report = await shadowWriteCanon(
        deps,
        "P-heal-promote",
        [
          {
            digest: "abcdef0123456789ffff",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 6, entity_id: "chapter-6", id: "ch6-ep-abcdef012345" } },
          },
        ],
        1000,
        "canon-dual-write",
      )
      expect(report.reconcile.consistent).toBe(true)
      expect(promoteSpy).toHaveBeenCalledTimes(1)
      expect(promoteSpy.mock.calls[0]![0]).toMatchObject({
        channel: "canon-dual-write",
        projectPath: "P-heal-promote",
        chapterId: "chapter-6",
        chapterNumber: 6,
        entity: "ch6-ep-abcdef012345",
        contentDigestPrefix: "abcdef0123456789",
      })
    } finally {
      promoteSpy.mockRestore()
    }
  })

  it("R3-M01: shadowWriteCanon 透传 snapshotRevision 并以 episode.id 作 entity 避免同章多事实 replayKey 碰撞", async () => {
    const promoteSpy = vi
      .spyOn(promotionBridge, "promote")
      .mockResolvedValue({ record: {} as never, replayed: false })
    try {
      await shadowWriteCanon(
        depsWith(okOutcome(), okOutcome()),
        "P-rev",
        [
          {
            digest: "1111111111111111aaaa",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 5, entity_id: "chapter-5", id: "ch5-ep-111111111111" } },
          },
          {
            digest: "2222222222222222bbbb",
            legacyPayload: {},
            canonPayload: { kind: "episode", episode: { chapter_number: 5, entity_id: "chapter-5", id: "ch5-ep-222222222222" } },
          },
        ],
        1000,
        "canon-dual-write",
        4,
      )
      expect(promoteSpy).toHaveBeenCalledTimes(2)
      expect(promoteSpy.mock.calls[0]![0]).toMatchObject({
        chapterId: "chapter-5",
        revision: 4,
        entity: "ch5-ep-111111111111",
      })
      expect(promoteSpy.mock.calls[1]![0]).toMatchObject({
        chapterId: "chapter-5",
        revision: 4,
        entity: "ch5-ep-222222222222",
      })
      expect(promoteSpy.mock.calls[0]![0].entity).not.toBe(promoteSpy.mock.calls[1]![0].entity)
    } finally {
      promoteSpy.mockRestore()
    }
  })

  it("v2.35: canonStoreWriter 写前门发送定向非空 CanonEdgeFilter（含 entity_ids/predicates/edge_kinds?），绝不传空数组 []", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "canon_query") return { edges: [], max_revision: 1 }
      if (cmd === "canon_supersede_edges") return { result: { capped: 0, inserted: 2 }, max_revision: 2 }
      return {}
    })

    // 1) 全部新边声明 edge_kind → filter 包含 archived:false + 去重 entity_ids + predicates + edge_kinds
    await canonStoreWriter("P-targeted", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [
          { id: "n1", source_id: "林澈", target_id: "霜刃", predicate: "佩剑", edge_kind: "world_fact", valid_at: 5 },
          { id: "n2", source_id: "林澈", target_id: "临冬镇", predicate: "位于", edge_kind: "world_fact", valid_at: 5 },
        ],
      },
    })
    expect(invokeMock).toHaveBeenCalledWith("canon_query", {
      projectId: "P-targeted",
      filter: {
        archived: false,
        entity_ids: ["林澈"],
        predicates: ["佩剑", "位于"],
        edge_kinds: ["world_fact"],
      },
    })

    // 2) 部分边未声明 edge_kind → 省略 edge_kinds（不传空数组 []）
    invokeMock.mockClear()
    await canonStoreWriter("P-mixed", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [
          { id: "n1", source_id: "A", target_id: "B", predicate: "p", edge_kind: "world_fact", valid_at: 5 },
          { id: "n2", source_id: "C", target_id: "D", predicate: "q", valid_at: 5 },
        ],
      },
    })
    const mixedFilter = invokeMock.mock.calls.find((c) => c[0] === "canon_query")![1] as {
      projectId: string
      filter: Record<string, unknown>
    }
    expect(mixedFilter).toEqual({
      projectId: "P-mixed",
      filter: {
        archived: false,
        entity_ids: ["A", "C"],
        predicates: ["p", "q"],
      },
    })
    expect("edge_kinds" in mixedFilter.filter).toBe(false)

    // 3) 极端空白 source_id / predicate → 省略该键，绝不传 [] 给 Rust CanonEdgeFilter
    invokeMock.mockClear()
    await canonStoreWriter("P-blank", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [{ id: "n1", source_id: "  ", target_id: "B", predicate: "", valid_at: 5 }],
      },
    })
    const blankFilter = invokeMock.mock.calls.find((c) => c[0] === "canon_query")![1] as {
      projectId: string
      filter: Record<string, unknown>
    }
    expect(blankFilter.filter).toEqual({ archived: false })
    for (const val of Object.values(blankFilter.filter)) {
      if (Array.isArray(val)) expect(val.length).toBeGreaterThan(0)
    }

    // 4) Finding 8：混合批次中仅一条边缺失/空白 source_id 或 predicate → 必须省略该过滤键而非欠查询
    invokeMock.mockClear()
    await canonStoreWriter("P-mixed-blank-source", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [
          { id: "n1", source_id: "林澈", target_id: "霜刃", predicate: "佩剑", edge_kind: "world_fact", valid_at: 5 },
          { id: "n2", source_id: "   ", target_id: "黑塔", predicate: "位于", edge_kind: "world_fact", valid_at: 5 },
        ],
      },
    })
    const mixedBlankSource = invokeMock.mock.calls.find((c) => c[0] === "canon_query")![1] as {
      projectId: string
      filter: Record<string, unknown>
    }
    expect(mixedBlankSource.filter).toEqual({
      archived: false,
      predicates: ["佩剑", "位于"],
      edge_kinds: ["world_fact"],
    })
    expect("entity_ids" in mixedBlankSource.filter).toBe(false)

    invokeMock.mockClear()
    await canonStoreWriter("P-mixed-blank-pred", {
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 5,
        new_edges: [
          { id: "n1", source_id: "林澈", target_id: "霜刃", predicate: "佩剑", edge_kind: "world_fact", valid_at: 5 },
          { id: "n2", source_id: "苏未晞", target_id: "黑塔", predicate: "", edge_kind: "world_fact", valid_at: 5 },
        ],
      },
    })
    const mixedBlankPred = invokeMock.mock.calls.find((c) => c[0] === "canon_query")![1] as {
      projectId: string
      filter: Record<string, unknown>
    }
    expect(mixedBlankPred.filter).toEqual({
      archived: false,
      entity_ids: ["林澈", "苏未晞"],
      edge_kinds: ["world_fact"],
    })
    expect("predicates" in mixedBlankPred.filter).toBe(false)
  })
})
