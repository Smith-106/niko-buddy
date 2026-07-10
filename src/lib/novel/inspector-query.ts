/**
 * EPIC-004 / ADR-33 / TASK-009: Inspector 只读查询消费者。
 *
 * 本模块是 context-engine / novel-session-status 的只读 query consumer：
 * - 复用上次 6-dim review 运行的缓存结果（status.json dimension_results 字段，
 *   S3 F-003 additive field），通过 getCachedDimensionResults 纯函数派生视图。
 *   不新建模块级缓存（HARD-1 唯一真源），不触发新 6-dim 运行（PAT-DC3 孤儿
 *   预防 — 活动修复中触发会与 fix-loop LLM 调用竞争）。
 * - 同步扫描 CHINESE_NOVEL_DE_AI_RULES 静态 slop 词表（de-ai-rules.ts :14-20），
 *   无 LLM 调用。
 * - isStale: 自 cachedAt 草稿（draft.file_path mtime）更改则 true。
 *
 * 三大硬约束：
 * - HARD-1: 不写 status.json（无 status 写入函数 / 文件原子写调用）。
 *   UI prefs 存 cognition-state.json 现有 key 非新文件。
 * - HARD-2: 只读 ready/formal 草稿，不改 pending→ready→accepted 流程。
 * - HARD-3: 不写 decision_gates（门控权威不变，C-208），不触发新 6-dim review。
 *
 * PAT-DC1: message/evidence 字段脱敏 — catch 块 throw 脱敏 Error（无 raw error /
 * provider detail）。
 */
import { readFile, getFileModifiedTime } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadNovelSessionStatus } from "./novel-session-status"
import { loadCognitionState, type CognitionState } from "./character-cognition"
import {
  getCachedDimensionResults,
  SIX_REVIEW_DIMENSIONS,
  type DimensionReviewResult,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"
import { CHINESE_NOVEL_DE_AI_RULES } from "./de-ai-rules"
import type { DeepChapterDecisionGates } from "./deep-chapter-generation"

/**
 * Inspector 单条发现（脱敏后）。ADR-33: message/evidence 字段无 raw error /
 * provider detail（PAT-DC1）。
 */
export interface InspectorFinding {
  dimensionKey: SixReviewDimensionKey
  dimensionLabel: string
  score: number
  status: string
  summary: string
  /** 脱敏后的 issue 描述（无 provider detail）。 */
  messages: string[]
  /** 脱敏后的正文证据片段（无 provider detail）。 */
  evidences: string[]
}

/**
 * Inspector 静态 de-ai slop 命中。基于 CHINESE_NOVEL_DE_AI_RULES 静态词表
 * 同步扫描（无 LLM）。word = 命中的 slop 词，count = 该词在 draft 出现次数。
 */
export interface InspectorDeAiSlopHit {
  word: string
  count: number
}

/**
 * Inspector 6 分块之一：审查发现（来自缓存 6-dim，非实时）。
 */
export interface InspectorReviewBlock {
  findings: InspectorFinding[]
  /** 上次 review 运行的 ISO 时间戳（来自 status.dimension_results 各维 thinking
   * 无法稳定提供时间戳；此处取 status.updated_at 作为保守上界）。 */
  reviewedAt: string | null
}

/**
 * Inspector 6 分块之一：草稿状态。
 */
export interface InspectorDraftBlock {
  draftId: string
  filePath: string
  draftStatus: string
  /** 草稿正文（截断至 4000 字符以避免 UI 过载）。 */
  contentPreview: string
  updatedAt: string
}

/**
 * Inspector 6 分块之一：contextPack 快照（只读派生自 cognition-state.json）。
 */
export interface InspectorContextPackBlock {
  /** 认知状态摘要（characters knows/doesNotKnow 计数）。 */
  cognitionSummary: string
  /** 角色认知条目数。 */
  characterCount: number
  /** 读者已知条目数。 */
  readerKnowsCount: number
}

/**
 * Inspector 6 分块之一：认知状态（cognition-state.json 派生）。
 */
export interface InspectorCognitionStateBlock {
  characters: Array<{ name: string; knows: string[]; doesNotKnow: string[] }>
  readerKnows: string[]
  lastUpdatedChapter: number | null
}

/**
 * Inspector 6 分块之一：场景（EPIC-002 scene-breakdown 数据源，非硬依赖）。
 * EPIC-002 未落地时 scene 列表为空，面板该块灰显（EPIC-004 Story 4.2 AC）。
 */
export interface InspectorSceneBlock {
  /** 场景数（EPIC-002 未落地时为 0）。 */
  sceneCount: number
  /** 场景标题列表（EPIC-002 未落地时为空数组）。 */
  sceneTitles: string[]
}

/**
 * Inspector 6 分块之一：门控状态（只读派生自 status.decision_gates）。
 * Inspector 是咨询性非门控（C-208）；门控结论权威不变。
 */
export interface InspectorDecisionBlock {
  consistency: { status: string; verdict: string }
  anti_ai: { status: string; verdict: string }
  quality: { status: string; verdict: string }
  overall: string
}

/**
 * ADR-33 queryInspectorState 返回的只读快照。26 维字段分块为 6 组。
 * cachedAt = 缓存结果的时间戳；isStale = 自 cachedAt 草稿是否更改。
 */
export interface InspectorSnapshot {
  cognitionState: InspectorCognitionStateBlock
  draft: InspectorDraftBlock
  contextPack: InspectorContextPackBlock
  scene: InspectorSceneBlock
  review: InspectorReviewBlock
  decision: InspectorDecisionBlock
  /** 缓存结果的 ISO 时间戳（status.updated_at）。 */
  cachedAt: string
  /** 自 cachedAt 草稿（draft mtime）更改则 true。 */
  isStale: boolean
  /** 静态 de-ai slop 命中列表（同步扫描，无 LLM）。 */
  deAiSlopHits: InspectorDeAiSlopHit[]
}

/**
 * EPIC-002 scene-breakdown 数据源钩子。EPIC-002 未落地时返回空数组
 * （EPIC-004 非硬依赖，scene 缺失面板该块灰显）。inspector-query 不导入
 * scene-breakdown 模块（避免硬依赖），由调用方注入。
 */
export type SceneListProvider = (projectPath: string, chapterId: string) => Promise<string[]>

const DRAFT_PREVIEW_MAX_CHARS = 4000

/**
 * EPIC-004 / ADR-33: de-ai slop 静态词表。从 CHINESE_NOVEL_DE_AI_RULES
 * （de-ai-rules.ts:14-20 "禁用词汇 (Slop Words)" 章节）解析提取。同步扫描
 * 草稿正文，无 LLM 调用。
 *
 * 词表来源是 de-ai-rules.ts 的静态字符串（规则文档），其中"禁用词汇"章节
 * 列出总结腔/解释腔/模板句首/空洞形容/转折滥用/AI特征词六类。本函数解析
 * 该章节的中文词项（非英文/标点），去重返回。
 */
const SLOP_WORDS: readonly string[] = (() => {
  const words = new Set<string>()
  // 提取"禁用词汇"章节到下一个 "###" 或 "##" 之间的中文词项。
  const sectionMatch = CHINESE_NOVEL_DE_AI_RULES.match(/禁用词汇[\s\S]*?(?=^### |^## )/m)
  const section = sectionMatch ? sectionMatch[0] : CHINESE_NOVEL_DE_AI_RULES
  // 匹配连续中文词项（2 字以上），排除章节标题中的英文/标点。
  const cnWordRe = /[一-鿿]{2,}/g
  let m: RegExpExecArray | null
  while ((m = cnWordRe.exec(section)) !== null) {
    const word = m[0]
    // 排除章节标题词（"禁用词汇"、"总结腔" 等分类标签）与说明性短语。
    if (
      word === "禁用词汇"
      || word === "总结腔"
      || word === "解释腔"
      || word === "模板句首"
      || word === "空洞形容"
      || word === "转折滥用"
      || word === "特征词"
      || word === "机械句式"
    ) {
      continue
    }
    words.add(word)
  }
  return [...words]
})()

/**
 * 同步扫描草稿正文，统计 slop 词命中。无 LLM 调用。
 */
function scanSlopWords(draftContent: string): InspectorDeAiSlopHit[] {
  const hits: InspectorDeAiSlopHit[] = []
  for (const word of SLOP_WORDS) {
    let count = 0
    let idx = draftContent.indexOf(word)
    while (idx !== -1) {
      count++
      idx = draftContent.indexOf(word, idx + word.length)
    }
    if (count > 0) hits.push({ word, count })
  }
  return hits
}

/**
 * 从 DimensionReviewResult[] 派生脱敏后的 InspectorFinding[]。PAT-DC1:
 * message/evidence 字段已是结构化字符串（review-adapter normalizeIssue 已
 * String() 强制），无 raw error / provider detail。
 */
function toFindings(results: DimensionReviewResult[]): InspectorFinding[] {
  return results.map((result) => ({
    dimensionKey: result.dimensionKey,
    dimensionLabel: SIX_REVIEW_DIMENSIONS[result.dimensionKey]?.label ?? result.dimensionKey,
    score: result.score,
    status: result.status,
    summary: result.summary,
    messages: result.issues.map((issue) => issue.message).filter(Boolean),
    evidences: result.issues.map((issue) => issue.evidence).filter(Boolean),
  }))
}

function emptyCognitionState(): InspectorCognitionStateBlock {
  return { characters: [], readerKnows: [], lastUpdatedChapter: null }
}

function cognitionStateBlock(state: CognitionState | null): InspectorCognitionStateBlock {
  if (!state) return emptyCognitionState()
  return {
    characters: state.characters.map((c) => ({
      name: c.character,
      knows: [...c.knows],
      doesNotKnow: [...c.doesNotKnow],
    })),
    readerKnows: [...state.readerKnows],
    lastUpdatedChapter: state.lastUpdatedChapter ?? null,
  }
}

function contextPackBlock(state: CognitionState | null): InspectorContextPackBlock {
  if (!state) {
    return { cognitionSummary: "无认知状态", characterCount: 0, readerKnowsCount: 0 }
  }
  const characterCount = state.characters.length
  const readerKnowsCount = state.readerKnows.length
  return {
    cognitionSummary: `${characterCount} 角色 / ${readerKnowsCount} 读者已知`,
    characterCount,
    readerKnowsCount,
  }
}

function decisionBlock(gates: DeepChapterDecisionGates): InspectorDecisionBlock {
  return {
    consistency: { status: gates.consistency.status, verdict: gates.consistency.verdict },
    anti_ai: { status: gates.anti_ai.status, verdict: gates.anti_ai.verdict },
    quality: { status: gates.quality.status, verdict: gates.quality.verdict },
    overall: gates.overall,
  }
}

/**
 * 派生空草稿块（status.json 不存在或会话未开始时）。
 */
function emptyDraftBlock(): InspectorDraftBlock {
  return {
    draftId: "",
    filePath: "",
    draftStatus: "pending",
    contentPreview: "",
    updatedAt: "",
  }
}

/**
 * 读取草稿正文并截断至 DRAFT_PREVIEW_MAX_CHARS。
 */
async function readDraftPreview(
  filePath: string,
): Promise<{ content: string; mtime: number }> {
  try {
    const content = await readFile(filePath)
    const mtime = await getFileModifiedTime(filePath)
    return {
      content: content.length > DRAFT_PREVIEW_MAX_CHARS
        ? `${content.slice(0, DRAFT_PREVIEW_MAX_CHARS)}…`
        : content,
      mtime,
    }
  } catch {
    // 草稿文件可能尚未落盘（pending 状态）— 返回空内容，mtime=0。
    return { content: "", mtime: 0 }
  }
}

/**
 * 计算是否过期：草稿 mtime > cachedAt 时间戳则 stale。
 * cachedAt 是 ISO 字符串（status.updated_at），转 epoch 比较草稿 mtime。
 */
function computeIsStale(draftMtime: number, cachedAt: string): boolean {
  if (!cachedAt || draftMtime === 0) return false
  const cachedEpoch = Date.parse(cachedAt)
  if (!Number.isFinite(cachedEpoch)) return false
  // 草稿 mtime 毫秒 > cachedAt 毫秒 → 草稿在缓存之后被修改 → 过期。
  return draftMtime > cachedEpoch
}

/**
 * EPIC-004 / ADR-33 / TASK-009: 只读查询 Inspector 快照。
 *
 * @param projectPath 项目根路径
 * @param chapterId 章节标识（用于 scene-breakdown 数据源，EPIC-002 未落地时忽略）
 * @param sceneListProvider 可选 scene 列表 provider（EPIC-002 注入；缺省 scene 块为空）
 * @returns InspectorSnapshot 6 分块只读快照
 *
 * 只读保证（HARD-1/2/3）：
 * - 不写 status.json（无 status 保存或文件原子写调用）
 * - 不触发 LLM（无流式聊天或 CLI 子进程调用）
 * - 不写 decision_gates（门控权威不变 C-208）
 * - 不触发新 6-dim review（仅读 status.dimension_results 缓存）
 *
 * PAT-DC1: catch 块 throw 脱敏 Error（无 raw error / provider detail）。
 */
export async function queryInspectorState(
  projectPath: string,
  chapterId: string,
  sceneListProvider?: SceneListProvider,
): Promise<InspectorSnapshot> {
  try {
    const pp = normalizePath(projectPath)
    const status = await loadNovelSessionStatus(pp)
    const cognition = await loadCognitionState(pp)

    // 草稿块：status.draft.file_path（草稿落盘路径）。
    const draftFilePath = status?.draft?.file_path ?? ""
    let draftBlock: InspectorDraftBlock = emptyDraftBlock()
    let draftMtime = 0
    let draftContent = ""
    if (status?.draft) {
      const preview = draftFilePath ? await readDraftPreview(draftFilePath) : { content: "", mtime: 0 }
      draftContent = preview.content
      draftMtime = preview.mtime
      draftBlock = {
        draftId: status.draft.draft_id,
        filePath: draftFilePath,
        draftStatus: status.draft.draft_status,
        contentPreview: preview.content,
        updatedAt: status.draft.updated_at,
      }
    }

    // 审查块：缓存 6-dim 发现（status.dimension_results，S3 F-003 additive field）。
    const cachedResults = getCachedDimensionResults(status?.dimension_results)
    const findings = toFindings(cachedResults)
    const reviewedAt = status?.updated_at ?? null
    const reviewBlock: InspectorReviewBlock = { findings, reviewedAt }

    // 认知状态块：cognition-state.json 派生（只读，不改）。
    const cognitionState = cognitionStateBlock(cognition)
    const contextPack = contextPackBlock(cognition)

    // 场景块：EPIC-002 scene-breakdown 数据源（非硬依赖，缺失则空）。
    let sceneTitles: string[] = []
    if (sceneListProvider) {
      try {
        sceneTitles = await sceneListProvider(pp, chapterId)
      } catch {
        // scene provider 失败不阻塞 Inspector — 降级空场景块。
        sceneTitles = []
      }
    }
    const scene: InspectorSceneBlock = {
      sceneCount: sceneTitles.length,
      sceneTitles,
    }

    // 门控块：status.decision_gates 只读派生（Inspector 咨询性非门控 C-208）。
    const decision = status?.decision_gates
      ? decisionBlock(status.decision_gates)
      : {
          consistency: { status: "pending", verdict: "pending" },
          anti_ai: { status: "pending", verdict: "pending" },
          quality: { status: "pending", verdict: "pending" },
          overall: "pending",
        }

    // 静态 de-ai slop 扫描（同步，无 LLM）。
    const deAiSlopHits = scanSlopWords(draftContent)

    const cachedAt = status?.updated_at ?? new Date(0).toISOString()
    const isStale = status ? computeIsStale(draftMtime, cachedAt) : false

    return {
      cognitionState,
      draft: draftBlock,
      contextPack,
      scene,
      review: reviewBlock,
      decision,
      cachedAt,
      isStale,
      deAiSlopHits,
    }
  } catch (error) {
    // PAT-DC1: 脱敏 — 只暴露 message，不泄露 provider / raw error 细节。
    const message = error instanceof Error ? error.message : "Inspector 查询失败"
    throw new Error(`Inspector 查询失败：${message}`)
  }
}
