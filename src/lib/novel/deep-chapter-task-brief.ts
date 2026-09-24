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

/** Structure-first residual rewrite: optional plan injection into task brief. */
export {
  appendStructurePlanToTaskBrief,
  taskBriefHasStructurePlan,
} from "./structure-first-rewrite"

// Wave 3 (v2.5.0): 计划模式预填接线（planning/prefill.ts 的 re-export 面；
// 聚合逻辑在 planning/ 模块，本文件保持任务书清洗/修复/fallback 集群 SRP）。
export {
  appendPlanningBlockToTaskBrief,
  taskBriefHasPlanningBlock,
} from "./planning/prefill"

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
    "5b. 必须追加【章节契约】machine-readable 段（供写后核对自动解析）：逐行输出必须节拍：… / 禁区：… / 连贯核对：…，方向提示（情绪主色/兑现点/钩子目标）有则输出、无则省略，末行固定为方向提示豁免声明。",
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
  /* v8 ignore next */
  return ""
}

function taskBriefFallbackLine(label: string, value: string): string {
  return `${label}：${value.trim()}`
}

// ── §GAP-88-01 章节契约 machine-readable 段 ─────────────────────────────
// ainovel-cli chapter_contract 模式吸收：写前约束（任务书携带）+ 写后核对
// （checkChapterContract 消费）。渲染/解析同构，标签固定，不得改名。

export interface ChapterContractSection {
  requiredBeats: string[]
  forbiddenMoves: string[]
  continuityChecks: string[]
  emotionTarget?: string
  payoffPoints?: string[]
  hookGoal?: string
}

export const CHAPTER_CONTRACT_HEADER = "【章节契约】"
export const CHAPTER_CONTRACT_WAIVER = "方向提示不是机械打卡项：自然节奏与契约细项冲突时优先保证章节成立，并在返修说明中记录取舍。"

/** sanitize 后文本按 ；/换行 切分为契约条目（上限 5，防膨胀）。 */
export function splitContractLines(value: string): string[] {
  if (!value.trim()) return []
  return value
    .split(/[；;\n]/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5)
}

/** fallback 紧凑契约行：必须/禁区/核对首条各 8 字符锚点摘要，‖ 分隔。
 * 8 字符 ≥ hit() 4 字符最小锚点下限（短锚点恒命中=宽松核对），锚点落在
 * 摘要前缀内则命中 —— 紧凑摘要即核对锚点前缀，语义一致。长度纪律优先：
 * 8 字符 * 3 + 标签 ≈ 60 字符行，守 420/520 预算。 */
function compactContractSummary(value: string): string {
  const compact = value.replace(/\s+/g, "").slice(0, 8)
  return compact || "—"
}

/**
 * 渲染 fallback 紧凑章节契约段（恒 2 行：header + 紧凑行，无豁免行）。
 * 豁免行在此省略的原因：fallback 无 LLM 参与，豁免声明是写给模型的
 * 文档行；parse 遇后续非契约行（正史指纹/文末）同样终止，段界明确。
 * 长度纪律：紧凑段恒 ≤120 字符，守 420/520 字符预算（旧 spec 不变量）。
 * parseChapterContractSection 同构解析紧凑行（‖ 切分 → 三类条目各 1）。
 */
export function buildCompactChapterContractSection(parts: {
  requiredBeat: string
  forbiddenMove: string
  continuityCheck: string
  hookGoal?: string
}): string {
  // hookGoal 上限 24（与三类摘要同宽；超长钩子由任务书正文行承载，此处仅锚点）。
  const compactLine = [
    `必须节拍：${compactContractSummary(parts.requiredBeat)}`,
    `禁区：${compactContractSummary(parts.forbiddenMove)}`,
    `连贯核对：${compactContractSummary(parts.continuityCheck)}`,
  ].join("‖") + (parts.hookGoal ? `‖钩子目标：${parts.hookGoal.slice(0, 24)}` : "")
  return [CHAPTER_CONTRACT_HEADER, compactLine].join("\n")
}

/** 渲染 machine-readable 章节契约段（任务书携带，写后核对解析）。 */
export function buildChapterContractSection(contract: ChapterContractSection): string {
  const lines = [CHAPTER_CONTRACT_HEADER]
  for (const beat of contract.requiredBeats) lines.push(`必须节拍：${beat}`)
  for (const move of contract.forbiddenMoves) lines.push(`禁区：${move}`)
  for (const check of contract.continuityChecks) lines.push(`连贯核对：${check}`)
  if (contract.emotionTarget) lines.push(`情绪主色：${contract.emotionTarget}`)
  for (const payoff of contract.payoffPoints ?? []) lines.push(`兑现点：${payoff}`)
  if (contract.hookGoal) lines.push(`钩子目标：${contract.hookGoal}`)
  lines.push(CHAPTER_CONTRACT_WAIVER)
  return lines.join("\n")
}

/** 解析任务书中的章节契约段；缺失返回 null（contract 不适用如实标记）。 */
export function parseChapterContractSection(taskBrief: string): ChapterContractSection | null {
  const headerIndex = taskBrief.indexOf(CHAPTER_CONTRACT_HEADER)
  if (headerIndex < 0) return null
  const section = taskBrief.slice(headerIndex).split("\n").slice(1)
  const contract: ChapterContractSection = {
    requiredBeats: [],
    forbiddenMoves: [],
    continuityChecks: [],
    payoffPoints: [],
  }
  for (const rawLine of section) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === CHAPTER_CONTRACT_WAIVER) break
    // 豁免声明变体（模型复述）同样视为段结束
    if (line.startsWith("方向提示不是机械")) break
    // 紧凑行（fallback 单行 ‖ 式）：切分后每段按标签归类，各类至多 1 条
    if (line.includes("‖")) {
      for (const part of line.split("‖")) {
        const seg = part.trim()
        if (seg.startsWith("必须节拍：") && contract.requiredBeats.length === 0) contract.requiredBeats.push(seg.slice("必须节拍：".length).trim())
        else if (seg.startsWith("禁区：") && contract.forbiddenMoves.length === 0) contract.forbiddenMoves.push(seg.slice("禁区：".length).trim())
        else if (seg.startsWith("连贯核对：") && contract.continuityChecks.length === 0) contract.continuityChecks.push(seg.slice("连贯核对：".length).trim())
        else if (seg.startsWith("情绪主色：") && !contract.emotionTarget) contract.emotionTarget = seg.slice("情绪主色：".length).trim() || undefined
        else if (seg.startsWith("兑现点：")) contract.payoffPoints!.push(seg.slice("兑现点：".length).trim())
        else if (seg.startsWith("钩子目标：") && !contract.hookGoal) contract.hookGoal = seg.slice("钩子目标：".length).trim() || undefined
      }
      continue
    }
    if (line.startsWith("必须节拍：")) contract.requiredBeats.push(line.slice("必须节拍：".length).trim())
    else if (line.startsWith("禁区：")) contract.forbiddenMoves.push(line.slice("禁区：".length).trim())
    else if (line.startsWith("连贯核对：")) contract.continuityChecks.push(line.slice("连贯核对：".length).trim())
    else if (line.startsWith("情绪主色：")) contract.emotionTarget = line.slice("情绪主色：".length).trim() || undefined
    else if (line.startsWith("兑现点：")) contract.payoffPoints!.push(line.slice("兑现点：".length).trim())
    else if (line.startsWith("钩子目标：")) contract.hookGoal = line.slice("钩子目标：".length).trim() || undefined
    // 非契约行（后续任务书段落）→ 段结束，未消费行丢弃
    else break
  }
  if (contract.payoffPoints!.length === 0) delete contract.payoffPoints
  return contract
}

/**
 * 写后核对：对照契约检查正文（纯函数，机械包含匹配）。
 * - required_beats 缺失 → warning（不管阻断只告警：机械子串匹配无法区分
 *   “转述兑现”与“真正缺失”，error 级会把每个转述章节 stranded 进 manual
 *   handoff —— 端到端 spec 已证明确定性误杀；人类/复审可见即管住下限）
 * - forbidden_moves 命中 → error（触犯禁区）：禁区 distinctive 原文逐字出现
 *   才是高精度信号，误报率远低于缺失类检查，可阻断
 * - continuity_checks 未命中 → warning
 * - 方向提示（emotion/payoff/hook）未兑现 → warning；transitional 过渡章
 *   方向提示未兑现记 trade_off 不出 finding（ainovel editor.md 同款语义）。
 */
export function checkChapterContract(
  contract: ChapterContractSection,
  chapterBody: string,
  options?: { transitional?: boolean },
): { passed: boolean; findings: import("./review-adapter").NovelReviewResult[]; tradeOffs: string[] } {
  const findings: import("./review-adapter").NovelReviewResult[] = []
  const tradeOffs: string[] = []
  const body = (chapterBody ?? "").replace(/\s+/g, "")
  const hit = (beat: string): boolean => {
    const anchor = beat.replace(/\s+/g, "").slice(0, 12)
    if (anchor.length < 4) return true
    return body.includes(anchor)
  }
  const err = (message: string, relatedMemory: string, suggestion: string) => ({
    severity: "error" as const,
    type: "contract",
    message,
    evidence: "",
    relatedMemory,
    suggestion,
  })
  const warn = (message: string, relatedMemory: string, suggestion: string) => ({
    severity: "warning" as const,
    type: "contract",
    message,
    evidence: "",
    relatedMemory,
    suggestion,
  })
  for (const beat of contract.requiredBeats) {
    if (!hit(beat)) {
      // warning 而非 error：见函数头注释（转述兑现误杀 → stranded manual）。
      findings.push(warn(
        `章节契约：必须节拍未兑现——${beat.slice(0, 40)}`,
        "chapter_contract.required_beats",
        "在返修中补足该节拍，或确认为过渡章并记录取舍。",
      ))
    }
  }
  for (const move of contract.forbiddenMoves) {
    if (hit(move)) {
      findings.push(err(
        `章节契约：触犯禁区——${move.slice(0, 40)}`,
        "chapter_contract.forbidden_moves",
        "删除或改写触犯禁区的段落。",
      ))
    }
  }
  for (const check of contract.continuityChecks) {
    if (!hit(check)) {
      findings.push(warn(
        `章节契约：连贯核对未覆盖——${check.slice(0, 40)}`,
        "chapter_contract.continuity_checks",
        "核对时间线/认知边界是否在本章得到呼应。",
      ))
    }
  }
  const soft: Array<[string, readonly string[] | string | undefined]> = [
    ["情绪主色", contract.emotionTarget ? [contract.emotionTarget] : []],
    ["兑现点", contract.payoffPoints ?? []],
    ["钩子目标", contract.hookGoal ? [contract.hookGoal] : []],
  ]
  for (const [label, values] of soft) {
    const list = Array.isArray(values) ? values : []
    for (const v of list) {
      if (!hit(v)) {
        if (options?.transitional) {
          tradeOffs.push(`${label}未兑现但记为过渡章取舍：${v.slice(0, 40)}`)
        } else {
          findings.push(warn(
            `章节契约（方向提示）：${label}未兑现——${v.slice(0, 40)}`,
            "chapter_contract.soft",
            "如下章承接则可接受，否则补强。",
          ))
        }
      }
    }
  }
  return { passed: !findings.some((f) => f.severity === "error"), findings, tradeOffs }
}

export function buildFallbackTaskBrief(
  contextPack: ContextPack,
  userRequest: string,
  chapterNumber: number | undefined,
  lengthSpec: ChapterLengthSpec,
  /**
   * T25b: canon 事实集 SHA-256 摘要指纹。由 computeCheckpointDigestOf(canonRules)
   * 计算，随 canon 事实集变化，使 task_brief 可溯源正史版本。
   * 可选参数：不传/undefined 时行为完全不变（向后兼容）。
   */
  canonHash?: string,
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
    // §GAP-88-01 (ainovel chapter_contract 写前约束): fallback 同样携带
    // machine-readable 章节契约段 — sanitize 后的同源字段压缩为单行契约
    // （紧凑式：首行 header + 尾行豁免固定，中间一行承载必须/禁区/核对首条
    // 64 字符摘要；方向提示只留钩子目标）。写后核对经 parse 紧凑行解析，
    // 长度纪律：紧凑段恒 ≤160 字符，守 420/520 字符预算（旧 spec 不变量）。
    buildCompactChapterContractSection({
      requiredBeat: splitContractLines(mustDo)[0] ?? "",
      forbiddenMove: splitContractLines(mustAvoid)[0] ?? "",
      continuityCheck: splitContractLines(
        [contextPack.timeline, contextPack.cognitionStates].filter(Boolean).join("\n"),
      )[0] ?? "",
      hookGoal: sanitizeTaskBriefSourceText(contextPack.nextChapterAdvice) || undefined,
    }),
    ...(canonHash ? [taskBriefFallbackLine("正史指纹", canonHash)] : []),
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
