// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * antigravity-hybrid-ingest.ts — 黄金混合模式检测 + 零 API Key 交互式章节快照摄取服务。
 *
 * ## 职责边界（合规与 Draft-first 红线）
 * 1. **Google Antigravity ToS 合规**：不提取/复用任何 OAuth 凭据，不绕过官方 ACP/MCP 边界。
 *    零 API Key 用户在纯订阅模式下，由 Antigravity 通过只读 `chapter.read` 读取正式章后
 *    生成结构化 `ChapterSnapshot` JSON，再由用户在 Niko Buddy 内审阅预览并显式确认落盘。
 * 2. **两段式严格分离**：
 *    - `prepareInteractiveChapterSnapshot` 严格只读（零磁盘写入），执行源校验、唯一正式章校验、
 *      JSON 提取/规范化与克隆体实体/正史冲突预览；
 *    - `commitInteractiveChapterSnapshot` 必须显式确认（`confirmed !== false`），校验 64 位 SHA-256
 *      源绑定后直接委托生产 `commitPreparedChapterIngest` 执行受锁原子提交。
 */

import { hasUsableLlm, type LlmProvider } from "@/lib/has-usable-llm"
import { toErrorMessage } from "@/lib/utils"
import {
  DEFAULT_NOVEL_CONFIG,
  type EmbeddingConfig,
  type LlmConfig,
  type NovelConfig,
} from "@/stores/wiki-store"
import {
  classifyMemoryIngest,
  readBackMemoryIngest,
  type AcceptDraftIngestStatus,
} from "./accept-draft-with-ingest"
import {
  commitPreparedChapterIngest,
  extractJsonObjectFromModelText,
  type ChapterSnapshot,
  type IngestResult,
  type PreparedChapterIngest,
  type ValidationWarning,
} from "./chapter-ingest"
import {
  linkSnapshotEntities,
  validateCanonConflicts,
  validateEntityReferences,
} from "./chapter-ingest-entity-validation"
import { resolveIngestTarget } from "./chapter-ingest-ingest-guards"
import { parseChapterNumber } from "./chapter-meta"
import { normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { canonicalizeSnapshotCharacters } from "./graph-adapter"
import { resolveNovelModel, type ModelResolverStoreSnapshot } from "./model-resolver"
import { buildSnapshotMemorySyncPreview } from "./snapshot-preview"
import { assertUniqueFinalChapterSource } from "./snapshot-scanner"
import { runTruthAuthorityCheck } from "./truth-authority-adapter"

export type AntigravityMemoryMode = "pure_subscription" | "golden_hybrid" | "full_api"

export type AntigravityMemoryModeReasonCode =
  | "no_extract_model_configured"
  | "dedicated_extract_model_configured"
  | "extract_only_via_provider_override"
  | "full_api_configured"

export interface AntigravityMemoryModeInfo {
  mode: AntigravityMemoryMode
  canAutoExtract: boolean
  autoIngestOnSave: boolean
  autoIngestReady: boolean
  embeddingEnabled: boolean
  extractModelLabel: string | null
  reasonCode: AntigravityMemoryModeReasonCode
}

export interface BuildInteractiveIngestPromptOptions {
  chapterNumber: number
  chapterPath: string
  chapterTitle?: string
  lang?: string
}

export interface PreparedInteractiveChapterSnapshot {
  prepared: PreparedChapterIngest
  snapshot: ChapterSnapshot
  preview: string
  validationWarnings: ValidationWarning[]
  warnings: string[]
  chapterPath: string
  chapterNumber: number
}

export type PrepareInteractiveSnapshotErrorCode =
  | "invalid_project"
  | "invalid_chapter_path"
  | "invalid_chapter_number"
  | "empty_json"
  | "novel_mode_disabled"
  | "not_chapter"
  | "not_final"
  | "duplicate_chapter_number"
  | "source_not_unique"
  | "source_unavailable"
  | "source_changed"
  | "chapter_number_mismatch"
  | "empty_chapter_body"
  | "no_json_found"
  | "invalid_json"
  | "invalid_snapshot_shape"
  | "snapshot_chapter_mismatch"
  | "empty_snapshot"
  | "no_llm"
  | "extract_failed"
  | "cancelled"

export type PrepareInteractiveSnapshotResult =
  | { ok: true; prepared: PreparedInteractiveChapterSnapshot }
  | { ok: false; errorCode: PrepareInteractiveSnapshotErrorCode; error: string }

export interface CommitInteractiveSnapshotOptions {
  confirmed?: boolean
  beforeFormalEffects?: () => Promise<void>
  onDataVersionBump?: () => void
  /** 为 true 时执行独立磁盘回读验证（`readBackMemoryIngest`）；缺省按本次结果分类（`classifyMemoryIngest`）。 */
  verifyReadback?: boolean
}

export interface CommitInteractiveSnapshotMemoryStatus {
  ingest: AcceptDraftIngestStatus
  failReason?: string
  ledgerSaveFailed?: boolean
  factsStoreFailed?: boolean
  failedProjections?: readonly string[]
  committedProjections?: readonly string[]
  pendingProjections?: readonly string[]
  canonOutcome?: IngestResult["canonOutcome"]
}

export interface CommitInteractiveSnapshotResult {
  ingestResult: IngestResult
  memoryStatus: CommitInteractiveSnapshotMemoryStatus
}

const KNOWN_LLM_PROVIDERS: ReadonlySet<string> = new Set<LlmProvider>([
  "custom",
  "ollama",
  "azure",
  "claude-code",
  "codex-cli",
  "antigravity-cli",
  "openai",
  "anthropic",
  "google",
  "minimax",
  "cursor-cli",
])

const EMPTY_LLM_CONFIG: LlmConfig = {
  provider: "openai",
  apiKey: "",
  model: "",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/

function isUsableLlmSafe(cfg: LlmConfig | null | undefined): boolean {
  if (!cfg || typeof cfg !== "object") return false
  if (typeof cfg.provider !== "string" || !KNOWN_LLM_PROVIDERS.has(cfg.provider)) return false
  return hasUsableLlm(cfg)
}

/**
 * 检测当前工作区的 Antigravity 记忆摄取运行模式（完全 null-safe，绝不隐式读取脏 store 或抛 TypeError）。
 *
 * - `pure_subscription`：未配置任何可用提取模型（零 API Key 纯订阅，走交互式 JSON 快照摄取）；
 * - `golden_hybrid`：配置了专用廉价/本地 `extractModel` 或仅通过 providerOverride 具备提取能力（主创作仍走 Antigravity）；
 * - `full_api`：主模型已配置且未另设独立 `extractModel`。
 */
export function detectAntigravityMemoryMode(
  llmConfig?: LlmConfig | null,
  novelConfig?: Partial<NovelConfig> | null,
  embeddingConfig?: Partial<EmbeddingConfig> | null,
  storeSnapshot?: ModelResolverStoreSnapshot | null,
): AntigravityMemoryModeInfo {
  const safeStoreSnapshot: ModelResolverStoreSnapshot = {
    providerConfigs: storeSnapshot?.providerConfigs ?? {},
    defaultLlmModel: storeSnapshot?.defaultLlmModel ?? "",
    aiChatModel: storeSnapshot?.aiChatModel ?? "",
  }

  const hasDedicatedExtractModel = Boolean(novelConfig?.extractModel?.trim())
  const hasFallbackStoreModel = Boolean(
    safeStoreSnapshot.defaultLlmModel?.trim() || safeStoreSnapshot.aiChatModel?.trim(),
  )
  const hasConfig = Boolean(llmConfig || hasDedicatedExtractModel || hasFallbackStoreModel)

  const safeLlm: LlmConfig = llmConfig && typeof llmConfig === "object"
    ? llmConfig
    : EMPTY_LLM_CONFIG
  const safeNovel: NovelConfig = {
    ...DEFAULT_NOVEL_CONFIG,
    ...(novelConfig && typeof novelConfig === "object" ? novelConfig : {}),
  }

  const extractLlm = hasConfig
    ? resolveNovelModel(safeLlm, safeNovel, "extract", safeStoreSnapshot)
    : null
  const canAutoExtract = Boolean(extractLlm && isUsableLlmSafe(extractLlm))
  const mainHasLlm = isUsableLlmSafe(llmConfig)

  const mode: AntigravityMemoryMode = !canAutoExtract
    ? "pure_subscription"
    : hasDedicatedExtractModel || !mainHasLlm
      ? "golden_hybrid"
      : "full_api"

  const reasonCode: AntigravityMemoryModeReasonCode = !canAutoExtract
    ? "no_extract_model_configured"
    : hasDedicatedExtractModel
      ? "dedicated_extract_model_configured"
      : !mainHasLlm
        ? "extract_only_via_provider_override"
        : "full_api_configured"

  const autoIngestOnSave = novelConfig?.autoIngestOnSave !== false
  const autoIngestReady = canAutoExtract && autoIngestOnSave
  const embeddingEnabled = Boolean(embeddingConfig?.enabled)
  const extractModelLabel = canAutoExtract && extractLlm
    ? `${extractLlm.provider}/${extractLlm.model}`
    : null

  return {
    mode,
    canAutoExtract,
    autoIngestOnSave,
    autoIngestReady,
    embeddingEnabled,
    extractModelLabel,
    reasonCode,
  }
}

/**
 * 生成供零 API Key 用户复制给 Antigravity 的交互式章节快照提取提示词（纯函数）。
 * 严禁调用任何写入工具，仅允许用只读 `chapter.read` 读取正式章并输出单一 JSON 代码块。
 */
export function buildInteractiveIngestPrompt(options: BuildInteractiveIngestPromptOptions): string {
  const { chapterNumber, chapterPath, chapterTitle, lang } = options
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error("buildInteractiveIngestPrompt 需要 >= 1 的整数 chapterNumber")
  }
  const safePath = (chapterPath ?? "").trim()
  if (!safePath) {
    throw new Error("buildInteractiveIngestPrompt 需要非空 chapterPath")
  }
  const titleText = chapterTitle?.trim() ? `（${chapterTitle.trim()}）` : ""
  const isEnglish = typeof lang === "string" && lang.toLowerCase().startsWith("en")

  const schemaTemplate = `{
  "chapterId": "chapter-${chapterNumber}",
  "chapterNumber": ${chapterNumber},
  "summary": "章节摘要（200字以内）",
  "characters": ["出场人物正式名列表"],
  "characterAliases": { "人物正式名": ["昵称", "旧名"] },
  "locations": ["出场地点列表"],
  "organizations": ["出场组织列表"],
  "items": ["出场物品列表"],
  "events": ["关键事件列表"],
  "characterStateChanges": ["人物状态变化描述"],
  "relationshipChanges": ["人物关系变化描述"],
  "knowledgeChanges": ["角色认知变化描述"],
  "foreshadowingChanges": ["新增伏笔：伏笔名称-伏笔描述", "推进伏笔：伏笔名称-推进进展", "回收伏笔：伏笔名称-回收结果"],
  "newCanonFacts": ["新增正史设定"],
  "beliefFacts": [{ "subject": "认知主体", "predicate": "认为/怀疑/以为", "object": "角色所信内容" }],
  "hypothesisFacts": [{ "subject": "假设主体", "predicate": "假设/猜测/推测", "object": "假设内容" }],
  "timelineEvents": ["时间线事件"],
  "conflicts": ["冲突变化描述"],
  "endingHook": "章节结尾钩子描述",
  "graphNodes": ["图谱节点列表"],
  "graphEdges": ["A->关系->B（关系仅限：出场于|发生于|属于|持有|敌对|合作|怀疑|隐瞒|知道|不知道|推进伏笔|回收伏笔|新增伏笔|导致|揭示|影响|位于）"],
  "povCharacter": "本章 POV 角色（可选）",
  "characterDetails": {
    "人物正式名": {
      "identity": "身份（可选）",
      "faction": "阵营（可选）",
      "goals": "本章目标（可选）",
      "arcChange": "弧光变化（本章中该人物的成长或情绪转折）"
    }
  },
  "locationDetails": {},
  "organizationDetails": {},
  "itemDetails": {
    "物品名": {
      "holder": "当前持有者",
      "previousHolders": "前持有者（如有转手）",
      "abilities": "能力（可选）",
      "limitations": "限制（可选）",
      "origin": "来源（可选）"
    }
  },
  "eventDetails": {}
}`

  if (isEnglish) {
    return [
      `Please read formal Chapter ${chapterNumber}${titleText} using ONLY the read-only MCP tool \`chapter.read\` (chapter selector: "${chapterNumber}", file: "${safePath}").`,
      "",
      "STRICT RULES:",
      "1. Do NOT call any write tools (`chapter.write`, `chapter.write_direct`, `memory.write`, `outline.write`, `draft.patch`, `character.upsert`, etc.). Only read the chapter.",
      "2. Output ONLY a single fenced ```json ... ``` code block containing the structured `ChapterSnapshot` JSON — no prose before or after.",
      `3. Keep \`chapterNumber\` strictly equal to ${chapterNumber} and \`chapterId\` equal to "chapter-${chapterNumber}".`,
      "4. Put character subjective beliefs (e.g., X believes/suspects...) in `beliefFacts` and guesses in `hypothesisFacts`; never pollute `newCanonFacts` with subjective beliefs.",
      "5. Put canonical character names in `characters` and nicknames/former names in `characterAliases`.",
      "6. Format every entry in `foreshadowingChanges` using exact prefixes: `新增伏笔：伏笔名称-伏笔描述`, `推进伏笔：伏笔名称-推进进展`, or `回收伏笔：伏笔名称-回收结果` (use `[]` when no foreshadowing changed).",
      "7. When a character has an arc/emotional shift, fill `characterDetails.<name>.arcChange`; when a notable item is held or transferred, fill `itemDetails.<item>.holder` and (if transferred) `itemDetails.<item>.previousHolders`. Omit placeholder entries when the chapter has no explicit details.",
      "",
      "JSON schema template:",
      "```json",
      schemaTemplate,
      "```",
    ].join("\n")
  }

  return [
    `请仅使用只读 MCP 工具 \`chapter.read\` 读取正式章节：第 ${chapterNumber} 章${titleText}（章号选择器：\`"${chapterNumber}"\`，文件路径：\`${safePath}\`）。`,
    "",
    "硬性约束：",
    "1. 严禁调用任何写入工具（禁止调用 `chapter.write`、`chapter.write_direct`、`memory.write`、`outline.write`、`draft.patch`、`character.upsert` 等），只允许读取正文。",
    "2. 请严格仅输出一个 ```json ... ``` 围栏代码块（符合 `ChapterSnapshot` 结构），不要在代码块前后添加额外说明文字；用户将在 Niko Buddy 内预览并确认后入库。",
    `3. \`chapterNumber\` 必须严格为 ${chapterNumber}，\`chapterId\` 必须为 \`"chapter-${chapterNumber}"\`。`,
    "4. 模态判定规则：仅当原文出现「X认为/怀疑/以为/相信/觉得」等认知动词时提取为 `beliefFacts`；仅当出现「假设/猜测/推测/猜想」时提取为 `hypothesisFacts`；其余客观正史进 `newCanonFacts`，绝不让角色认知污染正史。",
    "5. 人物归一规则：正式名放进 `characters`，昵称/小名/旧名放进 `characterAliases`，不要把同一人物拆成多个条目；`*Details` 字段仅在正文有明确信息时填写，勿照抄模板占位符。",
    "6. 伏笔格式规则：`foreshadowingChanges` 每条必须严格使用前缀 `新增伏笔：伏笔名称-伏笔描述`、`推进伏笔：伏笔名称-推进进展` 或 `回收伏笔：伏笔名称-回收结果`（无伏笔变化则填 `[]`），以便确定性写入伏笔库。",
    "7. 投影明细规则：角色在本章有成长/情绪转折时填写 `characterDetails.<name>.arcChange`；关键物品有归属或转手时填写 `itemDetails.<item>.holder` 与 `itemDetails.<item>.previousHolders`。",
    "",
    "请严格按以下 JSON 结构输出：",
    "```json",
    schemaTemplate,
    "```",
  ].join("\n")
}

function isSnapshotSemanticallyEmpty(snapshot: ChapterSnapshot): boolean {
  const hasText = Boolean(snapshot.summary.trim() || snapshot.endingHook.trim())
  if (hasText) return false
  const arrays: ReadonlyArray<readonly unknown[] | undefined> = [
    snapshot.characters,
    snapshot.locations,
    snapshot.organizations,
    snapshot.items,
    snapshot.events,
    snapshot.characterStateChanges,
    snapshot.relationshipChanges,
    snapshot.knowledgeChanges,
    snapshot.foreshadowingChanges,
    snapshot.newCanonFacts,
    snapshot.beliefFacts,
    snapshot.hypothesisFacts,
    snapshot.timelineEvents,
    snapshot.conflicts,
    snapshot.graphNodes,
    snapshot.graphEdges,
  ]
  return arrays.every((arr) => !arr || arr.length === 0)
}

/**
 * 阶段 1（严格只读，零磁盘写入）：
 * 解析并校验正式章源与用户粘贴的 Antigravity JSON 输出，生成可直接提交的 `PreparedChapterIngest` 与人类可读同步预览。
 */
export async function prepareInteractiveChapterSnapshot(
  projectPath: string,
  chapterPath: string,
  chapterNumber: number,
  rawJsonText: string,
  options?: { novelMode?: boolean },
): Promise<PrepareInteractiveSnapshotResult> {
  if (!projectPath || !projectPath.trim()) {
    return { ok: false, errorCode: "invalid_project", error: "未打开项目，无法准备交互式章节快照" }
  }
  if (!chapterPath || !chapterPath.trim()) {
    return { ok: false, errorCode: "invalid_chapter_path", error: "缺少正式章节路径" }
  }
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    return { ok: false, errorCode: "invalid_chapter_number", error: "chapterNumber 必须是 >= 1 的整数" }
  }
  if (typeof rawJsonText !== "string" || !rawJsonText.trim()) {
    return { ok: false, errorCode: "empty_json", error: "请先粘贴 Antigravity 输出的章节快照 JSON" }
  }

  let target: Awaited<ReturnType<typeof resolveIngestTarget>>
  try {
    target = await resolveIngestTarget(
      projectPath,
      chapterPath,
      {
        ...(options?.novelMode !== undefined ? { novelMode: options.novelMode } : {}),
        requireUniqueFinalChapter: true,
      },
      { requireExtractionModel: false },
    )
  } catch (err) {
    return {
      ok: false,
      errorCode: "source_unavailable",
      error: `读取正式章源文件失败：${toErrorMessage(err)}`,
    }
  }

  if (!target.ok) {
    const code: PrepareInteractiveSnapshotErrorCode = target.result.failReason ?? "novel_mode_disabled"
    const messages: Record<string, string> = {
      novel_mode_disabled: "当前项目未开启小说模式（novelMode=false）",
      not_chapter: "目标文件不是规范的章节页（缺少 type: chapter）",
      not_final: "目标章节尚未定稿（chapter_status 必须为 final）",
      invalid_chapter_number: "目标章节 frontmatter 的 chapter_number 非法",
      duplicate_chapter_number: "同章号存在多个正式章文件，请先处理冲突",
      source_unavailable: "正式章源文件不可读",
      source_changed: "正式章源文件在准备期间已变更",
    }
    return { ok: false, errorCode: code, error: messages[code] ?? `源章节校验未通过（${code}）` }
  }

  if (target.fm.type !== "chapter") {
    return { ok: false, errorCode: "not_chapter", error: "目标文件不是规范章节页（type !== chapter）" }
  }
  if (target.chapterNumber !== chapterNumber) {
    return {
      ok: false,
      errorCode: "chapter_number_mismatch",
      error: `正式章文件章号（第 ${target.chapterNumber} 章）与请求章号（第 ${chapterNumber} 章）不一致`,
    }
  }
  if (!target.body.trim()) {
    return { ok: false, errorCode: "empty_chapter_body", error: "正式章正文为空，无法提取快照" }
  }

  const [bodySha256, contentSha256] = await Promise.all([
    computeCheckpointDigest(target.body),
    computeCheckpointDigest(target.content),
  ])

  try {
    await assertUniqueFinalChapterSource(target.pp, chapterPath, chapterNumber)
  } catch (err) {
    const msg = toErrorMessage(err)
    const isDuplicate = /多个正式章|Multiple final chapter/i.test(msg)
    return {
      ok: false,
      errorCode: isDuplicate ? "duplicate_chapter_number" : "source_not_unique",
      error: msg,
    }
  }

  const jsonText = extractJsonObjectFromModelText(rawJsonText)
  if (!jsonText) {
    return {
      ok: false,
      errorCode: "no_json_found",
      error: "未在粘贴内容中检测到合法的 JSON 对象（请粘贴完整的 ```json ... ``` 代码块）",
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    return {
      ok: false,
      errorCode: "invalid_json",
      error: `快照 JSON 解析失败：${toErrorMessage(err)}`,
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      errorCode: "invalid_snapshot_shape",
      error: "快照 JSON 根节点必须是对象",
    }
  }

  const rawRecord = parsed as Record<string, unknown>
  if (rawRecord.chapterNumber !== undefined && rawRecord.chapterNumber !== null) {
    const parsedNum = parseChapterNumber(rawRecord.chapterNumber)
    if (parsedNum !== chapterNumber) {
      return {
        ok: false,
        errorCode: "snapshot_chapter_mismatch",
        error: `JSON 中的 chapterNumber（${String(rawRecord.chapterNumber)}）与目标章号（${chapterNumber}）不一致`,
      }
    }
  }

  const normalized = normalizeChapterSnapshot(
    {
      ...rawRecord,
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
      // 剥离外部不可信的持久化身份与历史字段，由 commit 阶段从磁盘真源安全派生。
      sourceType: undefined,
      sourceSequence: undefined,
      revision: undefined,
      snapshotId: undefined,
      supersedes: undefined,
      isHistorical: undefined,
      memorySyncedAt: undefined,
      entityIsNew: {},
      validationWarnings: [],
    },
    { chapterId: `chapter-${chapterNumber}`, chapterNumber },
  )
  if (!normalized) {
    return {
      ok: false,
      errorCode: "invalid_snapshot_shape",
      error: "无法将 JSON 规范化为合法的 ChapterSnapshot",
    }
  }

  const canonicalized = canonicalizeSnapshotCharacters(normalized)
  if (isSnapshotSemanticallyEmpty(canonicalized)) {
    return {
      ok: false,
      errorCode: "empty_snapshot",
      error: "快照内容为空（摘要、人物、事件、设定等核心字段均为空），拒绝入库",
    }
  }

  // 在独立克隆体上执行只读实体/正史冲突预览校验（绝不触发磁盘写或污染提交对象）。
  const validationClone = JSON.parse(JSON.stringify(canonicalized)) as ChapterSnapshot
  const warnings: string[] = []
  let validationWarnings: ValidationWarning[] = []
  try {
    const linkWarnings = await linkSnapshotEntities(target.pp, validationClone)
    const entityWarnings = await validateEntityReferences(target.pp, validationClone)
    const canonWarnings = await validateCanonConflicts(target.pp, validationClone)
    const truthAuthorityWarnings = runTruthAuthorityCheck(validationClone)
    validationWarnings = [
      ...linkWarnings,
      ...entityWarnings,
      ...canonWarnings,
      ...truthAuthorityWarnings,
    ]
    validationClone.validationWarnings = validationWarnings
  } catch (err) {
    warnings.push(`实体与正史只读预检部分降级：${toErrorMessage(err)}`)
  }

  const preview = buildSnapshotMemorySyncPreview(validationClone)
  const prepared: PreparedChapterIngest = {
    snapshot: canonicalized,
    source: {
      readPath: chapterPath,
      chapterNumber,
      bodySha256,
      contentSha256,
    },
  }

  return {
    ok: true,
    prepared: {
      prepared,
      snapshot: validationClone,
      preview,
      validationWarnings,
      warnings,
      chapterPath,
      chapterNumber,
    },
  }
}

/**
 * 阶段 2（用户显式确认后落盘）：
 * 校验确认标记与 64 位源摘要，委托生产 `commitPreparedChapterIngest` 原子提交并分类返回记忆状态。
 */
export async function commitInteractiveChapterSnapshot(
  projectPath: string,
  preparedSnapshot: PreparedInteractiveChapterSnapshot,
  options?: CommitInteractiveSnapshotOptions,
): Promise<CommitInteractiveSnapshotResult> {
  if (!projectPath || !projectPath.trim()) {
    throw new Error("未打开项目，无法提交交互式章节快照")
  }
  if (options?.confirmed === false) {
    throw new Error("提交交互式章节快照必须经用户明确确认（confirmed !== false）")
  }
  if (!preparedSnapshot || !preparedSnapshot.prepared || !preparedSnapshot.prepared.source) {
    throw new Error("缺少有效的预处理章节快照（preparedSnapshot）")
  }

  const { source, snapshot } = preparedSnapshot.prepared
  if (typeof source.readPath !== "string" || !source.readPath.trim()) {
    throw new Error("无效的源章节路径（source.readPath）")
  }
  if (
    !Number.isSafeInteger(source.chapterNumber)
    || source.chapterNumber < 1
    || source.chapterNumber !== preparedSnapshot.chapterNumber
    || snapshot.chapterNumber !== source.chapterNumber
  ) {
    throw new Error("预处理快照与源绑定的章号不一致")
  }
  if (typeof source.bodySha256 !== "string" || !SHA256_HEX_RE.test(source.bodySha256)) {
    throw new Error("无效的源正文摘要 bodySha256（需要 64 位小写十六进制 SHA-256）")
  }
  if (typeof source.contentSha256 !== "string" || !SHA256_HEX_RE.test(source.contentSha256)) {
    throw new Error("无效的源文件摘要 contentSha256（需要 64 位小写十六进制 SHA-256）")
  }

  const ingestResult = await commitPreparedChapterIngest(
    projectPath,
    preparedSnapshot.prepared,
    options?.beforeFormalEffects,
  )

  const memoryStatus: CommitInteractiveSnapshotMemoryStatus = options?.verifyReadback
    ? await readBackMemoryIngest(projectPath, source.readPath, ingestResult)
    : classifyMemoryIngest(ingestResult)

  if (ingestResult.snapshot !== null) {
    options?.onDataVersionBump?.()
  }

  return { ingestResult, memoryStatus }
}
