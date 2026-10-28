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
 * P0 回归（2026-10-29）：内置 anthropic / google / minimax 三个 provider 会注册工具，
 * 但它们的 body builder 不转发 tools —— Agent 空转一轮后静默退化成单轮 chat。
 *
 * 因果链（已实测）：
 *   preset-resolver.ts:75  apiMode 只在 provider === "custom" 分支赋值
 *     → 这三个 provider 的 apiMode 恒为 undefined
 *     → apiModeSupportsTools(undefined) === true
 *     → buildAgentConfig 注册 23 个工具
 *     → buildAnthropicBody / buildGoogleBody 无 tools 字段
 *     → Agent 拿不到 tool_calls，直接当 finalText 返回
 *
 * 本组测试**钉住当前错误行为**（记录 bug 现状），不是认可它。
 * 修复后这些断言会失败，届时需同步改成「返回 false / 不注册工具」。
 */
describe("P0 回归：内置 provider 的工具通道与 body builder 不一致", () => {
  const BUILTIN_PROVIDERS_WITHOUT_APIMODE = [
    ["anthropic", "claude-sonnet-4-5"],
    ["google", "gemini-2.5-pro"],
    ["minimax", "minimax-m2"],
  ] as const

  it("这三个 provider 的 LlmConfig 不带 apiMode（preset-resolver 只在 custom 分支赋值）", () => {
    // 用真实形状构造：provider 是内置值，没有 apiMode 字段
    for (const [provider, model] of BUILTIN_PROVIDERS_WITHOUT_APIMODE) {
      const cfg = llmConfig({ provider, model, apiMode: undefined })
      expect(cfg.apiMode, `${provider} 不应有 apiMode`).toBeUndefined()
    }
  })

  it("【bug 现状】apiMode=undefined 被判为「支持工具」", () => {
    // 这是缺陷的源头：undefined 被当作 chat_completions 处理。
    // 修复后应改为按 provider 的 body builder 能力推导。
    expect(apiModeSupportsTools(undefined)).toBe(true)
  })

  it("【bug 现状】三个内置 provider 的 effectiveToolsEnabled 全为 true", () => {
    for (const [provider, model] of BUILTIN_PROVIDERS_WITHOUT_APIMODE) {
      const cfg = llmConfig({ provider, model, apiMode: undefined })
      expect(
        effectiveToolsEnabled(model, cfg),
        `${provider} 当前被判为支持工具（但 builder 不转发）`,
      ).toBe(true)
    }
  })

  it("【bug 现状】buildAgentConfig 为这三个 provider 注册了工具", () => {
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
      expect(
        cfg.tools.length,
        `${provider} 注册了 ${cfg.tools.length} 个工具，但 builder 不会转发`,
      ).toBeGreaterThan(0)
    }
  })
})

/**
 * P0 回归（续）：直接验证 body builder 的输出形状。
 *
 * 上面那组证明「工具被注册了」，这组证明「工具没被发出去」——
 * 两者合起来才是完整的 bug 证据链。
 *
 * 同时钉住反面：custom + chat_completions 的 body 确实带 tools，
 * 说明工具通道本身是好的，问题只在内置 provider 的分支。
 */
describe("P0 回归：body builder 是否真的转发 tools", () => {
  it("【bug 现状】anthropic 官方 provider 的 body 不含 tools", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "anthropic", model: "claude-sonnet-4-5", apiMode: undefined })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: [{ type: "function", function: { name: "x", description: "d", parameters: {} } }] } as never,
    ) as Record<string, unknown>
    expect(body.tools, "anthropic body 当前不含 tools（bug 现状）").toBeUndefined()
    // 但 messages 是正常构造的，说明 body builder 本身在跑
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it("【bug 现状】google provider 的 body 不含 tools", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "google", model: "gemini-2.5-pro", apiMode: undefined })
    const pc = getProviderConfig(cfg)
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools: [{ type: "function", function: { name: "x", description: "d", parameters: {} } }] } as never,
    ) as Record<string, unknown>
    expect(body.tools, "google body 当前不含 tools（bug 现状）").toBeUndefined()
    expect(body.contents ?? body.generationConfig).toBeDefined()
  })

  it("【对照组】custom + chat_completions 的 body 确实带 tools（工具通道本身正常）", async () => {
    const { getProviderConfig } = await import("../llm-providers")
    const cfg = llmConfig({ provider: "custom", apiMode: "chat_completions" })
    const pc = getProviderConfig(cfg)
    const tools = [{ type: "function", function: { name: "x", description: "d", parameters: {} } }]
    const body = pc.buildBody(
      [{ role: "user", content: "hi" }] as never,
      { tools } as never,
    ) as Record<string, unknown>
    expect(body.tools, "custom chat_completions 应转发 tools").toEqual(tools)
  })
})
