// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { resolveConfig } from "@/lib/llm-config/preset-resolver"
import { LLM_PRESETS } from "@/lib/llm-config/llm-presets"
import type { LlmConfig, ProviderConfigs } from "@/stores/wiki-store"

/**
 * 解析 AI 会话当前生效的 LLM 配置（chat-panel 拆分 T1）。
 *
 * 原先 `handleSend` 与 `handleContinueUnfinished` 各自内联了逐字相同的解析块，
 * 此处提取为纯函数，行为逐字保留：
 * - `aiChatModel` 为空（含纯空白）时直接返回传入的 `llmConfig`（不克隆）。
 * - `providerId/modelId` 形式优先精确匹配 provider 的 savedModels，命中后按
 *   preset 模板合并 baseUrl/apiKey/apiMode 并覆盖 model。
 * - 否则按纯模型名遍历 providerConfigs（兼容旧数据），命中后 break。
 *
 * 注意：不要改成 `{ ...llmConfig }` 克隆 —— 调用方依赖「空白时原样返回」。
 */
export function resolveEffectiveChatLlmConfig(params: {
  aiChatModel: string
  llmConfig: LlmConfig
  providerConfigs: ProviderConfigs
}): LlmConfig {
  const { aiChatModel, llmConfig, providerConfigs } = params
  // AI 会话选中的 model 名（如 "deepseek-v3"）需要找到它所属的 provider
  // 重新计算 baseUrl/apiKey/apiMode，否则会沿用 activePresetId 的配置
  // 导致跨 provider 调用失败
  let effectiveChatLlmConfig = llmConfig
  if (aiChatModel.trim()) {
    const targetModel = aiChatModel.trim()
    // 优先按 "providerId/modelId" 格式精确匹配
    const slashIdx = targetModel.indexOf("/")
    if (slashIdx > 0) {
      const providerId = targetModel.slice(0, slashIdx)
      const modelId = targetModel.slice(slashIdx + 1)
      const override = providerConfigs[providerId]
      if (override?.savedModels?.some((m) => m.model === modelId)) {
        const template =
          LLM_PRESETS.find((p) => p.id === providerId) ??
          LLM_PRESETS.find((p) => p.id === "custom")
        /* v8 ignore next */
        if (template) {
          effectiveChatLlmConfig = {
            ...resolveConfig(template, override, llmConfig),
            model: modelId,
          }
        }
      } else {
        effectiveChatLlmConfig = { ...llmConfig, model: modelId }
      }
    } else {
      // 回退：按纯模型名匹配（兼容旧数据）
      let matched = false
      for (const [providerId, override] of Object.entries(providerConfigs)) {
        /* v8 ignore next */
        if (override.savedModels?.some((m) => m.model === targetModel)) {
          const template =
            LLM_PRESETS.find((p) => p.id === providerId) ??
            LLM_PRESETS.find((p) => p.id === "custom")
          /* v8 ignore next */
          if (template) {
            effectiveChatLlmConfig = {
              ...resolveConfig(template, override, llmConfig),
              model: targetModel,
            }
          }
          matched = true
          break
        }
      }
      if (!matched) {
        effectiveChatLlmConfig = { ...llmConfig, model: targetModel }
      }
    }
  }
  return effectiveChatLlmConfig
}
