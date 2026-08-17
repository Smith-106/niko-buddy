// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/preset-resolver.ts
// (complements preset-resolver.override.spec.ts — this file drives the
// resolveConfig / hasAnthropicApiKey / isExplicitUserSelection branches
// that the override spec does not reach.)

import { afterEach, describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import { LLM_PRESETS } from "./llm-presets"
import type { LlmPreset } from "./llm-presets"
import {
  hasAnthropicApiKey,
  isExplicitUserSelection,
  resolveConfig,
} from "./preset-resolver"

const fallback: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "https://fallback.example/v1",
  maxContextSize: 204800,
  apiMode: "chat_completions",
  reasoning: { mode: "auto" },
}

function preset(id: string) {
  const found = LLM_PRESETS.find((item) => item.id === id)
  if (!found) throw new Error(`Missing preset ${id}`)
  return found
}

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k]
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v
  }
})

describe("resolveConfig — custom provider", () => {
  it("applies override fields (apiKey, trimmed model, baseUrl, apiMode)", () => {
    const config = resolveConfig(
      preset("custom"),
      {
        apiKey: "  sk-123  ",
        model: "  gpt-4o  ",
        baseUrl: "https://override.example/v1",
        apiMode: "anthropic_messages",
        maxContextSize: 9999,
        reasoning: { mode: "high" },
      },
      fallback,
    )
    expect(config.provider).toBe("custom")
    expect(config.apiKey).toBe("  sk-123  ") // apiKey 不 trim（仅 model trim）
    expect(config.model).toBe("gpt-4o")
    expect(config.customEndpoint).toBe("https://override.example/v1")
    expect(config.apiMode).toBe("anthropic_messages")
    expect(config.maxContextSize).toBe(9999)
    expect(config.reasoning).toEqual({ mode: "high" })
    expect(config.localCliIsolation).toBe(false)
  })

  it("falls back to preset defaults and fallback passthrough fields", () => {
    const config = resolveConfig(preset("deepseek"), undefined, fallback)
    expect(config.provider).toBe("custom")
    expect(config.apiKey).toBe("")
    expect(config.model).toBe("deepseek-v4-flash") // preset.defaultModel
    expect(config.customEndpoint).toBe("https://api.deepseek.com/v1") // preset.baseUrl
    expect(config.apiMode).toBe("chat_completions") // preset.apiMode
    expect(config.maxContextSize).toBe(64000) // preset.suggestedContextSize
    expect(config.ollamaUrl).toBe(fallback.ollamaUrl) // passthrough
    expect(config.reasoning).toEqual({ mode: "auto" })
  })

  it("falls back to the fallback config maxContextSize when nothing suggests one", () => {
    // custom preset: 无 defaultModel/suggestedContextSize → 模型为空 + maxContextSize 取 fallback
    const config = resolveConfig(preset("custom"), undefined, fallback)
    expect(config.model).toBe("")
    expect(config.maxContextSize).toBe(204800)
    expect(config.customEndpoint).toBe("")
  })
})

describe("resolveConfig — ollama provider", () => {
  it("uses the override baseUrl and forces apiKey empty", () => {
    const config = resolveConfig(
      preset("ollama-local"),
      { apiKey: "nope", baseUrl: "http://192.168.1.5:11434", model: "qwen2.5" },
      fallback,
    )
    expect(config.provider).toBe("ollama")
    expect(config.apiKey).toBe("")
    expect(config.ollamaUrl).toBe("http://192.168.1.5:11434")
    expect(config.model).toBe("qwen2.5")
    expect(config.customEndpoint).toBe(fallback.customEndpoint)
  })

  it("defaults to the preset baseUrl and suggested context size", () => {
    const config = resolveConfig(preset("ollama-local"), undefined, fallback)
    expect(config.ollamaUrl).toBe("http://localhost:11434")
    expect(config.maxContextSize).toBe(32768)
  })
})

describe("resolveConfig — azure provider", () => {
  it("uses override azureApiVersion / azureModelFamily", () => {
    const config = resolveConfig(
      preset("azure"),
      {
        baseUrl: "https://override.openai.azure.com",
        azureApiVersion: "2025-01-01",
        azureModelFamily: "gpt5",
      },
      fallback,
    )
    expect(config.provider).toBe("azure")
    expect(config.customEndpoint).toBe("https://override.openai.azure.com")
    expect(config.azureApiVersion).toBe("2025-01-01")
    expect(config.azureModelFamily).toBe("gpt5")
  })

  it("defaults azureApiVersion to the preset value and family to auto", () => {
    const config = resolveConfig(preset("azure"), undefined, fallback)
    expect(config.azureApiVersion).toBe("2024-10-21")
    expect(config.azureModelFamily).toBe("auto")
  })
})

describe("resolveConfig — local CLI providers", () => {
  it("claude-code: no key, model trim fallback empty, codex timeout undefined", () => {
    const config = resolveConfig(preset("claude-code-cli"), { localCliIsolation: true }, fallback)
    expect(config.provider).toBe("claude-code")
    expect(config.apiKey).toBe("")
    expect(config.model).toBe("")
    expect(config.localCliIsolation).toBe(true)
    expect(config.codexCliTimeoutMinutes).toBeUndefined()
    expect(config.explicitProviderSelection).toBe(true)
  })

  it("claude-code: keeps a trimmed override model", () => {
    const config = resolveConfig(
      preset("claude-code-cli"),
      { model: "  claude-opus-4-7  " },
      fallback,
    )
    expect(config.model).toBe("claude-opus-4-7")
  })

  it("codex-cli clamps timeout to [1, 240] with flooring", () => {
    expect(
      resolveConfig(preset("codex-cli"), { codexCliTimeoutMinutes: 12.7 }, fallback).codexCliTimeoutMinutes,
    ).toBe(12)
    expect(
      resolveConfig(preset("codex-cli"), { codexCliTimeoutMinutes: 0.5 }, fallback).codexCliTimeoutMinutes,
    ).toBe(1)
    expect(
      resolveConfig(preset("codex-cli"), { codexCliTimeoutMinutes: 999 }, fallback).codexCliTimeoutMinutes,
    ).toBe(240)
  })

  it("codex-cli drops non-finite timeout values to undefined", () => {
    expect(
      resolveConfig(preset("codex-cli"), { codexCliTimeoutMinutes: Number.NaN }, fallback)
        .codexCliTimeoutMinutes,
    ).toBeUndefined()
    expect(
      resolveConfig(preset("codex-cli"), { codexCliTimeoutMinutes: Number.POSITIVE_INFINITY }, fallback)
        .codexCliTimeoutMinutes,
    ).toBeUndefined()
  })

  it("codex-cli without localCliIsolation flag defaults to false", () => {
    const config = resolveConfig(preset("codex-cli"), {}, fallback)
    expect(config.localCliIsolation).toBe(false)
  })
})

describe("resolveConfig — fallback defaults with minimal synthetic presets", () => {
  // 契约允许任意 LlmPreset 进入 resolveConfig；这些用例覆盖 preset 字段缺失时的
  // `??` fallback 分支（真实预设数据总是显式给出这些字段）。
  it("custom preset without apiMode falls back to chat_completions", () => {
    const synthetic: LlmPreset = {
      id: "synth-custom",
      label: "synth",
      provider: "custom",
      baseUrl: "https://synth.example/v1",
    }
    const config = resolveConfig(synthetic, undefined, fallback)
    expect(config.apiMode).toBe("chat_completions")
    expect(config.customEndpoint).toBe("https://synth.example/v1")
  })

  it("ollama preset without baseUrl falls back to localhost:11434", () => {
    const synthetic: LlmPreset = {
      id: "synth-ollama",
      label: "synth",
      provider: "ollama",
    }
    const config = resolveConfig(synthetic, undefined, fallback)
    expect(config.ollamaUrl).toBe("http://localhost:11434")
  })

  it("azure preset without baseUrl/apiVersion/family falls back to empty + defaults", () => {
    const synthetic: LlmPreset = {
      id: "synth-azure",
      label: "synth",
      provider: "azure",
    }
    const config = resolveConfig(synthetic, undefined, fallback)
    expect(config.customEndpoint).toBe("")
    expect(config.azureApiVersion).toBe(AZURE_OPENAI_API_VERSION)
    expect(config.azureModelFamily).toBe("auto")
  })
})

describe("resolveConfig — fixed-endpoint providers (openai/anthropic/google/minimax)", () => {
  it("maps override apiKey/model and passes through fallback endpoints", () => {
    const config = resolveConfig(
      preset("openai"),
      { apiKey: "sk-oai", model: "gpt-4o", maxContextSize: 100000 },
      fallback,
    )
    expect(config.provider).toBe("openai")
    expect(config.apiKey).toBe("sk-oai")
    expect(config.model).toBe("gpt-4o")
    expect(config.maxContextSize).toBe(100000)
    expect(config.ollamaUrl).toBe(fallback.ollamaUrl)
    expect(config.customEndpoint).toBe(fallback.customEndpoint)
    expect(config.localCliIsolation).toBe(false)
  })
})

describe("hasAnthropicApiKey", () => {
  it("returns true from the config apiKey alone", () => {
    expect(hasAnthropicApiKey({ apiKey: "  sk-ant-abc  " })).toBe(true)
  })

  it("returns true from the ANTHROPIC_API_KEY env when the config key is empty", () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"
    expect(hasAnthropicApiKey({ apiKey: "" })).toBe(true)
  })

  it("returns false when neither config nor env provides a trimmed key", () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(hasAnthropicApiKey({ apiKey: "" })).toBe(false)
    expect(hasAnthropicApiKey({ apiKey: "   " })).toBe(false)
    process.env.ANTHROPIC_API_KEY = "   "
    expect(hasAnthropicApiKey({ apiKey: "" })).toBe(false)
  })
})

describe("isExplicitUserSelection", () => {
  it("is true only for the literal true value", () => {
    expect(isExplicitUserSelection({ explicitProviderSelection: true })).toBe(true)
    expect(isExplicitUserSelection({ explicitProviderSelection: false })).toBe(false)
    expect(isExplicitUserSelection({})).toBe(false)
  })
})
