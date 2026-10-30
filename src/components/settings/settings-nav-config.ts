// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/**
 * 设置页静态配置：侧栏分组、各分类的保存方式、三域对应的 draft 键。
 * settings-view.tsx 只做编排，静态表放这里（REFACTOR_AUDIT F1–F15 边界）。
 */
import type { SettingsCategoryId } from "@/stores/wiki-store"
import type { SettingsDraft } from "./settings-types"

/** B 波三域分存：每个设置分类恰属一域，保存按域隔离。 */
export type SettingsDomain = "model" | "storage" | "interface"

/**
 * 分类的保存方式，决定底部保存栏怎么显示：
 * - draft：改动先进草稿，点"保存"才落盘（显示保存栏）。
 * - auto：改动即时生效（只显示"自动保存"说明，不显示按钮）。
 * - none：没有可保存的设置（不显示保存栏）。
 */
export type SettingsSaveMode = "draft" | "auto" | "none"

export const SETTINGS_SAVE_MODE: Record<SettingsCategoryId, SettingsSaveMode> = {
  llm: "draft",
  rerank: "draft",
  embedding: "draft",
  network: "draft",
  interface: "draft",
  novel: "draft",
  mcp: "auto",
  "skill-library": "none",
  "usage-guide": "none",
  maintenance: "none",
  "data-management": "none",
  feedback: "none",
  "contact-support": "none",
  changelog: "none",
}

export interface SettingsNavGroup {
  id: "models" | "writing" | "app" | "data" | "help"
  labelKey: string
  categories: readonly SettingsCategoryId[]
}

/** 侧栏分组顺序。每个分类恰好出现一次（settings-nav-config.spec 校验）。 */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  { id: "models", labelKey: "settings.navGroups.models", categories: ["llm", "rerank", "embedding", "mcp"] },
  { id: "writing", labelKey: "settings.navGroups.writing", categories: ["novel", "skill-library"] },
  { id: "app", labelKey: "settings.navGroups.app", categories: ["interface", "network"] },
  { id: "data", labelKey: "settings.navGroups.data", categories: ["data-management", "maintenance"] },
  { id: "help", labelKey: "settings.navGroups.help", categories: ["usage-guide", "feedback", "contact-support", "changelog"] },
]

/**
 * 每个域的保存函数实际写回的 draft 键。用于"未保存改动"提示，
 * 以及保存成功后只清本域的已改动标记。
 */
export const SETTINGS_DOMAIN_DRAFT_KEYS: Record<SettingsDomain, readonly (keyof SettingsDraft)[]> = {
  model: [
    "provider",
    "apiKey",
    "model",
    "ollamaUrl",
    "customEndpoint",
    "azureApiVersion",
    "azureModelFamily",
    "maxContextSize",
    "apiMode",
    "reasoning",
    "localCliIsolation",
    "embeddingEnabled",
    "embeddingEndpoint",
    "embeddingApiKey",
    "embeddingModel",
    "embeddingOutputDimensionality",
    "embeddingMaxChunkChars",
    "embeddingOverlapChunkChars",
    "rerankConfig",
    "multimodalEnabled",
    "multimodalUseMainLlm",
    "multimodalProvider",
    "multimodalApiKey",
    "multimodalModel",
    "multimodalOllamaUrl",
    "multimodalCustomEndpoint",
    "multimodalAzureApiVersion",
    "multimodalAzureModelFamily",
    "multimodalApiMode",
    "multimodalConcurrency",
  ],
  storage: [
    "proxyEnabled",
    "proxyUrl",
    "proxyBypassLocal",
    "sourceWatchConfig",
    "scheduledImportEnabled",
    "scheduledImportPath",
    "scheduledImportInterval",
    "revisionFeedbackWindowConfig",
    "novelConfig",
    "maxHistoryMessages",
  ],
  interface: ["outputLanguage", "uiLanguage", "uiFontSizeScale"],
}
