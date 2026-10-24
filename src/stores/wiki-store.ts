// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Central application store — project state, LLM config, UI preferences and task lifecycle.

import { create } from "zustand"
import type { McpConfig } from "@/lib/mcp/config"
import type { WikiProject, FileNode } from "@/types/wiki"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"
import type { TrashItem } from "@/lib/trash"
import { CHAT_DOCK_POSITION_KEY, FOCUS_MODE_KEY, OFFLINE_MODE_KEY, UI_FONT_SIZE_SCALE_KEY } from "./wiki-store-config"

import type {
  ChatDockPosition, SettingsCategoryId,
  RerankConfig, NovelConfig,
  RevisionFeedbackWindowConfig, ProviderConfigs,
  FinalChapterSaveState, LintRunState, ReviewRunState, PendingEditorHighlight,
  LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig,
  ScheduledImportConfig, SourceWatchConfig, LintRunFinishState, ReviewRunFinishState,
} from "./wiki-store-config"
import {
  DEFAULT_RERANK_CONFIG, DEFAULT_NOVEL_CONFIG,
  readStoredChatDockPosition, readStoredUiFontSizeScale, readStoredFocusMode, readStoredGraphLabelDisplayMode,
  readStoredGraphEdgeColorHex, readStoredGraphEdgeStrengthPercent, readStoredGraphEdgeStyle,
  readStoredGraphEdgeLabelsAlways, confirmDiscardSkillLibraryDraft,
} from "./wiki-store-config"
export type {
  ChatDockPosition, SettingsCategoryId, CustomApiMode, AzureModelFamily, ReasoningMode, ReasoningConfig,
  SearchProvider, SerpApiEngine, SearXngCategory, SearchProviderOverride, SearchProviderConfigs, RerankConfig,
  TaskPromptKey, NovelConfig, RevisionFeedbackWindowConfig, SavedModel, ProviderOverride, ProviderConfigs,
  FinalChapterSavePhase, FinalChapterSaveState, LintRunState, ReviewRunState, PendingEditorHighlight,
  LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig,
  ScheduledImportConfig, SourceWatchConfig,
} from "./wiki-store-config"
export {
  DEFAULT_RERANK_CONFIG, TASK_PROMPT_KEYS, DEFAULT_NOVEL_CONFIG, confirmDiscardSkillLibraryDraft,
} from "./wiki-store-config"


export interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  selectedTrashItem: TrashItem | null
  fileContent: string
  pendingEditorHighlight: PendingEditorHighlight | null
  /**
   * One-shot scroll target for the markdown preview image jump.
   * Consumed on next render and cleared back to null.
   */
  pendingScrollImageSrc: string | null
  selectedMemoryCenterEntry: string | null
  chatExpanded: boolean
  chatDockPosition: ChatDockPosition
  searchPanelOpen: boolean
  /** 写作专注模式（additive）：开时隐藏图标侧边栏与侧边面板，编辑区全宽。默认 false。 */
  focusMode: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "soul" | "bookAnalysis" | "settings" | "trash" | "reviewCenter" | "skillLibrary" | "writingSkillLibrary" | "skillFavorites" | "storySimulation" | "backupExport" | "diagnosticsCenter" | "canonEditor" | "director" | "moduleHeatmap" | "pipelineMotion" | "mainControl" | "dataManager" | "workbench" | "followUpCenter" | "liveExecution" | "bookshelf" | "creativeHub" | "knowledgeLibrary" | "worldLibrary" | "genreLibrary" | "storyModeLibrary" | "titleStudio" | "styleEngine" | "antiAiRules" | "modelRoutes" | "mcpManager" | "workflowEditor" | "marketRadar" | "help" | "exportCenter"
  activeSettingsCategory: SettingsCategoryId | null
  selectedSoulId: string | null
  selectedSoulTab: "project" | "character"
  selectedSoulSection: "builtIn" | "custom"
  selectedReviewDimension: string | null
  mcpConfig: McpConfig | null
  selectedReviewFilePath: string
  /** Per-chapter thril soft-gate explicit acknowledge ("0" if unknown). Not a FIX-1 bypass. */
  thrilSoftGateAcknowledgedByChapter: Record<string, boolean>
  selectedDismantlingProjectId: string | null
  graphMode: string
  graphDisplayMode: string
  graphColorMode: string
  graphLabelDisplayMode: string
  graphShowFilters: boolean
  graphShowEdgeControls: boolean
  graphEdgeStyle: string
  graphEdgeColorHex: string
  graphEdgeStrengthPercent: number
  graphEdgeLabelsAlwaysVisible: boolean
  graphStats: { nodeCount: number; edgeCount: number; hiddenCount: number; filteredNodeCount: number; filteredEdgeCount: number }
  refreshGraph: (() => void) | null
  llmConfig: LlmConfig
  aiChatModel: string
  /** Default model for background tasks (format: "providerId/modelId"). */
  defaultLlmModel: string
  providerConfigs: ProviderConfigs
  activePresetId: string | null
  searchApiConfig: SearchApiConfig
  embeddingConfig: EmbeddingConfig
  rerankConfig: RerankConfig
  multimodalConfig: MultimodalConfig
  outputLanguage: OutputLanguage
  proxyConfig: ProxyConfig
  scheduledImportConfig: ScheduledImportConfig
  sourceWatchConfig: SourceWatchConfig
  novelMode: boolean
  chatEditModeEnabled: boolean
  novelConfig: NovelConfig
  /** Community summary error message for UI toast display. */
  communitySummaryError: string | null
  searchHistory: string[]
  searchTrigger: { query: string; ts: number } | null
  revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig
  finalChapterSave: FinalChapterSaveState | null
  lintRun: LintRunState | null
  reviewRun: ReviewRunState | null
  /** G4 (39 号修复): 当前六维审查的 AbortController, 供 cancelReviewRun 级联 abort。 */
  reviewRunAbortController: AbortController | null
  theme: "light" | "dark" | "deep-blue" | "eye-care" | "system"
  uiFontSizeScale: number
  dataVersion: number
  /** 空态「新建章节」跨面板触发：preview 空态按钮 +1，sidebar 订阅后调已有 handleCreateNextChapter。 */
  chapterCreateNonce: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setSelectedTrashItem: (item: TrashItem | null) => void
  setFileContent: (content: string) => void
  setPendingEditorHighlight: (highlight: PendingEditorHighlight | null) => void
  setPendingScrollImageSrc: (src: string | null) => void
  setSelectedMemoryCenterEntry: (entry: string | null) => void
  setChatExpanded: (expanded: boolean) => void
  setChatDockPosition: (position: ChatDockPosition) => void
  setSearchPanelOpen: (open: boolean) => void
  setFocusMode: (enabled: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setActiveSettingsCategory: (category: SettingsCategoryId | null) => void
  setSelectedSoulId: (id: string | null) => void
  setSelectedSoulTab: (tab: "project" | "character") => void
  setSelectedSoulSection: (section: "builtIn" | "custom") => void
  selectedSkillLibrarySkillId: string | null
  skillLibraryDraftDirty: boolean
  selectedWritingSkillLibrarySkillId: string | null
  writingSkillLibraryDraftDirty: boolean
  setSelectedSkillLibrarySkillId: (id: string | null) => void
  setSkillLibraryDraftDirty: (dirty: boolean) => void
  setSelectedWritingSkillLibrarySkillId: (id: string | null) => void
  setWritingSkillLibraryDraftDirty: (dirty: boolean) => void
  bindingVersion: number
  bumpBindingVersion: () => void
  setMcpConfig: (mcpConfig: McpConfig) => void
  setSelectedReviewDimension: (dimension: string | null) => void
  setSelectedReviewFilePath: (path: string) => void
  setThrillSoftGateAcknowledged: (chapter: number | null | undefined, acknowledged: boolean) => void
  clearThrillSoftGateAcknowledged: (chapter?: number | null) => void
  setSelectedDismantlingProjectId: (id: string | null) => void
  setGraphMode: (mode: string) => void
  setGraphDisplayMode: (mode: string) => void
  setGraphColorMode: (mode: string) => void
  setGraphLabelDisplayMode: (mode: string) => void
  setGraphShowFilters: (v: boolean) => void
  setGraphShowEdgeControls: (v: boolean) => void
  setGraphEdgeStyle: (style: string) => void
  setGraphEdgeColorHex: (hex: string) => void
  setGraphEdgeStrengthPercent: (pct: number) => void
  setGraphEdgeLabelsAlwaysVisible: (v: boolean) => void
  setGraphStats: (stats: WikiState["graphStats"]) => void
  setRefreshGraph: (refreshGraph: (() => void) | null) => void
  setLlmConfig: (config: LlmConfig) => void
  setAiChatModel: (model: string) => void
  setDefaultLlmModel: (model: string) => void
  setProviderConfigs: (configs: ProviderConfigs) => void
  setActivePresetId: (id: string | null) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setEmbeddingConfig: (config: EmbeddingConfig) => void
  setRerankConfig: (config: Partial<RerankConfig>) => void
  setMultimodalConfig: (config: MultimodalConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  setProxyConfig: (config: ProxyConfig) => void
  setScheduledImportConfig: (config: ScheduledImportConfig) => void
  setSourceWatchConfig: (sourceWatchConfig: SourceWatchConfig) => void
  setNovelMode: (novelMode: boolean) => void
  setChatEditModeEnabled: (enabled: boolean) => void
  setNovelConfig: (config: Partial<NovelConfig>) => void
  setCommunitySummaryError: (error: string | null) => void
  setSearchHistory: (history: string[]) => void
  setSearchTrigger: (trigger: { query: string; ts: number } | null) => void
  setRevisionFeedbackWindowConfig: (revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig) => void
  setFinalChapterSave: (finalChapterSave: FinalChapterSaveState | null) => void
  setLintRun: (lintRun: LintRunState | null) => void
  finishLintRun: (runId: string, lintRun: LintRunFinishState) => void
  setReviewRun: (reviewRun: ReviewRunState | null) => void
  finishReviewRun: (runId: string, reviewRun: ReviewRunFinishState) => void
  /** G4 (39 号修复): 取消当前六维审查 (abort 级联到 streamChat)。 */
  cancelReviewRun: () => void
  clearTransientTaskState: () => void
  setTheme: (theme: "light" | "dark" | "deep-blue" | "eye-care" | "system") => void
  setUiFontSizeScale: (scale: number) => void
  /** G10 (39 号修复): 统一离线模式 — 短路 embedding/rerank 等可选网络依赖。 */
  offlineMode: boolean
  setOfflineMode: (enabled: boolean) => void
  bumpDataVersion: () => void
  requestChapterCreate: () => void
}

// ── Store initialisation ─────────────────────────────────────────────────────────

/**
 * Central Zustand store for the entire application. Holds project state,
 * LLM/embedding/search configuration, UI preferences, and transient
 * async task state (lint runs, review runs, final chapter saves).
 *
 * UI preferences (chat dock position, font scale, graph settings) are
 * round-tripped through `localStorage` so they survive app restarts.
 */
export const useWikiStore = create<WikiState>((set) => ({
  // ── Project & file state ───────────────────────────────────────────────────────
  project: null,
  fileTree: [],
  selectedFile: null,
  selectedTrashItem: null,
  fileContent: "",
  pendingEditorHighlight: null,
  pendingScrollImageSrc: null,
  selectedMemoryCenterEntry: null,
  chatExpanded: false,
  chatDockPosition: readStoredChatDockPosition(),
  searchPanelOpen: false,
  focusMode: readStoredFocusMode(),
  activeView: "wiki",
  bindingVersion: 0,
  selectedSkillLibrarySkillId: null,
  skillLibraryDraftDirty: false,
  selectedWritingSkillLibrarySkillId: null,
  writingSkillLibraryDraftDirty: false,
  activeSettingsCategory: null,
  selectedSoulId: null,
  selectedSoulTab: "project",
  selectedSoulSection: "builtIn",
  selectedReviewDimension: null,
  selectedReviewFilePath: "",
  thrilSoftGateAcknowledgedByChapter: {},
  selectedDismantlingProjectId: null,

  // ── Graph view state ───────────────────────────────────────────────────────────
  graphMode: "overview",
  graphDisplayMode: "graph",
  graphColorMode: "type",
  graphLabelDisplayMode: readStoredGraphLabelDisplayMode(),
  graphShowFilters: false,
  graphShowEdgeControls: false,
  graphEdgeStyle: readStoredGraphEdgeStyle(),
  graphEdgeColorHex: readStoredGraphEdgeColorHex(),
  graphEdgeStrengthPercent: readStoredGraphEdgeStrengthPercent(),
  graphEdgeLabelsAlwaysVisible: readStoredGraphEdgeLabelsAlways(),
  graphStats: { nodeCount: 0, edgeCount: 0, hiddenCount: 0, filteredNodeCount: 0, filteredEdgeCount: 0 },
  refreshGraph: null,

  // ── LLM / provider state ───────────────────────────────────────────────────────
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    azureModelFamily: "auto",
    reasoning: { mode: "auto" },
    localCliIsolation: false,
  },
  aiChatModel: "",
  defaultLlmModel: "",
  providerConfigs: {},
  activePresetId: null,
  dataVersion: 0,
  chapterCreateNonce: 0,

  // ── Search / embedding / rerank ────────────────────────────────────────────────
  searchApiConfig: {
    provider: "none",
    apiKey: "",
    serpApiEngine: "google",
    searXngUrl: "",
    searXngCategories: ["general"],
    providerConfigs: {},
  },
  embeddingConfig: {
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  },
  rerankConfig: { ...DEFAULT_RERANK_CONFIG },
  mcpConfig: null,
  multimodalConfig: {
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    azureModelFamily: "auto",
    apiMode: "chat_completions",
    concurrency: 4,
  },
  outputLanguage: "Chinese",

  // ── Proxy / import / source-watch ──────────────────────────────────────────────
  proxyConfig: { enabled: false, url: "", bypassLocal: true },
  scheduledImportConfig: { enabled: false, path: "", interval: 60, lastScan: null },
  sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG,

  // ── Novel / UI state ───────────────────────────────────────────────────────────
  novelMode: true,
  chatEditModeEnabled: false,
  novelConfig: { ...DEFAULT_NOVEL_CONFIG },
  communitySummaryError: null,
  searchHistory: [],
  searchTrigger: null,
  revisionFeedbackWindowConfig: {
    currentChapterIncludeShouldImprove: true,
    previousChapterCarryEnabled: true,
    lookbackChapterCount: 2,
    lookbackIncludeMustFixOnly: true,
  },
  finalChapterSave: null,
  lintRun: null,
  reviewRun: null,
  reviewRunAbortController: null,
  theme: "system",
  uiFontSizeScale: readStoredUiFontSizeScale(),

  // ── Simple setters ─────────────────────────────────────────────────────────────
  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
  setSelectedFile: (selectedFile) => set({ selectedFile, selectedTrashItem: null }),
  setSelectedTrashItem: (selectedTrashItem) => set({ selectedTrashItem, selectedFile: null }),
  setFileContent: (fileContent) => set({ fileContent }),
  setPendingEditorHighlight: (pendingEditorHighlight) => set({ pendingEditorHighlight }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
  setSelectedMemoryCenterEntry: (selectedMemoryCenterEntry) => set({ selectedMemoryCenterEntry }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setChatDockPosition: (chatDockPosition) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CHAT_DOCK_POSITION_KEY, chatDockPosition)
    }
    set({ chatDockPosition })
  },
  setSearchPanelOpen: (searchPanelOpen) => set({ searchPanelOpen }),
  setFocusMode: (focusMode) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FOCUS_MODE_KEY, focusMode ? "1" : "0")
    }
    set({ focusMode })
  },
  setActiveView: (activeView) => set((state) => {
    if (
      state.activeView === "skillLibrary"
      && activeView !== "skillLibrary"
      && state.skillLibraryDraftDirty
      && !confirmDiscardSkillLibraryDraft()
    ) {
      return {}
    }
    if (
      state.activeView === "writingSkillLibrary"
      && activeView !== "writingSkillLibrary"
      && state.writingSkillLibraryDraftDirty
      && !confirmDiscardSkillLibraryDraft()
    ) {
      return {}
    }
    return {
      activeView,
      skillLibraryDraftDirty: activeView === "skillLibrary" ? state.skillLibraryDraftDirty : false,
      writingSkillLibraryDraftDirty: activeView === "writingSkillLibrary"
        ? state.writingSkillLibraryDraftDirty
        : false,
    }
  }),
  setActiveSettingsCategory: (activeSettingsCategory) => set({ activeSettingsCategory }),
  setSelectedSoulId: (selectedSoulId) => set({ selectedSoulId }),
  setSelectedSoulTab: (selectedSoulTab) => set({ selectedSoulTab }),
  setSelectedSoulSection: (selectedSoulSection) => set({ selectedSoulSection }),
  setSelectedSkillLibrarySkillId: (selectedSkillLibrarySkillId) => set((state) => {
    if (state.selectedSkillLibrarySkillId === selectedSkillLibrarySkillId) return {}
    if (state.skillLibraryDraftDirty && !confirmDiscardSkillLibraryDraft()) return {}
    return {
      selectedSkillLibrarySkillId,
      skillLibraryDraftDirty: false,
    }
  }),
  setSkillLibraryDraftDirty: (skillLibraryDraftDirty) => set({ skillLibraryDraftDirty }),
  setSelectedWritingSkillLibrarySkillId: (selectedWritingSkillLibrarySkillId) => set((state) => {
    if (state.selectedWritingSkillLibrarySkillId === selectedWritingSkillLibrarySkillId) return {}
    if (state.writingSkillLibraryDraftDirty && !confirmDiscardSkillLibraryDraft()) return {}
    return {
      selectedWritingSkillLibrarySkillId,
      writingSkillLibraryDraftDirty: false,
    }
  }),
  setWritingSkillLibraryDraftDirty: (writingSkillLibraryDraftDirty) => set({ writingSkillLibraryDraftDirty }),
  bumpBindingVersion: () => set((state) => ({ bindingVersion: state.bindingVersion + 1 })),
  setSelectedReviewDimension: (selectedReviewDimension) => set({ selectedReviewDimension }),
  setMcpConfig: (mcpConfig) => set({ mcpConfig }),
  setSelectedReviewFilePath: (selectedReviewFilePath) => set({ selectedReviewFilePath }),
  setThrillSoftGateAcknowledged: (chapter, acknowledged) => set((prev) => {
    const key = chapter == null || !Number.isFinite(chapter) ? "0" : String(Math.trunc(chapter))
    const next = { ...prev.thrilSoftGateAcknowledgedByChapter }
    if (acknowledged) next[key] = true
    else delete next[key]
    return { thrilSoftGateAcknowledgedByChapter: next }
  }),
  clearThrillSoftGateAcknowledged: (chapter) => set((prev) => {
    if (chapter === undefined) return { thrilSoftGateAcknowledgedByChapter: {} }
    const key = chapter == null || !Number.isFinite(chapter) ? "0" : String(Math.trunc(chapter))
    const next = { ...prev.thrilSoftGateAcknowledgedByChapter }
    delete next[key]
    return { thrilSoftGateAcknowledgedByChapter: next }
  }),
  setSelectedDismantlingProjectId: (selectedDismantlingProjectId) => set({ selectedDismantlingProjectId }),
  setGraphMode: (graphMode) => set({ graphMode }),
  setGraphDisplayMode: (graphDisplayMode) => set({ graphDisplayMode }),
  setGraphColorMode: (graphColorMode) => set({ graphColorMode }),
  setGraphLabelDisplayMode: (graphLabelDisplayMode) => set({ graphLabelDisplayMode }),
  setGraphShowFilters: (graphShowFilters) => set({ graphShowFilters }),
  setGraphShowEdgeControls: (graphShowEdgeControls) => set({ graphShowEdgeControls }),
  setGraphEdgeStyle: (graphEdgeStyle) => set({ graphEdgeStyle }),
  setGraphEdgeColorHex: (graphEdgeColorHex) => set({ graphEdgeColorHex }),
  setGraphEdgeStrengthPercent: (graphEdgeStrengthPercent) => set({ graphEdgeStrengthPercent }),
  setGraphEdgeLabelsAlwaysVisible: (graphEdgeLabelsAlwaysVisible: boolean) => set({ graphEdgeLabelsAlwaysVisible }),
  setGraphStats: (graphStats) => set({ graphStats }),
  setRefreshGraph: (refreshGraph) => set({ refreshGraph }),
  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setAiChatModel: (aiChatModel) => set({ aiChatModel }),
  setDefaultLlmModel: (defaultLlmModel) => set({ defaultLlmModel }),
  setProviderConfigs: (providerConfigs) => set({ providerConfigs }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
  setRerankConfig: (rerankConfig) => set((prev) => ({ rerankConfig: { ...prev.rerankConfig, ...rerankConfig } })),
  setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  setProxyConfig: (proxyConfig) => set({ proxyConfig }),
  setScheduledImportConfig: (scheduledImportConfig) => set({ scheduledImportConfig }),
  setSourceWatchConfig: (sourceWatchConfig) => set({ sourceWatchConfig }),
  setNovelMode: (novelMode) => set({ novelMode }),
  setChatEditModeEnabled: (chatEditModeEnabled) => set({ chatEditModeEnabled }),
  setNovelConfig: (config) => set((prev) => ({ novelConfig: { ...prev.novelConfig, ...config } })),
  setCommunitySummaryError: (communitySummaryError) => set({ communitySummaryError }),
  setSearchHistory: (searchHistory) => set({ searchHistory }),
  setSearchTrigger: (searchTrigger) => set({ searchTrigger }),
  setRevisionFeedbackWindowConfig: (revisionFeedbackWindowConfig) => set({ revisionFeedbackWindowConfig }),
  setFinalChapterSave: (finalChapterSave) => set({ finalChapterSave }),
  setLintRun: (lintRun) => set({ lintRun }),
  finishLintRun: (runId, lintRun) => set((prev) => {
    if (prev.lintRun?.runId !== runId) return {}
    return { lintRun: { ...prev.lintRun, ...lintRun } }
  }),
  setReviewRun: (reviewRun) => set({ reviewRun }),
  finishReviewRun: (runId, reviewRun) => set((prev) => {
    if (prev.reviewRun?.runId !== runId) return {}
    return { reviewRun: { ...prev.reviewRun, ...reviewRun } }
  }),
  cancelReviewRun: () => set((prev) => {
    if (!prev.reviewRun?.running) return prev
    prev.reviewRunAbortController?.abort()
    return { reviewRun: { ...prev.reviewRun, running: false, error: undefined } }
  }),
  clearTransientTaskState: () => set({ finalChapterSave: null, lintRun: null, reviewRun: null }),
  setTheme: (theme) => set({ theme }),
  setUiFontSizeScale: (scale) => {
    const clamped = Math.max(0.85, Math.min(1.3, Number(scale.toFixed(2))))
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(UI_FONT_SIZE_SCALE_KEY, String(clamped))
    }
    set({ uiFontSizeScale: clamped })
  },
  offlineMode: (() => {
    if (typeof localStorage === "undefined") return false
    return localStorage.getItem(OFFLINE_MODE_KEY) === "1"
  })(),
  setOfflineMode: (enabled) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OFFLINE_MODE_KEY, enabled ? "1" : "0")
    }
    set({ offlineMode: enabled })
  },
  bumpDataVersion: () => set((prev) => ({ dataVersion: prev.dataVersion + 1 })),
  requestChapterCreate: () => set((prev) => ({ chapterCreateNonce: prev.chapterCreateNonce + 1 })),
}))
