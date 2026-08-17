// @vitest-environment jsdom
/**
 * useChatLlmResolver — aiChatModel 解析（provider/model 精确匹配 / legacy 全量搜索）全口径覆盖。
 * preset-resolver / llm-presets 全部 mock。
 */
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, ProviderOverride } from "@/stores/wiki-store"
import { useChatLlmResolver } from "./use-chat-llm-resolver"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PresetLike {
  id: string
  name: string
}

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn((template: PresetLike, override: any, fallback: LlmConfig) => ({
    ...fallback,
    provider: template.id,
    baseUrl: `merged-${template.id}`,
  })),
  presetList: [] as PresetLike[],
}))

vi.mock("@/components/settings/preset-resolver", () => ({
  resolveConfig: mocks.resolveConfig,
}))

vi.mock("@/components/settings/llm-presets", () => ({
  get LLM_PRESETS() {
    return mocks.presetList
  },
}))

const BASE_CONFIG: LlmConfig = {
  provider: "deepseek",
  model: "deepseek-v3",
  baseUrl: "https://api.deepseek.com",
  apiKey: "key",
  apiMode: "chat",
}

function overrideFor(providerId: string, models: string[]): ProviderOverride {
  return { savedModels: models.map((model) => ({ model })) } as ProviderOverride
}

describe("useChatLlmResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.presetList.length = 0
  })

  it("aiChatModel 为空时返回 llmConfig 的副本（不修改原对象）", () => {
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "   ",
      llmConfig: BASE_CONFIG,
      providerConfigs: {},
    })
    expect(out).toEqual(BASE_CONFIG)
    expect(out).not.toBe(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider/model 精确匹配：合并 provider 配置并覆盖 model", () => {
    mocks.presetList.push({ id: "deepseek", name: "DeepSeek" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor("deepseek", ["deepseek-v3", "deepseek-r1"]) },
    })
    expect(mocks.resolveConfig).toHaveBeenCalledWith(
      { id: "deepseek", name: "DeepSeek" },
      expect.objectContaining({ savedModels: expect.any(Array) }),
      BASE_CONFIG,
    )
    expect(out).toEqual({ ...BASE_CONFIG, provider: "deepseek", baseUrl: "merged-deepseek", model: "deepseek-v3" })
  })

  it("provider/model 但 model 不在 savedModels：仅覆盖 model", () => {
    mocks.presetList.push({ id: "deepseek", name: "DeepSeek" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek/unknown-model",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor("deepseek", ["deepseek-v3"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "unknown-model" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider 未配置 override：走 else 分支仅覆盖 model", () => {
    mocks.presetList.push({ id: "deepseek", name: "DeepSeek" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: {},
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "deepseek-v3" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider 不在 presets 时回退 custom preset 模板", () => {
    mocks.presetList.push({ id: "custom", name: "Custom" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "ollama/llama3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { ollama: overrideFor("ollama", ["llama3"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, provider: "custom", baseUrl: "merged-custom", model: "llama3" })
  })

  it("provider/model 匹配但 presets 为空：模板缺失时不合并", () => {
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor("deepseek", ["deepseek-v3"]) },
    })
    expect(out).toEqual(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("legacy modelId：遍历 providers 命中后合并并 break", () => {
    mocks.presetList.push({ id: "openai", name: "OpenAI" }, { id: "deepseek", name: "DeepSeek" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: {
        openai: overrideFor("openai", ["gpt-4o"]),
        deepseek: overrideFor("deepseek", ["deepseek-v3"]),
      },
    })
    expect(out).toEqual({ ...BASE_CONFIG, provider: "deepseek", baseUrl: "merged-deepseek", model: "deepseek-v3" })
    expect(mocks.resolveConfig).toHaveBeenCalledTimes(1)
  })

  it("legacy modelId：无 provider 命中时仅覆盖 model", () => {
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "some-model",
      llmConfig: BASE_CONFIG,
      providerConfigs: { openai: overrideFor("openai", ["gpt-4o"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "some-model" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("legacy modelId：命中但模板缺失时 matched=true 且不合并", () => {
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor("deepseek", ["deepseek-v3"]) },
    })
    expect(out).toEqual(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("legacy modelId：命中且 provider 无 preset 时回退 custom", () => {
    mocks.presetList.push({ id: "custom", name: "Custom" })
    const { result } = renderHook(() => useChatLlmResolver())
    const out = result.current.resolveEffectiveLlmConfig({
      aiChatModel: "llama3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { ollama: overrideFor("ollama", ["llama3"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, provider: "custom", baseUrl: "merged-custom", model: "llama3" })
  })
})
