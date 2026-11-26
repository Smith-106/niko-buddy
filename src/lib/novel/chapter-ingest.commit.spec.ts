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

// 轻量持久化夹具：严格链回读要求 commit 写盘字节可被后续读看到。
const snapshotFiles = new Map<string, string>()

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

import { computeCheckpointDigest } from "./checkpoint-digest"
import { commitPreparedChapterIngest, ingestChapter, prepareChapterIngest, type ChapterSnapshot } from "./chapter-ingest"
import { recoverInterruptedCommunitySummaryAttempts } from "./chapter-ingest-projections"
import { withSnapshotWriteLock } from "./chapter-ingest-snapshot-io"
import { emptyLedger, recordProjectionStatus, type ProjectionStatusLedger } from "./projection-status-ledger"

const PROJECT = "E:/Novel"
const CHAPTER_PATH = `${PROJECT}/wiki/chapters/chapter-001.md`
const LEDGER_PATH = `${PROJECT}/.novel/projection-status.json`

function persistedLedger(): ProjectionStatusLedger {
  return JSON.parse(snapshotFiles.get(LEDGER_PATH)!) as ProjectionStatusLedger
}

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

  snapshotFiles.clear()
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.endsWith("chapter-001.md")) return chapterContent()
    const saved = snapshotFiles.get(p)
    if (saved !== undefined) return saved
    if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
    throw new Error("ENOENT: no such file or directory")
  })
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockImplementation(async (path: string, raw: string) => {
    snapshotFiles.set(String(path), String(raw))
    return undefined
  })
  fsMocks.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>) => {
    for (const [fp, raw] of files) snapshotFiles.set(String(fp), String(raw))
    return undefined
  })
  fsMocks.deleteFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockImplementation(async (path: string) => snapshotFiles.has(String(path)))

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
    // deferred 在 finally 账本落盘后才经微任务调度——等待真实调用，不假设同步执行。
    await vi.waitFor(() => expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled())
    // deferred 计入 pending，不并入 failed。
    expect(result.pendingProjections).toEqual(["community_summary"])
    expect(result.failedProjections).not.toContain("community_summary")
  })

  it("批处理显式 await：async 模式下生成失败计入 failed 而非 pending，且写入本章 ledger", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    // 叶子语义：promise 仍 resolve，但经第 5 参 failure 回调上报部分失败。
    moduleMocks.generateCommunitySummaries.mockImplementation(async (...args: unknown[]) => {
      const report = args[4] as (cause: unknown) => void
      report(new Error("summary boom"))
    })
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { awaitCommunitySummary: true })
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled()
    expect(moduleMocks.backupCommunitySummariesLastGood).not.toHaveBeenCalled()
    expect(moduleMocks.restoreCommunitySummariesLastGood).not.toHaveBeenCalled()
    expect(result.failedProjections).toContain("community_summary")
    expect(result.pendingProjections).toEqual([])
    // awaited 失败持久化到本章账本 cell（deferred 不写）。
    const ledger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
      chapters?: Record<string, Record<string, { status?: string }>>
    }
    expect(ledger.chapters?.["1"]?.community_summary?.status).toBe("failed")
  })

  it("批处理显式 await：async 模式下生成成功计入 committed 且写入本章 ledger", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { awaitCommunitySummary: true })
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled()
    expect(result.failedProjections).not.toContain("community_summary")
    expect(result.pendingProjections).toEqual([])
    expect(result.committedProjections).toContain("community_summary")
    const ledger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
      chapters?: Record<string, Record<string, { status?: string }>>
    }
    expect(ledger.chapters?.["1"]?.community_summary?.status).toBe("committed")
  })

  it("批处理显式 await：执行社区摘要 LLM 期间已释放章锁，不阻塞同章后续锁请求", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    let signalStarted!: () => void
    const summaryStarted = new Promise<void>(resolve => { signalStarted = resolve })
    let releaseSummary!: () => void
    const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve })
    moduleMocks.generateCommunitySummaries.mockImplementationOnce(async () => {
      signalStarted()
      await summaryGate
    })
    mockLlmJsonResponse(llmSnapshotJson())

    const ingestPromise = ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { awaitCommunitySummary: true })
    try {
      await summaryStarted
      // 进入社区摘要 LLM 时 durable pending 已落账本，且章级写锁已释放。
      const pendingCell = persistedLedger().chapters["1"]?.community_summary
      expect(pendingCell?.status).toBe("pending")
      expect(pendingCell?.attemptId).toBeTruthy()
      await expect(withSnapshotWriteLock(PROJECT, 1, async () => "lock-acquired")).resolves.toBe("lock-acquired")
    } finally {
      releaseSummary()
    }

    const result = await ingestPromise
    expect(result.snapshot).not.toBeNull()
    expect(result.committedProjections).toContain("community_summary")
    expect(result.pendingProjections).toEqual([])
    expect(result.failedProjections).toEqual([])
    expect(result.ledgerSaveFailed).toBe(false)
    const finalLedger = persistedLedger()
    expect(finalLedger.chapters["1"]?.community_summary?.status).toBe("committed")
    expect(finalLedger.auditTrail?.filter(e => e.projection === "community_summary" && e.status === "rebuild")).toHaveLength(1)
  })

  it("deferred 摘要：先落 pending cell，解析失败回调后落 failed + 仅一条终态审计", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    let settle: (() => void) | undefined
    moduleMocks.generateCommunitySummaries.mockImplementation((...args: unknown[]) => new Promise<void>((resolve) => {
      const report = args[4] as ((cause: unknown) => void) | undefined
      settle = () => { report?.(new Error("deferred summary boom")); resolve() }
    }))
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    // ingest 返回时 deferred 尚未结算：账本已有 durable pending cell（带 attemptId）。
    const pendingLedger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
      chapters?: Record<string, Record<string, { status?: string; attemptId?: string }>>
    }
    const pendingCell = pendingLedger.chapters?.["1"]?.community_summary
    expect(pendingCell?.status).toBe("pending")
    expect(pendingCell?.attemptId).toBeTruthy()
    expect(result.pendingProjections).toEqual(["community_summary"])

    // 等待 deferred 微任务链真正调用生成器（未结算会占住 project lock 拖死后续测试）。
    await vi.waitFor(() => expect(settle).toBeDefined())
    settle!()
    await vi.waitFor(() => {
      const ledger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
        chapters?: Record<string, Record<string, { status?: string; last_error?: string }>>
        auditTrail?: Array<{ projection?: string; status?: string }>
      }
      const cell = ledger.chapters?.["1"]?.community_summary
      expect(cell?.status).toBe("failed")
      expect(cell?.last_error).toContain("deferred summary boom")
      const terminalAudits = (ledger.auditTrail ?? []).filter((e) => e.projection === "community_summary" && (e.status === "failed" || e.status === "rebuild"))
      expect(terminalAudits).toHaveLength(1)
      expect(terminalAudits[0]?.status).toBe("failed")
    })
    expect(result.snapshot).not.toBeNull()
  })

  it("deferred 摘要：生成成功把 pending 收敛为 committed + 一条 rebuild 审计", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true } as NovelConfig
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    await vi.waitFor(() => expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled())
    await vi.waitFor(() => {
      const ledger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
        chapters?: Record<string, Record<string, { status?: string }>>
        auditTrail?: Array<{ projection?: string; status?: string }>
      }
      expect(ledger.chapters?.["1"]?.community_summary?.status).toBe("committed")
      const terminalAudits = (ledger.auditTrail ?? []).filter((e) => e.projection === "community_summary" && (e.status === "failed" || e.status === "rebuild"))
      expect(terminalAudits).toHaveLength(1)
      expect(terminalAudits[0]?.status).toBe("rebuild")
    })
  })

  it("next ingest settles abandoned attempts before self-heal and preserves the live attempt and terminal CAS", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true }
    mockLlmJsonResponse(llmSnapshotJson())
    let finishFirst!: () => void
    let finishSecond!: () => void
    const firstSummary = new Promise<void>(resolve => { finishFirst = resolve })
    const secondSummary = new Promise<void>(resolve => { finishSecond = resolve })
    moduleMocks.generateCommunitySummaries
      .mockImplementationOnce(async (...args: unknown[]) => {
        const report = args[4] as (cause: unknown) => void
        await firstSummary
        report(new Error("superseded summary failure"))
      })
      .mockImplementationOnce(() => secondSummary)

    try {
      const first = await ingestChapter(PROJECT, CHAPTER_PATH)
      expect(first.pendingProjections).toEqual(["community_summary"])
      await vi.waitFor(() => expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(1))
      const ledger = persistedLedger()
      const live = ledger.chapters["1"].community_summary
      expect(live.status).toBe("pending")
      expect(live.attemptId).toBeTruthy()
      const withLegacy = recordProjectionStatus(ledger, 2, "community_summary", "pending")
      const old = recordProjectionStatus(withLegacy, 3, "community_summary", "pending")
      old.chapters["3"].community_summary.attemptId = "interrupted-attempt"
      snapshotFiles.set(LEDGER_PATH, JSON.stringify(old))

      let atSelfHeal: ProjectionStatusLedger | undefined
      moduleMocks.selfHealFailedProjections.mockImplementationOnce(async () => {
        atSelfHeal = persistedLedger()
        return { attempted: false, healed: [] }
      })
      const second = await ingestChapter(PROJECT, CHAPTER_PATH)
      expect(second.pendingProjections).toEqual(["community_summary"])
      expect(atSelfHeal?.chapters["1"].community_summary).toEqual(live)
      expect(atSelfHeal?.chapters["2"].community_summary).toMatchObject({ status: "failed" })
      expect(atSelfHeal?.chapters["3"].community_summary).toMatchObject({
        status: "failed", attemptId: "interrupted-attempt",
      })
      expect(atSelfHeal?.auditTrail?.filter(e => e.projection === "community_summary").map(e => [e.chapter, e.status]))
        .toEqual([[2, "failed"], [3, "failed"]])

      const newer = persistedLedger().chapters["1"].community_summary
      expect(newer.status).toBe("pending")
      expect(newer.attemptId).toBeTruthy()
      expect(newer.attemptId).not.toBe(live.attemptId)
      const beforeScan = snapshotFiles.get(LEDGER_PATH)
      const writesBeforeScan = fsMocks.writeFileAtomic.mock.calls.length
      await recoverInterruptedCommunitySummaryAttempts(PROJECT)
      expect(snapshotFiles.get(LEDGER_PATH)).toBe(beforeScan)
      expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(writesBeforeScan)
      expect(streamChatMock).toHaveBeenCalledTimes(2)
      expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(1)

      finishFirst()
      await vi.waitFor(() => {
        expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(2)
        // 旧 attempt 终态 CAS 被较新 pending 挡下 → 不追加误导性 terminal 审计。
        expect(persistedLedger().auditTrail?.filter(e => e.projection === "community_summary" && e.chapter === 1 && (e.status === "rebuild" || e.status === "failed"))).toHaveLength(0)
      })
      expect(persistedLedger().chapters["1"].community_summary).toEqual(newer)

      finishSecond()
      await vi.waitFor(() => {
        const persisted = persistedLedger()
        expect(persisted.chapters["1"].community_summary.status).toBe("committed")
        expect(persisted.auditTrail?.filter(e => e.projection === "community_summary" && e.status === "rebuild")).toHaveLength(1)
      })
      expect(storeState.setCommunitySummaryError).not.toHaveBeenCalled()
    } finally {
      finishFirst()
      finishSecond()
    }
  })

  it("queues another chapter's summary past the file-lock watchdog without reporting failure", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true }
    mockLlmJsonResponse(llmSnapshotJson())
    let releaseFirst!: () => void
    const work = new Promise<void>(resolve => { releaseFirst = resolve })
    moduleMocks.generateCommunitySummaries.mockImplementationOnce(() => work)
    vi.useFakeTimers()
    try {
      const first = await ingestChapter(PROJECT, CHAPTER_PATH)
      expect(first.pendingProjections).toEqual(["community_summary"])
      await vi.waitFor(() => expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(1))
      const secondPath = `${PROJECT}/wiki/chapters/chapter-002.md`
      snapshotFiles.set(secondPath, chapterContent().replace("chapter_number: 1", "chapter_number: 2"))
      mockLlmJsonResponse(llmSnapshotJson({ chapterId: "chapter-2", chapterNumber: 2 }))
      const second = await ingestChapter(PROJECT, secondPath)
      expect(second.pendingProjections).toEqual(["community_summary"])
      await vi.advanceTimersByTimeAsync(10_001)
      expect(persistedLedger().chapters["2"].community_summary.status).toBe("pending")
      expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(1)
      expect(storeState.setCommunitySummaryError).not.toHaveBeenCalled()
      releaseFirst()
      await vi.waitFor(() => {
        expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(2)
        expect(persistedLedger().chapters["1"].community_summary.status).toBe("committed")
        expect(persistedLedger().chapters["2"].community_summary.status).toBe("committed")
      })
    } finally {
      releaseFirst()
      vi.useRealTimers()
    }
  })

  it("does not start a model call if the pending cell cannot be saved", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true }
    mockLlmJsonResponse(llmSnapshotJson())
    let refused = 0
    fsMocks.writeFileAtomic.mockImplementation(async (path: string, raw: string) => {
      if (path === LEDGER_PATH && (JSON.parse(raw) as Partial<ProjectionStatusLedger>).chapters?.["1"]?.community_summary?.status === "pending") {
        refused++
        throw new Error("pending write denied")
      }
      snapshotFiles.set(path, raw)
    })

    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(refused).toBe(2)
    expect(result.ledgerSaveFailed).toBe(true)
    expect(result.pendingProjections).toEqual([])
    expect(result.failedProjections).toContain("community_summary")
    expect(moduleMocks.generateCommunitySummaries).not.toHaveBeenCalled()
  })

  it("recovers a pending attempt on next ingest after its terminal save retries fail, without rerunning summaries", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true }
    mockLlmJsonResponse(llmSnapshotJson())
    let refused = 0
    fsMocks.writeFileAtomic.mockImplementation(async (path: string, raw: string) => {
      if (path === LEDGER_PATH && (JSON.parse(raw) as Partial<ProjectionStatusLedger>).chapters?.["1"]?.community_summary?.status === "committed") {
        refused++
        throw new Error("terminal write denied")
      }
      snapshotFiles.set(path, raw)
    })

    const initial = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(initial.pendingProjections).toEqual(["community_summary"])
    await vi.waitFor(() => expect(storeState.setCommunitySummaryError).toHaveBeenCalledWith(
      "Community summary finished but its final status could not be saved.",
    ))
    expect(refused).toBe(2)
    const abandoned = persistedLedger().chapters["1"].community_summary
    expect(abandoned.status).toBe("pending")
    expect(abandoned.attemptId).toBeTruthy()

    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(false)
    await ingestChapter(PROJECT, CHAPTER_PATH)
    const persisted = persistedLedger()
    expect(persisted.chapters["1"].community_summary).toMatchObject({
      status: "failed", attemptId: abandoned.attemptId, last_error: expect.stringContaining("retry budget exhausted"),
    })
    expect(persisted.auditTrail?.filter(e => e.projection === "community_summary")).toMatchObject([{ status: "failed" }])
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledTimes(1)
  })

  it("sync 摘要（communitySummaryAsync:false 无 await）：叶子失败计 failed 且无 pending", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: false } as NovelConfig
    moduleMocks.generateCommunitySummaries.mockImplementation(async (...args: unknown[]) => {
      const report = args[4] as (cause: unknown) => void
      report(new Error("sync summary boom"))
    })
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(result.failedProjections).toContain("community_summary")
    expect(result.pendingProjections).toEqual([])
    const ledger = JSON.parse(snapshotFiles.get(`${PROJECT}/.novel/projection-status.json`)!) as {
      chapters?: Record<string, Record<string, { status?: string }>>
    }
    expect(ledger.chapters?.["1"]?.community_summary?.status).toBe("failed")
  })
})

describe("ingestChapter — 显式再摄取唯一正式源复核（requireUniqueFinalChapter）", () => {
  it.each([false, true])("rejects a duplicate final source (duplicate appears during extraction: %s)", async (appearsDuringExtraction) => {
    const chaptersDir = `${PROJECT}/wiki/chapters`
    const firstNode = { name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false }
    const altNode = { name: "alternate.md", path: `${PROJECT}/wiki/chapters/alternate.md`, is_dir: false }
    let calls = 0
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir) !== chaptersDir) throw new Error("ENOENT: no such file or directory")
      calls++
      return calls === 1 && appearsDuringExtraction ? [firstNode] : [firstNode, altNode]
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("chapter-001.md") || p.endsWith("alternate.md")) return chapterContent()
      const saved = snapshotFiles.get(p)
      if (saved !== undefined) return saved
      throw new Error("ENOENT")
    })
    mockLlmJsonResponse(llmSnapshotJson())

    await expect(ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, {
      requireUniqueFinalChapter: true,
    })).rejects.toThrow("Multiple final chapter files share chapter number 1")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
    expect(streamChatMock).toHaveBeenCalledTimes(appearsDuringExtraction ? 1 : 0)
    expect(calls).toBe(appearsDuringExtraction ? 2 : 1)
  })

  it.each([false, true])("requires a durable reservation before replacing a snapshot (reservation denied: %s)", async (reservationDenied) => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir !== `${PROJECT}/wiki/chapters`) throw new Error("ENOENT")
      return [{ name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false }]
    })
    snapshotFiles.set(LEDGER_PATH, JSON.stringify(
      recordProjectionStatus(
        recordProjectionStatus(emptyLedger(), 1, "chapter_ingest_output", "committed"),
        1, "sync_snapshot_to_memory", "committed",
      ),
    ))
    fsMocks.writeFileAtomic.mockImplementation(async (path: string, raw: string) => {
      if (path === LEDGER_PATH) {
        const entry = (JSON.parse(raw) as ProjectionStatusLedger).chapters["1"]?.chapter_ingest_output
        if (entry?.status === "failed" || (reservationDenied && entry?.status === "pending")) throw new Error("ledger unavailable")
      }
      if (path.endsWith("/001.output.json")) throw new Error("output unavailable")
      snapshotFiles.set(path, raw)
    })
    mockLlmJsonResponse(llmSnapshotJson())
    await expect(ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { requireUniqueFinalChapter: true }))
      .rejects.toThrow(reservationDenied ? "Could not save the reingest reservation" : "output unavailable")
    const chapter = persistedLedger().chapters["1"]
    if (reservationDenied) {
      expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
      expect(chapter.chapter_ingest_output.status).toBe("committed")
    } else {
      expect(fsMocks.writeFilesAtomic).toHaveBeenCalledTimes(1)
      expect(chapter.chapter_ingest_output.status).toBe("pending")
      expect(chapter.sync_snapshot_to_memory.status).toBe("pending")
    }
    expect(moduleMocks.writeSnapshotToWiki).not.toHaveBeenCalled()
  })

  it("source_fence 失败时将已预留的 pending cell 精准收敛为 failed（不再永久残留 pending）", async () => {
    const snapPath = `${PROJECT}/.novel/snapshots/001.snapshot.json`
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir !== `${PROJECT}/wiki/chapters`) throw new Error("ENOENT")
      return [{ name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false }]
    })
    const defaultRead = fsMocks.readFile.getMockImplementation()!
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/facts.json")) {
        // 模拟提交后、投影加锁前 current 快照被外部篡改，触发 source_fence 失败。
        snapshotFiles.set(snapPath, JSON.stringify({
          ...llmSnapshotJson(),
          revision: 9,
          snapshotId: "chapter-1-r9",
          isHistorical: false,
        }, null, 2))
      }
      return defaultRead(path)
    })
    mockLlmJsonResponse(llmSnapshotJson())

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { requireUniqueFinalChapter: true })
    expect(result.projectionError).toEqual({
      stage: "source_fence",
      message: "Current snapshot no longer matches the extraction commit.",
    })
    const chapter = persistedLedger().chapters["1"]
    expect(chapter.chapter_ingest_output?.status).toBe("failed")
    expect(chapter.chapter_ingest_output?.last_error).toContain("Current snapshot no longer matches")
    expect(chapter.sync_snapshot_to_memory?.status).toBe("failed")
    expect(chapter.sync_snapshot_to_memory?.last_error).toContain("Current snapshot no longer matches")
  })

  it("source_fence 失败但新写者已接管账本 → CAS 返回 superseded，绝不覆盖新写者状态", async () => {
    const snapPath = `${PROJECT}/.novel/snapshots/001.snapshot.json`
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir !== `${PROJECT}/wiki/chapters`) throw new Error("ENOENT")
      return [{ name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false }]
    })
    let newerLedgerJson = ""
    const defaultRead = fsMocks.readFile.getMockImplementation()!
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/facts.json")) {
        // 模拟新写者已写盘 r9 并在账本登记了自己的新 pending（不同 attemptId）。
        snapshotFiles.set(snapPath, JSON.stringify({
          ...llmSnapshotJson(),
          revision: 9,
          snapshotId: "chapter-1-r9",
          isHistorical: false,
        }, null, 2))
        let newer = recordProjectionStatus(emptyLedger(), 1, "chapter_ingest_output", "pending")
        newer = recordProjectionStatus(newer, 1, "sync_snapshot_to_memory", "pending")
        newer.chapters["1"]!.chapter_ingest_output!.attemptId = "newer-writer-attempt"
        newer.chapters["1"]!.sync_snapshot_to_memory!.attemptId = "newer-writer-attempt"
        newerLedgerJson = JSON.stringify(newer, null, 2)
        snapshotFiles.set(LEDGER_PATH, newerLedgerJson)
      }
      return defaultRead(path)
    })
    mockLlmJsonResponse(llmSnapshotJson())

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { requireUniqueFinalChapter: true })
    expect(result.projectionError?.stage).toBe("source_fence")
    // 旧写者 CAS 发现 cell 已被新写者替换，返回 superseded 且零覆盖。
    expect(snapshotFiles.get(LEDGER_PATH)).toBe(newerLedgerJson)
    const chapter = persistedLedger().chapters["1"]
    expect(chapter.chapter_ingest_output).toMatchObject({ status: "pending", attemptId: "newer-writer-attempt" })
    expect(chapter.sync_snapshot_to_memory).toMatchObject({ status: "pending", attemptId: "newer-writer-attempt" })
  })
})

describe("ingestChapter — 持久化中断诊断（onPersistenceFailure）", () => {
  it("output write interrupted → ledger cells failed, then flip back on retry", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    snapshotFiles.set(LEDGER_PATH, JSON.stringify(
      recordProjectionStatus(
        recordProjectionStatus(emptyLedger(), 1, "chapter_ingest_output", "committed"),
        1, "sync_snapshot_to_memory", "committed",
      ),
    ))
    const storeWrite = async (path: string, raw: string) => { snapshotFiles.set(String(path), String(raw)) }
    fsMocks.writeFileAtomic.mockImplementation(async (path: string, raw: string) => {
      if (String(path).endsWith("/001.output.json")) throw new Error("output write interrupted")
      await storeWrite(path, raw)
    })

    await expect(ingestChapter(PROJECT, CHAPTER_PATH)).rejects.toThrow("output write interrupted")
    expect(snapshotFiles.has(`${PROJECT}/.novel/snapshots/001.snapshot.json`)).toBe(true)
    const failed = persistedLedger().chapters["1"]
    expect(failed.chapter_ingest_output?.status).toBe("failed")
    expect(failed.sync_snapshot_to_memory?.status).toBe("failed")
    expect(moduleMocks.writeSnapshotToWiki).not.toHaveBeenCalled()

    fsMocks.writeFileAtomic.mockImplementation(storeWrite)
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const recovered = persistedLedger().chapters["1"]
    expect(recovered.chapter_ingest_output?.status).toBe("committed")
    expect(recovered.sync_snapshot_to_memory?.status).toBe("committed")
    expect(result.ledgerSaveFailed).toBe(false)
  })
})

describe("ingestChapter — 提交点顺序不变量（commit-then-project）", () => {
  it("writes the snapshot before any projection runs", async () => {
    const order: string[] = []
    fsMocks.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>) => {
      order.push("snapshot")
      for (const [fp, raw] of files) snapshotFiles.set(String(fp), String(raw))
    })
    moduleMocks.writeSnapshotToWiki.mockImplementation(async () => {
      order.push("projection")
      return []
    })
    mockLlmJsonResponse(llmSnapshotJson())
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(order).toContain("projection")
    expect(order.indexOf("snapshot")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("snapshot")).toBeLessThan(order.indexOf("projection"))
  })

  it("returns the committed snapshot with memorySyncedAt", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    const snapshot = result.snapshot as ChapterSnapshot
    expect(snapshot).not.toBeNull()
    expect(snapshot.chapterNumber).toBe(1)
    // memorySyncedAt 落在 snapshot 对象内部（不是 IngestResult 顶层）
    expect(snapshot.memorySyncedAt).toEqual(expect.any(String))
  })

  it("distinguishes a projection runner exception from a failed ledger save or missing extraction", async () => {
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    moduleMocks.generateCommunitySummaries.mockRejectedValueOnce(new Error("summary failure"))
    mockLlmJsonResponse(llmSnapshotJson())

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, {
      onCommunitySummaryError: () => { throw new Error("notification unavailable") },
    })
    expect(result.projectionError).toEqual({ stage: "projection_runner", message: "notification unavailable" })
    expect(result).not.toHaveProperty("ledgerSaveFailed")
    expect(result.failedProjections).toEqual([])
    expect(result.committedProjections).toEqual([])
    expect(result.receipt?.snapshotIdAtExtractionCommit).toBe("chapter-1-r1")
    expect(result.projectionReceipt).toBeUndefined()
    expect(persistedLedger().chapters["1"].community_summary.status).toBe("failed")
  })
})

describe("prepare→commit 两段式（阶段 1 提取 / 阶段 2 守卫提交）", () => {
  beforeEach(() => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir !== `${PROJECT}/wiki/chapters`) throw new Error("ENOENT")
      return [{ name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false }]
    })
  })

  it("prepare 返回剥离 originalContent 的 source；源被改动后 commit 拒绝 source_changed（无 replay/无写/无重提取）", async () => {
    mockLlmJsonResponse(llmSnapshotJson())

    const prepared = await prepareChapterIngest(PROJECT, CHAPTER_PATH, 1)
    expect(prepared.snapshot.chapterNumber).toBe(1)
    expect(prepared.source).not.toHaveProperty("originalContent")
    expect(prepared.source.readPath).toBe(CHAPTER_PATH)
    expect(prepared.source.chapterNumber).toBe(1)
    expect(typeof prepared.source.bodySha256).toBe("string")
    expect(typeof prepared.source.contentSha256).toBe("string")

    // 提取之后源被改动 → 后续 CHAPTER_PATH 全部读到新字节。
    const edited = `${chapterContent()}
Edited`
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("chapter-001.md")) return edited
      const saved = snapshotFiles.get(p)
      if (saved !== undefined) return saved
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    streamChatMock.mockClear()

    const beforeFormalEffects = vi.fn(async () => {})
    const result = await commitPreparedChapterIngest(PROJECT, prepared, beforeFormalEffects)
    expect(result).toEqual({ snapshot: null, failReason: "source_changed" })
    expect(beforeFormalEffects).not.toHaveBeenCalled()
    // 拒绝早于一切正式效果：不 replay Canon、不自愈、不批量写、不重提取。
    expect(moduleMocks.replayPendingQueue).not.toHaveBeenCalled()
    expect(moduleMocks.selfHealFailedProjections).not.toHaveBeenCalled()
    expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("prepare 后第二份同号正式章出现 → commit 拒绝（唯一源复核，不 replay/不写）", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    const prepared = await prepareChapterIngest(PROJECT, CHAPTER_PATH, 1)

    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir !== `${PROJECT}/wiki/chapters`) throw new Error("ENOENT")
      return [
        { name: "chapter-001.md", path: CHAPTER_PATH, is_dir: false },
        { name: "duplicate.md", path: `${PROJECT}/wiki/chapters/duplicate.md`, is_dir: false },
      ]
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("chapter-001.md") || p.endsWith("duplicate.md")) return chapterContent()
      const saved = snapshotFiles.get(p)
      if (saved !== undefined) return saved
      throw new Error("ENOENT: no such file or directory")
    })

    await expect(commitPreparedChapterIngest(PROJECT, prepared)).rejects.toThrow(
      "Multiple final chapter files share chapter number 1",
    )
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(moduleMocks.replayPendingQueue).not.toHaveBeenCalled()
    expect(moduleMocks.selfHealFailedProjections).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
  })

  it("同字节源 → commitPreparedChapterIngest 用已提取快照落盘（无第二次模型调用）", async () => {
    mockLlmJsonResponse(llmSnapshotJson())
    const prepared = await prepareChapterIngest(PROJECT, CHAPTER_PATH, 1)
    streamChatMock.mockClear()

    const result = await commitPreparedChapterIngest(PROJECT, prepared)
    expect(result.snapshot?.chapterNumber).toBe(1)
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it.each(["body", "BOM", "header"] as const)("rejects changed %s before any effect（exactUtf8 基线逐字节）", async (change) => {
    const original = "\uFEFF" + chapterContent().replace(/\r?\n/g, "\r\n")
    fsMocks.readFile.mockResolvedValueOnce(original)
    mockLlmJsonResponse(llmSnapshotJson())

    const prepared = await prepareChapterIngest(PROJECT, CHAPTER_PATH, 1)
    expect(prepared.source.contentSha256).toBe(await computeCheckpointDigest(original))

    const edited = change === "BOM"
      ? original.slice(1)
      : change === "header"
        ? original.replace("chapter_status: final", "chapter_status: draft")
        : `${original}\r\nEdited`
    expect(edited).not.toBe(original)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("chapter-001.md")) return edited
      const saved = snapshotFiles.get(p)
      if (saved !== undefined) return saved
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    streamChatMock.mockClear()

    const result = await commitPreparedChapterIngest(PROJECT, prepared)
    expect(result).toEqual({ snapshot: null, failReason: "source_changed" })
    expect(moduleMocks.replayPendingQueue).not.toHaveBeenCalled()
    expect(moduleMocks.selfHealFailedProjections).not.toHaveBeenCalled()
    expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("prepare 拒绝非 chapter 类型（与扫描同判）", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent().replace("type: chapter", "type: outline"))
    mockLlmJsonResponse(llmSnapshotJson())
    await expect(prepareChapterIngest(PROJECT, CHAPTER_PATH, 1)).rejects.toThrow("not_chapter")
    expect(streamChatMock).not.toHaveBeenCalled()
  })
})
