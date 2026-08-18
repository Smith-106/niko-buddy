import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getHttpFetch: vi.fn(),
  isFetchNetworkError: vi.fn(),
}))

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: mocks.getHttpFetch,
  isFetchNetworkError: mocks.isFetchNetworkError,
}))

import { isDirectRerankEndpoint, requestDirectRerank } from "./rerank-api"

function makeConfig(
  overrides: Partial<{ provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"; customEndpoint: string; apiKey: string; model: string }> = {},
) {
  return {
    provider: "custom" as const,
    customEndpoint: "https://example.com/v1/rerank",
    apiKey: "sk-test",
    model: "bge-reranker",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getHttpFetch.mockReset()
  mocks.isFetchNetworkError.mockReset()
})

describe("isDirectRerankEndpoint", () => {
  it("matches custom providers with a /rerank endpoint", () => {
    expect(isDirectRerankEndpoint({ provider: "custom", customEndpoint: "https://x.com/v1/rerank" })).toBe(true)
    expect(isDirectRerankEndpoint({ provider: "custom", customEndpoint: "https://x.com/v1/rerank/" })).toBe(true)
    expect(isDirectRerankEndpoint({ provider: "custom", customEndpoint: "  https://x.com/v1/rerank  " })).toBe(true)
    expect(isDirectRerankEndpoint({ provider: "custom", customEndpoint: "https://x.com/v1/RERANK/" })).toBe(true)
  })

  it("rejects non-matching endpoints and providers", () => {
    expect(isDirectRerankEndpoint({ provider: "custom", customEndpoint: "https://x.com/v1/models" })).toBe(false)
    expect(isDirectRerankEndpoint({ provider: "openai", customEndpoint: "https://x.com/v1/rerank" })).toBe(false)
  })
})

describe("requestDirectRerank", () => {
  it("throws when the endpoint is not a direct rerank endpoint", async () => {
    await expect(
      requestDirectRerank(makeConfig({ customEndpoint: "https://x.com/v1/models" }), "q", ["d"]),
    ).rejects.toThrow("当前配置不是直连重排接口。")
  })

  it("throws when the model is blank", async () => {
    await expect(
      requestDirectRerank(makeConfig({ model: "   " }), "q", ["d"]),
    ).rejects.toThrow("请先填写重排模型名称后再测试。")
  })

  it("returns an empty list for empty documents without fetching", async () => {
    const result = await requestDirectRerank(makeConfig(), "q", [])
    expect(result).toEqual([])
    expect(mocks.getHttpFetch).not.toHaveBeenCalled()
  })

  it("sends the rerank payload and maps results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.95 },
            { index: 2 },
          ],
        }),
        { status: 200 },
      ),
    )
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    const result = await requestDirectRerank(makeConfig(), "谁是主角", ["doc1", "doc2", "doc3"])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://example.com/v1/rerank")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test")
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      model: "bge-reranker",
      query: "谁是主角",
      documents: ["doc1", "doc2", "doc3"],
      top_n: 3,
      return_documents: false,
    })
    expect(result).toEqual([
      { index: 0, relevanceScore: 0.95 },
      { index: 2, relevanceScore: 0 },
    ])
  })

  it("omits the Authorization header when there is no api key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 }),
    )
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await requestDirectRerank(makeConfig({ apiKey: "" }), "q", ["d"])

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it("strips trailing slashes from the endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ index: 0 }] }), { status: 200 }),
    )
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await requestDirectRerank(makeConfig({ customEndpoint: "https://x.com/v1/rerank/" }), "q", ["d"])
    expect(fetchMock.mock.calls[0][0]).toBe("https://x.com/v1/rerank")
  })

  it("throws an HTTP error with the body text on non-OK responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429, statusText: "Too Many Requests" }))
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow(
      "HTTP 429: Too Many Requests - rate limited",
    )
  })

  it("still throws an HTTP error when the error body cannot be read", async () => {
    const response = new Response("", { status: 500, statusText: "boom" })
    vi.spyOn(response, "text").mockRejectedValue(new Error("body unreadable"))
    const fetchMock = vi.fn().mockResolvedValue(response)
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow("HTTP 500: boom")
  })

  it("throws when the response has no valid results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow(
      "没有返回有效的 results",
    )

    const fetchMock2 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ relevance_score: 0.5 }] }), { status: 200 }),
    )
    mocks.getHttpFetch.mockResolvedValue(fetchMock2)
    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow(
      "没有返回有效的 results",
    )
  })

  it("wraps network errors with the endpoint address", async () => {
    mocks.isFetchNetworkError.mockReturnValue(true)
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow(
      "无法连接到重排接口：https://example.com/v1/rerank",
    )
  })

  it("rethrows non-network errors as-is", async () => {
    mocks.isFetchNetworkError.mockReturnValue(false)
    const fetchMock = vi.fn().mockRejectedValue(new Error("json parse failed"))
    mocks.getHttpFetch.mockResolvedValue(fetchMock)

    await expect(requestDirectRerank(makeConfig(), "q", ["d"])).rejects.toThrow("json parse failed")
  })

  it("passes the abort signal through to the fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ index: 0 }] }), { status: 200 }),
    )
    mocks.getHttpFetch.mockResolvedValue(fetchMock)
    const controller = new AbortController()

    await requestDirectRerank(makeConfig(), "q", ["d"], controller.signal)
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal)
  })
})
