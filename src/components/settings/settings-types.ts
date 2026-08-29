// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import type { CustomApiMode } from "./llm-presets"
import type {
  AzureModelFamily,
  ReasoningConfig,
  SourceWatchConfig,
  RevisionFeedbackWindowConfig,
  NovelConfig,
  RerankConfig,
  OutputLanguage,
} from "@/stores/wiki-store"

/**
 * Draft state shape shared across all settings sections.
 *
 * The parent SettingsView owns a single draft instance and passes it
 * to each section. The Save button commits the entire draft to stores
 * and disk in one atomic flush.
 */
export interface SettingsDraft {
  // ── LLM provider ──
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli" | "cursor-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion: string
  azureModelFamily: AzureModelFamily
  maxContextSize: number
  apiMode: CustomApiMode | undefined
  reasoning: ReasoningConfig | undefined
  localCliIsolation: boolean

  // ── Embedding ──
  embeddingEnabled: boolean
  embeddingEndpoint: string
  embeddingApiKey: string
  embeddingModel: string
  /** Optional Gemini native output_dimensionality. Empty = provider default. */
  embeddingOutputDimensionality: number | undefined
  /** Target characters per chunk. Empty = use chunker default (1000). */
  embeddingMaxChunkChars: number | undefined
  /** Overlap characters between adjacent chunks. Empty = default (200). */
  embeddingOverlapChunkChars: number | undefined

  // ── Multimodal (image captioning at ingest time) ──
  multimodalEnabled: boolean
  multimodalUseMainLlm: boolean
  multimodalProvider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli" | "cursor-cli"
  multimodalApiKey: string
  multimodalModel: string
  multimodalOllamaUrl: string
  multimodalCustomEndpoint: string
  multimodalAzureApiVersion: string
  multimodalAzureModelFamily: AzureModelFamily
  multimodalApiMode: CustomApiMode | undefined
  multimodalConcurrency: number

  // ── Output preferences ──
  outputLanguage: OutputLanguage
  maxHistoryMessages: number

  // ── Network — global outbound HTTP proxy ──
  // Persisted to app-state.json, read by Rust setup hook on app launch.
  // Changes apply after restart. See src/lib/proxy-config.ts.
  proxyEnabled: boolean
  proxyUrl: string
  proxyBypassLocal: boolean

  // ── Scheduled Import ──
  scheduledImportEnabled: boolean
  scheduledImportPath: string
  scheduledImportInterval: number // minutes

  // ── UI ──
  uiLanguage: string
  uiFontSizeScale: number

  // ── Source folder auto watch ──
  sourceWatchConfig: SourceWatchConfig

  // ── Novel feedback window ──
  revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig

  // ── Novel config ──
  novelConfig: NovelConfig

  // ── Retrieval rerank config ──
  rerankConfig: RerankConfig
}

/** Type-safe setter function passed to each settings section. */
export type DraftSetter = <K extends keyof SettingsDraft>(
  key: K,
  value: SettingsDraft[K],
) => void
