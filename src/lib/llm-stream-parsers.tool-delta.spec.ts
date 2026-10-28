/**
 * 新增的两个流式工具调用解析器（P0 修复配套）。
 *
 * 这两个解析器是「工具真能往返」的另一半：body builder 把 tools 声明发出去后，
 * 模型回的 tool_calls 必须能被解析成 agent 认得的增量，否则多轮工具循环照样断。
 */
import { describe, expect, it } from "vitest"
import { parseAnthropicToolDelta, parseGoogleToolDelta } from "./llm-stream-parsers"

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`
}

describe("parseAnthropicToolDelta", () => {
  it("content_block_start 的 tool_use 给出 id 与 name，参数为空串", () => {
    const line = sse({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_abc", name: "read_file" },
    })
    expect(parseAnthropicToolDelta(line)).toEqual([
      { index: 1, id: "toolu_abc", name: "read_file", arguments: "" },
    ])
  })

  it("input_json_delta 按 index 交付参数分片", () => {
    const line = sse({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    })
    expect(parseAnthropicToolDelta(line)).toEqual([{ index: 1, arguments: '{"path":' }])
  })

  it("多片参数按顺序到达（由上层累积拼接）", () => {
    const a = parseAnthropicToolDelta(
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
    )
    const b = parseAnthropicToolDelta(
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.md"}' } }),
    )
    const joined = `${a?.[0]?.arguments ?? ""}${b?.[0]?.arguments ?? ""}`
    expect(joined).toBe('{"path":"a.md"}')
  })

  it("文本 delta 与其它事件返回 null（不干扰正文流）", () => {
    expect(
      parseAnthropicToolDelta(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })),
    ).toBeNull()
    expect(parseAnthropicToolDelta(sse({ type: "message_start" }))).toBeNull()
    expect(parseAnthropicToolDelta(sse({ type: "message_stop" }))).toBeNull()
  })

  it("非 tool_use 的 content_block_start 返回 null", () => {
    expect(
      parseAnthropicToolDelta(
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ),
    ).toBeNull()
  })

  it("缺 name 的 tool_use 返回 null（无法执行）", () => {
    expect(
      parseAnthropicToolDelta(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x" } })),
    ).toBeNull()
  })

  it("非 data: 前缀、非法 JSON 均返回 null，不抛异常", () => {
    expect(parseAnthropicToolDelta("event: content_block_start")).toBeNull()
    expect(parseAnthropicToolDelta("data: {not json")).toBeNull()
    expect(parseAnthropicToolDelta("")).toBeNull()
  })
})

describe("parseGoogleToolDelta", () => {
  it("functionCall 一次给完整 args，序列化成 arguments 字符串", () => {
    const line = sse({
      candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.md" } } }] } }],
    })
    expect(parseGoogleToolDelta(line)).toEqual([
      { index: 0, name: "read_file", arguments: '{"path":"a.md"}' },
    ])
  })

  it("多个 functionCall 用递增 index 区分", () => {
    const line = sse({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "read_file", args: { path: "a.md" } } },
              { functionCall: { name: "write_file", args: { path: "b.md" } } },
            ],
          },
        },
      ],
    })
    const deltas = parseGoogleToolDelta(line)
    expect(deltas).toHaveLength(2)
    expect(deltas?.[0]).toMatchObject({ index: 0, name: "read_file" })
    expect(deltas?.[1]).toMatchObject({ index: 1, name: "write_file" })
  })

  it("args 缺省时给空对象（模型可能不传参）", () => {
    const line = sse({ candidates: [{ content: { parts: [{ functionCall: { name: "list_all" } }] } }] })
    expect(parseGoogleToolDelta(line)).toEqual([{ index: 0, name: "list_all", arguments: "{}" }])
  })

  it("纯文本 parts 返回 null（不干扰正文流）", () => {
    const line = sse({ candidates: [{ content: { parts: [{ text: "你好" }] } }] })
    expect(parseGoogleToolDelta(line)).toBeNull()
  })

  it("无 functionCall 的 parts / 空 candidates 返回 null", () => {
    expect(parseGoogleToolDelta(sse({ candidates: [] }))).toBeNull()
    expect(parseGoogleToolDelta(sse({ candidates: [{ content: {} }] }))).toBeNull()
  })

  it("缺 name 的 functionCall 被跳过", () => {
    const line = sse({ candidates: [{ content: { parts: [{ functionCall: { args: { a: 1 } } }] } }] })
    expect(parseGoogleToolDelta(line)).toBeNull()
  })

  it("非 data: 前缀、[DONE]、非法 JSON 均返回 null", () => {
    expect(parseGoogleToolDelta("event: message")).toBeNull()
    expect(parseGoogleToolDelta("data: [DONE]")).toBeNull()
    expect(parseGoogleToolDelta("data: {bad")).toBeNull()
  })
})
