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
import { LLM_PRESETS } from "@/lib/llm-config/llm-presets"
import { resolveConfig } from "@/lib/llm-config/preset-resolver"
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
  it("三条 wire 协议都具备工具通道（anthropic_messages 已实现 tool_use 转发）", () => {
    expect(apiModeSupportsTools("chat_completions")).toBe(true)
    expect(apiModeSupportsTools("responses")).toBe(true)
    expect(apiModeSupportsTools(undefined)).toBe(true)
    // 曾硬返回 false，连带禁掉 minimax-global / minimax-cn 预设；
    // 代理不透传 tools 的 400 由 runner 的 isToolUnsupportedError 兜底降级。
    expect(apiModeSupportsTools("anthropic_messages")).toBe(true)
  })

  it("modelSupportsTools 把 apiMode 纳入判定", () => {
    expect(modelSupportsTools("gpt-5.4", "custom", "responses")).toBe(true)
    expect(modelSupportsTools("gpt-5.4", "custom", "anthropic_messages")).toBe(true)
    // 未传 apiMode 时保持历史行为
    expect(modelSupportsTools("gpt-5.4", "custom")).toBe(true)
  })

  it("effectiveToolsEnabled 对 anthropic_messages 开启工具", () => {
    expect(effectiveToolsEnabled("gpt-5.4", llmConfig({ apiMode: "responses" }))).toBe(true)
    expect(effectiveToolsEnabled("gpt-5.4", llmConfig({ apiMode: "anthropic_messages" }))).toBe(true)
  })

  it("buildAgentConfig 在 anthropic_messages 与 responses 下注册同样的工具集", () => {
    const deps = {
      wikiPath: "C:/demo/wiki",
      projectPath: "C:/demo",
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => [],
    }

    const registry = new ToolRegistry()
    const anthropicConfig = buildAgentConfig("gpt-5.4", "系统提示", registry, {
      ...deps,
      llmConfig: llmConfig({ apiMode: "anthropic_messages" }),
    })
    expect(anthropicConfig.tools.length).toBeGreaterThan(0)

    const registry2 = new ToolRegistry()
    const responsesConfig = buildAgentConfig("gpt-5.4", "系统提示", registry2, {
      ...deps,
      llmConfig: llmConfig({ apiMode: "responses" }),
    })
    expect(responsesConfig.tools.length).toBeGreaterThan(0)
    expect(anthropicConfig.tools.length).toBe(responsesConfig.tools.length)
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

/**
 * P0 剩余缺口（2026-10-29）：工具注册层与 transport 转发层脱节。
 *
 * 四个 CLI transport 全文零处 `tools`（claude-cli / codex-cli /
 * antigravity-cli / cursor-cli-proxy），但旧 buildAgentConfig 只看 apiMode，
 * 于是 claude-code / codex-cli / antigravity-cli 三个 provider 会注册 23 个工具
 * 却永远不会被转发——Agent 带着一份永不执行的清单空转，表现为「静默零工具调用」。
 *
 * 旧 TOOL_UNSUPPORTED_PROVIDERS 恰好把两者搞反：cursor-cli 被误禁（它靠
 * providerUsesTextToolCalls 注入 prompt、runner 文本解析，确实支持工具），
 * 而 codex-cli / antigravity-cli 被漏禁。
 */
describe("工具注册与 transport 能力一致（P0 剩余缺口）", () => {
  const deps = {
    wikiPath: "C:/demo/wiki",
    projectPath: "C:/demo",
    getSkillConfig: () => null,
    getChatConversations: () => [],
    getOutlineConversations: () => [],
  }

  const buildFor = (overrides: Partial<LlmConfig>, modelId = "gpt-5.4") =>
    buildAgentConfig(modelId, "系统提示", new ToolRegistry(), {
      ...deps,
      llmConfig: llmConfig(overrides),
    })

  it.each(["claude-code", "codex-cli", "antigravity-cli"] as const)(
    "%s 不注册工具（transport 不转发 tools，注册即静默退化）",
    (provider) => {
      const cfg = buildFor({ provider })
      expect(cfg.tools).toEqual([])
    },
  )

  it("cursor-cli 仍注册工具并注入文本调用约定（它靠文本解析，不是原生 tools）", () => {
    const cfg = buildFor({ provider: "cursor-cli" })
    expect(cfg.tools.length).toBeGreaterThan(0)
    expect(cfg.systemPrompt).toContain('{"name":"工具名","arguments":{...}}')
  })

  it("非 CLI 的 OpenAI 形状通道正常注册且不注入文本约定", () => {
    const cfg = buildFor({ provider: "custom", apiMode: "chat_completions" })
    expect(cfg.tools.length).toBeGreaterThan(0)
    expect(cfg.systemPrompt).not.toContain('{"name":"工具名"')
  })

  it("黑名单与文本解析名单不再互相矛盾", () => {
    // cursor-cli 走文本解析 → modelSupportsTools 必须为 true
    expect(modelSupportsTools("gpt-5.4", "cursor-cli", "chat_completions")).toBe(true)
    expect(providerUsesTextToolCalls("cursor-cli")).toBe(true)
    // 三个无通道 provider → false，且不走文本解析
    for (const p of ["claude-code", "codex-cli", "antigravity-cli"] as const) {
      expect(modelSupportsTools("gpt-5.4", p, "chat_completions")).toBe(false)
      expect(providerUsesTextToolCalls(p)).toBe(false)
    }
  })

  it("不支持工具的模型前缀同样被拦（旧 buildAgentConfig 完全没查这一层）", () => {
    const cfg = buildFor({ provider: "custom", apiMode: "chat_completions" }, "o3-mini")
    expect(cfg.tools).toEqual([])
  })
})

/**
 * MiniMax 预设端到端（P0 剩余缺口收尾）。
 *
 * 修复前因果链：
 *   llm-presets.ts  minimax-global / minimax-cn 的 provider 是 "custom"，
 *                   apiMode 是 "anthropic_messages"
 *   → preset-resolver.ts:75  apiMode 只在 provider === "custom" 分支赋值
 *   → config.ts  apiModeSupportsTools("anthropic_messages") === false
 *   → 用户从下拉框选 MiniMax，拿到的是**无工具**的 Agent。
 *
 * 而 provider === "minimax" 分支虽然判定正确，却没有任何预设可达它，
 * 所以「minimax 已修」此前只对一个不可达的代码路径成立。
 */
describe("MiniMax 预设工具可用性（端到端）", () => {
  const fallback = llmConfig()

  const resolvePreset = (id: string) => {
    const preset = LLM_PRESETS.find((item) => item.id === id)
    if (!preset) throw new Error(`preset not found: ${id}`)
    return resolveConfig(preset, { apiKey: "sk-test" }, fallback)
  }

  it.each(["minimax-global", "minimax-cn"])(
    "%s 解析后 provider=custom + apiMode=anthropic_messages（前提确认）",
    (id) => {
      const cfg = resolvePreset(id)
      expect(cfg.provider).toBe("custom")
      expect(cfg.apiMode).toBe("anthropic_messages")
    },
  )

  it.each(["minimax-global", "minimax-cn"])(
    "%s 解析后工具可用且真的注册进 registry",
    (id) => {
      const cfg = resolvePreset(id)
      expect(effectiveToolsEnabled(cfg.model, cfg)).toBe(true)

      const built = buildAgentConfig(cfg.model, "系统提示", new ToolRegistry(), {
        wikiPath: "C:/demo/wiki",
        projectPath: "C:/demo",
        getSkillConfig: () => null,
        getChatConversations: () => [],
        getOutlineConversations: () => [],
        llmConfig: cfg,
      })
      expect(built.tools.length).toBeGreaterThan(0)
    },
  )

  it("用户关掉函数调用开关时仍可禁用（保留逃生口）", () => {
    const cfg = { ...resolvePreset("minimax-global"), functionCallingEnabled: false }
    expect(effectiveToolsEnabled(cfg.model, cfg as LlmConfig)).toBe(false)
  })
})
