import type { LlmConfig, ProviderConfigs } from "@/stores/wiki-store"

const trimEnv = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : ""
}

// 环境变量双名兼容：VITE_NIKOBUDDY_LLM_* 优先，VITE_QMAI_LLM_* 旧名回退（不破坏既有 .env）
const readEnv = (suffix: string): string => {
  return (
    trimEnv(import.meta.env[`VITE_NIKOBUDDY_LLM_${suffix}`]) ||
    trimEnv(import.meta.env[`VITE_QMAI_LLM_${suffix}`])
  )
}

const readContextSize = (): number => {
  const raw = Number(readEnv("CONTEXT_SIZE"))
  return Number.isFinite(raw) && raw > 0 ? raw : 204800
}

export function loadEnvLlmDefault(): {
  config: LlmConfig
  providerConfigs: ProviderConfigs
  activePresetId: string
} | null {
  const apiKey = readEnv("API_KEY")
  const customEndpoint = readEnv("ENDPOINT")
  const model = readEnv("MODEL")

  if (!apiKey || !customEndpoint || !model) return null

  const maxContextSize = readContextSize()
  const config: LlmConfig = {
    provider: "custom",
    apiKey,
    model,
    ollamaUrl: "http://localhost:11434",
    customEndpoint,
    maxContextSize,
    apiMode: "chat_completions",
    reasoning: { mode: "auto" },
  }

  return {
    config,
    providerConfigs: {
      custom: {
        apiKey,
        model,
        baseUrl: customEndpoint,
        apiMode: "chat_completions",
        maxContextSize,
        reasoning: { mode: "auto" },
      },
    },
    activePresetId: "custom",
  }
}
