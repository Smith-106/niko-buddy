import { describe, expect, it, vi, beforeEach } from "vitest"
import type { CommunityInfo, GraphNode } from "@/lib/wiki-graph"
import type { CommunitySummaryRecord } from "./community-summary"
import { DEFAULT_NOVEL_CONFIG, type LlmConfig } from "@/stores/wiki-store"

const fsMocks = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFile: (...args: unknown[]) => fsMocks.writeFile(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
}))

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
vi.mock("@/lib/llm-client", () => ({
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
}))

const buildWikiGraphMock = vi.fn()
vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: (...args: unknown[]) => buildWikiGraphMock(...args),
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveNovelModel: (cfg: unknown) => cfg,
}))

const embedPageMock = vi.fn()
const searchByEmbeddingMock = vi.fn()
vi.mock("@/lib/embedding", () => ({
  embedPage: (...args: unknown[]) => embedPageMock(...args),
  // community-summary.ts 也 import 了 searchByEmbedding —— mock 必须镜像该导出
  searchByEmbedding: (...args: unknown[]) => searchByEmbeddingMock(...args),
}))

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

describe("generateCommunitySummaries (TASK-402 并行 + 信号量限流)", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset()
    fsMocks.createDirectory.mockReset()
    streamChatMock.mockReset()
    buildWikiGraphMock.mockReset()
    embedPageMock.mockReset()

    fsMocks.readFile.mockResolvedValue("成员正文内容")
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    embedPageMock.mockResolvedValue(undefined)
    wikiStoreState.embeddingConfig = { enabled: true, model: "test-model" }
    buildWikiGraphMock.mockResolvedValue({ nodes: [], communities: [] })
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
    // 每个社区都落盘
    expect(fsMocks.writeFile.mock.calls).toHaveLength(6)
  })

  it("persists summaries in input community order regardless of LLM completion order", async () => {
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

    // 写 JSON 顺序 = communities 输入序（确定性收敛）
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual(ids)

    // 向量化顺序同样 = 输入序
    const embeddedIds = embedPageMock.mock.calls.map(([, pageId]) => Number(String(pageId).replace("community:", "")))
    expect(embeddedIds).toEqual(ids)

    // 每个文件内容与对应社区匹配
    const firstRecord = JSON.parse(String(fsMocks.writeFile.mock.calls[0][1]))
    expect(firstRecord.communityId).toBe(2)
    expect(firstRecord.summary).toContain("摘要-社区2")
  })

  it("keeps per-community failure non-blocking: surviving communities still persist", async () => {
    const ids = [1, 2, 3]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })

    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      const id = communityIdFromMessages(messages)
      if (id === 2) throw new Error("LLM quota exceeded")
      callbacks.onToken?.(`摘要-社区${id}`)
      callbacks.onDone?.()
    })

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)

    // 社区 2 失败被吞掉，1/3 仍按输入序落盘
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual([1, 3])
  })

  it("returns early when the graph has no communities", async () => {
    buildWikiGraphMock.mockResolvedValue({ nodes: [], communities: [] })
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("skips communities that have no member nodes", async () => {
    const ids = [1, 2]
    // 社区 1 无成员节点（nodes 里没有任何 community:1 的节点），社区 2 有
    buildWikiGraphMock.mockResolvedValue({
      nodes: [{ id: "n2-a", label: "成员2", type: "character", path: "/p/wiki/2-a.md", linkCount: 3, community: 2 }],
      communities: ids.map(makeCommunity),
    })

    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone?.()
    })

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    // 只有社区 2 落盘
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual([2])
  })

  it("persist failure is non-blocking for later communities", async () => {
    const ids = [1, 2]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone?.()
    })
    // 社区 1 写盘失败，社区 2 正常；失败不阻断后续落盘
    fsMocks.writeFile.mockRejectedValueOnce(new Error("disk full"))

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    // 两次写盘均被尝试（社区 2 未被阻断）
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual([1, 2])
  })

  it("embed failure is non-blocking and summary still persists", async () => {
    const ids = [1]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone?.()
    })
    embedPageMock.mockRejectedValue(new Error("lance error"))

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    // 写入仍发生（embed 失败不阻断）
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  it("does not embed when embedding is disabled", async () => {
    const ids = [1]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone?.()
    })
    wikiStoreState.embeddingConfig = { enabled: false, model: "" }

    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(embedPageMock).not.toHaveBeenCalled()
  })

  it("tolerates non-Error throws from LLM / write / embed", async () => {
    const ids = [1, 2]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    // 社区 1：LLM 抛非 Error 值；社区 2：正常
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      if (communityIdFromMessages(messages) === 1) throw "string-error"
      callbacks.onToken?.("摘要")
      callbacks.onDone?.()
    })
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    // 社区 1 被跳过，社区 2 正常落盘
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual([2])
  })

  it("tolerates non-Error throws from write and embed", async () => {
    const ids = [1, 2]
    buildWikiGraphMock.mockResolvedValue({ nodes: makeNodes(ids), communities: ids.map(makeCommunity) })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.(`摘要-社区${communityIdFromMessages(messages)}`)
      callbacks.onDone?.()
    })
    // 社区 1 写盘抛非 Error；社区 2 embed 抛非 Error
    fsMocks.writeFile.mockImplementation(async (path: string) => {
      if (String(path).includes("1.json")) throw { code: "EIO" }
    })
    embedPageMock.mockRejectedValue({ code: "LANCE" })
    const { generateCommunitySummaries } = await import("./community-summary")
    await generateCommunitySummaries("/p", llmConfig, wikiStoreState.novelConfig)
    // 两条路径均被尝试且不抛出
    const writtenIds = fsMocks.writeFile.mock.calls.map(([path]) => Number(String(path).match(/(\d+)\.json$/)?.[1]))
    expect(writtenIds).toEqual([1, 2])
    expect(embedPageMock).toHaveBeenCalledTimes(1)
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
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    // 标题回退为空串（topNodes[0] ?? ""）
    expect(embedPageMock).toHaveBeenCalledTimes(1)
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
