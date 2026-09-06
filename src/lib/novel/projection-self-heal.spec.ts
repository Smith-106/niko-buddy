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

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", () => ({
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
}))

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
  clearGraphCache: vi.fn(),
  clearTemporalFactsCache: vi.fn(),
  buildEntityLinkIndex: vi.fn(),
  resolveEntityLink: vi.fn(),
  extractEntitySummary: vi.fn(),
  planAddOpsFromCanonFacts: vi.fn(),
  applyMemoryOps: vi.fn(),
  embedPage: vi.fn(),
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
}))
vi.mock("@/lib/graph-relevance", () => ({
  clearGraphCache: (...args: unknown[]) => moduleMocks.clearGraphCache(...args),
}))
vi.mock("./context-engine", () => ({
  clearTemporalFactsCache: (...args: unknown[]) => moduleMocks.clearTemporalFactsCache(...args),
}))
vi.mock("@/lib/dedup", () => ({
  buildEntityLinkIndex: (...args: unknown[]) => moduleMocks.buildEntityLinkIndex(...args),
  resolveEntityLink: (...args: unknown[]) => moduleMocks.resolveEntityLink(...args),
  extractEntitySummary: (...args: unknown[]) => moduleMocks.extractEntitySummary(...args),
}))
vi.mock("./memory-op", () => ({
  planAddOpsFromCanonFacts: (...args: unknown[]) => moduleMocks.planAddOpsFromCanonFacts(...args),
  applyMemoryOps: (...args: unknown[]) => moduleMocks.applyMemoryOps(...args),
}))
vi.mock("@/lib/embedding", () => ({
  embedPage: (...args: unknown[]) => moduleMocks.embedPage(...args),
}))

const promotionBridgeMock = vi.hoisted(() => ({ promotionReplaySuccessRate: vi.fn() }))
vi.mock("./promotion-bridge", () => ({
  promotionReplaySuccessRate: (...args: unknown[]) => promotionBridgeMock.promotionReplaySuccessRate(...args),
}))

import {
  autoRepairTruthFoldDrift,
  computeTruthFoldDrift,
  ingestChapter,
  selfHealFailedProjections,
  type ChapterSnapshot,
} from "./chapter-ingest"
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
  moduleMocks.clearGraphCache.mockReturnValue(undefined)
  moduleMocks.clearTemporalFactsCache.mockReturnValue(undefined)
  moduleMocks.buildEntityLinkIndex.mockReturnValue({})
  moduleMocks.resolveEntityLink.mockReturnValue(null)
  moduleMocks.extractEntitySummary.mockReturnValue(null)
  moduleMocks.planAddOpsFromCanonFacts.mockReturnValue([])
  moduleMocks.applyMemoryOps.mockReturnValue([])
  moduleMocks.embedPage.mockResolvedValue(undefined)
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
