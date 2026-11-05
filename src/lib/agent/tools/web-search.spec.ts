import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SearchApiConfig } from "@/stores/wiki-store"
import { createWebSearchTool } from "./web-search"

const webSearchMock = vi.fn()

vi.mock("@/lib/web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search")>()
  return {
    ...actual,
      resolveSearchConfig: (config: SearchApiConfig) => config,
      providerRequiresApiKey: (provider: string) =>
        provider === "bocha" ||
        provider === "qiniu" ||
        provider === "metaso" ||
        provider === "tavily" ||
        provider === "serpapi",
      webSearch: (...args: unknown[]) => webSearchMock(...args),
    
  }
})

const notConfigured: SearchApiConfig = {
  provider: "none",
  apiKey: "",
  serpApiEngine: "google",
  searXngUrl: "",
  searXngCategories: ["general"],
  providerConfigs: {},
}

const configured: SearchApiConfig = {
  provider: "tavily",
  apiKey: "test-key",
  serpApiEngine: "google",
  searXngUrl: "",
  searXngCategories: ["general"],
  providerConfigs: {},
}

describe("createWebSearchTool", () => {
  beforeEach(() => {
    webSearchMock.mockReset()
  })

  it("未配置外部搜索时返回中文降级结果，且不假装已经搜索", async () => {
    const tool = createWebSearchTool(() => notConfigured)

    const raw = await tool.execute({ query: "黄蓉", maxResults: 3 })
    const result = JSON.parse(raw)

    expect(result.status).toBe("not_configured")
    expect(result.query).toBe("黄蓉")
    expect(result.resultCount).toBe(0)
    expect(result.message).toContain("当前未配置外部搜索")
    expect(result.message).toContain("未执行联网搜索")
    expect(result.message).toContain("设置 → 网页搜索")
    expect(result.message).toContain("博查")
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it("已配置外部搜索时返回标题、摘要、链接和来源", async () => {
    webSearchMock.mockResolvedValueOnce([
      {
        title: "黄蓉 - 人物资料",
        url: "https://example.com/huang-rong",
        snippet: "黄蓉是金庸小说中的人物。",
        source: "example.com",
      },
    ])
    const tool = createWebSearchTool(() => configured)

    const raw = await tool.execute({ query: "黄蓉", maxResults: 1 })
    const result = JSON.parse(raw)

    expect(webSearchMock).toHaveBeenCalledWith("黄蓉", configured, 1)
    expect(result.status).toBe("ok")
    expect(result.provider).toBe("tavily")
    expect(result.resultCount).toBe(1)
    expect(result.results[0]).toMatchObject({
      title: "黄蓉 - 人物资料",
      url: "https://example.com/huang-rong",
      snippet: "黄蓉是金庸小说中的人物。",
      source: "example.com",
    })
  })

  it("搜索失败时返回中文失败结果，明确本次未使用联网资料", async () => {
    webSearchMock.mockRejectedValueOnce(new Error("timeout"))
    const tool = createWebSearchTool(() => configured)

    const raw = await tool.execute({ query: "黄蓉" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.resultCount).toBe(0)
    expect(result.message).toContain("外部搜索失败")
    expect(result.message).toContain("本次未使用联网资料")
  })
})

describe("createWebSearchTool — 参数归一与配置判定", () => {
  beforeEach(() => {
    webSearchMock.mockReset()
  })

  it("查询关键词为空白时返回中文错误且不触网（不伪造一次空搜索）", async () => {
    const tool = createWebSearchTool(() => configured)

    const result = JSON.parse(await tool.execute({ query: "   ", maxResults: 3 }))

    expect(result.status).toBe("error")
    expect(result.query).toBe("")
    expect(result.provider).toBe("tavily")
    expect(result.resultCount).toBe(0)
    expect(result.results).toEqual([])
    expect(result.message).toBe("搜索关键词为空，未执行联网搜索。")
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it("完全没传 query 参数时按空关键词处理（不把 undefined 拼进搜索词）", async () => {
    const tool = createWebSearchTool(() => configured)

    const result = JSON.parse(await tool.execute({ maxResults: 3 }))

    expect(result.status).toBe("error")
    expect(result.query).toBe("")
    expect(result.message).toBe("搜索关键词为空，未执行联网搜索。")
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it("maxResults 非法值回落默认 5、超界截到 10、字符串数字按整数解析", async () => {
    webSearchMock.mockResolvedValue([])
    const tool = createWebSearchTool(() => configured)

    await tool.execute({ query: "黄蓉", maxResults: 0 })
    await tool.execute({ query: "黄蓉", maxResults: -4 })
    await tool.execute({ query: "黄蓉", maxResults: "abc" })
    await tool.execute({ query: "黄蓉" })
    await tool.execute({ query: "黄蓉", maxResults: 99 })
    await tool.execute({ query: "黄蓉", maxResults: "3" })
    await tool.execute({ query: "黄蓉", maxResults: 2.9 })

    expect(webSearchMock.mock.calls.map((call) => call[2])).toEqual([5, 5, 5, 5, 10, 3, 2])
  })

  it("未注入配置读取器时按未配置处理（provider=none，不触网）", async () => {
    const tool = createWebSearchTool()

    const result = JSON.parse(await tool.execute({ query: "黄蓉" }))

    expect(result.status).toBe("not_configured")
    expect(result.provider).toBe("none")
    expect(result.message).toContain("当前未配置外部搜索")
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it("配置读取器返回 null 时按未配置处理", async () => {
    const tool = createWebSearchTool(() => null)

    const result = JSON.parse(await tool.execute({ query: "黄蓉" }))

    expect(result.status).toBe("not_configured")
    expect(result.provider).toBe("none")
  })

  it("需要 API Key 的 provider 只有空白 key 时按未配置处理", async () => {
    const tool = createWebSearchTool(() => ({ ...configured, apiKey: "   " }))

    const result = JSON.parse(await tool.execute({ query: "黄蓉" }))

    expect(result.status).toBe("not_configured")
    expect(result.message).toContain("当前未配置外部搜索")
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it("searxng 缺实例地址时未配置；补齐地址后按 searxng 正常搜索", async () => {
    const noUrl: SearchApiConfig = { ...configured, provider: "searxng", apiKey: "", searXngUrl: "" }
    const blocked = JSON.parse(await createWebSearchTool(() => noUrl).execute({ query: "黄蓉" }))
    expect(blocked.status).toBe("not_configured")

    webSearchMock.mockResolvedValueOnce([
      { title: "黄蓉", url: "https://example.com/a", snippet: "摘要", source: "example.com" },
    ])
    const withUrl: SearchApiConfig = { ...noUrl, searXngUrl: "http://127.0.0.1:8888" }
    const ok = JSON.parse(await createWebSearchTool(() => withUrl).execute({ query: "黄蓉" }))

    expect(ok.status).toBe("ok")
    expect(ok.provider).toBe("searxng")
    expect(ok.resultCount).toBe(1)
    expect(webSearchMock).toHaveBeenCalledWith("黄蓉", withUrl, 5)
  })
})
