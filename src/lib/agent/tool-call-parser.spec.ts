/**
 * tool-call-parser — 流式 tool_calls 累积 + 从模型纯文本里解析 JSON 工具调用。
 * 后者用于 cursor-api-proxy 这类只能把 tools schema 注入 prompt 的桥接层。
 */
import { describe, expect, it } from "vitest"
import { accumulateToolCalls, parseTextToolCalls } from "./tool-call-parser"
import type { ToolCallDelta } from "./types"

const ALLOWED = new Set(["read_file", "write_file", "search"])

describe("accumulateToolCalls", () => {
  it("空数组返回空结果", () => {
    expect(accumulateToolCalls([])).toEqual([])
  })

  it("单条 delta 直接成型", () => {
    const deltas: ToolCallDelta[] = [
      { index: 0, id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
    ]
    expect(accumulateToolCalls(deltas)).toEqual([
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
    ])
  })

  it("同 index 的分片参数按序拼接，id/name 后到覆盖先到", () => {
    const deltas: ToolCallDelta[] = [
      { index: 0, id: "call_1", name: "read_file", arguments: '{"pa' },
      { index: 0, arguments: 'th":' },
      { index: 0, name: "read_file", arguments: '"a"}' },
    ]
    const calls = accumulateToolCalls(deltas)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe("call_1")
    expect(calls[0].function.name).toBe("read_file")
    expect(calls[0].function.arguments).toBe('{"path":"a"}')
  })

  it("不同 index 各自成型且保持首次出现顺序", () => {
    const deltas: ToolCallDelta[] = [
      { index: 2, id: "c2", name: "search", arguments: "{}" },
      { index: 0, id: "c0", name: "read_file", arguments: "{}" },
    ]
    const calls = accumulateToolCalls(deltas)
    expect(calls.map((c) => c.id)).toEqual(["c2", "c0"])
  })

  it("缺 id/name/arguments 的 delta 得到空字段而不是抛错", () => {
    const calls = accumulateToolCalls([{ index: 0 }])
    expect(calls).toEqual([{ id: "", type: "function", function: { name: "", arguments: "" } }])
  })

  it("先出现参数分片、后出现 id 的乱序流也能正确归组", () => {
    const deltas: ToolCallDelta[] = [
      { index: 1, arguments: '{"q":1}' },
      { index: 1, id: "late", name: "search" },
    ]
    const calls = accumulateToolCalls(deltas)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe("late")
    expect(calls[0].function.name).toBe("search")
    expect(calls[0].function.arguments).toBe('{"q":1}')
  })
})

describe("parseTextToolCalls：前置守卫", () => {
  it("空文本原样返回", () => {
    expect(parseTextToolCalls("", ALLOWED)).toEqual({ toolCalls: [], residualText: "" })
  })

  it("只有空白的文本原样返回", () => {
    expect(parseTextToolCalls("   \n\t ", ALLOWED)).toEqual({ toolCalls: [], residualText: "   \n\t " })
  })

  it("允许名单为空时不做任何解析", () => {
    const text = '{"name":"read_file","arguments":{}}'
    expect(parseTextToolCalls(text, new Set())).toEqual({ toolCalls: [], residualText: text })
  })

  it("纯文本没有任何 JSON 时原样返回", () => {
    const text = "这是一段普通回答，没有工具调用。"
    expect(parseTextToolCalls(text, ALLOWED)).toEqual({ toolCalls: [], residualText: text })
  })
})

describe("parseTextToolCalls：代码块围栏", () => {
  it("解析 ```json 围栏内的调用，并清空残留", () => {
    const text = '```json\n{"name":"read_file","arguments":{"path":"a.md"}}\n```'
    const { toolCalls, residualText } = parseTextToolCalls(text, ALLOWED)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe("read_file")
    expect(toolCalls[0].function.arguments).toBe('{"path":"a.md"}')
    expect(residualText).toBe("")
  })

  it("解析无语言标记的 ``` 围栏", () => {
    const text = '```\n{"name":"search","arguments":{"q":"x"}}\n```'
    const { toolCalls } = parseTextToolCalls(text, ALLOWED)
    expect(toolCalls[0].function.name).toBe("search")
  })

  it("围栏内为空时退回其它候选，不误判为空调用", () => {
    const text = '```json\n```\n{"name":"search","arguments":{}}'
    const { toolCalls } = parseTextToolCalls(text, ALLOWED)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe("search")
  })
})

describe("parseTextToolCalls：字段变体", () => {
  const one = (payload: unknown, text?: string) =>
    parseTextToolCalls(text ?? JSON.stringify(payload), ALLOWED).toolCalls

  it("裸对象用 name + arguments", () => {
    expect(one({ name: "read_file", arguments: { path: "a" } })[0].function.arguments).toBe('{"path":"a"}')
  })

  it("name + parameters 变体", () => {
    const calls = one({ name: "read_file", parameters: { path: "b" } })
    expect(calls[0].function.arguments).toBe('{"path":"b"}')
  })

  it("tool + input 变体", () => {
    const calls = one({ tool: "search", input: { q: "x" } })
    expect(calls[0].function.name).toBe("search")
    expect(calls[0].function.arguments).toBe('{"q":"x"}')
  })

  it("tool_name 变体", () => {
    expect(one({ tool_name: "write_file", arguments: {} })[0].function.name).toBe("write_file")
  })

  it("嵌套 function.name / function.arguments", () => {
    const calls = one({ function: { name: "read_file", arguments: { path: "c" } } })
    expect(calls[0].function.name).toBe("read_file")
    expect(calls[0].function.arguments).toBe('{"path":"c"}')
  })

  it("嵌套 function.parameters 变体", () => {
    const calls = one({ function: { name: "search", parameters: { q: "y" } } })
    expect(calls[0].function.arguments).toBe('{"q":"y"}')
  })

  it("name 前后空白被裁掉", () => {
    expect(one({ name: "  search  ", arguments: {} })[0].function.name).toBe("search")
  })

  it("优先取 raw.name 而不是嵌套 function.name", () => {
    const calls = one({ name: "search", function: { name: "read_file" } })
    expect(calls[0].function.name).toBe("search")
  })
})

describe("parseTextToolCalls：容器形态", () => {
  const one = (payload: unknown) => parseTextToolCalls(JSON.stringify(payload), ALLOWED).toolCalls

  it("tool_calls 数组容器", () => {
    const calls = one({ tool_calls: [{ name: "read_file", arguments: {} }, { name: "search", arguments: {} }] })
    expect(calls.map((c) => c.function.name)).toEqual(["read_file", "search"])
  })

  it("tools 数组容器", () => {
    expect(one({ tools: [{ name: "search", arguments: {} }] })[0].function.name).toBe("search")
  })

  it("顶层数组", () => {
    const calls = one([{ name: "read_file", arguments: {} }])
    expect(calls).toHaveLength(1)
  })

  it("数组里混入非对象元素时跳过它们而不是抛错", () => {
    const calls = one([1, "x", null, { name: "search", arguments: {} }])
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe("search")
  })

  it("顶层是标量时没有调用", () => {
    expect(one(42)).toEqual([])
    expect(one(null)).toEqual([])
  })
})

describe("parseTextToolCalls：参数序列化", () => {
  const args = (value: unknown) =>
    parseTextToolCalls(JSON.stringify({ name: "search", arguments: value }), ALLOWED).toolCalls[0]
      ?.function.arguments

  it("对象参数序列化为 JSON 文本", () => {
    expect(args({ q: "x", n: 1 })).toBe('{"q":"x","n":1}')
  })

  it("字符串参数本身是合法 JSON 时原样保留", () => {
    expect(args('{"q":"x"}')).toBe('{"q":"x"}')
  })

  it("字符串参数不是合法 JSON 时再包一层引号，不丢内容", () => {
    expect(args("not json")).toBe('"not json"')
  })

  it("空字符串参数归一为 {}", () => {
    expect(args("")).toBe("{}")
    expect(args("   ")).toBe("{}")
  })

  it("数字/布尔等标量参数归一为 {}", () => {
    expect(args(7)).toBe("{}")
    expect(args(true)).toBe("{}")
  })

  it("参数缺省时归一为 {}", () => {
    expect(args(undefined)).toBe("{}")
  })
})

describe("parseTextToolCalls：id 与白名单", () => {
  it("取 raw.id", () => {
    const calls = parseTextToolCalls(JSON.stringify({ id: "call_x", name: "search", arguments: {} }), ALLOWED)
    expect(calls.toolCalls[0].id).toBe("call_x")
  })

  it("raw.id 为空时退回嵌套 function.id", () => {
    const calls = parseTextToolCalls(
      JSON.stringify({ id: "  ", function: { id: "nested_id", name: "search" } }),
      ALLOWED,
    )
    expect(calls.toolCalls[0].id).toBe("nested_id")
  })

  it("都没有 id 时生成 text_call_<index>_<时间戳> 兜底", () => {
    const calls = parseTextToolCalls(JSON.stringify({ name: "search", arguments: {} }), ALLOWED)
    expect(calls.toolCalls[0].id).toMatch(/^text_call_0_\d+$/)
  })

  it("数组里第 2 个元素的兜底 id 带 index 1", () => {
    const calls = parseTextToolCalls(
      JSON.stringify([{ name: "read_file", arguments: {} }, { name: "search", arguments: {} }]),
      ALLOWED,
    )
    expect(calls.toolCalls[1].id).toMatch(/^text_call_1_\d+$/)
  })

  it("白名单外的工具名被丢弃", () => {
    const text = JSON.stringify({ name: "delete_everything", arguments: {} })
    expect(parseTextToolCalls(text, ALLOWED)).toEqual({ toolCalls: [], residualText: text })
  })

  it("没有可用工具名时丢弃", () => {
    const text = JSON.stringify({ arguments: { a: 1 } })
    expect(parseTextToolCalls(text, ALLOWED)).toEqual({ toolCalls: [], residualText: text })
  })

  it("首个候选不是合法 JSON 时继续试下一个候选", () => {
    // 顶层以 [ 开头 → 整段文本被 unshift 为候选一（非法），候选二才是真正的对象
    const text = '[不是数组] {"name":"search","arguments":{}}'
    const { toolCalls } = parseTextToolCalls(text, ALLOWED)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe("search")
  })

  it("对象切片是贪婪的：前面有游离的 { 时会连内层合法对象一起吞掉，导致解析失败", () => {
    // 刻画现有行为：firstObj..lastObj 一整段才是一个候选，不会退回再试内层
    const text = '坏的：{不是 json} 好的：{"name":"search","arguments":{}}'
    expect(parseTextToolCalls(text, ALLOWED)).toEqual({ toolCalls: [], residualText: text })
  })
})

describe("parseTextToolCalls：残留文本", () => {
  it("剥掉 JSON 后保留前后自然语言", () => {
    const text = '好的，我来读文件。{"name":"read_file","arguments":{"path":"a"}} 完成。'
    const { toolCalls, residualText } = parseTextToolCalls(text, ALLOWED)
    expect(toolCalls).toHaveLength(1)
    expect(residualText).toBe("好的，我来读文件。 完成。")
  })

  it("围栏内 JSON 被剥掉后，空的围栏标记也被清掉", () => {
    const text = '```json\n{"name":"search","arguments":{}}\n```'
    expect(parseTextToolCalls(text, ALLOWED).residualText).toBe("")
  })

  it("纯 JSON 输入解析成功后残留为空串", () => {
    expect(parseTextToolCalls('{"name":"search","arguments":{}}', ALLOWED).residualText).toBe("")
  })

  it("顶层数组形态同样清空残留", () => {
    const text = '[{"name":"search","arguments":{}}]'
    expect(parseTextToolCalls(text, ALLOWED).residualText).toBe("")
  })

  it("围栏里是原始值时视为无可解析工具调用", () => {
    const text = "```json\n42\n```"
    const result = parseTextToolCalls(text, ALLOWED)
    expect(result.toolCalls).toEqual([])
    expect(result.residualText).toBe(text)
  })
})
