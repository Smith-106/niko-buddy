import { describe, expect, it } from "vitest"
import {
  getCustomCompatibleHeaders,
  getProviderConfig,
  withCustomOriginHeader,
  buildAnthropicUrl,
  parseGoogleLine,
  extractGoogleUsage,
} from "./llm-providers"
import type { LlmConfig, ReasoningMode } from "@/stores/wiki-store"

function customConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "custom",
    apiKey: "sk-test",
    model: "gpt-5.4",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 204800,
    apiMode: "chat_completions",
    reasoning: { mode: "auto" },
    ...overrides,
  }
}

function requestBody(config: LlmConfig): Record<string, unknown> {
  return getProviderConfig(config).buildBody([
    { role: "user", content: "请回答。" },
  ]) as Record<string, unknown>
}

describe("llm provider reasoning options", () => {
  it("sends reasoning_effort for explicit custom OpenAI-compatible reasoning mode", () => {
    const body = requestBody(customConfig({ reasoning: { mode: "high" } }))

    expect(body.reasoning_effort).toBe("high")
  })

  it("enables Qwen3 thinking when explicit reasoning is enabled", () => {
    const body = requestBody(customConfig({
      model: "qwen3-235b-a22b",
      reasoning: { mode: "high" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(body.reasoning_effort).toBe("high")
  })

  it("keeps Qwen3 thinking disabled when reasoning is off", () => {
    const body = requestBody(customConfig({
      model: "qwen3-235b-a22b",
      reasoning: { mode: "off" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it.each<ReasoningMode>(["max", "custom"])("maps Responses API %s reasoning to high effort", (mode) => {
    const body = requestBody(customConfig({
      apiMode: "responses",
      customEndpoint: "https://example.test/v1",
      reasoning: mode === "custom" ? { mode, budgetTokens: 12000 } : { mode },
    }))

    expect(body.reasoning).toEqual({ effort: "high" })
  })
})

describe("custom provider headers", () => {
  it("clears Origin for remote custom gateways", () => {
    expect(getCustomCompatibleHeaders("sk-test", "https://example.test/v1/chat/completions")).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("keeps localhost Origin only for local endpoints", () => {
    expect(getCustomCompatibleHeaders("", "http://localhost:11434/v1/chat/completions")).toMatchObject({
      Origin: "http://localhost",
    })
  })

  it("preserves existing auth headers when clearing Origin", () => {
    expect(withCustomOriginHeader({ "x-api-key": "sk-test" }, "https://example.test/v1/messages")).toEqual({
      "x-api-key": "sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom OpenAI-compatible chat requests", () => {
    expect(getProviderConfig(customConfig()).headers).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom Responses API requests", () => {
    expect(getProviderConfig(customConfig({ apiMode: "responses" })).headers).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom Anthropic-compatible requests", () => {
    expect(getProviderConfig(customConfig({ apiMode: "anthropic_messages" })).headers).toMatchObject({
      "x-api-key": "sk-test",
      Origin: "",
    })
  })
})

describe("prompt caching cache_control breakpoints", () => {
  const cachedMessage = [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "STABLE_PREFIX", cacheControl: true },
      { type: "text" as const, text: "STAGE_SPECIFIC" },
    ],
  }]

  it("emits Anthropic cache_control on the flagged prefix block and leaves the rest plain", () => {
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody(cachedMessage) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    expect(messages[0].content).toEqual([
      { type: "text", text: "STABLE_PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "STAGE_SPECIFIC" },
    ])
  })

  it("collapses the same blocks to a byte-identical string for OpenAI-compatible wires (cache marker ignored)", () => {
    const body = getProviderConfig(customConfig({ apiMode: "chat_completions" }))
      .buildBody(cachedMessage) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    // OpenAI/DeepSeek 走自动前缀缓存：纯文本块折叠回与原字符串逐字节一致的内容。
    expect(messages[0].content).toBe("STABLE_PREFIXSTAGE_SPECIFIC")
  })

  it("keeps the legacy string-collapse path when no block is flagged for caching", () => {
    const plainBlocks = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "A" },
        { type: "text" as const, text: "B" },
      ],
    }]
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody(plainBlocks) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    expect(messages[0].content).toBe("AB")
  })
})

// ISS-20260719-002: token usage extraction — the option-A short-circuit
// decision data channel. Each provider surfaces usage in different SSE event
// types; extractUsage must return the counts from those specific events and
// null for the common no-usage line (the streamChat loop probes every line).
describe("ISS-20260719-002 extractUsage token data channel", () => {
  it("anthropic: extracts input from message_start, output from message_delta", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk-anthropic" })
    const start = cfg.extractUsage!(
      `data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":800}}}`,
    ) as { input: number; output: number }
    expect(start).toEqual({ input: 2000, output: 0 })

    const delta = cfg.extractUsage!(
      `data: {"type":"message_delta","usage":{"output_tokens":450}}`,
    ) as { input: number; output: number }
    expect(delta).toEqual({ input: 0, output: 450 })
  })

  it("anthropic: returns null for content_block_delta (the common streaming line)", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk-anthropic" })
    expect(cfg.extractUsage!(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`)).toBeNull()
    expect(cfg.extractUsage!(`not a data line`)).toBeNull()
  })

  it("openai: extracts usage from the final chunk (prompt/completion_tokens)", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "openai", apiKey: "sk-openai" })
    const usage = cfg.extractUsage!(
      `data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":150,"total_tokens":450}}`,
    )
    expect(usage).toEqual({ input: 300, output: 150 })
  })

  it("openai: returns null for delta chunks and [DONE]", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "openai", apiKey: "sk-openai" })
    expect(cfg.extractUsage!(`data: {"choices":[{"delta":{"content":"hi"}}]}`)).toBeNull()
    expect(cfg.extractUsage!(`data: [DONE]`)).toBeNull()
  })

  it("google: extracts usageMetadata (thoughts folded into output)", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google" })
    const usage = cfg.extractUsage!(
      `data: {"candidates":[],"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":200,"thoughtsTokenCount":80}}`,
    )
    expect(usage).toEqual({ input: 500, output: 280 })
  })

  it("custom responses: extracts from response.completed event", () => {
    const cfg = getProviderConfig(customConfig({ apiMode: "responses" }))
    const usage = cfg.extractUsage!(
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":700,"output_tokens":220}}}`,
    )
    expect(usage).toEqual({ input: 700, output: 220 })
  })

  it("custom chat_completions: routes to openai usage extractor", () => {
    const cfg = getProviderConfig(customConfig({ apiMode: "chat_completions" }))
    const usage = cfg.extractUsage!(
      `data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":17}}`,
    )
    expect(usage).toEqual({ input: 42, output: 17 })
  })

  it("best-effort: malformed JSON returns null, never throws", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk-anthropic" })
    expect(() => cfg.extractUsage!(`data: {broken`)).not.toThrow()
    expect(cfg.extractUsage!(`data: {broken`)).toBeNull()
  })
})

// ── L3 全口径 100% 覆盖补齐：线路解析 / 端构造 / 适配器 / provider 全分支 ────────

describe("line parsers: openai / responses / anthropic / google", () => {
  const openai = getProviderConfig({ ...customConfig(), provider: "openai", apiKey: "sk-openai" })
  const responses = getProviderConfig(customConfig({ apiMode: "responses" }))
  const anthropic = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk-anthropic" })
  getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google" })

  it("openai: delta content, no-content, non-data, [DONE], malformed", () => {
    expect(openai.parseStream(`data: {"choices":[{"delta":{"content":"hi"}}]}`)).toBe("hi")
    expect(openai.parseStream(`data: {"choices":[{"delta":{}}]}`)).toBeNull()
    expect(openai.parseStream(`not a data line`)).toBeNull()
    expect(openai.parseStream(`data: [DONE]`)).toBeNull()
    expect(openai.parseStream(`data: {broken`)).toBeNull()
    expect(openai.extractUsage!(`data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`)).toEqual({ input: 3, output: 1 })
    expect(openai.extractUsage!(`data: {"choices":[],"usage":{"completion_tokens":1}}`)).toEqual({ input: 0, output: 1 })
    expect(openai.extractUsage!(`data: {"choices":[],"usage":{"prompt_tokens":2}}`)).toEqual({ input: 2, output: 0 })
    expect(openai.extractUsage!(`data: {"choices":[]}`)).toBeNull()
    expect(openai.extractUsage!(`raw line`)).toBeNull()
    expect(openai.extractUsage!(`data: {broken`)).toBeNull()
  })

  it("responses: output_text.delta, other types, usage completion event", () => {
    expect(responses.parseStream(`data: {"type":"response.output_text.delta","delta":"hi"}`)).toBe("hi")
    expect(responses.parseStream(`data: {"type":"response.output_text.delta"}`)).toBeNull()
    expect(responses.parseStream(`data: {"type":"response.output_text.done","text":"hi"}`)).toBeNull()
    expect(responses.parseStream(`data: [DONE]`)).toBeNull()
    expect(responses.parseStream(`data: {broken`)).toBeNull()
    expect(responses.parseStream(`raw line`)).toBeNull()
    expect(responses.extractUsage!(`data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}`)).toEqual({ input: 7, output: 2 })
    expect(responses.extractUsage!(`data: {"type":"response.completed","response":{"usage":{"output_tokens":2}}}`)).toEqual({ input: 0, output: 2 })
    expect(responses.extractUsage!(`data: {"type":"response.completed","response":{"usage":{"input_tokens":7}}}`)).toEqual({ input: 7, output: 0 })
    expect(responses.extractUsage!(`data: {"type":"response.output_text.delta","delta":"x"}`)).toBeNull()
    expect(responses.extractUsage!(`data: {broken`)).toBeNull()
    expect(responses.extractUsage!(`raw line`)).toBeNull()
  })

  it("anthropic: text_delta, non-text event, usage start/delta, malformed", () => {
    expect(anthropic.parseStream(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`)).toBe("hi")
    expect(anthropic.parseStream(`data: {"type":"content_block_delta","delta":{"type":"text_delta"}}`)).toBeNull()
    expect(anthropic.parseStream(`data: {"type":"content_block_start","index":0}`)).toBeNull()
    expect(anthropic.parseStream(`not a data line`)).toBeNull()
    expect(anthropic.parseStream(`data: {broken`)).toBeNull()
    expect(anthropic.extractUsage!(
      `data: {"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}`,
    )).toEqual({ input: 6, output: 4 })
    expect(anthropic.extractUsage!(`data: {"type":"message_start","message":{"usage":{"output_tokens":4}}}`)).toEqual({ input: 0, output: 4 })
    expect(anthropic.extractUsage!(`data: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":9}}`)).toEqual({ input: 0, output: 9 })
    expect(anthropic.extractUsage!(`data: {"type":"message_delta","usage":{"input_tokens":0}}`)).toEqual({ input: 0, output: 0 })
    expect(anthropic.extractUsage!(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}`)).toBeNull()
    expect(anthropic.extractUsage!(`data: {broken`)).toBeNull()
  })

  it("google: exported line/usage extractors", () => {
    expect(parseGoogleLine(`data: {"candidates":[{"content":{"parts":[{"text":"hi"},{"text":" there"}]}}]}`)).toBe("hi there")
    expect(parseGoogleLine(`data: {"candidates":[{"content":{"parts":[{"text":"skip","thought":true},{"text":"keep"}]}}]}`)).toBe("keep")
    expect(parseGoogleLine(`data: {"candidates":[{"content":{"parts":[{"text":""},{"text":"x"}]}}]}`)).toBe("x")
    expect(parseGoogleLine(`data: {"candidates":[{"content":{"parts":[{"thought":true}]}}]}`)).toBeNull()
    expect(parseGoogleLine(`data: {"candidates":[{"content":{}}]}`)).toBeNull()
    expect(parseGoogleLine(`data: {broken`)).toBeNull()
    expect(parseGoogleLine(`raw`)).toBeNull()

    expect(extractGoogleUsage(`data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":1}}`)).toEqual({ input: 5, output: 3 })
    expect(extractGoogleUsage(`data: {"usageMetadata":{"promptTokenCount":5}}`)).toEqual({ input: 5, output: 0 })
    expect(extractGoogleUsage(`data: {"usageMetadata":{"thoughtsTokenCount":1}}`)).toEqual({ input: 0, output: 1 })
    expect(extractGoogleUsage(`data: {"candidates":[]}`)).toBeNull()
    expect(extractGoogleUsage(`data: {broken`)).toBeNull()
    expect(extractGoogleUsage(`raw`)).toBeNull()
  })
})

describe("content translation helpers", () => {
  it("toOpenAiContent: string, all-text collapse, mixed image blocks", () => {
    const cfg = getProviderConfig(customConfig())
    const stringBody = cfg.buildBody([{ role: "user", content: "plain" }]) as { messages: Array<{ content: unknown }> }
    expect(stringBody.messages[0]!.content).toBe("plain")

    const allText = cfg.buildBody([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]) as { messages: Array<{ content: unknown }> }
    expect(allText.messages[0]!.content).toBe("ab")

    const mixed = cfg.buildBody([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", mediaType: "image/png", dataBase64: "QQ==" }] }]) as { messages: Array<{ content: Array<{ type: string }> }> }
    expect(mixed.messages[0]!.content).toEqual([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
    ])
  })

  it("toResponsesContent: string, input_text, input_image", () => {
    const cfg = getProviderConfig(customConfig({ apiMode: "responses" }))
    const body = cfg.buildBody([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", mediaType: "image/jpeg", dataBase64: "Yg==" }] }]) as { input: Array<{ content: unknown }> }
    expect(body.input[0]!.content).toEqual([
      { type: "input_text", text: "a" },
      { type: "input_image", image_url: "data:image/jpeg;base64,Yg==" },
    ])
    const str = cfg.buildBody([{ role: "user", content: "plain" }]) as { input: Array<{ content: unknown }> }
    expect(str.input[0]!.content).toBe("plain")
  })

  it("buildResponsesBody folds temperature/top_p/max_tokens/stop + reasoning effort", () => {
    const cfg = getProviderConfig(customConfig({ apiMode: "responses", reasoning: { mode: "high" } }))
    const body = cfg.buildBody([{ role: "user", content: "hi" }], {
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 1200,
      stop: "END",
    }) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.top_p).toBe(0.9)
    expect(body.max_output_tokens).toBe(1200)
    expect(body.stop).toBe("END")
    expect(body.reasoning).toEqual({ effort: "high" })
    // reasoning from config alone (no override)
    const body2 = cfg.buildBody([{ role: "user", content: "hi" }]) as Record<string, unknown>
    expect(body2.reasoning).toEqual({ effort: "high" })
  })

  it("toAnthropicContent: string, cache_control blocks, image source", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk-anthropic" })
    const body = cfg.buildBody([{
      role: "user",
      content: [
        { type: "text", text: "stable", cacheControl: true },
        { type: "text", text: "rest" },
        { type: "image", mediaType: "image/png", dataBase64: "QQ==" },
      ],
    }]) as { messages: Array<{ content: unknown }> }
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "rest" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
    ])
  })

  it("toGoogleParts: text + inline_data", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google" })
    const body = cfg.buildBody([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", mediaType: "image/png", dataBase64: "QQ==" }] }]) as { contents: Array<{ parts: unknown }> }
    expect(body.contents[0]!.parts).toEqual([
      { text: "a" },
      { inline_data: { mime_type: "image/png", data: "QQ==" } },
    ])
  })
})

describe("anthropic url + headers", () => {
  it("buildAnthropicUrl handles /v1/messages, /v1, and bare bases", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1/messages")
    expect(buildAnthropicUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages")
    expect(buildAnthropicUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages")
    expect(buildAnthropicUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1/messages")
  })

  it("uses Bearer auth for bearer-only gateways, x-api-key otherwise", () => {
    const bearer = getProviderConfig({ ...customConfig({ apiMode: "anthropic_messages", customEndpoint: "https://api.minimax.io/anthropic" }), apiKey: "mm" }).headers
    expect(bearer.Authorization).toBe("Bearer mm")
    expect(bearer["x-api-key"]).toBeUndefined()

    const minimaxi = getProviderConfig({ ...customConfig({ apiMode: "anthropic_messages", customEndpoint: "https://api.minimaxi.com/anthropic/v1" }), apiKey: "mm2" }).headers
    expect(minimaxi.Authorization).toBe("Bearer mm2")

    const dashscope = getProviderConfig({ ...customConfig({ apiMode: "anthropic_messages", customEndpoint: "https://coding.dashscope.aliyuncs.com/apps/anthropic" }), apiKey: "ds" }).headers
    expect(dashscope.Authorization).toBe("Bearer ds")

    const plain = getProviderConfig({ ...customConfig({ apiMode: "anthropic_messages" }), apiKey: "sk-anthropic" }).headers
    expect(plain["x-api-key"]).toBe("sk-anthropic")
    expect(plain["anthropic-version"]).toBe("2023-06-01")
    expect(plain["anthropic-dangerous-direct-browser-access"]).toBe("true")
  })
})

describe("openai-compatible body adapters", () => {
  function buildFor(model: string, cfg: Partial<LlmConfig> = {}): Record<string, unknown> {
    return getProviderConfig(customConfig({ model, ...cfg })).buildBody([
      { role: "user", content: "hello" },
    ]) as Record<string, unknown>
  }

  it("deepseek: disables/enables thinking and maps effort", () => {
    expect(buildFor("deepseek-chat", { reasoning: { mode: "off" } }).thinking).toEqual({ type: "disabled" })
    expect(buildFor("deepseek-chat", { reasoning: { mode: "low" } })).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    })
    const auto = buildFor("deepseek-chat", { reasoning: { mode: "auto" } })
    expect(auto.thinking).toBeUndefined()
    expect(auto.reasoning_effort).toBeUndefined()
    // endpoint-based detection
    const endpointDeepseek = getProviderConfig(customConfig({ model: "v3", customEndpoint: "https://api.deepseek.com/v1" })).buildBody([{ role: "user", content: "x" }], { reasoning: { mode: "off" } }) as Record<string, unknown>
    expect(endpointDeepseek.thinking).toEqual({ type: "disabled" })
  })

  it("deepseek: enables thinking but skips effort when the mode maps to null", () => {
    // A mode outside the low/medium/high/max/custom set makes
    // reasoningEffort return null, so `if (effort)` takes its false path:
    // thinking is enabled but no reasoning_effort is attached.
    const body = buildFor("deepseek-chat", { reasoning: { mode: "minimal" as never } })
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("qwen3: enable_thinking flag only", () => {
    expect(buildFor("qwen3-235b", { reasoning: { mode: "off" } }).chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(buildFor("qwen_3-8b", { reasoning: { mode: "high" } }).chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(buildFor("qwen2.5-72b", { reasoning: { mode: "high" } }).chat_template_kwargs).toBeUndefined()
    expect(buildFor("qwen3-235b", { reasoning: { mode: "auto" } }).chat_template_kwargs).toBeUndefined()
  })

  it("effort is only attached for openai/azure/custom providers", () => {
    expect(buildFor("llama3", { reasoning: { mode: "high" } }).reasoning_effort).toBe("high")
    const ollama = getProviderConfig({ ...customConfig(), provider: "ollama", ollamaUrl: "http://localhost:11434", reasoning: { mode: "high" } }).buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(ollama.reasoning_effort).toBeUndefined()
  })

  it("strict completion models: gpt-5 / o-series rewrite the body", () => {
    // azure + gpt5 family
    const azureGpt5 = getProviderConfig(customConfig({ provider: "azure", azureModelFamily: "gpt5", model: "gpt-5.4", customEndpoint: "https://r.openai.azure.com" })).buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(azureGpt5.temperature).toBeUndefined()
    // openai provider + gpt-5 model + max_tokens override
    const openai = getProviderConfig({ ...customConfig(), provider: "openai", model: "gpt-5.4", apiKey: "k" }).buildBody([{ role: "user", content: "x" }], { max_tokens: 500 }) as Record<string, unknown>
    expect(openai.max_completion_tokens).toBe(500)
    expect(openai.max_tokens).toBeUndefined()
    // o-series via custom azure endpoint
    const oCustomAzure = getProviderConfig(customConfig({ model: "o3-mini", customEndpoint: "https://r.openai.azure.com" })).buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(oCustomAzure).not.toHaveProperty("max_tokens")
    // gpt-5 on custom non-azure endpoint: NOT strict
    const customNonAzure = getProviderConfig(customConfig({ model: "gpt-5.4" })).buildBody([{ role: "user", content: "x" }], { max_tokens: 100 }) as Record<string, unknown>
    expect(customNonAzure.max_tokens).toBe(100)
    expect(customNonAzure.max_completion_tokens).toBeUndefined()
    // non-strict model unaffected
    const normal = buildFor("gpt-4o")
    expect(normal.temperature).toBeUndefined()
    expect(normal.max_tokens).toBeUndefined()
  })

  it("kimi: strips temperature but keeps the rest", () => {
    const kimi = getProviderConfig(customConfig({ model: "kimi-k2", reasoning: { mode: "high" } })).buildBody([{ role: "user", content: "x" }], { temperature: 0.3, top_p: 0.9 }) as Record<string, unknown>
    expect(kimi.temperature).toBeUndefined()
    expect(kimi.top_p).toBe(0.9)
    const moonshot = getProviderConfig(customConfig({ model: "moonshot-v1" })).buildBody([{ role: "user", content: "x" }], { temperature: 1 }) as Record<string, unknown>
    expect(moonshot.temperature).toBeUndefined()
    const moonshotEndpoint = getProviderConfig(customConfig({ model: "x", customEndpoint: "https://api.moonshot.cn/v1" })).buildBody([{ role: "user", content: "x" }], { temperature: 1 }) as Record<string, unknown>
    expect(moonshotEndpoint.temperature).toBeUndefined()
  })
})

describe("anthropic body builders", () => {
  function anthropicBody(cfg: Partial<LlmConfig> = {}, overrides?: import("./llm-providers").RequestOverrides, messages: import("./llm-providers").ChatMessage[] = [{ role: "user", content: "hi" }]) {
    return getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "sk", ...cfg }).buildBody(messages, overrides) as Record<string, unknown>
  }

  it("splits system messages out and folds overrides", () => {
    const body = anthropicBody({}, { temperature: 0.5, top_p: 0.8, top_k: 40, max_tokens: 3000, stop: "END" }, [
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])
    expect(body.system).toBe("SYSTEM PROMPT")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }])
    expect(body.max_tokens).toBe(3000)
    expect(body.temperature).toBe(0.5)
    expect(body.top_p).toBe(0.8)
    expect(body.top_k).toBe(40)
    expect(body.stop_sequences).toEqual(["END"])
  })

  it("stop array stays an array; default max_tokens 4096; no system", () => {
    const body = anthropicBody({}, { stop: ["A", "B"] })
    expect(body.stop_sequences).toEqual(["A", "B"])
    expect(body.max_tokens).toBe(4096)
    expect(body.system).toBeUndefined()
  })

  it("system content blocks flatten to string; image block collapses to empty", () => {
    const body = anthropicBody({}, undefined, [{ role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }])
    expect(body.system).toBe("AB")
    const withImage = anthropicBody({}, undefined, [{ role: "system", content: [{ type: "text", text: "A" }, { type: "image", mediaType: "image/png", dataBase64: "QQ==" }] }])
    expect(withImage.system).toBe("A")
  })

  it("reasoning budgets: auto/off skip, low/medium/high/custom apply", () => {
    expect(anthropicBody({ reasoning: { mode: "auto" } }).thinking).toBeUndefined()
    expect(anthropicBody({ reasoning: { mode: "off" } }).thinking).toBeUndefined()

    const low = anthropicBody({ reasoning: { mode: "low" } })
    expect(low.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(low.temperature).toBeUndefined()

    const medium = anthropicBody({ reasoning: { mode: "medium" } })
    expect(medium.thinking).toEqual({ type: "enabled", budget_tokens: 4096 })

    const high = anthropicBody({ reasoning: { mode: "high" } })
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })

    const max = anthropicBody({ reasoning: { mode: "max" } })
    expect(max.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })

    const custom = anthropicBody({ reasoning: { mode: "custom", budgetTokens: 2000 } })
    expect(custom.thinking).toEqual({ type: "enabled", budget_tokens: 2000 })

    const customNoBudget = anthropicBody({ reasoning: { mode: "custom" } })
    expect(customNoBudget.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })

    const tinyBudget = anthropicBody({ reasoning: { mode: "custom", budgetTokens: 500 } })
    expect(tinyBudget.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  it("raises max_tokens when the thinking budget would exceed it", () => {
    const body = anthropicBody({ reasoning: { mode: "low" } }, { max_tokens: 512 })
    expect(body.max_tokens).toBe(1025)
  })
})

describe("google body builder", () => {
  function googleBody(cfg: Partial<LlmConfig> = {}, overrides?: import("./llm-providers").RequestOverrides) {
    return getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google", ...cfg }).buildBody([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ], overrides) as Record<string, unknown>
  }

  it("maps roles, system instruction, and full generation config", () => {
    const body = googleBody({}, { temperature: 0.7, top_p: 0.9, top_k: 20, max_tokens: 1000, stop: ["END", "STOP"] })
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "yo" }] },
    ])
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] })
    expect(body.generationConfig).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 20,
      maxOutputTokens: 1000,
      stopSequences: ["END", "STOP"],
    })
  })

  it("string stop becomes array; thinking budgets per mode", () => {
    const off = googleBody({}, { reasoning: { mode: "off" } })
    expect(off.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } })

    const strStop = googleBody({}, { stop: "END" })
    expect((strStop.generationConfig as { stopSequences?: string[] } | undefined)?.stopSequences).toEqual(["END"])

    const low = googleBody({}, { reasoning: { mode: "low" } })
    expect((low.generationConfig as { thinkingConfig?: { thinkingBudget: number } } | undefined)?.thinkingConfig).toEqual({ thinkingBudget: 1024 })

    const medium = googleBody({}, { reasoning: { mode: "medium" } })
    expect((medium.generationConfig as { thinkingConfig?: { thinkingBudget: number } } | undefined)?.thinkingConfig).toEqual({ thinkingBudget: 4096 })

    const high = googleBody({}, { reasoning: { mode: "high" } })
    expect((high.generationConfig as { thinkingConfig?: { thinkingBudget: number } } | undefined)?.thinkingConfig).toEqual({ thinkingBudget: 8192 })

    const custom = googleBody({}, { reasoning: { mode: "custom", budgetTokens: 3000 } })
    expect((custom.generationConfig as { thinkingConfig?: { thinkingBudget: number } } | undefined)?.thinkingConfig).toEqual({ thinkingBudget: 3000 })

    const notes = googleBody({}, { reasoning: { mode: "auto" } }).generationConfig
    expect(notes).toBeUndefined()
  })

  it("no overrides → no generationConfig; block system content flattens", () => {
    const body = googleBody({})
    expect(body.generationConfig).toBeUndefined()
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] })

    const blockSys = getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google" }).buildBody([
      { role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      { role: "user", content: "hi" },
    ]) as Record<string, unknown>
    expect(blockSys.systemInstruction).toEqual({ parts: [{ text: "AB" }] })

    const blockSysImage = getProviderConfig({ ...customConfig(), provider: "google", apiKey: "sk-google" }).buildBody([
      { role: "system", content: [{ type: "text", text: "A" }, { type: "image", mediaType: "image/png", dataBase64: "QQ==" }] },
      { role: "user", content: "hi" },
    ]) as Record<string, unknown>
    expect(blockSysImage.systemInstruction).toEqual({ parts: [{ text: "A" }] })
  })
})

describe("getProviderConfig provider coverage", () => {
  it("openai provider shape", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "openai", apiKey: "k" })
    expect(cfg.url).toBe("https://api.openai.com/v1/chat/completions")
    expect(cfg.headers.Authorization).toBe("Bearer k")
    const body = cfg.buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(body.model).toBe("gpt-5.4")
  })

  it("anthropic provider shape", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "anthropic", apiKey: "k" })
    expect(cfg.url).toBe("https://api.anthropic.com/v1/messages")
    expect(cfg.headers["x-api-key"]).toBe("k")
  })

  it("google provider URL encodes the model", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "google", apiKey: "k", model: "gemini-2.5 pro" })
    expect(cfg.url).toContain("/models/gemini-2.5%20pro:streamGenerateContent?alt=sse")
    expect(cfg.headers["x-goog-api-key"]).toBe("k")
  })

  it("azure provider URL via buildAzureOpenAiUrl + api-key header", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "azure", apiKey: "k", model: "gpt-4o", customEndpoint: "https://r.openai.azure.com" })
    expect(cfg.url).toContain("https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=")
    expect(cfg.headers["api-key"]).toBe("k")
    const body = cfg.buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(body.model).toBeUndefined()
  })

  it("ollama URL normalization: full path, /v1, and base", () => {
    const a = getProviderConfig({ ...customConfig(), provider: "ollama", ollamaUrl: "http://localhost:11434/v1/chat/completions" })
    expect(a.url).toBe("http://localhost:11434/v1/chat/completions")
    const b = getProviderConfig({ ...customConfig(), provider: "ollama", ollamaUrl: "http://localhost:11434/v1" })
    expect(b.url).toBe("http://localhost:11434/v1/chat/completions")
    const c = getProviderConfig({ ...customConfig(), provider: "ollama", ollamaUrl: "http://localhost:11434/" })
    expect(c.url).toBe("http://localhost:11434/v1/chat/completions")
    expect(c.headers.Origin).toBe("http://localhost")
    const body = c.buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(body.model).toBe("gpt-5.4")
  })

  it("minimax provider routes through anthropic builders", () => {
    const cfg = getProviderConfig({ ...customConfig(), provider: "minimax", apiKey: "k", customEndpoint: "" })
    expect(cfg.url).toBe("https://api.minimax.io/anthropic/v1/messages")
    const body = cfg.buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(body.model).toBe("gpt-5.4")
  })

  it("claude-code / codex-cli providers throw in getProviderConfig", () => {
    expect(() => getProviderConfig({ ...customConfig(), provider: "claude-code" })).toThrow(/subprocess transport/)
    expect(() => getProviderConfig({ ...customConfig(), provider: "codex-cli" })).toThrow(/subprocess transport/)
  })

  it("unknown provider hits the exhaustive default", () => {
    expect(() => getProviderConfig({ ...customConfig(), provider: "bogus" } as unknown as LlmConfig)).toThrow(/Unknown provider/)
  })

  it("custom anthropic_messages + custom responses + azure custom endpoint", () => {
    const anthro = getProviderConfig(customConfig({ apiMode: "anthropic_messages", customEndpoint: "https://gw.example.com/anthropic/v1" }))
    expect(anthro.url).toBe("https://gw.example.com/anthropic/v1/messages")

    const respWithTail = getProviderConfig(customConfig({ apiMode: "responses", customEndpoint: "https://gw.example.com/v1/responses" }))
    expect(respWithTail.url).toBe("https://gw.example.com/v1/responses")
    expect(respWithTail.headers.Authorization).toBe("Bearer sk-test")
    // normalized base still ends in /responses (no protocol → no tail stripping) → used verbatim
    const respKept = getProviderConfig(customConfig({ apiMode: "responses", customEndpoint: "localhost:8080/v1/responses" }))
    expect(respKept.url).toBe("localhost:8080/v1/responses")

    const azureCustom = getProviderConfig(customConfig({ customEndpoint: "https://r.openai.azure.com" }))
    expect(azureCustom.headers["api-key"]).toBe("sk-test")
    expect(azureCustom.headers.Authorization).toBeUndefined()
    // azure endpoint with empty apiKey → no api-key header
    const azureNoKey = getProviderConfig(customConfig({ customEndpoint: "https://r.openai.azure.com", apiKey: "" }))
    expect(azureNoKey.headers["api-key"]).toBeUndefined()
    // non-azure endpoint with empty apiKey → no Authorization header
    const noKey = getProviderConfig(customConfig({ apiKey: "" }))
    expect(noKey.headers.Authorization).toBeUndefined()
    expect(noKey.headers["Content-Type"]).toBe("application/json")
  })

  it("custom chat_completions appends /chat/completions when missing", () => {
    const cfg = getProviderConfig(customConfig({ customEndpoint: "https://gw.example.com/v1" }))
    expect(cfg.url).toBe("https://gw.example.com/v1/chat/completions")
    const tail = getProviderConfig(customConfig({ customEndpoint: "https://gw.example.com/v1/chat/completions" }))
    expect(tail.url).toBe("https://gw.example.com/v1/chat/completions")
    // no protocol → tail not stripped → base used verbatim
    const kept = getProviderConfig(customConfig({ customEndpoint: "localhost:8080/v1/chat/completions" }))
    expect(kept.url).toBe("localhost:8080/v1/chat/completions")
    const body = cfg.buildBody([{ role: "user", content: "x" }]) as Record<string, unknown>
    expect(body.model).toBe("gpt-5.4")
    // apiMode undefined falls back to chat_completions
    const noMode = getProviderConfig(customConfig({ apiMode: undefined }))
    expect(noMode.url).toBe("https://example.test/v1/chat/completions")
  })

  it("effectiveReasoning falls back to auto when neither override nor config set reasoning", () => {
    const body = getProviderConfig(customConfig({ reasoning: undefined })).buildBody([{ role: "user", content: "x" }], { temperature: 0.1 }) as Record<string, unknown>
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.temperature).toBe(0.1)
  })
})

describe("endpoint origin heuristics", () => {
  it("classifies private/local endpoints", () => {
    const local = getCustomCompatibleHeaders("k", "http://localhost:11434/v1")
    expect(local.Origin).toBe("http://localhost")
    const subLocal = getCustomCompatibleHeaders("k", "http://app.localhost/v1")
    expect(subLocal.Origin).toBe("http://localhost")
    const loopback = getCustomCompatibleHeaders("k", "http://127.0.0.1:8080/v1")
    expect(loopback.Origin).toBe("http://localhost")
    const ipv6 = getCustomCompatibleHeaders("k", "http://[::1]:8080/v1")
    expect(ipv6.Origin).toBe("http://localhost")
    const ten = getCustomCompatibleHeaders("k", "http://10.1.2.3/v1")
    expect(ten.Origin).toBe("http://localhost")
    const lan = getCustomCompatibleHeaders("k", "http://192.168.1.10/v1")
    expect(lan.Origin).toBe("http://localhost")
    const docker = getCustomCompatibleHeaders("k", "http://172.20.0.4/v1")
    expect(docker.Origin).toBe("http://localhost")
    const notDocker = getCustomCompatibleHeaders("k", "http://172.15.0.4/v1")
    expect(notDocker.Origin).toBe("")
    const publicHost = getCustomCompatibleHeaders("k", "https://api.example.com/v1")
    expect(publicHost.Origin).toBe("")
  })

  it("falls back to regex when the URL cannot be parsed", () => {
    // URL parse fails (space) → regex fallback against the raw string
    const raw = getCustomCompatibleHeaders("k", "http://localhost:11434 /v1")
    expect(raw.Origin).toBe("http://localhost")
    const noMatch = getCustomCompatibleHeaders("k", "https://api.example.com /v1")
    expect(noMatch.Origin).toBe("")
  })
})
