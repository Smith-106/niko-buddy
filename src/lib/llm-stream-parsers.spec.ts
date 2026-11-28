import { describe, expect, it } from "vitest"
import {
  createResponsesToolDeltaParser,
  extractOpenAiUsage,
  extractResponsesUsage,
  parseAnthropicThinkingDelta,
} from "./llm-stream-parsers"

/**
 * Anthropic 扩展思考块解析。
 *
 * 这块此前零覆盖。它是「开 thinking + 用工具 → 400」这个边界的唯一数据入口：
 * 拿不到 signature 就没法在下一轮回放，拿错了会把整轮请求打挂。
 */
describe("parseAnthropicThinkingDelta", () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}`

  it("content_block_start 的 thinking 块产生 block_start", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ),
    ).toEqual([{ kind: "block_start", index: 0, block: { type: "thinking", thinking: "" } }])
  })

  it("content_block_start 的 redacted_thinking 块带上 data", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "ENCRYPTED" } }),
      ),
    ).toEqual([{ kind: "block_start", index: 1, block: { type: "redacted_thinking", data: "ENCRYPTED" } }])
  })

  it("thinking_delta 产生 text 增量", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先看设定" } }),
      ),
    ).toEqual([{ kind: "text", index: 0, text: "先看设定" }])
  })

  it("signature_delta 产生 signature 增量（回放凭证）", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCkYI" } }),
      ),
    ).toEqual([{ kind: "signature", index: 0, signature: "EqQBCkYI" }])
  })

  it("工具块与文本块的 start 不产生思考增量", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } }),
      ),
    ).toBeNull()
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ),
    ).toBeNull()
  })

  it("input_json_delta 与 text_delta 不误判成思考增量", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } }),
      ),
    ).toBeNull()
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正文" } }),
      ),
    ).toBeNull()
  })

  it("非 data: 行与坏 JSON 都返回 null 而不抛", () => {
    expect(parseAnthropicThinkingDelta("event: ping")).toBeNull()
    expect(parseAnthropicThinkingDelta("data: {not json")).toBeNull()
    expect(parseAnthropicThinkingDelta("")).toBeNull()
  })

  it("message_start / message_delta 不产生思考增量", () => {
    expect(
      parseAnthropicThinkingDelta(sse({ type: "message_start", message: { usage: { input_tokens: 1 } } })),
    ).toBeNull()
    expect(parseAnthropicThinkingDelta(sse({ type: "message_delta", usage: { output_tokens: 5 } }))).toBeNull()
  })
})

describe("responses 工具增量解析的坏 JSON 兜底", () => {
  it("data: 后是非法 JSON → 返回 null 而不抛", () => {
    const parse = createResponsesToolDeltaParser()
    expect(parse("data: {oops")).toBeNull()
    expect(parse("data: [DONE]")).toBeNull()
  })
})

describe("TASK-002: extractOpenAiUsage / extractResponsesUsage 缓存字段回退", () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}`

  it("支持 prompt_tokens_details.cached_tokens", () => {
    expect(
      extractOpenAiUsage(
        sse({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 700 } } }),
      ),
    ).toEqual({ input: 1000, output: 50, cachedInput: 700 })
  })

  it("支持 input_tokens_details.cached_tokens 兼容网关字段", () => {
    expect(
      extractOpenAiUsage(
        sse({ usage: { prompt_tokens: 900, completion_tokens: 40, input_tokens_details: { cached_tokens: 600 } } }),
      ),
    ).toEqual({ input: 900, output: 40, cachedInput: 600 })
  })

  it("支持 DeepSeek prompt_cache_hit_tokens（含 prompt_tokens 缺省时由 hit+miss 兜底）", () => {
    expect(
      extractOpenAiUsage(
        sse({
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 80,
            prompt_cache_hit_tokens: 1024,
            prompt_cache_miss_tokens: 176,
          },
        }),
      ),
    ).toEqual({ input: 1200, output: 80, cachedInput: 1024 })

    expect(
      extractOpenAiUsage(
        sse({
          usage: {
            output_tokens: 30,
            prompt_cache_hit_tokens: 512,
            prompt_cache_miss_tokens: 128,
          },
        }),
      ),
    ).toEqual({ input: 640, output: 30, cachedInput: 512 })
  })

  it("prompt_tokens_details.cached_tokens 为 0 时可回退正数 prompt_cache_hit_tokens；全 0 时省略 cachedInput", () => {
    expect(
      extractOpenAiUsage(
        sse({
          usage: {
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
            prompt_cache_hit_tokens: 256,
          },
        }),
      ),
    ).toEqual({ input: 500, output: 10, cachedInput: 256 })

    expect(
      extractOpenAiUsage(
        sse({
          usage: {
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
            prompt_cache_hit_tokens: 0,
          },
        }),
      ),
    ).toEqual({ input: 500, output: 10 })
  })

  it("extractResponsesUsage 也支持 prompt_cache_hit_tokens 兜底", () => {
    expect(
      extractResponsesUsage(
        sse({
          type: "response.completed",
          response: { usage: { input_tokens: 800, output_tokens: 20, prompt_cache_hit_tokens: 500 } },
        }),
      ),
    ).toEqual({ input: 800, output: 20, cachedInput: 500 })
  })
})
