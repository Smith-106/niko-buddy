// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/llm-presets.ts

import { describe, expect, it } from "vitest"
import { LLM_PRESETS, matchPreset } from "./llm-presets"

describe("LLM_PRESETS", () => {
  it("keeps exactly one custom preset (index 0) and drops the trailing duplicate", () => {
    expect(LLM_PRESETS[0]?.id).toBe("custom")
    expect(LLM_PRESETS.filter((p) => p.id === "custom")).toHaveLength(1)
    // 列表尾部不应再有 custom —— filter 的 index === 0 分支只保第一项
    expect(LLM_PRESETS[LLM_PRESETS.length - 1]?.id).not.toBe("custom")
  })

  it("contains every curated vendor preset", () => {
    const ids = LLM_PRESETS.map((p) => p.id)
    for (const expected of [
      "anthropic",
      "claude-code-cli",
      "codex-cli",
      "openai",
      "google",
      "azure",
      "deepseek",
      "ollama-local",
    ]) {
      expect(ids).toContain(expected)
    }
  })
})

describe("matchPreset", () => {
  const base = {
    provider: "custom" as const,
    customEndpoint: "",
    ollamaUrl: "http://localhost:11434",
    apiMode: undefined,
  }

  it("returns null when no preset matches at all", () => {
    expect(matchPreset({ ...base, customEndpoint: "https://example.invalid/v1" })).toBeNull()
  })

  it("skips presets without a baseUrl for custom provider (the bare custom row)", () => {
    // custom 预设本身没有 baseUrl → `if (!preset.baseUrl) continue`
    const result = matchPreset({ ...base, customEndpoint: "https://api.deepseek.com/v1" })
    expect(result?.id).toBe("deepseek")
  })

  it("matches a custom provider preset by normalized baseUrl (trailing slash tolerant)", () => {
    const result = matchPreset({
      ...base,
      customEndpoint: "https://api.deepseek.com/v1/",
    })
    expect(result?.id).toBe("deepseek")
  })

  it("skips a custom preset when apiMode differs (default chat_completions vs anthropic)", () => {
    const result = matchPreset({
      ...base,
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "anthropic_messages",
    })
    expect(result).toBeNull()
  })

  it("matches when the preset apiMode defaults to chat_completions and apiMode is undefined", () => {
    const result = matchPreset({
      ...base,
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: undefined,
    })
    expect(result?.id).toBe("deepseek")
  })

  it("matches a custom preset with explicit anthropic_messages apiMode (minimax)", () => {
    const result = matchPreset({
      ...base,
      customEndpoint: "https://api.minimaxi.com/anthropic",
      apiMode: "anthropic_messages",
    })
    expect(result?.id).toBe("minimax-cn")
  })

  it("matches ollama provider when baseUrl equals the preset url", () => {
    const result = matchPreset({
      provider: "ollama",
      customEndpoint: "",
      ollamaUrl: "http://localhost:11434",
    })
    expect(result?.id).toBe("ollama-local")
  })

  it("continues past ollama preset when the ollama url differs, then returns null", () => {
    const result = matchPreset({
      provider: "ollama",
      customEndpoint: "",
      ollamaUrl: "http://192.168.1.50:11434",
    })
    expect(result).toBeNull()
  })

  it("returns the first built-in preset for non-custom non-ollama providers", () => {
    const openai = matchPreset({
      provider: "openai",
      customEndpoint: "",
      ollamaUrl: "",
    })
    expect(openai?.id).toBe("openai")

    const anthropic = matchPreset({
      provider: "anthropic",
      customEndpoint: "",
      ollamaUrl: "",
    })
    expect(anthropic?.id).toBe("anthropic")
  })
})
