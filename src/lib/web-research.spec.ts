import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/web-search", () => ({
  webSearch: vi.fn(),
}))
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: vi.fn(),
}))

import { webSearch } from "@/lib/web-search"
import { getHttpFetch } from "@/lib/tauri-fetch"
import {
  buildWebResearchContext,
  collectWebResearch,
  deriveWebResearchQuery,
  extractWebUrls,
  htmlToPlainText,
  shouldUseWebResearch,
} from "./web-research"

const mockedWebSearch = vi.mocked(webSearch)
const mockedGetHttpFetch = vi.mocked(getHttpFetch)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetHttpFetch.mockResolvedValue(vi.fn() as unknown as typeof fetch)
})

describe("web research helpers", () => {
  it("detects explicit web research requests and URLs", () => {
    expect(shouldUseWebResearch("联网搜索一下都市小说热门题材")).toBe(true)
    expect(shouldUseWebResearch("打开 https://example.com/book/1 分析这个网页")).toBe(true)
    expect(shouldUseWebResearch("帮我生成第七章内容")).toBe(false)
  })

  it("extracts http and https URLs without trailing punctuation", () => {
    expect(extractWebUrls("参考 https://example.com/a，另一个是 http://foo.test/b.")).toEqual([
      "https://example.com/a",
      "http://foo.test/b",
    ])
  })

  it("extracts URLs and deduplicates, stripping Chinese/Western punctuation", () => {
    expect(
      extractWebUrls("看 https://a.com/x），以及 https://a.com/x，还有 https://b.com/y。"),
    ).toEqual(["https://a.com/x", "https://b.com/y"])
  })

  it("builds a bounded research context with sources", () => {
    const context = buildWebResearchContext({
      query: "玄幻小说热门套路",
      searchResults: [
        {
          title: "热门趋势",
          url: "https://example.com/hot",
          source: "example.com",
          snippet: "近期读者更关注强冲突开篇。",
        },
      ],
      importedDocuments: [
        {
          title: "榜单分析",
          url: "https://example.com/rank",
          source: "example.com",
          content: "榜单前排作品普遍在前三百字给出危机，并在第一章结尾留下明确钩子。".repeat(80),
        },
      ],
      failedUrls: ["https://example.com/fail"],
    })

    expect(context.markdown).toContain("## 联网研究资料")
    expect(context.markdown).toContain("搜索问题：玄幻小说热门套路")
    expect(context.markdown).toContain("https://example.com/hot")
    expect(context.markdown).toContain("https://example.com/rank")
    expect(context.markdown).toContain("读取失败")
    expect(context.sources).toEqual([
      "热门趋势 - https://example.com/hot",
      "榜单分析 - https://example.com/rank",
    ])
    expect(context.markdown.length).toBeLessThan(5200)
  })

  it("uses the fallback query label when no query is present", () => {
    const context = buildWebResearchContext({
      query: "",
      searchResults: [],
      importedDocuments: [],
      failedUrls: [],
    })
    expect(context.markdown).toContain("用户指定网页资料")
    expect(context.sources).toEqual([])
  })

  it("uses hostname when source is empty and clips long content", () => {
    const context = buildWebResearchContext({
      query: "q",
      searchResults: [
        { title: "无来源", url: "https://sub.example.com/page", source: "", snippet: "s".repeat(300) },
      ],
      importedDocuments: [
        { title: "正文", url: "https://www.other.org/doc", source: "", content: "c".repeat(2000) },
      ],
      failedUrls: [],
    })
    expect(context.markdown).toContain("sub.example.com")
    expect(context.markdown).toContain("other.org")
    expect(context.markdown).toContain("[已截断]")
  })

  it("derives a search query from the user message", () => {
    expect(deriveWebResearchQuery("请帮我查一下最新热门榜单")).toBe("最新热门榜单")
    expect(deriveWebResearchQuery("联网搜索一下都市小说热门题材")).toBe("都市小说热门题材")
    expect(deriveWebResearchQuery("打开 https://example.com/a 这个网页")).toBe("这个")
    expect(deriveWebResearchQuery("   ")).toBe("")
    expect(deriveWebResearchQuery("abc".repeat(50))).toHaveLength(120)
  })

  it("converts HTML to plain text", () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>标题</h1><p>第一段<br/>换行</p><div>第二段</div><noscript>no</noscript>
      &nbsp;&amp;&lt;&gt;&#39;&quot; end</body></html>`
    const text = htmlToPlainText(html)
    expect(text).toContain("标题")
    expect(text).toContain("第一段")
    expect(text).toContain("第二段")
    expect(text).toContain("&<>'\" end")
    expect(text).not.toContain("<style>")
    expect(text).not.toContain("alert")
    expect(text).not.toContain("<script>")
  })
})

describe("collectWebResearch", () => {
  it("runs a full search + fetch pipeline with deduplication and clamping", async () => {
    mockedWebSearch.mockResolvedValue([
      { title: "结果一", url: "https://example.com/r1", source: "example.com", snippet: "片段" },
      { title: "重复", url: "https://example.com/r1", source: "example.com", snippet: "重复片段" },
    ])
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://example.com/r1") {
        return jsonResponse("<html><body><h1>页面</h1><p>正文内容很长很详细。</p></body></html>")
      }
      if (url === "https://example.com/broken") {
        return jsonResponse("", false, 500)
      }
      return jsonResponse("<html></html>")
    })
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "请帮我搜索 最新 https://example.com/broken 资料",
      searchApiConfig: {} as never,
      maxSearchResults: 100,
      maxImportedDocuments: 100,
    })

    expect(result.query).toBe("最新 资料")
    expect(result.urls).toEqual(["https://example.com/broken"])
    expect(result.searchResults).toHaveLength(2)
    expect(result.importedDocuments).toHaveLength(1)
    expect(result.importedDocuments[0].title).toBe("结果一")
    expect(result.failedUrls).toEqual(["https://example.com/broken"])
    expect(result.notes).toEqual([])
    expect(fetchMock).toHaveBeenCalled()
  })

  it("clamps maxSearchResults and maxImportedDocuments and honors allow flags", async () => {
    mockedWebSearch.mockResolvedValue([
      { title: "a", url: "https://example.com/a", source: "s", snippet: "x" },
    ])
    const fetchMock = vi.fn(async () => jsonResponse("<p>正文</p>"))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "普通请求",
      searchApiConfig: {} as never,
      maxSearchResults: 99,
      maxImportedDocuments: 99,
      allowSearch: true,
      allowReadUrls: false,
    })
    expect(result.importedDocuments).toEqual([])
    expect(mockedWebSearch).toHaveBeenCalledWith("普通 求", {}, 10)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("records search failure notes and continues", async () => {
    mockedWebSearch.mockRejectedValue(new Error("no provider configured"))
    mockedGetHttpFetch.mockResolvedValue(vi.fn() as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "搜索一下 热门",
      searchApiConfig: {} as never,
    })
    expect(result.notes).toEqual(["网页搜索失败：no provider configured"])
    expect(result.searchResults).toEqual([])
  })

  it("stringifies non-Error search failures", async () => {
    mockedWebSearch.mockRejectedValue("string failure")
    mockedGetHttpFetch.mockResolvedValue(vi.fn() as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "搜索一下 热门",
      searchApiConfig: {} as never,
    })
    expect(result.notes).toEqual(["网页搜索失败：string failure"])
  })

  it("handles getHttpFetch rejection by marking all urls failed", async () => {
    mockedWebSearch.mockResolvedValue([])
    mockedGetHttpFetch.mockRejectedValue(new Error("no fetch"))

    const result = await collectWebResearch({
      text: "看看 https://example.com/x",
      searchApiConfig: {} as never,
    })
    expect(result.failedUrls).toEqual(["https://example.com/x"])
  })

  it("marks urls failed when the fetched document has no text content", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("<html><body><script>x</script></body></html>"))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "https://example.com/empty",
      searchApiConfig: {} as never,
    })
    expect(result.failedUrls).toEqual(["https://example.com/empty"])
    expect(result.importedDocuments).toEqual([])
  })

  it("skips search when allowSearch is false and still fetches explicit urls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("<p>body</p>"))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "https://example.com/direct",
      searchApiConfig: {} as never,
      allowSearch: false,
    })
    expect(mockedWebSearch).not.toHaveBeenCalled()
    expect(result.importedDocuments).toHaveLength(1)
    expect(result.importedDocuments[0].url).toBe("https://example.com/direct")
    expect(result.importedDocuments[0].title).toBe("example.com")
  })

  it("treats NaN limits as the minimum", async () => {
    mockedWebSearch.mockResolvedValue([])
    const result = await collectWebResearch({
      text: "搜索",
      searchApiConfig: {} as never,
      maxSearchResults: Number.NaN,
      maxImportedDocuments: Number.NaN,
    })
    expect(mockedWebSearch).toHaveBeenCalledWith("搜索", {}, 1)
    expect(result.searchResults).toEqual([])
  })

  it("tolerates invalid urls in context source fallback", () => {
    const context = buildWebResearchContext({
      query: "q",
      searchResults: [{ title: "bad", url: "not-a-url", source: "", snippet: "s" }],
      importedDocuments: [],
      failedUrls: [],
    })
    expect(context.markdown).toContain("not-a-url")
  })

  it("deduplicates source strings in context sources", () => {
    const context = buildWebResearchContext({
      query: "q",
      searchResults: [
        { title: "a", url: "https://a.com/x", source: "a.com", snippet: "s" },
        { title: "a", url: "https://a.com/x", source: "a.com", snippet: "s" },
      ],
      importedDocuments: [],
      failedUrls: [],
    })
    expect(context.sources).toEqual(["a - https://a.com/x"])
  })

  it("falls back to the raw url when hostname parsing fails", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("<p>正文</p>"))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "https://example.com/odd",
      searchApiConfig: {} as never,
    })
    expect(result.importedDocuments[0].source).toBe("example.com")
    expect(result.importedDocuments[0].title).toBe("example.com")
  })

  it("uses the raw url when the hostname cannot be parsed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("<p>正文</p>"))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "http://?",
      searchApiConfig: {} as never,
    })
    expect(result.importedDocuments).toHaveLength(1)
    expect(result.importedDocuments[0].title).toBe("http://")
  })

  it("caps imported documents at the clamped limit", async () => {
    mockedWebSearch.mockResolvedValue([
      { title: "a", url: "https://a.com/1", source: "a.com", snippet: "x" },
      { title: "b", url: "https://b.com/2", source: "b.com", snippet: "y" },
      { title: "c", url: "https://c.com/3", source: "c.com", snippet: "z" },
    ])
    const fetchMock = vi.fn(async (url: string) => jsonResponse(`<p>content ${url}</p>`))
    mockedGetHttpFetch.mockResolvedValue(fetchMock as unknown as typeof fetch)

    const result = await collectWebResearch({
      text: "搜索",
      searchApiConfig: {} as never,
      maxImportedDocuments: 1,
    })
    expect(result.importedDocuments).toHaveLength(1)
  })
})
