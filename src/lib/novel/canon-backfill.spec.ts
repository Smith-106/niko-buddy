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
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  canonStoreWriter,
  computeBackoffMs,
  replayPendingQueue,
  type CanonDualWriteDeps,
} from "./canon-dual-write"
import { projectEdges, type CanonFact, type RawCanonEdge } from "./canon-graph-client"
import {
  SOURCE_AWARE_MERGE_EVALUATION,
  SNAPSHOTS_DIR_SEGMENT,
  activateCanonDualMigration,
  auditPreMigrationFacts,
  backfillCanonHistory,
  buildBackfillOps,
  runCanonHistoryBackfill,
  buildSupersedeOps,
  classifyBackfillMerge,
  defaultCanonBackfillDeps,
  detectSupersedeDivergences,
  filterBackfillRange,
  loadBackfillSnapshot,
  parseChapterSnapshotFileName,
  parseDiscoveredChapters,
  snapshotsDir,
  type ActivateCanonDualMigrationDeps,
  type BackfillMergeDecisionReport,
  type CanonBackfillReport,
  type CanonDualMigrationActivationReport,
  type SupersedeDivergence,
} from "./canon-backfill"
import { parseCanonFactTriple } from "./chapter-ingest-utils"
import type { NovelSessionStatus } from "./novel-session-status"
import * as CanonGraphClient from "./canon-graph-client"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      createDirectory: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      writeFileAtomic: vi.fn(async () => {}),
      listDirectory: vi.fn(async () => []),
    
  }
})

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
      const m = /(\d{3,})\.snapshot\.json$/.exec(p)
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

  it("正文章快照名匹配并解析章节号（含 >=1000 章）", () => {
    expect(parseChapterSnapshotFileName("001.snapshot.json")).toBe(1)
    expect(parseChapterSnapshotFileName("012.snapshot.json")).toBe(12)
    expect(parseChapterSnapshotFileName("1000.snapshot.json")).toBe(1000)
    expect(parseChapterSnapshotFileName("12345.snapshot.json")).toBe(12345)
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

  it("逐条事实派生 episode + world_fact 操作，digest 与 T16 buildCanonDualWriteOps 逐字节同构", async () => {
    const snap = {
      ...mkSnapshot(2, ["林澈：佩剑名为黑剑", "黑塔位于北境"]),
      povCharacter: "林澈",
      characters: ["林澈", "苏未晞"],
    }
    const ops = await buildBackfillOps(snap)
    expect(ops).toHaveLength(4)

    for (let i = 0; i < snap.newCanonFacts.length; i++) {
      const epOp = ops[i]!
      // T16 契约交叉验证：episode digest 与字面公式一致（实时双写与离线回填同键）
      expect(epOp.digest).toBe(await computeCheckpointDigestOf({ chapter: 2, fact: snap.newCanonFacts[i] }))
      expect(epOp.content).toEqual({ chapter: 2, fact: snap.newCanonFacts[i] })
      expect(epOp.legacyPayload).toEqual({
        kind: "snapshot_fact",
        chapterNumber: 2,
        fact: snap.newCanonFacts[i],
      })
      expect(epOp.canonPayload).toEqual({
        kind: "episode",
        episode: {
          id: `ch2-ep-${epOp.digest!.slice(0, 12)}`,
          chapter_number: 2,
          entity_id: "chapter-2",
          summary: snap.newCanonFacts[i],
          digest: epOp.digest,
        },
      })

      const wfOp = ops[snap.newCanonFacts.length + i]!
      const { sourceId, predicate, targetId } = parseCanonFactTriple(snap.newCanonFacts[i]!, snap.chapterId)
      const wfContent = {
        chapter: 2,
        kind: "world_fact",
        fact: snap.newCanonFacts[i],
        sourceId,
        predicate,
        targetId,
      }
      const wfDigest = await computeCheckpointDigestOf(wfContent)
      expect(wfOp.digest).toBe(wfDigest)
      expect(wfOp.content).toEqual(wfContent)
      expect(wfOp.legacyPayload).toEqual({
        kind: "snapshot_world_fact",
        chapterNumber: 2,
        fact: snap.newCanonFacts[i],
        subject: sourceId,
        predicate,
        object: targetId,
      })
      expect(wfOp.canonPayload).toEqual({
        kind: "supersede",
        request: {
          old_edge_ids: [],
          cap_chapter: 2,
          caused_by: "snapshot-world-facts",
          new_edges: [
            {
              id: `ch2-wf-${wfDigest.slice(0, 12)}`,
              source_id: sourceId,
              target_id: targetId,
              predicate,
              edge_kind: "world_fact",
              valid_at: 2,
              source_chapter: 2,
              revealed_at: 2,
              known_by: ["林澈", "苏未晞"],
              modality: "assertive",
              digest: wfDigest,
            },
          ],
        },
      })
    }
  })

  it("R2-M07: beliefFacts / hypothesisFacts 派生模态 supersede 边，含 known_by/source_chapter/revealed_at", async () => {
    const snap = {
      ...mkSnapshot(4, ["正史事实"]),
      povCharacter: "林澈",
      characters: ["苏未晞"],
      beliefFacts: [{ subject: "林澈", predicate: "认为", object: "黑塔已被摧毁" }],
      hypothesisFacts: [{ subject: "苏未晞", predicate: "猜测", object: "密道通向地宫" }],
    }
    const ops = await buildBackfillOps(snap)
    expect(ops).toHaveLength(4)

    const beliefOp = ops[2]!
    expect(beliefOp.canonPayload.kind).toBe("supersede")
    const beliefDigest = await computeCheckpointDigestOf({
      chapter: 4,
      modality: "belief",
      fact: "林澈认为黑塔已被摧毁",
    })
    expect(beliefOp.digest).toBe(beliefDigest)
    expect(beliefOp.canonPayload).toEqual({
      kind: "supersede",
      request: {
        old_edge_ids: [],
        cap_chapter: 4,
        caused_by: "snapshot-modality-facts",
        new_edges: [
          {
            id: `ch4-mod-${beliefDigest.slice(0, 12)}`,
            source_id: "林澈",
            target_id: "黑塔已被摧毁",
            predicate: "认为",
            edge_kind: "world_fact",
            valid_at: 4,
            source_chapter: 4,
            revealed_at: 4,
            known_by: ["林澈", "苏未晞"],
            modality: "belief",
            digest: beliefDigest,
          },
        ],
      },
    })

    const hypOp = ops[3]!
    const hypDigest = await computeCheckpointDigestOf({
      chapter: 4,
      modality: "hypothesis",
      fact: "苏未晞猜测密道通向地宫",
    })
    expect(hypOp.digest).toBe(hypDigest)
    const hypReq = (hypOp.canonPayload as {
      kind: "supersede"
      request: { new_edges: Array<{ id: string; modality: string; known_by: string[]; source_chapter: number; revealed_at: number }> }
    }).request
    expect(hypReq.new_edges[0]).toMatchObject({
      id: `ch4-mod-${hypDigest.slice(0, 12)}`,
      modality: "hypothesis",
      known_by: ["苏未晞", "林澈"],
      source_chapter: 4,
      revealed_at: 4,
    })
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
    expect(report.factsTotal).toBe(6)
    expect(report.factsWritten).toBe(6)
    expect(report.factsQueued).toBe(0)
    expect(report.consistent).toBe(true)
    expect(report.divergences).toEqual([])
    // store 收敛：3 个唯一 (chapter,digest) episode 行（每条事实同时物化对应 world_fact 边）
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
    let blockFactA = true
    const baseWriteCanon = dualWrite.writeCanon
    dualWrite.writeCanon = async (pp, payload) => {
      if (
        blockFactA &&
        payload.kind === "episode" &&
        (payload.episode as { summary?: string }).summary === "事实A"
      ) {
        return { ok: false, error: "canon crash" }
      }
      return baseWriteCanon(pp, payload)
    }
    const queueRef = { text: "" }
    dualWrite.queueRead = async () => queueRef.text
    dualWrite.queueWrite = async (_p, contents) => {
      queueRef.text = contents
    }

    const deps = makeFsDeps({ 1: snapshotJson(1, ["事实A", "事实B"]) }, dualWrite)
    const NOW = 50_000
    const report: CanonBackfillReport = await backfillCanonHistory(deps, PROJECT, {}, NOW)

    expect(report.factsQueued).toBe(1)
    expect(report.factsWritten).toBe(3)
    expect(report.consistent).toBe(false)
    expect(report.divergences).toHaveLength(1)
    expect(report.perChapter[0]).toMatchObject({ status: "backfilled", factCount: 4, written: 3, queued: 1 })

    // 队列记录：digest 幂等键 + 经 twoPhaseReconcile 立即重放一次仍失败后退避升级（attempts=2）
    const lines = queueRef.text.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]!) as { digest: string; attempts: number; nextRetryAt: number }
    expect(rec.attempts).toBe(2)
    expect(rec.nextRetryAt).toBe(NOW + computeBackoffMs(2))
    expect(store.rows.size).toBe(1)

    // 故障恢复：T15 replayPendingQueue 补齐（离线续跑，无新增机制）
    blockFactA = false
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

  it("T2: 同槽位同 digest → 无分歧（幂等，兼容新 ch{n}-ep-{hash12} 与旧 ch{n}-fact{i}）", async () => {
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A"]))
    const existingDigest = ops[0]!.digest!
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: `ch1-ep-${existingDigest.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: existingDigest }],
      total: 1,
      max_revision: 1,
    })
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toEqual([])
  })

  it("T3: 同槽位不同 digest → 分歧（multi-divergence，兼容新 ch{n}-ep-{hash12}）", async () => {
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实A", "事实B"]))
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [
        { id: "ch1-ep-aaaaaaaaaaaa", chapter_number: 1, entity_id: "x", summary: "", digest: "old-digest-0" },
        { id: "ch1-ep-bbbbbbbbbbbb", chapter_number: 1, entity_id: "x", summary: "", digest: "old-digest-1" },
      ],
      total: 2,
      max_revision: 2,
    })
    const divs = await detectSupersedeDivergences(PROJECT, 1, ops)
    expect(divs).toHaveLength(2)
    expect(divs[0]).toEqual({ slot: 0, oldDigest: "old-digest-0", newDigest: ops[0]!.digest })
    expect(divs[1]).toEqual({ slot: 1, oldDigest: "old-digest-1", newDigest: ops[1]!.digest })
  })

  it("R2-M07 历史兼容：旧 ch1-fact0 仍按槽位检出分歧，新格式重排顺序零误报", async () => {
    const ops = await buildBackfillOps(mkSnapshotForTest(1, ["事实B", "事实A"]))
    const dA = await computeCheckpointDigestOf({ chapter: 1, fact: "事实A" })
    const dB = await computeCheckpointDigestOf({ chapter: 1, fact: "事实B" })
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValueOnce({
      episodes: [
        { id: `ch1-ep-${dA.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: dA },
        { id: `ch1-ep-${dB.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: dB },
      ],
      total: 2,
      max_revision: 2,
    })
    expect(await detectSupersedeDivergences(PROJECT, 1, ops)).toEqual([])

    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValueOnce({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: "legacy-old" }],
      total: 1,
      max_revision: 1,
    })
    expect(await detectSupersedeDivergences(PROJECT, 1, ops)).toEqual([
      { slot: 0, oldDigest: "legacy-old", newDigest: ops[0]!.digest },
    ])
  })

  it("空 ops → 短路返回空（不查库）", async () => {
    const query = vi.mocked(CanonGraphClient.queryEpisodesByChapter)
    const divs = await detectSupersedeDivergences(PROJECT, 1, [])
    expect(divs).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it("op 缺 digest（未预置幂等键）→ 跳过该槽位，不参与比较", async () => {
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: "ch1-fact0", chapter_number: 1, entity_id: "x", summary: "", digest: "old-digest-0" }],
      total: 1,
      max_revision: 1,
    })
    const opWithoutDigest = {
      legacyPayload: { kind: "snapshot_fact" as const, chapterNumber: 1, fact: "事实A" },
      canonPayload: { kind: "episode" as const, episode: { id: "ch1-fact0" } },
    }
    const divs = await detectSupersedeDivergences(PROJECT, 1, [opWithoutDigest])
    expect(divs).toEqual([])
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
      episodes: [{ id: `ch1-ep-${firstDigest.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: firstDigest }],
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
      episodes: [{ id: `ch1-ep-${oldDigest.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: oldDigest }],
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
    store.canonFailCount = 6 // 初始 3 次（episode + world_fact + supersede_by_digest）+ twoPhaseReconcile 立即重放 3 次均失败，留在持久队列
    const queueRef = { text: "" }
    dualWrite.queueRead = async () => queueRef.text
    dualWrite.queueWrite = async (_p, contents) => {
      queueRef.text = contents
    }

    // 模拟已存 episode 有旧 digest
    const oldDigest = await computeCheckpointDigestOf({ chapter: 1, fact: "事实A" })
    vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
      episodes: [{ id: `ch1-ep-${oldDigest.slice(0, 12)}`, chapter_number: 1, entity_id: "x", summary: "", digest: oldDigest }],
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

    // 重放补齐（两次失败后退避至 computeBackoffMs(2)）
    store.canonFailCount = 0
    const replay = await replayPendingQueue(dualWrite, PROJECT, NOW + computeBackoffMs(2) + 1)
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

describe("runCanonHistoryBackfill", () => {
  it("只回填当前项目已发现的全部快照，不设排他上界", async () => {
    const { dualWrite } = makeHarness()
    const deps = makeFsDeps(
      {
        1: snapshotJson(1, ["第一章事实"]),
        2: snapshotJson(2, ["第二章事实"]),
      },
      dualWrite,
    )
    const report = await runCanonHistoryBackfill(`  ${PROJECT}  `, deps, 1_000)
    expect(report.projectPath).toBe(PROJECT)
    expect(report.selectedChapters).toEqual([1, 2])
    expect(report.factsWritten).toBe(4)
  })

  it("空白项目路径拒绝执行，不读快照", async () => {
    const { dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const listSnapshotsDir = vi.fn(deps.listSnapshotsDir)
    await expect(
      runCanonHistoryBackfill("   ", { ...deps, listSnapshotsDir }, 1_000),
    ).rejects.toThrow(/open project path/)
    expect(listSnapshotsDir).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 9. E-05 晋升接线容错（promote 抛错 / promotionAudit 不一致与失败均非致命）
// ──────────────────────────────────────────────────────────────────────────

describe("backfillCanonHistory E-05 晋升接线容错", () => {
  it("promote 写凭证失败 → 非致命告警，回填本身仍回报 backfilled", async () => {
    const { logger } = await import("@/lib/utils")
    const warn = vi.spyOn(logger, "warn")
    // 仅让凭证层 promotions.json 的原子写失败（双写队列写不受影响）
    writeFileAtomicMock.mockImplementation(async (path: string) => {
      if (path.includes("promotions.json")) throw new Error("disk-full")
    })
    const { dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)

    expect(report.perChapter[0]).toMatchObject({ chapter: 1, status: "backfilled", factCount: 2 })
    expect(report.factsWritten).toBe(2)
    expect(warn.mock.calls.some(([, message]) => /promote failed \(non-fatal, chapter 1\): disk-full/.test(message))).toBe(true)
    warn.mockRestore()
  })

  it("promotionAudit 检出 recordWithoutEntry → 告警但不阻断回填", async () => {
    const { logger } = await import("@/lib/utils")
    const warn = vi.spyOn(logger, "warn")
    // 预置一条无 targetRef.entryId 的历史凭证记录（静态内容每次读都返回）
    readFileMock.mockImplementation(async (path: string) =>
      path.includes("promotions.json")
        ? JSON.stringify({ records: { "stale-key": { targetRef: {} } } })
        : "",
    )
    const { dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)

    expect(report.factsWritten).toBe(2)
    expect(
      warn.mock.calls.some(([, message]) =>
        /promotionAudit inconsistent: recordWithoutEntry=1 entryWithoutRecord=0/.test(message),
      ),
    ).toBe(true)
    warn.mockRestore()
  })

  it("promotionAudit 自身抛错（records 形状损坏）→ 告警后正常返回报告", async () => {
    const { logger } = await import("@/lib/utils")
    const warn = vi.spyOn(logger, "warn")
    readFileMock.mockImplementation(async (path: string) =>
      path.includes("promotions.json") ? '{"records":null}' : "",
    )
    const { dualWrite } = makeHarness()
    const deps = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)

    expect(report.selectedChapters).toEqual([1])
    expect(report.factsWritten).toBe(2)
    expect(
      warn.mock.calls.some(([, message]) => /promotionAudit failed \(non-fatal\)/.test(message)),
    ).toBe(true)
    warn.mockRestore()
  })
})

describe("R2-M07：1000+ 章回填与 beliefFacts/hypothesisFacts 模态边回填", () => {
  it("发现并回填 1000.snapshot.json 且生成 ch1000-ep-{hash12} ID", async () => {
    const { store, dualWrite } = makeHarness()
    const deps = makeFsDeps(
      {
        1000: snapshotJson(1000, ["第一千章决战"]),
      },
      dualWrite,
    )
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(report.selectedChapters).toEqual([1000])
    expect(report.factsWritten).toBe(2)
    const ep = [...store.rows.values()][0] as { id?: string; chapter_number: number; digest: string }
    expect(ep.chapter_number).toBe(1000)
    expect(ep.id).toBe(`ch1000-ep-${ep.digest.slice(0, 12)}`)
  })

  it("同时回填 world_fact、beliefFacts 与 hypothesisFacts 为 supersede 边", async () => {
    const writtenPayloads: Array<{ kind: string; request?: { new_edges: Array<Record<string, unknown>> } }> = []
    const { dualWrite } = makeHarness()
    const origWriteCanon = dualWrite.writeCanon
    const spyDualWrite: CanonDualWriteDeps = {
      ...dualWrite,
      writeCanon: async (pp, payload) => {
        writtenPayloads.push(payload as { kind: string; request?: { new_edges: Array<Record<string, unknown>> } })
        return origWriteCanon(pp, payload)
      },
    }
    const deps = makeFsDeps(
      {
        5: JSON.stringify({
          chapterNumber: 5,
          povCharacter: "林晚",
          newCanonFacts: ["林晚：佩剑名为霜刃"],
          beliefFacts: [{ subject: "林晚", predicate: "认为", object: "沈舟隐藏身份" }],
          hypothesisFacts: [{ subject: "沈舟", predicate: "猜测", object: "密室在城北" }],
        }),
      },
      spyDualWrite,
    )
    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(report.selectedChapters).toEqual([5])
    expect(report.factsWritten).toBe(4)
    const supersedeEdges = writtenPayloads
      .filter((p) => p.kind === "supersede")
      .flatMap((p) => p.request?.new_edges ?? [])
    expect(supersedeEdges).toHaveLength(3)
    expect(supersedeEdges[0]!.modality).toBe("assertive")
    expect(supersedeEdges[0]!.id).toMatch(/^ch5-wf-[0-9a-f]{12}$/)
    expect(supersedeEdges[0]!.known_by).toEqual(["林晚"])
    expect(supersedeEdges[0]!.source_chapter).toBe(5)
    expect(supersedeEdges[0]!.revealed_at).toBe(5)
    expect(supersedeEdges[1]!.modality).toBe("belief")
    expect(supersedeEdges[1]!.id).toMatch(/^ch5-mod-[0-9a-f]{12}$/)
    expect(supersedeEdges[2]!.modality).toBe("hypothesis")
    expect(supersedeEdges[2]!.id).toMatch(/^ch5-mod-[0-9a-f]{12}$/)
  })

  it("R3-M01: 同章多事实回填以 episode.id 为 entity + snapshot.revision 晋升，各自生成唯一 replayKey", async () => {
    const promotionBridge = await import("./promotion-bridge")
    const promoteSpy = vi
      .spyOn(promotionBridge, "promote")
      .mockResolvedValue({ record: {} as never, replayed: false })
    try {
      const { dualWrite } = makeHarness()
      const deps = makeFsDeps(
        {
          7: JSON.stringify({
            chapterId: "chapter-7",
            chapterNumber: 7,
            revision: 3,
            newCanonFacts: ["事实甲", "事实乙"],
          }),
        },
        dualWrite,
      )
      const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
      expect(report.factsWritten).toBe(4)
      expect(promoteSpy).toHaveBeenCalledTimes(2)
      const firstCall = promoteSpy.mock.calls[0]![0]
      const secondCall = promoteSpy.mock.calls[1]![0]
      expect(firstCall.revision).toBe(3)
      expect(secondCall.revision).toBe(3)
      expect(firstCall.entity).toMatch(/^ch7-ep-[0-9a-f]{12}$/)
      expect(secondCall.entity).toMatch(/^ch7-ep-[0-9a-f]{12}$/)
      expect(firstCall.entity).not.toBe(secondCall.entity)
    } finally {
      promoteSpy.mockRestore()
    }
  })
})

describe("TASK-006: activateCanonDualMigration 受控激活编排", () => {
  function fakeStatus(mode?: NovelSessionStatus["canon_migration"]): NovelSessionStatus {
    return {
      schema_version: "1",
      session_id: "sess-activate",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      active_step_index: 5,
      current_task: {
        task_id: "tsk-1",
        conversation_id: "conv-1",
        user_request: "test",
        checkpoint_stage: "completed",
        status: "completed",
      },
      draft: {
        draft_id: "d-1",
        file_path: "p",
        draft_status: "accepted",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
      canon_migration: mode,
    }
  }

  it("零差异回填 + 空 pending 队列 → 将 canon_migration 切换为 'dual'", async () => {
    const { dualWrite } = makeHarness()
    const backfill = makeFsDeps({ 1: snapshotJson(1, ["林澈：佩剑名为黑剑"]) }, dualWrite)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>(async () => fakeStatus("dual"))
    const report: CanonDualMigrationActivationReport = await activateCanonDualMigration(
      PROJECT,
      {
        backfill,
        loadStatus: async () => fakeStatus(undefined),
        setMigrationMode,
        loadPending: async () => [],
      },
      { now: 1_700_000_000_000 },
    )
    expect(report.activated).toBe(true)
    expect(report.reason).toBe("activated")
    expect(report.previousMode).toBeUndefined()
    expect(report.currentMode).toBe("dual")
    expect(report.pendingQueueLength).toBe(0)
    expect(report.backfillReport?.consistent).toBe(true)
    expect(setMigrationMode).toHaveBeenCalledWith(PROJECT, "dual", {
      onlyIfUnset: true,
      createIfMissing: true,
      now: new Date(1_700_000_000_000).toISOString(),
    })
  })

  it("回填存在对账分歧/入队失败 → 拒绝切换 canon_migration", async () => {
    const { dualWrite } = makeHarness()
    dualWrite.writeCanon = async () => ({ ok: false, error: "canon down" })
    const backfill = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>()
    const report = await activateCanonDualMigration(PROJECT, {
      backfill,
      loadStatus: async () => fakeStatus(undefined),
      setMigrationMode,
      loadPending: async () => [],
    })
    expect(report.activated).toBe(false)
    expect(report.reason).toBe("backfill_inconsistent")
    expect(report.currentMode).toBeUndefined()
    expect(report.backfillReport?.consistent).toBe(false)
    expect(setMigrationMode).not.toHaveBeenCalled()
  })

  it("pending 队列非空 → 即使本次回填一致也拒绝切换 canon_migration", async () => {
    const { dualWrite } = makeHarness()
    const backfill = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>()
    const report = await activateCanonDualMigration(PROJECT, {
      backfill,
      loadStatus: async () => fakeStatus(undefined),
      setMigrationMode,
      loadPending: async () => [
        {
          digest: "pending-d1",
          createdAt: 100,
          attempts: 1,
          nextRetryAt: 500,
          lastError: "transient",
          legacyPayload: {},
          canonPayload: { kind: "episode", episode: {} },
        },
      ],
    })
    expect(report.activated).toBe(false)
    expect(report.reason).toBe("pending_queue_non_empty")
    expect(report.pendingQueueLength).toBe(1)
    expect(setMigrationMode).not.toHaveBeenCalled()
  })

  it("显式 'legacy' 在未传 force: true 时保留原值且不执行回填", async () => {
    const { dualWrite } = makeHarness()
    const baseBackfill = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const listSnapshotsDir = vi.fn(baseBackfill.listSnapshotsDir)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>()
    const report = await activateCanonDualMigration(PROJECT, {
      backfill: { ...baseBackfill, listSnapshotsDir },
      loadStatus: async () => fakeStatus("legacy"),
      setMigrationMode,
      loadPending: async () => [],
    })
    expect(report.activated).toBe(false)
    expect(report.reason).toBe("explicit_legacy_preserved")
    expect(report.previousMode).toBe("legacy")
    expect(report.currentMode).toBe("legacy")
    expect(report.backfillReport).toBeNull()
    expect(listSnapshotsDir).not.toHaveBeenCalled()
    expect(setMigrationMode).not.toHaveBeenCalled()
  })

  it("显式 'legacy' 配合 force: true 且回填零差异/空队列 → 强制切换为 'dual'", async () => {
    const { dualWrite } = makeHarness()
    const backfill = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>(async () => fakeStatus("dual"))
    const report = await activateCanonDualMigration(
      PROJECT,
      {
        backfill,
        loadStatus: async () => fakeStatus("legacy"),
        setMigrationMode,
        loadPending: async () => [],
      },
      { force: true, now: 1_700_000_000_000 },
    )
    expect(report.activated).toBe(true)
    expect(report.reason).toBe("activated")
    expect(report.previousMode).toBe("legacy")
    expect(report.currentMode).toBe("dual")
    expect(setMigrationMode).toHaveBeenCalledWith(PROJECT, "dual", {
      onlyIfUnset: false,
      createIfMissing: true,
      now: new Date(1_700_000_000_000).toISOString(),
    })
  })

  it("已处于 'dual' 时幂等收敛（setMigrationMode 返回 null → already_dual）", async () => {
    const { dualWrite } = makeHarness()
    const backfill = makeFsDeps({ 1: snapshotJson(1, ["第一章事实"]) }, dualWrite)
    const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>(async () => null)
    const report = await activateCanonDualMigration(PROJECT, {
      backfill,
      loadStatus: async () => fakeStatus("dual"),
      setMigrationMode,
      loadPending: async () => [],
    })
    expect(report.activated).toBe(true)
    expect(report.reason).toBe("already_dual")
    expect(report.previousMode).toBe("dual")
    expect(report.currentMode).toBe("dual")
  })
})

describe("Finding 2: 多章顺序回填与修订章重回填真实 old_edge_ids 及 block 模式闭环", () => {
  interface InMemoryCanonDb {
    episodes: Array<{ id: string; chapter_number: number; entity_id: string; summary: string; digest: string }>
    edges: RawCanonEdge[]
    revision: number
    supersedeRequests: Array<{ old_edge_ids: string[]; cap_chapter: number; new_edges: RawCanonEdge[] }>
  }

  function installInMemoryCanonInvokeMock(): InMemoryCanonDb {
    const db: InMemoryCanonDb = {
      episodes: [],
      edges: [],
      revision: 0,
      supersedeRequests: [],
    }
    const invokeMock = vi.mocked(invoke)
    invokeMock.mockReset().mockImplementation(async (cmd: string, args?: unknown) => {
      const payload = (args ?? {}) as Record<string, unknown>
      if (cmd === "canon_ingest_episode") {
        const ep = payload.episode as InMemoryCanonDb["episodes"][number]
        if (!db.episodes.some((e) => e.chapter_number === ep.chapter_number && e.digest === ep.digest)) {
          db.episodes.push({ ...ep })
          db.revision += 1
        }
        return { inserted: true, max_revision: db.revision }
      }
      if (cmd === "canon_query") {
        const filter = (payload.filter ?? {}) as {
          archived?: boolean | null
          entity_ids?: string[] | null
          predicates?: string[] | null
          edge_kinds?: string[] | null
          digest?: string[] | null
        }
        const edges = db.edges.filter((e) => {
          if (filter.archived !== undefined && filter.archived !== null && Boolean(e.archived) !== filter.archived) {
            return false
          }
          if (filter.entity_ids && !filter.entity_ids.includes(e.source_id)) return false
          if (filter.predicates && !filter.predicates.includes(e.predicate)) return false
          if (filter.edge_kinds && !filter.edge_kinds.includes(e.edge_kind)) return false
          if (filter.digest && (!e.digest || !filter.digest.includes(e.digest))) return false
          return true
        })
        return { edges: edges.map((e) => ({ ...e })), max_revision: db.revision }
      }
      if (cmd === "canon_supersede_edges") {
        const req = payload.request as {
          old_edge_ids?: string[]
          cap_chapter: number
          new_edges?: RawCanonEdge[]
        }
        const oldIds = req.old_edge_ids ?? []
        const newEdges = req.new_edges ?? []
        db.supersedeRequests.push({
          old_edge_ids: [...oldIds],
          cap_chapter: req.cap_chapter,
          new_edges: newEdges.map((e) => ({ ...e })),
        })
        let capped = 0
        for (const oldId of oldIds) {
          const target = db.edges.find((e) => e.id === oldId)
          if (target) {
            target.invalid_at =
              target.invalid_at == null ? req.cap_chapter : Math.min(target.invalid_at, req.cap_chapter)
            capped += 1
          }
        }
        let inserted = 0
        for (const ne of newEdges) {
          if (!db.edges.some((e) => e.id === ne.id)) {
            db.edges.push({ ...ne, invalid_at: ne.invalid_at ?? null, archived: false })
            inserted += 1
          }
        }
        db.revision += 1
        return { result: { capped, inserted }, max_revision: db.revision }
      }
      return {}
    })
    return db
  }

  function makeDualStatus(mode?: NovelSessionStatus["canon_migration"]): NovelSessionStatus {
    return {
      schema_version: "1",
      session_id: "sess-block",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      active_step_index: 5,
      current_task: {
        task_id: "tsk-block",
        conversation_id: "conv-block",
        user_request: "test",
        checkpoint_stage: "completed",
        status: "completed",
      },
      draft: {
        draft_id: "d-block",
        file_path: "p",
        draft_status: "accepted",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
      canon_migration: mode,
    }
  }

  it("1. 跨章属性演进（Ch.1 林舟的境界是练气一层 → Ch.5 林舟的境界是筑基期）填充真实非空 old_edge_ids 指向 Ch.1 world_fact 边", async () => {
    const capturedSupersedes: Array<{ old_edge_ids: string[]; cap_chapter: number; new_edges: Array<{ id: string; target_id: string }> }> = []
    const dualWrite: CanonDualWriteDeps = {
      writeCanon: async (_pp, payload) => {
        if (payload.kind === "supersede") {
          const req = payload.request as {
            old_edge_ids: string[]
            cap_chapter: number
            new_edges: Array<{ id: string; target_id: string }>
          }
          capturedSupersedes.push(req)
        }
        return { ok: true, revision: 1 }
      },
      writeLegacy: async () => ({ ok: true }),
      queueRead: async () => "",
      queueWrite: async () => {},
    }
    const deps = makeFsDeps(
      {
        1: snapshotJson(1, ["林舟的境界是练气一层"]),
        5: snapshotJson(5, ["林舟的境界是筑基期"]),
      },
      dualWrite,
    )

    const report = await backfillCanonHistory(deps, PROJECT, {}, 1_000)
    expect(report.consistent).toBe(true)
    expect(capturedSupersedes).toHaveLength(2)

    const ch1Req = capturedSupersedes[0]!
    const ch5Req = capturedSupersedes[1]!
    expect(ch1Req.old_edge_ids).toEqual([])
    expect(ch1Req.new_edges[0]!.id).toMatch(/^ch1-wf-[0-9a-f]{12}$/)
    expect(ch5Req.cap_chapter).toBe(5)
    expect(ch5Req.old_edge_ids).toEqual([ch1Req.new_edges[0]!.id])
    expect(ch5Req.new_edges[0]!.target_id).toBe("筑基期")
  })

  it("2. 真实 checkCanonPreWrite(block 模式) 下 backfillCanonHistory + activateCanonDualMigration 全绿激活 dual 且不触发 block_endpoint_conflict", async () => {
    const db = installInMemoryCanonInvokeMock()
    const prevMode = useWikiStore.getState().novelConfig.preWriteGateMode
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    try {
      const dualWrite: CanonDualWriteDeps = {
        writeCanon: canonStoreWriter,
        writeLegacy: async () => ({ ok: true }),
        queueRead: async () => "",
        queueWrite: async () => {},
      }
      const backfill = makeFsDeps(
        {
          1: snapshotJson(1, ["林舟的境界是练气一层", "林舟的佩剑是铁剑"]),
          5: snapshotJson(5, ["林舟的境界是筑基期"]),
        },
        dualWrite,
      )
      const setMigrationMode = vi.fn<ActivateCanonDualMigrationDeps["setMigrationMode"]>(async () =>
        makeDualStatus("dual"),
      )

      const activation = await activateCanonDualMigration(
        PROJECT,
        {
          backfill,
          loadStatus: async () => makeDualStatus(undefined),
          setMigrationMode,
          loadPending: async () => [],
        },
        { now: 1_700_000_000_000 },
      )

      expect(activation.activated).toBe(true)
      expect(activation.reason).toBe("activated")
      expect(activation.currentMode).toBe("dual")
      expect(activation.backfillReport?.consistent).toBe(true)
      expect(activation.backfillReport?.factsQueued).toBe(0)

      const ch1Realm = db.edges.find((e) => e.source_id === "林舟" && e.predicate === "境界" && e.target_id === "练气一层")
      const ch5Realm = db.edges.find((e) => e.source_id === "林舟" && e.predicate === "境界" && e.target_id === "筑基期")
      const ch1Sword = db.edges.find((e) => e.source_id === "林舟" && e.predicate === "佩剑" && e.target_id === "铁剑")
      expect(ch1Realm).toBeDefined()
      expect(ch1Realm!.invalid_at).toBe(5)
      expect(ch5Realm).toBeDefined()
      expect(ch5Realm!.valid_at).toBe(5)
      expect(ch5Realm!.invalid_at).toBeNull()
      expect(ch1Sword).toBeDefined()
      expect(ch1Sword!.invalid_at).toBeNull()
    } finally {
      useWikiStore.getState().setNovelConfig({ preWriteGateMode: prevMode })
    }
  })

  it("3. 修订章重回填在 block 模式下干净封顶被替换的同章旧 world_fact 边，且绝不自封同章内多条独立事实", async () => {
    const db = installInMemoryCanonInvokeMock()
    const prevMode = useWikiStore.getState().novelConfig.preWriteGateMode
    useWikiStore.getState().setNovelConfig({ preWriteGateMode: "block" })
    try {
      const dualWrite: CanonDualWriteDeps = {
        writeCanon: canonStoreWriter,
        writeLegacy: async () => ({ ok: true }),
        queueRead: async () => "",
        queueWrite: async () => {},
      }

      // 初次回填第 1 章（两条不同谓词的事实）
      const depsRun1 = makeFsDeps(
        { 1: snapshotJson(1, ["林舟的境界是练气一层", "林舟的佩剑是铁剑"]) },
        dualWrite,
      )
      const r1 = await backfillCanonHistory(depsRun1, PROJECT, {}, 1_000)
      expect(r1.consistent).toBe(true)
      const oldRealmEdge = db.edges.find((e) => e.predicate === "境界" && e.target_id === "练气一层")!
      const swordEdge = db.edges.find((e) => e.predicate === "佩剑" && e.target_id === "铁剑")!
      expect(oldRealmEdge.invalid_at).toBeNull()
      expect(swordEdge.invalid_at).toBeNull()

      // 修订第 1 章：境界改为练气二层，佩剑保持铁剑不变 → 重跑回填应封顶旧境界边且不碰佩剑边
      vi.mocked(CanonGraphClient.queryEpisodesByChapter).mockResolvedValue({
        episodes: db.episodes.map((ep) => ({ ...ep })),
        total: db.episodes.length,
        max_revision: db.revision,
      })
      const depsRun2 = makeFsDeps(
        { 1: snapshotJson(1, ["林舟的境界是练气二层", "林舟的佩剑是铁剑"]) },
        dualWrite,
      )
      const r2 = await backfillCanonHistory(depsRun2, PROJECT, {}, 2_000)
      expect(r2.consistent).toBe(true)
      expect(r2.factsQueued).toBe(0)

      expect(oldRealmEdge.invalid_at).toBe(1)
      const newRealmEdge = db.edges.find((e) => e.predicate === "境界" && e.target_id === "练气二层")!
      expect(newRealmEdge).toBeDefined()
      expect(newRealmEdge.invalid_at).toBeNull()
      expect(swordEdge.invalid_at).toBeNull()

      // 纯函数边界验证：同一快照内两条不同事实即使同 (source_id, predicate) 也绝不互相封顶
      const sameChapterSnap = JSON.parse(snapshotJson(2, ["林舟持有黑剑", "林舟持有玉佩"]))
      const firstOps = await buildBackfillOps(sameChapterSnap)
      const wfEdgesFromSnap = firstOps
        .filter((o) => o.canonPayload.kind === "supersede")
        .map((o) => (o.canonPayload as { kind: "supersede"; request: { new_edges: RawCanonEdge[] } }).request.new_edges[0]!)
      const preExistingStale: RawCanonEdge = {
        id: "ch2-wf-stale0000001",
        source_id: "林舟",
        target_id: "残剑",
        predicate: "持有",
        edge_kind: "world_fact",
        valid_at: 2,
        invalid_at: null,
        modality: "assertive",
        archived: false,
      }
      const rerunOps = await buildBackfillOps(sameChapterSnap, {
        existingEdges: [...wfEdgesFromSnap, preExistingStale],
        includeSameChapterConflict: true,
      })
      const rerunWfReqs = rerunOps
        .filter((o) => o.canonPayload.kind === "supersede")
        .map((o) => (o.canonPayload as { kind: "supersede"; request: { old_edge_ids: string[] } }).request)
      for (const req of rerunWfReqs) {
        // 只封顶已移除的旧边 preExistingStale，绝不自封同快照中的另一条活跃边
        expect(req.old_edge_ids).toEqual(["ch2-wf-stale0000001"])
      }
    } finally {
      useWikiStore.getState().setNovelConfig({ preWriteGateMode: prevMode })
    }
  })
})
