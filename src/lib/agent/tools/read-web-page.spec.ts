import { describe, expect, it, vi } from "vitest"
import { createReadWebPageTool } from "./read-web-page"

describe("createReadWebPageTool", () => {
  it("拒绝非 http/https 地址并返回中文错误", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn(),
    })

    const raw = await tool.execute({ url: "file:///C:/secret.txt" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.message).toContain("只支持 http 或 https")
  })

  it("读取 HTML 时移除脚本、样式和标签，并保留标题", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => `
          <html>
            <head><title>黄蓉资料</title><style>.x{color:red}</style></head>
            <body><script>alert(1)</script><h1>黄蓉</h1><p>桃花岛主黄药师之女。</p></body>
          </html>
        `,
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/huang-rong" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("ok")
    expect(result.title).toBe("黄蓉资料")
    expect(result.content).toContain("黄蓉")
    expect(result.content).toContain("桃花岛主黄药师之女。")
    expect(result.content).not.toContain("alert")
    expect(result.content).not.toContain(".x")
  })

  it("正文超过 maxChars 时截断并标记 truncated", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => "一二三四五六七八九十",
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/text", maxChars: 4 })
    const result = JSON.parse(raw)

    expect(result.status).toBe("ok")
    expect(result.content).toBe("一二三四")
    expect(result.truncated).toBe(true)
    expect(result.message).toContain("已截断")
  })
})

describe("createReadWebPageTool 覆盖补齐", () => {
  it("URL 构造失败时同样返回无效地址错误", async () => {
    const tool = createReadWebPageTool({ fetchPage: vi.fn() })

    const raw = await tool.execute({ url: "http://[::1" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.url).toBe("http://[::1")
    expect(result.message).toContain("只支持 http 或 https")
  })

  it("非 200 响应返回 HTTP 状态码错误", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => "text/html" },
        text: async () => "Service Unavailable",
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/down" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.url).toBe("https://example.com/down")
    expect(result.content).toBe("")
    expect(result.truncated).toBe(false)
    expect(result.message).toContain("HTTP 状态码：503")
  })

  it("抓取抛错返回读取失败并携带原因", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockRejectedValue(new Error("boom-conn-UNIQUE")),
    })

    const raw = await tool.execute({ url: "https://example.com/flaky" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.url).toBe("https://example.com/flaky")
    expect(result.content).toBe("")
    expect(result.message).toContain("boom-conn-UNIQUE")
  })

  it("非法 maxChars 回退默认 6000 并截断", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => "文".repeat(7000),
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/long", maxChars: -5 })
    const result = JSON.parse(raw)

    expect(result.status).toBe("ok")
    expect(result.content).toHaveLength(6000)
    expect(result.truncated).toBe(true)
  })

  it("超大 maxChars 按 20000 封顶", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => "文".repeat(21000),
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/huge", maxChars: 999999 })
    const result = JSON.parse(raw)

    expect(result.content).toHaveLength(20000)
    expect(result.truncated).toBe(true)
  })

  it("纯文本无 HTML 标记时标题为空且保留折叠后正文", async () => {
    const tool = createReadWebPageTool({
      fetchPage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "第一段\n\n第二段",
      }),
    })

    const raw = await tool.execute({ url: "https://example.com/plain" })
    const result = JSON.parse(raw)

    expect(result.status).toBe("ok")
    expect(result.title).toBeUndefined()
    expect(result.content).toBe("第一段 第二段")
    expect(result.truncated).toBe(false)
  })
})
