/**
 * resolveEffectiveChatLlmConfig — AI 会话 model 解析（chat-panel 拆分 T1）直接契约。
 * preset-resolver / llm-presets 全部 mock，聚焦「空白模型名原样返回」等分支。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, ProviderConfigs, SavedModel } from "@/stores/wiki-store"
import { resolveEffectiveChatLlmConfig } from "./chat-panel-llm-config"

interface PresetLike {
  id: string
  name: string
}

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  presetList: [] as PresetLike[],
}))

vi.mock("@/lib/llm-config/preset-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-config/preset-resolver")>()
  return {
    ...actual,
    resolveConfig: mocks.resolveConfig,
  }
})

vi.mock("@/lib/llm-config/llm-presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-config/llm-presets")>()
  return {
    ...actual,
    get LLM_PRESETS() {
      return mocks.presetList
    },
  }
})

const BASE_CONFIG: LlmConfig = {
  provider: "custom",
  model: "deepseek-v3",
  customEndpoint: "https://api.deepseek.com",
  ollamaUrl: "",
  maxContextSize: 120000,
  apiKey: "key",
  apiMode: "chat_completions",
}

function savedModel(model: string): SavedModel {
  return { id: model, name: model, model, createdAt: 0 }
}

function overrideFor(models: string[]): ProviderConfigs[string] {
  return { savedModels: models.map(savedModel) }
}

describe("resolveEffectiveChatLlmConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.presetList.length = 0
    // 合并语义的极简替身：标记 provider 且改 baseUrl，便于断言走了合并分支。
    mocks.resolveConfig.mockImplementation((template: PresetLike, _override: unknown, fallback: LlmConfig) => ({
      ...fallback,
      provider: template.id,
      baseUrl: `merged-${template.id}`,
    }))
  })

  it("aiChatModel 为空白时原样返回 llmConfig（同一引用，不克隆、不查 provider）", () => {
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "   ",
      llmConfig: BASE_CONFIG,
      providerConfigs: {},
    })
    expect(out).toBe(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("aiChatModel 为空字符串且 providerConfigs 非空时仍原样返回", () => {
    const providerConfigs: ProviderConfigs = { deepseek: overrideFor(["deepseek-v3"]) }
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "",
      llmConfig: BASE_CONFIG,
      providerConfigs,
    })
    expect(out).toBe(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider/model 精确匹配：按 preset 模板合并并覆盖 model", () => {
    mocks.presetList.push({ id: "deepseek", name: "DeepSeek" })
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor(["deepseek-v3"]) },
    })
    expect(mocks.resolveConfig).toHaveBeenCalledTimes(1)
    expect(out).toEqual({
      ...BASE_CONFIG,
      provider: "deepseek",
      baseUrl: "merged-deepseek",
      model: "deepseek-v3",
    })
  })

  it("provider/model 但 model 不在 savedModels：只覆盖 model", () => {
    mocks.presetList.push({ id: "deepseek", name: "DeepSeek" })
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek/other-model",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor(["deepseek-v3"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "other-model" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider 无 override 配置：走 else 分支只覆盖 model", () => {
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: {},
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "deepseek-v3" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("provider 不在 presets 时回退 custom 模板", () => {
    mocks.presetList.push({ id: "custom", name: "Custom" })
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "ollama/llama3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { ollama: overrideFor(["llama3"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, provider: "custom", baseUrl: "merged-custom", model: "llama3" })
  })

  it("命中 savedModels 但模板缺失：不合并，保留 llmConfig", () => {
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek/deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor(["deepseek-v3"]) },
    })
    expect(out).toBe(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("legacy 纯模型名：遍历 providerConfigs 命中后合并并 break", () => {
    mocks.presetList.push({ id: "openai", name: "OpenAI" }, { id: "deepseek", name: "DeepSeek" })
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: {
        openai: overrideFor(["gpt-4o"]),
        deepseek: overrideFor(["deepseek-v3"]),
      },
    })
    expect(out).toEqual({
      ...BASE_CONFIG,
      provider: "deepseek",
      baseUrl: "merged-deepseek",
      model: "deepseek-v3",
    })
    expect(mocks.resolveConfig).toHaveBeenCalledTimes(1)
  })

  it("legacy 纯模型名：无 provider 命中时只覆盖 model", () => {
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "some-model",
      llmConfig: BASE_CONFIG,
      providerConfigs: { openai: overrideFor(["gpt-4o"]) },
    })
    expect(out).toEqual({ ...BASE_CONFIG, model: "some-model" })
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("legacy 纯模型名：命中但模板缺失时 matched 生效且不合并", () => {
    const out = resolveEffectiveChatLlmConfig({
      aiChatModel: "deepseek-v3",
      llmConfig: BASE_CONFIG,
      providerConfigs: { deepseek: overrideFor(["deepseek-v3"]) },
    })
    expect(out).toBe(BASE_CONFIG)
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })
})
