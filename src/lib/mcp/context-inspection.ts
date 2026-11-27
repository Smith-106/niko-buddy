/**
 * `context.inspect` 的只读门面（native-context-readback 计划 C2）。
 *
 * ## 为什么是「门面」而不是新引擎
 *
 * 本模块**不重新实现**上下文装配或六维 prompt：`buildContextPack`、
 * `buildDimensionReviewPrompt`、`canonicalizeContextPackForHash`、
 * `computeCheckpointDigest`、`resolveReviewChapterMaxChars`、
 * `loadGoldScaleMaterials` 全部直接调用生产函数。这里只做四件事：
 *
 * 1. 参数严格校验（含 `dimension` 的六维真源化——键取自
 *    `SIX_REVIEW_DIMENSION_ORDER`，不手写第二份枚举）；
 * 2. **默认零 pack 构建**：只回真实生效配置 + 选定章节的来源/窗口/哈希；
 * 3. 显式 `includePack` / `dimension` 时才用**实际内存 DI 参数**构建一次 pack，
 *    以不透明 `inspectionId` 复用短期独立快照；未带 ID 的显式请求是新构建。
 *    并注入丢弃 ROI 的 telemetry sink（`reportRoutingROI` 是 build 里唯一无条件
 *    副作用，默认会写 `cognition-state.json`；回读不得写项目遥测）；
 * 4. 公开配置投影走**显式字段白名单**：绝不 spread `llmConfig` /
 *    `providerConfigs` / `apiKey` / `customEndpoint` / headers。秘密值只以
 *    `configured: boolean` 的形式出现，合法数字 token / timeout / 写作开关原样保留。
 *
 * ## 三条不撒谎的边界
 *
 * - **不伪造生产 parity**：embedding/rerank 生效时，检索会真的走网络
 *   （`src/lib/search.ts` 直读 store 的 embedding 配置，DI 覆盖不到）。因此
 *   `allowRetrievalNetwork` 默认 `false` 并在**构建前**拒绝；只有调用方显式传
 *   `true` 才按**真实配置**构建。绝不把配置改写成 disabled 来假装「零 IO」。
 * - **`zeroIoClaimed: false`**：即使 embedding/rerank 关闭，构建仍会读本地
 *   wiki/canon/快照文件；「只读」不等于「零 IO」。
 * - **hash 域分开**：`chapter.textSha256` 是**实际 readFile 的完整文本 UTF-8**
 *   （不做 BOM/换行/frontmatter 归一化）；pack 的 `canonicalSha256` 是适配器
 *   自算的 `SHA-256(canonicalizeContextPackForHash(pack))`；`productionFingerprint`
 *   是生产 FNV-1a。三者算法与域都不同，不能互相冒充，也不构成评分输入。
 */

import { readFile } from "@/commands/fs"
import {
  SIX_REVIEW_DIMENSION_ORDER,
  SIX_REVIEW_DIMENSIONS,
  assessGoldScaleReadiness,
  buildChapterPlan as buildChapterPlanProduction,
  buildContextPack as buildContextPackProduction,
  buildDimensionReviewPrompt,
  canonicalizeContextPackForHash,
  computeCheckpointDigest,
  contextPackToPrompt,
  fingerprintText,
  listChapterDrafts,
  listScopeFiles,
  loadGoldScaleMaterials,
  parseChapterOrdinal,
  readDraftChapterNumber,
  resolveReviewChapterMaxChars,
  stableCheckpointStringify,
  type BuildContextOptions,
  type ChapterDraft,
  type ChapterPlanView,
  type ContextPack,
  type RoutingTelemetrySink,
  type SixReviewDimensionKey,
} from "@/lib/novel"
import { TASK_PROMPT_KEYS, useWikiStore } from "@/stores/wiki-store"
import { OFFLINE_MODE_KEY } from "@/stores/wiki-store-config"
import type {
  EmbeddingConfig,
  LlmConfig,
  NovelConfig,
  RerankConfig,
  RevisionFeedbackWindowConfig,
} from "@/stores/wiki-store"

// ── 六维真源（禁止手写字面量） ────────────────────────────────────────────────

/**
 * `dimension` 的合法键，**直接取自生产常量**。
 *
 * 计划 M1 的修正点：早先计划里手写的 `structure/thril/.../text` 枚举与生产
 * 真源不符，会让 `consistency` / `character` 永远选不到、`thrill` 拼错。
 * 这里以 `SIX_REVIEW_DIMENSION_ORDER` 为唯一真源，并用类型标注钉住
 * `SixReviewDimensionKey`，使「生产加了第七维但这里忘了」变成编译错误。
 */
export const SIX_DIMENSION_KEYS: readonly SixReviewDimensionKey[] = SIX_REVIEW_DIMENSION_ORDER

/** 是否为生产六维键。非法键由前端真源严格拒绝（Rust schema 只声明 string）。 */
export function isSixReviewDimensionKey(value: unknown): value is SixReviewDimensionKey {
  return typeof value === "string" && (SIX_REVIEW_DIMENSION_ORDER as readonly string[]).includes(value)
}

// ── 分页常量 ────────────────────────────────────────────────────────────────

/** 单页默认字符数（与 review 章节窗口默认同量级，便于一次读完典型 prompt）。 */
export const DEFAULT_PROMPT_PAGE_CHARS = 16_000
/** 单页硬上限：超过就是调用方在把分页当全文通道用。 */
export const MAX_PROMPT_PAGE_CHARS = 50_000
/** 回读批次只存本模块内存；TTL 是快照寿命，不是请求超时。 */
export const INSPECTION_CACHE_TTL_MS = 5 * 60_000
export const MAX_INSPECTION_CACHE_ENTRIES = 8

/** 默认 `task`（与深章六维审查的调用形态一致；调用方也可显式传入冻结任务）。 */
export function defaultInspectionTask(chapterNumber: number): string {
  return `六维审查第${chapterNumber}章`
}

// ── 运行时配置快照 ────────────────────────────────────────────────────────────

/**
 * 一次回读使用的**实际内存配置**。
 *
 * 这些对象既用于公开投影，也**原样**作为 DI 参数传给 `buildContextPack`——
 * 这样「报告出来的配置」与「真正参与构建的配置」是同一份快照，不会出现
 * 「报告真实值、构建用默认值」的假 parity。
 */
export interface ContextRuntimeConfig {
  novelMode: boolean
  novelConfig: NovelConfig
  llmConfig: LlmConfig
  embeddingConfig: EmbeddingConfig
  rerankConfig: RerankConfig
  revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig
}

/** 选定的章节条目（由状态桥用既有 `chapter-list` 解析逻辑给出，不接受任意路径）。 */
export interface InspectedChapter {
  /** 1 起序号（按既有章节排序）。 */
  index: number
  /** 文件名中的章号（`chapter-003.md` / `第170章-*.md` → 3 / 170）。 */
  number: number
  name: string
  path: string
}

export interface ContextInspectionRequest {
  projectPath: string
  chapter: InspectedChapter
  /** 状态桥透传的原始参数对象（本模块自行校验，桥不解释）。 */
  params: Record<string, unknown>
  /**
   * 桥独占的最终目录/章身份复查。仅内部 TS 接线，不是 MCP 参数或响应。
   * 必须在正文/完整配置终检前完成，以免最外层目录 await 越过终检。
   */
  recheckChapter?: () => Promise<void>
}

// ── 依赖注入 ────────────────────────────────────────────────────────────────

type GoldMaterials = Awaited<ReturnType<typeof loadGoldScaleMaterials>>

interface InspectionGoldSnapshot {
  materials: GoldMaterials
  promptHint: string
  softFailed: boolean
  diagnostic: "gold-materials-load-soft-failed" | "gold-readiness-assess-soft-failed" | null
}

interface FrozenDimensionPrompt {
  prompt: string
  promptSha256: string
}

interface ContextInspectionSnapshot {
  projectPath: string
  chapter: InspectedChapter
  chapterText: string
  textSha256: string
  privateConfigFingerprint: string
  task: string
  allowRetrievalNetwork: boolean
  hardInjectEnabled: boolean
  pack: ContextPack
  packMetadata: PackMetadata
  gold: InspectionGoldSnapshot
  prompts: Map<SixReviewDimensionKey, Promise<FrozenDimensionPrompt>>
  createdAt: number
  expiresAt: number
}

export type ContextInspectionCache = Map<string, ContextInspectionSnapshot>

/** 测试可隔离缓存容器；生产只使用下面的模块级短期缓存，不落盘。 */
export function createContextInspectionCache(): ContextInspectionCache {
  return new Map()
}

const defaultInspectionCache = createContextInspectionCache()

export interface ContextInspectionDeps {
  /** 当前打开的项目路径（用于「项目在回读期间被切换」的显式拒绝）。 */
  readProjectPath: () => string
  /** 读文件（生产是 Tauri `readFile`）。 */
  readFileText: (path: string) => Promise<string>
  /** 读实际生效配置（生产是 `useWikiStore.getState()`）。 */
  readRuntimeConfig: () => ContextRuntimeConfig
  /** 生产 `buildContextPack`（测试可注入探针，断言调用次数与 DI 参数）。 */
  buildContextPack: (
    projectPath: string,
    task: string,
    chapterNumber: number | undefined,
    options: BuildContextOptions,
  ) => Promise<ContextPack>
  /** 生产 gold-scale 只读材料加载（不造 human gold）。 */
  loadGoldMaterials: (projectPath: string) => Promise<GoldMaterials>
  /** 生产 readiness 纯函数；测试可注入意外异常。 */
  assessGoldReadiness?: typeof assessGoldScaleReadiness
  /** 测试可注入独立容器和时钟；都不改变生产 TTL / 容量。 */
  inspectionCache?: ContextInspectionCache
  now?: () => number
}

/**
 * 丢弃 ROI 遥测的 sink。
 *
 * `buildContextPack` 尾部会无条件调用 `reportRoutingROI(pp, sample, options.telemetrySink)`；
 * 默认 sink 会写 `cognition-state.json`。回读是只读操作，必须显式换成丢弃 sink，
 * 否则一次 inspect 就会污染项目遥测。返回 `undefined` 而不是空块，避免 lint 的
 * 空函数告警，语义上就是「什么都不做」。
 */
const DISCARD_TELEMETRY_SINK: RoutingTelemetrySink = () => undefined

const defaultDeps: ContextInspectionDeps = {
  readProjectPath: () => useWikiStore.getState().project?.path ?? "",
  readFileText: (path) => readFile(path),
  readRuntimeConfig: () => {
    const state = useWikiStore.getState()
    return {
      novelMode: state.novelMode,
      novelConfig: state.novelConfig,
      llmConfig: state.llmConfig,
      embeddingConfig: state.embeddingConfig,
      rerankConfig: state.rerankConfig,
      revisionFeedbackWindowConfig: state.revisionFeedbackWindowConfig,
    }
  },
  buildContextPack: (projectPath, task, chapterNumber, options) =>
    buildContextPackProduction(projectPath, task, chapterNumber, options),
  loadGoldMaterials: (projectPath) => loadGoldScaleMaterials(projectPath),
}

// ── 参数校验 ────────────────────────────────────────────────────────────────

interface NormalizedParams {
  inspectionId?: string
  task: string
  includePack: boolean
  dimension?: SixReviewDimensionKey
  includeChapter: boolean
  allowRetrievalNetwork: boolean
  promptOffset: number
  promptLimit: number
}

const CONTEXT_INSPECT_PARAM_KEYS = new Set([
  "chapter", "task", "inspectionId", "includePack", "dimension", "includeChapter",
  "allowRetrievalNetwork", "promptOffset", "promptLimit",
])

function optionalBoolean(
  params: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const raw = params[field]
  if (raw === undefined) return fallback
  if (typeof raw !== "boolean") {
    throw new Error(`context.inspect 的 ${field} 必须是 boolean，收到 ${typeof raw}`)
  }
  return raw
}

function optionalNonNegativeInt(
  params: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const raw = params[field]
  if (raw === undefined) return fallback
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`context.inspect 的 ${field} 必须是 >=0 的整数`)
  }
  return raw
}

function normalizeParams(params: Record<string, unknown>, chapterNumber: number): NormalizedParams {
  for (const key of Object.keys(params)) {
    if (!CONTEXT_INSPECT_PARAM_KEYS.has(key)) {
      throw new Error(`context.inspect 的参数未知：${key}`)
    }
  }
  if (params.chapter !== undefined &&
      (typeof params.chapter !== "string" || params.chapter.trim() === "")) {
    throw new Error("context.inspect 的 chapter 必须是非空字符串")
  }
  const inspectionId = params.inspectionId
  if (inspectionId !== undefined &&
      (typeof inspectionId !== "string" || inspectionId.trim() === "")) {
    throw new Error("context.inspect 的 inspectionId 必须是非空字符串")
  }
  const rawTask = params.task
  let task: string
  if (rawTask === undefined) {
    task = defaultInspectionTask(chapterNumber)
  } else if (typeof rawTask !== "string" || rawTask.trim() === "") {
    throw new Error("context.inspect 的 task 必须是非空字符串")
  } else {
    task = rawTask
  }

  let dimension: SixReviewDimensionKey | undefined
  const rawDimension = params.dimension
  if (rawDimension !== undefined) {
    if (!isSixReviewDimensionKey(rawDimension)) {
      throw new Error(
        `context.inspect 的 dimension 非法：${String(rawDimension)}。` +
          `合法值只能来自生产常量 SIX_REVIEW_DIMENSION_ORDER：${SIX_REVIEW_DIMENSION_ORDER.join(", ")}`,
      )
    }
    dimension = rawDimension
  }

  const promptLimit = optionalNonNegativeInt(params, "promptLimit", DEFAULT_PROMPT_PAGE_CHARS)
  if (promptLimit < 1 || promptLimit > MAX_PROMPT_PAGE_CHARS) {
    throw new Error(
      `context.inspect 的 promptLimit 必须在 1..${MAX_PROMPT_PAGE_CHARS}，收到 ${promptLimit}`,
    )
  }

  return {
    inspectionId,
    task,
    includePack: optionalBoolean(params, "includePack", false),
    dimension,
    includeChapter: optionalBoolean(params, "includeChapter", false),
    allowRetrievalNetwork: optionalBoolean(params, "allowRetrievalNetwork", false),
    promptOffset: optionalNonNegativeInt(params, "promptOffset", 0),
    promptLimit,
  }
}

// ── 公开配置投影（显式白名单，绝不 spread 原对象） ────────────────────────────

/**
 * `novelConfig` 里可公开的标量键白名单。
 *
 * 只放行「写作开关 / 数字预算 / 短枚举」这类非秘密字段。`taskPrompts`（自由文本
 * 提示词）不在此列，改以 SHA-256 + 长度投影；`consensusReviewModels` /
 * `taskSkillNames` 只投影数量。新增字段默认**不公开**——要公开必须改这张表，
 * 这样未来的凭据类字段不会因为「顺手 spread」而泄漏。
 */
const NOVEL_CONFIG_PUBLIC_SCALAR_KEYS = [
  "contextTokenBudget",
  "recentSummaryWindow",
  "searchTopK",
  "chapterTargetChars",
  "autoIngestOnSave",
  "autoExtractOnImport",
  "reviewBeforeSave",
  "deepPreviousChaptersAnalysis",
  "deepChapterReview",
  "literaryPolishAfterGate",
  "preWriteGateMode",
  "residualCampaignEnabled",
  "residualCampaignIncludeFreezeChapters",
  "stageJournalEnabled",
  "journalTtlMs",
  "reviewReasoningEffort",
  "reviewStageTimeoutMs",
  "reviewModel",
  "summaryModel",
  "extractModel",
  "consensusEnabled",
  "consensusDebateRounds",
  "communitySummaryEnabled",
  "communitySummaryInterval",
  "communitySummaryAsync",
  "autoGenerateChapterTitle",
  "exemplarEnabled",
  "relatedChaptersEnabled",
  "referenceEnabled",
  "sceneBreakdownEnabled",
  "conditionalRoutingEnabled",
  "inspectorEnabled",
  "temporalFactsEnabled",
  "entityBoostEnabled",
  "entityBoostWeight",
  "stateDeltaLightCheckEnabled",
  "stateDeltaBlocksTrackA",
  "outlineThrillSoftGateEnabled",
  "trustFilterEnabled",
  "dualKbRoutingEnabled",
  "hardInjectEnabled",
  "usefulnessRerankEnabled",
  "genre",
  "autoPlanningEnabled",
  "dialoguePunctuationStyle",
  "paragraphIndent",
  "quoteConvention",
] as const

type PublicScalar = string | number | boolean

function isPublicScalar(value: unknown): value is PublicScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** 秘密值只报告「有没有配置」，不报告值本身。 */
function configured(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== ""
}

interface PublicConfigProjection {
  novelMode: boolean
  novelConfig: Record<string, PublicScalar>
  llm: Record<string, PublicScalar | boolean | { apiKey: boolean; customEndpoint: boolean; ollamaUrl: boolean }>
  embedding: Record<string, PublicScalar | boolean | { endpoint: boolean; apiKey: boolean }>
  rerank: Record<string, PublicScalar | boolean | { apiKey: boolean; customEndpoint: boolean; ollamaUrl: boolean }>
}

/** 从 `novelConfig` 按白名单取标量（未定义的键不出现，避免伪装成默认值）。 */
function projectNovelConfig(novelConfig: NovelConfig): Record<string, PublicScalar> {
  const source = novelConfig as unknown as Record<string, unknown>
  const out: Record<string, PublicScalar> = {}
  for (const key of NOVEL_CONFIG_PUBLIC_SCALAR_KEYS) {
    const value = source[key]
    if (isPublicScalar(value)) out[key] = value
  }
  return out
}

/** 从 `llmConfig` 取公开字段：模型/窗口/timeout 保留，密钥与端点只报 configured。 */
function projectLlmConfig(llm: LlmConfig): PublicConfigProjection["llm"] {
  const out: PublicConfigProjection["llm"] = {
    provider: llm.provider,
    model: llm.model,
    maxContextSize: llm.maxContextSize,
    configured: {
      apiKey: configured(llm.apiKey),
      customEndpoint: configured(llm.customEndpoint),
      ollamaUrl: configured(llm.ollamaUrl),
    },
  }
  for (const key of [
    "httpConnectTimeoutMs",
    "httpHeaderTimeoutMs",
    "httpStreamIdleMs",
    "maxConcurrency",
    "maxOutputTokens",
    "codexCliTimeoutMinutes",
    "localCliIsolation",
    "explicitProviderSelection",
    "apiMode",
    "azureApiVersion",
    "azureModelFamily",
  ] as const) {
    const value = llm[key]
    if (isPublicScalar(value)) out[key] = value
  }
  return out
}

/** embedding 端点/密钥只报 configured（`endpoint` 是 URL，可能带凭据）。 */
function projectEmbeddingConfig(embedding: EmbeddingConfig): PublicConfigProjection["embedding"] {
  const out: PublicConfigProjection["embedding"] = {
    enabled: embedding.enabled,
    model: embedding.model,
    configured: {
      endpoint: configured(embedding.endpoint),
      apiKey: configured(embedding.apiKey),
    },
  }
  for (const key of ["outputDimensionality", "maxChunkChars", "overlapChunkChars"] as const) {
    const value = embedding[key]
    if (isPublicScalar(value)) out[key] = value
  }
  return out
}

function projectRerankConfig(rerank: RerankConfig): PublicConfigProjection["rerank"] {
  const out: PublicConfigProjection["rerank"] = {
    enabled: rerank.enabled,
    useMainLlm: rerank.useMainLlm,
    provider: rerank.provider,
    model: rerank.model,
    maxCandidates: rerank.maxCandidates,
    configured: {
      apiKey: configured(rerank.apiKey),
      customEndpoint: configured(rerank.customEndpoint),
      ollamaUrl: configured(rerank.ollamaUrl),
    },
  }
  for (const key of ["recipe", "apiMode"] as const) {
    const value = rerank[key]
    if (isPublicScalar(value)) out[key] = value
  }
  return out
}

/**
 * 公开配置投影 + 指纹。
 *
 * 指纹只作用于**公开投影**（不含秘密值），用途是分页期间让调用方确认配置没变；
 * 真正的配置漂移检测在内部用完整快照比较（见 `inspectContext`），不依赖这个指纹。
 */
async function projectEffectiveConfig(config: ContextRuntimeConfig): Promise<Record<string, unknown>> {
  const novelConfig = projectNovelConfig(config.novelConfig)
  const taskPrompts: Record<string, { sha256: string; chars: number }> = {}
  for (const key of TASK_PROMPT_KEYS) {
    const extra = config.novelConfig.taskPrompts?.[key]?.extra ?? ""
    taskPrompts[key] = { sha256: await computeCheckpointDigest(extra), chars: extra.length }
  }
  const consensusReviewModelCounts: Record<string, number> = {}
  for (const [key, models] of Object.entries(config.novelConfig.consensusReviewModels ?? {})) {
    consensusReviewModelCounts[key] = Array.isArray(models) ? models.length : 0
  }
  const taskSkillNameCounts: Record<string, number> = {}
  for (const key of TASK_PROMPT_KEYS) {
    const names = config.novelConfig.taskSkillNames?.[key]
    taskSkillNameCounts[key] = Array.isArray(names) ? names.length : 0
  }

  const projection = {
    novelMode: config.novelMode,
    novelConfig,
    taskPrompts,
    consensus: {
      reviewModelGroupSizes: consensusReviewModelCounts,
      // 写作共识组大小（刻意不叫 *ModelCount：旧死字段名在仓库有反向漂移闸）。
      writingGroupSize: Array.isArray(config.novelConfig.consensusWritingModels)
        ? config.novelConfig.consensusWritingModels.length
        : 0,
    },
    taskSkillNameCounts,
    revisionFeedbackWindow: {
      currentChapterIncludeShouldImprove:
        config.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove,
      previousChapterCarryEnabled: config.revisionFeedbackWindowConfig.previousChapterCarryEnabled,
      lookbackChapterCount: config.revisionFeedbackWindowConfig.lookbackChapterCount,
      lookbackIncludeMustFixOnly: config.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly,
    },
    llm: projectLlmConfig(config.llmConfig),
    embedding: projectEmbeddingConfig(config.embeddingConfig),
    rerank: projectRerankConfig(config.rerankConfig),
  }

  const fingerprint = await computeCheckpointDigest(stableCheckpointStringify(projection))
  return { ...projection, fingerprint, fingerprintAlgorithm: "sha256-utf8-of-public-projection" }
}

// ── pack 元数据（诊断，不构成质量门） ────────────────────────────────────────

/**
 * 「语义非空」只认**章节相关**字段。
 *
 * 静态基线（`soulDoc` / `writingStyle` / `characterAuras` / `mustDo` /
 * `mustAvoid`）单列报告：它们在有真实前情时也存在，不能单独凑成「真实上下文」。
 * `task` 是调用方请求本身、时间/用量元数据是构建产物，都不计入。
 * 首章 `previousChapterEnding` / `recent*` 为空是**合法**的，不设栏位硬门。
 */
const CHAPTER_CONTEXT_FIELDS = [
  "chapterGoal",
  "outline",
  "recentSummaries",
  "recentChapterContents",
  "previousChapterEnding",
  "characterStates",
  "cognitionStates",
  "foreshadowingStates",
  "timeline",
  "relatedSettings",
  "canonRules",
  "canonRulesBase",
  "searchResults",
  "graphSearchResults",
  "nextChapterAdvice",
  "revisionDirectives",
  "temporalFacts",
  "activeEntities",
  "hardInject",
] as const

const STATIC_BASELINE_FIELDS = [
  "soulDoc",
  "writingStyle",
  "characterAuras",
  "mustDo",
  "mustAvoid",
  "styleExemplars",
] as const

function fieldPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim() !== ""
  if (Array.isArray(value)) return value.length > 0
  return true
}

interface PackMetadata {
  productionFingerprint: string
  canonicalSha256: string
  algorithms: { productionFingerprint: string; canonicalSha256: string }
  fields: string[]
  packChars: number
  canonicalChars: number
  packUtf8Bytes: number
  canonicalUtf8Bytes: number
  lengthDomains: {
    packChars: string
    canonicalChars: string
    packUtf8Bytes: string
    canonicalUtf8Bytes: string
  }
  shape: {
    outlineChars: number
    previousEndingChars: number
    recentChapterCount: number
    styleExemplarCount: number
    gapCount: number
    characterStateChars: number
  }
  gaps: unknown[]
  gapCount: number
  semanticNonempty: {
    chapterContext: boolean
    staticBaselineOnly: boolean
    presentFields: string[]
    baselinePresentFields: string[]
  }
}

async function buildPackMetadata(pack: ContextPack): Promise<PackMetadata> {
  const canonical = canonicalizeContextPackForHash(pack)
  const serializedPack = JSON.stringify(pack)
  const source = pack as unknown as Record<string, unknown>
  const presentFields = CHAPTER_CONTEXT_FIELDS.filter((field) => fieldPresent(source[field]))
  const baselinePresentFields = STATIC_BASELINE_FIELDS.filter((field) => fieldPresent(source[field]))
  const gaps = Array.isArray(pack.gaps) ? pack.gaps : []
  const recent = pack.recentChapterContents
  const exemplars = pack.styleExemplars
  return {
    productionFingerprint: fingerprintText(canonical),
    canonicalSha256: await computeCheckpointDigest(canonical),
    algorithms: {
      productionFingerprint: "fnv1a-64 over UTF-8 (book-analysis content-fingerprint)",
      canonicalSha256: "sha256-utf8 of canonicalizeContextPackForHash(pack)",
    },
    fields: Object.keys(pack).sort(),
    packChars: serializedPack.length,
    canonicalChars: canonical.length,
    packUtf8Bytes: new TextEncoder().encode(serializedPack).length,
    canonicalUtf8Bytes: new TextEncoder().encode(canonical).length,
    lengthDomains: {
      packChars: "utf16-code-units of JSON.stringify(full ContextPack)",
      canonicalChars: "utf16-code-units of canonicalizeContextPackForHash(pack)",
      packUtf8Bytes: "utf8-bytes of JSON.stringify(full ContextPack)",
      canonicalUtf8Bytes: "utf8-bytes of canonicalizeContextPackForHash(pack)",
    },
    shape: {
      outlineChars: (pack.outline ?? "").length,
      previousEndingChars: (pack.previousChapterEnding ?? "").length,
      recentChapterCount: Array.isArray(recent) ? recent.length : 0,
      styleExemplarCount: Array.isArray(exemplars) ? exemplars.length : 0,
      gapCount: gaps.length,
      characterStateChars: (pack.characterStates ?? "").length,
    },
    gaps,
    gapCount: gaps.length,
    semanticNonempty: {
      chapterContext: presentFields.length > 0,
      staticBaselineOnly: presentFields.length === 0 && baselinePresentFields.length > 0,
      presentFields: [...presentFields],
      baselinePresentFields: [...baselinePresentFields],
    },
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export interface ContextInspectionResult {
  projectPath: string
  inspectionId?: string
  inspection?: {
    createdAt: number
    expiresAt: number
    cacheHit: boolean
    snapshotScope: "one-production-build-with-frozen-pack-and-gold"
    externalSourcesRevalidated: false
    acceptOrIngestRequiresNewInspection: true
    goldMaterialsSoftFailed: boolean
    goldMaterialsDiagnostic: InspectionGoldSnapshot["diagnostic"]
  }
  chapter: {
    index: number
    number: number
    name: string
    path: string
    chars: number
    charsDomain: "utf16-code-units"
    textSha256: string
    textHashDomain: string
  }
  effectiveConfig: Record<string, unknown>
  reviewWindow: { maxChars: number; chapterWindowOmitted: boolean }
  contextPackBuilt: boolean
  packMetadata?: PackMetadata
  buildPolicy?: {
    telemetryDiscarded: boolean
    retrievalNetworkAllowed: boolean
    effectiveNetworkEnabled: boolean
    zeroIoClaimed: false
    buildTriggered: boolean
  }
  /** 显式 `includePack=true` 时的**实际完整** ContextPack（生产 renderer 字段全在）。 */
  contextPack?: ContextPack
  /** 显式 `includeChapter=true` 时经既有 Tauri FS 读到的完整原文。 */
  chapterText?: string
  /** 显式 `dimension` 时的生产 user 分析 prompt 分页视图。 */
  dimension?: {
    key: SixReviewDimensionKey
    promptKind: "production-user-analysis-prompt"
    promptScope: "base-production-user-analysis-prompt"
    runtimeSkillHookFragmentsApplied: false
    goldReadinessHintSource: "assessGoldScaleReadiness.promptHint"
    systemPromptIncluded: false
    hardInjectEnabled: boolean
    goldAnchorCount: number
    goldMaterialsSoftFailed: boolean
    goldMaterialsDiagnostic: InspectionGoldSnapshot["diagnostic"]
    prompt: string
    pageOffset: number
    pageChars: number
    totalChars: number
    nextOffset: number | null
    responseTruncated: boolean
    chapterWindowOmitted: boolean
    promptSha256: string
    pageSha256: string
    algorithms: { promptSha256: string; pageSha256: string }
    offsetDomain: "utf16-code-units"
  }
}

/** 结构化漂移错误：调用方必须重跑，不能拿两份不一致的快照当一次回读。 */
function driftError(what: string): Error {
  return new Error(
    `context.inspect 拒绝：${what}在回读期间发生变化。` +
      `回读要求项目/配置/正文稳定；请重跑一次并把两次结果分开使用。`,
  )
}

/** 序号也是身份的一部分：前面插入章节时，路径不变也必须拒绝旧定位。 */
export function sameInspectedChapter(a: InspectedChapter, b: InspectedChapter): boolean {
  return a.path === b.path && a.name === b.name && a.index === b.index && a.number === b.number
}

/** 保留完整 JSON 可序列化字段；不冻结或向外返回生产共享对象。 */
function copySerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 执行一次只读回读。
 *
 * @throws Error（由状态桥转成 `{ok:false,error}`）——参数非法、网络未授权、
 *   或项目/配置/正文漂移一律显式失败，绝不返回「看起来成功」的部分结果。
 */
export async function inspectContext(
  request: ContextInspectionRequest,
  deps: ContextInspectionDeps = defaultDeps,
): Promise<ContextInspectionResult> {
  const { projectPath, chapter: chapterRequest } = request
  if (!projectPath || projectPath.trim() === "") {
    throw new Error("context.inspect 需要已打开的项目")
  }
  if (!chapterRequest || typeof chapterRequest.path !== "string" || chapterRequest.path.trim() === "") {
    throw new Error("context.inspect 需要已解析的章节条目")
  }
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error("context.inspect 的 params 必须是对象")
  }

  const chapter = { ...chapterRequest }
  const params = normalizeParams(request.params, chapter.number)
  const cache = deps.inspectionCache ?? defaultInspectionCache
  const now = deps.now ?? Date.now
  let inspectionId = params.inspectionId
  let snapshot: ContextInspectionSnapshot | undefined
  const rejectDrift = (what: string): never => {
    if (inspectionId !== undefined) cache.delete(inspectionId)
    throw driftError(what)
  }

  if (inspectionId !== undefined) {
    snapshot = cache.get(inspectionId)
    if (!snapshot) {
      throw new Error("context.inspect 拒绝：inspectionId 未知或已失效；请新建 inspection，不会静默重建")
    }
    if (snapshot.expiresAt <= now()) {
      cache.delete(inspectionId)
      throw new Error("context.inspect 拒绝：inspectionId 已过期；请新建 inspection，不会静默重建")
    }
    if (snapshot.projectPath !== projectPath) rejectDrift("inspectionId 的项目")
    if (!sameInspectedChapter(snapshot.chapter, chapter)) rejectDrift("inspectionId 的章节定位")
    if (snapshot.task !== params.task) rejectDrift("inspectionId 的冻结 task")
    if (snapshot.allowRetrievalNetwork !== params.allowRetrievalNetwork) {
      rejectDrift("inspectionId 的检索网络策略")
    }
  }
  const cacheHit = snapshot !== undefined

  // 1) 项目漂移（调用前）：项目在解析章节与读正文之间被切换 → 拒绝。
  const projectAtStart = deps.readProjectPath()
  if (projectAtStart !== projectPath) {
    rejectDrift("项目")
  }

  // 2) 实际生效配置快照（用于公开投影 + 原样 DI + 漂移比对）。
  const configAtStart = deps.readRuntimeConfig()
  const configBaseline = stableCheckpointStringify(configAtStart)
  const needsPack = params.includePack || params.dimension !== undefined || inspectionId !== undefined
  // 私有 baseline 只在内部比较，不放进公开投影或响应。
  const privateConfigFingerprint = needsPack ? await computeCheckpointDigest(configBaseline) : ""
  if (snapshot && snapshot.privateConfigFingerprint !== privateConfigFingerprint) {
    rejectDrift("inspectionId 的生效配置")
  }

  // 3) 正文快照：hash 作用于 readFile 的完整文本 UTF-8（不做任何归一化）。
  const readChapterText = async (): Promise<string> => {
    try {
      return await deps.readFileText(chapter.path)
    } catch (error) {
      if (inspectionId !== undefined) cache.delete(inspectionId)
      throw error
    }
  }
  const chapterText = await readChapterText()
  const textSha256 = await computeCheckpointDigest(chapterText)
  if (snapshot && snapshot.textSha256 !== textSha256) rejectDrift("inspectionId 的章节正文")
  const maxChars = resolveReviewChapterMaxChars()
  const chapterWindowOmitted = chapterText.length > maxChars

  const needsBuild = needsPack && snapshot === undefined
  const effectiveNetworkEnabled = configAtStart.embeddingConfig.enabled || configAtStart.rerankConfig.enabled

  // 4) 网络闸：embedding/rerank 生效时检索会真出网，未显式授权就在构建前拒绝。
  if (needsBuild && effectiveNetworkEnabled && !params.allowRetrievalNetwork) {
    throw new Error(
      "context.inspect 拒绝构建：当前生效配置启用了 embedding/rerank 检索网络，" +
        "但调用方未显式传 allowRetrievalNetwork=true。" +
        "回读不会为了「看起来只读」而把配置改成 disabled（那会伪造生产 parity）。",
    )
  }

  if (needsBuild) {
    // 5) 用**同一份实际内存配置**作为 DI 参数，并注入丢弃 ROI 的 sink。
    const options: BuildContextOptions = {
      llmConfig: configAtStart.llmConfig,
      novelConfig: configAtStart.novelConfig,
      novelMode: configAtStart.novelMode,
      embeddingConfig: configAtStart.embeddingConfig,
      rerankConfig: configAtStart.rerankConfig,
      revisionFeedbackWindowConfig: configAtStart.revisionFeedbackWindowConfig,
      telemetrySink: DISCARD_TELEMETRY_SINK,
    }
    const pack = copySerializable(await deps.buildContextPack(projectPath, params.task, chapter.number, options))
    const packMetadata = await buildPackMetadata(pack)
    const gold = await loadInspectionGold(projectPath, deps)
    const createdAt = now()
    inspectionId = crypto.randomUUID()
    snapshot = {
      projectPath,
      chapter,
      chapterText,
      textSha256,
      privateConfigFingerprint,
      task: params.task,
      allowRetrievalNetwork: params.allowRetrievalNetwork,
      hardInjectEnabled: configAtStart.novelConfig.hardInjectEnabled === true,
      pack,
      packMetadata,
      gold,
      prompts: new Map(),
      createdAt,
      expiresAt: createdAt + INSPECTION_CACHE_TTL_MS,
    }
  }

  const effectiveConfig = await projectEffectiveConfig(configAtStart)
  const result: ContextInspectionResult = {
    projectPath,
    chapter: {
      index: chapter.index,
      number: chapter.number,
      name: chapter.name,
      path: chapter.path,
      chars: chapterText.length,
      charsDomain: "utf16-code-units",
      textSha256,
      textHashDomain: "sha256-utf8-of-exact-file-text (no BOM/newline/frontmatter normalization)",
    },
    effectiveConfig,
    reviewWindow: { maxChars, chapterWindowOmitted },
    contextPackBuilt: snapshot !== undefined,
  }

  if (params.includeChapter) {
    result.chapterText = chapterText
  }

  if (snapshot !== undefined) {
    result.inspectionId = inspectionId
    result.inspection = {
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      cacheHit,
      snapshotScope: "one-production-build-with-frozen-pack-and-gold",
      // Canon / 其他外部文件没有全面复核；accept / ingest 后应显式新建批次。
      externalSourcesRevalidated: false,
      acceptOrIngestRequiresNewInspection: true,
      goldMaterialsSoftFailed: snapshot.gold.softFailed,
      goldMaterialsDiagnostic: snapshot.gold.diagnostic,
    }
    result.packMetadata = copySerializable(snapshot.packMetadata)
    result.buildPolicy = {
      telemetryDiscarded: true,
      retrievalNetworkAllowed: params.allowRetrievalNetwork,
      effectiveNetworkEnabled,
      zeroIoClaimed: false,
      buildTriggered: needsBuild,
    }
    if (params.includePack) {
      // 实际完整 pack：renderer 消费的 optional 字段（styleExemplars /
      // activeEntities / temporalFacts / hardInject / gaps …）全部保留，
      // 不是只有 PACK_HASH_KEYS 的投影。
      result.contextPack = copySerializable(snapshot.pack)
    }
    if (params.dimension !== undefined) {
      result.dimension = await buildDimensionPage({
        snapshot,
        dimension: params.dimension,
        promptOffset: params.promptOffset,
        promptLimit: params.promptLimit,
        chapterWindowOmitted,
      })
    }
  }

  // 桥独占的最终目录 / 章身份复查必须在这里 await：它内部还要读一次章节目录，
  // 本身也是异步的。若把它留在 `inspectContext` 返回之后，那次目录 await 就会
  // 越过下面的正文与完整配置终检，配置或正文在该窗口内漂移就会被漏报成稳定成功。
  // 顺序固定：projection / gold / prompt / page SHA → 目录与章身份复查 →
  // 最终正文 + SHA → 同步核完整配置 / 项目 / 过期。
  if (request.recheckChapter) {
    try {
      await request.recheckChapter()
    } catch (error) {
      // 回调失败（目录 / 身份漂移）同样是「这批回读已不可信」：已用批次必须失效，
      // 且不再为复查重新 build pack 或 load gold。
      if (inspectionId !== undefined) cache.delete(inspectionId)
      throw error
    }
  }

  // 最终检查必须在 projection、gold、prompt / page SHA 等全部 await 之后。
  // SHA await 后再同步核配置 / 项目，避免读取正文期间又切换项目仍返回成功。
  const textAtEnd = await readChapterText()
  if ((await computeCheckpointDigest(textAtEnd)) !== textSha256) rejectDrift("章节正文")
  if (stableCheckpointStringify(deps.readRuntimeConfig()) !== configBaseline) rejectDrift("生效配置")
  if (deps.readProjectPath() !== projectPath) rejectDrift("项目")
  if (snapshot && snapshot.expiresAt <= now()) {
    if (inspectionId !== undefined) cache.delete(inspectionId)
    throw new Error("context.inspect 拒绝：inspectionId 在回读期间已过期；请新建 inspection，不会静默重建")
  }
  if (needsBuild && snapshot && inspectionId !== undefined) {
    const currentTime = now()
    for (const [id, entry] of cache) {
      if (entry.expiresAt <= currentTime) cache.delete(id)
    }
    while (cache.size >= MAX_INSPECTION_CACHE_ENTRIES) {
      const oldestId = cache.keys().next().value
      if (oldestId === undefined) break
      cache.delete(oldestId)
    }
    cache.set(inspectionId, snapshot)
  }
  return result
}

async function loadInspectionGold(
  projectPath: string,
  deps: ContextInspectionDeps,
): Promise<InspectionGoldSnapshot> {
  let diagnostic: NonNullable<InspectionGoldSnapshot["diagnostic"]> = "gold-materials-load-soft-failed"
  try {
    const materials = copySerializable(await deps.loadGoldMaterials(projectPath))
    diagnostic = "gold-readiness-assess-soft-failed"
    const readiness = (deps.assessGoldReadiness ?? assessGoldScaleReadiness)({
      anchors: materials.anchors,
      exemplars: materials.exemplars,
    })
    return { materials, promptHint: readiness.promptHint, softFailed: false, diagnostic: null }
  } catch {
    // 与生产一样 soft-fail；保留稳定阶段诊断，不泄漏 loader 的私密错误内容。
    // 这是本次读取批次的明确降级状态，不冒充成功的 LLM 结果缓存。
    return {
      materials: { anchors: [], exemplars: [], merged: [] },
      promptHint: "",
      softFailed: true,
      diagnostic,
    }
  }
}

function getFrozenDimensionPrompt(
  snapshot: ContextInspectionSnapshot,
  dimension: SixReviewDimensionKey,
): Promise<FrozenDimensionPrompt> {
  const cached = snapshot.prompts.get(dimension)
  if (cached) return cached
  const definition = SIX_REVIEW_DIMENSIONS[dimension]
  if (!definition) throw new Error(`context.inspect 缺少六维定义：${dimension}`)
  // 只复用生产基座，不注册 runtime hooks，也不宣称完整 live wire parity。
  const prompt = buildDimensionReviewPrompt(snapshot.pack, snapshot.chapterText, definition, {
    goldAnchors: snapshot.gold.materials.merged,
    goldReadinessHint: snapshot.gold.promptHint,
    hardInjectEnabled: snapshot.hardInjectEnabled,
  })
  const pending = computeCheckpointDigest(prompt).then((promptSha256) => ({ prompt, promptSha256 }))
  snapshot.prompts.set(dimension, pending)
  return pending
}

async function buildDimensionPage(input: {
  snapshot: ContextInspectionSnapshot
  dimension: SixReviewDimensionKey
  promptOffset: number
  promptLimit: number
  chapterWindowOmitted: boolean
}): Promise<NonNullable<ContextInspectionResult["dimension"]>> {
  const { prompt, promptSha256 } = await getFrozenDimensionPrompt(input.snapshot, input.dimension)

  const totalChars = prompt.length
  if (input.promptOffset > totalChars) {
    throw new Error(
      `context.inspect 的 promptOffset 超出 prompt 长度（offset=${input.promptOffset}, totalChars=${totalChars}）`,
    )
  }
  const page = prompt.slice(input.promptOffset, input.promptOffset + input.promptLimit)
  const consumed = input.promptOffset + page.length
  const nextOffset = consumed < totalChars ? consumed : null

  return {
    key: input.dimension,
    promptKind: "production-user-analysis-prompt",
    promptScope: "base-production-user-analysis-prompt",
    runtimeSkillHookFragmentsApplied: false,
    goldReadinessHintSource: "assessGoldScaleReadiness.promptHint",
    systemPromptIncluded: false,
    hardInjectEnabled: input.snapshot.hardInjectEnabled,
    goldAnchorCount: input.snapshot.gold.materials.merged.length,
    goldMaterialsSoftFailed: input.snapshot.gold.softFailed,
    goldMaterialsDiagnostic: input.snapshot.gold.diagnostic,
    prompt: page,
    pageOffset: input.promptOffset,
    pageChars: page.length,
    totalChars,
    nextOffset,
    responseTruncated: nextOffset !== null,
    chapterWindowOmitted: input.chapterWindowOmitted,
    promptSha256,
    pageSha256: await computeCheckpointDigest(page),
    algorithms: {
      promptSha256: "sha256-utf8 of full base production user analysis prompt",
      pageSha256: "sha256-utf8 of this page",
    },
    offsetDomain: "utf16-code-units",
  }
}

// ── R2-B2: `context.prepare` 写作前零 LLM 只读准备门面 ─────────────────────────

const PREPARE_DRAFT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

export const PREPARE_RETRIEVAL_MODES = ["local_only", "configured_network"] as const
export type PrepareRetrievalMode = (typeof PREPARE_RETRIEVAL_MODES)[number]

/** `context.prepare_write` 短期内存批次缓存 TTL（5 分钟）与最大条目数。 */
export const PREPARE_CACHE_TTL_MS = 5 * 60_000
export const MAX_PREPARE_CACHE_ENTRIES = 8

interface PrepareWriteSnapshot {
  prepareId: string
  projectPath: string
  targetChapter: number
  existingChapterCount: number
  isNewBook: boolean
  task: string
  retrievalMode: PrepareRetrievalMode
  allowRetrievalNetwork: boolean
  effectiveNetworkEnabled: boolean
  privateConfigFingerprint: string
  hardInjectEnabled: boolean
  pack: ContextPack
  packMetadata: PackMetadata
  fullWritingPrompt: string
  planningView?: ChapterPlanView | null
  planningViewLoaded: boolean
  planningViewWarning: string | null
  gold?: InspectionGoldSnapshot
  initialDraftId?: string
  initialDraftSha256?: string
  dimensionPrompts: Map<string, Promise<FrozenDimensionPrompt>>
  createdAt: number
  expiresAt: number
}

export type PrepareWriteCache = Map<string, PrepareWriteSnapshot>

/** 测试可隔离 prepare 缓存容器；生产只使用下方模块级 5 分钟内存缓存，不落盘。 */
export function createPrepareWriteCache(): PrepareWriteCache {
  return new Map()
}

const defaultPrepareCache = createPrepareWriteCache()

const CONTEXT_PREPARE_PARAM_KEYS = new Set([
  "prepareId",
  "page",
  "targetChapter",
  "draftId",
  "task",
  "includePack",
  "includeDraft",
  "includePlanningView",
  "dimension",
  "retrievalMode",
  "allowRetrievalNetwork",
  "offset",
  "limit",
])

// 模块级引用计数内存离线守卫：仅操作 Zustand 内存态，严禁调用 setOfflineMode（避免写 localStorage）。
let localOnlyGuardRefCount = 0
let localOnlyGuardSavedOfflineMode: boolean | null = null
let localOnlyGuardLastObservedStorage: string | null = null
let localOnlyGuardExternalOverride: boolean | null = null
let localOnlyGuardUnsubscribe: (() => void) | null = null
let localOnlyGuardUpdatingStore = false

function readOfflineModeStorageSafe(): string | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(OFFLINE_MODE_KEY)
  } catch {
    return null
  }
}

function setOfflineModeInMemory(value: boolean): void {
  localOnlyGuardUpdatingStore = true
  try {
    useWikiStore.setState({ offlineMode: value })
  } finally {
    localOnlyGuardUpdatingStore = false
  }
}

/**
 * 在纯内存离线守卫内执行本地只读检索（零 `localStorage` 写入、支持并发引用计数与外部用户切换保护）。
 */
export async function runWithLocalOnlyRetrieval<T>(fn: () => Promise<T>): Promise<T> {
  if (localOnlyGuardRefCount === 0) {
    localOnlyGuardSavedOfflineMode = useWikiStore.getState().offlineMode
    localOnlyGuardLastObservedStorage = readOfflineModeStorageSafe()
    localOnlyGuardExternalOverride = null
    localOnlyGuardUnsubscribe = useWikiStore.subscribe((state, prevState) => {
      if (localOnlyGuardUpdatingStore) return
      const currentStorage = readOfflineModeStorageSafe()
      const storageChanged =
        currentStorage !== localOnlyGuardLastObservedStorage
        && (currentStorage === "1" || currentStorage === "0")
      if (storageChanged) {
        localOnlyGuardLastObservedStorage = currentStorage
      }
      if (state.offlineMode !== prevState.offlineMode) {
        localOnlyGuardExternalOverride = state.offlineMode
      } else if (storageChanged) {
        localOnlyGuardExternalOverride = currentStorage === "1"
      }
    })
  }
  localOnlyGuardRefCount += 1

  try {
    if (!useWikiStore.getState().offlineMode) {
      setOfflineModeInMemory(true)
    }
    return await fn()
  } finally {
    localOnlyGuardRefCount = Math.max(0, localOnlyGuardRefCount - 1)
    if (localOnlyGuardRefCount === 0) {
      const savedOffline = localOnlyGuardSavedOfflineMode ?? false
      const lastObservedStorage = localOnlyGuardLastObservedStorage
      const externalOverride = localOnlyGuardExternalOverride
      const unsubscribe = localOnlyGuardUnsubscribe
      localOnlyGuardSavedOfflineMode = null
      localOnlyGuardLastObservedStorage = null
      localOnlyGuardExternalOverride = null
      localOnlyGuardUnsubscribe = null
      unsubscribe?.()

      const currentStorage = readOfflineModeStorageSafe()
      let restoreTarget = savedOffline
      if (
        currentStorage !== lastObservedStorage
        && (currentStorage === "1" || currentStorage === "0")
      ) {
        restoreTarget = currentStorage === "1"
      } else if (externalOverride !== null) {
        restoreTarget = externalOverride
      }

      if (useWikiStore.getState().offlineMode !== restoreTarget) {
        setOfflineModeInMemory(restoreTarget)
      }
    }
  }
}

export interface PrepareWriteContextParams {
  prepareId?: string
  page?: number
  targetChapter?: number
  draftId?: string
  task?: string
  includePack?: boolean
  includeDraft?: boolean
  includePlanningView?: boolean
  dimension?: string
  retrievalMode?: PrepareRetrievalMode
  allowRetrievalNetwork?: boolean
  offset?: number
  limit?: number
}

export interface NormalizedPrepareWriteContextParams {
  prepareId?: string
  page?: number
  targetChapter?: number
  draftId?: string
  task?: string
  includePack: boolean
  includeDraft: boolean
  includePlanningView: boolean
  dimension?: SixReviewDimensionKey
  retrievalMode?: PrepareRetrievalMode
  allowRetrievalNetwork: boolean
  allowRetrievalNetworkExplicit: boolean
  offset: number
  limit: number
}

export interface PrepareWriteContextDeps {
  readProjectPath: () => string
  readRuntimeConfig: () => ContextRuntimeConfig
  listChapters: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  buildContextPack: (
    projectPath: string,
    task: string,
    chapterNumber: number | undefined,
    options: BuildContextOptions,
  ) => Promise<ContextPack>
  buildChapterPlan: (projectPath: string, chapterNumber: number) => Promise<ChapterPlanView>
  loadGoldMaterials: (projectPath: string) => Promise<GoldMaterials>
  assessGoldReadiness?: typeof assessGoldScaleReadiness
  /** 纯内存本地只读检索守卫（默认使用模块级引用计数 `runWithLocalOnlyRetrieval`）。 */
  runWithLocalOnlyRetrieval?: <T>(fn: () => Promise<T>) => Promise<T>
  /** 测试可注入独立 prepare 缓存容器与时钟（生产固定 5 分钟 TTL / 8 条容量）。 */
  prepareCache?: PrepareWriteCache
  now?: () => number
}

export interface PrepareWriteContextResult {
  projectPath: string
  /** 批次缓存键（5 分钟内存 TTL，跨分页/跨六维复用同一 ContextPack 与 gold）。 */
  prepareId: string
  prepareCache: {
    hit: boolean
    createdAt: number
    expiresAt: number
    ttlMs: number
  }
  mode: "new_book_chapter_1" | "next_chapter" | "draft_review"
  targetChapter: number
  existingChapterCount: number
  isNewBook: boolean
  task: string
  novelMode: boolean
  /** 显式告警摘要（如 `novelMode=false` 或规划视图降级）；无告警时为 null。 */
  warning: string | null
  warnings: string[]
  effectiveConfig: Record<string, unknown>
  buildPolicy: {
    telemetryDiscarded: true
    retrievalMode: PrepareRetrievalMode
    retrievalNetworkAllowed: boolean
    effectiveNetworkEnabled: boolean
    networkRetrievalSkipped: boolean
    zeroIoClaimed: false
    llmCalls: 0
    diskWrites: 0
  }
  contextPackBuilt: boolean
  packMetadata: PackMetadata
  /** 仅 `includePack === true` 时返回完整独立副本。 */
  contextPack?: ContextPack
  /** 仅 `includePlanningView !== false` 时返回零 LLM 规划视图（降级安全）。 */
  planningView?: ChapterPlanView | null
  /** 字符分页的写作上下文提示词切片。 */
  prompt: {
    text: string
    offset: number
    limit: number
    pageChars: number
    totalChars: number
    hasMore: boolean
    nextOffset: number | null
    promptSha256: string
    pageSha256: string
    offsetDomain: "utf16-code-units"
  }
  /** 传入 `draftId` 时的待审草稿元信息。 */
  draft?: {
    draftId: string
    chapterName: string
    chapterNumber: number | null
    status: ChapterDraft["status"]
    createdAt: number
    chars: number
    partial: boolean
    textSha256: string
  }
  /** 仅传入 `draftId` 且 `includeDraft === true` 时返回完整草稿正文。 */
  draftText?: string
  /** 仅传入 `dimension` 时返回六维评审标准（若同时传 `draftId` 则含生产六维分页审查 prompt）。 */
  dimension?: {
    key: SixReviewDimensionKey
    label: string
    objective: string
    stages: string[]
    checks: string[]
    reviewPromptBuilt: boolean
    note?: string
    promptKind?: "production-user-analysis-prompt"
    prompt?: string
    offset?: number
    limit?: number
    pageChars?: number
    totalChars?: number
    hasMore?: boolean
    nextOffset?: number | null
    chapterWindowOmitted?: boolean
    goldAnchorCount?: number
    goldMaterialsSoftFailed?: boolean
    goldMaterialsDiagnostic?: InspectionGoldSnapshot["diagnostic"]
    promptSha256?: string
    pageSha256?: string
    offsetDomain?: "utf16-code-units"
  }
  /** 面向调用方的精简下一步流程指引（直接由准备门面生成，桥不改写）。 */
  workflowHint: string
  meta: {
    llmCalls: 0
    diskWrites: 0
  }
}

const defaultPrepareDeps: PrepareWriteContextDeps = {
  readProjectPath: defaultDeps.readProjectPath,
  readRuntimeConfig: defaultDeps.readRuntimeConfig,
  listChapters: (projectPath) => listScopeFiles(projectPath, "chapters"),
  listDrafts: (projectPath) => listChapterDrafts(projectPath),
  buildContextPack: defaultDeps.buildContextPack,
  buildChapterPlan: (projectPath, chapterNumber) => buildChapterPlanProduction(projectPath, chapterNumber),
  loadGoldMaterials: defaultDeps.loadGoldMaterials,
  assessGoldReadiness: assessGoldScaleReadiness,
  runWithLocalOnlyRetrieval,
}

function prepareOptionalBoolean(
  params: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const raw = params[field]
  if (raw === undefined) return fallback
  if (typeof raw !== "boolean") {
    throw new Error(`context.prepare_write 的 ${field} 必须是 boolean，收到 ${typeof raw}`)
  }
  return raw
}

function prepareOptionalNonNegativeInt(
  params: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const raw = params[field]
  if (raw === undefined) return fallback
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`context.prepare_write 的 ${field} 必须是 >= 0 的整数`)
  }
  return raw
}

/** 校验并归一化 `context.prepare_write` 参数（可供状态桥在异步启动前做同步 fast-fail 校验）。 */
export function normalizePrepareWriteContextParams(
  params: Record<string, unknown>,
): NormalizedPrepareWriteContextParams {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("context.prepare_write 的 params 必须是对象")
  }
  for (const key of Object.keys(params)) {
    if (!CONTEXT_PREPARE_PARAM_KEYS.has(key)) {
      throw new Error(`context.prepare_write 的参数未知：${key}`)
    }
  }

  let prepareId: string | undefined
  if (params.prepareId !== undefined) {
    if (typeof params.prepareId !== "string" || !PREPARE_DRAFT_ID_PATTERN.test(params.prepareId)) {
      throw new Error("context.prepare_write 的 prepareId 非法（仅允许 1-128 位字母、数字、下划线或连字符）")
    }
    prepareId = params.prepareId
  }

  let targetChapter: number | undefined
  if (params.targetChapter !== undefined) {
    if (
      typeof params.targetChapter !== "number"
      || !Number.isInteger(params.targetChapter)
      || params.targetChapter < 1
    ) {
      throw new Error("context.prepare_write 的 targetChapter 必须是 >= 1 的整数")
    }
    targetChapter = params.targetChapter
  }

  let draftId: string | undefined
  if (params.draftId !== undefined) {
    if (typeof params.draftId !== "string" || !PREPARE_DRAFT_ID_PATTERN.test(params.draftId)) {
      throw new Error("context.prepare_write 的 draftId 非法（仅允许 1-128 位字母、数字、下划线或连字符）")
    }
    draftId = params.draftId
  }

  let task: string | undefined
  if (params.task !== undefined) {
    if (typeof params.task !== "string" || params.task.trim() === "") {
      throw new Error("context.prepare_write 的 task 必须是非空字符串")
    }
    task = params.task
  }

  let dimension: SixReviewDimensionKey | undefined
  if (params.dimension !== undefined) {
    if (!isSixReviewDimensionKey(params.dimension)) {
      throw new Error(
        `context.prepare_write 的 dimension 非法：${String(params.dimension)}。` +
          `合法值只能来自生产常量 SIX_REVIEW_DIMENSION_ORDER：${SIX_REVIEW_DIMENSION_ORDER.join(", ")}`,
      )
    }
    dimension = params.dimension
  }

  let retrievalMode: PrepareRetrievalMode | undefined
  if (params.retrievalMode !== undefined) {
    if (params.retrievalMode !== "local_only" && params.retrievalMode !== "configured_network") {
      throw new Error(
        `context.prepare_write 的 retrievalMode 非法：${String(params.retrievalMode)}。` +
          `合法值：${PREPARE_RETRIEVAL_MODES.join(", ")}`,
      )
    }
    retrievalMode = params.retrievalMode
  }

  const allowRetrievalNetworkExplicit = params.allowRetrievalNetwork !== undefined
  const allowRetrievalNetwork = prepareOptionalBoolean(params, "allowRetrievalNetwork", false)

  if (retrievalMode === "local_only" && allowRetrievalNetworkExplicit && allowRetrievalNetwork) {
    throw new Error(
      "context.prepare_write 参数冲突：retrievalMode=local_only 与 allowRetrievalNetwork=true 不能同时传入",
    )
  }
  if (retrievalMode === "configured_network" && allowRetrievalNetworkExplicit && !allowRetrievalNetwork) {
    throw new Error(
      "context.prepare_write 参数冲突：retrievalMode=configured_network 与 allowRetrievalNetwork=false 不能同时传入",
    )
  }

  const hasExplicitOffset = params.offset !== undefined
  const hasExplicitPage = params.page !== undefined
  if (hasExplicitPage && hasExplicitOffset) {
    throw new Error("context.prepare_write 参数冲突：page 与 offset 不能同时传入")
  }

  let page: number | undefined
  if (hasExplicitPage) {
    if (
      typeof params.page !== "number"
      || !Number.isSafeInteger(params.page)
      || params.page < 1
    ) {
      throw new Error("context.prepare_write 的 page 必须是 >= 1 的整数")
    }
    page = params.page
  }

  const limit = prepareOptionalNonNegativeInt(params, "limit", DEFAULT_PROMPT_PAGE_CHARS)
  if (limit < 1 || limit > MAX_PROMPT_PAGE_CHARS) {
    throw new Error(
      `context.prepare_write 的 limit 必须在 1..${MAX_PROMPT_PAGE_CHARS}，收到 ${limit}`,
    )
  }
  let offset: number
  if (page !== undefined) {
    const computedOffset = (page - 1) * limit
    if (!Number.isSafeInteger(computedOffset)) {
      throw new Error("context.prepare_write 的 page 与 limit 乘积超出安全整数范围")
    }
    offset = computedOffset
  } else {
    offset = prepareOptionalNonNegativeInt(params, "offset", 0)
  }

  return {
    prepareId,
    page,
    targetChapter,
    draftId,
    task,
    includePack: prepareOptionalBoolean(params, "includePack", false),
    includeDraft: prepareOptionalBoolean(params, "includeDraft", false),
    includePlanningView: prepareOptionalBoolean(params, "includePlanningView", true),
    dimension,
    retrievalMode,
    allowRetrievalNetwork,
    allowRetrievalNetworkExplicit,
    offset,
    limit,
  }
}

function buildPrepareWriteWorkflowHint(input: {
  prepareId: string
  mode: PrepareWriteContextResult["mode"]
  targetChapter: number
  matchedDraft?: ChapterDraft
  promptHasMore: boolean
  promptNextOffset: number | null
  dimensionSection?: PrepareWriteContextResult["dimension"]
}): string {
  if (input.mode === "draft_review" && input.matchedDraft) {
    const draftId = input.matchedDraft.id
    if (input.dimensionSection?.reviewPromptBuilt) {
      if (input.dimensionSection.hasMore) {
        return `草稿 ${draftId} 的「${input.dimensionSection.label}」审查 prompt 已分页返回，可传 prepareId="${input.prepareId}" 与 offset=${input.dimensionSection.nextOffset} 续读；完成后结合 gate.check_mechanical（detailLevel="compact"）输出修改建议，切勿直接改写正式章节。`
      }
      return `草稿 ${draftId} 的「${input.dimensionSection.label}」审查 prompt 已就绪（prepareId="${input.prepareId}"）；请先核对 gate.check_mechanical（detailLevel="compact"）结果（P0 > P1 > P2），再决定修订或通知用户在应用内审阅采纳。`
    }
    if (input.promptHasMore) {
      return `草稿 ${draftId} 审读上下文已分页返回，可传 prepareId="${input.prepareId}" 与 offset=${input.promptNextOffset} 续读；随后调用 gate.check_mechanical（draftId="${draftId}", detailLevel="compact"）完成零 LLM 机械预检。`
    }
    return `草稿 ${draftId} 审读上下文已就绪（prepareId="${input.prepareId}"）；下一步调用 gate.check_mechanical（draftId="${draftId}", detailLevel="compact"）完成零 LLM 机械预检，必要时传 prepareId 与 dimension 执行分维语义审查。`
  }

  if (input.promptHasMore) {
    return `第 ${input.targetChapter} 章写作上下文已分页返回，可传 prepareId="${input.prepareId}" 与 offset=${input.promptNextOffset} 续读；无需重复拉取 rules.get 完整 soulDoc，成稿后调用 chapter.write 落草稿再跑 gate.check_mechanical（detailLevel="compact"）。`
  }
  return `第 ${input.targetChapter} 章写作上下文已就绪（prepareId="${input.prepareId}"，已含灵魂/前情/章纲）；如需补充约束可调用 rules.get（compact=true），写完后调用 chapter.write 落草稿再运行 gate.check_mechanical（detailLevel="compact"）。`
}

function resolveChapterFileNumber(name: string): number | undefined {
  const stem = name.replace(/\.md$/i, "")
  const ordinal = parseChapterOrdinal(stem)
  if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal > 0) return ordinal
  const fromDraftHelper = readDraftChapterNumber(stem)
  if (fromDraftHelper !== undefined) return fromDraftHelper
  const digits = /(\d+)/.exec(stem)
  if (!digits) return undefined
  const num = Number(digits[1])
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

async function slicePaginatedText(
  fullText: string,
  offset: number,
  limit: number,
  label: string,
): Promise<{
  text: string
  offset: number
  limit: number
  pageChars: number
  totalChars: number
  hasMore: boolean
  nextOffset: number | null
  promptSha256: string
  pageSha256: string
}> {
  const totalChars = fullText.length
  if (offset > totalChars) {
    throw new Error(`${label} 的 offset 超出长度（offset=${offset}, totalChars=${totalChars}）`)
  }
  const text = fullText.slice(offset, offset + limit)
  const consumed = offset + text.length
  const hasMore = consumed < totalChars
  const nextOffset = hasMore ? consumed : null
  const [promptSha256, pageSha256] = await Promise.all([
    computeCheckpointDigest(fullText),
    computeCheckpointDigest(text),
  ])
  return {
    text,
    offset,
    limit,
    pageChars: text.length,
    totalChars,
    hasMore,
    nextOffset,
    promptSha256,
    pageSha256,
  }
}

function getFrozenPrepareDimensionPrompt(
  snapshot: PrepareWriteSnapshot,
  draft: ChapterDraft,
  draftSha256: string,
  dimension: SixReviewDimensionKey,
  gold: InspectionGoldSnapshot,
): Promise<FrozenDimensionPrompt> {
  const cacheKey = `${draft.id}:${dimension}:${draftSha256}`
  const existing = snapshot.dimensionPrompts.get(cacheKey)
  if (existing) return existing
  const definition = SIX_REVIEW_DIMENSIONS[dimension]
  if (!definition) throw new Error(`context.prepare_write 缺少六维定义：${dimension}`)
  const prompt = buildDimensionReviewPrompt(snapshot.pack, draft.content, definition, {
    goldAnchors: gold.materials.merged,
    goldReadinessHint: gold.promptHint,
    hardInjectEnabled: snapshot.hardInjectEnabled,
  })
  const pending = computeCheckpointDigest(prompt).then((promptSha256) => ({ prompt, promptSha256 }))
  snapshot.dimensionPrompts.set(cacheKey, pending)
  return pending
}

/**
 * 零 LLM、零写盘的写作/审稿上下文准备入口（供 MCP `context.prepare_write` 消费）。
 *
 * 支持三类核心场景与 5 分钟短期 `prepareId` 内存批次复用：
 * 1. 0 章新书首章准备（世界观/大纲/规划视图 + 第 1 章写作上下文）；
 * 2. 第 `N+1` 章续写上下文（ContextPack + 字符/页码分页提示词切片）；
 * 3. 待审草稿 `draftId` 审读（可选携带六维评审标准与生产六维分析 prompt，跨维度 0x 重装 pack/gold）。
 */
export async function runPrepareWriteContext(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<PrepareWriteContextDeps>,
): Promise<PrepareWriteContextResult> {
  if (!projectPath || projectPath.trim() === "") {
    throw new Error("context.prepare_write 需要已打开的项目")
  }
  const normalized = normalizePrepareWriteContextParams(params)
  const deps: PrepareWriteContextDeps = { ...defaultPrepareDeps, ...depsOverrides }
  const cache = deps.prepareCache ?? defaultPrepareCache
  const now = deps.now ?? Date.now
  const localOnlyRunner = deps.runWithLocalOnlyRetrieval ?? runWithLocalOnlyRetrieval

  const activeProject = deps.readProjectPath()
  if (activeProject !== projectPath) {
    throw new Error("context.prepare_write 拒绝：当前打开的项目与请求项目不一致")
  }

  const configAtStart = deps.readRuntimeConfig()
  const configBaseline = stableCheckpointStringify(configAtStart)
  const privateConfigFingerprint = await computeCheckpointDigest(configBaseline)
  const effectiveNetworkEnabled = configAtStart.embeddingConfig.enabled || configAtStart.rerankConfig.enabled
  const warnings: string[] = []

  if (!configAtStart.novelMode) {
    warnings.push(
      "当前项目未启用小说模式（novelMode=false），上下文包仅返回空壳；请在项目设置中开启小说模式后重试。",
    )
  }

  let snapshot: PrepareWriteSnapshot | undefined
  let cacheHit = false
  let matchedDraft: ChapterDraft | undefined
  let matchedDraftSha256: string | undefined

  const rejectPrepareDrift: (what: string) => never = (what: string): never => {
    if (normalized.prepareId !== undefined) {
      cache.delete(normalized.prepareId)
    }
    throw new Error(
      `context.prepare_write 拒绝：${what}在 prepareId 缓存期间发生变化；请新建 prepare 批次，不会静默重建`,
    )
  }

  if (normalized.prepareId !== undefined) {
    const cached = cache.get(normalized.prepareId)
    if (!cached) {
      throw new Error("context.prepare_write 拒绝：prepareId 未知或已失效；请新建 prepare 批次，不会静默重建")
    }
    if (cached.expiresAt <= now()) {
      cache.delete(normalized.prepareId)
      throw new Error("context.prepare_write 拒绝：prepareId 已过期；请新建 prepare 批次，不会静默重建")
    }
    if (cached.projectPath !== projectPath) rejectPrepareDrift("prepareId 的项目")
    if (cached.privateConfigFingerprint !== privateConfigFingerprint) {
      rejectPrepareDrift("prepareId 的生效配置")
    }
    if (normalized.targetChapter !== undefined && normalized.targetChapter !== cached.targetChapter) {
      rejectPrepareDrift("prepareId 的 targetChapter")
    }
    if (normalized.task !== undefined && normalized.task !== cached.task) {
      rejectPrepareDrift("prepareId 的冻结 task")
    }
    if (normalized.retrievalMode !== undefined && normalized.retrievalMode !== cached.retrievalMode) {
      rejectPrepareDrift("prepareId 的 retrievalMode")
    }
    if (
      normalized.allowRetrievalNetworkExplicit
      && normalized.allowRetrievalNetwork !== cached.allowRetrievalNetwork
    ) {
      rejectPrepareDrift("prepareId 的 allowRetrievalNetwork")
    }

    const effectiveDraftId = normalized.draftId ?? cached.initialDraftId
    if (cached.initialDraftId !== undefined || effectiveDraftId !== undefined) {
      const drafts = await deps.listDrafts(projectPath)
      if (cached.initialDraftId !== undefined) {
        const initialDraft = drafts.find((d) => d.id === cached.initialDraftId)
        if (!initialDraft) rejectPrepareDrift("prepareId 绑定的初始草稿")
        const initialSha = await computeCheckpointDigest(initialDraft.content)
        if (initialSha !== cached.initialDraftSha256) {
          rejectPrepareDrift("prepareId 绑定的草稿正文")
        }
        if (effectiveDraftId === cached.initialDraftId) {
          matchedDraft = initialDraft
          matchedDraftSha256 = initialSha
        }
      }
      if (effectiveDraftId !== undefined && !matchedDraft) {
        const requestedDraft = drafts.find((d) => d.id === effectiveDraftId)
        if (!requestedDraft) {
          throw new Error(`找不到草稿：${effectiveDraftId}`)
        }
        const requestedChapter = readDraftChapterNumber(requestedDraft.chapterName)
        if (requestedChapter !== undefined && requestedChapter !== cached.targetChapter) {
          rejectPrepareDrift("prepareId 跨章草稿")
        }
        matchedDraft = requestedDraft
        matchedDraftSha256 = await computeCheckpointDigest(requestedDraft.content)
      }
    }

    snapshot = cached
    cacheHit = true
  }

  let planningView: ChapterPlanView | null | undefined

  if (snapshot !== undefined) {
    if (normalized.includePlanningView) {
      if (snapshot.planningViewLoaded) {
        planningView = snapshot.planningView ? copySerializable(snapshot.planningView) : null
        if (snapshot.planningViewWarning) warnings.push(snapshot.planningViewWarning)
      } else {
        const loadPlan = async (): Promise<ChapterPlanView | null> => {
          try {
            return copySerializable(await deps.buildChapterPlan(projectPath, snapshot!.targetChapter))
          } catch {
            snapshot!.planningViewWarning = "规划视图装载失败，已优雅降级为 null。"
            warnings.push(snapshot!.planningViewWarning)
            return null
          }
        }
        const builtPlan =
          snapshot.retrievalMode === "local_only"
            ? await localOnlyRunner(loadPlan)
            : await loadPlan()
        snapshot.planningView = builtPlan
        snapshot.planningViewLoaded = true
        planningView = builtPlan ? copySerializable(builtPlan) : null
      }
    }
  } else {
    if (
      normalized.retrievalMode === undefined
      && !normalized.allowRetrievalNetwork
      && configAtStart.novelMode
      && effectiveNetworkEnabled
    ) {
      throw new Error(
        "context.prepare_write 拒绝构建：当前生效配置启用了 embedding/rerank 检索网络，" +
          '但调用方未显式传 allowRetrievalNetwork=true 或 retrievalMode="local_only"。',
      )
    }

    const resolvedRetrievalMode: PrepareRetrievalMode =
      normalized.retrievalMode !== undefined
        ? normalized.retrievalMode
        : normalized.allowRetrievalNetworkExplicit && normalized.allowRetrievalNetwork
          ? "configured_network"
          : "local_only"
    const retrievalNetworkAllowed = resolvedRetrievalMode === "configured_network"

    const chapters = await deps.listChapters(projectPath)
    const existingChapterCount = chapters.length
    const isNewBook = existingChapterCount === 0
    let maxChapterNumber = 0
    for (const ch of chapters) {
      const n = resolveChapterFileNumber(ch.name)
      if (n !== undefined && n > maxChapterNumber) maxChapterNumber = n
    }
    const defaultNextChapter = Math.max(maxChapterNumber, existingChapterCount) + 1

    if (normalized.draftId !== undefined) {
      const drafts = await deps.listDrafts(projectPath)
      matchedDraft = drafts.find((d) => d.id === normalized.draftId)
      if (!matchedDraft) {
        throw new Error(`找不到草稿：${normalized.draftId}`)
      }
      matchedDraftSha256 = await computeCheckpointDigest(matchedDraft.content)
    }

    const draftChapterNumber = matchedDraft ? readDraftChapterNumber(matchedDraft.chapterName) : undefined
    const targetChapter = normalized.targetChapter ?? draftChapterNumber ?? defaultNextChapter

    const task =
      normalized.task
      ?? (matchedDraft
        ? normalized.dimension
          ? `六维审查第${targetChapter}章（草稿 ${matchedDraft.id}）`
          : `审阅草稿第${targetChapter}章（${matchedDraft.id}）`
        : `准备写作第${targetChapter}章`)

    const buildOptions: BuildContextOptions = {
      llmConfig: configAtStart.llmConfig,
      novelConfig: configAtStart.novelConfig,
      novelMode: configAtStart.novelMode,
      embeddingConfig:
        resolvedRetrievalMode === "local_only"
          ? { ...configAtStart.embeddingConfig, enabled: false }
          : configAtStart.embeddingConfig,
      rerankConfig:
        resolvedRetrievalMode === "local_only"
          ? { ...configAtStart.rerankConfig, enabled: false }
          : configAtStart.rerankConfig,
      revisionFeedbackWindowConfig: configAtStart.revisionFeedbackWindowConfig,
      telemetrySink: DISCARD_TELEMETRY_SINK,
    }

    let planningViewWarning: string | null = null
    const executeBuilds = async (): Promise<{
      pack: ContextPack
      planningView: ChapterPlanView | null | undefined
    }> => {
      const builtPack = copySerializable(
        await deps.buildContextPack(projectPath, task, targetChapter, buildOptions),
      )
      let builtPlanningView: ChapterPlanView | null | undefined
      if (normalized.includePlanningView) {
        try {
          builtPlanningView = copySerializable(await deps.buildChapterPlan(projectPath, targetChapter))
        } catch {
          builtPlanningView = null
          planningViewWarning = "规划视图装载失败，已优雅降级为 null。"
          warnings.push(planningViewWarning)
        }
      }
      return { pack: builtPack, planningView: builtPlanningView }
    }

    const built =
      resolvedRetrievalMode === "local_only"
        ? await localOnlyRunner(executeBuilds)
        : await executeBuilds()
    const packMetadata = await buildPackMetadata(built.pack)
    const fullWritingPrompt = contextPackToPrompt(
      built.pack,
      configAtStart.novelConfig.contextTokenBudget,
      {
        temporalFactsEnabled: configAtStart.novelConfig.temporalFactsEnabled === true,
        hardInjectEnabled: configAtStart.novelConfig.hardInjectEnabled === true,
      },
    )

    const createdAt = now()
    const prepareId = `prep_${crypto.randomUUID().replace(/-/g, "")}`
    snapshot = {
      prepareId,
      projectPath,
      targetChapter,
      existingChapterCount,
      isNewBook,
      task,
      retrievalMode: resolvedRetrievalMode,
      allowRetrievalNetwork: retrievalNetworkAllowed,
      effectiveNetworkEnabled,
      privateConfigFingerprint,
      hardInjectEnabled: configAtStart.novelConfig.hardInjectEnabled === true,
      pack: built.pack,
      packMetadata,
      fullWritingPrompt,
      planningView: built.planningView,
      planningViewLoaded: normalized.includePlanningView,
      planningViewWarning,
      initialDraftId: matchedDraft?.id,
      initialDraftSha256: matchedDraftSha256,
      dimensionPrompts: new Map(),
      createdAt,
      expiresAt: createdAt + PREPARE_CACHE_TTL_MS,
    }
    planningView = built.planningView ? copySerializable(built.planningView) : built.planningView
  }

  const resolvedRetrievalMode = snapshot.retrievalMode
  const retrievalNetworkAllowed = snapshot.allowRetrievalNetwork
  const networkRetrievalSkipped = resolvedRetrievalMode === "local_only" && effectiveNetworkEnabled
  const draftChapterNumber = matchedDraft ? readDraftChapterNumber(matchedDraft.chapterName) : undefined
  const mode: PrepareWriteContextResult["mode"] = matchedDraft
    ? "draft_review"
    : snapshot.isNewBook && snapshot.targetChapter === 1
      ? "new_book_chapter_1"
      : "next_chapter"

  let dimensionSection: PrepareWriteContextResult["dimension"]
  let promptSlice: Awaited<ReturnType<typeof slicePaginatedText>>

  if (normalized.dimension !== undefined) {
    const definition = SIX_REVIEW_DIMENSIONS[normalized.dimension]
    if (matchedDraft && matchedDraftSha256 !== undefined) {
      if (!snapshot.gold) {
        snapshot.gold = await loadInspectionGold(projectPath, {
          ...defaultDeps,
          loadGoldMaterials: deps.loadGoldMaterials,
          assessGoldReadiness: deps.assessGoldReadiness ?? assessGoldScaleReadiness,
        })
      }
      const gold = snapshot.gold
      const frozenPrompt = await getFrozenPrepareDimensionPrompt(
        snapshot,
        matchedDraft,
        matchedDraftSha256,
        normalized.dimension,
        gold,
      )
      const reviewPage = await slicePaginatedText(
        frozenPrompt.prompt,
        normalized.offset,
        normalized.limit,
        "context.prepare_write(dimension)",
      )
      const maxChars = resolveReviewChapterMaxChars()
      dimensionSection = {
        key: definition.key,
        label: definition.label,
        objective: definition.objective,
        stages: [...definition.stages],
        checks: [...definition.checks],
        reviewPromptBuilt: true,
        promptKind: "production-user-analysis-prompt",
        prompt: reviewPage.text,
        offset: reviewPage.offset,
        limit: reviewPage.limit,
        pageChars: reviewPage.pageChars,
        totalChars: reviewPage.totalChars,
        hasMore: reviewPage.hasMore,
        nextOffset: reviewPage.nextOffset,
        chapterWindowOmitted: matchedDraft.content.length > maxChars,
        goldAnchorCount: gold.materials.merged.length,
        goldMaterialsSoftFailed: gold.softFailed,
        goldMaterialsDiagnostic: gold.diagnostic,
        promptSha256: frozenPrompt.promptSha256,
        pageSha256: reviewPage.pageSha256,
        offsetDomain: "utf16-code-units",
      }
      // dimension 分页时以 0 起点安全截断写作上下文，避免被更长的审查 prompt offset 误伤。
      promptSlice = await slicePaginatedText(
        snapshot.fullWritingPrompt,
        0,
        normalized.limit,
        "context.prepare_write",
      )
    } else {
      dimensionSection = {
        key: definition.key,
        label: definition.label,
        objective: definition.objective,
        stages: [...definition.stages],
        checks: [...definition.checks],
        reviewPromptBuilt: false,
        note: "未指定 draftId，仅返回维度评审标准；传入 draftId 可生成针对草稿正文的六维审查 prompt。",
      }
      promptSlice = await slicePaginatedText(
        snapshot.fullWritingPrompt,
        normalized.offset,
        normalized.limit,
        "context.prepare_write",
      )
    }
  } else {
    promptSlice = await slicePaginatedText(
      snapshot.fullWritingPrompt,
      normalized.offset,
      normalized.limit,
      "context.prepare_write",
    )
  }

  const effectiveConfig = await projectEffectiveConfig(configAtStart)

  let draftMeta: PrepareWriteContextResult["draft"]
  if (matchedDraft && matchedDraftSha256 !== undefined) {
    draftMeta = {
      draftId: matchedDraft.id,
      chapterName: matchedDraft.chapterName,
      chapterNumber: draftChapterNumber ?? null,
      status: matchedDraft.status,
      createdAt: matchedDraft.createdAt,
      chars: matchedDraft.content.length,
      partial: matchedDraft.partial === true,
      textSha256: matchedDraftSha256,
    }
  }

  // 终检：若准备期间切换项目、修改配置或批次过期，显式拒绝，不返回混合快照。
  if (stableCheckpointStringify(deps.readRuntimeConfig()) !== configBaseline) {
    if (cacheHit) cache.delete(snapshot.prepareId)
    throw new Error("context.prepare_write 拒绝：生效配置在准备期间发生变化，请重跑")
  }
  if (deps.readProjectPath() !== projectPath) {
    if (cacheHit) cache.delete(snapshot.prepareId)
    throw new Error("context.prepare_write 拒绝：项目在准备期间发生变化，请重跑")
  }
  if (cacheHit && snapshot.expiresAt <= now()) {
    cache.delete(snapshot.prepareId)
    throw new Error("context.prepare_write 拒绝：prepareId 在准备期间已过期；请新建 prepare 批次，不会静默重建")
  }

  if (!cacheHit) {
    const currentTime = now()
    for (const [id, entry] of cache) {
      if (entry.expiresAt <= currentTime) cache.delete(id)
    }
    while (cache.size >= MAX_PREPARE_CACHE_ENTRIES) {
      const oldestId = cache.keys().next().value
      if (oldestId === undefined) break
      cache.delete(oldestId)
    }
    cache.set(snapshot.prepareId, snapshot)
  } else {
    // 命中时刷新 LRU 顺序，确保最久未访问批次先被淘汰
    cache.delete(snapshot.prepareId)
    cache.set(snapshot.prepareId, snapshot)
  }

  const workflowHint = buildPrepareWriteWorkflowHint({
    prepareId: snapshot.prepareId,
    mode,
    targetChapter: snapshot.targetChapter,
    matchedDraft,
    promptHasMore: promptSlice.hasMore,
    promptNextOffset: promptSlice.nextOffset,
    dimensionSection,
  })

  const result: PrepareWriteContextResult = {
    projectPath,
    prepareId: snapshot.prepareId,
    prepareCache: {
      hit: cacheHit,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      ttlMs: PREPARE_CACHE_TTL_MS,
    },
    mode,
    targetChapter: snapshot.targetChapter,
    existingChapterCount: snapshot.existingChapterCount,
    isNewBook: snapshot.isNewBook,
    task: snapshot.task,
    novelMode: configAtStart.novelMode,
    warning: warnings.length > 0 ? warnings.join("；") : null,
    warnings,
    effectiveConfig,
    buildPolicy: {
      telemetryDiscarded: true,
      retrievalMode: resolvedRetrievalMode,
      retrievalNetworkAllowed,
      effectiveNetworkEnabled,
      networkRetrievalSkipped,
      zeroIoClaimed: false,
      llmCalls: 0,
      diskWrites: 0,
    },
    contextPackBuilt: true,
    packMetadata: copySerializable(snapshot.packMetadata),
    prompt: {
      ...promptSlice,
      offsetDomain: "utf16-code-units",
    },
    workflowHint,
    meta: {
      llmCalls: 0,
      diskWrites: 0,
    },
  }

  if (normalized.includePack) {
    result.contextPack = copySerializable(snapshot.pack)
  }
  if (normalized.includePlanningView) {
    result.planningView = planningView ?? null
  }
  if (draftMeta) {
    result.draft = draftMeta
  }
  if (matchedDraft && normalized.includeDraft) {
    result.draftText = matchedDraft.content
  }
  if (dimensionSection) {
    result.dimension = dimensionSection
  }

  return result
}
