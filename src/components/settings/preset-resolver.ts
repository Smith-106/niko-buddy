import type { LlmConfig } from "@/stores/wiki-store"
import type { ProviderOverride } from "@/stores/wiki-store"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import type { LlmPreset } from "./llm-presets"

/**
 * Build a full LlmConfig from a preset template + the user's saved
 * override fields for that preset. Falls back to the preset defaults
 * (or the existing LlmConfig) when an override is missing.
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
    // Subprocess transport — no apiKey, no endpoint URL. Model id is
    // passed straight to the local CLI's model flag when the user
    // explicitly sets one. Leaving it empty lets the local CLI use the
    // machine's own configured default model.
    //
    // F-004 (ANL-010 f004_correction): mark this as an explicit user
    // selection so `resolveProviderOverride` in llm-client.ts does NOT
    // reroute a user who deliberately picked the CLI/OAuth subprocess path
    // over to the anthropic HTTP case, even if an ANTHROPIC_API_KEY happens
    // to be present in the environment.
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

  // openai / anthropic / google / minimax — use fixed endpoint baked into the
  // provider dispatch. We still let users override baseUrl via apiKey env if
  // needed by editing manually, but presets for these don't expose it.
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
 * F-004 (S3 / ANL-010 f004_correction): does this config carry a usable
 * Anthropic API key? The key may live on the config (user pasted it into
 * the anthropic/claude-code settings) or in the `ANTHROPIC_API_KEY` env
 * var. Read-only; the key is never logged or exposed beyond this check.
 *
 * Note: the `claude-code-cli` preset forces `apiKey: ""` (see resolveConfig
 * above), so a non-empty apiKey on a `claude-code` config means the user
 * manually added one OR it was inherited from a fallback/config migration.
 */
export function hasAnthropicApiKey(config: Pick<LlmConfig, "apiKey">): boolean {
  const fromConfig = typeof config.apiKey === "string" && config.apiKey.trim().length > 0
  if (fromConfig) return true
  // Env-var fallback lets power users route via API key without touching the
  // settings UI (CI, portable builds, scripted runs).
  const fromEnv = typeof process !== "undefined"
    && typeof process.env?.ANTHROPIC_API_KEY === "string"
    && process.env.ANTHROPIC_API_KEY.trim().length > 0
  return fromEnv
}

/**
 * F-004: true when the user explicitly chose this provider in the settings
 * dropdown (preset-resolver sets `explicitProviderSelection: true` for every
 * preset it resolves). Carry-over/legacy configs without the field are
 * treated as NOT explicitly selected so the routing override can still fire
 * for them.
 */
export function isExplicitUserSelection(config: Pick<LlmConfig, "explicitProviderSelection">): boolean {
  return config.explicitProviderSelection === true
}

/**
 * F-004 (ANL-010 f004_correction — BS-003 "zero new code" claim corrected to
 * "new routing logic"): determine the EFFECTIVE provider for a resolved
 * LlmConfig. This is the SA-02 fallback target hook point referenced by
 * TASK-001's SessionTransportFallback.
 *
 * Routing rule (explicit-user-selection precedence preserved):
 *   - If provider is `claude-code` (the subprocess/OAuth default) AND an
 *     Anthropic API key is present AND the user did NOT explicitly select
 *     `claude-code` → reroute to `anthropic` so the existing anthropic HTTP
 *     case (llm-providers.ts:709-720, REUSED UNCHANGED) becomes the default
 *     for API-key users.
 *   - Otherwise: return config.provider unchanged (explicit selections,
 *     no-key configs, and already-HTTP providers are left alone).
 *
 * Boundary (ANL-009 NO-GO intact): no direct-API call is added and no OAuth
 * credential is reused — the rerouted path uses the user's OWN apiKey with
 * the sanctioned anthropic HTTP case body that already exists.
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
