/**
 * Single source of truth for LLM configuration usability checks.
 * Determines whether the user's LLM settings are sufficient to
 * make API calls, replacing ad-hoc provider/key checks scattered
 * across ingest, sweep, lint, chat, and clip-watcher.
 * MIT License — independently implemented.
 */

import type { LlmConfig } from "@/stores/wiki-store"

export type LlmProvider = LlmConfig["provider"]

/**
 * Providers that operate without an API key:
 * - `ollama` — local HTTP endpoint, no auth.
 * - `custom` — OpenAI-compatible local/LAN endpoint (LM Studio, llama.cpp, vLLM).
 * - `claude-code` — spawns the Claude Code CLI; auth via ~/.claude OAuth.
 * - `codex-cli` — spawns the Codex CLI; auth via Codex/ChatGPT login.
 */
export const PROVIDERS_WITHOUT_KEY: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  "ollama",
  "custom",
  "claude-code",
  "codex-cli",
])

/** True when the value is a non-empty, non-whitespace string. */
function isNonEmpty(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Check whether the given LLM configuration is usable.
 *
 * Rules by provider:
 * - `custom` — needs model + customEndpoint
 * - `ollama` — needs model + ollamaUrl
 * - `azure` — needs apiKey + model + customEndpoint
 * - `claude-code` / `codex-cli` — always usable (CLI inherits default model)
 * - hosted (`openai`, `anthropic`, `google`, `minimax`) — needs apiKey + model
 *
 * The exhaustiveness check ensures new providers are handled explicitly.
 */
export function hasUsableLlm(
  cfg: Pick<LlmConfig, "provider" | "apiKey" | "model">
    & Partial<Pick<LlmConfig, "customEndpoint" | "ollamaUrl">>,
  _providerConfigs?: unknown,
): boolean {
  switch (cfg.provider) {
    case "custom":
      return isNonEmpty(cfg.model) && isNonEmpty(cfg.customEndpoint)
    case "ollama":
      return isNonEmpty(cfg.model) && isNonEmpty(cfg.ollamaUrl)
    case "azure":
      return isNonEmpty(cfg.apiKey) && isNonEmpty(cfg.model) && isNonEmpty(cfg.customEndpoint)
    case "claude-code":
    case "codex-cli":
      return true
    case "openai":
    case "anthropic":
    case "google":
    case "minimax":
      return isNonEmpty(cfg.apiKey) && isNonEmpty(cfg.model)
    case "cursor-cli":
      // 本地 proxy 通道：无需 API key；有模型即可视为可用
      return isNonEmpty(cfg.model)
    default: {
      const _exhaustive: never = cfg.provider
      return _exhaustive
    }
  }
}
