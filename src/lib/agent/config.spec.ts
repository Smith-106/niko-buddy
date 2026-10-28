/** C4 冒烟覆盖：src/lib/agent/config.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import {
  providerUsesTextToolCalls,
  modelSupportsTools,
  isFunctionCallingEnabled,
  effectiveToolsEnabled,
  buildAgentConfig,
  apiModeSupportsTools,
} from "./config"
import { ToolRegistry } from "./registry"
import type { LlmConfig } from "@/stores/wiki-store"

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "custom",
    apiKey: "k",
    model: "gpt-5.4",
    customEndpoint: "https://example.test/v1",
    ollamaUrl: "",
    maxContextSize: 204800,
    apiMode: "chat_completions",
    ...overrides,
  }
}

describe("config.ts smoke", () => {
  it("exports providerUsesTextToolCalls", () => {
    expect(providerUsesTextToolCalls).toBeDefined()
  })
  it("exports modelSupportsTools", () => {
    expect(modelSupportsTools).toBeDefined()
  })
  it("exports isFunctionCallingEnabled", () => {
    expect(isFunctionCallingEnabled).toBeDefined()
  })
  it("exports effectiveToolsEnabled", () => {
    expect(effectiveToolsEnabled).toBeDefined()
  })
  it("exports buildAgentConfig", () => {
    expect(buildAgentConfig).toBeDefined()
  })
})

describe("apiMode 工具通道断言（P1-1 静默退化防线）", () => {
  it("responses / chat_completions 具备工具通道，anthropic_messages 没有", () => {
    expect(apiModeSupportsTools("chat_completions")).toBe(true)
    expect(apiModeSupportsTools("responses")).toBe(true)
    expect(apiModeSupportsTools(undefined)).toBe(true)
    expect(apiModeSupportsTools("anthropic_messages")).toBe(false)
  })

  it("modelSupportsTools 把 apiMode 纳入判定", () => {
    expect(modelSupportsTools("gpt-5.4", "custom", "responses")).toBe(true)
    expect(modelSupportsTools("gpt-5.4", "custom", "anthropic_messages")).toBe(false)
    // 未传 apiMode 时保持历史行为
    expect(modelSupportsTools("gpt-5.4", "custom")).toBe(true)
  })

  it("effectiveToolsEnabled 对 anthropic_messages 关闭工具", () => {
    expect(effectiveToolsEnabled("gpt-5.4", llmConfig({ apiMode: "responses" }))).toBe(true)
    expect(effectiveToolsEnabled("gpt-5.4", llmConfig({ apiMode: "anthropic_messages" }))).toBe(false)
  })

  it("buildAgentConfig 在无工具通道的协议下不注册任何工具，有通道时正常注册", () => {
    const deps = {
      wikiPath: "C:/demo/wiki",
      projectPath: "C:/demo",
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => [],
    }

    const registry = new ToolRegistry()
    const noToolsConfig = buildAgentConfig("gpt-5.4", "系统提示", registry, {
      ...deps,
      llmConfig: llmConfig({ apiMode: "anthropic_messages" }),
    })
    expect(noToolsConfig.tools).toEqual([])

    const registry2 = new ToolRegistry()
    const responsesConfig = buildAgentConfig("gpt-5.4", "系统提示", registry2, {
      ...deps,
      llmConfig: llmConfig({ apiMode: "responses" }),
    })
    expect(responsesConfig.tools.length).toBeGreaterThan(0)
  })
})

/**
 * P0 修复回归（2026-10-29）：内置 anthropic / google / minimax 三个 provider
 * 曾经会注册工具但 body builder 不转发，Agent 空转一轮后静默退化成单轮 chat。
 *
 * 修复前因果链：
 *   preset-resolver.ts  apiMode 只在 provider === "custom" 分支赋值
 *     → 这三个 provider 的 apiMode 恒为 undefined
 *     → apiModeSupportsTools(undefined) === true
 *     → buildAgentConfig 注册 23 个工具
 *     → buildAnthropicBody / buildGoogleBody 无 tools 字段
 *     → Agent 拿不到 tool_calls，直接当 finalText 返回
 *
 * 修复方式：给两个 body builder 补原生工具通道 + 各自的 parseToolDelta，
 * 让「注册了工具」与「工具真能发出去」重新一致。本组断言守住这个一致性。
 */
describe("P0 修复：内置 provider 的工具通道与 body builder 一致", () => {
  const BUILTIN_PROVIDERS_WITHOUT_APIMODE = [
    ["anthropic", "claude-sonnet-4-5"],
    ["google", "gemini-2.5-pro"],
    ["minimax", "minimax-m2"],
  ] as const

  it("这三个 provider 的 LlmConfig 不带 apiMode（preset-resolver 只在 custom 分支赋值）", () => {
    for (const [provider, model] of BUILTIN_PROVIDERS_WITHOUT_APIMODE) {
      const cfg = llmConfig({ provider, model, apiMode: undefined })
      expect(cfg.apiMode, `${provider} 不应有 apiMode`).toBeUndefined()
    }
  })

  it("三个内置 provider 都注册工具（effectiveToolsEnabled 为 true）", () => {
    for (const [provider, model] of BUILTIN_PROVIDERS_WITHOUT_APIMODE) {
      const cfg = llmConfig({ provider, model, apiMode: undefined })
      expect(effectiveToolsEnabled(model, cfg), `${provider} 应支持工具`).toBe(true)
    }
  })

  it("三个内置 provider 都注册了工具，且都配了 parseToolDelta", () => {
    const deps = {
      wikiPath: "C:/demo/wiki",
      projectPath: "C:/demo",
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => [],
    }
    for (const [provider, model] of BUILTIN_PROVIDERS_WITHOUT_APIMODE) {
      const registry = new ToolRegistry()
      const cfg = buildAgentConfig(model, "系统提示", registry, {
        ...deps,
        llmConfig: llmConfig({ provider, model, apiMode: undefined }),
      })
      expect(cfg.tools.length, `${provider} 应注册工具`).toBeGreaterThan(0)
    }
  })
})

/**
 * 修复的核心证据：body builder 必须真的把 tools 发出去。
 * 这组是「注册了工具」的另一半——只有两边都成立，才不是静默退化。
 */
describe("P0 修复：body builder 真的转发 tools", () => {
  const sampleTools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读文件",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ]

  it("anthropic 官方 provider 的 body 含 tools（Anthropic input_schema 形状）", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "anthropic", model: "claude-sonnet-4-5", apiMode: undefined })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: sampleTools } as never,
    ) as Record<string, unknown>
    const tools = body.tools as Array<Record<string, unknown>>
    expect(Array.isArray(tools)).toBe(true)
    expect(tools[0].name).toBe("read_file")
    // Anthropic 用 input_schema 而不是 function.parameters
    expect(tools[0].input_schema).toBeDefined()
    expect(tools[0].function).toBeUndefined()
  })

  it("google provider 的 body 含 tools（functionDeclarations 形状）", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "google", model: "gemini-2.5-pro", apiMode: undefined })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: sampleTools } as never,
    ) as Record<string, unknown>
    const tools = body.tools as Array<Record<string, unknown>>
    expect(Array.isArray(tools)).toBe(true)
    const decls = tools[0].functionDeclarations as Array<Record<string, unknown>>
    expect(Array.isArray(decls)).toBe(true)
    expect(decls[0].name).toBe("read_file")
  })

  it("minimax 走 Anthropic 通道，body 含 tools", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "minimax", model: "minimax-m2", apiMode: undefined })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: sampleTools } as never,
    ) as Record<string, unknown>
    expect(Array.isArray(body.tools)).toBe(true)
  })

  it("三个内置 provider 都配了 parseToolDelta（流里能收到工具意图）", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-4-5"],
      ["google", "gemini-2.5-pro"],
      ["minimax", "minimax-m2"],
    ] as const) {
      const cfg = llmConfig({ provider, model, apiMode: undefined })
      const pc = getProviderConfig(cfg)
      expect(pc.parseToolDelta, `${provider} 应有 parseToolDelta`).toBeDefined()
    }
  })

  it("【对照组】custom + chat_completions 的 body 仍按原样转发 tools", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "custom", apiMode: "chat_completions" })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: sampleTools } as never,
    ) as Record<string, unknown>
    expect(body.tools).toEqual(sampleTools)
  })
})

/**
 * 工具往返：assistant.tool_calls → 原生工具调用块；tool 结果 → 原生结果块。
 * 只发 tools 声明而不会回填工具结果，同样会让多轮工具循环断掉。
 */
describe("P0 修复：工具往返消息转换", () => {
  const roundTrip = [
    { role: "user", content: "读一下 a.md" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }],
    },
    { role: "tool", content: "文件内容", tool_call_id: "call_1", name: "read_file" },
  ] as never

  it("anthropic：tool_calls → tool_use，tool 结果 → user 回合内的 tool_result", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "anthropic", apiMode: undefined })
    const body = getProviderConfig(cfg).buildBody(roundTrip, {} as never) as Record<string, unknown>
    const msgs = body.messages as Array<{ role: string; content: unknown }>
    const flat = JSON.stringify(msgs)
    expect(flat).toContain("tool_use")
    expect(flat).toContain("tool_result")
    expect(flat).toContain("call_1")
    // tool_result 必须在 user 回合里（Anthropic 硬要求）
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe("user")
  })

  it("google：tool_calls → functionCall，tool 结果 → functionResponse", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "google", apiMode: undefined })
    const body = getProviderConfig(cfg).buildBody(roundTrip, {} as never) as Record<string, unknown>
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>
    const flat = JSON.stringify(contents)
    expect(flat).toContain("functionCall")
    expect(flat).toContain("functionResponse")
    // 工具调用必须挂在 model 回合
    const modelTurn = contents.find((c) => c.role === "model")
    expect(JSON.stringify(modelTurn)).toContain("functionCall")
  })
})
