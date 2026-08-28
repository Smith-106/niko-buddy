/**
 * canon-backfill.spec.ts — T30b 历史回填收敛测试（目标覆盖率 100%）。
 *
 * 覆盖：
 *   1. 快照发现：文件名契约（NNN.snapshot.json 严格匹配；outline-/md/traversal/000 拒绝）。
 *   2. 章节范围：1..N-1 排他上界语义。
 *   3. 快照加载：规范化 + 章节号以文件名为权威 + 容错（坏 JSON/IO 抛错不中断）。
 *   4. 操作派生：与 T16 buildCanonDualWriteOps digest 契约逐字节同构（交叉验证）。
 *   5. P1-5/F-006 源感知合并评估工件：评估常量 + 分类器（skip-existing / append-new，
 *      userEditsPreserved 恒 true —— 用户手工编辑永不覆盖）。
 *   6. 编排入口：升序确定性回填、章级容错、失败入持久队列 → T15 replay 补齐、
 *      重跑幂等（store (chapter,digest) 收敛不变）、exclusiveUpperBound 生效。
 *   7. 可查询审计：T14 projectEdges 投影链 → 迁移前事实经读出口可查。
 *
 * 不依赖 Tauri 运行时：mock `@tauri-apps/api/core` 与 `@/commands/fs`；
 * canon_store 用内存 (chapter,digest) 去重 map 模拟（与 Rust ingest_episode 幂等语义一致）。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import { BACKOFF_BASE_MS, replayPendingQueue, type CanonDualWriteDeps } from "./canon-dual-write"
import { projectEdges, type CanonFact, type RawCanonEdge } from "./canon-graph-client"
import {
  SOURCE_AWARE_MERGE_EVALUATION,
  SNAPSHOTS_DIR_SEGMENT,
  auditPreMigrationFacts,
  backfillCanonHistory,
  buildBackfillOps,
  buildSupersedeOps,
  classifyBackfillMerge,
  defaultCanonBackfillDeps,
  detectSupersedeDivergences,
  filterBackfillRange,
  loadBackfillSnapshot,
  parseChapterSnapshotFileName,
  parseDiscoveredChapters,
  snapshotsDir,
  type BackfillMergeDecisionReport,
  type CanonBackfillReport,
  type SupersedeDivergence,
} from "./canon-backfill"
import * as CanonGraphClient from "./canon-graph-client"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
}))

const createDirectoryMock = vi.mocked(createDirectory)
const readFileMock = vi.mocked(readFile)
const writeFileAtomicMock = vi.mocked(writeFileAtomic)

beforeEach(() => {
  createDirectoryMock.mockReset().mockResolvedValue(undefined)
  readFileMock.mockReset().mockResolvedValue("")
  writeFileAtomicMock.mockReset().mockResolvedValue(undefined)
  vi.spyOn(CanonGraphClient, "queryEpisodesByChapter").mockReset()
})

// ──────────────────────────────────────────────────────────────────────────
// 测试基建：快照 fixture + 内存双写 harness（canon_store 幂等模拟）
// ──────────────────────────────────────────────────────────────────────────

const PROJECT = "C:/proj/demo"

function pad3(n: number): string {
  return String(n).padStart(3, "0")
}

function snapshotJson(chapter: number, facts: string[]): string {
  return JSON.stringify({
    chapterId: `chapter-${chapter}`,
    chapterNumber: chapter,
    summary: `第${chapter}章摘要`,
    characters: ["林澈"],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: facts,
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
  })
}

/** 内存 canon_store：按 (chapter_number, digest) 幂等去重（对齐 Rust ingest_episode）。 */
interface MemStore {
  rows: Map<string, { chapter_number: number; digest: string; summary: string }>
  canonFailCount: number
  /** 已封顶的边 digest（供 supersede 测试验证）。 */
  supersededDigests: string[]
}

function makeHarness(): { store: MemStore; dualWrite: CanonDualWriteDeps } {
  const store: MemStore = { rows: new Map(), canonFailCount: 0, supersededDigests: [] }
  const writeCanon: CanonDualWriteDeps["writeCanon"] = async (_pp, payload) => {
    if (store.canonFailCount > 0) {
      store.canonFailCount -= 1
      return { ok: false, error: "canon crash" }
    }
    if (payload.kind === "episode") {
      const ep = payload.episode as { chapter_number: number; digest: string; summary: string }
      const key = `${ep.chapter_number}:${ep.digest}`
      if (!store.rows.has(key)) store.rows.set(key, { ...ep })
      return { ok: true, revision: store.rows.size }
    }
    if (payload.kind === "supersede_by_digest") {
      const req = payload.request as { oldDigest: string; capChapter: number; newDigest: string }
      store.supersededDigests.push(req.oldDigest)
      return { ok: true, revision: store.rows.size }
    }
    return { ok: true }
  }
  const dualWrite: CanonDualWriteDeps = {
    writeCanon,
    writeLegacy: async () => ({ ok: true }),
    queueRead: async () => "",
    queueWrite: async () => {},
  }
  return { store, dualWrite }
}

/** 快照文件系统内存版 + 注入同一 dualWrite。 */
function makeFsDeps(
  files: Record<number, string>,
  dualWrite: CanonDualWriteDeps,
  extraEntries: { name: string }[] = [],
) {
  const entries = [
    ...Object.keys(files).map((c) => ({ name: `${pad3(Number(c))}.snapshot.json` })),
    ...extraEntries,
  ]
  return {
    listSnapshotsDir: async () => entries,
    readSnapshotText: async (p: string) => {
      const m = /(\d{3})\.snapshot\.json$/.exec(p)
      const ch = m ? Number(m[1]) : NaN
      if (!(ch in files)) throw new Error(`ENOENT: ${p}`)
      return files[ch]
    },
    dualWrite,
  }
}

/** 由内存 store 行构造 canon 边（供 T14 投影链审计）。 */
function rowToRawEdge(row: { chapter_number: number; digest: string }, i: number): RawCanonEdge {
  return {
    id: `edge-${i}`,
    source_id: `chapter-${row.chapter_number}`,
    target_id: `ent-${row.digest.slice(0, 6)}`,
    predicate: "mentions",
    edge_kind: "world_fact",
    valid_at: row.chapter_number,
    invalid_at: null,
    reference_time: row.chapter_number,
    known_by: ["reader"],
    revealed_at: row.chapter_number,
    confidence: 1,
    source_chapter: row.chapter_number,
    digest: row.digest,
    beat_label: null,
    beat_hit: null,
    foreshadow_planted_at: null,
    hook_type: null,
    payoff_chapter: null,
    archived: false,
  }
}

function factFixture(sourceChapter: number | null, archived = false): CanonFact {
  return {
    id: `edge-${sourceChapter ?? "x"}-${archived ? "a" : "v"}-${Math.random()}`,
    sourceId: "s",
    targetId: "t",
    predicate: "mentions",
    edgeKind: "world_fact",
    sourceChapter,
    archived,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. 快照发现
// ──────────────────────────────────────────────────────────────────────────

describe("snapshotsDir / parseChapterSnapshotFileName", () => {
  it("snapshotsDir 归一化反斜杠并拼接 .novel/snapshots", () => {
    expect(snapshotsDir("C:\\proj\\demo")).toBe(`C:/proj/demo/${SNAPSHOTS_DIR_SEGMENT}`)
  })

  it("正文章快照名匹配并解析章节号", () => {
    expect(parseChapterSnapshotFileName("001.snapshot.json")).toBe(1)
    expect(parseChapterSnapshotFileName("012.snapshot.json")).toBe(12)
  })

  it("outline/md/history/遍历名一律拒绝", () => {
    expect(parseChapterSnapshotFileName("outline-001.snapshot.json")).toBeNull()
    expect(parseChapterSnapshotFileName("001.snapshot.md")).toBeNull()
    expect(parseChapterSnapshotFileName("2026-08-21T10-00-00-000Z.snapshot.json")).toBeNull()
    expect(parseChapterSnapshotFileName("../001.snapshot.json")).toBeNull()
    expect(parseChapterSnapshotFileName("")).toBeNull()
  })

  it("000 与负位形不产生章节号", () => {
    expect(parseChapterSnapshotFileName("000.snapshot.json")).toBeNull()
  })
})

describe("parseDiscoveredChapters", () => {
  it("过滤目录与非快照条目，升序去重", () => {
    const chapters = parseDiscoveredChapters([
      { name: "003.snapshot.json" },
      { name: "history" },
      { name: "001.snapshot.json" },
      { name: "003.snapshot.md" },
      { name: "outline-002.snapshot.json" },
      { name: "002.snapshot.json" },
      { name: "003.snapshot.json" },
    ])
    expect(chapters).toEqual([1, 2, 3])
  })

  it("空目录 → 空集", () => {
    expect(parseDiscoveredChapters([])).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. 章节范围（第 1..N-1 章）
// ──────────────────────────────────────────────────────────────────────────

describe("filterBackfillRange", () => {
  const all = [1, 2, 3, 4, 5]

  it("无选项 → 全量保持升序", () => {
    expect(filterBackfillRange(all)).toEqual(all)
  })

  it("exclusiveUpperBound=N 只保留 < N（第 1..N-1 章语义）", () => {
    expect(filterBackfillRange(all, { exclusiveUpperBound: 4 })).toEqual([1, 2, 3])
  })

  it("firstChapter 抬高下界（含）", () => {
    expect(filterBackfillRange(all, { firstChapter: 3 })).toEqual([3, 4, 5])
  })

  it("双界联合过滤；空结果合法", () => {
    expect(filterBackfillRange(all, { firstChapter: 2, exclusiveUpperBound: 4 })).toEqual([2, 3])
    expect(filterBackfillRange(all, { firstChapter: 2, exclusiveUpperBound: 2 })).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. 快照加载
// ──────────────────────────────────────────────────────────────────────────

describe("loadBackfillSnapshot", () => {
  const deps = { readSnapshotText: async (_p: string) => "" }

  it("规范化快照并以文件名派生章节号为权威（raw 漂移被覆盖）", async () => {
    const d = {
      readSnapshotText: async () =>
        JSON.stringify({ chapterNumber: 99, newCanonFacts: ["事实A"], characters: [] }),
    }
    const snap = await loadBackfillSnapshot(d, PROJECT, 3)
    expect(snap).not.toBeNull()
    expect(snap!.chapterNumber).toBe(3)
    expect(snap!.newCanonFacts).toEqual(["事实A"])
    void deps
  })

  it("缺 raw 字段时回填 fallback chapterId/chapterNumber", async () => {
    const d = { readSnapshotText: async () => JSON.stringify({ newCanonFacts: [] }) }
    const snap = await loadBackfillSnapshot(d, PROJECT, 7)
    expect(snap!.chapterNumber).toBe(7)
    expect(snap!.chapterId).toBe("chapter-7")
  })

  it("坏 JSON → null；IO 抛错 → null；非对象 JSON → null", async () => {
    expect(await loadBackfillSnapshot({ readSnapshotText: async () => "{broken" }, PROJECT, 1)).toBeNull()
    expect(
      await loadBackfillSnapshot(
        { readSnapshotText: async () => Promise.reject(new Error("EIO")) },
        PROJECT,
        1,
      ),
    ).toBeNull()
    expect(await loadBackfillSnapshot({ readSnapshotText: async () => "[1,2]" }, PROJECT, 1)).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. 操作派生（T16 digest 契约镜像 + 交叉验证）
// ──────────────────────────────────────────────────────────────────────────

describe("buildBackfillOps", () => {
  function mkSnapshot(chapter: number, facts: string[]): Parameters<typeof buildBackfillOps>[0] {
    return {
      chapterId: `chapter-${chapter}`,
      chapterNumber: chapter,
      summary: "",
      characters: [],
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: facts,
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    }
  }

  it("逐条事实派生 episode 操作，digest 命中 SHA-256({chapter,fact})", async () => {
    const snap = mkSnapshot(2, ["林澈获得残卷", "黑塔位于北境"])
    const ops = await buildBackfillOps(snap)
    expect(ops).toHaveLength(2)

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!
      // T16 契约交叉验证：digest 与字面公式一致（实时双写与离线回填同键）
      expect(op.digest).toBe(await computeCheckpointDigestOf({ chapter: 2, fact: snap.newCanonFacts[i] }))
      expect(op.content).toEqual({ chapter: 2, fact: snap.newCanonFacts[i] })
      expect(op.legacyPayload).toEqual({
        kind: "snapshot_fact",
        chapterNumber: 2,
        fact: snap.newCanonFacts[i],
      })
      expect(op.canonPayload).toEqual({
        kind: "episode",
        episode: {
          id: `ch2-fact${i}`,
          chapter_number: 2,
          entity_id: "chapter-2",
          summary: snap.newCanonFacts[i],
          digest: op.digest,
        },
      })
    }
  })

  it("不同章节的相同事实文本 → 不同 digest（chapter 参与键）；同章重复事实 → 同 digest", async () => {
    const [opCh1] = await buildBackfillOps(mkSnapshot(1, ["同一句话"]))
    const [opCh2] = await buildBackfillOps(mkSnapshot(2, ["同一句话"]))
    const [dup1] = await buildBackfillOps(mkSnapshot(1, ["同一句话"]))
    expect(opCh1!.digest).not.toBe(opCh2!.digest)
    expect(opCh1!.digest).toBe(dup1!.digest)
  })

  it("无新事实 / 缺字段 → 空操作集", async () => {
    expect(await buildBackfillOps(mkSnapshot(1, []))).toEqual([])
    // 运行时容错分支（?? []）：历史快照可能缺失该字段，类型层以显式转换模拟
    const missingField = { ...mkSnapshot(1, []), newCanonFacts: undefined } as unknown as Parameters<
      typeof buildBackfillOps
    >[0]
    expect(await buildBackfillOps(missingField)).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5. P1-5/F-006 源感知合并硬保证 —— 设计评估工件
// ──────────────────────────────────────────────────────────────────────────

describe("SOURCE_AWARE_MERGE_EVALUATION / classifyBackfillMerge", () => {
  it("评估常量声明 P1-5/F-006 引用、仅评估不承诺实现、三机制在位、supersede 路由为 designed-not-implemented", () => {
    expect(SOURCE_AWARE_MERGE_EVALUATION.requirementRefs).toContain("P1-5")
    expect(SOURCE_AWARE_MERGE_EVALUATION.requirementRefs).toContain("F-006")
    expect(SOURCE_AWARE_MERGE_EVALUATION.evaluatedDesignOnly).toBe(true)
    expect(SOURCE_AWARE_MERGE_EVALUATION.hardGuarantee).toContain("用户手工编辑永不覆盖")
    expect(SOURCE_AWARE_MERGE_EVALUATION.mechanismsInPlace).toHaveLength(3)
    expect(SOURCE_AWARE_MERGE_EVALUATION.designedNotImplemented).toHaveLength(1)
    expect(SOURCE_AWARE_MERGE_EVALUATION.designedNotImplemented[0]).toContain("fact槽位")
  })

  it("已存在 digest → skip-existing，且 userEditsPreserved 恒 true", () => {
    const r: BackfillMergeDecisionReport = classifyBackfillMerge(new Set(["d1"]), "d1")
    expect(r.decision).toBe("skip-existing")
    expect(r.userEditsPreserved).toBe(true)
  })

  it("新 digest → append-new（旧行含用户手改变体全部保留），userEditsPreserved 恒 true", () => {
    const r = classifyBackfillMerge(new Set(["d1"]), "d2")
    expect(r.decision).toBe("append-new")
    expect(r.userEditsPreserved).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 6. 编排入口 backfillCanonHistory
// ──────────────────────────────────────────────────────────────────────────

describe("backfillCanonHistory", () => {
  it("全量回填：升序处理、逐章状态、汇总对账一致", async () => {
    const { store, dualWrite } = makeHarness()
    const files: Record<number, string> = {
      2: snapshotJson(2, ["第二章事实一", "第二章事实二"]),
      1: snapshotJson(1, ["第一章事实"]),
      3: snapshotJson(3, []), // 无新事实章
    }
    const deps = makeFsDeps(files, dualWrite, [{ name: "notes.txt" }])

    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)

    // 升序确定性顺序
    expect(report.selectedChapters).toEqual([1, 2, 3])
    expect(report.perChapter.map((c) => c.status)).toEqual(["backfilled", "backfilled", "no-facts"])
    expect(report.factsTotal).toBe(3)
    expect(report.factsWritten).toBe(3)
    expect(report.factsQueued).toBe(0)
    expect(report.consistent).toBe(true)
    expect(report.divergences).toEqual([])
    // store 收敛：3 个唯一 (chapter,digest) 行
    expect(store.rows.size).toBe(3)
  })

  it("迁移前事实经 canon_query 读出口可查（T14 投影链审计）", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]), 2: snapshotJson(2, ["第二章事实"]) }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(report.consistent).toBe(true)

    const raws = [...store.rows.values()].map(rowToRawEdge)
    const facts = projectEdges(raws) // T14 allowlist 投影 + 禁句柄外泄守护
    const audit = auditPreMigrationFacts(facts, [
      { chapter: 1 },
      { chapter: 2, minFacts: 1 },
    ])
    expect(audit.queryable).toBe(true)
    expect(audit.results.map((r) => r.found)).toEqual([1, 1])
  })

  it("重跑幂等：digest 集稳定，store 行数收敛不变（(chapter,digest) 去重）", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实甲", "事实乙"]) }, dualWrite)

    const first = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    const keysAfterFirst = [...store.rows.keys()].sort()

    const second = await backfillCanonHistory(deps, PROJECT, {}, 2_000)
    expect([...store.rows.keys()].sort()).toEqual(keysAfterFirst)
    expect(store.rows.size).toBe(2)
    expect(second.factsTotal).toBe(first.factsTotal)
    expect(second.consistent).toBe(true)
  })

  it("写失败 → 落持久待写队列（digest 幂等 + 注入 now 的退避），T15 重放补齐后 store 完整", async () => {
    const { store, dualWrite } = makeHarness()
    store.canonFailCount = 1
    const queueRef = { text: "" }
    dualWrite.queueRead = async () => queueRef.text
    dualWrite.queueWrite = async (_p, contents) => {
      queueRef.text = contents
    }

    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实A", "事实B"]) }, dualWrite)
    const NOW = 50_000
    const report: CanonBackfillReport = await backfillCanonHistory(deps, PROJECT, {}, NOW)

    expect(report.factsQueued).toBe(1)
    expect(report.factsWritten).toBe(1)
    expect(report.consistent).toBe(false)
    expect(report.divergences).toHaveLength(1)
    expect(report.perChapter[0]).toMatchObject({ status: "backfilled", factCount: 2, written: 1, queued: 1 })

    // 队列记录：digest 幂等键 + nextRetryAt = now + BASE（注入时钟生效）
    const lines = queueRef.text.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]!) as { digest: string; attempts: number; nextRetryAt: number }
    expect(rec.attempts).toBe(1)
    expect(rec.nextRetryAt).toBe(NOW + BACKOFF_BASE_MS)
    expect(store.rows.size).toBe(1)

    // 故障恢复：T15 replayPendingQueue 补齐（离线续跑，无新增机制）
    store.canonFailCount = 0
    const replay = await replayPendingQueue(dualWrite, PROJECT, rec.nextRetryAt + 1)
    expect(replay.succeeded).toBe(1)
    expect(replay.remaining).toBe(0)
    expect(store.rows.size).toBe(2)
  })

  it("exclusiveUpperBound=N 只回填第 1..N-1 章，N 及以后不触达 store", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({
      1: snapshotJson(1, ["第一章事实"]),
      2: snapshotJson(2, ["第二章事实"]),
      4: snapshotJson(4, ["第四章事实"]),
    }, dualWrite)

    const report = await backfillCanonHistory(deps, PROJECT, { exclusiveUpperBound: 4 }, 1_000)
    expect(report.discoveredChapters).toEqual([1, 2, 4])
    expect(report.selectedChapters).toEqual([1, 2])
    expect(store.rows.size).toBe(2)
    expect([...store.rows.keys()].every((k) => k.startsWith("1:") || k.startsWith("2:"))).toBe(true)
  })

  it("firstChapter 下界生效", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({
      1: snapshotJson(1, ["第一章事实"]),
      3: snapshotJson(3, ["第三章事实"]),
    }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, { firstChapter: 2 }, 1_000)
    expect(report.selectedChapters).toEqual([3])
    expect(store.rows.size).toBe(1)
  })

  it("章级容错：坏快照跳过标注 snapshot-unreadable，其余章照常回填", async () => {
    const { store, dualWrite } = makeHarness()
    const files: Record<number, string> = {
      1: "{broken json",
      2: snapshotJson(2, ["第二章事实"]),
      3: "[not-an-object]",
    }
    const deps = makeFsDeps(files, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)

    expect(report.perChapter.map((c) => c.status)).toEqual([
      "snapshot-unreadable",
      "backfilled",
      "snapshot-unreadable",
    ])
    expect(report.consistent).toBe(true)
    expect(store.rows.size).toBe(1)
  })

  it("空项目（目录缺失/空目录）→ 空报告且 consistent", async () => {
    const { dualWrite } = makeHarness()
    const emptyDeps = { listSnapshotsDir: async () => [], readSnapshotText: async () => "", dualWrite }
    const report = await backfillCanonHistory(emptyDeps, PROJECT, {}, 1_000)
    expect(report.discoveredChapters).toEqual([])
    expect(report.selectedChapters).toEqual([])
    expect(report.factsTotal).toBe(0)
    expect(report.consistent).toBe(true)
  })

  it("projectPath 反斜杠归一化进报告", async () => {
    const { dualWrite } = makeHarness()
    const deps = { listSnapshotsDir: async () => [], readSnapshotText: async () => "", dualWrite }
    const report = await backfillCanonHistory(deps, "C:\\proj\\win", {}, 1_000)
    expect(report.projectPath).toBe("C:/proj/win")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 7. 可查询审计（纯函数分支）
// ──────────────────────────────────────────────────────────────────────────

describe("auditPreMigrationFacts", () => {
  it("达标/未达标/minFacts 自定义", () => {
    const facts = [factFixture(1), factFixture(1), factFixture(3)]
    const report = auditPreMigrationFacts(facts, [
      { chapter: 1 },
      { chapter: 2 },
      { chapter: 3, minFacts: 2 },
    ])
    expect(report.results).toEqual([
      { chapter: 1, found: 2, meets: true },
      { chapter: 2, found: 0, meets: false },
      { chapter: 3, found: 1, meets: false },
    ])
    expect(report.queryable).toBe(false)
  })

  it("archived 与无 sourceChapter 的边不计入", () => {
    const facts = [factFixture(1, true), factFixture(null)]
    const report = auditPreMigrationFacts(facts, [{ chapter: 1 }])
    expect(report.results[0]!.found).toBe(0)
    expect(report.queryable).toBe(false)
  })

  it("空期望集 → trivially queryable", () => {
    expect(auditPreMigrationFacts([], [])).toEqual({ queryable: true, results: [] })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 9. DEBT-20260621-30b：supersede 分歧检测（T1-T10）
// ──────────────────────────────────────────────────────────────────────────

/** 轻量 snapshot fixture（仅需 newCanonFacts 字段）。 */
function mkSnapshotForTest(chapter: number, facts: string[]) {
  return {
    chapterId: `chapter-${chapter}`,
    chapterNumber: chapter,
    summary: "",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: facts,
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
  }
}

describe("detectSupersedeDivergences (T1-T3 分歧三分类)", () => {
  it("T1: 无已存 episodes → 无分歧", async () => {
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [],
      total: 0,
      max_revision: 0,
    })
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A"]))
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toEqual([])
  })

  it("T2: 同槽位同 digest → 无分歧（幂等）", async () => {
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A"]))
    const existingDigest = ops[0]!.digest!
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: existingDigest }],
      total: 1,
      max_revision: 1,
    })
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toEqual([])
  })

  it("T3: 同槽位不同 digest → 分歧（multi-divergence）", async () => {
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A", "事实B"]))
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [
        { id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: "old-digest-0" },
        { id: "ch1-fact1", chapter_number: 1, entity_id: "x", summary: "", digest: "old-digest-1" },
      ],
      total: 2,
      max_revision: 2,
    })
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toHaveLength(2)
    expect(divs[0]).toEqual({ slot: 0, oldDigest: "old-digest-0", newDigest: ops[0]!.digest })
    expect(divs[1]).toEqual({ slot: 1, oldDigest: "old-digest-1", newDigest: ops[1]!.digest })
  })

  it("查询失败 → 容错返回空（无分歧）", async () => {
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockRejectedValue(new Error("DB down"))
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A"]))
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toEqual([])
  })
})

describe("buildSupersedeOps (T4-T6 op构造/digest含old+new)", () => {
  it("T4: 单条分歧 → 单条 supersede op，digest = SHA-256({chapter,slot,oldDigest,newDigest})", async () => {
    const divergences: SupersedeDivergence[] = [{ slot: 0, oldDigest: "old-d1", newDigest: "new-d1" }]
    const ops = await buildSupersedeOps(3, divergences)
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.canonPayload.kind).toBe("supersede_by_digest")
    const req = (op.canonPayload as { kind: "supersede_by_digest"; request: { oldDigest: string; capChapter: number; newDigest: string } }).request
    expect(req.oldDigest).toBe("old-d1")
    expect(req.capChapter).toBe(3)
    expect(req.newDigest).toBe("new-d1")
    // digest 幂等: 同内容同键
    const content = { chapter: 3, slot: 0, oldDigest: "old-d1", newDigest: "new-d1" }
    expect(op.digest).toBe(await computeCheckpointDigestOf(content))
  })

  it("T5: 多分歧 → 多条 supersede ops，每条独立 digest", async () => {
    const divergences: SupersedeDivergence[] = [
      { slot: 0, oldDigest: "old-0", newDigest: "new-0" },
      { slot: 2, oldDigest: "old-2", newDigest: "new-2" },
    ]
    const ops = await buildSupersedeOps(5, divergences)
    expect(ops).toHaveLength(2)
    expect(ops[0]!.digest).not.toBe(ops[1]!.digest)
  })

  it("T6: 空分歧 → 空 ops", async () => {
    const ops = await buildSupersedeOps(1, [])
    expect(ops).toEqual([])
  })
})

describe("backfillCanonHistory supersede 集成 (T7-T10)", () => {
  it("T7: 完整流——首次回填无已存 episodes → 无 supersede", async () => {
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [],
      total: 0,
      max_revision: 0,
    })
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实A", "事实B"]) }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(report.consistent).toBe(true)
    expect(store.rows.size).toBe(2)
    expect(store.supersededDigests).toEqual([])
  })

  it("T8: 二次回填——同事实同 digest → 零 supersede", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实A"]) }, dualWrite)

    // 第一次回填
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [],
      total: 0,
      max_revision: 0,
    })
    await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(store.rows.size).toBe(1)
    const firstDigest = [...store.rows.values()][0]!.digest

    // 第二次回填：模拟已存 episode 同 digest
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: firstDigest }],
      total: 0,
      max_revision: 1,
    })
    const report2 = await backfillCanonHistory(deps, PROJECT, {}, 2_000)
    expect(report2.consistent).toBe(true)
    expect(store.supersededDigests).toEqual([])
  })

  it("T9: 三次编辑——事实变更产生新分歧 → supersede 封顶旧 digest", async () => {
    const { store, dualWrite } = makeHarness()

    // 第一次回填：事实A
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [],
      total: 0,
      max_revision: 0,
    })
    const deps1 = makeFsDeps({ 1: snapshotJson(1, ["事实A"]) }, dualWrite)
    await backfillCanonHistory(deps1, PROJECT, {}, 1_000)
    const oldDigest = [...store.rows.values()][0]!.digest

    // 第三次编辑：事实A改为事实A'（新 snapshot）
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: oldDigest }],
      total: 0,
      max_revision: 1,
    })
    const deps3 = makeFsDeps({ 1: snapshotJson(1, ["事实A改"]) }, dualWrite)
    const report3 = await backfillCanonHistory(deps3, PROJECT, {}, 3_000)
    expect(report3.consistent).toBe(true)
    // 旧 digest 被封顶
    expect(store.supersededDigests).toContain(oldDigest)
    // 新事实也写入
    expect(store.rows.size).toBe(2)
  })

  it("T10: 失败入队重放——supersede op 也写队列，digest 幂等", async () => {
    const { store, dualWrite } = makeHarness()
    store.canonFailCount = 2 // 让前两个 op 失败
    const queueRef = { text: "" }
    dualWrite.queueRead = async () => queueRef.text
    dualWrite.queueWrite = async (_p, contents) => {
      queueRef.text = contents
    }

    // 模拟已存 episode 有旧 digest
    const oldDigest = await computeCheckpointDigestOf({ chapter: 1, fact: "事实A" })
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: oldDigest }],
      total: 0,
      max_revision: 1,
    })

    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实A改"]) }, dualWrite)
    const NOW = 50_000
    const report = await backfillCanonHistory(deps, PROJECT, {}, NOW)

    // 两个 op 入队（episode + supersede）
    expect(report.factsQueued).toBeGreaterThanOrEqual(2)

    // 队列记录含 supersede op
    const lines = queueRef.text.trim().split("\n").filter(Boolean)
    const supersedeLine = lines.find((l) => {
      try {
        const r = JSON.parse(l)
        return r.canonPayload?.kind === "supersede_by_digest"
      } catch {
        return false
      }
    })
    expect(supersedeLine).toBeDefined()

    // 重放补齐
    store.canonFailCount = 0
    const replay = await replayPendingQueue(dualWrite, PROJECT, NOW + BACKOFF_BASE_MS + 1)
    expect(replay.succeeded).toBeGreaterThanOrEqual(2)
    expect(replay.remaining).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 8. 默认依赖接线（真实 fs seam）
// ──────────────────────────────────────────────────────────────────────────

describe("defaultCanonBackfillDeps", () => {
  it("listSnapshotsDir 透传 listDirectory(dir)；readSnapshotText 透传 readFile", async () => {
    const { listDirectory } = await import("@/commands/fs")
    const listDirectoryMock = vi.mocked(listDirectory)
    listDirectoryMock.mockReset().mockResolvedValue([{ name: "001.snapshot.json", path: "x", is_dir: false }])
    readFileMock.mockResolvedValueOnce('{"newCanonFacts":["事实"]}')

    const deps = defaultCanonBackfillDeps()
    const entries = await deps.listSnapshotsDir(snapshotsDir(PROJECT))
    expect(listDirectoryMock).toHaveBeenCalledWith(`${PROJECT}/.novel/snapshots`)
    expect(entries).toHaveLength(1)
    await expect(deps.readSnapshotText(`${PROJECT}/x.json`)).resolves.toBe('{"newCanonFacts":["事实"]}')
  })

  it("listSnapshotsDir 目录缺失容错为空数组", async () => {
    const { listDirectory } = await import("@/commands/fs")
    const listDirectoryMock = vi.mocked(listDirectory)
    listDirectoryMock.mockReset().mockRejectedValue(new Error("ENOENT"))
    const deps = defaultCanonBackfillDeps()
    await expect(deps.listSnapshotsDir(snapshotsDir(PROJECT))).resolves.toEqual([])
  })
})
