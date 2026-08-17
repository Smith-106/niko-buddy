import { afterEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"
import {
  LLM_PROVIDER_TEST_MAX_TOKENS,
  testEmbeddingConnection,
  testEmbeddingFunction,
  testLlmConnection,
  testLlmFunction,
} from "./connection-tests"

const mocks = vi.hoisted(() => ({
  fetchEmbedding: vi.fn(),
  getLastEmbeddingError: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock("@/lib/embedding", () => ({
  fetchEmbedding: mocks.fetchEmbedding,
  getLastEmbeddingError: mocks.getLastEmbeddingError,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

function embeddingConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:11434/v1/embeddings",
    apiKey: "",
    model: "text-embedding-model",
    ...overrides,
  }
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "ollama",
    apiKey: "",
    model: "qwen3",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("testEmbeddingConnection", () => {
  it("rejects an empty endpoint", async () => {
    const res = await testEmbeddingConnection(embeddingConfig({ endpoint: "  " }))
    expect(res).toEqual({ ok: false, message: "Embedding endpoint is empty." })
    expect(mocks.fetchEmbedding).not.toHaveBeenCalled()
  })

  it("rejects an empty model", async () => {
    const res = await testEmbeddingConnection(embeddingConfig({ model: "" }))
    expect(res).toEqual({ ok: false, message: "Embedding model is empty." })
    expect(mocks.fetchEmbedding).not.toHaveBeenCalled()
  })

  it("reports the last embedding error when no vector is returned", async () => {
    mocks.fetchEmbedding.mockResolvedValue(null)
    mocks.getLastEmbeddingError.mockReturnValue("upstream refused")

    const res = await testEmbeddingConnection(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "upstream refused" })
  })

  it("falls back to a generic message when no vector and no stored error", async () => {
    mocks.fetchEmbedding.mockResolvedValue(null)
    mocks.getLastEmbeddingError.mockReturnValue(null)

    const res = await testEmbeddingConnection(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding endpoint returned no vector." })
  })

  it("reports success with the returned dimension count and latency", async () => {
    mocks.fetchEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const res = await testEmbeddingConnection(embeddingConfig())
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/Connected\. Returned 3 dimensions in \d+ ms\./)
    expect(mocks.fetchEmbedding).toHaveBeenCalledWith(
      "LLM Wiki embedding connection test.",
      expect.objectContaining({ endpoint: expect.any(String) }),
      0,
    )
  })
})

describe("testEmbeddingFunction", () => {
  it("reports the stored error when the first call fails", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce(null).mockResolvedValueOnce([1])
    mocks.getLastEmbeddingError.mockReturnValue("first call boom")

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "first call boom" })
  })

  it("falls back when the second call fails without a stored error", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([1]).mockResolvedValueOnce(null)
    mocks.getLastEmbeddingError.mockReturnValue(null)

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding endpoint did not return vectors." })
  })

  it("detects dimension drift between calls", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([1, 2, 3])

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding dimension changed between calls (2 vs 3)." })
  })

  it("rejects empty vectors", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding endpoint returned an empty or non-finite vector." })
  })

  it("rejects non-finite vector values", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([1, Number.NaN]).mockResolvedValueOnce([1, 2])

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding endpoint returned an empty or non-finite vector." })
  })

  it("rejects a zero-norm vector", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([0, 0])

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: false, message: "Embedding vector norm is zero or invalid." })
  })

  it("passes when vectors are stable and finite", async () => {
    mocks.fetchEmbedding.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([1, 2, 3])

    const res = await testEmbeddingFunction(embeddingConfig())
    expect(res).toEqual({ ok: true, message: "Functional test passed. Stable 3-dimension finite vectors returned." })
  })
})

describe("testLlmConnection", () => {
  it("surfaces a stream error", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onError: (e: Error) => void }) => {
      callbacks.onError(new Error("upstream 500"))
    })

    const res = await testLlmConnection(llmConfig())
    expect(res).toEqual({ ok: false, message: "upstream 500" })
  })

  it("rejects whitespace-only responses as empty content", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onToken: (t: string) => void }) => {
      callbacks.onToken("   \n  ")
    })

    const res = await testLlmConnection(llmConfig())
    expect(res).toEqual({ ok: false, message: "Model connected but returned empty content." })
  })

  it("reports success with latency and a truncated response preview", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
      callbacks.onToken("hello world")
      callbacks.onDone()
    })

    const res = await testLlmConnection(llmConfig())
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/^Connected in \d+ ms\. Response: hello world$/)
  })

  it("passes the fixed max_tokens and reasoning-off overrides to streamChat", async () => {
    mocks.streamChat.mockResolvedValue(undefined)

    await testLlmConnection(llmConfig())

    const [, messages, , , overrides] = mocks.streamChat.mock.calls[0] as unknown as [
      LlmConfig,
      unknown[],
      unknown,
      undefined,
      { max_tokens: number; reasoning: { mode: string } },
    ]
    expect(overrides.max_tokens).toBe(LLM_PROVIDER_TEST_MAX_TOKENS)
    expect(overrides.reasoning).toEqual({ mode: "off" })
    expect(messages).toHaveLength(2)
  })
})

describe("testLlmFunction", () => {
  it("surfaces a stream error", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onError: (e: Error) => void }) => {
      callbacks.onError(new Error("auth failed"))
    })

    const res = await testLlmFunction(llmConfig())
    expect(res).toEqual({ ok: false, message: "auth failed" })
  })

  it("rejects responses that do not contain the expected token", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onToken: (t: string) => void }) => {
      callbacks.onToken("I will not follow instructions")
    })

    const res = await testLlmFunction(llmConfig())
    expect(res.ok).toBe(false)
    expect(res.message).toContain("did not follow the functional test prompt")
  })

  it("rejects empty responses with an empty-preview hint", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onToken: (t: string) => void }) => {
      callbacks.onToken(" ")
    })

    const res = await testLlmFunction(llmConfig())
    expect(res.ok).toBe(false)
    expect(res.message).toContain("(empty)")
  })

  it("passes when the model returns the expected token", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _messages, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
      callbacks.onToken("LLM_WIKI_TEST_OK")
      callbacks.onDone()
    })

    const res = await testLlmFunction(llmConfig())
    expect(res).toEqual({ ok: true, message: "Functional test passed. The model returned the expected token." })
  })
})
