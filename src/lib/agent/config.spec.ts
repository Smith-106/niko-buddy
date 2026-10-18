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
