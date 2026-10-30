import type { NovelReviewResult, DimensionReviewResult, SixReviewDimensionKey, MeasurementFingerprint } from "@/lib/novel"
import type { LintResult } from "@/lib/lint"

export const CHAT_DOCK_POSITION_KEY = "niko-buddy-chat-dock-position"
export const OFFLINE_MODE_KEY = "niko-buddy-offline-mode"
export const UI_FONT_SIZE_SCALE_KEY = "niko-buddy-ui-font-size-scale"
/** 写作专注模式开关（开 = "1"，默认关闭）。 */
export const FOCUS_MODE_KEY = "niko-buddy-focus-mode"

const GRAPH_LABEL_MODE_KEY = "lk-graph-label-display-mode"
const GRAPH_EDGE_COLOR_KEY = "lk-graph-edge-color"
const GRAPH_EDGE_STRENGTH_KEY = "lk-graph-edge-strength"
const GRAPH_EDGE_STYLE_KEY = "lk-graph-edge-style"
const GRAPH_EDGE_LABELS_ALWAYS_KEY = "lk-graph-edge-labels-always"

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
  | "skill-library"
  | "mcp"

// ── localStorage reader helpers ────────────────────────────────────────────────

/** Reads the persisted chat dock position, falling back to "bottom". */
export const readStoredChatDockPosition = (): ChatDockPosition => {
  if (typeof localStorage === "undefined") return "bottom"
  const saved = localStorage.getItem(CHAT_DOCK_POSITION_KEY)
  return saved === "right" || saved === "bottom" ? saved : "bottom"
}

/** Reads the persisted UI font scale, clamping to [0.85, 1.3]. */
export const readStoredUiFontSizeScale = (): number => {
  if (typeof localStorage === "undefined") return 1
  const saved = Number(localStorage.getItem(UI_FONT_SIZE_SCALE_KEY) ?? "1")
  return Number.isFinite(saved) ? Math.max(0.85, Math.min(1.3, Number(saved.toFixed(2)))) : 1
}

/** Reads the persisted focus mode, defaulting to false (off). */
export const readStoredFocusMode = (): boolean => {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(FOCUS_MODE_KEY) === "1"
}

/** Reads the persisted graph label display mode, defaulting to "all". */
export const readStoredGraphLabelDisplayMode = (): string => {
  if (typeof localStorage === "undefined") return "all"
  const saved = localStorage.getItem(GRAPH_LABEL_MODE_KEY)
  return saved === "auto" || saved === "focused" || saved === "all" ? saved : "all"
}

/** Reads the persisted graph edge colour hex, validating format. */
export const readStoredGraphEdgeColorHex = (): string => {
  if (typeof localStorage === "undefined") return "#7f8ea3"
  const saved = localStorage.getItem(GRAPH_EDGE_COLOR_KEY)
  return saved && /^#[0-9a-fA-F]{6}$/.test(saved) ? saved : "#7f8ea3"
}

/** Reads the persisted graph edge strength percent, clamping to [100, 260]. */
export const readStoredGraphEdgeStrengthPercent = (): number => {
  if (typeof localStorage === "undefined") return 180
  const saved = Number(localStorage.getItem(GRAPH_EDGE_STRENGTH_KEY) ?? "180")
  return Number.isFinite(saved) ? Math.max(100, Math.min(260, saved)) : 180
}

/** Reads the persisted graph edge style, defaulting to "curve". */
export const readStoredGraphEdgeStyle = (): string => {
  if (typeof localStorage === "undefined") return "curve"
  const saved = localStorage.getItem(GRAPH_EDGE_STYLE_KEY)
  return saved === "curve" || saved === "arrow" || saved === "line" ? saved : "curve"
}

/** Reads whether graph edge labels should always be shown. */
export const readStoredGraphEdgeLabelsAlways = (): boolean => {
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

export interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli" | "cursor-cli" | "antigravity-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  /**
   * 模型上下文窗口，单位 **token**（不是字符）。
   *
   * 这个单位曾经在仓里两种读法并存：`runner.ts` 按 token 裁剪（
   * `maxContextSize × 0.75` 传给 `trimChatMessagesToTokenBudget`），
   * 而 `context-budget.ts` 的文档写的是 characters。现在统一为 token——
   * 模型窗口本身就是 token 计数的，预设的 `suggestedContextSize` 也是 token。
   *
   * `computeContextBudget` 返回的 `indexBudget` / `pageBudget` /
   * `maxPageSize` 仍是**字符**预算，由 token 窗口保守派生（见该文件注释）。
   */
  maxContextSize: number
  /**
   * HTTP transport timeouts (UI 可调, 单位毫秒, 均为可选 additive)。
   * undefined = 沿用各档硬编码默认 (connect 10s / header 20s / stream-idle 90s), 零行为变更。
   * 传入时经 streamChat 钳制后生效 (connect/header 5s–300s, idle 30s–600s)。
   */
  httpConnectTimeoutMs?: number
  httpHeaderTimeoutMs?: number
  httpStreamIdleMs?: number
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
  /**
   * 54 号设计 W3: 生成最大 token 数 (UI 可调)。
   * 可选 additive: undefined = 沿用各 provider 既有默认 (anthropic 4096 等);
   * 传入时经 streamChat 合并进 RequestOverrides.max_tokens (显式 overrides 优先)。
   */
  maxOutputTokens?: number
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

export interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  providerConfigs?: SearchProviderConfigs
}

export interface EmbeddingConfig {
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

export const SEARCH_RECIPE_IDS = ["default", "diverse", "local", "balanced"] as const
export type SearchRecipeId = (typeof SEARCH_RECIPE_IDS)[number]

export const isSearchRecipeId = (val: unknown): val is SearchRecipeId =>
  typeof val === "string" && (SEARCH_RECIPE_IDS as readonly string[]).includes(val)

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
  recipe?: SearchRecipeId
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
  recipe: "default",
}

// ── Multimodal / image captioning ───────────────────────────────────────────────

/**
 * Global outbound HTTP proxy. When `enabled` and `url` is a valid
 * http(s) URL, the Rust setup hook reads this on app launch and
 * sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars before the
 * reqwest client used by tauri-plugin-http is constructed.
 */
export interface ProxyConfig {
  enabled: boolean
  url: string
  bypassLocal: boolean
}

export interface ScheduledImportConfig {
  enabled: boolean
  path: string
  interval: number
  lastScan: number | null
}

export interface SourceWatchConfig {
  enabled: boolean
  autoIngest: boolean
  includeExtensions: string[]
  excludeExtensions: string[]
  excludeDirs: string[]
  excludeGlobs: string[]
  maxFileSizeMb: number
}

// ── Novel config ────────────────────────────────────────────────────────────────

export type TaskPromptKey = "writing" | "outline" | "review" | "summary" | "extract"
export const TASK_PROMPT_KEYS = ["writing", "outline", "review", "summary", "extract"] as const

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
   * B8: canon 写前一致性门模式 (additive, 默认 "warn" 观察期 = 零行为变更)。
   * "block" 时 BLOCK 级硬冲突在写入前硬拦, 写入返回 pre_write_block (读取点:
   * canon-dual-write.resolvePreWriteGateMode)。本开关只加强不削弱: 任何取值都保留
   * 门判定与 gate 记录, 无关闭档 (Consistency P0 不可被配置关闭)。
   * 持久化 `.niko-buddy/novel-config.json` (project-store normalizeNovelConfig 透传)。
   */
  preWriteGateMode?: "warn" | "block"
  /**
   * Residual campaign product opt-in (default off / fail-open).
   * When true and chapter is residual (not freeze Ch4/Ch6), deep-chapter receives
   * residualOverallMedian + structure_thril_pacing fields for structure-first inject/polish.
   * Does not elevate overall>=9 to Track A productHardGate.
   */
  residualCampaignEnabled: boolean
  /** Allow residual campaign on freeze chapters Ch4/Ch6 (default false). */
  residualCampaignIncludeFreezeChapters: boolean
  /** Deep generation stage-2 task-brief digest-keyed cache via stage-output-journal (default on).
   * Off = legacy behavior (direct LLM call, zero cache reads/writes). On = crash re-entry with
   * same digest skips the LLM re-call; cache-hit is surfaced in the thinking stream.
   *
   * F10-5 (G5 类型/注释收敛)：store 态内本字段恒为 concrete boolean（DEFAULT_NOVEL_CONFIG=true +
   * project-store normalize `??` 回填，稀疏/legacy 输入在边界即被补齐）。仅外部稀疏 fixture/单测
   * 可能缺席，故调用侧统一经 `buildStageJournalRuntime(projectId, stageJournalEnabled?: boolean | undefined)`
   * 装配（`=== false` 关，其余含 undefined 视为开），不再各处手写 `!== false` 门控。 */
  stageJournalEnabled: boolean
  /** Per-project journal TTL override (ms). Sparse optional: undefined = process-global
   * `effectiveJournalTtlMs()` chain (premium-config → default T+1h). Callers pass through
   * `buildStageJournalRuntime(projectId, stageJournalEnabled, journalTtlMs)` where an
   * explicit positive value wins; absent/invalid falls back to the global chain.
   *
   * F11-2 (Round-11 arch residue): per-project TTL source — kills the last-write-wins
   * cross-project pollution at assembly time without touching the premium global chain. */
  journalTtlMs?: number
  /** Reasoning effort tier for review calls (default high). */
  reviewReasoningEffort: "low" | "medium" | "high"
  writingModel: string
  reviewModel: string
  summaryModel: string
  extractModel: string
  /** 多模型共识总开关（default off）。开启后审查六维分维与章节生成走共识执行器；关闭=单模型现状行为逐字节等价。 */
  consensusEnabled: boolean
  /** 审查共识：每维独立模型组（"providerId/modelId"）；空数组回退 reviewModel 单模型。 */
  consensusReviewModels: Record<string, string[]>
  /** 写作共识：章节生成并行模型组；空数组回退会话当前模型。 */
  consensusWritingModels: string[]
  /** 辩论轮次数（default 1）：各模型互看他方匿名评分/理由后再评。 */
  consensusDebateRounds: number
  /** 任务级自定义提示词（追加段，default 空=追加段不存在）。键与 NovelTaskType 语义对齐。 */
  taskPrompts: Record<TaskPromptKey, { extra?: string }>
  /** 任务级技能名单覆盖（default 空数组=走内置默认选择逻辑）。 */
  taskSkillNames: Record<TaskPromptKey, string[]>
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
   * E-06 (run-execute-1, 双库架构蓝图 kb-governance): trust 过滤开关 (默认 false)。
   * 开启后检索侧剔除 blocked 条目 (GOV-TRUST-05); 关闭 = 字节级回退现状。
   * [stage: awaiting-wiring-done] P1-IMP-15：接线完成后翻默认值。流程见 docs/kb-flag-promotion-flow.md
   */
  trustFilterEnabled: boolean
  /**
   * E-06: 能力库衰减开关 (默认 false)。衰减参数 [需校准] (G-3), 校准前不生效。
   * [stage: DEFERRED] P1-IMP-15：衰减校准未完成，暂不翻默认值。
   */
  decayEnabled: boolean
  /**
   * E-06: 过程库 supersession 过滤开关 (默认 false)。开启后 superseded 条目不装配。
   * [stage: DEFERRED] P1-IMP-15：supersession 语义未产品拍板，暂不翻默认值。
   */
  supersessionFilterEnabled: boolean
  /**
   * E-02 (run-execute-1, 双库架构蓝图 capability-kb-retrieval): 双轨检索编排开关 (默认 false)。
   * 开启后写作路径 searchRelevantContentUnified 经 retrieveDualTrack 编排
   * (canon 不参与 RRF 排名, C-3); 关闭 = 字节级回退现状。
   * [stage: awaiting-eval-evidence] P1-IMP-15：离线评测 gate PASS 后翻默认值。流程见 docs/kb-flag-promotion-flow.md
   */
  dualKbRoutingEnabled: boolean
  /**
   * E-02 #5 M3b（三模型共识 2026-09-07 已翻转，等效证据替代）：硬注入通道开关 (默认 true)。
   * 开启后 buildContextPack 第四源装配 pack.hardInject (canon 认知轴 + visibleInfoFor POV 投影,
   * 预算 cap 裁剪)；renderIf 双门控（flag ∧ 条目非空）保证空数据/无 POV 字节级不变
   * （context-engine.spec E-02 渲染/字节级断言）；POV 真源 resolveChapterPovCharacter 已落地；
   * 硬注入预算探针 pack.hardInjectUsage 激活（context-engine.ts:799/:924）。
   * 回滚：本 flag 单点可逆（改回 false 即恢复不注入现状）。流程见 docs/kb-flag-promotion-flow.md
   */
  hardInjectEnabled: boolean
  /**
   * E-02: 写作特化 usefulness rerank 开关 (默认 false)。开启后检索候选经
   * reorderByUsefulness (canon_consistency 否决制) 重排; 关闭 = 现状排序。
   * [stage: awaiting-eval-evidence] P1-IMP-15：离线评测 gate PASS 后翻默认值。流程见 docs/kb-flag-promotion-flow.md
   */
  usefulnessRerankEnabled: boolean
  /**
   * 55 号设计 W1-1 (54⑧ 收尾): 题材 (genre) 英文稳定码 (outline-generator 9 码之一)。
   * 运行时单真源 (`.niko-buddy/novel-config.json`); undefined = 未设置 → 生成链零行为变更。
   */
  genre?: string
  /**
   * F-011: Voice Preservation 第一层 — spelling convention 全局拼写约定。
   * 存储在 settings 中，作为全局默认拼写规范而非 per-project 粒度。
   */
  /** 自动分章计划隐式阶段开关（default true）。开启后在深章生成时自动聚合本章分章计划并注入任务书。 */
  autoPlanningEnabled: boolean
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
  // B8: canon 写前门默认 warn 观察期 (显式 "block" 才硬拦; 读取点 canon-dual-write.resolvePreWriteGateMode)。
  preWriteGateMode: "warn",
  residualCampaignEnabled: false,
  residualCampaignIncludeFreezeChapters: false,
  stageJournalEnabled: true,
  reviewReasoningEffort: "high",
  writingModel: "",
  reviewModel: "",
  summaryModel: "",
  extractModel: "",
  consensusEnabled: false,
  consensusReviewModels: {},
  consensusWritingModels: [],
  consensusDebateRounds: 1,
  taskPrompts: { writing: {}, outline: {}, review: {}, summary: {}, extract: {} },
  taskSkillNames: { writing: [], outline: [], review: [], summary: [], extract: [] },
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
  // E-06 (kb-governance): 三 flag 默认 false（校准/接线前零行为变更）
  trustFilterEnabled: false,
  decayEnabled: false,
  supersessionFilterEnabled: false,
  // E-02 (capability-kb-retrieval): dualKbRouting/usefulnessRerank 默认 false（接线前零行为变更，可逆上线）
  dualKbRoutingEnabled: false,
  // #5 M3b 翻转（三模型共识 2026-09-07，等效证据替代）：hardInjectEnabled 默认 true。
  // 等效证据=renderIf 双门控（flag ∧ 条目非空）结构性保证空数据/无 POV 字节级不变
  // （context-engine.spec E-02 渲染/字节级断言区）+ POV 真源已落地（resolveChapterPovCharacter）+ 单点可逆。
  // 硬注入预算探针同时激活（hard_injection_budget_usage ← pack.hardInjectUsage.ratio）。
  hardInjectEnabled: true,
  usefulnessRerankEnabled: false,
  autoPlanningEnabled: true,
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

export interface MultimodalConfig {
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
export type OutputLanguage =
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
  /** 54 W3: 生成最大 token 数 (UI 可调, resolveConfig 透传至 LlmConfig.maxOutputTokens)。 */
  maxOutputTokens?: number
  /**
   * HTTP 三档超时 (UI 可调毫秒数, resolveConfig 透传至 LlmConfig 同名字段)。
   * undefined = 不覆盖, 沿用 LlmConfig 缺省 (即各档硬编码默认)。
   */
  httpConnectTimeoutMs?: number
  httpHeaderTimeoutMs?: number
  httpStreamIdleMs?: number
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

export type LintRunFinishState = Omit<Partial<LintRunState>, "runId" | "projectPath" | "filePath">
export type ReviewRunFinishState = Omit<Partial<ReviewRunState>, "runId" | "projectPath" | "filePath">

// ── WikiState interface ──────────────────────────────────────────────────────────

const SKILL_LIBRARY_UNSAVED_CONFIRM = "当前技能还有未保存修改，确定放弃修改吗？"

export function confirmDiscardSkillLibraryDraft(): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true
  return window.confirm(SKILL_LIBRARY_UNSAVED_CONFIRM)
}
