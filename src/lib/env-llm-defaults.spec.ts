import { afterEach, describe, expect, it, vi } from "vitest"
import { loadEnvLlmDefault } from "./env-llm-defaults"

describe("loadEnvLlmDefault", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns null when endpoint or model is missing", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "")

    expect(loadEnvLlmDefault()).toBeNull()
  })

  it("allows a keyless custom endpoint for local or LAN llm runtimes", () => {
    vi.stubEnv("VITE_QMAI_LLM_API_KEY", "")
    vi.stubEnv("VITE_QMAI_LLM_ENDPOINT", "http://127.0.0.1:18080/v1")
    vi.stubEnv("VITE_QMAI_LLM_MODEL", "mock-qmai")
    vi.stubEnv("VITE_QMAI_LLM_CONTEXT_SIZE", "8192")

    expect(loadEnvLlmDefault()).toEqual({
      config: {
        provider: "custom",
        apiKey: "",
        model: "mock-qmai",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "http://127.0.0.1:18080/v1",
        maxContextSize: 8192,
        apiMode: "chat_completions",
        reasoning: { mode: "auto" },
      },
      providerConfigs: {
        custom: {
          apiKey: "",
          model: "mock-qmai",
          baseUrl: "http://127.0.0.1:18080/v1",
          apiMode: "chat_completions",
          maxContextSize: 8192,
          reasoning: { mode: "auto" },
        },
      },
      activePresetId: "custom",
    })
  })
})
