import { describe, expect, it } from "vitest"
import { hasUsableLlm } from "./has-usable-llm"
import type { LlmConfig } from "@/stores/wiki-store"

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.4",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 204800,
    apiMode: "chat_completions",
    reasoning: { mode: "auto" },
    ...overrides,
  }
}

describe("hasUsableLlm", () => {
  it("requires custom providers to have both model and endpoint", () => {
    expect(hasUsableLlm(makeConfig({
      provider: "custom",
      apiKey: "",
      model: "gpt-5.4",
      customEndpoint: "",
    }))).toBe(false)

    expect(hasUsableLlm(makeConfig({
      provider: "custom",
      apiKey: "",
      model: "gpt-5.4",
      customEndpoint: "http://127.0.0.1:18080/v1",
    }))).toBe(true)
  })

  it("requires ollama providers to have both model and base url", () => {
    expect(hasUsableLlm(makeConfig({
      provider: "ollama",
      apiKey: "",
      model: "qwen2.5",
      ollamaUrl: "",
    }))).toBe(false)

    expect(hasUsableLlm(makeConfig({
      provider: "ollama",
      apiKey: "",
      model: "qwen2.5",
      ollamaUrl: "http://localhost:11434",
    }))).toBe(true)
  })

  it("requires azure providers to keep their endpoint alongside key and model", () => {
    expect(hasUsableLlm(makeConfig({
      provider: "azure",
      apiKey: "azure-key",
      model: "deployment-name",
      customEndpoint: "",
    }))).toBe(false)

    expect(hasUsableLlm(makeConfig({
      provider: "azure",
      apiKey: "azure-key",
      model: "deployment-name",
      customEndpoint: "https://example.openai.azure.com",
    }))).toBe(true)
  })

  it("keeps hosted providers on apiKey plus model", () => {
    expect(hasUsableLlm(makeConfig({
      provider: "openai",
      apiKey: "",
      model: "gpt-5.4",
    }))).toBe(false)

    expect(hasUsableLlm(makeConfig({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-5.4",
    }))).toBe(true)
  })

  it("treats anthropic/google/minimax like openai (key + model)", () => {
    expect(hasUsableLlm(makeConfig({ provider: "anthropic", apiKey: "k", model: "m" }))).toBe(true)
    expect(hasUsableLlm(makeConfig({ provider: "anthropic", apiKey: "", model: "m" }))).toBe(false)
    expect(hasUsableLlm(makeConfig({ provider: "google", apiKey: "k", model: "m" }))).toBe(true)
    expect(hasUsableLlm(makeConfig({ provider: "minimax", apiKey: "k", model: "m" }))).toBe(true)
  })

  it("exercises the exhaustive-switch default via an untyped provider", () => {
    // The default arm is dead by typing (all union members handled);
    // reach it at runtime only by bypassing the type system.
    expect(hasUsableLlm(makeConfig({ provider: "bogus" as never }))).toBe("bogus" as never)
  })

  it("allows local CLI providers to fall back to the machine default model", () => {
    expect(hasUsableLlm(makeConfig({
      provider: "claude-code",
      apiKey: "",
      model: "",
    }))).toBe(true)

    expect(hasUsableLlm(makeConfig({
      provider: "codex-cli",
      apiKey: "",
      model: "",
    }))).toBe(true)
  })
})
