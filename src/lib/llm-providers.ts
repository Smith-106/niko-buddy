// Copyright (c) 2024 Niko-hub contributors. MIT License.

import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
} from "@/lib/azure-openai"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"

export type ContentBlock =
  | { type: "text"; text: string; cacheControl?: boolean }
  | { type: "image"; mediaType: string; dataBase64: string }

export interface ChatMessage {
  /**
   * `tool` 是工具结果消息（agent 循环回填）：chat.completions 用 `{role:"tool",tool_call_id}`，
   * Responses 用 `{type:"function_call_output",call_id}`。类型层曾漏这一档，
   * 调用方只能强转绕过——现在如实声明，避免又一处「类型在擒谎」。
   */
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentBlock[]
  /** Optional agent/tool-calling extensions (port of v3 agent chain). */
  tool_calls?: Array<{ id?: string; type?: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  reasoning_content?: string
}

export interface RequestOverrides {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  stop?: string | string[]
  reasoning?: ReasoningConfig
  jsonSchema?: Record<string, unknown>
  /** Optional tool-calling extensions (port of v3 agent chain). */
  tools?: unknown[]
  toolChoice?: unknown
}

/** 流式响应里的原生工具调用增量（与 agent 的 ToolCallDelta 同构）。 */
export interface StreamToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[], overrides?: RequestOverrides) => unknown
  parseStream: (line: string) => string | null
  extractUsage?: (line: string) => { input: number; output: number } | null
  /**
   * 解析流式行里的工具调用增量。缺省 = 该 provider 不回原生 tool_calls。
   * 不实现则 agent 的按流式工具循环永远收不到工具意图（正文为空即一轮空转）。
   */
  parseToolDelta?: (line: string) => StreamToolCallDelta[] | null
}

const JSON_CONTENT_TYPE = "application/json"

function localLlmOriginHeader(): Record<string, string> {
  return { Origin: "http://localhost" }
}

function isLocalOrPrivateHttpEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint)
    const host = parsed.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".localhost")) return true
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]") return true
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    const match = host.match(/^172\.(\d+)\./)
    if (match) {
      const second = Number(match[1])
      if (second >= 16 && second <= 31) return true
    }
    return false
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/i.test(endpoint)
  }
}

export function getCustomCompatibleHeaders(apiKey: string, url: string): Record<string, string> {
  return withCustomOriginHeader({
    "Content-Type": JSON_CONTENT_TYPE,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }, url)
}

export function withCustomOriginHeader(headers: Record<string, string>, url: string): Record<string, string> {
  return {
    ...headers,
    ...(isLocalOrPrivateHttpEndpoint(url) ? localLlmOriginHeader() : { Origin: "" }),
  }
}

function parseOpenAiLine(line: string): string | null {
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
function parseOpenAiToolDelta(line: string): StreamToolCallDelta[] | null {
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

function extractOpenAiUsage(line: string): { input: number; output: number } | null {
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
function createResponsesTextParser(): (line: string) => string | null {
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
function createResponsesToolDeltaParser(): (line: string) => StreamToolCallDelta[] | null {
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

function extractResponsesUsage(line: string): { input: number; output: number } | null {
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

function parseAnthropicLine(line: string): string | null {
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

function extractAnthropicUsage(line: string): { input: number; output: number } | null {
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

export function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string; thought?: boolean }> }
      }>
    }
    const parts = parsed.candidates?.[0]?.content?.parts
    if (!parts || parts.length === 0) return null
    let out = ""
    for (const p of parts) {
      if (p.thought) continue
      if (p.text) out += p.text
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export function extractGoogleUsage(line: string): { input: number; output: number } | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        thoughtsTokenCount?: number
      }
    }
    if (parsed.usageMetadata) {
      return {
        input: parsed.usageMetadata.promptTokenCount ?? 0,
        output: (parsed.usageMetadata.candidatesTokenCount ?? 0) + (parsed.usageMetadata.thoughtsTokenCount ?? 0),
      }
    }
    return null
  } catch {
    return null
  }
}

function toOpenAiContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("") /* v8 ignore start */ /* v8 ignore stop */
  }
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text }
    return {
      type: "image_url",
      image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` },
    }
  })
}

function buildOpenAiBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const translated = messages.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
    // 工具往返必需的三个 wire 字段。此前只发 role+content，于是 chat 路径下
    // 多轮工具结果会变成没有 `tool_call_id` 的 `role:"tool"` —— 上游直接 400。
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls && m.tool_calls.length > 0
      ? {
          tool_calls: m.tool_calls.map((call) => ({
            ...(call.id ? { id: call.id } : {}),
            type: call.type ?? "function",
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        }
      : {}),
  }))
  const body: Record<string, unknown> = {
    messages: translated,
    stream: true,
    ...stripWireAgnosticOverrides(overrides),
  }
  // 类型层用 camelCase `toolChoice`，wire 契约是 `tool_choice`；此处做唯一映射，
  // 避免把 `toolChoice` 当未知字段交给上游（网关静默忽略 → 工具选择策略失效）。
  if (overrides?.toolChoice !== undefined) {
    body.tool_choice = overrides.toolChoice
    delete body.toolChoice
  }
  return body
}

function toResponsesContent(content: string | ContentBlock[], assistant = false): unknown {
  // assistant 历史内容只接受 output_text（input_text 会被拒），其余角色用 input_text
  const textType = assistant ? "output_text" : "input_text"
  if (typeof content === "string") return content
  return content.map((block) => {
    if (block.type === "text") {
      return { type: textType, text: block.text }
    }
    return {
      type: "input_image",
      image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
    }
  })
}

/**
 * chat 形状的 tool_choice 对象 → Responses 扁平形状。
 * chat:       `{ type:"function", function:{ name } }`
 * responses:  `{ type:"function", name }`
 * 字符串（auto / none / required）两边同形，原样透传。
 */
function toResponsesToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return choice
  const nested = (choice as { function?: { name?: string } }).function
  if (nested && typeof nested.name === "string" && nested.name.length > 0) {
    return { type: "function", name: nested.name }
  }
  return choice
}

/**
 * agent 的 OpenAI function 定义 → Responses API 的扁平 function 工具形状。
 *
 * chat.completions: `{ type:"function", function:{ name, description, parameters } }`
 * responses:       `{ type:"function", name, description, parameters }`
 * 两者不可互换；直接透传 chat 形状会被 Responses 端点判为非法 schema。
 */
function toResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool
    const raw = tool as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }
    if (raw.type !== "function" || !raw.function) return tool
    const { name, description, parameters } = raw.function
    return {
      type: "function",
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      parameters: parameters ?? { type: "object", properties: {} },
    }
  })
}

/**
 * 历史消息 → Responses API `input` 条目。
 *
 * 工具调用的两段式往返必须用 Responses 专有条目表达，否则整轮请求 400：
 *   assistant + tool_calls → `{ type:"function_call", call_id, name, arguments }`
 *   role:"tool"          → `{ type:"function_call_output", call_id, output }`
 */
function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = []
  // 只有真正发出过 function_call 的 call_id 才能接收 function_call_output，
  // 否则会留下孤儿 output（上游 400）。同理不允许用函数名冒充 call_id。
  const emittedCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
      if (text.trim().length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        })
      }
      for (const call of message.tool_calls) {
        if (!call.id) continue
        emittedCallIds.add(call.id)
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
      continue
    }
    if (message.role === "tool" || message.tool_call_id) {
      const callId = message.tool_call_id
      if (!callId || !emittedCallIds.has(callId)) continue
      const output = typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
      items.push({
        type: "function_call_output",
        call_id: callId,
        output,
      })
      continue
    }
    items.push({
      role: message.role,
      content: toResponsesContent(message.content, message.role === "assistant"),
    })
  }
  return items
}

function buildResponsesBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    input: toResponsesInput(messages),
    stream: true,
  }

  if (overrides?.temperature !== undefined) body.temperature = overrides.temperature
  if (overrides?.top_p !== undefined) body.top_p = overrides.top_p
  if (overrides?.max_tokens !== undefined) body.max_output_tokens = overrides.max_tokens
  if (overrides?.stop !== undefined) body.stop = overrides.stop

  if (overrides?.tools && overrides.tools.length > 0) {
    body.tools = toResponsesTools(overrides.tools)
    if (overrides.toolChoice !== undefined) body.tool_choice = toResponsesToolChoice(overrides.toolChoice)
  }

  const reasoning = effectiveReasoning(config, overrides)
  const effort = reasoningEffort(reasoning)
  if (effort) {
    body.reasoning = { effort }
  }

  return body
}

function stripWireAgnosticOverrides(overrides?: RequestOverrides): Omit<RequestOverrides, "reasoning"> {
  const { reasoning: _reasoning, ...rest } = overrides ?? {}
  return rest
}

function effectiveReasoning(config: LlmConfig, overrides?: RequestOverrides): ReasoningConfig {
  return overrides?.reasoning ?? config.reasoning ?? { mode: "auto" }
}

function reasoningEffort(reasoning: ReasoningConfig): "low" | "medium" | "high" | null {
  if (reasoning.mode === "low" || reasoning.mode === "medium" || reasoning.mode === "high") {
    return reasoning.mode
  }
  if (reasoning.mode === "max" || reasoning.mode === "custom") {
    return "high"
  }
  return null
}

function isDeepSeekEndpoint(config: LlmConfig): boolean {
  return /deepseek/i.test(config.model) || /deepseek/i.test(config.customEndpoint)
}

function isQwenThinkingModel(model: string): boolean {
  return /qwen[-_]?3/i.test(model)
}

function isGlmThinkingModel(model: string): boolean {
  return /glm[-_.]?\d/i.test(model)
}

// GLM 系思考 tokens 不随流式 content 下发，小上限会被思考吃光：正文与结构化 JSON 一并被截断。
// 实测（全文窗 prompt）：max_tokens=2000 → finish_reason=length 且流式 content 0 字节；
// max_tokens=6000 → finish_reason=stop 且 score 可解析。
const GLM_MIN_MAX_TOKENS = 6000

function isKimiEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])kimi([/:.-]|$)/i.test(config.model)
    || /moonshot/i.test(config.model)
    || /api\.moonshot\.(ai|cn)/i.test(config.customEndpoint)
}

function isOpenAiStrictCompletionModel(config: LlmConfig): boolean {
  if ((config.provider === "azure" || (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    && config.azureModelFamily === "gpt5") {
    return true
  }

  const model = config.model.trim().toLowerCase()
  const strictModel = /^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model)
  if (!strictModel) return false
  if (config.provider === "openai" || config.provider === "azure") return true
  return config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)
}

function adaptOpenAiStrictCompletionBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isOpenAiStrictCompletionModel(config)) return

  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  delete body.temperature
  delete body.top_p
  delete body.top_k
}

function adaptKimiBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isKimiEndpoint(config)) return
  delete body.temperature
}

function buildOpenAiCompatibleBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const reasoning = effectiveReasoning(config, overrides)
  const body: Record<string, unknown> = buildOpenAiBody(messages, stripWireAgnosticOverrides(overrides))
  adaptOpenAiStrictCompletionBody(config, body)
  adaptKimiBody(config, body)

  if (isDeepSeekEndpoint(config)) {
    if (reasoning.mode === "off") {
      body.thinking = { type: "disabled" }
    } else if (reasoning.mode !== "auto") {
      body.thinking = { type: "enabled" }
      const effort = reasoningEffort(reasoning)
      if (effort) {
        body.reasoning_effort = effort
      }
    }
    return body
  }

  if (isQwenThinkingModel(config.model)) {
    if (reasoning.mode === "off") {
      body.chat_template_kwargs = { enable_thinking: false }
    } else if (reasoning.mode !== "auto") {
      body.chat_template_kwargs = { enable_thinking: true }
    }
  }

  // GLM 系走顶层 enable_thinking（relay 实测：chat_template_kwargs 与 thinking 均无法关闭其思考）
  if (isGlmThinkingModel(config.model)) {
    if (reasoning.mode === "off") {
      body.enable_thinking = false
    } else if (reasoning.mode !== "auto") {
      body.enable_thinking = true
    }
    if (typeof body.max_tokens === "number" && body.max_tokens < GLM_MIN_MAX_TOKENS) {
      body.max_tokens = GLM_MIN_MAX_TOKENS
    }
  }

  const effort = reasoningEffort(reasoning)
  if ((config.provider === "openai" || config.provider === "azure" || config.provider === "custom") && effort) {
    body.reasoning_effort = effort
  }

  return body
}

function toAnthropicContent(content: string | ContentBlock[]): unknown {  if (typeof content === "string") return content
  const hasCacheControl = content.some((b) => b.type === "text" && b.cacheControl)
  if (!hasCacheControl && content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("") /* v8 ignore start */ /* v8 ignore stop */
  }
  return content.map((b) => {
    if (b.type === "text") {
      return b.cacheControl
        ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: b.text }
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

function flattenAnthropicSystem(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
}

/**
 * 合并相邻同角色回合。Anthropic 要求严格交替，块数组不能被当作「已合并」。
 * 两边都是字符串时保持字符串（最紧凑）；否则提升成 text block 再拼。
 */
function mergeAnthropicContent(previous: unknown, next: unknown): unknown {
  if (typeof previous === "string" && typeof next === "string") {
    return `${previous}\n${next}`
  }
  const toBlocks = (value: unknown): unknown[] => {
    if (typeof value === "string") return [{ type: "text", text: value }]
    return Array.isArray(value) ? value : []
  }
  return [...toBlocks(previous), ...toBlocks(next)]
}

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  // Anthropic 通道不转发 tools（apiModeSupportsTools 已在注册层关掉工具），
  // 所以 tool 消息与 assistant.tool_calls 在这里没有任何 wire 表达方式：
  // 全部丢弃。只改名成 user 而不合并相邻回合会得到连续 user / 空 content
  // 的 assistant，两者上游都会拒绝——半转换比不转更危险。
  const conversationMessages: Array<{ role: "user" | "assistant"; content: unknown }> = []
  for (const message of messages) {
    if (message.role === "system" || message.role === "tool" || message.tool_call_id) continue
    const content = toAnthropicContent(message.content)
    if (content === "" || (Array.isArray(content) && content.length === 0)) continue
    const role = message.role === "assistant" ? "assistant" : "user"
    const previous = conversationMessages[conversationMessages.length - 1]
    // 保持 user/assistant 交替：同角色相邻回合必须合并（字符串直接接，
    // 块数组先提升成 text block 再拼——只处理 string 会留下连续 user 而 400）
    if (previous && previous.role === role) {
      previous.content = mergeAnthropicContent(previous.content, content)
      continue
    }
    conversationMessages.push({ role, content })
  }
  const system =
    systemMessages.map((m) => flattenAnthropicSystem(m.content)).join("\n") ||
    undefined

  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: overrides?.max_tokens ?? 4096,
    ...(overrides?.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides?.top_p !== undefined ? { top_p: overrides.top_p } : {}),
    ...(overrides?.top_k !== undefined ? { top_k: overrides.top_k } : {}),
    ...(overrides?.stop !== undefined
      ? { stop_sequences: Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop] }
      : {}),
  }
}

function buildAnthropicBodyWithReasoning(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const body = buildAnthropicBody(messages, overrides)
  const reasoning = effectiveReasoning(config, overrides)
  if (reasoning.mode === "auto" || reasoning.mode === "off") return body

  const budget =
    reasoning.mode === "custom" && reasoning.budgetTokens !== undefined
      ? reasoning.budgetTokens
      : reasoning.mode === "low"
        ? 1024
        : reasoning.mode === "medium"
          ? 4096
        : 8192
  const budgetTokens = Math.max(1024, budget)
  if ((body.max_tokens as number) <= budgetTokens) {
    body.max_tokens = budgetTokens + 1
  }
  body.thinking = { type: "enabled", budget_tokens: budgetTokens }
  delete body.temperature
  delete body.top_p
  delete body.top_k
  return body
}

function requiresBearerAuth(url: string): boolean {
  const normalized = url.toLowerCase().replace(/\/+$/, "")
  return (
    normalized.startsWith("https://api.minimax.io/anthropic") ||
    normalized.startsWith("https://api.minimaxi.com/anthropic") ||
    normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic")
  )
}

export function buildAnthropicUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "")
  if (/\/v\d+\/messages$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function buildAnthropicHeaders(apiKey: string, url: string): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": JSON_CONTENT_TYPE,
  }
  if (requiresBearerAuth(url)) {
    base.Authorization = `Bearer ${apiKey}`
  } else {
    base["x-api-key"] = apiKey
    base["anthropic-version"] = "2023-06-01"
    base["anthropic-dangerous-direct-browser-access"] = "true"
  }
  return base
}

function toGoogleParts(content: string | ContentBlock[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((b) => {
    if (b.type === "text") return { text: b.text }
    return {
      inline_data: {
        mime_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

function flattenGoogleSystemParts(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

function buildGoogleBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: toGoogleParts(m.content),
  }))

  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((m) => ({ text: flattenGoogleSystemParts(m.content) })),
        }
      : undefined

  const generationConfig: Record<string, unknown> = {}
  if (overrides?.temperature !== undefined) generationConfig.temperature = overrides.temperature
  if (overrides?.top_p !== undefined) generationConfig.topP = overrides.top_p
  if (overrides?.top_k !== undefined) generationConfig.topK = overrides.top_k
  if (overrides?.max_tokens !== undefined) generationConfig.maxOutputTokens = overrides.max_tokens
  if (overrides?.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop]
  }
  if (overrides?.reasoning?.mode === "off") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  } else if (overrides?.reasoning && overrides.reasoning.mode !== "auto") {
    const budget =
      overrides.reasoning.mode === "custom" && overrides.reasoning.budgetTokens !== undefined
        ? overrides.reasoning.budgetTokens
        : overrides.reasoning.mode === "low"
          ? 1024
          : overrides.reasoning.mode === "medium"
            ? 4096
            : 8192
    generationConfig.thinkingConfig = { thinkingBudget: budget }
  }

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

export function getProviderConfig(config: LlmConfig): ProviderConfig {
  const { provider, apiKey, model, ollamaUrl, customEndpoint } = config

  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
        extractUsage: extractOpenAiUsage,
        parseToolDelta: parseOpenAiToolDelta,
      }

    case "anthropic": {
      const url = buildAnthropicUrl("https://api.anthropic.com")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
        parseStream: parseAnthropicLine,
        extractUsage: extractAnthropicUsage,
      }
    }

    case "google": {
      const encodedModel = encodeURIComponent(model)
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-goog-api-key": apiKey,
        },
        buildBody: (messages, overrides) => buildGoogleBody(messages, {
          ...(overrides ?? {}),
          reasoning: effectiveReasoning(config, overrides),
        }),
        parseStream: parseGoogleLine,
        extractUsage: extractGoogleUsage,
      }
    }

    case "azure": {
      return {
        url: buildAzureOpenAiUrl(
          customEndpoint,
          model,
          config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
        ),
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "api-key": apiKey,
        },
        buildBody: (messages, overrides) =>
          buildOpenAiCompatibleBody(config, messages, overrides),
        parseStream: parseOpenAiLine,
        extractUsage: extractOpenAiUsage,
        parseToolDelta: parseOpenAiToolDelta,
      }
    }

    case "ollama": {
      let ollamaBase = ollamaUrl.replace(/\/+$/, "")
      if (/\/v1\/chat\/completions$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1\/chat\/completions$/i, "")
      } else if (/\/v1$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1$/i, "")
      }
      return {
        url: `${ollamaBase}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...localLlmOriginHeader(),
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
        extractUsage: extractOpenAiUsage,
        parseToolDelta: parseOpenAiToolDelta,
      }
    }

    case "minimax": {
      const url = buildAnthropicUrl(customEndpoint || "https://api.minimax.io/anthropic")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
        parseStream: parseAnthropicLine,
        extractUsage: extractAnthropicUsage,
      }
    }

    case "claude-code":
    case "codex-cli":
    case "antigravity-cli":
      throw new Error(
        `${provider} provider uses subprocess transport; getProviderConfig should not be called for it`,
      )

    case "cursor-cli": {
      // OpenAI-compatible HTTP via local cursor-api-proxy.
      const endpoint = (customEndpoint || "http://127.0.0.1:8765/v1").replace(/\/+$/, "")
      const base = normalizeEndpoint(endpoint, "chat_completions").normalized.replace(/\/+$/, "")
      const url = /\/chat\/completions$/i.test(base)
        ? base
        : `${base}/chat/completions`
      const key = apiKey.trim() || "unused"
      return {
        url,
        headers: withCustomOriginHeader({
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${key}`,
        }, url),
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
        extractUsage: extractOpenAiUsage,
        parseToolDelta: parseOpenAiToolDelta,
      }
    }

    case "custom": {
      const mode = config.apiMode ?? "chat_completions"
      if (mode === "anthropic_messages") {
        const url = buildAnthropicUrl(customEndpoint)
        return {
          url,
          headers: withCustomOriginHeader(buildAnthropicHeaders(apiKey, url), url),
          buildBody: (messages, overrides) => ({
            ...buildAnthropicBodyWithReasoning(config, messages, overrides),
            model,
          }),
          parseStream: parseAnthropicLine,
          extractUsage: extractAnthropicUsage,
        }
      }
      if (mode === "responses") {
        const base = normalizeEndpoint(customEndpoint, "responses").normalized.replace(/\/+$/, "")
        const url = /\/responses$/i.test(base)
          ? base
          : `${base}/responses`
        return {
          url,
          headers: getCustomCompatibleHeaders(apiKey, url),
          buildBody: (messages, overrides) => buildResponsesBody(config, messages, overrides),
          parseStream: createResponsesTextParser(),
          parseToolDelta: createResponsesToolDeltaParser(),
          extractUsage: extractResponsesUsage,
        }
      }
      const base = normalizeEndpoint(customEndpoint, "chat_completions").normalized.replace(/\/+$/, "")
      const url = isAzureOpenAiEndpoint(base)
        ? buildAzureOpenAiUrl(
            base,
            model,
            config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
          )
        : /\/chat\/completions$/i.test(base)
          ? base
          : `${base}/chat/completions`
      const azure = isAzureOpenAiEndpoint(url)
      return {
        url,
        headers: azure
          ? {
              "Content-Type": JSON_CONTENT_TYPE,
              ...(apiKey ? { "api-key": apiKey } : {}),
            }
          : withCustomOriginHeader({
              "Content-Type": JSON_CONTENT_TYPE,
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            }, url),
        buildBody: (messages, overrides) => {
          const body = buildOpenAiCompatibleBody(config, messages, overrides)
          if (!azure) body.model = model
          return body
        },
        parseStream: parseOpenAiLine,
        extractUsage: extractOpenAiUsage,
        parseToolDelta: parseOpenAiToolDelta,
      }
    }

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}

export interface ToolCall {
  id?: string
  type?: string
  function: { name: string; arguments: string }
}

export function getEffectiveMaxContextSize(config: { maxContextSize?: number }): number {
  return typeof config.maxContextSize === "number" && config.maxContextSize > 0
    ? config.maxContextSize
    : 204_800
}
