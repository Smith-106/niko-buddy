import { describe, expect, it } from "vitest"
import { hasUsableLlm } from "./has-usable-llm"

describe("hasUsableLlm", () => {
  it("rejects the default empty openai config", () => {
    expect(hasUsableLlm({
      provider: "openai",
      apiKey: "",
      model: "",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(false)
  })

  it("requires both model and endpoint for custom providers", () => {
    expect(hasUsableLlm({
      provider: "custom",
      apiKey: "",
      model: "mock-qmai",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(false)

    expect(hasUsableLlm({
      provider: "custom",
      apiKey: "",
      model: "mock-qmai",
      customEndpoint: "http://127.0.0.1:18080/v1",
      ollamaUrl: "http://localhost:11434",
    })).toBe(true)
  })

  it("requires a model for ollama", () => {
    expect(hasUsableLlm({
      provider: "ollama",
      apiKey: "",
      model: "",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(false)

    expect(hasUsableLlm({
      provider: "ollama",
      apiKey: "",
      model: "qwen3:latest",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(true)
  })

  it("keeps local cli providers usable without API keys", () => {
    expect(hasUsableLlm({
      provider: "claude-code",
      apiKey: "",
      model: "claude-sonnet-4-6",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(true)

    expect(hasUsableLlm({
      provider: "codex-cli",
      apiKey: "",
      model: "gpt-5.4-mini",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })).toBe(true)
  })
})
