import { afterEach, describe, expect, it, vi } from "vitest"
import { loadEnvLlmDefault } from "./env-llm-defaults"

const ORIGINAL = { ...import.meta.env }

afterEach(() => {
  vi.unstubAllEnvs()
  for (const key of Object.keys(import.meta.env)) {
    if (key.startsWith("VITE_QMAI_LLM")) delete import.meta.env[key]
  }
  Object.assign(import.meta.env, ORIGINAL)
})

describe("loadEnvLlmDefault", () => {
  it("returns null when the API key is missing", () => {
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "https://example.com/v1")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "gpt-4o")
    expect(loadEnvLlmDefault()).toBeNull()
  })

  it("returns null when the endpoint is missing", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "sk-123")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "gpt-4o")
    expect(loadEnvLlmDefault()).toBeNull()
  })

  it("returns null when the model is missing", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "sk-123")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "https://example.com/v1")
    expect(loadEnvLlmDefault()).toBeNull()
  })

  it("returns null when all three are whitespace-only", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "  ")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "  ")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "  ")
    expect(loadEnvLlmDefault()).toBeNull()
  })

  it("builds a custom-provider config and provider preset", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "  sk-123  ")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", " https://example.com/v1 ")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", " gpt-4o ")

    const result = loadEnvLlmDefault()
    expect(result).not.toBeNull()
    expect(result?.config).toMatchObject({
      provider: "custom",
      apiKey: "sk-123",
      model: "gpt-4o",
      customEndpoint: "https://example.com/v1",
      apiMode: "chat_completions",
      reasoning: { mode: "auto" },
    })
    expect(result?.config.ollamaUrl).toBe("http://localhost:11434")
    expect(result?.config.maxContextSize).toBe(204800)
    expect(result?.providerConfigs.custom).toMatchObject({
      apiKey: "sk-123",
      model: "gpt-4o",
      baseUrl: "https://example.com/v1",
      apiMode: "chat_completions",
    })
    expect(result?.activePresetId).toBe("custom")
  })

  it("reads a positive numeric context size", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "sk-123")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "https://example.com/v1")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "gpt-4o")
    vi.stubEnv("VITE_QMAI_LLM_CONTEXT_SIZE", "100000")

    const result = loadEnvLlmDefault()
    expect(result?.config.maxContextSize).toBe(100000)
    expect(result?.providerConfigs.custom.maxContextSize).toBe(100000)
  })

  it("falls back to the default context size for invalid values", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "sk-123")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "https://example.com/v1")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "gpt-4o")
    vi.stubEnv("VITE_QMAI_LLM_CONTEXT_SIZE", "not-a-number")

    expect(loadEnvLlmDefault()?.config.maxContextSize).toBe(204800)

    vi.stubEnv("VITE_QMAI_LLM_CONTEXT_SIZE", "-5")
    expect(loadEnvLlmDefault()?.config.maxContextSize).toBe(204800)
  })
})
