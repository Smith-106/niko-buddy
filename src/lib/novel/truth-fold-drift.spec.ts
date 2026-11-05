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

import { autoRepairTruthFoldDrift, computeTruthFoldDrift, sampleTruthFoldDrift, emitTruthFoldDriftAlarm } from "./chapter-ingest"
// 未 fold 6 类采样未经 barrel 转出（仅 sync 内部调用）；直接引子模块做行为测试。
import { sampleUnfoldedMemoryDriftSuspected } from "./chapter-ingest-drift"
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

describe("P2-IMP-06 sampleTruthFoldDrift + emitTruthFoldDriftAlarm", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.listDirectory.mockReset()
  })

  it("健康（drift=0）→ sample.driftCount=0；emit 不告警、零 telemetry 写入", async () => {
    installFs(makeFileMap(buildReplayStores()))
    const sample = await sampleTruthFoldDrift("P", NOW)
    expect(sample).not.toBeNull()
    expect(sample!.driftCount).toBe(0)
    fsMocks.writeFileAtomic.mockClear()
    const alarmed = await emitTruthFoldDriftAlarm("P", sample)
    expect(alarmed).toBe(false)
    // drift=0 → 不写任何 telemetry drift 文件
    const telemetryCalls = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      String(c[0]).includes("/.novel/telemetry/drift-"),
    )
    expect(telemetryCalls).toHaveLength(0)
  })

  it("篡改 store → sample.driftCount>0；emit 告警 + telemetry 追加 drift-<ts>.jsonl", async () => {
    const stores = buildReplayStores()
    const chars = (stores["character-states.json"] as { characters: unknown[] }).characters
    chars.push({ characterName: "丙", currentLocation: "", status: "新", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 1, lastSeenChapter: 1, lastUpdatedAt: "" })
    installFs(makeFileMap(stores))
    const sample = await sampleTruthFoldDrift("P", NOW)
    expect(sample!.driftCount).toBeGreaterThan(0)
    expect(sample!.driftedFiles).toContain("character-states.json")
    fsMocks.writeFileAtomic.mockClear()
    const alarmed = await emitTruthFoldDriftAlarm("P", sample)
    expect(alarmed).toBe(true)
    const telemetryCalls = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      String(c[0]).includes("/.novel/telemetry/drift-"),
    )
    expect(telemetryCalls).toHaveLength(1)
    expect(String(telemetryCalls[0][0])).toMatch(/drift-.*\.jsonl$/)
  })

  it("采样异常 → sample 返回 null（不阻断）；emit(null) → false（N/A 不告警）", async () => {
    // 让 snapshot 读取失败 → computeTruthFoldDrift 抛错 → sample 吞掉返回 null
    fsMocks.readFile.mockRejectedValue(new Error("boom"))
    fsMocks.listDirectory.mockRejectedValue(new Error("boom"))
    const sample = await sampleTruthFoldDrift("P", NOW)
    expect(sample).toBeNull()
    const alarmed = await emitTruthFoldDriftAlarm("P", null)
    expect(alarmed).toBe(false)
  })
})

// ============================================================================
// 覆盖增补：未 fold 6 类定向采样 + telemetry 失败非致命 + 自愈全路径。
// （P2-IMP-08 采样 / P2-IMP-06 告警落盘 / P2-IMP-15 自动修复）
// ============================================================================

/** sync 直写类（cognition/character/foreshadow）之外的 6 类未 fold 采样对象。 */
function tamperChapterSummaries(liveStores: Record<string, unknown>): void {
  const store = liveStores["chapter-summaries.json"] as {
    entries: Array<{ summary: string }>
    lastUpdated: string
  }
  expect(store.entries.length).toBeGreaterThan(0)
  store.entries[0]!.summary = "被篡改的摘要（模拟 fold 漏写）"
}

function tamperCharacterStatesForRepair(liveStores: Record<string, unknown>): void {
  const store = liveStores["character-states.json"] as { characters: unknown[] }
  store.characters.push({
    characterName: "丙", currentLocation: "", status: "新", equipment: [], abilities: [],
    relationships: {}, lastUpdatedChapter: 1, lastSeenChapter: 1, lastUpdatedAt: "",
  })
}

describe("P2-IMP-08 sampleUnfoldedMemoryDriftSuspected（只采未 fold 的 6 类）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.listDirectory.mockReset()
  })

  it("未 fold 类漂移 → 报该文件；sync 直写类漂移 → 不报（采样域边界）", async () => {
    const stores = buildReplayStores()
    tamperChapterSummaries(stores)
    tamperCharacterStatesForRepair(stores)
    installFs(makeFileMap(stores))

    const suspected = await sampleUnfoldedMemoryDriftSuspected("P")

    // chapter-summaries 未 fold → 报；character 是 sync 直写类 → 由 sync 路径自身兜底，不在此报。
    expect(suspected).toEqual(["chapter-summaries.json"])
  })

  it("采样抛错 → 回 [] 且不阻断（债务记 trace）", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("boom"))
    fsMocks.listDirectory.mockRejectedValue(new Error("boom"))
    expect(await sampleUnfoldedMemoryDriftSuspected("P")).toEqual([])
  })
})

describe("P2-IMP-06 emitTruthFoldDriftAlarm：telemetry 写失败非致命", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.listDirectory.mockReset()
  })

  it("drift>0 且落盘失败 → 仍返 true（告警已发，不因 telemetry 失败反向吞掉告警）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    const alarmed = await emitTruthFoldDriftAlarm("P", {
      driftCount: 1,
      driftedFiles: ["character-states.json"],
    })
    expect(alarmed).toBe(true)
    const wroteTelemetry = fsMocks.writeFileAtomic.mock.calls.some((call) =>
      String(call[0]).includes("/.novel/telemetry/drift-"),
    )
    expect(wroteTelemetry).toBe(true)
  })
})

describe("P2-IMP-15 autoRepairTruthFoldDrift 覆盖增补：自愈落盘失败 / 复测不可用", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.listDirectory.mockReset()
  })

  it("自愈 telemetry 写失败 → 修复结论仍返回（非致命）；trigger 缺省记 unknown", async () => {
    const stores = buildReplayStores()
    tamperCharacterStatesForRepair(stores)
    const files = makeFileMap(stores)
    installFs(files)
    const realWrite = fsMocks.writeFileAtomic.getMockImplementation()!
    fsMocks.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      if (String(path).includes("/.novel/telemetry/selfheal-")) throw new Error("telemetry boom")
      return realWrite(path, content)
    })

    const result = await autoRepairTruthFoldDrift("P", { now: NOW })

    expect(result.attempted).toBe(true)
    expect(result.driftBefore).toBe(1)
    expect(result.driftAfter).toBe(0)
    expect(result.repairedFiles).toEqual(["character-states.json"])
    expect(result.escalated).toBe(false)
    // 重建确实落盘（telemetry 失败不影响修复本身）。
    const rewrittenRaw = files.get("P/.novel/character-states.json")
    expect(typeof rewrittenRaw).toBe("string")
    const rewritten = JSON.parse(rewrittenRaw!) as { characters: unknown[] }
    expect(rewritten.characters).toHaveLength(1)
    // selfheal telemetry 被拒 → 无 selfheal 文件（也不抛）。
    expect([...files.keys()].some((p) => p.includes("/.novel/telemetry/selfheal-"))).toBe(false)
  })

  it("复测不可用（第二次采样抛错）→ driftAfter 回退 repair 前计数并按升级告警", async () => {
    const stores = buildReplayStores()
    tamperCharacterStatesForRepair(stores)
    const files = makeFileMap(stores)
    installFs(files)
    const realRead = fsMocks.readFile.getMockImplementation()!
    let characterReads = 0
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/character-states.json")) {
        characterReads += 1
        // 第 1 次 = 修复前采样（正常）；第 2 次 = 复测 → 磁盘损坏（fileVersion 越界 fail-loud）
        if (characterReads >= 2) return JSON.stringify({ fileVersion: 999, characters: [] })
      }
      return realRead(path)
    })

    const result = await autoRepairTruthFoldDrift("P", { now: NOW, trigger: "restore" })

    expect(result.attempted).toBe(true)
    expect(result.driftBefore).toBe(1)
    expect(result.driftAfter).toBe(1)
    expect(result.repairedFiles).toEqual([])
    expect(result.stillDriftedFiles).toEqual(["character-states.json"])
    expect(result.error).toBeUndefined()
    // 复测不可用 → 不假装自愈（按升级处理）。
    expect(result.escalated).toBe(true)
    expect([...files.keys()].some((p) => p.includes("/.novel/telemetry/drift-"))).toBe(true)
  })
})
