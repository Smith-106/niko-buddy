// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, afterEach } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { LLM_PRESETS } from "./llm-presets"
import {
  hasAnthropicApiKey,
  isExplicitUserSelection,
  resolveConfig,
  resolveProviderOverride,
} from "./preset-resolver"

const fallback: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
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
  // Restore env between tests so ANTHROPIC_API_KEY leakage can't cause flaky results.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k]
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v
  }
})

describe("F-004 resolveProviderOverride — API-key anthropic HTTP default routing", () => {
  it("reroutes claude-code (default, no explicit selection) to anthropic when an apiKey is present", () => {
    // Carry-over / legacy claude-code config that acquired an Anthropic API
    // key but was NOT explicitly selected in the dropdown. The override must
    // reroute it to the anthropic HTTP case.
    const config: LlmConfig = {
      ...fallback,
      provider: "claude-code",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      explicitProviderSelection: false,
    }
    expect(resolveProviderOverride(config)).toBe("anthropic")
  })

  it("reroutes claude-code to anthropic when the key comes from ANTHROPIC_API_KEY env (config apiKey empty)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env"
    const config: LlmConfig = {
      ...fallback,
      provider: "claude-code",
      apiKey: "", // claude-code-cli preset forces empty
      model: "",
      explicitProviderSelection: false,
    }
    expect(hasAnthropicApiKey(config)).toBe(true)
    expect(resolveProviderOverride(config)).toBe("anthropic")
  })

  it("preserves explicit claude-code selection — NOT rerouted even with an apiKey present", () => {
    // The user deliberately picked the subprocess/OAuth CLI path.
    // Explicit-selection precedence: the override must NOT fire.
    const config: LlmConfig = {
      ...fallback,
      provider: "claude-code",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      explicitProviderSelection: true,
    }
    expect(isExplicitUserSelection(config)).toBe(true)
    expect(resolveProviderOverride(config)).toBe("claude-code")
  })

  it("does not reroute claude-code when no Anthropic API key is available", () => {
    delete process.env.ANTHROPIC_API_KEY
    const config: LlmConfig = {
      ...fallback,
      provider: "claude-code",
      apiKey: "",
      model: "",
      explicitProviderSelection: false,
    }
    expect(hasAnthropicApiKey(config)).toBe(false)
    expect(resolveProviderOverride(config)).toBe("claude-code")
  })

  it("leaves already-HTTP providers unchanged (no spurious override)", () => {
    const anthropic: LlmConfig = { ...fallback, provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-6" }
    const openai: LlmConfig = { ...fallback, provider: "openai", apiKey: "sk-oai", model: "gpt-4o" }
    expect(resolveProviderOverride(anthropic)).toBe("anthropic")
    expect(resolveProviderOverride(openai)).toBe("openai")
  })

  it("marks claude-code-cli / codex-cli presets as explicit user selections", () => {
    // resolveConfig must carry explicitProviderSelection: true for CLI
    // providers so the routing override never silently reroutes a user
    // who picked the CLI preset.
    const claude = resolveConfig(preset("claude-code-cli"), { localCliIsolation: true }, fallback)
    expect(claude.provider).toBe("claude-code")
    expect(claude.explicitProviderSelection).toBe(true)
    // Even with an env key present, an explicitly-selected CLI preset is preserved.
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"
    expect(resolveProviderOverride(claude)).toBe("claude-code")

    const codex = resolveConfig(preset("codex-cli"), { localCliIsolation: true }, fallback)
    expect(codex.provider).toBe("codex-cli")
    expect(codex.explicitProviderSelection).toBe(true)
    expect(resolveProviderOverride(codex)).toBe("codex-cli")
  })
})
