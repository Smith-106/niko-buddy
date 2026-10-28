// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * llm-stream-parsers.ts — SSE 流式解析内聚块（M10-1 自 llm-providers.ts 剥离）。
 *
 * OpenAI chat.completions / Responses / Anthropic 三条 wire 的文本增量、
 * 工具调用增量与用量解析。纯函数 + 闭包工厂，无外部依赖、无新依赖。
 *
 * @license MIT © Niko Buddy
 */

/** 流式响应里的原生工具调用增量（与 agent 的 ToolCallDelta 同构）。 */
export interface StreamToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices: Array<{ delta: { content?: string } }>
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

/**
 * OpenAI 兼容 chat.completions 的流式 tool_calls 增量。
 * 网关通常把首帧 index/id/name 与后续 arguments 片段分开推，这里原样透传。
 */
export function parseOpenAiToolDelta(line: string): StreamToolCallDelta[] | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index?: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    const raw = parsed.choices?.[0]?.delta?.tool_calls
    if (!raw || raw.length === 0) return null
    return raw.map((call, fallbackIndex) => ({
      index: typeof call.index === "number" ? call.index : fallbackIndex,
      ...(call.id ? { id: call.id } : {}),
      ...(call.function?.name ? { name: call.function.name } : {}),
      ...(typeof call.function?.arguments === "string" ? { arguments: call.function.arguments } : {}),
    }))
  } catch {
    return null
  }
}

export function extractOpenAiUsage(line: string): { input: number; output: number } | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
    if (parsed.usage) {
      return {
        input: parsed.usage.prompt_tokens ?? 0,
        output: parsed.usage.completion_tokens ?? 0,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Responses 文本增量解析器。
 *
 * 必须是「一请求一实例」：`response.completed` 里的最终文本只能在没有收到任何
 * `response.output_text.delta` 时兜底，否则整段正文会被拼第二遍（无状态版本
 * 的注释写着「调用方会忽略重复文本」，但调用方只是逐段拼接，并没有去重）。
 */
export function createResponsesTextParser(): (line: string) => string | null {
  let sawDelta = false
  // 终稿是否已经交出：乱序网关可能先推 completed 再推 delta，那个时候
  // delta 不能再拼（否则调用方拿到「全文 + 增量」）。
  let emittedFinal = false
  return (line: string) => {
    if (!line.startsWith("data: ")) return null
    const data = line.slice(6).trim()
    if (data === "[DONE]") return null
    try {
      const parsed = JSON.parse(data) as {
        type?: string
        delta?: string
        response?: {
          output_text?: string
          output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
        }
      }
      if (parsed.type === "response.output_text.delta") {
        if (emittedFinal) return null
        if (typeof parsed.delta !== "string" || parsed.delta.length === 0) return null
        sawDelta = true
        return parsed.delta
      }
      if (parsed.type === "response.completed") {
        if (sawDelta || emittedFinal) return null
        const fromOutput = (parsed.response?.output ?? [])
          .flatMap((item) => item.content ?? [])
          .filter((block) => block.type === "output_text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("")
        const text = fromOutput.length > 0
          ? fromOutput
          : typeof parsed.response?.output_text === "string"
            ? parsed.response.output_text
            : ""
        if (text.length === 0) return null
        sawDelta = true
        emittedFinal = true
        return text
      }
      return null
    } catch {
      return null
    }
  }
}

/**
 * Responses API 的流式工具调用增量。
 *
 * 事件序列（OpenAI Responses 语义）：
 *   response.output_item.added            → { item: { type:"function_call", id, call_id, name } }
 *   response.function_call_arguments.delta → { item_id, delta }（arguments 分片）
 *   response.function_call_arguments.done  → 完整 arguments（幂等兜底）
 *
 * 与 chat.completions 不同：这里的 index 是「输出条目序号」，而 delta 事件只带
 * `item_id`，所以用 item_id → index 的本地映射表保住同一次工具调用归到同一槽位。
 */
export function createResponsesToolDeltaParser(): (line: string) => StreamToolCallDelta[] | null {
  const itemIndex = new Map<string, number>()
  // 每个槽位三态：无 / 只有分片（sawDelta）/ 已有完整 arguments（haveFull）。
  // 三者互斥地决定 delta 与 done 的取舍。
  const sawDelta = new Set<number>()
  const haveFull = new Set<number>()
  let nextIndex = 0
  // 最近一次 output_item.added 分配的槽位：部分网关的 arguments delta 只带
  // 自己的序号/不重复 item_id，缺失时归到“最新一个尚未结束的调用”比统统
  // 归到 index 0 更接近真实语义（否则第二个调用的参数会污染第一个）。
  let lastIndex = 0
  const indexFor = (itemId: string | undefined, explicit?: number): number => {
    // 已建立的别名不再改挂：一个调用只能属于一个槽位，否则其分片会裂成两截
    const known = itemId ? itemIndex.get(itemId) : undefined
    if (known !== undefined) return known
    // output_index 是官方槽位序号，首次出现时以它为准（并行调用交错时唯一可靠的归并键）
    if (typeof explicit === "number" && explicit >= 0) {
      if (explicit >= nextIndex) nextIndex = explicit + 1
      if (itemId) itemIndex.set(itemId, explicit)
      lastIndex = explicit
      return explicit
    }
    if (!itemId) return lastIndex
    const assigned = nextIndex
    nextIndex += 1
    itemIndex.set(itemId, assigned)
    lastIndex = assigned
    return assigned
  }
  return (line: string) => {
    if (!line.startsWith("data: ")) return null
    const data = line.slice(6).trim()
    if (data === "[DONE]") return null
    try {
      const parsed = JSON.parse(data) as {
        type?: string
        item_id?: string
        output_index?: number
        delta?: string
        arguments?: string
        item?: {
          id?: string
          type?: string
          call_id?: string
          name?: string
          arguments?: string
        }
      }
      if (parsed.type === "response.output_item.added" && parsed.item?.type === "function_call") {
        // item.id 是后续 delta 的关联键；缺失时退回 call_id
        const keys = [parsed.item.id, parsed.item.call_id].filter(
          (key): key is string => typeof key === "string" && key.length > 0,
        )
        // 两个键都没有时也要占一个独立槽位，否则两个匿名调用会共用 lastIndex
        const index = keys.length === 0 && !parsed.output_index
          ? nextIndex++
          : indexFor(keys[0], parsed.output_index)
        lastIndex = index
        // 两个键互为别名：官方 delta 的 item_id 是 item.id，但多数网关同时回传 call_id
        for (const key of keys) itemIndex.set(key, index)
        const fullArguments = typeof parsed.item.arguments === "string" && parsed.item.arguments.length > 0
          ? parsed.item.arguments
          : undefined
        // added 上的 arguments 只是一个**片段**（官方语义下是 ""）：算作已见分片，
        // 不能当成终态 haveFull —— 否则「先给前缀再推增量」的网关会被截断。
        // 它也不会再被 .done 重复拼一遍（done 看到 sawDelta 就丢弃）。
        if (fullArguments !== undefined) sawDelta.add(index)
        return [{
          index,
          ...(parsed.item.call_id ? { id: parsed.item.call_id } : parsed.item.id ? { id: parsed.item.id } : {}),
          ...(parsed.item.name ? { name: parsed.item.name } : {}),
          ...(fullArguments !== undefined ? { arguments: fullArguments } : {}),
        }]
      }
      if (parsed.type === "response.function_call_arguments.delta") {
        if (typeof parsed.delta !== "string" || parsed.delta.length === 0) return null
        const index = indexFor(parsed.item_id, parsed.output_index)
        // 已拿到完整 arguments 后到的分片一律丢弃，否则全量 + 分片会拼成非法 JSON
        if (haveFull.has(index)) return null
        sawDelta.add(index)
        return [{ index, arguments: parsed.delta }]
      }
      if (parsed.type === "response.function_call_arguments.done") {
        // done 给的是完整参数，不是增量：
        //   - 已有完整参数（added 带过）→ 丢弃
        //   - 已有分片 → 丢弃（再追加会重复拼接）
        //   - 只有 done（网关不推分片）→ 当一次全量交出
        if (typeof parsed.arguments !== "string" || parsed.arguments.length === 0) return null
        const index = indexFor(parsed.item_id, parsed.output_index)
        // done 一定意味着该调用的参数已结束：无论本次是否交出内容，都标记终态，
        // 让其后迟到的分片被丢弃（全量 + 分片拼在一起就是非法 JSON）。
        if (haveFull.has(index) || sawDelta.has(index)) {
          haveFull.add(index)
          return null
        }
        haveFull.add(index)
        return [{ index, arguments: parsed.arguments }]
      }
      return null
    } catch {
      return null
    }
  }
}

export function extractResponsesUsage(line: string): { input: number; output: number } | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type?: string
      response?: { usage?: { input_tokens?: number; output_tokens?: number } }
    }
    if (parsed.type === "response.completed" && parsed.response?.usage) {
      return {
        input: parsed.response.usage.input_tokens ?? 0,
        output: parsed.response.usage.output_tokens ?? 0,
      }
    }
    return null
  } catch {
    return null
  }
}

export function parseAnthropicLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type: string
      delta?: { type: string; text?: string }
    }
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta"
    ) {
      return parsed.delta.text ?? null
    }
    return null
  } catch {
    return null
  }
}

export function extractAnthropicUsage(line: string): { input: number; output: number } | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type?: string
      message?: { usage?: Record<string, number> }
      usage?: Record<string, number>
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      return { input, output: u.output_tokens ?? 0 }
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      return { input: parsed.usage.input_tokens ?? 0, output: parsed.usage.output_tokens ?? 0 }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Anthropic Messages 流式工具调用增量解析。
 *
 * 协议（SSE）：
 *   content_block_start  { index, content_block: { type: "tool_use", id, name, input: {} } }
 *   content_block_delta  { index, delta: { type: "input_json_delta", partial_json } }
 *
 * 与 OpenAI 的差别：Anthropic 用 content block 的 `index` 定位工具块，
 * 参数以 partial_json 分片到达，需按 index 累积拼接（由上层负责拼接）。
 * 这里只负责把每个 SSE 行翻译成增量。
 */
export function parseAnthropicToolDelta(line: string): StreamToolCallDelta[] | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; partial_json?: string }
    }

    // 工具块开始：给出 id 与 name，参数为空（后续由 input_json_delta 累积）
    if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
      const block = parsed.content_block
      if (!block.name) return null
      return [{
        index: typeof parsed.index === "number" ? parsed.index : 0,
        ...(block.id ? { id: block.id } : {}),
        name: block.name,
        arguments: "",
      }]
    }

    // 参数分片
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "input_json_delta" &&
      typeof parsed.delta.partial_json === "string"
    ) {
      return [{
        index: typeof parsed.index === "number" ? parsed.index : 0,
        arguments: parsed.delta.partial_json,
      }]
    }

    return null
  } catch {
    return null
  }
}

/**
 * Google Gemini 流式工具调用增量解析。
 *
 * 协议（SSE，streamGenerateContent?alt=sse）：
 *   candidates[0].content.parts[] 中，functionCall 是**完整对象**：
 *     { functionCall: { name, args } }
 *
 * 与 OpenAI/Anthropic 的差别：Gemini 不流式分片参数，一次给完整 args 对象。
 * 所以这里把 args 序列化成一个完整 arguments 字符串，一次交付；
 * 上层按 index 累积时，后到的完整对象会覆盖前面的同名增量。
 * 每次 functionCall 用递增 index 区分（同一条消息里可能有多个）。
 */
export function parseGoogleToolDelta(line: string): StreamToolCallDelta[] | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            functionCall?: { name?: string; args?: Record<string, unknown> }
          }>
        }
      }>
    }
    const parts = parsed.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return null

    const deltas: StreamToolCallDelta[] = []
    for (const part of parts) {
      const fc = part?.functionCall
      if (!fc?.name) continue
      deltas.push({
        index: deltas.length,
        name: fc.name,
        arguments: JSON.stringify(fc.args ?? {}),
      })
    }
    return deltas.length > 0 ? deltas : null
  } catch {
    return null
  }
}
