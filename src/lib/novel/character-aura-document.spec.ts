import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SearchApiConfig } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
}))

const getHttpFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: getHttpFetchMock,
}))

const webSearchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/web-search", () => ({
  webSearch: webSearchMock,
}))

const storeState = vi.hoisted(() => ({
  llmConfig: { provider: "openai", apiKey: "k", model: "m" },
  searchApiConfig: { provider: "tavily", apiKey: "tk" } as SearchApiConfig,
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => storeState },
}))

import {
  collectCustomAuraWebSearch,
  readCustomAuraLocalDocuments,
  readCustomAuraUrls,
} from "./character-aura-document"
import type { CustomCharacterAuraSkillInput } from "./character-aura-types"
import type { WebSearchResult } from "@/lib/web-search"

function skillInput(overrides: Partial<CustomCharacterAuraSkillInput> = {}): CustomCharacterAuraSkillInput {
  return { name: "林动", category: "主角", generationPrompt: "测试", ...overrides }
}

function httpOk(body: string): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => body }
}

function httpError(status = 500): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: false, status, text: async () => "" }
}

function searchResult(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { title: "标题", url: "https://example.com/a", snippet: "摘要", source: "tavily", ...overrides }
}

describe("readCustomAuraLocalDocuments", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
  })

  it("imports readable paths and records failures", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/d/ok.md") return "正文内容"
      throw new Error("ENOENT")
    })
    const result = await readCustomAuraLocalDocuments(skillInput({ localDocumentPaths: "/d/ok.md\n/d/missing.md" }))
    expect(result.importedDocuments).toEqual([{ path: "/d/ok.md", content: "正文内容" }])
    expect(result.failedDocuments).toEqual(["/d/missing.md"])
  })

  it("returns empty results when no paths are provided", async () => {
    const result = await readCustomAuraLocalDocuments(skillInput({}))
    expect(result).toEqual({ importedDocuments: [], failedDocuments: [] })
  })
})

describe("readCustomAuraUrls", () => {
  beforeEach(() => {
    getHttpFetchMock.mockReset()
  })

  it("returns empty results when no urls are provided", async () => {
    const result = await readCustomAuraUrls(skillInput({}))
    expect(result).toEqual({ importedUrls: [], failedUrls: [] })
  })

  it("marks all urls failed when getHttpFetch throws", async () => {
    getHttpFetchMock.mockRejectedValue(new Error("no http"))
    const result = await readCustomAuraUrls(skillInput({ sourceUrls: "https://a.com\nhttps://b.com" }))
    expect(result.importedUrls).toEqual([])
    expect(result.failedUrls).toEqual(["https://a.com", "https://b.com"])
  })

  it("imports urls with plain-text content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpOk("<p>网页 &amp; 内容</p>"))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await readCustomAuraUrls(skillInput({ sourceUrls: "https://a.com" }))
    expect(result.importedUrls).toEqual([{ url: "https://a.com", content: "网页 & 内容" }])
    expect(result.failedUrls).toEqual([])
  })

  it("marks failed urls for non-ok responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(404))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await readCustomAuraUrls(skillInput({ sourceUrls: "https://a.com" }))
    expect(result.failedUrls).toEqual(["https://a.com"])
  })

  it("marks failed urls when content cleans to empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpOk("<script>var x=1</script>"))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await readCustomAuraUrls(skillInput({ sourceUrls: "https://a.com" }))
    expect(result.failedUrls).toEqual(["https://a.com"])
  })
})

describe("collectCustomAuraWebSearch", () => {
  beforeEach(() => {
    webSearchMock.mockReset()
    getHttpFetchMock.mockReset()
  })

  it("returns empty pack when no queries can be planned (name/prompt empty → queries still planned)", async () => {
    webSearchMock.mockResolvedValue([])
    const result = await collectCustomAuraWebSearch(skillInput({ name: "", category: "", generationPrompt: "" }))
    // the three fixed query suffixes keep the list non-empty
    expect(result.searchQueries).toEqual(["公开资料 人物经历", "说话风格 评价", "关键事件 时间线 决策"])
  })

  it("plans queries from name + category + prompt", async () => {
    webSearchMock.mockResolvedValue([])
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(result.searchQueries).toEqual([
      "林动 主角 测试 公开资料 人物经历",
      "林动 主角 测试 说话风格 评价",
      "林动 主角 测试 关键事件 时间线 决策",
    ])
    expect(webSearchMock).toHaveBeenCalledTimes(3)
  })

  it("breaks early when webSearch reports not configured", async () => {
    webSearchMock.mockRejectedValue(new Error("not configured"))
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(webSearchMock).toHaveBeenCalledTimes(1)
    expect(result.generationNotes).toContain("AI 搜索没有拿到可用结果，本次继续只使用你提供的资料。")
  })

  it("records non-config errors and continues, dedupes results, then imports documents", async () => {
    webSearchMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([
        searchResult({ url: "https://x.com/1" }),
        searchResult({ url: "https://x.com/1" }), // duplicate
        searchResult({ url: "", title: "空链接", source: "s" }),
      ])
      .mockResolvedValueOnce([])
    const fetchMock = vi.fn().mockResolvedValue(httpOk("<p>搜索结果正文</p>"))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(result.generationNotes).toEqual(["AI 搜索「林动 主角 测试 公开资料 人物经历」失败：rate limited"])
    expect(result.webSearchResults).toHaveLength(2)
    expect(result.importedSearchDocuments).toHaveLength(2)
    expect(result.failedSearchUrls).toEqual([])
  })

  it("marks failed fetches when getHttpFetch throws", async () => {
    webSearchMock.mockResolvedValue([searchResult({ url: "https://x.com/1" })])
    getHttpFetchMock.mockRejectedValue(new Error("no http"))
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(result.failedSearchUrls).toEqual(["https://x.com/1"])
    expect(result.importedSearchDocuments).toEqual([])
  })

  it("marks individual urls failed on non-ok responses", async () => {
    webSearchMock.mockResolvedValue([searchResult({ url: "https://bad.com" })])
    const fetchMock = vi.fn().mockResolvedValue(httpError(500))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(result.failedSearchUrls).toEqual(["https://bad.com"])
  })

  it("records the query matched to the result title or falls back to the first query", async () => {
    webSearchMock.mockResolvedValueOnce([
      searchResult({ title: "林动 主角 测试 公开资料 人物经历 特稿", url: "https://x.com/1" }),
      searchResult({ title: "无关标题", url: "https://x.com/2" }),
    ])
    const fetchMock = vi.fn().mockResolvedValue(httpOk("<p>正文</p>"))
    getHttpFetchMock.mockResolvedValue(fetchMock)
    const result = await collectCustomAuraWebSearch(skillInput())
    expect(result.importedSearchDocuments[0].query).toBe("林动 主角 测试 公开资料 人物经历")
    expect(result.importedSearchDocuments[1].query).toBe("林动 主角 测试 公开资料 人物经历")
  })

  it("uses an injected search config instead of the store config", async () => {
    webSearchMock.mockResolvedValue([])
    const searchApiConfig = { provider: "brave", apiKey: "injected" } as unknown as SearchApiConfig

    await collectCustomAuraWebSearch(skillInput(), { searchApiConfig })

    expect(webSearchMock).toHaveBeenCalledWith(expect.any(String), searchApiConfig, 4)
  })

  it("records a generic note for a non-Error search failure", async () => {
    webSearchMock.mockRejectedValue("raw search failure")

    const result = await collectCustomAuraWebSearch(skillInput())

    expect(result.generationNotes[0]).toContain("未知错误")
    expect(webSearchMock).toHaveBeenCalledTimes(3)
  })

  it("uses an empty result snippet when selecting the fallback query", async () => {
    webSearchMock.mockResolvedValue([searchResult({ snippet: "" })])
    getHttpFetchMock.mockResolvedValue(vi.fn().mockResolvedValue(httpOk("<p>正文</p>")))

    const result = await collectCustomAuraWebSearch(skillInput({ generationPrompt: undefined }))

    expect(result.importedSearchDocuments).toHaveLength(1)
    expect(result.importedSearchDocuments[0]?.query).toBe("林动 主角 公开资料 人物经历")
  })

  it("marks an empty search document as failed", async () => {
    webSearchMock.mockResolvedValue([searchResult({ url: "https://empty.com" })])
    getHttpFetchMock.mockResolvedValue(vi.fn().mockResolvedValue(httpOk("<script>ignore()</script>")))

    await expect(collectCustomAuraWebSearch(skillInput())).resolves.toMatchObject({
      importedSearchDocuments: [],
      failedSearchUrls: ["https://empty.com"],
    })
  })

  it("falls back to the store searchApiConfig when not injected", async () => {
    webSearchMock.mockResolvedValue([])
    await collectCustomAuraWebSearch(skillInput())
    expect(webSearchMock).toHaveBeenCalledWith(expect.any(String), storeState.searchApiConfig, 4)
  })
})
