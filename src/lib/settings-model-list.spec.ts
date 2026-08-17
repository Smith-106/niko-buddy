import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { invoke } from "@tauri-apps/api/core"

const fetchMock = vi.fn()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => fetchMock,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: () => true,
}))

function customConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "custom",
    apiKey: "sk-test",
    model: "gpt-4o",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://hub.linux.do/v1",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

afterEach(() => {
  fetchMock.mockReset()
  vi.mocked(invoke).mockReset()
})

describe("settings model list", () => {
  it("fetches custom OpenAI-compatible models from the normalized /models endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig())

    expect(fetchMock).toHaveBeenCalledWith("https://hub.linux.do/v1/models", {
      method: "GET",
      headers: {
        Authorization: "Bearer sk-test",
        Origin: "",
      },
    })
    expect(result.models).toEqual(["gpt-test"])
  })

  it("retries model list 403 responses with browser-compatible OpenAI headers", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "linux-do-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://hub.linux.do/v1/models",
      {
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          Accept: "application/json",
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        }),
      },
    ])
    expect(result.models).toEqual(["linux-do-model"])
  })

  it("keeps the original 403 diagnostic when the compatibility retry cannot be sent", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockRejectedValueOnce(new TypeError("Refused to set unsafe header"))

    const { fetchLlmModelList } = await import("./settings-model-list")

    await expect(fetchLlmModelList(customConfig())).rejects.toThrow(
      "模型列表拉取失败：HTTP 403 forbidden",
    )
  })

  it("reads the configured local Claude CLI model from Tauri detection", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      installed: true,
      version: "2.1.169 (Claude Code)",
      path: "C:/Users/Administrator/AppData/Roaming/npm/claude.cmd",
      model: "haiku",
      error: null,
    })

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({
      provider: "claude-code",
      apiKey: "",
      model: "",
    }))

    expect(invoke).toHaveBeenCalledWith("claude_cli_detect")
    expect(result.models).toEqual(["haiku"])
  })

  it("reads the configured local Codex CLI model from Tauri detection", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      installed: true,
      version: "codex-cli 0.137.0",
      path: "C:/Users/Administrator/AppData/Roaming/npm/codex.cmd",
      model: "gpt-5.4",
      error: null,
    })

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({
      provider: "codex-cli",
      apiKey: "",
      model: "",
    }))

    expect(invoke).toHaveBeenCalledWith("codex_cli_detect")
    expect(result.models).toEqual(["gpt-5.4"])
  })
})

describe("settings model list — full-coverage extensions", () => {
  it("fetches Google LLM models with x-goog-api-key and strips the models/ prefix", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "models/gemini-2.0-flash" }, { id: "models/gemini-pro" }] }), {
        status: 200,
      }),
    )

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({ provider: "google", apiKey: "gkey", customEndpoint: "" }))

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { method: "GET", headers: { "x-goog-api-key": "gkey" } },
    )
    expect(result.models).toEqual(["gemini-2.0-flash", "gemini-pro"])
  })

  it("fetches Google LLM models from an explicit endpoint without an api key", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "models/gemini-1.5-flash" }] }), { status: 200 }),
    )

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({
      provider: "google",
      apiKey: "",
      customEndpoint: "https://generativelanguage.googleapis.com/v1beta",
    }))

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { method: "GET", headers: {} },
    )
    expect(result.models).toEqual(["gemini-1.5-flash"])
  })

  it("fetches openai provider models using the provider-default headers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }),
    )

    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({ provider: "openai", apiKey: "sk-openai" }))

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      { method: "GET", headers: { Authorization: "Bearer sk-openai" } },
    )
    expect(result.models).toEqual(["gpt-5"])
  })

  it("returns the explicitly configured model for a local CLI provider without detection", async () => {
    const { fetchLlmModelList } = await import("./settings-model-list")
    const result = await fetchLlmModelList(customConfig({ provider: "claude-code", apiKey: "", model: "opus" }))

    expect(result.models).toEqual(["opus"])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("throws when the local CLI detect returns no model", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null)

    const { fetchLlmModelList } = await import("./settings-model-list")
    await expect(
      fetchLlmModelList(customConfig({ provider: "codex-cli", apiKey: "", model: "" })),
    ).rejects.toThrow("当前本地 CLI 未配置默认模型")
  })

  it("throws with the body text on a non-403 HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Not Found", { status: 404 }))

    const { fetchLlmModelList } = await import("./settings-model-list")
    await expect(fetchLlmModelList(customConfig())).rejects.toThrow(
      "模型列表拉取失败：HTTP 404 Not Found",
    )
  })

  it("throws with just the status when the error body cannot be read", async () => {
    const badResponse = new Response("boom", { status: 500 })
    vi.spyOn(badResponse, "text").mockRejectedValue(new TypeError("stream error"))
    fetchMock.mockResolvedValueOnce(badResponse)

    const { fetchLlmModelList } = await import("./settings-model-list")
    await expect(fetchLlmModelList(customConfig())).rejects.toThrow("模型列表拉取失败：HTTP 500")
  })

  it("keeps only the status when a 403 retry fails and the 403 body could not be read", async () => {
    const badResponse = new Response("n/a", { status: 403 })
    vi.spyOn(badResponse, "text").mockRejectedValue(new TypeError("stream error"))
    fetchMock.mockResolvedValueOnce(badResponse).mockRejectedValueOnce(new TypeError("net down"))

    const { fetchLlmModelList } = await import("./settings-model-list")
    await expect(fetchLlmModelList(customConfig())).rejects.toThrow("模型列表拉取失败：HTTP 403")
  })

  it("fetches Google embedding models, stripping the key and the models/ prefix", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ name: "models/text-embedding-004" }] }), { status: 200 }),
    )

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=abc123",
      apiKey: "gkey2",
      model: "text-embedding-004",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { method: "GET", headers: { "x-goog-api-key": "gkey2" } },
    )
    expect(result.models).toEqual(["text-embedding-004"])
  })

  it("fetches OpenAI-compatible embedding models with a Bearer header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "text-embedding-3-small" }] }), { status: 200 }),
    )

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.openai.com/v1/embeddings",
      apiKey: "sk-emb",
      model: "text-embedding-3-small",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      { method: "GET", headers: { Authorization: "Bearer sk-emb" } },
    )
    expect(result.models).toEqual(["text-embedding-3-small"])
  })

  it("fetches embedding models without an api key and dedupes/sorts string models", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: ["nomic-embed-text", " bge-m3 ", ""] }), { status: 200 }),
    )

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "",
      model: "nomic-embed-text",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/models",
      { method: "GET", headers: {} },
    )
    expect(result.models).toEqual(["bge-m3", "nomic-embed-text"])
  })

  it("throws when the embedding endpoint is empty", async () => {
    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    await expect(
      fetchEmbeddingModelList({ enabled: true, endpoint: "  ", apiKey: "", model: "m" }),
    ).rejects.toThrow("请先填写接口地址后再拉取模型列表。")
  })

  it("appends /models for a plain embedding endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.example.com/v1",
      apiKey: "",
      model: "x",
    })

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", { method: "GET", headers: {} })
    expect(result.models).toEqual(["x"])
  })

  it("returns the endpoint unchanged when it already ends in /models", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.example.com/v1/models",
      apiKey: "",
      model: "x",
    })

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", { method: "GET", headers: {} })
  })

  it.each([
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1/messages", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1/rerank", "https://api.example.com/v1/models"],
  ] as const)("maps request-path suffix %s to %s", async (endpoint, expected) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    await fetchEmbeddingModelList({ enabled: true, endpoint, apiKey: "", model: "m" })

    expect(fetchMock).toHaveBeenCalledWith(expected, { method: "GET", headers: {} })
  })

  it("handles a non-google embedContent endpoint without a key param", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://proxy.example.com/v1/models/gemini:embedContent",
      apiKey: "",
      model: "m",
    })

    expect(fetchMock).toHaveBeenCalledWith("https://proxy.example.com/v1/models", { method: "GET", headers: {} })
    expect(result.models).toEqual(["m"])
  })

  it("strips a mid-query key parameter via the regex fallback for malformed URLs", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com:abc/v1beta/models?x=1&key=abc",
      apiKey: "",
      model: "m",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com:abc/v1beta/models",
      { method: "GET", headers: {} },
    )
    expect(result.models).toEqual(["m"])
  })

  it("strips a leading key query parameter via the regex fallback for malformed URLs", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com:abc/v1beta/models?key=abc",
      apiKey: "",
      model: "m",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com:abc/v1beta/models",
      { method: "GET", headers: {} },
    )
    expect(result.models).toEqual(["m"])
  })

  it("parses mixed model list item shapes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: ["gpt-a", { name: "gpt-b" }, { model: "gpt-c" }, 42, { id: 123 }] }), {
        status: 200,
      }),
    )

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.example.com/v1/models",
      apiKey: "",
      model: "x",
    })

    expect(result.models).toEqual(["gpt-a", "gpt-b", "gpt-c"])
  })

  it("returns an empty list for a non-array data payload", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: 42 }), { status: 200 }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.example.com/v1/models",
      apiKey: "",
      model: "x",
    })

    expect(result.models).toEqual([])
  })

  it("returns an empty list when the payload is not an object", async () => {
    fetchMock.mockResolvedValueOnce(new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }))

    const { fetchEmbeddingModelList } = await import("./settings-model-list")
    const result = await fetchEmbeddingModelList({
      enabled: true,
      endpoint: "https://api.example.com/v1/models",
      apiKey: "",
      model: "x",
    })

    expect(result.models).toEqual([])
  })

  it("delegates rerank model fetch to the main LLM config when useMainLlm is set", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "rerank-model" }] }), { status: 200 }))

    const { fetchRerankModelList } = await import("./settings-model-list")
    const result = await fetchRerankModelList(customConfig(), {
      enabled: true,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxCandidates: 5,
    })

    expect(fetchMock).toHaveBeenCalledWith("https://hub.linux.do/v1/models", expect.anything())
    expect(result.models).toEqual(["rerank-model"])
  })

  it("fetches a direct rerank endpoint independently with a Bearer header", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "rerank-1" }] }), { status: 200 }))

    const { fetchRerankModelList } = await import("./settings-model-list")
    const result = await fetchRerankModelList(customConfig(), {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "rk",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "https://rerank.example.com/v1/rerank",
      maxCandidates: 5,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://rerank.example.com/v1/models",
      { method: "GET", headers: { Authorization: "Bearer rk" } },
    )
    expect(result.models).toEqual(["rerank-1"])
  })

  it("fetches a direct rerank endpoint without an api key", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "rerank-2" }] }), { status: 200 }))

    const { fetchRerankModelList } = await import("./settings-model-list")
    const result = await fetchRerankModelList(customConfig(), {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "https://rerank.example.com/v1/rerank",
      maxCandidates: 5,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://rerank.example.com/v1/models",
      { method: "GET", headers: {} },
    )
    expect(result.models).toEqual(["rerank-2"])
  })

  it("fetches via the main LLM pipeline for a non-direct custom rerank config", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "rr" }] }), { status: 200 }))

    const { fetchRerankModelList } = await import("./settings-model-list")
    const result = await fetchRerankModelList(customConfig({ maxContextSize: 128000 }), {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "rk2",
      model: "rr",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "https://hub.linux.do/v1",
      apiMode: "responses",
      maxCandidates: 5,
    })

    expect(fetchMock).toHaveBeenCalledWith("https://hub.linux.do/v1/models", expect.objectContaining({ method: "GET" }))
    expect(result.models).toEqual(["rr"])
  })

  it("fetches via the main LLM pipeline for a non-custom rerank provider", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "rr2" }] }), { status: 200 }))

    const { fetchRerankModelList } = await import("./settings-model-list")
    const llmConfig = { ...customConfig(), maxContextSize: undefined as unknown as number }
    const result = await fetchRerankModelList(llmConfig, {
      enabled: true,
      useMainLlm: false,
      provider: "openai",
      apiKey: "sk-o",
      model: "rr2",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxCandidates: 5,
    })

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ method: "GET" }))
    expect(result.models).toEqual(["rr2"])
  })
})
