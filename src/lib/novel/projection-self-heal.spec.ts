/**
 * P2-IMP-14 failed 自愈 + P2-IMP-15 drift 自动修复 — 行为 spec。
 *
 * IMP-14：ingest 入口 failed && fold_rebuildable && 注册表 rebuildable →
 * 自动先经注册表 rebuild（只重建失败类）再增量；非确定性投影（graph/vector）
 * 与注册表 rebuildable:false 的 fold_rebuildable 条目（sync_snapshot_to_memory）
 * 不自动。
 *
 * IMP-15：启动/restore/delete/sync 后 drift>0 → 自动经注册表 rebuild 漂移类 →
 * 复测仍>0 才告警升级（emitTruthFoldDriftAlarm）；drift=0 零动作（误报护栏）；
 * 自愈事件写 .novel/telemetry/selfheal-<ts>.jsonl；promotion_replay_success 经
 * collectKbMetricsLive 接 promotion-bridge 凭证层真实源。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeFilesAtomic: vi.fn(),
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
      writeFilesAtomic: (...args: unknown[]) => fsMocks.writeFilesAtomic(...args),
      listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
      fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
      createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
      deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
    
  }
})

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: (...args: unknown[]) => streamChatMock(...args),
      combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
        const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
        if (signals.length === 0) return undefined
        if (signals.length === 1) return signals[0]
        const controller = new AbortController()
        for (const s of signals) {
          if (s.aborted) { controller.abort(); break }
          s.addEventListener("abort", () => controller.abort(), { once: true })
        }
        return controller.signal
      },
      DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
    
  }
})

const storeState = vi.hoisted(() => ({
  novelMode: true,
  llmConfig: { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig,
  novelConfig: {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "review-model",
  } as NovelConfig,
  embeddingConfig: { enabled: false, model: "" },
  outputLanguage: "zh-CN",
  setCommunitySummaryError: vi.fn(),
  bumpDataVersion: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return { ...actual, useWikiStore: { getState: () => storeState } }
})

const moduleMocks = vi.hoisted(() => ({
  writeSnapshotToWiki: vi.fn(),
  writePatchFieldsToWiki: vi.fn(),
  shouldRebuildCommunitySummaries: vi.fn(),
  generateCommunitySummaries: vi.fn(),
  mergeSnapshotTimeline: vi.fn(),
  removeChapterTimelineEvents: vi.fn(),
  clearGraphCache: vi.fn(),
  clearTemporalFactsCache: vi.fn(),
  buildEntityLinkIndex: vi.fn(),
  resolveEntityLink: vi.fn(),
  extractEntitySummary: vi.fn(),
  planAddOpsFromCanonFacts: vi.fn(),
  applyMemoryOps: vi.fn(),
  embedPage: vi.fn(),
  removePageEmbedding: vi.fn(),
}))

vi.mock("./graph-adapter", () => ({
  canonicalizeSnapshotCharacters: (snapshot: unknown) => snapshot,
  sanitizeEntitySlug: (name: string) => name,
  writeSnapshotToWiki: (...args: unknown[]) => moduleMocks.writeSnapshotToWiki(...args),
  writePatchFieldsToWiki: (...args: unknown[]) => moduleMocks.writePatchFieldsToWiki(...args),
  canonicalizeGraphNodeId: (_snapshot: unknown, raw: string) => raw.trim(),
  detectNodeType: () => "character",
  getCharacterNamesForMatching: (snapshot: { characterAliases?: Record<string, string[]> }, name: string) => [
    name,
    ...(snapshot.characterAliases?.[name] ?? []),
  ],
  snapshotToGraphNodes: () => [],
  snapshotToGraphEdges: () => [],
}))

vi.mock("./model-resolver", () => ({ resolveNovelModel: (cfg: unknown) => cfg }))
vi.mock("./community-summary", () => ({
  shouldRebuildCommunitySummaries: (...args: unknown[]) => moduleMocks.shouldRebuildCommunitySummaries(...args),
  generateCommunitySummaries: (...args: unknown[]) => moduleMocks.generateCommunitySummaries(...args),
}))
vi.mock("./timeline", () => ({
  mergeSnapshotTimeline: (...args: unknown[]) => moduleMocks.mergeSnapshotTimeline(...args),
  removeChapterTimelineEvents: (...args: unknown[]) => moduleMocks.removeChapterTimelineEvents(...args),
}))
vi.mock("@/lib/graph-relevance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph-relevance")>()
  return {
    ...actual,
      clearGraphCache: (...args: unknown[]) => moduleMocks.clearGraphCache(...args),
    
  }
})
vi.mock("./context-engine", () => ({
  clearTemporalFactsCache: (...args: unknown[]) => moduleMocks.clearTemporalFactsCache(...args),
}))
vi.mock("@/lib/dedup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dedup")>()
  return {
    ...actual,
      buildEntityLinkIndex: (...args: unknown[]) => moduleMocks.buildEntityLinkIndex(...args),
      resolveEntityLink: (...args: unknown[]) => moduleMocks.resolveEntityLink(...args),
      extractEntitySummary: (...args: unknown[]) => moduleMocks.extractEntitySummary(...args),
    
  }
})
vi.mock("./memory-op", () => ({
  planAddOpsFromCanonFacts: (...args: unknown[]) => moduleMocks.planAddOpsFromCanonFacts(...args),
  applyMemoryOps: (...args: unknown[]) => moduleMocks.applyMemoryOps(...args),
}))
vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
      embedPage: (...args: unknown[]) => moduleMocks.embedPage(...args),
      removePageEmbedding: (...args: unknown[]) => moduleMocks.removePageEmbedding(...args),
    
  }
})

const promotionBridgeMock = vi.hoisted(() => ({ promotionReplaySuccessRate: vi.fn() }))
vi.mock("./promotion-bridge", () => ({
  promotionReplaySuccessRate: (...args: unknown[]) => promotionBridgeMock.promotionReplaySuccessRate(...args),
}))

import {
  autoRepairTruthFoldDrift,
  computeTruthFoldDrift,
  deleteChapterSnapshots,
  ingestChapter,
  rebuildDerivedMemoryFromSnapshots,
  selfHealFailedProjections,
  type ChapterSnapshot,
} from "./chapter-ingest"
import { readCurrentSnapshot } from "./chapter-ingest-history"
import { invalidateChapterCache } from "./chapter-utils"
import { listSnapshotEntriesWithMtime, loadAllSnapshots } from "./context-engine-temporal"
import { emptyFactsFile, saveFactsFile } from "./facts-store"
import { collectKbMetricsLive, decideDriftAlarmAfterRepair } from "./kb-observability"
import {
  applyCharacterStateChangesToStore,
  applyEmotionalArcsToStore,
  applyForeshadowingChangesToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
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

const PROJECT = "P"
const NOW = "2026-09-06T00:00:00.000Z"

const SNAPSHOT1: ChapterSnapshot = {
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

/** 与 truth-fold-drift.spec 同源的 live 基准（fold 直调 = 重放定义）。 */
function buildReplayStores(): Record<string, unknown> {
  const foldCtx = { now: NOW }
  const characterStates = createEmptyCharacterStateStore()
  applyCharacterStateChangesToStore(characterStates, SNAPSHOT1, undefined, foldCtx)
  const cognition = mergeCognitionFromSnapshot(emptyCognitionState(), SNAPSHOT1, undefined)
  let matrix = createEmptyEncounterMatrixStore()
  for (const edge of foldMeetingEdges(SNAPSHOT1, undefined)) matrix = appendMeetingEdge(matrix, edge, foldCtx)
  const foreshadowing = createEmptyForeshadowingStore()
  applyForeshadowingChangesToStore(foreshadowing, SNAPSHOT1, foldCtx)
  let summaries = createEmptyChapterSummariesStore()
  summaries = upsertChapterSummary(summaries, foldChapterSummary(SNAPSHOT1), foldCtx)
  const subplotBoard = createEmptySubplotBoardStore()
  applySubplotChangesToStore(subplotBoard, SNAPSHOT1, foldCtx)
  const emotionalArcs = createEmptyEmotionalArcStore()
  applyEmotionalArcsToStore(emotionalArcs, SNAPSHOT1, undefined, foldCtx)
  let particles = createEmptyParticleLedgerStore()
  for (const entry of foldParticleEntries(SNAPSHOT1, undefined)) particles = appendParticleEntry(particles, entry, foldCtx)
  const resourceLedger = createEmptyResourceLedgerStore()
  applyResourceLedgerToStore(resourceLedger, SNAPSHOT1, undefined, foldCtx)
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

function makeFileMap(): Map<string, string> {
  const files = new Map<string, string>()
  files.set(`${PROJECT}/.novel/snapshots/001.snapshot.json`, JSON.stringify(SNAPSHOT1))
  for (const [rel, store] of Object.entries(buildReplayStores())) {
    files.set(`${PROJECT}/.novel/${rel}`, JSON.stringify(store))
  }
  return files
}

/** 账本种子：chapters[ch][projection] = failed/committed cell。 */
function seedLedger(
  files: Map<string, string>,
  cells: Record<string, Record<string, { status: "failed" | "committed"; category: string; error?: string }>>,
): void {
  const chapters: Record<string, Record<string, unknown>> = {}
  for (const [ch, projs] of Object.entries(cells)) {
    chapters[ch] = {}
    for (const [proj, e] of Object.entries(projs)) {
      chapters[ch]![proj] = {
        projection: proj,
        category: e.category,
        status: e.status,
        updated_at: "2026-09-05T00:00:00.000Z",
        last_error: e.error ?? "",
      }
    }
  }
  files.set(`${PROJECT}/.novel/projection-status.json`, JSON.stringify({ projections: {}, chapters, auditTrail: [] }))
}

function installFs(files: Map<string, string>) {
  fsMocks.readFile.mockImplementation(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
    return files.get(p)
  })
  fsMocks.writeFileAtomic.mockImplementation(async (p: string, content: string) => {
    files.set(p, content)
  })
  // P0 #61 收敛：saveSnapshot 经 writeFilesAtomic 单次批量事务落盘；harness 逐文件
  // 经 writeFileAtomic 记账，保持 writtenPaths 顺序断言（先自愈后提交）零变更。
  fsMocks.writeFilesAtomic.mockImplementation(async (batch: Array<[string, string]>) => {
    for (const [p, content] of batch) {
      await fsMocks.writeFileAtomic(p, content)
    }
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

function writtenPaths(): string[] {
  return fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
}

function readLedger(files: Map<string, string>): {
  chapters: Record<string, Record<string, { status: string; last_error: string }>>
  auditTrail: Array<{ projection: string; chapter: number; status: string }>
} {
  return JSON.parse(files.get(`${PROJECT}/.novel/projection-status.json`) ?? "{}")
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateChapterCache()
  storeState.novelMode = true
  storeState.embeddingConfig = { enabled: false, model: "" }
  storeState.llmConfig = { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig
  storeState.novelConfig = {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "review-model",
  } as NovelConfig
  moduleMocks.writeSnapshotToWiki.mockResolvedValue([])
  moduleMocks.writePatchFieldsToWiki.mockResolvedValue([])
  moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(false)
  moduleMocks.generateCommunitySummaries.mockResolvedValue(undefined)
  moduleMocks.mergeSnapshotTimeline.mockResolvedValue(undefined)
  moduleMocks.removeChapterTimelineEvents.mockResolvedValue(undefined)
  moduleMocks.clearGraphCache.mockReturnValue(undefined)
  moduleMocks.clearTemporalFactsCache.mockReturnValue(undefined)
  moduleMocks.buildEntityLinkIndex.mockReturnValue({})
  moduleMocks.resolveEntityLink.mockReturnValue(null)
  moduleMocks.extractEntitySummary.mockReturnValue(null)
  moduleMocks.planAddOpsFromCanonFacts.mockReturnValue([])
  moduleMocks.applyMemoryOps.mockReturnValue([])
  moduleMocks.embedPage.mockResolvedValue(undefined)
  moduleMocks.removePageEmbedding.mockResolvedValue(undefined)
  promotionBridgeMock.promotionReplaySuccessRate.mockResolvedValue({ success: 1, total: 1, rate: 1 })
})

describe("P2-IMP-14 selfHealFailedProjections — failed && fold_rebuildable → 经注册表 rebuild", () => {
  it("cognition failed → 只重建该类：store 重写 + 账本 cell 改记 committed + rebuild 审计", async () => {
    const files = makeFileMap()
    // 篡改 live cognition（模拟投影失败后的脏/缺状态）并删除文件模拟半写失败。
    files.delete(`${PROJECT}/.novel/cognition-state.json`)
    seedLedger(files, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)

    const result = await selfHealFailedProjections(PROJECT)
    expect(result.attempted).toBe(true)
    expect(result.healed).toEqual(["cognition"])
    // 重建自 committed 快照序列：cognition-state.json 重新落盘且含快照知识条目。
    const written = files.get(`${PROJECT}/.novel/cognition-state.json`)
    expect(written).toBeTruthy()
    // 重建自 committed 快照：mergeCognitionFromSnapshot 解析后的知识条目落盘。
    expect(written).toContain("密道")
    // 账本：failed cell → committed（last_error 清空），auditTrail 记 rebuild 事件。
    const ledger = readLedger(files)
    expect(ledger.chapters["1"]!.cognition!.status).toBe("committed")
    expect(ledger.chapters["1"]!.cognition!.last_error).toBe("")
    expect(ledger.auditTrail.some((e) => e.projection === "cognition" && e.status === "rebuild")).toBe(true)
    // 只重建失败类：其余 8 类 store 未被触碰。
    expect(writtenPaths().filter((p) => p.endsWith("character-states.json"))).toHaveLength(0)
    expect(writtenPaths().filter((p) => p.endsWith("encounter-matrix.json"))).toHaveLength(0)
  })

  it("graph_entity_pages failed（non-rebuildable）→ 不自动重建，零动作", async () => {
    const files = makeFileMap()
    seedLedger(files, { "1": { graph_entity_pages: { status: "failed", category: "mutates_existing_non_rebuildable", error: "boom" } } })
    installFs(files)
    const result = await selfHealFailedProjections(PROJECT)
    expect(result.attempted).toBe(false)
    expect(result.healed).toEqual([])
    // 账本保留 failed 可见（未被静默改写）。
    expect(readLedger(files).chapters["1"]!.graph_entity_pages!.status).toBe("failed")
  })

  it("sync_snapshot_to_memory failed（fold_rebuildable 但注册表 rebuildable:false）→ 不自动", async () => {
    const files = makeFileMap()
    seedLedger(files, { "1": { sync_snapshot_to_memory: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)
    const result = await selfHealFailedProjections(PROJECT)
    expect(result.attempted).toBe(false)
    expect(result.healed).toEqual([])
  })

  it("账本健康（无 failed）→ attempted:false 零动作（误报护栏）", async () => {
    const files = makeFileMap()
    seedLedger(files, { "1": { cognition: { status: "committed", category: "fold_rebuildable" } } })
    installFs(files)
    const result = await selfHealFailedProjections(PROJECT)
    expect(result.attempted).toBe(false)
    expect(writtenPaths().filter((p) => p.includes(".novel/") && p.endsWith(".json") && !p.includes("projection-status"))).toHaveLength(0)
  })

  it("多类 failed（cognition + character）→ 两类都重建，其余类不碰", async () => {
    const files = makeFileMap()
    files.delete(`${PROJECT}/.novel/cognition-state.json`)
    files.delete(`${PROJECT}/.novel/character-states.json`)
    seedLedger(files, {
      "1": {
        cognition: { status: "failed", category: "fold_rebuildable", error: "boom" },
        character: { status: "failed", category: "fold_rebuildable", error: "boom" },
      },
    })
    installFs(files)
    const result = await selfHealFailedProjections(PROJECT)
    expect(result.healed.sort()).toEqual(["character", "cognition"])
    expect(files.get(`${PROJECT}/.novel/cognition-state.json`)).toBeTruthy()
    expect(files.get(`${PROJECT}/.novel/character-states.json`)).toContain("甲")
    expect(writtenPaths().some((p) => p.endsWith("foreshadowing-tracker.json"))).toBe(false)
  })

  it("summary_structured_memory failed → 经 rebuildFromSnapshots 钩子重建结构化记忆文档", async () => {
    const files = makeFileMap()
    seedLedger(files, { "1": { summary_structured_memory: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)
    const result = await selfHealFailedProjections(PROJECT)
    expect(result.healed).toEqual(["summary_structured_memory"])
    expect(writtenPaths().some((p) => p.includes("wiki/memory"))).toBe(true)
  })
})

describe("P2-IMP-14 ingest 入口自愈（集成：先 rebuild 再增量）", () => {
  function chapterContent(ch: number): string {
    return `---\ntype: chapter\nchapter_number: ${ch}\nchapter_status: final\ntitle: "第${ch}章 新局"\n---\n\n# 第${ch}章\n\n正文内容……`
  }
  function llmSnapshotJson(ch: number): Record<string, unknown> {
    return {
      chapterId: `chapter-${ch}`,
      chapterNumber: ch,
      summary: "乙抵达山寨",
      characters: ["乙", "丙"],
      locations: ["山寨"],
      organizations: [],
      items: [],
      events: ["结义"],
      characterStateChanges: ["乙：启程"],
      relationshipChanges: [],
      knowledgeChanges: ["乙得知身世"],
      foreshadowingChanges: ["新增伏笔：残图"],
      newCanonFacts: [],
      timelineEvents: [],
      conflicts: [],
      endingHook: "钩子",
      graphNodes: [],
      graphEdges: [],
    }
  }
  function mockLlmJsonResponse(json: unknown): void {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken(JSON.stringify(json))
      callbacks.onDone()
    })
  }

  it("cognition failed 账本 + 新章摄取 → 入口先重建失败类（写盘先于本章提交），账本 ch1 治愈 + ch2 全 fold id 记账（行为三方等值）", async () => {
    const files = makeFileMap()
    files.delete(`${PROJECT}/.novel/cognition-state.json`)
    files.set(`${PROJECT}/wiki/chapters/chapter-001.md`, chapterContent(1))
    files.set(`${PROJECT}/wiki/chapters/chapter-002.md`, chapterContent(2))
    seedLedger(files, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)
    mockLlmJsonResponse(llmSnapshotJson(2))

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002.md`)
    expect(result.snapshot).not.toBeNull()

    const paths = writtenPaths()
    const firstCognitionWrite = paths.findIndex((p) => p.endsWith(".novel/cognition-state.json"))
    const firstCommitWrite = paths.findIndex((p) => p.endsWith(".novel/snapshots/002.snapshot.json"))
    expect(firstCognitionWrite).toBeGreaterThan(-1)
    expect(firstCommitWrite).toBeGreaterThan(-1)
    // 自愈 rebuild 发生在本章提交之前（入口先 rebuild 再增量）。
    expect(firstCognitionWrite).toBeLessThan(firstCommitWrite)

    const ledger = readLedger(files)
    // ch1 失败 cell 已治愈。
    expect(ledger.chapters["1"]!.cognition!.status).toBe("committed")
    // 行为三方等值：ingest 实跑记账 ⊇ 注册表 9 个 store-fold id（遍历同一键集）。
    const ch2Cells = Object.keys(ledger.chapters["2"] ?? {})
    for (const id of [
      "cognition", "character", "foreshadow", "emotional_arc", "resource_ledger",
      "subplot_board", "encounter_matrix", "chapter_summaries", "particle_ledger",
      "graph_entity_pages", "graph_entity_patch_fields", "summary_structured_memory", "sync_snapshot_to_memory",
    ]) {
      expect(ch2Cells, `ch2 账本缺投影 ${id}`).toContain(id)
    }
    // 自愈 rebuild 审计事件在账本中可见。
    expect(ledger.auditTrail.some((e) => e.projection === "cognition" && e.status === "rebuild")).toBe(true)
  })

  it("M2-07 消除双倍 fold：单次 ingestChapter 中 cognition/character/foreshadow 各自仅写盘 1 次，且伏笔推进备注无重复行", async () => {
    const files = makeFileMap()
    files.set(`${PROJECT}/wiki/chapters/chapter-001.md`, chapterContent(1))
    files.set(`${PROJECT}/wiki/chapters/chapter-002.md`, chapterContent(2))
    installFs(files)
    const snapJson = {
      ...llmSnapshotJson(2),
      foreshadowingChanges: ["推进伏笔：玉佩-微光再现"],
    }
    mockLlmJsonResponse(snapJson)
    fsMocks.writeFileAtomic.mockClear()

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002.md`)
    expect(result.snapshot).not.toBeNull()

    const paths = writtenPaths()
    expect(paths.filter((p) => p.endsWith(".novel/character-states.json"))).toHaveLength(1)
    expect(paths.filter((p) => p.endsWith(".novel/cognition-state.json"))).toHaveLength(1)
    expect(paths.filter((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toHaveLength(1)

    const foreshadowing = JSON.parse(files.get(`${PROJECT}/.novel/foreshadowing-tracker.json`) ?? "{}") as {
      items: Array<{ name: string; notes: string; advancedChapters: number[] }>
    }
    const jade = foreshadowing.items.find((i) => i.name === "玉佩")
    expect(jade).toBeDefined()
    expect(jade!.advancedChapters).toEqual([2])
    expect(jade!.notes).toBe("[第2章推进] 微光再现")
  })
})

describe("P2-IMP-15 autoRepairTruthFoldDrift — drift>0 自动经注册表 rebuild，复测仍>0 才升级", () => {
  function tamperCharacterStates(files: Map<string, string>): void {
    const chars = files.get(`${PROJECT}/.novel/character-states.json`)!
    const store = JSON.parse(chars)
    store.characters.push({
      characterName: "丙", currentLocation: "", status: "新", equipment: [], abilities: [],
      relationships: {}, lastUpdatedChapter: 1, lastSeenChapter: 1, lastUpdatedAt: "",
    })
    files.set(`${PROJECT}/.novel/character-states.json`, JSON.stringify(store))
  }

  it("误报护栏：drift=0 → attempted:false 零动作（无 rebuild 写盘、无 telemetry）", async () => {
    const files = makeFileMap()
    installFs(files)
    const result = await autoRepairTruthFoldDrift(PROJECT, { trigger: "startup" })
    expect(result.attempted).toBe(false)
    expect(result.driftBefore).toBe(0)
    expect(result.escalated).toBe(false)
    expect(writtenPaths().some((p) => p.includes("/.novel/telemetry/"))).toBe(false)
  })

  it("注入漂移 → 自动经注册表 rebuild 漂移类 → 复测 drift=0 + telemetry 记自愈事件（不告警升级）", async () => {
    const files = makeFileMap()
    tamperCharacterStates(files)
    installFs(files)
    fsMocks.writeFileAtomic.mockClear()

    const result = await autoRepairTruthFoldDrift(PROJECT, { trigger: "startup" })
    expect(result.attempted).toBe(true)
    expect(result.driftBefore).toBe(1)
    expect(result.driftAfter).toBe(0)
    expect(result.repairedFiles).toEqual(["character-states.json"])
    expect(result.escalated).toBe(false)
    // 漂移类经注册表重建（character-states.json 重写）。
    expect(writtenPaths().some((p) => p.endsWith(".novel/character-states.json"))).toBe(true)
    // 自愈事件 telemetry 落盘。
    expect(writtenPaths().some((p) => /\/\.novel\/telemetry\/selfheal-.*\.jsonl$/.test(p))).toBe(true)
    // 复测=0 → 不触发告警升级（无 drift-*.jsonl）。
    expect(writtenPaths().some((p) => /\/\.novel\/telemetry\/drift-.*\.jsonl$/.test(p))).toBe(false)
    // 修复后全量 drift=0。
    const after = await computeTruthFoldDrift(PROJECT, "")
    for (const r of after) expect(r.drifted, r.file).toBe(false)
  })

  it("修复失败（重建写盘抛错）→ 复测仍>0 → 告警升级（drift-*.jsonl）+ selfheal telemetry 记 escalated", async () => {
    const files = makeFileMap()
    tamperCharacterStates(files)
    installFs(files)
    fsMocks.writeFileAtomic.mockImplementation(async (p: string, content: string) => {
      if (String(p).endsWith(".novel/character-states.json")) throw new Error("disk boom")
      files.set(p, content)
    })

    const result = await autoRepairTruthFoldDrift(PROJECT, { trigger: "restore" })
    expect(result.attempted).toBe(true)
    expect(result.escalated).toBe(true)
    expect(result.error).toContain("disk boom")
    expect(result.stillDriftedFiles).toContain("character-states.json")
    // 告警升级：IMP-06 通道 drift-*.jsonl 写入。
    expect(writtenPaths().some((p) => /\/\.novel\/telemetry\/drift-.*\.jsonl$/.test(p))).toBe(true)
    // 自愈事件（含失败原因）仍记 telemetry。
    const selfheal = writtenPaths().find((p) => /\/\.novel\/telemetry\/selfheal-.*\.jsonl$/.test(p))
    expect(selfheal).toBeTruthy()
    expect(files.get(selfheal!)).toContain('"escalated":true')
  })

  it("采样 N/A（store fileVersion 越界 fail-loud）→ attempted:false 不伪造不告警", async () => {
    const files = makeFileMap()
    files.set(`${PROJECT}/.novel/character-states.json`, JSON.stringify({ fileVersion: 999, characters: [] }))
    installFs(files)
    const result = await autoRepairTruthFoldDrift(PROJECT, { trigger: "startup" })
    expect(result.attempted).toBe(false)
    expect(result.driftBefore).toBeNull()
    expect(result.escalated).toBe(false)
    expect(writtenPaths().some((p) => p.includes("/.novel/telemetry/"))).toBe(false)
  })
})

describe("P2-IMP-15 kb-observability：自愈告警决策 + promotion_replay_success 真实源", () => {
  it("decideDriftAlarmAfterRepair：N/A / 健康 / 自愈成功 → 不告警；复测仍>0 或复测不可用 → 升级", () => {
    expect(decideDriftAlarmAfterRepair({ driftBefore: null, driftAfter: null, repairedFiles: [] }).alarm).toBe(false)
    expect(decideDriftAlarmAfterRepair({ driftBefore: 0, driftAfter: 0, repairedFiles: [] }).alarm).toBe(false)
    const healed = decideDriftAlarmAfterRepair({ driftBefore: 2, driftAfter: 0, repairedFiles: ["a.json", "b.json"] })
    expect(healed.alarm).toBe(false)
    expect(healed.escalated).toBe(false)
    expect(healed.detail).toContain("自愈成功")
    const escalated = decideDriftAlarmAfterRepair({ driftBefore: 2, driftAfter: 1, repairedFiles: ["a.json"] })
    expect(escalated.alarm).toBe(true)
    expect(escalated.escalated).toBe(true)
    const recheckNa = decideDriftAlarmAfterRepair({ driftBefore: 1, driftAfter: null, repairedFiles: [] })
    expect(recheckNa.alarm).toBe(true)
  })

  it("collectKbMetricsLive：promotion_replay_success 接 promotion-bridge 凭证层真实源", async () => {
    promotionBridgeMock.promotionReplaySuccessRate.mockResolvedValue({ success: 3, total: 4, rate: 0.75 })
    const metrics = await collectKbMetricsLive({ projectPath: PROJECT })
    expect(promotionBridgeMock.promotionReplaySuccessRate).toHaveBeenCalledWith(PROJECT)
    expect(metrics.promotion_replay_success.value).toBe(0.75)
    // 其余缺源项保持显式 N/A（不伪造）。
    expect(metrics.canon_violation_rate.value).toBeNull()
    expect(metrics.truth_fold_drift.value).toBeNull()
  })

  it("collectKbMetricsLive：真实源采集失败 → 诚实降级 N/A；显式注入 sources 优先", async () => {
    promotionBridgeMock.promotionReplaySuccessRate.mockRejectedValue(new Error("bridge boom"))
    const na = await collectKbMetricsLive({ projectPath: PROJECT })
    expect(na.promotion_replay_success.value).toBeNull()
    expect(na.promotion_replay_success.unavailableReason).toBeTruthy()

    const overridden = await collectKbMetricsLive({
      projectPath: PROJECT,
      sources: { promotionReplaySuccess: 0.5, truthFoldDrift: 0 },
    })
    expect(overridden.promotion_replay_success.value).toBe(0.5)
    expect(overridden.truth_fold_drift.value).toBe(0)
  })
})

describe("R2-M02 / R2-M03 / R2-M05 / R2-M09 / R2-M11 集成回归守卫", () => {
  function installHierarchicalFs(files: Map<string, string>) {
    installFs(files)
    fsMocks.deleteFile.mockImplementation(async (p: string) => {
      files.delete(p)
    })
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/"
      const directFiles: Array<{ name: string; path: string; is_dir: boolean; children?: unknown[] }> = []
      const subdirs = new Map<string, Array<{ name: string; path: string; is_dir: boolean }>>()
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        const slash = rest.indexOf("/")
        if (slash === -1) {
          directFiles.push({ name: rest, path: prefix + rest, is_dir: false })
        } else {
          const sub = rest.slice(0, slash)
          const leaf = rest.slice(slash + 1)
          if (!leaf.includes("/")) {
            const arr = subdirs.get(sub) ?? []
            arr.push({ name: leaf, path: `${prefix}${sub}/${leaf}`, is_dir: false })
            subdirs.set(sub, arr)
          }
        }
      }
      for (const [sub, children] of subdirs.entries()) {
        directFiles.push({ name: sub, path: prefix + sub, is_dir: true, children })
      }
      if (directFiles.length === 0) throw new Error(`ENOENT: ${dir}`)
      return directFiles
    })
  }

  it("R2-M03: deleteChapterSnapshots 联动清理 chapter-ingest-output / facts / timeline / ledger / 向量 / 分目录孤儿实体", async () => {
    const files = makeFileMap()
    const snap2: ChapterSnapshot = {
      ...SNAPSHOT1,
      chapterId: "ch-2",
      chapterNumber: 2,
      summary: "第二章继续推进",
    }
    files.set(`${PROJECT}/.novel/snapshots/002.snapshot.json`, JSON.stringify(snap2))
    files.set(`${PROJECT}/.novel/snapshots/001.snapshot.md`, "# ch1")
    files.set(`${PROJECT}/.novel/snapshots/history/001`, "hist")
    files.set(`${PROJECT}/.novel/chapter-ingest-output/001.output.json`, "{}")
    files.set(`${PROJECT}/.novel/chapter-ingest-output/001.wiki-patch.json`, "{}")
    files.set(`${PROJECT}/.novel/chapter-ingest-output/001.search-index.json`, "{}")
    files.set(`${PROJECT}/.novel/chapter-ingest-output/001.vector-index.json`, "{}")
    files.set(
      `${PROJECT}/wiki/chapters/chapter-001-dawn.md`,
      "---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n\n正文",
    )
    const facts = emptyFactsFile()
    facts.facts.push(
      { id: "f1", subject: "甲", predicate: "在", object: "都城", valid_at: 1, reference_time: 1, source: "chapter-1", episodes: [1] },
      { id: "f2", subject: "乙", predicate: "在", object: "山寨", valid_at: 2, reference_time: 2, source: "chapter-2", episodes: [2] },
    )
    facts.episodes.push({ chapter: 1, fact_ids: ["f1"] }, { chapter: 2, fact_ids: ["f2"] })
    facts.next_id = 3
    files.set(`${PROJECT}/.novel/facts.json`, saveFactsFile(facts))
    seedLedger(files, {
      "1": { cognition: { status: "committed", category: "fold_rebuildable" } },
      "2": { cognition: { status: "committed", category: "fold_rebuildable" } },
    })
    // 分目录孤儿实体（仅引用 001.snapshot.json）应按完整 f.path 删除；跨章混引实体保留。
    files.set(`${PROJECT}/wiki/entities/characters/独章甲.md`, "---\nsource: 001.snapshot.json\n---\n")
    files.set(
      `${PROJECT}/wiki/entities/characters/跨章乙.md`,
      "---\nsources: [001.snapshot.json, 002.snapshot.json]\n---\n",
    )
    installHierarchicalFs(files)

    await deleteChapterSnapshots(PROJECT, 1)

    // 1. chapter-ingest-output/001.* 全删
    expect(files.has(`${PROJECT}/.novel/chapter-ingest-output/001.output.json`)).toBe(false)
    expect(files.has(`${PROJECT}/.novel/chapter-ingest-output/001.wiki-patch.json`)).toBe(false)
    expect(files.has(`${PROJECT}/.novel/chapter-ingest-output/001.search-index.json`)).toBe(false)
    expect(files.has(`${PROJECT}/.novel/chapter-ingest-output/001.vector-index.json`)).toBe(false)
    // 2. facts.json 移除第 1 章，保留第 2 章
    const savedFacts = JSON.parse(files.get(`${PROJECT}/.novel/facts.json`)!) as {
      facts: Array<{ id: string }>
    }
    expect(savedFacts.facts.map((f) => f.id)).toEqual(["f2"])
    // 3. timeline 联动清理
    expect(moduleMocks.removeChapterTimelineEvents).toHaveBeenCalledWith(PROJECT, 1)
    // 4. projection-status.json 移除第 1 章，保留第 2 章
    const ledger = readLedger(files)
    expect(ledger.chapters["1"]).toBeUndefined()
    expect(ledger.chapters["2"]).toBeDefined()
    // 5. LanceDB 向量清理覆盖 chapter-001 / 001 / 真实文件 stem
    const removedIds = moduleMocks.removePageEmbedding.mock.calls.map((c) => c[1])
    expect(removedIds).toContain("chapter-001")
    expect(removedIds).toContain("001")
    expect(removedIds).toContain("chapter-001-dawn")
    // 6. 分目录孤儿实体按完整路径清理，跨章混引实体保留
    expect(files.has(`${PROJECT}/wiki/entities/characters/独章甲.md`)).toBe(false)
    expect(files.has(`${PROJECT}/wiki/entities/characters/跨章乙.md`)).toBe(true)
  })

  it("R2-M02: rebuildDerivedMemoryFromSnapshots 章节向量 pageId 使用真实文件 stem，缺失时回退 chapter-001", async () => {
    const files = makeFileMap()
    files.set(
      `${PROJECT}/wiki/chapters/chapter-001-dawn.md`,
      "---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n\n正文",
    )
    installHierarchicalFs(files)

    const embCfg = { enabled: true, model: "text-embedding-3-small", endpoint: "", apiKey: "" }
    await rebuildDerivedMemoryFromSnapshots(PROJECT, undefined, {
      embeddingConfig: embCfg,
    })
    expect(moduleMocks.embedPage).toHaveBeenCalledWith(
      PROJECT,
      "chapter-001-dawn",
      expect.any(String),
      SNAPSHOT1.summary,
      expect.objectContaining({ enabled: true, model: "text-embedding-3-small" }),
    )

    // 章节源文件缺失时回退 chapter-001
    moduleMocks.embedPage.mockClear()
    files.delete(`${PROJECT}/wiki/chapters/chapter-001-dawn.md`)
    invalidateChapterCache(PROJECT)
    await rebuildDerivedMemoryFromSnapshots(PROJECT, undefined, {
      embeddingConfig: embCfg,
    })
    expect(moduleMocks.embedPage).toHaveBeenCalledWith(
      PROJECT,
      "chapter-001",
      expect.any(String),
      SNAPSHOT1.summary,
      expect.objectContaining({ enabled: true, model: "text-embedding-3-small" }),
    )
  })

  it("R2-M05: ingestChapter 默认同号多正式章直接拒收 duplicate_chapter_number（不触发 LLM）", async () => {
    const files = makeFileMap()
    const ch2Body = "---\ntype: chapter\nchapter_number: 2\nchapter_status: final\n---\n\n正文"
    files.set(`${PROJECT}/wiki/chapters/chapter-002-a.md`, ch2Body)
    files.set(`${PROJECT}/wiki/chapters/chapter-002-b.md`, ch2Body)
    installHierarchicalFs(files)

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002-a.md`)
    expect(result).toEqual({ snapshot: null, failReason: "duplicate_chapter_number" })
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("R2-M09: listSnapshotEntriesWithMtime 与 loadAllSnapshots 过滤大纲负数/零号快照", async () => {
    const files = makeFileMap()
    files.set(
      `${PROJECT}/.novel/snapshots/outline-001.snapshot.json`,
      JSON.stringify({ ...SNAPSHOT1, chapterNumber: -1, chapterId: "outline-1" }),
    )
    files.set(
      `${PROJECT}/.novel/snapshots/000.snapshot.json`,
      JSON.stringify({ ...SNAPSHOT1, chapterNumber: 0, chapterId: "chapter-0" }),
    )
    installHierarchicalFs(files)

    const entries = await listSnapshotEntriesWithMtime(PROJECT)
    expect(entries.map((e) => e.number)).toEqual([1])
    const snapshots = await loadAllSnapshots(PROJECT)
    expect(snapshots.map((s) => s.chapterNumber)).toEqual([1])
  })

  it("R2-M11: readCurrentSnapshot 仅真缺失返回 null，权限错与坏 JSON 上抛", async () => {
    const files = new Map<string, string>()
    installHierarchicalFs(files)

    // 真缺失 → null
    await expect(readCurrentSnapshot(PROJECT, 99)).resolves.toBeNull()

    // 非缺失 IO 错 → 上抛
    fsMocks.readFile.mockRejectedValueOnce(new Error("EACCES: permission denied"))
    await expect(readCurrentSnapshot(PROJECT, 99)).rejects.toThrow(/EACCES/)

    // 坏 JSON → 上抛 SyntaxError
    files.set(`${PROJECT}/.novel/snapshots/001.snapshot.json`, "{corrupted-json")
    await expect(readCurrentSnapshot(PROJECT, 1)).rejects.toThrow(SyntaxError)
  })
})
