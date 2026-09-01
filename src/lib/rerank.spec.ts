import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  getState: vi.fn(),
  resolveDefaultModel: vi.fn(),
  isDirectRerankEndpoint: vi.fn(),
  requestDirectRerank: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.getState },
}))

vi.mock("@/lib/rerank-api", () => ({
  isDirectRerankEndpoint: mocks.isDirectRerankEndpoint,
  requestDirectRerank: mocks.requestDirectRerank,
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: mocks.resolveDefaultModel,
}))

import { isRerankEnabled, rerankCandidates, invalidateRerankCache } from "./rerank"
import type { RerankCandidate } from "./rerank"
import type { LlmConfig, RerankConfig } from "@/stores/wiki-store"

const baseConfig: LlmConfig = {
  provider: "openai",
  apiKey: "k",
  model: "gpt-x",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 65536,
}

const rerankConfig: RerankConfig = {
  enabled: true,
  useMainLlm: false,
  provider: "openai",
  apiKey: "rk",
  model: "rerank-1",
  ollamaUrl: "http://127.0.0.1:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxCandidates: 12,
}

function candidate(id: string): RerankCandidate {
  return { id, title: `T-${id}`, snippet: `S-${id}` }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getState.mockReturnValue({ llmConfig: baseConfig, rerankConfig, dataVersion: 0 })
  mocks.resolveDefaultModel.mockImplementation((c: LlmConfig) => c)
  mocks.isDirectRerankEndpoint.mockReturnValue(false)
  // G8 (39 号修复): 模块级 rerank 缓存跨测试隔离
  invalidateRerankCache()
})

describe("isRerankEnabled", () => {
  it("reflects the enabled flag", () => {
    expect(isRerankEnabled({ ...rerankConfig, enabled: true })).toBe(true)
    expect(isRerankEnabled({ ...rerankConfig, enabled: false })).toBe(false)
  })
})

describe("rerankCandidates — early exit and config resolution", () => {
  it("returns the candidates unchanged when there is at most one", async () => {
    const one = [candidate("a")]
    await expect(rerankCandidates("q", one, { topK: 3 })).resolves.toEqual(one)
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("returns empty slice when no candidates", async () => {
    await expect(rerankCandidates("q", [])).resolves.toEqual([])
  })

  it("returns original order when rerank is disabled", async () => {
    mocks.getState.mockReturnValue({
      llmConfig: baseConfig,
      dataVersion: 0,
      rerankConfig: { ...rerankConfig, enabled: false },
    })
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list, { topK: 1 })).resolves.toEqual([candidate("a")])
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("returns original order when the configured model is blank", async () => {
    mocks.getState.mockReturnValue({
      llmConfig: baseConfig,
      dataVersion: 0,
      rerankConfig: { ...rerankConfig, model: "  " },
    })
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
  })

  it("uses the main LLM config with reasoning disabled when useMainLlm is set", async () => {
    mocks.getState.mockReturnValue({
      llmConfig: baseConfig,
      dataVersion: 0,
      rerankConfig: { ...rerankConfig, useMainLlm: true },
    })
    const list = [candidate("a"), candidate("b")]
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"b","score":1},{"id":"a","score":0.5}]}')
      callbacks.onDone()
    })
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["b", "a"])
    const usedConfig = mocks.streamChat.mock.calls[0][0] as LlmConfig
    expect(usedConfig.model).toBe("gpt-x")
    expect(usedConfig.reasoning).toEqual({ mode: "off" })
  })

  it("resolves custom provider apiMode and caps maxContextSize", async () => {
    mocks.getState.mockReturnValue({
      llmConfig: { ...baseConfig, maxContextSize: 200_000 },
      dataVersion: 0,
      rerankConfig: {
        ...rerankConfig,
        provider: "custom",
        apiMode: "responses",
        customEndpoint: "http://x/v1",
      },
    })
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[]}')
      callbacks.onDone()
    })
    const out = await rerankCandidates("q", [candidate("a"), candidate("b")])
    expect(out.length).toBe(2)
    const usedConfig = mocks.streamChat.mock.calls[0][0] as LlmConfig
    expect(usedConfig.provider).toBe("custom")
    expect(usedConfig.apiMode).toBe("responses")
    expect(usedConfig.maxContextSize).toBe(65536)
  })

  it("defaults maxContextSize to 65536 when the base config omits it", async () => {
    const { maxContextSize: _drop, ...withoutSize } = baseConfig
    mocks.getState.mockReturnValue({ llmConfig: withoutSize, rerankConfig, dataVersion: 0 })
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[]}')
      callbacks.onDone()
    })
    await rerankCandidates("q", [candidate("a"), candidate("b")])
    expect((mocks.streamChat.mock.calls[0][0] as LlmConfig).maxContextSize).toBe(65536)
  })
})

describe("rerankCandidates — direct rerank endpoint", () => {
  beforeEach(() => {
    mocks.isDirectRerankEndpoint.mockReturnValue(true)
  })

  it("reorders by direct results, appends leftovers, and applies topK", async () => {
    mocks.requestDirectRerank.mockResolvedValue([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.8 },
    ])
    const list = [candidate("a"), candidate("b"), candidate("c")]
    const out = await rerankCandidates("q", list, { topK: 2 })
    expect(out.map((c) => c.id)).toEqual(["b", "a"])
    expect(mocks.requestDirectRerank).toHaveBeenCalledWith(
      expect.anything(),
      "q",
      expect.any(Array),
      expect.any(AbortSignal),
    )
  })

  it("skips invalid and duplicate indexes then fills remaining slots in order", async () => {
    mocks.requestDirectRerank.mockResolvedValue([
      { index: -1, relevanceScore: 1 },
      { index: 99, relevanceScore: 1 },
      { index: 0, relevanceScore: 1 },
      { index: 0, relevanceScore: 1 },
      { index: 1, relevanceScore: 0.5 },
    ])
    const list = [candidate("a"), candidate("b"), candidate("c")]
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("falls back to original order when the direct request fails with an Error", async () => {
    mocks.requestDirectRerank.mockRejectedValue(new Error("endpoint down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    expect(warn.mock.calls[0]?.[1]).toBe("endpoint down")
    warn.mockRestore()
  })

  it("falls back to original order when the direct request fails", async () => {
    mocks.requestDirectRerank.mockRejectedValue("plain string error")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    expect(warn.mock.calls[0]?.[0]).toContain("direct rerank endpoint failed")
    expect(warn.mock.calls[0]?.[1]).toBe("plain string error")
    warn.mockRestore()
  })
})

describe("rerankCandidates — streamed chat path", () => {
  it("reorders candidates by returned order and appends unlisted ones", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"c","score":1},{"id":"a","score":0.5}]}')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b"), candidate("c")]
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["c", "a", "b"])
    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.anything(),
      [{ role: "user", content: expect.stringContaining("查询：q") }],
      expect.any(Object),
      expect.any(AbortSignal),
      { temperature: 0, max_tokens: 1200 },
    )
  })

  it("skips unknown and duplicate ids, appending leftovers", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"missing"},{"id":"a"},{"id":"a"}]}')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b")]
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("handles fenced JSON responses", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('```json\n{"order":[{"id":"b","score":0.9}]}\n```')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b")]
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["b", "a"])
  })

  it("falls back to original order when the stream reports an Error instance", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("stream error"))
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    expect(warn.mock.calls[0]?.[1]).toBe("stream error")
    warn.mockRestore()
  })

  it("falls back to original order when the stream reports an error", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError("non-error message")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    expect(warn.mock.calls[0]?.[0]).toContain("falling back to original order")
    expect(warn.mock.calls[0]?.[1]).toBe("non-error message")
    warn.mockRestore()
  })

  it("keeps original order when the response omits the order array", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"unexpected":true}')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b")]
    const out = await rerankCandidates("q", list)
    expect(out.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("falls back to original order when the response contains no JSON", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("sorry, no json")
      callbacks.onDone()
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    expect(warn.mock.calls[0]?.[0]).toContain("could not parse response")
    warn.mockRestore()
  })

  it("falls back to original order when JSON parsing throws", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order": [broken}')
      callbacks.onDone()
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const list = [candidate("a"), candidate("b")]
    await expect(rerankCandidates("q", list)).resolves.toEqual(list)
    warn.mockRestore()
  })

  it("applies topK after reordering and truncates the tail", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"b","score":1},{"id":"a","score":0.5},{"id":"c","score":0.1}]}')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b"), candidate("c")]
    const out = await rerankCandidates("q", list, { topK: 2 })
    expect(out.map((c) => c.id)).toEqual(["b", "a"])
  })

  it("passes purpose into the prompt and slices candidates to maxCandidates", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[]}')
      callbacks.onDone()
    })
    mocks.getState.mockReturnValue({
      llmConfig: baseConfig,
      dataVersion: 0,
      rerankConfig: { ...rerankConfig, maxCandidates: 2 },
    })
    const list = [candidate("a"), candidate("b"), candidate("c")]
    const out = await rerankCandidates("q", list, { purpose: "章节连贯" })
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"])
    const prompt = String(mocks.streamChat.mock.calls[0][1][0].content)
    expect(prompt).toContain("当前用途：章节连贯")
    expect(prompt).toContain('"id": "a"')
    expect(prompt).not.toContain('"id": "c"')
  })

  it("G8 修复: dataVersion bump 后同 query 同候选集重新 rerank (缓存联动失效)", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"c"},{"id":"a"}]}')
      callbacks.onDone()
    })
    const list = [candidate("a"), candidate("b"), candidate("c")]
    // 第一次: 写缓存
    const out1 = await rerankCandidates("q", list)
    expect(out1.map((c) => c.id)).toEqual(["c", "a", "b"])
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    // 同 query 同候选: 缓存命中, 不再调 LLM
    const out2 = await rerankCandidates("q", list)
    expect(out2.map((c) => c.id)).toEqual(["c", "a", "b"])
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    // dataVersion bump (应用内编辑) → 缓存失效, 重新调 LLM
    mocks.getState.mockReturnValue({ llmConfig: baseConfig, rerankConfig, dataVersion: 1 })
    const out3 = await rerankCandidates("q", list)
    expect(out3.map((c) => c.id)).toEqual(["c", "a", "b"])
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
  })
})
