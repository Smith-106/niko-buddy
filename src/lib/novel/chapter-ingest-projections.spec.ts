import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_NOVEL_CONFIG, type EmbeddingConfig, type LlmConfig, type NovelConfig } from "@/stores/wiki-store"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn<() => Promise<string>>(),
  writeSnapshotToWiki: vi.fn<() => Promise<void>>(),
  writePatchFieldsToWiki: vi.fn<() => Promise<void>>(),
  generateCommunitySummaries: vi.fn<(...args: unknown[]) => Promise<void>>(),
  appendProjectionAuditEntry: vi.fn<() => Promise<void>>(),
  setCommunitySummaryError: vi.fn<(msg: string | null) => void>(),
  resolveNovelModel: vi.fn<(llm: LlmConfig, novel: NovelConfig, task: string) => LlmConfig>(),
  hasUsableLlm: vi.fn<(cfg: LlmConfig) => boolean>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...(args as [])),
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: (cfg: LlmConfig) => mocks.hasUsableLlm(cfg),
}))

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (llm: LlmConfig, novel: NovelConfig, task: string) =>
    mocks.resolveNovelModel(llm, novel, task),
}))

vi.mock("./graph-adapter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./graph-adapter")>()
  return {
    ...orig,
    writeSnapshotToWiki: (...args: unknown[]) => mocks.writeSnapshotToWiki(...(args as [])),
    writePatchFieldsToWiki: (...args: unknown[]) => mocks.writePatchFieldsToWiki(...(args as [])),
  }
})

vi.mock("./community-summary", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./community-summary")>()
  return {
    ...orig,
    generateCommunitySummaries: (...args: unknown[]) => mocks.generateCommunitySummaries(...args),
  }
})

vi.mock("./projection-status-ledger", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./projection-status-ledger")>()
  return {
    ...orig,
    PROJECTION_REGISTRY: {},
    appendProjectionAuditEntry: (...args: unknown[]) => mocks.appendProjectionAuditEntry(...(args as [])),
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...orig,
    useWikiStore: {
      getState: () => ({
        setCommunitySummaryError: mocks.setCommunitySummaryError,
        providerConfigs: {},
        defaultLlmModel: "",
        aiChatModel: "",
      }),
    },
  }
})

import { runIngestProjections, type RunIngestProjectionsParams } from "./chapter-ingest-projections"

const DISABLED_EMB: EmbeddingConfig = {
  enabled: false,
  endpoint: "",
  apiKey: "",
  model: "",
}

function makeSnapshot(chapterNumber = 5): ChapterSnapshot {
  return {
    chapterId: `chapter-${String(chapterNumber).padStart(3, "0")}`,
    chapterNumber,
    chapterTitle: `第${chapterNumber}章`,
    summary: "测试章节摘要",
    characters: [],
    locations: [],
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
    entityIsNew: {},
    validationWarnings: [],
  } as unknown as ChapterSnapshot
}

function makeParams(overrides: Partial<RunIngestProjectionsParams> = {}): {
  params: RunIngestProjectionsParams
  savedLedgers: ProjectionStatusLedger[]
} {
  const savedLedgers: ProjectionStatusLedger[] = []
  const novelConfig: NovelConfig = {
    ...DEFAULT_NOVEL_CONFIG,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    communitySummaryAsync: false,
  }
  const llmConfig: LlmConfig = {
    provider: "openai",
    apiKey: "",
    model: "",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128_000,
  }
  const params: RunIngestProjectionsParams = {
    pp: "/proj",
    chapterPath: "/proj/wiki/chapters/chapter-005.md",
    chapterNo: 5,
    content: "测试正文",
    fm: { title: "第5章" },
    snapshot: makeSnapshot(5),
    embCfg: DISABLED_EMB,
    llmConfig,
    novelConfig,
    options: {},
    exportStructuredMemoryToWiki: vi.fn(async () => []),
    syncSnapshotToMemory: vi.fn(async () => ({
      writtenEntityPaths: [],
      memoryPagePaths: [],
      memorySyncedAt: "2026-11-26T00:00:00.000Z",
      failedProjections: [],
      driftSuspected: [],
    })),
    saveProjectionLedgerWithSingleRetry: vi.fn(async (_pp, ledger) => {
      savedLedgers.push(ledger)
      return true
    }),
    ...overrides,
  }
  return { params, savedLedgers }
}

describe("chapter-ingest-projections — zero-LLM community_summary guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readFile.mockResolvedValue("{}")
    mocks.writeSnapshotToWiki.mockResolvedValue(undefined)
    mocks.writePatchFieldsToWiki.mockResolvedValue(undefined)
    mocks.generateCommunitySummaries.mockResolvedValue(undefined)
    mocks.appendProjectionAuditEntry.mockResolvedValue(undefined)
    mocks.resolveNovelModel.mockImplementation((llm) => llm)
    mocks.hasUsableLlm.mockReturnValue(false)
  })

  it("未配置可用摘要模型（hasUsableLlm=false）时静默跳过 community_summary：不调 LLM、不抛错、不污染 ledger", async () => {
    const onCommunitySummaryError = vi.fn()
    const { params, savedLedgers } = makeParams({
      options: { onCommunitySummaryError },
    })

    const result = await runIngestProjections(params)

    expect(mocks.resolveNovelModel).toHaveBeenCalledWith(params.llmConfig, params.novelConfig, "summary")
    expect(mocks.hasUsableLlm).toHaveBeenCalledTimes(1)
    expect(mocks.generateCommunitySummaries).not.toHaveBeenCalled()
    expect(onCommunitySummaryError).not.toHaveBeenCalled()
    expect(mocks.setCommunitySummaryError).not.toHaveBeenCalled()
    expect(result.failedProjections).not.toContain("community_summary")
    expect(result.pendingProjections).not.toContain("community_summary")
    expect(result.committedProjections).not.toContain("community_summary")
    expect(result.finalizeAwaitedCommunitySummary).toBeUndefined()
    // 账本中不得残留 failed 或 pending 的 community_summary 记录
    expect(savedLedgers).toHaveLength(1)
    expect(savedLedgers[0]?.chapters["5"]?.community_summary).toBeUndefined()
  })

  it("async/awaitCommunitySummary 模式下未配置可用模型同样干净跳过（不写入 pending 也不返回 finalize 回调）", async () => {
    const { params, savedLedgers } = makeParams({
      novelConfig: {
        ...DEFAULT_NOVEL_CONFIG,
        communitySummaryEnabled: true,
        communitySummaryInterval: 5,
        communitySummaryAsync: true,
      },
      options: { awaitCommunitySummary: true },
    })

    const result = await runIngestProjections(params)

    expect(mocks.generateCommunitySummaries).not.toHaveBeenCalled()
    expect(result.pendingProjections).toEqual([])
    expect(result.failedProjections).toEqual([])
    expect(result.finalizeAwaitedCommunitySummary).toBeUndefined()
    expect(savedLedgers[0]?.chapters["5"]?.community_summary).toBeUndefined()
  })

  it("配置了可用摘要模型（hasUsableLlm=true）时正常执行 community_summary 并记账 committed", async () => {
    const resolvedSummaryCfg: LlmConfig = {
      provider: "openai",
      apiKey: "sk-summary-ok",
      model: "gpt-4o-mini",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
    }
    mocks.resolveNovelModel.mockReturnValue(resolvedSummaryCfg)
    mocks.hasUsableLlm.mockReturnValue(true)

    const { params, savedLedgers } = makeParams({
      llmConfig: resolvedSummaryCfg,
    })

    const result = await runIngestProjections(params)

    expect(mocks.resolveNovelModel).toHaveBeenCalledWith(params.llmConfig, params.novelConfig, "summary")
    expect(mocks.hasUsableLlm).toHaveBeenCalledWith(resolvedSummaryCfg)
    expect(mocks.generateCommunitySummaries).toHaveBeenCalledTimes(1)
    expect(result.committedProjections).toContain("community_summary")
    expect(result.failedProjections).not.toContain("community_summary")
    expect(savedLedgers[0]?.chapters["5"]?.community_summary?.status).toBe("committed")
  })

  it("配置了可用摘要模型且 awaitCommunitySummary=true 时正确走 pending -> finalize committed", async () => {
    const usableCfg: LlmConfig = {
      provider: "openai",
      apiKey: "sk-summary-ok",
      model: "gpt-4o-mini",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
    }
    mocks.resolveNovelModel.mockReturnValue(usableCfg)
    mocks.hasUsableLlm.mockReturnValue(true)

    const { params } = makeParams({
      llmConfig: usableCfg,
      options: { awaitCommunitySummary: true },
    })

    const result = await runIngestProjections(params)

    expect(result.pendingProjections).toEqual(["community_summary"])
    expect(typeof result.finalizeAwaitedCommunitySummary).toBe("function")
    const finalResult = await result.finalizeAwaitedCommunitySummary!()
    expect(mocks.generateCommunitySummaries).toHaveBeenCalledTimes(1)
    expect(finalResult.committedProjections).toContain("community_summary")
    expect(finalResult.failedProjections).not.toContain("community_summary")
    expect(finalResult.pendingProjections).toEqual([])
  })
})
