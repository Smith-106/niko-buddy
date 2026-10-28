/**
 * Token 计量与缓存指标的专项测试。
 *
 * 覆盖三块：
 *   1. 校准估算器（token-estimator.ts）—— 分脚本估算、边界、与旧 chars/3 的对比
 *   2. 精确计数请求构造 —— Anthropic / Gemini 的 URL、headers、body 形状
 *   3. 4 个 provider 的缓存字段解析 —— 重点验证「Anthropic 相加 / OpenAI 不相加」
 *      这条厂商差异，搞反会让总量翻倍或漏计
 */
import { describe, expect, it } from "vitest"
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateScaffoldTokens,
  tokensToCharBudget,
  buildAnthropicCountTokensRequest,
  buildGoogleCountTokensRequest,
  parseCountTokensResponse,
  PER_MESSAGE_TOKEN_OVERHEAD,
  IMAGE_BLOCK_TOKEN_ESTIMATE,
} from "./token-estimator"
import {
  extractAnthropicUsage,
  extractOpenAiUsage,
  extractResponsesUsage,
} from "./llm-stream-parsers"
import { extractGoogleUsage } from "./llm-providers"

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`
}

describe("estimateTokens：分脚本校准", () => {
  it("中文按 1 token/字符（旧 chars/3 低估约 2.6 倍）", () => {
    const zh = "身体都是租的，你让我修仙？" // 13 字符
    const oldEstimate = Math.ceil(zh.length / 3) // 5
    const next = estimateTokens(zh)
    expect(next).toBeGreaterThanOrEqual(zh.length)
    // 旧口径低估至少 2 倍
    expect(next).toBeGreaterThanOrEqual(oldEstimate * 2)
  })

  it("英文按约 4 字符/token", () => {
    const en = "The body is rented, and you want me to cultivate immortality?" // 61 字符
    const next = estimateTokens(en)
    // 61 字符 / 4 ≈ 15-16 token，允许标点带来的偏差
    expect(next).toBeGreaterThanOrEqual(12)
    expect(next).toBeLessThanOrEqual(24)
  })

  it("纯 CJK 与纯 ASCII 的比率差异明显（证明分类生效）", () => {
    const cjk = "测".repeat(100)
    const ascii = "a".repeat(100)
    const cjkTokens = estimateTokens(cjk)
    const asciiTokens = estimateTokens(ascii)
    expect(cjkTokens).toBeGreaterThan(asciiTokens * 2)
  })

  it("空字符串返回 0，纯空白返回至少 1", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("   ")).toBeGreaterThanOrEqual(1)
  })

  it("非空文本永不返回 0（避免预算失效）", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1)
    expect(estimateTokens("。")).toBeGreaterThanOrEqual(1)
  })

  it("平假名 / 片假名 / 谚文按 CJK 档", () => {
    expect(estimateTokens("ひらがな")).toBeGreaterThanOrEqual(4)
    expect(estimateTokens("カタカナ")).toBeGreaterThanOrEqual(4)
    expect(estimateTokens("한국어")).toBeGreaterThanOrEqual(3)
  })

  it("emoji 等非 ASCII 非 CJK 字符按标点档（0.5）", () => {
    const emoji = "🚀🚀🚀🚀"
    const t = estimateTokens(emoji)
    // 4 个 emoji（代理对，每个占 2 个 UTF-16 单元）应至少 2 token
    expect(t).toBeGreaterThanOrEqual(2)
  })
})

describe("estimateMessageTokens：消息级估算", () => {
  it("字符串内容 = 固定开销 + 内容 token", () => {
    const t = estimateMessageTokens({ content: "你好世界" })
    expect(t).toBe(PER_MESSAGE_TOKEN_OVERHEAD + estimateTokens("你好世界"))
  })

  it("块数组只累加 text 块，图像块用中性常量", () => {
    const textOnly = estimateMessageTokens({
      content: [{ type: "text", text: "你好" }],
    })
    const withImage = estimateMessageTokens({
      content: [{ type: "text", text: "你好" }, { type: "image", mediaType: "image/png", dataBase64: "xxx" }],
    })
    expect(withImage).toBe(textOnly + IMAGE_BLOCK_TOKEN_ESTIMATE)
  })

  it("工具调用参数计入（多轮工具循环的预算不能漏）", () => {
    const withoutTools = estimateMessageTokens({ content: "查一下" })
    const withTools = estimateMessageTokens({
      content: "查一下",
      tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.md"}' } }],
    })
    expect(withTools).toBeGreaterThan(withoutTools)
  })

  it("推理内容计入", () => {
    const base = estimateMessageTokens({ content: "问" })
    const withReasoning = estimateMessageTokens({ content: "问", reasoning_content: "思考了很久".repeat(5) })
    expect(withReasoning).toBeGreaterThan(base)
  })

  it("estimateMessagesTokens 是逐条之和", () => {
    const messages = [{ content: "一" }, { content: "二" }, { content: "三" }]
    const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
    expect(estimateMessagesTokens(messages)).toBe(sum)
  })

  it("estimateScaffoldTokens 对 null/undefined 返回 0", () => {
    expect(estimateScaffoldTokens(null)).toBe(0)
    expect(estimateScaffoldTokens(undefined)).toBe(0)
    expect(estimateScaffoldTokens({})).toBeGreaterThan(0)
  })
})

describe("tokensToCharBudget：token 预算折算字符预算", () => {
  it("中文的字符预算约等于 token 预算（1 字符 ≈ 1 token）", () => {
    const messages = [{ content: "测".repeat(1000) }]
    const budget = tokensToCharBudget(messages, 500)
    // 中文 1 字符 ≈ 1 token，500 token ≈ 500 字符
    expect(budget).toBeGreaterThan(300)
    expect(budget).toBeLessThan(700)
  })

  it("英文的字符预算明显大于 token 预算（约 4 字符/token）", () => {
    const messages = [{ content: "a".repeat(4000) }]
    const budget = tokensToCharBudget(messages, 500)
    // 英文 4 字符/token，500 token ≈ 2000 字符
    expect(budget).toBeGreaterThan(1000)
  })

  it("非正预算返回 0", () => {
    expect(tokensToCharBudget([{ content: "x" }], 0)).toBe(0)
    expect(tokensToCharBudget([{ content: "x" }], -1)).toBe(0)
    expect(tokensToCharBudget([{ content: "x" }], Number.NaN)).toBe(0)
  })

  it("空内容时退回预算原值（无内容可裁）", () => {
    expect(tokensToCharBudget([], 500)).toBe(500)
  })
})

describe("精确计数请求构造", () => {
  it("Anthropic：URL、headers、body 形状", () => {
    const req = buildAnthropicCountTokensRequest({
      baseUrl: "https://api.anthropic.com/",
      apiKey: "sk-test",
      model: "claude-sonnet-4-5",
      text: "你好",
    })
    expect(req.url).toBe("https://api.anthropic.com/v1/messages/count_tokens")
    expect(req.headers["x-api-key"]).toBe("sk-test")
    expect(req.headers["anthropic-version"]).toBeDefined()
    expect(req.body.model).toBe("claude-sonnet-4-5")
    expect(req.body.messages).toEqual([{ role: "user", content: "你好" }])
  })

  it("Gemini：URL 编码模型名、x-goog-api-key、contents 形状", () => {
    const req = buildGoogleCountTokensRequest({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "g-test",
      model: "gemini-2.5-pro",
      text: "你好",
    })
    expect(req.url).toContain("/v1beta/models/gemini-2.5-pro:countTokens")
    expect(req.headers["x-goog-api-key"]).toBe("g-test")
    expect(req.body.contents).toEqual([{ parts: [{ text: "你好" }] }])
  })

  it("尾部斜杠不会产生双斜杠", () => {
    const req = buildAnthropicCountTokensRequest({
      baseUrl: "https://api.anthropic.com///",
      apiKey: "k",
      model: "m",
      text: "t",
    })
    expect(req.url).toBe("https://api.anthropic.com/v1/messages/count_tokens")
  })

  it("parseCountTokensResponse 认 Anthropic 的 input_tokens 与 Gemini 的 totalTokens", () => {
    expect(parseCountTokensResponse({ input_tokens: 42 })).toBe(42)
    expect(parseCountTokensResponse({ totalTokens: 99 })).toBe(99)
  })

  it("parseCountTokensResponse 对无法识别的载荷返回 null（由调用方回退估算）", () => {
    expect(parseCountTokensResponse(null)).toBeNull()
    expect(parseCountTokensResponse({})).toBeNull()
    expect(parseCountTokensResponse({ other: 1 })).toBeNull()
    expect(parseCountTokensResponse({ input_tokens: Number.NaN })).toBeNull()
  })
})

describe("缓存指标解析：厂商语义差异", () => {
  it("Anthropic：input_tokens 不含缓存，总量需相加，明细单独保留", () => {
    const usage = extractAnthropicUsage(
      sse({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
      }),
    )
    expect(usage).not.toBeNull()
    // 总量 = 100 + 500 + 200
    expect(usage?.input).toBe(800)
    expect(usage?.output).toBe(10)
    expect(usage?.cachedInput).toBe(500)
    expect(usage?.cacheWriteInput).toBe(200)
  })

  it("Anthropic：无缓存时 cachedInput/cacheWriteInput 不出现（不是 0）", () => {
    const usage = extractAnthropicUsage(
      sse({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 10 } } }),
    )
    expect(usage?.input).toBe(100)
    expect(usage?.cachedInput).toBeUndefined()
    expect(usage?.cacheWriteInput).toBeUndefined()
  })

  it("OpenAI chat：prompt_tokens 已含缓存，不能相加", () => {
    const usage = extractOpenAiUsage(
      sse({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
    )
    // 关键：input 仍是 1000，不是 1800
    expect(usage?.input).toBe(1000)
    expect(usage?.output).toBe(50)
    expect(usage?.cachedInput).toBe(800)
  })

  it("OpenAI chat：无缓存明细时不影响 input", () => {
    const usage = extractOpenAiUsage(sse({ usage: { prompt_tokens: 100, completion_tokens: 5 } }))
    expect(usage?.input).toBe(100)
    expect(usage?.cachedInput).toBeUndefined()
  })

  it("Responses：input_tokens 已含缓存，读 input_tokens_details.cached_tokens", () => {
    const usage = extractResponsesUsage(
      sse({
        type: "response.completed",
        response: {
          usage: { input_tokens: 900, output_tokens: 30, input_tokens_details: { cached_tokens: 600 } },
        },
      }),
    )
    expect(usage?.input).toBe(900)
    expect(usage?.output).toBe(30)
    expect(usage?.cachedInput).toBe(600)
  })

  it("Gemini：promptTokenCount 已含缓存，读 cachedContentTokenCount", () => {
    const usage = extractGoogleUsage(
      sse({
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 60,
          cachedContentTokenCount: 1000,
        },
      }),
    )
    expect(usage?.input).toBe(1200)
    // output 含 thoughts
    expect(usage?.output).toBe(100)
    expect(usage?.cachedInput).toBe(1000)
  })

  it("Gemini：无缓存时 cachedInput 不出现", () => {
    const usage = extractGoogleUsage(sse({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } }))
    expect(usage?.cachedInput).toBeUndefined()
  })

  it("三家缓存字段都为 0 时不产生缓存明细（避免报表出现 0 命中噪声）", () => {
    const anthropic = extractAnthropicUsage(
      sse({
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }),
    )
    expect(anthropic?.cachedInput).toBeUndefined()
    expect(anthropic?.cacheWriteInput).toBeUndefined()

    const openai = extractOpenAiUsage(
      sse({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } }),
    )
    expect(openai?.cachedInput).toBeUndefined()
  })
})
