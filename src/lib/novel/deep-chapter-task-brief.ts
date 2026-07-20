/**
 * ISS-20260712-ARCH-1 (Wave 1, 第 3 文件): task-brief 处理 + prompt 构造集群。
 *
 * 从 deep-chapter-generation.ts 抽出——该集群是独立叶子辅助群 (任务书源文本
 * 清洗 / 不可执行检测 / 噪声标记识别 / 结构化 fallback 构造 / 修复 prompt),
 * 被 generateTaskBrief (:1551-1610) 和 generateDraft (:1706-1715) 两处主流程
 * 入口调用, 无跨集群共享。守 S-20260720-86pp (SRP 巨文件拆分按抽象层分文件)。
 *
 * 常量 (TASK_BRIEF_* 正则/Set/数组 + DRAFT_META_* 正则) 随集群迁——仅本集群引用。
 * MAX_TASK_BRIEF_REPAIR_ATTEMPTS 留原文件 (主流程 generateTaskBrief :1577 用, 非本集群)。
 * trimForThinking 留原文件 (thinking 格式集群共用), 本文件 import。
 */
import type { ContextPack } from "./context-engine"
import { buildStableContextPrefix, type ChapterLengthSpec } from "./deep-chapter-prompts"
import { trimForThinking } from "./deep-chapter-generation"

const TASK_BRIEF_META_REQUEST_RE = /请(?:先)?补充|给我.{0,12}(?:五句|五句话)|待补全后再推进|等你补完/u
const TASK_BRIEF_META_REFUSAL_RE = /只给任务书|不写正文|本轮只|无法开写|无法推进/u
const DRAFT_META_REQUEST_RE = /请(?:先)?补充|给我.{0,12}(?:五句|五句话)|待补全后再推进|等你补完/u
const DRAFT_META_REFUSAL_RE = /只给任务书|不写正文|本轮只|任务书|错误草稿/u
const TASK_BRIEF_STRUCTURAL_MARKERS = [
  "必须完成",
  "禁止违背",
  "角色状态",
  "伏笔推进",
  "结尾钩子",
] as const
const TASK_BRIEF_SOURCE_MAX_SEGMENTS = 2
const TASK_BRIEF_SOURCE_MAX_SEGMENT_LENGTH = 72
const TASK_BRIEF_SOURCE_MAX_TOTAL_LENGTH = 160
const TASK_BRIEF_SOURCE_PREFIX_RE = /^(?:(?:本章必须完成|禁止违背|角色状态|伏笔推进|结尾钩子|暂定设定|长度要求|原始请求对齐|优先承接上一章结尾|注意推进或回应相关伏笔|不要违背既有设定|不要写乱当前时间线|不要写错当前人物状态|优先延续上一章结尾带出的悬念或动作|结合近期伏笔决定是否继续铺设、推进或回收|保持时间线连续|参考记忆库相关命中补足场景细节|注意承接最近剧情|场景必须承接)\s*[：:]\s*)+/u
const TASK_BRIEF_NOISE_MARKERS = [
  "---",
  "--- type:",
  "memory_type:",
  "snapshot_id:",
  "sources: [",
  "source_type:",
  "source_sequence:",
  "source_revision:",
  "chapter_status:",
  "chapter_number:",
  "[[",
  "]]",
] as const
const TASK_BRIEF_NOISE_LINE_RE = /^(?:-+\s*)?(?:type|memory_type|title|created|updated|tags|aliases|related|snapshot_id|source_type|source_sequence|source_revision|is_historical|sources|chapter_number|chapter_status)\s*[:：]/iu
const TASK_BRIEF_NOISE_FRAGMENT_RE = /(?:---(?:\s*type:)?|snapshot_id:|sources:\s*\[|source_(?:type|sequence|revision):|chapter_status:|chapter_number:|memory_type:|\[\[|\]\]|\{"knows":|\{"doesNotKnow":)/iu
const TASK_BRIEF_NOISE_LABELS = new Set([
  "正式设定记忆",
  "时间线记忆",
  "角色认知记忆",
  "人物状态记忆",
  "章节信息",
  "候选区",
  "当前正式认知",
  "当前正式状态",
  "正式事实",
  "最新来源",
  "相关章节",
  "关键事件",
  "关系变化",
  "角色认知",
  "当前持有者",
  "前持有者",
  "能力",
  "限制",
  "区域",
  "类型",
])

function normalizeMetaText(content: string): string {
  return content.replace(/\s+/g, "")
}

function sanitizeTaskBriefSourceText(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return ""

  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/(?:^|\s)---+(?=\s|$)/gu, "\n")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/[（(]来源[:：][^）)]*[）)]/gu, "")
    .replace(/\{[^{}]{0,200}\}/gu, " ")
    .replace(/\s+-\s+/gu, "\n- ")

  const segments = normalized
    .split(/\n+/u)
    .flatMap((line) => line.split(/[；;]/u))
    .map((line) => normalizeTaskBriefCandidateLine(line))
    .filter((line) => isUsableTaskBriefCandidateLine(line))

  const preferredSegments = segments.some(containsCjkTaskBriefText)
    ? segments.filter((line) => containsCjkTaskBriefText(line))
    : segments

  // F-21a (PAT-G2 mirror of uniqueSuggestions :271): Set-based dedup instead
  // of deduped.includes (which is O(n) per segment → O(n²) overall). Dedup is
  // keyed on the raw segment to match the prior .includes semantics (the
  // pushed value is the trimmed segment, but the dedup key stays raw).
  const deduped: string[] = []
  const dedupedSet = new Set<string>()
  for (const segment of preferredSegments) {
    if (dedupedSet.has(segment)) continue
    dedupedSet.add(segment)
    deduped.push(trimForThinking(segment, TASK_BRIEF_SOURCE_MAX_SEGMENT_LENGTH))
    if (deduped.length >= TASK_BRIEF_SOURCE_MAX_SEGMENTS) break
  }

  if (deduped.length === 0) return ""
  return trimForThinking(deduped.join("；"), TASK_BRIEF_SOURCE_MAX_TOTAL_LENGTH)
}

function normalizeTaskBriefCandidateLine(value: string): string {
  const trimmed = value.trim()
  const isHeading = /^#{1,6}\s*/u.test(trimmed)
  let normalized = trimmed
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^-+\s*/u, "")
    .replace(/^第\d+章[：:]\s*/u, "")
    .replace(/^Chapter\s*\d+[：:]\s*/iu, "")
    .replace(/^(?:当前状态|最近更新|关系变化|角色认知|关键事件|说明|已知|未知|当前正式事实|当前正式认知|当前正式状态)[：:]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()

  while (TASK_BRIEF_SOURCE_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(TASK_BRIEF_SOURCE_PREFIX_RE, "").trim()
  }

  if (isHeading && !/[：:，。！？；,.!?]/u.test(normalized)) {
    return ""
  }

  return normalized
}

function containsCjkTaskBriefText(value: string): boolean {
  return /[㐀-鿿]/u.test(value)
}

function isUsableTaskBriefCandidateLine(value: string): boolean {
  if (!value) return false
  if (TASK_BRIEF_NOISE_LABELS.has(value)) return false
  if (TASK_BRIEF_NOISE_LINE_RE.test(value) || TASK_BRIEF_NOISE_FRAGMENT_RE.test(value)) return false
  if (looksLikeNarrativeTaskBrief(value)) return false
  return value.length >= 6
}

function chapterLengthRequirement(lengthSpec: ChapterLengthSpec): string {
  return `目标约 ${lengthSpec.targetChars} 字；低于 ${lengthSpec.minChars} 字视为未完成。`
}

function isNonExecutableTaskBrief(taskBrief: string): boolean {
  const normalized = normalizeMetaText(taskBrief)
  if (!normalized) return false
  return TASK_BRIEF_META_REQUEST_RE.test(normalized) && TASK_BRIEF_META_REFUSAL_RE.test(normalized)
}

function countTaskBriefStructureHits(taskBrief: string): number {
  return TASK_BRIEF_STRUCTURAL_MARKERS.reduce((count, marker) => (
    taskBrief.includes(marker) ? count + 1 : count
  ), 0)
}

function containsPollutedTaskBriefMarkers(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  const markerHits = TASK_BRIEF_NOISE_MARKERS.reduce((count, marker) => (
    trimmed.includes(marker) ? count + 1 : count
  ), 0)
  if (markerHits === 0) return false
  return countTaskBriefStructureHits(trimmed) >= 2 || trimmed.length >= 240
}

function looksLikeNarrativeTaskBrief(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  if (/^\[N\]/u.test(trimmed)) return true
  if (/^#\s*第.{0,20}章/mu.test(trimmed) || /^第.{0,20}章(?:\s|$)/mu.test(trimmed)) {
    return true
  }
  if (countTaskBriefStructureHits(trimmed) >= 2) return false
  const longParagraphs = trimmed
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/g, ""))
    .filter((paragraph) => paragraph.length >= 40)
  return longParagraphs.length >= 3
}

export function shouldRepairTaskBrief(taskBrief: string): boolean {
  return isNonExecutableTaskBrief(taskBrief)
    || looksLikeNarrativeTaskBrief(taskBrief)
    || containsPollutedTaskBriefMarkers(taskBrief)
}

export function shouldUseDeterministicTaskBriefFallback(taskBrief: string): boolean {
  const trimmed = taskBrief.trim()
  if (!trimmed) return false
  if (containsPollutedTaskBriefMarkers(trimmed)) return true
  if (countTaskBriefStructureHits(trimmed) >= 2 && trimmed.length >= 600) return true
  return looksLikeNarrativeTaskBrief(trimmed) && trimmed.length >= 600
}

export function isMetaDraftContent(draftContent: string): boolean {
  const normalized = normalizeMetaText(draftContent)
  if (!normalized) return false
  if (/^\[N\]/u.test(draftContent.trim())) return true
  return DRAFT_META_REQUEST_RE.test(normalized) && DRAFT_META_REFUSAL_RE.test(normalized)
}

export function buildTaskBriefRepairPrompt(
  outlinePrompt: string,
  contextPrompt: string,
  invalidTaskBrief: string,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  return [
    buildStableContextPrefix(outlinePrompt, contextPrompt),
    "[TASK_BRIEF_MARKER]",
    "",
    "你刚才输出的写作任务书不可直接执行。",
    "它可能把缺失信息转回给用户、声明本轮不直接写正文，或者直接漂移成了小说正文片段。",
    "请把它改写成一份可以立刻开写的结构化章节任务书。",
    "",
    "硬性要求：",
    "1. 不得向用户追问，不得要求“补充设定”“给我五句话”“下一轮再写”。",
    "2. 不得写“只给任务书”“不写正文”“待补全后再推进”这类元说明。",
    "3. 不得输出小说正文、对话片段、场景描写、章节标题或任何可直接作为正文保存的内容。",
    "4. 如果上下文不足，必须自行补出最小必要设定，并明确标成“暂定设定”。",
    "5. 任务书必须显式覆盖：本章必须完成、禁止违背、角色状态、伏笔推进、结尾钩子。",
    `6. 这份任务书必须足以直接写出完整章节正文，${chapterLengthRequirement(lengthSpec)}`,
    "7. 严格按下面的结构输出，不得改标题，不得额外添加章节标题、正文片段或解释：",
    "本章必须完成：...",
    "禁止违背：...",
    "角色状态：...",
    "伏笔推进：...",
    "结尾钩子：...",
    "暂定设定：...",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    `用户请求：${userRequest}`,
    "",
    "不可执行任务书：",
    invalidTaskBrief,
  ].join("\n")
}

function pickTaskBriefFallbackValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = sanitizeTaskBriefSourceText(value)
    if (normalized) return normalized
  }
  return ""
}

function taskBriefFallbackLine(label: string, value: string): string {
  return `${label}：${value.trim()}`
}

export function buildFallbackTaskBrief(
  contextPack: ContextPack,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  const chapterLabel = chapterNumber ? `第${chapterNumber}章` : "当前章节"
  const mustDo = pickTaskBriefFallbackValue(
    contextPack.mustDo,
    contextPack.chapterGoal,
    `承接上一章结尾，完成 ${chapterLabel} 的核心冲突推进，并自然落出下一步行动。`,
  )
  const mustAvoid = pickTaskBriefFallbackValue(
    contextPack.mustAvoid,
    contextPack.canonRules,
    contextPack.timeline,
    "不得违背既有设定、角色认知边界与时间线。",
  )
  const characterState = pickTaskBriefFallbackValue(
    contextPack.characterStates,
    contextPack.cognitionStates,
    "沿用现有角色状态与认知边界，不擅自越界知晓或反常行动。",
  )
  const foreshadowing = pickTaskBriefFallbackValue(
    contextPack.foreshadowingStates,
    contextPack.searchResults,
    contextPack.graphSearchResults,
    "至少推进一个既有线索或伏笔，并把它和本章结果绑定。",
  )
  const endingHook = pickTaskBriefFallbackValue(
    contextPack.nextChapterAdvice,
    contextPack.previousChapterEnding && `结尾需承接上一章留下的压力：${contextPack.previousChapterEnding}`,
    "结尾保留下一章可直接承接的新压力、线索或选择题。",
  )
  const provisionalSetting = pickTaskBriefFallbackValue(
    contextPack.relatedSettings,
    contextPack.previousChapterEnding && `场景必须承接：${contextPack.previousChapterEnding}`,
    "若上下文仍有缺口，只补最小必要场景设定，不新增会推翻既有设定的事实。",
  )

  return [
    taskBriefFallbackLine("本章必须完成", mustDo),
    taskBriefFallbackLine("禁止违背", mustAvoid),
    taskBriefFallbackLine("角色状态", characterState),
    taskBriefFallbackLine("伏笔推进", foreshadowing),
    taskBriefFallbackLine("结尾钩子", endingHook),
    taskBriefFallbackLine("暂定设定", provisionalSetting),
    taskBriefFallbackLine("长度要求", chapterLengthRequirement(lengthSpec)),
    taskBriefFallbackLine(
      "原始请求对齐",
      sanitizeTaskBriefSourceText(userRequest) || `围绕 ${chapterLabel} 的写作需求推进。`,
    ),
  ].join("\n")
}

export function buildDraftRecoveryPrompt(
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  invalidDraft: string,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
): string {
  return [
    buildStableContextPrefix(outlinePrompt, contextPrompt),
    "[DRAFT_STAGE_MARKER]",
    "",
    "你上一次输出成了任务说明、追问用户或其他元文本，而不是小说正文。",
    "请丢弃那份错误输出，重新直接写出可审查、可保存的章节正文。",
    "",
    "硬性要求：",
    "1. 只输出小说正文，不得输出任务书、解释、追问、补设定请求或后续说明。",
    "2. 如果任务书里仍有缺口，必须自行补出最小必要设定并自然写进正文，不得把任务转回给用户。",
    `3. 必须写成完整章节，${chapterLengthRequirement(lengthSpec)}`,
    "4. 必须保留冲突推进、人物互动、细节描写和结尾钩子。",
    "5. 禁止复读、循环输出、重复段落，以及任何“等你补充后再写”的元文本。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    `用户请求：${userRequest}`,
    "",
    "写作任务书：",
    taskBrief,
    "",
    "错误草稿（仅用于识别错误模式，不可沿用其元文本表达）：",
    invalidDraft,
  ].join("\n")
}
