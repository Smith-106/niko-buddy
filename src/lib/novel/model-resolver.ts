import { useWikiStore, type LlmConfig, type NovelConfig, type ProviderOverride, type ProviderConfigs } from "@/stores/wiki-store"
import { LLM_PRESETS } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"

export type NovelTaskType = "writing" | "review" | "summary" | "extract" | "lint"

export function resolveModelConfig(
  targetModel: string,
  baseConfig: LlmConfig,
  providerConfigs: Record<string, ProviderOverride>,
): LlmConfig {
  // 优先按 "providerId/modelId" 格式精确匹配
  const slashIdx = targetModel.indexOf("/")
  if (slashIdx > 0) {
    const providerId = targetModel.slice(0, slashIdx)
    const modelId = targetModel.slice(slashIdx + 1)
    const override = providerConfigs[providerId]
    if (override?.savedModels?.some((m) => m.model === modelId)) {
      const template = LLM_PRESETS.find((p) => p.id === providerId) ?? LLM_PRESETS.find((p) => p.id === "custom")
      /* v8 ignore next */
      if (template) {
        return { ...resolveConfig(template, override, baseConfig), model: modelId }
      }
    }
    return { ...baseConfig, model: modelId }
  }
  // 回退：按纯模型名匹配（兼容旧数据）
  for (const [providerId, override] of Object.entries(providerConfigs)) {
    if (override.savedModels?.some((m) => m.model === targetModel)) {
      const template = LLM_PRESETS.find((p) => p.id === providerId) ?? LLM_PRESETS.find((p) => p.id === "custom")
      /* v8 ignore next */
      if (template) {
        return { ...resolveConfig(template, override, baseConfig), model: targetModel }
      }
    }
  }
  return { ...baseConfig, model: targetModel }
}

/**
 * 解析后台任务的默认模型。
 * 优先级：defaultLlmModel > aiChatModel > baseConfig
 * 用于提取记忆、提取角色等后台 AI 任务。
 */
/**
 * ISS-20260709-023 (DC-7) 渐进式 DI: store 字段子集注入。缺省回退
 * useWikiStore.getState() 保持向后兼容。
 */
export interface ModelResolverStoreSnapshot {
  providerConfigs?: ProviderConfigs
  defaultLlmModel?: string
  aiChatModel?: string
}

export function resolveDefaultModel(baseConfig: LlmConfig, storeSnapshot?: ModelResolverStoreSnapshot): LlmConfig {
  const { providerConfigs, defaultLlmModel, aiChatModel } = storeSnapshot
    ? {
        providerConfigs: storeSnapshot.providerConfigs ?? useWikiStore.getState().providerConfigs,
        defaultLlmModel: storeSnapshot.defaultLlmModel ?? useWikiStore.getState().defaultLlmModel,
        aiChatModel: storeSnapshot.aiChatModel ?? useWikiStore.getState().aiChatModel,
      }
    : useWikiStore.getState()
  const targetModel = defaultLlmModel?.trim() || aiChatModel?.trim()
  if (targetModel) {
    return resolveModelConfig(targetModel, baseConfig, providerConfigs)
  }
  return baseConfig
}

export function resolveNovelModel(
  llmConfig: LlmConfig,
  novelConfig: NovelConfig,
  taskType: NovelTaskType,
  storeSnapshot?: ModelResolverStoreSnapshot,
): LlmConfig {
  const modelMap: Record<NovelTaskType, string> = {
    writing: "", // 写作模型已移除，始终使用 AI 会话当前模型
    review: novelConfig.reviewModel,
    summary: novelConfig.summaryModel,
    extract: novelConfig.extractModel,
    lint: novelConfig.reviewModel,
  }

  const { providerConfigs, defaultLlmModel, aiChatModel } = storeSnapshot
    ? {
        providerConfigs: storeSnapshot.providerConfigs ?? useWikiStore.getState().providerConfigs,
        defaultLlmModel: storeSnapshot.defaultLlmModel ?? useWikiStore.getState().defaultLlmModel,
        aiChatModel: storeSnapshot.aiChatModel ?? useWikiStore.getState().aiChatModel,
      }
    : useWikiStore.getState()

  const taskModel = modelMap[taskType]
  if (!taskModel) {
    // 没有指定任务模型时：优先使用 AI 会话当前模型，再回退到默认模型
    const targetModel = aiChatModel?.trim() || defaultLlmModel?.trim()
    if (targetModel) {
      return resolveModelConfig(targetModel, llmConfig, providerConfigs)
    }
    return llmConfig
  }

  return resolveModelConfig(taskModel, llmConfig, providerConfigs)
}

/**
 * 多模型共识（consensus feature）：把 "providerId/modelId" 模型名数组逐个解析为
 * 独立 LlmConfig。空数组或全部解析失败时回退 reviewModel 单模型路径（返回长度 1），
 * 保证共识执行器在配置缺失时退化为现状行为。
 */
export function resolveConsensusModels(
  models: string[],
  llmConfig: LlmConfig,
  novelConfig: NovelConfig,
  storeSnapshot?: ModelResolverStoreSnapshot,
): LlmConfig[] {
  const cleaned = models.map((m) => m.trim()).filter(Boolean)
  if (cleaned.length === 0) {
    // 空配置回退：与审查单模型同一路径（reviewModel，可能仍为空 → 调用方 hasUsableLlm 兜底）
    return [resolveNovelModel(llmConfig, novelConfig, "review", storeSnapshot)]
  }
  const { providerConfigs } = storeSnapshot
    ? { providerConfigs: storeSnapshot.providerConfigs ?? useWikiStore.getState().providerConfigs }
    : { providerConfigs: useWikiStore.getState().providerConfigs }
  const resolved = cleaned.map((model) => resolveModelConfig(model, llmConfig, providerConfigs))
  return resolved.length > 0 ? resolved : [llmConfig]
}
