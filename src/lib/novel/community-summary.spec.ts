import { describe, expect, it, vi, beforeEach } from "vitest"
import type { CommunityInfo, GraphNode } from "@/lib/wiki-graph"
import type { CommunitySummaryRecord } from "./community-summary"
import { DEFAULT_NOVEL_CONFIG, type LlmConfig } from "@/stores/wiki-store"
import { logger } from "@/lib/utils"

const fsMocks = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeFilesAtomic: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (...args: unknown[]) => fsMocks.readFile(...args),
      writeFile: (...args: unknown[]) => fsMocks.writeFile(...args),
      writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
      writeFilesAtomic: (...args: unknown[]) => fsMocks.writeFilesAtomic(...args),
      fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
      createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
      listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
    
  }
})

// 可变的 store state：测试内可切换 embedding 开关
const wikiStoreState = {
  embeddingConfig: { enabled: true, model: "test-model" },
  novelConfig: { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 },
}

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: { getState: () => wikiStoreState },
  }
})

const streamChatMock = vi.fn()
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: (...args: unknown[]) => streamChatMock(...args),
      // mirror real combineAbortSignals: 任一 abort 即合并 abort
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

const buildWikiGraphMock = vi.fn()
vi.mock("@/lib/wiki-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki-graph")>()
  return {
    ...actual,
      buildWikiGraph: (...args: unknown[]) => buildWikiGraphMock(...args),
    
  }
})

vi.mock("@/lib/novel/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/model-resolver")>()
  return {
    ...actual,
      resolveNovelModel: (cfg: unknown) => cfg,
    
  }
})

const embedPageMock = vi.fn()
const indexCommunitySummaryMock = vi.fn()
const searchByEmbeddingMock = vi.fn()
vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
      embedPage: (...args: unknown[]) => embedPageMock(...args),
      indexCommunitySummary: (...args: unknown[]) => indexCommunitySummaryMock(...args),
      searchByEmbedding: (...args: unknown[]) => searchByEmbeddingMock(...args),
    
  }
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function makeCommunity(id: number): CommunityInfo {
  return { id, nodeCount: 2, cohesion: 0.5, topNodes: [`成员${id}`] }
}

function makeNodes(ids: number[]): GraphNode[] {
  return ids.flatMap((id) => [
    { id: `n${id}-a`, label: `成员${id}`, type: "character", path: `/p/wiki/${id}-a.md`, linkCount: 3, community: id },
    { id: `n${id}-b`, label: `地点${id}`, type: "location", path: `/p/wiki/${id}-b.md`, linkCount: 1, community: id },
  ])
}

/** 从 user prompt（“社区 ID: X”）解析当前 mock 正在服务的社区 id */
function communityIdFromMessages(messages: unknown[]): number {
  const second = messages[1] as { content?: string } | undefined
  const userPrompt = typeof second?.content === "string" ? second.content : ""
  return Number(userPrompt.match(/社区 ID: (\d+)/)?.[1] ?? 0)
}

const llmConfig = { provider: "custom", apiKey: "x", model: "mock" } as LlmConfig
const summaryDir = "/p/.novel/community-summaries"
const manifestPath = `${summaryDir}/current-set.json`

function publishedRecord(overrides: Partial<CommunitySummaryRecord> = {}): CommunitySummaryRecord {
  return {
    communityId: 1,
    summary: "已发布摘要",
    nodeCount: 2,
    topNodes: ["成员1"],
    generatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }
}

function setRaw(vectorSlot: 0 | 1 | null, records: CommunitySummaryRecord[]): string {
  return JSON.stringify({ schemaVersion: 1, vectorSlot, records })
}

describe("generateCommunitySummaries (TASK-402 并行限流 + 原子发布)", () => {
  const files = new Map<string, string>()

  function mockGeneration(ids: number[]): void {
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken: (text: string) => void; onDone: () => void }) => {
      callbacks.onToken(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone()
    })
  }

  function persistedSet() {
    return JSON.parse(files.get(manifestPath)!) as { vectorSlot: 0 | 1 | null; records: CommunitySummaryRecord[] }
  }

  beforeEach(() => {
    files.clear()
    fsMocks.readFile.mockReset().mockImplementation(async (path: string) => {
      const persisted = files.get(path)
      if (persisted !== undefined) return persisted
      if (path.startsWith("/p/wiki/")) return "成员正文内容"
      throw new Error("ENOENT")
    })
    fsMocks.writeFile.mockReset().mockImplementation(async (path: string, raw: string) => {
      files.set(path, raw)
    })
    fsMocks.writeFileAtomic.mockReset().mockImplementation(async (path: string, raw: string) => {
      files.set(path, raw)
    })
    fsMocks.writeFilesAtomic.mockReset().mockImplementation(async (entries: Array<[string, string]>, expectedContents?: (string | null)[]) => {
      for (const [i, [path]] of entries.entries()) {
        const current = files.has(path) ? files.get(path)! : null
        if (expectedContents !== undefined && current !== expectedContents[i]) {
          throw new Error(`Batch target '${path}' changed before staging; left untouched`)
        }
      }
      for (const [path, raw] of entries) {
        files.set(path, raw)
      }
    })
    fsMocks.fileExists.mockReset().mockImplementation(async (path: string) => files.has(path))
    fsMocks.createDirectory.mockReset().mockResolvedValue(undefined)
    fsMocks.listDirectory.mockReset()
    streamChatMock.mockReset()
    buildWikiGraphMock.mockReset().mockResolvedValue({ nodes: [], communities: [] })
    embedPageMock.mockReset()
    indexCommunitySummaryMock.mockReset().mockResolvedValue(undefined)
    searchByEmbeddingMock.mockReset()
    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
  })

  it("limits concurrent community LLM calls to maxConcurrency", async () => {
    const ids = [1, 2, 3, 4, 5, 6]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })

    let active = 0
    let peak = 0
    let calls = 0
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      calls++
      active++
      peak = Math.max(peak, active)
      await delay(30)
      callbacks.onToken?.(`摘要-${calls}`)
      callbacks.onDone?.()
      active--
    })

    const { generateCommunitySummaries, maxConcurrency } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)

    // 6 个社区全部调用 LLM
    expect(calls).toBe(6)
    // 并发峰值不超过 maxConcurrency（限流生效）
    expect(peak).toBeLessThanOrEqual(maxConcurrency)
    // 且确实发生了并行（串行实现 peak 恒为 1）
    expect(peak).toBeGreaterThan(1)
    // 所有社区通过一次发布写盘。
    expect(fsMocks.writeFilesAtomic).toHaveBeenCalledTimes(1)
    expect(persistedSet().records.map(record => record.communityId)).toEqual(ids)
  })

  it("publishes one set in input community order after indexing and reads back the exact bytes", async () => {
    const ids = [2, 5, 1]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })

    // 完成顺序故意与输入序相反：社区 1 最先完成，社区 2 最后完成
    const delayByCommunity: Record<number, number> = { 2: 60, 5: 30, 1: 5 }
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      const id = communityIdFromMessages(messages)
      await delay(delayByCommunity[id] ?? 10)
      callbacks.onToken?.(`摘要-社区${id}`)
      callbacks.onDone?.()
    })

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)

    expect(fsMocks.writeFilesAtomic).toHaveBeenCalledExactlyOnceWith([[manifestPath, files.get(manifestPath)!]], [null])
    expect(fsMocks.writeFilesAtomic.mock.invocationCallOrder[0]).toBeGreaterThan(indexCommunitySummaryMock.mock.invocationCallOrder.slice(-1)[0])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(embedPageMock).not.toHaveBeenCalled()
    expect(indexCommunitySummaryMock.mock.calls.map(([, pageId]) => pageId)).toEqual(ids.map(id => `community-summary-0.${id}`))
    expect(persistedSet()).toMatchObject({
      schemaVersion: 1,
      vectorSlot: 0,
      records: ids.map(id => ({
        communityId: id, summary: `摘要-社区${id}`, nodeCount: 2, topNodes: [`成员${id}`], generatedAt: expect.any(String),
      })),
    })
  })

  it("collects all generation results but reports only the first failure and performs no writes", async () => {
    const ids = [1, 2, 3]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    const prior = setRaw(0, [publishedRecord()])
    files.set(manifestPath, prior)
    const firstError = new Error("LLM quota exceeded")

    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      const id = communityIdFromMessages(messages)
      if (id === 2) throw firstError
      if (id === 3) {
        await delay(5)
        throw new Error("another generation error")
      }
      callbacks.onToken?.(`摘要-社区${id}`)
      callbacks.onDone?.()
    })

    const { generateCommunitySummaries } = await import("./community-summary")
    const onFailure = vi.fn()
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig, undefined, onFailure)
    expect(streamChatMock).toHaveBeenCalledTimes(ids.length)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(firstError)
    expect(indexCommunitySummaryMock).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(files.get(manifestPath)).toBe(prior)
  })

  it("returns early when the graph has no communities", async () => {
    files.set(manifestPath, setRaw(0, [publishedRecord()]))
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(fsMocks.fileExists).not.toHaveBeenCalled()
    expect(fsMocks.writeFilesAtomic).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("skips communities that have no member nodes", async () => {
    mockGeneration([1, 2])
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([2]), communities: [1, 2].map(makeCommunity) })
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(persistedSet().records.map(record => record.communityId)).toEqual([2])
  })

  it.each(["vector", "manifest"] as const)("keeps the prior published set after a %s dependency failure", async (stage) => {
    mockGeneration([1, 2, 3])
    const priorRecord = publishedRecord()
    const prior = setRaw(0, [priorRecord])
    const legacyPath = `${summaryDir}/3.json`
    const lastGoodPath = `${legacyPath}.last-good`
    files.set(manifestPath, prior)
    files.set(legacyPath, "legacy bytes")
    files.set(lastGoodPath, "last-good bytes")
    const vectors = new Map([["community-summary-0.1", priorRecord.summary], ["community:3", "legacy vector"]])
    // 用非 Error 原因模拟底层拒绝；回调应保留实际原因。
    const failure = { code: stage === "vector" ? "LANCE" : "EIO" }
    indexCommunitySummaryMock.mockImplementation(async (_project: string, pageId: string, _title: string, text: string) => {
      if (stage === "vector" && pageId === "community-summary-1.2") throw failure
      vectors.set(pageId, text)
    })
    if (stage === "manifest") fsMocks.writeFilesAtomic.mockRejectedValueOnce(failure)

    const { generateCommunitySummaries, loadPersistedCommunitySummaries, searchCommunitySummaries } = await import("./community-summary")
    const onFailure = vi.fn()
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig, undefined, onFailure)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(indexCommunitySummaryMock.mock.calls.map(([, pageId]) => pageId)).toEqual(stage === "vector"
      ? ["community-summary-1.1", "community-summary-1.2"]
      : ["community-summary-1.1", "community-summary-1.2", "community-summary-1.3"])
    expect(fsMocks.writeFilesAtomic).toHaveBeenCalledTimes(stage === "vector" ? 0 : 1)
    expect(files.get(manifestPath)).toBe(prior)
    expect(files.get(legacyPath)).toBe("legacy bytes")
    expect(files.get(lastGoodPath)).toBe("last-good bytes")
    expect((await loadPersistedCommunitySummaries("/p")).records).toEqual([priorRecord])

    expect(vectors.get("community-summary-1.1")).toBe("摘要-社区1")
    searchByEmbeddingMock.mockResolvedValue([...vectors].reverse().map(([id, text]) => ({ id, matchedChunks: [{ text }] })))
    expect(await searchCommunitySummaries("/p", "q")).toBe(`- 【社区摘要·社区1】: ${priorRecord.summary}`)
  })

  it("switches the active slot only after staging and ignores the old slot afterward", async () => {
    mockGeneration([1])
    const prior = setRaw(0, [publishedRecord()])
    files.set(manifestPath, prior)
    indexCommunitySummaryMock.mockImplementation(async () => {
      expect(files.get(manifestPath)).toBe(prior)
    })

    const { generateCommunitySummaries, searchCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(persistedSet().vectorSlot).toBe(1)
    searchByEmbeddingMock.mockResolvedValue([
      { id: "community-summary-0.1", matchedChunks: [{ text: "已发布摘要" }] },
      { id: "community-summary-1.1", matchedChunks: [{ text: "摘要-社区1" }] },
    ])
    expect(await searchCommunitySummaries("/p", "q")).toBe("- 【社区摘要·社区1】: 摘要-社区1")
  })

  it("refuses to overwrite a manifest changed between the read and the publish (native CAS)", async () => {
    mockGeneration([1])
    const prior = setRaw(0, [publishedRecord()])
    files.set(manifestPath, prior)
    const newer = setRaw(0, [{ ...publishedRecord(), summary: "外部更新的摘要" }])
    indexCommunitySummaryMock.mockImplementation(async () => {
      files.set(manifestPath, newer)
    })

    const { generateCommunitySummaries } = await import("./community-summary")
    await expect(generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)).rejects.toThrow("changed before staging")
    expect(files.get(manifestPath)).toBe(newer)
    expect(fsMocks.writeFilesAtomic).toHaveBeenCalledTimes(1)
  })

  it("publishes a null vector slot when embedding is disabled", async () => {
    mockGeneration([1])
    files.set(manifestPath, setRaw(0, [publishedRecord()]))
    wikiStoreState.embeddingConfig = { enabled: false, model: "" }

    const { generateCommunitySummaries, searchCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(persistedSet()).toMatchObject({ vectorSlot: null, records: [{ summary: "摘要-社区1" }] })
    expect(indexCommunitySummaryMock).not.toHaveBeenCalled()
    // 查询侧已重新开启向量化，但发布时没有活跃槽，也不复用旧命中。
    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
    searchByEmbeddingMock.mockResolvedValue([
      { id: "community-summary-0.1", matchedChunks: [{ text: "已发布摘要" }] },
      { id: "community:2", matchedChunks: [{ text: "legacy vector" }] },
    ])
    expect(await searchCommunitySummaries("/p", "q")).toBe("")
  })

  it("rejects non-Error generation failures for strict consumers", async () => {
    mockGeneration([1, 2])
    streamChatMock.mockRejectedValueOnce("string-error")
    const { generateCommunitySummaries } = await import("./community-summary")
    await expect(generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)).rejects.toBe("string-error")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(indexCommunitySummaryMock).not.toHaveBeenCalled()
  })

  it.each([
    ["JSON", "{"],
    ["schema", JSON.stringify({ schemaVersion: 2, vectorSlot: 0, records: [publishedRecord()] })],
    ["slot", JSON.stringify({ schemaVersion: 1, vectorSlot: 2, records: [publishedRecord()] })],
    ["id", setRaw(0, [publishedRecord({ communityId: Number.MAX_SAFE_INTEGER + 1 })])],
    ["summary", setRaw(0, [publishedRecord({ summary: "  " })])],
    ["nodeCount", setRaw(0, [publishedRecord({ nodeCount: -1 })])],
    ["topNodes", JSON.stringify({ schemaVersion: 1, vectorSlot: 0, records: [{ ...publishedRecord(), topNodes: [42] }] })],
    ["generatedAt", setRaw(0, [publishedRecord(), publishedRecord({ communityId: 2, generatedAt: "bad date" })])],
    ["duplicate id", setRaw(0, [publishedRecord(), publishedRecord({ summary: "不同文本" })])],
  ])("refuses a corrupt published set (%s) without writing or falling back", async (_reason, raw) => {
    mockGeneration([1])
    files.set(manifestPath, raw)
    searchByEmbeddingMock.mockResolvedValue([
      { id: "community:1", matchedChunks: [{ text: "legacy vector" }] },
      { id: "community-summary-0.1", matchedChunks: [{ text: "已发布摘要" }] },
    ])

    const { generateCommunitySummaries, loadPersistedCommunitySummaries, searchCommunitySummaries } = await import("./community-summary")
    await expect(generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)).rejects.toThrow("Invalid published community summary set")
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      expect(await loadPersistedCommunitySummaries("/p")).toEqual({ text: "", records: [] })
      expect(await searchCommunitySummaries("/p", "q")).toBe("")
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith("CommunitySummary", "Invalid published community summary set.")
    } finally {
      warn.mockRestore()
    }
    expect(fsMocks.listDirectory).not.toHaveBeenCalled()
    expect(indexCommunitySummaryMock).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(files.get(manifestPath)).toBe(raw)
  })

  it("handles communities with empty topNodes", async () => {
    buildWikiGraphMock.mockResolvedValue({
      nodes: makeNodes([1]),
      communities: [{ id: 1, nodeCount: 1, cohesion: 0.5, topNodes: [] }],
    })
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("摘要")
      callbacks.onDone?.()
    })
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(persistedSet().records).toMatchObject([{ communityId: 1, topNodes: [] }])
    expect(indexCommunitySummaryMock).toHaveBeenCalledExactlyOnceWith(
      "/p", "community-summary-0.1", "社区 1 摘要（）", "摘要", wikiStoreState.embeddingConfig,
    )
  })
})

describe("shouldRebuildCommunitySummaries", () => {
  it("disabled or non-multiple chapter returns false", async () => {
    const { shouldRebuildCommunitySummaries } = await import("./community-summary")
    const enabled = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    const disabled = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: false }
    expect(shouldRebuildCommunitySummaries(5, enabled)).toBe(true)
    expect(shouldRebuildCommunitySummaries(6, enabled)).toBe(false)
    expect(shouldRebuildCommunitySummaries(0, enabled)).toBe(false)
    expect(shouldRebuildCommunitySummaries(5, disabled)).toBe(false)
    // interval 未配置 → 回退 5
    const noInterval = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true }
    expect(shouldRebuildCommunitySummaries(10, noInterval)).toBe(true)
    // interval 显式为 0 → 回退 5
    const zeroInterval = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 0 }
    expect(shouldRebuildCommunitySummaries(10, zeroInterval)).toBe(true)
  })
})

describe("generateSingleCommunitySummary / searchCommunitySummaries", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockResolvedValue("成员正文内容")
    fsMocks.fileExists.mockReset().mockResolvedValue(false)
    streamChatMock.mockReset()
    searchByEmbeddingMock.mockReset()
  })

  it("returns the no-content fallback when all member reads fail", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("enoent"))
    const community = makeCommunity(1)
    const { generateSingleCommunitySummary } = await import("./community-summary")
    const result = await generateSingleCommunitySummary(community, makeNodes([1]), llmConfig)
    expect(result).toContain("无法读取节点内容")
  })

  it("returns the fallback when the LLM stream produces empty output", async () => {
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onDone?.()
    })
    const { generateSingleCommunitySummary } = await import("./community-summary")
    const result = await generateSingleCommunitySummary(makeCommunity(1), makeNodes([1]), llmConfig)
    expect(result).toContain("包含 2 个节点")
  })

  it("propagates stream errors", async () => {
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onError?: (e: Error) => void }) => {
      callbacks.onError?.(new Error("boom"))
    })
    const { generateSingleCommunitySummary } = await import("./community-summary")
    await expect(generateSingleCommunitySummary(makeCommunity(1), makeNodes([1]), llmConfig)).rejects.toThrow("boom")
  })

  it("passes the caller signal through combineAbortSignals", async () => {
    const controller = new AbortController()
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void }, signal?: AbortSignal) => {
      expect(signal).toBeDefined()
      callbacks.onToken?.("令牌")
    })
    const { generateSingleCommunitySummary } = await import("./community-summary")
    const result = await generateSingleCommunitySummary(makeCommunity(1), makeNodes([1]), llmConfig, controller.signal)
    expect(result).toContain("令牌")
  })

  it("searchCommunitySummaries: returns empty when embedding disabled or no community results", async () => {
    const { searchCommunitySummaries } = await import("./community-summary")
    wikiStoreState.embeddingConfig = { enabled: false, model: "" }
    expect(await searchCommunitySummaries("/p", "q")).toBe("")

    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
    searchByEmbeddingMock.mockResolvedValue([{ id: "page:1", matchedChunks: [{ text: "x" }] }])
    expect(await searchCommunitySummaries("/p", "q")).toBe("")
  })

  it("searchCommunitySummaries: formats community hits and tolerates errors", async () => {
    const { searchCommunitySummaries } = await import("./community-summary")
    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
    searchByEmbeddingMock.mockResolvedValue([
      { id: "community:3", matchedChunks: [{ text: "密室线索" }] },
      { id: "community:1", matchedChunks: [{ text: "阵营甲" }] },
      { id: "page:9", matchedChunks: [{ text: "ignore" }] },
    ])
    const text = await searchCommunitySummaries("/p", "q", 2)
    expect(text).toContain("社区摘要·社区3")
    expect(text).toContain("密室线索")
    expect(text).not.toContain("page:9")
    // 无 matchedChunks 时 snippet 为空串
    searchByEmbeddingMock.mockResolvedValue([{ id: "community:7", matchedChunks: [] }])
    const text2 = await searchCommunitySummaries("/p", "q")
    expect(text2).toContain("社区摘要·社区7")
    // embedding 抛错 → 空串
    searchByEmbeddingMock.mockRejectedValue(new Error("vec down"))
    expect(await searchCommunitySummaries("/p", "q")).toBe("")
  })

  it("resolves the active set after vector search and requires exact published text for that community", async () => {
    const { searchCommunitySummaries } = await import("./community-summary")
    const published = publishedRecord({ communityId: 0, summary: "已发布".repeat(200) })
    let current = setRaw(0, [publishedRecord()])
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockImplementation(async () => current)
    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
    searchByEmbeddingMock.mockImplementation(async () => {
      current = setRaw(1, [published, publishedRecord()])
      return [
        { id: "community-summary-0.1", matchedChunks: [{ text: "已发布摘要" }] },
        { id: "community-summary-1.1", matchedChunks: [{ text: "同槽残留旧字节" }] },
        { id: "community-summary-1.2", matchedChunks: [{ text: published.summary }] },
        { id: "community-summary-1.0", matchedChunks: [{ text: "不使用首个 chunk" }, { text: published.summary }] },
      ]
    })
    expect(await searchCommunitySummaries("/p", "q", 1)).toBe(`- 【社区摘要·社区0】: ${published.summary.slice(0, 400)}`)
  })
})

describe("generateCommunitySummariesForChapter", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockResolvedValue("成员正文内容")
    streamChatMock.mockReset()
    searchByEmbeddingMock.mockReset()
    buildWikiGraphMock.mockReset()
  })

  it("returns empty when disabled, no communities, or empty tokens", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    const disabledCfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: false }
    expect(await generateCommunitySummariesForChapter("/p-fc", "任务", 3, llmConfig, 3, disabledCfg)).toBe("")

    buildWikiGraphMock.mockResolvedValue({ nodes: [], communities: [] })
    expect(await generateCommunitySummariesForChapter("/p-fc", "任务", 3, llmConfig, 3, wikiStoreState.novelConfig)).toBe("")

    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    expect(await generateCommunitySummariesForChapter("/p-fc", "   ", 3, llmConfig, 3, wikiStoreState.novelConfig)).toBe("")
  })

  it("generates and caches summaries for relevant communities, reusing cache within a bucket", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    // 任务 token 命中 topNodes 标签「成员1」
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("缓存化社区摘要")
      callbacks.onDone?.()
    })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    const first = await generateCommunitySummariesForChapter("/p-fc", "任务 成员1 相关", 3, llmConfig, 3, cfg)
    expect(first).toContain("社区摘要·社区1")
    expect(first).toContain("缓存化社区摘要")
    // 第二次调用（同 bucket）应命中缓存：不再调用 LLM
    streamChatMock.mockClear()
    const second = await generateCommunitySummariesForChapter("/p-fc", "任务 成员1 相关", 3, llmConfig, 3, cfg)
    expect(second).toContain("社区摘要·社区1")
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("crosses the bucket boundary and clears this project's cache only", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("新摘要")
      callbacks.onDone?.()
    })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    // bucket 0 (chapter 3) → bucket 1 (chapter 6)：缓存被清 → 重新调用 LLM
    await generateCommunitySummariesForChapter("/p-bucket", "任务 成员1 相关", 3, llmConfig, 3, cfg)
    streamChatMock.mockClear()
    const second = await generateCommunitySummariesForChapter("/p-bucket", "任务 成员1 相关", 6, llmConfig, 3, cfg)
    expect(second).toContain("社区摘要·社区1")
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("skips relevant communities without member nodes or with LLM failure", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    // 社区 1 无成员节点、社区 2 有成员且 LLM 成功、社区 3 LLM 抛错
    const communities = [makeCommunity(1), makeCommunity(2), makeCommunity(3)]
    const nodes = [
      { id: "n2-a", label: "成员2", type: "character", path: "/p/wiki/2-a.md", linkCount: 3, community: 2 },
      { id: "n3-a", label: "成员3", type: "character", path: "/p/wiki/3-a.md", linkCount: 3, community: 3 },
    ]
    buildWikiGraphMock.mockResolvedValue({ nodes, communities })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      const id = communityIdFromMessages(messages)
      if (id === 3) throw new Error("llm down")
      callbacks.onToken?.(`摘要${id}`)
      callbacks.onDone?.()
    })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    const text = await generateCommunitySummariesForChapter("/p-multi", "任务 成员2 成员3", 3, llmConfig, 5, cfg)
    expect(text).toContain("社区摘要·社区2")
    expect(text).not.toContain("社区摘要·社区3")
    expect(text).not.toContain("社区摘要·社区1")
  })

  it("returns empty when no community matches the task tokens or the graph build fails", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    // 任务不命中任何 topNodes 标签
    expect(await generateCommunitySummariesForChapter("/p-none", "无关任务", 3, llmConfig, 3, cfg)).toBe("")
    // graph 构建抛错 → 空串
    buildWikiGraphMock.mockRejectedValue(new Error("graph down"))
    expect(await generateCommunitySummariesForChapter("/p-none", "任务 成员1 相关", 3, llmConfig, 3, cfg)).toBe("")
    // 任务不含任何可识别 token（单个字符）→ 空串
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    expect(await generateCommunitySummariesForChapter("/p-none", "a b", 3, llmConfig, 3, cfg)).toBe("")
  })

  it("interval 0 falls back to 5 and non-Error LLM throws are skipped", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1, 2]), communities: [makeCommunity(1), makeCommunity(2)] })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      if (communityIdFromMessages(messages) === 1) throw "boom-value"
      callbacks.onToken?.("存活摘要")
      callbacks.onDone?.()
    })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 0 }
    const text = await generateCommunitySummariesForChapter("/p-zero", "任务 成员2", 1, llmConfig, 5, cfg)
    expect(text).toContain("社区摘要·社区2")
    expect(text).not.toContain("社区摘要·社区1")
  })

  it("falls back to store novelConfig and bucket 0 for undefined chapter", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("store默认摘要")
      callbacks.onDone?.()
    })
    // 不传 novelConfig / chapterNumber → 使用 store 状态 + bucket 0
    const text = await generateCommunitySummariesForChapter("/p-store", "任务 成员1 相关", undefined, llmConfig, 3)
    expect(text).toContain("store默认摘要")
  })

  it("tokenizes latin words and dedups repeated tokens", async () => {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes([1]), communities: [makeCommunity(1)] })
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("latin命中")
      callbacks.onDone?.()
    })
    const cfg = { ...DEFAULT_NOVEL_CONFIG, communitySummaryEnabled: true, communitySummaryInterval: 5 }
    // 重复 token 去重 + latin 单词参与匹配
    const text = await generateCommunitySummariesForChapter("/p-latin", "alpha alpha 成员1", 1, llmConfig, 3, cfg)
    expect(text).toContain("latin命中")
  })
})

describe("loadPersistedCommunitySummaries (Wave B 读取 + 裁剪)", () => {
  function entry(name: string, isDir = false): { name: string; path: string; is_dir: boolean } {
    return { name, path: `/p/.novel/community-summaries/${name}`, is_dir: isDir }
  }

  function record(overrides: Partial<CommunitySummaryRecord> = {}): CommunitySummaryRecord {
    return {
      communityId: 1,
      summary: "摘要内容",
      nodeCount: 3,
      topNodes: ["成员A", "成员B", "成员C", "成员D"],
      generatedAt: "t",
      ...overrides,
    }
  }

  beforeEach(() => {
    fsMocks.listDirectory.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.fileExists.mockReset().mockResolvedValue(false)
  })

  it("uses only the published set and applies record ordering and context caps", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const small = publishedRecord()
    const largest = publishedRecord({ communityId: 2, nodeCount: 12, summary: "发布内容".repeat(200) })
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(setRaw(null, [small, largest]))
    fsMocks.listDirectory.mockResolvedValue([entry("9.json")])

    const { records, text } = await loadPersistedCommunitySummaries("/p", { maxRecords: 1, maxChars: 200 })
    expect(records).toEqual([largest])
    expect(text).toMatch(/^【社区2·12节点·成员1】.+…$/)
    expect(text.length).toBeLessThan(200)
    expect(fsMocks.listDirectory).not.toHaveBeenCalled()
  })

  it("filters json files, sorts by name, and caps by maxRecords", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([
      entry("b.json"),
      entry("notes.txt"),
      entry("a.json"),
      entry("sub.json", true), // is_dir → 过滤
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const name = String(path).split("/").pop() ?? ""
      return JSON.stringify(record({ communityId: name === "a.json" ? 1 : 2, summary: `摘要${name}` }))
    })
    const { text, records } = await loadPersistedCommunitySummaries("/p")
    // 按文件名排序 a.json → b.json
    expect(records.map((r) => r.communityId)).toEqual([1, 2])
    expect(text).toContain("【社区1·3节点·成员A、成员B、成员C】")
  })

  it("honors explicit maxRecords / maxChars options (?? 左分支)", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json"), entry("b.json"), entry("c.json")])
    fsMocks.readFile.mockResolvedValue(JSON.stringify(record({ summary: "短摘要" })))
    const { records } = await loadPersistedCommunitySummaries("/p", { maxRecords: 2, maxChars: 200 })
    expect(records.length).toBe(2)
  })

  it("breaks when records already reach maxRecords (L269 then)", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json"), entry("b.json"), entry("c.json"), entry("d.json")])
    fsMocks.readFile.mockResolvedValue(JSON.stringify(record({ summary: "x" })))
    const { records } = await loadPersistedCommunitySummaries("/p", { maxRecords: 2 })
    expect(records.length).toBe(2)
  })

  it("skips records with falsy parsed, non-string summary, or whitespace-only summary", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json"), entry("b.json"), entry("c.json"), entry("d.json")])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const name = String(path).split("/").pop()
      if (name === "a.json") return "null" // parsed 为 null
      if (name === "b.json") return JSON.stringify({ summary: 42 }) // summary 非 string
      if (name === "c.json") return JSON.stringify(record({ summary: "   " })) // 纯空白
      return JSON.stringify(record({ summary: "有效摘要" }))
    })
    const { records } = await loadPersistedCommunitySummaries("/p")
    expect(records.map((r) => r.communityId)).toEqual([1])
  })

  it("handles missing nodeCount / topNodes with nullish fallbacks", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json"), entry("b.json"), entry("c.json")])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const name = String(path).split("/").pop()
      if (name === "a.json") {
        return JSON.stringify({ communityId: 1, summary: "无topNodes摘要", generatedAt: "t" }) // nodeCount/topNodes 缺失
      }
      if (name === "b.json") {
        return JSON.stringify({ communityId: 2, summary: "也无topNodes", generatedAt: "t" }) // 第二个缺失记录 → 比较器两侧都命中 ?? 0
      }
      return JSON.stringify(record({ communityId: 3, nodeCount: 9, summary: "有topNodes摘要" }))
    })
    const { text, records } = await loadPersistedCommunitySummaries("/p")
    // sort 两侧都命中 ?? 0：社区3(9) 排最前，其余保持稳定序
    expect(records.map((r) => r.communityId)).toEqual([3, 1, 2])
    expect(text).toContain("【社区1·undefined节点·】")
  })

  it("truncates an over-long line with an ellipsis when room is large", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json")])
    const long = "长摘要".repeat(200) // 600 字符
    fsMocks.readFile.mockResolvedValue(JSON.stringify(record({ summary: long })))
    const { text } = await loadPersistedCommunitySummaries("/p", { maxChars: 300 })
    expect(text.endsWith("…")).toBe(true)
    expect(text.length).toBeLessThan(300)
  })

  it("breaks without pushing when the remaining room is small (room <= 80)", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockResolvedValue([entry("a.json"), entry("b.json"), entry("c.json")])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const name = String(path).split("/").pop()
      if (name === "a.json") return JSON.stringify(record({ communityId: 1, nodeCount: 1, summary: "又一条长摘要" }))
      if (name === "b.json") return JSON.stringify(record({ communityId: 2, nodeCount: 2, summary: "短" }))
      return JSON.stringify(record({ communityId: 3, nodeCount: 3, summary: "长".repeat(250) }))
    })
    const { text, records } = await loadPersistedCommunitySummaries("/p", { maxChars: 300 })
    // 排序后：社区3(3节点) → 社区2(2节点) → 社区1(1节点)
    // 社区3 长行(≈268) + 社区2 短行(≈19) → used≈289；第三条 room=300-289-20=-9 ≤ 80 → 不追加并 break
    expect(records.length).toBe(3)
    expect(text).toContain("短")
    expect(text).not.toContain("又一条长摘要")
  })

  it("returns empty text/records when listing fails", async () => {
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    fsMocks.listDirectory.mockRejectedValue(new Error("enoent"))
    const { text, records } = await loadPersistedCommunitySummaries("/p")
    expect(text).toBe("")
    expect(records).toEqual([])
  })
})
