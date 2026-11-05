import { describe, expect, it } from "vitest"
import {
  createResponsesTextParser,
  createResponsesToolDeltaParser,
  extractResponsesUsage,
  parseAnthropicThinkingDelta,
  parseAnthropicToolDelta,
  parseOpenAiToolDelta,
} from "./llm-stream-parsers"

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}`

/**
 * llm-stream-parsers.ts 分支补测（覆盖率战役第九批）。
 */
describe("llm-stream-parsers branch coverage", () => {
  it("openai tool_delta 无 arguments 时不带该字段（79 假支）", () => {
    const line = sse({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read" } }] } }],
    })
    expect(parseOpenAiToolDelta(line)).toEqual([{ index: 0, id: "c1", name: "read" }])
  })

  it("responses completed 无 output 时走 output_text 兜底（146 右支）", () => {
    const parse = createResponsesTextParser()
    const line = sse({
      type: "response.completed",
      response: { output_text: "全文兜底" },
    })
    expect(parse(line)).toBe("全文兜底")
  })

  it("responses completed 输出项缺 content 走 [] 兜底（147 右支）", () => {
    const parse = createResponsesTextParser()
    const line = sse({
      type: "response.completed",
      response: { output: [{ type: "message" }], output_text: "全文兜底" },
    })
    expect(parse(line)).toBe("全文兜底")
  })

  it("responses completed 非 output_text 块跳过 typeof 检查（147 左假）", () => {
    const parse = createResponsesTextParser()
    const line = sse({
      type: "response.completed",
      response: {
        output: [{ content: [{ type: "text", text: "普通" }] }],
        output_text: "兜底文本",
      },
    })
    expect(parse(line)).toBe("兜底文本")
  })

  it("responses completed 非法 text 块被过滤后走兜底（147 右支）", () => {
    const parse = createResponsesTextParser()
    const line = sse({
      type: "response.completed",
      response: {
        output: [{ content: [{ type: "output_text", text: 123 }] }],
        output_text: "兜底文本",
      },
    })
    expect(parse(line)).toBe("兜底文本")
  })

  it("responses completed 既无 fromOutput 又无 output_text 返回 null（151/153/156 真支）", () => {
    const parse = createResponsesTextParser()
    expect(parse(sse({ type: "response.completed", response: { output: [] } }))).toBeNull()
  })

  it("responses tool parser 非 data 行返回 null（209 真支）", () => {
    const parse = createResponsesToolDeltaParser()
    expect(parse("event: ping")).toBeNull()
    expect(parse("")).toBeNull()
  })

  it("responses added 带 call_id 时 id 取 call_id（248 真支）", () => {
    const parse = createResponsesToolDeltaParser()
    const deltas = parse(
      sse({
        type: "response.output_item.added",
        item: { type: "function_call", id: "item1", call_id: "call1", name: "read" },
      }),
    )
    expect(deltas?.[0]).toMatchObject({ index: 0, id: "call1", name: "read" })
  })

  it("responses added 仅 item.id 时 id 取 item.id（248 内层真支）", () => {
    const parse = createResponsesToolDeltaParser()
    const deltas = parse(
      sse({
        type: "response.output_item.added",
        item: { type: "function_call", id: "item-only", name: "read" },
      }),
    )
    expect(deltas?.[0]).toMatchObject({ index: 0, id: "item-only", name: "read" })
  })

  it("responses added 无 name 时不带 name（249 假支）", () => {
    const parse = createResponsesToolDeltaParser()
    const deltas = parse(
      sse({
        type: "response.output_item.added",
        item: { type: "function_call", id: "item9", call_id: "call9" },
      }),
    )
    expect(deltas?.[0]).toMatchObject({ index: 0, id: "call9" })
    expect(deltas?.[0]).not.toHaveProperty("name")
  })

  it("responses delta 空串返回 null（254 真支）", () => {
    const parse = createResponsesToolDeltaParser()
    expect(
      parse(sse({ type: "response.function_call_arguments.delta", delta: "" })),
    ).toBeNull()
    expect(
      parse(sse({ type: "response.function_call_arguments.delta", delta: 123 })),
    ).toBeNull()
  })

  it("responses done 空 arguments 返回 null（266 真支）", () => {
    const parse = createResponsesToolDeltaParser()
    expect(parse(sse({ type: "response.function_call_arguments.done", arguments: "" }))).toBeNull()
    expect(parse(sse({ type: "response.function_call_arguments.done" }))).toBeNull()
  })

  it("responses usage 带缓存时透出 cachedInput（305 真支）", () => {
    const line = sse({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 800 },
        },
      },
    })
    expect(extractResponsesUsage(line)).toMatchObject({ input: 1000, cachedInput: 800 })
  })

  it("responses usage cached 为 0 时不透出（305 假支）", () => {
    const line = sse({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    })
    const usage = extractResponsesUsage(line)
    expect(usage?.cachedInput).toBeUndefined()
    expect(usage?.input).toBe(1000)
  })

  it("anthropic tool start 缺 index 回 0（393 右支）", () => {
    const line = sse({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "t1", name: "read" },
    })
    expect(parseAnthropicToolDelta(line)).toEqual([
      { index: 0, id: "t1", name: "read", arguments: "" },
    ])
  })

  it("anthropic tool start 无 id 时不带 id（394 右支）", () => {
    const line = sse({
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", name: "read" },
    })
    expect(parseAnthropicToolDelta(line)).toEqual([{ index: 2, name: "read", arguments: "" }])
  })

  it("anthropic tool delta 缺 index 回 0（407 右支）", () => {
    const line = sse({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"a":' },
    })
    expect(parseAnthropicToolDelta(line)).toEqual([{ index: 0, arguments: '{"a":' }])
  })

  it("thinking start 缺 thinking/data 回空串（520/524 右支）", () => {
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 3, content_block: { type: "thinking" } }),
      ),
    ).toEqual([{ kind: "block_start", index: 3, block: { type: "thinking", thinking: "" } }])
    expect(
      parseAnthropicThinkingDelta(
        sse({ type: "content_block_start", index: 4, content_block: { type: "redacted_thinking" } }),
      ),
    ).toEqual([
      { kind: "block_start", index: 4, block: { type: "redacted_thinking", data: "" } },
    ])
  })
})
