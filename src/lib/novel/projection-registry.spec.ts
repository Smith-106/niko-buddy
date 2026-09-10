/**
 * P2-IMP-14 投影注册表 spec — 三方键集等值（CI fail-loud）+ 四路径同源遍历。
 *
 * 共识落点（findings P2-IMP-14）：
 *   1. PROJECTION_REGISTRY 键集 == PROJECTION_CATEGORIES 键集 == runProjection
 *      实际调用 id 集（注册表 ⊇ 调用集，store-fold 条目 ⊆ 调用集）三方等值；
 *   2. 9 个 store-backed fold_rebuildable 入表（全套 load/save/createEmpty/
 *      applyToStore/foldFromSnapshot）；graph/vector/community 标 non-rebuildable；
 *   3. 四路径（ingest 增量 / rebuild 重放 / drift 重放 / sync）同源遍历注册表 —
 *      drift 比对文件集合 == 注册表 store 文件集合 == rebuild 写盘文件集合，
 *      F5 类「某路径漏投影」缺陷结构上绝迹；
 *   4. registerProjections 注册即校验（cognee fail-loud）：未知 id / 类别分叉 /
 *      重复注册 / rebuildable 但类别非 fold_rebuildable 一律抛错。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NOVEL_DIR = resolve(__dirname)
function readSource(): string {
  return readFileSync(resolve(NOVEL_DIR, "chapter-ingest.ts"), "utf-8")
}

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (...args: unknown[]) => fsMocks.readFile(...args),
      writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
      listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
      fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
      createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
      deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
    
  }
})

import {
  PROJECTION_CATEGORIES,
  PROJECTION_REGISTRY,
  assertProjectionRegistryComplete,
  foldStoreRegistryEntries,
  isAutoRebuildableProjection,
  rebuildableRegistryEntries,
  registerProjections,
  syncDirectWriteProjectionIds,
} from "./projection-status-ledger"
// 导入 chapter-ingest 即触发注册表填充（registerProjections 在模块加载时执行）。
import {
  applyCharacterStateChangesToStore,
  applyEmotionalArcsToStore,
  applyForeshadowingChangesToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
  computeTruthFoldDrift,
  rebuildDerivedMemoryFromSnapshots,
  type ChapterSnapshot,
} from "./chapter-ingest"
import { createEmptyCharacterStateStore } from "./character-state"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import { emptyCognitionState, mergeCognitionFromSnapshot } from "./character-cognition"
import { appendMeetingEdge, createEmptyEncounterMatrixStore, foldMeetingEdges } from "./encounter-matrix"
import { createEmptyChapterSummariesStore, foldChapterSummary, upsertChapterSummary } from "./chapter-summaries"
import { appendParticleEntry, createEmptyParticleLedgerStore, foldParticleEntries } from "./particle-ledger"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import { createEmptySubplotBoardStore } from "./subplot-board"
import { truthStoreHash } from "./projection-store"

const SNAPSHOT: ChapterSnapshot = {
  chapterId: "ch-1",
  chapterNumber: 1,
  summary: "主角抵达都城",
  characters: ["甲", "乙"],
  locations: ["都城"],
  organizations: [],
  items: ["玉佩"],
  events: ["甲与乙在客栈会面"],
  characterStateChanges: ["甲：受伤"],
  relationshipChanges: ["甲-乙：结盟"],
  knowledgeChanges: ["甲得知密道"],
  foreshadowingChanges: ["新增伏笔：玉佩"],
  newCanonFacts: ["都城有密道"],
  timelineEvents: [],
  conflicts: [],
  endingHook: "玉佩发光",
  graphNodes: [],
  graphEdges: [],
  itemDetails: { 玉佩: { holder: "甲", previousHolders: "", abilities: "", limitations: "", origin: "" } },
}

const NOW = "2026-09-06T00:00:00.000Z"

/** 注册表 9 个 store-backed fold 投影的期望文件集合（drift 9 类）。 */
const EXPECTED_STORE_FILES = [
  "cognition-state.json",
  "character-states.json",
  "foreshadowing-tracker.json",
  "emotional-arcs.json",
  "resource-ledger.json",
  "subplot-board.json",
  "encounter-matrix.json",
  "chapter-summaries.json",
  "particle-ledger.json",
]

/** 与 truth-fold-drift.spec 同源的 live 基准构造（fold 函数直调 = 重放定义）。 */
function buildReplayStores(): Record<string, unknown> {
  const foldCtx = { now: NOW }
  const characterStates = createEmptyCharacterStateStore()
  applyCharacterStateChangesToStore(characterStates, SNAPSHOT, undefined, foldCtx)
  const cognition = mergeCognitionFromSnapshot(emptyCognitionState(), SNAPSHOT, undefined)
  let matrix = createEmptyEncounterMatrixStore()
  for (const edge of foldMeetingEdges(SNAPSHOT, undefined)) matrix = appendMeetingEdge(matrix, edge, foldCtx)
  const foreshadowing = createEmptyForeshadowingStore()
  applyForeshadowingChangesToStore(foreshadowing, SNAPSHOT, foldCtx)
  let summaries = createEmptyChapterSummariesStore()
  summaries = upsertChapterSummary(summaries, foldChapterSummary(SNAPSHOT), foldCtx)
  const subplotBoard = createEmptySubplotBoardStore()
  applySubplotChangesToStore(subplotBoard, SNAPSHOT, foldCtx)
  const emotionalArcs = createEmptyEmotionalArcStore()
  applyEmotionalArcsToStore(emotionalArcs, SNAPSHOT, undefined, foldCtx)
  let particles = createEmptyParticleLedgerStore()
  for (const entry of foldParticleEntries(SNAPSHOT, undefined)) particles = appendParticleEntry(particles, entry, foldCtx)
  const resourceLedger = createEmptyResourceLedgerStore()
  applyResourceLedgerToStore(resourceLedger, SNAPSHOT, undefined, foldCtx)
  return {
    "cognition-state.json": cognition,
    "character-states.json": characterStates,
    "foreshadowing-tracker.json": foreshadowing,
    "emotional-arcs.json": emotionalArcs,
    "resource-ledger.json": resourceLedger,
    "subplot-board.json": subplotBoard,
    "encounter-matrix.json": matrix,
    "chapter-summaries.json": summaries,
    "particle-ledger.json": particles,
  }
}

function makeFileMap(liveStores: Record<string, unknown>) {
  const files = new Map<string, string>()
  files.set("P/.novel/snapshots/001.snapshot.json", JSON.stringify(SNAPSHOT))
  for (const [rel, store] of Object.entries(liveStores)) {
    files.set(`P/.novel/${rel}`, JSON.stringify(store))
  }
  return files
}

function installFs(files: Map<string, string>) {
  fsMocks.readFile.mockImplementation(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
    return files.get(p)
  })
  fsMocks.writeFileAtomic.mockImplementation(async (p: string, content: string) => {
    files.set(p, content)
  })
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.deleteFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockImplementation(async (p: string) => files.has(p))
  fsMocks.listDirectory.mockImplementation(async (p: string) => {
    const prefix = p.endsWith("/") ? p : p + "/"
    const names = [...files.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((n) => !n.includes("/"))
    if (names.length === 0) throw new Error(`ENOENT: ${p}`)
    return names.map((name) => ({ name, path: prefix + name, is_dir: false }))
  })
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.listDirectory.mockReset()
})

describe("P2-IMP-14 注册表三方键集等值（CI fail-loud）", () => {
  it("注册表键集 == PROJECTION_CATEGORIES 键集（双向等值，assertProjectionRegistryComplete 不抛）", () => {
    expect(() => assertProjectionRegistryComplete()).not.toThrow()
    const registryKeys = new Set(Object.keys(PROJECTION_REGISTRY))
    const categoryKeys = new Set(Object.keys(PROJECTION_CATEGORIES))
    expect([...categoryKeys].sort()).toEqual([...registryKeys].sort())
  })

  it("runProjection 实际调用 id 集 ⊆ 注册表键集（字面调用点扫描 + 注册表遍历循环结构）", () => {
    const src = readSource()
    const called = new Set<string>()
    for (const m of src.matchAll(/runProjection\("([^"]+)"/g)) called.add(m[1]!)
    // 字面调用集（非 store 投影：vector/graph/patch/summary/sync）全部入表。
    expect(called.size).toBeGreaterThan(0)
    for (const id of called) {
      expect(PROJECTION_REGISTRY[id], `runProjection("${id}") 未入注册表`).toBeTruthy()
    }
    // 9 个 store-fold id 改由注册表遍历循环调用（runProjection(projection, …)）——
    // 遍历循环必须存在且以 store 能力四件套为门槛（注册即被 ingest 调用，
    // F5 反向分叉「注册了但没人跑」结构上不可能）。
    const ingestIdx = src.indexOf("const runProjection = async")
    expect(ingestIdx).toBeGreaterThan(-1)
    const ingestBlock = src.slice(ingestIdx, src.indexOf("finally {", ingestIdx))
    expect(ingestBlock).toMatch(/Object\.entries\(PROJECTION_REGISTRY\)/)
    expect(ingestBlock).toMatch(/if \(!entry\.applyToStore \|\| !entry\.load \|\| !entry\.save \|\| !entry\.createEmpty\) continue/)
    expect(ingestBlock).toMatch(/await runProjection\(projection, /)
    // 行为等值（ingest 实跑账本 ⊇ 9 fold id）见 projection-self-heal.spec.ts 集成用例。
  })

  it("9 个 store-backed fold_rebuildable 入表（全套 load/save/createEmpty/applyToStore/foldFromSnapshot）", () => {
    const entries = foldStoreRegistryEntries()
    expect(entries).toHaveLength(9)
    expect(entries.map(([id]) => id).sort()).toEqual([
      "chapter_summaries", "character", "cognition", "emotional_arc", "encounter_matrix",
      "foreshadow", "particle_ledger", "resource_ledger", "subplot_board",
    ])
    const files = entries.map(([, e]) => e.file).sort()
    expect(files).toEqual([...EXPECTED_STORE_FILES].sort())
    for (const [id, entry] of entries) {
      expect(entry.category, id).toBe("fold_rebuildable")
      expect(entry.rebuildable, id).toBe(true)
      expect(entry.load, id).toBeTypeOf("function")
      expect(entry.save, id).toBeTypeOf("function")
      expect(entry.createEmpty, id).toBeTypeOf("function")
      expect(entry.applyToStore, id).toBeTypeOf("function")
      expect(entry.foldFromSnapshot, id).toBeTypeOf("function")
    }
  })

  it("graph/vector/community 标 non-rebuildable；snapshot/chapter_ingest_output 提交点同样 false", () => {
    for (const id of ["vector", "graph_entity_pages", "graph_entity_patch_fields", "community_summary", "snapshot", "chapter_ingest_output"]) {
      const entry = PROJECTION_REGISTRY[id]
      expect(entry, id).toBeTruthy()
      expect(entry.rebuildable, id).toBe(false)
      expect(entry.file, id).toBeNull()
      expect(isAutoRebuildableProjection(id), id).toBe(false)
    }
    // sync_snapshot_to_memory 是复合用户路径（快照物化 + 实体页），rebuild 不等价
    // 于重放该路径 → fold_rebuildable 类别但 rebuildable:false（failed 保留可见）。
    expect(PROJECTION_REGISTRY.sync_snapshot_to_memory.category).toBe("fold_rebuildable")
    expect(PROJECTION_REGISTRY.sync_snapshot_to_memory.rebuildable).toBe(false)
    // summary_structured_memory 经 rebuildFromSnapshots 钩子确定性重建 → rebuildable。
    expect(PROJECTION_REGISTRY.summary_structured_memory.rebuildable).toBe(true)
    expect(PROJECTION_REGISTRY.summary_structured_memory.rebuildFromSnapshots).toBeTypeOf("function")
    // rebuildable 遍历集 = 9 store + summary_structured_memory = 10。
    expect(rebuildableRegistryEntries()).toHaveLength(10)
  })

  it("registerProjections 注册即校验（cognee fail-loud）：未知 id / 类别分叉 / 重复注册 / rebuildable 越类一律抛", () => {
    expect(() =>
      registerProjections({ no_such_projection: { category: "fold_rebuildable", rebuildable: false, file: null } }),
    ).toThrow(/unknown projection/)
    expect(() =>
      registerProjections({ vector: { category: "fold_rebuildable", rebuildable: false, file: null } }),
    ).toThrow(/category mismatch/)
    expect(() =>
      registerProjections({ cognition: { category: "fold_rebuildable", rebuildable: false, file: null } }),
    ).toThrow(/duplicate registration/)
    expect(() =>
      registerProjections({
        community_summary: { category: "mutates_existing_non_rebuildable", rebuildable: true, file: null },
      }),
    ).toThrow(/only fold_rebuildable/)
  })
})

describe("P2-IMP-14 四路径同源遍历注册表（行为等值）", () => {
  it("drift 重放路径：比对文件集合 == 注册表 store 文件集合（9 类）", async () => {
    installFs(makeFileMap(buildReplayStores()))
    const results = await computeTruthFoldDrift("P", NOW)
    expect(results.map((r) => r.file).sort()).toEqual([...EXPECTED_STORE_FILES].sort())
    for (const r of results) expect(r.drifted, r.file).toBe(false)
  })

  it("rebuild 路径：写盘覆盖全部 9 个注册表 store 文件，且 rebuild 后 drift=0（同源闭环）", async () => {
    // live 篡改 → drift>0；rebuild 后 9 类全部重写且 drift 归零。
    const stores = buildReplayStores()
    const chars = (stores["character-states.json"] as { characters: unknown[] }).characters
    chars.push({
      characterName: "丙", currentLocation: "", status: "新", equipment: [], abilities: [],
      relationships: {}, lastUpdatedChapter: 1, lastSeenChapter: 1, lastUpdatedAt: "",
    })
    const files = makeFileMap(stores)
    installFs(files)
    const before = await computeTruthFoldDrift("P", "")
    expect(before.filter((r) => r.drifted).map((r) => r.file)).toContain("character-states.json")

    await rebuildDerivedMemoryFromSnapshots("P")
    const written = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    for (const file of EXPECTED_STORE_FILES) {
      expect(written.some((p) => p.endsWith(`.novel/${file}`)), `rebuild 未写 ${file}`).toBe(true)
    }
    const after = await computeTruthFoldDrift("P", "")
    for (const r of after) expect(r.drifted, r.file).toBe(false)
  })

  it("注册表 fold 与共享 helper 同源：applyToStore 输出 == 直调 helper 输出（哈希等值）", async () => {
    const viaHelper = createEmptyCharacterStateStore()
    applyCharacterStateChangesToStore(viaHelper, SNAPSHOT, undefined, { now: NOW })
    const entry = PROJECTION_REGISTRY.character
    const viaRegistry = entry.applyToStore!(entry.createEmpty!({ now: NOW }), SNAPSHOT, { now: NOW })
    expect(await truthStoreHash(viaRegistry)).toBe(await truthStoreHash(viaHelper))

    const fsHelper = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(fsHelper, SNAPSHOT, { now: NOW })
    const fEntry = PROJECTION_REGISTRY.foreshadow
    const viaFRegistry = fEntry.applyToStore!(fEntry.createEmpty!({ now: NOW }), SNAPSHOT, { now: NOW })
    expect(await truthStoreHash(viaFRegistry)).toBe(await truthStoreHash(fsHelper))
  })

  it("foldFromSnapshot 由 createEmpty + 逐快照 applyToStore 派生（ingest==rebuild 结构保证）", async () => {
    const entry = PROJECTION_REGISTRY.character
    const ctx = { now: NOW }
    const replay = entry.foldFromSnapshot!([SNAPSHOT], ctx)
    let manual = entry.createEmpty!(ctx)
    manual = entry.applyToStore!(manual, SNAPSHOT, ctx)
    expect(await truthStoreHash(replay)).toBe(await truthStoreHash(manual))
  })

  it("ingest 增量路径遍历注册表（源码扫描：runProjection 循环引用 PROJECTION_REGISTRY 且不再内联 9 段）", () => {
    const src = readSource()
    const ingestIdx = src.indexOf("const runProjection = async")
    expect(ingestIdx).toBeGreaterThan(-1)
    const ingestBlock = src.slice(ingestIdx, src.indexOf("finally {", ingestIdx))
    expect(ingestBlock).toMatch(/Object\.entries\(PROJECTION_REGISTRY\)/)
    // 旧版 9 段硬编码 runProjection("cognition"...) 等内联块已收敛到注册表遍历。
    for (const id of ["cognition", "character", "foreshadow", "emotional_arc", "resource_ledger", "subplot_board", "encounter_matrix", "chapter_summaries", "particle_ledger"]) {
      expect(ingestBlock.includes(`runProjection("${id}"`), `ingest 仍内联 ${id} 硬编码块`).toBe(false)
    }
  })

  it("rebuild / drift 路径遍历注册表（源码扫描：硬编码 9 段已收敛）", () => {
    const src = readSource()
    const rebuildIdx = src.indexOf("async function rebuildFromCommittedSnapshot")
    expect(rebuildIdx).toBeGreaterThan(-1)
    const rebuildBlock = src.slice(rebuildIdx, src.indexOf("export async function rebuildDerivedMemoryFromSnapshots"))
    expect(rebuildBlock).toMatch(/rebuildRegistryProjections\(projectPath, snapshots, foldCtx\)/)
    // 旧版逐类 save 不再出现（cognition 等经注册表统一 save）。
    expect(rebuildBlock).not.toMatch(/await saveCognitionState\(projectPath/)
    expect(rebuildBlock).not.toMatch(/await writeStructuredMemoryDocuments\(projectPath, snapshots\)/)

    const driftIdx = src.indexOf("export async function computeTruthFoldDrift")
    const driftBlock = src.slice(driftIdx, src.indexOf("export async function sampleTruthFoldDrift"))
    expect(driftBlock).toMatch(/Object\.entries\(PROJECTION_REGISTRY\)/)
    expect(driftBlock).not.toMatch(/character-states\.json", live, replay/)
  })

  it("sync 路径遍历注册表 + 未 fold 文件集合由注册表派生（源码扫描）", () => {
    const src = readSource()
    expect(src).toMatch(/for \(const id of syncFoldProjectionIds\(\)\)/)
    expect(src).toMatch(/function unfoldedDriftClasses\(\): Set<string>/)
    // 旧版硬编码 UNFOLDED_DRIFT_CLASSES 字面量集合已删除。
    expect(src).not.toMatch(/const UNFOLDED_DRIFT_CLASSES = new Set\(\[/)
    // 旧版硬编码 SYNC_FOLD_PROJECTION_IDS 3 元字面量已删除（注册表派生）。
    expect(src).not.toMatch(/SYNC_FOLD_PROJECTION_IDS: readonly string\[\] = \["/)
    // sync 不再直调已删除的 syncCharacterStateChanges/syncForeshadowingChanges。
    expect(src).not.toMatch(/await syncCharacterStateChanges\(/)
    expect(src).not.toMatch(/await syncForeshadowingChanges\(/)
  })

  it("sync 直写子集由注册表 syncDirectWrite 标志派生（键集等值，消除硬编码）", () => {
    // chapter-ingest 模块加载即填充注册表；派生函数返回注册表标注 syncDirectWrite 的键。
    const derived = syncDirectWriteProjectionIds()
    expect([...derived].sort()).toEqual(["character", "cognition", "foreshadow"])
    // 反向保证：未标 syncDirectWrite 的 store 投影（如 emotional_arc/resource_ledger）不在直写子集。
    expect(derived).not.toContain("emotional_arc")
    expect(derived).not.toContain("resource_ledger")
    expect(derived).not.toContain("encounter_matrix")
    // 注册条目同步携带标志（注册表为派生函数唯一真源）。
    for (const id of derived) {
      expect(PROJECTION_REGISTRY[id].syncDirectWrite).toBe(true)
    }
  })

  it("syncDirectWrite 双向静态守卫：正向量必标 + 负向 6 类非直写显式断言（防新增投影忘标）", () => {
    const derived = new Set(syncDirectWriteProjectionIds())
    // 正向量：P2-IMP-08 边界三类必须标 flag（漏标 → 负向断言立即红）
    for (const id of ["cognition", "character", "foreshadow"]) {
      expect(derived.has(id), `sync 直写边界 ${id} 漏标 syncDirectWrite`).toBe(true)
    }
    // 负向：其余 store-backed fold_rebuildable 投影（drift 采样+自愈路径）必须显式不在直写子集
    for (const id of [
      "emotional_arc",
      "resource_ledger",
      "subplot_board",
      "encounter_matrix",
      "chapter_summaries",
      "particle_ledger",
    ]) {
      const entry = PROJECTION_REGISTRY[id]
      expect(entry?.syncDirectWrite !== true, `非直写投影 ${id} 误标 syncDirectWrite`).toBe(true)
      expect(entry?.file).toBeTruthy() // 均为 store-backed（file 非空），必须注册表兜底
    }
    // 兜底可见性：新增 store 投影若无 flag，既不会进 sync 直写也不应悄悄丢失——
    // 注册表 store 键集 == 派生直写 ∪ 负向非直写（合计键集可枚举）
    const storeIds = new Set(foldStoreRegistryEntries().map(([id]) => id))
    for (const id of storeIds) {
      expect(derived.has(id) || PROJECTION_REGISTRY[id].syncDirectWrite !== true).toBe(true)
    }
  })
})
