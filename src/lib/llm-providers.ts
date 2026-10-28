// Copyright (c) 2024 Niko-hub contributors. MIT License.

import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
} from "@/lib/azure-openai"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"
import { DEFAULT_MAX_CONTEXT_TOKENS } from "./llm-context-limits"
import {
  createResponsesTextParser,
  createResponsesToolDeltaParser,
  extractAnthropicUsage,
  extractOpenAiUsage,
  extractResponsesUsage,
  parseAnthropicLine,
  parseAnthropicThinkingDelta,
  parseAnthropicToolDelta,
  parseGoogleToolDelta,
  parseOpenAiLine,
  parseOpenAiToolDelta,
} from "@/lib/llm-stream-parsers"
import type {
  AnthropicThinkingBlock,
  StreamThinkingDelta,
  StreamToolCallDelta,
  StreamUsage,
} from "@/lib/llm-stream-parsers"
export type {
  AnthropicThinkingBlock,
  StreamThinkingDelta,
  StreamToolCallDelta,
  StreamUsage,
} from "@/lib/llm-stream-parsers"

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
  /**
   * Anthropic 思考块（含 signature），仅用于回放。
   *
   * 开了 thinking 的请求，带 tool_use 的 assistant 回合必须原样带回产生它的
   * 思考块，否则下一次请求 400。非 Anthropic 通道不填这个字段。
   */
  thinking_blocks?: AnthropicThinkingBlock[]
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


interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[], overrides?: RequestOverrides) => unknown
  parseStream: (line: string) => string | null
  extractUsage?: (line: string) => StreamUsage | null
  /**
   * 解析流式行里的工具调用增量。缺省 = 该 provider 不回原生 tool_calls。
   * 不实现则 agent 的按流式工具循环永远收不到工具意图（正文为空即一轮空转）。
   */
  parseToolDelta?: (line: string) => StreamToolCallDelta[] | null
  /**
   * 解析流式行里的思考块增量（仅 Anthropic 系）。缺省 = 该 provider 不回思考块。
   * 不实现则开 thinking 后带 tool_use 的回合拿不到 signature，下一轮请求 400。
   */
  parseThinkingDelta?: (line: string) => StreamThinkingDelta[] | null
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

export function extractGoogleUsage(line: string): StreamUsage | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        thoughtsTokenCount?: number
        /** Gemini 的 promptTokenCount 已包含缓存部分，cached 是子集。 */
        cachedContentTokenCount?: number
      }
    }
    if (parsed.usageMetadata) {
      const cached = parsed.usageMetadata.cachedContentTokenCount
      return {
        input: parsed.usageMetadata.promptTokenCount ?? 0,
        output: (parsed.usageMetadata.candidatesTokenCount ?? 0) + (parsed.usageMetadata.thoughtsTokenCount ?? 0),
        ...(typeof cached === "number" && cached > 0 ? { cachedInput: cached } : {}),
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

/**
 * OpenAI 形状的 tools → Anthropic 形状。
 *   { type:"function", function:{ name, description, parameters } }
 *   → { name, description, input_schema }
 *
 * input_schema 做与 Gemini 同一套清洗：Anthropic 的 input_schema 只接受
 * JSON Schema 的一个子集，$schema / $ref / additionalProperties 等关键字
 * 可能被上游以 400 拒绝。两条工具通道共用一个清洗函数，避免行为分叉。
 */
function toAnthropicTools(tools: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const raw of tools) {
    const t = raw as { type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }
    if (!t?.function?.name) continue
    out.push({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters
        ? sanitizeToolSchema(t.function.parameters)
        : { type: "object", properties: {} },
    })
  }
  return out
}

/**
 * 解析 assistant.tool_calls 的 arguments（JSON 字符串）成 Anthropic 的 input 对象。
 * 参数非法时退回空对象，避免整轮请求 400。
 */
function toAnthropicToolInput(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 把一条 tool 结果消息转成 Anthropic 的 tool_result block。
 * Anthropic 要求 tool_result 放在 **user** 回合里，且用 tool_use_id 关联。
 */
function toAnthropicToolResultBlock(message: ChatMessage): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id ?? "",
    content: typeof message.content === "string" ? message.content : flattenAnthropicSystem(message.content),
  }
}

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
  options?: { includeThinking?: boolean },
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const anthropicTools = overrides?.tools?.length ? toAnthropicTools(overrides.tools) : []

  const conversationMessages: Array<{ role: "user" | "assistant"; content: unknown }> = []
  // 待并入下一条 user 回合的 tool_result blocks（Anthropic 要求它们在 user 回合内）
  let pendingToolResults: Record<string, unknown>[] = []

  for (const message of messages) {
    if (message.role === "system") continue

    // tool 结果 → 收集成 tool_result，等 flush 到 user 回合
    if (message.role === "tool" || message.tool_call_id) {
      pendingToolResults.push(toAnthropicToolResultBlock(message))
      continue
    }

    // 有 tool_result 待合并时，必须先落一个 user 回合承载它们
    if (pendingToolResults.length > 0) {
      const previous = conversationMessages[conversationMessages.length - 1]
      if (previous && previous.role === "user") {
        previous.content = mergeAnthropicContent(previous.content, pendingToolResults)
      } else {
        conversationMessages.push({ role: "user", content: pendingToolResults })
      }
      pendingToolResults = []
    }

    const content = toAnthropicContent(message.content)
    const toolUseBlocks =
      message.role === "assistant" && message.tool_calls?.length
        ? message.tool_calls.map((call) => ({
            type: "tool_use",
            id: call.id ?? `toolu_${call.function.name}`,
            name: call.function.name,
            input: toAnthropicToolInput(call.function.arguments),
          }))
        : []

    const hasContent = !(content === "" || (Array.isArray(content) && content.length === 0))

    const role = message.role === "assistant" ? "assistant" : "user"
    // 开了 thinking 的请求，带 tool_use 的 assistant 回合必须原样带回思考块
    // （含 signature），否则下一次请求 400。思考块必须排在 text / tool_use 之前。
    const thinkingBlocks =
      message.role === "assistant" && options?.includeThinking && message.thinking_blocks?.length
        ? message.thinking_blocks.map((block) =>
            block.type === "redacted_thinking"
              ? { type: "redacted_thinking", data: block.data ?? "" }
              : { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" },
          )
        : []
    if (!hasContent && toolUseBlocks.length === 0 && thinkingBlocks.length === 0) continue

    // assistant 带 tool_use 时必须是块数组（thinking + text + tool_use 可共存）
    const merged: unknown =
      thinkingBlocks.length > 0
        ? [
            ...thinkingBlocks,
            ...(hasContent
              ? Array.isArray(content)
                ? content
                : [{ type: "text", text: content }]
              : []),
            ...toolUseBlocks,
          ]
        : toolUseBlocks.length > 0
          ? [
              ...(hasContent
                ? Array.isArray(content)
                  ? content
                  : [{ type: "text", text: content }]
                : []),
              ...toolUseBlocks,
            ]
          : content

    const previous = conversationMessages[conversationMessages.length - 1]
    // 保持 user/assistant 交替：同角色相邻回合必须合并
    if (previous && previous.role === role) {
      previous.content = mergeAnthropicContent(previous.content, merged)
      continue
    }
    conversationMessages.push({ role, content: merged })
  }

  // 末尾还有未消费的 tool_result（例如最后一条就是工具结果）
  if (pendingToolResults.length > 0) {
    const previous = conversationMessages[conversationMessages.length - 1]
    if (previous && previous.role === "user") {
      previous.content = mergeAnthropicContent(previous.content, pendingToolResults)
    } else {
      conversationMessages.push({ role: "user", content: pendingToolResults })
    }
  }

  const system =
    systemMessages.map((m) => flattenAnthropicSystem(m.content)).join("\n") ||
    undefined

  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: overrides?.max_tokens ?? 4096,
    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
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
  const reasoning = effectiveReasoning(config, overrides)
  const thinkingEnabled = reasoning.mode !== "auto" && reasoning.mode !== "off"
  // 回放思考块必须与「本次真的开 thinking」一致：没开 thinking 却带思考块，
  // 反而会被 Anthropic 拒。
  const body = buildAnthropicBody(messages, overrides, { includeThinking: thinkingEnabled })
  if (!thinkingEnabled) return body

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

/**
 * OpenAI 形状的 tools → Gemini functionDeclarations。
 *   { type:"function", function:{ name, description, parameters } }
 *   → { name, description, parameters }
 *
 * Gemini 要求 parameters 是 OpenAPI 子集；JSON Schema 的 object/properties/required
 * 与之兼容，但不支持 $schema / additionalProperties 等关键字，需剔除。
 */
function toGoogleFunctionDeclarations(tools: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const raw of tools) {
    const t = raw as { type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }
    if (!t?.function?.name) continue
    const params = t.function.parameters
    out.push({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(params ? { parameters: sanitizeToolSchema(params) } : {}),
    })
  }
  return out
}

/**
 * 剔除工具 schema 里各厂商不认的 JSON Schema 关键字（递归）。
 * Anthropic 与 Gemini 都对完整 JSON Schema 有保留，共用一个清洗器。
 */
function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const DROP = new Set(["$schema", "additionalProperties", "$id", "$ref", "definitions", "$defs"])
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== "object") return node
    const src = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(src)) {
      if (DROP.has(key)) continue
      out[key] = walk(value)
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}

/** 解析 assistant.tool_calls 的 arguments 字符串成 Gemini 的 args 对象。 */
function toGoogleArgs(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function buildGoogleBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents: Array<{ role: string; parts: unknown[] }> = []

  for (const m of conversationMessages) {
    // tool 结果 → 单独一个 user 回合，parts 为 functionResponse
    if (m.role === "tool" || m.tool_call_id) {
      let response: Record<string, unknown> = { result: typeof m.content === "string" ? m.content : flattenGoogleSystemParts(m.content) }
      if (typeof m.content === "string") {
        try {
          const parsed = JSON.parse(m.content)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) response = parsed as Record<string, unknown>
        } catch { /* 非 JSON 就当纯文本结果 */ }
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "unknown", response } }],
      })
      continue
    }

    const parts: unknown[] = [...toGoogleParts(m.content)]
    // assistant 的 tool_calls → functionCall parts
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) {
        parts.push({
          functionCall: { name: call.function.name, args: toGoogleArgs(call.function.arguments) },
        })
      }
    }
    if (parts.length === 0) continue
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts })
  }

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

  const googleTools = overrides?.tools?.length
    ? [{ functionDeclarations: toGoogleFunctionDeclarations(overrides.tools) }]
    : []

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(googleTools.length > 0 ? { tools: googleTools } : {}),
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
        parseToolDelta: parseAnthropicToolDelta,
        parseThinkingDelta: parseAnthropicThinkingDelta,
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
        parseToolDelta: parseGoogleToolDelta,
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
        parseToolDelta: parseAnthropicToolDelta,
        parseThinkingDelta: parseAnthropicThinkingDelta,
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
          // 此前漏了这两个：MiniMax 预设走的就是这条分支，
          // 工具注册了却解析不回 tool_use，正是「静默零工具调用」。
          parseToolDelta: parseAnthropicToolDelta,
          parseThinkingDelta: parseAnthropicThinkingDelta,
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
    : DEFAULT_MAX_CONTEXT_TOKENS
}
