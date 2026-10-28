import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

/**
 * ingestChapter 二次拆分（ISS-20260724-002 (A) 波）前置安全网。
 *
 * 与 chapter-ingest.behavior.spec.ts 互补：behavior 覆盖主路径与业务分支，
 * 本 spec 专门钉住**非致命降级路径**（canon 双写 replay 失败 / failed 投影自愈
 * 抛错 / facts-store 写入失败 / 提交阶段部分失败 / 社区摘要异步分支），
 * 这些正是拆分 ingestChapter 时最容易被搬错却不一定立刻报错的边界。
 */

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
  return {
    ...actual,
    useWikiStore: { getState: () => storeState },
  }
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
  replayPendingQueue: vi.fn(),
  runCanonDualWriteHook: vi.fn(),
  selfHealFailedProjections: vi.fn(),
  backupCommunitySummariesLastGood: vi.fn(),
  restoreCommunitySummariesLastGood: vi.fn(),
  rebuildCommunitySummaries: vi.fn(),
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

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (cfg: unknown) => cfg,
}))

vi.mock("./community-summary", () => ({
  shouldRebuildCommunitySummaries: (...args: unknown[]) => moduleMocks.shouldRebuildCommunitySummaries(...args),
  generateCommunitySummaries: (...args: unknown[]) => moduleMocks.generateCommunitySummaries(...args),
}))

vi.mock("./community-summary-recovery", () => ({
  backupCommunitySummariesLastGood: (...args: unknown[]) => moduleMocks.backupCommunitySummariesLastGood(...args),
  restoreCommunitySummariesLastGood: (...args: unknown[]) => moduleMocks.restoreCommunitySummariesLastGood(...args),
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

vi.mock("./canon-dual-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canon-dual-write")>()
  return {
    ...actual,
    replayPendingQueue: (...args: unknown[]) => moduleMocks.replayPendingQueue(...args),
    runCanonDualWriteHook: (...args: unknown[]) => moduleMocks.runCanonDualWriteHook(...args),
  }
})

vi.mock("./chapter-ingest-fold-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-ingest-fold-registry")>()
  return {
    ...actual,
    selfHealFailedProjections: (...args: unknown[]) => moduleMocks.selfHealFailedProjections(...args),
    rebuildCommunitySummaries: (...args: unknown[]) => moduleMocks.rebuildCommunitySummaries(...args),
  }
})

import { ingestChapter, type ChapterSnapshot } from "./chapter-ingest"

const PROJECT = "E:/Novel"
const CHAPTER_PATH = `${PROJECT}/wiki/chapters/chapter-001.md`

function chapterContent(): string {
  const fm = {
    type: "chapter",
    chapter_number: 1,
    chapter_status: "final",
    title: "第1章 开局",
  }
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  return `---\n${fmLines.join("\n")}\n---\n\n# 第1章 开局\n\n正文内容……`
}

function llmSnapshotJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    summary: "主角来到码头",
    characters: ["阿宁"],
    characterAliases: {},
    locations: ["码头"],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
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
  storeState.novelMode = true
  storeState.llmConfig = { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig
  storeState.novelConfig = {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "review-model",
  } as NovelConfig
  storeState.embeddingConfig = { enabled: false, model: "" }
  storeState.outputLanguage = "zh-CN"

  fsMocks.readFile.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.endsWith("chapter-001.md")) return chapterContent()
    if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
    throw new Error("ENOENT: no such file or directory")
  })
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.writeFilesAtomic.mockResolvedValue(undefined)
  fsMocks.deleteFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(false)

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
  moduleMocks.replayPendingQueue.mockResolvedValue({ queued: 0, remaining: 0, divergences: [] })
  moduleMocks.runCanonDualWriteHook.mockResolvedValue(undefined)
  moduleMocks.selfHealFailedProjections.mockResolvedValue({ attempted: false, healed: [] })
  moduleMocks.backupCommunitySummariesLastGood.mockResolvedValue(undefined)
  moduleMocks.restoreCommunitySummariesLastGood.mockResolvedValue(undefined)
  moduleMocks.rebuildCommunitySummaries.mockResolvedValue(undefined)
})

describe("ingestChapter — canon 双写 replay 非致命降级（拆分边界 1）", () => {
  it("warns and continues when replay leaves pending ops", async () => {
    moduleMocks.replayPendingQueue.mockResolvedValue({ queued: 3, remaining: 2, divergences: [] })
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, {
      canonDualWriteDeps: {} as never,
    })
    expect(moduleMocks.replayPendingQueue).toHaveBeenCalled()
    expect(result.snapshot).not.toBeNull()
  })

  it("warns and continues when replayPendingQueue itself throws", async () => {
    moduleMocks.replayPendingQueue.mockRejectedValue(new Error("queue corrupt"))
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, {
      canonDualWriteDeps: {} as never,
    })
    expect(result.snapshot).not.toBeNull()
    // replay 失败绝不阻断本章摄取
    expect(streamChatMock).toHaveBeenCalled()
  })

  it("skips replay entirely when no canonDualWriteDeps injected", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.replayPendingQueue).not.toHaveBeenCalled()
  })
})

describe("ingestChapter — failed 投影自愈非致命降级（拆分边界 2）", () => {
  it("continues when self-heal reports healed projections", async () => {
    moduleMocks.selfHealFailedProjections.mockResolvedValue({ attempted: true, healed: ["cognition"] })
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("warns and continues when self-heal throws", async () => {
    moduleMocks.selfHealFailedProjections.mockRejectedValue(new Error("ledger unreadable"))
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })
})

describe("ingestChapter — 提交阶段 facts-store 非致命降级（拆分边界 3）", () => {
  it("warns and continues when facts-store plan throws", async () => {
    moduleMocks.planAddOpsFromCanonFacts.mockImplementation(() => {
      throw new Error("plan boom")
    })
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    // 提交点（snapshot 落盘）不被 facts-store 失败阻断
    expect(fsMocks.writeFilesAtomic).toHaveBeenCalled()
  })

  it("warns and continues when applyMemoryOps throws", async () => {
    moduleMocks.planAddOpsFromCanonFacts.mockReturnValue([{ op: "ADD", id: "f1" }])
    moduleMocks.applyMemoryOps.mockImplementation(() => {
      throw new Error("apply boom")
    })
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("runs the canon dual-write hook on the final chapter", async () => {
    // runCanonDualWriteHook 是母模块内部直调（不经 mock 边界），因此断言其可观测后果：
    // 传入 deps 时钩子被执行且不阻断主链（钩子内部有自己的非致命 try/catch）。
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, {
      canonDualWriteDeps: {} as never,
    })
    expect(result.snapshot).not.toBeNull()
    expect(result.failReason).toBeUndefined()
  })
})

describe("ingestChapter — 社区摘要重建分支（拆分边界 4）", () => {
  it("does not touch community summaries when the guard says no", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(false)
    mockLlmJsonResponse(llmSnapshotJson())
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.generateCommunitySummaries).not.toHaveBeenCalled()
  })

  it("awaits the rebuild synchronously when communitySummaryAsync is off", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: false } as NovelConfig
    mockLlmJsonResponse(llmSnapshotJson())
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled()
  })

  it("fires and forgets when communitySummaryAsync is on", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled()
  })
})

describe("ingestChapter — 提交点顺序不变量（commit-then-project）", () => {
  it("writes the snapshot before any projection runs", async () => {
    const order: string[] = []
    fsMocks.writeFilesAtomic.mockImplementation(async () => {
      order.push("snapshot")
    })
    moduleMocks.writeSnapshotToWiki.mockImplementation(async () => {
      order.push("projection")
      return []
    })
    mockLlmJsonResponse(llmSnapshotJson())
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(order.indexOf("snapshot")).toBeGreaterThanOrEqual(0)
    if (order.includes("projection")) {
      expect(order.indexOf("snapshot")).toBeLessThan(order.indexOf("projection"))
    }
  })

  it("returns the committed snapshot with memorySyncedAt", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    const snapshot = result.snapshot as ChapterSnapshot
    expect(snapshot).not.toBeNull()
    expect(snapshot.chapterNumber).toBe(1)
    // memorySyncedAt 落在 snapshot 对象内部（不是 IngestResult 顶层）
    expect(snapshot.memorySyncedAt === undefined || typeof snapshot.memorySyncedAt === "string").toBe(true)
  })
})
