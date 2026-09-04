/**
 * E-03 (run-execute-1, 双库架构蓝图) 验收③ — truth_fold_drift spec。
 *
 * 共识 C-8：computeTruthFoldDrift 归属 chapter-ingest.ts 锚点（rebuild 的只读
 * 副产品）；live 盘上 store vs 从 committed snapshot 序列重放 store 的稳定哈希
 * 比对；drifted = liveHash !== replayHash；任一类 drifted → truth_fold_drift > 0。
 *
 * live 基准由「与 rebuild 同源的 fold 函数」构造（live == replay 的定义），
 * 篡改任一 live store 后 drift 必须 > 0。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
  listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
  fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
}))

import { computeTruthFoldDrift } from "./chapter-ingest"
import {
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
  applyEmotionalArcsToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
} from "./chapter-ingest"
import { appendMeetingEdge, foldMeetingEdges, createEmptyEncounterMatrixStore } from "./encounter-matrix"
import { upsertChapterSummary, foldChapterSummary, createEmptyChapterSummariesStore } from "./chapter-summaries"
import { appendParticleEntry, foldParticleEntries, createEmptyParticleLedgerStore } from "./particle-ledger"
import { createEmptyCharacterStateStore } from "./character-state"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import { createEmptySubplotBoardStore } from "./subplot-board"
import { emptyCognitionState, mergeCognitionFromSnapshot } from "./character-cognition"
import type { ChapterSnapshot } from "./chapter-ingest"

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

const NOW = "2026-09-04T00:00:00.000Z"

/** 与 computeTruthFoldDrift 内部重放同源的 fold 构造（live == replay 基准）。 */
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
    "character-states.json": characterStates,
    "cognition-state.json": cognition,
    "encounter-matrix.json": matrix,
    "foreshadowing-tracker.json": foreshadowing,
    "chapter-summaries.json": summaries,
    "subplot-board.json": subplotBoard,
    "emotional-arcs.json": emotionalArcs,
    "particle-ledger.json": particles,
    "resource-ledger.json": resourceLedger,
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

describe("E-03 computeTruthFoldDrift（truth_fold_drift 可执行定义）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.listDirectory.mockReset()
  })

  it("live == 快照重放 → 9 类全部 drifted=false（drift=0）", async () => {
    installFs(makeFileMap(buildReplayStores()))
    const results = await computeTruthFoldDrift("P", NOW)
    expect(results).toHaveLength(9)
    for (const r of results) {
      expect(r.drifted, `${r.file} drifted`).toBe(false)
      expect(r.liveHash).toBe(r.replayHash)
    }
  })

  it("live 被篡改（多一条角色）→ 对应类 drifted=true，其余类不受影响", async () => {
    const stores = buildReplayStores()
    const chars = (stores["character-states.json"] as { characters: unknown[] }).characters
    chars.push({ characterName: "丙", currentLocation: "", status: "新", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 1, lastSeenChapter: 1, lastUpdatedAt: "" })
    installFs(makeFileMap(stores))
    const results = await computeTruthFoldDrift("P", NOW)
    const char = results.find((r) => r.file === "character-states.json")
    expect(char?.drifted).toBe(true)
    expect(char?.liveHash).not.toBe(char?.replayHash)
    for (const r of results.filter((x) => x.file !== "character-states.json")) {
      expect(r.drifted).toBe(false)
    }
  })

  it("lastUpdated 墙钟差异不构成 drift（canonicalizeForHash 剔除易变元数据）", async () => {
    const stores = buildReplayStores()
    stores["encounter-matrix.json"] = {
      ...(stores["encounter-matrix.json"] as object),
      lastUpdated: "2099-01-01T00:00:00.000Z",
    }
    installFs(makeFileMap(stores))
    const results = await computeTruthFoldDrift("P", NOW)
    for (const r of results) expect(r.drifted).toBe(false)
  })

  it("无 snapshot → 空重放；live 为空 store 时 drift=0", async () => {
    // 9 类空 store（与空重放同构）；cognition 的 onMissing:"null" 语义下
    // 缺文件 live=null ≠ 空重放，故显式写空文件。
    const empty: Record<string, unknown> = {
      "character-states.json": createEmptyCharacterStateStore(),
      "cognition-state.json": emptyCognitionState(),
      "encounter-matrix.json": createEmptyEncounterMatrixStore(),
      "foreshadowing-tracker.json": createEmptyForeshadowingStore(),
      "chapter-summaries.json": createEmptyChapterSummariesStore(),
      "subplot-board.json": createEmptySubplotBoardStore(),
      "emotional-arcs.json": createEmptyEmotionalArcStore(),
      "particle-ledger.json": createEmptyParticleLedgerStore(),
      "resource-ledger.json": createEmptyResourceLedgerStore(),
    }
    const files = new Map<string, string>()
    for (const [rel, store] of Object.entries(empty)) {
      files.set(`P/.novel/${rel}`, JSON.stringify(store))
    }
    installFs(files)
    const results = await computeTruthFoldDrift("P", "")
    expect(results).toHaveLength(9)
    for (const r of results) expect(r.drifted).toBe(false)
  })
})
