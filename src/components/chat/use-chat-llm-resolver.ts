// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useCallback } from "react"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { LLM_PRESETS } from "@/components/settings/llm-presets"
import type { LlmConfig, ProviderOverride } from "@/stores/wiki-store"

/**
 * Resolves the effective chat LLM config based on the user-selected aiChatModel.
 *
 * The aiChatModel string can be in two formats:
 * - "providerId/modelId" (preferred, e.g. "deepseek/deepseek-v3")
 * - "modelId" (legacy fallback, searches all providers)
 *
 * When a matching provider is found, the config is merged with the provider's
 * saved settings (baseUrl, apiKey, apiMode etc.) via resolveConfig().
 * If no match, only the model field is overridden.
 *
 * Extracted from chat-panel.tsx to eliminate duplication between handleSend
 * and handleContinueUnfinished, which contained identical resolution logic.
 */
export function useChatLlmResolver() {
  const resolveEffectiveLlmConfig = useCallback(
    (params: {
      aiChatModel: string
      llmConfig: LlmConfig
      providerConfigs: Record<string, ProviderOverride>
    }) => {
      const { aiChatModel, llmConfig, providerConfigs } = params
      let effectiveConfig: LlmConfig = { ...llmConfig }

      if (!aiChatModel.trim()) {
        return effectiveConfig
      }

      const targetModel = aiChatModel.trim()
      const slashIdx = targetModel.indexOf("/")

      if (slashIdx > 0) {
        // "providerId/modelId" format — precise match
        const providerId = targetModel.slice(0, slashIdx)
        const modelId = targetModel.slice(slashIdx + 1)
        const override = providerConfigs[providerId]
        if (override?.savedModels?.some((m) => m.model === modelId)) {
          const template =
            LLM_PRESETS.find((p) => p.id === providerId) ??
            LLM_PRESETS.find((p) => p.id === "custom")
          if (template) {
            effectiveConfig = {
              ...resolveConfig(template, override, llmConfig),
              model: modelId,
            }
          }
        } else {
          effectiveConfig = { ...llmConfig, model: modelId }
        }
      } else {
        // Legacy fallback: model name only — search all providers
        let matched = false
        for (const [providerId, override] of Object.entries(providerConfigs)) {
          if (override.savedModels?.some((m) => m.model === targetModel)) {
            const template =
              LLM_PRESETS.find((p) => p.id === providerId) ??
              LLM_PRESETS.find((p) => p.id === "custom")
            if (template) {
              effectiveConfig = {
                ...resolveConfig(template, override, llmConfig),
                model: targetModel,
              }
            }
            matched = true
            break
          }
        }
        if (!matched) {
          effectiveConfig = { ...llmConfig, model: targetModel }
        }
      }

      return effectiveConfig
    },
    [],
  )

  return { resolveEffectiveLlmConfig }
}
