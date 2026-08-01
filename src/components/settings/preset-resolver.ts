// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import type { LlmConfig } from "@/stores/wiki-store"
import type { ProviderOverride } from "@/stores/wiki-store"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import type { LlmPreset } from "./llm-presets"

/**
 * Resolve a full LlmConfig by merging a preset template with the user's
 * saved override fields. Missing overrides fall back to preset defaults
 * or the existing config.
 */
export function resolveConfig(
  preset: LlmPreset,
  override: ProviderOverride | undefined,
  fallback: LlmConfig,
): LlmConfig {
  const ov = override ?? {}
  const apiKey = ov.apiKey ?? ""
  const model = ov.model?.trim() || preset.defaultModel || ""
  const maxContextSize =
    ov.maxContextSize ?? preset.suggestedContextSize ?? fallback.maxContextSize
  const reasoning = ov.reasoning ?? { mode: "auto" as const }
  const localCliIsolation = ov.localCliIsolation === true
  const codexCliTimeoutMinutes =
    typeof ov.codexCliTimeoutMinutes === "number" && Number.isFinite(ov.codexCliTimeoutMinutes)
      ? Math.max(1, Math.min(240, Math.floor(ov.codexCliTimeoutMinutes)))
      : undefined

  if (preset.provider === "custom") {
    return {
      provider: "custom",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      maxContextSize,
      apiMode: ov.apiMode ?? preset.apiMode ?? "chat_completions",
      reasoning,
      localCliIsolation: false,
    }
  }

  if (preset.provider === "ollama") {
    return {
      provider: "ollama",
      apiKey: "",
      model,
      ollamaUrl: ov.baseUrl ?? preset.baseUrl ?? "http://localhost:11434",
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
      localCliIsolation: false,
    }
  }

  if (preset.provider === "azure") {
    return {
      provider: "azure",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      azureApiVersion: ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
      azureModelFamily: ov.azureModelFamily ?? preset.azureModelFamily ?? "auto",
      maxContextSize,
      reasoning,
      localCliIsolation: false,
    }
  }

  if (preset.provider === "claude-code" || preset.provider === "codex-cli") {
    // Subprocess transport — no API key or endpoint URL needed.
    // Model id is forwarded to the local CLI's model flag; leaving it
    // empty lets the CLI use its own default model.
    //
    // Mark as explicit user selection so provider routing does NOT
    // reroute a user who deliberately picked the CLI subprocess path
    // over to the anthropic HTTP case.
    return {
      provider: preset.provider,
      apiKey: "",
      model: ov.model?.trim() || "",
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
      localCliIsolation,
      codexCliTimeoutMinutes: preset.provider === "codex-cli" ? codexCliTimeoutMinutes : undefined,
      explicitProviderSelection: true,
    }
  }

  // openai / anthropic / google / minimax — fixed endpoint baked into
  // the provider dispatch layer.
  return {
    provider: preset.provider,
    apiKey,
    model,
    ollamaUrl: fallback.ollamaUrl,
    customEndpoint: fallback.customEndpoint,
    maxContextSize,
    reasoning,
    localCliIsolation: false,
  }
}

/**
 * Check whether the config carries a usable Anthropic API key.
 * The key may come from the config directly or from the
 * `ANTHROPIC_API_KEY` environment variable.
 */
export function hasAnthropicApiKey(config: Pick<LlmConfig, "apiKey">): boolean {
  const fromConfig = typeof config.apiKey === "string" && config.apiKey.trim().length > 0
  if (fromConfig) return true

  const fromEnv = typeof process !== "undefined"
    && typeof process.env?.ANTHROPIC_API_KEY === "string"
    && process.env.ANTHROPIC_API_KEY.trim().length > 0
  return fromEnv
}

/**
 * Returns true when the user explicitly chose this provider in settings.
 * Carry-over / legacy configs without the flag are treated as NOT
 * explicitly selected so the routing override can still fire.
 */
export function isExplicitUserSelection(config: Pick<LlmConfig, "explicitProviderSelection">): boolean {
  return config.explicitProviderSelection === true
}

/**
 * Determine the effective provider for a resolved LlmConfig.
 *
 * Routing rule:
 *   - If provider is `claude-code` AND an Anthropic API key is present
 *     AND the user did NOT explicitly select `claude-code` → reroute
 *     to `anthropic` so the existing HTTP case becomes the default.
 *   - Otherwise: return config.provider unchanged.
 */
export function resolveProviderOverride(config: LlmConfig): LlmConfig["provider"] {
  if (
    config.provider === "claude-code"
    && hasAnthropicApiKey(config)
    && !isExplicitUserSelection(config)
  ) {
    return "anthropic"
  }
  return config.provider
}
