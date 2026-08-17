import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig, RerankConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  fetchEmbedding: vi.fn(),
  streamChat: vi.fn(),
  isDirectRerankEndpoint: vi.fn(),
  requestDirectRerank: vi.fn(),
  fetchLlmModelList: vi.fn(),
}))

vi.mock("@/lib/embedding", () => ({
  fetchEmbedding: mocks.fetchEmbedding,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/lib/rerank-api", () => ({
  isDirectRerankEndpoint: mocks.isDirectRerankEndpoint,
  requestDirectRerank: mocks.requestDirectRerank,
}))

vi.mock("@/lib/settings-model-list", () => ({
  fetchLlmModelList: mocks.fetchLlmModelList,
}))

import {
  normalizeModelTestError,
  testSettingsEmbeddingModel,
  testSettingsLlmModel,
  testSettingsRerankModel,
} from "./settings-model-test"

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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDirectRerankEndpoint.mockReturnValue(false)
})

describe("normalizeModelTestError", () => {
  it("maps insufficient balance messages", () => {
    const err = normalizeModelTestError(new Error("insufficient account balance on relay"))
    expect(err.message).toContain("账户余额不足")
  })

  it("maps client-not-allowed messages", () => {
    const err = normalizeModelTestError(new Error("client not allowed, please contact admin"))
    expect(err.message).toContain("客户端来源")
  })

  it("maps unsupported-model messages and extracts the model name", () => {
    const err = normalizeModelTestError(new Error("不支持所选模型 gpt-4o-fake"))
    expect(err.message).toContain("gpt-4o-fake")
    expect(err.message).toContain("不支持所选模型")
  })

  it("maps HTTP 404 errors mentioning a model", () => {
    const err = normalizeModelTestError(new Error("HTTP 404 model not found"))
    expect(err.message).toContain("不支持所选模型")
  })

  it("passes unrelated errors through unchanged", () => {
    const original = new Error("some other failure")
    expect(normalizeModelTestError(original)).toBe(original)
  })

  it("recognizes english-style unsupported model patterns", () => {
    expect(normalizeModelTestError(new Error('unsupported selected model "foo"')).message).toContain("foo")
    expect(normalizeModelTestError(new Error("model 'bar' not found")).message).toContain("bar")
  })
})

describe("testSettingsLlmModel", () => {
  it("returns model and trimmed content on success", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(" 模型测试成功 ")
      callbacks.onDone()
    })
    const result = await testSettingsLlmModel(baseConfig)
    expect(result).toEqual({ model: "gpt-x", content: "模型测试成功" })
  })

  it("uses the first CLI-listed model when no explicit model is set", async () => {
    mocks.fetchLlmModelList.mockResolvedValue({ models: ["cli-model-1", "cli-model-2"], error: null })
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("ok")
      callbacks.onDone()
    })
    const result = await testSettingsLlmModel({ ...baseConfig, provider: "claude-code", model: "  " })
    expect(result.model).toBe("cli-model-1")
  })

  it("throws when the CLI model list is empty", async () => {
    mocks.fetchLlmModelList.mockResolvedValue({ models: [], error: null })
    await expect(testSettingsLlmModel({ ...baseConfig, provider: "codex-cli", model: "  " })).rejects.toThrow(
      "请先在本地 CLI 中设置默认模型",
    )
  })

  it("throws when no model name is configured for regular providers", async () => {
    await expect(testSettingsLlmModel({ ...baseConfig, model: " " })).rejects.toThrow("请先填写模型名称后再测试")
  })

  it("normalizes stream errors", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("insufficient account balance"))
    })
    await expect(testSettingsLlmModel(baseConfig)).rejects.toThrow("账户余额不足")
  })

  it("throws when the model returns empty content", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onDone()
    })
    await expect(testSettingsLlmModel(baseConfig)).rejects.toThrow("模型已连接，但没有返回可用内容")
  })
})

describe("testSettingsEmbeddingModel", () => {
  it("returns dimensions on success", async () => {
    mocks.fetchEmbedding.mockResolvedValue([0.1, 0.2, 0.3])
    const config: EmbeddingConfig = { enabled: true, endpoint: "http://x/v1/embeddings", apiKey: "", model: "emb-1" }
    await expect(testSettingsEmbeddingModel(config)).resolves.toEqual({ model: "emb-1", dimensions: 3 })
  })

  it("throws when the model name is blank", async () => {
    const config: EmbeddingConfig = { enabled: true, endpoint: "http://x", apiKey: "", model: " " }
    await expect(testSettingsEmbeddingModel(config)).rejects.toThrow("请先填写嵌入模型名称")
  })

  it("throws when the endpoint is blank", async () => {
    const config: EmbeddingConfig = { enabled: true, endpoint: "  ", apiKey: "", model: "emb-1" }
    await expect(testSettingsEmbeddingModel(config)).rejects.toThrow("请先填写嵌入接口地址")
  })

  it("throws when the embedding returns an empty vector", async () => {
    mocks.fetchEmbedding.mockResolvedValue([])
    const config: EmbeddingConfig = { enabled: true, endpoint: "http://x", apiKey: "", model: "emb-1" }
    await expect(testSettingsEmbeddingModel(config)).rejects.toThrow("嵌入模型没有返回有效向量")
  })
})

describe("testSettingsRerankModel", () => {
  it("uses the main LLM when configured, with reasoning off", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"a","score":1}]}')
      callbacks.onDone()
    })
    const result = await testSettingsRerankModel(baseConfig, { ...rerankConfig, useMainLlm: true })
    expect(result).toEqual({ model: "gpt-x", content: '{"order":[{"id":"a","score":1}]}', usedMainLlm: true })
    const usedConfig = mocks.streamChat.mock.calls[0][0] as LlmConfig
    expect(usedConfig.reasoning).toEqual({ mode: "off" })
  })

  it("throws when useMainLlm is set but the main model is blank", async () => {
    await expect(
      testSettingsRerankModel({ ...baseConfig, model: " " }, { ...rerankConfig, useMainLlm: true }),
    ).rejects.toThrow("请先配置主模型")
  })

  it("throws when the rerank model name is blank", async () => {
    await expect(testSettingsRerankModel(baseConfig, { ...rerankConfig, model: " " })).rejects.toThrow(
      "请先填写重排模型名称",
    )
  })

  it("rejects embedding-looking model names", async () => {
    await expect(
      testSettingsRerankModel(baseConfig, { ...rerankConfig, model: "bge-embedding" }),
    ).rejects.toThrow("更像是嵌入模型")
  })

  it("returns direct rerank results when the endpoint is a direct rerank API", async () => {
    mocks.isDirectRerankEndpoint.mockReturnValue(true)
    mocks.requestDirectRerank.mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.1 },
    ])
    const result = await testSettingsRerankModel(baseConfig, {
      ...rerankConfig,
      provider: "custom",
      apiMode: "responses",
    })
    expect(result.content).toBe(JSON.stringify([{ index: 0, relevanceScore: 0.9 }, { index: 1, relevanceScore: 0.1 }]))
    expect(result.usedMainLlm).toBe(false)
  })

  it("defaults maxContextSize to 65536 when the main config omits it", async () => {
    const { maxContextSize: _drop, ...withoutSize } = baseConfig
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"order":[{"id":"a","score":1}]}')
      callbacks.onDone()
    })
    const result = await testSettingsRerankModel(withoutSize as LlmConfig, {
      ...rerankConfig,
      provider: "custom",
      apiMode: "responses",
    })
    expect(result.usedMainLlm).toBe(false)
    const usedConfig = mocks.streamChat.mock.calls[0][0] as LlmConfig
    expect(usedConfig.provider).toBe("custom")
    expect(usedConfig.apiMode).toBe("responses")
    expect(usedConfig.maxContextSize).toBe(65536)
  })

  it("throws when direct rerank results are malformed", async () => {
    mocks.isDirectRerankEndpoint.mockReturnValue(true)
    mocks.requestDirectRerank.mockResolvedValue([])
    await expect(testSettingsRerankModel(baseConfig, rerankConfig)).rejects.toThrow("结果格式不正确")
  })

  it("throws when the rerank chat response lacks a valid order", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken('{"unexpected":true}')
      callbacks.onDone()
    })
    await expect(testSettingsRerankModel(baseConfig, rerankConfig)).rejects.toThrow("结果格式不正确")
  })

  it("throws when the rerank chat response is not JSON", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("plain prose")
      callbacks.onDone()
    })
    await expect(testSettingsRerankModel(baseConfig, rerankConfig)).rejects.toThrow("不是可用的 JSON 结果")
  })
})
