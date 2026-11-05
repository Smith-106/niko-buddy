import { describe, expect, it } from "vitest"
import type { Tool } from "../types"
import { createSummarizeSearchResultsTool } from "./summarize-search-results"

/**
 * summarize-search-results 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：覆盖既有 spec 未走到的条件分支另一侧，每例均断言可观察行为。
 */
describe("summarize-search-results 分支补齐", () => {
  it("空 results 数组 + status ok → 未返回结果摘要", async () => {
    const tool: Tool = createSummarizeSearchResultsTool()
    const raw = await tool.execute({
      results: JSON.stringify({ status: "ok", query: "关雎", results: [] }),
      query: "关雎",
    })
    const result = JSON.parse(raw)
    expect(result.status).toBe("ok")
    expect(result.query).toBe("关雎")
    expect(result.sourceCount).toBe(0)
    expect(result.summary).toContain("未返回结果")
    expect(result.sources).toEqual([])
  })

  it("缺 status/results/query 字段时回落默认值 → error + 未知错误", async () => {
    const tool: Tool = createSummarizeSearchResultsTool()
    const raw = await tool.execute({ results: JSON.stringify({}), query: "外部关键词" })
    const result = JSON.parse(raw)
    expect(result.status).toBe("error")
    expect(result.query).toBe("外部关键词")
    expect(result.sourceCount).toBe(0)
    expect(result.summary).toContain("搜索失败")
    expect(result.summary).toContain("未知错误")
  })

  it("not_configured 无 message 时用默认文案", async () => {
    const tool: Tool = createSummarizeSearchResultsTool()
    const raw = await tool.execute({
      results: JSON.stringify({ status: "not_configured", query: "测试" }),
    })
    const result = JSON.parse(raw)
    expect(result.status).toBe("not_configured")
    expect(result.summary).toContain("当前未配置外部搜索")
  })

  it("缺 source 的结果回退到 URL hostname（去 www 前缀）", async () => {
    const tool: Tool = createSummarizeSearchResultsTool()
    const raw = await tool.execute({
      results: JSON.stringify({
        status: "ok",
        query: "测试",
        results: [
          {
            title: "标题一",
            url: "https://www.example.com/some/page",
            snippet: "第一行  第二行\n第三行",
            source: "",
          },
        ],
      }),
      query: "测试",
    })
    const result = JSON.parse(raw)
    expect(result.status).toBe("ok")
    expect(result.sourceCount).toBe(1)
    expect(result.sources).toEqual(["example.com"])
    // snippet 空白归一化 + 来源行用裸 hostname
    expect(result.summary).toContain("第一行 第二行 第三行")
    // 逐条来源行用裸 hostname（不去 www），来源列表去 www 前缀
    expect(result.summary).toContain("来源：www.example.com")
  })

  it("maxSummaryChars 触发截断并保留截断标记", async () => {
    const tool: Tool = createSummarizeSearchResultsTool()
    const longResults = {
      status: "ok",
      query: "长文本",
      results: Array.from({ length: 12 }, (_, i) => ({
        title: `标题${i}——${"正文".repeat(40)}`,
        url: `https://example.com/p${i}`,
        snippet: `摘要${i}——${"内容".repeat(60)}`,
        source: "example.com",
      })),
    }
    const raw = await tool.execute({
      results: JSON.stringify(longResults),
      query: "长文本",
      maxSummaryChars: 500,
    })
    const result = JSON.parse(raw)
    expect(result.status).toBe("ok")
    expect(result.summary).toContain("已截断")
    expect(result.summary.length).toBeLessThan(700)
  })
})
