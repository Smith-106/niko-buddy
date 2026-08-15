import { describe, expect, it, vi, beforeEach } from "vitest"
import type { CommunityInfo, GraphNode } from "@/lib/wiki-graph"
import type { LlmConfig } from "@/stores/wiki-store"

const fsMocks = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFile: (...args: unknown[]) => fsMocks.writeFile(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
}))

// 可变的 store state：测试内可切换 embedding 开关
const wikiStoreState = {
  embeddingConfig: { enabled: true, model: "test-model" },
  novelConfig: { communitySummaryEnabled: true, communitySummaryInterval: 5 },
}

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => wikiStoreState },
}))

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
vi.mock("@/lib/embedding", () => ({
  embedPage: (...args: unknown[]) => embedPageMock(...args),
  // community-summary.ts 也 import 了 searchByEmbedding —— mock 必须镜像该导出
  searchByEmbedding: vi.fn(),
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
})
