import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, NovelConfig, ProviderOverride } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  resolveConfig: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.getState },
}))

vi.mock("@/components/settings/llm-presets", () => ({
  LLM_PRESETS: [
    { id: "anthropic", provider: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet" },
    { id: "custom", provider: "custom", label: "Custom", defaultModel: "custom-default" },
  ],
}))

vi.mock("@/components/settings/preset-resolver", () => ({
  resolveConfig: (...args: unknown[]) => mocks.resolveConfig(...args),
}))

import { resolveDefaultModel, resolveModelConfig, resolveNovelModel } from "./model-resolver"

const baseConfig: LlmConfig = {
  provider: "custom",
  apiKey: "k",
  model: "base-model",
  ollamaUrl: "",
  customEndpoint: "https://endpoint/v1",
  maxContextSize: 120000,
}

const overrideWithSaved: ProviderOverride = {
  label: "Anthropic",
  savedModels: [
    { id: "m1", name: "Sonnet", model: "claude-sonnet-4", createdAt: 1 },
    { id: "m2", name: "Opus", model: "claude-opus-4", createdAt: 2 },
  ],
}

describe("model-resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      providerConfigs: {},
      defaultLlmModel: "",
      aiChatModel: "",
    })
    mocks.resolveConfig.mockImplementation((_preset: unknown, _override: unknown, fallback: LlmConfig) => ({
      ...fallback,
      provider: "anthropic",
      apiKey: "override-key",
    }))
  })

  describe("resolveModelConfig", () => {
    it("resolves provider/model slash format against a matching saved model", () => {
      const resolved = resolveModelConfig("anthropic/claude-sonnet-4", baseConfig, { anthropic: overrideWithSaved })
      expect(resolved.model).toBe("claude-sonnet-4")
      expect(mocks.resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: "anthropic" }),
        overrideWithSaved,
        baseConfig,
      )
    })

    it("falls back to custom preset when provider preset id is absent", () => {
      const resolved = resolveModelConfig("ghost/unknown-model", baseConfig, {
        ghost: { savedModels: [{ id: "g", name: "G", model: "unknown-model", createdAt: 1 }] },
      })
      expect(resolved.model).toBe("unknown-model")
      // custom preset matched (ghost not in presets)
      expect(mocks.resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom" }),
        expect.any(Object),
        baseConfig,
      )
    })

    it("returns base config with model override when override has no matching saved model", () => {
      const resolved = resolveModelConfig("anthropic/claude-opus-5", baseConfig, { anthropic: overrideWithSaved })
      expect(resolved).toEqual({ ...baseConfig, model: "claude-opus-5" })
      expect(mocks.resolveConfig).not.toHaveBeenCalled()
    })

    it("returns base config with model override when provider unknown and no presets resolve", () => {
      const resolved = resolveModelConfig("nonexistent/model-x", baseConfig, {})
      expect(resolved).toEqual({ ...baseConfig, model: "model-x" })
    })

    it("falls back to plain-name matching over providerConfigs entries", () => {
      const resolved = resolveModelConfig("claude-opus-4", baseConfig, {
        anthropic: overrideWithSaved,
      })
      expect(resolved.model).toBe("claude-opus-4")
      expect(mocks.resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: "anthropic" }),
        overrideWithSaved,
        baseConfig,
      )
    })

    it("falls back to the custom preset in the plain-name loop when the provider preset is absent", () => {
      const resolved = resolveModelConfig("model-x", baseConfig, {
        ghost: { savedModels: [{ id: "g", name: "G", model: "model-x", createdAt: 1 }] },
      })
      expect(resolved.model).toBe("model-x")
      expect(mocks.resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom" }),
        expect.any(Object),
        baseConfig,
      )
    })

    it("skips overrides whose savedModels do not contain the plain model name", () => {
      const resolved = resolveModelConfig("claude-opus-9", baseConfig, {
        anthropic: overrideWithSaved,
        openai: { savedModels: [{ id: "o", name: "O", model: "gpt-x", createdAt: 1 }] },
      })
      expect(resolved).toEqual({ ...baseConfig, model: "claude-opus-9" })
      expect(mocks.resolveConfig).not.toHaveBeenCalled()
    })

    it("handles a leading-slash target by skipping the slash branch", () => {
      // slashIdx === 0 → slash branch skipped; name-loop finds no saved model
      // matching "/model-only" → base config with model passthrough
      const resolved = resolveModelConfig("/model-only", baseConfig, {
        anthropic: { savedModels: [{ id: "m", name: "M", model: "model-only", createdAt: 1 }] },
      })
      expect(resolved).toEqual({ ...baseConfig, model: "/model-only" })
      expect(mocks.resolveConfig).not.toHaveBeenCalled()
    })
  })

  describe("resolveDefaultModel", () => {
    it("uses storeSnapshot providerConfigs and defaultLlmModel when provided", () => {
      const resolved = resolveDefaultModel(baseConfig, {
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "anthropic/claude-sonnet-4",
      })
      expect(resolved.model).toBe("claude-sonnet-4")
    })

    it("falls back to aiChatModel when defaultLlmModel is blank", () => {
      const resolved = resolveDefaultModel(baseConfig, {
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "  ",
        aiChatModel: "claude-opus-4",
      })
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("reads from the wiki store when no snapshot is given", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "claude-opus-4",
        aiChatModel: "ignored",
      })
      const resolved = resolveDefaultModel(baseConfig)
      expect(resolved.model).toBe("claude-opus-4")
      expect(mocks.getState).toHaveBeenCalled()
    })

    it("falls back to store fields for snapshot fields not supplied", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: {},
        defaultLlmModel: "store-model",
        aiChatModel: "",
      })
      const resolved = resolveDefaultModel(baseConfig, { providerConfigs: {} })
      expect(resolved.model).toBe("store-model")
    })

    it("returns base config unchanged when no default model configured", () => {
      const resolved = resolveDefaultModel(baseConfig, {
        providerConfigs: {},
        defaultLlmModel: "",
        aiChatModel: "",
      })
      expect(resolved).toEqual(baseConfig)
    })

    it("falls back to store providerConfigs when the snapshot omits them", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "",
        aiChatModel: "",
      })
      const resolved = resolveDefaultModel(baseConfig, { defaultLlmModel: "anthropic/claude-sonnet-4" })
      expect(resolved.model).toBe("claude-sonnet-4")
    })
  })

  describe("resolveNovelModel", () => {
    const novelConfig = {
      reviewModel: "anthropic/claude-sonnet-4",
      summaryModel: "claude-opus-4",
      extractModel: "gpt-x",
    } as unknown as NovelConfig

    it("writing: no task model → uses aiChatModel then defaultLlmModel", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing", {
        providerConfigs: { anthropic: overrideWithSaved },
        aiChatModel: "claude-opus-4",
        defaultLlmModel: "fallback",
      })
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("writing: falls back to defaultLlmModel when aiChatModel blank", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing", {
        providerConfigs: { anthropic: overrideWithSaved },
        aiChatModel: "",
        defaultLlmModel: "claude-opus-4",
      })
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("writing: returns llmConfig unchanged when neither model configured", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing", {
        providerConfigs: {},
        aiChatModel: "",
        defaultLlmModel: "",
      })
      expect(resolved).toEqual(baseConfig)
    })

    it("writing: falls back to store providerConfigs when the snapshot omits them", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "",
        aiChatModel: "",
      })
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing", { aiChatModel: "claude-opus-4" })
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("review: resolves novelConfig.reviewModel", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "review", {
        providerConfigs: { anthropic: overrideWithSaved },
      })
      expect(resolved.model).toBe("claude-sonnet-4")
    })

    it("lint: uses reviewModel", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "lint", {
        providerConfigs: { anthropic: overrideWithSaved },
      })
      expect(resolved.model).toBe("claude-sonnet-4")
    })

    it("summary: resolves summaryModel", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "summary", {
        providerConfigs: { anthropic: overrideWithSaved },
      })
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("extract: resolves extractModel (plain name, no matching saved → base + model)", () => {
      const resolved = resolveNovelModel(baseConfig, novelConfig, "extract", {
        providerConfigs: {},
      })
      expect(resolved).toEqual({ ...baseConfig, model: "gpt-x" })
    })

    it("reads store defaults when snapshot absent (writing path)", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: { anthropic: overrideWithSaved },
        defaultLlmModel: "",
        aiChatModel: "claude-opus-4",
      })
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing")
      expect(resolved.model).toBe("claude-opus-4")
    })

    it("partial snapshot falls back to store for missing defaultLlmModel", () => {
      mocks.getState.mockReturnValue({
        providerConfigs: {},
        defaultLlmModel: "store-fallback",
        aiChatModel: "",
      })
      const resolved = resolveNovelModel(baseConfig, novelConfig, "writing", { providerConfigs: {} })
      expect(resolved.model).toBe("store-fallback")
    })
  })
})
