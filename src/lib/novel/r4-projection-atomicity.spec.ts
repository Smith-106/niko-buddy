/**
 * R4 真相库失败投影账本可见与入口自愈收敛加固（方案 a）——行为 spec。
 *
 * 覆盖 UC1–UC4 + 幂等哈希，零真实 IO（故障注入 mock writeFileAtomic）。
 *
 * - UC1 入口自愈可观测：ingestChapter 成功返回携带 selfHeal（attempted/healed
 *   可观测），失败 cell 收敛为 committed 且审计可见。
 * - UC2 薄包装收敛：replayFailedProjectionsFromLedger 与 selfHealFailedProjections
 *   同参同果；二次重放 attempted:false 零多余写盘（幂等收敛）；非 rebuildable
 *   失败保留可见。
 * - UC3 finally 落盘重试 1 次：首败→重试成功返回 true（恰 2 次写盘）；
 *   连败→返回 false（恰 2 次写盘，不无限重试）。
 * - UC4 ledgerSaveFailed 标记：账本落盘连败时主链不阻断（snapshot 照常返回）
 *   且结果标记 ledgerSaveFailed=true；成功路径为 false。
 * - 幂等哈希：truthStoreHash 在键序/易变元数据下稳定（重放收敛的计算基石）。
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
  }
})

import {
  ingestChapter,
  replayFailedProjectionsFromLedger,
  saveProjectionLedgerWithSingleRetry,
  selfHealFailedProjections,
  type ChapterSnapshot,
} from "./chapter-ingest"
import { emptyLedger, LEDGER_SAVE_MAX_RETRIES, shouldRetryLedgerSave } from "./projection-status-ledger"
import { canonicalizeForHash, truthStoreHash } from "./projection-store"
import { emptyCognitionState, mergeCognitionFromSnapshot } from "./character-cognition"
import { createEmptyCharacterStateStore } from "./character-state"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import { createEmptyEncounterMatrixStore, foldMeetingEdges, appendMeetingEdge } from "./encounter-matrix"
import { createEmptyChapterSummariesStore, foldChapterSummary, upsertChapterSummary } from "./chapter-summaries"
import { createEmptyParticleLedgerStore, foldParticleEntries, appendParticleEntry } from "./particle-ledger"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import { createEmptySubplotBoardStore } from "./subplot-board"
import { applyCharacterStateChangesToStore } from "./chapter-ingest"
import { applyForeshadowingChangesToStore } from "./chapter-ingest"
import { applyEmotionalArcsToStore } from "./chapter-ingest"
import { applyResourceLedgerToStore } from "./chapter-ingest"
import { applySubplotChangesToStore } from "./chapter-ingest"

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

/** 与既有自愈 spec 同源的 live 基准（fold 直调 = 重放定义）。 */
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

/** R4 故障注入：ledgerFailuresRemaining 次账本写盘抛错（其余路径恒成功）。 */
const faultState = { ledgerFailuresRemaining: 0 }

function installFs(files: Map<string, string>) {
  fsMocks.readFile.mockImplementation(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
    return files.get(p)
  })
  fsMocks.writeFileAtomic.mockImplementation(async (p: string, content: string) => {
    if (String(p).endsWith("projection-status.json") && faultState.ledgerFailuresRemaining > 0) {
      faultState.ledgerFailuresRemaining -= 1
      throw new Error("R4 fault: ledger disk boom")
    }
    files.set(p, content)
  })
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

function ledgerWrites(): string[] {
  return fsMocks.writeFileAtomic.mock.calls
    .map(([p]) => String(p))
    .filter((p) => p.endsWith("projection-status.json"))
}

function readLedger(files: Map<string, string>): {
  chapters: Record<string, Record<string, { status: string; last_error: string }>>
  auditTrail: Array<{ projection: string; chapter: number; status: string }>
} {
  return JSON.parse(files.get(`${PROJECT}/.novel/projection-status.json`) ?? "{}")
}

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

beforeEach(() => {
  vi.clearAllMocks()
  faultState.ledgerFailuresRemaining = 0
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
})

const ALL_INGEST_IDS = [
  "cognition",
  "character",
  "foreshadow",
  "emotional_arc",
  "resource_ledger",
  "subplot_board",
  "encounter_matrix",
  "chapter_summaries",
  "particle_ledger",
  "graph_entity_pages",
  "graph_entity_patch_fields",
  "summary_structured_memory",
  "sync_snapshot_to_memory",
]

describe("R4 UC1 入口自愈可观测（ingest 成功路径携带 selfHeal + 账本收敛）", () => {
  it("failed cognition 账本 + 新章摄取 → result.selfHeal.healed 可观测，ch1 治愈，ch2 全 id 记账", async () => {
    const files = makeFileMap()
    files.delete(`${PROJECT}/.novel/cognition-state.json`)
    files.set(`${PROJECT}/wiki/chapters/chapter-001.md`, chapterContent(1))
    files.set(`${PROJECT}/wiki/chapters/chapter-002.md`, chapterContent(2))
    seedLedger(files, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)
    mockLlmJsonResponse(llmSnapshotJson(2))

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002.md`)
    expect(result.snapshot).not.toBeNull()
    // 入口自愈可观测：成功路径恒携带 selfHeal。
    expect(result.selfHeal?.attempted).toBe(true)
    expect(result.selfHeal?.healed).toContain("cognition")
    expect(result.ledgerSaveFailed).toBe(false)

    const ledger = readLedger(files)
    expect(ledger.chapters["1"]!.cognition!.status).toBe("committed")
    expect(ledger.chapters["1"]!.cognition!.last_error).toBe("")
    const ch2Cells = Object.keys(ledger.chapters["2"] ?? {})
    for (const id of ALL_INGEST_IDS) {
      expect(ch2Cells, `ch2 账本缺投影 ${id}`).toContain(id)
    }
    expect(ledger.auditTrail.some((e) => e.projection === "cognition" && e.status === "rebuild")).toBe(true)
    // 自愈重建内容与快照一致（密道知识落盘）。
    expect(files.get(`${PROJECT}/.novel/cognition-state.json`)).toContain("密道")
  })
})

describe("R4 UC2 薄包装收敛（replayFailedProjectionsFromLedger 委托 + 幂等）", () => {
  it("与自愈直调同参同果；二次重放 attempted:false 零多余写盘", async () => {
    const filesA = makeFileMap()
    filesA.delete(`${PROJECT}/.novel/cognition-state.json`)
    seedLedger(filesA, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    const filesB = makeFileMap()
    filesB.delete(`${PROJECT}/.novel/cognition-state.json`)
    seedLedger(filesB, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })

    installFs(filesA)
    const viaWrapper = await replayFailedProjectionsFromLedger(PROJECT)
    installFs(filesB)
    const viaDirect = await selfHealFailedProjections(PROJECT)
    // 薄包装：同参同果，不复制逻辑。
    expect([...viaWrapper.healed].sort()).toEqual([...viaDirect.healed].sort())
    expect(viaWrapper.healed).toEqual(["cognition"])

    // 幂等收敛：二次重放零动作（failed 已治愈，无可重建项）。
    installFs(filesA)
    fsMocks.writeFileAtomic.mockClear()
    const second = await replayFailedProjectionsFromLedger(PROJECT)
    expect(second.attempted).toBe(false)
    expect(second.healed).toEqual([])
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("非 rebuildable 失败（graph_entity_pages）→ 不重建且保留 failed 可见", async () => {
    const files = makeFileMap()
    seedLedger(files, {
      "1": { graph_entity_pages: { status: "failed", category: "mutates_existing_non_rebuildable", error: "boom" } },
    })
    installFs(files)
    const result = await replayFailedProjectionsFromLedger(PROJECT)
    expect(result.attempted).toBe(false)
    expect(result.healed).toEqual([])
    expect(readLedger(files).chapters["1"]!.graph_entity_pages!.status).toBe("failed")
  })
})

describe("R4 UC3 finally 落盘重试 1 次（saveProjectionLedgerWithSingleRetry）", () => {
  it("纯函数门槛：attempt=0 可重试，attempt=1 停止；上限常量为 1", () => {
    expect(LEDGER_SAVE_MAX_RETRIES).toBe(1)
    expect(shouldRetryLedgerSave(0)).toBe(true)
    expect(shouldRetryLedgerSave(1)).toBe(false)
    expect(shouldRetryLedgerSave(2)).toBe(false)
    expect(shouldRetryLedgerSave(-1)).toBe(false)
    expect(shouldRetryLedgerSave(0.5)).toBe(false)
    expect(shouldRetryLedgerSave(Number.NaN)).toBe(false)
  })

  it("首次失败→重试成功：返回 true，账本写盘恰 2 次", async () => {
    const files = makeFileMap()
    seedLedger(files, {})
    installFs(files)
    faultState.ledgerFailuresRemaining = 1
    fsMocks.writeFileAtomic.mockClear()

    const ok = await saveProjectionLedgerWithSingleRetry(PROJECT, emptyLedger())
    expect(ok).toBe(true)
    expect(ledgerWrites()).toHaveLength(2)
    // 重试后落盘内容完整（schemaVersion + 空 chapters 写回）。
    expect(JSON.parse(files.get(`${PROJECT}/.novel/projection-status.json`) ?? "{}").schemaVersion).toBe("2")
  })

  it("两次均失败：返回 false，账本写盘恰 2 次（不无限重试）", async () => {
    const files = makeFileMap()
    seedLedger(files, {})
    installFs(files)
    faultState.ledgerFailuresRemaining = 99
    fsMocks.writeFileAtomic.mockClear()

    const ok = await saveProjectionLedgerWithSingleRetry(PROJECT, emptyLedger())
    expect(ok).toBe(false)
    expect(ledgerWrites()).toHaveLength(2)
  })
})

describe("R4 UC4 ledgerSaveFailed 标记（落盘连败不阻断主链）", () => {
  it("账本写盘连败 → snapshot 照常返回 + ledgerSaveFailed=true + 自愈 error 可观测", async () => {
    const files = makeFileMap()
    files.delete(`${PROJECT}/.novel/cognition-state.json`)
    files.set(`${PROJECT}/wiki/chapters/chapter-001.md`, chapterContent(1))
    files.set(`${PROJECT}/wiki/chapters/chapter-002.md`, chapterContent(2))
    seedLedger(files, { "1": { cognition: { status: "failed", category: "fold_rebuildable", error: "boom" } } })
    installFs(files)
    mockLlmJsonResponse(llmSnapshotJson(2))
    faultState.ledgerFailuresRemaining = 999

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002.md`)
    // 主链不阻断：快照照常产出。
    expect(result.snapshot).not.toBeNull()
    expect(result.snapshot?.chapterNumber).toBe(2)
    // 落盘失败标记可见。
    expect(result.ledgerSaveFailed).toBe(true)
    // 入口自愈尝试本身可观测（账本落盘失败导致 error 携带，failed 保留下次收敛）。
    expect(result.selfHeal?.attempted).toBe(true)
    expect(result.selfHeal?.error).toBeTruthy()
  })

  it("账本写盘成功路径 → ledgerSaveFailed=false", async () => {
    const files = makeFileMap()
    files.set(`${PROJECT}/wiki/chapters/chapter-002.md`, chapterContent(2))
    seedLedger(files, {})
    installFs(files)
    mockLlmJsonResponse(llmSnapshotJson(2))

    const result = await ingestChapter(PROJECT, `${PROJECT}/wiki/chapters/chapter-002.md`)
    expect(result.snapshot).not.toBeNull()
    expect(result.ledgerSaveFailed).toBe(false)
    expect(result.selfHeal?.attempted).toBe(false)
  })
})

describe("R4 幂等哈希（truthStoreHash 稳定性 = 重放收敛的计算基石）", () => {
  it("键序/易变元数据不影响哈希；认识论字段影响哈希；输出 64 位 hex", async () => {
    const store = {
      lastUpdated: "2026-09-04T00:00:00.000Z",
      fileVersion: 2,
      items: [{ name: "a", updatedAt: "2026-09-04T00:00:00.000Z", validAt: "ch-3", revealedAt: "ch-5" }],
    }
    const canonical = canonicalizeForHash(store)
    expect(canonical.lastUpdated).toBeUndefined()
    expect(canonical.fileVersion).toBeUndefined()
    expect(canonical.items[0].updatedAt).toBeUndefined()
    expect(canonical.items[0].validAt).toBe("ch-3")
    const h1 = await truthStoreHash(store)
    const h2 = await truthStoreHash(JSON.parse(JSON.stringify(store)))
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    const reordered = await truthStoreHash({ items: store.items, fileVersion: 2, lastUpdated: store.lastUpdated })
    expect(reordered).toBe(h1)
    // 认识论字段是数据：改变 validAt 必须改变哈希（否则重放会漏判漂移）。
    const drifted = await truthStoreHash({
      ...store,
      items: [{ name: "a", validAt: "ch-4", revealedAt: "ch-5" }],
    } as unknown)
    expect(drifted).not.toBe(h1)
  })

  it("同一快照 fold 产物哈希恒定（自愈重放与增量写盘同一内容必同哈希）", async () => {
    const fresh = mergeCognitionFromSnapshot(emptyCognitionState(), SNAPSHOT1, undefined)
    const h1 = await truthStoreHash(fresh)
    const h2 = await truthStoreHash(mergeCognitionFromSnapshot(emptyCognitionState(), SNAPSHOT1, undefined))
    expect(h1).toBe(h2)
  })
})
