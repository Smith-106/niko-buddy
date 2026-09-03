// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Central application store — project state, LLM config, UI preferences and task lifecycle.

import { create } from "zustand"
import type { McpConfig } from "@/lib/mcp/config"
import type { WikiProject, FileNode } from "@/types/wiki"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"
import type { LintResult } from "@/lib/lint"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"
import type { MeasurementFingerprint } from "@/lib/novel/measurement-fingerprint"
import type { TrashItem } from "@/lib/trash"

// ── localStorage persistence keys ─────────────────────────────────────────────

const GRAPH_LABEL_MODE_KEY = "lk-graph-label-display-mode"
const GRAPH_EDGE_COLOR_KEY = "lk-graph-edge-color"
const GRAPH_EDGE_STRENGTH_KEY = "lk-graph-edge-strength"
const GRAPH_EDGE_STYLE_KEY = "lk-graph-edge-style"
const GRAPH_EDGE_LABELS_ALWAYS_KEY = "lk-graph-edge-labels-always"
const CHAT_DOCK_POSITION_KEY = "qmai-chat-dock-position"
const OFFLINE_MODE_KEY = "qmai-offline-mode"
const UI_FONT_SIZE_SCALE_KEY = "qmai-ui-font-size-scale"

// ── Public type exports ────────────────────────────────────────────────────────

/** Position of the chat dock within the main layout. */
export type ChatDockPosition = "bottom" | "right"

/** Identifiers for settings sidebar categories. */
export type SettingsCategoryId =
  | "llm"
  | "rerank"
  | "embedding"
  | "network"
  | "interface"
  | "novel"
  | "usage-guide"
  | "maintenance"
  | "data-management"
  | "feedback"
  | "contact-support"
  | "changelog"

// ── localStorage reader helpers ────────────────────────────────────────────────

/** Reads the persisted chat dock position, falling back to "bottom". */
const readStoredChatDockPosition = (): ChatDockPosition => {
  if (typeof localStorage === "undefined") return "bottom"
  const saved = localStorage.getItem(CHAT_DOCK_POSITION_KEY)
  return saved === "right" || saved === "bottom" ? saved : "bottom"
}

/** Reads the persisted UI font scale, clamping to [0.85, 1.3]. */
const readStoredUiFontSizeScale = (): number => {
  if (typeof localStorage === "undefined") return 1
  const saved = Number(localStorage.getItem(UI_FONT_SIZE_SCALE_KEY) ?? "1")
  return Number.isFinite(saved) ? Math.max(0.85, Math.min(1.3, Number(saved.toFixed(2)))) : 1
}

/** Reads the persisted graph label display mode, defaulting to "all". */
const readStoredGraphLabelDisplayMode = (): string => {
  if (typeof localStorage === "undefined") return "all"
  const saved = localStorage.getItem(GRAPH_LABEL_MODE_KEY)
  return saved === "auto" || saved === "focused" || saved === "all" ? saved : "all"
}

/** Reads the persisted graph edge colour hex, validating format. */
const readStoredGraphEdgeColorHex = (): string => {
  if (typeof localStorage === "undefined") return "#7f8ea3"
  const saved = localStorage.getItem(GRAPH_EDGE_COLOR_KEY)
  return saved && /^#[0-9a-fA-F]{6}$/.test(saved) ? saved : "#7f8ea3"
}

/** Reads the persisted graph edge strength percent, clamping to [100, 260]. */
const readStoredGraphEdgeStrengthPercent = (): number => {
  if (typeof localStorage === "undefined") return 180
  const saved = Number(localStorage.getItem(GRAPH_EDGE_STRENGTH_KEY) ?? "180")
  return Number.isFinite(saved) ? Math.max(100, Math.min(260, saved)) : 180
}

/** Reads the persisted graph edge style, defaulting to "curve". */
const readStoredGraphEdgeStyle = (): string => {
  if (typeof localStorage === "undefined") return "curve"
  const saved = localStorage.getItem(GRAPH_EDGE_STYLE_KEY)
  return saved === "curve" || saved === "arrow" || saved === "line" ? saved : "curve"
}

/** Reads whether graph edge labels should always be shown. */
const readStoredGraphEdgeLabelsAlways = (): boolean => {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(GRAPH_EDGE_LABELS_ALWAYS_KEY) === "true"
}

// ── LLM / provider types ────────────────────────────────────────────────────────

/**
 * Wire protocol used when `provider === "custom"`. Other providers have a
 * fixed protocol (openai → OpenAI chat; anthropic → Anthropic messages;
 * etc.), so this field is ignored for them. `undefined` defaults to
 * `chat_completions` for backward compatibility with pre-0.3.7 configs.
 */
export type CustomApiMode = "chat_completions" | "responses" | "anthropic_messages"
export type AzureModelFamily = "auto" | "gpt5"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli" | "cursor-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize: number // max context window in characters
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
  /**
   * F-004 (S3 / ANL-010 f004_correction): true when the user explicitly
   * selected this provider in the settings dropdown (vs. it being a
   * carry-over default). `resolveProviderOverride` honors this to preserve
   * explicit-selection precedence — an API-key user who deliberately chose
   * `claude-code` (subprocess/OAuth path) is NOT silently rerouted to the
   * anthropic HTTP case. Optional & additive; undefined = treated as false
   * (not an explicit selection). See preset-resolver.ts.
   */
  explicitProviderSelection?: boolean
}

// ── Search / embedding / rerank types ───────────────────────────────────────────

export type SearchProvider = "tavily" | "serpapi" | "searxng" | "none"
export type SerpApiEngine =
  | "google"
  | "google_news"
  | "google_scholar"
  | "google_patents"
  | "bing"
  | "duckduckgo"
  | "google_images"
  | "google_videos"
  | "youtube"
  | string
export type SearXngCategory =
  | "general"
  | "news"
  | "science"
  | "it"
  | "images"
  | "videos"
  | "files"
  | "map"
  | "music"
  | "social media"
  | string

export interface SearchProviderOverride {
  apiKey?: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
}

export type SearchProviderConfigs = Partial<Record<Exclude<SearchProvider, "none">, SearchProviderOverride>>

interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  providerConfigs?: SearchProviderConfigs
}

interface EmbeddingConfig {
  enabled: boolean
  endpoint: string // e.g. "http://127.0.0.1:1234/v1/embeddings"
  apiKey: string
  model: string // e.g. "text-embedding-qwen3-embedding-0.6b"
  /** Optional Gemini native `output_dimensionality` value. Ignored by OpenAI-compatible endpoints. */
  outputDimensionality?: number
  /**
   * Chunking knobs (Phase 1 RAG). Undefined values fall back to the
   * chunker's built-in defaults in `src/lib/text-chunker.ts`.
   */
  maxChunkChars?: number
  overlapChunkChars?: number
}

export interface RerankConfig {
  enabled: boolean
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  apiMode?: CustomApiMode
  maxCandidates: number
}

export const DEFAULT_RERANK_CONFIG: RerankConfig = {
  enabled: false,
  useMainLlm: true,
  provider: "custom",
  apiKey: "",
  model: "",
  ollamaUrl: "http://127.0.0.1:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxCandidates: 12,
}

// ── Multimodal / image captioning ───────────────────────────────────────────────

/**
 * Global outbound HTTP proxy. When `enabled` and `url` is a valid
 * http(s) URL, the Rust setup hook reads this on app launch and
 * sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars before the
 * reqwest client used by tauri-plugin-http is constructed.
 */
interface ProxyConfig {
  enabled: boolean
  url: string
  bypassLocal: boolean
}

interface ScheduledImportConfig {
  enabled: boolean
  path: string
  interval: number
  lastScan: number | null
}

interface SourceWatchConfig {
  enabled: boolean
  autoIngest: boolean
  includeExtensions: string[]
  excludeExtensions: string[]
  excludeDirs: string[]
  excludeGlobs: string[]
  maxFileSizeMb: number
}

// ── Novel config ────────────────────────────────────────────────────────────────

export interface NovelConfig {
  contextTokenBudget: number
  recentSummaryWindow: number
  searchTopK: number
  /** Per-chapter target character count for generation and threshold calculations. */
  chapterTargetChars: number
  autoIngestOnSave: boolean
  autoExtractOnImport: boolean
  reviewBeforeSave: boolean
  /** Deep generation phase 0: read and LLM-analyse prior chapters (default off). */
  deepPreviousChaptersAnalysis: boolean
  /** Deep generation phase 4-5: AI review + auto-revision (default on). */
  deepChapterReview: boolean
  /** After Track A gates are green, optionally run Track B literary polish for thril/pull warnings (default off). Does not override Consistency/FIX-1. */
  literaryPolishAfterGate: boolean
  /**
   * Residual campaign product opt-in (default off / fail-open).
   * When true and chapter is residual (not freeze Ch4/Ch6), deep-chapter receives
   * residualOverallMedian + structure_thril_pacing fields for structure-first inject/polish.
   * Does not elevate overall>=9 to Track A productHardGate.
   */
  residualCampaignEnabled: boolean
  /** Allow residual campaign on freeze chapters Ch4/Ch6 (default false). */
  residualCampaignIncludeFreezeChapters: boolean
  /** Reasoning effort tier for review calls (default high). */
  reviewReasoningEffort: "low" | "medium" | "high"
  writingModel: string
  reviewModel: string
  summaryModel: string
  extractModel: string
  /** Community summary auto-extraction toggle (default on). */
  communitySummaryEnabled: boolean
  /** Chapter interval for community summary rebuild (default 5). */
  communitySummaryInterval: number
  /** Background async execution for community summaries (default on). */
  communitySummaryAsync: boolean
  /** Auto-generate chapter title during generation (default on). */
  autoGenerateChapterTitle: boolean
  /** EPIC-001 / ADR-29: Style Exemplars injection toggle (default on). */
  exemplarEnabled: boolean
  /** S2a (roadmap R06 / TASK-101): related-chapters 四维反查 + 伏笔逾期 finding 注入 toggle (default on). */
  relatedChaptersEnabled: boolean
  /** Wave 2 (v2.5.0): @引用系统注入 toggle (default on)。关闭=现状行为（不注入引用段）。 */
  referenceEnabled: boolean
  /** EPIC-002 / ADR-30: Scene Breakdown stage 1.5 toggle (default off). */
  sceneBreakdownEnabled: boolean
  /** EPIC-003 / ADR-32: Conditional entity routing toggle (default on). */
  conditionalRoutingEnabled: boolean
  /** EPIC-004 / ADR-33: Inspector read-only query panel toggle (default on). */
  inspectorEnabled: boolean
  /** Quality Foundation v1: temporal-facts routing for mid-chapter consistency (default on). Explicit false is preserved on load. */
  temporalFactsEnabled: boolean
  /** Quality Foundation v1: additive entity-name boost on context search hits (default on). */
  entityBoostEnabled: boolean
  /** Weight added to hit score when title/snippet mentions a known entity (0–1 scale contribution). */
  entityBoostWeight: number
  /** Quality Foundation v1: post-draft StateDelta light-check (default on). */
  stateDeltaLightCheckEnabled: boolean
  /** When true, light-check errors can block Track A; default false = warn-only. */
  stateDeltaBlocksTrackA: boolean
  /** Quality Foundation v1: outline thril soft-gate before draft (default on). */
  outlineThrillSoftGateEnabled: boolean
  /**
   * F-011: Voice Preservation 第一层 — spelling convention 全局拼写约定。
   * 存储在 settings 中，作为全局默认拼写规范而非 per-project 粒度。
   */
  dialoguePunctuationStyle: string
  paragraphIndent: string
  quoteConvention: string
}

export const DEFAULT_NOVEL_CONFIG: NovelConfig = {
  contextTokenBudget: 0,
  recentSummaryWindow: 8,
  searchTopK: 5,
  chapterTargetChars: 3000,
  autoIngestOnSave: true,
  autoExtractOnImport: true,
  reviewBeforeSave: false,
  deepPreviousChaptersAnalysis: false,
  deepChapterReview: true,
  literaryPolishAfterGate: false,
  residualCampaignEnabled: false,
  residualCampaignIncludeFreezeChapters: false,
  reviewReasoningEffort: "high",
  writingModel: "",
  reviewModel: "",
  summaryModel: "",
  extractModel: "",
  communitySummaryEnabled: true,
  communitySummaryInterval: 5,
  communitySummaryAsync: true,
  autoGenerateChapterTitle: true,
  exemplarEnabled: true,
  // S2a (roadmap R06 / TASK-101): 四维反查生产接线默认开启；关闭=现状行为（不注入 related 文本）。
  relatedChaptersEnabled: true,
  // Wave 2 (v2.5.0): @引用注入默认开启；关闭=现状行为（不注入引用段）。
  referenceEnabled: true,
  sceneBreakdownEnabled: false,
  conditionalRoutingEnabled: true,
  inspectorEnabled: true,
  temporalFactsEnabled: true,
  entityBoostEnabled: true,
  entityBoostWeight: 0.4,
  stateDeltaLightCheckEnabled: true,
  stateDeltaBlocksTrackA: false,
  outlineThrillSoftGateEnabled: true,
  // F-011: Voice Preservation 第一层 — spelling convention 默认值
  dialoguePunctuationStyle: "",
  paragraphIndent: "",
  quoteConvention: "",
}

// ── Revision feedback / multimodal ──────────────────────────────────────────────

export interface RevisionFeedbackWindowConfig {
  currentChapterIncludeShouldImprove: boolean
  previousChapterCarryEnabled: boolean
  lookbackChapterCount: number
  lookbackIncludeMustFixOnly: boolean
}

interface MultimodalConfig {
  enabled: boolean
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  /** Max parallel caption requests during ingest. >=1. */
  concurrency: number
}

// ── Output language ──────────────────────────────────────────────────────────────

/**
 * Output language for LLM-generated content.
 * "auto" = detect from user input / source document language.
 */
type OutputLanguage =
  | "auto"
  | "English"
  | "Chinese"
  | "Traditional Chinese"
  | "Japanese"
  | "Korean"
  | "Vietnamese"
  | "French"
  | "German"
  | "Spanish"
  | "Portuguese"
  | "Italian"
  | "Russian"
  | "Arabic"
  | "Persian"
  | "Hindi"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Swedish"
  | "Indonesian"
  | "Thai"
  | "Ukrainian"

// ── Saved model / provider override ──────────────────────────────────────────────

/** Persisted model configuration entry. */
export interface SavedModel {
  id: string
  name: string
  model: string
  apiKey?: string
  customEndpoint?: string
  description?: string
  createdAt: number
}

/** Per-preset saved fields surviving toggle off/on cycles. */
export interface ProviderOverride {
  label?: string
  apiKey?: string
  model?: string
  baseUrl?: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  maxContextSize?: number
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
  /** Whether to show models under this provider in AI conversations (default true). */
  enabled?: boolean
  /** Saved models for this provider. */
  savedModels?: SavedModel[]
}

export type ProviderConfigs = Record<string, ProviderOverride>

// ── Async task state types ───────────────────────────────────────────────────────

interface BaseTaskState {
  projectPath: string
  filePath?: string
}

interface AsyncTaskState extends BaseTaskState {
  runId: string
  running: boolean
  error?: string
}

export type FinalChapterSavePhase =
  | "saving"
  | "reviewing"
  | "saved"
  | "reingesting"
  | "ingested"
  | "blocked_by_review"
  | "ingest_failed"
  | "ingest_no_llm"
  | "ingest_no_chapter_number"
  | "ingest_not_final"
  | "ingest_extract_failed"
  | "review_warnings"
  | "review_failed_proceed"

export interface FinalChapterSaveState extends BaseTaskState {
  filePath: string
  saving: boolean
  phase: FinalChapterSavePhase | null
  params?: Record<string, string | number>
}

export interface LintRunState extends AsyncTaskState {
  hasRun: boolean
  results: LintResult[]
}

export interface ReviewRunState extends AsyncTaskState {
  results: NovelReviewResult[]
  thinking?: string
  dimensionResults?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  dimensionThinking?: Partial<Record<SixReviewDimensionKey, string>>
  activeDimension?: SixReviewDimensionKey
  dimensionProgress?: string
  /** M0: pack+text fingerprint for Track B score interpretation (not product gate). */
  measurementFingerprint?: MeasurementFingerprint | null
  /** 53 号报告 P1-3 additive: critic 防伪完成门状态 (suspect/incomplete 不宣称完成态)。 */
  gateStatus?: "completed" | "incomplete" | "suspect"
}

export interface PendingEditorHighlight {
  path: string
  text: string
  nonce: number
}

type LintRunFinishState = Omit<Partial<LintRunState>, "runId" | "projectPath" | "filePath">
type ReviewRunFinishState = Omit<Partial<ReviewRunState>, "runId" | "projectPath" | "filePath">

// ── WikiState interface ──────────────────────────────────────────────────────────

const SKILL_LIBRARY_UNSAVED_CONFIRM = "当前 Skill 还有未保存修改，确定放弃修改吗？"

export function confirmDiscardSkillLibraryDraft(): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true
  return window.confirm(SKILL_LIBRARY_UNSAVED_CONFIRM)
}

interface WikiState {
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
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "soul" | "bookAnalysis" | "settings" | "trash" | "reviewCenter" | "skillLibrary" | "writingSkillLibrary" | "skillFavorites" | "storySimulation" | "backupExport" | "canonEditor"
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
  theme: "light" | "dark" | "deep-blue" | "system"
  uiFontSizeScale: number
  dataVersion: number

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
  setTheme: (theme: "light" | "dark" | "deep-blue" | "system") => void
  setUiFontSizeScale: (scale: number) => void
  /** G10 (39 号修复): 统一离线模式 — 短路 embedding/rerank 等可选网络依赖。 */
  offlineMode: boolean
  setOfflineMode: (enabled: boolean) => void
  bumpDataVersion: () => void
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
}))

export type { WikiState, LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig, ScheduledImportConfig, SourceWatchConfig }
